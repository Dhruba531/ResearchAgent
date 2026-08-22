"""P7 anti-hallucination: groundedness parsing/scoring, the export gate
(block + force override), and execution-grounds-the-draft ordering."""
import asyncio
import os
import sys
import time
from pathlib import Path

os.environ["AGENTLAB_DATABASE_URL"] = "sqlite:///:memory:"
os.environ["AGENTLAB_DATA_DIR"] = "/tmp/agentlab-test-data"
os.environ["AGENTLAB_ARTIFACT_ROOT"] = "/tmp/agentlab-test-data/artifacts"
os.environ["AGENTLAB_MOCK_STEP_DELAY"] = "0.01"
os.environ["AGENTLAB_VERIFY_URLS"] = "0"  # no network

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from fastapi.testclient import TestClient  # noqa: E402

import groundedness as gr  # noqa: E402
import provider_adapters  # noqa: E402
import real_runner as rr  # noqa: E402
from app import app  # noqa: E402
from database import SessionLocal  # noqa: E402
from runner_common import ConnectionManager  # noqa: E402
from models import AgentSession, Brief, Project, ProviderKey, ReviewFinding, Run, User  # noqa: E402


# ---- pure parsing / scoring --------------------------------------------------
def test_extract_urls_and_placeholders():
    text = "See https://arxiv.org/abs/1234.5678, and (https://example.com/p). Dup https://example.com/p."
    urls = gr.extract_urls(text)
    assert urls == ["https://arxiv.org/abs/1234.5678", "https://example.com/p"]  # deduped, punct-stripped
    assert gr.count_placeholders("a [CITATION NEEDED: x] b [CITATION NEEDED] c") == 2
    assert gr.count_placeholders("clean text") == 0


def test_fabricated_flags():
    none = "## Unsupported or Fabricated\nNone — all citations verified.\n## References"
    assert gr.fabricated_flags(none) == 0
    flagged = "## Unsupported or Fabricated\n1. Smith 2020 — no such paper.\n2. Fake benchmark.\n## References"
    assert gr.fabricated_flags(flagged) == 2
    assert gr.fabricated_flags("no such section here") == 0


def test_score_monotonic():
    assert gr.score(0, 0, 0) == 1.0
    assert gr.score(0, 0, 2) == 0.7
    assert gr.score(3, 3, 3) < gr.score(1, 1, 1)
    assert gr.score(100, 100, 100) == 0.0  # clamped


def test_check_urls_disabled_returns_unchecked():
    res = asyncio.run(gr.check_urls(["https://example.com"]))
    assert res == {"https://example.com": None}  # disabled -> no network, no verdict


def test_check_urls_blocks_literal_and_dns_private_targets(monkeypatch):
    import httpx

    calls = []

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            pass

        def build_request(self, method, url, **kwargs):
            calls.append((method, url, kwargs))
            raise AssertionError("private target must not be requested")

        async def send(self, *_args, **_kwargs):
            raise AssertionError("private target must not be requested")

    def private_dns(host, port, **_kwargs):
        return [(2, 1, 6, "", ("10.0.0.9", port))]

    monkeypatch.setattr(gr, "verify_urls_enabled", lambda: True)
    monkeypatch.setattr(gr.socket, "getaddrinfo", private_dns)
    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    urls = ["http://127.0.0.1/admin", "https://internal.example/metadata"]
    assert asyncio.run(gr.check_urls(urls)) == {url: False for url in urls}
    assert calls == []


def test_check_urls_revalidates_redirect_target(monkeypatch):
    import httpx

    calls = []

    class Response:
        status_code = 302
        headers = {"location": "http://169.254.169.254/latest/meta-data"}

        async def aclose(self):
            pass

    class Request:
        def __init__(self, method, url, kwargs):
            self.method = method
            self.url = url
            self.kwargs = kwargs

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            pass

        def build_request(self, method, url, **kwargs):
            calls.append((method, url, kwargs))
            return Request(method, url, kwargs)

        async def send(self, _request, **_kwargs):
            return Response()

    def public_dns(_host, port, **_kwargs):
        return [(2, 1, 6, "", ("93.184.216.34", port))]

    monkeypatch.setattr(gr, "verify_urls_enabled", lambda: True)
    monkeypatch.setattr(gr.socket, "getaddrinfo", public_dns)
    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    url = "https://public.example/paper"
    assert asyncio.run(gr.check_urls([url])) == {url: False}
    assert len(calls) == 1  # redirect target was blocked before a second request
    assert calls[0][0] == "HEAD"
    assert calls[0][1] == "https://93.184.216.34/paper"
    assert calls[0][2]["headers"]["Host"] == "public.example"
    assert calls[0][2]["extensions"]["sni_hostname"] == "public.example"


def test_assess_flags_unverified():
    draft = "Result is strong [CITATION NEEDED: baseline]. See https://x.example/paper."
    audit = "## Unsupported or Fabricated\n1. The 78% figure is unsupported.\n## References"
    report = asyncio.run(gr.assess(draft, audit))
    assert report["placeholders"] == 1 and report["fabricated_flags"] == 1
    assert report["verified"] is False and report["score"] < 1.0


# ---- export gate -------------------------------------------------------------
def _seed_completed_run(client: TestClient, groundedness: dict) -> tuple[int, int]:
    email = f"gate-{os.urandom(4).hex()}@example.test"
    client.post("/api/auth/register", json={"name": "G", "email": email, "password": "agentlab-test"})
    me = client.get("/api/auth/me").json()
    with SessionLocal() as db:
        project = Project(owner_id=me["id"], title="Gate")
        db.add(project)
        db.commit()
        brief = Brief(project_id=project.id, version=1, is_approved=True, content_json={"title": "G"})
        db.add(brief)
        db.commit()
        session = AgentSession(project_id=project.id, brief_id=brief.id, provider="anthropic")
        db.add(session)
        db.commit()
        run = Run(session_id=session.id, project_id=project.id, brief_id=brief.id, status="completed",
                  draft_markdown="# Final draft", analysis_json={"groundedness": groundedness})
        db.add(run)
        db.commit()
        db.add(ReviewFinding(project_id=project.id, run_id=run.id, category="methods",
                             severity="low", finding="ok", suggested_fix="none"))
        db.commit()
        return project.id, run.id


def test_export_blocked_on_fabrication_then_forced():
    with TestClient(app) as client:
        bad = {"verified": False, "score": 0.55, "fabricated_flags": 2, "placeholders": 1, "urls_dead": 0}
        project_id, _ = _seed_completed_run(client, bad)
        blocked = client.post(f"/api/projects/{project_id}/final/approve", json={"notes": "ship"})
        assert blocked.status_code == 409
        assert "Groundedness check failed" in blocked.json()["detail"]
        # Human override.
        forced = client.post(f"/api/projects/{project_id}/final/approve", json={"notes": "ack", "force": True})
        assert forced.status_code == 200


def test_export_allowed_when_verified():
    with TestClient(app) as client:
        good = {"verified": True, "score": 1.0, "fabricated_flags": 0, "placeholders": 0, "urls_dead": 0}
        project_id, _ = _seed_completed_run(client, good)
        assert client.post(f"/api/projects/{project_id}/final/approve", json={"notes": "ship"}).status_code == 200


def test_export_not_blocked_without_groundedness():
    # Older provider runs may predate groundedness metadata; the gate is a no-op.
    with TestClient(app) as client:
        email = f"nog-{os.urandom(4).hex()}@example.test"
        client.post("/api/auth/register", json={"name": "N", "email": email, "password": "agentlab-test"})
        me = client.get("/api/auth/me").json()
        with SessionLocal() as db:
            project = Project(owner_id=me["id"], title="NoG")
            db.add(project)
            db.commit()
            brief = Brief(project_id=project.id, version=1, is_approved=True, content_json={})
            db.add(brief)
            db.commit()
            sess = AgentSession(project_id=project.id, brief_id=brief.id, provider="anthropic")
            db.add(sess)
            db.commit()
            run = Run(session_id=sess.id, project_id=project.id, brief_id=brief.id, status="completed",
                      draft_markdown="# Draft", analysis_json={})
            db.add(run)
            db.commit()
            db.add(ReviewFinding(project_id=project.id, run_id=run.id, category="methods",
                                 severity="low", finding="x", suggested_fix="y"))
            db.commit()
            pid = project.id
        assert client.post(f"/api/projects/{pid}/final/approve", json={"notes": "ok"}).status_code == 200


# ---- execution grounds the draft (ordering) ----------------------------------
def test_execution_runs_before_and_grounds_the_draft(monkeypatch):
    """With execute on, the experiment runs after the plan and its real results
    are injected into the draft stage's prompt."""
    monkeypatch.setenv("AGENTLAB_ALLOW_EXECUTION", "1")
    calls = []

    async def execute_double(**_kwargs):
        return {
            "ok": True,
            "mode": "real",
            "status": "COMPLETED",
            "exit_code": 0,
            "seconds": 1.0,
            "stdout": "measured_accuracy=0.91",
            "stderr": "",
            "artifacts": [],
        }

    async def fake(*, system, user, on_text=lambda _s: None, **kw):
        calls.append({"system": system, "user": user})
        if "You are the Experiment Planner" in system:
            text = "## Methodology\n```python\nprint('run')\n```\n"
        elif "You are the Paper Assembler" in system:
            text = "# Draft\nFigure 1: acc vs cost.\n"
        elif "You are the Editor agent" in system:
            text = "# Revised\n"
        elif "You are the Citation Verifier" in system:
            text = "## Verdict\nok"
        elif "adversarial reviewer" in system:
            text = "## Score\n8/10"
        else:
            text = "x"
        on_text(text)
        return text, 30, 30

    monkeypatch.setattr(provider_adapters, "stream_stage", fake)
    monkeypatch.setattr(rr.runpod_adapter, "run_experiment", execute_double)
    with TestClient(app):
        with SessionLocal() as db:
            user = User(name="Ord", email=f"ord-{os.urandom(3).hex()}@x.test", password_hash="")
            db.add(user)
            db.commit()
            db.add(ProviderKey(user_id=user.id, provider="anthropic", api_key="sk-ant-x", is_enabled=True))
            db.add(ProviderKey(user_id=user.id, provider="runpod", api_key="rp", model_name="ep", is_enabled=True))
            project = Project(owner_id=user.id, title="Ord")
            db.add(project)
            db.commit()
            brief = Brief(project_id=project.id, version=1, is_approved=True, content_json={"title": "Ord"})
            db.add(brief)
            db.commit()
            sess = AgentSession(project_id=project.id, brief_id=brief.id, provider="anthropic")
            db.add(sess)
            db.commit()
            run = Run(session_id=sess.id, project_id=project.id, brief_id=brief.id,
                      config_json={"execute": True}, cost_estimate=5.0, budget_threshold=50.0)
            db.add(run)
            db.commit()
            run_id = run.id
        asyncio.run(rr.RealAgentRunner(ConnectionManager())._run(run_id))

    draft_call = next(c for c in calls if "You are the Paper Assembler" in c["system"])
    assert "Measured experiment results" in draft_call["user"]  # real results injected pre-draft
    assert "measured_accuracy=0.91" in draft_call["user"]
