"""Google OAuth + session management.

Flow:
    GET  /auth/login     → redirect to Google with OAuth state in a transient cookie
    GET  /auth/callback  → Google sends user back here with a code → we exchange,
                            verify the ID token, check the email domain, upsert User,
                            persist Gmail tokens (encrypted), create Session row,
                            set ltp_session cookie, redirect to /
    POST /auth/logout    → delete Session row + clear cookie
    GET  /auth/me        → return current user info (or 401), including gmail
                            connection status for the Send-button gate

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
from backend.auth_deps import require_session, SESSION_COOKIE_NAME, hash_session_token
from backend import crypto

# Scope string for the per-user Gmail send feature. Mirrored from
# backend/main.py — kept inline here so the lookup in /auth/me doesn't
# create an import cycle through main.
GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"


router = APIRouter(prefix="/auth", tags=["auth"])


# Cookie + session config
SESSION_LIFETIME = timedelta(days=30)


def _cookie_secure(request: Request | None = None) -> bool:
    """Whether to set the Secure cookie attribute. Fail-safe: any one signal
    being true => Secure (SECURITY_REVIEW.md H7):
      - explicit LTP_FORCE_HTTPS switch (production),
      - an https:// LTP_OAUTH_REDIRECT_URI,
      - the actual request transport (scheme / X-Forwarded-Proto) — so a real
        HTTPS request gets a Secure cookie even if the config is wrong.
    Returns False only in genuine http dev, where Secure would drop the cookie."""
    if os.environ.get("LTP_FORCE_HTTPS", "").strip().lower() in ("1", "true", "yes", "on"):
        return True
    if os.environ.get("LTP_OAUTH_REDIRECT_URI", "").startswith("https://"):
        return True
    if request is not None:
        if request.url.scheme == "https":
            return True
        xfp = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
        if xfp == "https":
            return True
    return False


def _set_session_cookie(response: Response, token: str, request: Request | None = None) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        max_age=int(SESSION_LIFETIME.total_seconds()),
        httponly=True,
        secure=_cookie_secure(request),
        samesite="lax",
        path="/",
    )


def _clear_session_cookie(response: Response, request: Request | None = None) -> None:
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path="/",
        secure=_cookie_secure(request),
        samesite="lax",
    )


# ── Routes ─────────────────────────────────────────────────────────────────

@router.get("/login")
async def login(request: Request):
    """Kick off Google OAuth. Authlib generates and stores state + nonce in
    Starlette's signed session cookie before redirecting.

    `access_type=offline` asks Google to include a refresh_token in the token
    response; `prompt=consent` forces the consent screen on every sign-in,
    which is what makes Google issue the refresh_token reliably (without it,
    Google returns one only on the user's very first consent — invisible to
    us at callback time). The UX cost is a one-screen consent prompt per
    sign-in; the correctness gain is that we never lose the refresh token to
    a silent skip."""
    oauth = request.app.state.oauth
    redirect_uri = os.environ.get("LTP_OAUTH_REDIRECT_URI", "")
    if not redirect_uri:
        raise HTTPException(
            status_code=500,
            detail="LTP_OAUTH_REDIRECT_URI is not configured on the server",
        )
    return await oauth.google.authorize_redirect(
        request,
        redirect_uri,
        access_type="offline",
        prompt="consent",
    )


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
    except OAuthError:
        # Common cases: state mismatch, user denied consent. Don't reflect the
        # provider's raw error detail to the client (SECURITY_REVIEW.md L9/H10).
        return JSONResponse(
            status_code=400,
            content={"error": "oauth_error",
                     "detail": "Sign-in could not be completed. Please try again."},
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

    # Access control. Two optional, complementary allowlists:
    #   LTP_ALLOWED_DOMAIN  — a single workspace domain (e.g. "acme.com")
    #   LTP_ALLOWED_EMAILS  — comma-separated explicit addresses (lets a
    #                         gmail.com owner restrict access without a domain)
    # If EITHER is configured, the sign-in email must satisfy at least one. If
    # NEITHER is set, any Google account can sign in — main.py logs a loud boot
    # warning in that case (SECURITY_REVIEW.md M4).
    allowed_domain = os.environ.get("LTP_ALLOWED_DOMAIN", "").strip().lower()
    allowed_emails = {
        e.strip().lower()
        for e in os.environ.get("LTP_ALLOWED_EMAILS", "").split(",")
        if e.strip()
    }
    if allowed_domain or allowed_emails:
        email_domain = email.rsplit("@", 1)[-1] if "@" in email else ""
        domain_ok = bool(allowed_domain) and email_domain == allowed_domain
        email_ok = email in allowed_emails
        if not (domain_ok or email_ok):
            raise HTTPException(
                status_code=403,
                detail=f"Sign-in is restricted; {email} is not on the allow list.",
            )

    # Email-verified check. Treat the email as verified ONLY when Google
    # explicitly says True — the previous `is False` check let a missing/None
    # value through (SECURITY_REVIEW.md M4).
    if userinfo.get("email_verified") is not True:
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

    # Persist Gmail OAuth tokens. The token dict from Authlib mirrors Google's
    # response: access_token (short-lived), refresh_token (long-lived, present
    # because we asked for prompt=consent + access_type=offline at /auth/login),
    # expires_in (seconds), expires_at (epoch seconds, sometimes), scope
    # (space-separated string of granted scopes).
    #
    # Defensive rules:
    #   - Always update access_token + expires_at + scope: short-lived state.
    #   - Update refresh_token only if Google returned one. With prompt=consent
    #     it should always be present, but if Google ever skips it (policy
    #     change, edge case in Authlib parsing), we'd rather keep a working
    #     stored token than overwrite with null and break sends silently.
    #   - Ciphertexts are written via crypto.encrypt_token. If the encryption
    #     key isn't configured (LTP_TOKEN_ENCRYPTION_KEY env var), the helper
    #     raises and we let it propagate — sign-in fails loudly rather than
    #     storing plaintext.
    _persist_gmail_tokens(user, token, now)
    await db.flush()

    # Mint session. The raw token goes in the cookie; we persist only its
    # SHA-256 hash so a DB disclosure yields no usable tokens
    # (SECURITY_REVIEW.md L1).
    session_token = secrets.token_urlsafe(48)  # ~64 chars
    session_row = models.Session(
        id=hash_session_token(session_token),
        user_id=user.id,
        expires_at=now + SESSION_LIFETIME,
    )
    db.add(session_row)
    await db.flush()

    response = RedirectResponse(url="/", status_code=302)
    _set_session_cookie(response, session_token, request)
    return response


@router.post("/logout")
async def logout(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Delete the current session row (if any) and clear the cookie. Idempotent
    — works whether the user is currently signed in or not.

    Scope note (SECURITY_REVIEW.md H11): logout ends the SESSION only. The Gmail
    (per-user) and QuickBooks (company-wide) OAuth tokens are deliberately left
    intact — they're long-lived integration grants with their own explicit
    Disconnect controls, and revoking them on every logout would force a
    reconnect dance (and, for QBO, disrupt other users). Deleting the session
    row here means the cookie can't be replayed even if it was captured."""
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if token:
        await db.execute(
            delete(models.Session).where(models.Session.id == hash_session_token(token))
        )
        await db.flush()
    response = Response(status_code=204)
    _clear_session_cookie(response, request)
    return response


def _persist_gmail_tokens(user: models.User, token: dict, now: datetime) -> None:
    """Pull token fields out of the Authlib token dict and write them to the
    User row. Encryption happens here so the calling code path is unaware of
    the ciphertext format. See callback() above for the defensive rules."""
    access_token = token.get("access_token")
    refresh_token = token.get("refresh_token")
    scope_str = token.get("scope") or ""

    # Compute expiry. Google returns either `expires_in` (seconds from now) or
    # `expires_at` (epoch seconds), depending on Authlib version + flow.
    expires_at: datetime | None = None
    if "expires_at" in token:
        try:
            expires_at = datetime.fromtimestamp(int(token["expires_at"]), tz=timezone.utc)
        except (TypeError, ValueError) as e:
            print(f"[LTP] auth: ignored bad token['expires_at']={token.get('expires_at')!r} ({e})", flush=True)
            expires_at = None
    if expires_at is None and token.get("expires_in"):
        try:
            expires_at = now + timedelta(seconds=int(token["expires_in"]))
        except (TypeError, ValueError) as e:
            print(f"[LTP] auth: ignored bad token['expires_in']={token.get('expires_in')!r} ({e})", flush=True)
            expires_at = None

    if access_token:
        user.gmail_access_token = crypto.encrypt_token(access_token)
    # Persist expiry whenever we computed one — independent of access_token
    # presence. Google always returns access_token alongside in practice, but
    # decoupling here means we don't silently lose the expiry if a future
    # Authlib version splits the fields across calls.
    if expires_at is not None:
        user.gmail_token_expires_at = expires_at
    if refresh_token:
        # Critical: only overwrite when Google actually sent one. A returning
        # user where Google skipped the refresh_token (shouldn't happen with
        # prompt=consent but defense in depth) keeps their previously-stored
        # token rather than getting nulled out.
        user.gmail_refresh_token = crypto.encrypt_token(refresh_token)
    if scope_str:
        user.gmail_granted_scopes = scope_str


def _has_gmail_send_scope(user: models.User) -> bool:
    """True if the user's stored granted-scopes list includes gmail.send.
    Tokens being absent (user signed in before scope shipped) returns False,
    which is the signal the frontend uses to surface the reconnect banner."""
    if not user.gmail_granted_scopes:
        return False
    scopes = user.gmail_granted_scopes.split()
    return GMAIL_SEND_SCOPE in scopes


@router.get("/me")
async def me(user: models.User = Depends(require_session)):
    """Current-user endpoint. UNGATED in the sense that it doesn't require admin,
    but it does require a valid session — that's the whole point.

    The `gmail*` fields drive the Send button gate in the frontend:
      gmailConnected: a refresh token is on file (so we *can* attempt to send)
      gmailScope:     "send" if gmail.send was granted on the last sign-in,
                      else "none" — the frontend uses this to decide whether to
                      gate the Send modal vs surface a reconnect banner."""
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "pictureUrl": user.picture_url,
        "role": user.role,
        "title": user.title or "",
        "phone": user.phone or "",
        "gmailConnected": bool(user.gmail_refresh_token),
        "gmailScope": "send" if _has_gmail_send_scope(user) else "none",
    }
