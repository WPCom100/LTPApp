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

// 2) The theme + domain layer loads under a minimal shim and exports its full
//    public API. theme.js was split into components/domain-*.js; the loader
//    reads the file list out of index.html so this can never diverge from what
//    the browser actually loads.
const { domainScripts, loadDomain } = require("./_load_domain.js");
let scripts = [];
let loaded = true;
try { scripts = domainScripts(); loadDomain(); }
catch (e) { loaded = false; ok("domain layer loads under shim", false, e.message); }

if (loaded) {
  ok("domain layer loads under shim", true);
  ok("index.html still loads theme.js first", scripts[0] === "theme.js", scripts[0]);
  ok("index.html loads the domain files", scripts.length > 1, "n=" + scripts.length);

  // Spot-checks kept from before the split, one per destination file.
  ["LTP_THEME", "LTP_MODULES", "LTP_calcDayLabor", "LTP_calcLaborDay", "LTP_mealFixBreaks",
   "LTP_QUOTE_TOTALS", "LTP_INVOICE_TOTALS", "LTP_QUOTE_REF", "LTP_INVOICE_REF",
   "LTP_safeUrl", "LTP_formatDate", "LTP_formatTime", "LTP_resolveTemplate",
   "LTP_detectCrewConflicts", "LTP_diffRemovedCrew", "LTP_manualShiftProject",
   "LTP_clientRef", "LTP_servicesForClient", "LTP_applyClientRate", "LTP_clientRateMap"].forEach((k) => {
    ok("domain exports " + k, typeof window[k] !== "undefined");
  });

  // ── The split guard ─────────────────────────────────────────────────────
  // A spot-check list cannot catch an export that silently stops being
  // published — the failure is a ReferenceError at CALL time, in whichever
  // screen happens to use it. So assert on the COUNT and on set membership:
  // every window.LTP_* assigned at column 0 (or from inside one of the two
  // IIFEs) across the domain files must actually be on window afterwards.
  const declared = new Set();
  scripts.forEach((rel) => {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    // Column 0 for a normal export; up to 4 spaces for one published from
    // inside an IIFE (LTP_STATUS_COLORS, and the four crew-removal helpers).
    for (const m of src.matchAll(/^ {0,4}window\.(LTP_\w+)\s*=/gm)) declared.add(m[1]);
  });
  const live = new Set(Object.keys(window).filter((k) => k.startsWith("LTP_")));
  const missing = [...declared].filter((k) => !live.has(k));
  ok("every declared LTP_ export reaches window", missing.length === 0, missing.join(", "));
  ok("the domain layer still publishes 102 exports", live.size === 102, "got " + live.size);

  // No export may be published by two files: the later <script> would silently
  // win, and which one that is depends on index.html's ordering.
  const seen = new Map(); const dupes = [];
  scripts.forEach((rel) => {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    for (const m of src.matchAll(/^ {0,4}window\.(LTP_\w+)\s*=/gm)) {
      if (seen.has(m[1]) && seen.get(m[1]) !== rel) dupes.push(m[1] + " (" + seen.get(m[1]) + " + " + rel + ")");
      else seen.set(m[1], rel);
    }
  });
  ok("no export is published by two domain files", dupes.length === 0, dupes.join("; "));

  // theme.js keeps ONLY the theme. The whole point of the split was that it was
  // 96% business logic; a regression here means domain code drifted back in.
  const themeSrc = fs.readFileSync(path.join(root, "theme.js"), "utf8");
  ok("theme.js stayed small after the split", themeSrc.split("\n").length < 200,
     themeSrc.split("\n").length + " lines");

  // ── Helpers stay with the code that uses them ───────────────────────────
  // theme.js was never IIFE-wrapped, so a `function _timeToDecimal()` at its
  // top level is a GLOBAL and separate <script> tags share one global scope —
  // verified in Chromium. So splitting a helper away from its callers would
  // still RUN today; this is not a correctness guard.
  //
  // It is here because that is a latent trap. The right cleanup for this layer
  // is to wrap each domain file in an IIFE so `_timeToDecimal` stops leaking
  // onto window — and the moment anyone does, every helper that drifted into a
  // different file from its callers becomes a ReferenceError at call time, in
  // whichever screen happens to call it. Keeping them co-located now means that
  // cleanup is a safe one-line change per file later.
  const declFiles = new Map();   // private name -> file that declares it
  const useFiles = new Map();    // private name -> Set of files referencing it
  const srcOf = new Map();
  scripts.forEach((rel) => srcOf.set(rel, fs.readFileSync(path.join(root, rel), "utf8")));
  scripts.forEach((rel) => {
    for (const m of srcOf.get(rel).matchAll(/^(?:var|function|const|let)\s+(_\w+)/gm)) {
      declFiles.set(m[1], rel);
    }
  });
  declFiles.forEach((_declFile, name) => {
    scripts.forEach((rel) => {
      // A reference is any other mention of the identifier in that file.
      const hits = (srcOf.get(rel).match(new RegExp("\\b" + name + "\\b", "g")) || []).length;
      const decls = (srcOf.get(rel).match(
        new RegExp("^(?:var|function|const|let)\\s+" + name + "\\b", "gm")) || []).length;
      if (hits > decls) {
        if (!useFiles.has(name)) useFiles.set(name, new Set());
        useFiles.get(name).add(rel);
      }
    });
  });
  const strayed = [];
  useFiles.forEach((users, name) => {
    users.forEach((u) => { if (u !== declFiles.get(name)) strayed.push(`${name}: declared in ${declFiles.get(name)}, used in ${u}`); });
  });
  ok("every file-scope helper is used only in the file that declares it",
     strayed.length === 0, strayed.join("; "));
  ok("the helper scan found the known helpers", declFiles.size >= 8, "found " + declFiles.size);

  // Every domain file must be precached, or it is missing on a cold offline
  // launch — the boot chain is not something the runtime cache can cover.
  const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
  const precache = sw.slice(sw.indexOf("SAME_ORIGIN_PRECACHE"), sw.indexOf("CDN_PRECACHE"));
  scripts.filter((s) => s !== "theme.js").forEach((rel) => {
    ok("sw.js precaches /" + rel, precache.includes("'/" + rel + "'"));
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
