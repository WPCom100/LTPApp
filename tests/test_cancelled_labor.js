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

// ── Bookings: a person's shifts that day, cancelled as one ───────────────────
// A load-in and a show bill as ONE person-day, so the booking's reference is
// that day priced together — not two day rates — split across the positions.
{
  const B = window.LTP_bookingCancelReference, CB = window.LTP_cancelBooking, BC = window.LTP_bookingCancellation;
  const SB = window.LTP_setBookingCancellationShares, RB = window.LTP_restoreBooking;
  const sched = [
    shift("a", "2026-08-10", [P("a1", 1)], { time: "06:00", endTime: "12:00", breaks: [] }),
    shift("b", "2026-08-10", [P("b1", 1), P("b2", 2, { crewId: 6 })], { time: "12:00", endTime: "20:00", breaks: [{ startTime: "15:00", endTime: "15:30", type: "unpaid" }] }),
  ];
  const alone = [REF(sched[0], sched[0].positions[0], SVCS, {}), REF(sched[1], sched[1].positions[0], SVCS, {})];
  const both = B(sched, ["a1", "b1"], SVCS, {});
  const day = window.LTP_calcDayLabor([{ time: "06:00", endTime: "12:00", breaks: [], positions: [sched[0].positions[0]] },
                                       { time: "12:00", endTime: "20:00", breaks: sched[1].breaks, positions: [sched[1].positions[0]] }], SVCS, {}).units[0];
  eq("K0 the booking is priced as one person-day, not two", [both.bill, both.pay], [day.rateTotal, day.costTotal]);
  ok("K1 which is less than the two shifts priced alone", both.bill < alone[0].bill + alone[1].bill, both.bill + " vs " + (alone[0].bill + alone[1].bill));
  eq("K2 the parts add up exactly", [Math.round(both.parts.reduce((t, p) => t + p.bill, 0) * 100) / 100, Math.round(both.parts.reduce((t, p) => t + p.pay, 0) * 100) / 100], [both.bill, both.pay]);
  eq("K3 the other person on the shift is not in it", both.parts.map((p) => p.id), ["a1", "b1"]);
  eq("K4 a lone position matches LTP_cancelReference", (function() { const r = B(sched, ["b2"], SVCS, {}); return [r.bill, r.pay]; })(),
     (function() { const r = REF(sched[1], sched[1].positions[1], SVCS, {}); return [r.bill, r.pay]; })());
  eq("K5 nothing to price", B(sched, ["zz"], SVCS, {}), { bill: 0, pay: 0, parts: [] });

  const half = CB(sched, ["a1", "b1"], HALF, SVCS, {}, META);
  const ca = half[0].positions[0], cb = half[1].positions[0];
  eq("K6 both positions cancelled, the other person untouched", [ca.status, cb.status, half[1].positions[1].status], ["cancelled", "cancelled", "confirmed"]);
  eq("K7 each carries its part of the reference", [ca.cancel.ref, cb.cancel.ref], both.parts.map((p) => ({ bill: p.bill, pay: p.pay })));
  eq("K8 a percentage applies to each part", [ca.cancel.bill.value, cb.cancel.bill.value, ca.cancel.pay.mode], [50, 50, "percent"]);
  ok("K9 together they charge half the day, to the cent",
     Math.abs(ca.cancel.bill.total + cb.cancel.bill.total - both.bill / 2) <= 0.011, (ca.cancel.bill.total + cb.cancel.bill.total) + " vs " + both.bill / 2);
  eq("K10 frozen pay matches each record", [ca.work.pay.total, cb.work.pay.total], [ca.cancel.pay.total, cb.cancel.pay.total]);
  const amt = CB(sched, ["a1", "b1"], { bill: { mode: "amount", value: 333.33 }, pay: { mode: "amount", value: 100 } }, SVCS, {}, META);
  const aa = amt[0].positions[0].cancel, ab = amt[1].positions[0].cancel;
  eq("K11 an amount is split to the cent and adds up exactly",
     [Math.round((aa.bill.total + ab.bill.total) * 100) / 100, Math.round((aa.pay.total + ab.pay.total) * 100) / 100], [333.33, 100]);
  eq("K12 split in proportion to the parts", Math.round(aa.bill.total / ab.bill.total * 100) / 100,
     Math.round(both.parts[0].bill / both.parts[1].bill * 100) / 100);
  ok("K13 no part pays more than its own reference", aa.pay.total <= aa.ref.pay + 0.005 && ab.pay.total <= ab.ref.pay + 0.005);
  ok("K14 already-cancelled positions are left alone", CB(half, ["a1", "b1"], HALF, SVCS, {}, META) === half);

  const info = BC(half, ["a1", "b1"]);
  eq("K15 the booking reads back as one", [info.bill, info.pay, info.shares.bill, info.shares.pay, info.reason],
     [both.bill, both.pay, { mode: "percent", value: 50 }, { mode: "percent", value: 50 }, "Client moved the load-in"]);
  const infoAmt = BC(amt, ["a1", "b1"]);
  eq("K16 an amount booking reads back as its total", [infoAmt.shares.bill, infoAmt.billTotal], [{ mode: "amount", value: 333.33 }, 333.33]);
  eq("K17 nothing cancelled → null", BC(sched, ["a1"]), null);
  const re = SB(half, ["a1", "b1"], { bill: { mode: "percent", value: 100 }, pay: { mode: "amount", value: 90 } }, { at: "later", by: "Sam" });
  eq("K18 re-sharing keeps the references", [re[0].positions[0].cancel.ref, re[1].positions[0].cancel.ref], [ca.cancel.ref, cb.cancel.ref]);
  eq("K19 and moves the totals", [Math.round((re[0].positions[0].cancel.bill.total + re[1].positions[0].cancel.bill.total) * 100) / 100,
                                   Math.round((re[0].positions[0].cancel.pay.total + re[1].positions[0].cancel.pay.total) * 100) / 100], [both.bill, 90]);
  ok("K20 re-sharing a live booking is a no-op", SB(sched, ["a1"], HALF, META) === sched);
  const back = RB(half, ["a1", "b1"], SVCS, {}, "t9");
  eq("K21 restore brings the whole booking back", [back[0].positions[0].status, back[1].positions[0].status, "cancel" in back[1].positions[0]],
     ["confirmed", "confirmed", false]);
  ok("K22 with the day's pay re-locked", !!(back[0].positions[0].pay && back[0].positions[0].pay.lockedAt === "t9"));
}

// ── Refill the role ──────────────────────────────────────────────────────────
{
  let k = 0; const g = (p) => p + "-n" + (++k);
  const sched = [shift("a", "2026-08-10", [P("a1", 1, { status: "cancelled" }), P("a2", 1, { crewId: 6 })])];
  const r = window.LTP_refillPosition(sched, "a", "a1", g);
  const fresh = r.schedule[0].positions[2];
  eq("RF0 a new open position for the same role", [r.positionId, fresh.id, fresh.serviceId, fresh.status, fresh.crewId, fresh.fullMargin], ["pos-n1", "pos-n1", 1, "open", null, false]);
  eq("RF1 on the next free person-slot", fresh.slot, 3);
  eq("RF2 the cancelled one is untouched", r.schedule[0].positions[0], sched[0].positions[0]);
  eq("RF3 unknown position → nothing", window.LTP_refillPosition(sched, "a", "zz", g), { schedule: sched, positionId: null });
  const fx = window.LTP_refillFixedPosition([{ id: "f1", serviceId: 2, role: "LX", crewId: 5, status: "cancelled", fee: 500, bill: 800, fullMargin: true, note: "Rig", cancel: {} }], "f1", g);
  eq("RF4 a flat-rate refill keeps the terms, drops the person", fx.fixedPositions[1],
     { id: "pos-n2", serviceId: 2, role: "LX", crewId: null, status: "open", fee: 500, bill: 800, fullMargin: false, note: "Rig" });
}

// ── The notify tray, conflicts, and a cancel-only day's adjustments ─────────
{
  const before = [shift("a", "2026-08-10", [P("a1", 1), P("a2", 2, { crewId: 6, status: "accepted" })])];
  const paid = window.LTP_cancelPosition(before, "a", "a1", HALF, SVCS, {}, META);
  const noPay = window.LTP_cancelPosition(paid, "a", "a2", { bill: { mode: "percent", value: 50 }, pay: { mode: "none", value: 0 } }, SVCS, {}, META);
  const contacts = [{ id: 5, firstName: "Jane", lastName: "Doe" }, { id: 6, firstName: "Bob", lastName: "Ray" }];
  const notes = window.LTP_diffRemovedCrew(before, noPay, contacts, SVCS);
  const byCrew = {}; notes.forEach((n) => { byCrew[n.crewId] = n; });
  eq("N0 a paid cancellation gets its own notice, the share on its shift", [byCrew[5].template, byCrew[5].shifts.length, byCrew[5].shifts[0].cancellationPay], ["crewCancelledWithPay", 1, 150]);
  eq("N1 an unpaid one reads like any removal from its status", [byCrew[6].template, "cancellationPay" in byCrew[6].shifts[0]], ["crewNotSelected", false]);
  eq("N2 an unchanged schedule notices nothing", window.LTP_diffRemovedCrew(noPay, noPay, contacts, SVCS), []);
  const projs = [{ id: 1, name: "A", schedule: noPay }, { id: 2, name: "B", schedule: [shift("x", "2026-08-10", [P("x1", 1)])] }];
  eq("N3 a cancelled call takes nobody's day", Object.keys(window.LTP_detectCrewConflicts(projs)), []);

  // Adjustments on a day of nothing but a cancellation ride on it — and the
  // getter reads exactly what the payout rollup reads.
  const ADJ = [{ id: "j1", amount: 25, label: "parking" }];
  const withAdj = window.LTP_setPayAdjustments(paid, 5, "2026-08-10", ADJ);
  eq("N4 a cancel-only day keeps its adjustments", window.LTP_getPayAdjustments(withAdj, 5, "2026-08-10"), ADJ);
  const row = window.LTP_payoutRows([{ id: 1, name: "A", schedule: withAdj }], contacts, SVCS, "2026-08-01", "2026-08-31")
    .groups.find((gr) => gr.crewId === 5).rows[0];
  eq("N5 and the payout counts them", [row.adjTotal, row.payable], [25, 175]);
  // A confirmed shift joins the day: its list is the day's, and the cancelled
  // one's is cleared so it can never come back.
  const joined = withAdj.concat([shift("c", "2026-08-10", [P("c1", 2)], { time: "17:00", endTime: "19:00", breaks: [] })]);
  const moved = window.LTP_setPayAdjustments(joined, 5, "2026-08-10", [{ id: "j2", amount: 10, label: "gas" }]);
  eq("N6 the confirmed shift holds the list now", [moved[1].positions[0].adj, moved[0].positions[0].adj], [[{ id: "j2", amount: 10, label: "gas" }], undefined]);
  eq("N7 clearing it leaves nothing behind", window.LTP_getPayAdjustments(window.LTP_setPayAdjustments(moved, 5, "2026-08-10", []), 5, "2026-08-10"), []);
}

// ── A flat-rate cancellation is noticed the same way ────────────────────────
{
  const before = [{ id: "f1", serviceId: 2, role: "LX", crewId: 5, status: "confirmed", fee: 400, bill: 700 },
                  { id: "f2", serviceId: 2, role: "LX", crewId: 6, status: "confirmed", fee: 400, bill: 700 }];
  const one = CANCEL_FIXED(before, "f1", HALF, META);
  const both = CANCEL_FIXED(one, "f2", { bill: { mode: "percent", value: 50 }, pay: { mode: "none", value: 0 } }, META);
  const contacts = [{ id: 5, firstName: "Jane", lastName: "Doe" }, { id: 6, firstName: "Bob", lastName: "Ray" }];
  const byCrew = {}; window.LTP_diffRemovedFixed(before, both, contacts, SVCS).forEach((n) => { byCrew[n.crewId] = n; });
  eq("NF0 a paid flat cancellation → the pay notice, share on the card", [byCrew[5].template, byCrew[5].shifts[0].flat, byCrew[5].shifts[0].cancellationPay], ["crewCancelledWithPay", true, 200]);
  eq("NF1 an unpaid one → the confirmed-removal notice", [byCrew[6].template, "cancellationPay" in byCrew[6].shifts[0]], ["crewCancelled", false]);
  eq("NF2 still held and not cancelled → nothing", window.LTP_diffRemovedFixed(before, before, contacts, SVCS), []);
}

// ── Only someone committed to the call is paid ──────────────────────────────
{
  const asked = shift("q", "2026-08-10", [P("q1", 1, { status: "requested" })]);
  eq("C0 an unanswered request's reference pays nothing", REF(asked, asked.positions[0], SVCS, {}), { bill: 600, pay: 0 });
  const c = CANCEL([asked], "q", "q1", HALF, SVCS, {}, META)[0].positions[0];
  eq("C1 cancelled: charged, not paid, no frozen pay, still named", [c.cancel.bill.total, c.cancel.pay.mode, c.cancel.pay.total, "work" in c, c.crewId], [300, "none", 0, false, 5]);
  const acc = shift("a", "2026-08-10", [P("a1", 1, { status: "accepted" })]);
  eq("C2 an acceptance is a commitment", CANCEL([acc], "a", "a1", HALF, SVCS, {}, META)[0].positions[0].cancel.pay.total, 150);
  const open = shift("o", "2026-08-10", [P("o1", 1, { status: "open" }), P("o2", 2, { status: "declined", crewId: 6 })]);
  const oc = window.LTP_cancelBooking([open], ["o1", "o2"], HALF, SVCS, {}, META)[0].positions;
  eq("C3 a pencilled-in or declined slot is charged only", oc.map((p) => [p.cancel.bill.total, p.cancel.pay.total, "work" in p]), [[300, 0, false], [250, 0, false]]);
  const mixed = [shift("m", "2026-08-10", [P("m1", 1), P("m2", 2, { crewId: 6, status: "requested" })])];
  const ref = window.LTP_bookingCancelReference(mixed, ["m1", "m2"], SVCS, {});
  eq("C4 a booking's pay side counts only the committed", [ref.bill, ref.pay, ref.parts.map((pt) => pt.pay)], [1100, 300, [300, 0]]);
  const bk = window.LTP_projectBooking({ id: 1, schedule: mixed }, ["m2"], SVCS, {});
  eq("C5 the dialog shows no pay side for it", [bk.paysCrew, bk.ref.pay], [false, 0]);
  const fx = CANCEL_FIXED([{ id: "f1", serviceId: 2, crewId: 5, status: "requested", fee: 400, bill: 700 }], "f1", HALF, META)[0];
  eq("C6 flat-rate too", [fx.cancel.ref.pay, fx.cancel.pay.total, "work" in fx], [0, 0, false]);
  const before = [asked];
  const notes = window.LTP_diffRemovedCrew(before, CANCEL(before, "q", "q1", HALF, SVCS, {}, META), [{ id: 5, firstName: "Jane", lastName: "Doe" }], SVCS);
  eq("C7 and the person hears the request is withdrawn", notes.map((n) => n.template), ["crewWithdrawn"]);
}

// ── The activity wording ────────────────────────────────────────────────────
{
  const was = P("p1", 1);
  const cx = CANCEL([shift("d", "2026-08-10", [was])], "d", "p1", HALF, SVCS, {}, META)[0].positions[0];
  eq("AC0 the detail names who and both shares", window.LTP_cancelActivityDetail("Jane Doe", cx.cancel), "Jane Doe · bill 50% $300.00 · pay 50% $150.00");
  eq("AC1 an amount reads as the amount; nobody booked has no pay side",
     window.LTP_cancelActivityDetail("", { bill: { mode: "amount", value: 120, total: 120 }, pay: { mode: "none", value: 0, total: 0 } }), "Unassigned · bill $120.00");
  eq("AC2 cancelled", window.LTP_cancelChange(was, cx, "Jane Doe").what, "Cancelled");
  const edited = SETSHARES([shift("d", "2026-08-10", [cx])], "d", "p1", { bill: { mode: "percent", value: 100 }, pay: { mode: "none", value: 0 } }, META)[0].positions[0];
  eq("AC3 re-shared", window.LTP_cancelChange(cx, edited, "Jane Doe"), { what: "Cancellation Edited", detail: "Jane Doe · bill 100% $600.00 · pay none" });
  eq("AC4 restored", window.LTP_cancelChange(cx, Object.assign({}, was), "Jane Doe"), { what: "Restored", detail: "Jane Doe · back to confirmed" });
  eq("AC5 nothing about it changed", window.LTP_cancelChange(cx, cx, "Jane Doe"), null);
}

// ── A booking on a project row (the Labor tab) ──────────────────────────────
{
  let k = 0; const g = (p) => p + "-w" + (++k);
  const LOAD = { time: "08:00", endTime: "12:00", breaks: [] }, SHOW = { time: "13:00", endTime: "17:00", breaks: [] };
  const proj = { id: 7, name: "Gala",
    schedule: [shift("l", "2026-08-10", [P("l1", 1), P("l2", 2, { crewId: 6 })], LOAD), shift("s", "2026-08-10", [P("s1", 1)], SHOW)],
    fixedPositions: [{ id: "f1", serviceId: 2, role: "LX", crewId: 8, status: "confirmed", fee: 400, bill: 700 }] };
  const bk = window.LTP_projectBooking(proj, ["l1", "s1"], SVCS, {});
  eq("PB0 two shifts price as one person-day", [bk.flat, bk.ids, bk.crewId, bk.status, bk.date, bk.cancelled, bk.ref], [false, ["l1", "s1"], 5, "confirmed", "2026-08-10", false, { bill: 600, pay: 300 }]);
  const w = window.LTP_projectBookingWrite(proj, bk, "cancel", HALF, SVCS, {}, META, g);
  const pos = (pr, id) => { let hit = null; pr.schedule.forEach((s) => s.positions.forEach((p) => { if (p.id === id) hit = p; })); return hit; };
  eq("PB1 both cancelled, the share split across them", [pos(w.project, "l1").cancel.bill.total, pos(w.project, "s1").cancel.bill.total, pos(w.project, "l2").status], [150, 150, "confirmed"]);
  ok("PB2 the fixed list is untouched", w.project.fixedPositions === proj.fixedPositions);
  const again = window.LTP_projectBooking(w.project, ["l1", "s1"], SVCS, {});
  eq("PB3 read back as cancelled, against the same reference", [again.cancelled, again.ref, again.shares, again.billTotal, again.payTotal, again.reason],
     [true, { bill: 600, pay: 300 }, HALF, 300, 150, "Client moved the load-in"]);
  const edited = window.LTP_projectBookingWrite(w.project, again, "edit", { bill: { mode: "amount", value: 450 }, pay: { mode: "percent", value: 100 } }, SVCS, {}, META, g);
  eq("PB4 an edit re-shares within the reference", [pos(edited.project, "l1").cancel.bill.total + pos(edited.project, "s1").cancel.bill.total, pos(edited.project, "s1").cancel.pay.total], [450, 150]);
  const back = window.LTP_projectBookingWrite(edited.project, again, "restore", null, SVCS, {}, { at: "t9" }, g);
  eq("PB5 restore brings the whole booking back", [pos(back.project, "l1").status, pos(back.project, "s1").status, "cancel" in pos(back.project, "s1")], ["confirmed", "confirmed", false]);
  const re = window.LTP_projectBookingWrite(w.project, again, "refill", null, SVCS, {}, META, g);
  eq("PB6 refill opens one slot per cancelled shift", [re.positionIds.length, pos(re.project, re.positionIds[0]).status, pos(re.project, re.positionIds[1]).serviceId], [2, "open", 1]);
  eq("PB7 a booking that is not on the row → null", window.LTP_projectBooking(proj, ["zz"], SVCS, {}), null);
  eq("PB8 nothing to do → the same row", window.LTP_projectBookingWrite(proj, bk, "edit", HALF, SVCS, {}, META, g).project === proj, true);

  const fb = window.LTP_projectBooking(proj, ["f1"], SVCS, {});
  eq("PB9 a flat-rate position's reference is its bill and fee", [fb.flat, fb.ids, fb.crewId, fb.cancelled, fb.ref], [true, ["f1"], 8, false, { bill: 700, pay: 400 }]);
  const fw = window.LTP_projectBookingWrite(proj, fb, "cancel", HALF, SVCS, {}, META, g);
  eq("PB10 cancelled on the fixed list, schedule untouched", [fw.project.fixedPositions[0].status, fw.project.fixedPositions[0].cancel.pay.total, fw.project.schedule === proj.schedule], ["cancelled", 200, true]);
  const snaps = window.LTP_cancelSnapshots(w.project, ["l1", "s1"], SVCS);
  eq("PB11 the notice carries each shift's share", snaps.map((sn) => [sn.positionId, sn.cancellationPay]), [["l1", 75], ["s1", 75]]);
  eq("PB12 a flat notice too", window.LTP_cancelSnapshots(fw.project, ["f1"], SVCS).map((sn) => [sn.flat, sn.cancellationPay]), [[true, 200]]);
}

console.log("cancelled-labor suite — PASS: " + pass + "   FAIL: " + fail);
if (fail) { fails.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
