"""Auth dependencies used by route handlers.

`require_session` validates the `ltp_session` cookie and returns the User row.
`require_admin` chains on top to additionally check the user's role.

These are async FastAPI Depends helpers — wire them with `Depends(require_session)`
on a router or individual endpoint. See backend/routes/api.py for usage.
"""
from datetime import datetime, timezone
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from backend.database import get_db
from backend import models


SESSION_COOKIE_NAME = "ltp_session"


async def require_session(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> models.User:
    """Look up the caller via the `ltp_session` cookie. Returns the User row
    on success; raises 401 on missing/expired/unknown session.

    Note: expired sessions are NOT auto-deleted here (kept simple — a sweeper
    job can do that later). They just stop authenticating, same effect."""
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not signed in",
            headers={"WWW-Authenticate": "Cookie"},
        )

    result = await db.execute(
        select(models.Session, models.User)
        .join(models.User, models.Session.user_id == models.User.id)
        .where(models.Session.id == token)
    )
    row = result.first()
    if not row:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session",
            headers={"WWW-Authenticate": "Cookie"},
        )

    session, user = row
    # SQLite drops tzinfo on DateTime(timezone=True) columns when reading back.
    # Postgres preserves it. Normalize to UTC-aware before comparing so both
    # backends behave identically.
    expires = session.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires <= datetime.now(timezone.utc):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session expired",
            headers={"WWW-Authenticate": "Cookie"},
        )

    return user


async def require_admin(
    user: models.User = Depends(require_session),
) -> models.User:
    """Require the caller to have role='admin'. Chains on require_session so
    you get 401 (not signed in) vs 403 (signed in, not admin) for free."""
    if user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role required",
        )
    return user


async def get_optional_user(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> models.User | None:
    """Non-raising session probe. Returns the User row if the request carries
    a valid `ltp_session` cookie; returns None for missing/expired/unknown
    sessions.

    Used by public token-authenticated routes (view.py, pdf.py) that don't
    require a session but DO want to know "is this internal-LTP-user
    viewing the link, or an actual client?" — so they can suppress
    client_viewed activity entries when an LTP user opens the share URL
    (e.g. via the Preview button).

    The session lookup mirrors require_session's body intentionally — the
    extra few lines beat extracting a shared helper and then importing it
    in two places. Anything that changes the session model should be
    reviewed against BOTH this function and require_session."""
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        return None

    result = await db.execute(
        select(models.Session, models.User)
        .join(models.User, models.Session.user_id == models.User.id)
        .where(models.Session.id == token)
    )
    row = result.first()
    if not row:
        return None

    session, user = row
    expires = session.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires <= datetime.now(timezone.utc):
        return None

    return user
