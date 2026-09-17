#!/usr/bin/env node
// Rental periods vs. the project's dates — the helpers behind the quote
// builder's "out of sync" notice (components/domain-docs.js):
//   * LTP_docRentalWindow      — a document's own rental window
//   * LTP_sectionRentalWindow  — the window one section prices on
//   * LTP_staleRentalSections  — sections priced for a window the project left
//   * LTP_stampRentalWindows   — what save() records, and what it must NOT touch
//   * LTP_rentalDriftNotice    — the toast after a project's dates move
//
// WHY THIS SUITE EXISTS
//   A quote reads its rental dates live from its project, but prices its
//   equipment once. Moving the project's dates used to leave the quote showing
//   the new dates over the old prices with nobody told. These helpers decide
//   WHICH sections are out of sync and, just as importantly, which are not —
//   a false positive nags on every quote, a false negative is the old bug.
//   The decision (re-price, or keep the old dates) is the editor's; nothing
//   here changes a price.
//
// Pure Node, zero deps.
//   Run:  node tests/test_rental_drift.js
"use strict";
const { loadDomain } = require("./_load_domain.js");
loadDomain();

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, got, want) { ok(n, JSON.stringify(got) === JSON.stringify(want), "got " + JSON.stringify(got)); }

const WIN = window.LTP_docRentalWindow, SEC = window.LTP_sectionRentalWindow;
const STALE = window.LTP_staleRentalSections, STAMP = window.LTP_stampRentalWindows;
const NOTICE = window.LTP_rentalDriftNotice;
["LTP_docRentalWindow", "LTP_sectionRentalWindow", "LTP_staleRentalSections", "LTP_stampRentalWindows", "LTP_rentalDriftNotice"]
  .forEach((k) => ok(k + " is exported", typeof window[k] === "function"));

// The project ran Aug 10 → 11 when the quote was priced; it now runs Aug 10 → 13.
const GALA = { id: 7, name: "Riverfront Gala", startDate: "2026-08-10", endDate: "2026-08-13" };
const UNDATED = { id: 8, name: "TBD", startDate: "", endDate: "" };
const PROJECTS = [GALA, UNDATED];
const OLD = { pricedStartDate: "2026-08-10", pricedEndDate: "2026-08-11" };
const NEW = { pricedStartDate: "2026-08-10", pricedEndDate: "2026-08-13" };
const EQ = { id: "e1", type: "equipment", equipmentId: 1, name: "Mac Aura", qty: 4, unitPrice: 120 };
const SVC = { id: "s1", type: "service", serviceId: 1, name: "A1", qty: 1, unitPrice: 1000 };
function sec(id, over) {
  return Object.assign({ id: id, label: id, customDates: false, startDate: "", endDate: "", items: [EQ] }, over || {});
}
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── LTP_docRentalWindow ──────────────────────────────────────────────────────
eq("W0 linked project's dates", WIN({ projectId: 7 }, PROJECTS), { start: "2026-08-10", end: "2026-08-13" });
eq("W1 project with no dates -> null", WIN({ projectId: 8 }, PROJECTS), null);
eq("W2 project that no longer exists -> null", WIN({ projectId: 404 }, PROJECTS), null);
eq("W3 custom dates when unlinked", WIN({ projectId: null, customStartDate: "2026-09-01", customEndDate: "2026-09-02" }, PROJECTS),
   { start: "2026-09-01", end: "2026-09-02" });
eq("W4 unlinked and half-dated -> null", WIN({ projectId: null, customStartDate: "2026-09-01", customEndDate: "" }, PROJECTS), null);
eq("W5 a linked quote ignores its custom dates", WIN({ projectId: 7, customStartDate: "2026-01-01", customEndDate: "2026-01-02" }, PROJECTS),
   { start: "2026-08-10", end: "2026-08-13" });
eq("W6 null doc -> null", WIN(null, PROJECTS), null);

// ── LTP_sectionRentalWindow ──────────────────────────────────────────────────
const DOCW = { start: "2026-08-10", end: "2026-08-13" };
eq("S0 following section takes the doc window", SEC(sec("a"), DOCW), DOCW);
eq("S1 custom section takes its own", SEC(sec("a", { customDates: true, startDate: "2026-09-01", endDate: "2026-09-02" }), DOCW),
   { start: "2026-09-01", end: "2026-09-02" });
eq("S2 custom but half-filled falls back to the doc", SEC(sec("a", { customDates: true, startDate: "2026-09-01" }), DOCW), DOCW);
eq("S3 no doc window and nothing of its own -> null", SEC(sec("a"), null), null);

// ── LTP_staleRentalSections ──────────────────────────────────────────────────
{
  const q = { projectId: 7, sections: [sec("Lighting", OLD)] };
  eq("T0 a following section priced for the old window is stale", STALE(q, PROJECTS),
     [{ id: "Lighting", label: "Lighting", pricedStart: "2026-08-10", pricedEnd: "2026-08-11" }]);
}
eq("T1 priced for the current window -> in sync", STALE({ projectId: 7, sections: [sec("a", NEW)] }, PROJECTS), []);
eq("T2 a custom-dated section prices on its own window, never stale",
   STALE({ projectId: 7, sections: [sec("a", Object.assign({ customDates: true, startDate: "2026-08-10", endDate: "2026-08-11" }, OLD))] }, PROJECTS), []);
eq("T3 no equipment -> nothing priced by the dates, not stale",
   STALE({ projectId: 7, sections: [sec("a", Object.assign({ items: [SVC] }, OLD))] }, PROJECTS), []);
eq("T4 an empty section is not stale", STALE({ projectId: 7, sections: [sec("a", Object.assign({ items: [] }, OLD))] }, PROJECTS), []);
eq("T5 never stamped -> can't be judged, treated as in sync", STALE({ projectId: 7, sections: [sec("a")] }, PROJECTS), []);
eq("T6 half a stamp is no stamp", STALE({ projectId: 7, sections: [sec("a", { pricedStartDate: "2026-08-10" })] }, PROJECTS), []);
eq("T7 an unlinked quote can't drift (its dates are edited in the builder)",
   STALE({ projectId: null, customStartDate: "2026-08-10", customEndDate: "2026-08-13", sections: [sec("a", OLD)] }, PROJECTS), []);
eq("T8 a project with no dates flags nothing", STALE({ projectId: 8, sections: [sec("a", OLD)] }, PROJECTS), []);
eq("T9 a deleted project flags nothing", STALE({ projectId: 404, sections: [sec("a", OLD)] }, PROJECTS), []);
eq("T10 null doc -> []", STALE(null, PROJECTS), []);
eq("T11 doc without sections -> []", STALE({ projectId: 7 }, PROJECTS), []);
{
  // Mixed quote: only the stale ones come back, in document order, and a
  // section the end date alone moved on counts too.
  const q = { projectId: 7, sections: [
    sec("Labor", Object.assign({ items: [SVC] }, OLD)),
    sec("Lighting", OLD),
    sec("Audio", NEW),
    sec("Video", { pricedStartDate: "2026-08-09", pricedEndDate: "2026-08-13" }),
    sec("Other job", { customDates: true, startDate: "2026-09-01", endDate: "2026-09-02", pricedStartDate: "2026-09-01", pricedEndDate: "2026-09-02" }),
  ] };
  eq("T12 only the stale, following, equipment-bearing sections, in order",
     STALE(q, PROJECTS).map((s) => s.id), ["Lighting", "Video"]);
}
{
  // The two ways out, as the builder applies them, both clear the flag.
  const q = { projectId: 7, sections: [sec("Lighting", OLD)] };
  const bumped = { projectId: 7, sections: [Object.assign({}, q.sections[0], NEW)] };
  eq("T13 'update' (re-priced and re-stamped for the new window) clears it", STALE(bumped, PROJECTS), []);
  const kept = { projectId: 7, sections: [Object.assign({}, q.sections[0], { customDates: true, startDate: "2026-08-10", endDate: "2026-08-11" })] };
  eq("T14 'keep' (old window as the section's own dates) clears it", STALE(kept, PROJECTS), []);
}

// ── LTP_stampRentalWindows ───────────────────────────────────────────────────
{
  const q = { projectId: 7, sections: [sec("a")] };
  const out = STAMP(q, PROJECTS);
  eq("P0 an unstamped following section gets the doc window", [out[0].pricedStartDate, out[0].pricedEndDate], ["2026-08-10", "2026-08-13"]);
  ok("P1 the input section is not mutated", q.sections[0].pricedStartDate === undefined);
  ok("P2 items and label survive the stamp", out[0].label === "a" && out[0].items.length === 1);
}
{
  const custom = sec("a", { customDates: true, startDate: "2026-09-01", endDate: "2026-09-02" });
  const out = STAMP({ projectId: 7, sections: [custom] }, PROJECTS);
  eq("P3 a custom section is stamped with its own window", [out[0].pricedStartDate, out[0].pricedEndDate], ["2026-09-01", "2026-09-02"]);
}
{
  // THE rule that makes the notice survive a save: a stale section is not
  // stamped, so the editor's decision is still pending next time.
  const stale = sec("Lighting", OLD);
  const q = { projectId: 7, sections: [stale, sec("Audio")] };
  const out = STAMP(q, PROJECTS);
  eq("P4 a stale section keeps its old stamp", [out[0].pricedStartDate, out[0].pricedEndDate], ["2026-08-10", "2026-08-11"]);
  ok("P5 ...and is the same object", out[0] === stale);
  eq("P6 its in-sync neighbour is stamped", [out[1].pricedStartDate, out[1].pricedEndDate], ["2026-08-10", "2026-08-13"]);
  eq("P7 the stale one is still reported after the save", STALE({ projectId: 7, sections: out }, PROJECTS).map((s) => s.id), ["Lighting"]);
}
{
  const q = { projectId: 7, sections: [sec("a", NEW), sec("b", Object.assign({ items: [SVC] }, NEW))] };
  ok("P8 nothing to change -> the same array back", STAMP(q, PROJECTS) === q.sections);
}
{
  // A section with no equipment that was priced (well, stamped) for the old
  // window isn't stale — nothing on it is priced by dates — so save simply
  // moves its stamp along.
  const out = STAMP({ projectId: 7, sections: [sec("Labor", Object.assign({ items: [SVC] }, OLD))] }, PROJECTS);
  eq("P9 an equipment-free section's stamp follows the project", [out[0].pricedStartDate, out[0].pricedEndDate], ["2026-08-10", "2026-08-13"]);
}
eq("P10 no window at all -> untouched", STAMP({ projectId: 8, sections: [sec("a")] }, PROJECTS)[0].pricedStartDate, undefined);
eq("P11 unlinked quote stamps its custom dates",
   STAMP({ projectId: null, customStartDate: "2026-09-01", customEndDate: "2026-09-02", sections: [sec("a")] }, PROJECTS)[0].pricedEndDate, "2026-09-02");
eq("P12 null doc -> []", STAMP(null, PROJECTS), []);

// ── LTP_rentalDriftNotice ────────────────────────────────────────────────────
function quote(id, over) {
  return Object.assign({ id: id, createdDate: "2026-08-01", status: "draft", projectId: 7, projectIds: [7], sections: [sec("a")] }, over || {});
}
eq("N0 no quotes -> nothing to say", NOTICE(GALA, []), null);
eq("N1 null project -> null", NOTICE(null, [quote(1)]), null);
{
  const n = NOTICE(GALA, [quote(1)]);
  eq("N2 one draft quote", n.count, 1);
  ok("N3 named by its reference", n.refs[0] === window.LTP_QUOTE_REF(quote(1)) && n.message.indexOf(n.refs[0]) !== -1, n.message);
  ok("N4 singular wording", /^1 quote follows/.test(n.title), n.title);
}
{
  const n = NOTICE(GALA, [quote(1), quote(2, { status: "sent" }), quote(3, { status: "accepted" }),
                          quote(4, { status: "declined" }), quote(5, { status: "converted" })]);
  eq("N5 draft and sent count; accepted, declined, converted don't", n.count, 2);
  ok("N6 plural wording", /^2 quotes follow/.test(n.title), n.title);
}
eq("N7 another project's quote doesn't count", NOTICE(GALA, [quote(1, { projectId: 9, projectIds: [9] })]), null);
eq("N8 a contributor (its work rides on custom-dated sections) doesn't count",
   NOTICE(GALA, [quote(1, { projectId: 9, projectIds: [9, 7] })]), null);
eq("N9 a quote with no equipment following the dates doesn't count",
   NOTICE(GALA, [quote(1, { sections: [sec("a", { items: [SVC] })] })]), null);
eq("N10 a quote whose equipment is all on custom dates doesn't count",
   NOTICE(GALA, [quote(1, { sections: [sec("a", { customDates: true, startDate: "2026-09-01", endDate: "2026-09-02" })] })]), null);
ok("N11 counts a legacy quote with no stamp at all (the person moving the dates deserves the full count)",
   NOTICE(GALA, [quote(1)]) !== null);
ok("N12 the input is never mutated by any helper", (function() {
  const q = quote(1, { sections: [sec("Lighting", OLD), sec("Audio")] });
  const snap = JSON.stringify(q);
  STALE(q, PROJECTS); STAMP(q, PROJECTS); NOTICE(GALA, [q]); WIN(q, PROJECTS); SEC(q.sections[0], DOCW);
  return JSON.stringify(q) === snap;
})());

// ── Report ───────────────────────────────────────────────────────────────────
console.log("rental-drift suite — PASS: " + pass + "   FAIL: " + fail);
if (fail) { fails.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
