"""Crew portal — a crew member's own sign-in and dashboard.

The crew request flow (backend/routes/crew.py) is tokenized and stateless: a
link per ask, no account. That is right for answering one request and wrong
for everything around it — "what am I on next week", "which asks are still
waiting on me", "what am I owed and when is it paid". Those need a place that
is the crew member's own, and that is this: #/crew-portal, behind an email +
password sign-in.

Three routers, mirroring the public/producer split crew.py already uses:

  SIGN-IN SURFACE (no session — under /api/crew-portal/auth, rate-limited):
    POST /auth/login             {email, password}      → sets ltp_crew_session
    POST /auth/logout                                   → clears it
    GET  /auth/me                                       → 401 or the signed-in crew member
    POST /auth/forgot            {email}                → emails a reset link (always 200)
    POST /auth/request-access    {email}                → same handler: an invite for a
                                                          roster email with no account,
                                                          a reset for one that has one
    GET  /auth/token/{token}                            → who a link is for + is it live
    POST /auth/signup            {token, password}      → accept an invitation
    POST /auth/reset             {token, password}      → finish a password reset
    POST /auth/change-password   {currentPassword, newPassword}   (crew session)

  CREW (require_crew — the ltp_crew_session cookie):
    GET  /me · PUT /me {phone}
    GET  /dashboard?today=YYYY-MM-DD   → requests, upcoming, recent, stats, payouts
    GET  /dashboard/version            → {doc, app} for the freshness poll
    POST /requests/{id}/respond        {decision, comment?} → own request only

  STAFF (require_session — the staff app, under /api/crew-portal/accounts):
    GET  ""                       → portal status per crew contact (roster column)
    POST /{contactId}/invite      → mint + email an invitation (as the acting user)
    POST /{contactId}/reset       → mint + email a password reset
    POST /{contactId}/disable · /enable   (admin) → the off-switch

Security model
==============
- Separate credential system from staff (backend/crew_auth.py explains the
  split). The crew cookie is checked ONLY here; the staff cookie is never
  accepted here; neither reaches the other's routes.
- Passwords are scrypt-hashed; sessions and one-time links are stored as
  SHA-256 hashes (a database read yields nothing usable).
- Every crew read is scoped to `contact.id` at the query: the dashboard walks
  every project but keeps only this member's positions, requests are loaded
  by contact_id, and /requests/{id}/respond refuses a request that isn't
  theirs before touching the state machine. Money is this member's own
  frozen snapshots (backend/payouts.py) — never another crew member's, never
  the client's rate.
- Sign-in surface: per-IP rate limit (backend/rate_limit.py) + per-account
  lockout after LOCKOUT_ATTEMPTS wrong passwords; generic responses on the
  forgot / request-access paths so an address can't be tested for existence;
  a per-contact cool-down so those paths can't be used to flood an inbox.
- Emails go through the existing Gmail pipeline: staff-triggered ones as the
  acting user, self-serve ones as a designated system sender
  (LTP_CREW_PORTAL_SENDER_EMAIL, else the most recently signed-in admin
  with Gmail connected). Delivery is best-effort and reported, never fatal.
"""
import hashlib
import json
import os
import secrets
from datetime import date, datetime, timedelta, timezone
from html import escape
from typing import NamedTuple

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend import crew_auth, crew_integrity, gmail, livesync, models, payouts
from backend.auth_deps import require_admin, require_session
from backend.database import get_db
from backend.email_compose import (
    _CTA_ORANGE, _email_brand, _paragraphs_to_html, _render_signature, crew_origin, email_shell,
)
from backend.routes._shared import load_settings, public_settings
from backend.routes.auth import _cookie_secure
from backend.routes.crew import (
    _ask_label, _crew_shifts, _fixed_list, _project_date_outline, _resolve_site_address, _respond,
)
from backend.sanitize import email_html


CREW_COOKIE = "ltp_crew_session"
SESSION_LIFETIME = timedelta(days=30)
_IDLE_TIMEOUT = timedelta(days=30)
_LAST_USED_THROTTLE = timedelta(minutes=15)
# Minimum gap between two self-serve emails to the same crew member
# (forgot-password / request-access). A link is good for an hour, so a second
# ask inside two minutes is a double-click or an abuser, not a lost email.
_SELF_SERVE_COOLDOWN = timedelta(minutes=2)
# Requests answered inside this many days still show under "recent" on the
# dashboard, so a crew member can see that their answer landed.
_RECENT_DAYS = 45
# Confirmed calls this far back still list under "recently worked".
_PAST_DAYS = 45
# How many pay periods back the payouts tab reaches (plus the next one).
_PAYOUT_PERIODS_BACK = 5

# Pay-period defaults, mirrored from data/settings.js so a workspace that has
# never saved Settings still buckets pay the way the Payouts tab does.
_PP_DEFAULT_ANCHOR = "2026-07-06"
_PP_DEFAULT_LENGTH = 14
_PP_DEFAULT_OFFSET = 5

_UPCOMING_STATUSES = ("requested", "accepted", "confirmed")

# Sign-in surface (public) + crew-session routes.
crew_portal_router = APIRouter(prefix="/api/crew-portal", tags=["crew-portal"])
# Staff controls — every route requires a staff session.
crew_portal_admin_router = APIRouter(
    prefix="/api/crew-portal/accounts", tags=["crew-portal"],
    dependencies=[Depends(require_session)],
)


class CrewIdentity(NamedTuple):
    account: "models.CrewAccount"
    contact: "models.Contact"
    session_id: str


# ── Small helpers ───────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt):
    """SQLite drops tzinfo on DateTime(timezone=True) reads; Postgres keeps it.
    Normalize so comparisons never mix naive and aware."""
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _iso(dt) -> str | None:
    dt = _aware(dt)
    return dt.isoformat() if dt else None


def _contact_name(c) -> str:
    if c is None:
        return ""
    return ((c.first_name or "") + " " + (c.last_name or "")).strip()


def _crew_eligible(contact) -> bool:
    """A contact who may hold portal access: on the roster, and not inactive."""
    return bool(contact) and bool(contact.is_crew) and (contact.crew_status or "active") != "inactive"


def _body_dict(body) -> dict:
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")
    return body


async def _account_for_contact(db, contact_id):
    r = await db.execute(select(models.CrewAccount).where(models.CrewAccount.contact_id == contact_id))
    return r.scalar_one_or_none()


async def _account_for_email(db, email):
    if not email:
        return None
    r = await db.execute(select(models.CrewAccount).where(models.CrewAccount.email == email))
    return r.scalar_one_or_none()


async def _contact(db, contact_id):
    if contact_id is None:
        return None
    r = await db.execute(select(models.Contact).where(models.Contact.id == contact_id))
    return r.scalar_one_or_none()


async def _revoke_sessions(db, account_id, keep=None) -> None:
    q = delete(models.CrewSession).where(models.CrewSession.account_id == account_id)
    if keep:
        q = q.where(models.CrewSession.id != keep)
    await db.execute(q)


async def _retire_tokens(db, contact_id, kind=None) -> None:
    """Mark every still-open link for the contact used, so only the newest
    invitation / reset is live. `kind=None` retires both kinds (disable)."""
    q = select(models.CrewAuthToken).where(
        models.CrewAuthToken.contact_id == contact_id,
        models.CrewAuthToken.used_at.is_(None),
    )
    if kind:
        q = q.where(models.CrewAuthToken.kind == kind)
    now = _now()
    for row in (await db.execute(q)).scalars().all():
        row.used_at = now


async def _mint_link(db, contact, kind, email, created_by=None) -> tuple[str, "models.CrewAuthToken"]:
    """Retire earlier open links of this kind and mint a fresh one. Returns
    (raw token — for the link, row)."""
    await _retire_tokens(db, contact.id, kind)
    raw, digest = crew_auth.mint_token()
    life = crew_auth.INVITE_LIFETIME if kind == "invite" else crew_auth.RESET_LIFETIME
    row = models.CrewAuthToken(
        contact_id=contact.id, kind=kind, token_hash=digest, email=email,
        expires_at=_now() + life, created_by_user_id=created_by,
    )
    db.add(row)
    await db.flush()
    return raw, row


async def _find_token(db, raw):
    """The CrewAuthToken row for a raw link token, or None. Length floor like
    the other token lookups (view.py, crew.py)."""
    if not isinstance(raw, str) or len(raw) < 8 or len(raw) > 200:
        return None
    r = await db.execute(select(models.CrewAuthToken).where(
        models.CrewAuthToken.token_hash == crew_auth.hash_token(raw)))
    return r.scalar_one_or_none()


def _token_state(row) -> str:
    """'live' | 'used' | 'expired' for a token row."""
    if row.used_at is not None:
        return "used"
    if _aware(row.expires_at) <= _now():
        return "expired"
    return "live"


def _portal_url(path: str) -> str:
    """An absolute portal link — on the crew portal's own domain when one is
    configured (email_compose.crew_origin), else the app's."""
    return (crew_origin() or "") + "/#/crew-portal/" + path


def _me_payload(account, contact) -> dict:
    return {
        "id": account.id,
        "contactId": contact.id,
        "name": _contact_name(contact) or account.email,
        "firstName": contact.first_name or "",
        "lastName": contact.last_name or "",
        # The login identity, and the roster address requests are delivered to
        # — usually the same; shown side by side on the Account tab when not.
        "email": account.email,
        "contactEmail": contact.email or "",
        "phone": contact.phone or "",
        "roles": list(contact.crew_roles or []),
        "departments": list(contact.crew_departments or []),
        "crewStatus": contact.crew_status or "active",
        "lastLoginAt": _iso(account.last_login_at),
        "passwordChangedAt": _iso(account.password_changed_at),
    }


# ── Session cookie ──────────────────────────────────────────────────────────

def _set_cookie(response: Response, token: str, request: Request) -> None:
    response.set_cookie(
        key=CREW_COOKIE, value=token, max_age=int(SESSION_LIFETIME.total_seconds()),
        httponly=True, secure=_cookie_secure(request), samesite="lax", path="/",
    )


def _clear_cookie(response: Response, request: Request) -> None:
    response.delete_cookie(key=CREW_COOKIE, path="/", secure=_cookie_secure(request), samesite="lax")


async def _open_session(db, account, response: Response, request: Request) -> None:
    raw = secrets.token_urlsafe(48)
    db.add(models.CrewSession(
        id=crew_auth.hash_token(raw), account_id=account.id,
        expires_at=_now() + SESSION_LIFETIME, last_used_at=_now(),
    ))
    await db.flush()
    _set_cookie(response, raw, request)


async def _load_crew(db, raw_token):
    """(account, contact, session_id) for a raw cookie token, or None."""
    if not raw_token:
        return None
    sid = crew_auth.hash_token(raw_token)
    r = await db.execute(
        select(models.CrewSession, models.CrewAccount)
        .join(models.CrewAccount, models.CrewSession.account_id == models.CrewAccount.id)
        .where(models.CrewSession.id == sid)
    )
    row = r.first()
    if not row:
        return None
    session, account = row
    now = _now()
    if _aware(session.expires_at) <= now:
        return None
    last = _aware(session.last_used_at)
    if last is not None and now - last > _IDLE_TIMEOUT:
        return None
    if account.disabled:
        return None
    contact = await _contact(db, account.contact_id)
    if not _crew_eligible(contact):
        return None
    if last is None or (now - last) > _LAST_USED_THROTTLE:
        session.last_used_at = now
    return CrewIdentity(account, contact, sid)


async def require_crew(request: Request, db: AsyncSession = Depends(get_db)) -> CrewIdentity:
    """The signed-in crew member, or 401. Reads ONLY the crew cookie — a staff
    session is not a crew session."""
    ident = await _load_crew(db, request.cookies.get(CREW_COOKIE))
    if ident is None:
        raise HTTPException(status_code=401, detail="Not signed in",
                            headers={"WWW-Authenticate": "Cookie"})
    return ident


# ── Emails (invitation + reset), composed server-side like the crew request ─

# Server-side fallbacks — keep byte-for-byte in sync with data/settings.js
# emailTemplates.crewInvite / crewPasswordReset, for the same reason
# routes/crew.py pins _NOTIFY_FALLBACKS: the DB carries no template until an
# admin saves Settings, and a fresh deploy must still send a sensible email.
_PORTAL_FALLBACKS = {
    "crewInvite": {
        "subject": "You're invited to the {{companyName}} crew portal",
        "body": ("Hi {{crewName}},\n\nWe've set you up with access to our crew portal, "
                 "where you can see your upcoming calls, answer crew requests, and keep "
                 "track of what you're owed — all in one place.\n\n{{header}}\n\n"
                 "The link is yours alone and expires in {{expiresIn}}. If it stops "
                 "working, just ask us to send a new one.\n\n{{signature}}"),
    },
    "crewPasswordReset": {
        "subject": "Reset your {{companyName}} crew portal password",
        "body": ("Hi {{crewName}},\n\nWe received a request to reset your crew portal "
                 "password. Use the button below to choose a new one.\n\n{{header}}\n\n"
                 "This link expires in {{expiresIn}}. If you didn't ask for a reset, you "
                 "can ignore this email — your password won't change.\n\n{{signature}}"),
    },
}

_PORTAL_KINDS = {
    "invite": {"template": "crewInvite", "eyebrow": "Crew portal",
               "title": "Set up your account", "cta": "Set Up My Account",
               "expires": "7 days"},
    "reset": {"template": "crewPasswordReset", "eyebrow": "Crew portal",
              "title": "Reset your password", "cta": "Choose a New Password",
              "sub": "This link signs you in once so you can pick a new password.",
              "expires": "1 hour"},
}


def _portal_header_html(kind: str, url: str, company: str) -> str:
    """The themed call-to-action card ({{header}}) for an invitation or reset —
    same shape as the crew request's header (routes/crew.py::_crew_header_html)
    so every crew email reads as one family."""
    k = _PORTAL_KINDS[kind]
    sub = k.get("sub") or ""   # optional one-liner under the title; the button follows directly without it
    return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
        'style="width:100%;margin:6px 0;background-color:#f7f9fa;border:1px solid #eceef0;border-radius:10px">'
        '<tr><td style="padding:22px;text-align:center">'
        '<div style="font-size:12px;color:#8a949e;text-transform:uppercase;letter-spacing:0.06em">' + escape(company) + ' &middot; ' + escape(k["eyebrow"]) + '</div>'
        '<div style="font-size:19px;font-weight:bold;color:#233038;margin:4px 0 ' + ("2px" if sub else "18px") + '">' + escape(k["title"]) + '</div>'
        + ('<div style="font-size:12px;color:#8a949e;margin-bottom:18px">' + escape(sub) + '</div>' if sub else '') +
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto"><tr>'
        '<td style="background-color:' + _CTA_ORANGE + ';border-radius:7px">'
        '<a href="' + escape(url) + '" style="display:inline-block;padding:14px 38px;font-size:15px;font-weight:bold;'
        'color:#ffffff;text-decoration:none">' + escape(k["cta"]) + '</a></td>'
        '</tr></table>'
        '<div style="font-size:11px;color:#8a949e;margin-top:14px;word-break:break-all">Or paste this link into your browser:<br>'
        '<a href="' + escape(url) + '" style="color:#8a949e">' + escape(url) + '</a></div>'
        '</td></tr></table>'
    )


def render_portal_email(kind: str, *, crew_name: str, url: str, sender, settings_data: dict) -> tuple[str, str]:
    """(subject, final_html) for an invitation or reset email. Pure — no I/O —
    so tests can pin the rendering without a mailbox."""
    k = _PORTAL_KINDS[kind]
    tmpl = ((settings_data.get("emailTemplates") or {}).get(k["template"]) or {})
    fallback = _PORTAL_FALLBACKS[k["template"]]
    brand = _email_brand(settings_data)
    company = brand["company"]
    repl = {
        "{{companyName}}": company,
        "{{crewName}}": crew_name or "there",
        "{{expiresIn}}": k["expires"],
        "{{portalUrl}}": url,
    }

    def _sub(text):
        for key, val in repl.items():
            text = text.replace(key, val)
        return text

    subject = _sub(tmpl.get("subject") or fallback["subject"])
    body = _sub(tmpl.get("body") or fallback["body"])
    inner = _paragraphs_to_html(body, {
        "{{header}}": _portal_header_html(kind, url, company),
        "{{signature}}": _render_signature(sender, settings_data) if sender is not None else "",
    })
    return subject, email_html(email_shell(inner, brand))


async def _system_sender(db):
    """Who self-serve portal emails (forgot / request-access) are sent as. The
    address named by LTP_CREW_PORTAL_SENDER_EMAIL when that user has Gmail
    connected; else the most recently signed-in admin with Gmail connected;
    else any user with Gmail connected. None when nobody can send — the
    caller logs it, the crew member gets the generic 'check your inbox'."""
    wanted = (os.environ.get("LTP_CREW_PORTAL_SENDER_EMAIL") or "").strip().lower()
    if wanted:
        r = await db.execute(select(models.User).where(models.User.email == wanted))
        u = r.scalar_one_or_none()
        if u is not None and u.gmail_refresh_token:
            return u
    rows = (await db.execute(
        select(models.User).where(models.User.gmail_refresh_token.isnot(None))
    )).scalars().all()
    rows = [u for u in rows if u.gmail_refresh_token]
    if not rows:
        return None
    rows.sort(key=lambda u: (u.role != "admin", -(_aware(u.last_login) or datetime.min.replace(tzinfo=timezone.utc)).timestamp()))
    return rows[0]


async def _send_portal_email(db, sender, contact, kind, url, settings_data) -> dict:
    """Best-effort send. NEVER raises — a mail failure must not undo the
    invitation or reset that was just minted (staff can copy the invite
    link; the crew member can ask again)."""
    to = crew_auth.normalize_email(contact.email if kind == "invite" else contact.email)
    if not to:
        return {"emailed": False, "noEmail": True, "error": "no email on file"}
    if sender is None:
        print("[LTP] crew portal: no Gmail-connected user to send a %s email as" % kind, flush=True)
        return {"emailed": False, "noSender": True,
                "error": "no team member with Gmail connected can send this email"}
    try:
        subject, final_html = render_portal_email(
            kind, crew_name=_contact_name(contact) or "there", url=url,
            sender=sender, settings_data=settings_data,
        )
        reply_to = (settings_data.get("emailReplyTo") or "").strip() or None
        await gmail.send(
            user=sender, db=db,
            client_id=os.environ.get("GOOGLE_CLIENT_ID", ""),
            client_secret=os.environ.get("GOOGLE_CLIENT_SECRET", ""),
            to=[to], cc=[], subject=subject, html_body=final_html,
            text_body=None, reply_to=reply_to,
        )
        return {"emailed": True, "to": to}
    except gmail.GmailReconnectRequired as e:
        return {"emailed": False, "needsReconnect": True, "error": str(e)}
    except gmail.GmailSendError as e:
        return {"emailed": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001 — delivery is best-effort by contract
        print(f"[LTP] crew portal {kind} email failed: {e!r}", flush=True)
        return {"emailed": False, "error": "unexpected error sending email"}


# ── Sign-in surface ─────────────────────────────────────────────────────────

_dummy_hash = None


def _burn_a_hash(password: str) -> None:
    """Run one scrypt even when there is no account, so a missing address
    answers in the same time as a wrong password."""
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = crew_auth.hash_password(secrets.token_urlsafe(16))
    crew_auth.verify_password(password if isinstance(password, str) else "", _dummy_hash)


def _bad_credentials():
    return HTTPException(status_code=401, detail={
        "reason": "bad_credentials", "message": "That email and password don't match."})


@crew_portal_router.post("/auth/login")
async def login(body: dict, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    body = _body_dict(body)
    email = crew_auth.normalize_email(body.get("email"))
    password = body.get("password")
    if not email or not isinstance(password, str) or not password:
        raise HTTPException(status_code=400, detail={"reason": "missing", "message": "Enter your email and password."})

    account = await _account_for_email(db, email)
    if account is None:
        _burn_a_hash(password)
        raise _bad_credentials()

    now = _now()
    locked_until = _aware(account.locked_until)
    if locked_until and locked_until > now:
        wait = int((locked_until - now).total_seconds() // 60) + 1
        raise HTTPException(status_code=403, detail={
            "reason": "locked",
            "message": "Too many attempts. Try again in %d minute%s." % (wait, "" if wait == 1 else "s")})

    if not crew_auth.verify_password(password, account.password_hash):
        account.failed_attempts = (account.failed_attempts or 0) + 1
        if account.failed_attempts >= crew_auth.LOCKOUT_ATTEMPTS:
            account.locked_until = now + timedelta(minutes=crew_auth.LOCKOUT_MINUTES)
            account.failed_attempts = 0
        # Commit HERE, before raising: the 401 propagates through get_db, whose
        # error path rolls the transaction back — and a failure count that is
        # rolled back with every failure is a lockout that never fires.
        await db.commit()
        raise _bad_credentials()

    if account.disabled:
        raise HTTPException(status_code=403, detail={
            "reason": "disabled", "message": "Your portal access has been turned off. Please contact the office."})
    contact = await _contact(db, account.contact_id)
    if not _crew_eligible(contact):
        raise HTTPException(status_code=403, detail={
            "reason": "inactive", "message": "Your crew profile is inactive. Please contact the office."})

    account.failed_attempts = 0
    account.locked_until = None
    account.last_login_at = now
    if crew_auth.needs_rehash(account.password_hash):
        account.password_hash = crew_auth.hash_password(password)
    await _open_session(db, account, response, request)
    return _me_payload(account, contact)


@crew_portal_router.post("/auth/logout")
async def logout(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    raw = request.cookies.get(CREW_COOKIE)
    if raw:
        await db.execute(delete(models.CrewSession).where(models.CrewSession.id == crew_auth.hash_token(raw)))
    _clear_cookie(response, request)
    return {"ok": True}


@crew_portal_router.get("/auth/me")
async def auth_me(ident: CrewIdentity = Depends(require_crew)):
    return _me_payload(ident.account, ident.contact)


async def _self_serve(db, email: str) -> None:
    """Forgot-password / request-access. Never reveals whether the address is
    known: an account gets a reset link, a roster email with no account gets
    an invitation, anything else gets nothing — and the response is the same
    every time. Throttled per contact so the inbox can't be flooded."""
    if not email:
        return
    account = await _account_for_email(db, email)
    contact = None
    kind = None
    if account is not None:
        if account.disabled:
            return
        contact = await _contact(db, account.contact_id)
        kind = "reset"
    else:
        # A roster email with no account yet: the crew member is asking to be
        # let in. Match on the contact's own address, crew only, active only.
        rows = (await db.execute(select(models.Contact).where(models.Contact.is_crew.is_(True)))).scalars().all()
        matches = [c for c in rows if crew_auth.normalize_email(c.email) == email and _crew_eligible(c)]
        if not matches:
            return
        contact = matches[0]
        kind = "invite"
    if not _crew_eligible(contact):
        return
    recent = (await db.execute(
        select(models.CrewAuthToken)
        .where(models.CrewAuthToken.contact_id == contact.id,
               models.CrewAuthToken.kind == kind,
               models.CrewAuthToken.used_at.is_(None))
        .order_by(models.CrewAuthToken.id.desc()).limit(1)
    )).scalar_one_or_none()
    if recent is not None and _aware(recent.created_at) and _now() - _aware(recent.created_at) < _SELF_SERVE_COOLDOWN:
        return
    raw, _row = await _mint_link(db, contact, kind, email)
    url = _portal_url(("signup/" if kind == "invite" else "reset/") + raw)
    sender = await _system_sender(db)
    status = await _send_portal_email(db, sender, contact, kind, url, await load_settings(db))
    if not status.get("emailed"):
        print(f"[LTP] crew portal: self-serve {kind} email to contact {contact.id} not sent: {status.get('error')}", flush=True)


@crew_portal_router.post("/auth/forgot")
@crew_portal_router.post("/auth/request-access")
async def forgot(body: dict, db: AsyncSession = Depends(get_db)):
    body = _body_dict(body)
    await _self_serve(db, crew_auth.normalize_email(body.get("email")))
    return {"ok": True}


@crew_portal_router.get("/auth/token/{token}")
async def describe_token(token: str, db: AsyncSession = Depends(get_db)):
    """What a signup/reset link is for, so the page can greet the right person
    and say plainly when the link is spent or expired. 404 for an unknown
    token; a known-but-dead one still answers, with valid=false."""
    row = await _find_token(db, token)
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    contact = await _contact(db, row.contact_id)
    state = _token_state(row)
    settings = await load_settings(db)
    return {
        "kind": row.kind,
        "valid": state == "live" and _crew_eligible(contact),
        "reason": state if state != "live" else ("inactive" if not _crew_eligible(contact) else None),
        "email": row.email,
        "firstName": (contact.first_name if contact else "") or "",
        "name": _contact_name(contact),
        "expiresAt": _iso(row.expires_at),
        "companyName": (settings.get("companyName") or "").strip() or "Luminary Technology & Productions",
    }


def _password_or_400(password, email=""):
    problem = crew_auth.password_problem(password, email)
    if problem:
        raise HTTPException(status_code=400, detail={"field": "password", "reason": "weak", "message": problem})


async def _live_token_or_4xx(db, raw, kind):
    row = await _find_token(db, raw)
    if row is None or row.kind != kind:
        raise HTTPException(status_code=404, detail={"reason": "unknown", "message": "This link isn't valid."})
    state = _token_state(row)
    if state != "live":
        raise HTTPException(status_code=410, detail={
            "reason": state,
            "message": "This link has already been used." if state == "used" else "This link has expired — ask for a new one."})
    return row


@crew_portal_router.post("/auth/signup")
async def signup(body: dict, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    """Accept an invitation: set the password, create (or re-activate) the
    account, spend the link, sign in."""
    body = _body_dict(body)
    row = await _live_token_or_4xx(db, body.get("token"), "invite")
    contact = await _contact(db, row.contact_id)
    if not _crew_eligible(contact):
        raise HTTPException(status_code=403, detail={"reason": "inactive", "message": "This crew profile is no longer active. Please contact the office."})
    email = crew_auth.normalize_email(row.email) or crew_auth.normalize_email(contact.email)
    if not email:
        raise HTTPException(status_code=400, detail={"reason": "no_email", "message": "No email address is on file for this invitation."})
    _password_or_400(body.get("password"), email)

    now = _now()
    account = await _account_for_contact(db, contact.id)
    other = await _account_for_email(db, email)
    if other is not None and (account is None or other.id != account.id):
        raise HTTPException(status_code=409, detail={"reason": "email_taken", "message": "That email is already attached to another crew account. Please contact the office."})
    if account is None:
        account = models.CrewAccount(contact_id=contact.id, email=email)
        db.add(account)
    account.email = email
    account.password_hash = crew_auth.hash_password(body["password"])
    account.password_changed_at = now
    account.disabled = False
    account.failed_attempts = 0
    account.locked_until = None
    account.last_login_at = now
    row.used_at = now
    await db.flush()
    await _retire_tokens(db, contact.id, "invite")
    await _revoke_sessions(db, account.id)
    await _open_session(db, account, response, request)
    return _me_payload(account, contact)


@crew_portal_router.post("/auth/reset")
async def reset_password(body: dict, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    """Finish a password reset: new password, every other session revoked,
    the link spent, and a fresh sign-in so they land on the dashboard."""
    body = _body_dict(body)
    row = await _live_token_or_4xx(db, body.get("token"), "reset")
    account = await _account_for_contact(db, row.contact_id)
    if account is None or account.disabled:
        raise HTTPException(status_code=410, detail={"reason": "unknown", "message": "This link isn't valid any more."})
    contact = await _contact(db, account.contact_id)
    if not _crew_eligible(contact):
        raise HTTPException(status_code=403, detail={"reason": "inactive", "message": "This crew profile is no longer active. Please contact the office."})
    _password_or_400(body.get("password"), account.email)
    now = _now()
    account.password_hash = crew_auth.hash_password(body["password"])
    account.password_changed_at = now
    account.failed_attempts = 0
    account.locked_until = None
    account.last_login_at = now
    row.used_at = now
    await db.flush()
    await _retire_tokens(db, contact.id, "reset")
    await _revoke_sessions(db, account.id)
    await _open_session(db, account, response, request)
    return _me_payload(account, contact)


@crew_portal_router.post("/auth/change-password")
async def change_password(body: dict, request: Request, db: AsyncSession = Depends(get_db),
                          ident: CrewIdentity = Depends(require_crew)):
    body = _body_dict(body)
    current = body.get("currentPassword")
    if not isinstance(current, str) or not crew_auth.verify_password(current, ident.account.password_hash):
        raise HTTPException(status_code=403, detail={"field": "currentPassword", "reason": "bad_credentials", "message": "Your current password isn't right."})
    _password_or_400(body.get("newPassword"), ident.account.email)
    if body.get("newPassword") == current:
        raise HTTPException(status_code=400, detail={"field": "password", "reason": "same", "message": "Choose a password you haven't used here before."})
    ident.account.password_hash = crew_auth.hash_password(body["newPassword"])
    ident.account.password_changed_at = _now()
    await db.flush()
    # Every OTHER device is signed out; this one keeps its session.
    await _revoke_sessions(db, ident.account.id, keep=ident.session_id)
    return {"ok": True}


# ── Crew: profile ───────────────────────────────────────────────────────────

@crew_portal_router.get("/me")
async def me(ident: CrewIdentity = Depends(require_crew)):
    return _me_payload(ident.account, ident.contact)


@crew_portal_router.put("/me")
async def update_me(body: dict, db: AsyncSession = Depends(get_db), ident: CrewIdentity = Depends(require_crew)):
    """The one roster field a crew member keeps current themselves: their
    phone. Names, roles and the roster email stay staff-owned."""
    body = _body_dict(body)
    if "phone" in body:
        phone = body.get("phone")
        if phone is not None and not isinstance(phone, str):
            raise HTTPException(status_code=400, detail={"field": "phone", "reason": "must be a string"})
        phone = (phone or "").strip()
        if len(phone) > 50:
            raise HTTPException(status_code=400, detail={"field": "phone", "reason": "max 50 chars"})
        if phone != (ident.contact.phone or ""):
            ident.contact.phone = phone
            await db.flush()
            livesync.mark_dirty(db, "contacts")
    return _me_payload(ident.account, ident.contact)


# ── Crew: dashboard ─────────────────────────────────────────────────────────

def _parse_today(raw) -> str:
    """The crew member's local calendar date (the browser sends it — the
    server's clock may be on another day at 8 pm in Texas). Falls back to UTC."""
    if isinstance(raw, str) and payouts._parse_iso(raw) is not None:
        return raw
    return _now().date().isoformat()


def _add_days(iso: str, n: int) -> str:
    d = payouts._parse_iso(iso)
    return (d + timedelta(days=n)).isoformat() if d else iso


def _role_of(pos, services_by_id):
    svc = services_by_id.get(pos.get("serviceId"))
    if svc is not None:
        code = svc.role or ""
        label = (code + " — " + svc.description).strip(" —") if svc.description else code
        return code, label or "Crew", svc.department or ""
    code = pos.get("role") or ""
    return code, code or "Crew", ""


def _pending_estimates(projects, contact_id) -> dict:
    """(project_id, date) → the pay locked at confirm (`pay.total`) for this
    crew member's days that are confirmed but not yet signed off — the same
    pre-sign-off estimate the Payouts tab shows. Flat-rate positions key on
    the project's end date. First match per key, like the frontend."""
    out = {}
    for proj in projects:
        pid = proj.get("id")
        for s in (proj.get("schedule") or []):
            if not isinstance(s, dict) or not s.get("date"):
                continue
            key = (pid, s["date"])
            if key in out:
                continue
            for p in (s.get("positions") or []):
                if isinstance(p, dict) and p.get("crewId") == contact_id and p.get("status") == "confirmed":
                    pay = p.get("pay") if isinstance(p.get("pay"), dict) else None
                    if pay is not None:
                        out[key] = payouts.js_round2(payouts._num(pay.get("total")))
                        break
        d = payouts.fixed_pay_date(proj.get("end_date"))
        if not d:
            continue
        for fp in (proj.get("fixed_positions") or []):
            if isinstance(fp, dict) and fp.get("crewId") == contact_id and fp.get("status") == "confirmed":
                pay = fp.get("pay") if isinstance(fp.get("pay"), dict) else None
                total = payouts.js_round2(payouts._num(pay.get("total"))) if pay is not None else payouts.js_round2(payouts._num(fp.get("fee")))
                key = (pid, d)
                out[key] = payouts.js_round2(out.get(key, 0.0) + total)
    return out


def _pp_settings(settings: dict) -> tuple[str, int, int]:
    anchor = settings.get("payPeriodAnchor") or _PP_DEFAULT_ANCHOR
    if payouts._parse_iso(anchor) is None:
        anchor = _PP_DEFAULT_ANCHOR
    try:
        length = int(settings.get("payPeriodLengthDays") or _PP_DEFAULT_LENGTH)
    except (TypeError, ValueError):
        length = _PP_DEFAULT_LENGTH
    try:
        offset = int(settings.get("payPeriodPayDayOffsetDays") if settings.get("payPeriodPayDayOffsetDays") is not None else _PP_DEFAULT_OFFSET)
    except (TypeError, ValueError):
        offset = _PP_DEFAULT_OFFSET
    return anchor, length, offset


async def _payouts_section(db, contact, projects, contacts_by_id, settings, today) -> dict:
    """This crew member's pay, bucketed into pay periods: the next one, the
    current one and the last few. Signed-off days carry the frozen figure the
    QuickBooks bill posts; confirmed-but-unsigned days carry the estimate
    locked at confirm; each period says whether its bill has been submitted
    and paid."""
    anchor, length, offset = _pp_settings(settings)
    cur = payouts.pay_period_index(anchor, length, today)
    if cur is None:
        return {"configured": False, "periods": [], "ytdPaid": 0, "pendingEstimate": 0}
    indices = list(range(cur + 1, cur - _PAYOUT_PERIODS_BACK - 1, -1))
    first = payouts.pay_period_for_index(anchor, length, indices[-1])
    last = payouts.pay_period_for_index(anchor, length, indices[0])
    drafts = payouts.derive_payout_drafts(projects, contacts_by_id, first["start"], last["end"])
    mine = next((d for d in drafts if d["contact_id"] == contact.id), None)
    estimates = _pending_estimates(projects, contact.id)

    bills = (await db.execute(select(models.PayoutBill).where(models.PayoutBill.contact_id == contact.id))).scalars().all()
    bill_by_period = {(b.period_start, b.period_end): b for b in bills}

    periods = []
    for idx in indices:
        pp = payouts.pay_period_for_index(anchor, length, idx)
        numbering = payouts.pay_period_number_in_year(anchor, length, idx) or {}
        days = []
        pending = []
        if mine:
            for d in mine["days"]:
                if pp["start"] <= d["date"] <= pp["end"]:
                    days.append({
                        "date": d["date"], "projectId": d["project_id"], "projectName": d["project_name"],
                        "tier": d["tier"], "state": d["state"], "payable": d["payable"],
                        "adjTotal": d["adj_total"], "adjustments": d["adjustments"],
                        "paidHours": d["paid_hours"], "otHours": d["ot_hours"], "flat": bool(d.get("flat")),
                    })
            for p in mine["pending"]:
                if pp["start"] <= p["date"] <= pp["end"]:
                    pending.append({
                        "date": p["date"], "projectId": p["project_id"], "projectName": p["project_name"],
                        "estimate": estimates.get((p["project_id"], p["date"])),
                        "flat": bool(p.get("flat")),
                    })
        bill = bill_by_period.get((pp["start"], pp["end"]))
        bill_out = None
        if bill is not None:
            bill_out = {
                "status": "paid" if bill.qb_paid_at else ("submitted" if bill.qb_bill_id else "open"),
                "docNumber": bill.doc_number, "amount": bill.amount,
                "submittedAt": _iso(bill.qb_synced_at), "paidAt": _iso(bill.qb_paid_at),
            }
        signed_total = payouts.js_round2(sum(d["payable"] for d in days))
        pending_estimate = payouts.js_round2(sum((p["estimate"] or 0) for p in pending))
        periods.append({
            "index": idx, "start": pp["start"], "end": pp["end"],
            "payDay": payouts.pay_period_pay_day(pp["end"], offset),
            "label": payouts.pay_period_label(pp["start"], pp["end"]),
            "number": numbering.get("number"), "year": numbering.get("year"),
            "current": idx == cur, "upcoming": idx > cur,
            "days": days, "pending": pending,
            "signedTotal": signed_total, "pendingEstimate": pending_estimate,
            "bill": bill_out,
        })

    year = today[:4]
    ytd = payouts.js_round2(sum(
        (b.amount or 0.0) for b in bills
        if b.qb_paid_at and (b.period_end or "")[:4] == year))
    all_pending = payouts.js_round2(sum(p["pendingEstimate"] for p in periods))
    return {"configured": True, "anchor": anchor, "lengthDays": length, "payDayOffsetDays": offset,
            "periods": periods, "ytdPaid": ytd, "pendingEstimate": all_pending}


async def _dashboard_payload(db, ident: CrewIdentity, today: str) -> dict:
    account, contact = ident.account, ident.contact
    cid = contact.id
    settings = await load_settings(db)
    services = (await db.execute(select(models.Service))).scalars().all()
    services_by_id = {s.id: s for s in services}
    proj_rows = (await db.execute(select(models.Project))).scalars().all()
    by_id = {p.id: p for p in proj_rows}

    # ── Requests: waiting on them, and recently answered ──────────────────
    reqs = (await db.execute(
        select(models.CrewRequest).where(models.CrewRequest.contact_id == cid)
        .order_by(models.CrewRequest.id.desc())
    )).scalars().all()
    healed = False
    pos_to_req = {}
    for r in reqs:
        if r.status in ("pending", "accepted") and crew_integrity.reconcile_one(r, by_id.get(r.project_id)):
            healed = True
        if r.status in ("pending", "accepted"):
            for pid in (r.position_ids or []):
                pos_to_req.setdefault(pid, r)
    if healed:
        await db.flush()
        livesync.mark_dirty(db, "crew-requests")

    async def _project_head(p):
        return {
            "projectId": p.id if p else None,
            "projectName": (p.name if p else "") or "Project",
            "venue": (p.venue if p else "") or "",
            "siteAddress": await _resolve_site_address(db, p) if p else "",
            "startDate": (p.start_date if p else "") or "",
            "endDate": (p.end_date if p else "") or "",
        }

    requests_out = []
    recent_out = []
    # "Answered recently" is measured from real time, not the calendar date the
    # browser sent: respondedAt is a server timestamp, and a phone whose clock
    # (or timezone) is off must not hide yesterday's answer.
    recent_floor = (_now() - timedelta(days=_RECENT_DAYS)).date().isoformat()
    for r in reqs:
        p = by_id.get(r.project_id)
        if r.status == "pending":
            if p is None:
                continue
            shifts = _crew_shifts(p, r.position_ids, services_by_id)
            head = await _project_head(p)
            head.update({
                "id": r.id, "token": r.token, "status": r.status,
                "sentAt": _iso(r.sent_at), "shifts": shifts, "askLabel": _ask_label(shifts),
            })
            requests_out.append(head)
        elif r.status in ("accepted", "declined") and not r.silent:
            responded = _aware(r.responded_at)
            if responded is None or responded.date().isoformat() < recent_floor:
                continue
            statuses = []
            if p is not None:
                ids = set(r.position_ids or [])
                for s in (p.schedule or []):
                    for pos in (s.get("positions") or []):
                        if pos.get("id") in ids:
                            statuses.append(pos.get("status"))
                for pos in _fixed_list(p):
                    if pos.get("id") in ids:
                        statuses.append(pos.get("status"))
            live = [s for s in statuses if s != "declined"]
            recent_out.append({
                "id": r.id, "token": r.token, "status": r.status,
                "projectId": r.project_id, "projectName": (p.name if p else "") or "Project",
                "respondedAt": _iso(r.responded_at), "comment": r.comment or "",
                "count": len(r.position_ids or []),
                "confirmed": bool(live) and all(s == "confirmed" for s in live),
                "released": r.status == "accepted" and bool(statuses) and not live,
            })
    requests_out.sort(key=lambda x: (x["startDate"] or "9999", x["projectName"]))
    recent_out.sort(key=lambda x: x["respondedAt"] or "", reverse=True)

    # ── Schedule: every position of theirs, split around today ───────────
    upcoming, past = [], []
    past_floor = _add_days(today, -_PAST_DAYS)
    for p in proj_rows:
        if (p.status or "") == "cancelled":
            continue
        head = None
        for s in (p.schedule or []):
            if not isinstance(s, dict):
                continue
            d = (s.get("date") or "").strip()
            if not d:
                continue
            for pos in (s.get("positions") or []):
                if not isinstance(pos, dict) or pos.get("crewId") != cid:
                    continue
                st = pos.get("status")
                if st not in _UPCOMING_STATUSES:
                    continue
                if d < today and (st != "confirmed" or d < past_floor):
                    continue
                if head is None:
                    head = await _project_head(p)
                code, label, dept = _role_of(pos, services_by_id)
                req = pos_to_req.get(pos.get("id"))
                work = pos.get("work") if isinstance(pos.get("work"), dict) else None
                entry = dict(head)
                entry.update({
                    "positionId": pos.get("id"), "date": d,
                    "startTime": s.get("time") or "", "endTime": s.get("endTime") or "",
                    "shiftTitle": s.get("title") or "", "role": code, "roleLabel": label,
                    "department": dept, "status": st, "note": (pos.get("note") or "").strip(),
                    "requestId": req.id if req else None, "requestToken": req.token if req else None,
                    "signedOff": bool(work and work.get("pay")),
                    "flat": False,
                })
                (upcoming if d >= today else past).append(entry)
        # Flat-rate positions: one entry for the whole project, listed while the
        # project's dates haven't passed (or when it has no dates at all).
        outline = None
        for fp in _fixed_list(p):
            if fp.get("crewId") != cid or fp.get("status") not in _UPCOMING_STATUSES:
                continue
            end = (p.end_date or "").strip() or (p.start_date or "").strip()
            is_past = bool(end) and end < today
            if is_past and (fp.get("status") != "confirmed" or end < past_floor):
                continue
            if head is None:
                head = await _project_head(p)
            if outline is None:
                outline = _project_date_outline(p)
            code, label, dept = _role_of(fp, services_by_id)
            req = pos_to_req.get(fp.get("id"))
            work = fp.get("work") if isinstance(fp.get("work"), dict) else None
            entry = dict(head)
            entry.update({
                "positionId": fp.get("id"), "date": (p.start_date or "").strip() or end,
                "startTime": "", "endTime": "", "shiftTitle": "", "role": code, "roleLabel": label,
                "department": dept, "status": fp.get("status"), "note": (fp.get("note") or "").strip(),
                "requestId": req.id if req else None, "requestToken": req.token if req else None,
                "signedOff": bool(work and work.get("pay")),
                "flat": True, "fee": payouts.js_round2(payouts._num(fp.get("fee"))),
                "projectStart": (p.start_date or ""), "projectEnd": (p.end_date or ""),
                "projectDates": outline,
            })
            (past if is_past else upcoming).append(entry)
    upcoming.sort(key=lambda e: (e["date"] or "9999", e["startTime"] or "", e["projectName"]))
    past.sort(key=lambda e: (e["date"] or "", e["startTime"] or ""), reverse=True)

    next_confirmed = next((e for e in upcoming if e["status"] == "confirmed"), None)
    stats = {
        "pendingRequests": len(requests_out),
        "awaitingConfirmation": sum(1 for e in upcoming if e["status"] == "accepted"),
        "confirmedUpcoming": sum(1 for e in upcoming if e["status"] == "confirmed"),
        "requestedUpcoming": sum(1 for e in upcoming if e["status"] == "requested"),
        "nextCall": next_confirmed,
    }

    projects_light = [{"id": p.id, "name": p.name or "", "schedule": p.schedule or [],
                       "fixed_positions": p.fixed_positions or [], "end_date": p.end_date or ""}
                      for p in proj_rows]
    contacts_by_id = {cid: {"id": cid, "first_name": contact.first_name or "", "last_name": contact.last_name or ""}}
    pay = await _payouts_section(db, contact, projects_light, contacts_by_id, settings, today)

    return {
        "today": today,
        "crew": _me_payload(account, contact),
        "requests": requests_out,
        "recent": recent_out,
        "upcoming": upcoming,
        "past": past,
        "stats": stats,
        "payouts": pay,
        "settings": public_settings(settings),
    }


def _dashboard_version(payload: dict) -> str:
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:16]


@crew_portal_router.get("/dashboard")
async def dashboard(request: Request, db: AsyncSession = Depends(get_db), ident: CrewIdentity = Depends(require_crew)):
    payload = await _dashboard_payload(db, ident, _parse_today(request.query_params.get("today")))
    payload["_v"] = _dashboard_version(payload)
    return payload


@crew_portal_router.get("/dashboard/version")
async def dashboard_version(request: Request, db: AsyncSession = Depends(get_db), ident: CrewIdentity = Depends(require_crew)):
    """Has anything on the dashboard moved? Same hash as the `_v` the
    dashboard hands over, over the same payload (see crew.py's version route
    for why the two must be computed from one shape)."""
    payload = await _dashboard_payload(db, ident, _parse_today(request.query_params.get("today")))
    return {"doc": _dashboard_version(payload), "app": livesync.app_version()}


@crew_portal_router.post("/requests/{req_id}/respond")
async def respond(req_id: int, body: dict, request: Request, db: AsyncSession = Depends(get_db),
                  ident: CrewIdentity = Depends(require_crew)):
    """Answer one of their own pending requests from the dashboard. Delegates
    to the same state machine the tokenized call sheet uses
    (routes/crew.py::_respond), so the two surfaces can never disagree."""
    body = _body_dict(body)
    decision = body.get("decision")
    if decision not in ("accept", "decline"):
        raise HTTPException(status_code=400, detail={"field": "decision", "reason": "must be accept or decline"})
    r = await db.execute(select(models.CrewRequest).where(models.CrewRequest.id == req_id))
    req = r.scalar_one_or_none()
    if req is None or req.contact_id != ident.contact.id:
        raise HTTPException(status_code=404, detail="not found")
    return await _respond(req.token, {"comment": body.get("comment") or ""}, request, db,
                          decision="accepted" if decision == "accept" else "declined")


# ── Staff: accounts, invitations, resets, the off-switch ────────────────────

def _account_status(account, open_invite) -> str:
    if account is not None:
        return "disabled" if account.disabled else "active"
    if open_invite is not None:
        return "invited"
    return "none"


async def _open_invites(db) -> dict:
    """contact_id → newest live invitation row."""
    rows = (await db.execute(
        select(models.CrewAuthToken)
        .where(models.CrewAuthToken.kind == "invite", models.CrewAuthToken.used_at.is_(None))
        .order_by(models.CrewAuthToken.id)
    )).scalars().all()
    out = {}
    for row in rows:
        if _token_state(row) == "live":
            out[row.contact_id] = row
    return out


def _account_row(contact_id, account, invite) -> dict:
    return {
        "contactId": contact_id,
        "status": _account_status(account, invite),
        "email": (account.email if account else (invite.email if invite else "")) or "",
        "invitedAt": _iso(invite.created_at) if invite else None,
        "inviteExpiresAt": _iso(invite.expires_at) if invite else None,
        "createdAt": _iso(account.created_at) if account else None,
        "lastLoginAt": _iso(account.last_login_at) if account else None,
        "lockedUntil": _iso(account.locked_until) if account and _aware(account.locked_until) and _aware(account.locked_until) > _now() else None,
    }


@crew_portal_admin_router.get("")
async def list_accounts(db: AsyncSession = Depends(get_db)):
    """Portal status for every crew contact that has one: an account (active
    or disabled) or a live invitation. Contacts absent from the list have
    never been invited — the roster reads that as 'not invited'."""
    accounts = (await db.execute(select(models.CrewAccount))).scalars().all()
    invites = await _open_invites(db)
    by_contact = {a.contact_id: a for a in accounts}
    ids = set(by_contact) | set(invites)
    return [_account_row(cid, by_contact.get(cid), invites.get(cid)) for cid in sorted(ids)]


async def _crew_contact_or_404(db, contact_id):
    contact = await _contact(db, contact_id)
    if contact is None:
        raise HTTPException(status_code=404, detail="contact not found")
    if not contact.is_crew:
        raise HTTPException(status_code=400, detail={"reason": "not_crew", "message": "This contact isn't on the crew roster."})
    return contact


@crew_portal_admin_router.post("/{contact_id}/invite")
async def invite(contact_id: int, db: AsyncSession = Depends(get_db), user: models.User = Depends(require_session)):
    """Mint an invitation for a crew member and email it as the acting user.
    Re-sending retires the earlier link. Refused for a contact who already has
    working access (send a password reset instead) — a disabled account may be
    re-invited, which re-enables it when accepted."""
    contact = await _crew_contact_or_404(db, contact_id)
    if not _crew_eligible(contact):
        raise HTTPException(status_code=400, detail={"reason": "inactive", "message": "Set this crew member to active before inviting them."})
    email = crew_auth.normalize_email(contact.email)
    if not email:
        raise HTTPException(status_code=400, detail={"reason": "no_email", "message": "Add an email address to the crew member first."})
    account = await _account_for_contact(db, contact.id)
    if account is not None and not account.disabled:
        raise HTTPException(status_code=409, detail={"reason": "already_active", "message": "This crew member already has portal access. Send a password reset instead."})
    other = await _account_for_email(db, email)
    if other is not None and (account is None or other.id != account.id):
        raise HTTPException(status_code=409, detail={"reason": "email_taken", "message": "Another crew account already uses this email address."})

    raw, row = await _mint_link(db, contact, "invite", email, created_by=user.id)
    url = _portal_url("signup/" + raw)
    status = await _send_portal_email(db, user, contact, "invite", url, await load_settings(db))
    out = _account_row(contact.id, account, row)
    out["emailStatus"] = status
    if not status.get("emailed"):
        # The link IS the credential, so it is handed over only as the
        # fallback when mail did not go out — the producer can text it.
        out["inviteUrl"] = url
    return out


@crew_portal_admin_router.post("/{contact_id}/reset")
async def staff_reset(contact_id: int, db: AsyncSession = Depends(get_db), user: models.User = Depends(require_session)):
    """Email a crew member a password-reset link, as the acting user. The link
    is never returned — a reset signs the holder in as that crew member."""
    contact = await _crew_contact_or_404(db, contact_id)
    account = await _account_for_contact(db, contact.id)
    if account is None:
        raise HTTPException(status_code=409, detail={"reason": "no_account", "message": "This crew member hasn't set up portal access yet — send an invitation."})
    if account.disabled:
        raise HTTPException(status_code=409, detail={"reason": "disabled", "message": "Enable this crew member's access first."})
    raw, _row = await _mint_link(db, contact, "reset", account.email, created_by=user.id)
    url = _portal_url("reset/" + raw)
    status = await _send_portal_email(db, user, contact, "reset", url, await load_settings(db))
    out = _account_row(contact.id, account, None)
    out["emailStatus"] = status
    return out


@crew_portal_admin_router.post("/{contact_id}/disable", dependencies=[Depends(require_admin)])
async def disable(contact_id: int, db: AsyncSession = Depends(get_db)):
    """Admin off-switch: the account stays (so a re-enable keeps the password)
    but every session is revoked and every open link retired."""
    contact = await _crew_contact_or_404(db, contact_id)
    account = await _account_for_contact(db, contact.id)
    if account is None:
        await _retire_tokens(db, contact.id)
        return _account_row(contact.id, None, None)
    account.disabled = True
    await db.flush()
    await _revoke_sessions(db, account.id)
    await _retire_tokens(db, contact.id)
    return _account_row(contact.id, account, None)


@crew_portal_admin_router.post("/{contact_id}/enable", dependencies=[Depends(require_admin)])
async def enable(contact_id: int, db: AsyncSession = Depends(get_db)):
    contact = await _crew_contact_or_404(db, contact_id)
    account = await _account_for_contact(db, contact.id)
    if account is None:
        raise HTTPException(status_code=409, detail={"reason": "no_account", "message": "This crew member hasn't set up portal access yet — send an invitation."})
    account.disabled = False
    account.failed_attempts = 0
    account.locked_until = None
    await db.flush()
    return _account_row(contact.id, account, None)
