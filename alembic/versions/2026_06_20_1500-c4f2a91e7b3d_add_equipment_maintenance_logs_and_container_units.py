"""add equipment.maintenance_logs + containers.units JSON columns

Closes the silent-data-loss gap for two maintenance-tracking paths the
frontend was already wired to but the backend had no column for:

  - Equipment, non-serialized: the maintenance form writes a log to
    `eq.maintenanceLogs` (a list at the parent level). _dict_to_row was
    dropping the field on every PUT because Equipment had no
    `maintenance_logs` column — logs vanished on next page refresh.

  - Container, serialized: the Containers form writes per-unit data
    (including each unit's `maintenanceLogs`) to `c.units[i]`. Container
    had no `units` JSON column, so a serialized container could be
    "created" with units in-memory and lose them all on save.

Both columns are nullable JSON. The model defaults are `list`, which
SQLAlchemy materializes on row construction, so existing rows that
predate this migration read back as `None` and the application code
treats `None` as `[]` (existing patterns in rentals-equipment.js and
rentals-containers.js already coerce with `|| []`).

Revision ID: c4f2a91e7b3d
Revises: ffdf5b454468
Create Date: 2026-06-20 15:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c4f2a91e7b3d'
down_revision: Union[str, None] = 'ffdf5b454468'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('equipment', schema=None) as batch_op:
        batch_op.add_column(sa.Column('maintenance_logs', sa.JSON(), nullable=True))
    with op.batch_alter_table('containers', schema=None) as batch_op:
        batch_op.add_column(sa.Column('units', sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('containers', schema=None) as batch_op:
        batch_op.drop_column('units')
    with op.batch_alter_table('equipment', schema=None) as batch_op:
        batch_op.drop_column('maintenance_logs')
