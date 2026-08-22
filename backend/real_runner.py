from __future__ import annotations

"""Real (LLM-backed) agent runner for AgentLab.

Exposes a ``start``/``cancel`` lifecycle and executes the research
pipeline against a real provider using the user's enabled API key:

    approved brief ─▶ plan ─▶ draft ─▶ citation verify ─▶ reviewer panel ─▶ editor revise ─▶ outputs

Two orchestration modes (run config_json ``{"orchestration": ...}``):
  * ``pipeline`` (default) — the fixed order above.
  * ``agentic`` — an Orchestrator agent chooses each next action from a bounded,
    precondition-checked action space (``allowed_actions``), capped per action
    and in total (``MAX_AGENTIC_STEPS``), with the same budget stops. Malformed
    decisions fall back deterministically, and a completeness backstop
    guarantees every finished run has plan/draft/citations/reviews.

Each stage's prompt comes from ``agents.build_prompt`` (provider-agnostic) and is
streamed through ``provider_adapters.stream_stage``. Output tokens are persisted
as live ``RunLog`` lines; the final paper, citation audit, and reviewer findings
are stored on the run through the shared artifact contract, so the rest of the product
(artifacts, draft view, reviewer panel, export gate) works unchanged.

This runner is only selected when a user has saved AND enabled a provider key
(see ``app.create_run``). It never executes user-generated code.
"""

import asyncio
import base64
import binascii
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

import agents
import cost
import crypto
import groundedness
import images
import provider_adapters
import runpod_adapter
import vector_store
from database import SessionLocal
from runner_common import ConnectionManager, checksum, safe_artifact_filename, safe_artifact_path, write_artifact
from models import (
    Artifact,
    Brief,
    Project,
    ProviderKey,
    ReviewFinding,
    Run,
    RunLog,
    StatusHistory,
    now,
)

# How many characters of streamed output to buffer before flushing a progress
# log line (keeps the live feel without writing a DB row per token).
_LOG_FLUSH_CHARS = 700

# ---------------------------------------------------------------------------
# Agentic orchestration (opt-in via run config_json {"orchestration": "agentic"}).
# The model chooses the next action; THESE invariants stay code-enforced:
#   * bounded action space (the five stages + finish — nothing else),
#   * preconditions (can't draft without a plan, can't finish unreviewed, …),
#   * per-action caps and a total step cap (no infinite loops),
#   * the existing per-stage budget stops and human gates.
# ---------------------------------------------------------------------------
MAX_AGENTIC_STEPS = 10
ACTION_CAPS: Dict[str, int] = {"plan": 1, "draft": 2, "verify": 2, "review": 2, "revise": 2}
_CANONICAL_ORDER = ["plan", "draft", "verify", "review", "revise", "finish"]

# ---------------------------------------------------------------------------
# Iterative refinement loop (pipeline mode). After the first draft the paper
# enters a review -> revise loop: the panel scores the working paper each
# round, the Editor revises while the aggregate score is below target, and the
# best-scoring version is exported (a revision that regresses never ships).
# Bounded by an iteration cap AND the same per-stage budget stops, so it can
# never loop indefinitely. Both knobs are overridable per run (config_json)
# within the hard cap below.
# ---------------------------------------------------------------------------
MAX_REVISE_ITERS = int(os.environ.get("AGENTLAB_MAX_REVISE_ITERS", "3"))
REVISE_SCORE_TARGET = float(os.environ.get("AGENTLAB_REVISE_TARGET", "8.0"))
REVISE_ITERS_HARD_CAP = 5

# ---------------------------------------------------------------------------
# Orchestrator-worker research swarm (opt-in).
#
# A lead agent splits the approved brief into disjoint subtasks, workers
# investigate them in parallel, and the lead consolidates the reports into one
# evidence base for the drafting agent.
#
# Fan-out is capped hard. Parallelism is what makes the swarm worth having, but
# it also removes the per-call budget checkpoint the sequential pipeline relies
# on: workers are already in flight when the cohort's spend lands, so the run
# can overshoot by up to one cohort. The cap bounds that worst case, and the
# estimate at gate 2 prices the full fan-out so the ceiling the human approves
# already accounts for it.
# ---------------------------------------------------------------------------
SWARM_SUBAGENTS_DEFAULT = int(os.environ.get("AGENTLAB_SWARM_SUBAGENTS", "3"))
SWARM_SUBAGENTS_HARD_CAP = 8


def advisor_requests_revision(text: str) -> bool:
    """Read the advisor's explicit verdict without treating body prose as control."""
    match = re.search(r"^##\s+Verdict[^\n]*\n\s*(APPROVE|REVISE)\b", text or "", re.I | re.M)
    return bool(match and match.group(1).upper() == "REVISE")


def allowed_actions(counts: Dict[str, int], ctx: Dict, reviews: Dict) -> List[str]:
    """The legal next actions given what the run has produced so far.

    Encodes the governance preconditions: a draft needs a plan, verification
    needs a draft, the panel needs a verified draft, revision needs reviews,
    and a run may only finish once draft + citation audit + reviews all exist.
    """
    out: List[str] = []
    if counts.get("plan", 0) < ACTION_CAPS["plan"]:
        out.append("plan")
    if ctx.get("plan") and counts.get("draft", 0) < ACTION_CAPS["draft"]:
        out.append("draft")
    if ctx.get("draft") and counts.get("verify", 0) < ACTION_CAPS["verify"]:
        out.append("verify")
    if ctx.get("draft") and ctx.get("citations") and counts.get("review", 0) < ACTION_CAPS["review"]:
        out.append("review")
    if ctx.get("draft") and reviews and counts.get("revise", 0) < ACTION_CAPS["revise"]:
        out.append("revise")
    if ctx.get("draft") and ctx.get("citations") and reviews:
        out.append("finish")
    return out


def fallback_action(allowed: List[str], counts: Optional[Dict[str, int]] = None) -> str:
    """Deterministic choice when the orchestrator's output is unusable.

    Prefers forward progress: the first canonical action not yet executed. If
    every stage has run at least once, finish. A persistently-broken
    orchestrator therefore degrades to exactly the fixed pipeline — never to
    cap-burning re-runs.
    """
    counts = counts or {}
    for action in _CANONICAL_ORDER:
        if action in allowed and counts.get(action, 0) == 0:
            return action
    if "finish" in allowed:
        return "finish"
    return allowed[0] if allowed else "finish"


def parse_action(text: str) -> Optional[Dict[str, str]]:
    """Extract {"action", "reason"} from orchestrator output; None if unusable.

    Tolerates code fences and surrounding prose — anything with one JSON object
    containing an "action" string parses; everything else falls back.
    """
    if not text:
        return None
    match = re.search(r"\{.*?\}", text, re.S)
    if not match:
        return None
    try:
        obj = json.loads(match.group(0))
    except Exception:
        return None
    action = str(obj.get("action") or "").strip().lower()
    if not action:
        return None
    return {"action": action, "reason": str(obj.get("reason") or "").strip()[:300]}


def parse_subtasks(text: str, max_subtasks: int) -> List[Dict[str, str]]:
    """Extract the lead agent's delegation plan; [] when unusable.

    Returns at most ``max_subtasks`` fully-specified subtasks. A subtask with no
    objective is dropped rather than sent to a worker: an unscoped worker
    re-researches the whole brief, which is exactly the duplicated effort the
    delegation stage exists to prevent. Callers treat ``[]`` as "skip the swarm"
    and fall through to the normal pipeline, so malformed output degrades to the
    single-agent path instead of failing the run.
    """
    if not text:
        return []
    # Objects nest (subtasks inside the envelope), so a non-greedy {.*?} would
    # stop at the first inner brace; take the outermost span instead.
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return []
    try:
        obj = json.loads(match.group(0))
    except Exception:
        return []
    raw = obj.get("subtasks")
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        objective = str(item.get("objective") or "").strip()
        if not objective:
            continue
        out.append({
            "objective": objective[:2000],
            "output_format": str(item.get("output_format") or "").strip()[:1000],
            "tool_guidance": str(item.get("tool_guidance") or "").strip()[:1000],
            "boundaries": str(item.get("boundaries") or "").strip()[:1000],
        })
        if len(out) >= max_subtasks:
            break
    return out


def _join_reviews(reviews: Dict[str, str]) -> str:
    """Join the panel's critiques into one Editor-ready markdown block."""
    return "\n\n---\n\n".join(
        f"## {agents.REVIEWERS.get(key, {}).get('name', key)}\n\n{text}" for key, text in reviews.items()
    )


_SCORE_SLASH_RE = re.compile(r"\b(10|[0-9](?:\.\d)?)\s*/\s*10\b")
_SCORE_LABEL_RE = re.compile(r"score\s*[:*]*\s*(10|[0-9](?:\.\d)?)\b(?!\s*[-–)])", re.I)


def review_score(text: str) -> Optional[float]:
    """Best-effort numeric score (0-10) from a reviewer's markdown critique.

    Prefers the unambiguous "N/10" form; falls back to "Score: N" while
    ignoring the rubric text "(1-10)" via the trailing-dash guard.
    """
    for pattern in (_SCORE_SLASH_RE, _SCORE_LABEL_RE):
        m = pattern.search(text or "")
        if m:
            value = float(m.group(1))
            if 0 <= value <= 10:
                return value
    return None


def _aggregate_score(reviews: Dict[str, str]) -> Optional[float]:
    """Mean of the panel's parseable numeric scores (0-10), or None if none.

    ``None`` means no reviewer gave a parseable score this round; the refinement
    loop treats that as "not proven good enough" and keeps refining until the
    iteration cap, rather than exporting an unscored paper as if it had passed.
    """
    scores = [s for s in (review_score(v) for v in reviews.values()) if s is not None]
    return round(sum(scores) / len(scores), 2) if scores else None


def enabled_provider_key(db: Session, user_id: int) -> Optional[ProviderKey]:
    """Return the user's enabled provider key (Anthropic preferred), or None."""
    rows = (
        db.query(ProviderKey)
        .filter(
            ProviderKey.user_id == user_id,
            ProviderKey.provider.in_(("anthropic", "openai")),
            ProviderKey.is_enabled.is_(True),
        )
        .all()
    )
    if not rows:
        return None
    rows.sort(key=lambda r: 0 if r.provider == "anthropic" else 1)
    return rows[0]


def render_brief(content_json) -> str:
    """Render a stored brief (structured JSON or string) into prompt-ready text."""
    if isinstance(content_json, str):
        return content_json.strip()
    if isinstance(content_json, dict):
        parts: List[str] = []
        for key, value in content_json.items():
            heading = str(key).replace("_", " ").title()
            if isinstance(value, (list, tuple)):
                body = "\n".join(f"- {item}" for item in value)
            elif isinstance(value, dict):
                body = json.dumps(value, indent=2)
            else:
                body = str(value)
            parts.append(f"## {heading}\n{body}")
        return "\n\n".join(parts).strip()
    return json.dumps(content_json, indent=2)


def _sha256_text(text: str) -> str:
    """Hash the exact code that ran, for the execution audit trail."""
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def _write_bytes_artifact(run_id: int, filename: str, data: bytes) -> Path:
    """Write a binary artifact (figures, execution outputs) under the run's dir."""
    path = safe_artifact_path(run_id, filename)
    path.write_bytes(data)
    return path


def enabled_key_for(db: Session, user_id: int, provider: str) -> Optional[ProviderKey]:
    """Return the user's enabled key for a specific provider (runpod/gemini/…), or None."""
    return (
        db.query(ProviderKey)
        .filter(ProviderKey.user_id == user_id, ProviderKey.provider == provider, ProviderKey.is_enabled.is_(True))
        .first()
    )


def budget_breach(
    model: str,
    usage: Dict,
    budget_threshold: float,
    monthly_remaining: float,
    *,
    prior_cost_usd: float = 0.0,
    addon_cost_usd: float = 0.0,
) -> Optional[str]:
    """Return a human-readable reason if metered spend crossed a limit, else None.

    Checked between pipeline stages so a run stops as soon as its real token
    spend reaches the human-approved run budget (gate 2) or the user's remaining
    monthly cap — instead of only pricing the damage after the last stage.
    A ``budget_threshold`` of 0 means "no per-run threshold" (matches create_run).
    """
    attempt_spend = cost.cost_usd(model, usage.get("input", 0), usage.get("output", 0)) + addon_cost_usd
    total_run_spend = prior_cost_usd + attempt_spend
    if budget_threshold and total_run_spend >= budget_threshold:
        return f"metered spend ${total_run_spend:.4f} reached the approved run budget ${budget_threshold:.2f}"
    # monthly_remaining was calculated after the persisted cost from an earlier
    # interrupted attempt, so compare only spend incurred by this retry.
    if attempt_spend >= monthly_remaining:
        return f"metered spend ${attempt_spend:.4f} reached the remaining monthly cap ${monthly_remaining:.2f}"
    return None


def _severity_from_review(text: str) -> str:
    """Best-effort map a reviewer's recommendation to a severity bucket."""
    low = text.lower()
    if "reject" in low or "major revision" in low:
        return "high"
    if "minor revision" in low:
        return "medium"
    if "accept" in low:
        return "low"
    return "info"


def _section(text: str, heading: str) -> str:
    """Extract a markdown section body by heading (e.g. 'Required Changes')."""
    marker = heading.lower()
    lines = text.splitlines()
    out: List[str] = []
    capturing = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("#") and marker in stripped.lower():
            capturing = True
            continue
        if capturing and stripped.startswith("#"):
            break
        if capturing:
            out.append(line)
    return "\n".join(out).strip()


class RealAgentRunner:
    """Background runner that drives the pipeline against a real LLM provider."""

    def __init__(self, manager: ConnectionManager) -> None:
        self.manager = manager
        self._tasks: Dict[int, asyncio.Task] = {}
        self._cancelled: set[int] = set()
        self._shutting_down: set[int] = set()

    # ---- lifecycle ---------------------------------------------------------
    def start(self, run_id: int) -> None:
        if run_id in self._tasks and not self._tasks[run_id].done():
            return
        self._cancelled.discard(run_id)
        self._tasks[run_id] = asyncio.create_task(self._run(run_id))

    def cancel(self, run_id: int) -> None:
        self._cancelled.add(run_id)
        task = self._tasks.get(run_id)
        if task and not task.done():
            task.cancel()

    async def shutdown(self, timeout: float = 20.0) -> None:
        """Stop local tasks while leaving durable runs reclaimable on restart.

        A deployment shutdown is not a user cancellation: run rows remain
        queued/running so the next process reclaims them, and remote RunPod work
        is still cancelled by its adapter's task-cancellation cleanup.
        """
        active = {run_id: task for run_id, task in self._tasks.items() if not task.done()}
        if not active:
            return
        self._shutting_down.update(active)
        for task in active.values():
            task.cancel()
        try:
            await asyncio.wait_for(
                asyncio.gather(*active.values(), return_exceptions=True),
                timeout=max(1.0, timeout),
            )
        except asyncio.TimeoutError:
            # Tasks are already cancelled. Process termination is the final
            # boundary; their durable rows remain eligible for startup recovery.
            pass

    # ---- main pipeline ----------------------------------------------------
    async def _run(self, run_id: int) -> None:
        try:
            ctx, key, meta = self._load_context(run_id)
            if key is None:
                with SessionLocal() as db:
                    await self._transition(db, run_id, "failed", "No enabled provider key.")
                    await self._log(db, run_id, "error", "No enabled provider key — cannot run in real mode.")
                return

            provider = key.provider
            api_key = crypto.decrypt(key.api_key)  # decrypted only in-memory for the call
            model = provider_adapters.resolve_model(provider, key.model_name)
            user_id = meta.get("user_id")
            project_id = meta.get("project_id")
            openai_key = meta.get("openai_key") or ""
            await self._cancel_orphaned_execution(run_id, meta)
            # RAG is active only when a vector DB is configured AND an OpenAI key
            # (for embeddings) is on file. Otherwise the run proceeds ungrounded.
            rag_on = bool(openai_key) and await asyncio.to_thread(vector_store.ready)
            with SessionLocal() as db:
                await self._transition(db, run_id, "running", f"Real agent session started ({provider}/{model}).")
                await self._log(db, run_id, "info", f"Live run via {provider} · model={model}. Web search enabled where the agent needs sources.")
                if rag_on:
                    await self._log(db, run_id, "info", "Vector store (pgvector) connected — draft & verify will be grounded with retrieved context.")

            usage = {"input": 0, "output": 0}  # metered token totals across all stages
            # A recovered attempt may already have exhausted its approved run
            # budget before the process died. Stop before issuing another paid
            # provider call in that case.
            if await self._enforce_stage_budget(run_id, model, usage, meta):
                return

            # Agentic mode: the Orchestrator chooses each next action within
            # code-enforced invariants. Handles its own completion/transitions.
            if meta.get("orchestration") == "agentic":
                await self._run_agentic(
                    run_id, provider, api_key, model, ctx, usage, meta, rag_on,
                )
                return

            # Optional orchestrator-worker swarm, before anything is planned or
            # written, so the plan and the draft are both grounded in evidence
            # the workers actually found rather than in the model's priors.
            if meta.get("research_swarm"):
                swarmed = await self._run_research_swarm(
                    run_id, provider, api_key, model, ctx, usage, meta,
                )
                if swarmed is None:  # cancelled or out of budget
                    return

            # Default: the fixed governed pipeline.
            stages: List[Tuple[str, str]] = [
                ("plan", "Experiment Planner"),
                ("draft", "Paper Assembler"),
                ("verify", "Citation Verifier"),
            ]
            retrieved: Optional[str] = None
            for stage, label in stages:
                if await self._maybe_cancel(run_id):
                    return
                extra = ""
                if stage == "plan" and ctx.get("evidence"):
                    # The planner does not use the RAG path, so hand it the
                    # evidence base directly.
                    extra = self._grounding("", ctx)
                if stage in ("draft", "verify"):
                    if retrieved is None:  # retrieve once (brief+plan are ready by the draft stage)
                        retrieved = await self._retrieve(run_id, openai_key, user_id, ctx) if rag_on else ""
                    extra = self._grounding(retrieved, ctx)
                text = await self._run_stage(
                    run_id, provider, api_key, model, stage, label, ctx, extra_context=extra, usage=usage,
                )
                if text is None:  # cancelled or failed inside the stage
                    return
                ctx[_OUTPUT_KEY[stage]] = text
                if await self._enforce_stage_budget(run_id, model, usage, meta):
                    return
                if stage == "plan" and meta.get("advisor"):
                    advice = await self._consult_advisor(
                        run_id, provider, api_key, model, "plan", ctx, usage,
                    )
                    if advice is None:
                        return
                    ctx["advisor_plan"] = advice
                    if await self._enforce_stage_budget(run_id, model, usage, meta):
                        return
                # Anti-hallucination: run the experiment right after the plan, so
                # the draft reports REAL measured results instead of inventing
                # numbers. (Figures still run at the end — they need the captions.)
                if stage == "plan" and meta.get("execute"):
                    try:
                        await self._run_execution(run_id, model, ctx, usage, meta)
                    except Exception as exc:
                        with SessionLocal() as db:
                            await self._log(db, run_id, "warn", f"Experiment execution skipped: {exc}")
                    else:
                        if await self._enforce_stage_budget(run_id, model, usage, meta):
                            return

            # Iterative refinement — the reviewer panel scores the paper and the
            # Editor revises, round after round, until the score clears the
            # target or the iteration/budget caps stop us:
            #   draft -> [ reviewer panel -> Editor revise ]* -> best version.
            # The best-scoring version becomes the run's primary paper; the
            # original draft is kept as its own artifact for the audit trail. A
            # draft that already clears the bar is not revised at all.
            loop = await self._refine_loop(run_id, provider, api_key, model, ctx, usage, meta)
            if loop is None:
                return  # cancelled / failed / budget stop — already transitioned
            reviews, revised = loop
            if revised is not None:
                ctx["revised"] = revised

            if meta.get("advisor"):
                advice = await self._consult_advisor(
                    run_id, provider, api_key, model, "delivery", ctx, usage, reviews,
                )
                if advice is None:
                    return
                ctx["advisor_delivery"] = advice
                if await self._enforce_stage_budget(run_id, model, usage, meta):
                    return
                if advisor_requests_revision(advice):
                    base_paper = ctx.get("revised") or ctx.get("draft", "")
                    final_ctx = dict(ctx, draft=base_paper)
                    final_ctx["reviews"] = _join_reviews(reviews) + "\n\n## Board Advisor\n\n" + advice
                    polished = await self._run_stage(
                        run_id, provider, api_key, model, "revise", "Editor (advisor polish)",
                        final_ctx, extra_context=(ctx.get("execution_block") or ""), usage=usage,
                    )
                    if polished is None:
                        return
                    ctx["revised"] = polished
                    if await self._enforce_stage_budget(run_id, model, usage, meta):
                        return
                    # The advisor changed the delivery candidate after the prior
                    # panel. Re-review that exact text so export findings never
                    # describe an obsolete paper version.
                    refreshed = await self._run_review_panel(
                        run_id, provider, api_key, model, dict(ctx, draft=polished), usage, meta,
                    )
                    if refreshed is None:
                        return
                    reviews = refreshed

            await self._complete_run(run_id, provider, model, ctx, reviews, usage, meta, rag_on)
        except asyncio.CancelledError:
            if run_id in self._shutting_down:
                with SessionLocal() as db:
                    await self._log(
                        db,
                        run_id,
                        "warn",
                        "Service shutdown interrupted this attempt; durable recovery will resume it on restart.",
                    )
            else:
                with SessionLocal() as db:
                    await self._transition(db, run_id, "cancelled", "Run cancelled by user.")
                    await self._log(db, run_id, "warn", "Cancellation received. Real runner stopped.")
        except Exception as exc:  # surface provider/auth/rate-limit errors as a failed run
            with SessionLocal() as db:
                await self._transition(db, run_id, "failed", f"Run failed: {exc}")
                await self._log(db, run_id, "error", f"Run failed: {exc}")
        finally:
            self._tasks.pop(run_id, None)
            self._cancelled.discard(run_id)
            self._shutting_down.discard(run_id)

    # ---- iterative refinement loop (pipeline mode) --------------------------
    async def _refine_loop(
        self, run_id: int, provider: str, api_key: str, model: str,
        ctx: Dict, usage: Dict, meta: Dict,
    ) -> Optional[Tuple[Optional[Dict[str, str]], Optional[str]]]:
        """Review -> revise until the paper is good enough or the caps stop us.

        Each round the reviewer panel scores the *current* working paper; while
        the aggregate score is below the target the Editor revises it and the
        loop re-reviews the result. Stops at the target, the per-run iteration
        cap, a budget breach, or cancellation. The highest-scoring version seen
        is returned, so a revision that regresses quality never ships.

        Returns ``None`` when the run was already transitioned (cancel / fail /
        budget) and the caller should bail; otherwise ``(reviews, revised)``
        where ``reviews`` is the panel for the exported version and ``revised``
        is ``None`` if the original draft already cleared the bar (downstream
        then keeps the original draft as the paper).
        """
        target = float(meta.get("revise_target", REVISE_SCORE_TARGET))
        max_iters = int(meta.get("revise_iterations", MAX_REVISE_ITERS))
        original = ctx.get("draft", "")
        working = original
        best_paper, best_reviews, best_score = original, None, None
        reviews: Optional[Dict[str, str]] = None

        for iteration in range(1, max_iters + 1):
            if await self._maybe_cancel(run_id):
                return None
            reviews = await self._run_review_panel(
                run_id, provider, api_key, model, dict(ctx, draft=working), usage, meta,
            )
            if reviews is None:
                return None
            score = _aggregate_score(reviews)
            score_txt = f"{score:.1f}" if score is not None else "n/a"
            with SessionLocal() as db:
                await self._log(
                    db, run_id, "info",
                    f"[loop] Refinement round {iteration}/{max_iters}: panel score "
                    f"{score_txt}/10 (target ≥ {target:.1f}).",
                )
            # Keep the best version seen (a later revision can regress).
            #
            # An unscored round must never displace a *scored* one. If the panel
            # output could not be parsed we have no evidence this version is
            # better, so letting it overwrite a measured best would break the
            # guarantee that a regression never ships.
            #
            # While nothing has scored at all there is no measured best to
            # protect, so keep tracking the newest version — it is the one that
            # incorporated the most reviewer feedback, and shipping the original
            # instead would discard the entire refinement loop.
            if score is not None:
                if best_score is None or score > best_score:
                    best_score, best_paper, best_reviews = score, working, reviews
            elif best_score is None:
                best_paper, best_reviews = working, reviews

            if score is not None and score >= target:
                with SessionLocal() as db:
                    await self._log(db, run_id, "info", f"[loop] Quality target met — accepting round {iteration}.")
                break
            if await self._enforce_stage_budget(run_id, model, usage, meta):
                return None
            if iteration == max_iters:
                best_txt = f"{best_score:.1f}" if best_score is not None else "n/a"
                with SessionLocal() as db:
                    await self._log(
                        db, run_id, "info",
                        f"[loop] Reached {max_iters}-round cap — exporting best version (score {best_txt}/10).",
                    )
                break

            # Below target and rounds remain: revise the working paper.
            rctx = dict(ctx, draft=working)
            rctx["reviews"] = _join_reviews(reviews)
            revised = await self._run_stage(
                run_id, provider, api_key, model, "revise", f"Editor · revision {iteration}",
                rctx, extra_context=(ctx.get("execution_block") or ""), usage=usage,
            )
            if revised is None:
                return None
            working = revised
            if await self._enforce_stage_budget(run_id, model, usage, meta):
                return None

        reviews = best_reviews if best_reviews is not None else reviews
        revised_out = best_paper if best_paper != original else None
        if revised_out is None and working != original:
            # The original scored best, so the revisions are correctly not
            # shipped — but they were paid for, and silently dropping them
            # leaves no evidence that the loop tried and rejected them. Archive
            # the last rejected revision so the audit trail explains the spend.
            try:
                path = write_artifact(run_id, "rejected-revision.md", working)
                with SessionLocal() as db:
                    db.add(Artifact(
                        run_id=run_id, type="rejected_revision", name="rejected-revision.md",
                        path=str(path), checksum=checksum(path),
                        metadata_json={
                            "reason": "Original draft outscored every revision; exported unchanged.",
                            "best_score": best_score,
                            "rounds_run": iteration,
                        },
                    ))
                    db.commit()
                    await self._log(
                        db, run_id, "info",
                        "[loop] Original draft scored best — archived the rejected revision for the audit trail.",
                    )
            except Exception as exc:  # never fail a good run over bookkeeping
                with SessionLocal() as db:
                    await self._log(db, run_id, "warn", f"Could not archive rejected revision: {exc}")
        return reviews, revised_out

    # ---- agentic orchestration loop ----------------------------------------
    async def _run_agentic(
        self, run_id: int, provider: str, api_key: str, model: str,
        ctx: Dict, usage: Dict, meta: Dict, rag_on: bool,
    ) -> None:
        """Model-chosen action loop with code-enforced invariants.

        Each iteration: compute the legal actions (preconditions + caps), ask
        the Orchestrator to pick one, execute it, then apply the same budget/
        cancel checks as the pipeline. Malformed orchestrator output falls back
        to the canonical order, so the loop always terminates with a complete,
        exportable run — or a properly failed one.
        """
        counts: Dict[str, int] = {a: 0 for a in ACTION_CAPS}
        reviews: Dict[str, str] = {}
        action_log: List[Dict[str, str]] = []
        retrieved: Optional[str] = None
        advisor_plan_done = False
        advisor_delivery_done = False
        verification_required = False
        review_required = False
        with SessionLocal() as db:
            await self._log(db, run_id, "info", f"[orchestrator] Agentic mode on — model-chosen actions, max {MAX_AGENTIC_STEPS} steps.")

        for step in range(1, MAX_AGENTIC_STEPS + 1):
            if await self._maybe_cancel(run_id):
                return
            allowed = allowed_actions(counts, ctx, reviews)
            if verification_required:
                if counts.get("verify", 0) >= ACTION_CAPS["verify"]:
                    break
                allowed = ["verify"]
            elif review_required:
                if counts.get("review", 0) >= ACTION_CAPS["review"]:
                    break
                allowed = ["review"]
            if not allowed:  # nothing legal remains (all caps hit before finish unlocked)
                break
            if allowed == ["finish"]:
                action, reason = "finish", "only legal action remaining"
            else:
                decision = await self._decide(run_id, provider, api_key, model, ctx, usage, counts, reviews, allowed, step)
                if decision and decision["action"] in allowed:
                    action, reason = decision["action"], decision["reason"] or "no reason given"
                else:
                    action = fallback_action(allowed, counts)
                    reason = "fallback — orchestrator output invalid or action not allowed"
            if action == "finish" and meta.get("advisor") and not advisor_delivery_done:
                advice = await self._consult_advisor(
                    run_id, provider, api_key, model, "delivery", ctx, usage, reviews,
                )
                if advice is None:
                    return
                ctx["advisor_delivery"] = advice
                advisor_delivery_done = True
                if await self._enforce_stage_budget(run_id, model, usage, meta):
                    return
                if advisor_requests_revision(advice) and counts.get("revise", 0) < ACTION_CAPS["revise"]:
                    action = "revise"
                    reason = "board advisor requested changes before delivery"
            action_log.append({"step": str(step), "action": action, "reason": reason})
            with SessionLocal() as db:
                await self._log(db, run_id, "info", f"[orchestrator] step {step}: {action} — {reason}")
            if action == "finish":
                break

            # Execute the chosen stage. Later stages always operate on the
            # current best draft (the latest revision when one exists).
            current_draft = ctx.get("revised") or ctx.get("draft", "")
            if action == "review":
                stage_ctx = dict(ctx, draft=current_draft)
                result = await self._run_review_panel(run_id, provider, api_key, model, stage_ctx, usage, meta)
                if result is None:
                    return
                reviews = result  # fresh critique of the current draft replaces the old panel
                review_required = False
            else:
                extra = ""
                if action in ("draft", "verify") and rag_on:
                    if retrieved is None:
                        retrieved = await self._retrieve(run_id, meta.get("openai_key", ""), meta.get("user_id"), ctx)
                    extra = retrieved or ""
                stage_ctx = dict(ctx, draft=current_draft)
                if action == "revise":
                    stage_ctx["reviews"] = _join_reviews(reviews)
                label = {"plan": "Experiment Planner", "draft": "Paper Assembler", "verify": "Citation Verifier", "revise": "Editor"}[action]
                text = await self._run_stage(
                    run_id, provider, api_key, model, action, label, stage_ctx, extra_context=extra, usage=usage,
                )
                if text is None:
                    return
                ctx[_OUTPUT_KEY[action]] = text
                if action in {"draft", "revise"}:
                    # A changed paper invalidates both verification and review.
                    # Force those gates again before finish; the completeness
                    # backstop supplies them if an action cap was reached.
                    ctx.pop("citations", None)
                    reviews = {}
                    verification_required = True
                    review_required = False
                elif action == "verify":
                    verification_required = False
                    review_required = True
            counts[action] += 1
            if await self._enforce_stage_budget(run_id, model, usage, meta):
                return
            if action == "plan" and meta.get("advisor") and not advisor_plan_done:
                advice = await self._consult_advisor(
                    run_id, provider, api_key, model, "plan", ctx, usage,
                )
                if advice is None:
                    return
                ctx["advisor_plan"] = advice
                advisor_plan_done = True
                if await self._enforce_stage_budget(run_id, model, usage, meta):
                    return

        # Completeness backstop: whatever the orchestrator did, an exportable
        # run needs plan -> draft -> citations -> reviews. Fill only what is
        # missing, in canonical order, still budget-checked.
        for action in ("plan", "draft", "verify", "review"):
            missing = (
                (action == "review" and not reviews)
                or (action != "review" and not ctx.get(_OUTPUT_KEY[action]))
            )
            if not missing:
                continue
            if await self._maybe_cancel(run_id):
                return
            action_log.append({"step": "backstop", "action": action, "reason": "required output missing at loop end"})
            with SessionLocal() as db:
                await self._log(db, run_id, "info", f"[orchestrator] backstop: running {action} (required output missing)")
            # Verification and review must judge the paper that will actually be
            # exported. After a revise, that is ctx["revised"] — ctx["draft"] is
            # the superseded original, and auditing it would attach a citation
            # audit and reviewer panel describing a different document to the
            # shipped paper.
            backstop_ctx = dict(ctx, draft=(ctx.get("revised") or ctx.get("draft", "")))
            if action == "review":
                result = await self._run_review_panel(run_id, provider, api_key, model, backstop_ctx, usage, meta)
                if result is None:
                    return
                reviews = result
            else:
                label = {"plan": "Experiment Planner", "draft": "Paper Assembler", "verify": "Citation Verifier"}[action]
                text = await self._run_stage(run_id, provider, api_key, model, action, label, backstop_ctx, usage=usage)
                if text is None:
                    return
                ctx[_OUTPUT_KEY[action]] = text
            if await self._enforce_stage_budget(run_id, model, usage, meta):
                return

        await self._complete_run(
            run_id, provider, model, ctx, reviews, usage, meta, rag_on,
            orchestration="agentic", action_log=action_log,
        )

    async def _decide(
        self, run_id: int, provider: str, api_key: str, model: str,
        ctx: Dict, usage: Dict, counts: Dict, reviews: Dict, allowed: List[str], step: int,
    ) -> Optional[Dict[str, str]]:
        """One Orchestrator call: state in, {"action","reason"} out (None = fallback).

        Metered into the same usage/budget totals as every other stage; any
        error degrades to the deterministic fallback instead of failing the run.
        """
        spent = cost.cost_usd(model, usage.get("input", 0), usage.get("output", 0))
        scores = {k: review_score(v) for k, v in reviews.items()}
        score_line = (
            ", ".join(f"{k}: {v:g}/10" for k, v in scores.items() if v is not None) or "not yet reviewed"
        )
        state_lines = [
            f"- plan: {'done (' + str(len(ctx.get('plan', ''))) + ' chars)' if ctx.get('plan') else 'missing'}",
            f"- draft: {'done (' + str(len(ctx.get('draft', ''))) + ' chars)' if ctx.get('draft') else 'missing'}",
            f"- citation audit: {'done — excerpt: ' + ' '.join(ctx.get('citations', '').split())[:220] if ctx.get('citations') else 'missing'}",
            f"- reviewer scores: {score_line}",
            f"- revision: {'done (' + str(len(ctx.get('revised', ''))) + ' chars)' if ctx.get('revised') else 'not yet'}",
            f"- action counts so far: {json.dumps(counts)}",
            f"- spend so far: ${spent:.4f}",
            f"- steps used: {step - 1} of {MAX_AGENTIC_STEPS}",
        ]
        octx = {"state": "\n".join(state_lines), "allowed": ", ".join(allowed)}
        try:
            system, user, max_tokens, tools = agents.build_prompt("orchestrate", octx)
            text, in_tok, out_tok = await provider_adapters.stream_stage(
                provider=provider, api_key=api_key, model=model,
                system=system, user=user, max_tokens=max_tokens, tools=tools,
                should_cancel=lambda: run_id in self._cancelled,
            )
            usage["input"] += in_tok
            usage["output"] += out_tok
            return parse_action(text)
        except Exception:
            return None  # orchestrator trouble never fails the run — fall back

    async def _run_review_panel(
        self, run_id: int, provider: str, api_key: str, model: str,
        ctx: Dict, usage: Dict, meta: Dict,
    ) -> Optional[Dict[str, str]]:
        """Run the reviewer personas concurrently. None if the run was stopped.

        The reviewers are independent — each judges the same paper from its own
        angle and none reads another's output — so running them in sequence only
        added latency. They are dispatched together and their results collected
        in the panel's declared order, so logs and the exported review remain
        deterministic regardless of which reviewer finishes first.

        The tradeoff is the same one the swarm makes: the budget is charged for
        the whole panel at once instead of after each reviewer, so a run can
        overshoot by at most one panel.
        """
        if await self._maybe_cancel(run_id):
            return None

        async def _reviewer(name: str) -> Tuple[str, Optional[str], Dict[str, int]]:
            local_usage = {"input": 0, "output": 0}
            rctx = dict(ctx, reviewer=name)
            text = await self._run_stage(
                run_id, provider, api_key, model, "review",
                f"{agents.REVIEWERS[name]['name']}", rctx, label_suffix=name,
                usage=local_usage, fatal=False,
            )
            return name, text, local_usage

        names = list(agents.REVIEWERS)
        results = await asyncio.gather(*(_reviewer(n) for n in names), return_exceptions=True)

        reviews: Dict[str, str] = {}
        for result in results:
            if isinstance(result, BaseException):
                with SessionLocal() as db:
                    await self._log(db, run_id, "warn", f"[review] a reviewer failed: {result}")
                continue
            name, text, local_usage = result
            usage["input"] += local_usage["input"]
            usage["output"] += local_usage["output"]
            if text is not None:
                reviews[name] = text

        # Individual reviewers are non-fatal: one dropping out must not fail a run
        # the rest completed. But a panel that produced nothing means the paper was
        # never reviewed, so the run cannot continue as though it had been — and
        # since no member transitioned the run, this is the point that must.
        # Cancellation already transitioned to "cancelled"; do not overwrite it.
        if not reviews:
            if run_id not in self._cancelled:
                with SessionLocal() as db:
                    await self._transition(
                        db, run_id, "failed",
                        "review panel failed: no reviewer produced a review",
                    )
            return None
        if await self._enforce_stage_budget(run_id, model, usage, meta):
            return None
        return {name: reviews[name] for name in names if name in reviews}

    async def _run_research_swarm(
        self, run_id: int, provider: str, api_key: str, model: str,
        ctx: Dict, usage: Dict, meta: Dict,
    ) -> Optional[bool]:
        """Lead decomposes -> workers investigate in parallel -> lead consolidates.

        Returns True when an evidence base was produced (written to
        ``ctx["evidence"]``), False when the swarm was skipped and the caller
        should continue on the normal single-agent path, or None when the run
        was stopped (cancelled or out of budget) and the caller must bail.

        Skipping is deliberate rather than fatal: if the lead's plan cannot be
        parsed, a run that already passed its human gates should still produce a
        paper on the ordinary pipeline instead of failing outright.
        """
        max_subtasks = max(1, min(SWARM_SUBAGENTS_HARD_CAP, int(meta.get("swarm_subagents", SWARM_SUBAGENTS_DEFAULT))))

        # ---- 1. Lead agent: decompose -------------------------------------
        plan_text = await self._run_stage(
            run_id, provider, api_key, model, "delegate", "Lead Researcher · delegation",
            dict(ctx, max_subtasks=max_subtasks), usage=usage,
        )
        if plan_text is None:
            return None
        if await self._enforce_stage_budget(run_id, model, usage, meta):
            return None

        subtasks = parse_subtasks(plan_text, max_subtasks)
        if not subtasks:
            with SessionLocal() as db:
                await self._log(
                    db, run_id, "warn",
                    "[swarm] Could not read a delegation plan — continuing without the research swarm.",
                )
            return False

        with SessionLocal() as db:
            await self._log(
                db, run_id, "info",
                f"[swarm] Lead split the brief into {len(subtasks)} subtask(s); "
                f"dispatching workers in parallel.",
            )
            for i, task in enumerate(subtasks, 1):
                await self._log(db, run_id, "info", f"[swarm] worker {i}: {task['objective'][:180]}")

        # ---- 2. Workers: investigate in parallel --------------------------
        # Each worker meters into its own dict. Sharing one would interleave
        # read-modify-write on the same counters across concurrent coroutines;
        # merging afterwards keeps the totals exact and order-independent.
        async def _worker(index: int, task: Dict[str, str]) -> Tuple[int, Optional[str], Dict[str, int]]:
            local_usage = {"input": 0, "output": 0}
            wctx = dict(ctx, **task)
            text = await self._run_stage(
                run_id, provider, api_key, model, "investigate",
                f"Research Worker {index}", wctx, label_suffix=f"w{index}",
                usage=local_usage, fatal=False,
            )
            return index, text, local_usage

        results = await asyncio.gather(
            *(_worker(i, t) for i, t in enumerate(subtasks, 1)),
            return_exceptions=True,
        )

        reports: List[Tuple[int, str]] = []
        for result in results:
            if isinstance(result, BaseException):
                # One worker failing must not lose the cohort's other findings.
                with SessionLocal() as db:
                    await self._log(db, run_id, "warn", f"[swarm] a worker failed: {result}")
                continue
            index, text, local_usage = result
            usage["input"] += local_usage["input"]
            usage["output"] += local_usage["output"]
            if text:
                reports.append((index, text))

        if await self._maybe_cancel(run_id):
            return None
        # Budget is charged for the whole cohort at once — see the note on
        # SWARM_SUBAGENTS_HARD_CAP about the one-cohort overshoot this allows.
        if await self._enforce_stage_budget(run_id, model, usage, meta):
            return None
        if not reports:
            with SessionLocal() as db:
                await self._log(
                    db, run_id, "warn",
                    "[swarm] No worker produced a report — continuing without the research swarm.",
                )
            return False

        # ---- 3. Lead agent: consolidate -----------------------------------
        reports.sort(key=lambda pair: pair[0])  # deterministic order despite parallel completion
        joined = "\n\n".join(
            f"### Worker {i} — {subtasks[i - 1]['objective'][:160]}\n\n{text}" for i, text in reports
        )
        evidence = await self._run_stage(
            run_id, provider, api_key, model, "synthesize", "Lead Researcher · synthesis",
            dict(ctx, worker_reports=joined), usage=usage,
        )
        if evidence is None:
            return None
        if await self._enforce_stage_budget(run_id, model, usage, meta):
            return None

        ctx["evidence"] = evidence
        ctx["swarm"] = {
            "subtasks": subtasks,
            "workers_dispatched": len(subtasks),
            "workers_reported": len(reports),
        }
        # Register the evidence base as a real artifact so the researcher can
        # read and download what the swarm actually found, rather than only
        # seeing its influence on the finished paper.
        try:
            path = write_artifact(run_id, "evidence-base.md", evidence)
            with SessionLocal() as db:
                db.add(Artifact(
                    run_id=run_id, type="evidence_base", name="evidence-base.md",
                    path=str(path), checksum=checksum(path),
                    metadata_json={
                        "workers_dispatched": len(subtasks),
                        "workers_reported": len(reports),
                        "objectives": [t["objective"][:200] for t in subtasks],
                    },
                ))
                db.commit()
        except Exception as exc:  # never fail a good run over bookkeeping
            with SessionLocal() as db:
                await self._log(db, run_id, "warn", f"Could not archive the evidence base: {exc}")
        with SessionLocal() as db:
            await self._log(
                db, run_id, "info",
                f"[swarm] Consolidated {len(reports)} worker report(s) into an evidence base.",
            )
        return True

    async def _consult_advisor(
        self, run_id: int, provider: str, api_key: str, model: str,
        boundary: str, ctx: Dict, usage: Dict, reviews: Optional[Dict[str, str]] = None,
    ) -> Optional[str]:
        """Consult the non-executing advisor at a named commitment boundary."""
        actx = dict(ctx, boundary=boundary)
        if boundary == "delivery":
            actx["candidate"] = ctx.get("revised") or ctx.get("draft", "")
            actx["reviews"] = _join_reviews(reviews or {})
        return await self._run_stage(
            run_id, provider, api_key, model, "advise",
            f"Board Advisor ({boundary} commitment)", actx,
            label_suffix=boundary, usage=usage,
        )

    @staticmethod
    def _grounding(retrieved: str, ctx: Dict) -> str:
        """Assemble labelled grounding context: retrieved sources + real results."""
        parts: List[str] = []
        if ctx.get("evidence"):
            parts.append(
                "[Evidence base from the research swarm — prefer these sourced "
                "findings, and respect the stated gaps rather than filling them "
                "with plausible-sounding claims]\n" + ctx["evidence"]
            )
        if retrieved:
            parts.append("[Retrieved prior-run sources]\n" + retrieved)
        if ctx.get("execution_block"):
            parts.append(
                "[Measured experiment results — report THESE exact numbers; "
                "do not invent metrics]\n" + ctx["execution_block"]
            )
        return "\n\n".join(parts)

    # ---- optional add-on stages: experiment execution + figure generation ----
    def _addon_budget_left(self, model: str, usage: Dict, meta: Dict) -> float:
        """Dollars still spendable this run: the tighter of the approved run
        budget and the remaining monthly cap, minus token + add-on spend so far."""
        attempt_spend = cost.cost_usd(model, usage.get("input", 0), usage.get("output", 0)) + meta.get("addon_cost_usd", 0.0)
        total_run_spend = meta.get("prior_cost_usd", 0.0) + attempt_spend
        run_left = (meta.get("budget_threshold", 0.0) or float("inf")) - total_run_spend
        month_left = meta.get("monthly_remaining", float("inf")) - attempt_spend
        return max(0.0, min(run_left, month_left))

    async def _run_addons(self, run_id: int, model: str, ctx: Dict, usage: Dict, meta: Dict) -> bool:
        """Run the opt-in execution + figure stages. Best-effort: a failure here
        is logged and recorded but never fails the run (the paper still ships)."""
        meta.setdefault("addon_cost_usd", 0.0)
        # In the fixed pipeline, execution already ran right after the plan (to
        # ground the draft); only run it here if it hasn't (e.g. agentic mode).
        if meta.get("execute") and not ctx.get("_executed"):
            try:
                await self._run_execution(run_id, model, ctx, usage, meta)
            except Exception as exc:
                with SessionLocal() as db:
                    await self._log(db, run_id, "warn", f"Experiment execution skipped: {exc}")
            if await self._enforce_stage_budget(run_id, model, usage, meta):
                return True
        if meta.get("figures") and run_id not in self._cancelled:
            try:
                if await self._run_figures(run_id, model, ctx, usage, meta):
                    return True
            except Exception as exc:
                with SessionLocal() as db:
                    await self._log(db, run_id, "warn", f"Figure generation skipped: {exc}")
        return False

    async def _run_execution(self, run_id: int, model: str, ctx: Dict, usage: Dict, meta: Dict) -> None:
        """Execute the plan's generated code in the RunPod sandbox."""
        if run_id in self._cancelled:
            return
        code = runpod_adapter.extract_python_code(ctx.get("plan", ""), ctx.get("revised") or ctx.get("draft", ""))
        with SessionLocal() as db:
            if not code:
                await self._log(db, run_id, "info", "Execution requested but the plan has no runnable code block — skipping.")
                return
            if not (
                runpod_adapter.allow_execution()
                and meta.get("runpod_key")
                and meta.get("runpod_endpoint")
            ):
                await self._log(
                    db,
                    run_id,
                    "warn",
                    "Execution requested but RunPod is not fully configured — skipping execution.",
                )
                return
            gpu = meta.get("gpu_type", "rtx 4090")
            # Wall-clock cap from the dollars left, then clamped to an absolute max.
            abs_cap = int(os.environ.get("AGENTLAB_MAX_EXEC_SECONDS", "600"))
            budget_cap = cost.max_runtime_seconds(self._addon_budget_left(model, usage, meta), gpu)
            max_seconds = max(1, min(abs_cap, budget_cap))
            if max_seconds < 10:
                await self._log(db, run_id, "warn", "Not enough remaining budget to execute on a GPU — skipping execution.")
                return
            await self._log(db, run_id, "info", f"Executing experiment (RunPod GPU {gpu}), cap={max_seconds}s.")

        logs: List[str] = []
        def remember_job(job_id: str) -> None:
            with SessionLocal() as state_db:
                state_run = state_db.get(Run, run_id)
                if state_run:
                    analysis = dict(state_run.analysis_json or {})
                    analysis["_runtime"] = {"runpod_job_id": job_id}
                    state_run.analysis_json = analysis
                    state_db.commit()

        result = await runpod_adapter.run_experiment(
            code=code, api_key=meta.get("runpod_key", ""), endpoint_id=meta.get("runpod_endpoint", ""),
            gpu_type=gpu, max_seconds=max_seconds,
            on_log=logs.append, on_submitted=remember_job,
            should_cancel=lambda: run_id in self._cancelled,
        )
        gpu_usd = cost.runpod_cost_usd(gpu, result.get("seconds", 0.0))
        meta["addon_cost_usd"] = meta.get("addon_cost_usd", 0.0) + gpu_usd

        # Persist stdout + any returned artifacts, with full provenance.
        with SessionLocal() as db:
            run = db.get(Run, run_id)
            if run and (run.analysis_json or {}).get("_runtime"):
                analysis = dict(run.analysis_json or {})
                analysis.pop("_runtime", None)
                run.analysis_json = analysis
            code_sha = _sha256_text(code)
            log_path = write_artifact(run_id, "experiment-stdout.txt", result.get("stdout", "") + "\n\n[stderr]\n" + result.get("stderr", ""))
            prov = {"real": True, "status": result.get("status"), "exit_code": result.get("exit_code"),
                    "seconds": result.get("seconds"), "gpu_type": gpu, "cost_usd": gpu_usd, "code_sha256": code_sha}
            db.add(Artifact(run_id=run_id, type="experiment", name="experiment-stdout.txt", path=str(log_path),
                            checksum=checksum(log_path), metadata_json=prov))
            for i, art in enumerate(result.get("artifacts", [])[:10]):
                raw_name = str(art.get("name") or f"experiment-artifact-{i}")[:120]
                try:
                    name = safe_artifact_filename(raw_name)
                except ValueError:
                    name = f"experiment-artifact-{i}"
                content = art.get("text")
                if content is None and art.get("content_b64"):
                    p = None
                    try:
                        encoded = str(art["content_b64"])
                        # Bound untrusted sandbox output before decoding/writing it.
                        if len(encoded) > 8_000_000:
                            raise ValueError("sandbox artifact exceeds size limit")
                        decoded = base64.b64decode(encoded, validate=True)
                        if len(decoded) > 6_000_000:
                            raise ValueError("sandbox artifact exceeds size limit")
                        p = _write_bytes_artifact(run_id, name, decoded)
                    except (binascii.Error, OSError, ValueError):
                        p = None
                else:
                    text_content = str(content or "")
                    if len(text_content.encode("utf-8")) > 2_000_000:
                        continue
                    p = write_artifact(run_id, name, text_content)
                if p is None:
                    continue
                db.add(Artifact(run_id=run_id, type="experiment_result", name=name, path=str(p),
                                checksum=checksum(p), metadata_json={"real": True, "code_sha256": code_sha}))
            ctx["execution"] = {**prov, "stdout_excerpt": " ".join(result.get("stdout", "").split())[:600]}
            ctx["_executed"] = True  # so the end-of-run addon pass doesn't re-run it
            # Compact, model-facing block of the real output for grounding the draft.
            result_texts = "\n".join(
                f"{a.get('name')}: {a.get('text')}" for a in result.get("artifacts", []) if a.get("text")
            )
            ctx["execution_block"] = (
                f"status={result.get('status')} exit={result.get('exit_code')}\n"
                f"stdout:\n{result.get('stdout', '')[:2000]}\n"
                + (f"result files:\n{result_texts[:1500]}" if result_texts else "")
            ).strip()
            db.commit()
            await self._log(db, run_id, "info",
                            f"Experiment {result.get('status')} in {result.get('seconds')}s"
                            + (f" (GPU cost ${gpu_usd:.4f})" if gpu_usd else "") + ".")

    async def _cancel_orphaned_execution(self, run_id: int, meta: Dict) -> None:
        """Cancel a remote execution persisted by a process that restarted."""
        with SessionLocal() as db:
            run = db.get(Run, run_id)
            job_id = str(((run.analysis_json or {}).get("_runtime") or {}).get("runpod_job_id") or "") if run else ""
        if not job_id:
            return
        cancelled = await runpod_adapter.cancel_job(
            api_key=meta.get("runpod_key", ""),
            endpoint_id=meta.get("runpod_endpoint", ""),
            job_id=job_id,
        )
        with SessionLocal() as db:
            run = db.get(Run, run_id)
            if run:
                analysis = dict(run.analysis_json or {})
                analysis.pop("_runtime", None)
                run.analysis_json = analysis
                db.commit()
            await self._log(
                db,
                run_id,
                "info" if cancelled else "warn",
                f"Recovered run {'cancelled' if cancelled else 'could not cancel'} orphaned RunPod job {job_id}.",
            )

    async def _run_figures(self, run_id: int, model: str, ctx: Dict, usage: Dict, meta: Dict) -> bool:
        """Generate figures for the paper and store them as image artifacts."""
        draft = ctx.get("revised") or ctx.get("draft", "")
        prompts = images.figure_prompts_from_draft(draft, ctx.get("title", ""), limit=images.max_figures())
        if not prompts:
            return False
        if not meta.get("image_key") or not meta.get("image_provider"):
            with SessionLocal() as db:
                await self._log(db, run_id, "warn", "Figure generation requested but no image provider is configured.")
            return False
        provider = meta["image_provider"]
        made: List[Dict] = []
        with SessionLocal() as db:
            await self._log(db, run_id, "info", f"Generating {len(prompts)} figure(s) via {provider}.")
        for i, prompt in enumerate(prompts):
            if run_id in self._cancelled:
                break
            expected_cost = cost.image_cost_usd(provider)
            if self._addon_budget_left(model, usage, meta) <= expected_cost:
                with SessionLocal() as db:
                    await self._log(
                        db,
                        run_id,
                        "warn",
                        "Not enough remaining approved budget for another generated figure — stopping figures.",
                    )
                break
            res = await images.generate_figure(
                prompt=prompt,
                provider=provider,
                api_key=meta.get("image_key", ""),
                index=i,
            )
            if not res.get("ok"):
                with SessionLocal() as db:
                    await self._log(db, run_id, "warn", f"Figure {i + 1} failed: {res.get('error')}")
                continue
            img_usd = cost.image_cost_usd(res.get("provider", provider))
            meta["addon_cost_usd"] = meta.get("addon_cost_usd", 0.0) + img_usd
            name = f"figure-{i + 1}.{res.get('ext', 'png')}"
            path = _write_bytes_artifact(run_id, name, res["data"])
            with SessionLocal() as db:
                db.add(Artifact(run_id=run_id, type="figure", name=name, path=str(path), checksum=checksum(path),
                                metadata_json={"real": True, "provider": res.get("provider"), "prompt": prompt[:300], "cost_usd": img_usd}))
                db.commit()
            made.append({"name": name, "provider": res.get("provider"), "prompt": prompt[:200]})
            if await self._enforce_stage_budget(run_id, model, usage, meta):
                ctx["figures"] = made
                return True
        ctx["figures"] = made
        return False

    async def _complete_run(
        self, run_id: int, provider: str, model: str, ctx: Dict, reviews: Dict,
        usage: Dict, meta: Dict, rag_on: bool,
        orchestration: str = "pipeline", action_log: Optional[List[Dict[str, str]]] = None,
    ) -> None:
        """Shared completion tail: run add-on stages, persist outputs, index, mark completed."""
        # Add-ons run after the paper is already written and paid for. A budget
        # stop here has already transitioned the run to failed, but the draft,
        # citation audit, reviewer findings and artifacts must still be
        # persisted — discarding them would throw away completed work the user
        # was charged for, and would contradict _run_addons' own contract that
        # an add-on problem "never fails the run (the paper still ships)".
        addons_stopped = await self._run_addons(run_id, model, ctx, usage, meta)
        # Deterministic groundedness pass (URL liveness + placeholder/fabrication
        # counts) — feeds the export gate. Best-effort: never fails the run.
        try:
            ctx["groundedness"] = await groundedness.assess(
                ctx.get("revised") or ctx.get("draft", ""), ctx.get("citations", ""),
            )
            g = ctx["groundedness"]
            with SessionLocal() as db:
                await self._log(
                    db, run_id, "info",
                    f"Groundedness {g['score']:.2f} — {g['urls_dead']}/{g['urls_total']} dead URLs, "
                    f"{g['placeholders']} placeholder(s), {g['fabricated_flags']} fabrication flag(s).",
                )
        except Exception as exc:
            with SessionLocal() as db:
                await self._log(db, run_id, "warn", f"Groundedness check skipped: {exc}")
        with SessionLocal() as db:
            self._finish_outputs(
                db, run_id, provider, model, ctx, reviews, usage,
                orchestration=orchestration, action_log=action_log,
                addon_cost_usd=meta.get("addon_cost_usd", 0.0),
                prior_cost_usd=meta.get("prior_cost_usd", 0.0),
            )
        if addons_stopped:
            # The budget check already marked the run failed; keep that status
            # (the run really did breach its ceiling) but tell the user their
            # paper survived, and skip indexing an incomplete run.
            with SessionLocal() as db:
                await self._log(
                    db, run_id, "warn",
                    "Add-on stage stopped by the budget check. The paper, citation audit, reviewer "
                    "findings, and artifacts produced before the stop have been saved.",
                )
            return
        if rag_on:
            await self._index_outputs(run_id, meta.get("user_id"), meta.get("project_id"), meta.get("openai_key", ""), ctx)
        with SessionLocal() as db:
            await self._transition(db, run_id, "completed", "Real run completed.")
            await self._log(db, run_id, "info", "Run completed. Real draft, citation audit, reviewer findings, and artifacts are ready.")

    async def _run_stage(
        self, run_id: int, provider: str, api_key: str, model: str,
        stage: str, label: str, ctx: Dict, label_suffix: str = "", extra_context: str = "",
        usage: Optional[Dict] = None, fatal: bool = True,
    ) -> Optional[str]:
        """Stream one stage; return its text, or None if cancelled/failed. Accumulates
        token usage into ``usage`` when provided.

        ``fatal`` controls whether a provider error ends the whole run. It must be
        False for stages dispatched concurrently (reviewer panel, swarm workers):
        those run inside ``asyncio.gather`` alongside siblings that may well
        succeed, so letting one member transition the run to "failed" marks a run
        dead while its siblings keep working and spending. The caller owning the
        fan-out decides what a partial failure means, because only it can see how
        many members survived."""
        tag = f"{stage}:{label_suffix}" if label_suffix else stage
        system, user, max_tokens, tools = agents.build_prompt(stage, ctx)
        if extra_context:
            user += (
                "\n\n<grounding_context>\nGround the writing in the facts below; do not "
                "invent citations or report numbers that contradict them:\n"
                + extra_context + "\n</grounding_context>"
            )
        with SessionLocal() as db:
            await self._log(db, run_id, "info", f"[{tag}] {label} working… (web_search={'on' if tools else 'off'})")

        buffer: List[str] = []
        flushed = {"n": 0}

        def on_text(chunk: str) -> None:
            buffer.append(chunk)

        try:
            text, in_tok, out_tok = await provider_adapters.stream_stage(
                provider=provider, api_key=api_key, model=model,
                system=system, user=user, max_tokens=max_tokens, tools=tools,
                on_text=on_text, should_cancel=lambda: run_id in self._cancelled,
            )
        except Exception as exc:
            with SessionLocal() as db:
                if fatal:
                    await self._transition(db, run_id, "failed", f"{tag} failed: {exc}")
                await self._log(db, run_id, "error", f"[{tag}] failed: {exc}")
            return None

        if run_id in self._cancelled:
            with SessionLocal() as db:
                await self._transition(db, run_id, "cancelled", "Run cancelled by user.")
                await self._log(db, run_id, "warn", f"[{tag}] cancelled.")
            return None

        if usage is not None:
            usage["input"] += in_tok
            usage["output"] += out_tok
        preview = " ".join(text.split())[:160]
        with SessionLocal() as db:
            await self._log(db, run_id, "info", f"[{tag}] complete — {len(text)} chars. {preview}…")
        return text

    async def _enforce_stage_budget(self, run_id: int, model: str, usage: Dict, meta: Dict) -> bool:
        """Persist metered cost so far; stop the run if a budget limit is crossed.

        Runs after every stage (and every reviewer) so ``actual_cost`` stays
        accurate even for cancelled/failed runs, and a runaway run can never
        stream past the approved budget by more than one stage. Returns True if
        the run was stopped.
        """
        attempt_spend = cost.cost_usd(model, usage.get("input", 0), usage.get("output", 0)) + meta.get("addon_cost_usd", 0.0)
        spent = meta.get("prior_cost_usd", 0.0) + attempt_spend
        reason = budget_breach(
            model, usage, meta.get("budget_threshold", 0.0), meta.get("monthly_remaining", float("inf")),
            prior_cost_usd=meta.get("prior_cost_usd", 0.0),
            addon_cost_usd=meta.get("addon_cost_usd", 0.0),
        )
        with SessionLocal() as db:
            run = db.get(Run, run_id)
            if run:
                run.actual_cost = round(spent, 4)
                db.commit()
            if reason:
                await self._transition(db, run_id, "failed", f"Budget stop: {reason}.")
                await self._log(db, run_id, "error", f"Run stopped by per-stage budget check — {reason}.")
        return reason is not None

    async def _maybe_cancel(self, run_id: int) -> bool:
        if run_id not in self._cancelled:
            return False
        with SessionLocal() as db:
            await self._transition(db, run_id, "cancelled", "Run cancelled by user.")
            await self._log(db, run_id, "warn", "Cancellation received. Real runner stopped.")
        return True

    # ---- context + persistence -------------------------------------------
    def _load_context(self, run_id: int) -> Tuple[Dict, Optional[ProviderKey], Dict]:
        with SessionLocal() as db:
            run = db.get(Run, run_id)
            if not run:
                return {}, None, {}
            project = db.get(Project, run.project_id)
            brief = db.get(Brief, run.brief_id)
            owner_id = project.owner_id if project else None
            key = enabled_provider_key(db, owner_id) if owner_id is not None else None
            # Embeddings always need an OpenAI key, independent of the generation
            # provider (Claude has no embeddings endpoint).
            openai_key = ""
            if owner_id is not None:
                row = enabled_key_for(db, owner_id, "openai")
                openai_key = crypto.decrypt(row.api_key) if row else ""
            ctx = {
                "idea": (project.idea_text if project and getattr(project, "idea_text", None) else ""),
                "brief": (brief.content_markdown or render_brief(brief.content_json)) if brief else "",
                "title": ((brief.content_json or {}).get("title") if brief and isinstance(brief.content_json, dict) else "") or "",
            }
            if key is not None:  # detach so scalars stay readable after the session closes
                db.expunge(key)
            cfg = run.config_json or {}
            # Optional add-on stages (opt-in per run, safe-off default): execute
            # the experiment on RunPod, and/or generate figures via an image key.
            runpod_row = enabled_key_for(db, owner_id, "runpod") if owner_id is not None else None
            gemini_row = enabled_key_for(db, owner_id, "gemini") if owner_id is not None else None
            # Image key: an enabled Gemini key preferred, else reuse the OpenAI key.
            if gemini_row:
                image_provider, image_key = "gemini", crypto.decrypt(gemini_row.api_key)
            elif openai_key:
                image_provider, image_key = "openai", openai_key
            else:
                image_provider, image_key = "", ""
            meta = {
                "user_id": owner_id,
                "project_id": run.project_id,
                "run_id": run_id,
                "openai_key": openai_key,
                # Budget context for per-stage checks: the human-approved run
                # threshold (gate 2) and what's left of the monthly cap at start.
                "budget_threshold": float(run.budget_threshold or 0.0),
                # Recovery preserves charges from completed calls in a previous
                # process. New attempt usage is added to, never substituted for,
                # this durable amount.
                "prior_cost_usd": float(run.actual_cost or 0.0),
                "monthly_remaining": (
                    cost.remaining_budget(db, owner_id) if owner_id is not None else float("inf")
                ),
                # "pipeline" (default, fixed order) or "agentic" (orchestrator
                # chooses each next action within code-enforced invariants).
                "orchestration": str(cfg.get("orchestration") or "pipeline").strip().lower(),
                "advisor": bool(cfg.get("advisor", False)),
                # Iterative refinement loop (pipeline mode): how many review->revise
                # rounds at most, and the aggregate reviewer score (0-10) that lets
                # the loop stop early. Clamped to safe hard limits regardless of the
                # stored config (which the API already validated at run creation).
                "revise_iterations": max(1, min(REVISE_ITERS_HARD_CAP, int(cfg.get("revise_iterations", MAX_REVISE_ITERS)))),
                "revise_target": max(0.0, min(10.0, float(cfg.get("revise_target", REVISE_SCORE_TARGET)))),
                # Orchestrator-worker swarm: opt-in, and its fan-out is clamped
                # here as well as at the API so a stored config can never widen
                # it beyond what the estimate priced at gate 2.
                "research_swarm": bool(cfg.get("research_swarm")),
                "swarm_subagents": max(1, min(
                    SWARM_SUBAGENTS_HARD_CAP,
                    int(cfg.get("swarm_subagents", SWARM_SUBAGENTS_DEFAULT)),
                )),
                # Add-on stages — each requires its own opt-in AND an enabled key.
                "execute": bool(cfg.get("execute")),
                "figures": bool(cfg.get("figures")),
                "gpu_type": str(cfg.get("gpu_type") or "rtx 4090"),
                "runpod_key": crypto.decrypt(runpod_row.api_key) if runpod_row else "",
                "runpod_endpoint": (runpod_row.model_name or "").strip() if runpod_row else "",
                "image_provider": image_provider,
                "image_key": image_key,
            }
            return ctx, key, meta

    async def _retrieve(self, run_id: int, openai_key: str, user_id, ctx: Dict) -> str:
        """Embed the brief+plan and pull related chunks from the vector store."""
        try:
            query = (ctx.get("brief", "") + "\n\n" + ctx.get("plan", "")).strip()[:8000]
            if not query:
                return ""
            with SessionLocal() as db:
                await self._log(db, run_id, "info", "Retrieving related sources from the vector store (RAG)…")
            vecs = await provider_adapters.embed_texts(api_key=openai_key, texts=[query])
            if not vecs:
                return ""
            hits = await asyncio.to_thread(
                vector_store.search, vecs[0], k=6, user_id=user_id, exclude_run_id=run_id,
            )
            if not hits:
                return ""
            block = "\n\n".join(
                f"[source {i + 1}] {content[:1200]}" for i, (content, _url, _dist) in enumerate(hits)
            )
            with SessionLocal() as db:
                await self._log(db, run_id, "info", f"Grounded with {len(hits)} retrieved chunk(s) from prior runs.")
            return block
        except Exception as exc:  # RAG is best-effort; never fail the run
            with SessionLocal() as db:
                await self._log(db, run_id, "warn", f"RAG retrieval skipped: {exc}")
            return ""

    async def _index_outputs(self, run_id: int, user_id, project_id, openai_key: str, ctx: Dict) -> None:
        """Embed this run's outputs and store them for future retrieval."""
        try:
            pieces: List[Tuple[str, str]] = []
            for kind in ("revised", "draft", "citations", "plan"):
                for chunk in vector_store.chunk_text(ctx.get(kind, "")):
                    pieces.append((kind, chunk))
            if not pieces:
                return
            vecs = await provider_adapters.embed_texts(api_key=openai_key, texts=[c for _k, c in pieces])
            if len(vecs) != len(pieces):
                return
            items = [
                {"user_id": user_id, "project_id": project_id, "run_id": run_id,
                 "kind": kind, "content": chunk, "embedding": vec}
                for (kind, chunk), vec in zip(pieces, vecs)
            ]
            written = await asyncio.to_thread(vector_store.add_documents, items)
            with SessionLocal() as db:
                await self._log(db, run_id, "info", f"Indexed {written} chunk(s) into the vector store for future runs.")
        except Exception as exc:
            with SessionLocal() as db:
                await self._log(db, run_id, "warn", f"Vector indexing skipped: {exc}")

    def _finish_outputs(
        self, db: Session, run_id: int, provider: str, model: str,
        ctx: Dict, reviews: Dict[str, str], usage: Optional[Dict] = None,
        orchestration: str = "pipeline", action_log: Optional[List[Dict[str, str]]] = None,
        addon_cost_usd: float = 0.0,
        prior_cost_usd: float = 0.0,
    ) -> None:
        run = db.get(Run, run_id)
        if not run:
            return
        brief = db.get(Brief, run.brief_id)
        title = (brief.content_json or {}).get("title") if brief else None
        title = title or "AgentLab Research Draft"

        draft = ctx.get("draft", "")
        citations = ctx.get("citations", "")
        plan = ctx.get("plan", "")
        revised = ctx.get("revised", "")

        # Parsed reviewer scores make run quality measurable (charts, quality
        # gates, and the agentic Orchestrator's revise-again decisions).
        scores = {k: s for k, s in ((k, review_score(v)) for k, v in reviews.items()) if s is not None}

        # The Editor's revision (when the stage ran) is the run's primary draft;
        # the pre-review original is preserved as its own artifact below.
        run.draft_markdown = revised or draft
        run.analysis_json = {
            "summary": (
                f"Real LLM run via {provider} · {model}. Draft, citation audit, adversarial "
                f"reviewer panel{', and an Editor revision' if revised else ''} were generated "
                "from the approved brief."
            ),
            "provider": provider,
            "model": model,
            "real": True,
            "revised": bool(revised),
            "orchestration": orchestration,
            "actions": action_log or [],
            "scores": scores,
            "avg_score": round(sum(scores.values()) / len(scores), 1) if scores else None,
            "tokens": dict(usage) if usage else {},
            "plan_excerpt": " ".join(plan.split())[:600],
            "citation_audit_excerpt": " ".join(citations.split())[:600],
            "advisor": {
                "enabled": bool(ctx.get("advisor_plan") or ctx.get("advisor_delivery")),
                "plan_verdict": "revise" if advisor_requests_revision(ctx.get("advisor_plan", "")) else "approve",
                "delivery_verdict": "revise" if advisor_requests_revision(ctx.get("advisor_delivery", "")) else "approve",
            },
            # Add-on stage outcomes (present only when opt-in + keys were set).
            "execution": ctx.get("execution"),
            "figures": ctx.get("figures", []),
            "addon_cost_usd": round(addon_cost_usd, 4),
            # Deterministic anti-hallucination report (enforced by the export gate).
            "groundedness": ctx.get("groundedness"),
            "reviewed_paper_checksum": _sha256_text(revised or draft) if reviews else "",
        }
        # Real metered cost = LLM tokens + add-on GPU/image dollars. Fall back
        # to the estimate only when a provider returns no usage counters.
        if usage and (usage.get("input") or usage.get("output")):
            run.actual_cost = round(
                prior_cost_usd
                + cost.cost_usd(model, usage.get("input", 0), usage.get("output", 0))
                + addon_cost_usd,
                4,
            )
        else:
            run.actual_cost = round(prior_cost_usd + run.cost_estimate + addon_cost_usd, 4)

        # Reviewer findings — one per persona, carrying the full critique.
        for reviewer, text in reviews.items():
            run_review = ReviewFinding(
                project_id=run.project_id,
                run_id=run.id,
                category=reviewer,
                severity=_severity_from_review(text),
                finding=text.strip()[:8000],
                suggested_fix=(_section(text, "Required Changes") or "See critique.")[:4000],
            )
            db.add(run_review)

        # Artifacts: real paper (original + revision), citation audit, plan, reviews.
        artifacts: List[Tuple[str, str, str]] = [
            ("draft", "paper-draft.md", draft or "# (empty draft)\n"),
            ("report", "citation-audit.md", citations or "# (no citation audit)\n"),
            ("plan", "experiment-plan.md", plan or "# (no plan)\n"),
        ]
        if revised:
            artifacts.insert(1, ("draft", "paper-revised.md", revised))
        for reviewer, text in reviews.items():
            artifacts.append(("review", f"review-{reviewer}.md", text or "# (empty review)\n"))
        if ctx.get("advisor_plan"):
            artifacts.append(("advisor", "advisor-plan-review.md", ctx["advisor_plan"]))
        if ctx.get("advisor_delivery"):
            artifacts.append(("advisor", "advisor-delivery-review.md", ctx["advisor_delivery"]))

        for kind, filename, content in artifacts:
            path = write_artifact(run.id, filename, content)
            db.add(Artifact(
                run_id=run.id, type=kind, name=filename, path=str(path),
                checksum=checksum(path), metadata_json={"real": True, "provider": provider, "model": model},
            ))
        db.commit()

    # ---- log / transition --------------------------------------------------
    async def _log(self, db: Session, run_id: int, level: str, message: str) -> RunLog:
        last = db.query(RunLog).filter(RunLog.run_id == run_id).order_by(RunLog.sequence.desc()).first()
        row = RunLog(run_id=run_id, sequence=(last.sequence + 1 if last else 1), level=level, message=message)
        db.add(row)
        db.commit()
        db.refresh(row)
        await self.manager.broadcast(
            run_id,
            {
                "type": "log",
                "id": row.id,
                "run_id": run_id,
                "sequence": row.sequence,
                "level": row.level,
                "message": row.message,
                "created_at": row.created_at.isoformat(),
            },
        )
        return row

    async def _transition(self, db: Session, run_id: int, status: str, note: str) -> None:
        run = db.get(Run, run_id)
        if not run:
            return
        previous = run.status
        run.status = status
        if status == "running" and not run.started_at:
            run.started_at = now()
            run.session.started_at = run.started_at
        if status in {"completed", "failed", "cancelled"}:
            run.ended_at = now()
            run.session.ended_at = run.ended_at
            run.session.status = status
        else:
            run.session.status = status
        db.add(StatusHistory(entity_type="run", entity_id=run.id, from_status=previous, to_status=status, note=note))
        db.commit()
        await self.manager.broadcast(run_id, {"type": "status", "status": status})


# Which context key each stage's output is stored under for downstream stages.
_OUTPUT_KEY = {"plan": "plan", "draft": "draft", "verify": "citations", "revise": "revised"}
