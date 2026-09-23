#!/usr/bin/env node
// Labor sync — the helpers behind "Labor is out of sync with the schedule"
// (components/domain-labor-sync.js):
//   * LTP_laborExpected / LTP_laborMarkedLines / LTP_laborHomeSection
//   * LTP_laborDrift / LTP_laborDriftAll  — what differs, per project
//   * LTP_applyLaborSync                   — the ticked changes, nothing else
//   * LTP_keepLaborSync                    — acknowledge without changing money
//   * LTP_laborSyncChanges                 — activity rows
//   * LTP_laborDriftNotice                 — the toast after a schedule save
//   * LTP_laborLinkable / LTP_adoptLaborLines — legacy documents
//   * LTP_laborDifferenceInvoice / LTP_laborDifferenceQty — a sent invoice
//
// WHY THIS SUITE EXISTS
//   A document prices a schedule once; the schedule keeps moving. These
//   helpers decide what differs and change exactly what the producer ticks —
//   never a hand-added line, never a per-line price adjustment, never the
//   rest of the document. A false positive nags on every quote; a false
//   negative is silent under-billing; a wrong apply is silent over-billing.
//   Money is compared to the cent, quantities to 1e-5.
//
// Pure Node, zero deps.
//   Run:  node tests/test_labor_sync.js
"use strict";
const { loadDomain } = require("./_load_domain.js");
loadDomain();

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, got, want) { ok(n, JSON.stringify(got) === JSON.stringify(want), "got " + JSON.stringify(got) + " exp " + JSON.stringify(want)); }

const SECTIONS = window.LTP_scheduleLaborSections;
const DRIFT = window.LTP_laborDrift, DRIFT_ALL = window.LTP_laborDriftAll;
const APPLY = window.LTP_applyLaborSync, KEEP = window.LTP_keepLaborSync, CHANGES = window.LTP_laborSyncChanges;
const NOTICE = window.LTP_laborDriftNotice, LINKABLE = window.LTP_laborLinkable, ADOPT = window.LTP_adoptLaborLines;
const DIFF = window.LTP_laborDifferenceInvoice, DQ = window.LTP_laborDifferenceQty;
["LTP_laborExpected", "LTP_laborMarkedLines", "LTP_laborHomeSection", "LTP_laborDrift", "LTP_laborDriftAll",
 "LTP_applyLaborSync", "LTP_keepLaborSync", "LTP_laborSyncChanges", "LTP_laborDriftNotice", "LTP_laborLinkable",
 "LTP_adoptLaborLines", "LTP_laborDifferenceInvoice", "LTP_laborDifferenceQty"]
  .forEach((k) => ok(k + " is exported", typeof window[k] === "function"));

// ── Fixtures ─────────────────────────────────────────────────────────────────
const SVCS = [
  { id: 1, role: "A1", description: "Audio Lead",         department: "Audio",      dayRate: 600, dayCost: 300 },
  { id: 2, role: "LX", description: "Lighting Tech",      department: "Lighting",   dayRate: 500, dayCost: 250 },
  { id: 3, role: "PM", description: "Production Manager", department: "Production", dayRate: 800, dayCost: 400 },
];
const fmt = (d) => d;
const NOW = "2026-09-23T12:00:00.000Z", LATER = "2026-09-24T12:00:00.000Z";
const MEAL = [{ startTime: "12:00", endTime: "12:30", type: "unpaid" }];
let seq = 0; const gen = (p) => p + "-" + (++seq);
const pos = (id, serviceId, extra) => Object.assign({ id: id, serviceId: serviceId, role: "R", status: "confirmed" }, extra || {});
const day = (id, date, positions) => ({ id: id, date: date, time: "08:00", endTime: "16:00", positions: positions, breaks: MEAL });
function project(schedule, extra) {
  return Object.assign({ id: 42, name: "Summit Keynote", companyId: 7, schedule: schedule, fixedPositions: [] }, extra || {});
}
// A document as Send to Quote leaves it: generated sections stamped with the project.
function docFrom(p, grouping, extra) {
  const secs = SECTIONS(p.schedule, SVCS, {}, grouping || "one", fmt, gen, p.fixedPositions, p.id, NOW)
    .map((s) => Object.assign({}, s, { projectId: p.id }));
  return Object.assign({ id: 3, status: "draft", projectId: p.id, projectIds: [p.id], companyId: 7, clientType: "company", sections: secs }, extra || {});
}
function line(doc, key) {
  for (const s of doc.sections) for (const it of s.items) if (it.laborSync && it.laborSync.key === key) return it;
  return null;
}
function keys(sec) { return sec.items.map((i) => i.laborSync.key); }
function withSections(doc, sections) { return Object.assign({}, doc, { sections: sections }); }
function mapLine(doc, key, patch) {
  return withSections(doc, doc.sections.map((s) => Object.assign({}, s, {
    items: s.items.map((it) => it.laborSync && it.laborSync.key === key ? Object.assign({}, it, patch) : it) })));
}

// Base: A1 on two days, LX on the first.
const S0 = [day("d1", "2026-08-10", [pos("p1", 1), pos("p2", 2)]), day("d2", "2026-08-11", [pos("p3", 1)])];
const P0 = project(S0);
const D0 = docFrom(P0, "one");
const PLUS_DAY = project(S0.concat([day("d3", "2026-08-12", [pos("p4", 1)])]));   // A1 gains a day

// ── In step ──────────────────────────────────────────────────────────────────
{
  eq("S0 read order of the base document", keys(D0.sections[0]), ["svc:2|day", "svc:1|day"]);
  const d = DRIFT(D0, P0, SVCS, {}, fmt);
  eq("S1 a fresh document is in step", [d.projectId, d.count, d.deltaTotal, d.changes], [42, 0, 0, []]);
  ok("S2 apply with nothing ticked hands back the same sections", APPLY(D0, d, [], gen, NOW).sections === D0.sections);
  ok("S3 keep with nothing ticked hands back the same sections", KEEP(D0, d, [], NOW) === D0.sections);
  eq("S4 no document", DRIFT(null, P0, SVCS, {}, fmt).count, 0);
  eq("S5 no project", DRIFT(D0, null, SVCS, {}, fmt).count, 0);
  ok("S6 ticking a key that is not a change is a no-op", APPLY(D0, d, ["svc:1|day"], gen, NOW).sections === D0.sections);
}

// ── A day added: quantity and days move ──────────────────────────────────────
{
  const d = DRIFT(D0, PLUS_DAY, SVCS, {}, fmt);
  eq("C0 one change", d.count, 1);
  const c = d.changes[0];
  eq("C1 the changed row", [c.kind, c.key, c.fields, c.delta, c.handEdited, c.hasAdjustedPrice, c.linked, c.dept],
     ["changed", "svc:1|day", ["qty", "dates"], 600, false, false, false, "Audio"]);
  eq("C2 current vs expected", [c.current.qty, c.expected.qty, c.expected.dates, c.snapDates],
     [2, 3, ["2026-08-10", "2026-08-11", "2026-08-12"], ["2026-08-10", "2026-08-11"]]);
  eq("C3 total effect", d.deltaTotal, 600);
  const a = APPLY(D0, d, ["svc:1|day"], gen, LATER);
  const nl = line({ sections: a.sections }, "svc:1|day");
  eq("C4 the applied line", [nl.qty, nl.unitPrice, nl.cost, nl.notes], [3, 600, 300, "2026-08-10, 2026-08-11, 2026-08-12"]);
  eq("C5 its snapshot follows", [nl.laborSync.snap.qty, nl.laborSync.snap.dates.length, nl.laborSync.at, nl.laborSync.key], [3, 3, LATER, "svc:1|day"]);
  eq("C6 in step afterwards", DRIFT({ sections: a.sections }, PLUS_DAY, SVCS, {}, fmt).count, 0);
  ok("C7 the untouched line keeps its identity", line({ sections: a.sections }, "svc:2|day") === line(D0, "svc:2|day"));
  eq("C8 the input document was not mutated", line(D0, "svc:1|day").qty, 2);
  eq("C9 applied keys are reported", [a.applied, a.removedLinked], [["svc:1|day"], []]);
}

// ── A per-line price adjustment is kept and priced into the delta ────────────
{
  const adj = mapLine(D0, "svc:1|day", { adjustedPrice: 550 });
  const d = DRIFT(adj, PLUS_DAY, SVCS, {}, fmt);
  eq("P0 the delta prices the new quantity at the adjusted price", [d.changes[0].delta, d.changes[0].hasAdjustedPrice], [550, true]);
  const a = APPLY(adj, d, ["svc:1|day"], gen, LATER);
  eq("P1 adjustedPrice survives apply", [line({ sections: a.sections }, "svc:1|day").adjustedPrice, line({ sections: a.sections }, "svc:1|day").unitPrice], [550, 600]);
  // A hand-set taxable flag survives too.
  const tx = mapLine(D0, "svc:1|day", { taxable: false });
  eq("P2 taxable survives apply", line({ sections: APPLY(tx, DRIFT(tx, PLUS_DAY, SVCS, {}, fmt), ["svc:1|day"], gen, LATER).sections }, "svc:1|day").taxable, false);
}

// ── A line edited by hand ────────────────────────────────────────────────────
{
  const hand = mapLine(D0, "svc:1|day", { qty: 1 });
  eq("H0 in step while the schedule has not moved — the edit was the producer's", DRIFT(hand, P0, SVCS, {}, fmt).count, 0);
  const d = DRIFT(hand, PLUS_DAY, SVCS, {}, fmt);
  eq("H1 flagged once the schedule moves", [d.count, d.changes[0].handEdited, d.changes[0].current.qty, d.changes[0].delta], [1, true, 1, 1200]);
  const price = mapLine(D0, "svc:1|day", { unitPrice: 580 });
  eq("H2 a hand-changed price flags too", DRIFT(price, PLUS_DAY, SVCS, {}, fmt).changes[0].handEdited, true);
  const note = mapLine(D0, "svc:1|day", { notes: "as agreed" });
  eq("H3 a rewritten note never counts", DRIFT(note, PLUS_DAY, SVCS, {}, fmt).changes[0].handEdited, false);
}

// ── Keep ─────────────────────────────────────────────────────────────────────
{
  const d = DRIFT(D0, PLUS_DAY, SVCS, {}, fmt);
  const kept = KEEP(D0, d, ["svc:1|day"], LATER);
  const kl = line({ sections: kept }, "svc:1|day");
  eq("K0 keep leaves the billed line alone", [kl.qty, kl.unitPrice, kl.notes], [2, 600, "2026-08-10, 2026-08-11"]);
  eq("K1 keep records the schedule's snapshot", [kl.laborSync.snap.qty, kl.laborSync.snap.dates.length, kl.laborSync.at], [3, 3, LATER]);
  eq("K2 in step after keep", DRIFT({ sections: kept }, PLUS_DAY, SVCS, {}, fmt).count, 0);
  ok("K3 the other line keeps its identity", line({ sections: kept }, "svc:2|day") === line(D0, "svc:2|day"));
  // The schedule moves again: it surfaces again, and the line now reads as
  // hand-edited (it bills 2 while the snapshot says 3).
  const P2 = project(PLUS_DAY.schedule.concat([day("d4", "2026-08-13", [pos("p5", 1)])]));
  const d2 = DRIFT({ sections: kept }, P2, SVCS, {}, fmt);
  eq("K4 surfaces again on the next change, flagged", [d2.count, d2.changes[0].handEdited, d2.changes[0].expected.qty], [1, true, 4]);
}

// ── A role dropped from the schedule ─────────────────────────────────────────
{
  const NO_LX = project([day("d1", "2026-08-10", [pos("p1", 1)]), day("d2", "2026-08-11", [pos("p3", 1)])]);
  const d = DRIFT(D0, NO_LX, SVCS, {}, fmt);
  eq("R0 the removed row", [d.count, d.changes[0].kind, d.changes[0].key, d.changes[0].delta, d.changes[0].expected], [1, "removed", "svc:2|day", -500, null]);
  const a = APPLY(D0, d, ["svc:2|day"], gen, LATER);
  eq("R1 apply removes the line", [line({ sections: a.sections }, "svc:2|day"), a.sections[0].items.length], [null, 1]);
  eq("R2 nothing linked to roll back", a.removedLinked, []);
  const kept = KEEP(D0, d, ["svc:2|day"], LATER);
  eq("R3 keep nulls the snapshot and leaves the line", [line({ sections: kept }, "svc:2|day").qty, line({ sections: kept }, "svc:2|day").laborSync.snap], [1, null]);
  eq("R4 in step after keep", DRIFT({ sections: kept }, NO_LX, SVCS, {}, fmt).count, 0);
  const d2 = DRIFT({ sections: kept }, P0, SVCS, {}, fmt);
  eq("R5 a kept line resurfaces as changed when the schedule produces it again", [d2.count, d2.changes[0].kind, d2.changes[0].fields], [1, "changed", ["qty", "unitPrice", "cost", "dates"]]);
  // Applying a removal keeps ONLY that key's removal: the other line is intact.
  eq("R6 the surviving line is untouched", line({ sections: a.sections }, "svc:1|day"), line(D0, "svc:1|day"));
}

// ── A new role: added in read order; keep → ignored ──────────────────────────
{
  const WITH_PM = project(S0.concat([day("d3", "2026-08-12", [pos("p4", 3)])]));
  const d = DRIFT(D0, WITH_PM, SVCS, {}, fmt);
  const c = d.changes[0];
  eq("N0 the added row", [d.count, c.kind, c.key, c.sectionId, c.delta, c.dept, c.itemId, c.wasIgnored], [1, "added", "svc:3|day", D0.sections[0].id, 800, "Production", null, false]);
  const a = APPLY(D0, d, ["svc:3|day"], gen, LATER);
  eq("N1 inserted in read order (letters-only roles alphabetical, then numbered)", keys(a.sections[0]), ["svc:2|day", "svc:3|day", "svc:1|day"]);
  const nl = a.sections[0].items[1];
  eq("N2 the new line", [nl.type, nl.serviceId, nl.name, nl.rateType, nl.qty, nl.unitPrice, nl.cost, nl.notes, nl.adjustedPrice, nl.deliveredQty, nl.invoicedQty],
     ["service", 3, "PM — Production Manager", "day", 1, 800, 400, "2026-08-12", null, 0, 0]);
  eq("N3 its marker", [nl.laborSync.projectId, nl.laborSync.key, nl.laborSync.at, nl.laborSync.snap.dates], [42, "svc:3|day", LATER, ["2026-08-12"]]);
  ok("N4 the new id is fresh", nl.id !== D0.sections[0].items[0].id && nl.id !== D0.sections[0].items[1].id);
  eq("N5 in step afterwards", DRIFT({ sections: a.sections }, WITH_PM, SVCS, {}, fmt).count, 0);
  const kept = KEEP(D0, d, ["svc:3|day"], LATER);
  eq("N6 keep records the key as ignored on the home section", kept[0].laborSync.ignored["svc:3|day"].qty, 1);
  eq("N7 keep adds no line", kept[0].items.length, 2);
  eq("N8 in step after keep", DRIFT({ sections: kept }, WITH_PM, SVCS, {}, fmt).count, 0);
  const PM_TWICE = project(S0.concat([day("d3", "2026-08-12", [pos("p4", 3)]), day("d4", "2026-08-13", [pos("p5", 3)])]));
  const d2 = DRIFT({ sections: kept }, PM_TWICE, SVCS, {}, fmt);
  eq("N9 an ignored key resurfaces when its values change", [d2.count, d2.changes[0].kind, d2.changes[0].wasIgnored, d2.changes[0].expected.qty], [1, "added", true, 2]);
  const a2 = APPLY({ sections: kept }, d2, ["svc:3|day"], gen, LATER);
  eq("N10 applying drops the ignore", a2.sections[0].laborSync.ignored, {});
  eq("N11 and adds the full line", line({ sections: a2.sections }, "svc:3|day").qty, 2);
}

// ── Department grouping: a new line lands in its department's section ────────
{
  const Dd = docFrom(P0, "split");
  const lighting = Dd.sections.filter((s) => s.laborSync.dept === "Lighting")[0];
  const audio = Dd.sections.filter((s) => s.laborSync.dept === "Audio")[0];
  eq("G0 split document has a section per department", Dd.sections.map((s) => s.laborSync.dept).sort(), ["Audio", "Lighting"]);
  const WITH_PM = project(S0.concat([day("d3", "2026-08-12", [pos("p4", 3)])]));
  eq("G1 no section for the department → the first labor section", DRIFT(Dd, WITH_PM, SVCS, {}, fmt).changes[0].sectionId, Dd.sections[0].id);
  const SV2 = SVCS.concat([{ id: 4, role: "L2", description: "Lighting Tech 2", department: "Lighting", dayRate: 400, dayCost: 200 }]);
  const WITH_L2 = project(S0.concat([day("d3", "2026-08-12", [pos("p4", 4)])]));
  const d = DRIFT(Dd, WITH_L2, SV2, {}, fmt);
  eq("G2 a role lands in its department's section", d.changes[0].sectionId, lighting.id);
  const a = APPLY(Dd, d, ["svc:4|day"], gen, LATER);
  eq("G3 inserted after the department's existing lines", keys(a.sections.filter((s) => s.id === lighting.id)[0]), ["svc:2|day", "svc:4|day"]);
  ok("G4 the other section keeps its identity", a.sections.filter((s) => s.id === audio.id)[0] === audio);
}

// ── No section left for the project → one is created ────────────────────────
{
  const bare = withSections(D0, [{ id: "manual", label: "Extras", items: [{ id: "m1", type: "fee", name: "Travel", qty: 1, unitPrice: 100 }] }]);
  const d = DRIFT(bare, P0, SVCS, {}, fmt);
  eq("E0 everything is an addition", d.changes.map((c) => [c.kind, c.sectionId]), [["added", null], ["added", null]]);
  const a = APPLY(bare, d, ["svc:2|day", "svc:1|day"], gen, LATER, { projectName: "Summit Keynote" });
  eq("E1 a labor section is created after the existing one",
     [a.sections.length, a.sections[1].label, a.sections[1].projectId, a.sections[1].laborSync, a.sections[1].customDates],
     [2, "Labor — Summit Keynote", 42, { projectId: 42, grouping: "one", ignored: {} }, false]);
  eq("E2 both lines in read order", keys(a.sections[1]), ["svc:2|day", "svc:1|day"]);
  ok("E3 the manual section is untouched", a.sections[0] === bare.sections[0]);
  eq("E4 without a project name the label is plain", APPLY(bare, d, ["svc:1|day"], gen, LATER).sections[1].label, "Labor");
}

// ── Manual lines and other sections are never touched ────────────────────────
{
  const mixed = withSections(D0, [
    Object.assign({}, D0.sections[0], { items: D0.sections[0].items.concat([
      { id: "hand", type: "service", serviceId: 1, name: "A1 — Audio Lead", rateType: "day", qty: 5, unitPrice: 600 }]) }),
    { id: "gear", label: "Gear", items: [{ id: "e1", type: "equipment", name: "Mac Aura", qty: 4, unitPrice: 120 }] },
  ]);
  const d = DRIFT(mixed, PLUS_DAY, SVCS, {}, fmt);
  eq("M0 the hand-added A1 line is not part of the diff", d.count, 1);
  const a = APPLY(mixed, d, ["svc:1|day"], gen, LATER);
  eq("M1 the hand-added line is untouched", a.sections[0].items.filter((i) => i.id === "hand")[0].qty, 5);
  ok("M2 the gear section keeps its identity", a.sections[1] === mixed.sections[1]);
  eq("M3 marked lines exclude it", window.LTP_laborMarkedLines(mixed, 42).map((l) => l.item.laborSync.key), ["svc:2|day", "svc:1|day"]);
}

// ── A duplicate section ("append anyway"): only the first copy is tracked ────
{
  const twice = withSections(D0, D0.sections.concat(
    SECTIONS(S0, SVCS, {}, "one", fmt, gen, [], 42, NOW).map((s) => Object.assign({}, s, { projectId: 42 }))));
  const d = DRIFT(twice, PLUS_DAY, SVCS, {}, fmt);
  eq("U0 the duplicate copy is left alone", [d.count, d.changes[0].sectionId], [1, D0.sections[0].id]);
  const a = APPLY(twice, d, ["svc:1|day"], gen, LATER);
  eq("U1 apply touches only the tracked copy", [a.sections[0].items[1].qty, a.sections[1].items[1].qty], [3, 2]);
}

// ── Invoice lines converted from a quote ─────────────────────────────────────
{
  const inv = withSections(D0, D0.sections.map((s) => Object.assign({}, s, {
    items: s.items.map((it) => Object.assign({}, it, { sourceItemId: "q-" + it.id, sourceQuoteId: 9, linkedQty: it.qty })) })));
  const ONE_DAY = project([day("d1", "2026-08-10", [pos("p1", 1), pos("p2", 2)])]);
  const d = DRIFT(inv, ONE_DAY, SVCS, {}, fmt);
  const a = APPLY(inv, d, ["svc:1|day"], gen, LATER);
  const l = line({ sections: a.sections }, "svc:1|day");
  eq("L0 quantity and linkedQty both drop", [d.changes[0].linked, l.qty, l.linkedQty], [true, 1, 1]);
  const a2 = APPLY(inv, DRIFT(inv, PLUS_DAY, SVCS, {}, fmt), ["svc:1|day"], gen, LATER);
  eq("L1 linkedQty never grows", [line({ sections: a2.sections }, "svc:1|day").qty, line({ sections: a2.sections }, "svc:1|day").linkedQty], [3, 2]);
  const NO_LX = project([day("d1", "2026-08-10", [pos("p1", 1)]), day("d2", "2026-08-11", [pos("p3", 1)])]);
  const a3 = APPLY(inv, DRIFT(inv, NO_LX, SVCS, {}, fmt), ["svc:2|day"], gen, LATER);
  eq("L2 a removed linked line queues a rollback", a3.removedLinked,
     [{ quoteId: 9, sourceItemId: "q-" + line(inv, "svc:2|day").id, qty: 1, name: "LX — Lighting Tech" }]);
  const legacy = withSections(inv, inv.sections.map((s) => Object.assign({}, s, {
    items: s.items.map((it) => { const c = Object.assign({}, it); delete c.sourceQuoteId; return c; }) })));
  eq("L3 a line without sourceQuoteId falls back to the document's quote",
     APPLY(legacy, DRIFT(legacy, NO_LX, SVCS, {}, fmt), ["svc:2|day"], gen, LATER, { fallbackQuoteId: 5 }).removedLinked[0].quoteId, 5);
  eq("L4 a quantity that dropped below the link is a direct-bill reduction",
     APPLY(mapLine(inv, "svc:1|day", { qty: 4, linkedQty: 2 }), DRIFT(mapLine(inv, "svc:1|day", { qty: 4, linkedQty: 2 }), PLUS_DAY, SVCS, {}, fmt), ["svc:1|day"], gen, LATER)
       .sections[0].items.filter((i) => i.laborSync.key === "svc:1|day")[0].linkedQty, 2);
}

// ── Rounding and legacy snapshots ────────────────────────────────────────────
{
  const noisy = withSections(D0, D0.sections.map((s) => Object.assign({}, s, { items: s.items.map((it) => Object.assign({}, it, {
    laborSync: Object.assign({}, it.laborSync, { snap: Object.assign({}, it.laborSync.snap, { unitPrice: it.laborSync.snap.unitPrice + 0.004, qty: it.laborSync.snap.qty + 0.000001 }) }) })) })));
  eq("X0 sub-cent and sub-1e-5 noise is not drift", DRIFT(noisy, P0, SVCS, {}, fmt).count, 0);
  const nodates = withSections(D0, D0.sections.map((s) => Object.assign({}, s, { items: s.items.map((it) => Object.assign({}, it, {
    laborSync: Object.assign({}, it.laborSync, { snap: { qty: it.qty, unitPrice: it.unitPrice, cost: it.cost } }) })) })));
  eq("X1 a snapshot without days is not flagged for its days", DRIFT(nodates, P0, SVCS, {}, fmt).count, 0);
  eq("X2 …but still flags a real change, by quantity alone", DRIFT(nodates, PLUS_DAY, SVCS, {}, fmt).changes[0].fields, ["qty"]);
}

// ── The document's client rate card ──────────────────────────────────────────
{
  const RATES = [{ id: 1, clientType: "company", companyId: 7, serviceId: 1, dayRate: 550, active: true }];
  const svcs = window.LTP_servicesForClient(SVCS, RATES, window.LTP_clientRef(D0));
  const d = DRIFT(D0, P0, svcs, {}, fmt);
  eq("CR0 a negotiated rate shows as a price change on the day line", [d.count, d.changes[0].fields, d.changes[0].expected.unitPrice, d.changes[0].delta], [1, ["unitPrice"], 550, -100]);
  const a = APPLY(D0, d, ["svc:1|day"], gen, LATER);
  eq("CR1 apply moves the price, not the quantity", [line({ sections: a.sections }, "svc:1|day").unitPrice, line({ sections: a.sections }, "svc:1|day").qty], [550, 2]);
}

// ── Multi-project documents ──────────────────────────────────────────────────
{
  const PB = project([day("b1", "2026-09-01", [pos("b-p1", 2)])], { id: 43, name: "Riverfront Gala" });
  const both = withSections(D0, D0.sections.concat(
    SECTIONS(PB.schedule, SVCS, {}, "one", fmt, gen, [], 43, NOW).map((s) => Object.assign({}, s, { projectId: 43, label: "Labor — Riverfront Gala" }))));
  eq("MP0 in step for both projects", DRIFT_ALL(both, [P0, PB], SVCS, {}, fmt), []);
  const PB2 = project(PB.schedule.concat([day("b2", "2026-09-02", [pos("b-p2", 2)])]), { id: 43, name: "Riverfront Gala" });
  const all = DRIFT_ALL(both, [P0, PB2], SVCS, {}, fmt);
  eq("MP1 only the moved project reports", all.map((d) => [d.projectId, d.count, d.changes[0].key, d.changes[0].sectionId]), [[43, 1, "svc:2|day", both.sections[1].id]]);
  eq("MP2 an unknown project id is skipped", DRIFT_ALL(both, [P0], SVCS, {}, fmt), []);
  const a = APPLY(both, all[0], ["svc:2|day"], gen, LATER);
  ok("MP3 the other project's section keeps its identity", a.sections[0] === both.sections[0]);
}

// ── Difference-invoice lines are never tracked ───────────────────────────────
{
  const diffDoc = { id: 9, projectId: 42, sections: [{ id: "adj", label: "Labor adjustments", projectId: 42,
    laborSync: { projectId: 42, grouping: "one", ignored: {}, basis: { invoiceId: 3 } },
    items: [{ id: "x", type: "service", serviceId: 1, name: "A1 — Audio Lead", rateType: "day", qty: 1, unitPrice: 600,
              laborSync: { projectId: 42, key: "svc:1|day", at: NOW, snap: null, basis: { invoiceId: 3 } } }] }] };
  eq("B0 basis lines are not marked lines", window.LTP_laborMarkedLines(diffDoc, 42), []);
  eq("B1 a difference invoice reports no drift at all", DRIFT_ALL(diffDoc, [PLUS_DAY], SVCS, {}, fmt), []);
  eq("B2 nor is it linkable", LINKABLE(diffDoc, 42), false);
}

// ── Notice after a schedule save ─────────────────────────────────────────────
{
  const q = Object.assign({}, D0, { id: 12, status: "sent" });
  const locked = Object.assign({}, D0, { id: 13, status: "accepted" });
  const inv = Object.assign({}, D0, { id: 7, status: "sent" });
  const paid = Object.assign({}, D0, { id: 8, status: "paid" });
  const other = Object.assign({}, D0, { id: 14, status: "draft", sections: [] });
  const nt = NOTICE(PLUS_DAY, [q, locked], [inv, paid, other], SVCS, [], [], fmt);
  eq("T0 counts live documents only", [nt.count, nt.changes, nt.refs], [2, 2, [window.LTP_QUOTE_REF(q), window.LTP_INVOICE_REF(inv)]]);
  eq("T1 one line of copy", [nt.title, nt.message], ["Labor out of sync", window.LTP_QUOTE_REF(q) + ", " + window.LTP_INVOICE_REF(inv) + " · 2 changes"]);
  eq("T2 nothing to say when in step", NOTICE(P0, [q], [inv], SVCS, [], [], fmt), null);
  eq("T3 null project", NOTICE(null, [q], [inv], SVCS, [], [], fmt), null);
  // Each document is checked against ITS client's rate card.
  const RATES = [{ id: 1, clientType: "company", companyId: 7, serviceId: 1, dayRate: 550, active: true }];
  const nt2 = NOTICE(P0, [q], [], SVCS, RATES, [], fmt);
  eq("T4 a negotiated rate the document was not priced at counts", [nt2.count, nt2.changes], [1, 1]);
}

// ── Activity rows ────────────────────────────────────────────────────────────
{
  const MOVED = project([day("d1", "2026-08-10", [pos("p1", 1)]), day("d2", "2026-08-11", [pos("p3", 1)]),
                         day("d3", "2026-08-12", [pos("p4", 3)]), day("d4", "2026-08-13", [pos("p5", 1)])]);   // PM new, A1 +1, LX gone
  const d = DRIFT(D0, MOVED, SVCS, {}, fmt);
  eq("W0 three kinds in read order, removals last", d.changes.map((c) => c.kind), ["added", "changed", "removed"]);
  eq("W1 rows for applied and kept changes", CHANGES(d, ["svc:1|day", "svc:3|day"], ["svc:2|day"]), [
    { cat: "PM — Production Manager · Day", detail: "Added ×1 @ $800.00" },
    { cat: "A1 — Audio Lead · Day", detail: "Qty 2 → 3 · Days 2026-08-10, 2026-08-11 → 2026-08-10, 2026-08-11, 2026-08-13" },
    { cat: "LX — Lighting Tech · Day", detail: "Kept (no longer on schedule)" },
  ]);
  eq("W2 kept rows for the other kinds", CHANGES(d, [], ["svc:1|day", "svc:3|day"]).map((r) => r.detail), ["Not added", "Kept ×2 (schedule ×3)"]);
  eq("W3 applied removal", CHANGES(d, ["svc:2|day"], []).map((r) => r.detail), ["Removed"]);
  eq("W4 nothing selected → no rows", CHANGES(d, [], []), []);
  eq("W5 a price change reads as a price", CHANGES(DRIFT(D0, P0, window.LTP_servicesForClient(SVCS, [{ id: 1, clientType: "company", companyId: 7, serviceId: 1, dayRate: 550, active: true }], window.LTP_clientRef(D0)), {}, fmt), ["svc:1|day"], []),
     [{ cat: "A1 — Audio Lead · Day", detail: "Price $600.00 → $550.00" }]);
}

// ── Legacy documents: linkable, adopt ────────────────────────────────────────
{
  const legacy = { id: 20, projectId: 42, status: "draft", sections: [
    { id: "L", label: "Labor", projectId: 42, items: [
      { id: "a", type: "service", serviceId: 2, name: "LX — Lighting Tech", rateType: "day", qty: 1, unitPrice: 500, cost: 250, notes: "Aug 10" },
      { id: "b", type: "service", serviceId: 1, name: "A1 — Audio Lead", rateType: "day", qty: 2, unitPrice: 600, cost: 300, notes: "Aug 10, Aug 11" },
      { id: "c", type: "service", serviceId: 1, name: "A1 — Audio Lead", rateType: "day", qty: 1, unitPrice: 600, cost: 300, notes: "dup" },
      { id: "n", type: "note", text: "Crew parking on site" } ] },
    { id: "G", label: "Gear", items: [{ id: "e", type: "equipment", name: "Mac Aura", qty: 4, unitPrice: 120 }] } ] };
  eq("A0 a legacy document is linkable", LINKABLE(legacy, 42), true);
  eq("A1 a new-style document is not", LINKABLE(D0, 42), false);
  eq("A2 nor a different project", LINKABLE(legacy, 43), false);
  const r = ADOPT(legacy, P0, SVCS, {}, fmt, NOW);
  eq("A3 linked keys", r.linked, ["svc:2|day", "svc:1|day"]);
  eq("A4 the duplicate stays unlinked", r.unlinked, [{ sectionId: "L", itemId: "c", name: "A1 — Audio Lead", reason: "no match" }]);
  eq("A5 snapshot is the line's OWN values, with the schedule's days", r.sections[0].items[1].laborSync,
     { projectId: 42, key: "svc:1|day", at: NOW, snap: { qty: 2, unitPrice: 600, cost: 300, notes: "Aug 10, Aug 11", dates: ["2026-08-10", "2026-08-11"] } });
  eq("A6 the section gets a marker", r.sections[0].laborSync, { projectId: 42, grouping: "one", ignored: {} });
  ok("A7 gear untouched", r.sections[1] === legacy.sections[1]);
  eq("A8 note and duplicate untouched", [r.sections[0].items[2], r.sections[0].items[3]], [legacy.sections[0].items[2], legacy.sections[0].items[3]]);
  eq("A9 no longer linkable", LINKABLE({ projectId: 42, sections: r.sections }, 42), false);
  eq("A10 linked lines are in step with the unchanged schedule", DRIFT({ sections: r.sections }, P0, SVCS, {}, fmt).count, 0);
  // A line whose quantity differs from the schedule shows up on the very next pass.
  const r2 = ADOPT({ projectId: 42, sections: [{ id: "L", label: "Labor", projectId: 42, items: [
    { id: "b", type: "service", serviceId: 1, name: "A1 — Audio Lead", rateType: "day", qty: 1, unitPrice: 600, cost: 300 }] }] }, P0, SVCS, {}, fmt, NOW);
  const d2 = DRIFT({ sections: r2.sections }, P0, SVCS, {}, fmt);
  const a1row = d2.changes.filter((c) => c.key === "svc:1|day")[0];
  eq("A11 a genuine difference shows after linking (and the missing LX line as an addition)",
     [d2.count, d2.changes.map((c) => c.kind), a1row.fields, a1row.handEdited, a1row.current.qty, a1row.expected.qty], [2, ["added", "changed"], ["qty"], false, 1, 2]);
  // Sections without projectId belong to the primary project.
  const older = { id: 21, projectId: 42, sections: [{ id: "L", label: "Labor", items: [{ id: "a", type: "service", serviceId: 2, name: "LX", rateType: "day", qty: 1, unitPrice: 500 }] }] };
  eq("A12 pre-projectId sections count for the primary job", [LINKABLE(older, 42), ADOPT(older, P0, SVCS, {}, fmt, NOW).linked], [true, ["svc:2|day"]]);
  ok("A13 nothing to link → same reference", ADOPT(D0, P0, SVCS, {}, fmt, NOW).sections === D0.sections);
  // Flat lines match on amount too.
  const PF = project(S0, { fixedPositions: [
    { id: "f1", serviceId: 3, role: "PM", crewId: 9, status: "confirmed", fee: 1000, bill: 2000, fullMargin: false },
    { id: "f2", serviceId: 3, role: "PM", crewId: 8, status: "confirmed", fee: 500, bill: 900, fullMargin: false }] });
  const flatDoc = { projectId: 42, sections: [{ id: "L", label: "Labor", projectId: 42, items: [
    { id: "x", type: "service", serviceId: 3, name: "PM — Production Manager", rateType: "flat", qty: 1, unitPrice: 900, cost: 500 }] }] };
  eq("A14 a flat line links by its amount", ADOPT(flatDoc, PF, SVCS, {}, fmt, NOW).linked, ["flat:f2"]);
}

// ── Difference invoice (a sent invoice) ──────────────────────────────────────
{
  const sent = Object.assign({}, D0, { id: 7, status: "sent", terms: "Net 30" });
  const GROWN = project(S0.concat([day("d3", "2026-08-12", [pos("p4", 1)]), day("d4", "2026-08-13", [pos("p5", 3)])]));   // A1 +1 day, PM new
  const d = DRIFT(sent, GROWN, SVCS, {}, fmt);
  eq("DI0 qualifying quantities", d.changes.map((c) => [c.key, DQ(c)]), [["svc:3|day", 1], ["svc:1|day", 1]]);
  const OPTS = { id: 9, shareToken: "tok", today: "2026-09-23", time: "12:00", user: "Jamie", dueDate: "2026-10-23", projectName: "Summit Keynote", sentRef: "INV-7", fmtDate: fmt };
  const r = DIFF(sent, d, ["svc:3|day", "svc:1|day"], gen, LATER, OPTS);
  eq("DI1 the new draft", [r.invoice.id, r.invoice.status, r.invoice.quoteId, r.invoice.companyId, r.invoice.clientType, r.invoice.projectId, r.invoice.projectIds, r.invoice.terms, r.invoice.dueDate, r.invoice.shareToken, r.invoice.payments, r.invoice.globalDiscount],
     [9, "draft", null, 7, "company", 42, [42], "Net 30", "2026-10-23", "tok", [], { type: "none", value: 0 }]);
  eq("DI2 one adjustments section, itself marked as a difference", [r.invoice.sections.length, r.invoice.sections[0].label, r.invoice.sections[0].projectId, r.invoice.sections[0].laborSync],
     [1, "Labor adjustments — Summit Keynote", 42, { projectId: 42, grouping: "one", ignored: {}, basis: { invoiceId: 7 } }]);
  eq("DI3 lines bill only the difference and note the added days", r.lines.map((l) => [l.laborSync.key, l.qty, l.unitPrice, l.cost, l.notes, l.laborSync.basis, l.laborSync.snap]),
     [["svc:3|day", 1, 800, 400, "2026-08-13", { invoiceId: 7 }, null], ["svc:1|day", 1, 600, 300, "2026-08-12", { invoiceId: 7 }, null]]);
  eq("DI4 activity on the new invoice", [r.invoice.activity[0].type, r.invoice.activity[0].user, r.invoice.activity[0].message, r.invoice.activity[0].changes],
     ["created", "Jamie", "Invoice created from schedule changes to INV-7",
      [{ cat: "PM — Production Manager · Day", detail: "Added ×1 @ $800.00" }, { cat: "A1 — Audio Lead · Day", detail: "Added ×1 @ $600.00" }]]);
  const sa = line({ sections: r.sentSections }, "svc:1|day");
  eq("DI5 the sent line's billed fields do not move", [sa.qty, sa.unitPrice, sa.cost, sa.notes], [2, 600, 300, "2026-08-10, 2026-08-11"]);
  eq("DI6 the sent line records the adjustment", [sa.laborSync.snap.qty, sa.laborSync.adjustments], [3, [{ invoiceId: 9, at: LATER, qty: 1 }]]);
  eq("DI7 the new role is recorded as billed elsewhere", [r.sentSections[0].laborSync.ignored["svc:3|day"].invoiceId, r.sentSections[0].laborSync.ignored["svc:3|day"].qty], [9, 1]);
  eq("DI8 sent-invoice activity", [r.sentActivity.type, r.sentActivity.message, r.sentActivity.changes.length], ["updated", "Schedule changes billed on INV-9", 2]);
  eq("DI9 everything was recorded", r.unrecorded, []);
  ok("DI10 the sent invoice's untouched line keeps identity", line({ sections: r.sentSections }, "svc:2|day") === line(sent, "svc:2|day"));
  const after = { sections: r.sentSections };
  eq("DI11 the sent invoice is in step afterwards", DRIFT(after, GROWN, SVCS, {}, fmt).count, 0);
  const AGAIN = project(GROWN.schedule.concat([day("d5", "2026-08-14", [pos("p6", 1)])]));
  const d2 = DRIFT(after, AGAIN, SVCS, {}, fmt);
  eq("DI12 the next change is offered net of the difference invoice", [d2.count, d2.changes[0].key, d2.changes[0].handEdited, d2.changes[0].billedElsewhere, DQ(d2.changes[0]), d2.changes[0].delta],
     [1, "svc:1|day", false, [{ invoiceId: 9, at: LATER, qty: 1 }], 1, 600]);
  const SHUFFLED = project([day("d1", "2026-08-10", [pos("p1", 1)]), day("d3", "2026-08-12", [pos("p4", 1)]), day("d4", "2026-08-13", [pos("p5", 3)])]);   // LX gone, A1 moved a day
  const dx = DRIFT(sent, SHUFFLED, SVCS, {}, fmt);
  eq("DI13 reductions and same-quantity rows never qualify", dx.changes.map((c) => [c.kind, c.key, DQ(c)]), [["added", "svc:3|day", 1], ["changed", "svc:1|day", 0], ["removed", "svc:2|day", 0]]);
  eq("DI14 nothing qualifying → null", DIFF(sent, dx, ["svc:2|day", "svc:1|day"], gen, LATER, OPTS), null);
  eq("DI15 null inputs", [DIFF(null, d, ["svc:1|day"], gen, LATER, OPTS), DIFF(sent, null, ["svc:1|day"], gen, LATER, OPTS)], [null, null]);
  // Recalled afterwards and applied: the billed quantity nets out.
  const a = APPLY(Object.assign({}, after, { status: "draft" }), d2, ["svc:1|day"], gen, LATER);
  eq("DI16 apply after a difference invoice nets the billed quantity", [line({ sections: a.sections }, "svc:1|day").qty, line({ sections: a.sections }, "svc:1|day").laborSync.snap.qty], [3, 4]);
  // A second difference invoice stacks on the first.
  const r2 = DIFF(Object.assign({}, sent, { sections: r.sentSections }), d2, ["svc:1|day"], gen, LATER, Object.assign({}, OPTS, { id: 10 }));
  eq("DI17 a second difference invoice stacks", [r2.lines[0].qty, line({ sections: r2.sentSections }, "svc:1|day").laborSync.adjustments.map((x) => [x.invoiceId, x.qty])], [1, [[9, 1], [10, 1]]]);
  eq("DI18 in step after the second one", DRIFT({ sections: r2.sentSections }, AGAIN, SVCS, {}, fmt).count, 0);
}

// ── A cancellation reaches the document through the review ───────────────────
// Cancelling a booked shift shows up as two rows the producer decides on
// separately: the day line losing that day, and a cancellation line at the
// share. Taking both leaves the document exactly what a fresh send would bill;
// keeping the day line instead is how "cut the labor, still charge the client"
// is recorded.
{
  const P1 = project(S0.map((s) => Object.assign({}, s, { positions: s.positions.map((p) => Object.assign({}, p, { crewId: 5 })) })));
  const doc = docFrom(P1, "one");
  const CP = project(window.LTP_cancelPosition(P1.schedule, "d2", "p3",
    { bill: { mode: "percent", value: 50 }, pay: { mode: "percent", value: 50 } }, SVCS, {}, { at: NOW, by: "t" }));
  const d = DRIFT(doc, CP, SVCS, {}, fmt);
  eq("CX0 two rows: the day comes out, a cancellation goes in", d.changes.map((c) => [c.kind, c.key, c.delta]),
     [["changed", "svc:1|day", -600], ["added", "cancel:p3", 300]]);
  eq("CX1 the added row carries the charge and the note", [d.changes[1].expected.unitPrice, d.changes[1].expected.cost, d.changes[1].expected.notes, d.changes[1].rateType],
     [300, 150, "Cancelled 2026-08-11 · 50% charged", "cancel"]);
  const a = APPLY(doc, d, ["svc:1|day", "cancel:p3"], gen, LATER);
  eq("CX2 taking both leaves what a fresh send would bill",
     a.sections[0].items.map((i) => [i.laborSync.key, i.rateType, i.qty, i.unitPrice, i.cost, i.notes]),
     SECTIONS(CP.schedule, SVCS, {}, "one", fmt, gen, [], 42, NOW)[0].items.map((i) => [i.laborSync.key, i.rateType, i.qty, i.unitPrice, i.cost, i.notes]));
  eq("CX3 in step afterwards", DRIFT({ sections: a.sections }, CP, SVCS, {}, fmt).count, 0);
  // Cut the labor, still charge the client: keep the day line, don't add the charge.
  const kept = KEEP(doc, d, ["svc:1|day", "cancel:p3"], LATER);
  eq("CX4 keeping both leaves the billed day and adds nothing", [line({ sections: kept }, "svc:1|day").qty, line({ sections: kept }, "cancel:p3")], [2, null]);
  eq("CX5 and the notice goes quiet", DRIFT({ sections: kept }, CP, SVCS, {}, fmt).count, 0);
  // Changing the share later surfaces the cancellation line again.
  const CP2 = project(window.LTP_setCancellationShares(CP.schedule, "d2", "p3",
    { bill: { mode: "percent", value: 100 }, pay: { mode: "percent", value: 50 } }, { at: LATER, by: "t" }));
  const d2 = DRIFT({ sections: a.sections }, CP2, SVCS, {}, fmt);
  eq("CX6 a new share reprices the cancellation line", d2.changes.map((c) => [c.key, c.fields, c.expected.unitPrice, c.expected.notes]),
     [["cancel:p3", ["unitPrice"], 600, "Cancelled 2026-08-11 · 100% charged"]]);
  eq("CX7 applying it rewrites the note the client reads", line({ sections: APPLY({ sections: a.sections }, d2, ["cancel:p3"], gen, LATER).sections }, "cancel:p3").notes,
     "Cancelled 2026-08-11 · 100% charged");
}

console.log("labor-sync suite — PASS: " + pass + "   FAIL: " + fail);
if (fail) { fails.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
console.log("All " + pass + " assertions passed.");
