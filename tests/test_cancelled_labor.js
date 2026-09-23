#!/usr/bin/env node
// Cancelled labor — the position-level cancellation engine
// (components/domain-crew.js, "Cancellation" section):
//   * LTP_cancelReference      — this shift's own full rate / cost, from one engine
//   * LTP_cancelShare          — percent / amount / none
//   * LTP_cancelWork           — the frozen pay, in a sign-off's shape
//   * LTP_cancelPosition / LTP_setCancellationShares / LTP_restorePosition
//   * the flat-rate mirrors
//   * LTP_reassignPatch / LTP_SNAPSHOT_CLEAR — a slot changing hands takes no
//     snapshots with it (the next person used to inherit the last one's sign-off)
//   * LTP_cancelDefaults       — the dialog's 50 / 50 pre-fill from Settings
//
// WHY THIS SUITE EXISTS
//   Cancelling used to reset a position to open and remove the crew member,
//   leaving nothing to bill the client a share against and nothing to pay the
//   crew member from. The record and the frozen pay written here are what
//   payouts, vendor bills, the paid-day guard and the document generator read;
//   a wrong number here is silently wrong money in all of them. The reference
//   is fixed at cancel time: an edit only moves within it.
//
// Pure Node, zero deps.
//   Run:  node tests/test_cancelled_labor.js
"use strict";
const { loadDomain } = require("./_load_domain.js");
loadDomain();

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, got, want) { ok(n, JSON.stringify(got) === JSON.stringify(want), "got " + JSON.stringify(got) + " exp " + JSON.stringify(want)); }

const REF = window.LTP_cancelReference, SHARE = window.LTP_cancelShare, DEFAULTS = window.LTP_cancelDefaults;
const CANCEL = window.LTP_cancelPosition, SETSHARES = window.LTP_setCancellationShares, RESTORE = window.LTP_restorePosition;
const CANCEL_FIXED = window.LTP_cancelFixedPosition, SETSHARES_FIXED = window.LTP_setFixedCancellationShares, RESTORE_FIXED = window.LTP_restoreFixedPosition;
const PATCH = window.LTP_reassignPatch;
["LTP_cancelReference", "LTP_cancelShare", "LTP_cancelWork", "LTP_cancelDefaults", "LTP_cancelPosition", "LTP_setCancellationShares",
 "LTP_restorePosition", "LTP_cancelFixedPosition", "LTP_setFixedCancellationShares", "LTP_restoreFixedPosition", "LTP_reassignPatch"]
  .forEach((k) => ok(k + " is exported", typeof window[k] === "function"));

const SVCS = [
  { id: 1, role: "A1", description: "Audio Lead",    department: "Audio",    dayRate: 600, dayCost: 300 },
  { id: 2, role: "LX", description: "Lighting Tech", department: "Lighting", dayRate: 500, dayCost: 250 },
];
const MEAL = [{ startTime: "12:00", endTime: "12:30", type: "unpaid" }];
const shift = (id, date, positions, extra) => Object.assign({ id: id, date: date, time: "08:00", endTime: "16:00", breaks: MEAL, positions: positions }, extra || {});
const P = (id, serviceId, extra) => Object.assign({ id: id, serviceId: serviceId, role: "R", status: "confirmed", crewId: 5 }, extra || {});
const META = { at: "2026-09-23T12:00:00.000Z", by: "Jamie", byId: 4, reason: "Client moved the load-in" };
const HALF = { bill: { mode: "percent", value: 50 }, pay: { mode: "percent", value: 50 } };

// ── Reference: the shift's own full rate and cost ────────────────────────────
{
  const s = shift("d1", "2026-08-10", [P("p1", 1)]);
  eq("R0 full day: bill rate and pay cost", REF(s, s.positions[0], SVCS, {}), { bill: 600, pay: 300 });
  const half = shift("d2", "2026-08-10", [P("p1", 1)], { time: "09:00", endTime: "13:00", breaks: [] });
  eq("R1 half day", REF(half, half.positions[0], SVCS, {}), { bill: 300, pay: 150 });
  const ot = shift("d3", "2026-08-10", [P("p1", 1)], { time: "08:00", endTime: "22:00", breaks: MEAL.concat([{ startTime: "17:00", endTime: "17:30", type: "unpaid" }]) });
  eq("R2 overtime is in the reference", REF(ot, ot.positions[0], SVCS, {}), { bill: 870, pay: 435 });   // 600 + 3×90, 300 + 3×45
  eq("R3 full-margin pays nothing", REF(s, P("p1", 1, { fullMargin: true }), SVCS, {}), { bill: 600, pay: 0 });
  eq("R4 a crew floor raises the cost side only", REF(s, P("p1", 1), SVCS, { 5: 450 }), { bill: 600, pay: 450 });
  eq("R5 no times → nothing", REF(shift("d4", "2026-08-10", [P("p1", 1)], { time: "", endTime: "" }), P("p1", 1), SVCS, {}), { bill: 0, pay: 0 });
  eq("R6 unknown role → nothing", REF(s, P("p1", 99), SVCS, {}), { bill: 0, pay: 0 });
  eq("R7 null inputs", [REF(null, P("p1", 1), SVCS, {}), REF(s, null, SVCS, {})], [{ bill: 0, pay: 0 }, { bill: 0, pay: 0 }]);
  const svcs = window.LTP_servicesForClient(SVCS,
    [{ id: 1, clientType: "company", companyId: 7, serviceId: 1, dayRate: 550, dayCost: 275, active: true }],
    { clientType: "company", companyId: 7, clientContactId: null });
  eq("R8 the client's negotiated card applies", REF(s, s.positions[0], svcs, {}), { bill: 550, pay: 275 });
  // Only THIS position prices, whatever else shares the shift.
  const busy = shift("d5", "2026-08-10", [P("p1", 1), P("p2", 2, { crewId: 6 })]);
  eq("R9 the other positions on the shift do not price into it", REF(busy, busy.positions[0], SVCS, {}), { bill: 600, pay: 300 });
}

// ── Shares and defaults ──────────────────────────────────────────────────────
{
  eq("S0 percent", SHARE(600, "percent", 50), 300);
  eq("S1 percent rounds to the cent", SHARE(333.33, "percent", 50), 166.67);
  eq("S2 amount rounds to the cent", SHARE(600, "amount", 250.555), 250.56);
  eq("S3 none", SHARE(600, "none", 50), 0);
  eq("S4 never negative", [SHARE(600, "percent", -10), SHARE(600, "amount", -5), SHARE(-1, "percent", 50)], [0, 0, 0]);
  eq("S5 an amount may exceed the reference (the server caps a non-admin's pay share)", SHARE(600, "amount", 900), 900);
  eq("S6 unknown mode reads as percent", SHARE(600, undefined, 10), 60);
  eq("S7 defaults are 50 / 50", DEFAULTS({}), { bill: { mode: "percent", value: 50 }, pay: { mode: "percent", value: 50 } });
  eq("S8 settings override", DEFAULTS({ cancellationDefaultBillPct: 100, cancellationDefaultPayPct: "25" }),
     { bill: { mode: "percent", value: 100 }, pay: { mode: "percent", value: 25 } });
  eq("S9 junk settings fall back, a negative reads as 0", DEFAULTS({ cancellationDefaultBillPct: "abc", cancellationDefaultPayPct: -3 }),
     { bill: { mode: "percent", value: 50 }, pay: { mode: "percent", value: 0 } });
  eq("S10 null settings", DEFAULTS(null).bill.value, 50);
}

// ── Cancel a shift position ──────────────────────────────────────────────────
{
  const sched = [shift("d1", "2026-08-10", [P("p1", 1, { pay: { total: 300, lockedAt: "t0" } }), P("p2", 2, { crewId: 6 })]),
                 shift("d2", "2026-08-11", [P("p3", 1)])];
  const out = CANCEL(sched, "d1", "p1", HALF, SVCS, {}, META);
  const c = out[0].positions[0];
  eq("C0 status", c.status, "cancelled");
  eq("C1 the record", c.cancel, { at: META.at, by: "Jamie", byId: 4, reason: "Client moved the load-in",
     ref: { bill: 600, pay: 300 }, bill: { mode: "percent", value: 50, total: 300 }, pay: { mode: "percent", value: 50, total: 150 } });
  eq("C2 the frozen pay, in a sign-off's shape", c.work, { state: "cancelled", signedAt: META.at, signedBy: "Jamie",
     pay: { total: 150, paidHours: 0, otHours: 0, mealPenaltyHours: 0, tier: "cancel",
            units: [{ serviceId: 1, tier: "cancel", paidHours: 0, otHours: 0, dayCost: 150, otCost: 0, minApplied: false, minHoursApplied: false, fullMargin: false, total: 150 }] } });
  eq("C3 crew member and locked pay stay", [c.crewId, c.pay], [5, { total: 300, lockedAt: "t0" }]);
  ok("C4 the other position on the shift is untouched", out[0].positions[1] === sched[0].positions[1]);
  ok("C5 the other shift is untouched", out[1] === sched[1]);
  eq("C6 the input was not mutated", sched[0].positions[0].status, "confirmed");
  ok("C7 unknown position → same schedule", CANCEL(sched, "d1", "nope", HALF, SVCS, {}, META) === sched);
  ok("C7b unknown shift → same schedule", CANCEL(sched, "zz", "p1", HALF, SVCS, {}, META) === sched);
  const amt = CANCEL(sched, "d1", "p1", { bill: { mode: "amount", value: 200 }, pay: { mode: "none", value: 0 } }, SVCS, {}, META)[0].positions[0];
  eq("C8 amount on the bill side, none on the pay side", [amt.cancel.bill, amt.cancel.pay, amt.work.pay.total],
     [{ mode: "amount", value: 200, total: 200 }, { mode: "none", value: 0, total: 0 }, 0]);
  const nobody = CANCEL([shift("d1", "2026-08-10", [P("p1", 1, { crewId: null, status: "open" })])], "d1", "p1",
                        { bill: { mode: "percent", value: 100 }, pay: { mode: "percent", value: 100 } }, SVCS, {}, META)[0].positions[0];
  eq("C9 an unfilled position: charged, nothing to pay, no frozen pay", [nobody.status, nobody.cancel.bill.total, nobody.cancel.pay, "work" in nobody],
     ["cancelled", 600, { mode: "none", value: 0, total: 0 }, false]);
  const fm = CANCEL([shift("d1", "2026-08-10", [P("p1", 1, { fullMargin: true })])], "d1", "p1",
                    { bill: { mode: "percent", value: 50 }, pay: { mode: "amount", value: 999 } }, SVCS, {}, META)[0].positions[0];
  eq("C10 full-margin pays nothing whatever was asked", [fm.cancel.ref, fm.cancel.pay.total, fm.work.pay.total, fm.work.pay.units[0].fullMargin],
     [{ bill: 600, pay: 0 }, 0, 0, true]);
  const bare = CANCEL(sched, "d1", "p1", null, SVCS, {}, META)[0].positions[0];
  eq("C11 no shares → cancelled at 0 / 0", [bare.status, bare.cancel.bill.total, bare.cancel.pay.total, bare.work.pay.total], ["cancelled", 0, 0, 0]);
  const fromAccepted = CANCEL([shift("d1", "2026-08-10", [P("p1", 1, { status: "accepted" })])], "d1", "p1", HALF, SVCS, {}, META)[0].positions[0];
  eq("C12 cancels from any status", [fromAccepted.status, fromAccepted.work.pay.total], ["cancelled", 150]);
  const quiet = CANCEL(sched, "d1", "p1", HALF, SVCS, {}, {})[0].positions[0];
  eq("C13 missing meta is tolerated", [quiet.cancel.at, quiet.cancel.by, quiet.cancel.byId, quiet.cancel.reason, quiet.work.signedAt], ["", "", null, "", ""]);
}

// ── Edit the shares: the reference never moves ───────────────────────────────
{
  const sched = [shift("d1", "2026-08-10", [P("p1", 1)])];
  const first = CANCEL(sched, "d1", "p1", HALF, SVCS, {}, META);
  const CHEAP = SVCS.map((s) => s.id === 1 ? Object.assign({}, s, { dayRate: 100, dayCost: 50 }) : s);
  const again = CANCEL(first, "d1", "p1", { bill: { mode: "percent", value: 100 }, pay: { mode: "amount", value: 175 } }, CHEAP, {}, { at: "later", by: "Sam" });
  const c = again[0].positions[0];
  eq("E0 the reference is what it was at cancel time", c.cancel.ref, { bill: 600, pay: 300 });
  eq("E1 new shares from the fixed reference", [c.cancel.bill.total, c.cancel.pay.total, c.work.pay.total], [600, 175, 175]);
  eq("E2 original at/by kept, the edit recorded", [c.cancel.at, c.cancel.by, c.cancel.byId, c.cancel.updatedAt, c.cancel.updatedBy, c.cancel.reason],
     [META.at, "Jamie", 4, "later", "Sam", "Client moved the load-in"]);
  eq("E3 the frozen pay is re-signed at the edit", [c.work.signedAt, c.work.signedBy], ["later", "Sam"]);
  const viaSet = SETSHARES(first, "d1", "p1", { bill: { mode: "percent", value: 25 }, pay: { mode: "percent", value: 25 } }, { at: "l2", by: "Sam", reason: "agreed" });
  const v = viaSet[0].positions[0];
  eq("E4 LTP_setCancellationShares does the same, with a new reason", [v.cancel.bill.total, v.cancel.pay.total, v.work.pay.total, v.cancel.reason], [150, 75, 75, "agreed"]);
  ok("E5 setting shares on a live position is a no-op", SETSHARES(sched, "d1", "p1", HALF, META) === sched);
}

// ── Restore ──────────────────────────────────────────────────────────────────
{
  const sched = [shift("d1", "2026-08-10", [P("p1", 1, { adj: [{ id: "a", amount: 20, label: "parking" }] }), P("p2", 2, { crewId: 6 })])];
  const cancelled = CANCEL(sched, "d1", "p1", HALF, SVCS, {}, META);
  const back = RESTORE(cancelled, "d1", "p1", SVCS, {}, "t1");
  const r = back[0].positions[0];
  eq("T0 back to confirmed, record and frozen pay gone, crew kept", [r.status, "cancel" in r, "work" in r, r.crewId], ["confirmed", false, false, 5]);
  eq("T1 pay re-locked for the day at today's rates", r.pay, Object.assign({ lockedAt: "t1" }, window.LTP_crewDayPay(back, 5, SVCS, {})));
  eq("T2 adjustments survive a restore", r.adj, [{ id: "a", amount: 20, label: "parking" }]);
  ok("T3 the other person's position is untouched", back[0].positions[1] === sched[0].positions[1]);
  ok("T4 restoring a live position is a no-op", RESTORE(sched, "d1", "p1", SVCS, {}, "t1") === sched);
  const nobody = RESTORE(CANCEL([shift("d1", "2026-08-10", [P("p1", 1, { crewId: null, status: "open" })])], "d1", "p1", HALF, SVCS, {}, META),
                         "d1", "p1", SVCS, {}, "t1")[0].positions[0];
  eq("T5 an unfilled cancellation restores to open with no pay", [nobody.status, "pay" in nobody, "cancel" in nobody], ["open", false, false]);
}

// ── Flat-rate mirrors ────────────────────────────────────────────────────────
{
  const flats = [{ id: "f1", serviceId: 1, role: "A1", crewId: 5, status: "confirmed", fee: 1000, bill: 2000, fullMargin: false, pay: { total: 1000, lockedAt: "t0" } },
                 { id: "f2", serviceId: 2, role: "LX", crewId: 6, status: "confirmed", fee: 500, bill: 900, fullMargin: true }];
  const out = CANCEL_FIXED(flats, "f1", HALF, META);
  eq("F0 the flat reference is the typed amounts", out[0].cancel.ref, { bill: 2000, pay: 1000 });
  eq("F1 shares and frozen pay", [out[0].status, out[0].cancel.bill.total, out[0].cancel.pay.total, out[0].work.state, out[0].work.pay.total, out[0].work.pay.tier, out[0].work.pay.units[0].serviceId],
     ["cancelled", 1000, 500, "cancelled", 500, "cancel", 1]);
  eq("F2 locked fee stays", out[0].pay, { total: 1000, lockedAt: "t0" });
  ok("F3 the other flat position is untouched", out[1] === flats[1]);
  const fm = CANCEL_FIXED(flats, "f2", { bill: { mode: "percent", value: 100 }, pay: { mode: "percent", value: 100 } }, META)[1];
  eq("F4 full-margin flat: billed, paid nothing", [fm.cancel.ref, fm.cancel.bill.total, fm.cancel.pay.total, fm.work.pay.total], [{ bill: 900, pay: 0 }, 900, 0, 0]);
  const edited = SETSHARES_FIXED(out, "f1", { bill: { mode: "amount", value: 1500 }, pay: { mode: "amount", value: 250 } }, { at: "later", by: "Sam" });
  eq("F5 edited shares keep the fixed reference", [edited[0].cancel.ref, edited[0].cancel.bill.total, edited[0].work.pay.total, edited[0].cancel.updatedBy],
     [{ bill: 2000, pay: 1000 }, 1500, 250, "Sam"]);
  ok("F6 setting shares on a live flat position is a no-op", SETSHARES_FIXED(flats, "f1", HALF, META) === flats);
  const back = RESTORE_FIXED(out, "f1", "t1");
  eq("F7 restore re-locks the fee", [back[0].status, "cancel" in back[0], "work" in back[0], back[0].pay],
     ["confirmed", false, false, Object.assign({ lockedAt: "t1" }, window.LTP_fixedPositionPay(flats[0]))]);
  ok("F8 unknown id → same list", CANCEL_FIXED(flats, "zz", HALF, META) === flats);
  ok("F9 restoring a live flat position is a no-op", RESTORE_FIXED(flats, "f1", "t1") === flats);
}

// ── A slot changing hands takes no snapshots with it ─────────────────────────
{
  const pos = { id: "p1", serviceId: 1, crewId: 5, status: "confirmed", pay: { total: 300 }, work: { state: "worked" }, adj: [{ amount: 1 }], cancel: { at: "x" } };
  eq("Z0 the same person keeps status and snapshots", PATCH(pos, 5), { crewId: 5, status: "confirmed" });
  const p = PATCH(pos, 6);
  eq("Z1 a new person starts open", [p.crewId, p.status], [6, "open"]);
  ok("Z2 …with every snapshot cleared", "pay" in p && p.pay === undefined && p.work === undefined && p.adj === undefined && p.cancel === undefined);
  const merged = Object.assign({}, pos, p);
  eq("Z3 the merged position carries no snapshot values", [merged.pay, merged.work, merged.adj, merged.cancel], [undefined, undefined, undefined, undefined]);
  eq("Z4 and none survive JSON (what the save sends)", Object.keys(JSON.parse(JSON.stringify(merged))).sort(), ["crewId", "id", "serviceId", "status"]);
  const un = PATCH(pos, null);
  eq("Z5 unassigning clears too", [un.crewId, un.status, "work" in un], [null, "open", true]);
  eq("Z6 the clear constant names all four", Object.keys(window.LTP_SNAPSHOT_CLEAR).sort(), ["adj", "cancel", "pay", "work"]);
  eq("Z7 a null position is tolerated", PATCH(null, 6).status, "open");
}

console.log("cancelled-labor suite — PASS: " + pass + "   FAIL: " + fail);
if (fail) { fails.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
