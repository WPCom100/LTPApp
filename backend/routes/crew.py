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

from backend import crew_integrity, gmail, livesync, models, view_tracking, webpush
from backend.auth_deps import require_session
from backend.database import get_db
from backend.email_compose import (
    _CTA_ORANGE, _app_origin, _email_brand, _fmt_hhmm, _fmt_iso_date,
    _paragraphs_to_html, _render_signature, email_shell,
)
from backend.routes._shared import load_settings, public_settings
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


def _update_positions(project, position_ids, *, to_status, require_from=None, clear_crew=False) -> int:
    """Set status=to_status on every position in project.schedule whose id is
    in position_ids — optionally only when its current status is in
    `require_from`. With `clear_crew`, also unassign the crew member (crewId=None)
    — used on withdraw so the reopened slot returns to an empty selection rather
    than still showing the withdrawn person. Mutates the JSON in place and
    flag_modifies the column so SQLAlchemy persists it. Returns the number of
    positions changed."""
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
            if clear_crew:
                pos["crewId"] = None
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
                role_code = (svc.role or "")
                role_label = role_code
                if svc.description:
                    role_label = (role_label + " — " + svc.description).strip(" —")
                dept = svc.department or ""
            else:
                role_code = pos.get("role") or ""
                role_label = role_code
                dept = ""
            out.append({
                "positionId": pos.get("id"),
                # `role` is the bare role acronym (A1, L1, …) for the calendar
                # event title; `roleLabel` is the human line (acronym — description).
                "role": role_code,
                "roleLabel": role_label or "Crew",
                "department": dept,
                "status": pos.get("status"),
                # Producer-authored per-shift note (parking, gate code, wardrobe …)
                # set on the Assignments tab. Shown under the call on the page + email.
                "note": (pos.get("note") or "").strip(),
                "shiftTitle": shift.get("title") or "",
                "date": shift.get("date") or "",
                "startTime": shift.get("time") or "",
                "endTime": shift.get("endTime") or "",
            })
    out.sort(key=lambda s: (s["date"] or "", s["startTime"] or ""))
    return out


def _coerce_shifts(raw) -> list:
    """Sanitize a client-supplied shift snapshot (the notify tray sends these for
    a removal whose live positions are already gone — a deleted day or project).
    Allow-list string fields only, capped, so nothing untrusted flows verbatim
    into the email beyond the same fields _crew_shifts would have produced."""
    out = []
    if not isinstance(raw, list):
        return out
    for s in raw[:200]:
        if not isinstance(s, dict):
            continue
        out.append({
            "roleLabel": str(s.get("roleLabel") or "")[:200],
            "shiftTitle": str(s.get("shiftTitle") or "")[:200],
            "date": str(s.get("date") or "")[:40],
            "startTime": str(s.get("startTime") or "")[:20],
            "endTime": str(s.get("endTime") or "")[:20],
            "note": str(s.get("note") or "")[:1000],
            # Previous date/time — set only by a schedule-change notice so the
            # card can render "Updated from …". Absent (empty) for every other
            # notify template, which renders exactly as before.
            "prevDate": str(s.get("prevDate") or "")[:40],
            "prevStartTime": str(s.get("prevStartTime") or "")[:20],
            "prevEndTime": str(s.get("prevEndTime") or "")[:20],
        })
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
        # True = booked directly (no email, no crew answer). Drives the
        # "Booked directly" badge in Labor → Crew Requests, so a booking the
        # crew member never saw doesn't read as one they accepted.
        "silent": bool(r.silent),
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



async def _resolve_site_address(db, project) -> str:
    """Street address of the job site for crew-facing surfaces (request email,
    public crew page, notify {{location}}). When the project opts into the
    client company's billing address it's resolved LIVE here — so a company
    address edit flows into future sends without re-saving the project — and
    the typed site_address is the fallback either way."""
    if project is None:
        return ""
    if getattr(project, "site_use_company_address", False) and project.company_id:
        r = await db.execute(select(models.Company).where(models.Company.id == project.company_id))
        c = r.scalar_one_or_none()
        if c:
            street = ", ".join(ln.strip() for ln in (c.address or "").splitlines() if ln.strip())
            locality = " ".join(x for x in [(c.state or "").strip(), (c.zip or "").strip()] if x)
            tail = ", ".join(x for x in [(c.city or "").strip(), locality] if x)
            addr = ", ".join(x for x in [street, tail] if x)
            if addr:
                return addr
    return ", ".join(ln.strip() for ln in (project.site_address or "").splitlines() if ln.strip())


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
        # "Updated from …" — a schedule-change notice carries the prior date/time
        # (prev*); when it actually differs from the current one, spell out what
        # moved so the crew see old → new. Every other notify template leaves
        # prev* empty, so this line never renders for them.
        prev_when = _fmt_iso_date(s.get("prevDate")) if s.get("prevDate") else ""
        prev_rng = " – ".join([x for x in (_fmt_hhmm(s.get("prevStartTime")), _fmt_hhmm(s.get("prevEndTime"))) if x])
        prev_dt = "&nbsp;&nbsp;·&nbsp;&nbsp;".join([escape(x) for x in (prev_when, prev_rng) if x])
        line_prev = ('<div style="font-size:11px;color:#b26a00;margin-top:3px">Updated from:&nbsp;' + prev_dt + '</div>') if (prev_dt and prev_dt != when_time) else ""
        # Producer's per-shift note (parking, gate code, etc.) — its own line under
        # the call, accent-tinted so it reads as an instruction, not chrome.
        note = escape(s.get("note") or "").replace("\n", "<br>")
        line_note = ('<div style="font-size:12px;color:#3d4852;margin-top:6px;padding:7px 10px;'
                     'background-color:#f7f9fa;border-radius:5px;border-left:2px solid ' + accent + '">'
                     + note + '</div>') if note else ""
        rows.append(
            '<tr><td style="padding:11px 14px;border:1px solid #eceef0;border-left:3px solid ' + accent + ';'
            'background-color:#ffffff;border-radius:6px">'
            '<div style="font-size:14px;font-weight:bold;color:#233038">' + escape(s.get("roleLabel") or "Crew") + '</div>'
            + line_dt + line_prev + line_title + line_note +
            '</td></tr><tr><td style="font-size:0;line-height:0;padding:0">&nbsp;</td></tr>'
        )
    if not rows:
        return ""
    # margin-bottom gives the shift list real separation from the text that
    # follows it. It used to be 2px, which left the next paragraph jammed right
    # under the last card (blank lines in the template can't fix it — they're
    # collapsed by _paragraphs_to_html). 16px ≈ the body paragraph rhythm.
    return ('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
            'style="width:100%;margin:8px 0 16px">' + "".join(rows) + "</table>")


def _add_to_calendar_cta(view_url: str, accent: str) -> str:
    """A single 'Add to Calendar' button that opens the crew call sheet, where
    the per-shift Google-Calendar buttons live. Email clients can't run the
    calendar-link JS reliably and multi-shift button grids read as clutter, so
    the email just routes the crew back to the page. Empty when no link (no
    token) is available."""
    if not view_url:
        return ""
    url = escape(view_url)
    return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:8px 0 4px">'
        '<tr><td style="text-align:center;padding:6px 0 14px">'
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto"><tr>'
        '<td style="background-color:' + accent + ';border-radius:7px">'
        '<a href="' + url + '" style="display:inline-block;padding:13px 34px;font-size:15px;font-weight:bold;'
        'color:#ffffff;text-decoration:none">Click here to add to calendar</a></td>'
        '</tr></table>'
        '<div style="font-size:11px;color:#8a949e;margin-top:9px">Opens your call sheet — add each call in one tap.</div>'
        '</td></tr></table>'
    )


def _crew_header_html(project_name: str, shift_count: int, view_url: str, accent: str, site_address: str = "") -> str:
    """Themed call-to-action card with a single accent button that opens the
    crew landing page (where Accept / Decline + the note actually happen).
    One button — both responses live on the same page, so two links here would
    be redundant."""
    url = escape(view_url)
    n = str(shift_count) + " shift" + ("" if shift_count == 1 else "s")
    loc = ('<div style="font-size:12px;color:#8a949e;margin:0 0 2px">' + escape(site_address) + '</div>') if site_address else ""
    return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
        'style="width:100%;margin:6px 0;background-color:#f7f9fa;border:1px solid #eceef0;border-radius:10px">'
        '<tr><td style="padding:22px;text-align:center">'
        '<div style="font-size:12px;color:#8a949e;text-transform:uppercase;letter-spacing:0.06em">You\'re requested for</div>'
        '<div style="font-size:19px;font-weight:bold;color:#233038;margin:4px 0 2px">' + escape(project_name or "Project") + '</div>'
        + loc +
        '<div style="font-size:12px;color:#8a949e;margin-bottom:18px">' + n + ' — review the details and respond</div>'
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto"><tr>'
        '<td style="background-color:' + _CTA_ORANGE + ';border-radius:7px">'
        '<a href="' + url + '" style="display:inline-block;padding:14px 38px;font-size:15px;font-weight:bold;'
        'color:#ffffff;text-decoration:none">View &amp; Respond</a></td>'
        '</tr></table>'
        '</td></tr></table>'
    )




def _render_crew_request_body(body_tmpl, *, crew_name, project_name, company, brand, shifts, view_url, signature_html, site_address="") -> str:
    """Compose the inner (card) HTML for a crew request: template body →
    paragraphs, with the themed {{header}} CTA, {{shifts}} list, and
    {{signature}} substituted in. {{location}} carries the job-site address for
    templates that want it inline; the header card shows it regardless."""
    body = ((body_tmpl or _FALLBACK_CREW_BODY)
            .replace("{{crewName}}", crew_name)
            .replace("{{projectName}}", project_name)
            .replace("{{companyName}}", company)
            .replace("{{location}}", site_address))
    return _paragraphs_to_html(body, {
        "{{header}}": _crew_header_html(project_name, len(shifts), view_url, brand["accent"], site_address),
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
            site_address=await _resolve_site_address(db, project),
        )
        final_html = email_html(email_shell(inner, brand))

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
_CREW_NOTIFY_TEMPLATES = {"crewConfirmed", "crewCancelled", "crewNotSelected", "crewWithdrawn", "crewScheduleChanged", "crewShiftNote"}

# Server-side fallbacks for the notify templates, used when the workspace hasn't
# saved that template to the DB yet (load_settings reads the DB, which doesn't
# carry the data/settings.js defaults until an admin clicks Save). These are
# pinned because the notify tray / Confirm & Notify can send any of them before
# settings are saved, so an empty body would be a broken email. The removal
# notices list {{shifts}} (the tray groups per person); crewConfirmed lists
# {{addToCalendar}} so a fresh deploy's confirmation still carries the calendar
# button. MUST stay in sync with data/settings.js byte-for-byte.
_NOTIFY_FALLBACKS = {
    "crewConfirmed": {
        "subject": "Confirmed: {{projectName}} — {{date}}",
        "body": ("Hi {{crewName}},\n\nYou are confirmed for the following:\n\n"
                 "Project: {{projectName}}\nRole: {{role}}\nDate: {{date}}\n"
                 "Call: {{callTime}}\nWrap: {{wrapTime}}\nLocation: {{location}}\n\n"
                 "Please reach out if you have any questions. We look forward to "
                 "working with you.\n\n{{addToCalendar}}\n\n{{signature}}"),
    },
    "crewWithdrawn": {
        "subject": "Update: {{projectName}} — crew request withdrawn",
        "body": ("Hi {{crewName}},\n\nWe've withdrawn our crew request for "
                 "{{projectName}} — no response is needed on the following "
                 "shifts:\n\n{{shifts}}\n\nThank you for your time, and we'll keep "
                 "you in mind for future projects.\n\n{{signature}}"),
    },
    "crewCancelled": {
        "subject": "Schedule Update: {{projectName}} — position cancelled",
        "body": ("Hi {{crewName}},\n\nWe're writing to let you know that your "
                 "confirmed position on {{projectName}} has been cancelled. The "
                 "following shifts are affected:\n\n{{shifts}}\n\nWe apologize for "
                 "any inconvenience and hope to work with you on future "
                 "projects.\n\n{{signature}}"),
    },
    "crewNotSelected": {
        "subject": "Update: {{projectName}}",
        "body": ("Hi {{crewName}},\n\nThank you for your interest and availability "
                 "for {{projectName}}. Unfortunately, we've gone in a different "
                 "direction and won't be needing your services for the following "
                 "shifts:\n\n{{shifts}}\n\nWe appreciate your willingness to work "
                 "with us and will absolutely keep you in mind for upcoming "
                 "opportunities.\n\n{{signature}}"),
    },
    "crewScheduleChanged": {
        "subject": "Schedule Update: {{projectName}} — shift times changed",
        "body": ("Hi {{crewName}},\n\nThe schedule for {{projectName}} has been "
                 "updated. Please review your revised shift details below — the "
                 "previous time is noted on each shift that moved:\n\n{{shifts}}\n\n"
                 "If the new schedule doesn't work for you, just reply to this "
                 "email and let us know.\n\n{{signature}}"),
    },
    "crewShiftNote": {
        "subject": "Note added: {{projectName}}",
        "body": ("Hi {{crewName}},\n\nThere's a new note for your confirmed "
                 "call on {{projectName}} — please review it below:\n\n{{shifts}}\n\n"
                 "Any questions, just reply to this email.\n\n{{signature}}"),
    },
}


async def _send_crew_notify(db, user, contact, project, shifts, template_key, settings_data, project_name=None, token=None) -> dict:
    """Best-effort send of a crew notification email. NEVER raises (mirrors
    _send_crew_email): a delivery failure must not undo the producer's
    confirm/release/cancel, which already happened client-side.

    `project_name` overrides the display name — used when the notify tray flushes
    a removal after its project was deleted (project is None by then, but the
    snapshot carried the name). `token` is the crew-request token, used only by
    the crewConfirmed template to link its "Add to Calendar" button to the call
    sheet."""
    if not (contact and contact.email):
        # Permanently undeliverable, not a transient failure — flagged so the
        # notify tray drops the notice instead of parking it forever to retry
        # (crew booked directly need never have an email on file).
        return {"emailed": False, "noEmail": True, "error": "no email on file"}
    try:
        tmpl = ((settings_data.get("emailTemplates") or {}).get(template_key) or {})
        brand = _email_brand(settings_data)
        first = shifts[0] if shifts else {}
        project_name = project_name or (project.name if project else "") or "Project"
        # {{location}} = venue name + job-site address when both exist — the
        # venue names the place, the address gets the crew there.
        site_address = await _resolve_site_address(db, project)
        location = " — ".join(x for x in [((project.venue if project else "") or "").strip(), site_address] if x)
        repl = {
            "{{companyName}}": brand["company"],
            "{{crewName}}": ((contact.first_name or "") + " " + (contact.last_name or "")).strip() or "there",
            "{{role}}": first.get("roleLabel") or "",
            "{{date}}": _fmt_iso_date(first.get("date")) if first.get("date") else "",
            "{{callTime}}": _fmt_hhmm(first.get("startTime")) if first.get("startTime") else "",
            "{{wrapTime}}": _fmt_hhmm(first.get("endTime")) if first.get("endTime") else "",
            "{{location}}": location,
        }

        def _sub(t):
            for k, v in repl.items():
                t = t.replace(k, v)
            return t

        # Subject is plain text — substitute the project name plainly there.
        subject = _sub(tmpl.get("subject") or _NOTIFY_FALLBACKS.get(template_key, {}).get("subject") or "{{projectName}}").replace("{{projectName}}", project_name)
        body_text = _sub(tmpl.get("body") or _NOTIFY_FALLBACKS.get(template_key, {}).get("body") or "")
        # {{shifts}} renders the themed shift list (same block the request email
        # uses) so a withdrawal can spell out exactly which shifts it covers. The
        # block is offered to every notify template; single-position notices
        # (confirmed/cancelled/not-selected) simply don't reference it.
        # {{projectName}} is rendered as a block too so it can carry markup —
        # BOLD in the withdrawal email, plain elsewhere — surviving the escaping
        # _paragraphs_to_html applies to the surrounding text.
        project_html = ("<strong>" + escape(project_name) + "</strong>") if template_key == "crewWithdrawn" else escape(project_name)
        signature_html = _render_signature(user, settings_data)
        blocks = {
            "{{projectName}}": project_html,
            "{{shifts}}": _crew_shifts_html(shifts, brand["accent"]) if shifts else "",
            "{{signature}}": signature_html,
        }
        # Confirmation email: a single "Click here to add to calendar" button that
        # routes the crew back to their call sheet, where the per-shift calendar
        # buttons live (email clients can't run the calendar-link JS reliably).
        # The button is injected above the signature for any saved body that
        # predates the {{addToCalendar}} token, so it always renders on a confirmation.
        if template_key == "crewConfirmed":
            view_url = ((_app_origin() or "") + "/#/crew/" + token) if token else ""
            cal_html = _add_to_calendar_cta(view_url, _CTA_ORANGE)
            blocks["{{addToCalendar}}"] = cal_html
            if cal_html and "{{addToCalendar}}" not in body_text:
                blocks["{{signature}}"] = cal_html + signature_html
        inner = _paragraphs_to_html(body_text, blocks)
        final_html = email_html(email_shell(inner, brand))
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
    # Heal staleness on read: a link whose shifts were removed (or whose project
    # was deleted) is auto-withdrawn here too, so the crew always lands on the
    # "this request has been withdrawn" screen even if the producer-side hooks /
    # sweep haven't run yet. A no-op once the request is already terminal.
    if crew_integrity.reconcile_one(req, project):
        await db.flush()
        livesync.mark_dirty(db, "crew-requests")
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
            "siteAddress": await _resolve_site_address(db, project),
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
    # Stale guard: if the shifts were removed (or the project deleted) out from
    # under this request, refuse — the crew member sees the withdrawn screen on
    # reload (the GET heal / the project save+delete hooks persist the actual
    # withdrawal; this path just blocks the response and rolls back). A partial
    # removal only trims position_ids and falls through, so they answer for the
    # shifts that remain (that trim IS persisted, by the flush at the end).
    if crew_integrity.reconcile_one(req, project) and req.status == "withdrawn":
        raise HTTPException(
            status_code=409,
            detail={"status": "withdrawn", "message": "This request has been withdrawn."},
        )
    if project is not None:
        # Move positions sitting at `requested` — or at `open`, which for ids
        # the reconcile guard above just vetted (still this member's, on a
        # dated shift) can only be drift from a stale project save that
        # reverted the send. Slots the producer already settled out-of-band
        # (accepted / declined / confirmed) are still never overridden.
        changed = _update_positions(project, req.position_ids, to_status=decision,
                                    require_from={"requested", "open"})
        expected = len(req.position_ids or [])
        if changed != expected:
            # An answer that doesn't fully land is the zombie this pipeline
            # used to create silently — keep a trace either way.
            print(f"[LTP] crew {decision}: request {req.id} advanced "
                  f"{changed}/{expected} positions (rest already settled)", flush=True)

    now = datetime.now(timezone.utc)
    ip, ua = view_tracking.extract_client_meta(request)
    req.status = decision
    req.responded_at = now
    req.comment = comment
    req.respondent_ip = ip or None
    req.respondent_ua = (ua or "")[:300] or None
    await db.flush()
    # A crew member answering is the canonical "changed behind the producer's
    # back" write: it moves position statuses on the PROJECT row as well as the
    # request. Publishing both is what lets the producer's already-open Labor
    # tab resolve the project, show the shift name, and render Confirm — the
    # three things that needed a hard refresh before live sync.
    livesync.mark_dirty(db, "crew-requests", "projects")

    # Push-notify the producer who sent this request. Crew accept/decline had no
    # in-app channel before — the producer only found out by re-opening Labor —
    # so this is the first event wired to Web Push (backend/webpush.py). Fully
    # best-effort: send_to_user swallows push-service errors and a missing/failed
    # subscription must never turn a crew member's valid response into a 500.
    try:
        if req.sent_by_user_id:
            contact = None
            if req.contact_id is not None:
                r = await db.execute(
                    select(models.Contact).where(models.Contact.id == req.contact_id)
                )
                contact = r.scalar_one_or_none()
            crew_name = (
                ((contact.first_name or "") + " " + (contact.last_name or "")).strip()
                if contact else ""
            ) or "A crew member"
            project_name = (project.name if project else "") or "a project"
            n = len(req.position_ids or [])
            title = f"{crew_name} {decision} a crew request"
            body = project_name + " · " + str(n) + (" shift" if n == 1 else " shifts")
            if comment:
                body += " · “" + comment + "”"
            url = f"/#/projects/{req.project_id}" if req.project_id else "/#/dashboard"
            await webpush.send_to_user(db, req.sent_by_user_id, title, body, url)
    except Exception as e:  # never let notification wiring break the response
        print(f"[LTP] crew {decision}: push notify failed for request {req.id}: {e}", flush=True)

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
    # Heal stale requests on read: trims any whose shifts were removed and
    # auto-withdraws the fully-orphaned ones (including ones orphaned before this
    # engine existed, so opening the tab cleans up the existing backlog). The
    # frontend already hides withdrawn requests, so they simply drop out.
    # ONLY publish when the heal actually changed something. Marking this GET
    # dirty unconditionally would be a refetch loop: an unchanged collection that
    # is explicitly marked still gets its stamp bumped (see livesync.refresh),
    # so every list would tell every window to list again, forever.
    if await crew_integrity.reconcile_all(db):
        livesync.mark_dirty(db, "crew-requests", "projects")
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

    Validates the crew member exists, is crew, and has an email on file.

    Body `{silent: true}` books DIRECTLY instead: for a crew member the
    producer already agreed with off-platform. No email is composed or sent,
    the positions go straight open/declined → confirmed, and the request is
    stored as an already-answered `accepted` row flagged `silent=True`. An
    email address is not required in this mode — that's the point: a crew
    member who only takes texts can still be booked and paid. Emailing stays
    the default; the UI makes this the deliberate second action."""
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")
    project_id = body.get("projectId")
    contact_id = body.get("contactId")
    if not isinstance(project_id, int) or isinstance(project_id, bool):
        raise HTTPException(status_code=400, detail={"field": "projectId", "reason": "required integer"})
    if not isinstance(contact_id, int) or isinstance(contact_id, bool):
        raise HTTPException(status_code=400, detail={"field": "contactId", "reason": "required integer"})
    silent = body.get("silent") is True

    project = await _load_project(db, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail={"field": "projectId", "reason": "project not found"})
    r = await db.execute(select(models.Contact).where(models.Contact.id == contact_id))
    contact = r.scalar_one_or_none()
    if contact is None:
        raise HTTPException(status_code=404, detail={"field": "contactId", "reason": "contact not found"})
    if not contact.is_crew:
        raise HTTPException(status_code=400, detail={"field": "contactId", "reason": "contact is not a crew member"})
    # An email is the delivery address for the ask — required to send one,
    # irrelevant when booking directly (nothing is being delivered).
    if not silent and not (contact.email or "").strip():
        raise HTTPException(status_code=400, detail={"field": "contactId", "reason": "crew member has no email on file"})

    # Optional subset selection. When omitted/empty → whole project (every
    # sendable position assigned to this crew member).
    requested_ids = body.get("positionIds")
    explicit = isinstance(requested_ids, list) and len(requested_ids) > 0
    explicit_set = {str(x) for x in requested_ids} if explicit else None

    sendable = []
    for shift in (project.schedule or []):
        # An unscheduled day (no date) is never a valid availability ask — a crew
        # member can't be booked for a day that hasn't been scheduled. Skip its
        # positions so a request/email can't be sent against a dateless shift,
        # even via a direct API call (the Labor UI already hides these).
        if not (shift.get("date") or "").strip():
            continue
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
            detail={"reason": "no sendable positions — assign this crew member to a scheduled day (with a date) on the project first"},
        )

    # A direct book is already answered: it records an agreement the producer
    # made off-platform, so it opens at `accepted` with its positions
    # confirmed. The token is still minted (the column is NOT NULL and unique,
    # and the row stays a normal request for everything downstream), but it is
    # never emailed or rendered into a link — nothing can reach the public
    # landing page for it.
    req = models.CrewRequest(
        token=secrets.token_urlsafe(32),
        project_id=project_id,
        contact_id=contact_id,
        position_ids=sendable,
        status="accepted" if silent else "pending",
        silent=silent,
        responded_at=datetime.now(timezone.utc) if silent else None,
        sent_by_user_id=user.id,
    )
    db.add(req)
    _update_positions(project, sendable,
                      to_status="confirmed" if silent else "requested",
                      require_from=_SENDABLE_FROM)
    await db.flush()
    await db.refresh(req)
    livesync.mark_dirty(db, "crew-requests", "projects")

    out = _request_dict(req)
    if silent:
        # Nothing was sent, by design — report it explicitly so the UI can say
        # so rather than leaving the producer wondering whether mail failed.
        out["emailStatus"] = {"emailed": False, "silent": True}
        return out

    # Compose + send the crew-request email (best-effort). A delivery failure
    # (e.g. the sender hasn't connected Gmail) leaves the request intact — the
    # producer can copy the crew link from the response/Labor UI instead.
    services = (await db.execute(select(models.Service))).scalars().all()
    services_by_id = {s.id: s for s in services}
    shifts = _crew_shifts(project, sendable, services_by_id)
    settings_data = await load_settings(db)
    out["emailStatus"] = await _send_crew_email(db, user, contact, project, shifts, req.token, settings_data)
    return out


# ── PRODUCER: POST /api/crew-requests/{id}/withdraw ─────────────────────────

@crew_admin_router.post("/{req_id}/withdraw")
async def withdraw_crew_request(
    req_id: int,
    body: dict | None = None,
    db: AsyncSession = Depends(get_db),
    user: models.User = Depends(require_session),
):
    """Withdraw a still-PENDING request: its positions go requested → open and
    the request → withdrawn. A request the crew already answered
    (accepted/declined) is NOT silently reopened — that returns 409 so the
    producer uses the Labor status controls instead. Idempotent on an
    already-withdrawn request.

    Body `{notify: true}` also emails the crew member that the request was
    withdrawn (the crewWithdrawn template, best-effort — like send/notify, a
    delivery failure never rolls back the withdrawal). Returns `emailStatus`
    when an email was attempted."""
    r = await db.execute(select(models.CrewRequest).where(models.CrewRequest.id == req_id))
    req = r.scalar_one_or_none()
    if req is None:
        raise HTTPException(status_code=404, detail="not found")
    if req.status == "withdrawn":
        return _request_dict(req)            # idempotent — already gone, don't re-email
    if req.status != "pending":
        raise HTTPException(
            status_code=409,
            detail={"status": req.status, "message": f"cannot withdraw a {req.status} request; use the Labor controls"},
        )
    project = await _load_project(db, req.project_id)
    if project is not None:
        # Reopen the shifts AND unassign the crew member — a withdrawn ask returns
        # the slot to an empty selection, not "still penciled in".
        _update_positions(project, req.position_ids, to_status="open", require_from={"requested"}, clear_crew=True)
    req.status = "withdrawn"
    await db.flush()
    await db.refresh(req)
    livesync.mark_dirty(db, "crew-requests", "projects")

    out = _request_dict(req)
    if bool((body or {}).get("notify")):
        contact = (await db.execute(select(models.Contact).where(models.Contact.id == req.contact_id))).scalar_one_or_none()
        services = (await db.execute(select(models.Service))).scalars().all()
        shifts = _crew_shifts(project, req.position_ids, {s.id: s for s in services}) if project else []
        settings_data = await load_settings(db)
        out["emailStatus"] = await _send_crew_notify(db, user, contact, project, shifts, "crewWithdrawn", settings_data)
    return out


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
    positionIds?, shifts?, projectName?}. When `shifts` (a snapshot) is given it
    is used verbatim and the project may be gone (the notify tray flushing a
    removal whose day/project was deleted); otherwise shifts are resolved live
    from positionIds and the project must exist."""
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")
    contact_id = body.get("contactId")
    project_id = body.get("projectId")
    template = body.get("template")
    position_ids = body.get("positionIds") or []
    explicit_shifts = body.get("shifts")
    project_name_override = body.get("projectName")
    # Optional crew-request token — lets the crewConfirmed email link its
    # "Add to Calendar" button back to the call sheet. Validated loosely (a
    # short/garbage value just yields no button rather than a broken link).
    token = body.get("token")
    token = token if isinstance(token, str) and len(token) >= 8 else None
    if not isinstance(contact_id, int) or isinstance(contact_id, bool):
        raise HTTPException(status_code=400, detail={"field": "contactId", "reason": "required integer"})
    if not isinstance(project_id, int) or isinstance(project_id, bool):
        raise HTTPException(status_code=400, detail={"field": "projectId", "reason": "required integer"})
    if template not in _CREW_NOTIFY_TEMPLATES:
        raise HTTPException(status_code=400, detail={"field": "template", "reason": f"must be one of {sorted(_CREW_NOTIFY_TEMPLATES)}"})

    project = await _load_project(db, project_id)
    # A snapshot send tolerates a deleted project; a live (positionIds) send
    # still needs it to resolve the shifts.
    if project is None and explicit_shifts is None:
        raise HTTPException(status_code=404, detail="project not found")
    contact = (await db.execute(select(models.Contact).where(models.Contact.id == contact_id))).scalar_one_or_none()
    if contact is None:
        raise HTTPException(status_code=404, detail="crew contact not found")
    if explicit_shifts is not None:
        shifts = _coerce_shifts(explicit_shifts)
    else:
        services = (await db.execute(select(models.Service))).scalars().all()
        shifts = _crew_shifts(project, position_ids, {s.id: s for s in services})
    settings_data = await load_settings(db)
    project_name = project_name_override if isinstance(project_name_override, str) and project_name_override.strip() else None
    email_status = await _send_crew_notify(db, user, contact, project, shifts, template, settings_data, project_name=project_name, token=token)
    return {"emailStatus": email_status}
