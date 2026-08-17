from __future__ import annotations

"""SQLAlchemy data model for the governed AgentLab research workflow.

The schema mirrors the production proposal: projects own approved briefs, agent
sessions own runs, runs own logs/artifacts, and approvals/status history provide
the audit trail around human gates.
"""

from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import Boolean, CheckConstraint, DateTime, Float, ForeignKey, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


def now() -> datetime:
    return datetime.utcnow()


# ---------------------------------------------------------------------------
# The schema encodes a *governed* research workflow. The invariants that matter
# (beyond the obvious columns):
#   • A Project owns many Briefs, but only an **approved** Brief can start a Run
#     (human gate 1). Briefs are versioned so edits keep an audit trail.
#   • Every Run carries a cost triple — estimate -> approved budget_threshold ->
#     actual_cost — so spend is gated (gate 2) and metered.
#   • Approval + StatusHistory are the audit spine: who approved which gate, and
#     every state transition. Nothing bypasses brief / budget / final-export gates.
#   • A Campaign is the outer search loop over many Runs. Its Candidates form a
#     lineage tree (parent_id) and are retained even when invalid, because
#     negative results are the evidence that keeps the search from repeating
#     dead ends. Promotion of a candidate stays a human gate.
#   • cascade="all, delete-orphan" means deleting a Project tears down its whole
#     subtree (briefs, sessions, runs, logs, artifacts, reviews, approvals,
#     campaigns, candidates).
# ---------------------------------------------------------------------------


class User(Base):
    """Local authenticated user. Multi-user auth is intentionally simple here."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(40), default="researcher")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)

    projects: Mapped[List["Project"]] = relationship(back_populates="owner")
    sessions: Mapped[List["AuthSession"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class AuthSession(Base):
    """Server-side session row backing the HTTP-only browser cookie."""

    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    token_hash: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime)

    user: Mapped[User] = relationship(back_populates="sessions")


class ProviderKey(Base):
    """Per-user API key metadata for optional future real provider adapters."""

    __tablename__ = "provider_keys"
    __table_args__ = (UniqueConstraint("user_id", "provider", name="uq_provider_key_user_provider"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    provider: Mapped[str] = mapped_column(String(40), index=True)
    # Ciphertext, not the raw key (see crypto.py). Text rather than a bounded String
    # because Fernet output is longer than the key it wraps and grows with it.
    api_key: Mapped[str] = mapped_column(Text)
    model_name: Mapped[str] = mapped_column(String(120), default="")
    # Stored separately so the UI can show "…a1b2" without ever decrypting the key.
    key_last4: Mapped[str] = mapped_column(String(8), default="")
    # Defaults to off: saving a key must never be enough to start spending on it.
    # Enabling is a second, explicit action (and what real_runner checks).
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)
    last_tested_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    test_status: Mapped[str] = mapped_column(String(40), default="not_tested")


class Project(Base):
    """Top-level research workspace and dashboard anchor."""

    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    objective: Mapped[str] = mapped_column(Text, default="")
    idea_text: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(40), default="draft")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)

    owner: Mapped[User] = relationship(back_populates="projects")
    briefs: Mapped[List["Brief"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    sessions: Mapped[List["AgentSession"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    campaigns: Mapped[List["Campaign"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    reviews: Mapped[List["ReviewFinding"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    approvals: Mapped[List["Approval"]] = relationship(back_populates="project", cascade="all, delete-orphan")


class Brief(Base):
    """Versioned structured research brief; exactly one version is approved."""

    __tablename__ = "briefs"
    # Version numbers are the audit trail — two rows claiming the same version
    # of one project's brief would corrupt it.
    __table_args__ = (UniqueConstraint("project_id", "version", name="uq_brief_project_version"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)  # bumped on each regenerate/edit; history kept
    content_json: Mapped[Dict[str, Any]] = mapped_column(JSON, default=dict)
    content_markdown: Mapped[str] = mapped_column(Text, default="")
    is_approved: Mapped[bool] = mapped_column(Boolean, default=False)  # gate 1: only approved briefs can run
    approved_by: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    approved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)

    project: Mapped[Project] = relationship(back_populates="briefs")


class AgentSession(Base):
    """Long-running provider-backed agent execution context."""

    __tablename__ = "agent_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    brief_id: Mapped[int] = mapped_column(ForeignKey("briefs.id"))
    status: Mapped[str] = mapped_column(String(40), default="queued")
    provider: Mapped[str] = mapped_column(String(80))
    command_plan: Mapped[Dict[str, Any]] = mapped_column(JSON, default=dict)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    ended_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)

    project: Mapped[Project] = relationship(back_populates="sessions")
    runs: Mapped[List["Run"]] = relationship(back_populates="session", cascade="all, delete-orphan")


class Run(Base):
    """One experiment attempt with cost, status, analysis, and draft output."""

    __tablename__ = "runs"
    # Money columns can never go negative — a negative cost would silently
    # corrupt the monthly-spend cap (gate 2) that sums actual_cost.
    __table_args__ = (
        CheckConstraint("cost_estimate >= 0", name="ck_run_cost_estimate_nonneg"),
        CheckConstraint("budget_threshold >= 0", name="ck_run_budget_threshold_nonneg"),
        CheckConstraint("actual_cost >= 0", name="ck_run_actual_cost_nonneg"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("agent_sessions.id"), index=True)
    # project_id is reachable via session, but is denormalised here on purpose: every
    # ownership guard in app.py scopes a run to its owner, and the spend query in
    # cost.py joins runs to projects directly. Both would otherwise pay for an extra
    # hop on the hottest paths in the API.
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    brief_id: Mapped[int] = mapped_column(ForeignKey("briefs.id"))
    config_json: Mapped[Dict[str, Any]] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(40), default="queued")
    # Cost governance: estimate is shown to the user, budget_threshold is the
    # human-approved ceiling (gate 2), actual_cost is metered from real tokens.
    cost_estimate: Mapped[float] = mapped_column(Float, default=0.0)
    budget_threshold: Mapped[float] = mapped_column(Float, default=0.0)
    actual_cost: Mapped[float] = mapped_column(Float, default=0.0)
    analysis_json: Mapped[Dict[str, Any]] = mapped_column(JSON, default=dict)
    draft_markdown: Mapped[str] = mapped_column(Text, default="")
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    ended_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)

    session: Mapped[AgentSession] = relationship(back_populates="runs")
    logs: Mapped[List["RunLog"]] = relationship(back_populates="run", cascade="all, delete-orphan", order_by="RunLog.sequence")
    artifacts: Mapped[List["Artifact"]] = relationship(back_populates="run", cascade="all, delete-orphan")
    paper_revisions: Mapped[List["PaperRevision"]] = relationship(
        back_populates="run", cascade="all, delete-orphan", order_by="PaperRevision.created_at"
    )


class PaperRevision(Base):
    """Prompt-generated replacement for an exact range of a completed paper.

    Preview and apply are separate human-controlled steps. ``base_checksum`` and
    the stored offsets make apply optimistic: a preview can never overwrite a
    paper that changed after the model generated it.
    """

    __tablename__ = "paper_revisions"
    __table_args__ = (
        CheckConstraint("start_offset >= 0", name="ck_paper_revision_start_nonneg"),
        CheckConstraint("end_offset > start_offset", name="ck_paper_revision_range"),
        CheckConstraint("cost_estimate >= 0", name="ck_paper_revision_estimate_nonneg"),
        CheckConstraint("actual_cost >= 0", name="ck_paper_revision_actual_nonneg"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id"), index=True)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    instruction: Mapped[str] = mapped_column(Text)
    selected_text: Mapped[str] = mapped_column(Text)
    replacement_text: Mapped[str] = mapped_column(Text)
    start_offset: Mapped[int] = mapped_column(Integer)
    end_offset: Mapped[int] = mapped_column(Integer)
    base_checksum: Mapped[str] = mapped_column(String(64))
    result_checksum: Mapped[str] = mapped_column(String(64), default="")
    provider: Mapped[str] = mapped_column(String(40))
    model_name: Mapped[str] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(20), default="preview")
    cost_estimate: Mapped[float] = mapped_column(Float, default=0.0)
    actual_cost: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    applied_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    run: Mapped[Run] = relationship(back_populates="paper_revisions")


class Campaign(Base):
    """An autoresearch search campaign: many candidate runs under one budget.

    A campaign is the *outer* loop around ordinary runs. Where a Run answers
    "what did this one experiment produce", a Campaign answers "what did the
    search over many experiments discover, at what cost, and which candidate
    should be promoted". The same governance rules apply one level up:

      • ``config_json`` records the declared search contract (budget, exploration
        rate, edit-family weights, stopping rules) so a campaign cannot silently
        widen its own limits mid-flight.
      • ``spend_json`` is the running meter against that budget — the campaign
        equivalent of ``Run.actual_cost``.
      • ``best_candidate_id`` is advisory only. Promotion stays a human gate,
        recorded on the candidate itself.
    """

    __tablename__ = "campaigns"
    __table_args__ = (CheckConstraint("iteration >= 0", name="ck_campaign_iteration_nonneg"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    # queued | running | paused | stopped | completed | failed
    status: Mapped[str] = mapped_column(String(40), default="queued", index=True)
    iteration: Mapped[int] = mapped_column(Integer, default=0)
    config_json: Mapped[Dict[str, Any]] = mapped_column(JSON, default=dict)
    spend_json: Mapped[Dict[str, Any]] = mapped_column(JSON, default=dict)
    best_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    best_candidate_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    metrics_json: Mapped[Dict[str, Any]] = mapped_column(JSON, default=dict)
    failure_counts_json: Mapped[Dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    ended_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    project: Mapped[Project] = relationship(back_populates="campaigns")
    candidates: Mapped[List["Candidate"]] = relationship(
        back_populates="campaign", cascade="all, delete-orphan", order_by="Candidate.iteration"
    )


class Candidate(Base):
    """One proposed variant inside a campaign, plus the evidence it produced.

    Candidates are the archive of the search. Every attempt is retained —
    including invalid and discarded ones — because negative evidence is what
    lets a later proposal avoid repeating a dead end. ``parent_id`` records the
    lineage the candidate branched from, so the search history is a tree rather
    than a flat list, and ``run_id`` links back to the Run that actually
    produced the measurement.
    """

    __tablename__ = "candidates"
    __table_args__ = (
        CheckConstraint("iteration >= 0", name="ck_candidate_iteration_nonneg"),
        UniqueConstraint("campaign_id", "iteration", name="uq_candidate_campaign_iteration"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    campaign_id: Mapped[int] = mapped_column(ForeignKey("campaigns.id"), index=True)
    # The measured run. Null while queued, or when the candidate failed
    # validation gates before any run was dispatched.
    run_id: Mapped[Optional[int]] = mapped_column(ForeignKey("runs.id"), nullable=True, index=True)
    # Self-referential lineage: which prior candidate this one branched from.
    parent_id: Mapped[Optional[int]] = mapped_column(ForeignKey("candidates.id"), nullable=True, index=True)
    iteration: Mapped[int] = mapped_column(Integer)
    # architecture | optimizer | data | loss | regularization | schedule | tooling
    edit_family: Mapped[str] = mapped_column(String(40), default="tooling", index=True)
    # kept | discarded | invalid | running | queued
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    # Null until measured. Lower-is-better or higher-is-better is decided by the
    # campaign's metric, not by this column.
    score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    cost_vector_json: Mapped[Dict[str, Any]] = mapped_column(JSON, default=dict)
    diff: Mapped[str] = mapped_column(Text, default="")
    metrics_json: Mapped[Dict[str, Any]] = mapped_column(JSON, default=dict)
    # syntax | import | shape | oom | nan | timeout | leakage | metric_integrity
    failure_kind: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    notes_json: Mapped[Dict[str, Any]] = mapped_column(JSON, default=dict)
    trace_dir: Mapped[str] = mapped_column(Text, default="")
    # Auditor verdict: evaluator-hash match, leakage scan, budget compliance, and
    # the human promote/reject decision. Written by the audit path, not the agent.
    audit_json: Mapped[Dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    ended_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    campaign: Mapped[Campaign] = relationship(back_populates="candidates")


class RunLog(Base):
    """Append-only log line streamed to browsers over WebSockets."""

    __tablename__ = "run_logs"
    # One task owns a run's log stream; duplicate sequence numbers would break
    # ordered WebSocket replay.
    __table_args__ = (UniqueConstraint("run_id", "sequence", name="uq_runlog_run_sequence"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id"), index=True)
    sequence: Mapped[int] = mapped_column(Integer)
    level: Mapped[str] = mapped_column(String(20), default="info")
    message: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)

    run: Mapped[Run] = relationship(back_populates="logs")


class Artifact(Base):
    """Metadata for generated files stored under the local artifact root."""

    __tablename__ = "artifacts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id"), index=True)
    type: Mapped[str] = mapped_column(String(40))
    name: Mapped[str] = mapped_column(String(200))
    path: Mapped[str] = mapped_column(Text)
    checksum: Mapped[str] = mapped_column(String(128), default="")
    metadata_json: Mapped[Dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)

    run: Mapped[Run] = relationship(back_populates="artifacts")


class ReviewFinding(Base):
    """Reviewer-agent critique item grouped by review category."""

    __tablename__ = "review_findings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    run_id: Mapped[Optional[int]] = mapped_column(ForeignKey("runs.id"), nullable=True, index=True)
    category: Mapped[str] = mapped_column(String(40))
    severity: Mapped[str] = mapped_column(String(20))
    finding: Mapped[str] = mapped_column(Text)
    suggested_fix: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(40), default="open")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)

    project: Mapped[Project] = relationship(back_populates="reviews")


class Approval(Base):
    """Human approval record for brief, budget, and final export gates."""

    __tablename__ = "approvals"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    action_type: Mapped[str] = mapped_column(String(60))
    target_type: Mapped[str] = mapped_column(String(60), default="project")
    target_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    approved_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    approved_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    notes: Mapped[str] = mapped_column(Text, default="")

    project: Mapped[Project] = relationship(back_populates="approvals")


class StatusHistory(Base):
    """Audit event for important run/session/project state transitions."""

    __tablename__ = "status_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[int] = mapped_column(Integer, index=True)
    from_status: Mapped[str] = mapped_column(String(40), default="")
    to_status: Mapped[str] = mapped_column(String(40))
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
