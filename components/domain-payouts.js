// LTP domain — crew payouts and pay-period arithmetic.
//
// Split out of theme.js. LTP_payoutRows is what the QuickBooks payout push
// reads, so this is money math; the pay-period helpers below it are the
// calendar the payouts are bucketed into.
//
// KEEP TOGETHER: _ppEpochDays / _ppISO / _ppLen are the date arithmetic behind
// four of the six pay-period exports. Currently globals rather than true
// privates (see the note in domain-labor.js), so a split would still run — but
// the grouping is deliberate and should survive an IIFE wrap.
//
// LOAD ORDER CONTRACT — read before moving this <script> tag.
//   These domain-*.js files were split out of theme.js. They must stay in
//   index.html's THEME slot (group 3), together and in the listed order, and
//   BEFORE every components/ and modules/ file — NOT down in the components
//   group where their path suggests they belong. 46 frontend files alias these
//   exports into IIFE-locals at their OWN load time (modules/quotes-list.js:9
//   is `var computeTotals = window.LTP_QUOTE_TOTALS;`), so a symbol defined
//   after its consumer's <script> is captured as undefined, not late-bound.
//   They also belong in sw.js's SAME_ORIGIN_PRECACHE boot chain beside
//   /theme.js, or the shell drops them on a cold offline launch.
//
// Nothing here reads another LTP_ symbol at load time, so the order AMONG
// these files is free; it is fixed only for readability. The one genuine
// load-order edge in the original file (the LTP_STATUS_COLORS IIFE calling
// LTP_badgeFromHex) stayed behind in theme.js on purpose.


// Aggregate confirmed crew work across all projects into payout rows for a date
// range. One row = one person's day on one project. Each row carries:
//   locked  — the pay snapshot agreed at confirm (null on legacy pre-snapshot
//             confirmations → "unlocked")
//   current — the same day recomputed with today's schedule/rates/minimums
//   drift   — locked exists but no longer matches current (unsigned rows only —
//             a signed day's figure is frozen, drift no longer applies)
//   signed  — { state: worked|adjusted|no_show, pay, signedAt, signedBy } from
//             the day-of sign-off, or null while the day is still pending
//   adjustments/adjTotal — manual extras/deductions for the day (LTP_setPayAdjustments)
//   estimate — (locked else current) + adjustments: the pre-sign-off figure
//   payable — the FINAL figure (signed.pay.total + adjustments); null until signed off.
// Payout requires sign-off: grandTotal sums signed days only; pending days are
// counted separately (pendingCount/pendingTotal of estimates).
//
// `clientRates` (optional) re-prices the RECOMPUTED figure per project against
// that project's client — a project for a client with a negotiated payout rate
// or hours minimum recomputes on those, so "drift" compares like with like.
// Omit it and every project prices off the base card exactly as before.
window.LTP_payoutRows = function(projects, contacts, services, startDate, endDate, clientRates) {
  var crewMins = window.LTP_crewMinMap(contacts);
  var byCrew = {};   // String(crewId) → { crewId, rows: [] }
  (projects || []).forEach(function(proj) {
    // A project is always billed to its company; an internal/manual shift has
    // none and prices off the base card.
    var svcs = window.LTP_servicesForClient(services, clientRates, window.LTP_clientRef(proj));
    var byDate = {};
    (proj.schedule || []).forEach(function(s) {
      if (!s.date) return;
      if (startDate && s.date < startDate) return;
      if (endDate && s.date > endDate) return;
      (byDate[s.date] = byDate[s.date] || []).push(s);
    });
    Object.keys(byDate).forEach(function(d) {
      var seen = {};  // String(crewId) → { id, locked, work, states, adj }
      byDate[d].forEach(function(s) {
        (s.positions || []).forEach(function(p) {
          if (!p || p.crewId == null || p.status !== "confirmed") return;
          var k = String(p.crewId);
          if (!seen[k]) seen[k] = { id: p.crewId, locked: null, work: null, states: {}, adj: null };
          if (p.pay && !seen[k].locked) seen[k].locked = p.pay;
          if (p.work) { if (!seen[k].work) seen[k].work = p.work; seen[k].states[p.work.state] = true; }
          if (p.adj && p.adj.length && !seen[k].adj) seen[k].adj = p.adj;
        });
      });
      Object.keys(seen).forEach(function(k) {
        var entry = seen[k];
        var current = window.LTP_crewDayPay(byDate[d], entry.id, svcs, crewMins);
        var locked = entry.locked;
        var signed = null;
        if (entry.work && entry.work.pay) {
          // Day state rolls up from the position states: all no-show → no_show,
          // any adjusted (or a dropped shift alongside worked ones) → adjusted.
          var st = entry.states.no_show && !entry.states.worked && !entry.states.adjusted ? "no_show"
            : (entry.states.adjusted || entry.states.no_show) ? "adjusted" : "worked";
          signed = { state: st, pay: entry.work.pay, signedAt: entry.work.signedAt, signedBy: entry.work.signedBy };
        }
        var drift = !!(!signed && locked && (!current
          || Math.abs(locked.total - current.total) > 0.005
          || locked.paidHours !== current.paidHours
          || locked.otHours !== current.otHours));
        // Adjustments (extras/deductions) sit on top of both the pre-sign-off
        // estimate and the frozen final. Drift compares BASE figures only —
        // an adjustment shifts locked and current equally.
        var adjustments = entry.adj || [];
        var adjTotal = Math.round(adjustments.reduce(function(t, a) { return t + (a.amount || 0); }, 0) * 100) / 100;
        var estimate = Math.round(((locked ? locked.total : (current ? current.total : 0)) + adjTotal) * 100) / 100;
        if (!byCrew[k]) byCrew[k] = { crewId: entry.id, rows: [] };
        byCrew[k].rows.push({ crewId: entry.id, projectId: proj.id, projectName: proj.name,
          date: d, locked: locked, current: current, drift: drift,
          signed: signed, adjustments: adjustments, adjTotal: adjTotal, estimate: estimate,
          payable: signed ? Math.round((signed.pay.total + adjTotal) * 100) / 100 : null });
      });
    });
  });
  var groups = Object.keys(byCrew).map(function(k) {
    var g = byCrew[k];
    var cm = (contacts || []).find(function(c) { return c.id === g.crewId; });
    g.crewName = cm ? ((cm.firstName || "") + " " + (cm.lastName || "")).trim() : "Unknown";
    g.rows.sort(function(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.projectName < b.projectName ? -1 : 1); });
    g.total = Math.round(g.rows.reduce(function(t, r) { return t + (r.payable || 0); }, 0) * 100) / 100;
    g.pendingTotal = Math.round(g.rows.reduce(function(t, r) { return t + (r.signed ? 0 : r.estimate); }, 0) * 100) / 100;
    return g;
  });
  groups.sort(function(a, b) { return a.crewName < b.crewName ? -1 : 1; });
  var grandTotal = 0, pendingTotal = 0, pendingCount = 0, driftCount = 0, unlockedCount = 0;
  groups.forEach(function(g) {
    grandTotal += g.total;
    pendingTotal += g.pendingTotal;
    g.rows.forEach(function(r) {
      if (!r.signed) { pendingCount++; if (r.drift) driftCount++; if (!r.locked) unlockedCount++; }
    });
  });
  return { groups: groups, grandTotal: Math.round(grandTotal * 100) / 100,
    pendingTotal: Math.round(pendingTotal * 100) / 100, pendingCount: pendingCount,
    driftCount: driftCount, unlockedCount: unlockedCount };
};

// ── Pay periods (bi-weekly payroll cycles) ───────────────────────────────────
//
// A pay period is a fixed-length window (default 14 days) that tiles the calendar
// from a configured anchor date. All arithmetic is whole-UTC-day math so no
// wall-clock/DST term ever enters — every date maps to exactly one integer-indexed
// period (dates before the anchor get negative indices; there are no gaps). Inputs
// and outputs are date-only ISO strings "YYYY-MM-DD".
//
// The Python mirror is backend/payouts.py (pay_period_index / pay_period_bounds) —
// the two MUST agree; tests/fixtures/payout_periods.json locks them together.
//
// Helpers return null (never throw) on a missing/invalid anchor or date so callers
// can fall back to the week/month presets.

// Whole days between the UNIX epoch and an ISO date, in UTC. Returns null for a
// malformed or overflow-normalized date (e.g. "2026-02-31").
function _ppEpochDays(iso) {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  var p = iso.split("-");
  var y = parseInt(p[0], 10), m = parseInt(p[1], 10), d = parseInt(p[2], 10);
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  var t = Date.UTC(y, m - 1, d);
  if (isNaN(t)) return null;
  var back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return Math.floor(t / 86400000);
}
function _ppISO(days) {
  var dt = new Date(days * 86400000);
  return dt.getUTCFullYear() + "-" + String(dt.getUTCMonth() + 1).padStart(2, "0") + "-" + String(dt.getUTCDate()).padStart(2, "0");
}
function _ppLen(lengthDays) {
  var n = parseInt(lengthDays, 10);
  return (n >= 1 && n <= 31) ? n : 14;   // guard/default to bi-weekly
}

// Integer index of the period containing `dateISO` (0 = the anchor's own period).
window.LTP_payPeriodIndex = function(anchorISO, lengthDays, dateISO) {
  var a = _ppEpochDays(anchorISO), d = _ppEpochDays(dateISO);
  if (a === null || d === null) return null;
  return Math.floor((d - a) / _ppLen(lengthDays));
};

// { index, start, end } for a given period index (end inclusive = start + len - 1).
window.LTP_payPeriodForIndex = function(anchorISO, lengthDays, index) {
  var a = _ppEpochDays(anchorISO);
  if (a === null || typeof index !== "number" || isNaN(index)) return null;
  var len = _ppLen(lengthDays);
  var startDays = a + index * len;
  return { index: index, start: _ppISO(startDays), end: _ppISO(startDays + len - 1) };
};

// The period { index, start, end } containing `asOfISO`.
window.LTP_payPeriodBounds = function(anchorISO, lengthDays, asOfISO) {
  var idx = window.LTP_payPeriodIndex(anchorISO, lengthDays, asOfISO);
  if (idx === null) return null;
  return window.LTP_payPeriodForIndex(anchorISO, lengthDays, idx);
};

// The pay date for a period: its end date plus `offsetDays` (e.g. period ends
// Sunday, offset 5 → the following Friday).
window.LTP_payPeriodPayDay = function(endISO, offsetDays) {
  var e = _ppEpochDays(endISO);
  if (e === null) return null;
  var off = parseInt(offsetDays, 10);
  if (isNaN(off) || off < 0) off = 0;
  return _ppISO(e + off);
};

// Human label for a period, e.g. "July 6th, 2026 – July 19th, 2026".
window.LTP_payPeriodLabel = function(startISO, endISO) {
  if (!startISO || !endISO) return "";
  return window.LTP_formatDate(startISO) + " – " + window.LTP_formatDate(endISO);
};

// { year, year2, number } for a period index — 'number' is the 1-based ordinal
// of this period within its start date's calendar year (period #1 = first period
// starting that year; resets each January). Drives the "PAY-26-14" bill number
// and the navigator's "Period 14 · 2026" label. Python mirror:
// backend/payouts.py::pay_period_number_in_year.
window.LTP_payPeriodNumberInYear = function(anchorISO, lengthDays, index) {
  var pp = window.LTP_payPeriodForIndex(anchorISO, lengthDays, index);
  if (!pp) return null;
  var aDays = _ppEpochDays(anchorISO);
  var year = new Date(_ppEpochDays(pp.start) * 86400000).getUTCFullYear();
  var len = _ppLen(lengthDays);
  var idxJan1 = Math.floor((_ppEpochDays(year + "-01-01") - aDays) / len);
  var startJan1Year = new Date((aDays + idxJan1 * len) * 86400000).getUTCFullYear();
  var firstIdx = (startJan1Year === year) ? idxJan1 : idxJan1 + 1;
  return { year: year, year2: year % 100, number: index - firstIdx + 1 };
};
