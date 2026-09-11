"""cross rentals: vendor_rates + cross_rentals tables, equipment.cross_rental_only,
allocation source columns

Revision ID: d9e0f1a2b3c4
Revises: c8d9e0f1a2b3
Create Date: 2026-09-12 12:00:00.000000

Gear rented IN from a vendor to cover what we don't stock or don't have free on
the dates (docs/CROSS_RENTAL_PLAN.md):

  vendor_rates    what one vendor charges us for one catalog item — the price
                  memory. One row per (vendor, item); both FKs CASCADE like
                  client_rates.
  cross_rentals   one order from one vendor with its lines in JSON (fixtures
                  plus parts). A confirmed order's catalog-item lines count as
                  our inventory for their dates. Vendor and project FKs SET
                  NULL so the cost record outlives either.
  equipment.cross_rental_only
                  a label for gear we never stock: the catalog row exists so the
                  item can be quoted and checked for availability, qty stays 0.
  allocations.doc_type / doc_id / line_id
                  where a booking came from. Bookings are now DERIVED from
                  confirmed documents (backend/rental_bookings.py): an accepted
                  quote or an invoice books one allocation per equipment line,
                  keyed by these three so an edit updates the same row. Existing
                  rows backfill to doc_type "manual" (no document owns them).

Additive + reversible. Idempotent creates/adds so a DB already carrying any of
these objects heals to head instead of crash-looping.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd9e0f1a2b3c4'
down_revision: Union[str, None] = 'c8d9e0f1a2b3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "vendor_rates" not in tables:
        op.create_table(
            'vendor_rates',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('vendor_company_id', sa.Integer(), nullable=True),
            sa.Column('equipment_id', sa.Integer(), nullable=True),
            sa.Column('rates', sa.JSON(), nullable=True),
            sa.Column('vendor_item', sa.String(length=255), nullable=True),
            sa.Column('quoted_date', sa.String(length=10), nullable=True),
            sa.Column('preferred', sa.Boolean(), nullable=True),
            sa.Column('active', sa.Boolean(), nullable=True),
            sa.Column('notes', sa.Text(), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
            sa.ForeignKeyConstraint(['vendor_company_id'], ['companies.id'], ondelete='CASCADE'),
            sa.ForeignKeyConstraint(['equipment_id'], ['equipment.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('id'),
        )
        with op.batch_alter_table('vendor_rates', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_vendor_rates_id'), ['id'], unique=False)
            batch_op.create_index(batch_op.f('ix_vendor_rates_vendor_company_id'), ['vendor_company_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_vendor_rates_equipment_id'), ['equipment_id'], unique=False)

    if "cross_rentals" not in tables:
        op.create_table(
            'cross_rentals',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('vendor_company_id', sa.Integer(), nullable=True),
            sa.Column('reference', sa.String(length=100), nullable=True),
            sa.Column('status', sa.String(length=20), nullable=True),
            sa.Column('start_date', sa.String(length=10), nullable=True),
            sa.Column('end_date', sa.String(length=10), nullable=True),
            sa.Column('project_id', sa.Integer(), nullable=True),
            sa.Column('lines', sa.JSON(), nullable=True),
            sa.Column('remember_rates', sa.Boolean(), nullable=True),
            sa.Column('notes', sa.Text(), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
            sa.ForeignKeyConstraint(['vendor_company_id'], ['companies.id'], ondelete='SET NULL'),
            sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='SET NULL'),
            sa.PrimaryKeyConstraint('id'),
        )
        with op.batch_alter_table('cross_rentals', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_cross_rentals_id'), ['id'], unique=False)
            batch_op.create_index(batch_op.f('ix_cross_rentals_vendor_company_id'), ['vendor_company_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_cross_rentals_project_id'), ['project_id'], unique=False)

    eq_cols = {c["name"] for c in inspector.get_columns("equipment")}
    if "cross_rental_only" not in eq_cols:
        with op.batch_alter_table('equipment', schema=None) as batch_op:
            batch_op.add_column(sa.Column('cross_rental_only', sa.Boolean(), nullable=True,
                                          server_default=sa.false()))

    alloc_cols = {c["name"] for c in inspector.get_columns("allocations")}
    with op.batch_alter_table('allocations', schema=None) as batch_op:
        if "doc_type" not in alloc_cols:
            # Every booking that exists today was entered by hand (no document
            # has ever written one), so "manual" is the truthful backfill and
            # keeps the reconcile's hands off them.
            batch_op.add_column(sa.Column('doc_type', sa.String(length=10), nullable=True,
                                          server_default='manual'))
        if "doc_id" not in alloc_cols:
            batch_op.add_column(sa.Column('doc_id', sa.Integer(), nullable=True))
        if "line_id" not in alloc_cols:
            batch_op.add_column(sa.Column('line_id', sa.String(length=64), nullable=True,
                                          server_default=''))
    alloc_idx = {i["name"] for i in inspector.get_indexes("allocations")}
    if "ix_allocations_doc_id" not in alloc_idx:
        with op.batch_alter_table('allocations', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_allocations_doc_id'), ['doc_id'], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    alloc_idx = {i["name"] for i in inspector.get_indexes("allocations")}
    alloc_cols = {c["name"] for c in inspector.get_columns("allocations")}
    with op.batch_alter_table('allocations', schema=None) as batch_op:
        if "ix_allocations_doc_id" in alloc_idx:
            batch_op.drop_index(batch_op.f('ix_allocations_doc_id'))
        for col in ("line_id", "doc_id", "doc_type"):
            if col in alloc_cols:
                batch_op.drop_column(col)

    eq_cols = {c["name"] for c in inspector.get_columns("equipment")}
    if "cross_rental_only" in eq_cols:
        with op.batch_alter_table('equipment', schema=None) as batch_op:
            batch_op.drop_column('cross_rental_only')

    if "cross_rentals" in tables:
        with op.batch_alter_table('cross_rentals', schema=None) as batch_op:
            batch_op.drop_index(batch_op.f('ix_cross_rentals_project_id'))
            batch_op.drop_index(batch_op.f('ix_cross_rentals_vendor_company_id'))
            batch_op.drop_index(batch_op.f('ix_cross_rentals_id'))
        op.drop_table('cross_rentals')

    if "vendor_rates" in tables:
        with op.batch_alter_table('vendor_rates', schema=None) as batch_op:
            batch_op.drop_index(batch_op.f('ix_vendor_rates_equipment_id'))
            batch_op.drop_index(batch_op.f('ix_vendor_rates_vendor_company_id'))
            batch_op.drop_index(batch_op.f('ix_vendor_rates_id'))
        op.drop_table('vendor_rates')
