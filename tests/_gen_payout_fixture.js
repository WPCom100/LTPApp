#!/usr/bin/env node
// Fixture generator for the payout JS<->Python parity tests. NOT a test suite
// (underscore prefix keeps it out of the tests/test_*.js glob). Run once to
// regenerate tests/fixtures/payout_snapshot.json after intentional engine
// changes:  node tests/_gen_payout_fixture.js
//
// It builds crew/services/projects, signs off specific days through the REAL
// theme.js engine (LTP_signOffDay / LTP_setPayAdjustments) so the work.pay
// snapshots are authentic, then records LTP_payoutRows' output as the expected
// result. tests/test_payout_parity.js re-verifies the JS side; the Python
// tests/test_payout_bills.py asserts backend/payouts.derive_payout_drafts
// reproduces the same payables from the same frozen snapshots.
"use strict";
const fs = require("fs");
const path = require("path");
// theme.js is now theme.js + components/domain-*.js; the loader reads the
// order straight out of index.html so it cannot drift from production.
require("./_load_domain.js").loadDomain();

const services = [
  { id: 1, role: "L1", dayRate: 1000, dayCost: 600, halfDay: 500, halfDayCost: 300, otRate: 150, otCost: 90 },
  { id: 2, role: "A1", dayRate: 800, dayCost: 480, halfDay: 400, halfDayCost: 240, otRate: 120, otCost: 72 },
  { id: 3, role: "LD", description: "Lighting Designer", dayRate: 0, dayCost: 0 },   // flat-rate role
];
const contacts = [
  { id: 5, isCrew: true, firstName: "Alex", lastName: "Crew", minDayCost: 0 },
  { id: 6, isCrew: true, firstName: "Blair", lastName: "Tech", minDayCost: 700 }, // min floors L1 (700 > 600)
  { id: 7, isCrew: true, firstName: "Casey", lastName: "Owner", minDayCost: 0 },
  { id: 8, isCrew: true, firstName: "Dana", lastName: "Designer", minDayCost: 0 }, // flat-rate hire
];
const crewMins = window.LTP_crewMinMap(contacts);

function pos(id, crewId, serviceId, role, fullMargin) {
  return { id: id, crewId: crewId, serviceId: serviceId, role: role || "L1", status: "confirmed", fullMargin: !!fullMargin };
}
function shift(id, date, time, endTime, positions) {
  return { id: id, date: date, time: time, endTime: endTime, breaks: [], positions: positions };
}

// Flat-rate positions (project.fixedPositions) — see backend/models.py. A
// flat fee is billed on the PROJECT'S END DATE (the payroll period it falls
// into pays it), so each project's endDate is what places its flat-rate positions.
function flat(id, crewId, fee, extra) {
  return Object.assign({ id: id, serviceId: 3, role: "LD", crewId: crewId, status: "confirmed",
    fee: fee, bill: fee * 1.3, fullMargin: false, note: "" }, extra || {});
}

// Project 10 — Summer Fest (ends 07-08, the same day Blair has a signed L1 day)
let p10 = { id: 10, name: "Summer Fest", endDate: "2026-07-08", fixedPositions: [
  flat("f2", 7, 800),                                      // confirmed, NOT completed -> pending on 07-08
  flat("f3", 6, 300),                                      // completed; same date as Blair's signed L1 day -> merges server-side
  flat("f4", 8, 999, { status: "requested" }),             // not confirmed -> ignored
], schedule: [
  shift("s1", "2026-07-08", "08:00", "18:00", [pos("p1", 5, 1, "L1"), pos("p2", 6, 1, "L1")]),      // full day L1 x2
  shift("s2", "2026-07-09", "08:00", "13:00", [pos("p3", 5, 1, "L1")]),                              // Alex half L1
  shift("s3", "2026-07-09", "14:00", "19:00", [pos("p4", 5, 2, "A1")]),                              // Alex half A1 (2nd role)
  shift("s4", "2026-07-10", "08:00", "18:00", [pos("p5", 5, 1, "L1")]),                              // pending (unsigned)
] };
// Sign off the two signed days.
p10.schedule = window.LTP_signOffDay(p10.schedule, 5, "2026-07-08", {}, services, crewMins, "2026-07-08T20:00:00Z", "tester");
p10.schedule = window.LTP_signOffDay(p10.schedule, 6, "2026-07-08", {}, services, crewMins, "2026-07-08T20:00:00Z", "tester");
p10.schedule = window.LTP_signOffDay(p10.schedule, 5, "2026-07-09", {}, services, crewMins, "2026-07-09T20:00:00Z", "tester");
// Alex 07-09 adjustments: +50 parking, -20 advance -> net +30.
p10.schedule = window.LTP_setPayAdjustments(p10.schedule, 5, "2026-07-09",
  [{ id: "adj1", amount: 50, label: "Parking" }, { id: "adj2", amount: -20, label: "Advance" }]);
// 07-10 stays confirmed but unsigned (pending).
// Flat-rate positions: lock the fee at "confirm", then complete the ones that are done.
[7, 6].forEach(function(cid) { p10.fixedPositions = window.LTP_stampFixedPay(p10.fixedPositions, cid, "2026-07-01T09:00:00Z"); });
p10.fixedPositions = window.LTP_completeFixedPosition(p10.fixedPositions, "f3", null, "2026-07-08T20:00:00Z", "tester");

// Project 11 — Warehouse (ends 07-15: Dana's two flat-rate positions bill there)
let p11 = { id: 11, name: "Warehouse", endDate: "2026-07-15", fixedPositions: [
  flat("f1", 8, 1500),                                     // completed + adjustment -> 1550 on 07-15
  flat("f5", 8, 400, { fullMargin: true }),                // completed, full margin -> $0, same ledger key as f1
], schedule: [
  shift("s5", "2026-07-08", "08:00", "18:00", [pos("p6", 5, 2, "A1")]),                              // Alex full A1 (same date as p10 -> 2nd row)
  shift("s6", "2026-07-11", "08:00", "18:00", [pos("p7", 7, 1, "L1", true)]),                        // owner full-margin -> $0
  shift("s7", "2026-07-11", "08:00", "18:00", [pos("p8", 6, 1, "L1")]),                              // Blair no-show + kill fee
] };
p11.schedule = window.LTP_signOffDay(p11.schedule, 5, "2026-07-08", {}, services, crewMins, "2026-07-08T20:00:00Z", "tester");
p11.schedule = window.LTP_signOffDay(p11.schedule, 7, "2026-07-11", {}, services, crewMins, "2026-07-11T20:00:00Z", "tester");
p11.schedule = window.LTP_signOffDay(p11.schedule, 6, "2026-07-11", { p8: { state: "no_show" } }, services, crewMins, "2026-07-11T20:00:00Z", "tester");
p11.schedule = window.LTP_setPayAdjustments(p11.schedule, 6, "2026-07-11", [{ id: "adj3", amount: 100, label: "Kill fee" }]);
p11.fixedPositions = window.LTP_stampFixedPay(p11.fixedPositions, 8, "2026-07-01T09:00:00Z");
p11.fixedPositions = window.LTP_completeFixedPosition(p11.fixedPositions, "f1", null, "2026-07-14T20:00:00Z", "tester");
p11.fixedPositions = window.LTP_setFixedAdjustments(p11.fixedPositions, "f1", [{ id: "adjf1", amount: 50, label: "Travel" }]);
p11.fixedPositions = window.LTP_completeFixedPosition(p11.fixedPositions, "f5", null, "2026-07-16T20:00:00Z", "tester");

const projects = [p10, p11];
const range = { start: "2026-07-06", end: "2026-07-19" };
const pr = window.LTP_payoutRows(projects, contacts, services, range.start, range.end);

// Flatten expected: one entry per (crewId, projectName, date) with payable
// (null = pending). A flat-rate position paid on the same date as a signed shift
// day is a SECOND JS row under that key; the server merges the two into one
// ledger entry, so the expected payable is the SUM (pending stays pending only
// while nothing under the key is payable).
const rowMap = {};
const rowOrder = [];
pr.groups.forEach((g) => g.rows.forEach((r) => {
  const k = g.crewId + "|" + r.projectName + "|" + r.date;
  if (!rowMap[k]) { rowMap[k] = { crewId: g.crewId, projectName: r.projectName, date: r.date, payable: null }; rowOrder.push(k); }
  if (r.payable != null) rowMap[k].payable = Math.round(((rowMap[k].payable || 0) + r.payable) * 100) / 100;
}));
const rows = rowOrder.map((k) => rowMap[k]);
const byCrew = {};
pr.groups.forEach((g) => { byCrew[g.crewId] = g.total; });

const fixture = {
  _note: "Generated by tests/_gen_payout_fixture.js — do not hand-edit. Snapshots are authentic (signed via theme.js).",
  range, services, contacts, projects,
  expected: { grandTotal: pr.grandTotal, rows, byCrew },
};

const outDir = path.join(__dirname, "fixtures");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "payout_snapshot.json");
fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n");
console.log("wrote " + outPath);
console.log("grandTotal=" + pr.grandTotal + "  groups=" + pr.groups.length + "  rows=" + rows.length);

// Pay-period vectors — expected values come from the JS helpers so the Python
// mirror (backend/payouts.py) is locked to them.
const ppCases = [
  ["2026-07-06", 14, "2026-07-06"], ["2026-07-06", 14, "2026-07-19"], ["2026-07-06", 14, "2026-07-20"],
  ["2026-07-06", 14, "2026-07-05"], ["2026-07-06", 14, "2026-01-01"], ["2026-07-06", 7, "2026-07-13"],
  ["2026-01-01", 14, "2026-01-01"], ["2026-07-06", 14, "2026-12-31"], ["2026-07-06", 14, "2027-07-06"],
].map(function (c) {
  const idx = window.LTP_payPeriodIndex(c[0], c[1], c[2]);
  const b = window.LTP_payPeriodForIndex(c[0], c[1], idx);
  const n = window.LTP_payPeriodNumberInYear(c[0], c[1], idx);
  return { anchor: c[0], length: c[1], date: c[2], index: idx, start: b.start, end: b.end,
    year: n.year, year2: n.year2, number: n.number };
});
const ppPayday = [["2026-07-19", 5], ["2026-07-19", 0], ["2026-08-02", 5]].map(function (c) {
  return { end: c[0], offset: c[1], payDay: window.LTP_payPeriodPayDay(c[0], c[1]) };
});
const periodsPath = path.join(outDir, "payout_periods.json");
fs.writeFileSync(periodsPath, JSON.stringify({ cases: ppCases, payday: ppPayday }, null, 2) + "\n");
console.log("wrote " + periodsPath + "  cases=" + ppCases.length);
