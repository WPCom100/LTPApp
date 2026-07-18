#!/usr/bin/env node
// Payout parity — JS side. Re-verifies theme.js against the shared fixtures so
// they can't silently rot; the Python side (tests/test_payout_bills.py) asserts
// backend/payouts.py reproduces the SAME numbers from the SAME frozen snapshots.
// Regenerate fixtures with: node tests/_gen_payout_fixture.js
//   Run:  node tests/test_payout_parity.js
"use strict";
const fs = require("fs");
const path = require("path");
global.window = {};
let _seq = 0;
window.LTP_genId = (p) => (p || "x") + "-" + (++_seq);
(0, eval)(fs.readFileSync(path.join(__dirname, "..", "theme.js"), "utf8"));

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, g, e) { ok(n, g === e, "got " + JSON.stringify(g) + " exp " + JSON.stringify(e)); }

const fxDir = path.join(__dirname, "fixtures");
const snap = JSON.parse(fs.readFileSync(path.join(fxDir, "payout_snapshot.json"), "utf8"));
const periods = JSON.parse(fs.readFileSync(path.join(fxDir, "payout_periods.json"), "utf8"));

// ── Snapshot parity: LTP_payoutRows still matches the recorded expected ───────
const pr = window.LTP_payoutRows(snap.projects, snap.contacts, snap.services, snap.range.start, snap.range.end);
eq("PS1 grandTotal", pr.grandTotal, snap.expected.grandTotal);
const got = {};
pr.groups.forEach((g) => g.rows.forEach((r) => { got[g.crewId + "|" + r.projectName + "|" + r.date] = r.payable; }));
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
});
periods.payday.forEach((p, i) => {
  eq("PP payday " + i, window.LTP_payPeriodPayDay(p.end, p.offset), p.payDay);
});

console.log("payout-parity suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
