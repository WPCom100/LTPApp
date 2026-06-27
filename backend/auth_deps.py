"""Auth dependencies used by route handlers.

`require_session` validates the `ltp_session` cookie and returns the User row.
`require_admin` chains on top to additionally check the user's role.

These are async FastAPI Depends helpers — wire them with `Depends(require_session)`
on a router or individual endpoint. See backend/routes/api.py for usage.
"""
import hashlib
import os
from datetime import datetime, timedelta, timezone
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from backend.database import get_db
from backend import models


SESSION_COOKIE_NAME = "ltp_session"

# Idle timeout: a session unused for this long stops authenticating, even
# though its 30-day absolute lifetime hasn't elapsed (SECURITY_REVIEW.md L2).
# last_used_at is refreshed at most once per throttle window to avoid a DB
# write on every request.
_IDLE_TIMEOUT = timedelta(days=7)
_LAST_USED_THROTTLE = timedelta(minutes=15)


def hash_session_token(token: str) -> str:
    """SHA-256 hex digest of a raw session token. This is what we store in
    sessions.id; the raw token lives only in the cookie and is never persisted,
    so a database disclosure yields no usable session tokens
    (SECURITY_REVIEW.md L1). Always 64 hex chars."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def _load_session_user(db: AsyncSession, token: str | None):
    """Resolve a raw session-cookie token to its User, or None when the token
    is missing / unknown / expired. Single source of truth for session
    validation — shared by require_session (raising) and get_optional_user
    (non-raising). Review any session-model change here once."""
    if not token:
        return None
    result = await db.execute(
        select(models.Session, models.User)
        .join(models.User, models.Session.user_id == models.User.id)
        .where(models.Session.id == hash_session_token(token))
    )
    row = result.first()
    if not row:
        return None
    session, user = row
    now = datetime.now(timezone.utc)
    # SQLite drops tzinfo on DateTime(timezone=True) reads; Postgres keeps it.
    # Normalize to UTC-aware before comparing so both backends behave the same.
    expires = session.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires <= now:
        return None
    # Idle timeout (L2): reject a session untouched for longer than the window.
    last_used = session.last_used_at
    if last_used is not None:
        if last_used.tzinfo is None:
            last_used = last_used.replace(tzinfo=timezone.utc)
        if now - last_used > _IDLE_TIMEOUT:
            return None
    # Refresh last_used at most once per throttle window (the surrounding
    # get_db commits it). Skips a write on every request.
    if last_used is None or (now - last_used) > _LAST_USED_THROTTLE:
        session.last_used_at = now
    return user


# ═══════════════════════════════════════════════════════════════════════════
#  ⚠️  TEMPORARY DEV AUTH BYPASS  —  branch claude/schedule-editor-rates-6mhnto
# ═══════════════════════════════════════════════════════════════════════════
#  While this block is present, the Google sign-in requirement is DISABLED:
#  any request that lacks a valid session is transparently authenticated as a
#  shared local "dev admin" user. It exists ONLY so this feature branch can be
#  used/reviewed without going through OAuth during development.
#
#  ⚠️  DO NOT MERGE TO MASTER. The application has effectively NO authentication
#  while this is active. Before merging back, delete this block (and the single
#  `_AUTH_BYPASS` call site in require_session() below) to restore sign-in.
# ═══════════════════════════════════════════════════════════════════════════
_AUTH_BYPASS = True
_BYPASS_GOOGLE_SUB = "dev-auth-bypass"
_BYPASS_EMAIL = "dev-bypass@localhost"

if _AUTH_BYPASS:
    print(
        "[LTP] ⚠️  AUTH BYPASS ACTIVE — Google sign-in is DISABLED; every "
        "request is treated as a dev admin. Do NOT run this in production or "
        "merge it to master.",
        flush=True,
    )


async def _get_or_create_bypass_user(db: AsyncSession) -> models.User:
    """Return the shared local dev-admin User used by the TEMPORARY auth bypass,
    creating it on first use. Remove together with the bypass block above."""
    result = await db.execute(
        select(models.User).where(models.User.google_sub == _BYPASS_GOOGLE_SUB)
    )
    user = result.scalar_one_or_none()
    if user is not None:
        return user
    user = models.User(
        google_sub=_BYPASS_GOOGLE_SUB,
        email=_BYPASS_EMAIL,
        name="Dev Admin (auth bypass)",
        role="admin",
    )
    db.add(user)
    try:
        await db.flush()
    except IntegrityError:
        # Another concurrent first-request created it — discard our insert
        # (nothing else is pending at auth-resolution time) and re-read.
        await db.rollback()
        result = await db.execute(
            select(models.User).where(models.User.google_sub == _BYPASS_GOOGLE_SUB)
        )
        user = result.scalar_one()
    return user


async def require_session(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> models.User:
    """Look up the caller via the `ltp_session` cookie. Returns the User row
    on success; raises 401 on missing/expired/unknown session.

    Note: expired sessions are NOT auto-deleted here (kept simple — a sweeper
    job can do that later). They just stop authenticating, same effect."""
    user = await _load_session_user(db, request.cookies.get(SESSION_COOKIE_NAME))
    if user is None and _AUTH_BYPASS:  # TEMP dev bypass — remove before merge
        return await _get_or_create_bypass_user(db)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not signed in",
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

    Shares the same validation as require_session via _load_session_user, so
    the two can never drift."""
    return await _load_session_user(db, request.cookies.get(SESSION_COOKIE_NAME))
