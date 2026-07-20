"""Alembic environment.

Runs in two modes:

  1. CLI — `alembic upgrade head`, `alembic revision --autogenerate`, etc.
     The user invokes alembic directly; this module sets up the engine and
     runs the migrations synchronously from inside an asyncio.run() call.

  2. In-process boot — backend/database.py::init_db() calls
     command.upgrade(cfg, "head") via asyncio.to_thread (so the embedded
     asyncio.run() below gets a fresh event loop in a worker thread,
     instead of trying to nest inside the FastAPI lifespan loop).

Both paths read DATABASE_URL from the environment so the migration target
matches the live app's database. Same translation Railway needs (postgres://
→ postgresql+asyncpg://) is applied here too.
"""

import asyncio
import os
from logging.config import fileConfig

from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

from alembic import context

# Importing models registers every table with Base.metadata, which
# autogenerate diffs against the live DB to produce migration steps.
from backend import models  # noqa: F401 — side-effect import
from backend.database import Base


config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _resolve_database_url() -> str:
    """Mirror backend/database.py::DATABASE_URL resolution so CLI and boot
    upgrades hit the same database. Falls back to the local dev sqlite if
    no DATABASE_URL is set, which is what makes `alembic revision
    --autogenerate` work locally without spinning up Postgres."""
    url = os.environ.get("DATABASE_URL", "")
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+asyncpg://", 1)
    elif url.startswith("postgresql://") and "+asyncpg" not in url:
        url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
    if not url:
        url = "sqlite+aiosqlite:///./ltp_dev.db"
    return url


def run_migrations_offline() -> None:
    """Render SQL to stdout without connecting. Rarely used; `alembic
    upgrade head --sql` produces a script for DBAs who apply manually."""
    context.configure(
        url=_resolve_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        # Detect column-type changes (Integer → BigInteger, etc.) during
        # autogenerate. Off by default in Alembic because false positives
        # are common; we tolerate that in exchange for fewer missed diffs.
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection) -> None:
    # SQLite can't ALTER COLUMN. Render alterations as batch operations
    # (table recreate) when the target is SQLite so local dev with the
    # sqlite fallback can run the same migrations Postgres does. Postgres
    # gets plain ALTERs since batch mode is unnecessary overhead there.
    is_sqlite = connection.dialect.name == "sqlite"
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        render_as_batch=is_sqlite,
        # Commit each migration in its own transaction so a partially-applied
        # multi-migration deploy leaves alembic_version at the LAST fully-applied
        # revision (the next boot resumes from there) instead of rolling the whole
        # batch back. Our migrations are additive + idempotent, so a resume is safe.
        transaction_per_migration=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    section = config.get_section(config.config_ini_section, {}) or {}
    section["sqlalchemy.url"] = _resolve_database_url()
    connectable = async_engine_from_config(
        section,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
