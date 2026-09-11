"""per-company QuickBooks tax exemption reason (companies.tax_exemption_reason)

Revision ID: b7c8d9e0f1a2
Revises: a6b7c8d9e0f1
Create Date: 2026-09-10 12:00:00.000000

QuickBooks' Automated Sales Tax will not accept a Customer marked Taxable=false
unless a TaxExemptionReasonId comes with it:

    Business Validation Error: Tax Exemption Reason should be specified
    incase customer is marked as not taxable

The app pushed the flag and never the reason, so every tax-exempt client — the
common case here — failed the customer create that precedes the invoice push,
and the invoice stayed a draft with the email unsent.

This column holds the reason for one client, as one of Intuit's fixed ids
("1".."15", see qbo_sync._TAX_EXEMPTION_REASONS). "" means "not set": the push
falls back to the workspace default (Settings → qboTaxExemptionReasonId, itself
defaulting to 9 "Resale"), so every existing exempt company starts pushing again
with no backfill and no data invented per row. Only read while `taxable` is
False.

Additive + reversible. Idempotent add so a DB already carrying the column heals
to head instead of crash-looping on DuplicateColumnError.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7c8d9e0f1a2'
down_revision: Union[str, None] = 'a6b7c8d9e0f1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("companies")}
    if "tax_exemption_reason" not in existing:
        op.add_column("companies", sa.Column("tax_exemption_reason", sa.String(length=8),
                                             nullable=True, server_default=""))


def downgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("companies")}
    if "tax_exemption_reason" in existing:
        op.drop_column("companies", "tax_exemption_reason")
