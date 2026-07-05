"""quote QuickBooks-computed sales tax columns

Revision ID: a1b2c3d4e5f6
Revises: f7a8b9c0d1e2
Create Date: 2026-06-28 12:00:00.000000

Adds qb_tax_total + qb_tax_signature to quotes so a quote can carry
QuickBooks-authoritative sales tax. The tax is obtained by creating a
TEMPORARY QB Estimate, reading its computed tax, and deleting it (the business
doesn't use QB estimates) — see backend/qbo_sync.py::get_quote_estimate_tax.

Both columns are server-authoritative (written by the sync engine, stripped
from client writes by _READONLY_COLS). Additive + reversible.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, None] = 'f7a8b9c0d1e2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Idempotent add. Some databases already carry these columns (the quotes
    # table was seeded by the old Base.metadata.create_all path, which builds
    # from the current models, while alembic_version is still at the previous
    # revision). A plain ADD COLUMN then raises DuplicateColumnError and
    # crash-loops the deploy, so add each column only when it's actually missing
    # — a no-op that just advances the version on a drifted DB, a real add on a
    # fresh one. Checked per-column so a partially-drifted table heals correctly.
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("quotes")}
    if "qb_tax_total" not in existing:
        op.add_column("quotes", sa.Column("qb_tax_total", sa.Float(), nullable=True))
    if "qb_tax_signature" not in existing:
        op.add_column("quotes", sa.Column("qb_tax_signature", sa.Text(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("quotes")}
    if "qb_tax_signature" in existing:
        op.drop_column("quotes", "qb_tax_signature")
    if "qb_tax_total" in existing:
        op.drop_column("quotes", "qb_tax_total")
