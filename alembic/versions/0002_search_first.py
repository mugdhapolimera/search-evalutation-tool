"""Search first: a session needs only a query; ideal order within a grade.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-23
"""

import sqlalchemy as sa

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
    # Searching no longer asks for a name or an information need. Each
    # judgement still stores its rater, and rating requires the need.
    with op.batch_alter_table("session") as batch:
        batch.alter_column("rater", existing_type=sa.String(255), nullable=True)
        batch.alter_column("information_need", existing_type=sa.Text(), nullable=True)
    with op.batch_alter_table("ideal_ranking") as batch:
        batch.add_column(
            sa.Column("ordered", sa.Boolean(), nullable=False, server_default=sa.false())
        )


def downgrade():
    with op.batch_alter_table("ideal_ranking") as batch:
        batch.drop_column("ordered")
    op.execute("UPDATE session SET rater = '' WHERE rater IS NULL")
    op.execute("UPDATE session SET information_need = '' WHERE information_need IS NULL")
    with op.batch_alter_table("session") as batch:
        batch.alter_column("information_need", existing_type=sa.Text(), nullable=False)
        batch.alter_column("rater", existing_type=sa.String(255), nullable=False)
