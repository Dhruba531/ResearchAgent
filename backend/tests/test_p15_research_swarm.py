"""Orchestrator-worker research swarm: delegation, parallelism, and governance.

The swarm is the one stage whose cost scales with a model-chosen number, so the
tests below care less about prose quality than about the things that keep it
governable: fan-out is capped, the budget priced at gate 2 covers the fan-out,
malformed delegation degrades instead of failing, and workers genuinely run
concurrently rather than in a loop.
"""

import asyncio
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
from fastapi.testclient import TestClient  # noqa: E402

import agents  # noqa: E402
import app as app_module  # noqa: E402
import cost  # noqa: E402
import real_runner  # noqa: E402
from database import init_db  # noqa: E402

init_db()

MODEL = "claude-opus-4-8"


# ---------------------------------------------------------------------------
# Delegation contract
# ---------------------------------------------------------------------------
def test_parse_subtasks_reads_a_well_formed_plan():
    plan = """Here is the plan:
    ```json
    {"complexity": "comparison", "subtasks": [
      {"objective": "Survey method A", "output_format": "bullets",
       "tool_guidance": "prefer papers", "boundaries": "not method B"},
      {"objective": "Survey method B", "output_format": "bullets",
       "tool_guidance": "prefer papers", "boundaries": "not method A"}
    ]}
    ```"""
    tasks = real_runner.parse_subtasks(plan, max_subtasks=5)
    assert len(tasks) == 2
    assert tasks[0]["objective"] == "Survey method A"
    # All four delegation fields survive — an under-specified worker is exactly
    # how parallel agents end up duplicating each other.
    assert set(tasks[0]) == {"objective", "output_format", "tool_guidance", "boundaries"}


def test_parse_subtasks_enforces_the_fanout_cap():
    """The lead does not get to widen its own fan-out past what was priced."""
    many = {"subtasks": [{"objective": f"task {i}"} for i in range(50)]}
    import json as _json
    tasks = real_runner.parse_subtasks(_json.dumps(many), max_subtasks=3)
    assert len(tasks) == 3


def test_parse_subtasks_drops_unscoped_workers():
    plan = '{"subtasks": [{"objective": "real work"}, {"output_format": "bullets"}, {}]}'
    tasks = real_runner.parse_subtasks(plan, max_subtasks=5)
    # A worker with no objective would re-research the whole brief.
    assert [t["objective"] for t in tasks] == ["real work"]


@pytest.mark.parametrize("junk", ["", "no json here", "{broken", '{"subtasks": "not a list"}', "{}"])
def test_parse_subtasks_degrades_instead_of_raising(junk):
    """Unusable delegation must skip the swarm, never fail an approved run."""
    assert real_runner.parse_subtasks(junk, max_subtasks=5) == []


def test_delegation_prompt_carries_the_allocation_rules():
    system, user, max_tokens, tools = agents.build_prompt(
        "delegate", {"brief": "study X", "max_subtasks": 4}
    )
    # Effort has to scale with the question or a one-fact lookup spawns a swarm.
    assert "1 subtask" in system
    assert "2-4 subtasks" in system
    for field in ("objective", "output_format", "tool_guidance", "boundaries"):
        assert field in system
    assert "at most 4 subtasks" in user
    # Planning stage: no search budget — the workers do the gathering.
    assert tools is None
    assert max_tokens == agents.MAX_TOKENS["delegate"]


def test_worker_prompt_scopes_and_bounds_the_search():
    system, user, _, tools = agents.build_prompt("investigate", {
        "brief": "study X", "objective": "find A", "output_format": "bullets",
        "tool_guidance": "papers", "boundaries": "not B",
    })
    assert "Start wide" in system and "narrow" in system
    assert "primary sources" in system
    assert "not B" in user            # boundaries reach the worker
    assert "orientation only" in user  # brief must not widen the objective
    # Workers are the evidence gatherers, so they are the stage that searches.
    assert tools and tools[0]["max_uses"] == agents.SEARCH_BUDGET["investigate"]


def test_synthesis_prompt_preserves_disagreement():
    system, _, _, tools = agents.build_prompt(
        "synthesize", {"brief": "b", "worker_reports": "r"}
    )
    # Averaging away contradictions would launder disagreement into confidence.
    assert "contradictions" in system.lower()
    assert "Never invent" in system
    assert tools is None  # reasoning over text the swarm already gathered


# ---------------------------------------------------------------------------
# Cost governance — the fan-out must be priced before the human approves
# ---------------------------------------------------------------------------
def test_swarm_is_priced_into_the_gate_two_estimate():
    plain, _, _ = cost.estimate_real_run(MODEL)
    swarm, _, assumptions = cost.estimate_real_run(MODEL, research_swarm=True, swarm_subagents=3)
    bigger, _, _ = cost.estimate_real_run(MODEL, research_swarm=True, swarm_subagents=8)

    assert swarm > plain, "an unpriced swarm would blow past the approved ceiling"
    assert bigger > swarm, "more workers must cost more"
    assert any("research swarm" in a for a in assumptions)


def test_estimate_matches_the_runner_fanout_clamp():
    """What the human approves must equal what the runner is allowed to spend."""
    over_cap = {"research_swarm": True, "swarm_subagents": 999}
    priced = max(1, min(
        app_module.SWARM_SUBAGENTS_HARD_CAP,
        int(over_cap.get("swarm_subagents", app_module.SWARM_SUBAGENTS_DEFAULT)),
    ))
    executed = max(1, min(
        real_runner.SWARM_SUBAGENTS_HARD_CAP,
        int(over_cap.get("swarm_subagents", real_runner.SWARM_SUBAGENTS_DEFAULT)),
    ))
    assert priced == executed == real_runner.SWARM_SUBAGENTS_HARD_CAP


def test_swarm_config_is_validated_and_bounded():
    assert app_module.validated_run_config({"research_swarm": True, "swarm_subagents": 4})["swarm_subagents"] == 4
    for bad in ({"swarm_subagents": 0}, {"swarm_subagents": 99},
                {"swarm_subagents": "three"}, {"swarm_subagents": True},
                {"research_swarm": "yes"}):
        with pytest.raises(Exception) as exc:
            app_module.validated_run_config(dict(bad))
        assert getattr(exc.value, "status_code", None) == 422, bad


def test_swarm_is_off_by_default():
    """A paid fan-out must never be something a run opts into accidentally."""
    config = app_module.validated_run_config({})
    assert not config.get("research_swarm")
    plain, _, _ = cost.estimate_real_run(MODEL)
    explicit_off, _, _ = cost.estimate_real_run(MODEL, research_swarm=False, swarm_subagents=5)
    assert plain == explicit_off


# ---------------------------------------------------------------------------
# Parallelism — the reason the pattern is worth its cost
# ---------------------------------------------------------------------------
def test_workers_run_concurrently_not_sequentially():
    """Workers must overlap; a sequential loop would forfeit the speedup."""
    in_flight = {"now": 0, "peak": 0}

    async def slow_stage(*_args, **kwargs):
        in_flight["now"] += 1
        in_flight["peak"] = max(in_flight["peak"], in_flight["now"])
        await asyncio.sleep(0.02)
        in_flight["now"] -= 1
        usage = kwargs.get("usage")
        if usage is not None:
            usage["input"] += 10
            usage["output"] += 5
        return "## Findings\nsomething\n\n## Evidence\n- claim — src — https://example.test"

    runner = real_runner.RealAgentRunner.__new__(real_runner.RealAgentRunner)
    plan = ('{"subtasks": [{"objective": "a"}, {"objective": "b"}, {"objective": "c"}]}')

    calls = {"n": 0}

    async def staged(*args, **kwargs):
        calls["n"] += 1
        stage = args[4] if len(args) > 4 else kwargs.get("stage")
        if stage == "delegate":
            return plan
        if stage == "synthesize":
            return "## Evidence Base\nmerged"
        return await slow_stage(*args, **kwargs)

    runner._run_stage = staged
    runner._enforce_stage_budget = lambda *a, **k: _false()
    runner._maybe_cancel = lambda *a, **k: _false()
    runner._log = _noop_log

    ctx, usage = {"brief": "b"}, {"input": 0, "output": 0}
    ok = asyncio.run(runner._run_research_swarm(
        1, "anthropic", "key", MODEL, ctx, usage, {"swarm_subagents": 3},
    ))

    assert ok is True
    assert in_flight["peak"] == 3, f"workers did not overlap (peak={in_flight['peak']})"
    assert ctx["evidence"] == "## Evidence Base\nmerged"
    assert ctx["swarm"]["workers_reported"] == 3
    # Every worker's tokens are merged into the run's meter, not lost.
    assert usage["input"] == 30 and usage["output"] == 15


def test_a_failing_worker_does_not_lose_the_cohort():
    """One worker erroring must not discard the findings of the others."""
    async def staged(*args, **kwargs):
        stage = args[4] if len(args) > 4 else kwargs.get("stage")
        if stage == "delegate":
            return '{"subtasks": [{"objective": "a"}, {"objective": "b"}]}'
        if stage == "synthesize":
            return "## Evidence Base\nmerged from survivors"
        if kwargs.get("label_suffix") == "w1":
            raise RuntimeError("provider blew up")
        return "## Findings\nsurvivor"

    runner = real_runner.RealAgentRunner.__new__(real_runner.RealAgentRunner)
    runner._run_stage = staged
    runner._enforce_stage_budget = lambda *a, **k: _false()
    runner._maybe_cancel = lambda *a, **k: _false()
    runner._log = _noop_log

    ctx = {"brief": "b"}
    ok = asyncio.run(runner._run_research_swarm(
        1, "anthropic", "key", MODEL, ctx, {"input": 0, "output": 0}, {"swarm_subagents": 2},
    ))
    assert ok is True
    assert ctx["swarm"]["workers_dispatched"] == 2
    assert ctx["swarm"]["workers_reported"] == 1  # the survivor still counts
    assert "merged from survivors" in ctx["evidence"]


def test_unparseable_delegation_skips_the_swarm_without_failing_the_run():
    async def staged(*args, **kwargs):
        stage = args[4] if len(args) > 4 else kwargs.get("stage")
        if stage == "delegate":
            return "I'm afraid I can't do that."
        raise AssertionError("no worker should run without a plan")

    runner = real_runner.RealAgentRunner.__new__(real_runner.RealAgentRunner)
    runner._run_stage = staged
    runner._enforce_stage_budget = lambda *a, **k: _false()
    runner._maybe_cancel = lambda *a, **k: _false()
    runner._log = _noop_log

    ctx = {"brief": "b"}
    result = asyncio.run(runner._run_research_swarm(
        1, "anthropic", "key", MODEL, ctx, {"input": 0, "output": 0}, {},
    ))
    # False (not None) = "carry on without me", so the paper still gets written.
    assert result is False
    assert "evidence" not in ctx


def test_evidence_base_reaches_the_drafting_agent():
    """Gathering evidence is pointless if the writer never sees it."""
    grounding = real_runner.RealAgentRunner._grounding(
        "", {"evidence": "## Evidence Base\nX is established"}
    )
    assert "X is established" in grounding
    assert "research swarm" in grounding
    # The stated gaps must travel with it, or the draft will overclaim.
    assert "gaps" in grounding.lower()


async def _false(*_args, **_kwargs):
    return False


async def _noop_log(*_args, **_kwargs):
    return None
