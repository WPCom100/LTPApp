// ── Schedule ↔ document labor sync ───────────────────────────────────────────
//
// A quote or invoice bills a project's labor as a snapshot: LTP_scheduleLaborSections
// (domain-crew.js) prices the schedule once and the lines are then plain
// service items. When the schedule moves afterwards — a day added, a call
// dropped, a role cancelled — nothing here changes on its own. These helpers
// only DESCRIBE the difference between what the schedule produces now and what
// each marked line last recorded, and apply exactly the changes the producer
// ticks. Design and decisions: docs/LABOR_SYNC_PLAN.md.
//
// The memory is the `laborSync` marker every generated line and section
// carries (see the header of LTP_scheduleLaborSections):
//   line.laborSync    { projectId, key, at, snap, adjustments?, basis? }
//   section.laborSync { projectId, grouping, dept?, ignored }
// Three rules hold everywhere below:
//   • a line with no marker is a hand-added line — never read, never written;
//   • a line carrying `basis` is a difference-invoice line (A9) — skipped;
//   • "in sync" means the SNAPSHOT equals the schedule, not the billed values.
//     A producer who kept a line at a different quantity on purpose recorded
//     that decision, and the notice stays quiet until the schedule moves again.
// Money is compared to the cent and quantities to 1e-5 (the precision the rest
// of the app, and QuickBooks, use). Every function is pure and hands back the
// SAME array reference when it changes nothing, so a builder's dirty tracking
// is never tripped by a no-op.
//
// Tests: tests/test_labor_sync.js

var _LS_RATE_LABEL = { day: "Day", half: "Half day", hourly: "Hourly", ot: "OT", flat: "Flat", cancel: "Cancellation" };
var _LS_FIELDS = ["qty", "unitPrice", "cost", "dates"];

function _lsR2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function _lsR5(n) { return Math.round((Number(n) || 0) * 1e5) / 1e5; }
function _lsEff(it) { return it.adjustedPrice != null ? (Number(it.adjustedPrice) || 0) : (Number(it.unitPrice) || 0); }
function _lsSum(list, k) { return (list || []).reduce(function(s, a) { return s + (Number(a && a[k]) || 0); }, 0); }
function _lsSorted(a) { return (a || []).slice().sort(); }
// Unknown days (a snapshot written without them) are never a reason to flag.
function _lsSameDates(a, b) { return a == null || JSON.stringify(_lsSorted(a)) === JSON.stringify(_lsSorted(b)); }
function _lsKeySet(keys) {
  var s = {};
  if (Array.isArray(keys)) keys.forEach(function(k) { s[k] = true; });
  else if (keys && typeof keys === "object") Object.keys(keys).forEach(function(k) { if (keys[k]) s[k] = true; });
  return s;
}
function _lsMarkedFor(item, projectId) {
  var m = item && item.laborSync;
  return !!(m && m.key && m.projectId === projectId && !m.basis);
}
// A difference invoice's own section carries `basis` too, so neither its lines
// nor its section ever count as the project's tracked labor.
function _lsSectionFor(sec, projectId) {
  return !!(sec && sec.laborSync && sec.laborSync.projectId === projectId && !sec.laborSync.basis);
}
function _lsAdjQty(item) { return _lsR5(_lsSum(item && item.laborSync && item.laborSync.adjustments, "qty")); }
// What a generated line says the schedule produced: its fields plus the ISO
// days its own marker recorded.
function _lsSnapOfLine(it) {
  return { qty: _lsR5(it.qty), unitPrice: _lsR2(it.unitPrice), cost: _lsR2(it.cost), notes: it.notes || "",
           dates: _lsSorted(it.laborSync && it.laborSync.snap && it.laborSync.snap.dates) };
}
function _lsCloneSnap(s) {
  return { qty: _lsR5(s.qty), unitPrice: _lsR2(s.unitPrice), cost: _lsR2(s.cost), notes: s.notes || "", dates: _lsSorted(s.dates) };
}
function _lsCur(it) {
  return { qty: _lsR5(it.qty), unitPrice: _lsR2(it.unitPrice), adjustedPrice: it.adjustedPrice != null ? _lsR2(it.adjustedPrice) : null,
           cost: _lsR2(it.cost), notes: it.notes || "" };
}
// Which of a snapshot's fields differ from what the schedule produces now. A
// missing snapshot (never recorded, or null = "kept after the schedule dropped
// it") differs in everything.
function _lsDiffFields(snap, eSnap) {
  if (!snap) return _LS_FIELDS.slice();
  var f = [];
  if (_lsR5(snap.qty) !== eSnap.qty) f.push("qty");
  if (_lsR2(snap.unitPrice) !== eSnap.unitPrice) f.push("unitPrice");
  if (_lsR2(snap.cost) !== eSnap.cost) f.push("cost");
  if (!_lsSameDates(snap.dates, eSnap.dates)) f.push("dates");
  return f;
}
// A line the producer changed by hand since the last sync: what it bills (plus
// whatever was billed for it on a difference invoice) is not what the schedule
// said. Notes are free text and never count.
function _lsHandEdited(it) {
  var snap = it.laborSync && it.laborSync.snap;
  if (!snap) return false;
  return _lsR5((Number(it.qty) || 0) + _lsAdjQty(it)) !== _lsR5(snap.qty)
      || _lsR2(it.unitPrice) !== _lsR2(snap.unitPrice)
      || _lsR2(it.cost) !== _lsR2(snap.cost);
}
function _lsRoleParts(name) {
  var s = String(name || ""), i = s.indexOf(" — ");
  return i === -1 ? { role: s, description: "" } : { role: s.slice(0, i), description: s.slice(i + 3) };
}
// Read order among labor lines (letters-only roles, then numbered; flat, day,
// half, hourly, OT, cancellation) — the generator's own order, so an inserted
// line lands where a regenerated document would have put it.
function _lsCmp(a, b) {
  var pa = _lsRoleParts(a.name), pb = _lsRoleParts(b.name);
  return window.LTP_compareLaborLines({ role: pa.role, description: pa.description, rateType: a.rateType },
                                      { role: pb.role, description: pb.description, rateType: b.rateType });
}
function _lsIndexOfSection(sections, id) {
  for (var i = 0; i < sections.length; i++) if (sections[i] && sections[i].id === id) return i;
  return -1;
}
function _lsIndexOfItem(items, id) {
  for (var i = 0; i < items.length; i++) if (items[i] && items[i].id === id) return i;
  return -1;
}
// Copy-on-write over a sections array: the first write to a section replaces
// it (and its items array) with a copy; untouched sections keep their identity.
function _lsWriter(sections) {
  var out = sections.slice(), touched = {};
  return {
    out: out,
    section: function(i) {
      if (!touched[i]) { out[i] = Object.assign({}, out[i], { items: (out[i].items || []).slice() }); touched[i] = true; }
      return out[i];
    },
    push: function(sec) { out.push(sec); touched[out.length - 1] = true; return out.length - 1; },
    changed: function() { return Object.keys(touched).length > 0; },
  };
}
function _lsMoney(n) { return window.LTP_money ? window.LTP_money(n) : String(_lsR2(n)); }
function _lsCat(c) { return (c.name || "") + " · " + (_LS_RATE_LABEL[c.rateType] || c.rateType || ""); }

// What the schedule produces now, keyed the way the document's lines are.
// `svcs` must be the DOCUMENT's client-resolved rate card (LTP_servicesForClient)
// so a negotiated rate is what gets compared. Returns { byKey, order }; order
// is the generator's read order.
window.LTP_laborExpected = function(project, svcs, crewMins, fmtDate, nowIso) {
  var byKey = {}, order = [];
  if (!project) return { byKey: byKey, order: order };
  var secs = window.LTP_scheduleLaborSections(project.schedule, svcs, crewMins, "one", fmtDate, window.LTP_genId,
                                              project.fixedPositions, project.id, nowIso);
  ((secs[0] && secs[0].items) || []).forEach(function(it) {
    var k = it.laborSync && it.laborSync.key;
    if (!k || byKey[k]) return;
    byKey[k] = it; order.push(k);
  });
  return { byKey: byKey, order: order };
};

// The document's lines that belong to this project's schedule, in document
// order: [{ sectionId, section, item }]. Difference-invoice lines are excluded.
window.LTP_laborMarkedLines = function(doc, projectId) {
  var out = [];
  ((doc && doc.sections) || []).forEach(function(sec) {
    ((sec && sec.items) || []).forEach(function(it) {
      if (_lsMarkedFor(it, projectId)) out.push({ sectionId: sec.id, section: sec, item: it });
    });
  });
  return out;
};

// The keys the producer chose not to add, across every marked section for the
// project: { key: snapshot }. A snapshot carrying `invoiceId` was billed on a
// difference invoice instead.
function _lsIgnored(doc, projectId) {
  var m = {};
  ((doc && doc.sections) || []).forEach(function(sec) {
    if (!_lsSectionFor(sec, projectId)) return;
    var ig = sec.laborSync.ignored || {};
    Object.keys(ig).forEach(function(k) { if (!m[k]) m[k] = ig[k]; });
  });
  return m;
}

// Where a NEW line for the project lands: the section marked for its
// department when the document was split by department, else the project's
// single labor section, else (legacy: lines linked but no section marker) the
// first section holding one of the project's lines. null = none, and the
// caller creates one.
window.LTP_laborHomeSection = function(doc, projectId, dept) {
  var secs = (doc && doc.sections) || [];
  var marked = secs.filter(function(s) { return _lsSectionFor(s, projectId); });
  if (marked.length) {
    if (dept) {
      var byDept = marked.filter(function(s) { return s.laborSync.grouping === "dept" && s.laborSync.dept === dept; })[0];
      if (byDept) return byDept;
    }
    return marked.filter(function(s) { return s.laborSync.grouping !== "dept"; })[0] || marked[0];
  }
  return secs.filter(function(s) {
    return s && (s.items || []).some(function(it) { return _lsMarkedFor(it, projectId); });
  })[0] || null;
};

// The difference between the schedule and the document, for one project:
//   { projectId, count, deltaTotal, changes: [change] }
//   change = { kind: "changed"|"added"|"removed", key, sectionId, itemId, name,
//              rateType, serviceId, dept, current, expected, snapDates, fields,
//              delta, handEdited, hasAdjustedPrice, linked, billedElsewhere,
//              wasIgnored }
//   delta is the effect on the document's adjusted total if this one change
//   is applied (a per-line price adjustment is kept, so it prices the new
//   quantity). A zero count means the document is in step — which includes
//   lines the producer kept on purpose.
window.LTP_laborDrift = function(doc, project, svcs, crewMins, fmtDate) {
  var pid = project ? project.id : null;
  if (!doc || !project) return { projectId: pid, count: 0, deltaTotal: 0, changes: [] };
  var exp = window.LTP_laborExpected(project, svcs, crewMins, fmtDate);
  var svcById = {};
  (svcs || []).forEach(function(s) { if (s) svcById[s.id] = s; });
  function deptOf(serviceId) { return (svcById[serviceId] && svcById[serviceId].department) || "Other"; }
  var lines = window.LTP_laborMarkedLines(doc, pid);
  // The first line for a key is the tracked one; a duplicate (a second
  // "append anyway" of the same schedule) is left alone like a manual line.
  var curByKey = {};
  lines.forEach(function(l) { var k = l.item.laborSync.key; if (!curByKey[k]) curByKey[k] = l; });
  var ignored = _lsIgnored(doc, pid);
  var changes = [];

  exp.order.forEach(function(k) {
    var e = exp.byKey[k], eSnap = _lsSnapOfLine(e);
    var cur = curByKey[k];
    if (cur) {
      var it = cur.item, snap = it.laborSync.snap;
      var fields = _lsDiffFields(snap, eSnap);
      if (!fields.length) return;
      var newQty = Math.max(0, _lsR5(eSnap.qty - _lsAdjQty(it)));
      var before = _lsR2((Number(it.qty) || 0) * _lsEff(it));
      var after = _lsR2(newQty * (it.adjustedPrice != null ? _lsEff(it) : eSnap.unitPrice));
      changes.push({ kind: "changed", key: k, sectionId: cur.sectionId, itemId: it.id, name: it.name, rateType: it.rateType,
                     serviceId: it.serviceId, dept: deptOf(it.serviceId), current: _lsCur(it), expected: eSnap,
                     snapDates: snap && snap.dates != null ? _lsSorted(snap.dates) : null, fields: fields,
                     delta: _lsR2(after - before), handEdited: _lsHandEdited(it), hasAdjustedPrice: it.adjustedPrice != null,
                     linked: !!it.sourceItemId, billedElsewhere: (it.laborSync.adjustments || []).slice(), wasIgnored: false });
      return;
    }
    var ig = ignored[k];
    if (ig && !_lsDiffFields(ig, eSnap).length) return;   // still exactly what the producer declined
    var billed = ig && ig.invoiceId != null ? [{ invoiceId: ig.invoiceId, qty: _lsR5(ig.qty) }] : [];
    var addQty = Math.max(0, _lsR5(eSnap.qty - _lsSum(billed, "qty")));
    var home = window.LTP_laborHomeSection(doc, pid, deptOf(e.serviceId));
    changes.push({ kind: "added", key: k, sectionId: home ? home.id : null, itemId: null, name: e.name, rateType: e.rateType,
                   serviceId: e.serviceId, dept: deptOf(e.serviceId), current: null, expected: eSnap,
                   snapDates: ig && ig.dates != null ? _lsSorted(ig.dates) : null, fields: _LS_FIELDS.slice(),
                   delta: _lsR2(addQty * eSnap.unitPrice), handEdited: false, hasAdjustedPrice: false, linked: false,
                   billedElsewhere: billed, wasIgnored: !!ig });
  });

  lines.forEach(function(l) {
    var it = l.item, k = it.laborSync.key;
    if (exp.byKey[k] || curByKey[k] !== l) return;   // still on the schedule, or a duplicate of a tracked line
    if (it.laborSync.snap === null) return;          // kept after the schedule dropped it
    changes.push({ kind: "removed", key: k, sectionId: l.sectionId, itemId: it.id, name: it.name, rateType: it.rateType,
                   serviceId: it.serviceId, dept: deptOf(it.serviceId), current: _lsCur(it), expected: null,
                   snapDates: it.laborSync.snap && it.laborSync.snap.dates != null ? _lsSorted(it.laborSync.snap.dates) : null,
                   fields: [], delta: _lsR2(-((Number(it.qty) || 0) * _lsEff(it))), handEdited: _lsHandEdited(it),
                   hasAdjustedPrice: it.adjustedPrice != null, linked: !!it.sourceItemId,
                   billedElsewhere: (it.laborSync.adjustments || []).slice(), wasIgnored: false });
  });

  return { projectId: pid, count: changes.length, deltaTotal: _lsR2(_lsSum(changes, "delta")), changes: changes };
};

// One drift per project the document carries labor for (multi-project
// documents), only those with something to show.
window.LTP_laborDriftAll = function(doc, projects, svcs, crewMins, fmtDate) {
  var ids = {};
  ((doc && doc.sections) || []).forEach(function(sec) {
    if (sec && sec.laborSync && sec.laborSync.projectId != null && !sec.laborSync.basis) ids[sec.laborSync.projectId] = true;
    ((sec && sec.items) || []).forEach(function(it) {
      if (it && it.laborSync && it.laborSync.projectId != null && !it.laborSync.basis) ids[it.laborSync.projectId] = true;
    });
  });
  var out = [];
  Object.keys(ids).forEach(function(id) {
    var project = (projects || []).filter(function(p) { return p && String(p.id) === id; })[0];
    if (!project) return;
    var d = window.LTP_laborDrift(doc, project, svcs, crewMins, fmtDate);
    if (d.count) out.push(d);
  });
  return out;
};

// A line built from an expected snapshot — what "Apply" inserts for an added
// key. Anything already billed for the key on a difference invoice is netted
// out of the quantity and carried as an adjustment, so the accounting survives
// a recalled invoice.
function _lsBuildLine(c, pid, gen, now) {
  var billed = _lsR5(_lsSum(c.billedElsewhere, "qty"));
  var line = { id: gen("item"), type: "service", serviceId: c.serviceId, name: c.name, rateType: c.rateType,
               qty: Math.max(0, _lsR5(c.expected.qty - billed)), unitPrice: c.expected.unitPrice, adjustedPrice: null,
               cost: c.expected.cost, notes: c.expected.notes, deliveredQty: 0, invoicedQty: 0,
               laborSync: { projectId: pid, key: c.key, at: now, snap: _lsCloneSnap(c.expected) } };
  if (billed > 0) {
    line.laborSync.adjustments = (c.billedElsewhere || []).map(function(a) { return { invoiceId: a.invoiceId, at: now, qty: _lsR5(a.qty) }; });
  }
  return line;
}
// Insert among the section's marked lines in read order; after the last of
// them when it sorts last; at the end of a section with none.
function _lsInsertIndex(items, line, pid) {
  var last = -1;
  for (var i = 0; i < items.length; i++) {
    if (!_lsMarkedFor(items[i], pid)) continue;
    if (_lsCmp(line, items[i]) < 0) return i;
    last = i;
  }
  return last === -1 ? items.length : last + 1;
}
function _lsDropIgnored(w, pid, key) {
  w.out.forEach(function(sec, i) {
    if (!_lsSectionFor(sec, pid) || !sec.laborSync.ignored || !(key in sec.laborSync.ignored)) return;
    var s = w.section(i);
    var ig = Object.assign({}, s.laborSync.ignored); delete ig[key];
    s.laborSync = Object.assign({}, s.laborSync, { ignored: ig });
  });
}

// Apply the ticked changes. Only qty / unitPrice / cost / notes move on a
// changed line; adjustedPrice, taxable, name and the delivered ledger stay.
// An invoice line converted from a quote keeps the linkedQty rule the invoice
// builder applies to a manual edit (linked never grows; qty above it is a
// direct bill), and a removed linked line comes back in `removedLinked` in the
// shape the builder's pendingRollbacks expects. opts: { projectName,
// fallbackQuoteId }. Returns { sections, removedLinked, applied }; `sections`
// is the input reference when nothing was ticked.
window.LTP_applyLaborSync = function(doc, drift, selectedKeys, genId, nowIso, opts) {
  var gen = genId || window.LTP_genId, now = nowIso || new Date().toISOString();
  opts = opts || {};
  var sections = (doc && doc.sections) || [];
  var sel = _lsKeySet(selectedKeys);
  var picked = ((drift && drift.changes) || []).filter(function(c) { return sel[c.key]; });
  if (!picked.length) return { sections: sections, removedLinked: [], applied: [] };
  var pid = drift.projectId;
  var w = _lsWriter(sections);
  var removedLinked = [], applied = [];
  var created = -1;   // the section made for added lines when the project had none left; shared by all of them

  picked.forEach(function(c) {
    if (c.kind === "changed") {
      var si = _lsIndexOfSection(w.out, c.sectionId);
      if (si === -1) return;
      var sec = w.section(si), ii = _lsIndexOfItem(sec.items, c.itemId);
      if (ii === -1) return;
      var it = sec.items[ii];
      var newQty = Math.max(0, _lsR5(c.expected.qty - _lsAdjQty(it)));
      var patch = { qty: newQty, unitPrice: c.expected.unitPrice, cost: c.expected.cost, notes: c.expected.notes,
                    laborSync: Object.assign({}, it.laborSync, { at: now, snap: _lsCloneSnap(c.expected) }) };
      if (it.sourceItemId) {
        var oldLinked = it.linkedQty != null ? (Number(it.linkedQty) || 0) : (Number(it.qty) || 0);
        patch.linkedQty = Math.min(newQty, oldLinked);
      }
      sec.items[ii] = Object.assign({}, it, patch);
      applied.push(c.key);
    } else if (c.kind === "removed") {
      var rsi = _lsIndexOfSection(w.out, c.sectionId);
      if (rsi === -1) return;
      var rsec = w.section(rsi), rii = _lsIndexOfItem(rsec.items, c.itemId);
      if (rii === -1) return;
      var gone = rsec.items[rii];
      if (gone.sourceItemId) {
        removedLinked.push({ quoteId: gone.sourceQuoteId != null ? gone.sourceQuoteId : (opts.fallbackQuoteId != null ? opts.fallbackQuoteId : null),
                             sourceItemId: gone.sourceItemId,
                             qty: gone.linkedQty != null ? (Number(gone.linkedQty) || 0) : (Number(gone.qty) || 0),
                             name: gone.name || "" });
      }
      rsec.items.splice(rii, 1);
      applied.push(c.key);
    } else if (c.kind === "added") {
      var hi = c.sectionId != null ? _lsIndexOfSection(w.out, c.sectionId) : -1;
      if (hi === -1) hi = created;
      if (hi === -1) {
        hi = created = w.push({ id: gen("sec"), label: opts.projectName ? window.LTP_projectSectionLabel("Labor", opts.projectName) : "Labor",
                                customDates: false, startDate: "", endDate: "", projectId: pid,
                                laborSync: { projectId: pid, grouping: "one", ignored: {} }, items: [] });
      }
      var home = w.section(hi);
      var line = _lsBuildLine(c, pid, gen, now);
      home.items.splice(_lsInsertIndex(home.items, line, pid), 0, line);
      _lsDropIgnored(w, pid, c.key);
      applied.push(c.key);
    }
  });
  return { sections: w.changed() ? w.out : sections, removedLinked: removedLinked, applied: applied };
};

// Acknowledge the ticked changes without changing what is billed: a changed
// line's snapshot becomes the schedule's current output, a removed line's
// becomes null, and an added key is recorded as ignored on its home section
// (a legacy home with no marker gets one). Returns the sections array — the
// input reference when nothing changed.
window.LTP_keepLaborSync = function(doc, drift, keys, nowIso) {
  var now = nowIso || new Date().toISOString();
  var sections = (doc && doc.sections) || [];
  var sel = _lsKeySet(keys);
  var picked = ((drift && drift.changes) || []).filter(function(c) { return sel[c.key]; });
  if (!picked.length) return sections;
  var pid = drift.projectId;
  var w = _lsWriter(sections);
  picked.forEach(function(c) {
    if (c.kind === "added") {
      var home = window.LTP_laborHomeSection({ sections: w.out }, pid, c.dept);
      if (!home) return;
      var hi = _lsIndexOfSection(w.out, home.id);
      var s = w.section(hi);
      var marker = s.laborSync || { projectId: pid, grouping: "one", ignored: {} };
      var ig = Object.assign({}, marker.ignored || {});
      ig[c.key] = _lsCloneSnap(c.expected);
      s.laborSync = Object.assign({}, marker, { ignored: ig });
      return;
    }
    var si = _lsIndexOfSection(w.out, c.sectionId);
    if (si === -1) return;
    var sec = w.section(si), ii = _lsIndexOfItem(sec.items, c.itemId);
    if (ii === -1) return;
    var it = sec.items[ii];
    sec.items[ii] = Object.assign({}, it, {
      laborSync: Object.assign({}, it.laborSync, { at: now, snap: c.kind === "removed" ? null : _lsCloneSnap(c.expected) }),
    });
  });
  return w.changed() ? w.out : sections;
};

// Activity rows for what a review did: [{ cat, detail }], one per applied or
// kept change, in the drift's order.
window.LTP_laborSyncChanges = function(drift, appliedKeys, keptKeys) {
  var ap = _lsKeySet(appliedKeys), kp = _lsKeySet(keptKeys);
  var rows = [];
  ((drift && drift.changes) || []).forEach(function(c) {
    var applied = !!ap[c.key], kept = !applied && !!kp[c.key];
    if (!applied && !kept) return;
    var detail;
    if (applied && c.kind === "changed") {
      var parts = [];
      if (c.fields.indexOf("qty") !== -1) parts.push("Qty " + c.current.qty + " → " + c.expected.qty);
      if (c.fields.indexOf("unitPrice") !== -1) parts.push("Price $" + _lsMoney(c.current.unitPrice) + " → $" + _lsMoney(c.expected.unitPrice));
      if (c.fields.indexOf("cost") !== -1) parts.push("Cost $" + _lsMoney(c.current.cost) + " → $" + _lsMoney(c.expected.cost));
      if (c.fields.indexOf("dates") !== -1 && c.current.notes !== c.expected.notes) parts.push("Days " + c.current.notes + " → " + c.expected.notes);
      detail = parts.join(" · ") || "Synced";
    } else if (applied && c.kind === "added") {
      detail = "Added ×" + c.expected.qty + " @ $" + _lsMoney(c.expected.unitPrice);
    } else if (applied) {
      detail = "Removed";
    } else if (c.kind === "changed") {
      detail = "Kept ×" + c.current.qty + " (schedule ×" + c.expected.qty + ")";
    } else if (c.kind === "removed") {
      detail = "Kept (no longer on schedule)";
    } else {
      detail = "Not added";
    }
    rows.push({ cat: _lsCat(c), detail: detail });
  });
  return rows;
};

// What to tell whoever just saved a schedule: which live documents now differ
// from it. Draft and sent quotes, and invoices that are not paid. Each
// document is checked against ITS client's rate card. Returns null when there
// is nothing to say, else { count, refs, changes, title, message } for a toast.
window.LTP_laborDriftNotice = function(project, quotes, invoices, services, clientRates, contacts, fmtDate) {
  if (!project) return null;
  var crewMins = window.LTP_crewMinMap(contacts);
  var hits = [];
  function check(doc, ref) {
    var svcs = window.LTP_servicesForClient(services, clientRates, window.LTP_clientRef(doc));
    var d = window.LTP_laborDrift(doc, project, svcs, crewMins, fmtDate);
    if (d.count) hits.push({ ref: ref, count: d.count });
  }
  (quotes || []).forEach(function(q) {
    if (!q || (q.status !== "draft" && q.status !== "sent")) return;
    if (!window.LTP_laborMarkedLines(q, project.id).length) return;
    check(q, window.LTP_QUOTE_REF(q));
  });
  (invoices || []).forEach(function(inv) {
    if (!inv || inv.status === "paid") return;
    if (!window.LTP_laborMarkedLines(inv, project.id).length) return;
    check(inv, window.LTP_INVOICE_REF(inv));
  });
  if (!hits.length) return null;
  var n = _lsSum(hits, "count");
  return { count: hits.length, refs: hits.map(function(h) { return h.ref; }), changes: n,
           title: "Labor out of sync",
           message: hits.map(function(h) { return h.ref; }).join(", ") + " · " + n + (n === 1 ? " change" : " changes") };
};

// ── Legacy documents ─────────────────────────────────────────────────────────
// Documents from before the marker existed hold schedule lines with no memory.
// They are linked once, explicitly, and only when nothing on the document is
// marked for the project yet — a document created after the marker shipped
// never sees this (decision 13).
function _lsLegacySections(doc, projectId) {
  return ((doc && doc.sections) || []).filter(function(s) {
    if (!s) return false;
    if (s.projectId != null) return s.projectId === projectId;
    return doc.projectId === projectId;   // pre-projectId sections belong to the primary job
  });
}
window.LTP_laborLinkable = function(doc, projectId) {
  if (!doc || projectId == null) return false;
  if (window.LTP_laborMarkedLines(doc, projectId).length) return false;
  if ((doc.sections || []).some(function(s) { return _lsSectionFor(s, projectId); })) return false;
  return _lsLegacySections(doc, projectId).some(function(s) {
    return (s.items || []).some(function(it) { return it && it.type === "service" && !it.laborSync; });
  });
};
// Match unmarked service lines to the schedule by role + rate type (a flat
// line also by its amount) and stamp them with a snapshot of THEIR OWN values,
// so the next drift pass shows the genuine differences for review. Anything
// with no match or more than one candidate stays unmarked and is reported.
// Returns { sections, linked: [key], unlinked: [{ sectionId, itemId, name,
// reason }] }; `sections` is the input reference when nothing linked.
window.LTP_adoptLaborLines = function(doc, project, svcs, crewMins, fmtDate, nowIso) {
  var now = nowIso || new Date().toISOString();
  var sections = (doc && doc.sections) || [];
  if (!project) return { sections: sections, linked: [], unlinked: [] };
  var pid = project.id;
  var exp = window.LTP_laborExpected(project, svcs, crewMins, fmtDate);
  var claimed = {}, linked = [], unlinked = [];
  var w = _lsWriter(sections);
  _lsLegacySections(doc, pid).forEach(function(sec) {
    var si = _lsIndexOfSection(sections, sec.id);
    (sec.items || []).forEach(function(it, j) {
      if (!it || it.type !== "service" || it.laborSync) return;
      var matches = exp.order.filter(function(k) {
        var e = exp.byKey[k];
        return !claimed[k] && e.serviceId === it.serviceId && e.rateType === it.rateType
            && (e.rateType !== "flat" || _lsR2(e.unitPrice) === _lsR2(it.unitPrice));
      });
      if (matches.length !== 1) {
        unlinked.push({ sectionId: sec.id, itemId: it.id, name: it.name || "", reason: matches.length ? "ambiguous" : "no match" });
        return;
      }
      var k = matches[0];
      claimed[k] = true;
      var s = w.section(si);
      s.items[j] = Object.assign({}, it, { laborSync: { projectId: pid, key: k, at: now,
        snap: { qty: _lsR5(it.qty), unitPrice: _lsR2(it.unitPrice), cost: _lsR2(it.cost), notes: it.notes || "",
                dates: _lsSorted(exp.byKey[k].laborSync.snap.dates) } } });
      if (!s.laborSync) s.laborSync = { projectId: pid, grouping: "one", ignored: {} };
      linked.push(k);
    });
  });
  return { sections: w.changed() ? w.out : sections, linked: linked, unlinked: unlinked };
};

// ── Difference invoice (A9) ──────────────────────────────────────────────────
// A sent invoice cannot be edited; what the schedule ADDED is billed on a new
// draft invoice instead. Only rows whose quantity went up (net of anything
// already billed for the key elsewhere) or that are new lines qualify — the
// app has no negative lines, so a reduction is a recall or a credit memo.
window.LTP_laborDifferenceQty = function(c) {
  if (!c || !c.expected) return 0;
  var billed = _lsSum(c.billedElsewhere, "qty");
  var have = c.kind === "changed" ? (Number(c.current.qty) || 0) + billed : (c.kind === "added" ? billed : Infinity);
  var dq = _lsR5(c.expected.qty - have);
  return dq > 0 ? dq : 0;
};
// Build the new draft and the sent invoice's updated sections. opts carries
// what only the builder knows: { id, shareToken, today, time, user, dueDate,
// projectName, sentRef, notes, terms, fmtDate }. Returns null when nothing
// ticked qualifies, else { invoice, sentSections, sentActivity, lines,
// unrecorded } — `unrecorded` lists keys whose billing could not be written
// back on the sent invoice (no section to hold the record).
window.LTP_laborDifferenceInvoice = function(sent, drift, selectedKeys, genId, nowIso, opts) {
  var gen = genId || window.LTP_genId, now = nowIso || new Date().toISOString();
  opts = opts || {};
  if (!sent || !drift) return null;
  var sel = _lsKeySet(selectedKeys), pid = drift.projectId;
  var rows = (drift.changes || []).filter(function(c) { return sel[c.key] && window.LTP_laborDifferenceQty(c) > 0; });
  if (!rows.length) return null;
  var fmt = opts.fmtDate || function(d) { return d; };
  var newId = opts.id != null ? opts.id : null;

  var lines = rows.map(function(c) {
    var dq = window.LTP_laborDifferenceQty(c);
    var known = c.snapDates || [];
    var added = (c.expected.dates || []).filter(function(d) { return known.indexOf(d) === -1; });
    return { id: gen("item"), type: "service", serviceId: c.serviceId, name: c.name, rateType: c.rateType,
             qty: dq, unitPrice: c.expected.unitPrice, adjustedPrice: null, cost: c.expected.cost,
             notes: added.length ? added.map(fmt).join(", ") : c.expected.notes,
             deliveredQty: 0, invoicedQty: 0,
             laborSync: { projectId: pid, key: c.key, at: now, snap: null, basis: { invoiceId: sent.id } } };
  });
  var section = { id: gen("sec"), label: opts.projectName ? "Labor adjustments — " + opts.projectName : "Labor adjustments",
                  customDates: false, startDate: "", endDate: "", projectId: pid,
                  laborSync: { projectId: pid, grouping: "one", ignored: {}, basis: { invoiceId: sent.id } }, items: lines };
  var sentRef = opts.sentRef || (window.LTP_INVOICE_REF ? window.LTP_INVOICE_REF(sent) : ("INV-" + sent.id));
  var changeRows = rows.map(function(c) {
    return { cat: _lsCat(c), detail: "Added ×" + window.LTP_laborDifferenceQty(c) + " @ $" + _lsMoney(c.expected.unitPrice) };
  });
  var invoice = {
    id: newId, quoteId: null, shareToken: opts.shareToken || null,
    clientType: sent.clientType || "company", companyId: sent.companyId,
    clientContactId: sent.clientContactId != null ? sent.clientContactId : null,
    projectId: sent.projectId, projectIds: window.LTP_docProjectIds(sent),
    customName: sent.customName || "", status: "draft",
    invoiceDate: opts.today || "", createdDate: opts.today || "", sentDate: null,
    dueDate: opts.dueDate || "", paidDate: null,
    globalDiscount: { type: "none", value: 0 },
    sections: [section], notes: opts.notes || "", terms: opts.terms != null ? opts.terms : (sent.terms || ""),
    payments: [],
    activity: [{ id: gen("act"), date: opts.today || "", time: opts.time || "", type: "created",
                 user: opts.user || "User", message: "Invoice created from schedule changes to " + sentRef, changes: changeRows }],
  };

  // Record on the sent invoice what was billed elsewhere — marker fields only,
  // so its money, its QuickBooks fingerprint and its public view do not move.
  var w = _lsWriter(sent.sections || []);
  var unrecorded = [];
  rows.forEach(function(c) {
    var dq = window.LTP_laborDifferenceQty(c);
    if (c.kind === "changed") {
      var si = _lsIndexOfSection(w.out, c.sectionId);
      var sec = si === -1 ? null : w.section(si), ii = sec ? _lsIndexOfItem(sec.items, c.itemId) : -1;
      if (ii === -1) { unrecorded.push(c.key); return; }
      var it = sec.items[ii];
      sec.items[ii] = Object.assign({}, it, { laborSync: Object.assign({}, it.laborSync, {
        at: now, snap: _lsCloneSnap(c.expected),
        adjustments: (it.laborSync.adjustments || []).concat([{ invoiceId: newId, at: now, qty: dq }]),
      }) });
      return;
    }
    var home = window.LTP_laborHomeSection({ sections: w.out }, pid, c.dept);
    if (!home) { unrecorded.push(c.key); return; }
    var hs = w.section(_lsIndexOfSection(w.out, home.id));
    var marker = hs.laborSync || { projectId: pid, grouping: "one", ignored: {} };
    var ig = Object.assign({}, marker.ignored || {});
    var prior = _lsSum(c.billedElsewhere, "qty");
    ig[c.key] = Object.assign(_lsCloneSnap(c.expected), { invoiceId: newId, qty: _lsR5(prior + dq) });
    hs.laborSync = Object.assign({}, marker, { ignored: ig });
  });
  var sentActivity = { id: gen("act"), date: opts.today || "", time: opts.time || "", type: "updated", user: opts.user || "User",
                       message: "Schedule changes billed on " + (newId != null ? "INV-" + newId : "a new invoice"), changes: changeRows };
  return { invoice: invoice, sentSections: w.changed() ? w.out : (sent.sections || []), sentActivity: sentActivity,
           lines: lines, unrecorded: unrecorded };
};
