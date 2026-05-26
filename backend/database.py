import os
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase

DATABASE_URL = os.environ.get("DATABASE_URL", "")

# Railway gives postgres:// but asyncpg needs postgresql+asyncpg://
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)
elif DATABASE_URL.startswith("postgresql://") and "+asyncpg" not in DATABASE_URL:
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)

# Fallback for local dev without a database
if not DATABASE_URL:
    DATABASE_URL = "sqlite+aiosqlite:///./ltp_dev.db"

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


async def init_db():
    """Create tables on startup. Set LTP_RESET_DB=true in the environment to
    drop everything first — one-shot, intended for schema rewrites where the
    existing data is disposable. Unset the var (or set to false) after the
    next deploy so subsequent restarts don't keep wiping the database.

    On Postgres, the reset does DROP SCHEMA public CASCADE so it wipes EVERY
    table including orphans from prior schemas — Base.metadata.drop_all
    alone only knows about tables in the current models, so a stale table
    from an earlier deploy with a different name would survive."""
    from sqlalchemy import text

    raw = os.environ.get("LTP_RESET_DB", "")
    reset = raw.strip().lower() in ("1", "true", "yes")
    # Loud startup log — visible in Railway's deploy logs so you can confirm
    # the reset actually ran. The repr() shows trailing whitespace etc.
    print(f"[LTP] init_db: LTP_RESET_DB={raw!r} -> reset={reset}", flush=True)

    async with engine.begin() as conn:
        dialect = conn.dialect.name
        if reset:
            if dialect == "postgresql":
                # Railway does rolling deploys: the old container is still
                # alive holding pool connections when the new one starts, and
                # those connections block our exclusive lock on the schema.
                # Forcibly terminate every OTHER backend on this database so
                # DROP SCHEMA can acquire its lock. Without this, the reset
                # hangs indefinitely waiting for the old instance.
                print("[LTP] terminating other backends on this database", flush=True)
                killed = await conn.execute(text(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = current_database() AND pid <> pg_backend_pid()"
                ))
                print(f"[LTP] terminated {killed.rowcount} backend(s)", flush=True)
                print("[LTP] DROP SCHEMA public CASCADE (nuclear reset)", flush=True)
                await conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
                await conn.execute(text("CREATE SCHEMA public"))
            else:
                print("[LTP] drop_all (sqlite/other)", flush=True)
                await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
        print(f"[LTP] tables ready ({dialect}): {sorted(Base.metadata.tables.keys())}", flush=True)
