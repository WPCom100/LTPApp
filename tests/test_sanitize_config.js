#!/usr/bin/env node
// components/sanitize.js — the ONE allowlist standing between member-authored
// HTML and an admin's DOM.
//
// WHY THIS EXISTS
//   Both configs used to carry USE_PROFILES: { html: true } next to their
//   allowlists. DOMPurify does not intersect those — USE_PROFILES REPLACES
//   ALLOWED_TAGS/ALLOWED_ATTR with its built-in HTML profile, so the arrays
//   below them were decorative. Measured in Chromium: the narrow config
//   declared 13 tags and "NO attributes are allowed" while actually permitting
//   85 tags and 14 attributes, <form>/<input>/<button> and style=/id=/src=
//   among them. Nothing executable got through (handlers and <script> are
//   dropped either way, and the CSP blocks the form POST and the image
//   fetch), but a position:fixed overlay plus an <a href> anywhere is enough
//   for in-app phishing — and CRM note bodies have no server-side sanitizer
//   at all, so this file is the only allowlist on that path.
//
//   Nothing caught it because nothing tested this file. These tests read the
//   REAL config objects rather than the source text: DOMPurify is shimmed with
//   a recorder, so what is asserted is exactly what ships to the browser.
//
// Pure Node, zero deps.
//   Run:  node tests/test_sanitize_config.js
"use strict";
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }

// ── Load the module with DOMPurify replaced by a config recorder ───────────
const calls = [];
global.window = {
  DOMPurify: { sanitize: function (input, cfg) { calls.push(cfg); return input; } },
};
(0, eval)(fs.readFileSync(path.join(root, "components", "sanitize.js"), "utf8"));

ok("sanitize.js publishes LTP_SANITIZE", typeof window.LTP_SANITIZE === "object");
window.LTP_SANITIZE.html("probe");
window.LTP_SANITIZE.emailHtml("probe");
ok("both entry points reached DOMPurify", calls.length === 2, "calls=" + calls.length);

const CONFIG = calls[0] || {};
const EMAIL = calls[1] || {};
const tags = CONFIG.ALLOWED_TAGS || [];
const attrs = CONFIG.ALLOWED_ATTR || [];
const eTags = EMAIL.ALLOWED_TAGS || [];
const eAttrs = EMAIL.ALLOWED_ATTR || [];

// ── The regression itself ──────────────────────────────────────────────────
// USE_PROFILES must not come back. Asserted on the live objects, so a
// reintroduction is caught even if the source comment still says otherwise.
ok("narrow CONFIG sets no USE_PROFILES", CONFIG.USE_PROFILES === undefined,
   JSON.stringify(CONFIG.USE_PROFILES));
ok("EMAIL_CONFIG sets no USE_PROFILES", EMAIL.USE_PROFILES === undefined,
   JSON.stringify(EMAIL.USE_PROFILES));

// ── Narrow config: what must never be allowed ──────────────────────────────
// Each of these was reachable while USE_PROFILES was in place.
[["form", "phishing form"], ["input", "phishing form"], ["button", "phishing form"],
 ["img", "external tracking beacon"], ["iframe", "framed content"],
 ["textarea", "profile leakage"], ["select", "profile leakage"],
 ["style", "stylesheet injection"], ["script", "script"], ["table", "profile leakage"]
].forEach(function (pair) {
  ok("narrow tags exclude <" + pair[0] + "> (" + pair[1] + ")", tags.indexOf(pair[0]) === -1);
});
[["style", "position:fixed overlay"], ["id", "DOM clobbering"], ["class", "UI spoofing"],
 ["src", "external fetch"], ["target", "tabnabbing"], ["onclick", "handler"]
].forEach(function (pair) {
  ok("narrow attrs exclude " + pair[0] + "= (" + pair[1] + ")", attrs.indexOf(pair[0]) === -1);
});
ok("narrow attrs are href and nothing else",
   attrs.length === 1 && attrs[0] === "href", JSON.stringify(attrs));

// ── Narrow config: what must stay allowed ──────────────────────────────────
// The editor toolbar's own output. Losing any of these silently flattens
// every existing note that used that button.
["b", "i", "u", "s", "strike", "p", "div", "br", "ul", "ol", "li", "h3", "blockquote"]
  .forEach(function (t) { ok("narrow tags keep toolbar <" + t + ">", tags.indexOf(t) !== -1); });
// Tags a real paste carries. These were reachable for as long as USE_PROFILES
// was set, so stored notes contain them; dropping them re-renders history.
["strong", "em", "span", "h1", "h2", "h4", "a"]
  .forEach(function (t) { ok("narrow tags keep pasted <" + t + ">", tags.indexOf(t) !== -1); });

// ── Shared hardening flags ─────────────────────────────────────────────────
[["narrow", CONFIG], ["email", EMAIL]].forEach(function (pair) {
  const label = pair[0], cfg = pair[1];
  ok(label + " sets ALLOW_DATA_ATTR false", cfg.ALLOW_DATA_ATTR === false, String(cfg.ALLOW_DATA_ATTR));
  ok(label + " sets KEEP_CONTENT true", cfg.KEEP_CONTENT === true, String(cfg.KEEP_CONTENT));
  // Without a URI regexp the href allowance below would accept data: URLs.
  const re = cfg.ALLOWED_URI_REGEXP;
  const hasRe = re instanceof RegExp;
  ok(label + " constrains URI schemes", hasRe, String(re));
  // Guarded: without it, a missing regexp throws here and takes the whole
  // suite down instead of reporting one clean failure. A test that crashes
  // under the change it exists to catch reports nothing at all.
  [["https://ok.example/x", true], ["mailto:a@b.co", true], ["tel:+15550100", true],
   ["/relative/path", true], ["javascript:alert(1)", false],
   ["data:text/html;base64,PHN2Zz4=", false], ["vbscript:msgbox(1)", false]
  ].forEach(function (c) {
    ok(label + " URI regexp " + (c[1] ? "accepts" : "rejects") + " " + c[0],
       hasRe && re.test(c[0]) === c[1], hasRe ? "" : "no regexp configured");
  });
});

// ── Email config mirrors the server ────────────────────────────────────────
// components/sanitize.js states this list "needs to MIRROR backend/sanitize.py
// exactly — otherwise the live preview renders something different from what
// goes out". USE_PROFILES silently broke that in both directions: it dropped
// target= (which the backend keeps) and added bgcolor=/id= (which it does not).
// Parsed straight out of the Python so the two cannot drift again.
const py = fs.readFileSync(path.join(root, "backend", "sanitize.py"), "utf8");

function pyBlock(startMarker, endChar) {
  const i = py.indexOf(startMarker);
  if (i === -1) return null;
  const j = py.indexOf(endChar, i);
  return j === -1 ? null : py.slice(i + startMarker.length, j);
}
function pyStrings(block) {
  return block === null ? null : (block.match(/"([a-z0-9_*-]+)"/gi) || [])
    .map(function (s) { return s.slice(1, -1); });
}

const pyTags = pyStrings(pyBlock("ALLOWED_TAGS = frozenset({", "})"));
ok("could parse backend ALLOWED_TAGS", Array.isArray(pyTags) && pyTags.length > 10,
   pyTags ? "n=" + pyTags.length : "parse failed");
if (pyTags) {
  const missing = pyTags.filter(function (t) { return eTags.indexOf(t) === -1; });
  const extra = eTags.filter(function (t) { return pyTags.indexOf(t) === -1; });
  ok("email tags match backend/sanitize.py exactly", missing.length === 0 && extra.length === 0,
     "js-missing=" + missing.join(",") + " js-extra=" + extra.join(","));
}

// The backend keys attributes per-tag ("*" applies to all); DOMPurify takes a
// flat list. Flatten the Python side and compare sets.
const pyAttrBlock = pyBlock("ALLOWED_ATTRIBUTES = {", "\n}");
const pyAttrs = pyAttrBlock === null ? null : (function () {
  const out = {};
  (pyAttrBlock.match(/\[([^\]]*)\]/g) || []).forEach(function (grp) {
    (grp.match(/"([a-z-]+)"/gi) || []).forEach(function (s) { out[s.slice(1, -1)] = true; });
  });
  return Object.keys(out);
})();
ok("could parse backend ALLOWED_ATTRIBUTES", Array.isArray(pyAttrs) && pyAttrs.length > 10,
   pyAttrs ? "n=" + pyAttrs.length : "parse failed");
if (pyAttrs) {
  const missing = pyAttrs.filter(function (a) { return eAttrs.indexOf(a) === -1; });
  const extra = eAttrs.filter(function (a) { return pyAttrs.indexOf(a) === -1; });
  ok("email attrs match backend/sanitize.py exactly", missing.length === 0 && extra.length === 0,
     "js-missing=" + missing.join(",") + " js-extra=" + extra.join(","));
  // Named explicitly: this is the pair USE_PROFILES got wrong.
  ok("target= is on the email list (backend keeps it)", eAttrs.indexOf("target") !== -1);
  ["bgcolor", "id"].forEach(function (a) {
    ok("email attrs exclude " + a + "= (backend rejects it)", eAttrs.indexOf(a) === -1);
  });
}

// ── Every caller goes through the wrapper ──────────────────────────────────
// The module header says "All callers MUST use LTP_SANITIZE.html() — never
// call DOMPurify.sanitize directly." A direct call would bypass every
// assertion above, so enforce it.
const frontendDirs = ["components", "modules", "data"];
const scanned = [];
["theme.js", "router.js", "app.js", "mount.js"].forEach(function (f) {
  const p = path.join(root, f); if (fs.existsSync(p)) scanned.push(p);
});
frontendDirs.forEach(function (d) {
  const dir = path.join(root, d);
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir).filter(function (f) { return f.endsWith(".js"); })
    .forEach(function (f) { scanned.push(path.join(dir, f)); });
});
const direct = scanned.filter(function (p) {
  if (path.basename(p) === "sanitize.js") return false;   // the wrapper itself
  return /DOMPurify\s*\.\s*sanitize\s*\(/.test(fs.readFileSync(p, "utf8"));
}).map(function (p) { return path.relative(root, p); });
ok("no module calls DOMPurify.sanitize directly", direct.length === 0, direct.join(", "));
ok("the scan actually covered the frontend", scanned.length > 40, "n=" + scanned.length);

console.log("sanitize-config suite — PASS: " + pass + "   FAIL: " + fail);
if (fail) { fails.forEach(function (f) { console.log("  FAIL " + f); }); process.exit(1); }
console.log("All " + pass + " assertions passed.");
