"""Production readiness, durable recovery, and truthful cost tests."""

import asyncio
import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault("AGENTLAB_DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("AGENTLAB_DATA_DIR", "/tmp/agentlab-test-data")
os.environ.setdefault("AGENTLAB_ARTIFACT_ROOT", "/tmp/agentlab-test-data/artifacts")

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

import app as app_module  # noqa: E402
import cost  # noqa: E402
import provider_adapters  # noqa: E402
import runpod_adapter  # noqa: E402
from database import SessionLocal, init_db  # noqa: E402
from runner_common import ConnectionManager, write_artifact  # noqa: E402
from models import AgentSession, Artifact, Brief, Project, ProviderKey, ReviewFinding, Run, RunLog, User  # noqa: E402

init_db()


def _seed_interrupted_run(provider="anthropic", runtime=None):
    with SessionLocal() as db:
        user = User(name="Recovery", email=f"recover-{os.urandom(3).hex()}@example.test", password_hash="x")
        db.add(user)
        db.commit()
        project = Project(owner_id=user.id, title="Recovery")
        db.add(project)
        db.commit()
        brief = Brief(project_id=project.id, version=1, is_approved=True)
        db.add(brief)
        db.commit()
        session = AgentSession(project_id=project.id, brief_id=brief.id, provider=provider, status="running")
        db.add(session)
        db.commit()
        run = Run(
            session_id=session.id,
            project_id=project.id,
            brief_id=brief.id,
            status="running",
            actual_cost=2.0,
            draft_markdown="partial",
            analysis_json={"_runtime": runtime} if runtime else {"partial": True},
        )
        db.add(run)
        db.commit()
        return run.id, user.id


def test_interrupted_run_is_reclaimed_idempotently():
    run_id, _ = _seed_interrupted_run(runtime={"runpod_job_id": "job-1"})
    path = write_artifact(run_id, "partial.txt", "partial")
    with SessionLocal() as db:
        run = db.get(Run, run_id)
        db.add(Artifact(run_id=run.id, type="draft", name="partial", path=str(path)))
        db.add(
            ReviewFinding(
                project_id=run.project_id,
                run_id=run.id,
                category="methods",
                severity="medium",
                finding="partial",
                suggested_fix="retry",
            )
        )
        db.commit()
        recovered = app_module._recover_interrupted_runs(db)
    assert recovered == [(run_id, True)]
    with SessionLocal() as db:
        run = db.get(Run, run_id)
        assert run.status == run.session.status == "queued"
        assert run.actual_cost == 2.0 and run.draft_markdown == ""
        assert run.analysis_json == {"_runtime": {"runpod_job_id": "job-1"}}
        assert db.query(Artifact).filter(Artifact.run_id == run_id).count() == 0
        assert db.query(ReviewFinding).filter(ReviewFinding.run_id == run_id).count() == 0
        run.status = run.session.status = "failed"  # keep later lifespan tests from dispatching it
        db.commit()
    assert not path.exists()


def test_transition_broadcasts_live_status():
    run_id, _ = _seed_interrupted_run()

    class RecordingManager:
        def __init__(self):
            self.events = []

        async def broadcast(self, event_run_id, payload):
            self.events.append((event_run_id, payload))

    manager = RecordingManager()
    runner = app_module.real_runner.__class__(manager)

    async def transition():
        with SessionLocal() as db:
            await runner._transition(db, run_id, "failed", "test terminal transition")

    asyncio.run(transition())
    assert manager.events == [(run_id, {"type": "status", "status": "failed"})]


def test_graceful_shutdown_leaves_run_reclaimable(monkeypatch):
    run_id, user_id = _seed_interrupted_run(provider="anthropic")
    with SessionLocal() as db:
        db.add(ProviderKey(user_id=user_id, provider="anthropic", api_key="sk-ant-test", is_enabled=True))
        db.commit()

    async def scenario():
        entered = asyncio.Event()

        async def hanging_provider(**_kwargs):
            entered.set()
            await asyncio.Event().wait()

        monkeypatch.setattr(provider_adapters, "stream_stage", hanging_provider)
        runner = app_module.real_runner.__class__(ConnectionManager())
        runner.start(run_id)
        await asyncio.wait_for(entered.wait(), timeout=1)
        await runner.shutdown(timeout=2)

    asyncio.run(scenario())
    with SessionLocal() as db:
        run = db.get(Run, run_id)
        assert run.status == "running"
        assert db.query(RunLog).filter(
            RunLog.run_id == run_id,
            RunLog.message.contains("durable recovery"),
        ).count() == 1
        run.status = run.session.status = "failed"
        db.commit()


def test_recovered_real_run_cancels_orphaned_remote_job(monkeypatch):
    run_id, user_id = _seed_interrupted_run(provider="anthropic", runtime={"runpod_job_id": "job-2"})
    with SessionLocal() as db:
        db.add(ProviderKey(user_id=user_id, provider="runpod", api_key="rp-key", model_name="endpoint", is_enabled=True))
        db.commit()
    calls = []

    async def cancel_job(**kwargs):
        calls.append(kwargs)
        return True

    monkeypatch.setattr(runpod_adapter, "cancel_job", cancel_job)
    runner = app_module.real_runner.__class__(ConnectionManager())
    _ctx, _key, meta = runner._load_context(run_id)
    asyncio.run(runner._cancel_orphaned_execution(run_id, meta))
    assert calls == [{"api_key": "rp-key", "endpoint_id": "endpoint", "job_id": "job-2"}]
    with SessionLocal() as db:
        assert "_runtime" not in (db.get(Run, run_id).analysis_json or {})
        db.get(Run, run_id).status = "failed"
        db.commit()


def test_real_cost_estimate_includes_selected_addons():
    base, base_breakdown, _ = cost.estimate_real_run("gpt-4.1")
    enhanced, breakdown, assumptions = cost.estimate_real_run(
        "gpt-4.1", advisor=True, execute=True, figures=True, gpu_type="h100"
    )
    assert base > 0 and enhanced > base
    assert breakdown["gpu"] > 0 and breakdown["images"] > 0
    assert breakdown["uncertainty_reserve"] > base_breakdown["uncertainty_reserve"]
    assert any("20%" in item for item in assumptions)


def test_cost_table_uses_exact_mini_and_serverless_rates():
    assert cost.price_per_million("gpt-4.1-mini") == (0.40, 1.60)
    assert cost.price_per_million("gpt-4.1-nano") == (0.10, 0.40)
    assert cost.gpu_price_per_hr("RTX 4090") == 1.116
    assert cost.gpu_price_per_hr("H100 PRO") == 4.176


def test_production_requires_explicit_database_and_sqlite_opt_in(monkeypatch):
    import auth

    monkeypatch.setenv("AGENTLAB_ENV", "production")
    monkeypatch.setattr(auth, "COOKIE_SECURE", True)
    monkeypatch.setattr(app_module, "_allowed_hosts", ["api.example"])
    monkeypatch.setattr(app_module, "_cors_origins", ["https://frontend.example"])
    monkeypatch.delenv("AGENTLAB_DATABASE_URL", raising=False)
    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        app_module._validate_deployment_security()
    monkeypatch.setenv("AGENTLAB_DATABASE_URL", "sqlite:////tmp/production.sqlite3")
    with pytest.raises(RuntimeError, match="Postgres"):
        app_module._validate_deployment_security()
    monkeypatch.setenv("AGENTLAB_ALLOW_SQLITE_PRODUCTION", "1")
    app_module._validate_deployment_security()


def test_production_rejects_unsafe_worker_host_budget_and_shutdown_config(monkeypatch):
    import auth

    monkeypatch.setenv("AGENTLAB_ENV", "production")
    monkeypatch.setenv("AGENTLAB_DATABASE_URL", "postgresql+psycopg://db/agentlab")
    monkeypatch.setattr(auth, "COOKIE_SECURE", True)
    monkeypatch.setattr(app_module, "_cors_origins", ["https://frontend.example"])
    monkeypatch.setattr(app_module, "_allowed_hosts", ["api.example"])

    monkeypatch.setenv("WEB_CONCURRENCY", "2")
    with pytest.raises(RuntimeError, match="exactly one"):
        app_module._validate_deployment_security()
    monkeypatch.delenv("WEB_CONCURRENCY")

    monkeypatch.setattr(app_module, "_allowed_hosts", ["*"])
    with pytest.raises(RuntimeError, match="wildcard"):
        app_module._validate_deployment_security()
    monkeypatch.setattr(app_module, "_allowed_hosts", ["api.example"])

    monkeypatch.setattr(cost, "USER_MONTHLY_CAP_USD", float("nan"))
    with pytest.raises(RuntimeError, match="finite positive"):
        app_module._validate_deployment_security()
    monkeypatch.setattr(cost, "USER_MONTHLY_CAP_USD", 50.0)

    monkeypatch.setenv("AGENTLAB_SHUTDOWN_TIMEOUT_S", "90")
    with pytest.raises(RuntimeError, match="between 1 and 60"):
        app_module._validate_deployment_security()


def test_readiness_returns_503_when_database_is_unavailable(monkeypatch):
    class BrokenSession:
        def __enter__(self):
            raise OSError("database down")

        def __exit__(self, *_args):
            pass

    monkeypatch.setattr(app_module, "SessionLocal", BrokenSession)
    response = app_module.health_ready()
    assert response.status_code == 503
