"""Idempotently remove the publicly-known legacy demonstration account.

Revision ID: 0004_remove_legacy_demo_account
Revises: 0003_real_provider_only
Create Date: 2026-07-12
"""

import os
from pathlib import Path

from alembic import op
import sqlalchemy as sa


revision = "0004_remove_legacy_demo_account"
down_revision = "0003_real_provider_only"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Clean databases that may already have recorded revision 0003.

    Migration files are immutable once released. This follow-up deliberately
    repeats the cleanup so every upgrade path removes the known-password user,
    including installations that applied an earlier variant of revision 0003.
    """
    bind = op.get_bind()
    demo = {"email": "demo@agentlab.local"}
    projects = "SELECT p.id FROM projects p JOIN users u ON u.id = p.owner_id WHERE u.email = :email"
    runs = f"SELECT id FROM runs WHERE project_id IN ({projects})"
    revisions = f"SELECT id FROM paper_revisions WHERE run_id IN ({runs})"
    sessions = f"SELECT id FROM agent_sessions WHERE project_id IN ({projects})"
    artifact_root = Path(
        os.environ.get(
            "AGENTLAB_ARTIFACT_ROOT",
            Path(__file__).resolve().parents[3] / "data" / "artifacts",
        )
    ).resolve()

    paths = bind.execute(sa.text(f"SELECT path FROM artifacts WHERE run_id IN ({runs})"), demo).scalars().all()
    for raw_path in paths:
        try:
            path = Path(raw_path).resolve()
            if artifact_root in path.parents:
                path.unlink(missing_ok=True)
        except OSError:
            pass

    bind.execute(sa.text(f"DELETE FROM status_history WHERE entity_type = 'paper_revision' AND entity_id IN ({revisions})"), demo)
    bind.execute(sa.text(f"DELETE FROM status_history WHERE entity_type = 'run' AND entity_id IN ({runs})"), demo)
    bind.execute(sa.text(f"DELETE FROM status_history WHERE entity_type = 'session' AND entity_id IN ({sessions})"), demo)
    bind.execute(sa.text(f"DELETE FROM paper_revisions WHERE run_id IN ({runs}) OR created_by IN (SELECT id FROM users WHERE email = :email)"), demo)
    bind.execute(sa.text(f"DELETE FROM artifacts WHERE run_id IN ({runs})"), demo)
    bind.execute(sa.text(f"DELETE FROM run_logs WHERE run_id IN ({runs})"), demo)
    bind.execute(sa.text(f"DELETE FROM review_findings WHERE project_id IN ({projects})"), demo)
    bind.execute(sa.text(f"DELETE FROM approvals WHERE project_id IN ({projects})"), demo)
    bind.execute(sa.text(f"DELETE FROM runs WHERE project_id IN ({projects})"), demo)
    bind.execute(sa.text(f"DELETE FROM agent_sessions WHERE project_id IN ({projects})"), demo)
    bind.execute(sa.text(f"DELETE FROM briefs WHERE project_id IN ({projects})"), demo)
    bind.execute(sa.text(f"DELETE FROM projects WHERE id IN ({projects})"), demo)
    bind.execute(sa.text("DELETE FROM provider_keys WHERE user_id IN (SELECT id FROM users WHERE email = :email)"), demo)
    bind.execute(sa.text("DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE email = :email)"), demo)
    bind.execute(sa.text("DELETE FROM users WHERE email = :email"), demo)


def downgrade() -> None:
    # A known-password account and generated demo data must never be recreated.
    pass
