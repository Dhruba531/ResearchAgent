from __future__ import annotations

"""FastAPI entrypoint for the AgentLab production MVP.

This file wires the product workflow together: authentication, project/brief
management, human approval gates, real run orchestration, artifact downloads,
WebSocket log streaming, and serving the built React dashboard.
"""

import json
import hashlib
import logging
import math
import re
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect, status
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from auth import COOKIE_SAMESITE, SESSION_COOKIE, clear_auth_session, create_auth_session, current_user, hash_password, user_from_token, verify_password
from database import ARTIFACT_ROOT, SessionLocal, get_db, init_db
from runner_common import ConnectionManager, write_artifact
from real_runner import (
    MAX_REVISE_ITERS,
    REVISE_ITERS_HARD_CAP,
    SWARM_SUBAGENTS_DEFAULT,
    SWARM_SUBAGENTS_HARD_CAP,
    RealAgentRunner,
    enabled_key_for,
    enabled_provider_key,
)
import os
import cost
import crypto
import agents
import groundedness
import observability
import provider_adapters
import ratelimit
import runpod_adapter
import supabase_auth
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from models import AgentSession, Approval, Artifact, Brief, Campaign, Candidate, PaperRevision, Project, ProviderKey, ReviewFinding, Run, RunLog, StatusHistory, User, now
from schemas import (
    AgentMetricsOut,
    ApprovalIn,
    ArtifactOut,
    AuditCheckOut,
    AuditReportOut,
    BriefOut,
    BriefUpdate,
    CampaignCreate,
    CampaignOut,
    CampaignSpendOut,
    CandidateAuditOut,
    CandidateNotes,
    CandidateOut,
    CandidateRejectIn,
    CandidateTraceOut,
    CostEstimateIn,
    CostEstimateOut,
    ExportOut,
    FrontierPointOut,
    IdeaIn,
    LeaderboardRowOut,
    LoginIn,
    PaperRevisionEstimateOut,
    PaperRevisionOut,
    PaperRevisionPreviewIn,
    PaperRevisionTarget,
    ProviderKeyIn,
    ProviderKeyOut,
    ProviderKeyTestOut,
    ProjectCreate,
    ProjectOut,
    ProjectUpdate,
    RegisterIn,
    ReviewOut,
    RunCreate,
    RunOut,
    TraceFileNodeOut,
    TraceStepOut,
    UserOut,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Initialize persistence and recover runs orphaned by a restart.

    Production boots with no demo data or demo account (demo seeding removed).
    """
    _validate_deployment_security()
    crypto.validate_configuration()
    init_db()
    db = SessionLocal()
    recovered: List[tuple[int, bool]] = []
    try:
        _encrypt_legacy_provider_keys(db)
        recovered = _recover_interrupted_runs(db)
    finally:
        db.close()
    # Run rows are the durable queue. Every run is provider-backed.
    for run_id, _is_real in recovered:
        real_runner.start(run_id)
    try:
        yield
    finally:
        try:
            timeout = int(os.environ.get("AGENTLAB_SHUTDOWN_TIMEOUT_S", "20"))
        except ValueError:
            timeout = 20
        await real_runner.shutdown(timeout=max(1, min(timeout, 60)))


def _encrypt_legacy_provider_keys(db: Session) -> None:
    """One-way migration for keys created before encryption was required."""
    if not crypto.is_active():
        return
    changed = False
    for row in db.query(ProviderKey).all():
        if row.api_key and not crypto.is_encrypted(row.api_key):
            row.api_key = crypto.encrypt(row.api_key)
            changed = True
    if changed:
        db.commit()


def _recover_interrupted_runs(db: Session) -> List[tuple[int, bool]]:
    """Reset and reclaim queued/running work after a process restart.

    Runs are restarted from their approved brief. Partial generated outputs are
    removed first so completion remains idempotent; append-only logs and status
    history are retained as the audit trail.
    """
    stuck = db.query(Run).filter(Run.status.in_(["queued", "running"])).all()
    recovered: List[tuple[int, bool]] = []
    for run in stuck:
        previous = run.status
        for artifact in list(run.artifacts):
            try:
                path = Path(artifact.path).resolve()
                if ARTIFACT_ROOT.resolve() in path.parents:
                    path.unlink(missing_ok=True)
            except OSError:
                logging.getLogger("agentlab.recovery").warning(
                    "Could not remove partial artifact for recovered run %s", run.id
                )
            db.delete(artifact)
        db.query(ReviewFinding).filter(ReviewFinding.run_id == run.id).delete(synchronize_session=False)
        run.status = "queued"
        run.started_at = None
        run.ended_at = None
        # Provider calls completed before the crash were already billed. Keep
        # their durable metered cost so the retry adds to it and monthly spend
        # cannot be reset by restarting the service.
        runtime_state = dict((run.analysis_json or {}).get("_runtime") or {})
        run.analysis_json = {"_runtime": runtime_state} if runtime_state else {}
        run.draft_markdown = ""
        run.session.status = "queued"
        run.session.started_at = None
        run.session.ended_at = None
        db.add(StatusHistory(
            entity_type="run", entity_id=run.id, from_status=previous, to_status="queued",
            note="Run reclaimed from the durable queue after a server restart.",
        ))
        recovered.append((run.id, True))
    if stuck:
        db.commit()
    return recovered


observability.configure_logging()
observability.init_sentry()
app = FastAPI(title="AgentLab", version="2.0.0", lifespan=lifespan)
app.add_middleware(observability.RequestContextMiddleware)
app.add_middleware(observability.SecurityHeadersMiddleware)

_max_request_bytes = max(16_384, int(os.environ.get("AGENTLAB_MAX_REQUEST_BYTES", "1048576")))
app.add_middleware(observability.RequestSizeLimitMiddleware, max_bytes=_max_request_bytes)

_allowed_hosts = [h.strip() for h in os.environ.get("AGENTLAB_ALLOWED_HOSTS", "").split(",") if h.strip()]
if _allowed_hosts:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=_allowed_hosts)

# CORS for a separately-deployed frontend (e.g. the Cloudflare/Lovable app calling
# this API cross-origin). Set AGENTLAB_CORS_ORIGINS to a comma-separated allowlist.
# Credentials are allowed so the session cookie is sent; for true cross-site cookies
# the session cookie must also be SameSite=None; Secure (see auth.py — follow-up).
_cors_origins = [o.strip() for o in os.environ.get("AGENTLAB_CORS_ORIGINS", "").split(",") if o.strip()]
_allowed_origins = set(_cors_origins)
if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


def _validate_deployment_security() -> None:
    """Reject unsafe production configuration instead of starting insecurely."""
    production = os.environ.get("AGENTLAB_ENV", "").strip().lower() in {"production", "staging"}
    if not production:
        return
    database_url = os.environ.get("AGENTLAB_DATABASE_URL", "").strip()
    if not database_url:
        raise RuntimeError("AGENTLAB_DATABASE_URL is required in production.")
    sqlite_opt_in = os.environ.get("AGENTLAB_ALLOW_SQLITE_PRODUCTION", "").strip().lower() in {"1", "true", "yes"}
    if database_url.startswith("sqlite") and not sqlite_opt_in:
        raise RuntimeError(
            "Production requires Postgres; set AGENTLAB_ALLOW_SQLITE_PRODUCTION=1 only for an explicit single-node deployment."
        )
    if not _allowed_hosts:
        raise RuntimeError("AGENTLAB_ALLOWED_HOSTS is required in production.")
    if any("*" in host for host in _allowed_hosts):
        raise RuntimeError("AGENTLAB_ALLOWED_HOSTS must not contain a wildcard in production.")
    if not all(origin.startswith("https://") and "*" not in origin for origin in _cors_origins):
        raise RuntimeError("Production CORS origins must be explicit HTTPS origins.")
    from auth import COOKIE_SECURE

    if not COOKIE_SECURE:
        raise RuntimeError("AGENTLAB_COOKIE_SECURE=1 is required in production.")
    if not ARTIFACT_ROOT.is_absolute():
        raise RuntimeError("AGENTLAB_ARTIFACT_ROOT must be an absolute path in production.")
    for name in ("WEB_CONCURRENCY", "UVICORN_WORKERS", "AGENTLAB_WORKERS"):
        raw_workers = os.environ.get(name, "").strip()
        if raw_workers:
            try:
                workers = int(raw_workers)
            except ValueError as exc:
                raise RuntimeError(f"{name} must be an integer.") from exc
            if workers != 1:
                raise RuntimeError(
                    "AgentLab currently requires exactly one API worker because run dispatch and rate limits "
                    "are process-local. Deploy one replica with one worker."
                )
    if not math.isfinite(cost.USER_MONTHLY_CAP_USD) or cost.USER_MONTHLY_CAP_USD <= 0:
        raise RuntimeError("AGENTLAB_USER_MONTHLY_CAP_USD must be a finite positive number.")
    try:
        shutdown_timeout = int(os.environ.get("AGENTLAB_SHUTDOWN_TIMEOUT_S", "20"))
    except ValueError as exc:
        raise RuntimeError("AGENTLAB_SHUTDOWN_TIMEOUT_S must be an integer.") from exc
    if not 1 <= shutdown_timeout <= 60:
        raise RuntimeError("AGENTLAB_SHUTDOWN_TIMEOUT_S must be between 1 and 60 seconds.")
    if COOKIE_SAMESITE == "none" and not _cors_origins:
        raise RuntimeError("SameSite=None requires an explicit AGENTLAB_CORS_ORIGINS allowlist.")
    if supabase_auth.is_enabled():
        if supabase_auth.SUPABASE_JWT_SECRET and len(supabase_auth.SUPABASE_JWT_SECRET) < 32:
            raise RuntimeError("SUPABASE_JWT_SECRET is too short for production.")
        if not supabase_auth.SUPABASE_JWT_ISS:
            raise RuntimeError("SUPABASE_JWT_ISS is required when Supabase authentication is enabled.")
        if supabase_auth.SUPABASE_JWKS_URL and not supabase_auth.SUPABASE_JWKS_URL.startswith("https://"):
            raise RuntimeError("SUPABASE_JWKS_URL must use HTTPS in production.")


def _origin_allowed(origin: str, host: str) -> bool:
    """Whether a browser ``Origin`` may make a credentialed request here.

    Allowed when: (a) no Origin header (non-browser client — carries no ambient
    session cookie, so no CSRF/CSWSH risk), (b) Origin is in the configured
    allowlist, or (c) Origin is same-origin with the request's Host (the
    dashboard FastAPI serves itself). Everything else is a foreign site and is
    rejected. CORS only controls who may *read* responses; this controls who may
    *send* credentialed requests — the gap that made SameSite=None cookies +
    the log WebSocket exploitable cross-site.
    """
    if not origin:
        return True
    if origin in _allowed_origins:
        return True
    try:
        from urllib.parse import urlparse

        return bool(host) and urlparse(origin).netloc == host
    except Exception:
        return False


_UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def _origin_guard_required() -> bool:
    """Origin checks are required when browser cookies may be sent cross-site."""
    return bool(_cors_origins) or COOKIE_SAMESITE == "none"


@app.middleware("http")
async def csrf_origin_guard(request: Request, call_next):
    """Reject cross-site credentialed writes (CSRF defense via Origin check).

    Only active when a cross-origin allowlist is configured — i.e. the
    SameSite=None deployment where the browser attaches the cookie cross-site.
    In the default local setup (no allowlist, SameSite=Lax) the cookie already
    isn't sent cross-site, so this stays out of the way. Safe methods and
    non-/api paths are never blocked; a missing Origin (curl, tests, server-to-
    server) is allowed because it can't be a browser CSRF vector.
    """
    if (
        _origin_guard_required()
        and request.method in _UNSAFE_METHODS
        and request.url.path.startswith("/api/")
    ):
        origin = request.headers.get("origin", "")
        if origin and not _origin_allowed(origin, request.headers.get("host", "")):
            return JSONResponse({"detail": "Cross-origin request rejected."}, status_code=403)
    return await call_next(request)


manager = ConnectionManager()
# Second broadcast channel, keyed by campaign id rather than run id. Run logs and
# search-loop progress are different streams with different lifetimes, so they
# get separate managers instead of sharing one keyspace.
campaign_manager = ConnectionManager()
real_runner = RealAgentRunner(manager)


# Serializer helpers keep SQLAlchemy internals out of API responses and make it
# clear where nested data, such as logs and artifacts, is intentionally included.
# ===========================================================================
# Response serializers — turn DB models into the Pydantic API shapes
# ===========================================================================
def user_out(user: User) -> UserOut:
    return UserOut(id=user.id, name=user.name, email=user.email, role=user.role)


def brief_out(brief: Optional[Brief]) -> Optional[BriefOut]:
    if not brief:
        return None
    return BriefOut(
        id=brief.id,
        project_id=brief.project_id,
        version=brief.version,
        content_json=brief.content_json or {},
        content_markdown=brief.content_markdown,
        is_approved=brief.is_approved,
        approved_by=brief.approved_by,
        approved_at=brief.approved_at,
        created_at=brief.created_at,
        updated_at=brief.updated_at,
    )


def log_out(log: RunLog) -> Dict[str, Any]:
    return {
        "id": log.id,
        "run_id": log.run_id,
        "sequence": log.sequence,
        "level": log.level,
        "message": log.message,
        "created_at": log.created_at,
    }


def artifact_out(artifact: Artifact) -> ArtifactOut:
    return ArtifactOut(id=artifact.id, run_id=artifact.run_id, type=artifact.type, name=artifact.name, metadata_json=artifact.metadata_json or {}, created_at=artifact.created_at)


def run_out(run: Optional[Run], include_logs: bool = False) -> Optional[RunOut]:
    if not run:
        return None
    logs = [log_out(row) for row in run.logs] if include_logs else []
    return RunOut(
        id=run.id,
        session_id=run.session_id,
        project_id=run.project_id,
        brief_id=run.brief_id,
        config_json=run.config_json or {},
        status=run.status,
        cost_estimate=run.cost_estimate,
        budget_threshold=run.budget_threshold,
        actual_cost=run.actual_cost,
        analysis_json=run.analysis_json or {},
        draft_markdown=run.draft_markdown,
        started_at=run.started_at,
        ended_at=run.ended_at,
        created_at=run.created_at,
        updated_at=run.updated_at,
        logs=logs,
        artifacts=[artifact_out(row) for row in run.artifacts],
    )


def paper_revision_out(revision: PaperRevision) -> PaperRevisionOut:
    return PaperRevisionOut(
        id=revision.id,
        run_id=revision.run_id,
        created_by=revision.created_by,
        instruction=revision.instruction,
        selected_text=revision.selected_text,
        replacement_text=revision.replacement_text,
        start_offset=revision.start_offset,
        end_offset=revision.end_offset,
        base_checksum=revision.base_checksum,
        result_checksum=revision.result_checksum,
        provider=revision.provider,
        model_name=revision.model_name,
        status=revision.status,
        cost_estimate=revision.cost_estimate,
        actual_cost=revision.actual_cost,
        created_at=revision.created_at,
        applied_at=revision.applied_at,
    )


def _paper_checksum(markdown: str) -> str:
    return hashlib.sha256((markdown or "").encode("utf-8")).hexdigest()


def _validate_revision_target(run: Run, payload: PaperRevisionTarget) -> None:
    """Prove the selection belongs to this exact version of a completed paper."""
    draft = run.draft_markdown or ""
    if run.status != "completed" or not draft:
        raise HTTPException(status_code=409, detail="A completed run with a paper is required.")
    if payload.end_offset <= payload.start_offset or payload.end_offset > len(draft):
        raise HTTPException(status_code=409, detail="The selected paper range is no longer valid.")
    if _paper_checksum(draft) != payload.base_checksum:
        raise HTTPException(status_code=409, detail="The paper changed. Select the passage again.")
    if draft[payload.start_offset:payload.end_offset] != payload.selected_text:
        raise HTTPException(status_code=409, detail="The selected passage does not match the current paper.")


def _revision_estimate(model: str, payload: PaperRevisionTarget) -> tuple[float, int, int]:
    """Conservative token/cost estimate for one targeted replacement call."""
    input_tokens = max(300, math.ceil((len(payload.selected_text) + len(payload.instruction) + 3_000) / 4))
    output_tokens = min(8_000, max(300, math.ceil(len(payload.selected_text) / 3)))
    estimate = round(cost.cost_usd(model, input_tokens, output_tokens) * 1.20, 4)
    return max(0.0001, estimate), input_tokens, output_tokens


def _clean_replacement(text_value: str) -> str:
    """Remove a single whole-response Markdown fence without altering content."""
    value = (text_value or "").strip()
    match = re.fullmatch(r"```(?:markdown|md)?\s*\n(.*?)\n```", value, re.I | re.S)
    return (match.group(1) if match else value).strip()


def review_out(review: ReviewFinding) -> ReviewOut:
    return ReviewOut(
        id=review.id,
        project_id=review.project_id,
        run_id=review.run_id,
        category=review.category,
        severity=review.severity,
        finding=review.finding,
        suggested_fix=review.suggested_fix,
        status=review.status,
        created_at=review.created_at,
    )


def normalize_provider(provider: str) -> str:
    """Use stable provider IDs while accepting user-facing aliases.

    LLM providers (anthropic/openai) drive the writing pipeline; runpod is the
    experiment-execution sandbox key; gemini is a text-to-image (figure) key.
    """
    value = provider.strip().lower()
    if value in {"openai", "chatgpt", "gpt"}:
        return "openai"
    if value in {"anthropic", "claude"}:
        return "anthropic"
    if value in {"runpod", "runpod.io"}:
        return "runpod"
    if value in {"gemini", "google", "nano-banana", "nanobanana", "paperbanana", "paper-banana"}:
        return "gemini"
    raise HTTPException(status_code=400, detail="Provider must be one of: anthropic, openai, runpod, gemini.")


def mask_key(api_key: str) -> str:
    """Return a display-safe key preview without exposing the secret."""
    clean = api_key.strip()
    if len(clean) <= 8:
        return "..." + clean[-4:]
    prefix = clean[: min(6, len(clean) - 4)]
    return f"{prefix}...{clean[-4:]}"


def provider_key_out(row: ProviderKey) -> ProviderKeyOut:
    return ProviderKeyOut(
        id=row.id,
        provider=row.provider,
        model_name=row.model_name,
        is_configured=bool(row.api_key),
        is_enabled=row.is_enabled,
        masked_key=mask_key(crypto.decrypt(row.api_key)),
        key_last4=row.key_last4,
        test_status=row.test_status,
        created_at=row.created_at,
        updated_at=row.updated_at,
        last_tested_at=row.last_tested_at,
    )


def project_out(project: Project) -> ProjectOut:
    """Build the dashboard project shape from related briefs, runs, and reviews."""
    latest_brief = sorted(project.briefs, key=lambda b: b.version, reverse=True)[0] if project.briefs else None
    runs: List[Run] = [run for session in project.sessions for run in session.runs]
    latest_run = sorted(runs, key=lambda row: row.created_at, reverse=True)[0] if runs else None
    return ProjectOut(
        id=project.id,
        owner_id=project.owner_id,
        title=project.title,
        objective=project.objective,
        idea_text=project.idea_text,
        status=project.status,
        created_at=project.created_at,
        updated_at=project.updated_at,
        latest_brief=brief_out(latest_brief),
        latest_run=run_out(latest_run),
        review_findings=[review_out(row) for row in sorted(project.reviews, key=lambda r: r.created_at, reverse=True)],
    )


# ===========================================================================
# Access-control guards — every lookup is scoped to the authenticated owner,
# so a user can never read/act on another user's project, brief, or run.
# ===========================================================================
def owned_project(db: Session, project_id: int, user: User) -> Project:
    """Load a project only if it belongs to the authenticated user."""
    project = (
        db.query(Project)
        .options(joinedload(Project.briefs), joinedload(Project.sessions).joinedload(AgentSession.runs).joinedload(Run.artifacts), joinedload(Project.reviews))
        .filter(Project.id == project_id, Project.owner_id == user.id)
        .first()
    )
    if not project:
        raise HTTPException(status_code=404, detail="Project not found.")
    return project


def owned_brief(db: Session, brief_id: int, user: User) -> Brief:
    """Authorize brief access through its parent project."""
    brief = db.get(Brief, brief_id)
    if not brief:
        raise HTTPException(status_code=404, detail="Brief not found.")
    owned_project(db, brief.project_id, user)
    return brief


def owned_run(db: Session, run_id: int, user: User) -> Run:
    """Authorize run access through its parent project."""
    run = db.query(Run).options(joinedload(Run.logs), joinedload(Run.artifacts)).filter(Run.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found.")
    owned_project(db, run.project_id, user)
    return run


def approved_brief(project: Project) -> Optional[Brief]:
    """Return the latest approved brief; experiment execution depends on it."""
    approved = [brief for brief in project.briefs if brief.is_approved]
    return sorted(approved, key=lambda b: b.version, reverse=True)[0] if approved else None


def estimate_cost(
    project: Project,
    budget_threshold: float,
    config_json: Dict[str, Any],
    *,
    provider_key: ProviderKey,
) -> CostEstimateOut:
    """Estimate the run that will actually execute behind the budget gate."""
    model = provider_adapters.resolve_model(provider_key.provider, provider_key.model_name)
    total, breakdown, assumptions = cost.estimate_real_run(
        model,
        complexity=float(config_json.get("complexity", 1.0) or 1.0),
        orchestration=str(config_json.get("orchestration") or "pipeline"),
        advisor=bool(config_json.get("advisor")),
        execute=bool(config_json.get("execute")),
        figures=bool(config_json.get("figures")),
        gpu_type=str(config_json.get("gpu_type") or "rtx 4090"),
        # Mirror the runner's own defaulting and clamping exactly. If the
        # estimate assumed fewer rounds than the runner will actually execute,
        # the human would approve a ceiling the run is guaranteed to breach.
        revise_iterations=max(
            1, min(REVISE_ITERS_HARD_CAP, int(config_json.get("revise_iterations", MAX_REVISE_ITERS)))
        ),
        # Same mirroring for the swarm: the fan-out priced here must be the
        # fan-out the runner is allowed to execute.
        research_swarm=bool(config_json.get("research_swarm")),
        swarm_subagents=max(
            1, min(SWARM_SUBAGENTS_HARD_CAP, int(config_json.get("swarm_subagents", SWARM_SUBAGENTS_DEFAULT)))
        ),
    )
    return CostEstimateOut(
        cost_estimate=total,
        budget_threshold=budget_threshold,
        mode="real",
        model=model,
        breakdown=breakdown,
        assumptions=assumptions,
    )


_RUN_CONFIG_KEYS = {
    "complexity", "orchestration", "advisor", "execute", "figures", "gpu_type",
    "revise_iterations", "revise_target", "research_swarm", "swarm_subagents",
}
_GPU_TYPES = {"rtx 4090", "rtx a6000", "l40s", "a100", "h100"}


def validated_run_config(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Validate the untyped JSON config before it reaches cost or runner code."""
    unknown = set(raw) - _RUN_CONFIG_KEYS
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unknown run configuration option(s): {', '.join(sorted(unknown))}.")
    config = dict(raw)
    complexity = config.get("complexity", 1)
    if isinstance(complexity, bool) or not isinstance(complexity, (int, float)):
        raise HTTPException(status_code=422, detail="Run complexity must be a number.")
    complexity = float(complexity)
    if not math.isfinite(complexity) or not 0.1 <= complexity <= 10:
        raise HTTPException(status_code=422, detail="Run complexity must be finite and between 0.1 and 10.")
    config["complexity"] = complexity
    orchestration = str(config.get("orchestration") or "pipeline").strip().lower()
    if orchestration not in {"pipeline", "agentic"}:
        raise HTTPException(status_code=422, detail="Orchestration must be 'pipeline' or 'agentic'.")
    config["orchestration"] = orchestration
    for key in ("advisor", "execute", "figures", "research_swarm"):
        if key in config and not isinstance(config[key], bool):
            raise HTTPException(status_code=422, detail=f"Run option '{key}' must be a boolean.")
    # Swarm fan-out multiplies token spend, so the ceiling is enforced here as
    # well as in the runner — the estimate at gate 2 is priced from this value.
    if "swarm_subagents" in config:
        workers = config["swarm_subagents"]
        if isinstance(workers, bool) or not isinstance(workers, int):
            raise HTTPException(status_code=422, detail="Run option 'swarm_subagents' must be an integer.")
        if not 1 <= workers <= SWARM_SUBAGENTS_HARD_CAP:
            raise HTTPException(
                status_code=422,
                detail=f"Run option 'swarm_subagents' must be between 1 and {SWARM_SUBAGENTS_HARD_CAP}.",
            )
        config["swarm_subagents"] = workers
    if "gpu_type" in config:
        gpu = str(config["gpu_type"]).strip().lower()
        if gpu not in _GPU_TYPES:
            raise HTTPException(status_code=422, detail="Unsupported GPU type.")
        config["gpu_type"] = gpu
    # Iterative refinement loop knobs (pipeline mode).
    if "revise_iterations" in config:
        iters = config["revise_iterations"]
        if isinstance(iters, bool) or not isinstance(iters, int):
            raise HTTPException(status_code=422, detail="Run option 'revise_iterations' must be an integer.")
        if not 1 <= iters <= 5:
            raise HTTPException(status_code=422, detail="Run option 'revise_iterations' must be between 1 and 5.")
        config["revise_iterations"] = iters
    if "revise_target" in config:
        target = config["revise_target"]
        if isinstance(target, bool) or not isinstance(target, (int, float)):
            raise HTTPException(status_code=422, detail="Run option 'revise_target' must be a number.")
        target = float(target)
        if not math.isfinite(target) or not 0 <= target <= 10:
            raise HTTPException(status_code=422, detail="Run option 'revise_target' must be finite and between 0 and 10.")
        config["revise_target"] = target
    return config


# ===========================================================================
# Provider-key routes — per-user LLM keys (encrypted at rest via crypto.py,
# only ever returned masked; rate-limited to curb abuse)
# ===========================================================================
@app.get("/api/provider-keys", response_model=List[ProviderKeyOut])
def list_provider_keys(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.query(ProviderKey).filter(ProviderKey.user_id == user.id).order_by(ProviderKey.provider.asc()).all()
    return [provider_key_out(row) for row in rows]


@app.post("/api/provider-keys", response_model=ProviderKeyOut)
def save_provider_key(payload: ProviderKeyIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    ratelimit.enforce(f"pk:{user.id}", ratelimit.KEY_LIMIT, ratelimit.KEY_WINDOW_S)
    provider = normalize_provider(payload.provider)
    api_key = payload.api_key.strip()
    model_name = payload.model_name.strip()
    if provider == "runpod" and model_name and not runpod_adapter.valid_endpoint_id(model_name):
        raise HTTPException(status_code=422, detail="RunPod endpoint ID contains unsupported characters.")
    row = db.query(ProviderKey).filter(ProviderKey.user_id == user.id, ProviderKey.provider == provider).first()
    stored = crypto.encrypt(api_key)  # encrypted at rest when AGENTLAB_SECRET_KEY is set
    if not row:
        row = ProviderKey(user_id=user.id, provider=provider, api_key=stored)
        db.add(row)
    row.api_key = stored
    row.model_name = model_name
    row.key_last4 = api_key[-4:]
    row.is_enabled = payload.is_enabled
    row.test_status = "not_tested"
    try:
        db.commit()
    except IntegrityError:
        # Concurrent first-save requests can race on (user_id, provider).
        db.rollback()
        row = db.query(ProviderKey).filter(ProviderKey.user_id == user.id, ProviderKey.provider == provider).one()
        row.api_key = stored
        row.model_name = model_name
        row.key_last4 = api_key[-4:]
        row.is_enabled = payload.is_enabled
        row.test_status = "not_tested"
        db.commit()
    db.refresh(row)
    return provider_key_out(row)


@app.delete("/api/provider-keys/{provider}")
def delete_provider_key(provider: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    normalized = normalize_provider(provider)
    row = db.query(ProviderKey).filter(ProviderKey.user_id == user.id, ProviderKey.provider == normalized).first()
    if row:
        db.delete(row)
        db.commit()
    return {"ok": True}


@app.post("/api/provider-keys/{provider}/test", response_model=ProviderKeyTestOut)
def test_provider_key(provider: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    ratelimit.enforce(f"pk:{user.id}", ratelimit.KEY_LIMIT, ratelimit.KEY_WINDOW_S)
    normalized = normalize_provider(provider)
    row = db.query(ProviderKey).filter(ProviderKey.user_id == user.id, ProviderKey.provider == normalized).first()
    if not row:
        raise HTTPException(status_code=404, detail="Provider key is not configured.")
    # Local format heuristic only (no external call): typical key prefixes per
    # provider; unknown prefixes just fall back to a length check.
    _prefixes = {"openai": "sk-", "anthropic": "sk-ant-", "gemini": "AIza", "runpod": ""}
    expected_prefix = _prefixes.get(normalized, "")
    plaintext = crypto.decrypt(row.api_key)
    ok = plaintext.startswith(expected_prefix) and len(plaintext) >= 20
    row.last_tested_at = now()
    row.test_status = "format_ok" if ok else "format_warning"
    db.commit()
    detail = (
        "Local format check passed. No external provider call was made."
        if ok
        else f"Saved key does not look like a typical {normalized} key. No external provider call was made."
    )
    return ProviderKeyTestOut(provider=normalized, ok=ok, status=row.test_status, detail=detail, tested_at=row.last_tested_at)


# ===========================================================================
# Auth routes — local register/login/logout/me. Protected routes accept either
# this session cookie or a Supabase JWT (see auth.current_user).
# ===========================================================================
def _client_id(request: Request) -> str:
    """Best-effort client identity for rate limiting.

    Behind the Cloudflare Tunnel every request reaches uvicorn from localhost,
    so prefer the edge-provided headers when present. These are spoofable when
    the app is NOT behind a trusted proxy — which is why login is additionally
    limited per target email below.
    """
    return (
        request.headers.get("cf-connecting-ip")
        or (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
        or (request.client.host if request.client else "unknown")
    )


@app.post("/api/auth/register", response_model=UserOut)
def register(payload: RegisterIn, request: Request, response: Response, db: Session = Depends(get_db)):
    ratelimit.enforce(f"auth:{_client_id(request)}", ratelimit.AUTH_LIMIT, ratelimit.AUTH_WINDOW_S)
    email = payload.email.strip().lower()
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=409, detail="Email already registered.")
    user = User(name=payload.name.strip(), email=email, password_hash=hash_password(payload.password))
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Email already registered.")
    db.refresh(user)
    create_auth_session(db, user, response)
    return user_out(user)


@app.post("/api/auth/login", response_model=UserOut)
def login(payload: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    # Two buckets: per-client (slows wide scans) and per-account (an attacker
    # rotating spoofed forwarded-for headers still can't hammer one account).
    email = payload.email.strip().lower()
    ratelimit.enforce(f"auth:{_client_id(request)}", ratelimit.AUTH_LIMIT, ratelimit.AUTH_WINDOW_S)
    ratelimit.enforce(f"auth-email:{email}", ratelimit.AUTH_LIMIT, ratelimit.AUTH_WINDOW_S)
    user = db.query(User).filter(User.email == email).first()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password.")
    create_auth_session(db, user, response)
    return user_out(user)


@app.post("/api/auth/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    clear_auth_session(db, request.cookies.get(SESSION_COOKIE), response)
    return {"ok": True}


@app.get("/api/auth/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return user_out(user)


# ===========================================================================
# Project routes — the research workspace (create / list / get / update / archive)
# ===========================================================================
@app.get("/api/projects", response_model=List[ProjectOut])
def list_projects(user: User = Depends(current_user), db: Session = Depends(get_db)):
    projects = (
        db.query(Project)
        .options(joinedload(Project.briefs), joinedload(Project.sessions).joinedload(AgentSession.runs).joinedload(Run.artifacts), joinedload(Project.reviews))
        .filter(Project.owner_id == user.id, Project.status != "archived")
        .order_by(Project.updated_at.desc())
        .all()
    )
    return [project_out(project) for project in projects]


@app.post("/api/projects", response_model=ProjectOut)
def create_project(payload: ProjectCreate, user: User = Depends(current_user), db: Session = Depends(get_db)):
    project = Project(owner_id=user.id, title=payload.title.strip(), objective=payload.objective, idea_text=payload.idea_text, status="draft")
    db.add(project)
    db.commit()
    db.refresh(project)
    return project_out(owned_project(db, project.id, user))


@app.get("/api/projects/{project_id}", response_model=ProjectOut)
def get_project(project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return project_out(owned_project(db, project_id, user))


@app.patch("/api/projects/{project_id}", response_model=ProjectOut)
def update_project(project_id: int, payload: ProjectUpdate, user: User = Depends(current_user), db: Session = Depends(get_db)):
    project = owned_project(db, project_id, user)
    if payload.title is not None:
        project.title = payload.title.strip()
    if payload.objective is not None:
        project.objective = payload.objective
    if payload.idea_text is not None:
        project.idea_text = payload.idea_text
    db.commit()
    return project_out(owned_project(db, project_id, user))


@app.post("/api/projects/{project_id}/archive")
def archive_project(project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    project = owned_project(db, project_id, user)
    active = any(
        run.status in {"queued", "running"}
        for session in project.sessions
        for run in session.runs
    )
    if active:
        raise HTTPException(status_code=409, detail="Cancel the active run before archiving this project.")
    project.status = "archived"
    db.commit()
    return {"ok": True}


# ===========================================================================
# Idea + Brief routes — GATE 1. idea -> generate brief -> edit -> approve.
# Only an approved brief unlocks runs (enforced in create_run).
# ===========================================================================
@app.post("/api/projects/{project_id}/idea", response_model=ProjectOut)
def save_idea(project_id: int, payload: IdeaIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    project = owned_project(db, project_id, user)
    project.idea_text = payload.idea_text
    project.status = "briefing"
    db.commit()
    return project_out(owned_project(db, project_id, user))


@app.get("/api/projects/{project_id}/briefs", response_model=List[BriefOut])
def list_briefs(project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    project = owned_project(db, project_id, user)
    return [brief_out(brief) for brief in sorted(project.briefs, key=lambda b: b.version, reverse=True)]


@app.post("/api/projects/{project_id}/briefs/generate", response_model=BriefOut)
async def generate_brief(project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Generate a research brief through the user's enabled LLM provider."""
    ratelimit.enforce(f"brief:{user.id}", ratelimit.BRIEF_LIMIT, ratelimit.BRIEF_WINDOW_S)
    project = owned_project(db, project_id, user)
    if not project.idea_text.strip():
        raise HTTPException(status_code=400, detail="Save a research idea before generating a brief.")
    key = enabled_provider_key(db, user.id)
    if key is None:
        raise HTTPException(status_code=409, detail="Enable an Anthropic or OpenAI key before generating a brief.")
    provider = key.provider
    model = provider_adapters.resolve_model(provider, key.model_name)
    api_key = crypto.decrypt(key.api_key)
    idea = project.idea_text
    system, prompt, max_tokens, tools = agents.build_prompt("brief", {"idea": idea})
    db.rollback()
    try:
        markdown, input_tokens, output_tokens = await provider_adapters.stream_stage(
            provider=provider,
            api_key=api_key,
            model=model,
            system=system,
            user=prompt,
            max_tokens=max_tokens,
            tools=tools,
        )
    except Exception as exc:
        logging.getLogger("agentlab.brief").warning(
            "Brief generation failed for project %s: %s", project_id, type(exc).__name__
        )
        raise HTTPException(status_code=502, detail="The model could not generate the research brief.")
    markdown = markdown.strip()
    if not markdown:
        raise HTTPException(status_code=502, detail="The model returned an empty research brief.")
    title_match = re.search(r"^##\s+Title[^\n]*\n+(.+)$", markdown, re.I | re.M)
    generated_title = (title_match.group(1).strip() if title_match else "")[:200]

    # Re-authorize and lock only for the short persistence transaction. Version
    # is chosen after the paid call so concurrent requests cannot collide.
    db.query(Project).filter(Project.id == project_id, Project.owner_id == user.id).with_for_update().one_or_none()
    project = owned_project(db, project_id, user)
    version = (max([brief.version for brief in project.briefs]) + 1) if project.briefs else 1
    content = {
        "title": generated_title or project.title,
        "generation": {
            "provider": provider,
            "model": model,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost_usd": cost.cost_usd(model, input_tokens, output_tokens),
        },
    }
    brief = Brief(project_id=project.id, version=version, content_json=content, content_markdown=markdown)
    project.status = "briefing"
    db.add(brief)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="A brief version was generated concurrently; retry.")
    db.refresh(brief)
    return brief_out(brief)


@app.patch("/api/briefs/{brief_id}", response_model=BriefOut)
def update_brief(brief_id: int, payload: BriefUpdate, user: User = Depends(current_user), db: Session = Depends(get_db)):
    brief = owned_brief(db, brief_id, user)
    if brief.is_approved:
        raise HTTPException(status_code=400, detail="Approved briefs are immutable. Generate a new version to revise.")
    brief.content_markdown = payload.content_markdown
    brief.content_json = payload.content_json or brief.content_json
    db.commit()
    db.refresh(brief)
    return brief_out(brief)


@app.post("/api/briefs/{brief_id}/approve", response_model=BriefOut)
def approve_brief(brief_id: int, payload: ApprovalIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    brief = owned_brief(db, brief_id, user)
    # Only one brief version should unlock execution for a project.
    for row in db.query(Brief).filter(Brief.project_id == brief.project_id).all():
        row.is_approved = False
        row.approved_by = None
        row.approved_at = None
    brief.is_approved = True
    brief.approved_by = user.id
    brief.approved_at = now()
    project = db.get(Project, brief.project_id)
    project.status = "ready_for_run"
    db.add(Approval(project_id=brief.project_id, action_type="brief_approval", target_type="brief", target_id=brief.id, approved_by=user.id, notes=payload.notes))
    db.commit()
    db.refresh(brief)
    return brief_out(brief)


# ===========================================================================
# Run routes — GATE 2 (budget). estimate -> budget-approved create -> get/cancel.
# Every run requires an enabled LLM provider and real cost approval. create_run
# also enforces rate limit + monthly spend cap.
# ===========================================================================
@app.post("/api/projects/{project_id}/runs/estimate", response_model=CostEstimateOut)
def create_estimate(project_id: int, payload: CostEstimateIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    project = owned_project(db, project_id, user)
    if not approved_brief(project):
        raise HTTPException(status_code=400, detail="Approve a brief before estimating a run.")
    config = validated_run_config(payload.config_json)
    pkey = enabled_provider_key(db, user.id)
    if pkey is None:
        raise HTTPException(status_code=409, detail="Enable an Anthropic or OpenAI key before estimating a run.")
    return estimate_cost(
        project,
        payload.budget_threshold,
        config,
        provider_key=pkey,
    )


@app.post("/api/projects/{project_id}/runs", response_model=RunOut)
async def create_run(project_id: int, payload: RunCreate, user: User = Depends(current_user), db: Session = Depends(get_db)):
    # Abuse protection + hard per-user monthly spend cap (LLM spend is real money).
    ratelimit.enforce(f"run:{user.id}", ratelimit.RUN_LIMIT, ratelimit.RUN_WINDOW_S)
    # Serialize run reservations per account on production databases, preventing
    # concurrent requests from each observing the same remaining monthly budget.
    db.query(User).filter(User.id == user.id).with_for_update().one()
    if cost.over_budget(db, user.id):
        raise HTTPException(
            status_code=402,
            detail=f"Monthly spend cap of ${cost.USER_MONTHLY_CAP_USD:.2f} reached. Runs resume next month.",
        )
    config = validated_run_config(payload.config_json)
    project = owned_project(db, project_id, user)
    brief = approved_brief(project)
    # Two human gates protect run creation: an approved brief and approved cost.
    if not brief:
        raise HTTPException(status_code=400, detail="Approve a brief before starting a run.")
    pkey = enabled_provider_key(db, user.id)
    if pkey is None:
        raise HTTPException(status_code=409, detail="Enable an Anthropic or OpenAI key before starting a run.")
    if payload.budget_threshold <= 0:
        raise HTTPException(status_code=400, detail="A positive approved budget threshold is required.")
    if config.get("execute"):
        runpod_key = enabled_key_for(db, user.id, "runpod")
        if not runpod_adapter.allow_execution() or not runpod_key or not (runpod_key.model_name or "").strip():
            raise HTTPException(
                status_code=409,
                detail="Experiment execution requires the operator execution flag and an enabled RunPod key with endpoint ID.",
            )
    if config.get("figures"):
        gemini_key = enabled_key_for(db, user.id, "gemini")
        openai_key = enabled_key_for(db, user.id, "openai")
        if not gemini_key and not openai_key:
            raise HTTPException(status_code=409, detail="Figure generation requires an enabled Gemini or OpenAI key.")
    estimate = estimate_cost(
        project,
        payload.budget_threshold,
        config,
        provider_key=pkey,
    )
    if not payload.approved_cost:
        raise HTTPException(status_code=400, detail="Human budget approval is required before starting a run.")
    if payload.budget_threshold and estimate.cost_estimate > payload.budget_threshold:
        raise HTTPException(status_code=400, detail="Cost estimate exceeds the approved budget threshold.")
    if cost.monthly_commitment(db, user.id) + estimate.cost_estimate > cost.USER_MONTHLY_CAP_USD:
        raise HTTPException(
            status_code=402,
            detail="This run's estimate would exceed the monthly spend cap, including active run reservations.",
        )
    session = AgentSession(
        project_id=project.id,
        brief_id=brief.id,
        status="queued",
        provider=pkey.provider,
        command_plan={
            "runner": "RealAgentRunner",
            "provider": pkey.provider,
            "model": pkey.model_name or "default",
        },
    )
    db.add(session)
    db.flush()
    run = Run(
        session_id=session.id,
        project_id=project.id,
        brief_id=brief.id,
        config_json=config,
        status="queued",
        cost_estimate=estimate.cost_estimate,
        budget_threshold=payload.budget_threshold,
    )
    project.status = "running"
    db.add(run)
    db.flush()
    db.add(Approval(project_id=project.id, action_type="budget_approval", target_type="run", target_id=run.id, approved_by=user.id, notes=f"Approved ${payload.budget_threshold:.2f} budget threshold."))
    db.add(StatusHistory(entity_type="run", entity_id=run.id, from_status="", to_status="queued", note="Run created after brief and budget approval."))
    db.commit()
    db.refresh(run)
    real_runner.start(run.id)
    return run_out(owned_run(db, run.id, user), include_logs=True)


@app.get("/api/projects/{project_id}/runs", response_model=List[RunOut])
def list_runs(project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    owned_project(db, project_id, user)
    runs = db.query(Run).options(joinedload(Run.artifacts)).filter(Run.project_id == project_id).order_by(Run.created_at.desc()).all()
    return [run_out(run) for run in runs]


@app.get("/api/runs/{run_id}", response_model=RunOut)
def get_run(run_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return run_out(owned_run(db, run_id, user), include_logs=True)


@app.post("/api/runs/{run_id}/revisions/estimate", response_model=PaperRevisionEstimateOut)
def estimate_paper_revision(
    run_id: int,
    payload: PaperRevisionTarget,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    run = owned_run(db, run_id, user)
    _validate_revision_target(run, payload)
    key = enabled_provider_key(db, user.id)
    if key is None:
        raise HTTPException(status_code=409, detail="Enable an Anthropic or OpenAI key to revise by prompt.")
    model = provider_adapters.resolve_model(key.provider, key.model_name)
    estimate, input_tokens, output_tokens = _revision_estimate(model, payload)
    return PaperRevisionEstimateOut(
        cost_estimate=estimate,
        provider=key.provider,
        model=model,
        assumptions=[
            f"One targeted model call; approximately {input_tokens:,} input and up to {output_tokens:,} output tokens.",
            "Includes a 20% uncertainty reserve; the preview is charged even if it is not applied.",
        ],
    )


@app.post("/api/runs/{run_id}/revisions/preview", response_model=PaperRevisionOut)
async def preview_paper_revision(
    run_id: int,
    payload: PaperRevisionPreviewIn,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Generate, meter, and persist a replacement preview without changing the paper."""
    ratelimit.enforce(
        f"revision:{user.id}", ratelimit.REVISION_LIMIT, ratelimit.REVISION_WINDOW_S
    )
    run = owned_run(db, run_id, user)
    _validate_revision_target(run, payload)
    key = enabled_provider_key(db, user.id)
    if key is None:
        raise HTTPException(status_code=409, detail="Enable an Anthropic or OpenAI key to revise by prompt.")
    provider = key.provider
    model = provider_adapters.resolve_model(provider, key.model_name)
    estimate, _input_estimate, max_output_tokens = _revision_estimate(model, payload)
    if not payload.approved_cost:
        raise HTTPException(
            status_code=400,
            detail=f"Approve the estimated ${estimate:.4f} revision-preview cost first.",
        )
    remaining = cost.remaining_budget(db, user.id)
    if estimate > remaining:
        raise HTTPException(
            status_code=402,
            detail=f"Revision estimate ${estimate:.4f} exceeds the remaining monthly budget ${remaining:.4f}.",
        )
    draft = run.draft_markdown
    before = draft[max(0, payload.start_offset - 1_500):payload.start_offset]
    after = draft[payload.end_offset:payload.end_offset + 1_500]
    api_key = crypto.decrypt(key.api_key)
    # Release any read transaction while waiting on a paid network call. Apply
    # still revalidates the checksum, so a concurrent paper change is safe.
    db.rollback()
    system = (
        "You are a precise academic editor. Rewrite only the selected passage according to the "
        "user's instruction. Preserve supported facts, measurements, citations, Markdown heading "
        "level, and the paper's voice unless the instruction explicitly changes them. Never invent "
        "evidence or citations. Return only the replacement passage, with no preface or code fence."
    )
    prompt = (
        f"<instruction>\n{payload.instruction}\n</instruction>\n\n"
        f"<context_before>\n{before}\n</context_before>\n\n"
        f"<selected_passage>\n{payload.selected_text}\n</selected_passage>\n\n"
        f"<context_after>\n{after}\n</context_after>"
    )
    try:
        generated, input_tokens, output_tokens = await provider_adapters.stream_stage(
            provider=provider,
            api_key=api_key,
            model=model,
            system=system,
            user=prompt,
            max_tokens=max_output_tokens,
            tools=[],
        )
    except Exception as exc:
        logging.getLogger("agentlab.revision").warning(
            "Paper revision preview failed for run %s: %s", run_id, type(exc).__name__
        )
        raise HTTPException(status_code=502, detail="The model could not generate a revision preview.")
    replacement = _clean_replacement(generated)
    if not replacement:
        raise HTTPException(status_code=502, detail="The model returned an empty revision preview.")
    if len(replacement) > 100_000:
        raise HTTPException(status_code=502, detail="The model returned an oversized revision preview.")
    actual = cost.cost_usd(model, input_tokens, output_tokens)

    # Re-authorize after the network call, then record the paid preview even if
    # another editor changed the paper while it was being generated.
    run = owned_run(db, run_id, user)
    revision = PaperRevision(
        run_id=run.id,
        created_by=user.id,
        instruction=payload.instruction.strip(),
        selected_text=payload.selected_text,
        replacement_text=replacement,
        start_offset=payload.start_offset,
        end_offset=payload.end_offset,
        base_checksum=payload.base_checksum,
        result_checksum="",
        provider=provider,
        model_name=model,
        status="preview",
        cost_estimate=estimate,
        actual_cost=actual,
    )
    run.actual_cost = round(float(run.actual_cost or 0) + actual, 4)
    analysis = dict(run.analysis_json or {})
    analysis["revision_cost_usd"] = round(float(analysis.get("revision_cost_usd") or 0) + actual, 4)
    run.analysis_json = analysis
    db.add(revision)
    db.commit()
    db.refresh(revision)
    return paper_revision_out(revision)


@app.get("/api/runs/{run_id}/revisions", response_model=List[PaperRevisionOut])
def list_paper_revisions(
    run_id: int,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    owned_run(db, run_id, user)
    rows = (
        db.query(PaperRevision)
        .filter(PaperRevision.run_id == run_id)
        .order_by(PaperRevision.created_at.desc())
        .all()
    )
    return [paper_revision_out(row) for row in rows]


@app.post("/api/runs/{run_id}/revisions/{revision_id}/apply", response_model=RunOut)
async def apply_paper_revision(
    run_id: int,
    revision_id: int,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Apply a stored preview if its exact base paper is still current."""
    run = owned_run(db, run_id, user)
    revision = db.get(PaperRevision, revision_id)
    if not revision or revision.run_id != run.id or revision.created_by != user.id:
        raise HTTPException(status_code=404, detail="Revision preview not found.")
    if revision.status != "preview":
        raise HTTPException(status_code=409, detail="This revision preview is no longer pending.")
    target = PaperRevisionTarget(
        instruction=revision.instruction,
        selected_text=revision.selected_text,
        start_offset=revision.start_offset,
        end_offset=revision.end_offset,
        base_checksum=revision.base_checksum,
    )
    _validate_revision_target(run, target)
    candidate = (
        run.draft_markdown[:revision.start_offset]
        + revision.replacement_text
        + run.draft_markdown[revision.end_offset:]
    )
    # Recheck cited URLs/placeholders on the candidate before making it current.
    try:
        grounded = await groundedness.assess(candidate, "")
    except Exception:
        grounded = None

    # Lock/reload after the asynchronous check. PostgreSQL serializes concurrent
    # applies; the checksum/range validation provides the same stale-write guard
    # for the explicit single-node SQLite deployment.
    run = db.query(Run).filter(Run.id == run_id).with_for_update().one()
    revision = db.query(PaperRevision).filter(PaperRevision.id == revision_id).with_for_update().one()
    if revision.status != "preview":
        raise HTTPException(status_code=409, detail="This revision preview is no longer pending.")
    _validate_revision_target(run, target)
    previous_checksum = _paper_checksum(run.draft_markdown)
    result_checksum = _paper_checksum(candidate)
    path = write_artifact(run.id, f"paper-revision-{revision.id}.md", candidate)
    run.draft_markdown = candidate
    analysis = dict(run.analysis_json or {})
    analysis["groundedness"] = grounded
    analysis["revision_review_required"] = True
    analysis["last_revision_id"] = revision.id
    run.analysis_json = analysis
    revision.status = "applied"
    revision.result_checksum = result_checksum
    revision.applied_at = now()
    for finding in db.query(ReviewFinding).filter(ReviewFinding.run_id == run.id).all():
        finding.status = "stale"
    project = db.get(Project, run.project_id)
    if project:
        project.status = "review"
    db.add(
        Artifact(
            type="paper_revision",
            name=f"paper-revision-{revision.id}.md",
            run_id=run.id,
            path=str(path),
            checksum=result_checksum,
            metadata_json={
                "revision_id": revision.id,
                "created_by": user.id,
                "base_checksum": previous_checksum,
                "result_checksum": result_checksum,
                "provider": revision.provider,
                "model": revision.model_name,
            },
        )
    )
    db.add(
        StatusHistory(
            entity_type="paper_revision",
            entity_id=revision.id,
            from_status="preview",
            to_status="applied",
            note=f"Applied by user {user.id} to run {run.id}.",
        )
    )
    db.commit()
    db.expire_all()
    return run_out(owned_run(db, run_id, user), include_logs=True)


@app.post("/api/runs/{run_id}/cancel", response_model=RunOut)
async def cancel_run(run_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    run = owned_run(db, run_id, user)
    if run.status not in {"queued", "running"}:
        return run_out(run, include_logs=True)
    real_runner.cancel(run.id)
    previous = run.status
    run.status = "cancelled"
    run.session.status = "cancelled"
    run.ended_at = now()
    run.session.ended_at = run.ended_at
    db.add(StatusHistory(entity_type="run", entity_id=run.id, from_status=previous, to_status="cancelled", note="Cancelled by user."))
    db.commit()
    await manager.broadcast(run.id, {"type": "status", "status": "cancelled"})
    return run_out(owned_run(db, run_id, user), include_logs=True)


# ===========================================================================
# Reviews + Final export — GATE 3. The reviewer-panel findings inform the human,
# and nothing exports without an explicit final approval.
# ===========================================================================
@app.get("/api/projects/{project_id}/reviews", response_model=List[ReviewOut])
def list_reviews(project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    project = owned_project(db, project_id, user)
    return [review_out(row) for row in sorted(project.reviews, key=lambda r: (r.category, r.created_at))]


@app.post("/api/projects/{project_id}/final/approve", response_model=ExportOut)
def approve_final(project_id: int, payload: ApprovalIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    project = owned_project(db, project_id, user)
    runs = [run for session in project.sessions for run in session.runs if run.status == "completed" and run.draft_markdown]
    if not runs:
        raise HTTPException(status_code=400, detail="A completed run with draft sections is required before export.")
    run = sorted(runs, key=lambda row: row.created_at, reverse=True)[0]
    # The gate must be satisfied by findings from the exact run being exported —
    # findings left over from an older run must not unlock a newer draft.
    run_reviews = [row for row in project.reviews if row.run_id == run.id]
    if not run_reviews:
        raise HTTPException(status_code=400, detail="Reviewer findings for the exported run are required before final approval.")
    current_reviews = [row for row in run_reviews if row.status != "stale"]
    if not current_reviews and not payload.force:
        raise HTTPException(
            status_code=409,
            detail=(
                "The paper changed after its reviewer panel, so the findings are stale. "
                "Re-run review or approve with force=true."
            ),
        )
    analysis = dict(run.analysis_json or {})
    reviewed_checksum = str(analysis.get("reviewed_paper_checksum") or "")
    if reviewed_checksum and reviewed_checksum != _paper_checksum(run.draft_markdown) and not payload.force:
        raise HTTPException(
            status_code=409,
            detail=(
                "The paper changed after its reviewer panel. Re-run review or approve with force=true "
                "to explicitly accept the unreviewed version."
            ),
        )
    if analysis.get("revision_review_required") and not payload.force:
        raise HTTPException(
            status_code=409,
            detail=(
                "The paper changed after the reviewer panel. Review the targeted revision, then "
                "approve with force=true to explicitly accept the post-review edit."
            ),
        )
    # Groundedness gate (anti-hallucination): block export of a draft with dead
    # source URLs, unresolved [CITATION NEEDED] placeholders, or citations the
    # verifier itself flagged as fabricated — unless the human explicitly forces
    # it.
    g = analysis.get("groundedness")
    if g and not g.get("verified", True) and not payload.force:
        problems = []
        if g.get("fabricated_flags"):
            problems.append(f"{g['fabricated_flags']} citation(s) flagged unsupported/fabricated")
        if g.get("placeholders"):
            problems.append(f"{g['placeholders']} unresolved [CITATION NEEDED] placeholder(s)")
        if g.get("urls_dead"):
            problems.append(f"{g['urls_dead']} dead/unreachable source URL(s)")
        if problems:
            raise HTTPException(
                status_code=409,
                detail="Groundedness check failed: " + "; ".join(problems)
                + f". Groundedness score {g.get('score')}. Resolve these, or re-approve with force=true to override.",
            )
    approval = Approval(project_id=project.id, action_type="final_export_approval", target_type="run", target_id=run.id, approved_by=user.id, notes=payload.notes)
    db.add(approval)
    project.status = "exported"
    db.commit()
    db.refresh(approval)
    if analysis.get("revision_review_required"):
        analysis["revision_review_required"] = False
        analysis["revision_review_override_approval_id"] = approval.id
        run.analysis_json = analysis
        db.commit()

    provenance = {
        "project_id": project.id,
        "run_id": run.id,
        "brief_id": run.brief_id,
        "approval_id": approval.id,
        "artifact_ids": [artifact.id for artifact in run.artifacts],
        "paper_checksum": _paper_checksum(run.draft_markdown),
        "last_revision_id": analysis.get("last_revision_id"),
    }
    markdown = run.draft_markdown + "\n\n## Provenance\n\n```json\n" + json.dumps(provenance, indent=2) + "\n```\n"
    export_path = write_artifact(run.id, "final-export.md", markdown)
    artifact = Artifact(type="export", name="Final reviewed draft package", run_id=run.id, path=str(export_path), metadata_json=provenance)
    db.add(artifact)
    db.commit()
    db.refresh(artifact)
    return ExportOut(approval_id=approval.id, artifact_id=artifact.id, markdown=markdown, provenance=provenance)


# ===========================================================================
# Artifact download + live run-log WebSocket. Downloads are owner-scoped and
# must stay inside ARTIFACT_ROOT (no path traversal).
# ===========================================================================
@app.get("/api/artifacts/{artifact_id}/download")
def download_artifact(artifact_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    artifact = db.get(Artifact, artifact_id)
    if not artifact:
        raise HTTPException(status_code=404, detail="Artifact not found.")
    run = owned_run(db, artifact.run_id, user)
    path = Path(artifact.path)
    # Artifact downloads are restricted to files created under the configured root.
    if not path.exists() or ARTIFACT_ROOT.resolve() not in path.resolve().parents:
        raise HTTPException(status_code=404, detail="Artifact file not found.")
    return FileResponse(path, filename=path.name)


@app.websocket("/api/runs/{run_id}/logs/ws")
async def run_logs_ws(websocket: WebSocket, run_id: int):
    db = next(get_db())
    try:
        # CORS does not apply to WebSockets and the cookie is SameSite=None in the
        # cross-origin deployment, so a foreign page could otherwise open this
        # socket with the victim's cookie and read their run logs (CSWSH). Reject
        # any handshake whose Origin isn't allowlisted or same-origin.
        if _origin_guard_required():
            origin = websocket.headers.get("origin", "")
            if origin and not _origin_allowed(origin, websocket.headers.get("host", "")):
                await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
                return
        # WebSockets cannot use the normal dependency stack, so authenticate from
        # the same HTTP-only cookie used by REST routes.
        user = user_from_token(db, websocket.cookies.get(SESSION_COOKIE))
        if not user:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        run = owned_run(db, run_id, user)
        await manager.connect(run_id, websocket)
        # Send historical logs first so reconnecting browsers recover context.
        for log in run.logs:
            await websocket.send_json({"type": "log", **log_out(log), "created_at": log.created_at.isoformat()})
        await websocket.send_json({"type": "status", "status": run.status})
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(run_id, websocket)
    finally:
        db.close()


# ===========================================================================
# Autoresearch campaigns — the search loop over many candidate runs.
#
# A Run answers "what did this experiment produce". A Campaign answers "what did
# the search discover, at what cost, and which candidate should ship". The same
# governance applies one level up: a search needs an approved brief to start, a
# declared budget it cannot widen, and a human decision to promote a result.
#
# This module is the archive and its read models. Candidates are written by the
# search engine; the endpoints below never fabricate them, so a campaign with no
# evaluated candidates correctly reports an empty leaderboard and frontier.
# ===========================================================================

# Reading one archived file is capped so a large trace cannot exhaust memory on
# the API host; the client is told when it received a truncated view.
TRACE_FILE_MAX_BYTES = 1_048_576
TRACE_TREE_MAX_DEPTH = 6
TRACE_TREE_MAX_ENTRIES = 500


def campaign_spend_out(campaign: Campaign) -> CampaignSpendOut:
    raw = campaign.spend_json or {}
    return CampaignSpendOut(
        iters=int(raw.get("iters", campaign.iteration) or 0),
        wall_clock_minutes=float(raw.get("wall_clock_minutes", 0.0) or 0.0),
        model_calls=int(raw.get("model_calls", 0) or 0),
        gpu_hours=float(raw.get("gpu_hours", 0.0) or 0.0),
        usd=float(raw.get("usd", 0.0) or 0.0),
    )


def campaign_metrics_out(campaign: Campaign) -> AgentMetricsOut:
    """Derive search-quality metrics from the archive rather than cached counters.

    These describe how well the *search* is doing, not how good any one
    candidate is. Computing them from the candidate rows keeps them honest: a
    stored counter can drift from reality after a crash or a manual edit.
    """
    candidates = list(campaign.candidates)
    evaluated = [c for c in candidates if c.status in {"kept", "discarded"}]
    invalid = [c for c in candidates if c.status == "invalid"]
    finished = len(evaluated) + len(invalid)
    kept = [c for c in evaluated if c.status == "kept"]

    hit_rate = (len(kept) / len(evaluated)) if evaluated else 0.0
    invalid_rate = (len(invalid) / finished) if finished else 0.0

    # A regression is "useful" when it was rejected on score but still recorded an
    # interpretation worth mining for a later transplant.
    regressions = [c for c in evaluated if c.status == "discarded"]
    useful = [c for c in regressions if (c.notes_json or {}).get("interpretation")]
    useful_regression_rate = (len(useful) / len(regressions)) if regressions else 0.0

    best = next((c for c in candidates if c.id == campaign.best_candidate_id), None)
    time_to_best = 0.0
    if best is not None and campaign.started_at and best.ended_at:
        time_to_best = max(0.0, (best.ended_at - campaign.started_at).total_seconds() / 60.0)

    # How many iterations have passed since the best candidate was found.
    stagnation = max(0, campaign.iteration - best.iteration) if best is not None else campaign.iteration

    return AgentMetricsOut(
        hit_rate=round(hit_rate, 4),
        invalid_rate=round(invalid_rate, 4),
        time_to_best_minutes=round(time_to_best, 2),
        useful_regression_rate=round(useful_regression_rate, 4),
        # Derived from the archive like every other figure here. Preferring a
        # stored counter would reintroduce exactly the drift this function's
        # docstring promises to avoid.
        stagnation_counter=stagnation,
    )


def campaign_failure_counts(campaign: Campaign) -> Dict[str, int]:
    """Tally failures by kind so the console can show where the search is losing."""
    counts: Dict[str, int] = {}
    for candidate in campaign.candidates:
        if candidate.failure_kind:
            counts[candidate.failure_kind] = counts.get(candidate.failure_kind, 0) + 1
    return counts


def campaign_out(campaign: Campaign) -> CampaignOut:
    return CampaignOut(
        id=campaign.id,
        project_id=campaign.project_id,
        name=campaign.name,
        status=campaign.status,
        iteration=campaign.iteration,
        config=campaign.config_json or {},
        spend=campaign_spend_out(campaign),
        best_score=campaign.best_score,
        best_candidate_id=campaign.best_candidate_id,
        metrics=campaign_metrics_out(campaign),
        failure_counts=campaign_failure_counts(campaign),
        created_at=campaign.created_at,
        started_at=campaign.started_at,
        ended_at=campaign.ended_at,
    )


def _cost_vector(candidate: Candidate) -> Dict[str, float]:
    raw = candidate.cost_vector_json or {}
    out: Dict[str, float] = {}
    for key, value in raw.items():
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(number):
            out[str(key)] = number
    return out


def candidate_out(candidate: Candidate, include_diff: bool = True) -> CandidateOut:
    notes_raw = candidate.notes_json or {}
    audit_raw = candidate.audit_json or {}
    return CandidateOut(
        id=candidate.id,
        campaign_id=candidate.campaign_id,
        run_id=candidate.run_id,
        parent_id=candidate.parent_id,
        iteration=candidate.iteration,
        edit_family=candidate.edit_family,
        status=candidate.status,
        score=candidate.score,
        cost_vector=_cost_vector(candidate),
        diff=(candidate.diff or "") if include_diff else "",
        metrics=candidate.metrics_json or {},
        failure_kind=candidate.failure_kind,
        notes=CandidateNotes(
            hypothesis=str(notes_raw.get("hypothesis", "") or ""),
            result=str(notes_raw.get("result", "") or ""),
            interpretation=str(notes_raw.get("interpretation", "") or ""),
            rejection_reason=str(notes_raw.get("rejection_reason", "") or ""),
        ),
        trace_dir=candidate.trace_dir or None,
        audit=CandidateAuditOut(
            eval_hash_match=bool(audit_raw.get("eval_hash_match", True)),
            leakage_scan=str(audit_raw.get("leakage_scan", "skipped")),
            budget_compliant=bool(audit_raw.get("budget_compliant", True)),
            reviewed_by=audit_raw.get("reviewed_by"),
            reviewed_at=audit_raw.get("reviewed_at"),
            decision=str(audit_raw.get("decision", "pending")),
        ),
        created_at=candidate.created_at,
        ended_at=candidate.ended_at,
    )


def owned_campaign(db: Session, campaign_id: int, user: User) -> Campaign:
    """Authorize campaign access through its parent project."""
    campaign = db.get(Campaign, campaign_id)
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found.")
    owned_project(db, campaign.project_id, user)
    return campaign


def owned_candidate(db: Session, candidate_id: int, user: User) -> Candidate:
    """Authorize candidate access through its campaign's project."""
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found.")
    owned_campaign(db, candidate.campaign_id, user)
    return candidate


def _campaign_trace_root(candidate: Candidate) -> Path:
    """On-disk archive directory holding one candidate's raw evidence.

    Honours an explicit ``trace_dir`` when the engine recorded one, so evidence
    archived outside the default layout is still readable. The stored value is
    still confined to the artifact root: it arrives from the writer, not the
    client, but a stray absolute path must not turn this into arbitrary file
    read. Anything escaping the root falls back to the derived location.
    """
    default = (ARTIFACT_ROOT / f"campaign-{candidate.campaign_id}" / f"candidate-{candidate.id}").resolve()
    stored = (candidate.trace_dir or "").strip()
    if not stored:
        return default
    root = ARTIFACT_ROOT.resolve()
    candidate_path = Path(stored)
    resolved = (candidate_path if candidate_path.is_absolute() else root / candidate_path).resolve()
    return resolved if resolved == root or root in resolved.parents else default


def _safe_trace_path(candidate: Candidate, relative: str) -> Path:
    """Resolve a path inside the candidate's trace directory, or refuse.

    Trace paths come from the client, so this is the same containment rule used
    for artifact downloads: resolve first (which collapses `..` and follows any
    symlink), then prove the result is still under the candidate's own root.
    """
    cleaned = str(relative or "").strip()
    if not cleaned or "\x00" in cleaned or PurePosixPath(cleaned).is_absolute():
        raise HTTPException(status_code=400, detail="Trace path is invalid.")
    root = _campaign_trace_root(candidate)
    target = (root / cleaned).resolve()
    if target != root and root not in target.parents:
        raise HTTPException(status_code=404, detail="Trace file not found.")
    return target


def _trace_tree(directory: Path, root: Path, depth: int = 0) -> List[TraceFileNodeOut]:
    """List the archive directory as a bounded tree the console can browse."""
    if depth >= TRACE_TREE_MAX_DEPTH or not directory.is_dir():
        return []
    nodes: List[TraceFileNodeOut] = []
    try:
        entries = sorted(directory.iterdir(), key=lambda p: (p.is_file(), p.name))
    except OSError:
        return []
    for entry in entries[:TRACE_TREE_MAX_ENTRIES]:
        # Skip anything that resolves outside the archive (stray symlink).
        resolved = entry.resolve()
        if root not in resolved.parents and resolved != root:
            continue
        relative = resolved.relative_to(root).as_posix()
        if entry.is_dir():
            nodes.append(
                TraceFileNodeOut(
                    name=entry.name,
                    path=relative,
                    type="dir",
                    children=_trace_tree(entry, root, depth + 1),
                )
            )
        else:
            try:
                size = entry.stat().st_size
            except OSError:
                size = None
            nodes.append(TraceFileNodeOut(name=entry.name, path=relative, type="file", size_bytes=size))
    return nodes


def _read_trace_text(path: Path) -> str:
    """Read a capped, lossy-decoded slice of an archived text file."""
    if not path.is_file():
        return ""
    try:
        data = path.read_bytes()[:TRACE_FILE_MAX_BYTES]
    except OSError:
        return ""
    return data.decode("utf-8", errors="replace")


@app.post("/api/projects/{project_id}/campaigns", response_model=CampaignOut, status_code=201)
def create_campaign(
    project_id: int,
    payload: CampaignCreate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Open a search campaign over an approved brief, under a declared budget."""
    project = owned_project(db, project_id, user)

    # Gate 1 applies to a search exactly as it applies to a single run: no
    # approved brief, no experiments.
    brief = approved_brief(project)
    if not brief:
        raise HTTPException(status_code=400, detail="Approve a brief before starting a campaign.")

    # Budget invariance: an unbounded search is one that cannot be stopped by
    # policy, only by noticing the bill. Require at least one declared limit.
    budget = payload.budget.model_dump(exclude_none=True)
    if payload.max_iters is not None:
        budget.setdefault("max_iters", payload.max_iters)
    if not budget:
        raise HTTPException(
            status_code=400,
            detail="Declare at least one campaign budget limit (max_iters, wall_clock_minutes, model_calls, gpu_hours, or usd).",
        )

    config: Dict[str, Any] = {
        "budget": budget,
        "brief_id": brief.id,
        "edit_families": payload.edit_families,
        # The metric contract. Declared once at creation and read by every
        # ranking view, so the leaderboard, frontier, and candidate list can
        # never disagree about which direction is "better".
        "metric": payload.metric,
        "lower_is_better": payload.lower_is_better,
        "cost_metric": payload.cost_metric,
    }
    if payload.max_iters is not None:
        config["max_iters"] = payload.max_iters
    if payload.explore is not None:
        config["explore"] = payload.explore
    if payload.stopping is not None:
        config["stopping"] = payload.stopping.model_dump(exclude_none=True)

    campaign = Campaign(
        project_id=project.id,
        name=payload.name or f"Search {now():%Y-%m-%d %H:%M}",
        status="queued",
        iteration=0,
        config_json=config,
        spend_json={"iters": 0, "wall_clock_minutes": 0.0, "model_calls": 0, "gpu_hours": 0.0, "usd": 0.0},
        metrics_json={},
        failure_counts_json={},
    )
    db.add(campaign)
    db.commit()
    db.refresh(campaign)
    db.add(
        StatusHistory(
            entity_type="campaign",
            entity_id=campaign.id,
            from_status="",
            to_status="queued",
            note="Campaign created after brief approval with a declared budget.",
        )
    )
    db.commit()
    db.refresh(campaign)
    return campaign_out(campaign)


@app.get("/api/projects/{project_id}/campaigns", response_model=List[CampaignOut])
def list_campaigns(project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    project = owned_project(db, project_id, user)
    campaigns = (
        db.query(Campaign)
        .filter(Campaign.project_id == project.id)
        .order_by(Campaign.created_at.desc())
        .all()
    )
    return [campaign_out(campaign) for campaign in campaigns]


@app.get("/api/campaigns/{campaign_id}", response_model=CampaignOut)
def get_campaign(campaign_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return campaign_out(owned_campaign(db, campaign_id, user))


@app.post("/api/campaigns/{campaign_id}/stop", response_model=CampaignOut)
def stop_campaign(campaign_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Halt a search. Terminal campaigns are left untouched rather than reopened."""
    campaign = owned_campaign(db, campaign_id, user)
    if campaign.status in {"stopped", "completed", "failed"}:
        return campaign_out(campaign)
    previous = campaign.status
    campaign.status = "stopped"
    campaign.ended_at = now()
    db.add(
        StatusHistory(
            entity_type="campaign",
            entity_id=campaign.id,
            from_status=previous,
            to_status="stopped",
            note="Campaign stopped by user.",
        )
    )
    db.commit()
    db.refresh(campaign)
    return campaign_out(campaign)


@app.get("/api/campaigns/{campaign_id}/candidates", response_model=List[CandidateOut])
def list_candidates(
    campaign_id: int,
    sort: str = "iteration",
    filter: str = "",
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """The archive for one campaign, including invalid and discarded attempts.

    Failed candidates are returned by default and are not a bug: the record of
    what did not work is what stops a later proposal from trying it again.
    """
    campaign = owned_campaign(db, campaign_id, user)
    query = db.query(Candidate).filter(Candidate.campaign_id == campaign.id)

    # `filter` accepts a status or an edit family; anything else matches nothing
    # rather than silently returning the unfiltered archive.
    selector = (filter or "").strip()
    if selector:
        if selector in {"kept", "discarded", "invalid", "running", "queued"}:
            query = query.filter(Candidate.status == selector)
        else:
            query = query.filter(Candidate.edit_family == selector)

    if sort == "score":
        # Nulls last so unmeasured candidates never outrank measured ones, and
        # the direction follows the campaign's declared metric — otherwise this
        # list would rank a lower-is-better search backwards while the
        # leaderboard ranked it correctly.
        best_first = (
            Candidate.score.asc()
            if (campaign.config_json or {}).get("lower_is_better")
            else Candidate.score.desc()
        )
        query = query.order_by(Candidate.score.is_(None), best_first)
    elif sort == "created_at":
        query = query.order_by(Candidate.created_at.desc())
    else:
        query = query.order_by(Candidate.iteration.asc())

    # The list view renders rows, not diffs; omitting the patch keeps the payload
    # small for long searches.
    return [candidate_out(candidate, include_diff=False) for candidate in query.all()]


@app.get("/api/campaigns/{campaign_id}/leaderboard", response_model=List[LeaderboardRowOut])
def campaign_leaderboard(campaign_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Measured candidates ranked best-first, with their cost profile."""
    campaign = owned_campaign(db, campaign_id, user)
    lower_is_better = bool((campaign.config_json or {}).get("lower_is_better", False))
    scored = [c for c in campaign.candidates if c.score is not None]
    scored.sort(key=lambda c: c.score, reverse=not lower_is_better)

    rows: List[LeaderboardRowOut] = []
    for candidate in scored:
        costs = _cost_vector(candidate)
        metrics = candidate.metrics_json or {}
        throughput = metrics.get("throughput", metrics.get("tokens_per_sec"))
        rows.append(
            LeaderboardRowOut(
                candidate_id=candidate.id,
                run_id=candidate.run_id,
                parent_id=candidate.parent_id,
                edit_family=candidate.edit_family,
                status=candidate.status,
                score=candidate.score,
                cost_usd=costs.get("usd"),
                throughput=float(throughput) if isinstance(throughput, (int, float)) else None,
                context_tokens=costs.get("context_tokens"),
                note=(candidate.notes_json or {}).get("interpretation") or None,
            )
        )
    return rows


@app.get("/api/campaigns/{campaign_id}/frontier", response_model=List[FrontierPointOut])
def campaign_frontier(campaign_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """The quality/cost tradeoff, with dominated candidates flagged.

    A single leaderboard collapses a two-dimensional decision into one number.
    A candidate is dominated when another is at least as good on quality *and*
    no more expensive, and strictly better on one of the two — those are the
    ones you can discard without losing an option.
    """
    campaign = owned_campaign(db, campaign_id, user)
    config = campaign.config_json or {}
    lower_is_better = bool(config.get("lower_is_better", False))
    cost_key = str(config.get("cost_metric", "usd"))
    metric_label = str(config.get("metric", "score"))

    points: List[tuple[Candidate, float, float]] = []
    for candidate in campaign.candidates:
        if candidate.score is None:
            continue
        cost = _cost_vector(candidate).get(cost_key)
        if cost is None:
            continue
        # Normalize so higher quality is always better for the comparison below.
        quality = -candidate.score if lower_is_better else candidate.score
        points.append((candidate, quality, cost))

    out: List[FrontierPointOut] = []
    for candidate, quality, cost in points:
        dominated = any(
            (other_q >= quality and other_c <= cost) and (other_q > quality or other_c < cost)
            for other, other_q, other_c in points
            if other.id != candidate.id
        )
        out.append(
            FrontierPointOut(
                candidate_id=candidate.id,
                quality=candidate.score,
                cost=cost,
                quality_label=metric_label,
                cost_label=cost_key,
                dominated=dominated,
                edit_family=candidate.edit_family,
            )
        )
    return out


@app.get("/api/candidates/{candidate_id}", response_model=CandidateOut)
def get_candidate(candidate_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return candidate_out(owned_candidate(db, candidate_id, user))


@app.get("/api/candidates/{candidate_id}/trace", response_model=CandidateTraceOut)
def get_candidate_trace(candidate_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Structured search steps plus a browsable view of the raw archive.

    Scalar scores say a candidate failed; the trace is what explains why. Steps
    are read from the candidate's stored metrics, while the tree exposes the
    on-disk evidence so the console can open individual files on demand.
    """
    candidate = owned_candidate(db, candidate_id, user)
    root = _campaign_trace_root(candidate)

    steps: List[TraceStepOut] = []
    raw_steps = (candidate.metrics_json or {}).get("steps")
    if isinstance(raw_steps, list):
        for index, raw in enumerate(raw_steps):
            if not isinstance(raw, dict):
                continue
            tool_calls = raw.get("tool_calls")
            steps.append(
                TraceStepOut(
                    step=int(raw.get("step", index)),
                    phase=raw.get("phase"),
                    tool=raw.get("tool"),
                    prompt=raw.get("prompt"),
                    model_output=raw.get("model_output"),
                    tool_calls=[c for c in tool_calls if isinstance(c, dict)] if isinstance(tool_calls, list) else [],
                    parser_status=raw.get("parser_status"),
                    duration_ms=raw.get("duration_ms"),
                    tokens=raw.get("tokens"),
                    ts=raw.get("ts"),
                )
            )

    return CandidateTraceOut(
        candidate_id=candidate.id,
        steps=steps,
        tree=_trace_tree(root, root) if root.is_dir() else [],
        stdout=_read_trace_text(root / "stdout.log"),
        stderr=_read_trace_text(root / "stderr.log"),
    )


@app.get("/api/candidates/{candidate_id}/trace/file")
def get_candidate_trace_file(
    candidate_id: int,
    path: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Read one archived evidence file, contained to the candidate's directory."""
    candidate = owned_candidate(db, candidate_id, user)
    target = _safe_trace_path(candidate, path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Trace file not found.")
    return {"path": path, "content": _read_trace_text(target)}


@app.post("/api/candidates/{candidate_id}/promote", response_model=CandidateOut)
def promote_candidate(
    candidate_id: int,
    payload: ApprovalIn,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Human gate: accept a candidate as the campaign's best known result.

    Promotion is never automatic. A search can rank candidates, but a person
    decides which one represents a real finding, and that decision is recorded
    alongside the other approval gates.
    """
    candidate = owned_candidate(db, candidate_id, user)
    campaign = db.get(Campaign, candidate.campaign_id)
    if candidate.score is None:
        raise HTTPException(status_code=400, detail="Cannot promote a candidate with no measured score.")
    if candidate.status == "invalid":
        raise HTTPException(status_code=400, detail="Cannot promote a candidate that failed validation.")

    previous = candidate.status
    candidate.status = "kept"
    audit = dict(candidate.audit_json or {})
    audit.update({"decision": "promoted", "reviewed_by": user.email, "reviewed_at": now().isoformat()})
    candidate.audit_json = audit

    # The campaign's "best" pointer follows the human decision, not the raw sort.
    campaign.best_candidate_id = candidate.id
    campaign.best_score = candidate.score

    db.add(
        Approval(
            project_id=campaign.project_id,
            action_type="candidate_promotion",
            target_type="candidate",
            target_id=candidate.id,
            approved_by=user.id,
            notes=payload.notes,
        )
    )
    db.add(
        StatusHistory(
            entity_type="candidate",
            entity_id=candidate.id,
            from_status=previous,
            to_status="kept",
            note="Promoted by user.",
        )
    )
    db.commit()
    db.refresh(candidate)
    return candidate_out(candidate)


@app.post("/api/candidates/{candidate_id}/reject", response_model=CandidateOut)
def reject_candidate(
    candidate_id: int,
    payload: CandidateRejectIn,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Human gate: discard a candidate, keeping it in the archive with a reason."""
    candidate = owned_candidate(db, candidate_id, user)
    campaign = db.get(Campaign, candidate.campaign_id)

    previous = candidate.status
    candidate.status = "discarded"
    audit = dict(candidate.audit_json or {})
    audit.update({"decision": "rejected", "reviewed_by": user.email, "reviewed_at": now().isoformat()})
    candidate.audit_json = audit
    # Record the reviewer's reason without overwriting the agent's own
    # interpretation. The whole point of keeping discarded candidates is to
    # preserve why they failed; clobbering that note would destroy the evidence
    # a later proposal needs (and would peg useful_regression_rate at 1.0).
    notes = dict(candidate.notes_json or {})
    notes["rejection_reason"] = payload.reason
    candidate.notes_json = notes

    # A rejected candidate must not remain the campaign's advertised best.
    if campaign.best_candidate_id == candidate.id:
        campaign.best_candidate_id = None
        campaign.best_score = None

    db.add(
        Approval(
            project_id=campaign.project_id,
            action_type="candidate_rejection",
            target_type="candidate",
            target_id=candidate.id,
            approved_by=user.id,
            notes=payload.reason,
        )
    )
    db.add(
        StatusHistory(
            entity_type="candidate",
            entity_id=candidate.id,
            from_status=previous,
            to_status="discarded",
            note="Rejected by user.",
        )
    )
    db.commit()
    db.refresh(candidate)
    return candidate_out(candidate)


@app.get("/api/candidates/{candidate_id}/audit", response_model=AuditReportOut)
def candidate_audit(candidate_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """The auditor's verdict on one candidate, as individually inspectable checks.

    The checks are reported separately rather than as one pass/fail so a reviewer
    can see *which* guarantee is missing — an unverified evaluator hash and a
    budget overrun call for very different responses.
    """
    candidate = owned_candidate(db, candidate_id, user)
    campaign = db.get(Campaign, candidate.campaign_id)
    audit_raw = candidate.audit_json or {}

    eval_hash_match = bool(audit_raw.get("eval_hash_match", True))
    leakage_scan = str(audit_raw.get("leakage_scan", "skipped"))
    budget_compliant = bool(audit_raw.get("budget_compliant", True))

    checks = [
        AuditCheckOut(
            name="evaluator_hash",
            ok=eval_hash_match,
            detail="Evaluator files match the campaign baseline."
            if eval_hash_match
            else "Evaluator hash differs from the campaign baseline; the score is not comparable.",
        ),
        AuditCheckOut(
            name="leakage_scan",
            ok=leakage_scan == "clean",
            detail={
                "clean": "No held-out answers or task identifiers found.",
                "flagged": "Potential leakage found; review before promoting.",
            }.get(leakage_scan, "Leakage scan has not been run for this candidate."),
        ),
        AuditCheckOut(
            name="budget_compliance",
            ok=budget_compliant,
            detail="Candidate stayed within the declared campaign budget."
            if budget_compliant
            else "Candidate exceeded its declared budget; the result is not comparable.",
        ),
        AuditCheckOut(
            name="metric_present",
            ok=candidate.score is not None,
            detail="Candidate recorded a score." if candidate.score is not None else "No score recorded for this candidate.",
        ),
        AuditCheckOut(
            name="run_linked",
            ok=candidate.run_id is not None,
            detail="Candidate is linked to the run that produced it."
            if candidate.run_id is not None
            else "No run is linked; this candidate has no reproducible measurement.",
        ),
    ]
    if campaign is not None and campaign.status == "failed":
        checks.append(
            AuditCheckOut(name="campaign_health", ok=False, detail="Parent campaign ended in a failed state.")
        )

    return AuditReportOut(
        candidate_id=candidate.id,
        audit=CandidateAuditOut(
            eval_hash_match=eval_hash_match,
            leakage_scan=leakage_scan,
            budget_compliant=budget_compliant,
            reviewed_by=audit_raw.get("reviewed_by"),
            reviewed_at=audit_raw.get("reviewed_at"),
            decision=str(audit_raw.get("decision", "pending")),
        ),
        checks=checks,
        generated_at=now(),
    )


@app.websocket("/api/campaigns/{campaign_id}/trace/ws")
async def campaign_trace_ws(websocket: WebSocket, campaign_id: int):
    """Live search-loop progress: propose, evaluate, select, repeat.

    Same authentication and origin rules as the run-log socket — a WebSocket
    bypasses CORS, so the handshake is checked explicitly before any campaign
    data is sent.
    """
    db = next(get_db())
    try:
        if _origin_guard_required():
            origin = websocket.headers.get("origin", "")
            if origin and not _origin_allowed(origin, websocket.headers.get("host", "")):
                await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
                return
        user = user_from_token(db, websocket.cookies.get(SESSION_COOKIE))
        if not user:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        campaign = owned_campaign(db, campaign_id, user)
        await campaign_manager.connect(campaign_id, websocket)
        # Replay the archive so a reconnecting browser recovers the search so far.
        for candidate in campaign.candidates:
            await websocket.send_json(
                {
                    "type": "search",
                    "phase": "evaluate",
                    "campaign_id": campaign.id,
                    "candidate_id": candidate.id,
                    "iteration": candidate.iteration,
                    "edit_family": candidate.edit_family,
                    "score": candidate.score,
                    "status": candidate.status,
                    "ts": candidate.created_at.isoformat(),
                }
            )
        await websocket.send_json(
            {"type": "status", "campaign_id": campaign.id, "status": campaign.status, "iteration": campaign.iteration}
        )
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        campaign_manager.disconnect(campaign_id, websocket)
    finally:
        db.close()


# ===========================================================================
# Account usage + capabilities — the frontend reads these to render the spend
# meter and to enable/disable run options it must not guess at.
# ===========================================================================
@app.get("/api/me/usage")
def my_usage(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """This user's current-month LLM/GPU spend against their monthly cap."""
    spent = cost.monthly_spend(db, user.id)
    return {
        "monthly_spend_usd": round(spent, 4),
        "monthly_cap_usd": round(cost.USER_MONTHLY_CAP_USD, 2),
        "remaining_usd": round(cost.remaining_budget(db, user.id), 4),
        "over_budget": cost.over_budget(db, user.id),
    }


@app.get("/api/capabilities")
def capabilities(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """What this deployment + this user can do — so the UI never offers a run
    option that would 400. Reflects the operator execution flag and which
    provider keys the user has enabled."""
    enabled = {
        row.provider
        for row in db.query(ProviderKey).filter(ProviderKey.user_id == user.id, ProviderKey.is_enabled.is_(True)).all()
    }
    exec_allowed = runpod_adapter.allow_execution()
    return {
        "modes": ["real"],
        "orchestration_modes": ["pipeline", "agentic"],
        "real_run_ready": bool(enabled & {"anthropic", "openai"}),
        "execution_allowed": exec_allowed,          # operator flag on this box
        "execute_ready": exec_allowed and "runpod" in enabled,
        "figures_ready": bool(enabled & {"gemini", "openai"}),
        "enabled_providers": sorted(enabled),
        "gpu_types": ["rtx 4090", "rtx a6000", "l40s", "a100", "h100"],
        "models": {
            "anthropic": ["claude-opus-4-8", "claude-fable-5", "claude-haiku-4-5-20251001"],
            "openai": ["gpt-4o", "gpt-4o-mini", "gpt-4.1"],
        },
    }


# /api/status is public and polled by every landing page ~5s; cache the DB
# aggregates briefly so anonymous polling can't multiply into DB load.
_STATUS_TTL_S = 5.0
_status_cache: Dict[str, Any] = {"at": 0.0, "data": None}


@app.get("/api/status")
def system_status(response: Response, db: Session = Depends(get_db)):
    """Aggregate system telemetry for the landing console (`GET /api/status`).

    Matches the frontend's ``SystemStatus`` shape (see lib/api.ts), using real
    database aggregates. Deliberately
    unauthenticated but only exposes fleet-wide counts — no per-user data.
    """
    import time as _time

    from datetime import timedelta

    from sqlalchemy import func

    from agents import REVIEWERS

    response.headers["Cache-Control"] = f"public, max-age={int(_STATUS_TTL_S)}"
    if _status_cache["data"] is not None and _time.monotonic() - _status_cache["at"] < _STATUS_TTL_S:
        return _status_cache["data"]

    nowt = now()
    runs_active = db.query(func.count(Run.id)).filter(Run.status == "running").scalar() or 0
    runs_queued = db.query(func.count(Run.id)).filter(Run.status == "queued").scalar() or 0
    steps_per_min = (
        db.query(func.count(RunLog.id)).filter(RunLog.created_at >= nowt - timedelta(minutes=1)).scalar() or 0
    )
    spend_per_hr = (
        db.query(func.coalesce(func.sum(Run.actual_cost), 0.0))
        .filter(Run.ended_at.isnot(None), Run.ended_at >= nowt - timedelta(hours=1))
        .scalar()
        or 0.0
    )
    # Gate latency: average queued->running delay over the most recent runs.
    recent = (
        db.query(Run.created_at, Run.started_at)
        .filter(Run.started_at.isnot(None))
        .order_by(Run.created_at.desc())
        .limit(20)
        .all()
    )
    waits_ms = [(started - created).total_seconds() * 1000 for created, started in recent if started >= created]
    gate_latency_ms = int(sum(waits_ms) / len(waits_ms)) if waits_ms else 0
    data = {
        "ok": True,
        "region": os.environ.get("AGENTLAB_REGION", "local"),
        "build": app.version,
        "ts": nowt.isoformat(),
        "runs_active": int(runs_active),
        "runs_queued": int(runs_queued),
        "reviewers_online": len(REVIEWERS),
        "gate_latency_ms": gate_latency_ms,
        "steps_per_min": int(steps_per_min),
        "spend_per_hr": round(float(spend_per_hr), 2),
    }
    _status_cache["data"] = data
    _status_cache["at"] = _time.monotonic()
    return data


@app.get("/health/live")
def health_live():
    """Process liveness only; does not claim dependencies are usable."""
    return {"ok": True}


@app.get("/health/ready")
@app.get("/health")
def health_ready():
    """Readiness for traffic: database round-trip plus artifact-store write."""
    try:
        with SessionLocal() as db:
            db.execute(text("SELECT 1"))
        ARTIFACT_ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(prefix=".ready-", dir=ARTIFACT_ROOT, delete=True):
            pass
    except Exception:
        logging.getLogger("agentlab.health").exception("Readiness dependency check failed")
        return JSONResponse({"ok": False, "detail": "A required backend dependency is unavailable."}, status_code=503)
    return {"ok": True}


@app.get("/")
def api_root():
    """Explicit API root; the production web console is deployed separately."""
    return {"service": "AgentLab API", "version": app.version, "docs": "/docs"}
