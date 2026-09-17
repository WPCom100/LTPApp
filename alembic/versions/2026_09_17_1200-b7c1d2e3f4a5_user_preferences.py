"""users.preferences — per-user UI preferences (saved table views)

Revision ID: b7c1d2e3f4a5
Revises: 9c4e2a7b1d58
Create Date: 2026-09-17 12:00:00.000000

Private, per-user UI state: saved table views (column sort + filter/toggle
selections) for the record lists, keyed by table. Free-form JSON owned by the
frontend (components/table-views.js); the server stores it wholesale. See
backend/models.py::User.preferences.

Additive + nullable, no default; every existing row reads as null and every
table falls back to its built-in "Default" ordering exactly as before.
Idempotent add so a DB already carrying the column heals to head instead of
crash-looping.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7c1d2e3f4a5'
down_revision: Union[str, None] = '9c4e2a7b1d58'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("users")}
    if "preferences" not in existing:
        with op.batch_alter_table('users', schema=None) as batch_op:
            batch_op.add_column(sa.Column('preferences', sa.JSON(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("users")}
    if "preferences" in existing:
        with op.batch_alter_table('users', schema=None) as batch_op:
            batch_op.drop_column('preferences')
