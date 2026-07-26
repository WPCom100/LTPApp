"""fees catalog table

Revision ID: f8a9b0c1d2e3
Revises: f2a3b4c5d6e7
Create Date: 2026-07-26 12:00:00.000000

Adds the `fees` table — a catalog of miscellaneous billable line items that
aren't equipment, services, or products (Lodging, Meal Expenses, Travel,
Consultation, Project Prep, …). Consumed by quote/invoice line items via
`type: "fee"` + `feeId`. See backend/models.py::Fee.

Additive + reversible. Idempotent create so a DB that already carries the table
heals to head instead of crash-looping on "table already exists".
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f8a9b0c1d2e3'
down_revision: Union[str, None] = 'f2a3b4c5d6e7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    existing = set(sa.inspect(bind).get_table_names())
    if "fees" in existing:
        return
    op.create_table(
        "fees",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("category", sa.String(length=100), nullable=True),
        sa.Column("unit", sa.String(length=50), nullable=True),
        sa.Column("unit_price", sa.Float(), nullable=True),
        sa.Column("cost", sa.Float(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("qb_item_id", sa.String(length=32), nullable=True),
        sa.Column("qb_income_account_id", sa.String(length=32), nullable=True),
        sa.Column("qb_income_account_synced", sa.String(length=32), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("fees", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_fees_id"), ["id"], unique=False)
        batch_op.create_index(batch_op.f("ix_fees_qb_item_id"), ["qb_item_id"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    existing = set(sa.inspect(bind).get_table_names())
    if "fees" not in existing:
        return
    with op.batch_alter_table("fees", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_fees_qb_item_id"))
        batch_op.drop_index(batch_op.f("ix_fees_id"))
    op.drop_table("fees")
