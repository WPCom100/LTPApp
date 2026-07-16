#!/usr/bin/env node
// Regression suite for the barcode scan-import helpers + wiring.
//   1. Behavioral: the pure helpers in modules/rentals-utils.js that turn a
//      scanned code + persistent batch info into a serialized unit
//      (buildScannedUnit / isDuplicateCode / batchLabel).
//   2. Structural: source-string guards so a future refactor can't silently
//      drop the scan wiring (matches the convention in test_quote_availability.py).
// Pure Node, zero deps.  Run:  node tests/test_rentals_scan.js
"use strict";
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

// ── Shim just enough for rentals-utils.js to load headlessly ────────────────
// It reads React + window.LTP_THEME + window.LTP_badgeFromHex at module-eval
// time; the helpers under test are pure and touch none of it.
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

// ── buildScannedUnit ────────────────────────────────────────────────────────
const INFO = { purchaseDate: "2026-05-01", purchaseVendorId: 7, purchaseCost: "42.50", status: "available", location: "Warehouse A" };

const u1 = R.buildScannedUnit("LTP-CBL-001", INFO, []);
eq("B1 scanned code lands in barcode", u1.barcode, "LTP-CBL-001");
eq("B2 serial stays blank (decision: scan → barcode only)", u1.serial, "");
eq("B3 purchaseDate copied", u1.purchaseDate, "2026-05-01");
eq("B4 vendor copied", u1.purchaseVendorId, 7);
eq("B5 cost coerced to number", u1.purchaseCost, 42.5);
eq("B6 status copied", u1.status, "available");
eq("B7 location copied (per-unit JSON, no migration)", u1.location, "Warehouse A");
ok("B8 maintenanceLogs initialized empty", Array.isArray(u1.maintenanceLogs) && u1.maintenanceLogs.length === 0);
eq("B9 first id is 1 when none exist", u1.id, 1);

eq("B10 code is trimmed", R.buildScannedUnit("  X9  ", INFO, []).barcode, "X9");
eq("B11 blank cost → null", R.buildScannedUnit("Z", Object.assign({}, INFO, { purchaseCost: "" }), []).purchaseCost, null);
eq("B12 missing cost → null", R.buildScannedUnit("Z", { status: "available" }, []).purchaseCost, null);
eq("B13 no vendor → null", R.buildScannedUnit("Z", { status: "available" }, []).purchaseVendorId, null);
eq("B14 default status when unset", R.buildScannedUnit("Z", {}, []).status, "available");
eq("B15 id = max(existing)+1", R.buildScannedUnit("Z", INFO, [3, 9, 4]).id, 10);
// Existing units may carry Date.now()-style ids — max+1 must still be unique.
eq("B16 id beats large timestamp ids", R.buildScannedUnit("Z", INFO, [1751000000000]).id, 1751000000001);

// Rapid-scan loop: ids stay unique when each call is fed the growing id set.
(function () {
  const acc = [];
  for (let i = 0; i < 250; i++) {
    acc.push(R.buildScannedUnit("C" + i, INFO, acc.map(function (u) { return u.id; })));
  }
  const ids = acc.map(function (u) { return u.id; });
  ok("B17 250 rapid scans → all ids unique", new Set(ids).size === ids.length, "dupes present");
})();

// ── isDuplicateCode ─────────────────────────────────────────────────────────
const UNITS = [
  { id: 1, barcode: "LTP-CBL-001", serial: "" },
  { id: 2, barcode: "", serial: "SN-ABC-9" },
  { id: 3, barcode: "LTP-CBL-002", serial: "" },
];
ok("D1 matches existing barcode", R.isDuplicateCode("LTP-CBL-001", UNITS));
ok("D2 barcode match is case-insensitive", R.isDuplicateCode("ltp-cbl-002", UNITS));
ok("D3 whitespace is ignored", R.isDuplicateCode("  LTP-CBL-001 ", UNITS));
ok("D4 matches an existing serial too", R.isDuplicateCode("SN-ABC-9", UNITS));
ok("D5 new code is not a duplicate", !R.isDuplicateCode("LTP-CBL-999", UNITS));
ok("D6 empty code is never a duplicate", !R.isDuplicateCode("", UNITS));
ok("D7 empty/undefined units tolerated", !R.isDuplicateCode("X", []) && !R.isDuplicateCode("X", undefined));

// ── batchLabel ──────────────────────────────────────────────────────────────
const VENDORS = [{ id: 7, name: "Sennheiser" }, { id: 8, name: "Chauvet" }];
eq("L1 vendor · date · location", R.batchLabel(INFO, VENDORS), "Sennheiser · 2026-05-01 · Warehouse A");
eq("L2 unknown vendor id falls back", R.batchLabel({ purchaseVendorId: 99 }, VENDORS), "Vendor #99");
eq("L3 empty info → placeholder", R.batchLabel({}, VENDORS), "No batch info set");
eq("L4 date only", R.batchLabel({ purchaseDate: "2026-01-01" }, VENDORS), "2026-01-01");

// ── Structural guards (fail loudly if the wiring is refactored away) ─────────
function src(rel) { return fs.readFileSync(path.join(root, rel), "utf8"); }
const scan = src("modules/rentals-scan.js");
ok("S1 scan module uses buildScannedUnit", scan.indexOf("buildScannedUnit") !== -1);
ok("S2 scan module uses isDuplicateCode", scan.indexOf("isDuplicateCode") !== -1);
ok("S3 scan module carries all persistent fields", ["purchaseDate", "purchaseVendorId", "purchaseCost", "status", "location"].every(function (k) { return scan.indexOf(k) !== -1; }));
ok("S4 scan module drives a camera decoder (native BarcodeDetector or ZXing)",
   scan.indexOf("getUserMedia") !== -1 && (scan.indexOf("BarcodeDetector") !== -1 && scan.indexOf("decodeBitmap") !== -1));
ok("S4b scan module requests high resolution + centre crop for small barcodes",
   scan.indexOf("ideal: 3840") !== -1 && scan.indexOf("grabCrop") !== -1);
ok("S5 scan module stops the camera on cleanup", scan.indexOf(".reset()") !== -1 && scan.indexOf("stopLoop") !== -1);
ok("S6 scan module lazy-loads the vendored decoder", scan.indexOf("/assets/vendor/zxing.min.js") !== -1);

const shell = src("modules/rentals-shell.js");
ok("S7 shell routes the scan action", shell.indexOf('action === "scan"') !== -1);
ok("S8 shell persists scanned units", shell.indexOf("addScannedUnit") !== -1 && shell.indexOf("removeScannedUnit") !== -1);
ok("S9 shell renders the scan session", shell.indexOf("RentalsScanSession") !== -1);

const equip = src("modules/rentals-equipment.js");
ok("S10 equipment form uses the shared VendorSearch", equip.indexOf("R.VendorSearch") !== -1);
ok("S11 duplicate VendorSearch definition removed", equip.indexOf("function VendorSearch") === -1);
ok("S12 detail modal exposes a Scan Units entry point", equip.indexOf("onScan") !== -1);

// The decoder is present and same-origin (CSP script-src 'self').
ok("S13 vendored decoder file exists", fs.existsSync(path.join(root, "assets", "vendor", "zxing.min.js")));

console.log("rentals-scan suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach(function (f) { console.log("  x " + f); }); process.exit(1); }
console.log("All " + pass + " assertions passed.");
