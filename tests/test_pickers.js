#!/usr/bin/env node
// Unit coverage for the app's entity pickers — the parts that can be exercised
// without a DOM:
//
//   * components/entity-quick-form.js — the query→prefill parser and the
//     authorable-kind allow-list, which is what keeps crew rosters and other
//     fixed lists out of the inline-create feature.
//   * components/search-dropdown.js  — LTP_crewSelectOptions, the two-tier
//     "role-tagged crew, then everyone else behind a click" option builder.
//   * components/helpers.js          — contactFieldTiers, the two-tier candidate
//                                     list behind the Primary Contact pickers.
//
// The recurring theme in here is one latent bug in two places: a picker whose
// narrowing excludes the record ALREADY selected — an assigned-but-inactive
// crew member, a contact not linked to this client — leaves the position
// LOOKING unfilled while the record still holds them. Both builders pin the
// current selection into tier 1 instead, and these tests hold that line.
//   Run:  node tests/test_pickers.js
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

// ── Crew picker tiers (components/search-dropdown.js) ───────────────────────
// Crew is SEARCHABLE but never creatable — you pick from a roster, you don't
// author a crew member from a schedule row.
(0, eval)(fs.readFileSync(path.join(root, "components/search-dropdown.js"), "utf8"));
const crewTiers = window.LTP_crewSelectOptions;

const l2a = { id: 10, firstName: "Ann", lastName: "Ng", crewRoles: ["L2"], crewDepartments: ["Lighting"], crewStatus: "active" };
const l2b = { id: 11, firstName: "Bo", lastName: "Ray", crewRoles: ["L2", "A1"], crewDepartments: ["Lighting"], crewStatus: "active" };
const a1  = { id: 12, firstName: "Cy", lastName: "Vo", crewRoles: ["A1"], crewDepartments: ["Audio"], crewStatus: "active" };
const gone = { id: 13, firstName: "Di", lastName: "Ux", crewRoles: ["L2"], crewStatus: "inactive" };
const roster = [l2b, a1, l2a];            // deliberately unsorted
const everyone = roster.concat([gone]);

let t = crewTiers({ crew: roster, role: "L2", allContacts: everyone });
eq("only role-tagged crew are in the primary tier",
   t.options.map((o) => o.label), ["Ann Ng", "Bo Ray"]);
eq("everyone else is behind the second tier",
   t.moreOptions.map((o) => o.label), ["Cy Vo"]);
ok("second tier is labelled with its count", /Other crew \(1\)/.test(t.moreLabel), t.moreLabel);
eq("rows carry roles + department as a subtitle", t.options[0].sublabel, "L2 · Lighting");

t = crewTiers({ crew: roster, role: "L2", allContacts: everyone, leading: [{ value: "", label: "Crew…" }] });
eq("leading sentinel is pinned above the list",
   t.options.map((o) => o.label), ["Crew…", "Ann Ng", "Bo Ray"]);
ok("sentinel keeps its empty value", t.options[0].value === "");

// No role being filled → everyone is a candidate and there is no second tier.
t = crewTiers({ crew: roster, role: "", allContacts: everyone });
eq("with no role, everyone is primary, sorted by name",
   t.options.map((o) => o.label), ["Ann Ng", "Bo Ray", "Cy Vo"]);
ok("with no role there is no second tier", t.moreOptions === null);

// The bug the native selects had: an assigned crew member who goes inactive
// vanishes from the options, and a <select> whose value matches no option
// renders option 0 — so the row read "Crew…" while the position was still held.
t = crewTiers({ crew: roster, role: "L2", selectedId: 13, allContacts: everyone });
eq("an assigned-but-inactive crew member is pinned into the list, flagged",
   t.options.map((o) => o.label), ["Ann Ng", "Bo Ray", "Di Ux — inactive"]);
ok("...and keeps their real id so the value still resolves", t.options[2].value === 13);

t = crewTiers({ crew: roster, role: "L2", selectedId: 12, allContacts: everyone });
ok("an assignee who lost the role tag is pinned and flagged, not silently dropped",
   t.options.some((o) => o.label === "Cy Vo — not tagged for this role"),
   JSON.stringify(t.options.map((o) => o.label)));

t = crewTiers({ crew: roster, role: "L2", selectedId: 10, allContacts: everyone });
eq("an assignee already in the tier isn't duplicated",
   t.options.filter((o) => o.value === 10).length, 1);
t = crewTiers({ crew: roster, role: "L2", selectedId: 999, allContacts: everyone });
eq("an unresolvable id is dropped rather than faked",
   t.options.map((o) => o.label), ["Ann Ng", "Bo Ray"]);
eq("empty roster yields an empty list, not a crash",
   crewTiers({ crew: [], role: "L2", allContacts: [] }).options, []);

// ── Contact picker tiers (components/helpers.js) ──────────────────────────
const linked = { id: 1, firstName: "Ada", lastName: "Lovelace", role: "TD" };
const other  = { id: 2, firstName: "Bob", lastName: "Stone", role: "PM" };
const crewPerson = { id: 3, firstName: "Cal", lastName: "Rig", isCrew: true };
const allC = [linked, other, crewPerson];

// The rules that matter are three: this client's people first, crew never
// offered as someone to bill, and whoever is currently selected reachable
// WITHOUT first expanding tier 2 — a narrowed list that hides the contact the
// document already carries is how a quote came to look unaddressed.
let cf = H.contactFieldTiers([linked], null, allC);
eq("tier 1 is the client's own contacts", cf.primary.map((c) => c.id), [1]);
eq("tier 2 is everyone else", cf.rest.map((c) => c.id), [2]);
ok("crew are not offered as billable contacts",
   !cf.rest.some((c) => c.isCrew), JSON.stringify(cf.rest.map((c) => c.id)));
ok("second tier is labelled with its count", /Other contacts \(1\)/.test(cf.moreLabel), cf.moreLabel);

cf = H.contactFieldTiers([linked, other], null, allC);
eq("with everyone linked tier 2 is empty", cf.rest, []);
ok("...and there is no reveal label to render", cf.moreLabel === null, String(cf.moreLabel));

// The chip always shows the selection, so unlike the options version there is
// no "value with no matching option" hole — but re-opening the list to change
// your mind must still show who is picked without expanding tier 2 first.
cf = H.contactFieldTiers([linked], 2, allC);
eq("a selected off-list contact is lifted into tier 1", cf.primary.map((c) => c.id), [1, 2]);
ok("...and is not ALSO repeated in tier 2",
   !cf.rest.some((c) => c.id === 2), JSON.stringify(cf.rest.map((c) => c.id)));

// An id pointing at nobody can't be pinned — better an honest short list than a
// placeholder row for a contact that no longer exists.
cf = H.contactFieldTiers([linked], 999, allC);
eq("an unresolvable selection is dropped rather than faked", cf.primary.map((c) => c.id), [1]);

// Guards for the states the builders actually hit: no company picked yet (no
// candidates), and a contact list that hasn't loaded.
cf = H.contactFieldTiers([], null, allC);
eq("no candidates still offers everyone behind the click", cf.rest.map((c) => c.id), [1, 2]);
eq("empty tier 1 is empty, not a crash", cf.primary, []);
cf = H.contactFieldTiers(null, null, null);
eq("null inputs yield empty tiers", [cf.primary, cf.rest, cf.moreLabel], [[], [], null]);

// Duplicate candidates (a contact linked to both the project and the company)
// must not render twice — React would collide on the key.
cf = H.contactFieldTiers([linked, linked], null, allC);
eq("a duplicated candidate appears once", cf.primary.map((c) => c.id), [1]);


console.log("pickers suite — PASS: " + pass + "   FAIL: " + fail);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
