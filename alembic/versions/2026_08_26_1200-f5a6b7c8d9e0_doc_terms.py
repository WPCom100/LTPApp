"""editable terms & conditions (quotes.terms, invoices.terms)

Revision ID: f5a6b7c8d9e0
Revises: e4f5a6b7c8d9
Create Date: 2026-08-26 12:00:00.000000

The terms block printed at the foot of every quote and invoice was a hardcoded
array in TWO places — backend/pdf_generator.py and modules/client-view.js — so
the business could not change its own terms without a code change, and the two
copies could drift about what a client had actually been told.

These columns hold the document's own terms, one line per bullet, optionally
carrying {{token}} placeholders resolved at render time so a date named in the
text can't freeze while the document moves. "" means "never edited here", and
every reader falls back to the workspace default (Settings → Business Defaults)
and then to the built-in list — which is exactly what the hardcoded arrays said.
So existing rows print precisely what they printed before and no backfill is
needed.

Additive + reversible. Idempotent adds so a DB already carrying either column
heals to head instead of crash-looping on DuplicateColumnError.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f5a6b7c8d9e0'
down_revision: Union[str, None] = 'e4f5a6b7c8d9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLES = ("quotes", "invoices")


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table in _TABLES:
        existing = {c["name"] for c in inspector.get_columns(table)}
        if "terms" not in existing:
            op.add_column(table, sa.Column("terms", sa.Text(), nullable=True, server_default=""))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table in _TABLES:
        existing = {c["name"] for c in inspector.get_columns(table)}
        if "terms" in existing:
            op.drop_column(table, "terms")
