"""scrub hardcoded phantom crew-role abbreviations from persisted data

Role abbreviations (A1, L1, ...) used to be seeded from a hardcoded 17-code
default (`crewRoleOptions`) shipped in data/settings.js. The settings-hydrate
merge injected that list as the baseline, and because the whole settings blob
is PUT on any save, those codes were persisted into the Settings row for any
account that had ever saved settings -- and any of them clicked onto a crew
member were written into contacts.crew_roles. None of the shipped codes is
backed by a labor rate-card service.

Roles now derive solely from the rate card (Quotes -> Services), so this
forward-only data migration cleans the persisted junk:

  * settings.data['crewRoleOptions'] -> [] (the field is no longer read).
  * contacts.crew_roles -> drop any code that is one of the shipped defaults
    AND is not the `role` of an existing service. Service-backed roles (even if
    they share a default's name) and deliberate free-text customs a user typed
    themselves (never in the shipped list) are preserved.
  * projects.schedule[].positions[].role -> for a position with NO serviceId
    whose role is a shipped default with no backing service, clear the role to
    "" so every raw-`role` display fallback (Labor Assignments, crew emails)
    reads generic "Crew" instead of the phantom code. Positions that link a
    service (serviceId set) and deliberate customs ("Grip") are left alone; the
    role there is only ever a display fallback, since rates key on serviceId.

The same predicate is used in all three passes: a value is a phantom only when
it is one of the 17 shipped defaults AND no service defines it.

Revision ID: 5c11b0ac9e77
Revises: a9b0c1d2e3f4
Create Date: 2026-07-26 16:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '5c11b0ac9e77'
down_revision: Union[str, None] = 'a9b0c1d2e3f4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# The exact codes data/settings.js shipped as the crewRoleOptions default.
# ONLY these are ever treated as phantoms; a user's own free-text roles (never
# in this list) are left untouched no matter what.
_SHIPPED_DEFAULTS = {
    "L1", "L2", "L3", "LD", "A1", "A2", "A3", "V1", "V2",
    "SH", "SM", "F1", "F2", "RIG", "PM", "TD", "PA",
}


def _tables():
    meta = sa.MetaData()
    settings = sa.Table(
        "settings", meta,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("data", sa.JSON),
    )
    contacts = sa.Table(
        "contacts", meta,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("crew_roles", sa.JSON),
    )
    services = sa.Table(
        "services", meta,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("role", sa.String(20)),
    )
    projects = sa.Table(
        "projects", meta,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("schedule", sa.JSON),
    )
    return settings, contacts, services, projects


def _is_phantom(value, service_roles) -> bool:
    """A role string is a phantom only when it is one of the 17 shipped default
    codes AND no rate-card service defines it. A user's own free-text role is
    never in the shipped set, so it is never a phantom."""
    return isinstance(value, str) and value in _SHIPPED_DEFAULTS and value not in service_roles


def upgrade() -> None:
    conn = op.get_bind()
    settings, contacts, services, projects = _tables()

    # Roles that ARE backed by a live rate-card service -- never scrubbed, even
    # if one happens to share a shipped-default's name (e.g. a real "L1"
    # service).
    service_roles = {
        (row.role or "").strip()
        for row in conn.execute(sa.select(services.c.role))
        if (row.role or "").strip()
    }

    # 1) Empty the (now-unread) crewRoleOptions list on the Settings singleton.
    for row in conn.execute(sa.select(settings.c.id, settings.c.data)):
        data = row.data
        if not isinstance(data, dict):
            continue
        if data.get("crewRoleOptions"):
            new_data = dict(data)
            new_data["crewRoleOptions"] = []
            conn.execute(
                settings.update().where(settings.c.id == row.id).values(data=new_data)
            )

    # 2) Drop phantom default codes (those with no backing service) from every
    #    crew member's role tags. Order and any surviving entries are preserved.
    for row in conn.execute(sa.select(contacts.c.id, contacts.c.crew_roles)):
        roles = row.crew_roles
        if not isinstance(roles, list) or not roles:
            continue
        cleaned = [r for r in roles if not _is_phantom(r, service_roles)]
        if cleaned != roles:
            conn.execute(
                contacts.update().where(contacts.c.id == row.id).values(crew_roles=cleaned)
            )

    # 3) Clear phantom role strings off serviceId-less schedule positions, so the
    #    raw-`role` display fallbacks (Labor Assignments, crew emails) can't echo
    #    a phantom code. A position that links a service keeps its role (that copy
    #    is only ever a fallback label); a deliberate custom ("Grip") is kept.
    for row in conn.execute(sa.select(projects.c.id, projects.c.schedule)):
        schedule = row.schedule
        if not isinstance(schedule, list):
            continue
        changed = False
        for item in schedule:
            if not isinstance(item, dict):
                continue
            for pos in (item.get("positions") or []):
                if not isinstance(pos, dict):
                    continue
                if not pos.get("serviceId") and _is_phantom(pos.get("role"), service_roles):
                    pos["role"] = ""
                    changed = True
        if changed:
            conn.execute(
                projects.update().where(projects.c.id == row.id).values(schedule=schedule)
            )


def downgrade() -> None:
    # Forward-only: the removed values were unbacked phantom defaults with no
    # authoritative source to restore them from, and the emptied crewRoleOptions
    # list is no longer read by the app. No-op (mirrors the forward-only
    # drop-contacts.taxable cleanup migration).
    pass
