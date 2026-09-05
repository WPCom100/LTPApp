"""project fixed_positions (flat-rate engagements)

Revision ID: a6b7c8d9e0f1
Revises: f5a6b7c8d9e0
Create Date: 2026-09-05 12:00:00.000000

A production hires some people for the whole job at a flat fee — a lighting
designer, a stage manager — with no contracted shift times: we hand them the
schedule and they make their own hours. Nothing in the schedule shape could
hold that: a position only bills, pays, or can be requested when it sits on a
dated, timed shift row, and a flat engagement has neither.

`projects.fixed_positions` is the project-level list those positions live in
(see backend/models.py::Project for the item shape). Same position-id namespace
and status lifecycle as schedule positions, so crew requests, integrity healing
and the payout export handle both through the same seams.

Additive + nullable; existing rows read as an empty list. Idempotent add so a
DB already carrying the column heals to head instead of crash-looping.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a6b7c8d9e0f1'
down_revision: Union[str, None] = 'f5a6b7c8d9e0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("projects")}
    if "fixed_positions" not in existing:
        with op.batch_alter_table('projects', schema=None) as batch_op:
            batch_op.add_column(sa.Column('fixed_positions', sa.JSON(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("projects")}
    if "fixed_positions" in existing:
        with op.batch_alter_table('projects', schema=None) as batch_op:
            batch_op.drop_column('fixed_positions')
