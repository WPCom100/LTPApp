#!/usr/bin/env node
// Whole-app frontend guard. Two layers of cheap, broad coverage:
//   1. Syntax-check (node --check) EVERY frontend JS file — catches parse errors
//      app-wide (theme, router, app, every component/module/data file).
//   2. Load theme.js in a browser-less shim and assert its public API exists —
//      catches load-time reference errors and missing exports in the shared
//      utility/business-logic layer that the rest of the app depends on.
// Pure Node, zero deps.
//   Run:  node tests/test_frontend_load.js
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const root = path.join(__dirname, "..");

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }

// Collect every frontend JS file (root entrypoints + component/module/data dirs).
const files = [];
["theme.js", "router.js", "mount.js", "app.js"].forEach((f) => {
  const p = path.join(root, f); if (fs.existsSync(p)) files.push(p);
});
["components", "modules", "data"].forEach((d) => {
  const dir = path.join(root, d);
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir).filter((f) => f.endsWith(".js")).forEach((f) => files.push(path.join(dir, f)));
});

// 1) Parse-level check of every file.
files.forEach((f) => {
  const rel = path.relative(root, f);
  try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); ok("syntax: " + rel, true); }
  catch (e) { ok("syntax: " + rel, false, String(e.stderr || e.message || "").split("\n").filter(Boolean).slice(-1)[0]); }
});

// 2) theme.js loads under a minimal shim and exports its public API.
global.window = {};
let _seq = 0; window.LTP_genId = (p) => (p || "x") + "-" + (++_seq);
let loaded = true;
try { (0, eval)(fs.readFileSync(path.join(root, "theme.js"), "utf8")); }
catch (e) { loaded = false; ok("theme.js loads under shim", false, e.message); }
if (loaded) {
  ok("theme.js loads under shim", true);
  ["LTP_THEME", "LTP_MODULES", "LTP_calcDayLabor", "LTP_calcLaborDay", "LTP_mealFixBreaks",
   "LTP_QUOTE_TOTALS", "LTP_INVOICE_TOTALS", "LTP_QUOTE_REF", "LTP_INVOICE_REF",
   "LTP_safeUrl", "LTP_formatDate", "LTP_formatTime", "LTP_resolveTemplate",
   "LTP_detectCrewConflicts", "LTP_diffRemovedCrew", "LTP_manualShiftProject"].forEach((k) => {
    ok("theme exports " + k, typeof window[k] !== "undefined");
  });
}

console.log("frontend load/syntax suite — PASS: " + pass + "   FAIL: " + fail + "   (" + files.length + " files syntax-checked)");
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " checks passed.");
