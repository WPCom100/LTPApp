"""drop contacts.taxable — taxability is company-level only

The earlier QuickBooks migration added a `taxable` flag to both companies and
contacts. Taxability is a company-level concept in this business, so the flag
on contacts was removed: directly-billed contacts (client_type="contact") are
treated as tax-exempt. This forward-only migration drops the unused column so
existing databases (incl. live test deployments) clean themselves up rather
than carrying a dead column. companies.taxable is untouched.

Revision ID: f1a2b3c4d5e6
Revises: e8f0a1b2c3d4
Create Date: 2026-06-21 15:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f1a2b3c4d5e6'
down_revision: Union[str, None] = 'e8f0a1b2c3d4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('contacts', schema=None) as batch_op:
        batch_op.drop_column('taxable')


def downgrade() -> None:
    # Re-add so the chain remains reversible (the d7e9f1a2b3c4 downgrade still
    # expects to drop contacts.taxable).
    with op.batch_alter_table('contacts', schema=None) as batch_op:
        batch_op.add_column(sa.Column('taxable', sa.Boolean(), nullable=True, server_default=sa.false()))
