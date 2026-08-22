"""Add the autoresearch campaign archive: campaigns and their candidates.

Revision ID: 0005_campaigns_candidates
Revises: 0004_remove_legacy_demo_account
Create Date: 2026-08-04
"""

from alembic import op
import sqlalchemy as sa


revision = "0005_campaigns_candidates"
down_revision = "0004_remove_legacy_demo_account"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the campaign/candidate tables backing the search console."""
    op.create_table(
        "campaigns",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False, server_default=""),
        sa.Column("status", sa.String(length=40), nullable=False, server_default="queued"),
        sa.Column("iteration", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("config_json", sa.JSON(), nullable=False),
        sa.Column("spend_json", sa.JSON(), nullable=False),
        sa.Column("best_score", sa.Float(), nullable=True),
        sa.Column("best_candidate_id", sa.Integer(), nullable=True),
        sa.Column("metrics_json", sa.JSON(), nullable=False),
        sa.Column("failure_counts_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("ended_at", sa.DateTime(), nullable=True),
        sa.CheckConstraint("iteration >= 0", name="ck_campaign_iteration_nonneg"),
    )
    op.create_index("ix_campaigns_project_id", "campaigns", ["project_id"])
    op.create_index("ix_campaigns_status", "campaigns", ["status"])

    op.create_table(
        "candidates",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("campaign_id", sa.Integer(), sa.ForeignKey("campaigns.id"), nullable=False),
        sa.Column("run_id", sa.Integer(), sa.ForeignKey("runs.id"), nullable=True),
        # Self-referential lineage; the search history is a tree, not a list.
        sa.Column("parent_id", sa.Integer(), sa.ForeignKey("candidates.id"), nullable=True),
        sa.Column("iteration", sa.Integer(), nullable=False),
        sa.Column("edit_family", sa.String(length=40), nullable=False, server_default="tooling"),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="queued"),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("cost_vector_json", sa.JSON(), nullable=False),
        sa.Column("diff", sa.Text(), nullable=False, server_default=""),
        sa.Column("metrics_json", sa.JSON(), nullable=False),
        sa.Column("failure_kind", sa.String(length=40), nullable=True),
        sa.Column("notes_json", sa.JSON(), nullable=False),
        sa.Column("trace_dir", sa.Text(), nullable=False, server_default=""),
        sa.Column("audit_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("ended_at", sa.DateTime(), nullable=True),
        sa.CheckConstraint("iteration >= 0", name="ck_candidate_iteration_nonneg"),
        sa.UniqueConstraint("campaign_id", "iteration", name="uq_candidate_campaign_iteration"),
    )
    op.create_index("ix_candidates_campaign_id", "candidates", ["campaign_id"])
    op.create_index("ix_candidates_run_id", "candidates", ["run_id"])
    op.create_index("ix_candidates_parent_id", "candidates", ["parent_id"])
    op.create_index("ix_candidates_status", "candidates", ["status"])
    op.create_index("ix_candidates_edit_family", "candidates", ["edit_family"])


def downgrade() -> None:
    op.drop_index("ix_candidates_edit_family", table_name="candidates")
    op.drop_index("ix_candidates_status", table_name="candidates")
    op.drop_index("ix_candidates_parent_id", table_name="candidates")
    op.drop_index("ix_candidates_run_id", table_name="candidates")
    op.drop_index("ix_candidates_campaign_id", table_name="candidates")
    op.drop_table("candidates")
    op.drop_index("ix_campaigns_status", table_name="campaigns")
    op.drop_index("ix_campaigns_project_id", table_name="campaigns")
    op.drop_table("campaigns")
