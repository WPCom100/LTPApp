#!/usr/bin/env node
// Regression suite for cross rentals (docs/CROSS_RENTAL_PLAN.md).
//   1. Behavioral: the pure helpers in modules/rentals-utils.js that turn
//      cross-rental orders + vendor prices into availability and cost
//      (crossRentedQty / crossQuotedQty / totalQty / lineCost / orderCost /
//      vendorOptions / crossOverdue), plus calcRentalPrice now that it lives
//      here (moved from the quote builder — same numbers, one home).
//   2. Structural: every availability surface reads the canonical helpers and
//      the quote builder no longer carries its own pricing engine (matches the
//      convention in test_quote_availability.py / test_rentals_scan.js).
// Pure Node, zero deps.  Run:  node tests/test_rentals_cross.js
"use strict";
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

global.React = {
  createElement: function () { return null; },
  useState: function (v) { return [v, function () {}]; },
};
global.window = {
  LTP_THEME: new Proxy({}, { get: function () { return ""; } }),
  LTP_badgeFromHex: function () { return { bg: "", text: "", bd: "" }; },
};
(0, eval)(fs.readFileSync(path.join(root, "modules", "rentals-utils.js"), "utf8"));
const R = global.window.LTP_RENTALS;

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, g, e) { ok(n, g === e, "got " + JSON.stringify(g) + " exp " + JSON.stringify(e)); }

// ── calcRentalPrice (moved) ─────────────────────────────────────────────────
const RATES = { threeDay: 100, week: 200, month: 500 };
eq("P1 no dates → one 3-day", R.calcRentalPrice(null, null, RATES).totalPrice, 100);
eq("P2 1 day → one 3-day", R.calcRentalPrice("2026-10-01", "2026-10-01", RATES).totalPrice, 100);
eq("P3 3 days → one 3-day", R.calcRentalPrice("2026-10-01", "2026-10-03", RATES).totalPrice, 100);
eq("P4 4 days → cheaper of week vs 2×3-day (equal → week)", R.calcRentalPrice("2026-10-01", "2026-10-04", RATES).rateType, "week");
eq("P5 7 days → one week", R.calcRentalPrice("2026-10-01", "2026-10-07", RATES).totalPrice, 200);
eq("P6 10 days → week + 3-day", R.calcRentalPrice("2026-10-01", "2026-10-10", RATES).label, "1× Wk + 1× 3-Day");
eq("P7 30 days → one month", R.calcRentalPrice("2026-10-01", "2026-10-30", RATES).totalPrice, 500);
eq("P8 31 days → month + 3-day", R.calcRentalPrice("2026-10-01", "2026-10-31", RATES).totalPrice, 600);
eq("P9 no rates → 0", R.calcRentalPrice("2026-10-01", "2026-10-07", {}).totalPrice, 0);
ok("P10 breakdown present", Array.isArray(R.calcRentalPrice("2026-10-01", "2026-10-07", RATES).breakdown));

// ── Fixture orders ───────────────────────────────────────────────────────────
const EQ = { id: 5, name: "Mover", qty: 4, serialized: false, rates: RATES, maintenanceLogs: [] };
function order(status, lines, extra) {
  return Object.assign({ id: 1, vendorCompanyId: 7, status: status, startDate: "2026-10-01", endDate: "2026-10-10", lines: lines }, extra || {});
}
function line(eqId, qty, extra) {
  return Object.assign({ id: "l" + eqId + qty, equipmentId: eqId, name: "x", qty: qty, startDate: "", endDate: "", rates: { threeDay: 50, week: 100, month: 250 }, costOverride: null }, extra || {});
}

// ── crossRentedQty / crossQuotedQty ─────────────────────────────────────────
const CONF = [order("confirmed", [line(5, 6), line(9, 2), line(null, 3, { name: "cables" })])];
eq("C1 confirmed order supplies its line", R.crossRentedQty(CONF, 5, "2026-10-02", "2026-10-05"), 6);
eq("C2 other items excluded", R.crossRentedQty(CONF, 9, "2026-10-02", "2026-10-05"), 2);
eq("C3 part lines (no equipmentId) never count", R.crossRentedQty(CONF, null, "2026-10-02", "2026-10-05"), 0);
eq("C4 range must be fully covered — starts before", R.crossRentedQty(CONF, 5, "2026-09-30", "2026-10-05"), 0);
eq("C5 range must be fully covered — ends after", R.crossRentedQty(CONF, 5, "2026-10-05", "2026-10-11"), 0);
eq("C6 exact range counts", R.crossRentedQty(CONF, 5, "2026-10-01", "2026-10-10"), 6);
eq("C7 no range counts nothing", R.crossRentedQty(CONF, 5, "", ""), 0);
for (const st of ["quoted", "returned", "cancelled"]) {
  eq("C8 " + st + " order does not count", R.crossRentedQty([order(st, [line(5, 6)])], 5, "2026-10-02", "2026-10-05"), 0);
}
eq("C9 picked-up counts", R.crossRentedQty([order("picked-up", [line(5, 6)])], 5, "2026-10-02", "2026-10-05"), 6);
eq("C10 quoted is flagged via crossQuotedQty", R.crossQuotedQty([order("quoted", [line(5, 6)])], 5, "2026-10-02", "2026-10-05"), 6);
eq("C11 crossQuotedQty ignores confirmed", R.crossQuotedQty(CONF, 5, "2026-10-02", "2026-10-05"), 0);
eq("C12 two orders sum", R.crossRentedQty(CONF.concat([order("confirmed", [line(5, 1)], { id: 2 })]), 5, "2026-10-02", "2026-10-05"), 7);
eq("C13 negative qty clamps to 0", R.crossRentedQty([order("confirmed", [line(5, -3)])], 5, "2026-10-02", "2026-10-05"), 0);
eq("C14 tolerates null orders/lines", R.crossRentedQty([null, order("confirmed", [null, line(5, 2)])], 5, "2026-10-02", "2026-10-05"), 2);

// per-line dates override the order's
const LD = [order("confirmed", [line(5, 6, { startDate: "2026-10-05", endDate: "2026-10-06" })])];
eq("C15 line dates narrow the covered period", R.crossRentedQty(LD, 5, "2026-10-02", "2026-10-05"), 0);
eq("C16 …and count inside them", R.crossRentedQty(LD, 5, "2026-10-05", "2026-10-06"), 6);
eq("C17 lineDates falls back to the order", R.lineDates(order("quoted", []), line(5, 1)).end, "2026-10-10");

// ── totalQty ─────────────────────────────────────────────────────────────────
eq("T1 owned + confirmed cross-rented", R.totalQty(EQ, CONF, "2026-10-02", "2026-10-05"), 10);
eq("T2 no range → owned only", R.totalQty(EQ, CONF, "", ""), 4);
eq("T3 quoted does not add", R.totalQty(EQ, [order("quoted", [line(5, 6)])], "2026-10-02", "2026-10-05"), 4);
eq("T4 cross-rental-only item (0 owned) gets its supply from the order", R.totalQty(Object.assign({}, EQ, { qty: 0, crossRentalOnly: true }), CONF, "2026-10-02", "2026-10-05"), 6);
eq("T5 owned under maintenance still nets before adding", R.totalQty(Object.assign({}, EQ, { maintenanceLogs: [{ status: "open", qty: 1 }] }), CONF, "2026-10-02", "2026-10-05"), 9);

// ── lineCost / orderCost ────────────────────────────────────────────────────
const O = order("confirmed", [line(5, 2), line(9, 1, { costOverride: 75 }), line(null, 4, { rates: {} })]);
eq("K1 line cost = engine(10 days) × qty", R.lineCost(O, O.lines[0]), (100 + 50) * 2);
eq("K2 override wins", R.lineCost(O, O.lines[1]), 75);
eq("K3 no rates, no override → 0", R.lineCost(O, O.lines[2]), 0);
eq("K4 order cost sums the lines", R.orderCost(O), 375);
eq("K5 empty override string means compute", R.lineCost(O, line(5, 1, { costOverride: "" })), 150);
eq("K6 negative override → 0", R.lineCost(O, line(5, 1, { costOverride: -5 })), 0);
eq("K7 orderCost on no lines", R.orderCost({}), 0);

// ── vendorOptions ───────────────────────────────────────────────────────────
const COS = [{ id: 7, name: "PRG" }, { id: 8, name: "4Wall" }, { id: 9, name: "Cheapo" }];
const VR = [
  { id: 1, vendorCompanyId: 7, equipmentId: 5, rates: { threeDay: 60, week: 120, month: 300 }, preferred: false, active: true },
  { id: 2, vendorCompanyId: 8, equipmentId: 5, rates: { threeDay: 70, week: 130, month: 320 }, preferred: true, active: true },
  { id: 3, vendorCompanyId: 9, equipmentId: 5, rates: { threeDay: 10, week: 20, month: 50 }, preferred: false, active: false },
  { id: 4, vendorCompanyId: 7, equipmentId: 6, rates: { threeDay: 1, week: 2, month: 3 }, preferred: false, active: true },
];
const opts = R.vendorOptions(VR, COS, 5, "2026-10-01", "2026-10-07");
eq("V1 inactive and other-item prices skipped", opts.length, 2);
eq("V2 preferred first", opts[0].vendorName, "4Wall");
eq("V3 then cheapest", opts[1].vendorName, "PRG");
eq("V4 costed for the range (1 week)", opts[0].cost, 130);
eq("V5 carries the engine label", opts[0].label, "1× Wk");
eq("V6 unknown vendor still listed by id", R.vendorOptions([{ vendorCompanyId: 42, equipmentId: 5, rates: RATES }], [], 5, "2026-10-01", "2026-10-01")[0].vendorName, "Vendor #42");
eq("V7 no range → priced at one 3-day", R.vendorOptions(VR, COS, 5, "", "")[1].cost, 60);

// ── crossOverdue ────────────────────────────────────────────────────────────
ok("D1 picked-up past its end is overdue", R.crossOverdue(order("picked-up", []), "2026-10-11"));
ok("D2 confirmed past its end is overdue", R.crossOverdue(order("confirmed", []), "2026-10-11"));
ok("D3 not before the end", !R.crossOverdue(order("picked-up", []), "2026-10-10"));
ok("D4 returned never overdue", !R.crossOverdue(order("returned", []), "2026-12-01"));
ok("D5 quoted never overdue", !R.crossOverdue(order("quoted", []), "2026-12-01"));

// ── Structural guards ───────────────────────────────────────────────────────
const qb = fs.readFileSync(path.join(root, "modules", "quotes-builder.js"), "utf8");
ok("S1 quote builder no longer defines its own pricing engine", !/function calcRentalPrice\(/.test(qb));
ok("S2 quote builder aliases the shared engine", /calcRentalPrice = window\.LTP_RENTALS\.calcRentalPrice/.test(qb));
const ru = fs.readFileSync(path.join(root, "modules", "rentals-utils.js"), "utf8");
ok("S3 rentals-utils exports the engine", /calcRentalPrice:\s*calcRentalPrice/.test(ru));
ok("S4 rentals-utils exports totalQty", /totalQty:\s*totalQty/.test(ru));
const idx = fs.readFileSync(path.join(root, "index.html"), "utf8");
ok("S5 rentals-utils.js loads before quotes-builder.js", idx.indexOf("modules/rentals-utils.js") < idx.indexOf("modules/quotes-builder.js"));
ok("S6 data fallbacks for both collections are loaded", idx.includes("data/vendor-rates.js") && idx.includes("data/cross-rentals.js"));
const ds = fs.readFileSync(path.join(root, "components", "data-state.js"), "utf8");
ok("S7 both collections are entity keys", /"vendor-rates":\s*1/.test(ds) && /"cross-rentals":\s*1/.test(ds));
const ls = fs.readFileSync(path.join(root, "backend", "livesync.py"), "utf8");
ok("S8 both collections publish on the live feed", ls.includes('"vendor-rates"') && ls.includes('"cross-rentals"'));
// The surfaces that show availability must read the range-aware total.
for (const rel of ["modules/rentals-availability.js", "modules/quotes-builder.js"]) {
  const src = fs.readFileSync(path.join(root, rel), "utf8");
  ok("S9 " + rel + " reads LTP_RENTALS.totalQty", /LTP_RENTALS\.totalQty|R\.totalQty/.test(src));
  ok("S10 " + rel + " flags quoted cross rentals", /crossQuotedQty|"quoted": true/.test(src));
}
// The checker and the quote picker both open the shared order form when an
// item is short; the picker stacks it over its own modal.
const av = fs.readFileSync(path.join(root, "modules", "rentals-availability.js"), "utf8");
ok("S11 checker lists vendor options for a shortage", /R\.vendorOptions\(/.test(av) && /onCrossRent\(/.test(av));
ok("S12 quote picker mounts RentalsCrossForm with a z-index above itself", /window\.RentalsCrossForm/.test(qb) && /modalZIndex:\s*1100/.test(qb));
ok("S13 quote picker saves through the shared helpers", /upsertCrossRental\(/.test(qb) && /rememberVendorRates\(/.test(qb));
const sh = fs.readFileSync(path.join(root, "modules", "rentals-shell.js"), "utf8");
ok("S14 shell saves orders through the shared helpers too", /R\.upsertCrossRental\(/.test(sh) && /R\.rememberVendorRates\(/.test(sh));
ok("S15 shell routes the Allocations tab", /RentalsAllocationsView/.test(sh) && /"allocations"/.test(sh));
ok("S16 allocations + cross-rental modules are loaded by index.html", idx.includes("modules/rentals-allocations.js") && idx.includes("modules/rentals-cross.js") && idx.includes("components/vendor-rates.js"));
// The order form only ever counts confirmed/picked-up as inventory.
ok("S17 CROSS_COUNTS is exactly confirmed + picked-up", Object.keys(R.CROSS_COUNTS).sort().join(",") === "confirmed,picked-up");

console.log("cross-rentals suite — PASS: " + pass + "   FAIL: " + fail);
if (fail) { fails.forEach(function (f) { console.log("  ✗ " + f); }); process.exit(1); }
console.log("All " + pass + " assertions passed.");
