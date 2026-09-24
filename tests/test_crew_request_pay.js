#!/usr/bin/env node
// Paid out — when Labor → Crew Requests stops showing a request
// (components/domain-crew.js::LTP_crewRequestPay, LTP_paidOutProjects).
//
// The payout ledger says which days are paid: GET /api/crew-requests carries
// each request's paidDates (backend/routes/crew.py::_paid_dates). These tests
// hold the rules that read them:
//   * a request is paid out once every shift it covers that is still its crew
//     member's has its day paid (a cancellation with nothing to pay counts as
//     settled), and at least one was paid
//   * anything still waiting (an answer, a confirm, an unpaid day) keeps it
//   * a flat-rate position is paid when the project's end date is
//   * a shift handed to someone else counts neither way
//   * a project is paid out once every ask on it is paid out or declined, and
//     at least one is paid out; a withdrawn ask counts neither way
//   Run:  node tests/test_crew_request_pay.js
"use strict";
require("./_load_domain.js").loadDomain();

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, g, e) { ok(n, JSON.stringify(g) === JSON.stringify(e), "got " + JSON.stringify(g) + " exp " + JSON.stringify(e)); }

const PAY = window.LTP_crewRequestPay, PROJECTS = window.LTP_paidOutProjects;
ok("LTP_crewRequestPay is exported", typeof PAY === "function");
ok("LTP_paidOutProjects is exported", typeof PROJECTS === "function");

// A cancellation's frozen share (components/domain-crew.js::LTP_cancelWork).
const SHARE = { state: "cancelled", pay: { total: 120 } };
function pos(id, crewId, status, extra) { return Object.assign({ id: id, crewId: crewId, status: status }, extra || {}); }
function project(id, schedule, fixed, endDate) {
  return { id: id, name: "P" + id, startDate: "2026-09-10", endDate: endDate === undefined ? "2026-09-12" : endDate,
    schedule: schedule, fixedPositions: fixed || [] };
}
// A row as GET /api/crew-requests returns it.
function req(id, projectId, contactId, positionIds, status, paidDates, extra) {
  return Object.assign({ id: id, projectId: projectId, contactId: contactId, positionIds: positionIds,
    status: status, paidDates: paidDates || [] }, extra || {});
}

// Jane (5) on both days of a gala, Sam (6) on the second.
const GALA = project(1, [
  { id: "d1", date: "2026-09-10", positions: [pos("a", 5, "confirmed")] },
  { id: "d2", date: "2026-09-11", positions: [pos("b", 5, "confirmed"), pos("c", 6, "confirmed")] },
]);
const BOTH = ["2026-09-10", "2026-09-11"];

// ── One request ─────────────────────────────────────────────────────────────
eq("R1 every day paid → paid out", PAY(req(1, 1, 5, ["a", "b"], "accepted", BOTH), GALA), { paidOut: true, paid: { a: true, b: true } });
eq("R2 one day of two paid → not yet, and says which", PAY(req(1, 1, 5, ["a", "b"], "accepted", ["2026-09-10"]), GALA), { paidOut: false, paid: { a: true } });
eq("R3 nothing paid", PAY(req(1, 1, 5, ["a", "b"], "accepted", []), GALA), { paidOut: false, paid: {} });
eq("R4 a paid day the shift isn't on doesn't pay it", PAY(req(2, 1, 6, ["c"], "accepted", ["2026-09-10"]), GALA).paidOut, false);
eq("R5 a direct book pays out like any accepted ask", PAY(req(3, 1, 5, ["a", "b"], "accepted", BOTH, { silent: true }), GALA).paidOut, true);

const ASK = project(2, [{ id: "d", date: "2026-09-10", positions: [pos("p", 5, "requested")] }]);
eq("R6 an unanswered ask is never paid out", PAY(req(4, 2, 5, ["p"], "pending", ["2026-09-10"]), ASK), { paidOut: false, paid: {} });
// A decline is only ever cleared with its project (LTP_paidOutProjects), even
// when the shift was re-asked, accepted and paid through a later request.
eq("R7 a declined ask is never paid out on its own", PAY(req(5, 1, 5, ["a"], "declined", ["2026-09-10"]), GALA), { paidOut: false, paid: { a: true } });

const HALF = project(3, [{ id: "d", date: "2026-09-10", positions: [pos("x", 5, "confirmed"), pos("y", 5, "accepted")] }]);
eq("R8 a position still to confirm keeps it open", PAY(req(6, 3, 5, ["x", "y"], "accepted", ["2026-09-10"]), HALF), { paidOut: false, paid: { x: true } });

// ── Flat-rate positions: billed on the project's end date ─────────────────
const FLAT = project(4, [], [pos("f", 5, "confirmed", { fee: 1500 })], "2026-09-14");
eq("R9 a flat-rate position is paid when the end date is", PAY(req(7, 4, 5, ["f"], "accepted", ["2026-09-14"]), FLAT), { paidOut: true, paid: { f: true } });
eq("R10 …not by another day", PAY(req(7, 4, 5, ["f"], "accepted", ["2026-09-10"]), FLAT).paidOut, false);
eq("R11 …nor with no end date to bill on", PAY(req(7, 4, 5, ["f"], "accepted", ["2026-09-14"]), project(4, [], FLAT.fixedPositions, "")).paidOut, false);
const MIXED = project(5, [{ id: "d", date: "2026-09-10", positions: [pos("m", 5, "confirmed")] }], [pos("g", 5, "confirmed")], "2026-09-12");
eq("R12 shifts and a flat rate: every one of them", PAY(req(8, 5, 5, ["m", "g"], "accepted", ["2026-09-10"]), MIXED), { paidOut: false, paid: { m: true } });
eq("R13 …then paid out", PAY(req(8, 5, 5, ["m", "g"], "accepted", ["2026-09-10", "2026-09-12"]), MIXED).paidOut, true);

// ── Cancellations ───────────────────────────────────────────────────────────
const CXL = project(6, [
  { id: "d1", date: "2026-09-10", positions: [pos("k1", 5, "cancelled", { work: SHARE })] },
  { id: "d2", date: "2026-09-11", positions: [pos("k2", 5, "confirmed")] },
]);
eq("R14 a cancellation's share is payout work, paid with its day", PAY(req(9, 6, 5, ["k1", "k2"], "accepted", BOTH), CXL), { paidOut: true, paid: { k1: true, k2: true } });
eq("R15 …and holds the request open until it is", PAY(req(9, 6, 5, ["k1", "k2"], "accepted", ["2026-09-11"]), CXL).paidOut, false);
const NOPAY = project(7, [
  { id: "d1", date: "2026-09-10", positions: [pos("n1", 5, "cancelled")] },
  { id: "d2", date: "2026-09-11", positions: [pos("n2", 5, "confirmed")] },
]);
eq("R16 a cancellation that pays nothing is settled", PAY(req(10, 7, 5, ["n1", "n2"], "accepted", ["2026-09-11"]), NOPAY), { paidOut: true, paid: { n2: true } });
eq("R17 …but with nothing paid at all it is not paid out", PAY(req(10, 7, 5, ["n1"], "accepted", ["2026-09-10"]), NOPAY).paidOut, false);

// ── Whose shift it is ───────────────────────────────────────────────────────
const MOVED = project(8, [
  { id: "d1", date: "2026-09-10", positions: [pos("h1", 5, "confirmed")] },
  { id: "d2", date: "2026-09-11", positions: [pos("h2", 9, "confirmed")] },   // handed to Alex
]);
eq("R18 a shift handed to someone else counts neither way", PAY(req(11, 8, 5, ["h1", "h2"], "accepted", ["2026-09-10"]), MOVED), { paidOut: true, paid: { h1: true } });
const STR = project(9, [{ id: "d", date: "2026-09-10", positions: [pos("s", "5", "confirmed")] }]);
eq("R19 a crew id held as a string still matches", PAY(req(12, 9, 5, ["s"], "accepted", ["2026-09-10"]), STR).paidOut, true);
eq("R20 no live positions → not paid out", PAY(req(13, 1, 5, ["gone"], "accepted", ["2026-09-10"]), GALA).paidOut, false);
eq("R21 without the project nothing reads paid", PAY(req(14, 99, 5, ["a"], "accepted", ["2026-09-10"]), undefined), { paidOut: false, paid: {} });
eq("R22 no paidDates on the row → nothing paid", PAY({ id: 15, projectId: 1, contactId: 5, positionIds: ["a"], status: "accepted" }, GALA).paidOut, false);

// ── Projects ────────────────────────────────────────────────────────────────
const ALL = [GALA, ASK, HALF, FLAT, MIXED, CXL, NOPAY, MOVED, STR];
const janeGala = req(1, 1, 5, ["a", "b"], "accepted", BOTH);
eq("J1 every ask paid out → the project is", PROJECTS([janeGala, req(2, 1, 6, ["c"], "accepted", ["2026-09-11"])], ALL), { 1: true });
eq("J2 a decline goes with it", PROJECTS([janeGala, req(3, 1, 7, ["c"], "declined")], ALL), { 1: true });
eq("J3 an unanswered ask keeps the project", PROJECTS([janeGala, req(4, 1, 7, ["c"], "pending")], ALL), {});
eq("J4 an ask still to confirm keeps it", PROJECTS([req(6, 3, 5, ["x", "y"], "accepted", ["2026-09-10"])], ALL), {});
eq("J5 a confirmed day not yet paid keeps it", PROJECTS([janeGala, req(2, 1, 6, ["c"], "accepted", [])], ALL), {});
eq("J6 nothing but declines is not paid out", PROJECTS([req(3, 1, 7, ["c"], "declined")], ALL), {});
eq("J7 a withdrawn ask counts neither way", PROJECTS([janeGala, req(5, 1, 7, ["c"], "withdrawn")], ALL), { 1: true });
eq("J8 projects are read one at a time; one we don't hold never is", PROJECTS([
  janeGala,
  req(7, 4, 5, ["f"], "accepted", []),
  req(16, 99, 5, ["zz"], "accepted", ["2026-09-10"]),
], ALL), { 1: true });
eq("J9 no requests, no paid-out projects", PROJECTS([], ALL), {});

console.log("crew-request pay suite — PASS: " + pass + "   FAIL: " + fail);
if (fail) { fails.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
