"""product pricing variants

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-07-06 14:00:00.000000

Adds products.variants — alternative pricing structures for the same product
(e.g. Transportation: Local Delivery flat / Per Mile / Client Goods). Shape:
list[{id, label, unitPrice, cost}]. Empty/null keeps the product on its base
unit_price exactly as before, so existing rows need no backfill.

Additive + reversible. Idempotent add so a DB that already carries the column
heals to the head revision instead of crash-looping on DuplicateColumnError.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e5f6a7b8c9d0'
down_revision: Union[str, None] = 'd4e5f6a7b8c9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("products")}
    if "variants" not in existing:
        op.add_column("products", sa.Column("variants", sa.JSON(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("products")}
    if "variants" in existing:
        op.drop_column("products", "variants")
