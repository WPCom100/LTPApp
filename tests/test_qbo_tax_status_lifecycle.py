"""Who owns a client's sales tax status, over the whole life of the client.

The unit tests in test_quickbooks_sync.py pin each transition in isolation
against mocks. This one walks a single client through all of them in order,
against real SQLAlchemy rows, because the rule is stateful: every decision reads
`companies.qb_tax_synced`, which the PREVIOUS decision wrote. A transition that
is right on its own and wrong in sequence — a baseline not recorded, or recorded
from the wrong side — passes every isolated test and still leaves the app either
unable to change a status or unable to stop overwriting one.

THE RULE
    no baseline    QuickBooks and the app have never met. QuickBooks wins
                   outright: a customer already on file carries the exemption
                   certificate the books were built on.
    app differs    The app's pair moved away from the agreed baseline, which can
                   only be a person changing it here on purpose. Pushed.
    app matches    No local edit; QuickBooks stays in charge.

WHAT IS REAL HERE
    Real rows, real flush/commit, the real read-only guard, the real column.
    Only Intuit's HTTP layer is replaced — by a small customer store that keeps
    the request and response SHAPES (sparse updates that merge, a query that
    matches on DisplayName, "" clearing a field), so payload mistakes still
    surface.

Runs both as pytest and as a plain script:
    python tests/test_qbo_tax_status_lifecycle.py
"""
import asyncio
import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

from sqlalchemy import select  # noqa: E402

from backend import models, qbo_sync  # noqa: E402

_failures = []


def _check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        _failures.append(name + (f"  [{detail}]" if detail else ""))
        print(f"  FAIL {name}" + (f"  [{detail}]" if detail else ""))
    assert cond, f"{name} {detail}"


# ── A stand-in QuickBooks ────────────────────────────────────────────────────

class FakeQbo:
    """One customer store with Intuit's shapes: sparse updates MERGE, a query
    matches on DisplayName, and "" clears a field (which is how an exemption
    reason is retracted)."""

    def __init__(self):
        self.customers = {}
        self.next_id = 1
        self.updates = []

    def install(self):
        qbo_sync.quickbooks.query = self.query
        qbo_sync.quickbooks.get_customer = self.get_customer
        qbo_sync.quickbooks.create_customer = self.create_customer
        qbo_sync.quickbooks.update_customer = self.update_customer

    async def query(self, conn, db, sql, **kw):
        name = sql.split("DisplayName = '")[-1].rstrip("'")
        return [dict(c) for c in self.customers.values() if c.get("DisplayName") == name]

    async def get_customer(self, conn, db, cid, **kw):
        return dict(self.customers.get(str(cid), {}))

    async def create_customer(self, conn, db, payload, **kw):
        cid = str(self.next_id)
        self.next_id += 1
        row = {k: v for k, v in payload.items() if k != "sparse"}
        row.update({"Id": cid, "SyncToken": "0", "Active": True})
        self.customers[cid] = row
        return {"Customer": row}

    async def update_customer(self, conn, db, payload, **kw):
        self.updates.append(dict(payload))
        row = self.customers[str(payload["Id"])]
        for k, v in payload.items():
            if k in ("Id", "SyncToken", "sparse"):
                continue
            if k == "TaxExemptionReasonId" and v == "":
                row.pop("TaxExemptionReasonId", None)
            else:
                row[k] = v
        return {"Customer": row}

    @property
    def last_update(self):
        return self.updates[-1] if self.updates else {}


_booted = False


def _boot():
    """Bring the app up once so init_db builds the suite schema. Same pattern as
    the other real-row modules (see tests/conftest.py on the shared DB)."""
    global _booted
    if not _booted:
        from fastapi.testclient import TestClient
        from backend.main import app
        TestClient(app).__enter__()
        _booted = True


async def _push(db, company):
    return await qbo_sync.find_or_create_customer(
        None, db, company, "company", client_id="c", client_secret="s")


async def _lifecycle():
    from backend.database import async_session

    saved = (qbo_sync.quickbooks.query, qbo_sync.quickbooks.get_customer,
             qbo_sync.quickbooks.create_customer, qbo_sync.quickbooks.update_customer)
    qb = FakeQbo()
    qb.install()
    try:
        async with async_session() as db:
            # 1 ── A brand-new exempt client. Nothing exists in QuickBooks yet,
            #      so the app's status is what builds the customer.
            co = models.Company(name="QTS Dallas Theater Center", is_client=True,
                                taxable=False, tax_exemption_reason="5")
            db.add(co)
            await db.flush()
            cid = await _push(db, co)
            await db.commit()
            created = qb.customers[cid]
            _check("created from the app's status",
                   created["Taxable"] is False and created["TaxExemptionReasonId"] == "5")
            _check("the agreed baseline is recorded", co.qb_tax_synced == "0|5", co.qb_tax_synced)

            # 2 ── Nothing changed anywhere. Pushing an invoice must say nothing
            #      about tax — that is what used to overwrite QuickBooks.
            await _push(db, co)
            await db.commit()
            _check("a settled status sends no tax fields",
                   "Taxable" not in qb.last_update and "TaxExemptionReasonId" not in qb.last_update,
                   qb.last_update)

            # 3 ── The bookkeeper corrects the reason in QuickBooks. It owns the
            #      status, so the app takes the correction rather than stamping
            #      its own back over it.
            qb.customers[cid]["TaxExemptionReasonId"] = "7"
            await _push(db, co)
            await db.commit()
            _check("the bookkeeper's reason is adopted", co.tax_exemption_reason == "7",
                   co.tax_exemption_reason)
            _check("QuickBooks was not overwritten",
                   qb.customers[cid]["TaxExemptionReasonId"] == "7")
            _check("the baseline follows it", co.qb_tax_synced == "0|7", co.qb_tax_synced)

            # 4 ── A DELIBERATE change in the app: this client is taxable now.
            #      This is the edit the app is allowed to make, so it goes out —
            #      over QuickBooks' own value.
            co.taxable = True
            co.tax_exemption_reason = ""
            await db.commit()
            await _push(db, co)
            await db.commit()
            _check("the app's change is pushed", qb.last_update.get("Taxable") is True,
                   qb.last_update)
            # Intuit reads a customer that still carries a reason as exempt, so
            # without this retraction sales tax stays switched off.
            _check("the stale reason is retracted",
                   qb.last_update.get("TaxExemptionReasonId") == "")
            _check("QuickBooks now agrees",
                   qb.customers[cid]["Taxable"] is True
                   and "TaxExemptionReasonId" not in qb.customers[cid])
            _check("the app kept its change", co.taxable is True)
            _check("the baseline moves with it", co.qb_tax_synced == "1|", co.qb_tax_synced)

            # 5 ── ...and is not pushed again on every later sync.
            await _push(db, co)
            await db.commit()
            _check("the change is not re-pushed", "Taxable" not in qb.last_update,
                   qb.last_update)

            # 6 ── A client QuickBooks already knows, met for the first time. The
            #      app's guess (taxable) must NOT overwrite the certificate on
            #      file, even though it differs.
            qb.customers["99"] = {"Id": "99", "SyncToken": "0", "Active": True,
                                  "DisplayName": "QTS Booker T Washington",
                                  "Taxable": False, "TaxExemptionReasonId": "7"}
            qb.next_id = 100
            other = models.Company(name="QTS Booker T Washington", is_client=True,
                                   taxable=True, tax_exemption_reason="")
            db.add(other)
            await db.flush()
            got = await _push(db, other)
            await db.commit()
            _check("matched the customer already on file", got == "99", got)
            _check("QuickBooks' status wins on first contact",
                   other.taxable is False and other.tax_exemption_reason == "7",
                   f"{other.taxable}/{other.tax_exemption_reason}")
            _check("QuickBooks untouched by the match",
                   qb.customers["99"]["TaxExemptionReasonId"] == "7")
            _check("first contact records the baseline", other.qb_tax_synced == "0|7",
                   other.qb_tax_synced)

            # 7 ── From then on that client behaves like any other: a deliberate
            #      change here does reach QuickBooks.
            other.tax_exemption_reason = "5"
            await db.commit()
            await _push(db, other)
            await db.commit()
            _check("a later deliberate change is pushed",
                   qb.last_update.get("TaxExemptionReasonId") == "5", qb.last_update)
            _check("QuickBooks took it", qb.customers["99"]["TaxExemptionReasonId"] == "5")

            # 8 ── All of it survives the round trip through the database. The
            #      baseline is a real column, not something held in memory.
            fresh = (await db.execute(select(models.Company).where(
                models.Company.id == other.id))).scalar_one()
            _check("persisted",
                   fresh.tax_exemption_reason == "5" and fresh.qb_tax_synced == "0|5",
                   f"{fresh.tax_exemption_reason}/{fresh.qb_tax_synced}")
    finally:
        (qbo_sync.quickbooks.query, qbo_sync.quickbooks.get_customer,
         qbo_sync.quickbooks.create_customer, qbo_sync.quickbooks.update_customer) = saved


def test_tax_status_ownership_over_a_clients_life():
    print("\ntest_tax_status_ownership_over_a_clients_life:")
    _boot()
    asyncio.run(_lifecycle())


def main() -> int:
    test_tax_status_ownership_over_a_clients_life()
    print()
    if _failures:
        print(f"qbo-tax-status-lifecycle suite — FAIL: {len(_failures)}")
        for f in _failures:
            print(f"  x {f}")
        return 1
    print("qbo-tax-status-lifecycle suite — all assertions passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
