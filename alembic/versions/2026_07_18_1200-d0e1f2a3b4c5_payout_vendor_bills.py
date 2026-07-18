"""payout vendor bills — QuickBooks A/P export + per-role expense accounts

Revision ID: d0e1f2a3b4c5
Revises: c9d0e1f2a3b4
Create Date: 2026-07-18 12:00:00.000000

Adds the schema for exporting crew payouts to QuickBooks as Vendor Bills (one
Bill per crew member per pay period):

  - contacts.qb_vendor_id — the accounts-payable mirror of qb_customer_id.
  - services.qb_expense_account_id — per-role expense-account override for the
    bill lines (mirrors qb_income_account_id; user-editable, no _synced sibling).
  - qbo_connection.expense_accounts / ap_accounts / expense_accounts_updated_at —
    admin-refreshed caches of the QB Expense/COGS and Accounts-Payable accounts,
    mirroring income_accounts.
  - payout_bills — one row per (contact, pay period), the idempotency anchor for
    the fan-in export (unique contact+period; deterministic DocNumber).
  - payout_bill_lines — the double-pay ledger; unique (contact, project, date)
    makes it physically impossible to bill a person's project-day twice, even
    across pay periods, regardless of anchor/length reconfiguration.

Additive + reversible. Idempotent, inspect-guarded so a DB already carrying any
of these heals to head instead of crash-looping on a duplicate object.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd0e1f2a3b4c5'
down_revision: Union[str, None] = 'c9d0e1f2a3b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _cols(insp, table):
    names = set(insp.get_table_names())
    return {c["name"] for c in insp.get_columns(table)} if table in names else set()


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    tables = set(insp.get_table_names())

    # contacts.qb_vendor_id (+ index)
    if "qb_vendor_id" not in _cols(insp, "contacts"):
        op.add_column("contacts", sa.Column("qb_vendor_id", sa.String(length=32), nullable=True))
        op.create_index("ix_contacts_qb_vendor_id", "contacts", ["qb_vendor_id"])

    # services.qb_expense_account_id
    if "qb_expense_account_id" not in _cols(insp, "services"):
        op.add_column("services", sa.Column("qb_expense_account_id", sa.String(length=32), nullable=True))

    # qbo_connection expense/AP account caches
    qbo_cols = _cols(insp, "qbo_connection")
    if "expense_accounts" not in qbo_cols:
        op.add_column("qbo_connection", sa.Column("expense_accounts", sa.JSON(), nullable=True))
    if "ap_accounts" not in qbo_cols:
        op.add_column("qbo_connection", sa.Column("ap_accounts", sa.JSON(), nullable=True))
    if "expense_accounts_updated_at" not in qbo_cols:
        op.add_column("qbo_connection", sa.Column("expense_accounts_updated_at", sa.DateTime(timezone=True), nullable=True))

    # payout_bills — indexes created only alongside the (absent) table, so no
    # collision guard is needed on them individually.
    if "payout_bills" not in tables:
        op.create_table(
            "payout_bills",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("contact_id", sa.Integer(), sa.ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True),
            sa.Column("period_start", sa.String(length=10), nullable=False),
            sa.Column("period_end", sa.String(length=10), nullable=False),
            sa.Column("period_index", sa.Integer(), nullable=True),
            sa.Column("doc_number", sa.String(length=21), nullable=True),
            sa.Column("amount", sa.Float(), nullable=True),
            sa.Column("line_signature", sa.Text(), nullable=True),
            sa.Column("qb_bill_id", sa.String(length=32), nullable=True),
            sa.Column("qb_sync_token", sa.String(length=16), nullable=True),
            sa.Column("qb_sync_status", sa.String(length=20), nullable=True),
            sa.Column("qb_synced_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("qb_last_error", sa.Text(), nullable=True),
            sa.Column("activity", sa.JSON(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
            sa.UniqueConstraint("contact_id", "period_start", "period_end", name="uq_payout_bill_contact_period"),
        )
        op.create_index("ix_payout_bills_contact_id", "payout_bills", ["contact_id"])
        op.create_index("ix_payout_bills_qb_bill_id", "payout_bills", ["qb_bill_id"])

    if "payout_bill_lines" not in tables:
        op.create_table(
            "payout_bill_lines",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("payout_bill_id", sa.Integer(), sa.ForeignKey("payout_bills.id", ondelete="CASCADE"), nullable=False),
            sa.Column("contact_id", sa.Integer(), nullable=False),
            sa.Column("project_id", sa.Integer(), nullable=True),
            sa.Column("date", sa.String(length=10), nullable=False),
            sa.Column("amount", sa.Float(), nullable=True),
            sa.Column("tier", sa.String(length=20), nullable=True),
            sa.UniqueConstraint("contact_id", "project_id", "date", name="uq_payout_bill_line_day"),
        )
        op.create_index("ix_payout_bill_lines_payout_bill_id", "payout_bill_lines", ["payout_bill_id"])
        op.create_index("ix_payout_bill_lines_contact_id", "payout_bill_lines", ["contact_id"])


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    tables = set(insp.get_table_names())

    if "payout_bill_lines" in tables:
        op.drop_table("payout_bill_lines")
    if "payout_bills" in tables:
        op.drop_table("payout_bills")

    qbo_cols = _cols(insp, "qbo_connection")
    if "expense_accounts_updated_at" in qbo_cols:
        op.drop_column("qbo_connection", "expense_accounts_updated_at")
    if "ap_accounts" in qbo_cols:
        op.drop_column("qbo_connection", "ap_accounts")
    if "expense_accounts" in qbo_cols:
        op.drop_column("qbo_connection", "expense_accounts")

    if "qb_expense_account_id" in _cols(insp, "services"):
        op.drop_column("services", "qb_expense_account_id")

    if "qb_vendor_id" in _cols(insp, "contacts"):
        op.drop_index("ix_contacts_qb_vendor_id", table_name="contacts")
        op.drop_column("contacts", "qb_vendor_id")
