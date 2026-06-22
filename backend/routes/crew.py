"""Crew request — tokenized accept/decline + producer send/withdraw.

Two routers, mirroring the split that already exists for quotes/invoices
(public token surface in view.py, session-gated CRUD in api.py):

  PUBLIC (no session — the token IS the credential, like /api/view):
    GET  /api/crew/{token}          → sanitized crew-facing payload
    POST /api/crew/{token}/accept   → body {comment?}; pending → accepted
    POST /api/crew/{token}/decline  → body {comment?}; pending → declined

  PRODUCER (session-gated, under /api/crew-requests):
    GET  /api/crew-requests              → list (optionally ?projectId=)
    POST /api/crew-requests/send         → body {projectId, contactId, positionIds?}
    POST /api/crew-requests/{id}/withdraw → pending → withdrawn

The accept/decline flow drives the POSITION status machine that the Labor
module already understands (components/status-enums.js). Positions live in
Project.schedule[].positions[] (JSON); we mutate their `status` in place and
flag_modified the column. See backend/models.py CrewRequest for the full
state machine.

Security model (reuses the hardened patterns from SECURITY_REVIEW.md):
  - token minted server-side via secrets.token_urlsafe(32) (~256 bits), never
    client-set, never echoed on the public payload (the holder already has it).
  - the public GET payload is an ALLOW-LIST: only this crew member's own shifts
    + branding; no cost, no internal notes, no other crew, no FK ids.
  - accept/decline are idempotent (409 once terminal) and capture IP/UA for
    non-repudiation (internal-only — never surfaced on the payload).
  - /api/crew is rate-limited (backend/rate_limit.py) like /api/view.
"""
from datetime import datetime, timezone
from html import escape
import os
import re
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from backend import gmail, models, view_tracking
from backend.auth_deps import require_session
from backend.database import get_db
from backend.routes._shared import load_settings, public_settings
from backend.routes.email import _render_signature, _app_origin
from backend.sanitize import email_html


# Public — no session dependency. Token is the credential.
crew_public_router = APIRouter(prefix="/api/crew", tags=["crew"])
# Producer — every route requires a valid session.
crew_admin_router = APIRouter(
    prefix="/api/crew-requests", tags=["crew"],
    dependencies=[Depends(require_session)],
)

# Position statuses a request may be SENT against (assigned-but-not-yet-sent,
# or previously declined and being re-asked). Accepted/confirmed positions are
# deliberately excluded so a re-send can't clobber a settled hire.
_SENDABLE_FROM = {"open", "declined"}
# Terminal request statuses — once here, accept/decline are locked.
_TERMINAL = {"accepted", "declined", "withdrawn"}


# ── Shared helpers ─────────────────────────────────────────────────────────

async def _find_request_by_token(db: AsyncSession, token: str):
    """Return the CrewRequest for `token`, or None. The length floor blunts
    garbage/enumeration lookups before they hit the index (mirrors view.py)."""
    if not token or len(token) < 8:
        return None
    r = await db.execute(select(models.CrewRequest).where(models.CrewRequest.token == token))
    return r.scalar_one_or_none()


async def _load_project(db: AsyncSession, project_id):
    if project_id is None:
        return None
    r = await db.execute(select(models.Project).where(models.Project.id == project_id))
    return r.scalar_one_or_none()


def _update_positions(project, position_ids, *, to_status, require_from=None) -> int:
    """Set status=to_status on every position in project.schedule whose id is
    in position_ids — optionally only when its current status is in
    `require_from`. Mutates the JSON in place and flag_modifies the column so
    SQLAlchemy persists it. Returns the number of positions changed."""
    ids = set(position_ids or [])
    if not ids:
        return 0
    changed = 0
    schedule = project.schedule or []
    for shift in schedule:
        for pos in (shift.get("positions") or []):
            if pos.get("id") not in ids:
                continue
            if require_from is not None and pos.get("status") not in require_from:
                continue
            pos["status"] = to_status
            changed += 1
    if changed:
        flag_modified(project, "schedule")
    return changed


def _crew_shifts(project, position_ids, services_by_id) -> list:
    """Build the crew-facing shift list for `position_ids`, resolving role
    labels server-side (the public page has no services catalog). Allow-list
    only — never carries crewId, serviceId internals, or other crew's slots."""
    ids = set(position_ids or [])
    out = []
    for shift in (project.schedule or []):
        for pos in (shift.get("positions") or []):
            if pos.get("id") not in ids:
                continue
            svc = services_by_id.get(pos.get("serviceId"))
            if svc is not None:
                role_label = (svc.role or "")
                if svc.description:
                    role_label = (role_label + " — " + svc.description).strip(" —")
                dept = svc.department or ""
            else:
                role_label = pos.get("role") or ""
                dept = ""
            out.append({
                "positionId": pos.get("id"),
                "roleLabel": role_label or "Crew",
                "department": dept,
                "status": pos.get("status"),
                "shiftTitle": shift.get("title") or "",
                "date": shift.get("date") or "",
                "startTime": shift.get("time") or "",
                "endTime": shift.get("endTime") or "",
            })
    out.sort(key=lambda s: (s["date"] or "", s["startTime"] or ""))
    return out


def _request_dict(r: models.CrewRequest) -> dict:
    """Producer-facing serialization. Includes the token so the Labor UI can
    surface/copy the crew link; this is the authenticated producer's own data.
    The PUBLIC payload (below) deliberately never includes the token."""
    return {
        "id": r.id,
        "token": r.token,
        "projectId": r.project_id,
        "contactId": r.contact_id,
        "positionIds": r.position_ids or [],
        "status": r.status,
        "comment": r.comment or "",
        "sentAt": r.sent_at.isoformat() if r.sent_at else None,
        "respondedAt": r.responded_at.isoformat() if r.responded_at else None,
        "sentByUserId": r.sent_by_user_id,
    }


# ── Crew-request email (composed server-side, sent best-effort) ─────────────
#
# Unlike the quote/invoice pipeline (frontend composes, /api/email/send relays
# with per-recipient tracking), the crew email is rendered entirely server-side
# from the workspace `crewRequest` template and sent as the producer who clicked
# Send. There's no per-recipient open-tracking row — the request token already
# identifies the crew member. Delivery is BEST-EFFORT: a failure never rolls
# back the request (the producer can still copy the crew link).

# Server-side fallback body — keep in sync with data/settings.js
# emailTemplates.crewRequest.body so a fresh deploy (settings never saved) still
# sends a sensible email. {{header}}/{{shifts}}/{{signature}} are HTML fragments
# substituted after the text→HTML pass; {{crewName}}/{{projectName}} are text.
_FALLBACK_CREW_BODY = (
    "Hi {{crewName}},\n\n"
    "We'd like to book you for an upcoming project. Please review the details "
    "below and let us know if you can take it.\n\n"
    "{{header}}\n\n{{shifts}}\n\n"
    "Questions? Just reply to this email and we'll be glad to help.\n\n"
    "{{signature}}"
)

# Brand defaults — mirror data/settings.js (accentColor, logoUrl) so a themed
# email still renders before any Settings save. The LTP stacked logo doubles as
# the signature photo fallback (theme.js window.LTP_SIGNATURE_PHOTO_FALLBACK).
_DEFAULT_ACCENT = "#E8731A"
# The brand's vibrant orange used on the primary CTA button (same hue as the
# quote/invoice "View & Accept or Decline" button) — punchier than the muted
# accent used for borders/edges.
_CTA_ORANGE = "#EF5822"
_LTP_LOGO_URL = (
    "https://www.luminarytechnology.productions/wp-content/uploads/2024/07/LTP-Logo-Stacked.png"
)

# Shared body-paragraph style — explicit font-family so template text renders
# identically everywhere (don't rely on inheritance across table boundaries,
# which some mail clients drop).
_BODY_P_STYLE = ("margin:0 0 14px;font-size:14px;line-height:1.6;color:#3d4852;"
                 "font-family:'Helvetica Neue',Helvetica,Arial,sans-serif")


def _fmt_iso_date(iso: str) -> str:
    try:
        from datetime import date
        y, m, d = (int(x) for x in (iso or "").split("-"))
        return date(y, m, d).strftime("%a, %b ") + str(d) + ", " + str(y)
    except Exception:
        return iso or ""


def _fmt_hhmm(t: str) -> str:
    try:
        hh, mm = (t or "").split(":")[:2]
        hh = int(hh)
        return f"{hh % 12 or 12}:{mm} {'AM' if hh < 12 else 'PM'}"
    except Exception:
        return t or ""


def _safe_color(c: str, fallback: str) -> str:
    """Only let a #-hex color into inline styles (defense in depth — the value
    is admin-set in Settings and email_html also sanitizes CSS, but validating
    here keeps a malformed value from quietly breaking the layout)."""
    c = (c or "").strip()
    return c if re.match(r"^#[0-9a-fA-F]{3,8}$", c) else fallback


def _safe_url(u: str, fallback: str = "") -> str:
    u = (u or "").strip()
    return u if u[:8].lower() == "https://" or u[:7].lower() == "http://" else fallback


def _email_brand(settings_data: dict) -> dict:
    """Workspace branding for themed crew emails, from the proper Settings
    variables (accentColor, logoUrl, companyName, website)."""
    return {
        "accent": _safe_color(settings_data.get("accentColor"), _DEFAULT_ACCENT),
        "logo": _safe_url(settings_data.get("logoUrl"), _LTP_LOGO_URL),
        "company": (settings_data.get("companyName") or "").strip() or "Luminary Technology & Productions",
        "website": (settings_data.get("website") or "").strip(),
    }


def _crew_shifts_html(shifts: list, accent: str) -> str:
    """Themed shift list — one accent-edged card per shift. Date + time on one
    line, the day description (shiftTitle) on its own line beneath so a long
    row doesn't wrap onto two lines."""
    rows = []
    for s in shifts:
        when = _fmt_iso_date(s.get("date"))
        rng = " – ".join([x for x in (_fmt_hhmm(s.get("startTime")), _fmt_hhmm(s.get("endTime"))) if x])
        when_time = "&nbsp;&nbsp;·&nbsp;&nbsp;".join([escape(x) for x in (when, rng) if x])
        title = escape(s.get("shiftTitle") or "")
        line_dt = ('<div style="font-size:12px;color:#7a838c;margin-top:3px">' + when_time + '</div>') if when_time else ""
        line_title = ('<div style="font-size:12px;font-weight:600;color:#9aa3ab;margin-top:2px">' + title + '</div>') if title else ""
        rows.append(
            '<tr><td style="padding:11px 14px;border:1px solid #eceef0;border-left:3px solid ' + accent + ';'
            'background-color:#ffffff;border-radius:6px">'
            '<div style="font-size:14px;font-weight:bold;color:#233038">' + escape(s.get("roleLabel") or "Crew") + '</div>'
            + line_dt + line_title +
            '</td></tr><tr><td style="font-size:0;line-height:0;padding:0">&nbsp;</td></tr>'
        )
    if not rows:
        return ""
    return ('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
            'style="width:100%;margin:8px 0 2px">' + "".join(rows) + "</table>")


def _crew_header_html(project_name: str, shift_count: int, view_url: str, accent: str) -> str:
    """Themed call-to-action card with a single accent button that opens the
    crew landing page (where Accept / Decline + the note actually happen).
    One button — both responses live on the same page, so two links here would
    be redundant."""
    url = escape(view_url)
    n = str(shift_count) + " shift" + ("" if shift_count == 1 else "s")
    return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
        'style="width:100%;margin:6px 0;background-color:#f7f9fa;border:1px solid #eceef0;border-radius:10px">'
        '<tr><td style="padding:22px;text-align:center">'
        '<div style="font-size:12px;color:#8a949e;text-transform:uppercase;letter-spacing:0.06em">You\'re requested for</div>'
        '<div style="font-size:19px;font-weight:bold;color:#233038;margin:4px 0 2px">' + escape(project_name or "Project") + '</div>'
        '<div style="font-size:12px;color:#8a949e;margin-bottom:18px">' + n + ' — review the details and respond</div>'
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto"><tr>'
        '<td style="background-color:' + _CTA_ORANGE + ';border-radius:7px">'
        '<a href="' + url + '" style="display:inline-block;padding:14px 38px;font-size:15px;font-weight:bold;'
        'color:#ffffff;text-decoration:none">View &amp; Respond</a></td>'
        '</tr></table>'
        '</td></tr></table>'
    )


def _paragraphs_to_html(text: str, blocks: dict | None = None) -> str:
    """Plain-text body → HTML. Blank lines split paragraphs; text is escaped.
    A paragraph that is *exactly* a block token (e.g. "{{shifts}}") is emitted
    as that block's HTML — a sibling, NOT wrapped in <p>. That avoids both the
    invalid table-inside-<p> the sanitizer would hoist apart AND the empty
    <p></p> gaps it left behind, which made spacing look inconsistent above vs.
    below the header. Inline tokens (a token mid-sentence) are still substituted."""
    blocks = blocks or {}
    out = []
    for para in (text or "").split("\n\n"):
        p = para.strip()
        if p == "":
            continue
        if p in blocks:
            out.append(blocks[p])
            continue
        html_p = '<p style="' + _BODY_P_STYLE + '">' + escape(p).replace("\n", "<br>") + "</p>"
        for tok, frag in blocks.items():
            if tok in html_p:
                html_p = html_p.replace(tok, frag)
        out.append(html_p)
    return "".join(out)


def _crew_email_shell(inner_html: str, brand: dict) -> str:
    """Wrap composed crew-email content in the themed, branded responsive
    layout (light canvas, centered 600px card, logo masthead, footer)."""
    accent = brand["accent"]
    company = escape(brand["company"])
    if brand["logo"]:
        masthead = ('<img src="' + escape(brand["logo"]) + '" alt="' + company + '" height="72" '
                    'style="display:block;border:0;width:auto;max-width:100%;margin:0 auto">')
    else:
        masthead = ('<span style="font-size:22px;font-weight:bold;color:' + accent + ';'
                    'letter-spacing:0.03em">' + company + '</span>')
    footer = company + (('&nbsp;&nbsp;·&nbsp;&nbsp;' + escape(brand["website"])) if brand["website"] else "")
    # width:100% + max-width (NOT a fixed width:600px) so the card fills a phone
    # screen and stays centered — a hard 600px overflows and looks off-center.
    return (
        '<div style="background-color:#f1f3f5;padding:24px 10px;'
        "font-family:'Helvetica Neue',Helvetica,Arial,sans-serif\">"
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#f1f3f5">'
        '<tr><td align="center">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
        'style="width:100%;max-width:580px;background-color:#ffffff;border:1px solid #e6e8eb;border-radius:14px">'
        '<tr><td style="padding:24px 28px 16px;text-align:center;border-bottom:3px solid ' + accent + '">' + masthead + '</td></tr>'
        '<tr><td style="padding:22px 28px 26px">' + inner_html + '</td></tr>'
        '</table>'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:580px">'
        '<tr><td style="padding:16px 28px 4px;text-align:center;font-size:11px;line-height:1.6;color:#9aa3ab">' + footer + '</td></tr>'
        '</table>'
        '</td></tr></table></div>'
    )


def _render_crew_request_body(body_tmpl, *, crew_name, project_name, company, brand, shifts, view_url, signature_html) -> str:
    """Compose the inner (card) HTML for a crew request: template body →
    paragraphs, with the themed {{header}} CTA, {{shifts}} list, and
    {{signature}} substituted in."""
    body = ((body_tmpl or _FALLBACK_CREW_BODY)
            .replace("{{crewName}}", crew_name)
            .replace("{{projectName}}", project_name)
            .replace("{{companyName}}", company))
    return _paragraphs_to_html(body, {
        "{{header}}": _crew_header_html(project_name, len(shifts), view_url, brand["accent"]),
        "{{shifts}}": _crew_shifts_html(shifts, brand["accent"]),
        "{{signature}}": signature_html,
    })


async def _send_crew_email(db, user, contact, project, shifts, token, settings_data) -> dict:
    """Render + send the crew-request email as `user`. Returns an email-status
    dict; NEVER raises — delivery is best-effort so a Gmail outage or a
    not-yet-connected sender doesn't undo the request (producer copies the
    link instead). emailStatus.needsReconnect drives the UI's reconnect hint."""
    try:
        tmpl = ((settings_data.get("emailTemplates") or {}).get("crewRequest") or {})
        brand = _email_brand(settings_data)
        company = brand["company"]
        crew_name = ((contact.first_name or "") + " " + (contact.last_name or "")).strip() or "there"
        project_name = (project.name if project else "") or "Project"
        view_url = (_app_origin() or "") + "/#/crew/" + token

        subject = ((tmpl.get("subject") or "Crew request: {{projectName}}")
                   .replace("{{projectName}}", project_name)
                   .replace("{{crewName}}", crew_name)
                   .replace("{{companyName}}", company))

        inner = _render_crew_request_body(
            tmpl.get("body"), crew_name=crew_name, project_name=project_name,
            company=company, brand=brand, shifts=shifts, view_url=view_url,
            signature_html=_render_signature(user, settings_data),
        )
        final_html = email_html(_crew_email_shell(inner, brand))

        reply_to = (settings_data.get("emailReplyTo") or "").strip() or None
        await gmail.send(
            user=user, db=db,
            client_id=os.environ.get("GOOGLE_CLIENT_ID", ""),
            client_secret=os.environ.get("GOOGLE_CLIENT_SECRET", ""),
            to=[contact.email], cc=[], subject=subject,
            html_body=final_html, text_body=None, reply_to=reply_to,
        )
        return {"emailed": True, "to": contact.email}
    except gmail.GmailReconnectRequired as e:
        return {"emailed": False, "needsReconnect": True, "error": str(e)}
    except gmail.GmailSendError as e:
        return {"emailed": False, "error": str(e)}
    except Exception as e:
        print(f"[LTP] crew email send failed: {e!r}", flush=True)
        return {"emailed": False, "error": "unexpected error sending email"}


# Informational crew notifications (confirmed / cancelled / not-selected). Unlike
# the request email these carry NO Accept/Decline header — they're one-way — and
# resolve the legacy single-shift template vars ({{role}}/{{date}}/{{callTime}}/…)
# from a representative position, so the shipped template bodies AND their
# Settings previews stay valid without a redesign.
_CREW_NOTIFY_TEMPLATES = {"crewConfirmed", "crewCancelled", "crewNotSelected"}


async def _send_crew_notify(db, user, contact, project, shifts, template_key, settings_data) -> dict:
    """Best-effort send of a crew notification email. NEVER raises (mirrors
    _send_crew_email): a delivery failure must not undo the producer's
    confirm/release/cancel, which already happened client-side."""
    if not (contact and contact.email):
        return {"emailed": False, "error": "no email on file"}
    try:
        tmpl = ((settings_data.get("emailTemplates") or {}).get(template_key) or {})
        brand = _email_brand(settings_data)
        first = shifts[0] if shifts else {}
        repl = {
            "{{companyName}}": brand["company"],
            "{{crewName}}": ((contact.first_name or "") + " " + (contact.last_name or "")).strip() or "there",
            "{{projectName}}": (project.name if project else "") or "Project",
            "{{role}}": first.get("roleLabel") or "",
            "{{date}}": _fmt_iso_date(first.get("date")) if first.get("date") else "",
            "{{callTime}}": _fmt_hhmm(first.get("startTime")) if first.get("startTime") else "",
            "{{wrapTime}}": _fmt_hhmm(first.get("endTime")) if first.get("endTime") else "",
            "{{location}}": (project.venue if project else "") or "",
        }

        def _sub(t):
            for k, v in repl.items():
                t = t.replace(k, v)
            return t

        subject = _sub(tmpl.get("subject") or "{{projectName}}")
        inner = _paragraphs_to_html(_sub(tmpl.get("body") or ""), {"{{signature}}": _render_signature(user, settings_data)})
        final_html = email_html(_crew_email_shell(inner, brand))
        reply_to = (settings_data.get("emailReplyTo") or "").strip() or None
        await gmail.send(
            user=user, db=db,
            client_id=os.environ.get("GOOGLE_CLIENT_ID", ""),
            client_secret=os.environ.get("GOOGLE_CLIENT_SECRET", ""),
            to=[contact.email], cc=[], subject=subject,
            html_body=final_html, text_body=None, reply_to=reply_to,
        )
        return {"emailed": True, "to": contact.email}
    except gmail.GmailReconnectRequired as e:
        return {"emailed": False, "needsReconnect": True, "error": str(e)}
    except gmail.GmailSendError as e:
        return {"emailed": False, "error": str(e)}
    except Exception as e:
        print(f"[LTP] crew notify ({template_key}) failed: {e!r}", flush=True)
        return {"emailed": False, "error": "unexpected error sending email"}


# ── PUBLIC: GET /api/crew/{token} ───────────────────────────────────────────

@crew_public_router.get("/{token}")
async def get_crew_request(token: str, db: AsyncSession = Depends(get_db)):
    """Sanitized crew-facing payload. Exposes only this crew member's shifts on
    this request + branding — no cost, no internal notes, no other crew, and
    never the token itself (the holder already has it in their URL)."""
    req = await _find_request_by_token(db, token)
    if req is None:
        raise HTTPException(status_code=404, detail="not found")

    project = await _load_project(db, req.project_id)
    contact = None
    if req.contact_id is not None:
        r = await db.execute(select(models.Contact).where(models.Contact.id == req.contact_id))
        contact = r.scalar_one_or_none()
    services = (await db.execute(select(models.Service))).scalars().all()
    services_by_id = {s.id: s for s in services}
    settings = await load_settings(db)

    shifts = _crew_shifts(project, req.position_ids, services_by_id) if project else []
    crew_name = ((contact.first_name or "") + " " + (contact.last_name or "")).strip() if contact else ""

    return {
        "status": req.status,
        "crewName": crew_name,
        "comment": req.comment or "",
        "respondedAt": req.responded_at.isoformat() if req.responded_at else None,
        "project": {
            "name": project.name if project else "",
            "venue": project.venue if project else "",
            "startDate": project.start_date if project else "",
            "endDate": project.end_date if project else "",
        },
        "shifts": shifts,
        "settings": public_settings(settings),
    }


# ── PUBLIC: POST /api/crew/{token}/accept | /decline ────────────────────────

async def _respond(token: str, body: dict, request: Request, db: AsyncSession, *, decision: str):
    """Shared accept/decline. `decision` ∈ {"accepted", "declined"} and is also
    the target position status. Idempotent: 409 once the request is terminal."""
    req = await _find_request_by_token(db, token)
    if req is None:
        raise HTTPException(status_code=404, detail="not found")
    if not isinstance(body, dict):
        body = {}
    comment = (body.get("comment") or "").strip()
    if len(comment) > 1000:
        raise HTTPException(status_code=400, detail={"field": "comment", "reason": "max 1000 chars"})

    if req.status != "pending":
        raise HTTPException(
            status_code=409,
            detail={"status": req.status, "message": f"request is already {req.status}"},
        )

    project = await _load_project(db, req.project_id)
    if project is not None:
        # Only move positions still sitting at `requested` — never override a
        # slot the producer already settled out-of-band.
        _update_positions(project, req.position_ids, to_status=decision, require_from={"requested"})

    now = datetime.now(timezone.utc)
    ip, ua = view_tracking.extract_client_meta(request)
    req.status = decision
    req.responded_at = now
    req.comment = comment
    req.respondent_ip = ip or None
    req.respondent_ua = (ua or "")[:300] or None
    await db.flush()
    return {"status": decision}


@crew_public_router.post("/{token}/accept")
async def accept_crew_request(token: str, body: dict, request: Request, db: AsyncSession = Depends(get_db)):
    return await _respond(token, body, request, db, decision="accepted")


@crew_public_router.post("/{token}/decline")
async def decline_crew_request(token: str, body: dict, request: Request, db: AsyncSession = Depends(get_db)):
    return await _respond(token, body, request, db, decision="declined")


# ── PRODUCER: GET /api/crew-requests ────────────────────────────────────────

@crew_admin_router.get("")
async def list_crew_requests(projectId: int | None = None, db: AsyncSession = Depends(get_db)):
    q = select(models.CrewRequest).order_by(models.CrewRequest.id)
    if projectId is not None:
        q = q.where(models.CrewRequest.project_id == projectId)
    rows = (await db.execute(q)).scalars().all()
    return [_request_dict(r) for r in rows]


# ── PRODUCER: POST /api/crew-requests/send ──────────────────────────────────

@crew_admin_router.post("/send")
async def send_crew_request(
    body: dict,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(require_session),
):
    """Create a crew request covering a crew member's sendable positions on a
    project, flip those positions open/declined → requested, and return the
    request (with token + crew link). Defaults to the WHOLE project; pass
    `positionIds` to send only a subset (split a project into multiple
    requests). Emails the crew member their Accept/Decline link (best-effort —
    a delivery failure leaves the request intact; see emailStatus in the
    response).

    Validates the crew member exists, is crew, and has an email on file."""
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")
    project_id = body.get("projectId")
    contact_id = body.get("contactId")
    if not isinstance(project_id, int) or isinstance(project_id, bool):
        raise HTTPException(status_code=400, detail={"field": "projectId", "reason": "required integer"})
    if not isinstance(contact_id, int) or isinstance(contact_id, bool):
        raise HTTPException(status_code=400, detail={"field": "contactId", "reason": "required integer"})

    project = await _load_project(db, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail={"field": "projectId", "reason": "project not found"})
    r = await db.execute(select(models.Contact).where(models.Contact.id == contact_id))
    contact = r.scalar_one_or_none()
    if contact is None:
        raise HTTPException(status_code=404, detail={"field": "contactId", "reason": "contact not found"})
    if not contact.is_crew:
        raise HTTPException(status_code=400, detail={"field": "contactId", "reason": "contact is not a crew member"})
    if not (contact.email or "").strip():
        raise HTTPException(status_code=400, detail={"field": "contactId", "reason": "crew member has no email on file"})

    # Optional subset selection. When omitted/empty → whole project (every
    # sendable position assigned to this crew member).
    requested_ids = body.get("positionIds")
    explicit = isinstance(requested_ids, list) and len(requested_ids) > 0
    explicit_set = {str(x) for x in requested_ids} if explicit else None

    sendable = []
    for shift in (project.schedule or []):
        for pos in (shift.get("positions") or []):
            if pos.get("crewId") != contact_id:
                continue
            if explicit and str(pos.get("id")) not in explicit_set:
                continue
            if pos.get("status") in _SENDABLE_FROM:
                sendable.append(pos.get("id"))

    if not sendable:
        raise HTTPException(
            status_code=400,
            detail={"reason": "no sendable positions — assign this crew member to open positions on the project first"},
        )

    req = models.CrewRequest(
        token=secrets.token_urlsafe(32),
        project_id=project_id,
        contact_id=contact_id,
        position_ids=sendable,
        status="pending",
        sent_by_user_id=user.id,
    )
    db.add(req)
    _update_positions(project, sendable, to_status="requested", require_from=_SENDABLE_FROM)
    await db.flush()
    await db.refresh(req)

    # Compose + send the crew-request email (best-effort). A delivery failure
    # (e.g. the sender hasn't connected Gmail) leaves the request intact — the
    # producer can copy the crew link from the response/Labor UI instead.
    services = (await db.execute(select(models.Service))).scalars().all()
    services_by_id = {s.id: s for s in services}
    shifts = _crew_shifts(project, sendable, services_by_id)
    settings_data = await load_settings(db)
    email_status = await _send_crew_email(db, user, contact, project, shifts, req.token, settings_data)

    out = _request_dict(req)
    out["emailStatus"] = email_status
    return out


# ── PRODUCER: POST /api/crew-requests/{id}/withdraw ─────────────────────────

@crew_admin_router.post("/{req_id}/withdraw")
async def withdraw_crew_request(
    req_id: int,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(require_session),
):
    """Withdraw a still-PENDING request: its positions go requested → open and
    the request → withdrawn. A request the crew already answered
    (accepted/declined) is NOT silently reopened — that returns 409 so the
    producer uses the Labor status controls instead. Idempotent on an
    already-withdrawn request."""
    r = await db.execute(select(models.CrewRequest).where(models.CrewRequest.id == req_id))
    req = r.scalar_one_or_none()
    if req is None:
        raise HTTPException(status_code=404, detail="not found")
    if req.status == "withdrawn":
        return _request_dict(req)
    if req.status != "pending":
        raise HTTPException(
            status_code=409,
            detail={"status": req.status, "message": f"cannot withdraw a {req.status} request; use the Labor controls"},
        )
    project = await _load_project(db, req.project_id)
    if project is not None:
        _update_positions(project, req.position_ids, to_status="open", require_from={"requested"})
    req.status = "withdrawn"
    await db.flush()
    await db.refresh(req)
    return _request_dict(req)


# ── PRODUCER: POST /api/crew-requests/{id}/resend ───────────────────────────

@crew_admin_router.post("/{req_id}/resend")
async def resend_crew_request(
    req_id: int,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(require_session),
):
    """Re-send the request email for a still-PENDING request (same token, same
    shifts) — for when the crew member lost the original. No new request is
    created and positions are untouched. 409 if the request was already
    answered or withdrawn (nothing to chase). Returns the request + emailStatus."""
    r = await db.execute(select(models.CrewRequest).where(models.CrewRequest.id == req_id))
    req = r.scalar_one_or_none()
    if req is None:
        raise HTTPException(status_code=404, detail="not found")
    if req.status != "pending":
        raise HTTPException(
            status_code=409,
            detail={"status": req.status, "message": f"cannot resend a {req.status} request"},
        )
    project = await _load_project(db, req.project_id)
    contact = (await db.execute(select(models.Contact).where(models.Contact.id == req.contact_id))).scalar_one_or_none()
    if contact is None:
        raise HTTPException(status_code=404, detail="crew contact not found")
    services = (await db.execute(select(models.Service))).scalars().all()
    shifts = _crew_shifts(project, req.position_ids, {s.id: s for s in services}) if project else []
    settings_data = await load_settings(db)
    email_status = await _send_crew_email(db, user, contact, project, shifts, req.token, settings_data)
    out = _request_dict(req)
    out["emailStatus"] = email_status
    return out


# ── PRODUCER: POST /api/crew-requests/notify ────────────────────────────────

@crew_admin_router.post("/notify")
async def crew_notify(
    body: dict,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(require_session),
):
    """Send an informational crew email (confirmed / cancelled / not-selected)
    to a crew member as the producer. Composed server-side from the named
    template; delivery is best-effort (returns emailStatus, never rolls back
    the producer's status change). Body: {contactId, projectId, template,
    positionIds?}."""
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")
    contact_id = body.get("contactId")
    project_id = body.get("projectId")
    template = body.get("template")
    position_ids = body.get("positionIds") or []
    if not isinstance(contact_id, int) or isinstance(contact_id, bool):
        raise HTTPException(status_code=400, detail={"field": "contactId", "reason": "required integer"})
    if not isinstance(project_id, int) or isinstance(project_id, bool):
        raise HTTPException(status_code=400, detail={"field": "projectId", "reason": "required integer"})
    if template not in _CREW_NOTIFY_TEMPLATES:
        raise HTTPException(status_code=400, detail={"field": "template", "reason": f"must be one of {sorted(_CREW_NOTIFY_TEMPLATES)}"})

    project = await _load_project(db, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    contact = (await db.execute(select(models.Contact).where(models.Contact.id == contact_id))).scalar_one_or_none()
    if contact is None:
        raise HTTPException(status_code=404, detail="crew contact not found")
    services = (await db.execute(select(models.Service))).scalars().all()
    shifts = _crew_shifts(project, position_ids, {s.id: s for s in services})
    settings_data = await load_settings(db)
    email_status = await _send_crew_notify(db, user, contact, project, shifts, template, settings_data)
    return {"emailStatus": email_status}
