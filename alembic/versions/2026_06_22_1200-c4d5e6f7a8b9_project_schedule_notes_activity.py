"""project schedule_notes + schedule_activity columns

The schedule builder persists project.scheduleNotes (free text) and
project.scheduleActivity (the schedule save log), but the Project model had no
columns for them, so the CRUD write layer silently stripped both on every PUT
(200 OK, no error) -- the schedule's notes and activity history "saved" in the
UI but vanished on reload. Add the columns so they round-trip.

Additive + nullable / defaulted; safe against existing rows.

Revision ID: c4d5e6f7a8b9
Revises: b3c4d5e6f7a8
Create Date: 2026-06-22 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c4d5e6f7a8b9'
down_revision: Union[str, None] = 'b3c4d5e6f7a8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.add_column(sa.Column('schedule_notes', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column('schedule_activity', sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.drop_column('schedule_activity')
        batch_op.drop_column('schedule_notes')
