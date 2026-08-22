from __future__ import annotations

"""Cost metering + per-user budget caps.

Real LLM spend is real money, so runs are priced from **actual token usage**
(captured from the provider's response) via a list-price table, and each user is
held to a monthly spend cap (``AGENTLAB_USER_MONTHLY_CAP_USD``, default $50)
enforced at run-creation time. Prices are approximate list prices; override the
cap per deployment via the env var.
"""

import os
from functools import lru_cache
from datetime import datetime
from typing import Dict, List, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

import agents
from models import AgentSession, Project, Run

# USD per 1M tokens as (model-substring, input_price, output_price). First match wins,
# so list more specific keys before broader ones.
_PRICES: List[Tuple[str, float, float]] = [
    ("claude-fable-5", 10.0, 50.0),
    ("claude-opus-4-8", 5.0, 25.0),
    ("claude-opus-4-7", 5.0, 25.0),
    ("claude-opus-4-6", 5.0, 25.0),
    ("claude-opus", 5.0, 25.0),
    ("claude-sonnet", 3.0, 15.0),
    ("claude-haiku", 1.0, 5.0),
    ("text-embedding-3-small", 0.02, 0.0),
    ("text-embedding-3-large", 0.13, 0.0),
    ("gpt-4.1-mini", 0.40, 1.60),
    ("gpt-4.1-nano", 0.10, 0.40),
    ("gpt-4o-mini", 0.15, 0.60),
    ("gpt-4o", 2.50, 10.0),
    ("gpt-4.1", 2.0, 8.0),
]
_DEFAULT = (5.0, 25.0)  # conservative Opus-tier fallback for unknown models

USER_MONTHLY_CAP_USD = float(os.environ.get("AGENTLAB_USER_MONTHLY_CAP_USD", "50"))

# --- RunPod Serverless Flex list prices, converted from USD/sec to USD/hour --
# The adapter uses Serverless jobs, so pod/community-cloud hourly prices would
# materially understate cost. First substring match wins. Override the default
# per deployment if the endpoint has a negotiated or Active-worker rate.
_GPU_PRICES_PER_HR: List[Tuple[str, float]] = [
    ("a4000", 0.576),
    ("a5000", 0.684),
    ("rtx 4090", 1.116),
    ("4090", 1.116),
    ("a6000", 1.224),
    ("l40s", 1.908),
    ("a100", 2.736),
    ("h100", 4.176),
]
_DEFAULT_GPU_PRICE_PER_HR = float(os.environ.get("AGENTLAB_DEFAULT_GPU_PRICE_PER_HR", "1.116"))

# --- Text-to-image list prices, USD per image ------------------------------
_IMAGE_PRICES: dict = {
    "gemini": 0.039,   # Gemini 2.5 Flash Image ("Nano Banana"), ~$0.039/image
    "openai": 0.04,    # gpt-image-1, medium quality tier (approx)
}
_DEFAULT_IMAGE_PRICE = 0.04


def gpu_price_per_hr(gpu_type: str) -> float:
    g = (gpu_type or "").lower()
    for key, price in _GPU_PRICES_PER_HR:
        if key in g:
            return price
    return _DEFAULT_GPU_PRICE_PER_HR


def runpod_cost_usd(gpu_type: str, seconds: float) -> float:
    """Dollar cost of holding a GPU pod for ``seconds`` at its hourly rate."""
    return round(gpu_price_per_hr(gpu_type) * max(0.0, seconds) / 3600.0, 4)


def max_runtime_seconds(budget_usd: float, gpu_type: str) -> int:
    """Largest pod runtime (whole seconds) affordable within ``budget_usd``.

    This is the hard wall-clock cap handed to the executor so a run can never
    outspend its approved budget on GPU time. Zero/negative budget => 0 (no run).
    """
    price = gpu_price_per_hr(gpu_type)
    if budget_usd <= 0 or price <= 0:
        return 0
    return int(max(0.0, budget_usd) / price * 3600.0)


def image_cost_usd(provider: str, n: int = 1) -> float:
    """Dollar cost of generating ``n`` images with a text-to-image provider."""
    price = _IMAGE_PRICES.get((provider or "").lower(), _DEFAULT_IMAGE_PRICE)
    return round(price * max(0, n), 4)


def price_per_million(model: str) -> Tuple[float, float]:
    m = (model or "").lower()
    for key, p_in, p_out in _PRICES:
        if key in m:
            return p_in, p_out
    return _DEFAULT


def cost_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    """Dollar cost of a call given its real token usage."""
    p_in, p_out = price_per_million(model)
    return round((max(0, input_tokens) * p_in + max(0, output_tokens) * p_out) / 1_000_000, 6)


@lru_cache(maxsize=8)
def _agentic_call_ceiling(reviewers: int) -> int:
    """The most model calls _run_agentic can legally make.

    Counting the action caps is not enough. The completeness backstop that runs
    after the loop fills any REQUIRED output that is missing, and it deliberately
    does not consult ACTION_CAPS — real_runner says so directly: "the completeness
    backstop supplies them if an action cap was reached". A late draft or revise
    invalidates the citation audit and the reviews, so a run that already spent
    both its verify and review caps can still owe a verify plus a whole reviewer
    panel afterwards. Pricing the caps alone understated that by four calls.

    So walk the orchestrator's own state machine instead of approximating it:
    enumerate every legal action sequence using the real ``allowed_actions``, add
    the backstop each one would trigger, and take the worst. Cheap enough to do
    once per reviewer count and cached, and it cannot drift from the runner
    because it calls the runner's own decision function.
    """
    from real_runner import ACTION_CAPS, MAX_AGENTIC_STEPS, _OUTPUT_KEY, allowed_actions

    def backstop(ctx, reviews) -> int:
        extra, ctx, reviews = 0, dict(ctx), dict(reviews)
        for action in ("plan", "draft", "verify", "review"):
            if action == "review":
                if reviews:
                    continue
                extra += reviewers
                reviews = {"filled": "x"}
            else:
                if ctx.get(_OUTPUT_KEY[action]):
                    continue
                extra += 1
                ctx[_OUTPUT_KEY[action]] = "x"
        return extra

    best = 0

    def walk(step, counts, ctx, reviews, verify_forced, review_forced, calls) -> None:
        nonlocal best

        def finish_here(total: int) -> None:
            nonlocal best
            best = max(best, total + backstop(ctx, reviews))

        if step > MAX_AGENTIC_STEPS:
            return finish_here(calls)
        allowed = allowed_actions(counts, ctx, reviews)
        # The loop does not let the orchestrator roam freely: a changed paper
        # forces re-verification, and a fresh citation audit forces a new panel.
        # Ignoring that explores sequences the runner cannot take and overprices
        # the gate.
        if verify_forced:
            if counts.get("verify", 0) >= ACTION_CAPS["verify"]:
                return finish_here(calls)
            allowed = ["verify"]
        elif review_forced:
            if counts.get("review", 0) >= ACTION_CAPS["review"]:
                return finish_here(calls)
            allowed = ["review"]
        if not allowed:
            return finish_here(calls)
        if allowed == ["finish"]:
            return finish_here(calls)  # taken without an orchestrator call

        for action in allowed:
            spent = calls + 1  # the orchestrator's decide call for this step
            if action == "finish":
                finish_here(spent)
                continue
            ncounts, nctx, nreviews = dict(counts), dict(ctx), dict(reviews)
            nverify, nreview = verify_forced, review_forced
            if action == "review":
                spent += reviewers
                nreviews, nreview = {"filled": "x"}, False
            else:
                spent += 1
                nctx[_OUTPUT_KEY[action]] = "x"
                if action in {"draft", "revise"}:
                    nctx.pop("citations", None)
                    nreviews, nverify, nreview = {}, True, False
                elif action == "verify":
                    nverify, nreview = False, True
            ncounts[action] = ncounts.get(action, 0) + 1
            walk(step + 1, ncounts, nctx, nreviews, nverify, nreview, spent)

    walk(1, {}, {}, {}, False, False, 0)
    return best


def estimate_real_run(
    model: str,
    *,
    complexity: float = 1.0,
    orchestration: str = "pipeline",
    advisor: bool = False,
    execute: bool = False,
    figures: bool = False,
    gpu_type: str = "rtx 4090",
    revise_iterations: int = 1,
    research_swarm: bool = False,
    swarm_subagents: int = 0,
) -> Tuple[float, Dict[str, float], List[str]]:
    """Conservative pre-flight estimate for a paid run.

    The estimate mirrors the actual pipeline shape. Token volumes remain assumptions (providers meter only
    after a call), so they are operator-tunable and deliberately conservative.
    Add-on estimates are included only when the run explicitly opts into them.

    ``revise_iterations`` must match the value the runner will use. The refinement
    loop re-runs the whole reviewer panel and an editor revision on every round
    after the first, so omitting it understates the budget the human approves at
    gate 2 — and a run that breaches its own approved ceiling mid-loop is failed
    without persisting the paper it already paid for.
    """
    complexity = max(0.1, min(float(complexity), 10.0))
    reviewers = len(agents.REVIEWERS)
    # Defaults keep the assumptions block below valid in both branches. Agentic
    # mode leaves rounds at 1 because it genuinely has no refinement-round knob.
    rounds = 1
    per_extra_round = reviewers + 1
    orchestration_note = ""

    if orchestration == "pipeline":
        calls = 10
        # The base figure already covers one review+revise round; each additional
        # refinement round costs a full panel plus one editor pass. Reviewer count is
        # read from the panel definition so the two cannot drift apart.
        rounds = max(1, int(revise_iterations))
        per_extra_round = reviewers + 1
        calls += (rounds - 1) * per_extra_round
    else:
        # Agentic mode never reads revise_iterations — its cadence is fixed by the
        # orchestrator loop's own caps — so pricing it off that knob describes a run
        # that cannot happen, and understated the real ceiling by roughly 1.8x.
        #
        # Derive it from the caps the loop actually enforces: one orchestrator
        # decision per step, plus the action each step performs. A "review" action
        # is a full reviewer panel, not one call, which is where most of the
        # missing cost was. Imported lazily because real_runner imports this module.
        calls = _agentic_call_ceiling(reviewers)
        orchestration_note = (
            f"Agentic mode is priced at its own worst case ({calls} model calls), "
            f"derived from the orchestrator's action limits plus the completeness "
            f"backstop that reruns verification and the {reviewers}-reviewer panel "
            f"when a late revision invalidates them. It has no refinement-round "
            f"setting, so that field does not change this estimate."
        )

    if advisor:
        calls += 3  # plan critique, delivery critique, possible final polish
    # The research swarm is one lead delegation call, one call per worker, and
    # one lead synthesis call. Fan-out is the whole point of a multi-agent
    # design and also the whole cost of it — an unpriced swarm would let a run
    # multiply its token spend well past the ceiling the human approved.
    swarm_calls = 0
    if research_swarm:
        workers = max(1, int(swarm_subagents))
        swarm_calls = 1 + workers + 1
        calls += swarm_calls
    input_per_call = int(os.environ.get("AGENTLAB_EST_INPUT_TOKENS_PER_CALL", "4500"))
    output_per_call = int(os.environ.get("AGENTLAB_EST_OUTPUT_TOKENS_PER_CALL", "1800"))
    input_tokens = int(calls * input_per_call * complexity)
    output_tokens = int(calls * output_per_call * complexity)
    llm = cost_usd(model, input_tokens, output_tokens)

    # RAG indexing/retrieval uses OpenAI embeddings when enabled. Include the
    # allowance even when the generation provider is Anthropic so the budget
    # gate remains safe when an OpenAI embedding key is also configured.
    embedding_tokens = int(int(os.environ.get("AGENTLAB_EST_EMBEDDING_TOKENS", "30000")) * complexity)
    embeddings = cost_usd("text-embedding-3-small", embedding_tokens, 0)

    gpu = 0.0
    if execute:
        seconds = max(1, int(os.environ.get("AGENTLAB_EST_EXEC_SECONDS", "300")))
        gpu = runpod_cost_usd(gpu_type, seconds)

    image = 0.0
    if figures:
        image = image_cost_usd("openai", max(0, int(os.environ.get("AGENTLAB_MAX_FIGURES", "3"))))

    breakdown = {
        "llm": round(llm, 4),
        "embeddings": round(embeddings, 4),
        "gpu": round(gpu, 4),
        "images": round(image, 4),
    }
    # A 20% uncertainty reserve limits one-stage budget overshoot when prompts
    # or model output run longer than estimated.
    subtotal = sum(breakdown.values())
    reserve = round(subtotal * 0.20, 4)
    breakdown["uncertainty_reserve"] = reserve
    total = round(subtotal + reserve, 4)
    assumptions = [
        f"{calls} model calls; ~{input_tokens:,} input and {output_tokens:,} output tokens.",
        f"Model pricing resolved for {model}; unknown models use the conservative fallback tier.",
        "Includes a 20% uncertainty reserve; actual provider and add-on usage is metered after every stage.",
    ]
    if rounds > 1:
        assumptions.append(
            f"Covers up to {rounds} refinement rounds "
            f"({per_extra_round} extra calls each: {len(agents.REVIEWERS)}-reviewer panel + editor revision)."
        )
    if orchestration_note:
        assumptions.append(orchestration_note)
    if research_swarm:
        assumptions.append(
            f"Includes a {max(1, int(swarm_subagents))}-worker research swarm "
            f"({swarm_calls} calls: lead delegation + parallel workers + lead synthesis). "
            "Parallel workers also each carry their own web-search budget."
        )
    if execute:
        assumptions.append(f"Includes {seconds}s of estimated {gpu_type} execution.")
    if figures:
        assumptions.append(f"Includes up to {int(os.environ.get('AGENTLAB_MAX_FIGURES', '3'))} generated figures.")
    return total, breakdown, assumptions


def _month_start() -> datetime:
    # Naive UTC to match SQLAlchemy's naive datetime storage on SQLite/Postgres here.
    n = datetime.utcnow()
    return datetime(n.year, n.month, 1)


def monthly_spend(db: Session, user_id: int) -> float:
    """Sum of actual_cost across a user's runs in the current calendar month."""
    total = (
        db.query(func.coalesce(func.sum(Run.actual_cost), 0.0))
        .join(Project, Run.project_id == Project.id)
        .filter(Project.owner_id == user_id, Run.created_at >= _month_start())
        .scalar()
    )
    return float(total or 0.0)


def remaining_budget(db: Session, user_id: int) -> float:
    return max(0.0, USER_MONTHLY_CAP_USD - monthly_spend(db, user_id))


def over_budget(db: Session, user_id: int) -> bool:
    return monthly_spend(db, user_id) >= USER_MONTHLY_CAP_USD


def monthly_commitment(db: Session, user_id: int) -> float:
    """Actual spend plus unspent estimates for active real runs this month."""
    spent = monthly_spend(db, user_id)
    active = (
        db.query(Run)
        .join(Project, Run.project_id == Project.id)
        .join(AgentSession, Run.session_id == AgentSession.id)
        .filter(
            Project.owner_id == user_id,
            Run.created_at >= _month_start(),
            Run.status.in_(["queued", "running"]),
        )
        .all()
    )
    reserved = sum(max(0.0, float(run.cost_estimate or 0) - float(run.actual_cost or 0)) for run in active)
    return spent + reserved
