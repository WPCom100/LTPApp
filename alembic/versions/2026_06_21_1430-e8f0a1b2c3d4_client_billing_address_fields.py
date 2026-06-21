"""structured billing address fields on companies + contacts

Adds city / state / zip to companies and address / city / state / zip to
contacts so the app can hold a STRUCTURED billing address per client. QuickBooks
Automated Sales Tax geocodes the jurisdiction from Line1/City/State/ZIP, so the
prior free-form `address` text alone couldn't drive tax. These feed the QB
customer BillAddr on push (see backend/qbo_sync.py).

All columns are additive + nullable with an empty-string server default, so
this is safe against existing rows.

Revision ID: e8f0a1b2c3d4
Revises: d7e9f1a2b3c4
Create Date: 2026-06-21 14:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e8f0a1b2c3d4'
down_revision: Union[str, None] = 'd7e9f1a2b3c4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('companies', schema=None) as batch_op:
        batch_op.add_column(sa.Column('city', sa.String(length=100), nullable=True, server_default=''))
        batch_op.add_column(sa.Column('state', sa.String(length=50), nullable=True, server_default=''))
        batch_op.add_column(sa.Column('zip', sa.String(length=20), nullable=True, server_default=''))
    with op.batch_alter_table('contacts', schema=None) as batch_op:
        batch_op.add_column(sa.Column('address', sa.Text(), nullable=True, server_default=''))
        batch_op.add_column(sa.Column('city', sa.String(length=100), nullable=True, server_default=''))
        batch_op.add_column(sa.Column('state', sa.String(length=50), nullable=True, server_default=''))
        batch_op.add_column(sa.Column('zip', sa.String(length=20), nullable=True, server_default=''))


def downgrade() -> None:
    with op.batch_alter_table('contacts', schema=None) as batch_op:
        batch_op.drop_column('zip')
        batch_op.drop_column('state')
        batch_op.drop_column('city')
        batch_op.drop_column('address')
    with op.batch_alter_table('companies', schema=None) as batch_op:
        batch_op.drop_column('zip')
        batch_op.drop_column('state')
        batch_op.drop_column('city')
