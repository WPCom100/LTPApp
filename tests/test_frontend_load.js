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
   "LTP_detectCrewConflicts", "LTP_diffRemovedCrew", "LTP_manualShiftProject",
   "LTP_clientRef", "LTP_servicesForClient", "LTP_applyClientRate", "LTP_clientRateMap"].forEach((k) => {
    ok("theme exports " + k, typeof window[k] !== "undefined");
  });
}

// ── Invoice payment durability (source-level) ─────────────────────────────
// There is no React harness here, so these assert the invariant at the source.
// Recording a payment auto-saves it to the invoices list but the editor kept a
// PRE-payment discard baseline, because autoSavePayment was the one commit path
// that did not advance cleanRef. Discard is gated on isDirty alone — no
// !isLocked, unlike Save — so dirtying any un-gated field on a locked invoice
// and hitting Discard reset the draft to that stale snapshot and the payment
// disappeared from the editor. recallToDraft then wrote the payment-free draft
// over the persisted row, past a guard written to prevent exactly that.
const invSrc = fs.readFileSync(path.join(root, "modules", "invoices.js"), "utf8");

function fnBody(src, name) {
  const m = new RegExp("function\\s+" + name + "\\s*\\([^)]*\\)\\s*\\{").exec(src);
  if (!m) return null;
  let i = m.index + m[0].length - 1, depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(m.index, i + 1); }
  }
  return null;
}

const autoSave = fnBody(invSrc, "autoSavePayment");
ok("invoices.js defines autoSavePayment", autoSave !== null);
if (autoSave) {
  ok("autoSavePayment advances the discard baseline (cleanRef.current)",
     /cleanRef\.current\s*=/.test(autoSave),
     "a payment auto-save must re-baseline or Discard reverts it away");
  ok("autoSavePayment still clears the dirty flag", /setIsDirty\(false\)/.test(autoSave));
}

const recall = fnBody(invSrc, "recallToDraft");
ok("invoices.js defines recallToDraft", recall !== null);
if (recall) {
  ok("recallToDraft checks the persisted row, not just the draft",
     /invoices\s*\|\|\s*\[\]/.test(recall) && /persisted/.test(recall),
     "a money guard must not trust the in-memory draft alone");
  ok("recallToDraft still blocks when payments exist",
     /Cannot Recall/.test(recall));
}

console.log("frontend load/syntax suite — PASS: " + pass + "   FAIL: " + fail + "   (" + files.length + " files syntax-checked)");
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " checks passed.");
