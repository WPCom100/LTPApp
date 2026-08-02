"""client service rates (per-client rate overrides + day minimums)

Revision ID: b1c2d3e4f5a6
Revises: 5c11b0ac9e77
Create Date: 2026-08-02 12:00:00.000000

Adds the `client_rates` table — one row per (client, service) carrying that
client's negotiated rate/cost overrides and the minimum billable/payable hours
for the day. Consumed by the labor engine (theme.js::LTP_servicesForClient +
LTP_calcDayLabor) and every quote/invoice/schedule surface that prices a
service. See backend/models.py::ClientRate.

Rate/cost columns are nullable on purpose: null means "inherit the base Service
value", which is distinct from 0 (a genuinely free tier).

Additive + reversible. Idempotent create so a DB that already carries the table
heals to head instead of crash-looping on "table already exists".
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b1c2d3e4f5a6'
down_revision: Union[str, None] = '5c11b0ac9e77'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    existing = set(sa.inspect(bind).get_table_names())
    if "client_rates" in existing:
        return
    op.create_table(
        "client_rates",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("client_type", sa.String(length=20), nullable=True),
        sa.Column("company_id", sa.Integer(), nullable=True),
        sa.Column("client_contact_id", sa.Integer(), nullable=True),
        sa.Column("service_id", sa.Integer(), nullable=True),
        sa.Column("label", sa.String(length=100), nullable=True),
        sa.Column("day_rate", sa.Float(), nullable=True),
        sa.Column("half_day", sa.Float(), nullable=True),
        sa.Column("hourly_rate", sa.Float(), nullable=True),
        sa.Column("ot_rate", sa.Float(), nullable=True),
        sa.Column("day_cost", sa.Float(), nullable=True),
        sa.Column("half_day_cost", sa.Float(), nullable=True),
        sa.Column("hourly_cost", sa.Float(), nullable=True),
        sa.Column("ot_cost", sa.Float(), nullable=True),
        sa.Column("min_hours", sa.Float(), nullable=True),
        sa.Column("min_cost_hours", sa.Float(), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=True),
        # CASCADE on all three parents: an override has no meaning without its
        # client or its service (same rationale as allocations).
        sa.ForeignKeyConstraint(["company_id"], ["companies.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["client_contact_id"], ["contacts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["service_id"], ["services.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("client_rates", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_client_rates_id"), ["id"], unique=False)
        batch_op.create_index(batch_op.f("ix_client_rates_company_id"), ["company_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_client_rates_client_contact_id"), ["client_contact_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_client_rates_service_id"), ["service_id"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    existing = set(sa.inspect(bind).get_table_names())
    if "client_rates" not in existing:
        return
    with op.batch_alter_table("client_rates", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_client_rates_service_id"))
        batch_op.drop_index(batch_op.f("ix_client_rates_client_contact_id"))
        batch_op.drop_index(batch_op.f("ix_client_rates_company_id"))
        batch_op.drop_index(batch_op.f("ix_client_rates_id"))
    op.drop_table("client_rates")
