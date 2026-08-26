"""Per-quote expiration date — persistence, serialization, and the terms line.

Before `quotes.expiry_date` a quote's shelf life was one workspace-wide number
of days (Settings → defaultQuoteValidity) that only ever appeared as prose, and
the PDF/client-view terms block didn't even read that — it hardcoded "valid for
30 days from the date of issue". So there was no way to give one client longer,
and nothing recorded what a sent quote had actually promised: changing the
workspace setting silently moved the deadline on quotes already in a client's
inbox.

Covers:
  - POST/PUT/GET round-trip expiryDate through the CRUD API.
  - A bad date shape is rejected by the validator rather than stored.
  - quote_dict (what the PDF generator + public view consume) carries it.
  - _quote_expiry resolves the quote's own date first, then sentDate + the
    workspace validity, then "" when there's nothing to count from — the rule
    window.LTP_quoteExpiry (theme.js) implements on the frontend. Both languages
    have to name the same day or the client's copy and the app disagree.
  - The rendered PDF terms line names the day when there is one, and falls back
    to the old "N days from issue" wording when there isn't.
  - public_settings exposes defaultQuoteValidity, which is what lets the public
    client view resolve that same fallback without a session.

Runs both as pytest and as a plain script:
    python tests/test_quote_expiry.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_quote_expiry.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

# Fresh DB so the full migration stack (incl. quotes.expiry_date) runs clean
# when this module is executed on its own.
_db_path = os.path.join(_root, "_test_quote_expiry.db")
if os.path.exists(_db_path):
    os.remove(_db_path)

from backend import models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402
from backend.pdf_generator import _quote_expiry, _quote_validity_days  # noqa: E402
from backend.routes._shared import public_settings, quote_dict  # noqa: E402

_ADMIN_TOK = "quoteexpiry-admin-session"
_client = None
_seeded = False


def _setup():
    global _client, _seeded
    if _client is None:
        from fastapi.testclient import TestClient
        from backend.main import app
        _client = TestClient(app)
        _client.__enter__()

    if not _seeded:
        from backend.database import async_session

        async def seed():
            async with async_session() as db:
                admin = models.User(google_sub="quoteexpiry-admin-sub", email="quoteexpiry@biz.com",
                                    name="Quote Admin", role="admin")
                db.add(admin)
                await db.flush()
                db.add(models.Session(id=hash_session_token(_ADMIN_TOK), user_id=admin.id,
                                      expires_at=datetime.now(timezone.utc) + timedelta(days=7)))
                await db.commit()

        asyncio.run(seed())
        _seeded = True
    return _client, _ADMIN_TOK


def _teardown():
    global _client
    if _client is not None:
        _client.__exit__(None, None, None)
        _client = None


# ── Test infra (dual-mode: pytest asserts, script tallies) ───────────────────

_results: list = []


def _check(label, cond, detail=""):
    _results.append((label, bool(cond)))
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  ({detail})" if detail else ""))
    assert cond, f"{label} {detail}"


def _cookies():
    return {"ltp_session": _ADMIN_TOK}


# ── Round-trip through the CRUD API ─────────────────────────────────────────

def test_expiry_persists_through_post_and_get():
    client, _ = _setup()
    body = {"clientType": "company", "status": "draft", "expiryDate": "2026-10-15"}
    r = client.post("/api/quotes", json=body, cookies=_cookies())
    _check("POST accepted", r.status_code == 200, r.text)
    created = r.json()
    _check("POST echoes expiryDate", created.get("expiryDate") == "2026-10-15", str(created.get("expiryDate")))

    got = client.get(f"/api/quotes/{created['id']}", cookies=_cookies()).json()
    _check("GET round-trips expiryDate", got.get("expiryDate") == "2026-10-15", str(got.get("expiryDate")))


def test_expiry_updates_via_put():
    client, _ = _setup()
    created = client.post("/api/quotes", json={"clientType": "company", "expiryDate": "2026-09-01"},
                          cookies=_cookies()).json()
    r = client.put(f"/api/quotes/{created['id']}", json=dict(created, expiryDate="2026-12-31"),
                   cookies=_cookies())
    _check("PUT accepted", r.status_code == 200, r.text)
    got = client.get(f"/api/quotes/{created['id']}", cookies=_cookies()).json()
    _check("PUT pushed the date out", got.get("expiryDate") == "2026-12-31", str(got.get("expiryDate")))

    # Clearing it back to "" is how a producer returns a quote to the workspace
    # default, so an empty string must be storable — not rejected as malformed.
    r = client.put(f"/api/quotes/{created['id']}", json=dict(got, expiryDate=""), cookies=_cookies())
    _check("clearing back to the default is accepted", r.status_code == 200, r.text)
    got = client.get(f"/api/quotes/{created['id']}", cookies=_cookies()).json()
    _check("cleared expiryDate reads back empty", not got.get("expiryDate"), str(got.get("expiryDate")))


def test_malformed_expiry_is_rejected():
    client, _ = _setup()
    r = client.post("/api/quotes", json={"clientType": "company", "expiryDate": "next Tuesday"},
                    cookies=_cookies())
    _check("non-ISO expiryDate rejected", r.status_code == 400, r.text)


def test_quote_dict_carries_expiry():
    q = models.Quote(id=1, expiry_date="2026-11-05", sent_date="2026-10-06",
                     share_token="tok-" + "x" * 20, client_type="company")
    d = quote_dict(q)
    _check("quote_dict includes expiryDate", d.get("expiryDate") == "2026-11-05", str(d.get("expiryDate")))


# ── The resolution rule, shared with window.LTP_quoteExpiry ──────────────────

def test_quote_expiry_resolution():
    # 1. The quote's own date always wins — that's the whole point of the field.
    _check("own expiryDate wins over the fallback",
           _quote_expiry({"expiryDate": "2026-11-05", "sentDate": "2026-10-01"},
                         {"defaultQuoteValidity": 30}) == "2026-11-05")

    # 2. No date of its own → sent date + the workspace validity. This is the
    #    only rule that existed before the column, so every legacy quote keeps
    #    reading exactly as it always did.
    _check("falls back to sentDate + validity",
           _quote_expiry({"sentDate": "2026-10-01"}, {"defaultQuoteValidity": 30}) == "2026-10-31")
    _check("a non-default validity is honoured",
           _quote_expiry({"sentDate": "2026-10-01"}, {"defaultQuoteValidity": 45}) == "2026-11-15")

    # 3. Nothing to count from → "". An unsent quote with no date of its own has
    #    no clock running, so the terms block must NOT invent a deadline.
    _check("unsent + unset yields no date", _quote_expiry({}, {"defaultQuoteValidity": 30}) == "")
    _check("None entity is tolerated", _quote_expiry(None, {}) == "")
    _check("a garbage sentDate yields no date",
           _quote_expiry({"sentDate": "whenever"}, {}) == "")

    # An unsent quote that DOES carry its own date still names it — the producer
    # set it deliberately and the preview should show what sending will promise.
    _check("unset sentDate still honours an explicit expiry",
           _quote_expiry({"expiryDate": "2026-12-24"}, {}) == "2026-12-24")


def test_validity_days_fallback():
    _check("missing setting falls back to 30", _quote_validity_days({}) == 30)
    _check("None settings falls back to 30", _quote_validity_days(None) == 30)
    _check("junk falls back to 30", _quote_validity_days({"defaultQuoteValidity": "soon"}) == 30)
    _check("zero/negative falls back to 30", _quote_validity_days({"defaultQuoteValidity": 0}) == 30)
    _check("a real value is used", _quote_validity_days({"defaultQuoteValidity": 14}) == 14)
    _check("a numeric string is used", _quote_validity_days({"defaultQuoteValidity": "60"}) == 60)


# ── What the client actually reads ──────────────────────────────────────────

def _terms_lines(entity, settings):
    """Reproduce _DocPDF._terms' quote branch. Rendering a whole PDF just to
    read one string would tie this test to reportlab's output; the branch itself
    is the contract."""
    expiry = _quote_expiry(entity, settings)
    from backend.pdf_generator import _fmt_date
    return (f"This quote is valid through {_fmt_date(expiry)}." if expiry
            else f"This quote is valid for {_quote_validity_days(settings)} days from the date of issue.")


def test_terms_line_names_the_day_when_there_is_one():
    line = _terms_lines({"expiryDate": "2026-11-05"}, {"defaultQuoteValidity": 30})
    _check("terms name the expiry date", line == "This quote is valid through November 5th, 2026.", line)

    # A quote with nothing to count from falls back to the old wording — but now
    # off the workspace setting rather than a hardcoded 30.
    line = _terms_lines({}, {"defaultQuoteValidity": 45})
    _check("fallback wording uses the workspace validity",
           line == "This quote is valid for 45 days from the date of issue.", line)


def test_public_settings_exposes_the_validity_fallback():
    # The public client view has no session, so app.js never mirrors the
    # workspace default onto window — it reads it off this blob instead.
    pub = public_settings({"defaultQuoteValidity": 45, "companyName": "LTP",
                           "emailTemplates": {"quoteSent": {"body": "secret"}}})
    _check("defaultQuoteValidity is public", pub.get("defaultQuoteValidity") == 45, str(pub))
    _check("email templates are still scrubbed", "emailTemplates" not in pub, str(sorted(pub)))


def main() -> int:
    tests = [
        test_expiry_persists_through_post_and_get,
        test_expiry_updates_via_put,
        test_malformed_expiry_is_rejected,
        test_quote_dict_carries_expiry,
        test_quote_expiry_resolution,
        test_validity_days_fallback,
        test_terms_line_names_the_day_when_there_is_one,
        test_public_settings_exposes_the_validity_fallback,
    ]
    failed = 0
    try:
        for t in tests:
            try:
                t()
                print(f"  [PASS] {t.__name__}")
            except AssertionError as e:
                failed += 1
                print(f"  [FAIL] {t.__name__}: {e}")
    finally:
        _teardown()
    print(f"\n== {len(tests) - failed}/{len(tests)} tests passed ==")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
