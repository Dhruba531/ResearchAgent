"""P2 hardening tests: provider-only runs, per-stage budgets, export scoping,
auth rate limits, email validation, /api/status, and DB constraints."""
import os
import sys
import time
from pathlib import Path

os.environ["AGENTLAB_DATABASE_URL"] = "sqlite:///:memory:"
os.environ["AGENTLAB_DATA_DIR"] = "/tmp/agentlab-test-data"
os.environ["AGENTLAB_ARTIFACT_ROOT"] = "/tmp/agentlab-test-data/artifacts"

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app as app_module  # noqa: E402
import ratelimit  # noqa: E402
import real_runner as real_runner_module  # noqa: E402
from app import app  # noqa: E402
from database import SessionLocal  # noqa: E402
from models import AgentSession, ProviderKey, ReviewFinding, User  # noqa: E402


# ---- helpers ---------------------------------------------------------------
def register(client: TestClient, email: str) -> dict:
    response = client.post(
        "/api/auth/register",
        json={"name": "Hardening Tester", "email": email, "password": "agentlab-test"},
    )
    assert response.status_code == 200, response.text
    return response.json()


def project_with_approved_brief(client: TestClient) -> int:
    if not any(row["is_enabled"] for row in client.get("/api/provider-keys").json()):
        save_enabled_key(client)
    project = client.post(
        "/api/projects",
        json={"title": "Hardening", "objective": "", "idea_text": ""},
    ).json()
    idea = "Evaluate governed research pipelines under adversarial review."
    assert client.post(f"/api/projects/{project['id']}/idea", json={"idea_text": idea}).status_code == 200
    brief = client.post(f"/api/projects/{project['id']}/briefs/generate", json={}).json()
    assert client.post(f"/api/briefs/{brief['id']}/approve", json={"notes": "ok"}).status_code == 200
    return project["id"]


def start_run(client: TestClient, project_id: int, **extra) -> "requests.Response":  # noqa: F821
    payload = {"budget_threshold": 12.0, "approved_cost": True, "config_json": {}}
    payload.update(extra)
    return client.post(f"/api/projects/{project_id}/runs", json=payload)


def save_enabled_key(client: TestClient, provider: str = "anthropic") -> None:
    response = client.post(
        "/api/provider-keys",
        json={"provider": provider, "api_key": "sk-ant-test-000000000000", "is_enabled": True},
    )
    assert response.status_code == 200, response.text


def wait_for_terminal(client: TestClient, run_id: int, timeout: float = 3.0) -> dict:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = client.get(f"/api/runs/{run_id}").json()
        if last["status"] in {"completed", "failed", "cancelled"}:
            return last
        time.sleep(0.03)
    raise AssertionError(f"run did not finish; last={last}")


# ---- provider-only run mode -------------------------------------------------
def test_default_run_uses_enabled_provider():
    with TestClient(app) as client:
        register(client, "mode-default@example.test")
        save_enabled_key(client)
        project_id = project_with_approved_brief(client)
        run = start_run(client, project_id).json()
        with SessionLocal() as db:
            session = db.get(AgentSession, run["session_id"])
            assert session.provider == "anthropic"
            assert session.command_plan["runner"] == "RealAgentRunner"


def test_run_without_key_is_rejected():
    with TestClient(app) as client:
        register(client, "mode-nokey@example.test")
        project_id = project_with_approved_brief(client)
        assert client.delete("/api/provider-keys/anthropic").status_code == 200
        response = start_run(client, project_id)
        assert response.status_code == 409
        assert "anthropic or openai key" in response.json()["detail"].lower()


def test_addon_only_keys_are_not_selected_as_writing_providers():
    with SessionLocal() as db:
        user = User(name="Addon Only", email=f"addon-{os.urandom(3).hex()}@example.test", password_hash="x")
        db.add(user)
        db.flush()
        db.add_all([
            ProviderKey(user_id=user.id, provider="runpod", api_key="r" * 20, is_enabled=True),
            ProviderKey(user_id=user.id, provider="gemini", api_key="g" * 20, is_enabled=True),
        ])
        db.commit()
        assert real_runner_module.enabled_provider_key(db, user.id) is None


def test_real_mode_requires_positive_budget(monkeypatch):
    monkeypatch.setattr(app_module.real_runner, "start", lambda _run_id: None)
    with TestClient(app) as client:
        register(client, "positive-budget@example.test")
        save_enabled_key(client)
        project_id = project_with_approved_brief(client)
        response = start_run(client, project_id, budget_threshold=0)
        assert response.status_code == 400
        assert "positive" in response.json()["detail"]


def test_enabled_key_selects_provider_runner(monkeypatch):
    started: list[int] = []
    monkeypatch.setattr(app_module.real_runner, "start", started.append)
    with TestClient(app) as client:
        register(client, "mode-real@example.test")
        save_enabled_key(client)
        project_id = project_with_approved_brief(client)
        run = start_run(client, project_id).json()
        assert started == [run["id"]]
        with SessionLocal() as db:
            session = db.get(AgentSession, run["session_id"])
            assert session.provider == "anthropic"
            assert session.command_plan["runner"] == "RealAgentRunner"


def test_active_real_run_estimates_reserve_monthly_budget(monkeypatch):
    monkeypatch.setattr(app_module.real_runner, "start", lambda _run_id: None)
    # Size the cap so exactly one run's reservation fits. The assertion under
    # test is that an *active* run's estimate is reserved against the monthly
    # cap, blocking a second concurrent run — so the cap is derived from the
    # real estimate rather than hardcoded. A literal here silently stops
    # testing reservation the moment the pipeline's call count changes (it
    # starts failing the first run on price instead).
    one_run_estimate = app_module.cost.estimate_real_run(
        app_module.provider_adapters.resolve_model("anthropic", ""),
        revise_iterations=app_module.MAX_REVISE_ITERS,
    )[0]
    monkeypatch.setattr(app_module.cost, "USER_MONTHLY_CAP_USD", one_run_estimate * 1.5)
    with TestClient(app) as client:
        register(client, "reservation@example.test")
        save_enabled_key(client)
        project_id = project_with_approved_brief(client)
        assert start_run(client, project_id).status_code == 200
        blocked = start_run(client, project_id)
        assert blocked.status_code == 402
        assert "active run reservations" in blocked.json()["detail"]


def test_project_with_active_run_cannot_be_archived(monkeypatch):
    monkeypatch.setattr(app_module.real_runner, "start", lambda _run_id: None)
    with TestClient(app) as client:
        register(client, "archive-active@example.test")
        save_enabled_key(client)
        project_id = project_with_approved_brief(client)
        run = start_run(client, project_id).json()
        blocked = client.post(f"/api/projects/{project_id}/archive")
        assert blocked.status_code == 409
        assert "cancel" in blocked.json()["detail"].lower()
        assert client.post(f"/api/runs/{run['id']}/cancel").status_code == 200
        assert client.post(f"/api/projects/{project_id}/archive").status_code == 200


def test_removed_run_mode_config_is_rejected():
    with TestClient(app) as client:
        register(client, "mode-legacy@example.test")
        save_enabled_key(client)
        project_id = project_with_approved_brief(client)
        response = start_run(client, project_id, config_json={"mode": "real"})
        assert response.status_code == 422


def test_unknown_mode_is_rejected():
    with TestClient(app) as client:
        register(client, "mode-bad@example.test")
        project_id = project_with_approved_brief(client)
        assert start_run(client, project_id, mode="yolo").status_code == 422


def test_non_finite_budget_and_complexity_are_rejected():
    with TestClient(app) as client:
        register(client, "finite@example.test")
        project_id = project_with_approved_brief(client)
        assert client.post(
            f"/api/projects/{project_id}/runs",
            content='{"budget_threshold": Infinity, "approved_cost": true, "config_json": {}}',
            headers={"content-type": "application/json"},
        ).status_code == 400
        assert client.post(
            f"/api/projects/{project_id}/runs",
            content='{"budget_threshold": 12, "approved_cost": true, "config_json": {"complexity": NaN}}',
            headers={"content-type": "application/json"},
        ).status_code == 400


def test_unknown_or_mistyped_run_config_is_rejected():
    with TestClient(app) as client:
        register(client, "config-shape@example.test")
        project_id = project_with_approved_brief(client)
        assert start_run(client, project_id, config_json={"execute": "yes"}).status_code == 422
        assert start_run(client, project_id, config_json={"unexpected": True}).status_code == 422


def test_runpod_endpoint_path_injection_is_rejected():
    with TestClient(app) as client:
        register(client, "runpod-path@example.test")
        response = client.post(
            "/api/provider-keys",
            json={
                "provider": "runpod",
                "api_key": "rp-00000000000000000000",
                "model_name": "../other-endpoint?x=1",
                "is_enabled": True,
            },
        )
        assert response.status_code == 422


def test_api_request_body_limit():
    with TestClient(app) as client:
        response = client.post(
            "/api/auth/login",
            content=b"x" * (app_module._max_request_bytes + 1),
            headers={"content-type": "application/json"},
        )
        assert response.status_code == 413


# ---- per-stage budget checks ------------------------------------------------
def test_budget_breach_run_threshold():
    usage = {"input": 1_000_000, "output": 1_000_000}  # $30 on opus-4-8 prices
    reason = real_runner_module.budget_breach("claude-opus-4-8", usage, 10.0, 1000.0)
    assert reason and "run budget" in reason


def test_budget_breach_monthly_cap():
    usage = {"input": 1_000_000, "output": 1_000_000}
    reason = real_runner_module.budget_breach("claude-opus-4-8", usage, 0.0, 5.0)
    assert reason and "monthly cap" in reason


def test_budget_breach_zero_threshold_means_no_run_cap():
    usage = {"input": 1_000_000, "output": 1_000_000}
    assert real_runner_module.budget_breach("claude-opus-4-8", usage, 0.0, 1000.0) is None


def test_budget_breach_under_limits_is_none():
    usage = {"input": 1000, "output": 1000}
    assert real_runner_module.budget_breach("claude-opus-4-8", usage, 10.0, 50.0) is None


def test_budget_breach_counts_prior_attempt_and_addon_spend():
    usage = {"input": 0, "output": 0}
    assert "run budget" in real_runner_module.budget_breach(
        "gpt-4o", usage, 10.0, 50.0, prior_cost_usd=9.98, addon_cost_usd=0.04,
    )
    assert "monthly cap" in real_runner_module.budget_breach(
        "gpt-4o", usage, 0.0, 0.03, prior_cost_usd=4.0, addon_cost_usd=0.04,
    )


# ---- final export scoped to the exported run --------------------------------
def test_export_requires_findings_from_exported_run():
    with TestClient(app) as client:
        register(client, "export-scope@example.test")
        project_id = project_with_approved_brief(client)
        run = start_run(client, project_id).json()
        finished = wait_for_terminal(client, run["id"])
        assert finished["status"] == "completed"

        # Simulate stale project-level findings: detach them from this run.
        with SessionLocal() as db:
            rows = db.query(ReviewFinding).filter(ReviewFinding.run_id == run["id"]).all()
            assert rows, "provider runner should have created run-scoped findings"
            for row in rows:
                row.run_id = None
            db.commit()

        blocked = client.post(f"/api/projects/{project_id}/final/approve", json={"notes": "ship it"})
        assert blocked.status_code == 400
        assert "exported run" in blocked.json()["detail"]

        # Reattach -> export unlocks again.
        with SessionLocal() as db:
            for row in db.query(ReviewFinding).filter(ReviewFinding.project_id == project_id).all():
                row.run_id = run["id"]
            db.commit()
        assert client.post(f"/api/projects/{project_id}/final/approve", json={"notes": "ship it"}).status_code == 200


# ---- auth hardening ----------------------------------------------------------
def test_register_rejects_invalid_email():
    with TestClient(app) as client:
        response = client.post(
            "/api/auth/register",
            json={"name": "X", "email": "not-an-email", "password": "longenough"},
        )
        assert response.status_code == 422


def test_login_is_rate_limited(monkeypatch):
    monkeypatch.setattr(ratelimit, "AUTH_LIMIT", 3)
    with TestClient(app) as client:
        for _ in range(3):
            response = client.post(
                "/api/auth/login",
                json={"email": "ghost@example.test", "password": "wrong-password"},
            )
            assert response.status_code == 401
        blocked = client.post(
            "/api/auth/login",
            json={"email": "ghost@example.test", "password": "wrong-password"},
        )
        assert blocked.status_code == 429
        assert "Retry-After" in blocked.headers


def test_session_cookie_flags_default():
    with TestClient(app) as client:
        register(client, "cookie-flags@example.test")
        cookie_header = ""
        for response in [client.post("/api/auth/login", json={"email": "cookie-flags@example.test", "password": "agentlab-test"})]:
            cookie_header = response.headers.get("set-cookie", "")
        assert "HttpOnly" in cookie_header
        assert "SameSite=lax" in cookie_header


# ---- /api/status (frontend drift fix) ---------------------------------------
def test_status_endpoint_matches_frontend_shape():
    with TestClient(app) as client:
        payload = client.get("/api/status").json()
        expected = {
            "ok", "region", "build", "ts", "runs_active", "runs_queued",
            "reviewers_online", "gate_latency_ms", "steps_per_min", "spend_per_hr",
        }
        assert expected <= set(payload)
        assert payload["ok"] is True
        assert isinstance(payload["runs_active"], int)
        assert isinstance(payload["spend_per_hr"], float)


# ---- DB constraints ----------------------------------------------------------
def test_brief_version_unique_per_project():
    from sqlalchemy import create_engine
    from sqlalchemy.exc import IntegrityError
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import Brief, Project, User

    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    try:
        user = User(name="U", email="u@x.test", password_hash="")
        db.add(user)
        db.commit()
        project = Project(owner_id=user.id, title="P")
        db.add(project)
        db.commit()
        db.add(Brief(project_id=project.id, version=1))
        db.commit()
        db.add(Brief(project_id=project.id, version=1))  # duplicate version
        with pytest.raises(IntegrityError):
            db.commit()
    finally:
        db.close()
