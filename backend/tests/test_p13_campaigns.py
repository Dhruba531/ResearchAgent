"""Autoresearch campaigns: gates, owner scoping, ranking, and archive safety.

The campaign layer is the search loop above ordinary runs, so it inherits the
same obligations: a search cannot start without an approved brief or a declared
budget, a candidate cannot be promoted without a human, and one user's archive
must never be readable by another.
"""

import os
import sys
from pathlib import Path

os.environ.setdefault("AGENTLAB_DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("AGENTLAB_DATA_DIR", "/tmp/agentlab-test-data")
os.environ.setdefault("AGENTLAB_ARTIFACT_ROOT", "/tmp/agentlab-test-data/artifacts")
os.environ["AGENTLAB_VERIFY_URLS"] = "0"

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from fastapi.testclient import TestClient  # noqa: E402

import app as app_module  # noqa: E402
from database import ARTIFACT_ROOT, SessionLocal, init_db  # noqa: E402
from models import (  # noqa: E402
    Approval,
    Brief,
    Campaign,
    Candidate,
    Project,
    StatusHistory,
    User,
)

init_db()

BUDGET = {"budget": {"max_iters": 20, "usd": 25.0}}


def _register(client: TestClient, tag: str) -> int:
    """Create a signed-in user on this client and return their id."""
    email = f"{tag}-{os.urandom(4).hex()}@example.test"
    response = client.post(
        "/api/auth/register",
        json={"name": tag, "email": email, "password": "strong-pass-123"},
    )
    assert response.status_code == 200, response.text
    with SessionLocal() as db:
        return db.query(User).filter(User.email == email).one().id


def _project(owner_id: int, *, approved_brief: bool = True) -> int:
    with SessionLocal() as db:
        project = Project(owner_id=owner_id, title="Search project")
        db.add(project)
        db.commit()
        db.add(Brief(project_id=project.id, version=1, is_approved=approved_brief))
        db.commit()
        return project.id


def _campaign(client: TestClient, project_id: int) -> dict:
    response = client.post(f"/api/projects/{project_id}/campaigns", json=BUDGET)
    assert response.status_code == 201, response.text
    return response.json()


def _add_candidate(campaign_id: int, iteration: int, **kwargs) -> int:
    """Insert an archive row directly; candidates are written by the engine."""
    with SessionLocal() as db:
        candidate = Candidate(
            campaign_id=campaign_id,
            iteration=iteration,
            edit_family=kwargs.pop("edit_family", "optimizer"),
            status=kwargs.pop("status", "kept"),
            score=kwargs.pop("score", None),
            cost_vector_json=kwargs.pop("cost_vector_json", {}),
            **kwargs,
        )
        db.add(candidate)
        db.commit()
        return candidate.id


# ---------------------------------------------------------------------------
# Creation gates
# ---------------------------------------------------------------------------
def test_campaign_requires_approved_brief():
    with TestClient(app_module.app) as client:
        owner = _register(client, "nobrief")
        project_id = _project(owner, approved_brief=False)
        response = client.post(f"/api/projects/{project_id}/campaigns", json=BUDGET)
        assert response.status_code == 400
        assert "brief" in response.json()["detail"].lower()


def test_campaign_requires_a_declared_budget():
    """An unbounded search can only be stopped by noticing the bill."""
    with TestClient(app_module.app) as client:
        owner = _register(client, "nobudget")
        project_id = _project(owner)
        response = client.post(f"/api/projects/{project_id}/campaigns", json={"budget": {}})
        assert response.status_code == 400
        assert "budget" in response.json()["detail"].lower()


def test_campaign_created_queued_with_config_and_history():
    with TestClient(app_module.app) as client:
        owner = _register(client, "create")
        project_id = _project(owner)
        body = client.post(
            f"/api/projects/{project_id}/campaigns",
            json={"name": "Sweep A", "budget": {"max_iters": 10}, "explore": 0.3,
                  "edit_families": {"optimizer": 0.7}, "stopping": {"stagnation_iters": 5}},
        )
        assert body.status_code == 201, body.text
        payload = body.json()
        assert payload["status"] == "queued"
        assert payload["name"] == "Sweep A"
        assert payload["iteration"] == 0
        assert payload["config"]["explore"] == 0.3
        assert payload["config"]["stopping"]["stagnation_iters"] == 5
        assert payload["spend"]["usd"] == 0.0
        assert payload["best_candidate_id"] is None

        with SessionLocal() as db:
            history = db.query(StatusHistory).filter(
                StatusHistory.entity_type == "campaign", StatusHistory.entity_id == payload["id"]
            ).all()
            assert [h.to_status for h in history] == ["queued"]


def test_campaign_list_and_get_are_owner_scoped():
    with TestClient(app_module.app) as owner_client, TestClient(app_module.app) as other_client:
        owner = _register(owner_client, "owner")
        _register(other_client, "intruder")
        project_id = _project(owner)
        campaign = _campaign(owner_client, project_id)

        assert owner_client.get(f"/api/campaigns/{campaign['id']}").status_code == 200
        listing = owner_client.get(f"/api/projects/{project_id}/campaigns")
        assert [c["id"] for c in listing.json()] == [campaign["id"]]

        # Another account must not be able to read the campaign or its project.
        assert other_client.get(f"/api/campaigns/{campaign['id']}").status_code == 404
        assert other_client.get(f"/api/projects/{project_id}/campaigns").status_code == 404


def test_stop_is_idempotent_and_recorded():
    with TestClient(app_module.app) as client:
        owner = _register(client, "stop")
        campaign = _campaign(client, _project(owner))
        first = client.post(f"/api/campaigns/{campaign['id']}/stop")
        assert first.status_code == 200
        assert first.json()["status"] == "stopped"
        assert first.json()["ended_at"] is not None

        # Stopping again must not reopen or re-timestamp a terminal campaign.
        second = client.post(f"/api/campaigns/{campaign['id']}/stop")
        assert second.status_code == 200
        assert second.json()["ended_at"] == first.json()["ended_at"]


# ---------------------------------------------------------------------------
# Archive, ranking, and the Pareto frontier
# ---------------------------------------------------------------------------
def test_candidates_include_failures_and_support_filtering():
    with TestClient(app_module.app) as client:
        owner = _register(client, "archive")
        campaign = _campaign(client, _project(owner))
        cid = campaign["id"]
        _add_candidate(cid, 0, status="kept", score=1.0, edit_family="optimizer")
        _add_candidate(cid, 1, status="invalid", failure_kind="nan", edit_family="architecture")
        _add_candidate(cid, 2, status="discarded", score=0.5, edit_family="optimizer")

        everything = client.get(f"/api/campaigns/{cid}/candidates").json()
        # Negative results stay in the archive; that is the point of keeping them.
        assert [c["status"] for c in everything] == ["kept", "invalid", "discarded"]

        by_status = client.get(f"/api/campaigns/{cid}/candidates?filter=invalid").json()
        assert len(by_status) == 1 and by_status[0]["failure_kind"] == "nan"

        by_family = client.get(f"/api/campaigns/{cid}/candidates?filter=optimizer").json()
        assert {c["edit_family"] for c in by_family} == {"optimizer"}

        # The campaign summary tallies failures by kind for the console.
        assert client.get(f"/api/campaigns/{cid}").json()["failure_counts"] == {"nan": 1}


def test_leaderboard_ranks_measured_candidates_and_respects_direction():
    with TestClient(app_module.app) as client:
        owner = _register(client, "board")
        campaign = _campaign(client, _project(owner))
        cid = campaign["id"]
        low = _add_candidate(cid, 0, score=8.0, cost_vector_json={"usd": 2.0})
        high = _add_candidate(cid, 1, score=12.0, cost_vector_json={"usd": 5.0})
        _add_candidate(cid, 2, status="queued", score=None)

        rows = client.get(f"/api/campaigns/{cid}/leaderboard").json()
        # Unmeasured candidates are absent, not ranked last with a null score.
        assert [r["candidate_id"] for r in rows] == [high, low]
        assert rows[0]["cost_usd"] == 5.0

        # A lower-is-better metric must invert the ranking, not the stored score.
        with SessionLocal() as db:
            row = db.get(Campaign, cid)
            row.config_json = {**row.config_json, "lower_is_better": True}
            db.commit()
        inverted = client.get(f"/api/campaigns/{cid}/leaderboard").json()
        assert [r["candidate_id"] for r in inverted] == [low, high]


def test_frontier_flags_dominated_candidates():
    """A candidate is dominated only if another is no worse on both axes."""
    with TestClient(app_module.app) as client:
        owner = _register(client, "pareto")
        campaign = _campaign(client, _project(owner))
        cid = campaign["id"]
        cheap_good = _add_candidate(cid, 0, score=10.0, cost_vector_json={"usd": 1.0})
        dominated = _add_candidate(cid, 1, score=8.0, cost_vector_json={"usd": 2.0})
        pricey_best = _add_candidate(cid, 2, score=12.0, cost_vector_json={"usd": 5.0})
        # No cost recorded → cannot be placed in the tradeoff space at all.
        _add_candidate(cid, 3, score=99.0, cost_vector_json={})

        points = {p["candidate_id"]: p for p in client.get(f"/api/campaigns/{cid}/frontier").json()}
        assert set(points) == {cheap_good, dominated, pricey_best}
        assert points[dominated]["dominated"] is True
        assert points[cheap_good]["dominated"] is False
        assert points[pricey_best]["dominated"] is False
        assert points[cheap_good]["cost_label"] == "usd"


def test_agent_metrics_are_derived_from_the_archive():
    with TestClient(app_module.app) as client:
        owner = _register(client, "metrics")
        campaign = _campaign(client, _project(owner))
        cid = campaign["id"]
        _add_candidate(cid, 0, status="kept", score=1.0)
        _add_candidate(cid, 1, status="discarded", score=0.5,
                       notes_json={"interpretation": "slower but stabler init"})
        _add_candidate(cid, 2, status="invalid", failure_kind="oom")

        metrics = client.get(f"/api/campaigns/{cid}").json()["metrics"]
        assert metrics["hit_rate"] == 0.5  # 1 kept of 2 evaluated
        assert round(metrics["invalid_rate"], 4) == round(1 / 3, 4)
        # The one regression carried an interpretation worth mining later.
        assert metrics["useful_regression_rate"] == 1.0


# ---------------------------------------------------------------------------
# Human governance
# ---------------------------------------------------------------------------
def test_promote_is_a_recorded_human_gate():
    with TestClient(app_module.app) as client:
        owner = _register(client, "promote")
        project_id = _project(owner)
        campaign = _campaign(client, project_id)
        candidate_id = _add_candidate(campaign["id"], 0, status="running", score=9.5)

        response = client.post(
            f"/api/candidates/{candidate_id}/promote", json={"notes": "Reproduced twice."}
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "kept"
        assert body["audit"]["decision"] == "promoted"
        assert body["audit"]["reviewed_by"]

        summary = client.get(f"/api/campaigns/{campaign['id']}").json()
        assert summary["best_candidate_id"] == candidate_id
        assert summary["best_score"] == 9.5

        with SessionLocal() as db:
            approval = db.query(Approval).filter(
                Approval.action_type == "candidate_promotion", Approval.target_id == candidate_id
            ).one()
            assert approval.notes == "Reproduced twice."
            assert approval.project_id == project_id


def test_promote_refuses_unmeasured_or_invalid_candidates():
    with TestClient(app_module.app) as client:
        owner = _register(client, "badpromote")
        campaign = _campaign(client, _project(owner))
        unscored = _add_candidate(campaign["id"], 0, status="queued", score=None)
        broken = _add_candidate(campaign["id"], 1, status="invalid", score=5.0, failure_kind="nan")

        assert client.post(f"/api/candidates/{unscored}/promote", json={"notes": ""}).status_code == 400
        assert client.post(f"/api/candidates/{broken}/promote", json={"notes": ""}).status_code == 400


def test_reject_keeps_the_record_and_clears_a_stale_best():
    with TestClient(app_module.app) as client:
        owner = _register(client, "reject")
        campaign = _campaign(client, _project(owner))
        candidate_id = _add_candidate(campaign["id"], 0, status="running", score=7.0)
        client.post(f"/api/candidates/{candidate_id}/promote", json={"notes": "provisional"})

        response = client.post(
            f"/api/candidates/{candidate_id}/reject", json={"reason": "Gain was inside noise."}
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "discarded"
        assert body["audit"]["decision"] == "rejected"
        # The reason is preserved as evidence, in its own field so it cannot
        # overwrite an interpretation the agent recorded.
        assert body["notes"]["rejection_reason"] == "Gain was inside noise."

        summary = client.get(f"/api/campaigns/{campaign['id']}").json()
        assert summary["best_candidate_id"] is None
        assert summary["best_score"] is None


def test_reject_requires_a_reason():
    with TestClient(app_module.app) as client:
        owner = _register(client, "noreason")
        campaign = _campaign(client, _project(owner))
        candidate_id = _add_candidate(campaign["id"], 0, score=1.0)
        assert client.post(f"/api/candidates/{candidate_id}/reject", json={"reason": ""}).status_code == 422


def test_audit_reports_each_check_separately():
    with TestClient(app_module.app) as client:
        owner = _register(client, "audit")
        campaign = _campaign(client, _project(owner))
        candidate_id = _add_candidate(
            campaign["id"], 0, score=3.0,
            audit_json={"eval_hash_match": False, "leakage_scan": "flagged", "budget_compliant": True},
        )
        report = client.get(f"/api/candidates/{candidate_id}/audit").json()
        checks = {c["name"]: c for c in report["checks"]}
        # A failing hash and a leakage flag call for different responses, so they
        # are reported as separate checks rather than one aggregate verdict.
        assert checks["evaluator_hash"]["ok"] is False
        assert checks["leakage_scan"]["ok"] is False
        assert checks["budget_compliance"]["ok"] is True
        assert checks["metric_present"]["ok"] is True
        assert checks["run_linked"]["ok"] is False  # no run linked in this fixture


def test_candidate_access_is_owner_scoped():
    with TestClient(app_module.app) as owner_client, TestClient(app_module.app) as other_client:
        owner = _register(owner_client, "cowner")
        _register(other_client, "cintruder")
        campaign = _campaign(owner_client, _project(owner))
        candidate_id = _add_candidate(campaign["id"], 0, score=1.0)

        assert owner_client.get(f"/api/candidates/{candidate_id}").status_code == 200
        for path, method, payload in [
            (f"/api/candidates/{candidate_id}", "get", None),
            (f"/api/candidates/{candidate_id}/audit", "get", None),
            (f"/api/candidates/{candidate_id}/trace", "get", None),
            (f"/api/candidates/{candidate_id}/promote", "post", {"notes": ""}),
            (f"/api/candidates/{candidate_id}/reject", "post", {"reason": "x"}),
        ]:
            call = getattr(other_client, method)
            response = call(path) if payload is None else call(path, json=payload)
            assert response.status_code == 404, f"{method} {path} leaked to another user"


# ---------------------------------------------------------------------------
# Trace archive containment
# ---------------------------------------------------------------------------
def test_trace_tree_and_file_read_back_archived_evidence():
    with TestClient(app_module.app) as client:
        owner = _register(client, "trace")
        campaign = _campaign(client, _project(owner))
        candidate_id = _add_candidate(
            campaign["id"], 0, score=2.0,
            metrics_json={"steps": [{"step": 0, "phase": "hypothesize", "parser_status": "ok"}]},
        )
        root = ARTIFACT_ROOT / f"campaign-{campaign['id']}" / f"candidate-{candidate_id}"
        (root / "prompts").mkdir(parents=True, exist_ok=True)
        (root / "stdout.log").write_text("training complete", encoding="utf-8")
        (root / "prompts" / "000.txt").write_text("system prompt", encoding="utf-8")

        trace = client.get(f"/api/candidates/{candidate_id}/trace").json()
        assert trace["stdout"] == "training complete"
        assert trace["steps"][0]["phase"] == "hypothesize"
        names = {node["name"] for node in trace["tree"]}
        assert {"prompts", "stdout.log"} <= names

        contents = client.get(
            f"/api/candidates/{candidate_id}/trace/file", params={"path": "prompts/000.txt"}
        )
        assert contents.status_code == 200
        assert contents.json()["content"] == "system prompt"


def test_trace_file_refuses_paths_outside_the_candidate_archive():
    """Trace paths come from the client, so containment is enforced server-side."""
    with TestClient(app_module.app) as client:
        owner = _register(client, "traversal")
        campaign = _campaign(client, _project(owner))
        candidate_id = _add_candidate(campaign["id"], 0, score=1.0)
        root = ARTIFACT_ROOT / f"campaign-{campaign['id']}" / f"candidate-{candidate_id}"
        root.mkdir(parents=True, exist_ok=True)
        # A file that exists, but belongs to a sibling candidate's directory.
        (root.parent / "secret.txt").write_text("other candidate", encoding="utf-8")

        for hostile in ["../secret.txt", "../../../etc/passwd", "/etc/passwd", "", "prompts/../../secret.txt"]:
            response = client.get(
                f"/api/candidates/{candidate_id}/trace/file", params={"path": hostile}
            )
            assert response.status_code in {400, 404}, f"{hostile!r} was not rejected"
            assert "other candidate" not in response.text
