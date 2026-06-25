"""remembered send recipients on quotes + invoices

Adds a nullable JSON column `send_recipients` to `quotes` and `invoices`,
storing the email recipient list the producer last used for that record:

    {"to": ["primary@client.com"], "cc": ["other@client.com", ...]}

null = not customized yet → the send modal derives recipients from the linked
project's contacts (primary → To, the rest → Cc). Additive + nullable, safe
against existing rows.

Revision ID: f7a8b9c0d1e2
Revises: e6f7a8b9c0d1
Create Date: 2026-06-25 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f7a8b9c0d1e2'
down_revision: Union[str, None] = 'e6f7a8b9c0d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('quotes', schema=None) as batch_op:
        batch_op.add_column(sa.Column('send_recipients', sa.JSON(), nullable=True))
    with op.batch_alter_table('invoices', schema=None) as batch_op:
        batch_op.add_column(sa.Column('send_recipients', sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('invoices', schema=None) as batch_op:
        batch_op.drop_column('send_recipients')
    with op.batch_alter_table('quotes', schema=None) as batch_op:
        batch_op.drop_column('send_recipients')
