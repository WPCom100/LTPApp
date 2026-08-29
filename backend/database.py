import asyncio
import faulthandler
import os
import signal
import sys
import traceback
from pathlib import Path

from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase

from backend.env import looks_like_production

# ── Startup diagnostics ──────────────────────────────────────────────────────
# init_db() runs Alembic migrations during the FastAPI lifespan. If that step
# hangs or dies, the platform can kill the container before any traceback is
# flushed — leaving an opaque crash-loop. faulthandler dumps every thread's
# stack on a fatal signal AND on SIGTERM (what a platform sends to stop us), so
# a hung migration reveals exactly where it's stuck (e.g. an ALTER blocked on a
# lock). init_db() also arms a periodic dump while migrating; see below.
faulthandler.enable()
try:
    faulthandler.register(signal.SIGTERM, chain=True)
except (AttributeError, ValueError, OSError):
    pass  # best-effort: not every platform/thread allows registering

DATABASE_URL = os.environ.get("DATABASE_URL", "")

# Railway gives postgres:// but asyncpg needs postgresql+asyncpg://
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)
elif DATABASE_URL.startswith("postgresql://") and "+asyncpg" not in DATABASE_URL:
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)

# Fallback for local dev without a database.
#
# On a real deployment this fallback is a trap, not a convenience: the app would
# boot happily on a SQLite file inside the container, run `alembic upgrade head`
# against it to create an empty schema, and hand the first Google sign-in an
# admin account (routes/auth.py). Every write would then land on a filesystem
# that Railway discards on the next deploy or restart, and nothing would say so
# — the logs look like a normal healthy boot. Refuse instead, using the same
# two signals main.py already uses to decide Secure cookies, HSTS and whether a
# missing LTP_SESSION_SECRET is fatal.
if not DATABASE_URL:
    if looks_like_production():
        raise RuntimeError(
            "DATABASE_URL is not set. It is required on any real deployment "
            "(LTP_FORCE_HTTPS is on, or LTP_OAUTH_REDIRECT_URI is https). "
            "Refusing to start on an ephemeral container-local SQLite file, "
            "which would silently discard every write on the next restart."
        )
    DATABASE_URL = "sqlite+aiosqlite:///./ltp_dev.db"
    print("[LTP] WARNING: DATABASE_URL not set — using local SQLite "
          f"({DATABASE_URL}). Fine for development; never for a deployment.",
          flush=True)

engine = create_async_engine(DATABASE_URL, echo=False, pool_pre_ping=True)
async_session = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with async_session() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


# Path to alembic.ini relative to repo root (this file lives one level down).
_ALEMBIC_INI = Path(__file__).resolve().parent.parent / "alembic.ini"


def _alembic_config():
    """Build an Alembic Config that points at our alembic.ini. We
    intentionally do NOT set sqlalchemy.url here — env.py reads DATABASE_URL
    itself, which keeps CLI runs (`alembic upgrade head` from a terminal)
    and boot-time upgrades on the same code path."""
    from alembic.config import Config
    return Config(str(_ALEMBIC_INI))


async def _probe_tables() -> set[str]:
    """Return the set of table names currently in the database. Uses the
    app's async engine via run_sync so we don't need a separate sync driver
    (no psycopg2) just to peek at the schema."""
    async with engine.connect() as conn:
        return await conn.run_sync(lambda c: set(inspect(c).get_table_names()))


def _run_alembic_commands(needs_stamp: bool) -> None:
    """Worker-thread body. Stamps once if cutting over from create_all, then
    runs upgrade head. Both calls go through Alembic's sync command layer;
    env.py internally uses asyncio.run() to drive the actual SQL, which
    works because to_thread gave us a fresh event loop slot."""
    from alembic import command
    try:
        cfg = _alembic_config()
        if needs_stamp:
            print("[LTP] alembic: stamping pre-alembic schema as head (one-shot cutover)", flush=True)
            command.stamp(cfg, "head")
        print("[LTP] alembic: upgrade head", flush=True)
        command.upgrade(cfg, "head")
    except BaseException:
        # Print from inside the worker thread too, so the trace survives even if
        # it's lost crossing the to_thread boundary or the process is then killed.
        print("[LTP] alembic command raised — traceback follows:", flush=True)
        traceback.print_exc(file=sys.stdout)
        sys.stdout.flush()
        raise


async def init_db():
    """Apply pending Alembic migrations.

    Replaces the prior Base.metadata.create_all + LTP_RESET_DB combo. Schema
    changes now go through `alembic revision --autogenerate`, are reviewed,
    and ride a normal deploy. There is no longer any in-process knob that
    drops the database — recovery from corruption is via Railway's
    point-in-time restore, not an env var.

    Three boot scenarios are handled:
      (a) Fresh DB (no app tables, no alembic_version) — upgrade head
          creates everything from the migration history.
      (b) Existing DB seeded by the prior create_all path (app tables but
          no alembic_version) — stamp head once to adopt the live schema as
          Alembic's baseline, then upgrade head (no-op the first time).
      (c) Existing DB already under Alembic management — upgrade head
          applies any pending migrations.

    Stamping in case (b) is safe ONLY because the initial migration was
    autogenerated from the same models create_all was producing. If we
    ever ship a schema change before this cutover runs everywhere, that
    assumption breaks; see README "Migrations" for the operational note."""
    tables = await _probe_tables()
    has_alembic = "alembic_version" in tables
    has_app_tables = any(t in tables for t in ("companies", "quotes", "invoices", "users"))
    needs_stamp = has_app_tables and not has_alembic
    # Arm a periodic stack dump: if the migration hangs (e.g. an ALTER blocked on
    # a lock), every thread's stack is dumped after 1s — so a crash-loop leaves a
    # usable trace even when the platform kills the container a moment later.
    # Cancelled on success, so a healthy boot stays silent.
    faulthandler.dump_traceback_later(1, repeat=True)
    try:
        await asyncio.to_thread(_run_alembic_commands, needs_stamp)
    except BaseException:
        print("[LTP] init_db: migrations FAILED — traceback follows:", flush=True)
        traceback.print_exc(file=sys.stdout)
        sys.stdout.flush()
        sys.stderr.flush()
        raise
    finally:
        faulthandler.cancel_dump_traceback_later()
    print(f"[LTP] init_db complete ({engine.dialect.name})", flush=True)
