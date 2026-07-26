#!/usr/bin/env node
// Unit coverage for the inline entity add/edit plumbing
// (components/entity-quick-form.js) and the narrowed-contact-select helper it
// made easy to hit (components/helpers.js).
//
// These are the pieces that can be exercised without a DOM: the query→prefill
// parser, the kind allow-list (which is what keeps crew rosters and other
// fixed lists out of the feature), and contactSelectOptions.
//   Run:  node tests/test_entity_quick_form.js
"use strict";
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(n, g === w, g === w ? "" : "got " + g + " want " + w);
}

// ── Minimal browser shim ───────────────────────────────────────────────────
// Both files are IIFEs that only touch window at load time; the React bits are
// referenced inside component bodies we never render here.
global.window = { LTP_THEME: {} };
global.React = { createElement: function () { return null; }, Fragment: "Fragment" };
global.console = console;

(0, eval)(fs.readFileSync(path.join(root, "components/helpers.js"), "utf8"));
(0, eval)(fs.readFileSync(path.join(root, "components/entity-quick-form.js"), "utf8"));

const H = window.LTP_HELPERS;
const prefill = window.LTP_entityPrefillFromQuery;

// ── The authorable-kind allow-list ─────────────────────────────────────────
// The whole safety story of this feature is that it can only author these
// three. If someone adds "crew" or "equipment" here, this test should fail and
// make them justify it.
eq("only company/contact/project are authorable",
   Object.keys(window.LTP_ENTITY_KIND_LABEL).sort(), ["company", "contact", "project"]);

// Opening an unsupported kind is refused, not thrown — a picker can call it
// blind. (No host is mounted here, so a supported kind refuses too.)
const warns = [];
const realWarn = console.warn; console.warn = (...a) => warns.push(a.join(" "));
ok("unknown kind is refused", window.LTP_openEntityForm({ kind: "crew" }) === false);
ok("missing request is refused", window.LTP_openEntityForm(null) === false);
ok("supported kind refuses when no host is mounted", window.LTP_openEntityForm({ kind: "company" }) === false);
console.warn = realWarn;
ok("each refusal warned", warns.length === 3, "warns=" + warns.length);

// ── query → create-form seed ───────────────────────────────────────────────
eq("company seed uses the whole query as the name",
   prefill("company", "Dallas Theater Center"), { name: "Dallas Theater Center" });
eq("project seed uses the whole query as the name",
   prefill("project", "Fall Gala 2026"), { name: "Fall Gala 2026" });
eq("contact seed splits first / last",
   prefill("contact", "Ada Lovelace"), { firstName: "Ada", lastName: "Lovelace" });
eq("contact seed keeps multi-word surnames whole",
   prefill("contact", "Ada van der Lovelace"), { firstName: "Ada", lastName: "van der Lovelace" });
eq("contact seed with one word leaves lastName empty",
   prefill("contact", "Ada"), { firstName: "Ada", lastName: "" });
eq("surrounding whitespace is trimmed",
   prefill("company", "   Acme Staging  "), { name: "Acme Staging" });
eq("collapsed inner whitespace doesn't produce empty name parts",
   prefill("contact", "Ada    Lovelace"), { firstName: "Ada", lastName: "Lovelace" });
eq("empty query seeds nothing", prefill("company", "   "), {});
eq("null query seeds nothing", prefill("contact", null), {});

// ── contactSelectOptions ───────────────────────────────────────────────────
// A narrowed candidate list can exclude an ALREADY-SELECTED contact (link a
// project that doesn't list them). A native <select> whose value isn't among
// its options silently shows the first one, so the field would read "(none)"
// while the draft still carried that contact's id.
const ada = { id: 1, firstName: "Ada", lastName: "Lovelace", role: "TD" };
const bob = { id: 2, firstName: "Bob", lastName: "Stone", role: "" };
const all = [ada, bob];

eq("candidates map to value/label with role suffix",
   H.contactSelectOptions([ada], null, all), [{ value: 1, label: "Ada Lovelace — TD" }]);
eq("no role → no suffix",
   H.contactSelectOptions([bob], null, all), [{ value: 2, label: "Bob Stone" }]);
eq("selected contact already in the list isn't duplicated",
   H.contactSelectOptions([ada, bob], 1, all),
   [{ value: 1, label: "Ada Lovelace — TD" }, { value: 2, label: "Bob Stone" }]);
eq("selected contact missing from a narrowed list is appended and flagged",
   H.contactSelectOptions([bob], 1, all),
   [{ value: 2, label: "Bob Stone" }, { value: 1, label: "Ada Lovelace — not on this list" }]);
eq("an empty candidate list still surfaces the selection",
   H.contactSelectOptions([], 1, all), [{ value: 1, label: "Ada Lovelace — not on this list" }]);
eq("nothing selected → candidates unchanged", H.contactSelectOptions([], null, all), []);
eq("a selected id that no longer resolves is dropped rather than faked",
   H.contactSelectOptions([bob], 99, all), [{ value: 2, label: "Bob Stone" }]);
eq("null candidates tolerated", H.contactSelectOptions(null, null, all), []);

console.log("entity quick-form suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
