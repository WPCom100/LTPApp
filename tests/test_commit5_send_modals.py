"""Tests covering commit 5 of the email feature: the wire contract between
the frontend Send modals and POST /api/email/send.

Frontend changes themselves (split-pane HTML editor, From: display, Send-
button gating on window.LTP_GMAIL_CONNECTED, reconnect banner) are
browser-rendered UI we can't unit-test without a JS runner. What we CAN
verify deterministically is the contract:

  - The exact payload shape the frontend sends (entityType / entityId /
    to / cc / subject / bodyHtml) is what the backend SendRequest
    pydantic model accepts.
  - Gmail's send call is mocked so we can drive 200 / 409-reconnect /
    502 paths end-to-end and confirm the routes return what the
    frontend's response handler expects.
  - email_sent activity entries get stamped with the cat/detail shape
    the frontend's typeColors + changes renderer reads.
  - email_recipients rows include the cc role when present and skip
    when whitespace-only.

Runs as a plain script: python tests/test_commit5_send_modals.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_commit5.db")
os.environ.setdefault("GOOGLE_CLIENT_ID", "fake-client-id")
os.environ.setdefault("GOOGLE_CLIENT_SECRET", "fake-client-secret")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

_db_path = os.path.join(_root, "_test_commit5.db")
if os.path.exists(_db_path):
    os.remove(_db_path)

from backend import crypto, models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402


_results: list[tuple[str, bool]] = []


def _check(label: str, cond: bool, detail: str = "") -> None:
    _results.append((label, cond))
    status = "PASS" if cond else "FAIL"
    suffix = f"  ({detail})" if detail else ""
    print(f"  [{status}] {label}{suffix}")


# Module-level TestClient — created once and shared across tests (sqlite
# file locking on Windows prevents per-test recreation). Per-test unique
# google_sub tags keep seeded users from colliding.
_client = None
_tcount = 0


def _setup():
    """Seed a sender User + a quote + an invoice (each with share_token).
    Returns (client, session_token, quote_id, invoice_id)."""
    global _client, _tcount
    _tcount += 1
    tag = f"t{_tcount}"

    if _client is None:
        from fastapi.testclient import TestClient
        from backend.main import app
        _client = TestClient(app)
        _client.__enter__()

    from backend.database import async_session

    async def seed():
        async with async_session() as db:
            sender = models.User(
                google_sub=f"sender-{tag}", email=f"sarah-{tag}@biz.com", name="Sarah",
                role="member", title="Producer", phone="555-0001",
            )
            sender.gmail_refresh_token = crypto.encrypt_token("rt")
            sender.gmail_access_token = crypto.encrypt_token("at")
            sender.gmail_token_expires_at = datetime.now(timezone.utc) + timedelta(hours=1)
            sender.gmail_granted_scopes = "openid email profile https://www.googleapis.com/auth/gmail.send"
            db.add(sender)
            await db.flush()
            sess = models.Session(
                id=hash_session_token(f"sess-{tag}"),
                user_id=sender.id,
                expires_at=datetime.now(timezone.utc) + timedelta(days=7),
            )
            quote = models.Quote(
                share_token=f"qtok-{tag}-aaaaaaaaaa",
                status="draft",
                activity=[],
            )
            invoice = models.Invoice(
                share_token=f"itok-{tag}-bbbbbbbbbb",
                status="draft",
                activity=[],
            )
            db.add_all([sess, quote, invoice])
            await db.flush()
            await db.commit()
            return sender.id, quote.id, invoice.id

    sender_id, q_id, i_id = asyncio.run(seed())
    return _client, f"sess-{tag}", q_id, i_id


def _teardown():
    global _client
    if _client is not None:
        _client.__exit__(None, None, None)
        _client = None


# ── Fake Gmail responses used to drive route paths without a real Google call


def _gmail_send_ok(**_kwargs):
    return {"id": "gmail-msg-fake-1", "threadId": "t1"}


async def _gmail_reconnect_required(**_kwargs):
    from backend.gmail import GmailReconnectRequired
    raise GmailReconnectRequired("refresh token rejected by Google")


async def _gmail_send_error(**_kwargs):
    from backend.gmail import GmailSendError
    raise GmailSendError(500, "Gmail upstream blew up")


# ── Tests ─────────────────────────────────────────────────────────────────


def test_request_shape_quote_200():
    """Confirms the exact payload shape the frontend sends is accepted."""
    print("test_request_shape_quote_200")
    client, sess_tok, q_id, _ = _setup()
    with patch("backend.gmail.send", new=AsyncMock(side_effect=lambda **kw: _gmail_send_ok())):
        r = client.post(
            "/api/email/send",
            json={
                "entityType": "quote",
                "entityId": q_id,
                "to": "alice@biz.com",
                "cc": "bob@biz.com",
                "subject": "Quote Q-2026-001",
                "bodyHtml": "<p>Hi Alice, please review.</p>",
            },
            cookies={"ltp_session": sess_tok},
        )
    _check("200 OK", r.status_code == 200, f"got {r.status_code}: {r.text[:200]}")
    body = r.json()
    _check("body.ok=True", body.get("ok") is True)
    _check("gmailMessageId returned", body.get("gmailMessageId") == "gmail-msg-fake-1")
    _check("activityId returned", isinstance(body.get("activityId"), str))
    _check("recipients listed (to + cc)", len(body.get("recipients", [])) == 2)


def test_too_many_recipients_rejected():
    """H4: a send whose To+CC exceeds the per-send recipient cap is rejected
    with 400 BEFORE any Gmail call, so the relay can't blast hundreds of
    addresses from the company mailbox. Uses bare asserts (the file's _check
    helper does not raise, so it wouldn't fail the pytest run on its own)."""
    print("test_too_many_recipients_rejected")
    client, sess_tok, q_id, _ = _setup()
    many = ", ".join(f"user{i}@biz.com" for i in range(26))  # 26 > cap of 25
    gmail_called = {"hit": False}

    async def _spy(**_kw):
        gmail_called["hit"] = True
        return _gmail_send_ok()

    with patch("backend.gmail.send", new=AsyncMock(side_effect=_spy)):
        r = client.post(
            "/api/email/send",
            json={
                "entityType": "quote",
                "entityId": q_id,
                "to": many,
                "subject": "blast",
                "bodyHtml": "<p>x</p>",
            },
            cookies={"ltp_session": sess_tok},
        )
    _check("400 rejected", r.status_code == 400, f"got {r.status_code}: {r.text[:200]}")
    assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text[:200]}"
    assert r.json().get("detail", {}).get("field") == "recipients", r.text[:200]
    assert gmail_called["hit"] is False, "Gmail must not be called when over the cap"


def test_email_sent_activity_entry_shape():
    """Confirms the activity entry the frontend renders has the right shape."""
    print("test_email_sent_activity_entry_shape")
    client, sess_tok, q_id, _ = _setup()
    with patch("backend.gmail.send", new=AsyncMock(side_effect=lambda **kw: _gmail_send_ok())):
        client.post(
            "/api/email/send",
            json={
                "entityType": "quote", "entityId": q_id,
                "to": "alice@biz.com",
                "cc": None,
                "subject": "Hello Alice",
                "bodyHtml": "<p>Hi</p>",
            },
            cookies={"ltp_session": sess_tok},
        )

    from backend.database import async_session
    from sqlalchemy import select

    async def fetch_activity():
        async with async_session() as db:
            r = await db.execute(select(models.Quote).where(models.Quote.id == q_id))
            row = r.scalar_one_or_none()
            return list(row.activity or [])

    activity = asyncio.run(fetch_activity())
    es = [e for e in activity if e.get("type") == "email_sent"]
    _check("exactly one email_sent entry", len(es) == 1, f"got {len(es)}")
    entry = es[0]
    _check("type=email_sent (PUBLIC_TYPES)", entry["type"] == "email_sent")
    _check("user is sender name", entry["user"] == "Sarah")
    _check("userId is sender id", isinstance(entry["userId"], int))
    _check("message mentions recipient", "alice@biz.com" in entry["message"])
    _check("recipients.to populated", entry["recipients"]["to"] == ["alice@biz.com"])
    _check("recipients.cc empty list", entry["recipients"]["cc"] == [])
    cats = {c["cat"]: c["detail"] for c in entry["changes"]}
    _check("From in changes", "From" in cats and "sarah" in cats["From"].lower())
    _check("To in changes", cats.get("To") == "alice@biz.com")
    _check("Subject in changes", cats.get("Subject") == "Hello Alice")
    _check("Gmail Message ID in changes", cats.get("Gmail Message ID") == "gmail-msg-fake-1")
    # Critical: no CC entry when CC is empty (matches the frontend's
    # `cc: (sendCc || "").trim() || null` whitespace-trim behavior).
    _check("no CC change when cc=null", "CC" not in cats)


def test_cc_whitespace_only_skipped():
    """Mirrors the frontend's trim-before-send behavior; whitespace cc
    should result in no email_recipients row for cc."""
    print("test_cc_whitespace_only_skipped")
    client, sess_tok, q_id, _ = _setup()
    with patch("backend.gmail.send", new=AsyncMock(side_effect=lambda **kw: _gmail_send_ok())):
        # Frontend now trims, but backend should ALSO tolerate empty / null —
        # we don't want a defense-in-depth gap if the frontend regresses.
        r = client.post(
            "/api/email/send",
            json={
                "entityType": "quote", "entityId": q_id,
                "to": "alice@biz.com",
                "cc": "",
                "subject": "x", "bodyHtml": "<p>x</p>",
            },
            cookies={"ltp_session": sess_tok},
        )
    _check("empty cc string accepted", r.status_code == 200, f"got {r.status_code}: {r.text[:200]}")
    body = r.json()
    cc_recipients = [r for r in body.get("recipients", []) if r.get("role") == "cc"]
    _check("no CC recipient rows", len(cc_recipients) == 0)


def test_409_reconnect_response_shape():
    """Confirms 409 reason=reconnect matches what executeSendQuote
    branches on."""
    print("test_409_reconnect_response_shape")
    client, sess_tok, q_id, _ = _setup()
    with patch("backend.gmail.send", new=AsyncMock(side_effect=_gmail_reconnect_required)):
        r = client.post(
            "/api/email/send",
            json={
                "entityType": "quote", "entityId": q_id,
                "to": "alice@biz.com", "cc": None,
                "subject": "x", "bodyHtml": "<p>x</p>",
            },
            cookies={"ltp_session": sess_tok},
        )
    _check("409 status", r.status_code == 409, f"got {r.status_code}")
    body = r.json()
    detail = body.get("detail", {})
    _check("detail.reason=reconnect (frontend branch trigger)",
           detail.get("reason") == "reconnect" if isinstance(detail, dict) else False,
           f"got detail={detail!r}")


def test_502_send_failure_response_shape():
    """Confirms 502 gmail_error shape is what the frontend toast surfaces."""
    print("test_502_send_failure_response_shape")
    client, sess_tok, q_id, _ = _setup()
    with patch("backend.gmail.send", new=AsyncMock(side_effect=_gmail_send_error)):
        r = client.post(
            "/api/email/send",
            json={
                "entityType": "quote", "entityId": q_id,
                "to": "alice@biz.com", "cc": None,
                "subject": "x", "bodyHtml": "<p>x</p>",
            },
            cookies={"ltp_session": sess_tok},
        )
    _check("502 status", r.status_code == 502, f"got {r.status_code}")
    body = r.json()
    detail = body.get("detail", {})
    _check("detail.reason=gmail_error",
           detail.get("reason") == "gmail_error" if isinstance(detail, dict) else False)


def test_unauthenticated_request_blocked():
    """Frontend's gmail-connected gate is UX only; backend MUST reject
    no-session requests. If this regresses, anyone could send emails."""
    print("test_unauthenticated_request_blocked")
    client, sess_tok, q_id, _ = _setup()
    r = client.post(
        "/api/email/send",
        json={
            "entityType": "quote", "entityId": q_id,
            "to": "alice@biz.com", "cc": None,
            "subject": "x", "bodyHtml": "<p>x</p>",
        },
    )
    _check("401 without session cookie", r.status_code == 401, f"got {r.status_code}")


def test_invoice_send_route_with_cc():
    """Invoice flow mirrors quote flow; confirm both work and cc rows
    land in email_recipients with role='cc'."""
    print("test_invoice_send_route_with_cc")
    client, sess_tok, _, i_id = _setup()
    with patch("backend.gmail.send", new=AsyncMock(side_effect=lambda **kw: _gmail_send_ok())):
        r = client.post(
            "/api/email/send",
            json={
                "entityType": "invoice",
                "entityId": i_id,
                "to": "alice@biz.com",
                "cc": "bob@biz.com, carol@biz.com",
                "subject": "Invoice INV-2026-001",
                "bodyHtml": "<p>Hi</p>",
            },
            cookies={"ltp_session": sess_tok},
        )
    _check("200 invoice send", r.status_code == 200, f"got {r.status_code}: {r.text[:200]}")
    body = r.json()
    recipients = body.get("recipients", [])
    to_count = sum(1 for r in recipients if r.get("role") == "to")
    cc_count = sum(1 for r in recipients if r.get("role") == "cc")
    _check("1 to + 2 cc recipients", to_count == 1 and cc_count == 2,
           f"to={to_count}, cc={cc_count}")


def test_unsaved_entity_blocked_at_backend():
    """Frontend has a 'Save First' alert when shareToken is missing, but
    even if it regresses, the backend must reject. Confirm by sending
    with an unknown entityId."""
    print("test_unsaved_entity_blocked_at_backend")
    client, sess_tok, _, _ = _setup()
    r = client.post(
        "/api/email/send",
        json={
            "entityType": "quote", "entityId": 999999,
            "to": "alice@biz.com", "cc": None,
            "subject": "x", "bodyHtml": "<p>x</p>",
        },
        cookies={"ltp_session": sess_tok},
    )
    _check("404 unknown entity", r.status_code == 404, f"got {r.status_code}")


def test_button_disabled_prop_in_ui_js():
    """Sanity: confirm components/ui.js Btn now exposes the disabled
    prop in its destructuring + applies pointerEvents:none + opacity.
    Catches a regression of the commit-5 critical fix."""
    print("test_button_disabled_prop_in_ui_js")
    ui_path = os.path.join(_root, "components", "ui.js")
    with open(ui_path, encoding="utf-8") as f:
        src = f.read()
    # Look for the disabled destructuring (anywhere in the file is fine)
    _check("disabled prop destructured",
           "disabled" in src.split("window.Btn")[1].split("};")[0])
    _check("disabled style includes pointerEvents:none",
           '"pointerEvents": "none"' in src or "pointerEvents: \"none\"" in src)


def test_app_js_exposes_gmail_globals():
    """Sanity: confirm app.js sets the four window.LTP_* gmail globals
    the Send modals depend on."""
    print("test_app_js_exposes_gmail_globals")
    app_path = os.path.join(_root, "app.js")
    with open(app_path, encoding="utf-8") as f:
        src = f.read()
    _check("window.LTP_GMAIL_CONNECTED set", "window.LTP_GMAIL_CONNECTED" in src)
    _check("window.LTP_GMAIL_SCOPE set", "window.LTP_GMAIL_SCOPE" in src)
    _check("window.LTP_SENDER_EMAIL set", "window.LTP_SENDER_EMAIL" in src)
    _check("window.LTP_SENDER_NAME set", "window.LTP_SENDER_NAME" in src)


def test_invoice_attach_pdf_passes_attachment_to_gmail():
    """attachPdf=true on an invoice send generates the PDF and hands it to
    gmail.send as an attachment. generate_pdf is mocked (no reportlab dep);
    we spy on gmail.send to capture the attachments kwarg."""
    print("test_invoice_attach_pdf_passes_attachment_to_gmail")
    client, sess_tok, _, i_id = _setup()
    captured = {}

    async def _spy_send(**kw):
        captured.update(kw)
        return _gmail_send_ok()

    def _fake_generate_pdf(buf, *a, **kw):
        buf.write(b"%PDF-1.4 fake invoice pdf")

    with patch("backend.gmail.send", new=AsyncMock(side_effect=_spy_send)), \
         patch("backend.routes.email.generate_pdf", new=_fake_generate_pdf):
        r = client.post(
            "/api/email/send",
            json={
                "entityType": "invoice", "entityId": i_id,
                "to": "client@biz.com", "subject": "Invoice INV-2026-014",
                "bodyHtml": "<p>Please find the invoice attached.</p>",
                "attachPdf": True,
            },
            cookies={"ltp_session": sess_tok},
        )
    _check("200 OK", r.status_code == 200, f"got {r.status_code}: {r.text[:200]}")
    atts = captured.get("attachments")
    _check("one attachment passed to gmail.send",
           isinstance(atts, list) and len(atts) == 1, f"got {atts!r}")
    if atts:
        _check("attachment carries the generated PDF bytes",
               atts[0].get("content") == b"%PDF-1.4 fake invoice pdf")
        _check("attachment filename ends with .pdf",
               str(atts[0].get("filename", "")).lower().endswith(".pdf"))


def test_invoice_send_without_flag_has_no_attachment():
    """attachPdf omitted → default False → no PDF generated, no attachment."""
    print("test_invoice_send_without_flag_has_no_attachment")
    client, sess_tok, _, i_id = _setup()
    captured = {}
    gen = {"hit": False}

    async def _spy_send(**kw):
        captured.update(kw)
        return _gmail_send_ok()

    def _fake_generate_pdf(buf, *a, **kw):
        gen["hit"] = True
        buf.write(b"%PDF")

    with patch("backend.gmail.send", new=AsyncMock(side_effect=_spy_send)), \
         patch("backend.routes.email.generate_pdf", new=_fake_generate_pdf):
        r = client.post(
            "/api/email/send",
            json={
                "entityType": "invoice", "entityId": i_id,
                "to": "client@biz.com", "subject": "Invoice",
                "bodyHtml": "<p>No attach.</p>",
            },
            cookies={"ltp_session": sess_tok},
        )
    _check("200 OK", r.status_code == 200, f"got {r.status_code}")
    _check("no attachments passed", not captured.get("attachments"))
    _check("generate_pdf NOT called", gen["hit"] is False)


def test_quote_attach_pdf_is_ignored():
    """attachPdf only applies to invoices; a quote send with the flag set
    must NOT generate or attach a PDF."""
    print("test_quote_attach_pdf_is_ignored")
    client, sess_tok, q_id, _ = _setup()
    captured = {}
    gen = {"hit": False}

    async def _spy_send(**kw):
        captured.update(kw)
        return _gmail_send_ok()

    def _fake_generate_pdf(buf, *a, **kw):
        gen["hit"] = True
        buf.write(b"%PDF")

    with patch("backend.gmail.send", new=AsyncMock(side_effect=_spy_send)), \
         patch("backend.routes.email.generate_pdf", new=_fake_generate_pdf):
        r = client.post(
            "/api/email/send",
            json={
                "entityType": "quote", "entityId": q_id,
                "to": "client@biz.com", "subject": "Quote",
                "bodyHtml": "<p>x</p>", "attachPdf": True,
            },
            cookies={"ltp_session": sess_tok},
        )
    _check("200 OK", r.status_code == 200, f"got {r.status_code}")
    _check("no attachment for quote send", not captured.get("attachments"))
    _check("generate_pdf NOT called for quote", gen["hit"] is False)


def test_invoice_send_modal_attach_pdf_wiring():
    """Frontend: the invoice send modal declares attachPdf state (default ON),
    renders the 'Attach invoice PDF' checkbox, resets it on open, and
    executeSend posts the attachPdf flag."""
    print("test_invoice_send_modal_attach_pdf_wiring")
    path = os.path.join(_root, "modules", "invoices.js")
    with open(path, encoding="utf-8") as f:
        src = f.read()
    _check("attachPdf state declared",
           "[attachPdf, setAttachPdf]" in src)
    _check("attachPdf defaults ON (useState(true))",
           "var [attachPdf, setAttachPdf] = useState(true)" in src)
    _check("'Attach invoice PDF' checkbox label present",
           "Attach invoice PDF" in src)
    _check("checkbox bound to attachPdf",
           "checked: attachPdf" in src and "setAttachPdf(e.target.checked)" in src)
    _check("openSendModal resets the flag ON",
           "setAttachPdf(true)" in src)
    _check("executeSend posts attachPdf",
           "attachPdf: attachPdf" in src)


def main() -> int:
    try:
        test_request_shape_quote_200()
        test_too_many_recipients_rejected()
        test_email_sent_activity_entry_shape()
        test_cc_whitespace_only_skipped()
        test_409_reconnect_response_shape()
        test_502_send_failure_response_shape()
        test_unauthenticated_request_blocked()
        test_invoice_send_route_with_cc()
        test_unsaved_entity_blocked_at_backend()
        test_button_disabled_prop_in_ui_js()
        test_app_js_exposes_gmail_globals()
        test_invoice_attach_pdf_passes_attachment_to_gmail()
        test_invoice_send_without_flag_has_no_attachment()
        test_quote_attach_pdf_is_ignored()
        test_invoice_send_modal_attach_pdf_wiring()
    finally:
        _teardown()

    fail_count = sum(1 for _, ok in _results if not ok)
    print()
    print(f"== {len(_results) - fail_count}/{len(_results)} checks passed ==")
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
