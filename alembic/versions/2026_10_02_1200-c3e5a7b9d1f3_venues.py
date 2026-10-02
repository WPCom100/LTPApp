"""venue memory: venues table + projects.site_instructions

Revision ID: c3e5a7b9d1f3
Revises: b7c1d2e3f4a5
Create Date: 2026-10-02 12:00:00.000000

Saved venues (README.md "Saved venues"): a place we have worked before,
remembered by name with its address and parking / access instructions so the
next project at the same venue starts filled in.

  venues                        one row per venue name (matched case-
                                insensitively). Written only as a side effect
                                of saving a project — see backend/routes/
                                api.py::_remember_venue — and read-only over
                                the API.
  projects.site_instructions    the project's own copy of the parking /
                                access notes, crew-facing like site_address.

Additive + reversible. Idempotent create/add so a DB already carrying either
object heals to head instead of crash-looping.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c3e5a7b9d1f3'
down_revision: Union[str, None] = 'b7c1d2e3f4a5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "venues" not in tables:
        op.create_table(
            'venues',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('name', sa.String(length=255), nullable=False, server_default=''),
            sa.Column('address', sa.Text(), nullable=True),
            sa.Column('instructions', sa.Text(), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
            sa.PrimaryKeyConstraint('id'),
        )
        with op.batch_alter_table('venues', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_venues_id'), ['id'], unique=False)
            batch_op.create_index(batch_op.f('ix_venues_name'), ['name'], unique=False)

    proj_cols = {c["name"] for c in inspector.get_columns("projects")}
    if "site_instructions" not in proj_cols:
        with op.batch_alter_table('projects', schema=None) as batch_op:
            batch_op.add_column(sa.Column('site_instructions', sa.Text(), nullable=True, server_default=''))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    proj_cols = {c["name"] for c in inspector.get_columns("projects")}
    if "site_instructions" in proj_cols:
        with op.batch_alter_table('projects', schema=None) as batch_op:
            batch_op.drop_column('site_instructions')

    if "venues" in tables:
        with op.batch_alter_table('venues', schema=None) as batch_op:
            batch_op.drop_index(batch_op.f('ix_venues_name'))
            batch_op.drop_index(batch_op.f('ix_venues_id'))
        op.drop_table('venues')
