"""services.hourly — per-hour pricing for one role

Revision ID: 9c4e2a7b1d58
Revises: e0f1a2b3c4d5
Create Date: 2026-09-15 12:00:00.000000

Shop and warehouse roles are paid by the hour, not by the day. Until now every
role on the rate card priced a shift through the half/full-day tiers with OT
on top, so a 3-hour shop call billed (and paid) a half day. `services.hourly`
marks ONE role as hourly: every paid hour bills the hourly tier and pays the
hourly cost, with the same overtime rules as everyone else. See
backend/models.py::Service and components/domain-labor.js::LTP_calcDayLabor.

Additive + nullable, default false; every existing row reads as a day-rate
role and prices exactly as before. Idempotent add so a DB already carrying the
column heals to head instead of crash-looping.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '9c4e2a7b1d58'
down_revision: Union[str, None] = 'e0f1a2b3c4d5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("services")}
    if "hourly" not in existing:
        with op.batch_alter_table('services', schema=None) as batch_op:
            batch_op.add_column(sa.Column('hourly', sa.Boolean(), nullable=True,
                                          server_default=sa.false()))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("services")}
    if "hourly" in existing:
        with op.batch_alter_table('services', schema=None) as batch_op:
            batch_op.drop_column('hourly')
