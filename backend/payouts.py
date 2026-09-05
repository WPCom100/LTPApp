"""Crew payout re-derivation + bi-weekly pay-period math.

This module is the SERVER's authoritative view of "what we owe each crew member"
for a date range. It deliberately does NOT re-run the labor rate engine — the
payable figure for a signed-off day is a FROZEN snapshot the frontend stamped at
sign-off time (components/domain-crew.js::LTP_signOffDay writes the same ``work.pay`` object onto
every confirmed position of a (crew, date), and LTP_setPayAdjustments writes the
same ``adj`` list). So we re-read those snapshots straight out of the opaque
``Project.schedule`` JSON and rebuild the payout, guaranteeing the QuickBooks
vendor bills post exactly the numbers the Payouts tab shows — never a client-
submitted amount.

Two responsibilities:

  1. Pay periods — fixed-length (default 14-day) windows tiling the calendar from
     a configured anchor date. Pure whole-day arithmetic (no wall-clock/DST term),
     mirroring components/domain-payouts.js::LTP_payPeriod* EXACTLY. tests/fixtures/payout_periods.json
     locks the JS and Python implementations together.

  2. derive_payout_drafts — the snapshot re-derivation, mirroring
     components/domain-payouts.js::LTP_payoutRows' payable path (first-match dedup per (crew, date),
     two-step js_round2 rounding, per-unit expense-account grouping).

Flat-rate engagements (Project.fixed_positions — a designer or stage manager
hired for the whole job at a fixed fee, no shift times) ride the same rails:
"Mark complete" on the Payouts tab freezes ``work.pay`` on the position exactly
like a day sign-off, and the fee is billed on the PROJECT'S END DATE — so it
lands in the payroll period that date falls into and is paid on that period's
pay day with every other payout. Because the bill ledger is unique per
(crew, project, date), a flat fee whose date coincides with a signed shift day
on the same project MERGES into that day's entry — one ledger line, two
sources — see ``_merge_flat_into_day``.

Money is float dollars rounded to the cent, matching the rest of the app.
"""
import json
import math
from datetime import date, timedelta

# ── Money rounding ──────────────────────────────────────────────────────────
#
# js_round2 reproduces JavaScript's ``Math.round(x * 100) / 100`` bit-for-bit.
# Both languages compute ``x * 100`` on the same IEEE-754 double, and
# floor(v + 0.5) reproduces Math.round's round-half-toward-+infinity (including
# the negative case: Math.round(-12.5) === -12, floor(-12.5 + 0.5) === -12).
#
# Do NOT use Python's built-in round() here — it is banker's rounding
# (round(0.125, 2) == 0.12) and will silently drift a cent from the frontend.
def js_round2(x):
    return math.floor(x * 100 + 0.5) / 100


# ── Pay periods (bi-weekly payroll cycles) ──────────────────────────────────

def _parse_iso(iso):
    """Strict YYYY-MM-DD -> date, or None (mirrors components/domain-payouts.js::_ppEpochDays, which
    rejects malformed and overflow-normalized dates like '2026-02-31')."""
    if not isinstance(iso, str) or len(iso) != 10 or iso[4] != "-" or iso[7] != "-":
        return None
    try:
        y, m, d = int(iso[0:4]), int(iso[5:7]), int(iso[8:10])
    except ValueError:
        return None
    if not (1 <= m <= 12 and 1 <= d <= 31):
        return None
    try:
        return date(y, m, d)
    except ValueError:
        return None


def _pp_len(length_days):
    """Guard/default the period length to bi-weekly (matches components/domain-payouts.js::_ppLen)."""
    try:
        n = int(length_days)
    except (TypeError, ValueError):
        return 14
    return n if 1 <= n <= 31 else 14


def pay_period_index(anchor_iso, length_days, date_iso):
    """Integer index of the period containing ``date_iso`` (0 = the anchor's own
    period). Python floor-division matches JS Math.floor for negatives (dates
    before the anchor). Returns None on an invalid anchor/date."""
    a, d = _parse_iso(anchor_iso), _parse_iso(date_iso)
    if a is None or d is None:
        return None
    return (d - a).days // _pp_len(length_days)


def pay_period_for_index(anchor_iso, length_days, index):
    """{'index','start','end'} for a period index (end inclusive = start+len-1)."""
    a = _parse_iso(anchor_iso)
    if a is None or not isinstance(index, int) or isinstance(index, bool):
        return None
    length = _pp_len(length_days)
    start = a + timedelta(days=index * length)
    end = start + timedelta(days=length - 1)
    return {"index": index, "start": start.isoformat(), "end": end.isoformat()}


def pay_period_bounds(anchor_iso, length_days, as_of_iso):
    """The period {'index','start','end'} containing ``as_of_iso``."""
    idx = pay_period_index(anchor_iso, length_days, as_of_iso)
    if idx is None:
        return None
    return pay_period_for_index(anchor_iso, length_days, idx)


def pay_period_pay_day(end_iso, offset_days):
    """A period's pay date = its end date + ``offset_days`` (e.g. period ends
    Sunday, offset 5 -> the following Friday)."""
    e = _parse_iso(end_iso)
    if e is None:
        return None
    try:
        off = int(offset_days)
    except (TypeError, ValueError):
        off = 0
    if off < 0:
        off = 0
    return (e + timedelta(days=off)).isoformat()


_MONTHS = ["January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December"]


def _ordinal_date(iso):
    """'2026-07-06' -> 'July 6th, 2026' (mirrors components/domain-util.js::LTP_formatDate)."""
    d = _parse_iso(iso)
    if d is None:
        return iso or ""
    day = d.day
    if day in (1, 21, 31):
        suffix = "st"
    elif day in (2, 22):
        suffix = "nd"
    elif day in (3, 23):
        suffix = "rd"
    else:
        suffix = "th"
    return "%s %d%s, %d" % (_MONTHS[d.month - 1], day, suffix, d.year)


def pay_period_label(start_iso, end_iso):
    """Human label 'July 6th, 2026 – July 19th, 2026' (matches LTP_payPeriodLabel)."""
    if not start_iso or not end_iso:
        return ""
    return _ordinal_date(start_iso) + " – " + _ordinal_date(end_iso)


def pay_period_number_in_year(anchor_iso, length_days, index):
    """{'year','year2','number'} for a period index — a human-friendly payroll
    label. `number` is the 1-based ordinal of this period within its START date's
    calendar year (period #1 = the first period that STARTS that year; resets each
    January; ~26/yr). Drives the QuickBooks bill number PAY-{year2}-{number}, e.g.
    PAY-26-14. Mirrors components/domain-payouts.js::LTP_payPeriodNumberInYear."""
    pp = pay_period_for_index(anchor_iso, length_days, index)
    if pp is None:
        return None
    a = _parse_iso(anchor_iso)
    start = _parse_iso(pp["start"])
    year = start.year
    length = _pp_len(length_days)
    # The first period that STARTS in `year`: the period containing Jan 1, bumped
    # one forward when that period actually began in the prior year (straddle).
    idx_jan1 = (date(year, 1, 1) - a).days // length
    start_jan1 = a + timedelta(days=idx_jan1 * length)
    first_idx = idx_jan1 if start_jan1.year == year else idx_jan1 + 1
    return {"year": year, "year2": year % 100, "number": index - first_idx + 1}


# ── Payout re-derivation from frozen schedule snapshots ─────────────────────
#
# Mirrors components/domain-payouts.js::LTP_payoutRows' PAYABLE path (not the rate engine). For each
# (crew, date, project) the sign-off invariant guarantees one representative
# work.pay and one adj list across the group, so we take the FIRST match — never
# sum per position. Two-step js_round2 rounding matches the frontend to the cent.

def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def _rollup_state(states):
    """Day-state label from the position work-states (description only), matching
    LTP_payoutRows: all no-show -> 'no_show'; any adjusted/mixed -> 'adjusted';
    else 'worked'."""
    if "no_show" in states and "worked" not in states and "adjusted" not in states:
        return "no_show"
    if "adjusted" in states or "no_show" in states:
        return "adjusted"
    return "worked"


def fixed_pay_date(project_end_date):
    """The date a flat-rate engagement is billed on: the project's end date,
    or None when the project has none (not payable anywhere until it does).
    The payroll period containing that date is where the fee lands, and the
    period's pay day is when it is paid — the same Friday as every other payout
    in that period. There is deliberately no per-position override. Mirrors
    components/domain-payouts.js::LTP_fixedPayDate — keep the two in step, the
    ledger line's date is what this resolves to."""
    if _parse_iso(project_end_date) is not None:
        return project_end_date
    return None


def _flat_units(fp, work_pay):
    """Bill units for a completed flat engagement. The frozen snapshot carries
    its own units (mirroring a day's ``work.pay.units``); a legacy/hand-edited
    snapshot without them falls back to one unit for the whole total against the
    position's service, so the fee still lands on that role's expense account."""
    raw = work_pay.get("units")
    if not isinstance(raw, list) or not raw:
        raw = [{"serviceId": fp.get("serviceId"), "total": work_pay.get("total")}]
    out = []
    for u in raw:
        if not isinstance(u, dict):
            continue
        amt = js_round2(_num(u.get("total")))
        if amt == 0:
            continue  # full-margin engagement carries no line
        out.append({"service_id": u.get("serviceId"), "amount": amt,
                    "paid_hours": 0.0, "ot_hours": 0.0})
    return out


def _merge_flat_into_day(day, flat):
    """Fold a flat engagement into a same-(crew, project, date) entry so the
    period keeps ONE entry per ledger key. Money adds; units and adjustments
    concatenate; the tier reads ``mixed`` once a shift day and a flat fee share
    the line (two flat engagements on one project stay ``flat``)."""
    day["payable"] = js_round2(day["payable"] + flat["payable"])
    day["adj_total"] = js_round2(day["adj_total"] + flat["adj_total"])
    day["units"] = list(day["units"]) + list(flat["units"])
    day["adjustments"] = list(day["adjustments"]) + list(flat["adjustments"])
    if not (day.get("flat") and day.get("tier") == "flat"):
        day["tier"] = "mixed"
    day["flat"] = True
    return day


def derive_payout_drafts(projects, contacts_by_id, start_iso, end_iso):
    """Re-derive per-crew payout drafts from persisted schedule snapshots.

    ``projects``: list of {"id", "name", "schedule": [...], "fixed_positions":
    [...], "end_date"} (schedule is the raw frontend camelCase JSON — positions
    carry crewId/status/work/adj; fixed_positions are the flat-rate
    engagements, see backend/models.py::Project).
    ``contacts_by_id``: {crew_id: {"first_name","last_name",...}} — crew only.

    Returns a name-sorted list of drafts::

        {contact_id, name, contact, total_signed,
         days: [{project_id, project_name, date, tier, state, payable, adj_total,
                 units: [{service_id, amount}], flat?: True}],   # SIGNED days (payable may be <=0)
         pending: [{project_id, project_name, date, flat?: True}]}  # confirmed but unsigned

    A flat engagement is a "day" dated on the project's END date
    (``fixed_pay_date``) — the payroll period that date falls into is where it
    is paid: ``tier == "flat"`` on its own, ``mixed`` when merged into a shift
    day on the same date. It is pending until "Mark complete" freezes
    ``work.pay``.

    The biller (backend/qbo_payouts.py) applies the billable filter (drop $0,
    resolve expense accounts, block a bill whose total <= 0). This function
    returns the raw truth so the preview can report what was excluded and why.
    """
    by_crew = {}  # crew_id -> {"days": [], "pending": []}
    for proj in (projects or []):
        pid = proj.get("id")
        pname = proj.get("name") or ""
        # Bucket this project's schedule by date within the (inclusive) range.
        by_date = {}
        for s in (proj.get("schedule") or []):
            if not isinstance(s, dict):
                continue
            d = s.get("date")
            if not d:
                continue
            if start_iso and d < start_iso:
                continue
            if end_iso and d > end_iso:
                continue
            by_date.setdefault(d, []).append(s)

        for d, items in by_date.items():
            seen = {}  # crew_id -> {"work", "adj", "states"}
            for s in items:
                for p in (s.get("positions") or []):
                    if not isinstance(p, dict):
                        continue
                    cid = p.get("crewId")
                    if cid is None or p.get("status") != "confirmed":
                        continue
                    e = seen.get(cid)
                    if e is None:
                        e = seen[cid] = {"work": None, "adj": None, "states": set()}
                    work = p.get("work")
                    if work:
                        if e["work"] is None:
                            e["work"] = work
                        st = work.get("state")
                        if st:
                            e["states"].add(st)
                    adj = p.get("adj")
                    if adj and e["adj"] is None:
                        e["adj"] = adj

            for cid, e in seen.items():
                grp = by_crew.get(cid)
                if grp is None:
                    grp = by_crew[cid] = {"days": [], "pending": []}
                work = e["work"]
                work_pay = work.get("pay") if isinstance(work, dict) else None
                if not work_pay:
                    # Confirmed but not signed off -> not payable; report as pending.
                    grp["pending"].append({"project_id": pid, "project_name": pname, "date": d})
                    continue
                adj = e["adj"] or []
                adj_total = js_round2(sum(_num(a.get("amount")) for a in adj if isinstance(a, dict)))
                payable = js_round2(_num(work_pay.get("total")) + adj_total)
                units_out = []
                for u in (work_pay.get("units") or []):
                    if not isinstance(u, dict):
                        continue
                    amt = js_round2(_num(u.get("total")))
                    if amt == 0:
                        continue  # full-margin / zero-cost units carry no line
                    units_out.append({
                        "service_id": u.get("serviceId"), "amount": amt,
                        "paid_hours": js_round2(_num(u.get("paidHours"))),
                        "ot_hours": js_round2(_num(u.get("otHours"))),
                    })
                # Itemized adjustments (label + amount) so the bill lists each one
                # separately; drop zero-amount entries (they carry no line).
                adjustments = [
                    {"label": (a.get("label") or "").strip(), "amount": js_round2(_num(a.get("amount")))}
                    for a in adj if isinstance(a, dict) and int(round(_num(a.get("amount")) * 100)) != 0
                ]
                grp["days"].append({
                    "project_id": pid, "project_name": pname, "date": d,
                    "tier": work_pay.get("tier") or "", "state": _rollup_state(e["states"]),
                    "payable": payable, "adj_total": adj_total,
                    "paid_hours": js_round2(_num(work_pay.get("paidHours"))),
                    "ot_hours": js_round2(_num(work_pay.get("otHours"))),
                    "units": units_out, "adjustments": adjustments,
                })

        # Flat-rate engagements: one entry per confirmed position, dated on the
        # project's end date. Processed AFTER the project's shift days so a
        # same-date shift entry already exists to merge into. Both spellings are
        # read so the JS↔Python parity fixture can feed raw camelCase project JSON.
        fixed_list = proj.get("fixed_positions")
        if fixed_list is None:
            fixed_list = proj.get("fixedPositions")
        proj_end = proj.get("end_date")
        if proj_end is None:
            proj_end = proj.get("endDate")
        for fp in (fixed_list or []):
            if not isinstance(fp, dict):
                continue
            cid = fp.get("crewId")
            if cid is None or fp.get("status") != "confirmed":
                continue
            d = fixed_pay_date(proj_end)
            if not d:
                continue  # project has no end date — the builder flags the row
            if start_iso and d < start_iso:
                continue
            if end_iso and d > end_iso:
                continue
            grp = by_crew.get(cid)
            if grp is None:
                grp = by_crew[cid] = {"days": [], "pending": []}
            work = fp.get("work")
            work_pay = work.get("pay") if isinstance(work, dict) else None
            if not work_pay:
                grp["pending"].append({"project_id": pid, "project_name": pname, "date": d, "flat": True})
                continue
            adj = fp.get("adj") or []
            adj_total = js_round2(sum(_num(a.get("amount")) for a in adj if isinstance(a, dict)))
            flat = {
                "project_id": pid, "project_name": pname, "date": d,
                "tier": "flat", "state": "worked",
                "payable": js_round2(_num(work_pay.get("total")) + adj_total), "adj_total": adj_total,
                "paid_hours": 0.0, "ot_hours": 0.0,
                "units": _flat_units(fp, work_pay),
                "adjustments": [
                    {"label": (a.get("label") or "").strip(), "amount": js_round2(_num(a.get("amount")))}
                    for a in adj if isinstance(a, dict) and int(round(_num(a.get("amount")) * 100)) != 0
                ],
                "flat": True,
            }
            same = next((x for x in grp["days"] if x["project_id"] == pid and x["date"] == d), None)
            if same is not None:
                _merge_flat_into_day(same, flat)
            else:
                grp["days"].append(flat)

    drafts = []
    for cid, grp in by_crew.items():
        contact = contacts_by_id.get(cid)
        if contact is None:
            continue  # crewId references a non-crew/absent contact — skip defensively
        name = ((contact.get("first_name") or "") + " " + (contact.get("last_name") or "")).strip() or "Unknown"
        days = sorted(grp["days"], key=lambda r: (r["date"], r["project_name"]))
        pending = sorted(grp["pending"], key=lambda r: (r["date"], r["project_name"]))
        total_signed = js_round2(sum(x["payable"] for x in days))
        drafts.append({
            "contact_id": cid, "name": name, "contact": contact,
            "days": days, "pending": pending, "total_signed": total_signed,
        })
    drafts.sort(key=lambda g: g["name"])
    return drafts


# ── Paid-day integrity ──────────────────────────────────────────────────────
#
# Once a crew member's day has been billed to QuickBooks AND that bill is paid,
# the money is out the door. Editing the schedule underneath it does not claw
# anything back — it just makes the app disagree with the accounts.
#
# The Schedule Builder and Payouts tab both warn before such an edit, but that
# check reads a `paidDays` map fetched once when the editor opened. Two windows,
# or a bill paid while an editor sat open, and the warning simply does not fire.
# The client check is a courtesy; THIS is the enforcement.


def _ser_breaks(breaks) -> str:
    """Order-independent serialization of a break list."""
    parts = []
    for b in (breaks or []):
        if not isinstance(b, dict):
            continue
        parts.append("%s:%s:%s" % (b.get("startTime") or "", b.get("endTime") or "", b.get("type") or ""))
    return "|".join(sorted(parts))


def paid_day_signature(schedule, fixed_positions=None, end_date=None) -> dict:
    """`"{crewId}|{date}"` → a fingerprint of everything that decides what that
    crew member is owed for that day.

    Mirrors modules/schedule-builder.js::_paidSig — shift times, the crew-wide
    breaks AND the position's own breaks, and each of that crew's positions
    (service, role, status) — because any of those changing means the frozen
    `work.pay` snapshot we already billed no longer describes the day worked.

    Flat-rate engagements (``fixed_positions``) fingerprint under the project's
    END date (``fixed_pay_date``, which is why ``end_date`` comes along): the
    fee, the full-margin flag, service, status — and, server side, the frozen
    snapshot. Moving the project's end date moves the key itself, which reads
    as a change on both the old and the new date — correct, since the paid
    ledger line no longer describes when that fee is paid.

    Deliberately STRICTER than the client in one respect: it also covers `work`
    and `adj` themselves. Those are the billed money, and crew_integrity's
    pay-snapshot guard only restrains non-admins — so an admin re-pricing a day
    that is already paid must trip this too. Being stricter than the client is
    safe (the worst case is a prompt the client did not predict); being looser
    would be a hole.

    KEEP IN STEP with _paidSig. A field one side fingerprints and the other does
    not is a paid day that changes without anyone being asked.
    """
    m: dict = {}
    flat_date = fixed_pay_date(end_date)
    for fp in (fixed_positions or []):
        if not isinstance(fp, dict):
            continue
        cid = fp.get("crewId")
        d = flat_date
        if cid is None or not d:
            continue
        m.setdefault("%s|%s" % (cid, d), []).append(json.dumps([
            "flat", fp.get("serviceId"), fp.get("role"), fp.get("status"),
            _num(fp.get("fee")), bool(fp.get("fullMargin")),
            fp.get("work"), fp.get("adj"),
        ], sort_keys=True, default=str))
    for shift in (schedule or []):
        if not isinstance(shift, dict):
            continue
        d = shift.get("date")
        if not d:
            continue
        shift_breaks = _ser_breaks(shift.get("breaks"))
        for pos in (shift.get("positions") or []):
            if not isinstance(pos, dict):
                continue
            cid = pos.get("crewId")
            if cid is None:
                continue
            m.setdefault("%s|%s" % (cid, d), []).append(json.dumps([
                shift.get("time"), shift.get("endTime"),
                pos.get("serviceId"), pos.get("role"), pos.get("status"),
                shift_breaks, _ser_breaks(pos.get("breaks")),
                pos.get("work"), pos.get("adj"),
            ], sort_keys=True, default=str))
    # Sorted, so reordering positions within a day is not a "change".
    return {k: "\u0000".join(sorted(v)) for k, v in m.items()}


async def paid_day_conflicts(db, project_id, stored_schedule, incoming_schedule,
                             stored_fixed=None, incoming_fixed=None,
                             stored_end=None, incoming_end=None) -> list:
    """Days on `project_id` that are PAID in QuickBooks and whose payout inputs
    this write would change.

    Compare against the FINAL incoming schedule — after crew_integrity's status
    floor and pay-snapshot guards have had their say — or a change those guards
    already reverted would be reported as a conflict that does not exist. The
    flat-rate list and the project end date ride along for the same reason (see
    ``paid_day_signature``); a caller that isn't writing them passes the stored
    values for both sides.

    Empty list = nothing paid is affected, which is the overwhelmingly common
    case and costs one indexed query.
    """
    from sqlalchemy import select
    from backend import models

    rows = (await db.execute(
        select(models.PayoutBillLine, models.PayoutBill)
        .join(models.PayoutBill, models.PayoutBillLine.payout_bill_id == models.PayoutBill.id)
        .where(models.PayoutBillLine.project_id == project_id,
               models.PayoutBill.qb_paid_at.isnot(None))
    )).all()
    if not rows:
        return []

    before = paid_day_signature(stored_schedule, stored_fixed, stored_end)
    after = paid_day_signature(incoming_schedule, incoming_fixed, incoming_end)

    hits = []
    for line, bill in rows:
        key = "%s|%s" % (line.contact_id, line.date)
        if before.get(key) == after.get(key):
            continue
        hits.append({"contactId": line.contact_id, "date": line.date,
                     "docNumber": bill.doc_number, "amount": line.amount, "name": ""})
    if not hits:
        return []

    # Names, so the refusal can say WHO rather than a bare contact id.
    ids = {h["contactId"] for h in hits if h["contactId"] is not None}
    if ids:
        people = (await db.execute(
            select(models.Contact).where(models.Contact.id.in_(ids)))).scalars().all()
        by_id = {c.id: ((c.first_name or "") + " " + (c.last_name or "")).strip() for c in people}
        for h in hits:
            h["name"] = by_id.get(h["contactId"]) or "A crew member"
    hits.sort(key=lambda h: (h["date"], h["name"]))
    return hits


async def load_projects_and_crew(db):
    """Load all projects (id/name/schedule) + crew contacts keyed by id from the
    DB. Split out from ``load_payout_drafts`` so a caller that re-derives several
    periods (e.g. the day-status route) can load this ONCE and re-derive in
    memory, instead of re-querying every project per period."""
    from sqlalchemy import select
    from . import models

    proj_rows = (await db.execute(select(models.Project))).scalars().all()
    contact_rows = (await db.execute(
        select(models.Contact).where(models.Contact.is_crew.is_(True))
    )).scalars().all()

    projects = [{"id": p.id, "name": p.name or "", "schedule": p.schedule or [],
                 "fixed_positions": p.fixed_positions or [], "end_date": p.end_date or ""}
                for p in proj_rows]
    contacts_by_id = {}
    for c in contact_rows:
        contacts_by_id[c.id] = {
            "id": c.id,
            "first_name": c.first_name or "",
            "last_name": c.last_name or "",
            "email": getattr(c, "email", "") or "",
            "crew_departments": getattr(c, "crew_departments", None) or [],
            "row": c,  # live ORM row — the biller caches qb_vendor_id back onto it
        }
    return projects, contacts_by_id


async def load_payout_drafts(db, start_iso, end_iso):
    """Load projects + crew contacts from the DB and re-derive payout drafts.
    The server is the source of truth for the schedule snapshots, so this always
    reflects the persisted state — never a client-submitted amount."""
    projects, contacts_by_id = await load_projects_and_crew(db)
    return derive_payout_drafts(projects, contacts_by_id, start_iso, end_iso)
