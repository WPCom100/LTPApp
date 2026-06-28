"""Tests covering commit 2 of the email feature: HTML sanitizer,
recipient parser, Gmail MIME builder + token refresh helper, and the
/api/email/send endpoint with Gmail mocked.

Runs as a plain script:
    python tests/test_commit2_send_pipeline.py
from the repo root. Self-contained; sets env vars before importing
backend so module-level loads succeed.
"""
import asyncio
import base64
import os
import sys
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("GOOGLE_CLIENT_ID", "fake-client-id")
os.environ.setdefault("GOOGLE_CLIENT_SECRET", "fake-client-secret")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

from backend import crypto, gmail, models  # noqa: E402
from backend.email_validate import (  # noqa: E402
    parse_recipients, validate_subject, RecipientError,
)
from backend.routes.email import (  # noqa: E402
    _app_origin, _build_view_url, _render_signature,
    _stamp_email_sent, _stamp_email_failed,
)
from backend.sanitize import email_html  # noqa: E402


_results: list[tuple[str, bool]] = []


def _check(label: str, cond: bool, detail: str = "") -> None:
    _results.append((label, cond))
    status = "PASS" if cond else "FAIL"
    suffix = f"  ({detail})" if detail else ""
    print(f"  [{status}] {label}{suffix}")


# ── Sanitizer ──────────────────────────────────────────────────────────────


def test_sanitizer_strips_script():
    print("test_sanitizer_strips_script")
    out = email_html('<p>Hi</p><script>alert(1)</script>')
    # The <script> TAG must be gone. Bleach (strip=True) keeps the text
    # content of dropped tags — `<script>alert(1)</script>` becomes the
    # plain string `alert(1)`. That's safe: text isn't executable, browsers
    # render `alert(1)` as the literal characters. So we assert the
    # opening tag is absent; the text body is fine.
    _check("<script> opening tag dropped", "<script" not in out)
    _check("</script> closing tag dropped", "</script" not in out)
    _check("<p>Hi</p> preserved", "<p>Hi</p>" in out)


def test_sanitizer_strips_javascript_href():
    print("test_sanitizer_strips_javascript_href")
    out = email_html('<a href="javascript:alert(1)">click</a>')
    _check("javascript: protocol stripped from href",
           "javascript" not in out, f"got {out!r}")


def test_sanitizer_preserves_safe_anchor():
    print("test_sanitizer_preserves_safe_anchor")
    out = email_html('<a href="https://example.com/x?y=1">link</a>')
    _check("https href kept", "https://example.com/x?y=1" in out)


def test_sanitizer_strips_dangerous_style():
    print("test_sanitizer_strips_dangerous_style")
    out = email_html('<p style="color:red;background-image:url(javascript:alert(1))">hi</p>')
    _check("dangerous CSS URL stripped",
           "javascript" not in out or "[bad url]" in out, f"got {out!r}")
    _check("safe color: declaration preserved", "color" in out and "red" in out)


def test_sanitizer_idempotent():
    print("test_sanitizer_idempotent")
    src = '<p style="color:red">Hi <strong>world</strong></p>'
    out1 = email_html(src)
    out2 = email_html(out1)
    _check("running twice gives same result", out1 == out2)


def test_sanitizer_keeps_table_structure():
    """Marketing-tool exports often use tables for layout."""
    print("test_sanitizer_keeps_table_structure")
    src = '<table><tr><td>A</td><td>B</td></tr></table>'
    out = email_html(src)
    _check("table preserved", "<table>" in out and "<td>A</td>" in out)


# ── Recipient parser ───────────────────────────────────────────────────────


def test_parse_recipients_valid():
    print("test_parse_recipients_valid")
    _check("single address",
           parse_recipients("alice@example.com") == ["alice@example.com"])
    _check("comma-separated normalized",
           parse_recipients("Alice@X.com, BOB@y.org")
           == ["alice@x.com", "bob@y.org"])
    _check("semicolon-separated",
           parse_recipients("a@x.com;b@y.org") == ["a@x.com", "b@y.org"])
    _check("duplicates collapsed",
           parse_recipients("a@x.com,a@x.com,b@y.com") == ["a@x.com", "b@y.com"])
    _check("empty allowed by default", parse_recipients(None) == [])
    _check("whitespace-only treated as empty", parse_recipients("   ") == [])


def test_parse_recipients_injection_attempts():
    print("test_parse_recipients_injection_attempts")
    for evil in [
        "a@x.com\r\nBcc: evil@y.com",
        "a@x.com\nBcc: evil@y.com",
        '"evil"@x.com',
        "a<b>@x.com",
        "a\\b@x.com",
    ]:
        raised = False
        try:
            parse_recipients(evil)
        except RecipientError:
            raised = True
        _check(f"rejects {evil!r}", raised)


def test_parse_recipients_malformed():
    print("test_parse_recipients_malformed")
    for bad in ["not-an-email", "@nodomain.com", "a@", "a@b", " "]:
        raised = False
        try:
            r = parse_recipients(bad, allow_empty=False)
            if not r:
                raised = True
        except RecipientError:
            raised = True
        _check(f"rejects {bad!r}", raised)


def test_validate_subject_strips_crlf():
    print("test_validate_subject_strips_crlf")
    _check("CR stripped", "\r" not in validate_subject("hi\rBcc: evil"))
    _check("LF stripped", "\n" not in validate_subject("hi\nBcc: evil"))
    _check("CRLF stripped", "\r" not in validate_subject("hi\r\nBcc: evil"))
    raised = False
    try:
        validate_subject("x" * 600)
    except RecipientError:
        raised = True
    _check("long subject rejected", raised)


# ── Gmail MIME builder ─────────────────────────────────────────────────────


def test_build_message_structure():
    print("test_build_message_structure")
    raw = gmail.build_message(
        from_name="Sarah Chen",
        from_email="sarah@ltpnj.com",
        to=["alice@biz.com", "bob@biz.com"],
        cc=["cc@biz.com"],
        subject="Quote Q-2026-001",
        html_body='<p>View: <a href="https://ltp/view">click</a></p>',
        reply_to="info@ltpnj.com",
    )
    # Decode the base64url to inspect the MIME structure
    padded = raw + b"=" * (-len(raw) % 4)
    msg = base64.urlsafe_b64decode(padded)

    _check("CRLF line endings", b"\r\n" in msg)
    _check("multipart/alternative content-type", b"multipart/alternative" in msg)
    _check("From with display name", b"Sarah Chen" in msg and b"sarah@ltpnj.com" in msg)
    _check("multiple To recipients", b"alice@biz.com" in msg and b"bob@biz.com" in msg)
    _check("Cc header present", b"Cc: cc@biz.com" in msg)
    _check("Reply-To header present", b"Reply-To: info@ltpnj.com" in msg)
    _check("Subject preserved", b"Quote Q-2026-001" in msg)
    _check("text/plain alternative present", b"text/plain" in msg)
    _check("text/html part present", b"text/html" in msg)


def test_build_message_unicode_subject():
    print("test_build_message_unicode_subject")
    raw = gmail.build_message(
        from_name="Sarah", from_email="s@x.com",
        to=["a@b.com"], cc=[],
        subject="Devis — Q-2026-001 (Préparation)",
        html_body="<p>Bonjour</p>",
    )
    # Should not raise; subject gets RFC 2047 encoded
    padded = raw + b"=" * (-len(raw) % 4)
    msg = base64.urlsafe_b64decode(padded)
    # RFC 2047 encoded-word marker: =?utf-8?
    _check("non-ASCII subject RFC2047 encoded",
           b"=?utf-8?" in msg.lower() or b"=?UTF-8?" in msg)


def test_build_message_with_pdf_attachment():
    print("test_build_message_with_pdf_attachment")
    raw = gmail.build_message(
        from_name="Sarah", from_email="s@x.com",
        to=["client@biz.com"], cc=[], subject="Invoice INV-2026-014",
        html_body="<p>Please find the invoice attached.</p>",
        attachments=[{"filename": "INV-2026-014.pdf", "content": b"%PDF-1.4 demo bytes"}],
    )
    padded = raw + b"=" * (-len(raw) % 4)
    msg = base64.urlsafe_b64decode(padded).decode("latin-1")
    _check("multipart/mixed wrapper", "multipart/mixed" in msg)
    _check("body still inline (multipart/alternative)", "multipart/alternative" in msg)
    _check("text/html part still present", "text/html" in msg)
    _check("application/pdf attachment part", "application/pdf" in msg)
    _check("Content-Disposition attachment + filename",
           "attachment" in msg and "INV-2026-014.pdf" in msg)
    _check("PDF bytes base64-encoded into the part",
           base64.b64encode(b"%PDF-1.4 demo bytes").decode() in msg)


def test_build_message_no_attachment_stays_alternative():
    print("test_build_message_no_attachment_stays_alternative")
    raw = gmail.build_message(
        from_name="S", from_email="s@x.com", to=["a@b.com"], cc=[],
        subject="hi", html_body="<p>hi</p>",
    )
    msg = base64.urlsafe_b64decode(raw + b"=" * (-len(raw) % 4)).decode("latin-1")
    _check("no mixed wrapper without attachments", "multipart/mixed" not in msg)
    _check("plain multipart/alternative preserved", "multipart/alternative" in msg)


def test_html_to_text_preserves_links():
    print("test_html_to_text_preserves_links")
    out = gmail.html_to_text('<p>Click <a href="https://x.com/quote">here</a></p>')
    _check("link URL appears in plaintext", "https://x.com/quote" in out)


# ── Token refresh helper ───────────────────────────────────────────────────


async def test_refresh_returns_cached_when_fresh():
    print("test_refresh_returns_cached_when_fresh")
    u = models.User(google_sub="g1", email="x@y.com", name="X")
    u.gmail_refresh_token = crypto.encrypt_token("refresh-tok")
    u.gmail_access_token = crypto.encrypt_token("access-tok")
    u.gmail_token_expires_at = datetime.now(timezone.utc) + timedelta(hours=1)

    db = MagicMock()
    db.flush = AsyncMock()
    client = MagicMock()
    client.post = AsyncMock()
    out = await gmail.refresh_if_needed(
        u, db, client_id="cid", client_secret="csec", httpx_client=client,
    )
    _check("returned cached access token", out == "access-tok")
    _check("did not call Google", client.post.await_count == 0)


async def test_refresh_calls_google_when_expired():
    print("test_refresh_calls_google_when_expired")
    u = models.User(google_sub="g2", email="x@y.com", name="X")
    u.gmail_refresh_token = crypto.encrypt_token("refresh-tok")
    u.gmail_access_token = crypto.encrypt_token("old-access")
    u.gmail_token_expires_at = datetime.now(timezone.utc) - timedelta(minutes=5)

    fake_resp = MagicMock()
    fake_resp.status_code = 200
    fake_resp.json = MagicMock(return_value={
        "access_token": "new-access",
        "expires_in": 3600,
        "scope": "openid email profile https://www.googleapis.com/auth/gmail.send",
    })
    client = MagicMock()
    client.post = AsyncMock(return_value=fake_resp)
    db = MagicMock()
    db.flush = AsyncMock()

    out = await gmail.refresh_if_needed(
        u, db, client_id="cid", client_secret="csec", httpx_client=client,
    )
    _check("returned new access token", out == "new-access")
    _check("called Google's token endpoint once", client.post.await_count == 1)
    _check("stored encrypted new access token",
           crypto.decrypt_token(u.gmail_access_token) == "new-access")
    _check("scope updated", "gmail.send" in u.gmail_granted_scopes)
    _check("expires_at updated to ~1hr",
           (u.gmail_token_expires_at - datetime.now(timezone.utc)).total_seconds() > 3500)


async def test_refresh_persists_rotated_refresh_token():
    print("test_refresh_persists_rotated_refresh_token")
    u = models.User(google_sub="g3", email="x@y.com", name="X")
    u.gmail_refresh_token = crypto.encrypt_token("old-refresh")
    u.gmail_token_expires_at = datetime.now(timezone.utc) - timedelta(minutes=5)

    fake_resp = MagicMock()
    fake_resp.status_code = 200
    fake_resp.json = MagicMock(return_value={
        "access_token": "new-access",
        "refresh_token": "ROTATED-refresh",
        "expires_in": 3600,
    })
    client = MagicMock()
    client.post = AsyncMock(return_value=fake_resp)
    db = MagicMock()
    db.flush = AsyncMock()

    await gmail.refresh_if_needed(
        u, db, client_id="cid", client_secret="csec", httpx_client=client,
    )
    _check("rotated refresh token persisted",
           crypto.decrypt_token(u.gmail_refresh_token) == "ROTATED-refresh")


async def test_refresh_invalid_grant_raises_reconnect():
    print("test_refresh_invalid_grant_raises_reconnect")
    u = models.User(google_sub="g4", email="x@y.com", name="X")
    u.gmail_refresh_token = crypto.encrypt_token("revoked-refresh")
    u.gmail_token_expires_at = datetime.now(timezone.utc) - timedelta(minutes=5)

    fake_resp = MagicMock()
    fake_resp.status_code = 400
    fake_resp.text = '{"error": "invalid_grant"}'
    client = MagicMock()
    client.post = AsyncMock(return_value=fake_resp)
    db = MagicMock()
    db.flush = AsyncMock()

    raised = False
    try:
        await gmail.refresh_if_needed(
            u, db, client_id="cid", client_secret="csec", httpx_client=client,
        )
    except gmail.GmailReconnectRequired:
        raised = True
    _check("invalid_grant raises GmailReconnectRequired", raised)
    _check("stored tokens cleared", u.gmail_refresh_token is None and u.gmail_access_token is None)


async def test_refresh_missing_token_raises_reconnect():
    print("test_refresh_missing_token_raises_reconnect")
    u = models.User(google_sub="g5", email="x@y.com", name="X")
    raised = False
    try:
        await gmail.refresh_if_needed(
            u, MagicMock(), client_id="cid", client_secret="csec",
        )
    except gmail.GmailReconnectRequired:
        raised = True
    _check("no refresh_token raises GmailReconnectRequired", raised)


# ── Send (mocked Gmail) ────────────────────────────────────────────────────


async def test_send_success():
    print("test_send_success")
    u = models.User(google_sub="g6", email="sarah@ltp.com", name="Sarah")
    u.gmail_refresh_token = crypto.encrypt_token("rt")
    u.gmail_access_token = crypto.encrypt_token("at")
    u.gmail_token_expires_at = datetime.now(timezone.utc) + timedelta(hours=1)

    fake_resp = MagicMock()
    fake_resp.status_code = 200
    fake_resp.json = MagicMock(return_value={"id": "gmail-msg-123", "threadId": "t123"})
    client = MagicMock()
    client.post = AsyncMock(return_value=fake_resp)
    db = MagicMock()
    db.flush = AsyncMock()

    out = await gmail.send(
        user=u, db=db, client_id="cid", client_secret="csec",
        to=["alice@b.com"], cc=[], subject="hi",
        html_body="<p>hi</p>", httpx_client=client,
    )
    _check("returns gmail response dict", out.get("id") == "gmail-msg-123")
    _check("called gmail send URL once", client.post.await_count == 1)
    # Verify the request body has the base64url 'raw' field
    call_kwargs = client.post.await_args.kwargs
    _check("body has 'raw' key", "raw" in call_kwargs["json"])


async def test_send_401_triggers_one_retry():
    print("test_send_401_triggers_one_retry")
    u = models.User(google_sub="g7", email="x@y.com", name="X")
    u.gmail_refresh_token = crypto.encrypt_token("rt")
    u.gmail_access_token = crypto.encrypt_token("at")
    u.gmail_token_expires_at = datetime.now(timezone.utc) + timedelta(hours=1)

    # First send returns 401; refresh succeeds; second send returns 200
    send_resp_401 = MagicMock(status_code=401, text="unauthorized")
    refresh_resp = MagicMock(status_code=200)
    refresh_resp.json = MagicMock(return_value={"access_token": "new-at", "expires_in": 3600})
    send_resp_200 = MagicMock(status_code=200)
    send_resp_200.json = MagicMock(return_value={"id": "ok"})

    call_log = []

    async def fake_post(url, *args, **kwargs):
        call_log.append(url)
        if "oauth2.googleapis.com/token" in url:
            return refresh_resp
        # Gmail send
        return send_resp_401 if len(call_log) <= 1 else send_resp_200

    client = MagicMock()
    client.post = AsyncMock(side_effect=fake_post)
    db = MagicMock()
    db.flush = AsyncMock()

    out = await gmail.send(
        user=u, db=db, client_id="cid", client_secret="csec",
        to=["a@b.com"], cc=[], subject="s", html_body="<p>x</p>",
        httpx_client=client,
    )
    _check("succeeds after 401 → refresh → retry", out.get("id") == "ok")
    # First send (initial), refresh, second send
    _check("exactly one refresh between sends",
           sum(1 for u in call_log if "token" in u) == 1, f"calls: {call_log}")


async def test_send_5xx_then_success():
    print("test_send_5xx_then_success")
    u = models.User(google_sub="g8", email="x@y.com", name="X")
    u.gmail_refresh_token = crypto.encrypt_token("rt")
    u.gmail_access_token = crypto.encrypt_token("at")
    u.gmail_token_expires_at = datetime.now(timezone.utc) + timedelta(hours=1)

    seq = [
        MagicMock(status_code=503, text="upstream"),
        MagicMock(status_code=200),
    ]
    seq[1].json = MagicMock(return_value={"id": "ok"})
    iter_seq = iter(seq)
    async def fake_post(url, *args, **kwargs):
        return next(iter_seq)
    client = MagicMock()
    client.post = AsyncMock(side_effect=fake_post)
    db = MagicMock()
    db.flush = AsyncMock()

    # Patch out the 2-second sleep so the test runs fast
    real_sleep = asyncio.sleep
    asyncio.sleep = AsyncMock()
    try:
        out = await gmail.send(
            user=u, db=db, client_id="cid", client_secret="csec",
            to=["a@b.com"], cc=[], subject="s", html_body="<p>x</p>",
            httpx_client=client,
        )
    finally:
        asyncio.sleep = real_sleep
    _check("succeeds after 5xx → retry", out.get("id") == "ok")


async def test_send_400_raises_send_error():
    print("test_send_400_raises_send_error")
    u = models.User(google_sub="g9", email="x@y.com", name="X")
    u.gmail_refresh_token = crypto.encrypt_token("rt")
    u.gmail_access_token = crypto.encrypt_token("at")
    u.gmail_token_expires_at = datetime.now(timezone.utc) + timedelta(hours=1)

    fake_resp = MagicMock(status_code=400, text='{"error":"Bad Request"}')
    client = MagicMock()
    client.post = AsyncMock(return_value=fake_resp)
    db = MagicMock()
    db.flush = AsyncMock()

    raised = None
    try:
        await gmail.send(
            user=u, db=db, client_id="cid", client_secret="csec",
            to=["a@b.com"], cc=[], subject="s", html_body="<p>x</p>",
            httpx_client=client,
        )
    except gmail.GmailSendError as e:
        raised = e
    _check("400 raises GmailSendError", raised is not None)
    _check("GmailSendError carries status", getattr(raised, "status", None) == 400)


# ── Route helpers (signature template, view URL, activity stamping) ────────


def test_view_url_construction():
    print("test_view_url_construction")
    url = _build_view_url("quote", "ABC123", "tok456")
    _check("contains origin", url.startswith("https://ltp.example.com"))
    _check("contains /#/view/quote/", "/#/view/quote/" in url)
    _check("contains share_token", "ABC123" in url)
    _check("contains tracking_token as ?r=", "?r=tok456" in url)


def test_render_signature_substitutes_variables():
    print("test_render_signature_substitutes_variables")
    u = models.User(google_sub="g", email="sarah@x.com", name="Sarah Chen",
                    title="Producer", phone="555-1212")
    settings = {"emailSignatureTemplate":
        "<p>Best,<br>{{userName}}<br>{{userTitle}}<br>{{userPhone}}<br>{{userEmail}}</p>"}
    out = _render_signature(u, settings)
    _check("userName substituted", "Sarah Chen" in out)
    _check("userTitle substituted", "Producer" in out)
    _check("userPhone substituted", "555-1212" in out)
    _check("userEmail substituted", "sarah@x.com" in out)


def test_render_signature_handles_missing_template():
    """The polish pass changed this behavior: empty/missing template
    now falls back to _FALLBACK_SIGNATURE so recipients always see a
    signed-off email. (See tests/test_polish_pass_signature_html.py
    for the canonical fallback coverage.)"""
    print("test_render_signature_handles_missing_template")
    u = models.User(google_sub="g", email="x@y.com", name="X")
    out_empty = _render_signature(u, {})
    _check("empty template falls back to non-empty", out_empty != "")
    _check("fallback includes the user's name", "X" in out_empty)
    out_missing = _render_signature(u, {"other": "stuff"})
    _check("missing key also falls back", out_missing != "" and "X" in out_missing)


def test_render_signature_null_safe_user_fields():
    print("test_render_signature_null_safe_user_fields")
    u = models.User(google_sub="g", email="x@y.com", name=None)  # name NULL
    settings = {"emailSignatureTemplate": "Hi {{userName}} {{userTitle}}"}
    out = _render_signature(u, settings)
    # Null fields become empty; template still renders
    _check("null name becomes empty", "{{" not in out, f"got {out!r}")


def test_stamp_email_sent_structure():
    print("test_stamp_email_sent_structure")
    class FakeEntity:
        activity = [{"id": "old", "type": "created"}]

    e = FakeEntity()
    e.activity = list(e.activity)  # shallow copy
    user = models.User(id=42, google_sub="g", email="s@x.com", name="Sarah")
    # flag_modified now runs inside backend.activity.append_activity; patch it
    # there to no-op on the fake (non-mapped) entity.
    import backend.activity as activity_mod
    real_flag = activity_mod.flag_modified
    activity_mod.flag_modified = lambda *a, **k: None
    try:
        entry = _stamp_email_sent(
            e, user,
            to=["alice@x.com"], cc=["bob@x.com"], subject="Hi",
            gmail_message_id="g123",
            now=datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc),
        )
    finally:
        activity_mod.flag_modified = real_flag

    _check("activity entry appended", len(e.activity) == 2)
    _check("type is email_sent", entry["type"] == "email_sent")
    _check("user populated", entry["user"] == "Sarah" and entry["userId"] == 42)
    _check("recipients structured", entry["recipients"]
           == {"to": ["alice@x.com"], "cc": ["bob@x.com"]})
    cats = {c["cat"]: c["detail"] for c in entry["changes"]}
    _check("From in changes", cats.get("From") == "Sarah <s@x.com>")
    _check("To in changes", cats.get("To") == "alice@x.com")
    _check("CC in changes", cats.get("CC") == "bob@x.com")
    _check("Gmail Message ID in changes", cats.get("Gmail Message ID") == "g123")


def test_app_origin_strips_path():
    print("test_app_origin_strips_path")
    # LTP_OAUTH_REDIRECT_URI was set to https://ltp.example.com/auth/callback
    _check("origin is scheme + host only",
           _app_origin() == "https://ltp.example.com")


# ── Main ───────────────────────────────────────────────────────────────────


def main() -> int:
    # Sync tests
    test_sanitizer_strips_script()
    test_sanitizer_strips_javascript_href()
    test_sanitizer_preserves_safe_anchor()
    test_sanitizer_strips_dangerous_style()
    test_sanitizer_idempotent()
    test_sanitizer_keeps_table_structure()
    test_parse_recipients_valid()
    test_parse_recipients_injection_attempts()
    test_parse_recipients_malformed()
    test_validate_subject_strips_crlf()
    test_build_message_structure()
    test_build_message_unicode_subject()
    test_build_message_with_pdf_attachment()
    test_build_message_no_attachment_stays_alternative()
    test_html_to_text_preserves_links()
    test_view_url_construction()
    test_render_signature_substitutes_variables()
    test_render_signature_handles_missing_template()
    test_render_signature_null_safe_user_fields()
    test_stamp_email_sent_structure()
    test_app_origin_strips_path()
    # Async tests
    asyncio.run(test_refresh_returns_cached_when_fresh())
    asyncio.run(test_refresh_calls_google_when_expired())
    asyncio.run(test_refresh_persists_rotated_refresh_token())
    asyncio.run(test_refresh_invalid_grant_raises_reconnect())
    asyncio.run(test_refresh_missing_token_raises_reconnect())
    asyncio.run(test_send_success())
    asyncio.run(test_send_401_triggers_one_retry())
    asyncio.run(test_send_5xx_then_success())
    asyncio.run(test_send_400_raises_send_error())

    fail_count = sum(1 for _, ok in _results if not ok)
    print()
    print(f"== {len(_results) - fail_count}/{len(_results)} checks passed ==")
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
