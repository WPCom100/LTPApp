"""user cached profile photo columns

Revision ID: a9b0c1d2e3f4
Revises: f8a9b0c1d2e3
Create Date: 2026-07-27 12:00:00.000000

Caches each user's Google profile photo in the app instead of hotlinking the
volatile lh*.googleusercontent.com URL (which rots / rate-limits, so avatars
stopped rendering). Adds to `users`:
  - photo_token            opaque public id used in the serve URL
  - photo_data             the cached image bytes (deferred-loaded in the ORM)
  - photo_content_type     e.g. "image/jpeg"
  - photo_updated_at       when we last cached; also the `?v=` cache-buster
  - photo_refresh_requested admin "re-pull on next sign-in" flag

Additive + reversible. Idempotent so a DB that already carries the columns heals
to head instead of crash-looping on "duplicate column".
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a9b0c1d2e3f4'
down_revision: Union[str, None] = 'f8a9b0c1d2e3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_NEW_COLUMNS = {
    "photo_token": sa.Column("photo_token", sa.String(length=64), nullable=True),
    "photo_data": sa.Column("photo_data", sa.LargeBinary(), nullable=True),
    "photo_content_type": sa.Column("photo_content_type", sa.String(length=64), nullable=True),
    "photo_updated_at": sa.Column("photo_updated_at", sa.DateTime(timezone=True), nullable=True),
    "photo_refresh_requested": sa.Column(
        "photo_refresh_requested", sa.Boolean(), nullable=False, server_default=sa.false()
    ),
}


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing_cols = {c["name"] for c in insp.get_columns("users")}
    existing_idx = {i["name"] for i in insp.get_indexes("users")}

    with op.batch_alter_table("users", schema=None) as batch_op:
        for name, col in _NEW_COLUMNS.items():
            if name not in existing_cols:
                batch_op.add_column(col)
    # Unique index added separately: SQLite can't ADD COLUMN with a UNIQUE
    # constraint inline, and a unique index over an all-NULL column is fine
    # (NULLs don't collide).
    if "ix_users_photo_token" not in existing_idx:
        op.create_index("ix_users_photo_token", "users", ["photo_token"], unique=True)


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing_cols = {c["name"] for c in insp.get_columns("users")}
    existing_idx = {i["name"] for i in insp.get_indexes("users")}

    if "ix_users_photo_token" in existing_idx:
        op.drop_index("ix_users_photo_token", table_name="users")
    with op.batch_alter_table("users", schema=None) as batch_op:
        for name in reversed(list(_NEW_COLUMNS)):
            if name in existing_cols:
                batch_op.drop_column(name)
