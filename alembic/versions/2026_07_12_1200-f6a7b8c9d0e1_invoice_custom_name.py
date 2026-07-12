"""invoice custom name (project-less invoices)

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-07-12 12:00:00.000000

Adds invoices.custom_name — the name a producer types on an invoice that isn't
linked to a project. Mirrors quotes.custom_name (already present since the
initial schema). Without this column the frontend's `customName` was silently
dropped on save (_dict_to_row keeps only real columns), so a project-less
invoice's name vanished on refresh and never reached the invoice list, the
printed PDF (pdf_generator falls back to entity["customName"]), or the public
view.

Additive + reversible. Idempotent add so a DB already carrying the column
(e.g. seeded by the legacy create_all path while alembic_version lagged) heals
to head instead of crash-looping on DuplicateColumnError.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f6a7b8c9d0e1'
down_revision: Union[str, None] = 'e5f6a7b8c9d0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("invoices")}
    if "custom_name" not in existing:
        op.add_column("invoices", sa.Column("custom_name", sa.String(length=255), nullable=True, server_default=""))


def downgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("invoices")}
    if "custom_name" in existing:
        op.drop_column("invoices", "custom_name")
