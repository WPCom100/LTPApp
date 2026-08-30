"""QuickBooks-driven automatic payment receipts.

Background poller + server-side composer that emails a client their payment
receipt as soon as the linked QuickBooks invoice is marked paid (its QB
``Balance`` reaches 0). Mirrors what an admin does manually today — the
"Send Receipt" modal that pops after an in-app payment settles the balance —
but driven by QuickBooks instead of an in-app click, on a poll cadence.

Why poll instead of a webhook
=============================
A webhook would need a public, authenticated endpoint and Intuit subscription
plumbing. The owner asked to "sync every couple of hours," and the candidate
set (linked invoices not yet receipted) is tiny for this business, so a simple
periodic poll — started from the FastAPI lifespan exactly like the session
sweeper in backend/main.py — is the right amount of machinery.

Sender identity (owner's decision)
==================================
Every auto-receipt is sent from the Gmail of the admin who connected
QuickBooks (``QboConnection.connected_by_user_id``). If that admin's Gmail is
unavailable (never granted / token revoked / refresh fails mid-cycle), the
receipt is CACHED — ``receipt_email_status='pending'`` — and retried on each
later cycle, so it goes out once "the admin's Gmail connection is
reestablished." Reconciling the invoice to paid still happens regardless (that
is QuickBooks truth); only the email waits.

Two OAuth clients, never interchangeable
========================================
A cycle touches TWO different OAuth apps: the QuickBooks app credentials
(``QBO_CLIENT_ID``/``QBO_CLIENT_SECRET`` via ``qbo_sync.creds()``) authenticate
the QB API fetch, and the Google app credentials
(``GOOGLE_CLIENT_ID``/``GOOGLE_CLIENT_SECRET``) refresh the sender's Gmail token
for the send — exactly the creds routes/email.py and routes/crew.py use for
their sends. They are NOT interchangeable: handing the QuickBooks client to
Google's token endpoint returns ``invalid_client`` ("The OAuth client was not
found"), which surfaces as a GmailSendError and a failed receipt even though
manual quote/invoice sends (which use the Google creds) work fine.

Idempotency
===========
``Invoice.receipt_email_status`` is the state machine (null → pending/failed →
sent). The poller only looks at invoices whose status is null/pending/failed,
and the manual "Send Receipt" path stamps 'sent' too (routes/email.py), so a
client is never double-receipted from the two paths.

Server-side composition
=======================
Customer emails are normally composed in the browser and relayed through
POST /api/email/send. The poller has no browser, so this module reproduces that
pipeline server-side: resolve the ``paymentReceipt`` template, render the
themed {{header}} action box (the Python twin of theme.js::LTP_renderHeader for
kind="receipt"), substitute {{signature}} + per-recipient {{viewUrl}}, wrap in
the shared ``email_shell``, and hand the result to ``gmail.send`` — reusing the
helpers in routes/email.py and routes/crew.py so an auto-receipt is
byte-for-byte the same shape as a manually sent one.
"""
import os
import re
import secrets
from datetime import datetime, timezone
from html import escape

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from backend import gmail, models, qbo_sync, quickbooks, webpush
from backend.database import async_session
from backend.email_compose import (
    _build_view_url, _email_brand, _fmt_iso_date, _paragraphs_to_html,
    _render_signature, email_shell,
)
from backend.email_validate import RecipientError, parse_recipients
from backend.routes._shared import doc_display_name, load_settings
from backend.sanitize import email_html


# Safety cap on QB fetches per cycle so a misconfiguration can't turn the loop
# into an unbounded API storm. Logged when hit. Far above any realistic count
# of open-and-unreceipted invoices for this business.
_MAX_INVOICES_PER_CYCLE = 200

# Treated as "paid in full." QB balances are currency, but compare with a small
# epsilon so floating dust never reads as an outstanding balance.
_PAID_EPSILON = 0.01


# ── Money / date / line-item formatting (mirror modules/invoices.js) ─────────

def _num(x) -> float:
    try:
        return float(x or 0)
    except (TypeError, ValueError):
        return 0.0


def _money(amount) -> str:
    """'$1,234.50'. Receipts always show two decimals."""
    return "${:,.2f}".format(_num(amount))


_METHOD_LABELS = {
    "check": "Check", "ach": "ACH", "credit_card": "Credit Card",
    "cash": "Cash", "wire": "Wire", "other": "Other", "quickbooks": "QuickBooks",
}


def _payment_lines(payments: list) -> str:
    """One indented line per payment — the same shape openReceiptModal builds:
    '  Fri, Jun 12, 2026 — $1,234.50 via QuickBooks (ref)'."""
    out = []
    for p in (payments or []):
        when = _fmt_iso_date(p.get("date"))
        method = _METHOD_LABELS.get(p.get("method"), p.get("method") or "")
        ref = (p.get("reference") or "").strip()
        out.append("  " + when + " — " + _money(p.get("amount")) + " via " + method
                   + ((" (" + ref + ")") if ref else ""))
    return "\n".join(out)


# ── Receipt {{header}} action box (Python twin of theme.js LTP_renderHeader) ──

def render_receipt_header(ref_number: str, project_name: str, total: str) -> str:
    """The themed receipt action box: reference + project + total summary and a
    single "View Receipt" button linking to {{viewUrl}} (left literal here — the
    send path swaps in the per-recipient tracked URL, exactly like the browser).

    Structurally identical to theme.js::LTP_renderHeader(kind="receipt", …) so an
    auto-receipt's header matches a manually-composed one. The summary values are
    HTML-escaped (defense in depth; the whole body is bleach-sanitized downstream
    too)."""
    ref = escape(ref_number or "")
    proj = escape(project_name or "")
    tot = escape(total or "")
    return (
        '<div style="padding:0px">'
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" '
        'style="width:100%;margin-top:5px;background-color:#f7f9fa;border:1px solid #eceef0;border-radius:10px">'
        '<tbody><tr><td style="padding:22px;text-align:center">'
        '<div style="font-size:12px;color:#8a949e;text-transform:uppercase;letter-spacing:0.06em">' + ref + '</div>'
        '<div style="font-size:19px;font-weight:bold;color:#233038;margin:4px 0 2px">' + proj + '</div>'
        '<div style="font-size:14px;color:#233038;margin-bottom:18px">' + tot + '</div>'
        '<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:0 auto">'
        '<tbody><tr><td style="background-color:#f15927;border-radius:7px">'
        '<a href="{{viewUrl}}" style="display:inline-block;padding:14px 38px;font-size:15px;'
        'font-weight:bold;color:#ffffff;text-decoration:none">View Receipt</a>'
        '</td></tr></tbody></table>'
        '</td></tr></tbody></table></div>'
    )


# Fallbacks if the workspace never customized the paymentReceipt template (the
# rich default lives in data/settings.js, not the DB, until an admin saves
# Settings). Kept in sync with modules/invoices.js openReceiptModal.
# Fallback used ONLY when the DB has no saved paymentReceipt template — a fresh
# deploy where Settings were never saved (load_settings reads the DB, which
# doesn't carry the data/settings.js defaults until an admin clicks Save). It is
# pinned BYTE-FOR-BYTE to data/settings.js::emailTemplates.paymentReceipt so the
# auto-receipt sends exactly the template an admin sees in Settings — the same
# pattern as backend/routes/email.py::_FALLBACK_SIGNATURE. Any edit to the
# data/settings.js default MUST be mirrored here (test_qbo_receipts pins it).
_FALLBACK_SUBJECT = "{{refNumber}} — Payment Received — Thank You"
_FALLBACK_BODY = (
    "{{header}}\n\nHi {{clientName}},\n\nThank you! We have received your payment for "
    "{{refNumber}} ({{projectName}}).\n\n{{lineItems}}\n\nBalance: $0.00 — Paid in Full\n\n"
    "This email serves as your receipt. Please keep it for your records.\n\n{{signature}}"
)


def _resolve(template: str, vars: dict) -> str:
    """Substitute {{key}} from vars; leave unknown tokens literal (so {{header}},
    {{signature}}, {{viewUrl}} survive for the block/recipient passes). Mirror of
    theme.js::LTP_resolveTemplate."""
    out = template or ""
    for k, v in vars.items():
        out = out.replace("{{" + k + "}}", "" if v is None else str(v))
    return out


# An empty parenthetical " ()" left after a placeholder resolved to "" — the
# paymentReceipt template reads "...payment for {{refNumber}} ({{projectName}})."
# and a project-less invoice with no custom name leaves "{{projectName}}" empty.
# Collapse the orphaned parens (and the single space before them) so the receipt
# never shows a bare "()". Kept in sync with the same cleanup in
# modules/invoices.js::openReceiptModal (the manual "Send Receipt" flow).
_EMPTY_PARENS_RE = re.compile(r" ?\(\s*\)")


def _strip_empty_parens(text: str) -> str:
    return _EMPTY_PARENS_RE.sub("", text or "")


def build_receipt_email(settings_data: dict, sender: models.User, text_vars: dict,
                        header_html: str) -> tuple[str, str]:
    """Pure composition: resolve the paymentReceipt template against ``text_vars``,
    drop in the receipt header + the sender's signature at block level, and return
    ``(subject, inner_html)``. ``inner_html`` still carries a literal {{viewUrl}}
    for the send path to swap per recipient; it is NOT yet shell-wrapped."""
    templates = (settings_data.get("emailTemplates") or {})
    tmpl = templates.get("paymentReceipt") or {}
    subject = _resolve(tmpl.get("subject") or _FALLBACK_SUBJECT, text_vars)
    body = _strip_empty_parens(_resolve(tmpl.get("body") or _FALLBACK_BODY, text_vars))

    signature_html = _render_signature(sender, settings_data)
    inner = _paragraphs_to_html(body, {
        "{{header}}": header_html,
        "{{signature}}": signature_html,
    })
    return subject, inner


def _finalize_html(inner_html: str, view_url: str, settings_data: dict) -> str:
    """Substitute {{viewUrl}}, sanitize, and wrap in the shared branded shell —
    the same final stages routes/email.py runs before the wire."""
    rendered = inner_html.replace("{{viewUrl}}", view_url).replace("{{masthead}}", "")
    sanitized = email_html(rendered)
    return email_html(email_shell(sanitized, _email_brand(settings_data)))


# ── Recipient resolution (mirror modules/invoices.js openReceiptModal) ───────

async def _resolve_recipient(db: AsyncSession, invoice: models.Invoice) -> tuple[str, str]:
    """Return (email, client_name) for the invoice's billing party. Contact-billed
    → that contact; company-billed → the company's first linked contact (preferring
    one that actually has an email). Returns ('', '') if none is resolvable."""
    if invoice.client_contact_id:
        r = await db.execute(select(models.Contact).where(models.Contact.id == invoice.client_contact_id))
        ct = r.scalar_one_or_none()
        if ct:
            name = (f"{ct.first_name or ''} {ct.last_name or ''}").strip()
            return (ct.email or "").strip(), name
        return "", ""
    if invoice.company_id:
        r = await db.execute(select(models.Contact))
        linked = [c for c in r.scalars().all() if invoice.company_id in (c.company_ids or [])]
        if not linked:
            return "", ""
        # Prefer a contact with an email on file.
        chosen = next((c for c in linked if (c.email or "").strip()), linked[0])
        return (chosen.email or "").strip(), (chosen.first_name or "").strip()
    return "", ""


# ── Local reconciliation: bring the app invoice in line with "paid in QB" ────

def _reconcile_paid(invoice: models.Invoice, total_amt: float, now: datetime) -> bool:
    """Idempotently mark the invoice paid and, if the app doesn't already know
    about the payment, record ONE synthetic 'Paid via QuickBooks' payment so the
    app shows paid-in-full and the receipt's line items render. Returns True if
    anything changed (caller stamps an activity entry once)."""
    changed = False
    today = now.strftime("%Y-%m-%d")
    if invoice.status != "paid":
        invoice.status = "paid"
        changed = True
    if not (invoice.paid_date or "").strip():
        invoice.paid_date = today
        changed = True
    payments = list(invoice.payments or [])
    app_paid = sum(_num(p.get("amount")) for p in payments)
    total = _num(total_amt)
    remainder = round(total - app_paid, 2)
    if total > 0 and remainder > _PAID_EPSILON:
        payments.append({
            "id": "pay-qb-" + secrets.token_urlsafe(6),
            "date": today,
            "amount": remainder,
            "method": "quickbooks",
            "reference": "Paid via QuickBooks",
            "notes": "Recorded automatically when the QuickBooks invoice was marked paid.",
        })
        invoice.payments = payments
        flag_modified(invoice, "payments")
        changed = True
    return changed


# ── Per-invoice processing ───────────────────────────────────────────────────

async def _send_receipt(db, invoice, sender, settings_data, to_list, cc_list,
                        subject, inner_html, now, *, client_id, client_secret,
                        prev_status=None) -> str:
    """Mint per-recipient tracking tokens, persist EmailRecipient rows, finalize
    the HTML with the primary recipient's {{viewUrl}}, send via the sender's
    Gmail, and stamp activity — the server-side twin of routes/email.py's send
    block. Returns the new receipt_email_status ('sent' | 'pending' | 'failed').

    ``client_id``/``client_secret`` here are the GOOGLE app credentials (Gmail
    token refresh), NOT the QuickBooks ones — see the module docstring.
    ``prev_status`` is the invoice's receipt_email_status before this attempt;
    it gates the failure stamp so a receipt Gmail keeps rejecting is logged once
    (on the null/pending → failed transition), not re-stamped every poll cycle.
    """
    from backend.routes.email import _stamp_email_failed, _stamp_email_sent

    primary_tracking = secrets.token_urlsafe(24)
    rows = [models.EmailRecipient(
        entity_type="invoice", entity_id=invoice.id, share_token=invoice.share_token,
        recipient_email=to_list[0], recipient_role="to",
        tracking_token=primary_tracking, sent_at=now, sent_by_user_id=sender.id,
    )]
    for addr in to_list[1:]:
        rows.append(models.EmailRecipient(
            entity_type="invoice", entity_id=invoice.id, share_token=invoice.share_token,
            recipient_email=addr, recipient_role="to",
            tracking_token=secrets.token_urlsafe(24), sent_at=now, sent_by_user_id=sender.id))
    for addr in cc_list:
        rows.append(models.EmailRecipient(
            entity_type="invoice", entity_id=invoice.id, share_token=invoice.share_token,
            recipient_email=addr, recipient_role="cc",
            tracking_token=secrets.token_urlsafe(24), sent_at=now, sent_by_user_id=sender.id))
    db.add_all(rows)
    await db.flush()

    view_url = _build_view_url("invoice", invoice.share_token, primary_tracking)
    final_html = _finalize_html(inner_html, view_url, settings_data)

    try:
        resp = await gmail.send(
            user=sender, db=db, client_id=client_id, client_secret=client_secret,
            to=to_list, cc=cc_list, subject=subject, html_body=final_html,
            reply_to=(settings_data.get("emailReplyTo") or "").strip() or None,
        )
    except gmail.GmailReconnectRequired:
        # Cache: the admin's Gmail is unavailable. Drop the recipient rows and
        # retry next cycle once the connection is reestablished.
        for r in rows:
            await db.delete(r)
        await db.flush()
        return "pending"
    except gmail.GmailSendError as e:
        for r in rows:
            await db.delete(r)
        # Auth / transport failures (401 invalid_client from bad or missing
        # GOOGLE_CLIENT_ID/SECRET, 403, or a 5xx/outage) are NOT this invoice's
        # fault and clear once the config or outage is fixed — cache and retry
        # silently like a reconnect, so a broken app credential doesn't stamp an
        # email_failed on every 2-hour cycle. Only a genuine per-message
        # rejection (a 4xx on the send itself, e.g. a bad address) is a real
        # per-invoice failure worth recording — stamped once, on entry to failed.
        if e.status in (401, 403) or 500 <= e.status < 600:
            await db.flush()
            return "pending"
        if prev_status != "failed":
            _stamp_email_failed(invoice, sender, to_list, cc_list, subject, str(e), now)
        await db.flush()
        return "failed"

    gmail_message_id = resp.get("id") if isinstance(resp, dict) else None
    for r in rows:
        r.gmail_message_id = gmail_message_id
    _stamp_email_sent(invoice, sender, to_list, cc_list, subject, gmail_message_id, now)
    invoice.receipt_email_sent_at = now
    await db.flush()
    return "sent"


async def _process_invoice(db, conn, invoice, sender, settings_data, *,
                           qb_client_id, qb_client_secret,
                           gmail_client_id, gmail_client_secret, can_email) -> str:
    """Fetch this invoice's QB balance; if paid, reconcile locally and (if able)
    email the receipt. Returns a short outcome string for the cycle summary.

    Takes BOTH OAuth client pairs: the QuickBooks app creds authenticate the QB
    API fetch, the Google app creds refresh the sender's Gmail token for the
    send. They are not interchangeable (module docstring)."""
    prev_status = invoice.receipt_email_status
    qb_inv = await quickbooks.get_invoice(
        conn, db, invoice.qb_invoice_id, client_id=qb_client_id, client_secret=qb_client_secret,
    )
    balance = qb_inv.get("Balance")
    total_amt = qb_inv.get("TotalAmt")
    invoice.qb_balance = _num(balance) if balance is not None else invoice.qb_balance

    # Not paid yet (or QB has no real total) — nothing to do this cycle.
    if balance is None or _num(balance) > _PAID_EPSILON or _num(total_amt) <= 0:
        await db.flush()
        return "open"

    now = datetime.now(timezone.utc)
    ref = qbo_sync._invoice_ref(invoice)
    was_paid = invoice.status == "paid"
    if _reconcile_paid(invoice, total_amt, now):
        qbo_sync._stamp(invoice, None, "paid",
                        f"Marked paid in QuickBooks ({ref})",
                        [{"cat": "Balance", "detail": "$0.00 — Paid in full"},
                         {"cat": "Source", "detail": "QuickBooks"}])
        # Push-notify the invoice's sender(s) once, on the open→paid transition.
        # Best-effort inside the receipt poll; no-ops when push isn't configured.
        if not was_paid:
            try:
                amt = _num(total_amt)
                name = await doc_display_name(db, invoice)
                lead = (name + " · ") if name else ""
                body = lead + "Paid in full" + (f" · ${amt:,.2f}" if amt else "")
                await webpush.notify_entity(db, "invoice", invoice.id,
                                            f"Invoice {ref} paid", body,
                                            f"/#/invoices/{invoice.id}")
            except Exception as e:
                print(f"[LTP] webpush: invoice paid notify failed for "
                      f"invoice {invoice.id}: {e}", flush=True)

    # Defensive: a manual receipt may have claimed the slot between query + now.
    if invoice.receipt_email_status == "sent":
        await db.flush()
        return "already_sent"

    if not can_email:
        invoice.receipt_email_status = "pending"
        await db.flush()
        return "pending"

    # Resolve + validate the recipient.
    to_email, client_name = await _resolve_recipient(db, invoice)
    try:
        to_list = parse_recipients(to_email, allow_empty=False)
    except RecipientError:
        to_list = []
    if not to_list:
        invoice.receipt_email_status = "failed"
        # Stamp once, on the transition into 'failed' (see _send_receipt) so a
        # permanently unaddressable invoice doesn't flood the activity feed.
        if prev_status != "failed":
            qbo_sync._stamp(invoice, sender, "email_failed",
                            "Payment receipt could not be sent — no valid client email on file",
                            [{"cat": "Reference", "detail": ref}])
        await db.flush()
        return "failed"

    # Compose. Resolve the invoice's display name the SAME way the manual
    # "Send Receipt" flow does (modules/invoices.js openReceiptModal): its
    # custom_name if set, else the linked project's name, else "". Using the
    # project name alone (the old behavior here) left a project-less invoice —
    # the common shape for a QuickBooks-driven receipt — with an empty
    # projectName, which the template's "({{projectName}})" rendered as a bare
    # "()" next to the invoice number.
    project_name = await doc_display_name(db, invoice)
    total_str = _money(total_amt)
    text_vars = {
        "companyName": (settings_data.get("companyName") or "LTP"),
        "refNumber": ref,
        "projectName": project_name,
        "clientName": client_name or "there",
        "total": total_str,
        "lineItems": "Payments Received:\n" + _payment_lines(invoice.payments),
    }
    header_html = render_receipt_header(ref, project_name, total_str)
    subject, inner_html = build_receipt_email(settings_data, sender, text_vars, header_html)

    try:
        cc_list = parse_recipients((tmpl_cc(settings_data, text_vars)), allow_empty=True)
    except RecipientError:
        cc_list = []

    status = await _send_receipt(
        db, invoice, sender, settings_data, to_list, cc_list, subject, inner_html, now,
        client_id=gmail_client_id, client_secret=gmail_client_secret, prev_status=prev_status,
    )
    invoice.receipt_email_status = status
    await db.flush()
    return status


def tmpl_cc(settings_data: dict, text_vars: dict) -> str:
    """Resolved cc line from the paymentReceipt template (usually empty)."""
    tmpl = (settings_data.get("emailTemplates") or {}).get("paymentReceipt") or {}
    return _resolve(tmpl.get("cc") or "", text_vars)


# ── Poll cycle ───────────────────────────────────────────────────────────────

async def _candidate_invoices(db: AsyncSession) -> list[models.Invoice]:
    """Invoices the poller should check this cycle: linked to QuickBooks, not a
    draft, and not yet receipted (status null/pending/failed). Bounded by the
    safety cap."""
    result = await db.execute(
        select(models.Invoice).where(
            models.Invoice.qb_invoice_id.isnot(None),
            models.Invoice.status != "draft",
            or_(
                models.Invoice.receipt_email_status.is_(None),
                models.Invoice.receipt_email_status.in_(["pending", "failed"]),
            ),
        ).order_by(models.Invoice.id).limit(_MAX_INVOICES_PER_CYCLE + 1)
    )
    return list(result.scalars().all())


async def run_receipt_poll() -> dict:
    """One full poll cycle. Opens its own session and commits per invoice so a
    mid-batch failure never loses progress (same self-contained pattern as the
    session sweeper). Returns a small summary dict for logging/tests. Never
    raises for an individual invoice — those are isolated and logged."""
    summary = {"checked": 0, "sent": 0, "pending": 0, "failed": 0, "paid": 0, "skipped": False}
    # Two distinct OAuth clients (module docstring): QuickBooks app creds for the
    # QB API fetch, Google app creds for the Gmail token refresh on the send.
    qb_client_id, qb_client_secret = qbo_sync.creds()
    gmail_client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    gmail_client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "")

    async with async_session() as db:
        try:
            conn = await quickbooks.load_connection(db)
        except quickbooks.QboNotConnected:
            summary["skipped"] = True
            return summary

        settings_data = await load_settings(db)

        # Sender = the admin who connected QuickBooks. No usable Gmail → cache
        # everything this cycle and retry once reconnected.
        sender_id = conn.connected_by_user_id
        sender = None
        if sender_id:
            r = await db.execute(select(models.User).where(models.User.id == sender_id))
            sender = r.scalar_one_or_none()
        can_email = sender is not None and bool(sender.gmail_refresh_token)

        invoices = await _candidate_invoices(db)
        if len(invoices) > _MAX_INVOICES_PER_CYCLE:
            invoices = invoices[:_MAX_INVOICES_PER_CYCLE]
            print(f"[LTP] qbo-receipts: candidate set capped at {_MAX_INVOICES_PER_CYCLE}; "
                  "remaining invoices handled next cycle", flush=True)
        # Capture ids up front: a per-invoice rollback expires every ORM object in
        # the session, so re-load each invoice freshly (awaited db.get, greenlet-
        # safe) instead of touching an expired instance from the list.
        invoice_ids = [inv.id for inv in invoices]

        aborted = False
        qb_ok = False  # at least one QB round-trip succeeded this cycle (health proof)
        for invoice_id in invoice_ids:
            # Re-load conn each iteration: a per-invoice rollback expires every ORM
            # object including conn, and _process_invoice -> refresh_if_needed reads
            # conn's token fields on the next QB call — an expired attribute there
            # raises MissingGreenlet and would silently drop the rest of the cycle.
            try:
                conn = await quickbooks.load_connection(db)
            except quickbooks.QboNotConnected:
                break  # connection dropped mid-cycle
            # Re-load the sender for exactly the same reason as conn above. It
            # was loaded once before the loop and never refreshed, so any earlier
            # rollback in this loop — the object-level 400/404 `continue` below,
            # or the generic handler — left it expired. _process_invoice reads
            # sender.id, and _render_signature / build_receipt_email / gmail.send
            # read its other columns, so the first touch raised MissingGreenlet,
            # which the generic `except Exception` swallowed as "failed
            # (continuing)". Candidates are ordered by id, so ONE invoice deleted
            # in QuickBooks (404s every cycle, forever) poisoned the sender for
            # every higher-id invoice: receipts silently stopped and the only
            # symptom was a log line, since receipt_email_status never advanced.
            if sender_id:
                sender = await db.get(models.User, sender_id)
            can_email = sender is not None and bool(sender.gmail_refresh_token)
            invoice = await db.get(models.Invoice, invoice_id)
            if invoice is None:
                continue
            summary["checked"] += 1
            try:
                outcome = await _process_invoice(
                    db, conn, invoice, sender, settings_data,
                    qb_client_id=qb_client_id, qb_client_secret=qb_client_secret,
                    gmail_client_id=gmail_client_id, gmail_client_secret=gmail_client_secret,
                    can_email=can_email,
                )
                # outcome ∈ open | sent | pending | failed | already_sent
                if outcome != "open":
                    summary["paid"] += 1
                if outcome in ("sent", "pending", "failed"):
                    summary[outcome] += 1
                await db.commit()
                qb_ok = True
            except quickbooks.QboReconnectRequired as e:
                # Connection/auth-level — nothing works until an admin reconnects.
                await db.rollback()
                print(f"[LTP] qbo-receipts: aborting cycle on reconnect-required: {e}", flush=True)
                summary["qbo_error"] = getattr(e, "safe_message", str(e))
                await quickbooks.record_connection_error(db, summary["qbo_error"])
                aborted = True
                break
            except quickbooks.QboApiError as e:
                await db.rollback()
                if e.status in (400, 404):
                    # Object-level fault (e.g. the invoice was deleted in QBO): the
                    # connection is fine, so skip THIS invoice and keep polling the
                    # rest instead of wedging every higher-id candidate.
                    print(f"[LTP] qbo-receipts: invoice {invoice_id} object-level QB "
                          f"error ({e.status}), skipping: {e.safe_message}", flush=True)
                    summary["skippedInvoices"] = summary.get("skippedInvoices", 0) + 1
                    qb_ok = True
                    continue
                # Auth (401/403) or a post-retry 5xx/429 — treat as connection-level.
                print(f"[LTP] qbo-receipts: aborting cycle on QuickBooks error: {e}", flush=True)
                # Snapshot it on the connection row (in a fresh commit, after the
                # rollback above) so it surfaces in Settings → Error Log rather
                # than only in the server logs.
                summary["qbo_error"] = e.safe_message
                await quickbooks.record_connection_error(db, summary["qbo_error"])
                aborted = True
                break
            except Exception as e:  # pragma: no cover - isolate one bad invoice
                await db.rollback()
                print(f"[LTP] qbo-receipts: invoice {invoice_id} failed (continuing): {e}", flush=True)

        # Only retire the shared last_error when THIS cycle actually completed a
        # QuickBooks round-trip — an empty candidate set is no evidence of health
        # and must not wipe an error the payout poller just recorded (M1).
        if not aborted and qb_ok:
            await quickbooks.clear_connection_error(db)

    return summary
