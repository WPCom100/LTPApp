"""Line-item price stickiness + deletion safety for quotes and invoices.

A quote/invoice line item SNAPSHOTS its price, name, and cost when it's added
(the catalog id — productId/serviceId/feeId/equipmentId — is only a
back-reference). Two invariants follow, and this suite pins both down:

  1. EDIT stickiness — editing the underlying catalog row (raise a product's
     price, adjust a cost, change a service day rate, rename a fee) must NOT
     change any already-saved quote or invoice. Totals are computed from the
     line's stored unitPrice/adjustedPrice/qty, never re-derived from the
     catalog, so the money on a saved document is frozen at save time.

  2. DELETE safety — deleting the catalog row (product/service/fee/equipment)
     must leave every referencing line item fully intact: same price, same
     name, same qty, same total. Line items live in the quotes/invoices
     `sections` JSON with no foreign key to the catalog, so a delete can't
     cascade or null them. The catalog row is gone (404) but the billed line
     survives. Deleting a LINE from a document removes only that line.

These are the behaviors a user relies on when they edit their price book after
a quote has gone out, or retire an item that older invoices still bill for.

Runs both as pytest and as a plain script:
    python tests/test_line_item_price_stickiness.py
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_price_stickiness.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

# Fresh DB when run on its own, so the full migration stack (incl. the fees
# table) is present. Under pytest, conftest's shared DB wins instead and this
# module keeps its ids/emails disjoint from the others.
_db_path = os.path.join(_root, "_test_price_stickiness.db")
if os.path.exists(_db_path):
    os.remove(_db_path)

from backend import models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402

_ADMIN_TOK = "price-stickiness-admin-session"
_client = None
_seeded = False

# High, module-unique ids so the shared pytest DB never collides with siblings.
PID = 88101   # product
SID = 88102   # service
FID = 88103   # fee
EID = 88104   # equipment
QID = 88110   # quote
IID = 88120   # invoice


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
                admin = models.User(google_sub="price-stick-admin-sub",
                                    email="price-stick-admin@biz.com",
                                    name="Stickiness Admin", role="admin")
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


_results: list = []


def _check(label, cond, detail=""):
    _results.append((label, bool(cond)))
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  ({detail})" if detail else ""))
    assert cond, f"{label} {detail}"


def _cookies():
    return {"ltp_session": _ADMIN_TOK}


# ── Snapshot line items: prices DELIBERATELY differ from what the catalog will
# later become, so any accidental re-derivation would be caught immediately. ──
def _line_items():
    return [
        {"id": "ln-prod", "type": "product", "productId": PID, "name": "Gaff Tape (as quoted)",
         "qty": 3, "unitPrice": 12, "adjustedPrice": None, "cost": 5, "taxable": True},
        {"id": "ln-svc", "type": "service", "serviceId": SID, "name": "L1 — Lead Tech (as quoted)",
         "rateType": "day", "qty": 2, "unitPrice": 500, "adjustedPrice": None, "cost": 300, "taxable": True},
        {"id": "ln-fee", "type": "fee", "feeId": FID, "name": "Lodging (as quoted)", "unit": "night",
         "qty": 2, "unitPrice": 250, "adjustedPrice": None, "cost": 180, "taxable": True},
        {"id": "ln-custom-fee", "type": "fee", "feeId": None, "name": "Airfare",
         "qty": 1, "unitPrice": 600, "adjustedPrice": None, "cost": 0, "taxable": True},
        {"id": "ln-eq", "type": "equipment", "equipmentId": EID, "name": "Solaframe (as quoted)",
         "rateType": "threeDay", "qty": 4, "unitPrice": 100, "adjustedPrice": None, "cost": 0, "taxable": True},
        {"id": "ln-note", "type": "note", "text": "Travel billed at cost."},
    ]


# Expected subtotal from the snapshot prices: 12*3 + 500*2 + 250*2 + 600 + 100*4
SNAPSHOT_SUBTOTAL = 36 + 1000 + 500 + 600 + 400  # = 2536


def _subtotal(doc):
    """Mirror LTP_QUOTE_TOTALS / LTP_INVOICE_TOTALS: sum priced lines using the
    line's own adjustedPrice ?? unitPrice — the catalog is never consulted."""
    total = 0.0
    for sec in doc.get("sections", []):
        for it in sec.get("items", []):
            if it.get("type") == "note":
                continue
            price = it.get("adjustedPrice")
            if price is None:
                price = it.get("unitPrice") or 0
            total += price * (it.get("qty") or 0)
    return total


def _line(doc, line_id):
    for sec in doc.get("sections", []):
        for it in sec.get("items", []):
            if it.get("id") == line_id:
                return it
    return None


def _seed_catalog_and_documents():
    """Create the catalog rows + a quote and an invoice that bill them. Idempotent
    across reruns (deletes any leftovers from an earlier run first)."""
    client, _ = _setup()
    # Clean slate for this module's ids (a rerun on the shared DB would 409).
    for path, _id in (("quotes", QID), ("invoices", IID),
                      ("products", PID), ("services", SID), ("fees", FID)):
        client.delete(f"/api/{path}/{_id}", cookies=_cookies())
    # equipment is seeded directly (no equipment POST body here); ensure a row.
    client.post("/api/products", json={"id": PID, "name": "Gaff Tape", "category": "Consumables",
                                       "unit": "roll", "unitPrice": 12, "cost": 5}, cookies=_cookies())
    client.post("/api/services", json={"id": SID, "role": "L1", "description": "Lead Tech",
                                       "department": "Lighting", "dayRate": 500, "dayCost": 300}, cookies=_cookies())
    client.post("/api/fees", json={"id": FID, "name": "Lodging", "category": "Travel",
                                   "unit": "night", "unitPrice": 250, "cost": 180}, cookies=_cookies())
    # Equipment via ORM (its POST body needs a rates JSON; keep the test focused).
    from backend.database import async_session

    async def seed_eq():
        async with async_session() as db:
            existing = await db.get(models.Equipment, EID)
            if existing is None:
                db.add(models.Equipment(id=EID, name="Solaframe 3000", category="Fixtures",
                                        rates={"threeDay": 100}))
                await db.commit()

    asyncio.run(seed_eq())

    section = [{"id": "s1", "label": "Everything", "items": _line_items()}]
    q = client.post("/api/quotes", json={"clientType": "company", "id": QID, "status": "draft",
                                         "sections": section}, cookies=_cookies())
    assert q.status_code == 200, q.text
    inv = client.post("/api/invoices", json={"clientType": "company", "id": IID, "status": "draft",
                                             "sections": section}, cookies=_cookies())
    assert inv.status_code == 200, inv.text
    return client


# ── 1. Baseline: the documents save with their snapshot prices ───────────────

def test_documents_save_with_snapshot_prices():
    client = _seed_catalog_and_documents()
    q = client.get(f"/api/quotes/{QID}", cookies=_cookies()).json()
    inv = client.get(f"/api/invoices/{IID}", cookies=_cookies()).json()
    _check("quote subtotal is the snapshot total", _subtotal(q) == SNAPSHOT_SUBTOTAL, str(_subtotal(q)))
    _check("invoice subtotal is the snapshot total", _subtotal(inv) == SNAPSHOT_SUBTOTAL, str(_subtotal(inv)))
    _check("quote product line carries snapshot price 12", _line(q, "ln-prod")["unitPrice"] == 12)
    _check("quote fee line carries snapshot price 250", _line(q, "ln-fee")["unitPrice"] == 250)
    _check("custom fee (no feeId) persists", _line(q, "ln-custom-fee")["unitPrice"] == 600
           and _line(q, "ln-custom-fee")["feeId"] is None)


# ── 2. EDIT stickiness: raising catalog prices/costs leaves saved docs alone ──

def test_catalog_edits_do_not_change_saved_line_prices():
    client = _seed_catalog_and_documents()
    # Move every catalog price/cost far away from the snapshots.
    prod = client.get(f"/api/products/{PID}", cookies=_cookies()).json()
    client.put(f"/api/products/{PID}", json=dict(prod, name="Gaff Tape XL", unitPrice=999, cost=999),
               cookies=_cookies())
    svc = client.get(f"/api/services/{SID}", cookies=_cookies()).json()
    client.put(f"/api/services/{SID}", json=dict(svc, description="Lead Tech (raised)", dayRate=999, dayCost=999),
               cookies=_cookies())
    fee = client.get(f"/api/fees/{FID}", cookies=_cookies()).json()
    client.put(f"/api/fees/{FID}", json=dict(fee, name="Lodging Deluxe", unitPrice=999, cost=999),
               cookies=_cookies())

    q = client.get(f"/api/quotes/{QID}", cookies=_cookies()).json()
    inv = client.get(f"/api/invoices/{IID}", cookies=_cookies()).json()
    _check("quote total unchanged after catalog price hikes", _subtotal(q) == SNAPSHOT_SUBTOTAL, str(_subtotal(q)))
    _check("invoice total unchanged after catalog price hikes", _subtotal(inv) == SNAPSHOT_SUBTOTAL, str(_subtotal(inv)))
    _check("product line keeps its quoted price (12, not 999)", _line(q, "ln-prod")["unitPrice"] == 12)
    _check("product line keeps its quoted cost (5, not 999)", _line(q, "ln-prod")["cost"] == 5)
    _check("product line keeps its quoted name", _line(q, "ln-prod")["name"] == "Gaff Tape (as quoted)")
    _check("service line keeps its quoted rate (500, not 999)", _line(q, "ln-svc")["unitPrice"] == 500)
    _check("fee line keeps its quoted price (250, not 999)", _line(q, "ln-fee")["unitPrice"] == 250)
    _check("invoice fee line keeps its quoted price too", _line(inv, "ln-fee")["unitPrice"] == 250)


# ── 3. DELETE safety: retiring catalog rows leaves the billed lines intact ────

def test_deleting_catalog_rows_leaves_saved_lines_intact():
    client = _seed_catalog_and_documents()
    for path, _id in (("products", PID), ("services", SID), ("fees", FID)):
        r = client.delete(f"/api/{path}/{_id}", cookies=_cookies())
        _check(f"DELETE /{path}/{_id} ok", r.status_code == 200, r.text)
        gone = client.get(f"/api/{path}/{_id}", cookies=_cookies())
        _check(f"{path} row is actually gone (404)", gone.status_code == 404, str(gone.status_code))

    q = client.get(f"/api/quotes/{QID}", cookies=_cookies()).json()
    inv = client.get(f"/api/invoices/{IID}", cookies=_cookies()).json()
    _check("quote total survives catalog deletions", _subtotal(q) == SNAPSHOT_SUBTOTAL, str(_subtotal(q)))
    _check("invoice total survives catalog deletions", _subtotal(inv) == SNAPSHOT_SUBTOTAL, str(_subtotal(inv)))
    _check("orphaned product line keeps price + id", _line(q, "ln-prod")["unitPrice"] == 12
           and _line(q, "ln-prod")["productId"] == PID)
    _check("orphaned service line keeps price + id", _line(q, "ln-svc")["unitPrice"] == 500
           and _line(q, "ln-svc")["serviceId"] == SID)
    _check("orphaned fee line keeps price + id", _line(q, "ln-fee")["unitPrice"] == 250
           and _line(q, "ln-fee")["feeId"] == FID)
    _check("note line still present", _line(q, "ln-note") is not None)


# ── 4. Deleting a LINE removes only that line ────────────────────────────────

def test_removing_a_line_keeps_the_others():
    client = _seed_catalog_and_documents()
    q = client.get(f"/api/quotes/{QID}", cookies=_cookies()).json()
    # Drop the fee line, keep the rest — mirrors the builder's deleteItem.
    q["sections"][0]["items"] = [it for it in q["sections"][0]["items"] if it.get("id") != "ln-fee"]
    r = client.put(f"/api/quotes/{QID}", json=q, cookies=_cookies())
    _check("PUT with one line removed ok", r.status_code == 200, r.text)
    after = client.get(f"/api/quotes/{QID}", cookies=_cookies()).json()
    _check("removed fee line is gone", _line(after, "ln-fee") is None)
    _check("other lines untouched (product still 12)", _line(after, "ln-prod")["unitPrice"] == 12)
    # New subtotal = old minus the fee line (250*2 = 500).
    _check("subtotal drops by exactly the removed line", _subtotal(after) == SNAPSHOT_SUBTOTAL - 500,
           str(_subtotal(after)))


def main() -> int:
    tests = [
        test_documents_save_with_snapshot_prices,
        test_catalog_edits_do_not_change_saved_line_prices,
        test_deleting_catalog_rows_leaves_saved_lines_intact,
        test_removing_a_line_keeps_the_others,
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
