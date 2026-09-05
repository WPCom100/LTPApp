#!/usr/bin/env node
// Payout parity — JS side. Re-verifies theme.js against the shared fixtures so
// they can't silently rot; the Python side (tests/test_payout_bills.py) asserts
// backend/payouts.py reproduces the SAME numbers from the SAME frozen snapshots.
// Regenerate fixtures with: node tests/_gen_payout_fixture.js
//   Run:  node tests/test_payout_parity.js
"use strict";
const fs = require("fs");
const path = require("path");
// theme.js is now theme.js + components/domain-*.js; the loader reads the
// order straight out of index.html so it cannot drift from production.
require("./_load_domain.js").loadDomain();

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, g, e) { ok(n, g === e, "got " + JSON.stringify(g) + " exp " + JSON.stringify(e)); }

const fxDir = path.join(__dirname, "fixtures");
const snap = JSON.parse(fs.readFileSync(path.join(fxDir, "payout_snapshot.json"), "utf8"));
const periods = JSON.parse(fs.readFileSync(path.join(fxDir, "payout_periods.json"), "utf8"));

// ── Snapshot parity: LTP_payoutRows still matches the recorded expected ───────
const pr = window.LTP_payoutRows(snap.projects, snap.contacts, snap.services, snap.range.start, snap.range.end);
eq("PS1 grandTotal", pr.grandTotal, snap.expected.grandTotal);
// Sum per (crew, project, date): a flat-rate position paid on a signed shift day is
// a second row under the same key (the server merges them into one ledger line).
const got = {};
pr.groups.forEach((g) => g.rows.forEach((r) => {
  const k = g.crewId + "|" + r.projectName + "|" + r.date;
  if (!(k in got)) got[k] = null;
  if (r.payable != null) got[k] = Math.round(((got[k] || 0) + r.payable) * 100) / 100;
}));
snap.expected.rows.forEach((r) => {
  const k = r.crewId + "|" + r.projectName + "|" + r.date;
  eq("PS row " + k, got[k], r.payable);
});
Object.keys(snap.expected.byCrew).forEach((cid) => {
  const g = pr.groups.find((x) => String(x.crewId) === cid);
  eq("PS total crew " + cid, g ? g.total : null, snap.expected.byCrew[cid]);
});

// ── Period parity: helpers still match the recorded vectors ───────────────────
periods.cases.forEach((c, i) => {
  eq("PP index " + i, window.LTP_payPeriodIndex(c.anchor, c.length, c.date), c.index);
  const b = window.LTP_payPeriodForIndex(c.anchor, c.length, c.index);
  ok("PP bounds " + i, b && b.start === c.start && b.end === c.end, JSON.stringify(b));
  const n = window.LTP_payPeriodNumberInYear(c.anchor, c.length, c.index);
  ok("PP number " + i, n && n.year2 === c.year2 && n.number === c.number, JSON.stringify(n));
});
periods.payday.forEach((p, i) => {
  eq("PP payday " + i, window.LTP_payPeriodPayDay(p.end, p.offset), p.payDay);
});

// ── Pay adjustments: the getter must agree with the payout rollup ────────────
//
// The adjustments modal reads LTP_getPayAdjustments and the payout row reads
// its own rollup in domain-payouts.js. They walk the same schedule looking for
// the same thing, so if they ever disagree the modal shows one list while the
// money is computed from another. These pin them together.

function dayWith(positions) {
  return [{ id: "s1", date: "2026-05-04", time: "08:00", endTime: "17:00", breaks: [], positions: positions }];
}
const ADJ = [{ id: "a1", amount: 25, label: "parking" }, { id: "a2", amount: -10, label: "advance" }];

{
  const sched = window.LTP_setPayAdjustments(
    dayWith([{ id: "p1", crewId: 9, status: "confirmed", serviceId: 1 }]), 9, "2026-05-04", ADJ);
  eq("PA1 what the setter stored is what the getter reads",
     JSON.stringify(window.LTP_getPayAdjustments(sched, 9, "2026-05-04")), JSON.stringify(ADJ));
  eq("PA2 a different person on the same day has none",
     window.LTP_getPayAdjustments(sched, 8, "2026-05-04").length, 0);
  eq("PA3 a different day has none",
     window.LTP_getPayAdjustments(sched, 9, "2026-05-05").length, 0);
}

{
  // Clearing must read back as empty, not as the old list.
  let sched = window.LTP_setPayAdjustments(
    dayWith([{ id: "p1", crewId: 9, status: "confirmed", serviceId: 1 }]), 9, "2026-05-04", ADJ);
  sched = window.LTP_setPayAdjustments(sched, 9, "2026-05-04", []);
  eq("PA4 clearing empties it", window.LTP_getPayAdjustments(sched, 9, "2026-05-04").length, 0);
}

{
  // Unconfirmed positions are not the person's day — the rollup skips them and
  // so must the getter, or the modal offers to edit something nothing bills.
  const sched = dayWith([{ id: "p1", crewId: 9, status: "requested", serviceId: 1, adj: ADJ }]);
  eq("PA5 an unconfirmed position is not read", window.LTP_getPayAdjustments(sched, 9, "2026-05-04").length, 0);
}

{
  // The zero-amount filter lives in the setter; the getter reports what is
  // stored, so a zero can never reach the row through either path.
  const sched = window.LTP_setPayAdjustments(
    dayWith([{ id: "p1", crewId: 9, status: "confirmed", serviceId: 1 }]), 9, "2026-05-04",
    [{ id: "z", amount: 0, label: "nothing" }, { id: "a1", amount: 25, label: "parking" }]);
  const read = window.LTP_getPayAdjustments(sched, 9, "2026-05-04");
  eq("PA6 a zero-amount adjustment is not stored", read.length, 1);
  eq("PA7 and the real one survives", read[0].label, "parking");
}

{
  // The whole point: the modal's list and the payout row's list are the same
  // list, on the real rollup path.
  const projects = [{ id: 1, name: "Gala", status: "upcoming",
    startDate: "2026-05-04", endDate: "2026-05-04",
    schedule: window.LTP_setPayAdjustments(
      dayWith([{ id: "p1", crewId: 9, status: "confirmed", serviceId: 1,
                 work: { state: "worked", pay: { total: 400, tier: "day" }, signedAt: "2026-05-04" } }]),
      9, "2026-05-04", ADJ) }];
  const contacts = [{ id: 9, firstName: "Pat", lastName: "Paid", isCrew: true }];
  const services = [{ id: 1, role: "A1", description: "Audio", department: "Audio" }];
  const rows = window.LTP_payoutRows(projects, contacts, services, "2026-05-01", "2026-05-31");
  const row = rows.groups[0] && rows.groups[0].rows[0];
  ok("PA8 the payout row carries the adjustments", !!row && row.adjustments.length === 2);
  eq("PA9 and the getter reads exactly the same list",
     JSON.stringify(window.LTP_getPayAdjustments(projects[0].schedule, 9, "2026-05-04")),
     JSON.stringify(row.adjustments));
  eq("PA10 net matches the row's adjTotal", row.adjTotal, 15);
}

console.log("payout-parity suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
