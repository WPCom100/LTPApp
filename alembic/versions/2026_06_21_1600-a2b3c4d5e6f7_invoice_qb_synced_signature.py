"""invoice qb_synced_signature column

Stores an opaque change-signature captured by the frontend at the last
successful QuickBooks push. The invoice builder shows "Update QuickBooks" only
when its live signature differs (i.e. something QB-relevant changed — lines,
dates, discount, customer info, project name). The backend stores it verbatim.

Additive + nullable; safe against existing rows.

Revision ID: a2b3c4d5e6f7
Revises: f1a2b3c4d5e6
Create Date: 2026-06-21 16:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a2b3c4d5e6f7'
down_revision: Union[str, None] = 'f1a2b3c4d5e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('invoices', schema=None) as batch_op:
        batch_op.add_column(sa.Column('qb_synced_signature', sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('invoices', schema=None) as batch_op:
        batch_op.drop_column('qb_synced_signature')
