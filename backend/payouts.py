"""Crew payout re-derivation + bi-weekly pay-period math.

This module is the SERVER's authoritative view of "what we owe each crew member"
for a date range. It deliberately does NOT re-run the labor rate engine — the
payable figure for a signed-off day is a FROZEN snapshot the frontend stamped at
sign-off time (theme.js::LTP_signOffDay writes the same ``work.pay`` object onto
every confirmed position of a (crew, date), and LTP_setPayAdjustments writes the
same ``adj`` list). So we re-read those snapshots straight out of the opaque
``Project.schedule`` JSON and rebuild the payout, guaranteeing the QuickBooks
vendor bills post exactly the numbers the Payouts tab shows — never a client-
submitted amount.

Two responsibilities:

  1. Pay periods — fixed-length (default 14-day) windows tiling the calendar from
     a configured anchor date. Pure whole-day arithmetic (no wall-clock/DST term),
     mirroring theme.js::LTP_payPeriod* EXACTLY. tests/fixtures/payout_periods.json
     locks the JS and Python implementations together.

  2. derive_payout_drafts — the snapshot re-derivation, mirroring
     theme.js::LTP_payoutRows' payable path (first-match dedup per (crew, date),
     two-step js_round2 rounding, per-unit expense-account grouping).

Money is float dollars rounded to the cent, matching the rest of the app.
"""
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
    """Strict YYYY-MM-DD -> date, or None (mirrors theme.js::_ppEpochDays, which
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
    """Guard/default the period length to bi-weekly (matches theme.js::_ppLen)."""
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
    """'2026-07-06' -> 'July 6th, 2026' (mirrors theme.js::LTP_formatDate)."""
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
