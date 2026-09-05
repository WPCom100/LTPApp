#!/usr/bin/env node
// Flat-rate ("fixed cost") positions — the domain layer.
//
// A lighting designer or stage manager hired for the whole project at a flat
// fee, no call times. Covers the helpers in components/domain-crew.js,
// domain-payouts.js and domain-util.js that the Schedule Builder, Labor tabs
// and the crew page build on:
//   - LTP_fixedPositionPay / LTP_stampFixedPay (lock at confirm)
//   - LTP_completeFixedPosition / LTP_uncompleteFixedPosition ("Mark complete")
//   - LTP_setFixedAdjustments / LTP_getFixedAdjustments
//   - LTP_fixedPayDate (the project's end date → "" without one)
//   - LTP_payoutRows flat rows (range, locked/current/drift/signed/payable, totals)
//   - LTP_scheduleLaborSections flat quote lines
//   - LTP_diffRemovedFixed / LTP_fixedSnapshots / LTP_fixedPositionsTotals
//   - LTP_gcalUrl all-day span
//   Run:  node tests/test_fixed_positions.js
"use strict";
require("./_load_domain.js").loadDomain();

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, g, e) { ok(n, JSON.stringify(g) === JSON.stringify(e), "got " + JSON.stringify(g) + " exp " + JSON.stringify(e)); }

const services = [
  { id: 1, role: "L1", description: "Lighting Tech", department: "Lighting", dayRate: 1000, dayCost: 600 },
  { id: 3, role: "LD", description: "Lighting Designer", department: "Lighting", dayRate: 0, dayCost: 0 },
];
const contacts = [
  { id: 5, isCrew: true, firstName: "Alex", lastName: "Crew" },
  { id: 8, isCrew: true, firstName: "Dana", lastName: "Designer" },
];
function flat(id, crewId, fee, extra) {
  return Object.assign({ id: id, serviceId: 3, role: "LD", crewId: crewId, status: "confirmed",
    fee: fee, bill: 2000, fullMargin: false, note: "" }, extra || {});
}

// ── Pay figure ───────────────────────────────────────────────────────────────
let pay = window.LTP_fixedPositionPay(flat("a", 8, 1500));
eq("A1 fee is the total", pay.total, 1500);
eq("A2 tier flat, no hours", [pay.tier, pay.paidHours, pay.otHours], ["flat", 0, 0]);
eq("A3 one unit on the role", [pay.units.length, pay.units[0].serviceId, pay.units[0].total], [1, 3, 1500]);
eq("A4 override amount", window.LTP_fixedPositionPay(flat("a", 8, 1500), 1750).total, 1750);
eq("A5 full margin pays $0 even with an amount", window.LTP_fixedPositionPay(flat("a", 8, 1500, { fullMargin: true }), 1750).total, 0);
eq("A6 cents rounding", window.LTP_fixedPositionPay(flat("a", 8, 1234.567)).total, 1234.57);
eq("A7 garbage fee → 0", window.LTP_fixedPositionPay(flat("a", 8, "x")).total, 0);

// ── Lock at confirm ──────────────────────────────────────────────────────────
let list = [flat("a", 8, 1500), flat("b", 8, 200, { status: "requested" }), flat("c", 5, 900)];
let locked = window.LTP_stampFixedPay(list, 8, "2026-07-01T09:00:00Z");
ok("B1 confirmed engagement of the crew locks", locked[0].pay && locked[0].pay.total === 1500 && locked[0].pay.lockedAt === "2026-07-01T09:00:00Z");
ok("B2 unconfirmed one untouched", !locked[1].pay);
ok("B3 other crew untouched", !locked[2].pay && locked[2] === list[2]);
locked = window.LTP_stampFixedPay(list, 8, "t", ["zzz"]);
ok("B4 ids filter → nothing when no match", !locked[0].pay);

// ── Mark complete / undo ─────────────────────────────────────────────────────
let done = window.LTP_completeFixedPosition(list, "a", null, "2026-07-14T20:00:00Z", "tester");
ok("C1 work frozen on the engagement", done[0].work && done[0].work.state === "completed" && done[0].work.pay.total === 1500);
eq("C2 signer recorded", [done[0].work.signedAt, done[0].work.signedBy], ["2026-07-14T20:00:00Z", "tester"]);
eq("C3 completing at another amount", window.LTP_completeFixedPosition(list, "a", 1750, "t", "u")[0].work.pay.total, 1750);
ok("C4 a non-confirmed engagement can't complete", !window.LTP_completeFixedPosition(list, "b", null, "t", "u")[1].work);
ok("C5 original untouched (pure)", !list[0].work);
let undone = window.LTP_uncompleteFixedPosition(done, "a");
ok("C6 undo strips work", !undone[0].work && undone[1] === done[1]);

// ── Adjustments ──────────────────────────────────────────────────────────────
let adj = window.LTP_setFixedAdjustments(list, "a", [{ id: "x", amount: 50, label: "Travel" }, { id: "y", amount: 0 }, { id: "z", amount: "nope" }]);
eq("D1 zero/invalid amounts dropped", adj[0].adj.map(function(a) { return a.id; }), ["x"]);
eq("D2 getter reads back", window.LTP_getFixedAdjustments(adj, "a").length, 1);
ok("D3 empty list clears", !("adj" in window.LTP_setFixedAdjustments(adj, "a", [])[0]));
eq("D4 getter on unknown id → []", window.LTP_getFixedAdjustments(adj, "nope"), []);

// ── Pay date resolution: the project's end date, nothing else ────────────────
eq("E1 project end date", window.LTP_fixedPayDate({ endDate: "2026-09-13" }), "2026-09-13");
eq("E2 no end date → empty", window.LTP_fixedPayDate({ endDate: "" }), "");
eq("E3 malformed end date → empty", window.LTP_fixedPayDate({ endDate: "2026-02-31" }), "");
eq("E4 missing project → empty", window.LTP_fixedPayDate(null), "");
// The payroll period that date falls into is where the fee is paid, on that
// period's pay day (the following Friday with a Sunday period end + 5 days).
const ppEnd = window.LTP_payPeriodBounds("2026-09-07", 14, window.LTP_fixedPayDate({ endDate: "2026-09-13" }));
eq("E5 lands in the period containing the end date", [ppEnd.start, ppEnd.end], ["2026-09-07", "2026-09-20"]);
eq("E6 paid on that period's pay day", window.LTP_payPeriodPayDay(ppEnd.end, 5), "2026-09-25");

// ── Payout rows ──────────────────────────────────────────────────────────────
// Dana's engagements on Summer Fest (ends 07-15): one completed with an
// adjustment, one requested (ignored), one completed at full margin. Alex:
// confirmed-but-incomplete on Autumn Gala (ends 07-18) → pending; a completed
// one on a project ending 08-01 → outside the range.
let fixed = [flat("a", 8, 1500), flat("c", 8, 999, { status: "requested" }), flat("d", 8, 400, { fullMargin: true })];
fixed = window.LTP_stampFixedPay(fixed, 8, "2026-07-01T09:00:00Z");
fixed = window.LTP_completeFixedPosition(fixed, "a", null, "2026-07-14T20:00:00Z", "tester");
fixed = window.LTP_setFixedAdjustments(fixed, "a", [{ id: "x", amount: 50, label: "Travel" }]);
fixed = window.LTP_completeFixedPosition(fixed, "d", null, "2026-07-16T20:00:00Z", "tester");
// bump the fee on "a" AFTER completing (frozen figure must not move)
fixed = fixed.map(function(p) { return p.id === "a" ? Object.assign({}, p, { fee: 1600 }) : p; });
const proj = { id: 10, name: "Summer Fest", endDate: "2026-07-15", schedule: [], fixedPositions: fixed };
const projB = { id: 11, name: "Autumn Gala", endDate: "2026-07-18", schedule: [], fixedPositions: [flat("b", 5, 800)] };
const projC = { id: 12, name: "Winter Show", endDate: "2026-08-01", schedule: [],
  fixedPositions: window.LTP_completeFixedPosition([flat("e", 5, 100)], "e", null, "t", "u") };
const pr = window.LTP_payoutRows([proj, projB, projC], contacts, services, "2026-07-06", "2026-07-19");
const dana = pr.groups.find(function(g) { return g.crewId === 8; });
const alex = pr.groups.find(function(g) { return g.crewId === 5; });
ok("F1 two crew groups", pr.groups.length === 2 && dana && alex);
eq("F2 Dana rows: completed + full-margin (requested one skipped)", dana.rows.map(function(r) { return r.posId; }), ["a", "d"]);
const ra = dana.rows[0];
eq("F3 flat row dated on the project end", [ra.kind, ra.date, ra.roleLabel, ra.projectName], ["flat", "2026-07-15", "LD — Lighting Designer", "Summer Fest"]);
eq("F4 frozen payable = work total + adjustments (fee bump ignored)", ra.payable, 1550);
ok("F5 signed carries the completion", ra.signed && ra.signed.state === "completed" && ra.signed.pay.total === 1500);
ok("F6 no drift once completed", ra.drift === false);
eq("F7 full-margin row pays 0", [dana.rows[1].payable, dana.rows[1].fullMargin], [0, true]);
eq("F8 Dana total = signed only", dana.total, 1550);
const rb = alex.rows[0];
eq("F9 Alex: pending on the project end date", [rb.date, rb.payable, rb.signed], ["2026-07-18", null, null]);
eq("F10 pending estimate is the fee", rb.estimate, 800);
ok("F11 engagement on a project ending outside the range excluded", !alex.rows.some(function(r) { return r.posId === "e"; }));
eq("F12 grand/pending totals", [pr.grandTotal, pr.pendingTotal, pr.pendingCount], [1550, 800, 1]);
eq("F13 unlocked count (Alex was never stamped)", pr.unlockedCount, 1);
// Drift: locked at 1500, fee now 1700, not yet completed.
const drifted = { id: 11, name: "Drift", endDate: "2026-07-18", schedule: [],
  fixedPositions: window.LTP_stampFixedPay([flat("g", 8, 1500)], 8, "t").map(function(p) { return Object.assign({}, p, { fee: 1700 }); }) };
const pd = window.LTP_payoutRows([drifted], contacts, services, "2026-07-06", "2026-07-19");
ok("F14 drift flagged when the fee moved after lock", pd.groups[0].rows[0].drift === true && pd.driftCount === 1);
eq("F15 estimate stays at the locked figure", pd.groups[0].rows[0].estimate, 1500);
// No project end date → not a row anywhere.
const nodate = { id: 14, name: "Undated", endDate: "", schedule: [], fixedPositions: [flat("h", 8, 500)] };
eq("F16 no project end date → no row", window.LTP_payoutRows([nodate], contacts, services, "", "").groups.length, 0);
// A flat row alongside a shift day on the same date stays a separate UI row.
const both = { id: 13, name: "Both", endDate: "2026-07-08", schedule: [
    { id: "s", date: "2026-07-08", time: "08:00", endTime: "18:00", breaks: [], positions: [{ id: "p", crewId: 8, serviceId: 1, role: "L1", status: "confirmed" }] }],
  fixedPositions: [flat("k", 8, 300)] };
const pb = window.LTP_payoutRows([both], contacts, services, "2026-07-06", "2026-07-19");
eq("F17 same-date shift + flat are two rows", pb.groups[0].rows.map(function(r) { return r.kind || "day"; }), ["flat", "day"]);

// ── Quote lines ──────────────────────────────────────────────────────────────
const sched = [{ id: "s1", date: "2026-09-10", time: "08:00", endTime: "18:00", breaks: [], positions: [{ id: "p1", serviceId: 1, role: "L1", crewId: 5, status: "confirmed" }] },
               { id: "s2", date: "2026-09-13", time: "08:00", endTime: "18:00", breaks: [], positions: [] }];
const fmt = function(d) { return d; };
const secs = window.LTP_scheduleLaborSections(sched, services, {}, "one", fmt, function(p) { return p + "-x"; },
  [flat("q1", 8, 1500, { bill: 2000 }), flat("q2", 8, 100, { bill: 0 }), flat("q3", 8, 100, { bill: 500, serviceId: null }),
   flat("q4", 5, 700, { bill: 900, fullMargin: true })]);
const items = secs[0].items;
const flatLines = items.filter(function(i) { return i.rateType === "flat"; });
eq("G1 one flat line per billed engagement with a role", flatLines.length, 2);
eq("G2 flat line shape", [flatLines[0].type, flatLines[0].serviceId, flatLines[0].name, flatLines[0].qty, flatLines[0].unitPrice, flatLines[0].cost],
   ["service", 3, "LD — Lighting Designer", 1, 2000, 1500]);
eq("G3 note spans the scheduled dates", flatLines[0].notes, "Flat-rate engagement · 2026-09-10 – 2026-09-13");
eq("G4 full-margin line costs 0", [flatLines[1].unitPrice, flatLines[1].cost], [900, 0]);
ok("G5 hourly day line still emitted first", items[0].rateType === "day" && items[0].serviceId === 1);
const flatOnly = window.LTP_scheduleLaborSections([], services, {}, "split", fmt, null, [flat("q1", 8, 1500, { bill: 2000 })]);
eq("G6 flat-only schedule still bills, grouped by department", [flatOnly.length, flatOnly[0].label, flatOnly[0].items.length], [1, "Lighting", 1]);
eq("G7 nothing billable → []", window.LTP_scheduleLaborSections([], services, {}, "one", fmt, null, [flat("q2", 8, 100, { bill: 0 })]), []);

// ── Removal notices + snapshots + totals ────────────────────────────────────
const before = [flat("r1", 8, 1500, { status: "confirmed" }), flat("r2", 5, 800, { status: "requested" }), flat("r3", 5, 100, { status: "open" })];
const after = [flat("r2", 8, 800, { status: "open" })];   // r1 deleted, r2 reassigned to Dana, r3 gone (was open → no notice)
const removed = window.LTP_diffRemovedFixed(before, after, contacts, services);
eq("H1 one notice per person + type", removed.map(function(g) { return g.crewId + ":" + g.template; }).sort(), ["5:crewWithdrawn", "8:crewCancelled"]);
const canc = removed.find(function(g) { return g.crewId === 8; });
eq("H2 snapshot is an engagement card", [canc.shifts[0].flat, canc.shifts[0].roleLabel, canc.shifts[0].date, canc.crewName], [true, "LD — Lighting Designer", "", "Dana Designer"]);
eq("H3 unchanged list → no notices", window.LTP_diffRemovedFixed(before, before, contacts, services), []);
eq("H4 snapshots by id", window.LTP_fixedSnapshots(before, ["r2"], services).map(function(s) { return s.positionId; }), ["r2"]);
const tot = window.LTP_fixedPositionsTotals([flat("t1", 8, 1500, { bill: 2000 }), flat("t2", 5, 700, { bill: 900, fullMargin: true, status: "open" })]);
eq("I1 totals: bill, cost (full margin → 0), margin, counts", [tot.rateTotal, tot.costTotal, tot.margin, tot.count, tot.filled], [2900, 1500, 1400, 2, 1]);

// ── All-day calendar link ────────────────────────────────────────────────────
const url = window.LTP_gcalUrl({ title: "LTP - LD - Gala", date: "2026-09-10", endDate: "2026-09-13", allDay: true });
ok("J1 all-day span with exclusive end", url.indexOf("&dates=20260910/20260914") !== -1, url);
const one = window.LTP_gcalUrl({ title: "x", date: "2026-09-10", allDay: true });
ok("J2 single all-day event", one.indexOf("&dates=20260910/20260911") !== -1, one);
ok("J3 timed link unchanged", window.LTP_gcalUrl({ title: "x", date: "2026-09-10", time: "08:00", endTime: "18:00" }).indexOf("&dates=20260910T080000/20260910T180000") !== -1);

console.log("fixed-positions suite — PASS: " + pass + "   FAIL: " + fail);
if (fail) { fails.forEach(function(f) { console.log("  ✗ " + f); }); process.exit(1); }
console.log("All " + pass + " assertions passed.");
