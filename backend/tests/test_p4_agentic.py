"""P4 agentic-orchestration tests: action gating, decision parsing, score
extraction, and two full agentic runs driven by a fake provider (no network)."""
import asyncio
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

import provider_adapters  # noqa: E402
import real_runner as rr  # noqa: E402
from app import app  # noqa: E402
from database import SessionLocal  # noqa: E402
from runner_common import ConnectionManager  # noqa: E402
from models import AgentSession, Artifact, Brief, Project, ProviderKey, ReviewFinding, Run, User  # noqa: E402


# ---- pure primitives ---------------------------------------------------------
def test_allowed_actions_preconditions():
    counts = {a: 0 for a in rr.ACTION_CAPS}
    assert rr.allowed_actions(counts, {}, {}) == ["plan"]  # nothing exists yet
    ctx = {"plan": "p"}
    counts["plan"] = 1
    assert rr.allowed_actions(counts, ctx, {}) == ["draft"]  # plan capped, draft unlocked
    ctx["draft"] = "d"
    counts["draft"] = 1
    allowed = rr.allowed_actions(counts, ctx, {})
    assert "verify" in allowed and "review" not in allowed  # panel needs the citation audit
    ctx["citations"] = "c"
    counts["verify"] = 1
    allowed = rr.allowed_actions(counts, ctx, {})
    assert "review" in allowed and "finish" not in allowed  # finish needs reviews
    reviews = {"methods": "ok"}
    allowed = rr.allowed_actions(counts, ctx, reviews)
    assert "revise" in allowed and "finish" in allowed


def test_allowed_actions_caps_block_rerun():
    counts = {"plan": 1, "draft": 2, "verify": 2, "review": 2, "revise": 2}
    allowed = rr.allowed_actions(counts, {"plan": "p", "draft": "d", "citations": "c"}, {"m": "r"})
    assert allowed == ["finish"]  # every cap hit -> only finish remains


def test_fallback_prefers_forward_progress():
    counts = {"plan": 1, "draft": 1, "verify": 1, "review": 1, "revise": 0}
    allowed = ["draft", "verify", "review", "revise", "finish"]
    assert rr.fallback_action(allowed, counts) == "revise"  # first not-yet-run stage
    counts["revise"] = 1
    assert rr.fallback_action(allowed, counts) == "finish"  # everything ran once -> finish


def test_parse_action_variants():
    assert rr.parse_action('{"action": "verify", "reason": "check refs"}') == {"action": "verify", "reason": "check refs"}
    fenced = 'Sure!\n```json\n{"action": "revise", "reason": "low scores"}\n```'
    assert rr.parse_action(fenced)["action"] == "revise"
    assert rr.parse_action("I think we should plan next!") is None
    assert rr.parse_action('{"reason": "no action key"}') is None
    assert rr.parse_action("") is None


def test_review_score_extraction():
    assert rr.review_score("## Score  (1-10) and Recommendation\n6/10 — Major revision") == 6.0
    assert rr.review_score("Score: 8. Recommendation: Minor revision") == 8.0
    assert rr.review_score("## Score (1-10)\nno number given") is None
    assert rr.review_score("") is None


def test_advisor_verdict_is_explicit_and_heading_scoped():
    assert rr.advisor_requests_revision("## Verdict\nREVISE\n## Required Changes\nFix scope")
    assert not rr.advisor_requests_revision("## Verdict\nAPPROVE\n## Critical Risks\nRevise wording later")
    assert not rr.advisor_requests_revision("REVISE")


# ---- full agentic runs with a fake provider -----------------------------------
def _seed_run(config_json: dict) -> int:
    with SessionLocal() as db:
        user = User(name="Agentic", email=f"agentic-{os.urandom(3).hex()}@example.test", password_hash="")
        db.add(user)
        db.commit()
        db.add(ProviderKey(user_id=user.id, provider="anthropic", api_key="sk-ant-test-000", is_enabled=True))
        project = Project(owner_id=user.id, title="Agentic Project")
        db.add(project)
        db.commit()
        brief = Brief(project_id=project.id, version=1, content_json={"title": "Agentic Study"}, is_approved=True)
        db.add(brief)
        db.commit()
        session = AgentSession(project_id=project.id, brief_id=brief.id, provider="anthropic")
        db.add(session)
        db.commit()
        run = Run(
            session_id=session.id, project_id=project.id, brief_id=brief.id,
            config_json=config_json, cost_estimate=5.0, budget_threshold=12.0,
        )
        db.add(run)
        db.commit()
        return run.id


def _fake_provider(decisions: list):
    """stream_stage stand-in: routes by persona in the system prompt."""

    async def fake(*, provider, api_key, model, system, user, max_tokens, tools=None,
                   on_text=lambda _s: None, should_cancel=lambda: False):
        # Match persona OPENINGS — later prompts mention other personas in
        # their body text ("a Citation Verifier's audit…"), so substring-anywhere
        # routing would misfire.
        if "You are the Orchestrator agent" in system:
            text = decisions.pop(0) if decisions else "gibberish"
        elif "You are the Experiment Planner" in system:
            text = "PLAN CONTENT"
        elif "You are the Paper Assembler" in system:
            text = "# DRAFT v1"
        elif "You are the Editor agent" in system:
            text = "# REVISED PAPER"
        elif "You are the Citation Verifier" in system:
            text = "## Verdict\nWell grounded."
        elif "adversarial reviewer" in system:
            text = "## Score\n7/10 — Minor revision\n## Required Changes\nTighten section 3."
        else:
            raise AssertionError(f"unexpected stage system prompt: {system[:80]}")
        on_text(text)
        return text, 100, 200

    return fake


def _run_agentic_case(monkeypatch, decisions: list) -> int:
    run_id = _seed_run({"orchestration": "agentic"})
    monkeypatch.setattr(provider_adapters, "stream_stage", _fake_provider(decisions))
    runner = rr.RealAgentRunner(ConnectionManager())
    asyncio.run(runner._run(run_id))
    return run_id


def test_agentic_run_follows_orchestrator_decisions(monkeypatch):
    with TestClient(app):
        decisions = [
            '{"action": "plan", "reason": "start"}',
            '{"action": "draft", "reason": "write it"}',
            '{"action": "verify", "reason": "check citations"}',
            '{"action": "review", "reason": "panel critique"}',
            '{"action": "revise", "reason": "address findings"}',
            '{"action": "finish", "reason": "quality adequate"}',
        ]
        run_id = _run_agentic_case(monkeypatch, decisions)
        with SessionLocal() as db:
            run = db.get(Run, run_id)
            assert run.status == "completed"
            assert run.draft_markdown == "# REVISED PAPER"
            analysis = run.analysis_json
            assert analysis["orchestration"] == "agentic"
            assert [a["action"] for a in analysis["actions"]] == [
                "plan", "draft", "verify", "review", "revise", "verify", "review", "finish",
            ]
            assert analysis["scores"] == {"methods": 7.0, "statistics": 7.0, "novelty": 7.0, "clarity": 7.0}
            assert analysis["avg_score"] == 7.0
            assert run.actual_cost > 0  # metered from fake token usage
            names = [a.name for a in db.query(Artifact).filter(Artifact.run_id == run_id).all()]
            assert "paper-revised.md" in names and "paper-draft.md" in names
            assert db.query(ReviewFinding).filter(ReviewFinding.run_id == run_id).count() == 4


def test_agentic_run_survives_garbage_orchestrator(monkeypatch):
    """A broken orchestrator degrades to the canonical pipeline, never a stuck run."""
    with TestClient(app):
        run_id = _run_agentic_case(monkeypatch, [])  # every decision is 'gibberish'
        with SessionLocal() as db:
            run = db.get(Run, run_id)
            assert run.status == "completed"
            actions = [a["action"] for a in run.analysis_json["actions"]]
            assert actions == ["plan", "draft", "verify", "review", "revise", "verify", "review", "finish"]
            assert all(a["reason"].startswith("fallback") or a["action"] == "finish" for a in run.analysis_json["actions"][:5])
            assert run.draft_markdown == "# REVISED PAPER"


def test_pipeline_mode_untouched_by_default(monkeypatch):
    """No orchestration flag -> classic fixed pipeline, no orchestrator calls."""
    with TestClient(app):
        orchestrator_called = {"n": 0}

        async def fake(*, system, on_text=lambda _s: None, **kwargs):
            if "Orchestrator agent" in system:
                orchestrator_called["n"] += 1
            text = "## Score\n8/10" if "reviewer panel" in system else "CONTENT"
            on_text(text)
            return text, 50, 50

        monkeypatch.setattr(provider_adapters, "stream_stage", fake)
        run_id = _seed_run({})
        runner = rr.RealAgentRunner(ConnectionManager())
        asyncio.run(runner._run(run_id))
        with SessionLocal() as db:
            run = db.get(Run, run_id)
            assert run.status == "completed"
            assert run.analysis_json["orchestration"] == "pipeline"
            assert orchestrator_called["n"] == 0


def test_advisor_polish_is_reviewed_again_before_completion(monkeypatch):
    """The final findings must describe the post-advisor delivery candidate."""
    with TestClient(app):
        review_inputs = []

        async def fake(*, system, user, on_text=lambda _s: None, **kwargs):
            if "Experiment Planner" in system:
                text = "PLAN"
            elif "Paper Assembler" in system:
                text = "# ORIGINAL PAPER"
            elif "Editor agent" in system:
                text = "# ADVISOR POLISHED PAPER"
            elif "adversarial reviewer" in system:
                review_inputs.append(user)
                marker = "POLISHED" if "ADVISOR POLISHED" in user else "ORIGINAL"
                text = f"{marker} REVIEW\n\n## Score\n9/10\n## Required Changes\nNone."
            elif "Citation Verifier" in system:
                text = "## Verdict\nGrounded."
            elif "Board Advisor" in system:
                text = (
                    "## Verdict\nREVISE\n## Critical Risks\nNone\n## Required Changes\nPolish delivery\n## Taste Pass\nTighten"
                    if "final delivery commitment" in user
                    else "## Verdict\nAPPROVE\n## Critical Risks\nNone\n## Required Changes\nNone\n## Taste Pass\nGood"
                )
            else:
                raise AssertionError(system[:100])
            on_text(text)
            return text, 50, 50

        monkeypatch.setattr(provider_adapters, "stream_stage", fake)
        run_id = _seed_run({"advisor": True, "revise_iterations": 1, "revise_target": 8.0})
        asyncio.run(rr.RealAgentRunner(ConnectionManager())._run(run_id))

        with SessionLocal() as db:
            run = db.get(Run, run_id)
            findings = db.query(ReviewFinding).filter(ReviewFinding.run_id == run_id).all()
            assert run.status == "completed"
            assert run.draft_markdown == "# ADVISOR POLISHED PAPER"
            assert len(review_inputs) == 8  # four before polish, four after
            assert findings and all("POLISHED REVIEW" in row.finding for row in findings)
            assert run.analysis_json["reviewed_paper_checksum"]
