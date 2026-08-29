"""Terms & conditions — the resolver, and its agreement with the JS twin.

The bullet block at the foot of a quote/invoice used to be a hardcoded array in
backend/pdf_generator.py AND again in modules/client-view.js. The business could
not change its own terms without a code change, and the two copies could drift —
so a client's emailed PDF and the link inside it could carry different terms.

Now one rule, implemented twice (Python here, window.LTP_docTerms in theme.js)
because the PDF renders server-side and the app/client view render in a browser.
Two implementations of one rule is a drift risk, so this file pins BOTH: the
Python directly, and the JS by running node over the same table and comparing.

Covers:
  - the fallback chain: document terms -> workspace default -> built-in
  - one line per bullet, blanks dropped
  - {{token}} substitution, and the two rules that are easy to get backwards:
      * a line naming a value the document lacks is dropped whole
      * an UNKNOWN token is left literal (a typo should be visible)
  - the invoice line tracking workspace net terms rather than a hardcoded 30
  - round-tripping `terms` through the CRUD API, and the length cap

Runs both as pytest and as a plain script:
    python tests/test_doc_terms.py
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_doc_terms.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

# Fresh DB so the full migration stack (incl. the terms columns) runs clean when
# this module is executed on its own.
_db_path = os.path.join(_root, "_test_doc_terms.db")
if os.path.exists(_db_path):
    os.remove(_db_path)

import pytest  # noqa: E402

from backend import models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402
from backend.pdf_generator import doc_terms, doc_terms_text  # noqa: E402
from backend.routes._shared import public_settings  # noqa: E402

_ADMIN_TOK = "docterms-admin-session"
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
                admin = models.User(google_sub="docterms-sub", email="docterms@biz.com",
                                    name="Terms Admin", role="admin")
                db.add(admin)
                await db.flush()
                db.add(models.Session(id=hash_session_token(_ADMIN_TOK), user_id=admin.id,
                                      expires_at=datetime.now(timezone.utc) + timedelta(days=7)))
                await db.commit()

        asyncio.run(seed())
        _seeded = True
    return _client


def _cookies():
    return {"ltp_session": _ADMIN_TOK}

SETTINGS = {"defaultPaymentTerms": 20, "defaultQuoteValidity": 30, "companyName": "LTP"}


# ── The fallback chain ──────────────────────────────────────────────────────

def test_document_terms_win():
    assert doc_terms_text({"terms": "Mine."}, "quote", SETTINGS) == "Mine."
    # Whitespace-only is "not set", not "deliberately blank" — otherwise a stray
    # space in the textarea would silently wipe a client's terms.
    assert doc_terms_text({"terms": "   \n  "}, "quote", dict(SETTINGS, defaultQuoteTerms="House.")) == "House."


def test_workspace_default_is_next():
    s = dict(SETTINGS, defaultQuoteTerms="House rule.")
    assert doc_terms_text({}, "quote", s) == "House rule."
    assert doc_terms_text({"terms": "Mine."}, "quote", s) == "Mine."


def test_builtin_is_last():
    got = doc_terms_text({}, "quote", SETTINGS)
    assert "Prices are subject to equipment availability" in got
    got = doc_terms_text({}, "invoice", SETTINGS)
    assert "finance charge" in got


def test_kind_is_not_confused():
    s = dict(SETTINGS, defaultQuoteTerms="Q.", defaultInvoiceTerms="I.")
    assert doc_terms_text({}, "quote", s) == "Q."
    assert doc_terms_text({}, "invoice", s) == "I."
    # Anything that isn't "invoice" is a quote — the kind comes from a route
    # segment, and a typo must not silently print invoice terms on a quote.
    assert doc_terms_text({}, "estimate", s) == "Q."


# ── Lines and placeholders ──────────────────────────────────────────────────

def test_one_line_per_bullet_blanks_dropped():
    e = {"terms": "  First  \n\n\n  Second  \n   \n"}
    assert doc_terms(e, "quote", SETTINGS) == ["First", "Second"]


def test_known_tokens_substitute():
    e = {"terms": "Good through {{expiryDate}} from {{companyName}}.", "expiryDate": "2026-09-25"}
    assert doc_terms(e, "quote", SETTINGS) == ["Good through September 25th, 2026 from LTP."]


def test_a_line_naming_a_missing_value_is_dropped():
    # An unsent quote with no expiry has no deadline to promise. Printing
    # "This quote is valid through ." is worse than saying nothing.
    e = {"terms": "Valid through {{expiryDate}}.\nAlways true."}
    assert doc_terms(e, "quote", SETTINGS) == ["Always true."]


def test_unknown_tokens_stay_literal():
    # The opposite rule, and the one that's easy to get backwards: a typo must
    # stay visible rather than silently eating the line it sits in.
    e = {"terms": "Ask about {{discountz}}."}
    assert doc_terms(e, "quote", SETTINGS) == ["Ask about {{discountz}}."]


def test_invoice_tokens():
    e = {"terms": "Due {{dueDate}}, net {{paymentTerms}}.", "dueDate": "2026-09-15"}
    assert doc_terms(e, "invoice", SETTINGS) == ["Due September 15th, 2026, net 20."]


def test_builtin_invoice_line_tracks_workspace_terms():
    # It used to say a hardcoded "within 30 days" regardless of the setting.
    got = doc_terms({}, "invoice", dict(SETTINGS, defaultPaymentTerms=45))
    assert got[0].startswith("Payment is due within 45 days"), got[0]


def test_builtin_quote_line_names_the_expiry():
    got = doc_terms({"expiryDate": "2026-12-24"}, "quote", SETTINGS)
    assert got[0] == "This quote is valid through December 24th, 2026.", got[0]


def test_tolerates_nothing():
    assert doc_terms(None, "quote", None)      # built-in, no crash
    assert doc_terms({}, "invoice", {})


# ── The JS twin must agree, line for line ───────────────────────────────────

_CASES = [
    ({"expiryDate": "2026-09-25"}, "quote"),
    ({}, "quote"),
    ({"dueDate": "2026-09-15"}, "invoice"),
    ({}, "invoice"),
    ({"terms": "One\n\n  Two {{companyName}}  \n{{nope}} stays\n"}, "quote"),
    ({"terms": "Valid through {{expiryDate}}.\nAlways."}, "quote"),
    ({"terms": "Due {{dueDate}}.", "dueDate": "2026-10-01"}, "invoice"),
    ({"sentDate": "2026-08-01"}, "quote"),          # expiry via the sentDate fallback
]


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_js_twin_matches_python():
    # theme.js is now theme.js + components/domain-*.js (LTP_docTerms lives in
    # domain-docs.js). The file list is read from index.html by
    # tests/_load_domain.js, so this cannot drift from what the browser loads.
    script = (
        "require('./tests/_load_domain.js').loadDomain();"
        "const cases=JSON.parse(process.argv[1]);"
        "const settings=JSON.parse(process.argv[2]);"
        "console.log(JSON.stringify(cases.map(c=>window.LTP_docTerms(c[0],c[1],settings))));"
    )
    proc = subprocess.run(
        ["node", "-e", script, json.dumps(_CASES), json.dumps(SETTINGS)],
        cwd=_root, capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    from_js = json.loads(proc.stdout)
    from_py = [doc_terms(entity, kind, SETTINGS) for entity, kind in _CASES]
    for (entity, kind), js, py in zip(_CASES, from_js, from_py):
        assert js == py, f"{kind} {entity}\n  js={js}\n  py={py}"


# ── Persistence ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("kind", ["quotes", "invoices"])
def test_terms_round_trip(kind):
    client = _setup()
    body = {"clientType": "company", "terms": "Line one.\nLine two."}
    created = client.post(f"/api/{kind}", json=body, cookies=_cookies())
    assert created.status_code == 200, created.text
    doc = created.json()
    assert doc.get("terms") == "Line one.\nLine two.", doc.get("terms")

    got = client.get(f"/api/{kind}/{doc['id']}", cookies=_cookies()).json()
    assert got.get("terms") == "Line one.\nLine two."

    # Clearing back to "" is how the builder says "follow the default again", so
    # an empty string must be storable rather than rejected as missing.
    upd = client.put(f"/api/{kind}/{doc['id']}", json=dict(got, terms=""), cookies=_cookies())
    assert upd.status_code == 200, upd.text
    assert not client.get(f"/api/{kind}/{doc['id']}", cookies=_cookies()).json().get("terms")


@pytest.mark.parametrize("kind", ["quotes", "invoices"])
def test_absurdly_long_terms_are_rejected(kind):
    # Bounded so a runaway paste can't wedge PDF layout or bloat every payload.
    client = _setup()
    r = client.post(f"/api/{kind}", json={"clientType": "company", "terms": "x" * 4001},
                    cookies=_cookies())
    assert r.status_code == 400, r.text


def test_public_settings_carries_the_workspace_terms():
    # The client view resolves the same fallback chain with no session, so it
    # needs the defaults — but must still not see the private blob.
    pub = public_settings({"defaultQuoteTerms": "Q terms", "defaultInvoiceTerms": "I terms",
                           "companyName": "LTP", "emailTemplates": {"quoteSent": {"body": "secret"}}})
    assert pub.get("defaultQuoteTerms") == "Q terms"
    assert pub.get("defaultInvoiceTerms") == "I terms"
    assert "emailTemplates" not in pub


def main() -> int:
    # Parametrized tests need pytest to supply their arguments; the script mode
    # runs the rest and says so rather than pretending it covered everything.
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)
             and not hasattr(v, "pytestmark")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  [PASS] {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  [FAIL] {t.__name__}: {e}")
    print(f"\n== {len(tests) - failed}/{len(tests)} tests passed ==")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
