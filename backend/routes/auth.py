"""Google OAuth + session management.

Flow:
    GET  /auth/login     → redirect to Google with OAuth state in a transient cookie
    GET  /auth/callback  → Google sends user back here with a code → we exchange,
                            verify the ID token, check the email domain, upsert User,
                            create Session row, set ltp_session cookie, redirect to /
    POST /auth/logout    → delete Session row + clear cookie
    GET  /auth/me        → return current user info (or 401)

The Authlib OAuth client is instantiated in backend/main.py and stashed on
`app.state.oauth`. We pull it back via the Request to keep this module decoupled.
"""
import os
import secrets
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse, JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, delete
from authlib.integrations.starlette_client import OAuthError

from backend.database import get_db
from backend import models
from backend.auth_deps import require_session, SESSION_COOKIE_NAME


router = APIRouter(prefix="/auth", tags=["auth"])


# Cookie + session config
SESSION_LIFETIME = timedelta(days=30)


def _cookie_secure() -> bool:
    """Use Secure cookie attribute only when serving over HTTPS. Without this
    check, the cookie wouldn't be set on http://localhost during dev."""
    redirect = os.environ.get("LTP_OAUTH_REDIRECT_URI", "")
    return redirect.startswith("https://")


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        max_age=int(SESSION_LIFETIME.total_seconds()),
        httponly=True,
        secure=_cookie_secure(),
        samesite="lax",
        path="/",
    )


def _clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path="/",
        secure=_cookie_secure(),
        samesite="lax",
    )


# ── Routes ─────────────────────────────────────────────────────────────────

@router.get("/login")
async def login(request: Request):
    """Kick off Google OAuth. Authlib generates and stores state + nonce in
    Starlette's signed session cookie before redirecting."""
    oauth = request.app.state.oauth
    redirect_uri = os.environ.get("LTP_OAUTH_REDIRECT_URI", "")
    if not redirect_uri:
        raise HTTPException(
            status_code=500,
            detail="LTP_OAUTH_REDIRECT_URI is not configured on the server",
        )
    return await oauth.google.authorize_redirect(request, redirect_uri)


@router.get("/callback")
async def callback(request: Request, db: AsyncSession = Depends(get_db)):
    """Handle Google's redirect. Steps:
      1. Exchange the auth code for tokens; Authlib verifies the ID token's
         signature against Google's JWKS and validates the nonce.
      2. Pull email/sub/name/picture from the userinfo / id_token claims.
      3. Enforce LTP_ALLOWED_DOMAIN (if set) — reject everyone else.
      4. Upsert the User row (key off google_sub). First user ever becomes admin.
      5. Mint a new Session row + set the ltp_session cookie.
      6. Redirect to /."""
    oauth = request.app.state.oauth
    try:
        token = await oauth.google.authorize_access_token(request)
    except OAuthError as e:
        # Common cases: state mismatch, user denied consent
        return JSONResponse(
            status_code=400,
            content={"error": "oauth_error", "detail": str(e)},
        )

    # Authlib parses and verifies the ID token automatically when scope includes openid.
    userinfo = token.get("userinfo") or {}
    if not userinfo:
        # Fallback: fetch userinfo endpoint explicitly
        resp = await oauth.google.userinfo(token=token)
        userinfo = dict(resp)

    google_sub = userinfo.get("sub")
    email = (userinfo.get("email") or "").lower().strip()
    name = userinfo.get("name") or email or "Unknown"
    picture = userinfo.get("picture") or ""

    if not google_sub or not email:
        raise HTTPException(status_code=400, detail="Google did not return required user info")

    # Domain check
    allowed_domain = os.environ.get("LTP_ALLOWED_DOMAIN", "").strip().lower()
    if allowed_domain:
        email_domain = email.rsplit("@", 1)[-1] if "@" in email else ""
        if email_domain != allowed_domain:
            raise HTTPException(
                status_code=403,
                detail=f"Sign-in restricted to @{allowed_domain} accounts (you signed in as {email}).",
            )

    # Email-verified check (Google returns this as a boolean)
    if userinfo.get("email_verified") is False:
        raise HTTPException(status_code=403, detail="Google reports your email is not verified.")

    # Upsert user. First user becomes admin. We count inside the transaction to
    # narrow the race window — true atomicity would require SELECT ... FOR UPDATE
    # which asyncpg supports but is overkill for a private tool.
    existing = await db.execute(
        select(models.User).where(models.User.google_sub == google_sub)
    )
    user = existing.scalar_one_or_none()

    now = datetime.now(timezone.utc)
    if user is None:
        # Decide role: admin iff this is the very first user
        count_result = await db.execute(select(func.count()).select_from(models.User))
        is_first_user = (count_result.scalar() or 0) == 0
        user = models.User(
            google_sub=google_sub,
            email=email,
            name=name,
            picture_url=picture,
            role="admin" if is_first_user else "member",
            last_login=now,
        )
        db.add(user)
        await db.flush()
    else:
        # Refresh cached profile from Google (the source of truth)
        user.email = email
        user.name = name
        user.picture_url = picture
        user.last_login = now
        await db.flush()

    # Mint session
    session_token = secrets.token_urlsafe(48)  # ~64 chars
    session_row = models.Session(
        id=session_token,
        user_id=user.id,
        expires_at=now + SESSION_LIFETIME,
    )
    db.add(session_row)
    await db.flush()

    response = RedirectResponse(url="/", status_code=302)
    _set_session_cookie(response, session_token)
    return response


@router.post("/logout")
async def logout(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Delete the current session (if any) and clear the cookie. Idempotent —
    works whether the user is currently signed in or not."""
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if token:
        await db.execute(delete(models.Session).where(models.Session.id == token))
        await db.flush()
    response = Response(status_code=204)
    _clear_session_cookie(response)
    return response


@router.get("/me")
async def me(user: models.User = Depends(require_session)):
    """Current-user endpoint. UNGATED in the sense that it doesn't require admin,
    but it does require a valid session — that's the whole point."""
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "pictureUrl": user.picture_url,
        "role": user.role,
    }
