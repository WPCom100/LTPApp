"""crew request silent (direct book — no email sent)

Revision ID: c2d3e4f5a6b7
Revises: b1c2d3e4f5a6
Create Date: 2026-08-02 14:00:00.000000

Adds `crew_requests.silent` — True for a booking the producer recorded directly
(crew member already agreed by phone/text), which skips the request email and
the tokenized landing page entirely and lands as an accepted request with its
positions confirmed. See backend/models.py::CrewRequest and the send route's
`silent` body flag in backend/routes/crew.py.

Every existing row is a real emailed request, so the backfill default is False.

Additive + reversible. Idempotent so a DB that already carries the column heals
to head instead of crash-looping on "duplicate column".
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c2d3e4f5a6b7'
down_revision: Union[str, None] = 'b1c2d3e4f5a6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("crew_requests")}
    if "silent" in existing:
        return
    with op.batch_alter_table("crew_requests", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("silent", sa.Boolean(), nullable=False, server_default=sa.false())
        )


def downgrade() -> None:
    bind = op.get_bind()
    existing = {c["name"] for c in sa.inspect(bind).get_columns("crew_requests")}
    if "silent" not in existing:
        return
    with op.batch_alter_table("crew_requests", schema=None) as batch_op:
        batch_op.drop_column("silent")
