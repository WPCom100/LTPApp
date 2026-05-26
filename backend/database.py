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
    next deploy so subsequent restarts don't keep wiping the database."""
    reset = os.environ.get("LTP_RESET_DB", "").lower() in ("1", "true", "yes")
    async with engine.begin() as conn:
        if reset:
            await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
