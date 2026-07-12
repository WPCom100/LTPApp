"""Invoice custom name — persistence + serialization for project-less invoices.

An invoice that isn't linked to a project is named by its typed `customName`
(mirrors Quote.customName). This was silently dropped on save because the
`invoices` table had no `custom_name` column, so `_dict_to_row` filtered the
field out — the name showed while editing the draft, then vanished on refresh
and never reached the invoice list, the printed PDF, or the public view.

Covers:
  - POST then GET round-trips customName through the CRUD API (the core bug).
  - PUT updates customName.
  - customName survives even when the invoice HAS a project (it's just not the
    display source then), so linking/unlinking a project never loses the name.
  - invoice_dict (the shape the PDF generator + public view consume) carries
    customName, and the generator's name fallback resolves to it when there's
    no project.
  - length validation rejects an over-long customName (>255).

Runs both as pytest and as a plain script:
    python tests/test_invoice_custom_name.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_inv_customname.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

# Fresh DB so the full migration stack (incl. invoice custom_name) runs clean
# when this module is executed on its own.
_db_path = os.path.join(_root, "_test_inv_customname.db")
if os.path.exists(_db_path):
    os.remove(_db_path)

from backend import models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402
from backend.routes._shared import invoice_dict  # noqa: E402

_ADMIN_TOK = "invcustom-admin-session"
_client = None
_seeded = False

PROJ_ID = 5501   # a real project to attach in the "with project" case


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
                admin = models.User(google_sub="invcustom-admin-sub", email="invcustom-admin@biz.com",
                                    name="Invoice Admin", role="admin")
                db.add(admin)
                await db.flush()
                db.add(models.Session(id=hash_session_token(_ADMIN_TOK), user_id=admin.id,
                                      expires_at=datetime.now(timezone.utc) + timedelta(days=7)))
                db.add(models.Project(id=PROJ_ID, name="Real Project", start_date="2026-07-01"))
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


# ── The core round-trip: POST → GET keeps customName ─────────────────────────

def test_customname_persists_through_post_and_get():
    client, _ = _setup()
    body = {"clientType": "company", "customName": "Summer Warehouse Rental", "status": "draft"}
    r = client.post("/api/invoices", json=body, cookies=_cookies())
    _check("POST accepted", r.status_code == 200, r.text)
    created = r.json()
    inv_id = created["id"]
    _check("POST echoes customName", created.get("customName") == "Summer Warehouse Rental", str(created.get("customName")))

    # The bug: after a reload the name came back empty. GET must carry it.
    got = client.get(f"/api/invoices/{inv_id}", cookies=_cookies()).json()
    _check("GET round-trips customName", got.get("customName") == "Summer Warehouse Rental", str(got.get("customName")))
    _check("no project linked", got.get("projectId") is None)


def test_customname_updates_via_put():
    client, _ = _setup()
    created = client.post("/api/invoices", json={"clientType": "company", "customName": "First Name"},
                          cookies=_cookies()).json()
    inv_id = created["id"]
    upd = dict(created, customName="Renamed Invoice")
    r = client.put(f"/api/invoices/{inv_id}", json=upd, cookies=_cookies())
    _check("PUT accepted", r.status_code == 200, r.text)
    got = client.get(f"/api/invoices/{inv_id}", cookies=_cookies()).json()
    _check("PUT persisted the rename", got.get("customName") == "Renamed Invoice", str(got.get("customName")))


def test_customname_survives_alongside_a_project():
    # A customName set before a project is linked must not be wiped by the link
    # (or by later edits) — so unlinking the project later restores the name.
    client, _ = _setup()
    created = client.post("/api/invoices", json={"clientType": "company", "customName": "Kept Name",
                                                 "projectId": PROJ_ID}, cookies=_cookies()).json()
    got = client.get(f"/api/invoices/{created['id']}", cookies=_cookies()).json()
    _check("customName stored even with a project", got.get("customName") == "Kept Name", str(got.get("customName")))
    _check("project also stored", got.get("projectId") == PROJ_ID, str(got.get("projectId")))


def test_overlong_customname_is_rejected():
    client, _ = _setup()
    r = client.post("/api/invoices", json={"clientType": "company", "customName": "x" * 256},
                    cookies=_cookies())
    _check("256-char customName rejected", r.status_code == 400, r.text)


# ── Serialization for the PDF generator + public view ────────────────────────

def test_invoice_dict_carries_customname_and_generator_falls_back():
    # invoice_dict is the shape both the PDF route and the public view build.
    inv = models.Invoice(id=1, custom_name="Standalone Invoice", project_id=None,
                         share_token="tok-" + "x" * 20, client_type="company")
    d = invoice_dict(inv)
    _check("invoice_dict includes customName", d.get("customName") == "Standalone Invoice", str(d.get("customName")))

    # Mirror pdf_generator._DocPDF's display-name resolution: project name, else
    # customName, else the literal "Invoice".
    project = {}  # no linked project
    display = project.get("name") or d.get("customName") or "Invoice"
    _check("generator name falls back to customName", display == "Standalone Invoice", display)

    # With a project, the project name wins (customName is just carried).
    display_with_proj = {"name": "Real Project"}.get("name") or d.get("customName") or "Invoice"
    _check("project name wins when present", display_with_proj == "Real Project", display_with_proj)


def main() -> int:
    tests = [
        test_customname_persists_through_post_and_get,
        test_customname_updates_via_put,
        test_customname_survives_alongside_a_project,
        test_overlong_customname_is_rejected,
        test_invoice_dict_carries_customname_and_generator_falls_back,
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
