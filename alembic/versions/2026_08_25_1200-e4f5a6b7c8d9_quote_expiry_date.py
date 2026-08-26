"""per-quote expiration date (quotes.expiry_date)

Revision ID: e4f5a6b7c8d9
Revises: d3e4f5a6b7c8
Create Date: 2026-08-25 12:00:00.000000

Until now a quote's expiration was a single workspace-wide number of days
(Settings → defaultQuoteValidity, 30) that only ever appeared as prose: the
{{quoteValidity}} email variable, and a hardcoded "valid for 30 days" line in
the PDF and client-view terms. There was no way to give one client longer, and
nothing recorded what a sent quote had actually promised.

This column holds the concrete ISO date a quote's pricing stops being good for.
"" means "not set" — every reader falls back to the old rule (sent date +
default validity), so existing rows keep behaving exactly as they did and no
backfill is needed. The builder stamps a real date on send, so a quote's terms
stop moving with the workspace setting once the client has it.

Additive + reversible. Idempotent add so a DB already carrying the column heals
to head instead of crash-looping on DuplicateColumnError.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e4f5a6b7c8d9'
down_revision: Union[str, None] = 'd3e4f5a6b7c8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("quotes")}
    if "expiry_date" not in existing:
        op.add_column("quotes", sa.Column("expiry_date", sa.String(length=10), nullable=True, server_default=""))


def downgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("quotes")}
    if "expiry_date" in existing:
        op.drop_column("quotes", "expiry_date")
