"""project internal flag (manual / one-off shift marker)

Revision ID: c9d0e1f2a3b4
Revises: b8c9d0e1f2a3
Create Date: 2026-07-16 15:00:00.000000

Adds projects.internal — a boolean marking a project as a lightweight container
for a manual, one-off shift (warehouse labor and other work not tied to a client
job). Internal projects reuse the Project+schedule shape so they flow through the
crew-request and payout pipelines unchanged; the flag only lets client-facing
surfaces hide them while Labor keeps showing them. See backend/models.py Project.

Additive + reversible. Idempotent add (server_default '0' so existing rows
backfill to False) so a DB that already carries the column heals to head instead
of crash-looping on DuplicateColumnError.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c9d0e1f2a3b4'
down_revision: Union[str, None] = 'b8c9d0e1f2a3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("projects")}
    if "internal" not in existing:
        op.add_column("projects", sa.Column("internal", sa.Boolean(), nullable=True, server_default="0"))


def downgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("projects")}
    if "internal" in existing:
        op.drop_column("projects", "internal")
