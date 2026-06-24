"""invoice auto-receipt columns (QuickBooks-driven payment receipts)

Adds the three columns the background receipt poller (backend/qbo_receipts.py)
needs to email a client their payment receipt automatically once the linked
QuickBooks invoice is marked paid:

  qb_balance            (Float)    — last QB Balance the poller saw (0 = paid)
  receipt_email_status  (String)   — null|pending|sent|failed idempotency state
  receipt_email_sent_at (DateTime) — when the receipt went out

All additive + nullable; safe against existing rows.

Backfill — prevent a receipt blast on first deploy
==================================================
Every invoice that is ALREADY paid at deploy time has already been handled by
the existing manual "Send Receipt" flow (which fires when an in-app payment
settles the balance). If we left their receipt_email_status NULL, the poller
would treat them as un-receipted and email every historical client at once.
So we stamp those rows 'sent'. Invoices still outstanding (sent/partial/
overdue) keep NULL, so the poller correctly receipts them WHEN they later get
paid in QuickBooks — which is the whole point of the feature.

Revision ID: e6f7a8b9c0d1
Revises: d5e6f7a8b9c0
Create Date: 2026-06-24 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e6f7a8b9c0d1'
down_revision: Union[str, None] = 'd5e6f7a8b9c0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('invoices', schema=None) as batch_op:
        batch_op.add_column(sa.Column('qb_balance', sa.Float(), nullable=True))
        batch_op.add_column(sa.Column('receipt_email_status', sa.String(length=20), nullable=True))
        batch_op.add_column(sa.Column('receipt_email_sent_at', sa.DateTime(timezone=True), nullable=True))
    # Backfill: treat already-paid invoices as already-receipted so the poller
    # never emails historical clients. Plain SQL works on SQLite + Postgres.
    op.execute("UPDATE invoices SET receipt_email_status = 'sent' WHERE status = 'paid'")


def downgrade() -> None:
    with op.batch_alter_table('invoices', schema=None) as batch_op:
        batch_op.drop_column('receipt_email_sent_at')
        batch_op.drop_column('receipt_email_status')
        batch_op.drop_column('qb_balance')
