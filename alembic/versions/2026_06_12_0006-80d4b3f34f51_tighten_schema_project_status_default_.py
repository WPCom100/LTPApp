"""tighten schema: project status default, share_token NOT NULL, FK indexes

Revision ID: 80d4b3f34f51
Revises: 792d95ce98e1
Create Date: 2026-06-12 00:06:44.362261

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '80d4b3f34f51'
down_revision: Union[str, None] = '792d95ce98e1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Backfill NULL share_tokens BEFORE enforcing NOT NULL. Empty DBs are
    # expected at this revision, but any leftover row from before share_token
    # shipped would fail the alter_column otherwise. Token shape matches what
    # backend/routes/api.py::create mints (secrets.token_urlsafe(32) ~ 43
    # url-safe chars, well under the String(64) cap).
    import secrets
    conn = op.get_bind()
    for table in ("quotes", "invoices"):
        rows = conn.execute(sa.text(f"SELECT id FROM {table} WHERE share_token IS NULL")).fetchall()
        for r in rows:
            conn.execute(
                sa.text(f"UPDATE {table} SET share_token = :tok WHERE id = :id"),
                {"tok": secrets.token_urlsafe(32), "id": r[0]},
            )

    # batch_alter_table wraps ALTER COLUMN in a table-recreate on SQLite
    # and emits a plain ALTER on Postgres. Required because SQLite can't
    # ALTER COLUMN directly; we keep dev parity with prod by using batch
    # mode here. Indexes go through batch ops too so the SQLite table
    # recreation picks them up in one pass.
    with op.batch_alter_table('allocations') as batch_op:
        batch_op.create_index(batch_op.f('ix_allocations_equipment_id'), ['equipment_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_allocations_project_id'), ['project_id'], unique=False)
    with op.batch_alter_table('invoices') as batch_op:
        batch_op.alter_column('share_token', existing_type=sa.VARCHAR(length=64), nullable=False)
        batch_op.create_index(batch_op.f('ix_invoices_client_contact_id'), ['client_contact_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_invoices_company_id'), ['company_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_invoices_project_id'), ['project_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_invoices_quote_id'), ['quote_id'], unique=False)
    with op.batch_alter_table('projects') as batch_op:
        batch_op.create_index(batch_op.f('ix_projects_company_id'), ['company_id'], unique=False)
    with op.batch_alter_table('quotes') as batch_op:
        batch_op.alter_column('share_token', existing_type=sa.VARCHAR(length=64), nullable=False)
        batch_op.create_index(batch_op.f('ix_quotes_client_contact_id'), ['client_contact_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_quotes_company_id'), ['company_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_quotes_project_id'), ['project_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('quotes') as batch_op:
        batch_op.drop_index(batch_op.f('ix_quotes_project_id'))
        batch_op.drop_index(batch_op.f('ix_quotes_company_id'))
        batch_op.drop_index(batch_op.f('ix_quotes_client_contact_id'))
        batch_op.alter_column('share_token', existing_type=sa.VARCHAR(length=64), nullable=True)
    with op.batch_alter_table('projects') as batch_op:
        batch_op.drop_index(batch_op.f('ix_projects_company_id'))
    with op.batch_alter_table('invoices') as batch_op:
        batch_op.drop_index(batch_op.f('ix_invoices_quote_id'))
        batch_op.drop_index(batch_op.f('ix_invoices_project_id'))
        batch_op.drop_index(batch_op.f('ix_invoices_company_id'))
        batch_op.drop_index(batch_op.f('ix_invoices_client_contact_id'))
        batch_op.alter_column('share_token', existing_type=sa.VARCHAR(length=64), nullable=True)
    with op.batch_alter_table('allocations') as batch_op:
        batch_op.drop_index(batch_op.f('ix_allocations_project_id'))
        batch_op.drop_index(batch_op.f('ix_allocations_equipment_id'))
