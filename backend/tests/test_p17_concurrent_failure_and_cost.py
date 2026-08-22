"""Two bugs that cost real money, and the regressions that keep them fixed.

Both were invisible to the existing suite for the same reason: the tests that
covered these code paths stubbed out ``_run_stage`` wholesale, so the side effect
that caused the damage — a run-wide status transition fired from inside a
concurrent fan-out — never executed. The tests here deliberately run the REAL
``_run_stage`` and ``_transition`` against a real database row, stubbing only the
provider call itself.

1. A single reviewer's transient provider error used to transition the WHOLE run
   to "failed" while its three siblings kept working and spending. Beyond the
   wrong status, that freed the run's budget reservation: monthly_commitment only
   counts runs in "queued"/"running", so a run mislabelled "failed" mid-flight
   stopped counting against the monthly cap while still spending toward its own
   ceiling — letting a second run be approved against a cap already committed.

2. Agentic mode was priced at a flat 14 calls while its own caps permit 25,
   understating the gate-2 ceiling by ~1.8x. It also scaled with
   ``revise_iterations``, a knob the agentic loop never reads.
"""

import asyncio
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("AGENTLAB_DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("AGENTLAB_DATA_DIR", "/tmp/agentlab-test-data")
os.environ.setdefault("AGENTLAB_ARTIFACT_ROOT", "/tmp/agentlab-test-data/artifacts")
os.environ["AGENTLAB_VERIFY_URLS"] = "0"

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

import pytest  # noqa: E402

import agents  # noqa: E402
import cost  # noqa: E402
import provider_adapters  # noqa: E402
import real_runner  # noqa: E402
from database import SessionLocal, init_db  # noqa: E402
from models import AgentSession, Brief, Project, Run, User  # noqa: E402
from runner_common import ConnectionManager  # noqa: E402

init_db()

MODEL = "claude-opus-4-8"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _make_run(db) -> int:
    user = User(name="P17", email=f"p17-{id(db)}-{os.urandom(4).hex()}@example.test", password_hash="")
    db.add(user); db.commit()
    project = Project(owner_id=user.id, title="P17 Project")
    db.add(project); db.commit()
    brief = Brief(project_id=project.id, version=1, content_json={"title": "T"})
    db.add(brief); db.commit()
    session = AgentSession(project_id=project.id, brief_id=brief.id, provider="anthropic")
    db.add(session); db.commit()
    run = Run(session_id=session.id, project_id=project.id, brief_id=brief.id,
              cost_estimate=5.0, status="running")
    db.add(run); db.commit()
    return run.id


def _runner():
    """A real runner with only the fan-out's collaborators stubbed. _run_stage and
    _transition are the code under test and stay real."""
    r = real_runner.RealAgentRunner.__new__(real_runner.RealAgentRunner)
    r._cancelled = set()
    r.manager = ConnectionManager()

    async def _no_budget_stop(*_a, **_k):
        return False

    r._enforce_stage_budget = _no_budget_stop
    r._maybe_cancel = _no_budget_stop
    return r


def _status(run_id: int) -> str:
    with SessionLocal() as db:
        return db.get(Run, run_id).status


def _stream(fail_first: int = 0, fail_all: bool = False):
    """Stub provider call. Fails the first ``fail_first`` invocations — which under
    asyncio.gather deterministically means that many panel members fail, whichever
    reviewer happens to be scheduled first."""
    seen = {"n": 0}

    async def stream_stage(**kwargs):
        n = seen["n"]
        seen["n"] += 1
        if fail_all or n < fail_first:
            raise RuntimeError("provider 529 overloaded")
        return ("Critique of the draft. Score: 7.0/10", 10, 5)

    return stream_stage


# ---------------------------------------------------------------------------
# 1. Concurrent stage failure must stay contained
# ---------------------------------------------------------------------------
def test_one_failing_reviewer_does_not_fail_the_whole_run(monkeypatch):
    monkeypatch.setattr(provider_adapters, "stream_stage", _stream(fail_first=1))
    with SessionLocal() as db:
        run_id = _make_run(db)

    runner = _runner()
    reviews = asyncio.run(runner._run_review_panel(
        run_id, "anthropic", "key", MODEL,
        {"draft": "d", "citations": "c"}, {"input": 0, "output": 0}, {},
    ))

    assert reviews is not None, "the surviving reviewers' work must not be discarded"
    assert len(reviews) == len(agents.REVIEWERS) - 1
    # The heart of it: the run is still alive. Marking it "failed" here would also
    # release its budget reservation while it carries on spending.
    assert _status(run_id) == "running"


def test_a_run_marked_failed_would_release_its_budget_reservation():
    """Why the status matters, not just that it looks wrong: cost accounting
    reserves only active runs, so a false "failed" un-reserves live spending."""
    src = Path(BACKEND_DIR / "cost.py").read_text()
    assert 'Run.status.in_(["queued", "running"])' in src, (
        "monthly_commitment's active-status filter changed; re-check whether a "
        "mid-run status flip still frees the reservation"
    )


def test_every_reviewer_failing_does_fail_the_run(monkeypatch):
    """Containment is not permission to continue unreviewed. If the panel produced
    nothing, the paper was never reviewed and the run must stop."""
    monkeypatch.setattr(provider_adapters, "stream_stage", _stream(fail_all=True))
    with SessionLocal() as db:
        run_id = _make_run(db)

    runner = _runner()
    reviews = asyncio.run(runner._run_review_panel(
        run_id, "anthropic", "key", MODEL,
        {"draft": "d", "citations": "c"}, {"input": 0, "output": 0}, {},
    ))

    assert reviews is None
    assert _status(run_id) == "failed"


def test_a_sequential_stage_failure_still_fails_the_run(monkeypatch):
    """The non-fatal path is opt-in. An ordinary single-call stage failing is still
    a run-ending event, and must not have been weakened by the fix."""
    monkeypatch.setattr(provider_adapters, "stream_stage", _stream(fail_all=True))
    with SessionLocal() as db:
        run_id = _make_run(db)

    runner = _runner()
    out = asyncio.run(runner._run_stage(
        run_id, "anthropic", "key", MODEL, "draft", "Author", {"brief": "b"},
    ))

    assert out is None
    assert _status(run_id) == "failed"


def test_a_failing_swarm_worker_does_not_fail_the_run(monkeypatch):
    """The swarm is explicitly degradable — a worker dropping out must not end a
    run that already passed its human gates."""
    monkeypatch.setattr(provider_adapters, "stream_stage", _stream(fail_first=1))
    with SessionLocal() as db:
        run_id = _make_run(db)

    runner = _runner()
    asyncio.run(runner._run_stage(
        run_id, "anthropic", "key", MODEL, "investigate", "Worker 1",
        {"objective": "o"}, label_suffix="w1", fatal=False,
    ))
    assert _status(run_id) == "running"


# ---------------------------------------------------------------------------
# 2. Agentic mode must be priced from the limits it enforces
# ---------------------------------------------------------------------------
def test_agentic_estimate_covers_a_real_worst_case_run(monkeypatch):
    """Drive the REAL orchestrator loop down its most expensive legal path and
    count the provider calls it actually makes.

    Deriving the expected number from cost.py's own formula would only prove the
    formula equals itself. This scripts the orchestrator through a sequence that
    is legal at every step, then compares the gate-2 price against what the runner
    really did — including the completeness backstop, which reruns verification
    and the whole reviewer panel after a late revision and does NOT consult
    ACTION_CAPS. That backstop is what made an earlier cap-only estimate
    understate this path.
    """
    # Legal at every step; the final revise invalidates citations and reviews, so
    # the backstop must rerun verify + the full panel after the loop ends.
    # After a draft or revise the loop FORCES verification, and a fresh citation
    # audit forces a new panel, so the costliest reachable path is not simply the
    # most expensive actions — it is this one. The closing revise invalidates both
    # gates with the verify cap already spent, which is what hands the backstop a
    # verify plus a full panel to rerun.
    worst_path = ["plan", "draft", "verify", "review", "draft", "verify", "review", "revise"]
    script = iter(worst_path)
    calls = {"n": 0}

    async def stream(**kwargs):
        calls["n"] += 1
        # _decide is the only caller that omits on_text — that is how we tell an
        # orchestrator decision apart from a stage doing work.
        if "on_text" not in kwargs:
            return (json.dumps({"action": next(script, "finish"), "reason": "worst case"}), 10, 5)
        return ("Stage output. Score: 7.0/10", 10, 5)

    monkeypatch.setattr(provider_adapters, "stream_stage", stream)
    with SessionLocal() as db:
        run_id = _make_run(db)

    runner = _runner()

    async def _skip_completion(*_a, **_k):
        return None

    runner._complete_run = _skip_completion
    asyncio.run(runner._run_agentic(
        run_id, "anthropic", "key", MODEL,
        {"brief": "b"}, {"input": 0, "output": 0}, {}, False,
    ))

    per_call = cost.estimate_real_run(MODEL, orchestration="pipeline", revise_iterations=1)[0] / 10.0
    priced = round(cost.estimate_real_run(MODEL, orchestration="agentic")[0] / per_call)

    assert calls["n"] > 25, (
        f"this path only made {calls['n']} calls; it must exceed the old cap-only "
        "ceiling of 25 or it is not exercising the backstop overrun"
    )
    assert calls["n"] == 27, f"expected the known worst case of 27 calls, got {calls['n']}"
    assert priced >= calls["n"], (
        f"gate-2 prices {priced} calls but the runner actually made {calls['n']} — "
        "the human would approve a ceiling the run breaches"
    )


def test_agentic_estimate_ignores_the_knob_agentic_mode_ignores():
    """_run_agentic never reads revise_iterations, so charging for it described a
    run that cannot happen."""
    base = cost.estimate_real_run(MODEL, orchestration="agentic", revise_iterations=1)[0]
    for iters in (2, 3, 5):
        assert cost.estimate_real_run(MODEL, orchestration="agentic", revise_iterations=iters)[0] == base


def test_pipeline_still_scales_with_refinement_rounds():
    """The pipeline DOES honour the knob; the fix must not have flattened it."""
    one = cost.estimate_real_run(MODEL, orchestration="pipeline", revise_iterations=1)[0]
    three = cost.estimate_real_run(MODEL, orchestration="pipeline", revise_iterations=3)[0]
    per_extra = len(agents.REVIEWERS) + 1
    assert round(three / (one / 10.0)) == 10 + 2 * per_extra


def test_the_agentic_estimate_explains_itself_at_the_gate():
    """The human approving the ceiling should be told why the refinement setting
    had no effect, rather than silently seeing it ignored."""
    notes = cost.estimate_real_run(MODEL, orchestration="agentic", revise_iterations=4)[2]
    joined = " ".join(notes)
    assert "refinement-round" in joined
    # The note must quote the ceiling actually charged, so the approver can see
    # what they are paying for rather than a number pulled from elsewhere.
    assert str(cost._agentic_call_ceiling(len(agents.REVIEWERS))) in joined
