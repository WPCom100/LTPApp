// ── Labor sync: the quote and invoice builders' banner + review ─────────────
//
// A document prices its project's schedule once; the schedule keeps moving.
// components/domain-labor-sync.js works out what differs and applies exactly
// what the producer ticks. This file is the part the two builders share on
// screen (docs/LABOR_SYNC_PLAN.md, A3/A4/A9):
//
//   LTP_useLaborSync(opts)   the builder-side state: which projects on the
//                            document have changes, the review that is open,
//                            the Apply / Keep handlers, and the activity rows a
//                            save records. One hook so the quote and invoice
//                            builders cannot disagree about what a sync does.
//   LTPLaborSyncBanner       one line per project with changes, and its actions
//   LTPLaborSyncReview       the modal: one row per change, ticked by default
//                            unless the line was edited by hand
//
// Three modes, set by the builder from the document's status:
//   "edit"        a draft or sent quote, a draft invoice. Apply and Keep are
//                 ordinary edits through the builder's setDraft (a sent quote
//                 raises its usual "Editing Sent Quote" notice) and nothing is
//                 stored until Save, which records one activity entry per
//                 project from takeActivity().
//   "difference"  a sent, partial or paid invoice. It cannot be edited, so the
//                 banner offers Recall to sync, New invoice with changes (only
//                 what the schedule ADDED, on a new draft) and Keep as is — the
//                 last two write only the sync markers, straight away, through
//                 the builder's writeLocked (money, the QuickBooks fingerprint
//                 and the client's view do not move).
//   "off"         an accepted/converted/declined quote. Nothing is shown.
//
// A document that predates the markers ("legacy", decision 13) is offered the
// review only when linking its lines to the schedule would show a difference;
// the review then says it will link them, and the first Apply or Keep does.
//
// UI copy is held to a line (decision 17): the reasoning lives here and in
// the plan, not on screen.
(function() {
  var B = window.LTP_THEME, h = React.createElement;
  var useState = React.useState, useMemo = React.useMemo, useRef = React.useRef, useEffect = React.useEffect;

  function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function money(n) { return "$" + window.LTP_money(Math.abs(r2(n))); }
  function signed(n) { var v = r2(n); return (v < 0 ? "−" : "+") + money(v); }
  // "Sep 12" — no weekday, and never a year: the review is about one job's
  // days, and a year that appears only once the calendar turns over would read
  // as a change that isn't one.
  function shortDay(iso) { return window.LTP_formatDateShort(iso, { weekday: false, year: false }); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function nowIso() { return new Date().toISOString(); }
  function findProject(projects, id) {
    return (projects || []).filter(function(p) { return p && String(p.id) === String(id); })[0] || null;
  }

  // ── The builder-side state ─────────────────────────────────────────────────
  // opts: {
  //   kind         "quote" | "invoice" (only for the open-on-arrival handoff)
  //   draft        the builder's current draft
  //   projects, svcs (the DOCUMENT's client-resolved rate card), contacts
  //   mode         "edit" | "difference" | "off"
  //   setDraft     the builder's dirtying setter (edit mode)
  //   writeLocked  function(patch) — a marker-only write on a locked invoice,
  //                applied to the stored row, the draft and the clean baseline
  //                at once (difference mode)
  //   genId        id minting
  //   onRemovedLinked(list) — invoice lines from a quote that Apply removed, in
  //                the builder's pendingRollbacks shape
  //   fallbackQuoteId — the invoice's own quoteId, for legacy converted lines
  // }
  window.LTP_useLaborSync = function(opts) {
    var o = opts || {};
    var draft = o.draft;
    var active = !!draft && (o.mode === "edit" || o.mode === "difference");
    var fmt = window.LTP_formatDate;
    var crewMins = useMemo(function() { return window.LTP_crewMinMap(o.contacts); }, [o.contacts]);

    var found = useMemo(function() {
      if (!active) return { drifts: [], links: [] };
      var drifts = window.LTP_laborDriftAll(draft, o.projects, o.svcs, crewMins, fmt);
      var links = [];
      if (o.mode === "edit") {
        window.LTP_docProjectIds(draft).forEach(function(pid) {
          if (!window.LTP_laborLinkable(draft, pid)) return;
          var project = findProject(o.projects, pid);
          if (!project) return;
          var adopted = window.LTP_adoptLaborLines(draft, project, o.svcs, crewMins, fmt);
          if (!adopted.linked.length) return;
          var drift = window.LTP_laborDrift(Object.assign({}, draft, { sections: adopted.sections }), project, o.svcs, crewMins, fmt);
          if (drift.count) links.push({ projectId: project.id, adopted: adopted, drift: drift });
        });
      }
      return { drifts: drifts, links: links };
    }, [active, o.mode, draft, o.projects, o.svcs, crewMins]);

    // The schedule builder's send routes an already-linked target here with the
    // review open: window.__LTP_OPEN_LABOR_REVIEW = { kind, id, projectId }.
    // Read at mount so the page arrives with the review up (no flash of the
    // bare document); the effect below clears the handoff, and covers a
    // builder that was already open on another document.
    function handoff() {
      var p = window.__LTP_OPEN_LABOR_REVIEW;
      return (p && p.kind === o.kind && draft && draft.id != null && String(p.id) === String(draft.id)) ? p : null;
    }
    var reviewState = useState(function() { var p = handoff(); return p ? { projectId: p.projectId } : null; });   // { projectId } | null
    var review = reviewState[0], setReview = reviewState[1];
    var logRef = useRef([]);

    function linkFor(pid) { return found.links.filter(function(l) { return String(l.projectId) === String(pid); })[0] || null; }
    function driftFor(pid) {
      var l = linkFor(pid);
      if (l) return l.drift;
      return found.drifts.filter(function(d) { return String(d.projectId) === String(pid); })[0] || null;
    }
    function nameOf(pid) { var p = findProject(o.projects, pid); return p ? p.name : "Project " + pid; }
    function openReview(pid) { if (driftFor(pid)) setReview({ projectId: pid }); }
    function closeReview() { setReview(null); }

    useEffect(function() {
      var p = handoff();
      if (!p) return;
      window.__LTP_OPEN_LABOR_REVIEW = null;
      if (driftFor(p.projectId)) setReview({ projectId: p.projectId });
      else if (window.LTP_toast) window.LTP_toast("Labor already matches the schedule", { variant: "info" });
    }, [draft && draft.id]);

    // A review whose changes are all resolved closes itself.
    var reviewDrift = review ? driftFor(review.projectId) : null;
    useEffect(function() { if (review && !reviewDrift) setReview(null); }, [review, reviewDrift]);

    // Edit mode: Apply or Keep the ticked keys as an ordinary draft edit.
    function editAction(pid, keys, keep) {
      var link = linkFor(pid);
      var drift = driftFor(pid);
      if (!drift || !keys || !keys.length) return;
      var base = link ? Object.assign({}, draft, { sections: link.adopted.sections }) : draft;
      var ts = nowIso(), sections, done = [], removed = [];
      if (keep) {
        sections = window.LTP_keepLaborSync(base, drift, keys, ts);
        done = drift.changes.filter(function(c) { return keys.indexOf(c.key) !== -1; }).map(function(c) { return c.key; });
      } else {
        var res = window.LTP_applyLaborSync(base, drift, keys, o.genId, ts,
          { projectName: nameOf(pid), fallbackQuoteId: o.fallbackQuoteId });
        sections = res.sections; done = res.applied; removed = res.removedLinked;
      }
      if (sections === draft.sections) return;
      logRef.current.push({ projectId: pid, name: nameOf(pid),
        rows: window.LTP_laborSyncChanges(drift, keep ? [] : done, keep ? done : []),
        applied: keep ? 0 : done.length, kept: keep ? done.length : 0,
        linked: link ? link.adopted.linked.length : 0 });
      if (removed.length && o.onRemovedLinked) o.onRemovedLinked(removed);
      o.setDraft(Object.assign({}, draft, { sections: sections }));
    }

    // Difference mode: Keep as is — record the decision on the locked invoice's
    // markers only, straight away.
    function keepLocked(pid, keys) {
      var drift = driftFor(pid);
      if (!drift || !keys || !keys.length || !o.writeLocked) return;
      var sections = window.LTP_keepLaborSync(draft, drift, keys, nowIso());
      if (sections === draft.sections) return;
      var n = new Date();
      o.writeLocked({ sections: sections, activity: (draft.activity || []).concat([{
        id: o.genId("act"), date: window.LTP_todayISO(), time: n.toTimeString().substring(0, 5), type: "updated",
        user: window.LTP_CURRENT_USER || "User", message: "Schedule changes kept as is (" + nameOf(pid) + ")",
        changes: window.LTP_laborSyncChanges(drift, [], keys) }]) });
    }

    function allKeys(pid) { var d = driftFor(pid); return d ? d.changes.map(function(c) { return c.key; }) : []; }

    return {
      mode: o.mode,
      drifts: found.drifts,
      links: found.links,
      // Every project with something to review, legacy links included, in one list.
      banners: found.links.map(function(l) { return { projectId: l.projectId, drift: l.drift, linking: l.adopted }; })
        .concat(found.drifts.map(function(d) { return { projectId: d.projectId, drift: d, linking: null }; })),
      review: review && reviewDrift ? { projectId: review.projectId, drift: reviewDrift, linking: (linkFor(review.projectId) || {}).adopted || null } : null,
      nameOf: nameOf,
      driftFor: driftFor,
      openReview: openReview,
      closeReview: closeReview,
      apply: function(pid, keys) { editAction(pid, keys, false); },
      keep: function(pid, keys) { if (o.mode === "difference") keepLocked(pid, keys); else editAction(pid, keys, true); },
      keepAll: function(pid) { var k = allKeys(pid); if (o.mode === "difference") keepLocked(pid, k); else editAction(pid, k, true); },
      // One activity entry per project for what this editing session applied
      // and kept — appended by the builder's save(), then forgotten.
      takeActivity: function(meta) {
        var byPid = {}, order = [];
        logRef.current.forEach(function(e) {
          var k = String(e.projectId);
          if (!byPid[k]) { byPid[k] = { name: e.name, rows: [], applied: 0, kept: 0, linked: 0 }; order.push(k); }
          var t = byPid[k];
          t.rows = t.rows.concat(e.rows); t.applied += e.applied; t.kept += e.kept; t.linked = Math.max(t.linked, e.linked);
        });
        logRef.current = [];
        return order.map(function(k) {
          var t = byPid[k], parts = [];
          if (t.applied) parts.push(t.applied + " applied");
          if (t.kept) parts.push(t.kept + " kept");
          var rows = (t.linked ? [{ cat: "Labor", detail: "Linked " + plural(t.linked, "line", "lines") + " to the schedule" }] : []).concat(t.rows);
          return { id: o.genId("act"), date: meta.date, time: meta.time, type: "updated", user: meta.user,
                   message: "Labor synced from " + t.name + " schedule" + (parts.length ? " (" + parts.join(", ") + ")" : ""),
                   changes: rows.length ? rows : null };
        });
      },
      resetLog: function() { logRef.current = []; },
    };
  };

  // ── Banner ──────────────────────────────────────────────────────────────────
  // p: { projectName, drift, mode, onReview, onKeepAll, onRecall, recallBlocked, onNewInvoice }
  window.LTPLaborSyncBanner = function(p) {
    var d = p.drift;
    if (!d || !d.count) return null;
    var diff = p.mode === "difference";
    var title = diff ? "Labor changed on " + p.projectName + " since sent" : "Labor out of sync with " + p.projectName;
    var meta = plural(d.count, "change", "changes") + (!diff && r2(d.deltaTotal) !== 0 ? " · " + signed(d.deltaTotal) : "");
    var btn = function(key, label, onClick, variant, disabled) {
      return h(window.Btn, { key: key, small: true, variant: variant, onClick: onClick, disabled: disabled }, label);
    };
    return h("div", { style: { padding: "10px 12px", background: B.warnBg, border: "1px solid " + B.warnBd, borderRadius: "6px", fontSize: "11px", color: B.text, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
      h("div", { style: { flex: "1 1 220px", minWidth: 0 } },
        h("span", { style: { fontWeight: 700, color: B.warn } }, "⚠ " + title),
        h("span", { style: { color: B.textSec } }, " · " + meta)),
      h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" } },
        diff
          ? [btn("recall", "Recall to sync", p.onRecall, "ghost", !!p.recallBlocked),
             p.recallBlocked && h("span", { key: "rb", style: { fontSize: "10px", color: B.textMut } }, "has payments"),
             btn("new", "New invoice with changes", p.onNewInvoice, "primary"),
             btn("keep", "Keep as is", p.onKeepAll, "ghost")]
          : [btn("review", "Review", p.onReview, "primary"),
             btn("keep", "Keep all", p.onKeepAll, "ghost")]));
  };

  // ── Review ──────────────────────────────────────────────────────────────────
  // What one change does, in a few words — the second line of its row.
  function describe(c) {
    var e = c.expected, cur = c.current;
    if (c.kind === "removed") return "Off the schedule";
    var days = function() {
      if (c.rateType === "cancel") return e.notes;
      var was = c.snapDates, now = e.dates || [];
      if (c.kind === "added") {
        var list = now.map(shortDay);
        return list.length > 4 ? list.slice(0, 3).join(", ") + " + " + (list.length - 3) + " more" : list.join(", ");
      }
      if (was == null) return e.notes ? "Days: " + e.notes : "";
      var plus = now.filter(function(d) { return was.indexOf(d) === -1; }).map(function(d) { return "+" + shortDay(d); });
      var minus = was.filter(function(d) { return now.indexOf(d) === -1; }).map(function(d) { return "−" + shortDay(d); });
      return plus.concat(minus).join(", ");
    };
    if (c.kind === "added") {
      var dd = days();
      return "New · ×" + e.qty + " @ " + money(e.unitPrice) + (dd ? " · " + dd : "");
    }
    var parts = [];
    if (c.fields.indexOf("qty") !== -1) parts.push("Qty " + cur.qty + " → " + e.qty);
    if (c.fields.indexOf("unitPrice") !== -1) parts.push("Rate " + money(cur.unitPrice) + " → " + money(e.unitPrice));
    if (c.fields.indexOf("dates") !== -1) { var d2 = days(); if (d2) parts.push(d2); }
    if (c.fields.indexOf("cost") !== -1 && c.fields.length === 1) parts.push("Cost " + money(cur.cost) + " → " + money(e.cost));
    return parts.join(" · ");
  }

  function chip(key, text, color) {
    return h("span", { key: key, style: { fontSize: "9px", fontWeight: 700, color: color, border: "1px solid " + color + "66", borderRadius: "10px", padding: "0 6px", whiteSpace: "nowrap" } }, text);
  }

  // p: { drift, projectName, mode: "edit"|"difference", linking: {linked, unlinked}|null,
  //      onApply(keys), onKeep(keys), onNewInvoice(keys), onClose, invoiceRef(id) }
  window.LTPLaborSyncReview = function(p) {
    var isMobile = window.LTP_useIsMobile();
    var pickState = useState({});
    var picked = pickState[0], setPicked = pickState[1];
    var diff = p.mode === "difference";
    var changes = (p.drift && p.drift.changes) || [];
    function qualifies(c) { return !diff || window.LTP_laborDifferenceQty(c) > 0; }
    function isOn(c) { return picked[c.key] != null ? picked[c.key] : (!c.handEdited && qualifies(c)); }
    var onKeys = changes.filter(isOn).map(function(c) { return c.key; });
    var billable = changes.filter(function(c) { return isOn(c) && qualifies(c); }).map(function(c) { return c.key; });
    var anyCredit = diff && changes.some(function(c) { return !qualifies(c); });
    function toggle(c) { var next = Object.assign({}, picked); next[c.key] = !isOn(c); setPicked(next); }
    function ref(id) { return p.invoiceRef ? p.invoiceRef(id) : "INV-" + id; }

    var rows = changes.map(function(c) {
      var on = isOn(c);
      var amount = diff
        ? (qualifies(c) ? "+" + money(window.LTP_laborDifferenceQty(c) * c.expected.unitPrice) : null)
        : (r2(c.delta) === 0 ? "" : signed(c.delta));
      // Why a row can't go on a new invoice, in two words: it takes money off
      // (credit), it only re-prices (rate changed), or only the days moved.
      var aside = null;
      if (diff && !qualifies(c)) {
        var billed = (c.billedElsewhere || []).reduce(function(t, b) { return t + (Number(b.qty) || 0); }, 0);
        var have = c.kind === "changed" ? (Number(c.current.qty) || 0) + billed : billed;
        var net = c.kind === "removed" ? -1 : Math.round(((Number(c.expected.qty) || 0) - have) * 1e5) / 1e5;
        aside = net < 0 ? "credit" : (c.fields.indexOf("unitPrice") !== -1 ? "rate changed" : "days moved");
      }
      var flags = [
        c.handEdited && chip("h", "edited by hand", B.warn),
        c.hasAdjustedPrice && chip("a", "adjusted price kept", B.info),
        c.linked && chip("l", "from quote", B.info),
        c.wasIgnored && chip("w", "skipped before", B.textMut),
      ].concat((c.billedElsewhere || []).map(function(b, i) { return chip("b" + i, "×" + b.qty + " on " + ref(b.invoiceId), B.textMut); }))
        .filter(Boolean);
      return h("label", { key: c.key, style: { display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 0", borderBottom: "1px solid " + B.border, cursor: "pointer" } },
        h("input", { type: "checkbox", checked: on, onChange: function() { toggle(c); }, style: { width: 18, height: 18, marginTop: 1, flexShrink: 0 } }),
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, c.name + " · " + window.LTP_rateTypeLabel(c.rateType)),
          h("div", { style: { fontSize: "11px", color: B.textSec, marginTop: 2 } }, describe(c)),
          flags.length > 0 && h("div", { style: { display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 } }, flags)),
        h("div", { style: { flexShrink: 0, textAlign: "right", fontSize: "12px", fontWeight: 700, fontVariantNumeric: "tabular-nums",
                            color: aside ? B.textMut : (amount && amount.charAt(0) === "−" ? B.danger : B.success) } },
          aside || amount));
    });

    var btnStyle = isMobile ? window.LTP_SHEET_BTN : null;
    var footer = h("div", null,
      anyCredit && h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 8 } }, "Reductions need a recall or a credit memo."),
      h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" } },
        h(window.Btn, { variant: "ghost", onClick: p.onClose, style: btnStyle }, "Cancel"),
        h(window.Btn, { variant: "ghost", disabled: onKeys.length === 0, onClick: function() { p.onKeep(onKeys); }, style: btnStyle },
          onKeys.length ? "Keep " + onKeys.length : "Keep"),
        diff
          ? h(window.Btn, { disabled: billable.length === 0, onClick: function() { p.onNewInvoice(billable); }, style: Object.assign({}, btnStyle, isMobile ? { flex: 1 } : null) },
              "New invoice" + (billable.length ? " (" + billable.length + ")" : ""))
          : h(window.Btn, { disabled: onKeys.length === 0, onClick: function() { p.onApply(onKeys); }, style: Object.assign({}, btnStyle, isMobile ? { flex: 1 } : null) },
              onKeys.length ? "Apply " + onKeys.length : "Apply")));

    var linking = p.linking;
    return h(window.LTPModal, { title: "Schedule changes · " + p.projectName, onClose: p.onClose, wide: true, footer: footer },
      linking && h("div", { style: { fontSize: "11px", color: B.textSec, marginBottom: 8 } },
        "Links " + plural(linking.linked.length, "existing line", "existing lines") + " to the schedule"
        + (linking.unlinked.length ? " · not linked: " + linking.unlinked.map(function(u) { return u.name; }).join(", ") : "")),
      h("div", null, rows));
  };
})();
