"""multi-project quotes & invoices (quotes.project_ids, invoices.project_ids)

Revision ID: d3e4f5a6b7c8
Revises: c2d3e4f5a6b7
Create Date: 2026-08-04 12:00:00.000000

A project schedule can now send its labor into any of the client's existing
DRAFT quotes/invoices, whatever project that document started on — so one
document may bill work for several jobs. `project_id` stays the PRIMARY project
(it still names the document on the PDF, in the QuickBooks memo and in push
notifications); these columns hold the full contributing set, primary first.

Backfill: every existing row covers exactly one project, so the list is
[project_id] — or [] when the row has no project (a customName-only document).
Readers still fall back to [project_id] for safety (see
window.LTP_docProjectIds in theme.js and _project_ids() in routes/_shared.py),
so a row this backfill somehow missed behaves exactly as it did before.

Additive + reversible — the downgrade drops the lists, leaving each document
attributed to its primary project only. Idempotent so a DB that already carries
the columns heals to head instead of crash-looping on "duplicate column".
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd3e4f5a6b7c8'
down_revision: Union[str, None] = 'c2d3e4f5a6b7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLES = ("quotes", "invoices")


def _tbl(name: str):
    """Lightweight table clause for the backfill. Going through SQLAlchemy's
    JSON type (rather than string-concatenating SQL) is what makes this work on
    Postgres, where a `text` value has no implicit cast to a json column."""
    return sa.table(
        name,
        sa.column("project_id", sa.Integer),
        sa.column("project_ids", sa.JSON),
    )


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table in _TABLES:
        existing = {c["name"] for c in inspector.get_columns(table)}
        if "project_ids" in existing:
            continue
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.add_column(sa.Column("project_ids", sa.JSON(), nullable=True))

        # Backfill the single project each existing row already has. One UPDATE
        # per distinct project (bounded by the project count, which is small)
        # plus one for the project-less rows — rather than a per-row loop.
        t = _tbl(table)
        bind.execute(t.update().where(t.c.project_id.is_(None)).values(project_ids=[]))
        pids = bind.execute(
            sa.select(t.c.project_id).where(t.c.project_id.isnot(None)).distinct()
        ).scalars().all()
        for pid in pids:
            bind.execute(t.update().where(t.c.project_id == pid).values(project_ids=[pid]))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table in _TABLES:
        existing = {c["name"] for c in inspector.get_columns(table)}
        if "project_ids" not in existing:
            continue
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.drop_column("project_ids")
