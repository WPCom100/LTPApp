"""income account mapping for QuickBooks items

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-07-06 12:00:00.000000

Categorize services and products into QuickBooks income accounts:

  - services / products gain `qb_income_account_id` (user-set override; null =
    use the type-level default mapped in Settings) and
    `qb_income_account_synced` (server-authoritative cache of the account the
    backing QB Item was last confirmed to carry — a mismatch triggers a
    re-point on the next push; see backend/qbo_sync.py).
  - qbo_connection gains `income_accounts` + `income_accounts_updated_at`, the
    admin-refreshed cache of the QB company's active Income accounts that
    feeds the account dropdowns (POST /api/qbo/accounts/refresh).

Additive + reversible. Idempotent add so a DB that already carries the columns
heals to the head revision instead of crash-looping on DuplicateColumnError.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd4e5f6a7b8c9'
down_revision: Union[str, None] = 'c3d4e5f6a7b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table in ("services", "products"):
        existing = {c["name"] for c in inspector.get_columns(table)}
        if "qb_income_account_id" not in existing:
            op.add_column(table, sa.Column("qb_income_account_id", sa.String(32), nullable=True))
        if "qb_income_account_synced" not in existing:
            op.add_column(table, sa.Column("qb_income_account_synced", sa.String(32), nullable=True))
    existing = {c["name"] for c in inspector.get_columns("qbo_connection")}
    if "income_accounts" not in existing:
        op.add_column("qbo_connection", sa.Column("income_accounts", sa.JSON(), nullable=True))
    if "income_accounts_updated_at" not in existing:
        op.add_column("qbo_connection", sa.Column("income_accounts_updated_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("qbo_connection")}
    if "income_accounts_updated_at" in existing:
        op.drop_column("qbo_connection", "income_accounts_updated_at")
    if "income_accounts" in existing:
        op.drop_column("qbo_connection", "income_accounts")
    for table in ("products", "services"):
        existing = {c["name"] for c in inspector.get_columns(table)}
        if "qb_income_account_synced" in existing:
            op.drop_column(table, "qb_income_account_synced")
        if "qb_income_account_id" in existing:
            op.drop_column(table, "qb_income_account_id")
