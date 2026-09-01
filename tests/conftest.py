"""Pytest-wide environment defaults, applied before any test module imports
the app.

DATABASE_URL — one shared file DB for the whole pytest session
===============================================================
Each test module declares its "own" database via os.environ.setdefault(
"DATABASE_URL", ...) in its header. That isolation is real when a module runs
as a standalone script (python tests/test_x.py), but under pytest ALL modules
are imported into one process at collection time (alphabetically), so only the
FIRST module's setdefault ever takes effect — historically
test_commit1_oauth_gmail.py's ":memory:".

An in-memory URL is fatal for the combined run: backend/database.py builds the
app engine once (StaticPool → one shared connection), while alembic/env.py
builds its OWN engine from DATABASE_URL for init_db's `upgrade head`. With
":memory:" those are two DIFFERENT private databases — migrations apply to a
throwaway DB and the app's connection never gets any tables, so every module
that relies on the TestClient lifespan for schema dies with "no such table".

Setting a file-based URL here (conftest is imported before any test module,
so this setdefault wins) puts the app engine and alembic on the same database
and the schema persists across pooled connections. The file is removed at
session start so every pytest run begins from a clean slate; modules already
keep their fixture data disjoint (unique ids/emails per module) because they
were designed to survive within-module accumulation.

LTP_SESSION_SECRET
==================
backend.main refuses to boot in a production-style configuration (an https://
LTP_OAUTH_REDIRECT_URI) unless LTP_SESSION_SECRET is set and strong
(SECURITY_REVIEW.md H6). Several test modules set an https:// redirect URI to
exercise the production cookie/HSTS path but don't set a session secret, so we
provide a strong test default here. Real deployments set this in the
environment.

Uses setdefault throughout so explicitly-exported values still win.

Session-factory guard
=====================
Because collection imports every module into one process, a module that
repoints backend.database.async_session at IMPORT time (rather than inside the
test that needs it) silently redirects the whole app — backend.database.get_db
resolves that same global — for the rest of the run. On a developer checkout
the damage hides: the offending module's private SQLite file already carries a
schema from an earlier run, so the misdirected writes land somewhere valid and
the suite passes. On a cold checkout, which is what CI always has, the file is
created empty on first connect and every module that relies on the shared
schema dies with "no such table: users". pytest_collection_finish below fails
the run outright instead, naming the cause.
"""
import os

import pytest

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
_suite_db = os.path.join(_root, "_test_suite.db")

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///" + _suite_db)

# Fresh database per pytest session (harmless if another URL was exported).
for _suffix in ("", "-wal", "-shm"):
    try:
        os.remove(_suite_db + _suffix)
    except FileNotFoundError:
        pass

os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)


def pytest_collection_finish(session):
    """Fail loudly if importing the test modules repointed the app's DB.

    Checked after collection (when every module has been imported) and before
    any test runs, so the failure names the cause instead of surfacing as a
    wall of "no such table" errors in unrelated modules.
    """
    import sys

    database = sys.modules.get("backend.database")
    if database is None:  # no module touched the app DB — nothing to guard
        return
    from sqlalchemy.engine import make_url

    bind = getattr(database.async_session, "kw", {}).get("bind")
    actual = getattr(bind, "url", None)
    expected = make_url(os.environ["DATABASE_URL"])
    if actual != expected:
        raise pytest.UsageError(
            "a test module repointed backend.database.async_session at import "
            f"time (bind is {actual!r}, expected {expected!r}). Collection "
            "imports every module into one process, so that redirects the whole "
            "app for the rest of the run. Scope the patch to the test that "
            "needs it."
        )
