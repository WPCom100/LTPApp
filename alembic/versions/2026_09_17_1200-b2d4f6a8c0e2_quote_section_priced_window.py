"""quote sections remember the rental window their equipment was priced for

Revision ID: b2d4f6a8c0e2
Revises: 9c4e2a7b1d58
Create Date: 2026-09-17 12:00:00.000000

A quote's rental window is read live from its primary project, but equipment
lines are priced once, for the window in force when they were added. Move the
project's dates afterwards and the quote quietly shows the new dates over the
old prices. Each section now carries `pricedStartDate` / `pricedEndDate` — the
window its equipment was priced for — so the builder can tell when the project
has moved away from it and let the editor decide, per section, whether to
re-price for the new dates or keep the old ones as a custom rental period
(components/domain-docs.js::LTP_staleRentalSections, modules/quotes-builder.js).

No column changes: the two keys live inside the existing `quotes.sections`
JSON. Backfill: every section that follows the quote's dates is stamped with
its primary project's current dates (its custom dates when the quote has no
project); a section with its own dates is stamped with those. That assumes
today's prices match today's window — the best anyone can say for a quote
written before the stamp existed, and exactly what the builder assumes on the
quote's next save. The backfill just brings it forward for quotes nobody
happens to reopen before their project moves.

Idempotent (a section already stamped is left alone) and reversible (the
downgrade strips the two keys). Sections with no resolvable window, and rows
whose `sections` isn't a list, are skipped untouched.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b2d4f6a8c0e2'
down_revision: Union[str, None] = '9c4e2a7b1d58'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_QUOTES = sa.table(
    "quotes",
    sa.column("id", sa.Integer),
    sa.column("project_id", sa.Integer),
    sa.column("custom_start_date", sa.String),
    sa.column("custom_end_date", sa.String),
    sa.column("sections", sa.JSON),
)
_PROJECTS = sa.table(
    "projects",
    sa.column("id", sa.Integer),
    sa.column("start_date", sa.String),
    sa.column("end_date", sa.String),
)


def stamp_sections(sections, doc_window):
    """Pure: the sections with `pricedStartDate`/`pricedEndDate` filled in where
    they are missing, plus whether anything changed. `doc_window` is the
    quote's (start, end); a section's own custom dates win over it, mirroring
    window.LTP_sectionRentalWindow. Never overwrites an existing stamp."""
    if not isinstance(sections, list):
        return sections, False
    doc_start, doc_end = (doc_window or ("", ""))
    changed = False
    out = []
    for sec in sections:
        if not isinstance(sec, dict):
            out.append(sec)
            continue
        if sec.get("pricedStartDate") and sec.get("pricedEndDate"):
            out.append(sec)
            continue
        if sec.get("customDates") and sec.get("startDate") and sec.get("endDate"):
            start, end = sec["startDate"], sec["endDate"]
        else:
            start, end = doc_start or "", doc_end or ""
        if not start or not end:
            out.append(sec)
            continue
        stamped = dict(sec)
        stamped["pricedStartDate"] = start
        stamped["pricedEndDate"] = end
        out.append(stamped)
        changed = True
    return out, changed


def strip_sections(sections):
    """Pure: the sections without the two stamp keys, plus whether anything changed."""
    if not isinstance(sections, list):
        return sections, False
    changed = False
    out = []
    for sec in sections:
        if isinstance(sec, dict) and ("pricedStartDate" in sec or "pricedEndDate" in sec):
            sec = {k: v for k, v in sec.items() if k not in ("pricedStartDate", "pricedEndDate")}
            changed = True
        out.append(sec)
    return out, changed


def backfill(bind) -> int:
    """Stamp every quote's sections on `bind`. Returns how many rows changed.
    Split out from upgrade() so a test can run it on a plain connection."""
    windows = {
        row.id: (row.start_date or "", row.end_date or "")
        for row in bind.execute(sa.select(_PROJECTS.c.id, _PROJECTS.c.start_date, _PROJECTS.c.end_date))
    }
    rows = bind.execute(sa.select(
        _QUOTES.c.id, _QUOTES.c.project_id, _QUOTES.c.custom_start_date,
        _QUOTES.c.custom_end_date, _QUOTES.c.sections,
    )).all()
    touched = 0
    for row in rows:
        if row.project_id is not None:
            window = windows.get(row.project_id, ("", ""))
        else:
            window = (row.custom_start_date or "", row.custom_end_date or "")
        new_sections, changed = stamp_sections(row.sections, window)
        if not changed:
            continue
        bind.execute(_QUOTES.update().where(_QUOTES.c.id == row.id).values(sections=new_sections))
        touched += 1
    return touched


def strip(bind) -> int:
    """Remove the stamps from every quote on `bind`. Returns how many rows changed."""
    rows = bind.execute(sa.select(_QUOTES.c.id, _QUOTES.c.sections)).all()
    touched = 0
    for row in rows:
        new_sections, changed = strip_sections(row.sections)
        if not changed:
            continue
        bind.execute(_QUOTES.update().where(_QUOTES.c.id == row.id).values(sections=new_sections))
        touched += 1
    return touched


def upgrade() -> None:
    backfill(op.get_bind())


def downgrade() -> None:
    strip(op.get_bind())
