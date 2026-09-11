"""last agreed QuickBooks tax status per company (companies.qb_tax_synced)

Revision ID: c8d9e0f1a2b3
Revises: b7c8d9e0f1a2
Create Date: 2026-09-11 12:00:00.000000

Holds `taxable` + `tax_exemption_reason` as QuickBooks and the company row last
agreed on them ("1|" for taxable, "0|9" for exempt-as-resale).

Without a baseline there is no way to tell a deliberate edit in the app from a
value that is simply stale, so the sync could only pick one side to always win.
Both choices are wrong: always pushing overwrote an exemption certificate the
bookkeeper set up in QuickBooks, and always pulling meant the app's tax-exempt
toggle silently did nothing for any client already on file there.

With it, the rule is: empty (the two have never met) → QuickBooks wins outright;
the app's pair differing from it → someone changed it here on purpose, so push
that; matching it → no local edit, QuickBooks stays in charge.

Server-authoritative — written only by backend/qbo_sync.py and listed in
_READONLY_COLS, so a client write can never fake or clear the baseline.

"" on existing rows is exactly right: every company predates the first
reconciliation, so each one adopts QuickBooks' status once and starts tracking
from there. No backfill.

Additive + reversible. Idempotent add so a DB already carrying the column heals
to head instead of crash-looping on DuplicateColumnError.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c8d9e0f1a2b3'
down_revision: Union[str, None] = 'b7c8d9e0f1a2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("companies")}
    if "qb_tax_synced" not in existing:
        op.add_column("companies", sa.Column("qb_tax_synced", sa.String(length=16),
                                             nullable=True, server_default=""))


def downgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("companies")}
    if "qb_tax_synced" in existing:
        op.drop_column("companies", "qb_tax_synced")
