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
    with op.batch_alter_table('quotes', schema=None) as batch_op:
        batch_op.add_column(sa.Column('qb_tax_total', sa.Float(), nullable=True))
        batch_op.add_column(sa.Column('qb_tax_signature', sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('quotes', schema=None) as batch_op:
        batch_op.drop_column('qb_tax_signature')
        batch_op.drop_column('qb_tax_total')
