"""Multi-project quotes & invoices — persistence, serialization, public view.

A project schedule can be sent into any of the client's existing DRAFT quotes /
invoices, whatever project that document started on, so one document may bill
work for several jobs. `project_id` stays the PRIMARY project (it names the
document on the PDF, in the QuickBooks memo and in push notifications) and the
new `project_ids` column carries the full contributing set, primary first.

Covers:
  - projectIds round-trips through the CRUD API on both quotes and invoices
    (it's a real column, so a missing migration would silently drop it —
    exactly the failure mode of the old invoice customName bug).
  - doc_project_ids() folds the primary in, de-duplicates, and preserves
    primary-first order — including for legacy rows written before the column
    existed (project_ids NULL).
  - load_project_names() resolves in order and degrades a deleted project to
    "Project <id>" rather than shortening the list.
  - The public client view (GET /api/view/{token}) exposes resolved
    projectNames and never leaks projectIds / projectId.
  - public_section_items() drops a section's internal projectId while keeping
    the label, which is what actually carries the job name to the client.
  - A section's projectId survives the CRUD round-trip inside the sections JSON.

Runs both as pytest and as a plain script:
    python tests/test_multi_project_docs.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_multi_project.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

# Fresh DB so the full migration stack (incl. project_ids) runs clean when this
# module is executed on its own.
_db_path = os.path.join(_root, "_test_multi_project.db")
if os.path.exists(_db_path):
    os.remove(_db_path)

from backend import models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402
from backend.routes._shared import (  # noqa: E402
    doc_project_ids, invoice_dict, load_project_names, public_section_items, quote_dict,
)

_ADMIN_TOK = "multiproj-admin-session"
_client = None
_seeded = False

PROJ_A = 7701   # "Riverfront Gala"  — the primary in most cases below
PROJ_B = 7702   # "Summit Keynote"   — the job appended into an existing doc
GONE_ID = 7799  # never created; stands in for a deleted project


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
                admin = models.User(google_sub="multiproj-admin-sub", email="multiproj-admin@biz.com",
                                    name="Multi Project Admin", role="admin")
                db.add(admin)
                await db.flush()
                db.add(models.Session(id=hash_session_token(_ADMIN_TOK), user_id=admin.id,
                                      expires_at=datetime.now(timezone.utc) + timedelta(days=7)))
                db.add(models.Project(id=PROJ_A, name="Riverfront Gala", start_date="2026-08-10"))
                db.add(models.Project(id=PROJ_B, name="Summit Keynote", start_date="2026-09-01"))
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


# ── The core round-trip: projectIds must reach the column ────────────────────

def test_quote_project_ids_round_trip():
    client, _ = _setup()
    body = {"clientType": "company", "status": "draft",
            "projectId": PROJ_A, "projectIds": [PROJ_A, PROJ_B]}
    r = client.post("/api/quotes", json=body, cookies=_cookies())
    _check("POST quote accepted", r.status_code == 200, r.text)
    created = r.json()
    _check("POST echoes projectIds", created.get("projectIds") == [PROJ_A, PROJ_B], str(created.get("projectIds")))

    got = client.get(f"/api/quotes/{created['id']}", cookies=_cookies()).json()
    _check("GET round-trips projectIds", got.get("projectIds") == [PROJ_A, PROJ_B], str(got.get("projectIds")))
    _check("primary project unchanged", got.get("projectId") == PROJ_A, str(got.get("projectId")))


def test_invoice_project_ids_round_trip_and_append():
    client, _ = _setup()
    # Starts life on one job...
    created = client.post("/api/invoices", json={"clientType": "company", "status": "draft",
                                                 "projectId": PROJ_A, "projectIds": [PROJ_A]},
                          cookies=_cookies()).json()
    inv_id = created["id"]
    _check("invoice created with one project", created.get("projectIds") == [PROJ_A], str(created.get("projectIds")))

    # ...then another job's schedule is appended into it. The PRIMARY must not move.
    upd = dict(created, projectIds=[PROJ_A, PROJ_B])
    r = client.put(f"/api/invoices/{inv_id}", json=upd, cookies=_cookies())
    _check("PUT accepted", r.status_code == 200, r.text)
    got = client.get(f"/api/invoices/{inv_id}", cookies=_cookies()).json()
    _check("second project persisted", got.get("projectIds") == [PROJ_A, PROJ_B], str(got.get("projectIds")))
    _check("primary still the first job", got.get("projectId") == PROJ_A, str(got.get("projectId")))


def test_section_project_id_survives_the_json_round_trip():
    # Section-level provenance lives inside the `sections` JSON blob, so it needs
    # no column — but it must not be filtered out on the way through the API.
    client, _ = _setup()
    sections = [{"id": "sec-1", "label": "Labor — Summit Keynote", "customDates": False,
                 "startDate": "", "endDate": "", "projectId": PROJ_B,
                 "items": [{"id": "it-1", "type": "service", "name": "A1 — Audio Lead",
                            "qty": 2, "unitPrice": 600, "cost": 300}]}]
    created = client.post("/api/quotes", json={"clientType": "company", "status": "draft",
                                               "projectId": PROJ_A, "projectIds": [PROJ_A, PROJ_B],
                                               "sections": sections}, cookies=_cookies()).json()
    got = client.get(f"/api/quotes/{created['id']}", cookies=_cookies()).json()
    _check("section survives", len(got.get("sections", [])) == 1, str(got.get("sections")))
    sec = got["sections"][0]
    _check("section projectId preserved", sec.get("projectId") == PROJ_B, str(sec.get("projectId")))
    _check("section label preserved", sec.get("label") == "Labor — Summit Keynote", str(sec.get("label")))


# ── doc_project_ids: the legacy-row contract ─────────────────────────────────

def test_doc_project_ids_normalization():
    # Legacy row: written before the column existed, so project_ids is NULL.
    legacy = models.Invoice(id=1, project_id=PROJ_A, project_ids=None,
                            share_token="tok-legacy-" + "x" * 12, client_type="company")
    _check("legacy row falls back to the primary", doc_project_ids(legacy) == [PROJ_A], str(doc_project_ids(legacy)))

    # Primary missing from the stored list is still folded in, and stays first.
    partial = models.Invoice(id=2, project_id=PROJ_A, project_ids=[PROJ_B],
                             share_token="tok-partial-" + "x" * 12, client_type="company")
    _check("primary folded in, first", doc_project_ids(partial) == [PROJ_A, PROJ_B], str(doc_project_ids(partial)))

    # Duplicates collapse.
    dupe = models.Quote(id=3, project_id=PROJ_A, project_ids=[PROJ_B, PROJ_A, PROJ_B],
                        share_token="tok-dupe-" + "x" * 12, client_type="company")
    _check("duplicates collapse", doc_project_ids(dupe) == [PROJ_A, PROJ_B], str(doc_project_ids(dupe)))

    # A project-less document keeps whatever list it has.
    orphan = models.Quote(id=4, project_id=None, project_ids=[PROJ_B],
                          share_token="tok-orphan-" + "x" * 12, client_type="company")
    _check("project-less doc keeps its list", doc_project_ids(orphan) == [PROJ_B], str(doc_project_ids(orphan)))

    # Nothing at all.
    empty = models.Quote(id=5, project_id=None, project_ids=None,
                         share_token="tok-empty-" + "x" * 12, client_type="company")
    _check("no projects -> empty", doc_project_ids(empty) == [], str(doc_project_ids(empty)))
    _check("None entity -> empty", doc_project_ids(None) == [])


def test_dict_converters_expose_project_ids():
    q = models.Quote(id=10, project_id=PROJ_A, project_ids=[PROJ_A, PROJ_B],
                     share_token="tok-q-" + "x" * 16, client_type="company")
    inv = models.Invoice(id=11, project_id=PROJ_B, project_ids=None,
                         share_token="tok-i-" + "x" * 16, client_type="company")
    _check("quote_dict carries projectIds", quote_dict(q).get("projectIds") == [PROJ_A, PROJ_B],
           str(quote_dict(q).get("projectIds")))
    # invoice_dict normalizes, so a legacy row still reports its one project.
    _check("invoice_dict normalizes a legacy row", invoice_dict(inv).get("projectIds") == [PROJ_B],
           str(invoice_dict(inv).get("projectIds")))


# ── load_project_names: order + deleted-project degradation ──────────────────

def test_load_project_names():
    _setup()
    from backend.database import async_session

    async def run():
        async with async_session() as db:
            in_order = await load_project_names(db, [PROJ_B, PROJ_A])
            reversed_ = await load_project_names(db, [PROJ_A, PROJ_B])
            with_gone = await load_project_names(db, [PROJ_A, GONE_ID])
            empty = await load_project_names(db, [])
            return in_order, reversed_, with_gone, empty

    in_order, reversed_, with_gone, empty = asyncio.run(run())
    _check("names follow the given order", in_order == ["Summit Keynote", "Riverfront Gala"], str(in_order))
    _check("order is not incidental", reversed_ == ["Riverfront Gala", "Summit Keynote"], str(reversed_))
    # Understating what a document covers would be worse than an ugly label.
    _check("deleted project degrades, doesn't vanish",
           with_gone == ["Riverfront Gala", f"Project {GONE_ID}"], str(with_gone))
    _check("empty list -> empty", empty == [], str(empty))


# ── Public client view ───────────────────────────────────────────────────────

def test_public_view_exposes_names_not_ids():
    client, _ = _setup()
    sections = [{"id": "sec-1", "label": "Labor — Summit Keynote", "projectId": PROJ_B,
                 "items": [{"id": "it-1", "type": "service", "name": "A1 — Audio Lead",
                            "qty": 2, "unitPrice": 600, "cost": 300,
                            "deliveredQty": 1, "invoicedQty": 0}]}]
    created = client.post("/api/quotes", json={"clientType": "company", "status": "sent",
                                               "projectId": PROJ_A, "projectIds": [PROJ_A, PROJ_B],
                                               "sections": sections}, cookies=_cookies()).json()
    token = created["shareToken"]

    # Public endpoint — no session cookie.
    r = client.get(f"/api/view/{token}")
    _check("public view reachable", r.status_code == 200, r.text)
    entity = r.json()["entity"]

    _check("projectNames resolved for the client",
           entity.get("projectNames") == ["Riverfront Gala", "Summit Keynote"], str(entity.get("projectNames")))
    # Internal FK ids must never reach the client — projectIds joins the list
    # that projectId/companyId/quoteId were already on.
    _check("projectIds stripped", "projectIds" not in entity, str(entity.keys()))
    _check("projectId stripped", "projectId" not in entity)
    _check("companyId stripped", "companyId" not in entity)

    # The section label is what actually tells the client which job the work is
    # for; the section's internal projectId is scrubbed with the cost fields.
    sec = entity["sections"][0]
    _check("section label reaches the client", sec.get("label") == "Labor — Summit Keynote", str(sec.get("label")))
    _check("section projectId scrubbed", "projectId" not in sec, str(sec.keys()))
    _check("cost still scrubbed", "cost" not in sec["items"][0], str(sec["items"][0].keys()))


def test_public_section_items_whitelist():
    # Guards the scrub directly: a new section-level field must be a deliberate
    # addition to the whitelist, never an accidental leak.
    out = public_section_items([{
        "id": "s1", "label": "Labor — Summit Keynote", "customDates": True,
        "startDate": "2026-09-01", "endDate": "2026-09-03", "projectId": PROJ_B,
        "items": [{"id": "i1", "name": "A1", "qty": 1, "unitPrice": 600,
                   "cost": 300, "deliveredQty": 1, "invoicedQty": 1}],
    }])
    sec = out[0]
    _check("label kept", sec["label"] == "Labor — Summit Keynote")
    _check("dates kept", (sec["customDates"], sec["startDate"], sec["endDate"]) == (True, "2026-09-01", "2026-09-03"))
    _check("section projectId dropped", "projectId" not in sec, str(sec.keys()))
    item = sec["items"][0]
    _check("item cost dropped", "cost" not in item)
    _check("item ledger fields dropped", "deliveredQty" not in item and "invoicedQty" not in item)
    _check("item name kept", item["name"] == "A1")


def main() -> int:
    tests = [
        test_quote_project_ids_round_trip,
        test_invoice_project_ids_round_trip_and_append,
        test_section_project_id_survives_the_json_round_trip,
        test_doc_project_ids_normalization,
        test_dict_converters_expose_project_ids,
        test_load_project_names,
        test_public_view_exposes_names_not_ids,
        test_public_section_items_whitelist,
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
