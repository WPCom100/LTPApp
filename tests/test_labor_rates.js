#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Regression suite for the schedule labor-rate engine (theme.js).
//
// Pure Node, zero dependencies. Loads theme.js into a minimal `window` global
// (all its browser API use is inside function bodies or guarded by
// `typeof document`, so the file evaluates cleanly in Node) and asserts the
// behavior of the per-person rate / OT / meal-penalty / full-margin / slot /
// meal-fix logic across edge cases.
//
//   Run:  node tests/test_labor_rates.js      (exit 0 = pass, 1 = fail)
// ─────────────────────────────────────────────────────────────────────────────
"use strict";
const fs = require("fs");
const path = require("path");

// Load theme.js in a browser-less shim.
global.window = {};
let _seq = 0;
window.LTP_genId = (p) => (p || "x") + "-" + (++_seq);
const themePath = path.join(__dirname, "..", "theme.js");
(0, eval)(fs.readFileSync(themePath, "utf8"));

const D = window.LTP_calcLaborDay;      // (dayRate, items) -> single rate calc
const DAY = window.LTP_calcDayLabor;    // (items, services) -> per-person units
const ES = window.LTP_effectiveSlots;   // (positions) -> { posId: slot }
const FIX = window.LTP_mealFixBreaks;   // (shifts) -> individual breaks to add

for (const [name, fn] of Object.entries({ LTP_calcLaborDay: D, LTP_calcDayLabor: DAY, LTP_effectiveSlots: ES, LTP_mealFixBreaks: FIX })) {
  if (typeof fn !== "function") { console.error("theme.js did not export " + name); process.exit(1); }
}

// ── tiny assertion harness ───────────────────────────────────────────────────
let pass = 0, fail = 0; const fails = [];
function ok(name, cond, detail) { if (cond) pass++; else { fail++; fails.push(name + (detail ? "  [" + detail + "]" : "")); } }
function eq(name, got, exp) { ok(name, got === exp, "got " + JSON.stringify(got) + " exp " + JSON.stringify(exp)); }
function near(name, got, exp) { ok(name, Math.abs(got - exp) < 0.5, "got " + got + " exp " + exp); }

// dayRate 1000 -> half 500, otRate 150/h, otCost 120/h (dayCost 800)
const R = 1000;
const S = [{ id: 1, role: "L1", dayRate: 1000, dayCost: 800 }, { id: 2, role: "L2", dayRate: 600, dayCost: 400 }];
let _pp = 0;
function P(id, o) { o = o || {}; return { id: o.id || ("p" + (++_pp)), serviceId: id, slot: o.slot, fullMargin: o.fm, breaks: o.breaks }; }
const sh = (a, b, brk) => ({ time: a, endTime: b, breaks: brk || [] });
const day = (items) => DAY(items, S);

// ── A. Core engine: LTP_calcLaborDay ─────────────────────────────────────────
let r;
r = D(R, [sh("09:00", "14:00")]);                       eq("A1 half 5h paid", r.paidHours, 5); near("A1 half rate", r.rate, 500); eq("A1 half tier", r.tier, "Half day (5h)"); eq("A1 no meal", r.mealPenaltyHours, 0);
r = D(R, [sh("09:00", "15:00")]);                       eq("A2 6h paid", r.paidHours, 6); eq("A2 meal 1h", r.mealPenaltyHours, 1); near("A2 rate 650", r.rate, 650);
r = D(R, [sh("09:00", "20:00")]);                       eq("A3 11h paid", r.paidHours, 11); eq("A3 meal 6h", r.mealPenaltyHours, 6); near("A3 rate 1400", r.rate, 1400);
r = D(R, [sh("09:00", "20:00", [{ startTime: "13:00", endTime: "14:00", type: "unpaid" }])]); eq("A4 unpaid break -> 10h", r.paidHours, 10); eq("A4 meal 1h", r.mealPenaltyHours, 1); near("A4 rate 1150", r.rate, 1150);
r = D(R, [sh("08:00", "14:00"), sh("18:00", "24:00")]); eq("A5 gap 6+6 paid 12", r.paidHours, 12); eq("A5 meal 2h", r.mealPenaltyHours, 2); eq("A5 regOT 0", r.regularOTHours, 0); near("A5 rate 1300", r.rate, 1300);
r = D(R, [sh("08:00", "14:00"), sh("18:00", "22:00")]); eq("A6 gap 6+4 paid 10", r.paidHours, 10); eq("A6 meal 1h", r.mealPenaltyHours, 1); eq("A6 regOT 0", r.regularOTHours, 0);
r = D(R, [sh("08:00", "15:00", [{ startTime: "12:00", endTime: "13:00", type: "unpaid" }]), sh("18:00", "24:00", [{ startTime: "21:00", endTime: "22:00", type: "unpaid" }])]); eq("A7 >10 w/breaks paid 11", r.paidHours, 11); eq("A7 no meal", r.mealPenaltyHours, 0); eq("A7 regOT 1", r.regularOTHours, 1);
r = D(R, [sh("09:00", "14:00", [{ startTime: "11:30", endTime: "12:00", type: "paid" }])]); eq("A8 paid break stays paid 5", r.paidHours, 5); eq("A8 no meal", r.mealPenaltyHours, 0);
r = D(R, [sh("20:00", "04:00")]);                       eq("A9 overnight 8h", r.paidHours, 8); eq("A9 meal 3h", r.mealPenaltyHours, 3);
r = D(0, [sh("09:00", "14:00")]);                       eq("A10 zero rate", r.rate, 0); eq("A10 zero paid", r.paidHours, 0);
r = D(R, []);                                           eq("A11 empty items rate 0", r.rate, 0);
r = D(R, [sh("", "")]);                                 eq("A12 blank times rate 0", r.rate, 0);

// ── B. Per-person units: LTP_calcDayLabor ────────────────────────────────────
let d;
d = day([{ time: "09:00", endTime: "14:00", breaks: [], positions: [P(1)] }]);
eq("B1 one person units", d.units.length, 1); eq("B1 half", d.units[0].tier, "half"); near("B1 rate", d.units[0].rateTotal, 500); near("B1 cost", d.units[0].costTotal, 400);

d = day([{ time: "09:00", endTime: "13:00", breaks: [], positions: [P(1)] }, { time: "13:00", endTime: "15:00", breaks: [], positions: [P(1)] }]);
eq("B2 contiguous merge -> 1 unit", d.units.length, 1); eq("B2 paid 6", d.units[0].paidHours, 6); eq("B2 meal 1", d.units[0].mealPenaltyHours, 1);

d = day([{ time: "09:00", endTime: "14:00", breaks: [], positions: [P(1), P(1)] }]);
eq("B3 two same shift -> 2 units", d.units.length, 2); eq("B3 slots", d.units.map((u) => u.slot).join(","), "1,2"); near("B3 total rate", d.rateTotal, 1000);

d = day([{ time: "09:00", endTime: "15:00", breaks: [], positions: [P(1, { slot: 1 })] }, { time: "18:00", endTime: "24:00", breaks: [], positions: [P(1, { slot: 1 })] }]);
eq("B4 same slot diff shifts -> 1 unit", d.units.length, 1); eq("B4 paid 12", d.units[0].paidHours, 12); near("B4 rate 1300", d.rateTotal, 1300);

d = day([{ time: "09:00", endTime: "15:00", breaks: [], positions: [P(1, { slot: 1 })] }, { time: "18:00", endTime: "24:00", breaks: [], positions: [P(1, { slot: 2 })] }]);
eq("B5 diff slots -> 2 units", d.units.length, 2); near("B5 rate 2300", d.rateTotal, 2300);

d = day([{ time: "09:00", endTime: "14:00", breaks: [], positions: [P(1, { fm: true })] }]);
near("B6 margin rate billed", d.units[0].rateTotal, 500); eq("B6 margin cost 0", d.units[0].costTotal, 0); eq("B6 fullMargin flag", d.units[0].fullMargin, true);

d = day([{ time: "09:00", endTime: "14:00", breaks: [], positions: [P(1, { fm: true }), P(1)] }]);
near("B7 mixed margin rate 1000", d.rateTotal, 1000); near("B7 mixed margin cost 400", d.costTotal, 400);

d = day([{ time: "09:00", endTime: "15:00", breaks: [], positions: [P(1, { id: "indiv", breaks: [{ id: "b", startTime: "12:00", endTime: "13:00", type: "unpaid" }] }), P(1, { id: "noind" })] }]);
ok("B8 indiv-break person 5h no meal", !!d.units.find((u) => u.paidHours === 5 && u.mealPenaltyHours === 0));
ok("B8 other person 6h meal 1", !!d.units.find((u) => u.paidHours === 6 && u.mealPenaltyHours === 1));

d = day([{ time: "09:00", endTime: "15:00", breaks: [{ id: "c", startTime: "12:00", endTime: "13:00", type: "unpaid" }], positions: [P(1), P(1)] }]);
ok("B9 crew break both 5h no meal", d.units.every((u) => u.paidHours === 5 && u.mealPenaltyHours === 0));

d = day([{ time: "09:00", endTime: "14:00", breaks: [], positions: [P(1), { id: "x", serviceId: null }] }]);
eq("B10 null role ignored", d.units.length, 1);

// ── C. effectiveSlots ────────────────────────────────────────────────────────
let es = ES([P(1, { id: "a" }), P(1, { id: "b" })]);
eq("C1 implicit slots 1,2", es.a + "," + es.b, "1,2");
es = ES([P(1, { id: "a", slot: 2 }), P(1, { id: "b" })]);
eq("C2 explicit honored, implicit fills", es.a + "," + es.b, "2,1");

// ── D. Quote aggregation (replicates schedule-builder logic) ─────────────────
function quote(items) {
  const dr = {}, ot = {};
  day(items).units.forEach((u) => {
    const k = u.serviceId + "|" + u.tier;
    if (!dr[k]) dr[k] = { rate: u.dayRate, qty: 0, costAccum: 0 };
    dr[k].qty += 1; dr[k].costAccum += (u.fullMargin ? 0 : u.dayCost);
    if (u.otHours > 0) { if (!ot[u.serviceId]) ot[u.serviceId] = { otRate: u.otRate, rateHours: 0, costAccum: 0 }; ot[u.serviceId].rateHours += u.otHours; ot[u.serviceId].costAccum += (u.fullMargin ? 0 : u.otCost * u.otHours); }
  });
  let rate = 0, cost = 0;
  Object.values(dr).forEach((li) => { rate += li.qty * li.rate; cost += li.costAccum; });
  Object.values(ot).forEach((li) => { rate += li.rateHours * li.otRate; cost += li.costAccum; });
  return { rate, cost };
}
let q = quote([{ time: "09:00", endTime: "14:00", breaks: [], positions: [P(1, { fm: true }), P(1)] }]);
near("D1 quote rate 1000", q.rate, 1000); near("D1 quote cost 400", q.cost, 400);
const items2 = [{ time: "12:30", endTime: "16:00", breaks: [], positions: [P(1), P(2)] }, { time: "17:00", endTime: "23:30", breaks: [], positions: [P(1), P(2)] }];
const dd = day(items2), qq = quote(items2);
near("D2 quote rate == day rate", qq.rate, dd.rateTotal); near("D2 quote cost == day cost", qq.cost, dd.costTotal);

// ── E. Reconciliation: units sum to day totals ───────────────────────────────
near("E1 sum units rate == total", dd.units.reduce((t, u) => t + u.rateTotal, 0), dd.rateTotal);
near("E1 sum units cost == total", dd.units.reduce((t, u) => t + u.costTotal, 0), dd.costTotal);

// ── F. Meal fix: per person, idempotent, honors existing, multi-span ─────────
function applyFix(items) {
  const cleared = items.map((it) => Object.assign({}, it, { positions: it.positions.map((p) => (p.breaks && p.breaks.length) ? Object.assign({}, p, { breaks: [] }) : p) }));
  const byPos = {};
  DAY(cleared, S).units.forEach((u) => {
    if (!(u.mealPenaltyHours > 0)) return;
    const key = u.serviceId + "#" + u.slot, shifts = [];
    cleared.forEach((it) => { const sl = ES(it.positions); it.positions.forEach((p) => { if (!p.serviceId) return; if (p.serviceId + "#" + (sl[p.id] || 1) !== key) return; shifts.push({ time: it.time, endTime: it.endTime, breaks: it.breaks || [], positionId: p.id }); }); });
    FIX(shifts).forEach((g) => { (byPos[g.positionId] = byPos[g.positionId] || []).push({ id: g.id, startTime: g.startTime, endTime: g.endTime, type: g.type }); });
  });
  return items.map((it) => Object.assign({}, it, { positions: it.positions.map((p) => { const nb = byPos[p.id] || []; return ((p.breaks && p.breaks.length) || nb.length) ? Object.assign({}, p, { breaks: nb }) : p; }) }));
}
const fixItems = [
  { time: "12:30", endTime: "16:00", breaks: [], positions: [P(1, { id: "chris", slot: 1 }), P(2, { id: "pm-d", slot: 1, fm: true })] },
  { time: "17:00", endTime: "19:00", breaks: [], positions: [P(1, { id: "chris2", slot: 1 }), P(2, { id: "pm-p", slot: 1, fm: true })] },
  { time: "19:00", endTime: "23:30", breaks: [], positions: [P(2, { id: "pm-s", slot: 1, fm: true }), P(1, { id: "landry", slot: 2, fm: true })] },
];
const before = DAY(fixItems, S), fixed = applyFix(fixItems), after = DAY(fixed, S);
ok("F1 before: PM has penalty", before.units.some((u) => u.serviceId === 2 && u.mealPenaltyHours > 0));
ok("F1 after: no penalties left", after.units.every((u) => u.mealPenaltyHours === 0));
near("F1 L1#1 rate unchanged by fix", after.units.find((u) => u.serviceId === 1 && u.slot === 1).rateTotal, before.units.find((u) => u.serviceId === 1 && u.slot === 1).rateTotal);
const broken = fixed.flatMap((it) => it.positions).filter((p) => p.breaks && p.breaks.length).map((p) => p.id);
ok("F1 only PM positions broken", broken.length > 0 && broken.every((id) => id.startsWith("pm")), "broke " + broken.join(","));

const twice = applyFix(fixed);
ok("F2 idempotent no penalties", DAY(twice, S).units.every((u) => u.mealPenaltyHours === 0));
eq("F2 same break count after 2nd fix", twice.flatMap((it) => it.positions).filter((p) => p.breaks && p.breaks.length).length, fixed.flatMap((it) => it.positions).filter((p) => p.breaks && p.breaks.length).length);

const withCrew = [{ time: "09:00", endTime: "20:00", breaks: [{ id: "c", startTime: "13:00", endTime: "14:00", type: "unpaid" }], positions: [P(1, { id: "solo" })] }];
const genCrew = FIX([{ time: "09:00", endTime: "20:00", breaks: withCrew[0].breaks, positionId: "solo" }]);
eq("F3 adds 1 break given existing crew break", genCrew.length, 1);
ok("F3 added break after the existing one", genCrew[0].startTime >= "18:00", "at " + (genCrew[0] && genCrew[0].startTime));
eq("F3 fix clears penalty", DAY(applyFix(withCrew), S).units[0].mealPenaltyHours, 0);

const twoSpan = FIX([{ time: "08:00", endTime: "14:00", breaks: [], positionId: "a" }, { time: "18:00", endTime: "24:00", breaks: [], positionId: "b" }]);
eq("F4 one break per span", twoSpan.length, 2);
ok("F4 breaks mapped to each shift", twoSpan.some((b) => b.positionId === "a") && twoSpan.some((b) => b.positionId === "b"));

const longGen = FIX([{ time: "08:00", endTime: "22:00", breaks: [], positionId: "a" }]);
ok("F5 long shift needs >=2 breaks", longGen.length >= 2, "got " + longGen.length);
eq("F5 long shift fully cleared", D(R, [{ time: "08:00", endTime: "22:00", breaks: longGen.map((b) => ({ startTime: b.startTime, endTime: b.endTime, type: "unpaid" })) }]).mealPenaltyHours, 0);

// ── G. Backward-compat: legacy positions (no slot/margin/breaks) ─────────────
d = day([{ time: "09:00", endTime: "14:00", breaks: [], positions: [{ id: "z", serviceId: 1, role: "L1", crewId: null, status: "open" }] }]);
eq("G1 legacy position works", d.units.length, 1); near("G1 legacy rate", d.rateTotal, 500); eq("G1 legacy not margin", d.units[0].fullMargin, false);

// ── H. Per-crew negotiated minimum (payout floor) ────────────────────────────
// A position carrying a crewId whose id maps to a minDayCost gets its COST
// floored at that minimum (treated like a normal rate: half → min*0.5, OT →
// min/10*1.5). RATE (client billing) is never affected. Map is the optional 3rd
// arg to LTP_calcDayLabor; L1 = dayCost 800, L2 = dayCost 400.
function PC(sid, crewId, o) { o = o || {}; return { id: o.id || ("pc" + (++_pp)), serviceId: sid, slot: o.slot, fullMargin: o.fm, breaks: o.breaks, crewId: crewId }; }
const CID = 7;

// H1: half day, min 500 → cost floored to min*0.5 = 250; rate (300) untouched.
d = DAY([{ time: "09:00", endTime: "14:00", breaks: [], positions: [PC(2, CID)] }], S, { 7: 500 });
near("H1 half cost floored to min*0.5", d.units[0].costTotal, 250);
near("H1 half rate untouched", d.units[0].rateTotal, 300);
eq("H1 minApplied", d.units[0].minApplied, true);

// H2: full day (9h via a real gap, no meal/OT), min 500 → cost floored to 500; rate 600.
d = DAY([{ time: "09:00", endTime: "14:00", breaks: [], positions: [PC(2, CID)] }, { time: "18:00", endTime: "22:00", breaks: [], positions: [PC(2, CID)] }], S, { 7: 500 });
eq("H2 one unit across shifts", d.units.length, 1); eq("H2 full tier", d.units[0].tier, "full");
near("H2 full cost floored to min", d.units[0].costTotal, 500);
near("H2 rate untouched", d.units[0].rateTotal, 600);

// H3: min below the role's cost → no change (per-component floor never lowers).
d = DAY([{ time: "09:00", endTime: "14:00", breaks: [], positions: [PC(1, CID)] }], S, { 7: 500 });
near("H3 min below role cost unchanged", d.units[0].costTotal, 400);
eq("H3 minApplied false", d.units[0].minApplied, false);

// H4: OT scales with the minimum too (three gapped 4h segments = 12h, 2h reg OT).
d = DAY([{ time: "08:00", endTime: "12:00", breaks: [], positions: [PC(2, CID)] }, { time: "13:00", endTime: "17:00", breaks: [], positions: [PC(2, CID)] }, { time: "18:00", endTime: "22:00", breaks: [], positions: [PC(2, CID)] }], S, { 7: 500 });
eq("H4 otHours 2", d.units[0].otHours, 2);
near("H4 dayCost floored to min", d.units[0].dayCost, 500);
near("H4 otCost floored to min/10*1.5", d.units[0].otCost, 75);
near("H4 total cost = 500 + 2*75", d.units[0].costTotal, 650);

// H5: full-margin unit ignores the minimum (owner works their own gig at $0).
d = DAY([{ time: "09:00", endTime: "14:00", breaks: [], positions: [PC(2, CID, { fm: true })] }], S, { 7: 500 });
eq("H5 fullMargin cost 0 despite min", d.units[0].costTotal, 0);
eq("H5 minApplied false on margin", d.units[0].minApplied, false);

// H6: absent map / crew not in map → role cost, exactly as before.
d = DAY([{ time: "09:00", endTime: "14:00", breaks: [], positions: [PC(2, CID)] }], S);
near("H6 no map => role half cost", d.units[0].costTotal, 200);
d = DAY([{ time: "09:00", endTime: "14:00", breaks: [], positions: [PC(2, CID)] }], S, { 99: 500 });
near("H6 crew not in map => role cost", d.units[0].costTotal, 200);

// H7: LTP_crewMinMap only picks up crew with a positive minimum.
const cm = window.LTP_crewMinMap([
  { id: 1, isCrew: true, minDayCost: 600 },
  { id: 2, isCrew: true, minDayCost: 0 },
  { id: 3, isCrew: true },
  { id: 4, isCrew: false, minDayCost: 900 },
]);
eq("H7 map has crew1", cm[1], 600);
eq("H7 skips zero min", cm[2], undefined);
eq("H7 skips missing min", cm[3], undefined);
eq("H7 skips non-crew", cm[4], undefined);

// ── I. Payout: crewDayPay / stampPay / payoutRows ────────────────────────────
const CDP = window.LTP_crewDayPay, STAMP = window.LTP_stampPay, PAYOUT = window.LTP_payoutRows;
for (const [name, fn] of Object.entries({ LTP_crewDayPay: CDP, LTP_stampPay: STAMP, LTP_payoutRows: PAYOUT })) {
  if (typeof fn !== "function") { console.error("theme.js did not export " + name); process.exit(1); }
}
function PP(sid, crewId, status, o) { o = o || {}; return { id: o.id || ("pp" + (++_pp)), serviceId: sid, slot: o.slot, fullMargin: o.fm, breaks: o.breaks, crewId: crewId, status: status, pay: o.pay, work: o.work }; }

// I1: only CONFIRMED positions count — an accepted shift the same day is ignored.
let pd = CDP([
  { time: "09:00", endTime: "14:00", breaks: [], positions: [PP(1, 7, "confirmed"), PP(1, 8, "confirmed")] },
  { time: "15:00", endTime: "20:00", breaks: [], positions: [PP(1, 7, "accepted")] },
], 7, S);
near("I1 confirmed-only total (half)", pd.total, 400); eq("I1 paid 5h", pd.paidHours, 5); eq("I1 tier half", pd.tier, "half");

// I2: person's confirmed shifts merge across items (4h + break + 4h = full day, no OT).
pd = CDP([
  { time: "09:00", endTime: "13:00", breaks: [], positions: [PP(1, 7, "confirmed")] },
  { time: "13:00", endTime: "18:00", breaks: [{ startTime: "13:00", endTime: "14:00", type: "unpaid" }], positions: [PP(1, 7, "confirmed")] },
], 7, S);
eq("I2 paid 8h", pd.paidHours, 8); eq("I2 no OT", pd.otHours, 0); near("I2 full-day cost", pd.total, 800);

// I3: negotiated minimum floors the snapshot (L2 half 200 → min 500 half = 250).
pd = CDP([{ time: "09:00", endTime: "14:00", breaks: [], positions: [PP(2, 7, "confirmed")] }], 7, S, { 7: 500 });
near("I3 min-floored half", pd.total, 250); eq("I3 minApplied", pd.units[0].minApplied, true);

// I4: nothing confirmed → null.
eq("I4 accepted-only is null", CDP([{ time: "09:00", endTime: "14:00", breaks: [], positions: [PP(1, 7, "accepted")] }], 7, S), null);
eq("I4 other crew is null", CDP([{ time: "09:00", endTime: "14:00", breaks: [], positions: [PP(1, 8, "confirmed")] }], 7, S), null);

// I5: stampPay stamps this person's confirmed positions per day, nobody else's;
// a dates restriction leaves other days' locks untouched.
let sched = [
  { id: "d1", date: "2026-07-10", time: "09:00", endTime: "14:00", breaks: [], positions: [PP(1, 7, "confirmed", { id: "x1" }), PP(1, 8, "confirmed", { id: "y1" })] },
  { id: "d2", date: "2026-07-11", time: "09:00", endTime: "14:00", breaks: [], positions: [PP(1, 7, "confirmed", { id: "x2" })] },
  { id: "d3", date: "", time: "09:00", endTime: "14:00", breaks: [], positions: [PP(1, 7, "confirmed", { id: "x3" })] },
];
sched = STAMP(sched, 7, S, null, "T0");
const findPos = (sc, id) => sc.flatMap((s) => s.positions || []).find((p) => p.id === id);
near("I5 x1 locked 400", findPos(sched, "x1").pay.total, 400); eq("I5 x1 lockedAt", findPos(sched, "x1").pay.lockedAt, "T0");
near("I5 x2 locked 400", findPos(sched, "x2").pay.total, 400);
eq("I5 other crew untouched", findPos(sched, "y1").pay, undefined);
eq("I5 undated untouched", findPos(sched, "x3").pay, undefined);
sched = STAMP(sched, 7, S, null, "T1", ["2026-07-11"]);
eq("I5 restricted: d1 keeps T0", findPos(sched, "x1").pay.lockedAt, "T0");
eq("I5 restricted: d2 now T1", findPos(sched, "x2").pay.lockedAt, "T1");

// I6: restamping a day after more confirmed work recomputes the day total.
sched = sched.concat([{ id: "d4", date: "2026-07-10", time: "15:00", endTime: "19:00", breaks: [], positions: [PP(1, 7, "confirmed", { id: "x5" })] }]);
sched = STAMP(sched, 7, S, null, "T2", ["2026-07-10"]);
near("I6 restamped day total (5h+4h full)", findPos(sched, "x1").pay.total, 800);
near("I6 new shift carries same day snapshot", findPos(sched, "x5").pay.total, 800);

// I7: payoutRows — locked is authoritative, drift flagged, legacy unlocked falls
// back to current, range filters, grouped by crew sorted by name.
const CONTACTS = [
  { id: 7, isCrew: true, firstName: "Alex", lastName: "A" },
  { id: 8, isCrew: true, firstName: "Bea", lastName: "B" },
];
const staleLock = { total: 999, paidHours: 5, otHours: 0, mealPenaltyHours: 0, tier: "half", units: [], lockedAt: "T0" };
const PROJ = [
  { id: 1, name: "Gala", schedule: [
    { id: "g1", date: "2026-07-10", time: "09:00", endTime: "14:00", breaks: [], positions: [
      PP(1, 7, "confirmed", { pay: staleLock }), PP(1, 8, "confirmed"), PP(1, 9, "requested")] },
  ] },
  { id: 2, name: "Expo", schedule: [
    { id: "e1", date: "2026-07-20", time: "09:00", endTime: "14:00", breaks: [], positions: [PP(2, 7, "confirmed")] },
  ] },
];
let po = PAYOUT(PROJ, CONTACTS, S, "2026-07-01", "2026-07-15");
eq("I7 two crew groups", po.groups.length, 2);
eq("I7 sorted by name", po.groups.map((g) => g.crewName).join(","), "Alex A,Bea B");
const alex = po.groups[0], bea = po.groups[1];
eq("I7 alex drift", alex.rows[0].drift, true);
near("I7 alex estimate = locked", alex.rows[0].estimate, 999);
eq("I7 unsigned payable is null", alex.rows[0].payable, null);
eq("I7 bea unlocked", bea.rows[0].locked, null);
near("I7 bea estimate = current", bea.rows[0].estimate, 400);
eq("I7 counts", po.driftCount + "/" + po.unlockedCount, "1/1");
eq("I7 all pending, nothing payable", po.grandTotal, 0);
near("I7 pending total = estimates", po.pendingTotal, 1399);
eq("I7 pending count", po.pendingCount, 2);
eq("I7 requested crew excluded", po.groups.some((g) => g.crewId === 9), false);
po = PAYOUT(PROJ, CONTACTS, S, "2026-07-01", "2026-07-31");
near("I7 full range adds Expo (L2 half 200)", po.groups[0].pendingTotal, 1199);

// I8: a snapshot taken by stampPay reads back with zero drift.
const cleanSched = STAMP([
  { id: "c1", date: "2026-07-10", time: "09:00", endTime: "14:00", breaks: [], positions: [PP(1, 7, "confirmed", { id: "cx" })] },
], 7, S, null, "T3");
po = PAYOUT([{ id: 3, name: "Clean", schedule: cleanSched }], CONTACTS, S, "2026-07-01", "2026-07-31");
eq("I8 no drift on fresh lock", po.groups[0].rows[0].drift, false);
eq("I8 nothing unlocked", po.unlockedCount, 0);
near("I8 estimate = locked = current", po.groups[0].rows[0].estimate, 400);

// ── J. Day-of actuals + sign-off ─────────────────────────────────────────────
const CDA = window.LTP_crewDayActuals, SIGN = window.LTP_signOffDay, UNSIGN = window.LTP_unsignDay;
for (const [name, fn] of Object.entries({ LTP_crewDayActuals: CDA, LTP_signOffDay: SIGN, LTP_unsignDay: UNSIGN })) {
  if (typeof fn !== "function") { console.error("theme.js did not export " + name); process.exit(1); }
}

// J1: adjusted work.time/endTime override the shift's scheduled times; a
// scheduled break inside the actual window still applies (5h sched → 9h-1h=8h full).
let ja = CDA([{ time: "09:00", endTime: "14:00", breaks: [{ startTime: "12:00", endTime: "13:00", type: "unpaid" }],
  positions: [PP(1, 7, "confirmed", { work: { state: "adjusted", time: "09:00", endTime: "18:00" } })] }], 7, S);
eq("J1 actual paid 8h", ja.paidHours, 8); near("J1 actual full-day", ja.total, 800);

// J2: no_show shifts are dropped; all no_show → null.
ja = CDA([
  { time: "09:00", endTime: "14:00", breaks: [], positions: [PP(1, 7, "confirmed", { work: { state: "no_show" } })] },
  { time: "15:00", endTime: "20:00", breaks: [], positions: [PP(1, 7, "confirmed", { work: { state: "worked" } })] },
], 7, S);
eq("J2 only worked shift counts", ja.paidHours, 5); near("J2 half day", ja.total, 400);
eq("J2 all no-show is null", CDA([{ time: "09:00", endTime: "14:00", breaks: [], positions: [PP(1, 7, "confirmed", { work: { state: "no_show" } })] }], 7, S), null);

// J3: a scheduled break OUTSIDE the adjusted window is dropped, not misapplied.
ja = CDA([{ time: "09:00", endTime: "14:00", breaks: [{ startTime: "13:00", endTime: "13:30", type: "unpaid" }],
  positions: [PP(1, 7, "confirmed", { work: { state: "adjusted", time: "09:00", endTime: "13:00" } })] }], 7, S);
eq("J3 clipped paid 4h", ja.paidHours, 4); near("J3 half day", ja.total, 400);

// J4: signOffDay defaults to "worked", stamps work + final pay on every one of
// the person's confirmed positions that day, and touches nobody else.
let ss = SIGN([
  { id: "w1", date: "2026-07-10", time: "09:00", endTime: "14:00", breaks: [], positions: [PP(1, 7, "confirmed", { id: "sa" }), PP(1, 8, "confirmed", { id: "sb" })] },
  { id: "w2", date: "2026-07-10", time: "15:00", endTime: "19:00", breaks: [], positions: [PP(1, 7, "confirmed", { id: "sc" })] },
  { id: "w3", date: "2026-07-11", time: "09:00", endTime: "14:00", breaks: [], positions: [PP(1, 7, "confirmed", { id: "sd" })] },
], 7, "2026-07-10", {}, S, null, "TS", "PM");
eq("J4 state worked", findPos(ss, "sa").work.state, "worked");
near("J4 final = 5h+4h full day", findPos(ss, "sa").work.pay.total, 800);
near("J4 same snapshot on 2nd shift", findPos(ss, "sc").work.pay.total, 800);
eq("J4 signedBy", findPos(ss, "sa").work.signedBy, "PM");
eq("J4 other crew untouched", findPos(ss, "sb").work, undefined);
eq("J4 other day untouched", findPos(ss, "sd").work, undefined);

// J5: dropping one shift at sign-off pays only the worked one.
ss = SIGN(ss, 7, "2026-07-10", { sc: { state: "no_show" } }, S, null, "TS2", "PM");
near("J5 only 5h shift pays", findPos(ss, "sa").work.pay.total, 400);
eq("J5 dropped shift marked", findPos(ss, "sc").work.state, "no_show");

// J6: whole-day no-show freezes $0.
ss = SIGN(ss, 7, "2026-07-10", { sa: { state: "no_show" }, sc: { state: "no_show" } }, S, null, "TS3", "PM");
eq("J6 no-show total 0", findPos(ss, "sa").work.pay.total, 0);

// J7: unsignDay strips work → day is pending again.
ss = UNSIGN(ss, 7, "2026-07-10");
eq("J7 work cleared", findPos(ss, "sa").work, undefined);
eq("J7 other day still untouched", findPos(ss, "sd").work, undefined);

// J8: payoutRows with a signed day — payable/final counts, drift suppressed.
let jsched = STAMP([
  { id: "j1", date: "2026-07-10", time: "09:00", endTime: "14:00", breaks: [], positions: [PP(1, 7, "confirmed", { id: "jx" })] },
  { id: "j2", date: "2026-07-11", time: "09:00", endTime: "14:00", breaks: [], positions: [PP(1, 7, "confirmed", { id: "jy" })] },
], 7, S, null, "T4");
// pretend rates changed after locking: stale lock says 999
jsched = jsched.map((s) => s.id !== "j1" ? s : Object.assign({}, s, { positions: s.positions.map((p) => Object.assign({}, p, { pay: Object.assign({}, p.pay, { total: 999 }) })) }));
jsched = SIGN(jsched, 7, "2026-07-10", {}, S, null, "TS4", "PM");
po = PAYOUT([{ id: 4, name: "Mix", schedule: jsched }], CONTACTS, S, "2026-07-01", "2026-07-31");
const jrows = po.groups[0].rows;
eq("J8 signed state worked", jrows[0].signed.state, "worked");
near("J8 signed payable = final", jrows[0].payable, 400);
eq("J8 drift suppressed once signed", jrows[0].drift, false);
eq("J8 second day pending", jrows[1].signed, null);
near("J8 grand = signed only", po.grandTotal, 400);
near("J8 pending = unsigned estimate", po.pendingTotal, 400);
eq("J8 pending count 1", po.pendingCount, 1);

// J9: mixed worked/no-show day rolls up as "adjusted" in payout rows.
let jm = SIGN([
  { id: "m1", date: "2026-07-10", time: "09:00", endTime: "14:00", breaks: [], positions: [PP(1, 7, "confirmed", { id: "ma" })] },
  { id: "m2", date: "2026-07-10", time: "15:00", endTime: "19:00", breaks: [], positions: [PP(1, 7, "confirmed", { id: "mb" })] },
], 7, "2026-07-10", { mb: { state: "no_show" } }, S, null, "TS5", "PM");
po = PAYOUT([{ id: 5, name: "MixDay", schedule: jm }], CONTACTS, S, "2026-07-01", "2026-07-31");
eq("J9 mixed day state adjusted", po.groups[0].rows[0].signed.state, "adjusted");
near("J9 mixed day pays worked shift", po.groups[0].rows[0].payable, 400);

// ── K. Pay adjustments (extras/deductions per person-day) ────────────────────
const ADJSET = window.LTP_setPayAdjustments;
if (typeof ADJSET !== "function") { console.error("theme.js did not export LTP_setPayAdjustments"); process.exit(1); }

// K1: stamps the person's confirmed positions that day; zero amounts filtered;
// other crew untouched; an empty list clears.
let ks = [
  { id: "k1", date: "2026-07-10", time: "09:00", endTime: "14:00", breaks: [], positions: [PP(1, 7, "confirmed", { id: "ka" }), PP(1, 8, "confirmed", { id: "kb" })] },
];
ks = ADJSET(ks, 7, "2026-07-10", [{ id: "a1", amount: 50, label: "parking" }, { id: "a2", amount: 0, label: "zero" }]);
eq("K1 adj stamped, zero filtered", findPos(ks, "ka").adj.length, 1);
eq("K1 kept the real one", findPos(ks, "ka").adj[0].label, "parking");
eq("K1 other crew untouched", findPos(ks, "kb").adj, undefined);
ks = ADJSET(ks, 7, "2026-07-10", []);
eq("K1 empty list clears", findPos(ks, "ka").adj, undefined);

// K2: pending row — estimate and pendingTotal include the adjustment; no
// payable until signed; adjustments never create drift (base compare only).
ks = STAMP([
  { id: "k2", date: "2026-07-10", time: "09:00", endTime: "14:00", breaks: [], positions: [PP(1, 7, "confirmed", { id: "kc" })] },
], 7, S, null, "T5");
ks = ADJSET(ks, 7, "2026-07-10", [{ id: "a3", amount: 50, label: "parking" }]);
po = PAYOUT([{ id: 6, name: "AdjP", schedule: ks }], CONTACTS, S, "2026-07-01", "2026-07-31");
near("K2 estimate = base 400 + 50", po.groups[0].rows[0].estimate, 450);
eq("K2 payable still null", po.groups[0].rows[0].payable, null);
near("K2 pendingTotal includes adj", po.pendingTotal, 450);
eq("K2 adj is not drift", po.groups[0].rows[0].drift, false);

// K3: signed row — payable = frozen final + net adjustments (with a deduction);
// adjustments survive sign-off and can be edited after it.
ks = SIGN(ks, 7, "2026-07-10", {}, S, null, "TS6", "PM");
ks = ADJSET(ks, 7, "2026-07-10", [{ id: "a4", amount: 50, label: "parking" }, { id: "a5", amount: -20, label: "advance" }]);
po = PAYOUT([{ id: 6, name: "AdjP", schedule: ks }], CONTACTS, S, "2026-07-01", "2026-07-31");
near("K3 payable = 400 + 30 net", po.groups[0].rows[0].payable, 430);
near("K3 adjTotal net", po.groups[0].rows[0].adjTotal, 30);
near("K3 grand total includes adj", po.grandTotal, 430);
eq("K3 two adjustments listed", po.groups[0].rows[0].adjustments.length, 2);

// ── report ───────────────────────────────────────────────────────────────────
console.log("labor-rate suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " edge-case assertions passed.");
process.exit(0);
