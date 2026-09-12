"""Bookings derived from confirmed documents (backend/rental_bookings.py).

Until this engine existed nothing in the app wrote an Allocation — the
Availability Checker's "out" figures could only ever be zero. These tests pin
the policy the owner confirmed ("similar to quotes, it's not marked as
unavailable until it's confirmed"):

  Pure (booking_lines over plain row objects):
    - a draft/sent quote books nothing; an accepted one books each equipment
      line for the document's dates
    - a section with its own rental period books on those dates; a section
      appended from another project books on that project's dates
    - no resolvable dates → the line is skipped, never booked blind
    - an accepted quote books only the un-invoiced remainder
    - an invoice books in every status
    - non-equipment lines, zero qty, and a boolean equipmentId are ignored

  Through the API (the reconcile is wired into POST/PUT/DELETE + client accept):
    - accepting a quote creates reserved bookings keyed by (quote, id, line)
    - editing the accepted quote updates the same rows, never stacks new ones
    - a booking someone checked out survives the quote going back to sent;
      the still-reserved one is released
    - converting: the quote's booking shrinks by what was invoiced while the
      invoice books what it drew — no double count
    - deleting a document releases its reservations
    - the public accept link books, with no producer session
    - manual bookings are never touched; the rebuild endpoint is admin-only

Runs both as pytest and as a plain script:
    python tests/test_rental_bookings.py
"""
import asyncio
import base64
import os
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_rental_bookings.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

_db_path = os.path.join(_root, "_test_rental_bookings.db")
if os.path.exists(_db_path):
    os.remove(_db_path)

from backend import models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402
from backend.rental_bookings import booking_lines, doc_books  # noqa: E402

_ADMIN_TOK = "bookings-admin-session-token-xyz"
_MEMBER_TOK = "bookings-member-session-token-xyz"
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
                admin = models.User(google_sub="bookings-admin-sub", email="bookings-admin@biz.com",
                                    name="Bookings Admin", role="admin")
                member = models.User(google_sub="bookings-member-sub", email="bookings-member@biz.com",
                                     name="Bookings Member", role="member")
                db.add_all([admin, member])
                await db.flush()
                exp = datetime.now(timezone.utc) + timedelta(days=7)
                db.add(models.Session(id=hash_session_token(_ADMIN_TOK), user_id=admin.id, expires_at=exp))
                db.add(models.Session(id=hash_session_token(_MEMBER_TOK), user_id=member.id, expires_at=exp))
                await db.commit()

        asyncio.run(seed())
        _seeded = True
    return _client, _ADMIN_TOK


_results: list = []


def _check(label, cond, detail=""):
    _results.append((label, bool(cond)))
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  ({detail})" if detail else ""))
    assert cond, f"{label} {detail}"


def _cookies(tok=_ADMIN_TOK):
    return {"ltp_session": tok}


def _post(client, path, body):
    r = client.post(path, json=body, cookies=_cookies())
    _check(f"POST {path} ok", r.status_code == 200, r.text[:200])
    return r.json()


def _put(client, path, body):
    r = client.put(path, json=body, cookies=_cookies())
    _check(f"PUT {path} ok", r.status_code == 200, r.text[:200])
    return r.json()


def _allocs(client, doc_type=None, doc_id=None):
    rows = client.get("/api/allocations", cookies=_cookies()).json()
    if doc_type is not None:
        rows = [a for a in rows if a["docType"] == doc_type and a["docId"] == doc_id]
    return rows


# ── Pure: booking_lines ───────────────────────────────────────────────────────

def _proj(pid, start, end):
    return SimpleNamespace(id=pid, start_date=start, end_date=end)


def _quote(status="accepted", project_id=1, sections=None, custom=("", "")):
    return SimpleNamespace(id=50, status=status, project_id=project_id, sections=sections or [],
                           custom_start_date=custom[0], custom_end_date=custom[1])


def _invoice(status="draft", project_id=1, sections=None):
    return SimpleNamespace(id=70, status=status, project_id=project_id, sections=sections or [])


def _sec(items, **kw):
    d = {"id": "sec-1", "label": "Lighting", "customDates": False, "startDate": "", "endDate": "", "items": items}
    d.update(kw)
    return d


def _eq(line_id, eq_id, qty, **kw):
    d = {"id": line_id, "type": "equipment", "equipmentId": eq_id, "qty": qty, "name": "x"}
    d.update(kw)
    return d


def test_pure_quote_status_gates_booking():
    projects = {1: _proj(1, "2026-11-01", "2026-11-03")}
    sec = _sec([_eq("l1", 5, 4)])
    for st in ("draft", "sent", "declined", "converted"):
        _check(f"{st} quote books nothing", booking_lines("quote", _quote(st, sections=[sec]), projects) == [])
        _check(f"doc_books false for {st} quote", not doc_books("quote", _quote(st)))
    got = booking_lines("quote", _quote("accepted", sections=[sec]), projects)
    _check("accepted quote books its line", len(got) == 1)
    _check("…on the project's dates", got[0]["start_date"] == "2026-11-01" and got[0]["end_date"] == "2026-11-03")
    _check("…with item, qty, line id, project", got[0]["equipment_id"] == 5 and got[0]["qty"] == 4
           and got[0]["line_id"] == "l1" and got[0]["project_id"] == 1)


def test_pure_section_dates_win_over_document_dates():
    projects = {1: _proj(1, "2026-11-01", "2026-11-03")}
    sec = _sec([_eq("l1", 5, 1)], customDates=True, startDate="2026-11-10", endDate="2026-11-12")
    got = booking_lines("quote", _quote(sections=[sec]), projects)
    _check("custom section period books on its own dates", got[0]["start_date"] == "2026-11-10" and got[0]["end_date"] == "2026-11-12")
    # customDates flag set but dates blank → falls back to document dates
    sec2 = _sec([_eq("l1", 5, 1)], customDates=True, startDate="", endDate="")
    got2 = booking_lines("quote", _quote(sections=[sec2]), projects)
    _check("blank custom dates fall back to the document's", got2[0]["start_date"] == "2026-11-01")


def test_pure_other_project_section_books_on_that_project():
    projects = {1: _proj(1, "2026-11-01", "2026-11-03"), 2: _proj(2, "2026-12-05", "2026-12-06")}
    sec = _sec([_eq("l1", 5, 1)], projectId=2)
    got = booking_lines("quote", _quote(sections=[sec]), projects)
    _check("appended section books on ITS project's dates", got[0]["start_date"] == "2026-12-05")
    _check("…and is attributed to that project", got[0]["project_id"] == 2)


def test_pure_no_dates_means_no_booking():
    sec = _sec([_eq("l1", 5, 1)])
    _check("quote with no project and no custom dates books nothing",
           booking_lines("quote", _quote(project_id=None, sections=[sec]), {}) == [])
    _check("quote whose project is missing books nothing",
           booking_lines("quote", _quote(project_id=9, sections=[sec]), {}) == [])
    got = booking_lines("quote", _quote(project_id=None, sections=[sec], custom=("2026-11-20", "2026-11-21")), {})
    _check("quote with custom dates and no project books on them", got and got[0]["start_date"] == "2026-11-20")
    _check("…with no project attribution", got[0]["project_id"] is None)
    inverted = _quote(project_id=None, sections=[sec], custom=("2026-11-21", "2026-11-20"))
    _check("an end before its start books nothing", booking_lines("quote", inverted, {}) == [])


def test_pure_invoiced_remainder_and_invoice_books_always():
    projects = {1: _proj(1, "2026-11-01", "2026-11-03")}
    sec = _sec([_eq("l1", 5, 10, invoicedQty=4)])
    got = booking_lines("quote", _quote(sections=[sec]), projects)
    _check("accepted quote books the un-invoiced remainder", got[0]["qty"] == 6)
    fully = _sec([_eq("l1", 5, 10, invoicedQty=10)])
    _check("fully invoiced line books nothing on the quote", booking_lines("quote", _quote(sections=[fully]), projects) == [])
    for st in ("draft", "sent", "partial", "paid", "overdue"):
        got = booking_lines("invoice", _invoice(st, sections=[_sec([_eq("i1", 5, 4, linkedQty=4)])]), projects)
        _check(f"{st} invoice books its line", len(got) == 1 and got[0]["qty"] == 4)


def test_pure_ignores_what_it_should():
    projects = {1: _proj(1, "2026-11-01", "2026-11-03")}
    sec = _sec([
        {"id": "s1", "type": "service", "serviceId": 3, "qty": 2},
        {"id": "n1", "type": "note", "name": "hi"},
        _eq("z", 5, 0),
        _eq("b", True, 1),
        _eq("", 5, 1),
        _eq("neg", 5, -3),
        "garbage",
        None,
    ])
    _check("services/notes/zero/bool/blank-id/negative/garbage all ignored",
           booking_lines("quote", _quote(sections=[sec, "not a section", None]), projects) == [])
    _check("non-list sections tolerated",
           booking_lines("quote", _quote(sections="oops"), projects) == [])


# ── Through the API ──────────────────────────────────────────────────────────

_ids: dict = {}


def _fixtures(client):
    if _ids:
        return _ids
    _ids["co"] = _post(client, "/api/companies", {"id": 8101, "name": "Gala Co", "isClient": True})["id"]
    _ids["proj"] = _post(client, "/api/projects", {"id": 8101, "name": "Autumn Gala", "companyId": 8101,
                                                   "status": "upcoming", "startDate": "2026-11-01", "endDate": "2026-11-03"})["id"]
    _ids["eqA"] = _post(client, "/api/equipment", {"id": 8101, "name": "Mover A", "qty": 10,
                                                   "rates": {"threeDay": 100, "week": 200, "month": 500}})["id"]
    _ids["eqB"] = _post(client, "/api/equipment", {"id": 8102, "name": "Hazer B", "qty": 3,
                                                   "rates": {"threeDay": 50, "week": 100, "month": 250}})["id"]
    return _ids


def _quote_body(qid, ids, status, qty_a=4, qty_b=1, **extra):
    body = {
        "id": qid, "clientType": "company", "companyId": ids["co"], "projectId": ids["proj"], "status": status,
        "sections": [{"id": f"sec-{qid}", "label": "Lighting", "customDates": False, "startDate": "", "endDate": "",
                      "items": [
                          {"id": f"q{qid}-a", "type": "equipment", "equipmentId": ids["eqA"], "name": "Mover A",
                           "qty": qty_a, "unitPrice": 100, "deliveredQty": 0, "invoicedQty": 0},
                          {"id": f"q{qid}-b", "type": "equipment", "equipmentId": ids["eqB"], "name": "Hazer B",
                           "qty": qty_b, "unitPrice": 50, "deliveredQty": 0, "invoicedQty": 0},
                          {"id": f"q{qid}-s", "type": "service", "serviceId": None, "name": "L1", "qty": 1, "unitPrice": 400},
                      ]}],
    }
    body.update(extra)
    return body


def test_api_accepting_a_quote_books_and_editing_updates_in_place():
    client, _ = _setup()
    ids = _fixtures(client)
    _post(client, "/api/quotes", _quote_body(8101, ids, "draft"))
    _check("a draft quote books nothing", _allocs(client, "quote", 8101) == [])
    _put(client, "/api/quotes/8101", _quote_body(8101, ids, "sent"))
    _check("a sent quote books nothing", _allocs(client, "quote", 8101) == [])
    _put(client, "/api/quotes/8101", _quote_body(8101, ids, "accepted"))
    rows = _allocs(client, "quote", 8101)
    _check("accepting books one allocation per equipment line", len(rows) == 2, str(rows))
    a = next(r for r in rows if r["lineId"] == "q8101-a")
    _check("…reserved", a["state"] == "reserved")
    _check("…qty from the line", a["qty"] == 4)
    _check("…dates from the project", a["startDate"] == "2026-11-01" and a["endDate"] == "2026-11-03")
    _check("…attributed to the project", a["projectId"] == ids["proj"])
    _check("…item from the line", a["equipmentId"] == ids["eqA"])
    first_ids = sorted(r["id"] for r in rows)

    _put(client, "/api/quotes/8101", _quote_body(8101, ids, "accepted", qty_a=7))
    rows = _allocs(client, "quote", 8101)
    _check("editing the accepted quote keeps the same rows", sorted(r["id"] for r in rows) == first_ids)
    _check("…and updates the qty", next(r for r in rows if r["lineId"] == "q8101-a")["qty"] == 7)

    # Someone checks the movers out; the hazer stays a reservation.
    _put(client, f"/api/allocations/{a['id']}", {"state": "checked-out"})
    _put(client, "/api/quotes/8101", _quote_body(8101, ids, "sent", qty_a=7))
    rows = _allocs(client, "quote", 8101)
    _check("back to sent releases the reservation", not any(r["lineId"] == "q8101-b" for r in rows))
    _check("…but gear already checked out stays booked", any(r["lineId"] == "q8101-a" and r["state"] == "checked-out" for r in rows))
    # Re-accepting re-books the hazer and leaves the checked-out row alone.
    _put(client, "/api/quotes/8101", _quote_body(8101, ids, "accepted", qty_a=7))
    rows = _allocs(client, "quote", 8101)
    _check("re-accepting re-books the released line", len(rows) == 2)
    _check("…without duplicating the checked-out one", sum(1 for r in rows if r["lineId"] == "q8101-a") == 1)


def test_api_conversion_hands_the_booking_to_the_invoice():
    client, _ = _setup()
    ids = _fixtures(client)
    _post(client, "/api/quotes", _quote_body(8102, ids, "accepted", qty_a=10, qty_b=0))
    q_rows = _allocs(client, "quote", 8102)
    _check("accepted quote books 10", len(q_rows) == 1 and q_rows[0]["qty"] == 10)

    # The frontend's convert flow: invoice draws 4, quote line records invoicedQty 4.
    inv = {"id": 8102, "clientType": "company", "companyId": ids["co"], "projectId": ids["proj"], "quoteId": 8102,
           "status": "draft", "sections": [{"id": "isec", "label": "Lighting", "customDates": False, "startDate": "",
                                            "endDate": "", "items": [
               {"id": "i8102-a", "type": "equipment", "equipmentId": ids["eqA"], "name": "Mover A", "qty": 4,
                "unitPrice": 100, "sourceItemId": "q8102-a", "sourceQuoteId": 8102, "linkedQty": 4}]}]}
    _post(client, "/api/invoices", inv)
    i_rows = _allocs(client, "invoice", 8102)
    _check("a draft invoice books what it drew", len(i_rows) == 1 and i_rows[0]["qty"] == 4)
    body = _quote_body(8102, ids, "accepted", qty_a=10, qty_b=0)
    body["sections"][0]["items"][0]["invoicedQty"] = 4
    body["sections"][0]["items"][0]["deliveredQty"] = 4
    _put(client, "/api/quotes/8102", body)
    q_rows = _allocs(client, "quote", 8102)
    _check("the quote now books only the remainder", q_rows[0]["qty"] == 6)
    total = sum(r["qty"] for r in _allocs(client) if r["equipmentId"] == ids["eqA"]
                and r["docId"] == 8102 and r["docType"] in ("quote", "invoice"))
    _check("quote + invoice never double count", total == 10)

    body["status"] = "converted"
    body["sections"][0]["items"][0]["invoicedQty"] = 10
    _put(client, "/api/quotes/8102", body)
    _check("a converted quote books nothing itself", _allocs(client, "quote", 8102) == [])
    _check("…its invoice keeps booking", len(_allocs(client, "invoice", 8102)) == 1)

    r = client.delete("/api/invoices/8102", cookies=_cookies())
    _check("DELETE invoice ok", r.status_code == 200)
    _check("deleting the invoice releases its reservation", _allocs(client, "invoice", 8102) == [])


def test_api_public_accept_books_without_a_session():
    client, _ = _setup()
    ids = _fixtures(client)
    created = _post(client, "/api/quotes", _quote_body(8103, ids, "sent", qty_a=2, qty_b=2))
    token = created["shareToken"]
    _check("quote carries a share token", bool(token))
    sig = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 240).decode()
    r = client.post(f"/api/view/{token}/accept", json={"clientName": "Gala Producer", "signatureDataUrl": sig})
    _check("client accept ok", r.status_code == 200, r.text[:200])
    rows = _allocs(client, "quote", 8103)
    _check("the client's acceptance booked the gear", len(rows) == 2 and all(a["state"] == "reserved" for a in rows))


def test_api_manual_bookings_are_untouched_and_rebuild_is_admin_only():
    client, _ = _setup()
    ids = _fixtures(client)
    manual = _post(client, "/api/allocations", {"id": 8199, "equipmentId": ids["eqB"], "projectId": ids["proj"],
                                                "qty": 1, "startDate": "2026-11-01", "endDate": "2026-11-02"})
    _check("manual booking defaults docType manual", manual["docType"] == "manual")
    r = client.post("/api/allocations/reconcile", cookies=_cookies(_MEMBER_TOK))
    _check("rebuild is admin-only", r.status_code == 403, r.text[:100])
    r = client.post("/api/allocations/reconcile", cookies=_cookies())
    _check("admin rebuild ok", r.status_code == 200, r.text[:200])
    _check("…returns the counts", set(r.json()) == {"created", "updated", "removed"})
    _check("…and a rebuild on a settled DB changes nothing", not any(r.json().values()), r.text)
    still = [a for a in _allocs(client) if a["id"] == 8199]
    _check("manual booking survived the rebuild", len(still) == 1 and still[0]["qty"] == 1)

    # Wipe a derived booking behind the engine's back; the rebuild restores it.
    derived = _allocs(client, "quote", 8101)
    _check("precondition: quote 8101 has bookings", len(derived) == 2)
    victim = next(a for a in derived if a["state"] == "reserved")
    client.delete(f"/api/allocations/{victim['id']}", cookies=_cookies())
    r = client.post("/api/allocations/reconcile", cookies=_cookies())
    _check("rebuild re-created the missing booking", r.json()["created"] == 1, r.text)
    _check("…so the quote is fully booked again", len(_allocs(client, "quote", 8101)) == 2)


def test_api_deleting_a_quote_releases_its_reservations():
    client, _ = _setup()
    ids = _fixtures(client)
    _post(client, "/api/quotes", _quote_body(8104, ids, "accepted", qty_a=1, qty_b=1))
    _check("precondition: booked", len(_allocs(client, "quote", 8104)) == 2)
    r = client.delete("/api/quotes/8104", cookies=_cookies())
    _check("DELETE quote ok", r.status_code == 200)
    _check("reservations released", _allocs(client, "quote", 8104) == [])


def _teardown():
    global _client
    if _client is not None:
        _client.__exit__(None, None, None)
        _client = None


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        print(t.__name__)
        try:
            t()
        except AssertionError as e:
            failed += 1
            print("   FAILED:", e)
    _teardown()
    passed = sum(1 for _, ok in _results if ok)
    print(f"\nrental-bookings suite — PASS: {passed}   FAIL: {len(_results) - passed}")
    sys.exit(1 if failed or passed != len(_results) else 0)
