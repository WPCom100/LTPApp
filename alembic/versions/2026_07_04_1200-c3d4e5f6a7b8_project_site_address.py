"""project job-site address for crew-facing surfaces

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-07-04 12:00:00.000000

Adds projects.site_address (typed street address) and
projects.site_use_company_address (derive the address live from the client
company's billing address instead). Sent to crew in shift-request emails and
shown on the public crew page — see backend/routes/crew.py::_resolve_site_address.

Additive + reversible. Idempotent add so a DB that already carries the columns
(e.g. seeded by the legacy create_all path while alembic_version lagged) heals
to the head revision instead of crash-looping on DuplicateColumnError.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c3d4e5f6a7b8'
down_revision: Union[str, None] = 'b2c3d4e5f6a7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("projects")}
    if "site_address" not in existing:
        op.add_column("projects", sa.Column("site_address", sa.Text(), nullable=True, server_default=""))
    if "site_use_company_address" not in existing:
        op.add_column("projects", sa.Column("site_use_company_address", sa.Boolean(), nullable=True, server_default=sa.text("false")))


def downgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("projects")}
    if "site_use_company_address" in existing:
        op.drop_column("projects", "site_use_company_address")
    if "site_address" in existing:
        op.drop_column("projects", "site_address")
