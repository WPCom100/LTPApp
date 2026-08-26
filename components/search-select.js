// Search Select Components — reusable across all modules
//
// INLINE ADD / EDIT
//   Every field here can offer to author the record you're searching for, via
//   components/entity-quick-form.js. Two affordances, both optional:
//
//     createKind  "company" | "contact" | "project"
//                 → a "＋ Create …" row closes out the dropdown, and the
//                   dropdown now STAYS OPEN on zero matches (it used to vanish,
//                   which read as a broken search box when the record simply
//                   didn't exist yet).
//     allowEdit   → a ✎ on the selected chip re-opens that record's form.
//
//   Both are opt-in. Pickers that choose from a fixed roster or a set list —
//   crew selection above all — must NOT pass them: picking a crew member is
//   choosing from a roster, not authoring a record.
//
//   createPrefill seeds the new record with context the field already knows
//   (e.g. a project created from a quote inherits that quote's company), and is
//   merged over the name parsed from whatever the user typed.
(function() {
  var B = window.LTP_THEME, h = React.createElement, useState = React.useState;
  var fmt = window.LTP_formatDate;

  // Focusing a field now shows the list straight away (it used to stay hidden
  // until you typed, which made an empty result indistinguishable from a broken
  // box). Browsing is capped — a few hundred companies shouldn't all render on
  // focus — and typing narrows past the cap.
  var BROWSE_CAP = 50;
  function capped(list) { return list.length > BROWSE_CAP ? list.slice(0, BROWSE_CAP) : list; }

  // The chip well every single-select field wears. Matches window.LTPInput's box
  // exactly — same fill, same radius, same border — because these sit directly
  // beside plain inputs in the quote and invoice headers (Linked Projects next
  // to Custom Quote Name, Company next to a date), and two fills on one row is
  // the thing that made those rows read as unfinished. The chips inside carry
  // the accent, so nothing is lost by letting the well recede like every other
  // field does.
  var WELL = {
    display: "flex", alignItems: "center", gap: 6, boxSizing: "border-box",
    background: B.bg, border: "1px solid " + B.border, borderRadius: "8px",
    padding: "0 8px 0 12px", minHeight: 37,
  };

  // Shared dropdown shell so all four fields drop their results in the same
  // box, and so the create row always sits at the bottom in the same place.
  function dropdown(children, maxHeight) {
    return h("div", { style: { position: "absolute", top: "100%", left: 0, right: 0, background: B.surface, border: "1px solid " + B.border, borderRadius: "0 0 8px 8px", maxHeight: maxHeight || 180, overflow: "auto", zIndex: 10 } }, children);
  }

  // Returns a 0- or 1-element array so callers can `.concat()` it onto their
  // result rows and hand the dropdown one flat, fully-keyed child list.
  function createRows(show, createKind, query, createPrefill, onCreated, first) {
    if (!show || !createKind) return [];
    return [h(window.LTPEntityCreateRow, { key: "_create", kind: createKind, query: query, prefill: createPrefill, onSaved: onCreated, first: first })];
  }

  // ✎ on a selected chip. Rendered inside the chip, before the × so the
  // clear action stays where the muscle memory expects it.
  function chipEdit(kind, id, onSaved) {
    if (!kind || id == null) return null;
    return h("button", {
      type: "button", "aria-label": "Edit this " + (window.LTP_ENTITY_KIND_LABEL[kind] || "record"),
      title: "Edit this " + (window.LTP_ENTITY_KIND_LABEL[kind] || "record"),
      onMouseDown: function(e) { e.preventDefault(); },
      onClick: function(e) {
        e.preventDefault(); e.stopPropagation();
        window.LTP_openEntityForm({ kind: kind, id: id, onSaved: onSaved });
      },
      style: { background: "none", border: "none", color: B.btnInk, cursor: "pointer", fontSize: "10px", fontWeight: 700, padding: "0 0 0 4px", lineHeight: 1 },
    }, "✎");
  }

  // Multi-select search (contacts, companies linking, attendees, etc.)
  window.SearchSelect = function({ label, items, selectedIds, onChange, nameField, createKind, createPrefill, allowEdit }) {
    var [query, setQuery] = useState("");
    var [focused, setFocused] = useState(false);
    var getName = function(item) { return typeof nameField === "function" ? nameField(item) : item[nameField || "name"]; };
    var filtered = items.filter(function(item) { return getName(item).toLowerCase().indexOf(query.toLowerCase()) !== -1; });
    // A record created from here is selected immediately — that's the whole
    // point of creating it from a picker.
    function onCreated(rec) {
      if (!rec || rec.id == null) return;
      if (selectedIds.indexOf(rec.id) === -1) onChange(selectedIds.concat([rec.id]));
      setQuery("");
    }
    var showCreate = !!createKind && focused && query.length > 0;
    return h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
      (label || createKind) && h(window.LTPFieldLabel, { label: label || "",
        // Sized down to sit INSIDE the shared label height. This field's box is
        // a chip well with no fixed right edge to hang an action off, so unlike
        // the single-select fields below it keeps its ＋ on the label.
        action: createKind ? h(window.LTPEntityQuickAction, { kind: createKind, id: null, prefill: createPrefill, onSaved: onCreated, size: window.LTP_FIELD_LABEL_HEIGHT }) : null }),
      selectedIds.length > 0 && h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 4 } },
        selectedIds.map(function(id) {
          var item = items.find(function(i) { return i.id === id; }); if (!item) return null;
          return h("span", { key: id, style: { display: "inline-flex", alignItems: "center", gap: 4, background: B.accent, color: B.btnInk, fontSize: "11px", padding: "2px 8px", borderRadius: "4px", fontWeight: 600 } },
            getName(item),
            allowEdit && createKind ? chipEdit(createKind, id, function() {}) : null,
            h("button", { onClick: function() { onChange(selectedIds.filter(function(x) { return x !== id; })); }, style: { background: "none", border: "none", color: B.btnInk, cursor: "pointer", fontSize: "12px", fontWeight: 700, padding: "0 0 0 2px", lineHeight: 1 } }, "×"));
        })
      ),
      h("div", { style: { position: "relative" } },
        h("input", { type: "text", value: query, placeholder: "Search...", onChange: function(e) { setQuery(e.target.value); }, onFocus: function() { setFocused(true); }, onBlur: function() { setTimeout(function() { setFocused(false); }, 200); }, style: { background: B.bg, border: "1px solid " + B.border, borderRadius: "8px", padding: "8px 12px", color: B.text, fontSize: "13px", fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box" } }),
        (focused && (filtered.length > 0 || showCreate)) && dropdown(
          capped(filtered).map(function(item) { var id = item.id, isSel = selectedIds.includes(id); return h("div", { key: id, onMouseDown: function(e) { e.preventDefault(); }, onClick: function() { if (isSel) onChange(selectedIds.filter(function(x) { return x !== id; })); else onChange(selectedIds.concat([id])); setQuery(""); }, style: { padding: "8px 12px", fontSize: "12px", cursor: "pointer", color: isSel ? B.accent : B.text, background: isSel ? B.accentMuted : "transparent", borderBottom: "1px solid " + B.border } }, (isSel ? "✓ " : "") + getName(item)); })
            .concat(createRows(showCreate, createKind, query, createPrefill, onCreated, filtered.length === 0)))
      )
    );
  };

  // Single-select inline chip search (for company field in project forms)
  window.CompanySearchField = function({ label, compId, setCompId, companies, onClear, createKind, createPrefill, allowEdit }) {
    var [query, setQuery] = useState("");
    var [focused, setFocused] = useState(false);
    var comps = companies || [];
    var selCompany = compId ? comps.find(function(c) { return c.id === compId; }) : null;
    var filtered = comps.filter(function(c) { return c.name.toLowerCase().indexOf(query.toLowerCase()) !== -1; });
    function onCreated(rec) { if (rec && rec.id != null) { setCompId(rec.id); setQuery(""); setFocused(false); } }
    var showCreate = !!createKind && focused && !selCompany && query.length > 0;
    return h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
      label != null && h(window.LTPFieldLabel, { label: label }),
      h("div", { style: { position: "relative" } },
        h("div", { style: Object.assign({}, WELL) },
          selCompany && h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4, background: B.accent, color: B.btnInk, fontSize: "11px", padding: "2px 8px", borderRadius: "4px", fontWeight: 600, flexShrink: 0 } },
            selCompany.name,
            h("button", { onClick: function(e) { e.stopPropagation(); setCompId(null); setQuery(""); if (onClear) onClear(); }, style: { background: "none", border: "none", color: B.btnInk, cursor: "pointer", fontSize: "12px", fontWeight: 700, padding: "0 0 0 2px", lineHeight: 1 } }, "×")
          ),
          h("input", { type: "text", value: selCompany ? "" : query, placeholder: selCompany ? "" : "Search companies...",
            onChange: function(e) { if (!selCompany) setQuery(e.target.value); },
            onFocus: function() { if (!selCompany) setFocused(true); },
            onBlur: function() { setTimeout(function() { setFocused(false); }, 200); },
            onClick: function() { if (selCompany) { setCompId(null); setQuery(""); setFocused(true); if (onClear) onClear(); } },
            style: { background: "transparent", border: "none", color: B.text, fontSize: "13px", fontFamily: "inherit", outline: "none", flex: 1, padding: "8px 0", minWidth: 60, cursor: selCompany ? "pointer" : "text" }
          }),
          createKind && h(window.LTPEntityQuickAction, {
            kind: createKind, id: (allowEdit && selCompany) ? selCompany.id : null,
            prefill: createPrefill, onSaved: onCreated })
        ),
        (focused && !selCompany && (filtered.length > 0 || showCreate)) && dropdown(
          capped(filtered).map(function(c) { return h("div", { key: c.id, onMouseDown: function(e) { e.preventDefault(); }, onClick: function() { setCompId(c.id); setQuery(""); setFocused(false); }, style: { padding: "8px 12px", fontSize: "12px", cursor: "pointer", color: B.text, borderBottom: "1px solid " + B.border } }, c.name); })
            .concat(createRows(showCreate, createKind, query, createPrefill, onCreated, filtered.length === 0)), 150)
      )
    );
  };

  // Single-select inline chip search for a contact. Mirrors CompanySearchField.
  // Accepts optional `filter` function to restrict candidates (e.g. only contacts
  // without a company, or contacts belonging to a specific company).
  //
  // TIERS — `tiers`
  //   Pass LTP_HELPERS.contactFieldTiers(...) — { primary, rest, moreLabel } —
  //   to split the list the way the quote/invoice "Primary Contact" field wants
  //   it: this client's people first, everyone else behind a deliberate click.
  //   Search stays inside tier 1 until tier 2 is opened, so a name match from an
  //   unrelated client can't bury the handful of people who belong to this one.
  //   `tiers` supersedes `filter` (it has already done the narrowing); without
  //   it the field behaves exactly as before — one flat, filtered list.
  window.ContactSearchField = function({ label, contactId, setContactId, contacts, filter, tiers, placeholder, onClear, createKind, createPrefill, allowEdit }) {
    var [query, setQuery] = useState("");
    var [focused, setFocused] = useState(false);
    // Tier 2 stays shut until deliberately opened, and re-shuts when the field
    // closes, so the next visit starts from the short, relevant list again.
    var [moreOpen, setMoreOpen] = useState(false);
    var list = tiers ? (tiers.primary || []) : (contacts || []);
    if (!tiers && typeof filter === "function") list = list.filter(filter);
    var rest = tiers ? (tiers.rest || []) : [];
    // Resolve the chip against the FULL list, not the filtered one, so a
    // selection that no longer passes the filter still renders its name.
    var selContact = contactId ? (contacts || []).find(function(c) { return c.id === contactId; }) : null;
    var q = query.toLowerCase();
    function matches(c) {
      var hay = (c.firstName + " " + c.lastName + " " + (c.email || "") + " " + (c.role || "")).toLowerCase();
      return hay.indexOf(q) !== -1;
    }
    var filtered = list.filter(matches);
    var filteredRest = moreOpen ? rest.filter(matches) : [];
    function fullName(c) { return c.firstName + " " + c.lastName; }
    function close() { setFocused(false); setMoreOpen(false); }
    function onCreated(rec) { if (rec && rec.id != null) { setContactId(rec.id); setQuery(""); close(); } }
    function pick(id) { setContactId(id); setQuery(""); close(); }
    var showCreate = !!createKind && focused && !selContact && query.length > 0;
    // The reveal row is offered whenever tier 2 has anyone in it — including
    // when tier 1 came back empty, which is the case that used to leave a
    // client with no linked contacts looking like it had nobody to pick at all.
    var showMoreRow = !!tiers && !moreOpen && rest.length > 0 && focused && !selContact;
    // One contact row, shared by both tiers.
    function contactRow(c) {
      return h("div", { key: c.id, onMouseDown: function(e) { e.preventDefault(); }, onClick: function() { pick(c.id); },
        style: { padding: "8px 12px", fontSize: "12px", cursor: "pointer", color: c.id === contactId ? B.accent : B.text, borderBottom: "1px solid " + B.border } },
        h("div", { style: { fontWeight: 600 } }, fullName(c)),
        c.role && h("div", { style: { fontSize: "10px", color: B.textMut } }, c.role + (c.email ? " · " + c.email : "")));
    }
    return h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
      label != null && h(window.LTPFieldLabel, { label: label }),
      h("div", { style: { position: "relative" } },
        h("div", { style: Object.assign({}, WELL) },
          selContact && h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4, background: B.accent, color: B.btnInk, fontSize: "11px", padding: "2px 8px", borderRadius: "4px", fontWeight: 600, flexShrink: 0 } },
            fullName(selContact),
            h("button", { onClick: function(e) { e.stopPropagation(); setContactId(null); setQuery(""); if (onClear) onClear(); }, style: { background: "none", border: "none", color: B.btnInk, cursor: "pointer", fontSize: "12px", fontWeight: 700, padding: "0 0 0 2px", lineHeight: 1 } }, "×")
          ),
          h("input", { type: "text", value: selContact ? "" : query, placeholder: selContact ? "" : (placeholder || "Search contacts..."),
            onChange: function(e) { if (!selContact) setQuery(e.target.value); },
            onFocus: function() { if (!selContact) setFocused(true); },
            onBlur: function() { setTimeout(function() { close(); }, 200); },
            onClick: function() { if (selContact) { setContactId(null); setQuery(""); setFocused(true); if (onClear) onClear(); } },
            style: { background: "transparent", border: "none", color: B.text, fontSize: "13px", fontFamily: "inherit", outline: "none", flex: 1, padding: "8px 0", minWidth: 60, cursor: selContact ? "pointer" : "text" }
          }),
          createKind && h(window.LTPEntityQuickAction, {
            kind: createKind, id: (allowEdit && selContact) ? selContact.id : null,
            prefill: createPrefill, onSaved: onCreated })
        ),
        (focused && !selContact && (filtered.length > 0 || filteredRest.length > 0 || showMoreRow || showCreate)) && dropdown(
          capped(filtered).map(contactRow)
            // The tier-2 header doubles as the reveal control, so everyone else
            // is always one deliberate click away and never mixed into tier 1.
            .concat(showMoreRow
              ? [h("div", { key: "_more",
                  onMouseDown: function(e) { e.preventDefault(); },
                  onClick: function() { setMoreOpen(true); },
                  style: { padding: "9px 12px", fontSize: "12px", cursor: "pointer", color: B.accent, fontWeight: 600, background: B.accentMuted,
                           display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 } },
                  h("span", null, tiers.moreLabel || "Other contacts…"),
                  h("span", { style: { fontSize: "11px" } }, "▾"))]
              : [])
            .concat(moreOpen && rest.length
              ? [h("div", { key: "_morehdr", style: { padding: "6px 12px", fontSize: "10px", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: B.textMut, background: B.raised, borderBottom: "1px solid " + B.border } },
                  tiers.moreLabel || "Other contacts")]
              : [])
            .concat(capped(filteredRest).map(contactRow))
            .concat(createRows(showCreate, createKind, query, createPrefill, onCreated, filtered.length === 0 && !showMoreRow && filteredRest.length === 0)))
      )
    );
  };

  // Inline chip search for a project. Mirrors the two above, but supports
  // selecting SEVERAL projects — a quote or invoice can bill work for more than
  // one job (see window.LTP_docProjectIds in theme.js).
  //
  // Replaces the native <select> the quote and invoice builders used for
  // "Linked Project": that select got unusable as the project list grew, and it
  // had no room for a create affordance. `emptyLabel` is the placeholder shown
  // when nothing is picked (the old select's "(no project — use custom name)"
  // option, which is now the chip's × instead).
  //
  // Two modes, chosen by which setter you pass:
  //   setProjectId  (+ projectId)   single — at most one chip, legacy behavior
  //   setProjectIds (+ projectIds)  multi  — the FIRST id is the primary
  //
  // The primary is fixed by selection order: it titles the PDF, names the
  // QuickBooks memo and drives rental dates, so it isn't quietly reassignable.
  // Removing it promotes whichever project is next in the list, which is the
  // deliberate way to change it.
  window.ProjectSearchField = function({ label, projectId, setProjectId, projectIds, setProjectIds, projects, companies, filter, placeholder, emptyLabel, onClear, createKind, createPrefill, allowEdit }) {
    var [query, setQuery] = useState("");
    var [focused, setFocused] = useState(false);
    var all = projects || [];
    var multi = typeof setProjectIds === "function";
    // Normalized selection, primary first. Single mode is just "at most one".
    var ids = multi
      ? (Array.isArray(projectIds) ? projectIds.filter(function(x) { return x != null; }) : [])
      : (projectId != null ? [projectId] : []);
    // Chips resolve against the FULL list — a completed or reassigned project
    // that the filter now excludes must still show its name while selected.
    var selected = ids.map(function(id) {
      return all.find(function(p) { return p.id === id; }) || { id: id, name: "Project " + id };
    });
    var atCapacity = !multi && selected.length > 0;   // single mode fills up at one

    function commit(next) {
      if (multi) setProjectIds(next);
      else setProjectId(next.length ? next[0] : null);
    }
    function add(id) {
      if (ids.some(function(x) { return String(x) === String(id); })) return;
      commit(multi ? ids.concat([id]) : [id]);
      setQuery(""); setFocused(false);
    }
    function remove(id) {
      var next = ids.filter(function(x) { return String(x) !== String(id); });
      commit(next);
      setQuery("");
      if (next.length === 0 && onClear) onClear();
    }

    var list = typeof filter === "function" ? all.filter(filter) : all;
    var q = query.toLowerCase();
    var compName = function(p) {
      var c = p.companyId != null && companies ? companies.find(function(x) { return x.id === p.companyId; }) : null;
      return c ? c.name : "";
    };
    var filtered = list.filter(function(p) {
      // Already-selected projects are chips, not dropdown rows.
      if (ids.some(function(x) { return String(x) === String(p.id); })) return false;
      return ((p.name || "") + " " + compName(p)).toLowerCase().indexOf(q) !== -1;
    });
    function onCreated(rec) { if (rec && rec.id != null) add(rec.id); }
    var showCreate = !!createKind && focused && !atCapacity && query.length > 0;
    // The quick-action edits the PRIMARY — it's the one project the document is
    // actually titled by, so it's the only unambiguous edit target.
    var primary = selected.length ? selected[0] : null;

    return h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
      label != null && h(window.LTPFieldLabel, { label: label }),
      h("div", { style: { position: "relative" } },
        h("div", { style: Object.assign({}, WELL, { flexWrap: "wrap" }) },
          selected.map(function(p, i) {
            // The primary wears the solid accent chip; the rest are outlined, so
            // which project titles the document is readable at a glance.
            var isPrimary = i === 0;
            return h("span", { key: p.id,
              title: multi ? (isPrimary ? p.name + " — primary: titles the document and drives its dates" : p.name) : p.name,
              style: { display: "inline-flex", alignItems: "center", gap: 4, margin: "3px 0",
                       background: isPrimary ? B.accent : "transparent",
                       border: isPrimary ? "1px solid " + B.accent : "1px solid " + B.border,
                       color: isPrimary ? B.btnInk : B.textSec,
                       fontSize: "11px", padding: "2px 8px", borderRadius: "4px", fontWeight: 600, flexShrink: 0, maxWidth: "100%", overflow: "hidden" } },
              h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, p.name),
              h("button", { "aria-label": "Remove " + p.name,
                onClick: function(e) { e.stopPropagation(); remove(p.id); },
                style: { background: "none", border: "none", color: isPrimary ? B.btnInk : B.textMut, cursor: "pointer", fontSize: "12px", fontWeight: 700, padding: "0 0 0 2px", lineHeight: 1, flexShrink: 0 } }, "×")
            );
          }),
          h("input", { type: "text", value: atCapacity ? "" : query,
            placeholder: selected.length ? (multi ? "Add another…" : "") : (placeholder || emptyLabel || "Search projects..."),
            onChange: function(e) { if (!atCapacity) setQuery(e.target.value); },
            onFocus: function() { if (!atCapacity) setFocused(true); },
            onBlur: function() { setTimeout(function() { setFocused(false); }, 200); },
            // Single mode keeps the old "click the field to clear and re-pick"
            // shortcut. Multi mode has nothing to clear — chips have their own ×.
            onClick: function() { if (atCapacity) { commit([]); setQuery(""); setFocused(true); if (onClear) onClear(); } },
            style: { background: "transparent", border: "none", color: B.text, fontSize: "13px", fontFamily: "inherit", outline: "none", flex: 1, padding: "8px 0", minWidth: 60, cursor: atCapacity ? "pointer" : "text" }
          }),
          createKind && h(window.LTPEntityQuickAction, {
            kind: createKind, id: (allowEdit && primary) ? primary.id : null,
            prefill: createPrefill, onSaved: onCreated })
        ),
        (focused && !atCapacity && (filtered.length > 0 || showCreate)) && dropdown(
          capped(filtered).map(function(p) {
            var cn = compName(p);
            return h("div", { key: p.id, onMouseDown: function(e) { e.preventDefault(); }, onClick: function() { add(p.id); },
              style: { padding: "8px 12px", fontSize: "12px", cursor: "pointer", color: B.text, borderBottom: "1px solid " + B.border } },
              h("div", { style: { fontWeight: 600 } }, p.name),
              h("div", { style: { fontSize: "10px", color: B.textMut } },
                [cn, p.startDate ? fmt(p.startDate) : "", p.status].filter(Boolean).join(" · "))
            );
          })
            .concat(createRows(showCreate, createKind, query, createPrefill, onCreated, filtered.length === 0)))
      ),
      // Says out loud what the chip styling implies, but only once it matters.
      multi && selected.length > 1 && h("div", { style: { fontSize: "9px", color: B.textMut, lineHeight: 1.4 } },
        selected[0].name + " is the primary — it titles the document and drives its dates. Remove it to promote the next.")
    );
  };
})();
