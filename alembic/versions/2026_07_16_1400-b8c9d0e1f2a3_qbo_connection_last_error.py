"""qbo_connection last_error columns

Revision ID: b8c9d0e1f2a3
Revises: a7b8c9d0e1f2
Create Date: 2026-07-16 14:00:00.000000

Adds qbo_connection.last_error / last_error_at — a snapshot of the most recent
connection-level QuickBooks error (auth/reconnect/API) captured from a
background context with no entity to stamp, chiefly the auto-receipt poller
(backend/qbo_receipts.py) aborting a cycle. Surfaced via GET /api/qbo/status and
shown in Settings -> Error Log; cleared on the next clean poll cycle or a
successful reconnect. Per-invoice sync failures continue to stamp
`qbo_sync_failed` on the invoice (invoices.qb_last_error) and are unaffected.

Additive + reversible. Idempotent adds so a DB already carrying the columns
heals to head instead of crash-looping on DuplicateColumnError.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b8c9d0e1f2a3'
down_revision: Union[str, None] = 'a7b8c9d0e1f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("qbo_connection")}
    if "last_error" not in existing:
        op.add_column("qbo_connection", sa.Column("last_error", sa.Text(), nullable=True))
    if "last_error_at" not in existing:
        op.add_column("qbo_connection", sa.Column("last_error_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("qbo_connection")}
    if "last_error_at" in existing:
        op.drop_column("qbo_connection", "last_error_at")
    if "last_error" in existing:
        op.drop_column("qbo_connection", "last_error")
