"""P3 production tests: Editor/revise stage outputs, security headers,
and the /api/status cache."""
import os
import sys
from pathlib import Path

os.environ["AGENTLAB_DATABASE_URL"] = "sqlite:///:memory:"
os.environ["AGENTLAB_DATA_DIR"] = "/tmp/agentlab-test-data"
os.environ["AGENTLAB_ARTIFACT_ROOT"] = "/tmp/agentlab-test-data/artifacts"
os.environ["AGENTLAB_MOCK_STEP_DELAY"] = "0.01"

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from fastapi.testclient import TestClient  # noqa: E402

from app import app  # noqa: E402
from database import SessionLocal  # noqa: E402
from runner_common import ConnectionManager  # noqa: E402
from models import AgentSession, Artifact, Brief, Project, Run, User  # noqa: E402
from real_runner import RealAgentRunner  # noqa: E402
import crypto  # noqa: E402


def _make_run(db) -> Run:
    """Minimal user->project->brief->session->run chain for output tests."""
    user = User(name="P3", email=f"p3-{id(db)}@example.test", password_hash="")
    db.add(user)
    db.commit()
    project = Project(owner_id=user.id, title="P3 Project")
    db.add(project)
    db.commit()
    brief = Brief(project_id=project.id, version=1, content_json={"title": "P3 Study"})
    db.add(brief)
    db.commit()
    session = AgentSession(project_id=project.id, brief_id=brief.id, provider="anthropic")
    db.add(session)
    db.commit()
    run = Run(session_id=session.id, project_id=project.id, brief_id=brief.id, cost_estimate=5.0)
    db.add(run)
    db.commit()
    return run


# ---- Editor/revise stage outputs --------------------------------------------
def test_finish_outputs_prefers_revised_draft():
    with TestClient(app):  # lifespan -> tables exist on the shared in-memory DB
        runner = RealAgentRunner(ConnectionManager())
        with SessionLocal() as db:
            run = _make_run(db)
            ctx = {
                "plan": "the plan",
                "draft": "# Original draft",
                "citations": "audit",
                "revised": "# Revised draft (editor)",
            }
            runner._finish_outputs(db, run.id, "anthropic", "claude-opus-4-8", ctx, {"methods": "ok. ## Required Changes\nnone"}, {"input": 10, "output": 10})
            db.refresh(run)
            assert run.draft_markdown == "# Revised draft (editor)"
            assert run.analysis_json["revised"] is True
            names = [a.name for a in db.query(Artifact).filter(Artifact.run_id == run.id).all()]
            assert "paper-revised.md" in names
            assert "paper-draft.md" in names  # original preserved for the audit trail


def test_finish_outputs_without_revision_keeps_original():
    with TestClient(app):
        runner = RealAgentRunner(ConnectionManager())
        with SessionLocal() as db:
            run = _make_run(db)
            ctx = {"plan": "p", "draft": "# Original only", "citations": ""}
            runner._finish_outputs(db, run.id, "anthropic", "claude-opus-4-8", ctx, {}, None)
            db.refresh(run)
            assert run.draft_markdown == "# Original only"
            assert run.analysis_json["revised"] is False
            names = [a.name for a in db.query(Artifact).filter(Artifact.run_id == run.id).all()]
            assert "paper-revised.md" not in names


def test_revise_prompt_builder_includes_reviews():
    import agents

    system, user, max_tokens, tools = agents.build_prompt(
        "revise", {"draft": "D", "reviews": "R-CRITIQUE", "citations": "C-AUDIT"}
    )
    assert "Editor" in system
    assert "R-CRITIQUE" in user and "C-AUDIT" in user
    assert max_tokens == agents.MAX_TOKENS["revise"]
    assert tools and tools[0]["name"] == "web_search"


# ---- security headers ---------------------------------------------------------
def test_security_headers_present():
    with TestClient(app) as client:
        r = client.get("/health")
        assert r.headers["X-Content-Type-Options"] == "nosniff"
        assert r.headers["X-Frame-Options"] == "DENY"
        assert r.headers["Referrer-Policy"] == "no-referrer"
        assert "default-src 'self'" in r.headers["Content-Security-Policy"]
        api = client.get("/api/status")
        assert "max-age" in api.headers.get("Cache-Control", "")  # status overrides no-store
        auth = client.post("/api/auth/login", json={"email": "x@y.test", "password": "nope"})
        assert auth.headers.get("Cache-Control") == "no-store"


def test_production_secret_encryption_fails_closed(monkeypatch):
    monkeypatch.setenv("AGENTLAB_ENV", "production")
    monkeypatch.delenv("AGENTLAB_SECRET_KEY", raising=False)
    monkeypatch.setattr(crypto, "_resolved", False)
    monkeypatch.setattr(crypto, "_fernet", None)
    try:
        import pytest

        with pytest.raises(crypto.SecretConfigurationError):
            crypto.validate_configuration()
    finally:
        # Do not leave the module's lazy cache poisoned for later tests.
        crypto._resolved = False
        crypto._fernet = None


# ---- /api/status cache ---------------------------------------------------------
def test_status_is_cached_within_ttl():
    with TestClient(app) as client:
        first = client.get("/api/status").json()
        second = client.get("/api/status").json()
        assert first["ts"] == second["ts"]  # identical payload => served from cache
