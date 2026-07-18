"""payout bill payment state (paid tracking + amount reconciliation)

Revision ID: e1f2a3b4c5d6
Revises: d0e1f2a3b4c5
Create Date: 2026-07-18 16:00:00.000000

Adds payment-state columns to payout_bills so the bill-payment poller
(backend/qbo_bill_poll.py) can track when a QuickBooks vendor bill is paid, and
so the push path can reconcile QuickBooks' returned total against ours:

  - qb_total_amt — QuickBooks' returned Bill TotalAmt (cross-checked vs `amount`).
  - qb_balance   — last observed outstanding balance (0 = paid).
  - qb_paid_at   — set once Balance hits 0; non-null = PAID (polling stops; the
                   bill's days are protected from silent re-pricing).

Additive + reversible. Idempotent, inspect-guarded so a DB already carrying the
columns heals to head instead of crash-looping.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e1f2a3b4c5d6'
down_revision: Union[str, None] = 'd0e1f2a3b4c5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _cols(insp, table):
    names = set(insp.get_table_names())
    return {c["name"] for c in insp.get_columns(table)} if table in names else set()


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = _cols(insp, "payout_bills")
    if "qb_total_amt" not in cols:
        op.add_column("payout_bills", sa.Column("qb_total_amt", sa.Float(), nullable=True))
    if "qb_balance" not in cols:
        op.add_column("payout_bills", sa.Column("qb_balance", sa.Float(), nullable=True))
    if "qb_paid_at" not in cols:
        op.add_column("payout_bills", sa.Column("qb_paid_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = _cols(insp, "payout_bills")
    if "qb_paid_at" in cols:
        op.drop_column("payout_bills", "qb_paid_at")
    if "qb_balance" in cols:
        op.drop_column("payout_bills", "qb_balance")
    if "qb_total_amt" in cols:
        op.drop_column("payout_bills", "qb_total_amt")
