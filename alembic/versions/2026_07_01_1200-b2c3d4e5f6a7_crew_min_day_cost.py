"""crew negotiated minimum day rate (payout floor)

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-07-01 12:00:00.000000

Adds contacts.min_day_cost — a per-crew negotiated payout floor. When a crew
member fills a role whose day cost is below their minimum, they are paid the
minimum instead; this never changes what the client is billed (the Service rate
card still drives billing). Treated like a normal day rate downstream (half-day,
meal-penalty, and OT scale the same way) — see theme.js::LTP_calcDayLabor.

Additive + reversible. Idempotent add so a DB that already carries the column
(e.g. seeded by the legacy create_all path while alembic_version lagged) heals
to the head revision instead of crash-looping on DuplicateColumnError.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b2c3d4e5f6a7'
down_revision: Union[str, None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("contacts")}
    if "min_day_cost" not in existing:
        op.add_column("contacts", sa.Column("min_day_cost", sa.Float(), nullable=True, server_default="0"))


def downgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("contacts")}
    if "min_day_cost" in existing:
        op.drop_column("contacts", "min_day_cost")
