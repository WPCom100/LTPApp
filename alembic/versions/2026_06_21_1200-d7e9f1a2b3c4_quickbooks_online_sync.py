"""quickbooks online sync: connection table + qb_* tracking columns

Adds everything the QuickBooks Online integration needs:

  - qbo_connection: the single company-wide connection (singleton row id=1).
    Holds the realm id + Fernet-encrypted access/refresh tokens + expiries +
    environment. Never exposed through the CRUD factory.

  - invoices.qb_*: two-way invoice tracking (qb_invoice_id, qb_sync_token,
    qb_sync_status, qb_synced_at, qb_last_error) plus QB-computed totals pulled
    back read-only (qb_tax_total, qb_total_amt).

  - products/services/equipment.qb_item_id: find-or-create cache for QB Items.

  - companies/contacts.qb_customer_id: find-or-create cache for QB Customers,
    plus a `taxable` master switch (default False — most clients are exempt).

Every column is additive + nullable (taxable defaults False), so this is safe
to apply against the live Postgres DB with existing rows. batch_alter_table
keeps the local SQLite dev DB working (it can't ALTER in place).

Revision ID: d7e9f1a2b3c4
Revises: c4f2a91e7b3d
Create Date: 2026-06-21 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd7e9f1a2b3c4'
down_revision: Union[str, None] = 'c4f2a91e7b3d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'qbo_connection',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('realm_id', sa.String(length=64), nullable=False),
        sa.Column('access_token_enc', sa.Text(), nullable=False),
        sa.Column('refresh_token_enc', sa.Text(), nullable=False),
        sa.Column('access_token_expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('refresh_token_expires_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('environment', sa.String(length=10), nullable=False, server_default='sandbox'),
        sa.Column('connected_by_user_id', sa.Integer(), nullable=True),
        sa.Column('connected_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)')),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)')),
        sa.ForeignKeyConstraint(['connected_by_user_id'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )

    with op.batch_alter_table('invoices', schema=None) as batch_op:
        batch_op.add_column(sa.Column('qb_invoice_id', sa.String(length=32), nullable=True))
        batch_op.add_column(sa.Column('qb_sync_token', sa.String(length=16), nullable=True))
        batch_op.add_column(sa.Column('qb_sync_status', sa.String(length=20), nullable=True))
        batch_op.add_column(sa.Column('qb_synced_at', sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column('qb_last_error', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column('qb_tax_total', sa.Float(), nullable=True))
        batch_op.add_column(sa.Column('qb_total_amt', sa.Float(), nullable=True))
        batch_op.create_index(batch_op.f('ix_invoices_qb_invoice_id'), ['qb_invoice_id'], unique=False)

    for table in ('products', 'services', 'equipment'):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.add_column(sa.Column('qb_item_id', sa.String(length=32), nullable=True))
            batch_op.create_index(batch_op.f(f'ix_{table}_qb_item_id'), ['qb_item_id'], unique=False)

    for table in ('companies', 'contacts'):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.add_column(sa.Column('taxable', sa.Boolean(), nullable=True, server_default=sa.false()))
            batch_op.add_column(sa.Column('qb_customer_id', sa.String(length=32), nullable=True))
            batch_op.create_index(batch_op.f(f'ix_{table}_qb_customer_id'), ['qb_customer_id'], unique=False)


def downgrade() -> None:
    for table in ('companies', 'contacts'):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.drop_index(batch_op.f(f'ix_{table}_qb_customer_id'))
            batch_op.drop_column('qb_customer_id')
            batch_op.drop_column('taxable')

    for table in ('products', 'services', 'equipment'):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.drop_index(batch_op.f(f'ix_{table}_qb_item_id'))
            batch_op.drop_column('qb_item_id')

    with op.batch_alter_table('invoices', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_invoices_qb_invoice_id'))
        batch_op.drop_column('qb_total_amt')
        batch_op.drop_column('qb_tax_total')
        batch_op.drop_column('qb_last_error')
        batch_op.drop_column('qb_synced_at')
        batch_op.drop_column('qb_sync_status')
        batch_op.drop_column('qb_sync_token')
        batch_op.drop_column('qb_invoice_id')

    op.drop_table('qbo_connection')
