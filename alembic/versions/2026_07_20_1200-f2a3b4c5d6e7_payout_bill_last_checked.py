"""payout bill last-checked timestamp (poller fairness)

Revision ID: f2a3b4c5d6e7
Revises: e1f2a3b4c5d6
Create Date: 2026-07-20 12:00:00.000000

Adds payout_bills.qb_last_checked_at so the bill-payment poller
(backend/qbo_bill_poll.py) can order candidates least-recently-checked first
(NULLs — never checked — win) instead of by id. That guarantees a large
persistent unpaid backlog can't starve a newer bill's payment detection behind
it (previously id-ascending + a hard cap could re-check the same oldest N every
cycle and never reach higher-id bills).

Additive + reversible. Idempotent, inspect-guarded so a DB already carrying the
column heals to head instead of crash-looping.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f2a3b4c5d6e7'
down_revision: Union[str, None] = 'e1f2a3b4c5d6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _cols(insp, table):
    names = set(insp.get_table_names())
    return {c["name"] for c in insp.get_columns(table)} if table in names else set()


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = _cols(insp, "payout_bills")
    if "payout_bills" in set(insp.get_table_names()) and "qb_last_checked_at" not in cols:
        op.add_column("payout_bills", sa.Column("qb_last_checked_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = _cols(insp, "payout_bills")
    if "qb_last_checked_at" in cols:
        op.drop_column("payout_bills", "qb_last_checked_at")
