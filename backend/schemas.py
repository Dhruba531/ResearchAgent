from __future__ import annotations

"""Pydantic request/response contracts for the public `/api` surface."""

import re
import math
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

# Deliberately simple shape check (local-part@domain.tld) — full RFC validation
# needs the optional `email-validator` package; this catches typos and garbage
# without adding a dependency.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class UserOut(BaseModel):
    """Safe user shape returned to the browser; never includes password hashes."""

    id: int
    name: str
    email: str
    role: str


class RegisterIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=255)
    # max_length bounds PBKDF2 work per request (unbounded input is a cheap DoS).
    password: str = Field(min_length=8, max_length=128)

    @field_validator("email")
    @classmethod
    def _valid_email(cls, value: str) -> str:
        value = value.strip().lower()
        if not _EMAIL_RE.match(value):
            raise ValueError("must be a valid email address")
        return value


class LoginIn(BaseModel):
    email: str = Field(max_length=255)
    password: str = Field(max_length=256)


class ProjectCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    objective: str = Field(default="", max_length=20_000)
    idea_text: str = Field(default="", max_length=100_000)


class ProjectUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    objective: Optional[str] = Field(default=None, max_length=20_000)
    idea_text: Optional[str] = Field(default=None, max_length=100_000)


class IdeaIn(BaseModel):
    idea_text: str = Field(max_length=100_000)


class BriefUpdate(BaseModel):
    content_markdown: str = Field(max_length=500_000)
    content_json: Dict[str, Any] = Field(default_factory=dict)


class ApprovalIn(BaseModel):
    notes: str = Field(default="", max_length=10_000)
    # Override the groundedness export gate (dead URLs / unresolved placeholders /
    # self-flagged fabrications). The human is the final authority, but must opt in.
    force: bool = False


class CostEstimateIn(BaseModel):
    budget_threshold: float = Field(default=12.0, ge=0, le=100_000)
    config_json: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("budget_threshold")
    @classmethod
    def _finite_budget(cls, value: float) -> float:
        # ge/le alone do not stop NaN — every comparison against it is False, so a
        # NaN budget passes the bounds and then makes every downstream cost check
        # ("spend > threshold") false as well, i.e. an unbounded run.
        if not math.isfinite(value):
            raise ValueError("must be finite")
        return value


class RunCreate(BaseModel):
    budget_threshold: float = Field(default=12.0, ge=0, le=100_000)
    approved_cost: bool = False
    # Retained as an explicit compatibility guard: any value except "real" is
    # rejected instead of silently starting a paid provider call.
    mode: Literal["real"] = "real"
    config_json: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("budget_threshold")
    @classmethod
    def _finite_budget(cls, value: float) -> float:
        # ge/le alone do not stop NaN — every comparison against it is False, so a
        # NaN budget passes the bounds and then makes every downstream cost check
        # ("spend > threshold") false as well, i.e. an unbounded run.
        if not math.isfinite(value):
            raise ValueError("must be finite")
        return value


class ProviderKeyIn(BaseModel):
    provider: str = Field(min_length=1, max_length=40)
    # Upper bound is generous because service-account keys are long; the lower bound
    # just rejects obvious paste errors before the key is encrypted and stored.
    api_key: str = Field(min_length=8, max_length=4096)
    model_name: str = Field(default="", max_length=120)
    is_enabled: bool = False


# Note the asymmetry with ProviderKeyIn: nothing on the way out carries the key
# itself. The client gets `masked_key`/`key_last4` for display and `is_configured`
# to render state, so a stored secret has no path back through the API.


class ProviderKeyOut(BaseModel):
    id: int
    provider: str
    model_name: str
    is_configured: bool
    is_enabled: bool
    masked_key: str
    key_last4: str
    test_status: str
    created_at: datetime
    updated_at: datetime
    last_tested_at: Optional[datetime]


class ProviderKeyTestOut(BaseModel):
    provider: str
    ok: bool
    status: str
    detail: str
    tested_at: datetime


class LogOut(BaseModel):
    id: int
    run_id: int
    sequence: int
    level: str
    message: str
    created_at: datetime


class ArtifactOut(BaseModel):
    id: int
    run_id: int
    type: str
    name: str
    metadata_json: Dict[str, Any]
    created_at: datetime


class ReviewOut(BaseModel):
    id: int
    project_id: int
    run_id: Optional[int]
    category: str
    severity: str
    finding: str
    suggested_fix: str
    status: str
    created_at: datetime


class BriefOut(BaseModel):
    id: int
    project_id: int
    version: int
    content_json: Dict[str, Any]
    content_markdown: str
    is_approved: bool
    approved_by: Optional[int]
    approved_at: Optional[datetime]
    created_at: datetime
    updated_at: datetime


class RunOut(BaseModel):
    """Run detail payload; logs are included only for endpoints that request them."""

    id: int
    session_id: int
    project_id: int
    brief_id: int
    config_json: Dict[str, Any]
    status: str
    cost_estimate: float
    budget_threshold: float
    actual_cost: float
    analysis_json: Dict[str, Any]
    draft_markdown: str
    started_at: Optional[datetime]
    ended_at: Optional[datetime]
    created_at: datetime
    updated_at: datetime
    logs: List[LogOut] = []
    artifacts: List[ArtifactOut] = []


class PaperRevisionTarget(BaseModel):
    instruction: str = Field(min_length=1, max_length=10_000)
    selected_text: str = Field(min_length=1, max_length=50_000)
    start_offset: int = Field(ge=0, le=500_000)
    end_offset: int = Field(gt=0, le=500_000)
    base_checksum: str = Field(pattern=r"^[0-9a-f]{64}$")


class PaperRevisionPreviewIn(PaperRevisionTarget):
    approved_cost: bool = False


class PaperRevisionEstimateOut(BaseModel):
    cost_estimate: float
    currency: str = "USD"
    provider: str
    model: str
    assumptions: List[str]


class PaperRevisionOut(BaseModel):
    id: int
    run_id: int
    created_by: int
    instruction: str
    selected_text: str
    replacement_text: str
    start_offset: int
    end_offset: int
    base_checksum: str
    result_checksum: str
    provider: str
    model_name: str
    status: str
    cost_estimate: float
    actual_cost: float
    created_at: datetime
    applied_at: Optional[datetime]


class ProjectOut(BaseModel):
    id: int
    owner_id: int
    title: str
    objective: str
    idea_text: str
    status: str
    created_at: datetime
    updated_at: datetime
    latest_brief: Optional[BriefOut] = None
    latest_run: Optional[RunOut] = None
    review_findings: List[ReviewOut] = []


class CostEstimateOut(BaseModel):
    cost_estimate: float
    budget_threshold: float
    currency: str = "USD"
    mode: Literal["real"] = "real"
    model: str
    breakdown: Dict[str, float] = Field(default_factory=dict)
    assumptions: List[str]


class ExportOut(BaseModel):
    approval_id: int
    artifact_id: int
    markdown: str
    provenance: Dict[str, Any]


# ===========================================================================
# Autoresearch campaigns — the search loop over many candidate runs. Budgets
# are declared up front and metered the same way single-run spend is, so a
# campaign cannot widen its own limits once started.
# ===========================================================================
class CampaignBudget(BaseModel):
    max_iters: Optional[int] = Field(default=None, ge=1, le=10_000)
    wall_clock_minutes: Optional[float] = Field(default=None, ge=0, le=100_000)
    model_calls: Optional[int] = Field(default=None, ge=0, le=1_000_000)
    gpu_hours: Optional[float] = Field(default=None, ge=0, le=100_000)
    usd: Optional[float] = Field(default=None, ge=0, le=100_000)

    @field_validator("wall_clock_minutes", "gpu_hours", "usd")
    @classmethod
    def _finite(cls, value: Optional[float]) -> Optional[float]:
        if value is not None and not math.isfinite(value):
            raise ValueError("must be finite")
        return value


class CampaignStopping(BaseModel):
    stagnation_iters: Optional[int] = Field(default=None, ge=1, le=10_000)
    target_score: Optional[float] = None
    max_invalid_rate: Optional[float] = Field(default=None, ge=0, le=1)

    @field_validator("target_score")
    @classmethod
    def _finite_target(cls, value: Optional[float]) -> Optional[float]:
        if value is not None and not math.isfinite(value):
            raise ValueError("must be finite")
        return value


class CampaignCreate(BaseModel):
    name: str = Field(default="", max_length=200)
    budget: CampaignBudget = Field(default_factory=CampaignBudget)
    max_iters: Optional[int] = Field(default=None, ge=1, le=10_000)
    # What the search optimizes, and in which direction. Validation bits-per-byte
    # — the canonical autoresearch metric — is lower-is-better, so this must be
    # declarable at creation or such a campaign would be ranked worst-first.
    metric: str = Field(default="score", max_length=60)
    lower_is_better: bool = False
    # Which key of a candidate's cost_vector forms the frontier's cost axis.
    cost_metric: str = Field(default="usd", max_length=60)
    # Exploration rate: 0 = pure exploitation of the current best, 1 = always
    # branch somewhere new.
    explore: Optional[float] = Field(default=None, ge=0, le=1)
    edit_families: Dict[str, float] = Field(default_factory=dict)
    stopping: Optional[CampaignStopping] = None


class CampaignSpendOut(BaseModel):
    iters: int = 0
    wall_clock_minutes: float = 0.0
    model_calls: int = 0
    gpu_hours: float = 0.0
    usd: float = 0.0


class AgentMetricsOut(BaseModel):
    """How well the *search* is performing, distinct from any one candidate."""

    hit_rate: float = 0.0
    invalid_rate: float = 0.0
    time_to_best_minutes: float = 0.0
    useful_regression_rate: float = 0.0
    stagnation_counter: int = 0


class CampaignOut(BaseModel):
    id: int
    project_id: int
    name: str
    status: str
    iteration: int
    config: Dict[str, Any]
    spend: CampaignSpendOut
    best_score: Optional[float]
    best_candidate_id: Optional[int]
    metrics: Optional[AgentMetricsOut] = None
    failure_counts: Dict[str, int] = Field(default_factory=dict)
    created_at: datetime
    started_at: Optional[datetime]
    ended_at: Optional[datetime]


class CandidateNotes(BaseModel):
    hypothesis: str = ""
    result: str = ""
    interpretation: str = ""
    # Why a human rejected the candidate. Kept separate from ``interpretation``
    # so a reviewer's verdict never overwrites the agent's own analysis.
    rejection_reason: str = ""


class CandidateAuditOut(BaseModel):
    eval_hash_match: bool = True
    leakage_scan: str = "skipped"
    budget_compliant: bool = True
    reviewed_by: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    decision: str = "pending"


class CandidateOut(BaseModel):
    id: int
    campaign_id: int
    run_id: Optional[int]
    parent_id: Optional[int]
    iteration: int
    edit_family: str
    status: str
    score: Optional[float]
    cost_vector: Dict[str, float] = Field(default_factory=dict)
    diff: str = ""
    metrics: Dict[str, Any] = Field(default_factory=dict)
    failure_kind: Optional[str] = None
    notes: Optional[CandidateNotes] = None
    trace_dir: Optional[str] = None
    audit: Optional[CandidateAuditOut] = None
    created_at: datetime
    ended_at: Optional[datetime]


class LeaderboardRowOut(BaseModel):
    candidate_id: int
    run_id: Optional[int]
    parent_id: Optional[int]
    edit_family: str
    status: str
    score: Optional[float]
    cost_usd: Optional[float]
    throughput: Optional[float] = None
    context_tokens: Optional[float] = None
    note: Optional[str] = None


class FrontierPointOut(BaseModel):
    """One point in the quality/cost tradeoff space, flagged if dominated."""

    candidate_id: int
    quality: float
    cost: float
    quality_label: str = "score"
    cost_label: str = "usd"
    dominated: bool = False
    edit_family: Optional[str] = None


class TraceStepOut(BaseModel):
    step: int
    phase: Optional[str] = None
    tool: Optional[str] = None
    prompt: Optional[str] = None
    model_output: Optional[str] = None
    tool_calls: List[Dict[str, Any]] = Field(default_factory=list)
    parser_status: Optional[str] = None
    duration_ms: Optional[float] = None
    tokens: Optional[int] = None
    ts: Optional[str] = None


class TraceFileNodeOut(BaseModel):
    name: str
    path: str
    type: Literal["file", "dir"]
    size_bytes: Optional[int] = None
    children: Optional[List["TraceFileNodeOut"]] = None


class CandidateTraceOut(BaseModel):
    candidate_id: int
    steps: List[TraceStepOut] = Field(default_factory=list)
    tree: List[TraceFileNodeOut] = Field(default_factory=list)
    stdout: str = ""
    stderr: str = ""


class AuditCheckOut(BaseModel):
    name: str
    ok: bool
    detail: str = ""


class AuditReportOut(BaseModel):
    candidate_id: int
    audit: CandidateAuditOut
    checks: List[AuditCheckOut] = Field(default_factory=list)
    generated_at: datetime


class CandidateRejectIn(BaseModel):
    reason: str = Field(min_length=1, max_length=10_000)


# The trace tree is recursive; resolve the forward reference now so the first
# request does not pay for (or fail on) a lazy rebuild.
TraceFileNodeOut.model_rebuild()
