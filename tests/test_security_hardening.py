"""Security-hardening regression tests (docs/SECURITY_REVIEW.md).

C1 — the public accept endpoint must only store signatures that are real
base64 raster images, so the staff-facing "View signature" popup can't be
turned into a stored-XSS sink (prefix/length checks alone let SVG payloads
and img-src attribute-breakout strings through).
"""
import base64
import os

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "http://localhost:8000/auth/callback")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import pytest
from fastapi import HTTPException

from backend.routes.view import _validate_signature_data_url, _sanitized_payload

# A real 1x1 transparent PNG (decodes to bytes starting with the PNG magic).
_PNG_1x1 = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _data_url(mime: str, raw: bytes) -> str:
    return f"data:{mime};base64," + base64.b64encode(raw).decode()


def test_valid_png_signature_accepted():
    # A genuine PNG must pass (no exception).
    _validate_signature_data_url(_PNG_1x1)


def test_valid_jpeg_signature_accepted():
    _validate_signature_data_url(_data_url("image/jpeg", b"\xff\xd8\xff\xe0" + b"\x00" * 16))


def test_svg_signature_rejected():
    # image/svg+xml is the one image/* type that can carry script.
    svg = _data_url("image/svg+xml", b"<svg onload=alert(1)></svg>")
    with pytest.raises(HTTPException) as ei:
        _validate_signature_data_url(svg)
    assert ei.value.status_code == 400


def test_attribute_breakout_rejected():
    # Starts with data:image/ (passes the old prefix check) but is not a real
    # base64 image — this is the string that would break out of the popup's
    # <img src="..."> attribute.
    payload = 'data:image/png"><script>alert(document.cookie)</script>'
    with pytest.raises(HTTPException):
        _validate_signature_data_url(payload)


def test_non_base64_rejected():
    with pytest.raises(HTTPException):
        _validate_signature_data_url("data:image/png;base64,@@@not base64@@@")


def test_non_image_base64_rejected():
    # Valid base64, but the bytes are not any known image (no magic number).
    with pytest.raises(HTTPException):
        _validate_signature_data_url(_data_url("image/png", b"this is not an image"))


def test_missing_base64_marker_rejected():
    # data:image/png,<raw> (no ;base64) — reject; we require base64 encoding.
    with pytest.raises(HTTPException):
        _validate_signature_data_url("data:image/png,iVBORw0KGgo")


# ── H2: rate-limit rule matching ───────────────────────────────────────────
# The previously-unthrottled families (public view, PDF, email relay, bulk
# sync, QBO callback) must now resolve to a limit, while ordinary /api routes
# stay unmatched, and prefixes must match on path segments (no /auth/loginX).

from backend.rate_limit import _match_rule


@pytest.mark.parametrize("path,expected_key", [
    ("/auth/login", "/auth/login"),
    ("/auth/callback", "/auth/callback"),
    ("/api/qbo/callback", "/api/qbo/callback"),
    ("/api/view/sometoken", "/api/view"),
    ("/api/view/sometoken/accept", "/api/view"),
    ("/api/view/sometoken/pdf", "/api/view"),
    ("/pdf/sometoken", "/pdf"),
    ("/api/email/send", "/api/email/send"),
])
def test_rate_limited_routes_match(path, expected_key):
    rule = _match_rule(path)
    assert rule is not None, f"{path} should be rate-limited"
    assert rule[0] == expected_key
    assert rule[1] > 0


@pytest.mark.parametrize("path", [
    "/api/companies",
    "/api/invoices/5",
    "/auth/loginX",        # not a path-segment prefix of /auth/login
    "/api/viewer",         # not a path-segment prefix of /api/view
    "/static/app.js",
    "/",
])
def test_unlimited_routes_pass_through(path):
    assert _match_rule(path) is None


# ── H3: share_token is server-authoritative ────────────────────────────────
# A client-supplied share_token (the public client-view credential) must be
# stripped by the write layer so a member can't pin it to a guessable value or
# rotate it. The token is minted server-side on create instead.

from backend.routes.api import _dict_to_row, _READONLY_COLS
from backend import models


def test_share_token_in_readonly_cols():
    assert "share_token" in _READONLY_COLS


def test_share_token_stripped_from_quote_writes():
    mapped = _dict_to_row({"shareToken": "attacker-chosen", "status": "draft"}, models.Quote)
    assert "share_token" not in mapped       # stripped
    assert mapped.get("status") == "draft"   # ordinary fields still write


def test_share_token_snake_case_also_stripped():
    # Defense against a client that sends the snake_case name directly.
    mapped = _dict_to_row({"share_token": "attacker-chosen"}, models.Invoice)
    assert "share_token" not in mapped


# ── L1: session tokens are hashed at rest ──────────────────────────────────

from backend.auth_deps import hash_session_token


def test_session_token_hash_deterministic_hex64():
    a = hash_session_token("a-raw-session-token")
    assert a == hash_session_token("a-raw-session-token")   # deterministic
    assert len(a) == 64 and all(c in "0123456789abcdef" for c in a)
    assert a != hash_session_token("a-raw-session-tokeN")    # input-sensitive
    assert a != "a-raw-session-token"                        # not the raw value


# ── H8: Origin/Referer CSRF middleware ─────────────────────────────────────

import asyncio

from backend.csrf import CsrfOriginMiddleware


def _run_csrf(method, headers):
    """Drive the middleware directly. Returns (inner_was_called, status_or_None)."""
    state = {"called": False}

    async def inner(scope, receive, send):
        state["called"] = True

    sent = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(msg):
        sent.append(msg)

    scope = {
        "type": "http",
        "method": method,
        "headers": [(k.encode("latin-1"), v.encode("latin-1")) for k, v in headers.items()],
    }
    asyncio.run(CsrfOriginMiddleware(inner)(scope, receive, send))
    status = next((m["status"] for m in sent if m.get("type") == "http.response.start"), None)
    return state["called"], status


def test_csrf_blocks_cross_origin_post():
    called, status = _run_csrf("POST", {"host": "app.example.com", "origin": "https://evil.com"})
    assert called is False and status == 403


def test_csrf_allows_same_origin_post():
    called, _ = _run_csrf("POST", {"host": "app.example.com", "origin": "https://app.example.com"})
    assert called is True


def test_csrf_allows_post_without_origin_or_referer():
    # server-to-server / curl / test client — no browser CSRF is possible
    called, _ = _run_csrf("POST", {"host": "app.example.com"})
    assert called is True


def test_csrf_ignores_safe_methods():
    called, _ = _run_csrf("GET", {"host": "app.example.com", "origin": "https://evil.com"})
    assert called is True


def test_csrf_falls_back_to_referer():
    called, status = _run_csrf("DELETE", {"host": "app.example.com", "referer": "https://evil.com/x"})
    assert called is False and status == 403


# ── M1: public view payload doesn't leak the token or payments ledger ──────

def test_public_payload_omits_share_token_and_payments():
    inv = models.Invoice(
        id=1, status="sent", share_token="super-secret-share-token",
        payments=[{"amount": 500, "method": "wire"}],
        sections=[], activity=[],
    )
    payload = _sanitized_payload("invoice", inv, {}, {}, {}, {})
    entity = payload["entity"]
    assert "shareToken" not in entity and "share_token" not in entity
    assert "payments" not in entity
    # FK ids are stripped too (existing behavior we rely on).
    for k in ("companyId", "clientContactId", "projectId", "quoteId"):
        assert k not in entity


# ── M3: key-rotation re-encryption helper ──────────────────────────────────

from backend import crypto as _crypto
from backend.rotate_encryption_key import _reencrypt


def test_reencrypt_roundtrip_preserves_plaintext():
    ct = _crypto.encrypt_token("a-secret-refresh-token")
    ct2 = _reencrypt(ct)
    assert _crypto.decrypt_token(ct2) == "a-secret-refresh-token"
    assert _reencrypt(None) is None
    assert _reencrypt("") is None


# ── H12: accept/decline audit metadata stays internal ──────────────────────

from backend.routes._shared import public_activity


def test_public_activity_strips_audit_and_internal_fields():
    entries = [{
        "id": "ca-x", "date": "2026-01-01", "time": "10:00",
        "type": "client_accepted", "user": "Client Name",
        "message": "Quote accepted by client",
        "signatureDataUrl": "data:image/png;base64,xxx", "comment": "ok",
        "ip": "1.2.3.4", "userAgent": "some-agent", "userId": 7,
    }]
    out = public_activity(entries)
    assert len(out) == 1
    # IP / User-Agent / internal user id never reach the public payload.
    for leaked in ("ip", "userAgent", "userId"):
        assert leaked not in out[0]
    assert out[0]["user"] == "Client Name"  # the name is still shown


# ── L5: rel=noopener on target=_blank email anchors ────────────────────────

from backend.sanitize import email_html


def test_email_html_adds_noopener_to_target_blank():
    out = email_html('<a href="https://x.com" target="_blank">x</a>')
    assert 'rel="noopener noreferrer"' in out
    assert email_html(out).count("rel=") == 1  # idempotent — no double rel


def test_email_html_leaves_non_blank_anchor_alone():
    out = email_html('<a href="https://x.com">x</a>')
    assert "rel=" not in out


# ── JSON container-shape validation ────────────────────────────────────────
# Every JSON column in models.py is declared `default=list` or `default=dict`
# and every reader assumes that shape, but nothing enforced it. `PUT
# /api/projects/{id}` with `{"schedule": true}` returned 200 and stored the
# bool, after which backend/payouts.py::derive_payout_drafts raised
# `TypeError: 'bool' object is not iterable` for EVERY project — one member's
# write took the payouts page down for the whole workspace until the row was
# repaired by hand. backend/validators.py now derives a container-type rule per
# JSON column from the column's own declared default.

def _rules():
    from backend import validators
    return validators._build_rules()


def _check_field(model_cls, field, value):
    """Run just this field's validator. Returns None on pass, the reason on
    failure — mirrors what validate() converts into a 400."""
    from backend import validators
    rule = _rules()[model_cls][field]
    try:
        rule(value)
        return None
    except ValueError as e:
        return str(e)


def test_json_shape_rules_are_derived_for_every_container_column():
    """Derived from the models, so a new JSON column is covered automatically
    and this can never drift the way a hand-maintained list would."""
    from sqlalchemy import JSON
    from backend import models, validators
    rules = _rules()
    missing = []
    for model_cls in rules:
        for col in model_cls.__table__.columns:
            if not isinstance(col.type, JSON):
                continue
            d = col.default
            if d is None or not getattr(d, "is_callable", False):
                continue
            if not isinstance(d.arg(None), (list, dict)):
                continue
            if col.name not in rules[model_cls]:
                missing.append(f"{model_cls.__name__}.{col.name}")
    assert not missing, f"JSON columns with no shape rule: {missing}"


def test_list_column_rejects_every_non_list_scalar():
    from backend import models
    for bad in ("hello", 42, True, 3.5, {"a": 1}):
        reason = _check_field(models.Project, "schedule", bad)
        assert reason is not None, f"schedule accepted {bad!r}"
        assert "must be a JSON list" in reason


def test_dict_column_rejects_a_list():
    from backend import models
    assert _check_field(models.Project, "budget", []) is not None
    assert _check_field(models.Project, "budget", {"lighting": 1}) is None


def test_container_columns_accept_their_declared_shape_and_null():
    from backend import models
    assert _check_field(models.Project, "schedule", []) is None
    assert _check_field(models.Project, "schedule", [{"date": "2026-07-10"}]) is None
    # null clears the field to the column default — must stay allowed
    assert _check_field(models.Project, "schedule", None) is None
    assert _check_field(models.Project, "budget", None) is None


def test_shape_check_does_not_reach_into_nested_contents():
    """Deliberately shallow: the readers guard per-element (payouts.py skips a
    non-dict entry), so tightening further would risk rejecting legacy rows."""
    from backend import models
    junk = [{"date": "x", "time": 123, "positions": "nope"}, "not-a-dict", None]
    assert _check_field(models.Project, "schedule", junk) is None


def test_snake_case_spelling_is_also_covered():
    """_dict_to_row accepts camelCase and snake_case alike, so registering only
    one spelling would leave the other as a bypass."""
    from backend import models
    rules = _rules()[models.Project]
    assert "contactIds" in rules and "contact_ids" in rules
    assert _check_field(models.Project, "contact_ids", "nope") is not None
    assert _check_field(models.Project, "contactIds", "nope") is not None


def test_derived_rules_do_not_clobber_hand_written_ones():
    from backend import models
    # `name`/`status` are hand-written; they must still be the real validators.
    assert _check_field(models.Project, "status", "not-a-status") is not None
    assert _check_field(models.Project, "status", "upcoming") is None


# ── M1 (completion): the public payload is an ALLOW-list ───────────────────
# The original M1 pass left three hand-maintained pop() lists behind. Between
# them they named "internalNotes" and "internal_notes" — neither of which
# quote_dict/invoice_dict ever produce. The real column is `notes`, annotated in
# models.py as "internal free-form text; never rendered client-side", so it was
# never stripped and shipped to every share-link holder. qbTaxSignature and the
# per-line-item `notes`/`taxable` leaked the same way. Both scrubs are now
# allow-lists (_shared._PUBLIC_ENTITY_KEYS / _PUBLIC_ITEM_KEYS) so a newly added
# column is absent from the public payload until someone deliberately adds it.

from datetime import datetime as _dt

from backend import models as _m


def _quote_with_internals():
    q = _m.Quote(
        id=7, client_type="company", company_id=3, client_contact_id=9,
        project_id=11, project_ids=[11, 12], status="sent",
        sent_date="2026-07-01", expiry_date="2026-08-01",
        custom_start_date="", custom_end_date="", custom_name="Gala",
        global_discount={}, terms="", activity=[],
        notes="INTERNAL: margin is thin, do not discount",
        share_token="SECRET-TOKEN-abc123",
        qb_tax_total=12.5, qb_tax_signature="internal-fingerprint-xyz",
        sections=[{"id": "s1", "label": "Audio", "projectId": 11, "items": [
            {"id": "i1", "type": "service", "name": "A1 Engineer", "qty": 2,
             "unitPrice": 1000, "adjustedPrice": None,
             "cost": 600, "deliveredQty": 2, "invoicedQty": 0,
             "notes": "INTERNAL: he owes us a favour", "taxable": True,
             "rateType": "day", "serviceId": 42, "productVariantId": "v9"},
            {"id": "n1", "type": "note", "text": "Load-in via the west dock.", "name": ""},
        ]}],
    )
    q.created_at = _dt(2026, 7, 1)
    return q


def _payload():
    return _sanitized_payload(
        "quote", _quote_with_internals(), {}, {}, {},
        {"companyName": "LTP", "defaultPaymentTerms": 45}, ["Gala"],
    )


def test_document_notes_never_reach_the_public_payload():
    """The leak M1 was written to close. `notes` is the actual column name; the
    old strip list named internalNotes/internal_notes, which never existed."""
    entity = _payload()["entity"]
    assert "notes" not in entity
    assert "INTERNAL: margin is thin" not in repr(_payload())


def test_qb_tax_signature_is_internal():
    assert "qbTaxSignature" not in _payload()["entity"]


def test_line_items_are_allow_listed_not_drop_listed():
    item = _payload()["entity"]["sections"][0]["items"][0]
    assert set(item) <= {"id", "type", "name", "text", "qty", "unitPrice",
                         "adjustedPrice", "rentalLabel", "qtyLabel"}
    for internal in ("cost", "deliveredQty", "invoicedQty", "notes", "taxable",
                     "rateType", "serviceId", "productVariantId"):
        assert internal not in item, f"line item leaked {internal}"
    # qtyLabel is derived from the internal rateType, which itself stays out.
    assert item["qtyLabel"] == "days"


def test_note_line_text_survives_the_scrub():
    """modules/client-view.js renders a note row as `n.text || n.name`. An
    allow-list that forgot `text` would silently blank every note on the
    customer-facing page — the exact risk of this conversion."""
    note = _payload()["entity"]["sections"][0]["items"][1]
    assert note["text"] == "Load-in via the west dock."


def test_everything_the_client_view_reads_still_arrives():
    """Guards the other direction: over-tightening breaks the customer page."""
    entity = _payload()["entity"]
    for needed in ("id", "status", "sections", "globalDiscount", "qbTaxTotal",
                   "customName", "customStartDate", "customEndDate",
                   "sentDate", "createdDate", "activity", "terms",
                   "projectNames"):
        assert needed in entity, f"public view lost {needed}"
    # doc_ref is computed from the scrubbed dict — it needs id + a date.
    assert _payload()["ref"] == "Q-2026-007"


def test_default_payment_terms_reaches_the_share_link():
    """theme.js::LTP_docTerms resolves {{paymentTerms}} as
    `String(s.defaultPaymentTerms || 30)`, so omitting this made the share link
    say Net 30 while the PDF printed the real number."""
    assert _payload()["settings"]["defaultPaymentTerms"] == 45


def test_a_new_internal_column_does_not_leak_by_default():
    """The structural point of the allow-list: an unrecognised key is dropped
    rather than shipped."""
    from backend.routes._shared import public_entity
    out = public_entity({"id": 1, "status": "sent", "someNewInternalColumn": "secret"})
    assert out == {"id": 1, "status": "sent"}


# ── Operational fail-safes + retirement of POST /api/sync ──────────────────

def test_env_int_rejects_garbage_and_out_of_range():
    """A bare int() on an env var raises at IMPORT time, which crash-loops the
    container before the app object exists — no traceback route, no health
    surface, just restarts. backend/rate_limit.py did that with
    LTP_TRUST_PROXY_HOPS; env_int is what main.py already used instead."""
    import os as _os
    from backend.env import env_int

    key = "LTP_TEST_ENV_INT_PROBE"
    try:
        _os.environ[key] = "2h"          # the typo that used to be fatal
        assert env_int(key, 7) == 7
        _os.environ[key] = ""
        assert env_int(key, 7) == 7
        _os.environ[key] = "12"
        assert env_int(key, 7) == 12
        # A poller interval of 0 parses fine and turns the loop into a hot spin
        # on the single event loop this app runs on.
        _os.environ[key] = "0"
        assert env_int(key, 3600, minimum=60) == 3600
        assert env_int(key, 7) == 0      # no floor asked for, no floor applied
        _os.environ.pop(key)
        assert env_int(key, 7) == 7
    finally:
        _os.environ.pop(key, None)


def test_trust_proxy_hops_is_parsed_defensively():
    """The specific import-time crash this replaced.

    Asserted at the source rather than by reloading the module: rate_limit is
    imported at app construction and backend/main.py binds RateLimitMiddleware
    from it, so importlib.reload() swaps the module out from under a live app
    and resets the shared _RateLimitState mid-suite. Not worth that risk to
    re-prove what test_env_int_rejects_garbage_and_out_of_range already covers.
    """
    import inspect
    from backend import rate_limit as _rl

    src = inspect.getsource(_rl)
    assert 'env_int("LTP_TRUST_PROXY_HOPS"' in src, "must parse defensively"
    assert 'int(os.environ.get("LTP_TRUST_PROXY_HOPS"' not in src, \
        "a bare int() here raises at import and crash-loops the container"
    assert _rl._TRUST_PROXY_HOPS >= 0


def test_production_is_detected_from_the_same_signals_main_uses():
    import os as _os
    from backend.env import looks_like_production

    keys = ("LTP_FORCE_HTTPS", "LTP_OAUTH_REDIRECT_URI")
    prev = {k: _os.environ.get(k) for k in keys}
    try:
        for k in keys:
            _os.environ.pop(k, None)
        assert looks_like_production() is False
        _os.environ["LTP_OAUTH_REDIRECT_URI"] = "http://localhost:8000/auth/callback"
        assert looks_like_production() is False
        _os.environ["LTP_OAUTH_REDIRECT_URI"] = "https://app.example.com/auth/callback"
        assert looks_like_production() is True
        _os.environ["LTP_OAUTH_REDIRECT_URI"] = "http://localhost:8000/auth/callback"
        _os.environ["LTP_FORCE_HTTPS"] = "1"
        assert looks_like_production() is True
    finally:
        for k, v in prev.items():
            if v is None:
                _os.environ.pop(k, None)
            else:
                _os.environ[k] = v


def test_webpush_sends_carry_a_timeout():
    """pywebpush defaults to timeout=None — block forever. The endpoint URL is
    client-supplied (routes/push.py takes it as a bare str) and _deliver runs
    inside the caller's transaction, so a dead host held a worker thread AND a
    DB session open."""
    import inspect
    from backend import webpush as _wp

    src = inspect.getsource(_wp._send_one)
    assert "timeout=" in src, "pywebpush call must pass an explicit timeout"
    assert isinstance(_wp._PUSH_TIMEOUT_SECONDS, (int, float))
    assert 0 < _wp._PUSH_TIMEOUT_SECONDS <= 60


def test_bulk_sync_endpoint_is_gone():
    """POST /api/sync wiped twelve entity tables from a request body and had no
    caller: the localStorage migration it existed for was finished, the app has
    been pure API-backed since, and it cascade-deleted client_rates without
    restoring them (that entity was never in its model map). Retired rather
    than left as a live wipe-everything endpoint."""
    from backend.routes import api as _api
    from backend.rate_limit import _match_rule

    assert not hasattr(_api, "bulk_sync")
    routes = [getattr(r, "path", "") for r in _api.router.routes]
    assert "/sync" not in routes and "/api/sync" not in routes, routes
    # Its rate-limit rule went with it; the path is now simply unmatched.
    assert _match_rule("/api/sync") is None
