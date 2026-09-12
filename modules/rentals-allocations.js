// Rentals — Allocations: the bookings that make gear read as "on rental".
//
// Bookings are DERIVED from confirmed documents (backend/rental_bookings.py):
// an accepted quote, or its invoice once converted, books one row per
// equipment line for that line's rental dates. This tab is where those rows
// are moved through their life (reserved → allocated → checked-out →
// returned), where a booking with no document behind it is entered by hand,
// and where an admin can rebuild every derived booking from the documents.
//
// Exposes:
//   window.RentalsAllocationsView   the list (desktop table / phone rows)
//   window.RentalsAllocationForm    edit a booking / add a manual one
//
// Depends on: rentals-utils.js (allocBadge, ALLOC_STATES), search-select.js
// (ProjectSearchField), ui.js.
(function() {
  var h = React.createElement, useState = React.useState;

  function eqOf(equipment, id) { return id == null ? null : (equipment || []).find(function(e) { return e.id === id; }) || null; }
  function projectOf(projects, id) { return id == null ? null : (projects || []).find(function(p) { return p.id === id; }) || null; }
  function sourceLabel(a) {
    if (a.docType === "quote") return "Quote #" + a.docId;
    if (a.docType === "invoice") return "Invoice #" + a.docId;
    return "Manual";
  }
  function isDerived(a) { return a.docType === "quote" || a.docType === "invoice"; }

  // ── Booking form ───────────────────────────────────────────────────────────
  // A derived booking keeps item, qty and dates locked to its document — those
  // change on the quote or invoice, and the engine re-derives them. State and
  // notes are always editable.
  window.RentalsAllocationForm = function({ initial, equipment, projects, companies, onSave, onClose, onDelete }) {
    var R = window.LTP_RENTALS, B = window.LTP_THEME;
    var isMobile = window.LTP_useIsMobile();
    window.LTP_useRecordWatch("allocations", initial && initial.id,
      { title: "This booking changed elsewhere",
        message: "Another window updated it while this form was open. Saving will replace the newer version." });
    var locked = !!(initial && isDerived(initial));
    var [f, setF] = useState({
      equipmentId: initial ? initial.equipmentId : null,
      projectId: initial ? initial.projectId : null,
      qty: initial ? String(initial.qty || 1) : "1",
      startDate: initial ? (initial.startDate || "") : R.today(),
      endDate: initial ? (initial.endDate || "") : R.addDays(R.today(), 2),
      state: initial ? (initial.state || "reserved") : "reserved",
      notes: initial ? (initial.notes || "") : "",
    });
    var [err, setErr] = useState("");
    var [query, setQuery] = useState("");
    var [focused, setFocused] = useState(false);
    function set(k, v) { setF(function(p) { var o = {}; o[k] = v; return Object.assign({}, p, o); }); }

    var eq = eqOf(equipment, f.equipmentId);
    var q = query.trim().toLowerCase();
    var matches = (equipment || []).filter(function(e) {
      return !q || (e.name || "").toLowerCase().indexOf(q) !== -1 || (e.category || "").toLowerCase().indexOf(q) !== -1;
    }).slice(0, 40);

    function save() {
      if (f.equipmentId == null) { setErr("Pick the item."); return; }
      var qty = parseInt(f.qty, 10);
      if (!qty || qty < 1) { setErr("Quantity must be at least 1."); return; }
      if (!f.startDate || !f.endDate) { setErr("Set the booking dates."); return; }
      if (f.startDate > f.endDate) { setErr("The booking ends before it starts."); return; }
      setErr("");
      onSave(Object.assign({}, initial || { docType: "manual", docId: null, lineId: "" }, {
        equipmentId: f.equipmentId, projectId: f.projectId, qty: qty,
        startDate: f.startDate, endDate: f.endDate, state: f.state, notes: f.notes,
      }));
    }

    var inp = Object.assign({}, R.INP, { width: "100%", boxSizing: "border-box" });
    return h(window.LTPModal, { title: initial ? "Edit Booking" : "New Booking", onClose: onClose, disableBackdrop: true },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
        err && h("div", { style: { background: B.dangerBg, border: "1px solid " + B.dangerBd, borderRadius: 6, padding: "8px 12px", color: B.danger, fontSize: "12px" } }, err),
        locked && h("div", { style: { fontSize: "11px", color: B.info, background: B.info + "14", border: "1px solid " + B.info + "44", borderRadius: 6, padding: "8px 12px", lineHeight: 1.5 } },
          "Booked by " + sourceLabel(initial) + ". The item, quantity and dates follow that document — change them there. State and notes are yours."),
        // Item
        locked || eq
          ? R.Field("Item", h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
              h("div", { style: { flex: 1, padding: "8px 12px", background: B.raised, border: "1px solid " + B.border, borderRadius: 8, fontSize: "13px", color: B.text } }, eq ? eq.name : "Item #" + f.equipmentId),
              !locked && h("button", { onClick: function() { set("equipmentId", null); }, style: { background: "none", border: "none", color: B.textMut, cursor: "pointer", fontSize: "14px" } }, "×")))
          : R.Field("Item *", h("div", { style: { position: "relative" } },
              h("input", { type: "text", value: query, placeholder: "Search the catalog…", autoFocus: true,
                onChange: function(e) { setQuery(e.target.value); setFocused(true); },
                onFocus: function() { setFocused(true); },
                onBlur: function() { setTimeout(function() { setFocused(false); }, 180); }, style: inp }),
              focused && h("div", { style: { position: "absolute", top: "100%", left: 0, right: 0, background: B.surface, border: "1px solid " + B.border, borderRadius: "0 0 6px 6px", maxHeight: 200, overflowY: "auto", zIndex: 20 } },
                matches.map(function(e) {
                  return h("div", { key: e.id, onMouseDown: function(ev) { ev.preventDefault(); }, onClick: function() { set("equipmentId", e.id); setQuery(""); setFocused(false); },
                    style: { padding: "8px 12px", cursor: "pointer", borderBottom: "1px solid " + B.border, fontSize: "12px", color: B.text } },
                    e.name, h("span", { style: { color: B.textMut, marginLeft: 6, fontSize: "11px" } }, R.eqQty(e) + " owned"));
                })))),
        h(window.ProjectSearchField, { label: "Project (optional)", projectId: f.projectId,
          setProjectId: function(id) { if (!locked) set("projectId", id); }, projects: projects || [], companies: companies || [],
          placeholder: "Which job this is for", filter: function(p) { return !p.internal; } }),
        h("div", { style: { display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "80px 1fr 1fr", gap: 10 } },
          R.Field("Qty *", h("input", { type: "number", min: 1, value: f.qty, disabled: locked, onChange: function(e) { set("qty", e.target.value); }, style: inp })),
          R.Field("From *", h(window.LTPDateField, { value: f.startDate, disabled: locked, onChange: function(v) { if (!locked) set("startDate", v); }, ariaLabel: "Booking start date", style: inp })),
          R.Field("To *", h(window.LTPDateField, { value: f.endDate, disabled: locked, onChange: function(v) { if (!locked) set("endDate", v); }, ariaLabel: "Booking end date", style: inp }))),
        R.Field("State", h("select", { value: f.state, onChange: function(e) { set("state", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) },
          R.ALLOC_STATES.map(function(s) { return h("option", { key: s, value: s }, s === "under-maintenance" ? "Under Maintenance" : s.charAt(0).toUpperCase() + s.slice(1)); }))),
        R.Field("Notes", h("textarea", { value: f.notes, onChange: function(e) { set("notes", e.target.value); }, rows: 2, style: Object.assign({}, inp, { resize: "vertical" }) })),
        h("div", { style: { display: "flex", justifyContent: "space-between", gap: 8 } },
          initial && !locked && onDelete ? h(window.Btn, { variant: "danger", small: true, onClick: onDelete }, "Delete") : h("span"),
          h("div", { style: { display: "flex", gap: 8 } },
            h(window.Btn, { variant: "ghost", onClick: onClose }, "Cancel"),
            h(window.Btn, { onClick: save }, initial ? "Save Changes" : "Add Booking")))
      )
    );
  };

  // ── List ───────────────────────────────────────────────────────────────────
  window.RentalsAllocationsView = function({ allocations, equipment, projects, isAdmin, onOpen, onSetState }) {
    var R = window.LTP_RENTALS, B = window.LTP_THEME;
    var fmt = window.LTP_formatDate;
    var isMobile = window.LTP_useIsMobile();
    var [stateFilter, setStateFilter] = useState("active");
    var [search, setSearch] = useState("");
    var [sort, setSort] = useState({ key: "dates", dir: "asc" });
    var [rebuild, setRebuild] = useState(null);   // null | "busy" | result text
    var today = R.today();

    function rebuildFromDocs() {
      setRebuild("busy");
      fetch("/api/allocations/reconcile", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" } })
        .then(function(r) { return r.json().then(function(j) { return { ok: r.ok, body: j }; }); })
        .then(function(res) {
          if (!res.ok) { setRebuild("Rebuild failed" + (res.body && res.body.detail ? ": " + JSON.stringify(res.body.detail) : "")); return; }
          var b = res.body || {};
          setRebuild("Rebuilt: " + (b.created || 0) + " booked, " + (b.updated || 0) + " updated, " + (b.removed || 0) + " released.");
        })
        .catch(function(e) { setRebuild("Rebuild failed: " + String(e)); });
    }

    var q = search.trim().toLowerCase();
    var rows = (allocations || []).filter(function(a) {
      if (stateFilter === "active" ? a.state === "returned" : (stateFilter !== "all" && a.state !== stateFilter)) return false;
      if (q) {
        var eq = eqOf(equipment, a.equipmentId), p = projectOf(projects, a.projectId);
        var hay = [(eq ? eq.name : ""), (p ? p.name : ""), sourceLabel(a), a.notes || ""].join(" ").toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    var COLS = [
      { key: "item",    label: "Item",    w: "minmax(0,1.6fr)", sort: function(a) { var e = eqOf(equipment, a.equipmentId); return e ? e.name : ""; } },
      { key: "project", label: "Project", w: "minmax(0,1.3fr)", sort: function(a) { var p = projectOf(projects, a.projectId); return p ? p.name : ""; } },
      { key: "source",  label: "Source",  w: "110px", sort: sourceLabel },
      { key: "qty",     label: "Qty",     w: "60px", align: "right", mono: true, dir: "desc", sort: function(a) { return a.qty || 0; } },
      { key: "dates",   label: "Dates",   w: "150px", sort: function(a) { return (a.startDate || "") + (a.endDate || ""); } },
      { key: "state",   label: "State",   w: "160px", sort: function(a) { return R.ALLOC_STATES.indexOf(a.state); } },
    ];
    var ordered = window.LTP_sortRows(rows, COLS, sort);
    var chips = [{ v: "active", l: "Active" }].concat(R.ALLOC_STATES.map(function(s) { return { v: s, l: s === "under-maintenance" ? "Under Maint." : s.charAt(0).toUpperCase() + s.slice(1) }; })).concat([{ v: "all", l: "All" }]);
    var chipStyle = function(on) { return { flexShrink: 0, whiteSpace: "nowrap", background: on ? B.accent : B.raised, color: on ? B.btnInk : B.textMut, border: "1px solid " + (on ? B.accent : B.border), borderRadius: isMobile ? "16px" : 4, padding: isMobile ? "8px 14px" : "4px 12px", fontSize: isMobile ? "13px" : "11px", fontWeight: 600, cursor: "pointer", minHeight: isMobile ? 36 : undefined }; };

    function stateSelect(a) {
      return h("select", { value: a.state, "aria-label": "Booking state",
        onClick: function(e) { e.stopPropagation(); },
        onChange: function(e) { e.stopPropagation(); onSetState(a.id, e.target.value); },
        style: Object.assign({}, R.INP, { padding: "3px 6px", fontSize: "11px" }) },
        R.ALLOC_STATES.map(function(s) { return h("option", { key: s, value: s }, s === "under-maintenance" ? "Under Maint." : s.charAt(0).toUpperCase() + s.slice(1)); }));
    }
    function overdue(a) { return a.state === "checked-out" && a.endDate && a.endDate < today; }
    function overdueChip() {
      return h("span", { style: { fontSize: "9px", fontWeight: 700, color: B.danger, background: B.dangerBg, border: "1px solid " + B.dangerBd, padding: "1px 6px", borderRadius: 3, textTransform: "uppercase", flexShrink: 0 } }, "Overdue");
    }

    return h("div", null,
      h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 10, lineHeight: 1.5 } },
        "Bookings come from accepted quotes and from invoices — one per equipment line, for that line's rental dates — and from bookings added here by hand. Move a booking through reserved → checked-out → returned as the gear goes out and comes back."),
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12, flexWrap: "wrap" } },
        h(window.LTPScrollStrip, { isMobile: isMobile, mobileStyle: { display: "flex", gap: 8, overflowX: "auto", flexWrap: "nowrap", WebkitOverflowScrolling: "touch", scrollbarWidth: "none", width: "100%", paddingBottom: 4 }, desktopStyle: { display: "flex", gap: 6, flexWrap: "wrap" } },
          chips.map(function(c) { return h("button", { key: c.v, className: "ltp-tap", onClick: function() { setStateFilter(c.v); }, style: chipStyle(stateFilter === c.v) }, c.l); })),
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
          h("input", { value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search item, project, source…", style: Object.assign({}, R.INP, { width: isMobile ? "100%" : 200 }) }),
          isAdmin && h(window.Btn, { small: true, variant: "ghost", disabled: rebuild === "busy", onClick: rebuildFromDocs }, rebuild === "busy" ? "Rebuilding…" : "Rebuild from documents"))),
      rebuild && rebuild !== "busy" && h("div", { style: { fontSize: "11px", color: rebuild.indexOf("failed") === 0 || rebuild.indexOf("Rebuild failed") === 0 ? B.danger : B.success, marginBottom: 10 } }, rebuild),

      ordered.length === 0
        ? h(window.EmptyState, { text: stateFilter === "active" ? "No active bookings. Accept a quote, or add a booking by hand." : "No bookings match." })
        : isMobile
        ? h(window.LTPList, null, ordered.map(function(a) {
            var eq = eqOf(equipment, a.equipmentId), p = projectOf(projects, a.projectId);
            return h(window.LTPRow, { key: a.id, onClick: function() { onOpen(a.id); }, style: { padding: "12px 14px" } },
              h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 } },
                h("div", { style: { minWidth: 0, flex: 1 } },
                  h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 3 } },
                    h("span", { style: { fontSize: "13px", fontWeight: 600, color: B.text } }, "×" + a.qty + " " + (eq ? eq.name : "Item #" + a.equipmentId)),
                    overdue(a) && overdueChip()),
                  h("div", { style: { fontSize: "11px", color: B.textMut } }, (p ? p.name + " · " : "") + sourceLabel(a) + " · " + fmt(a.startDate) + " → " + fmt(a.endDate))),
                h("div", { style: { flexShrink: 0 } }, stateSelect(a))));
          }))
        : h(window.LTPTable, { columns: COLS, sort: sort, onSort: setSort,
            rows: ordered.map(function(a) {
              var eq = eqOf(equipment, a.equipmentId), p = projectOf(projects, a.projectId);
              return { key: a.id, onClick: function() { onOpen(a.id); }, cells: [
                h("span", { style: { fontSize: "13px", fontWeight: 600, color: B.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, eq ? eq.name : "Item #" + a.equipmentId),
                h("span", { style: { fontSize: "12px", color: B.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, p ? p.name : "—"),
                h("span", { style: { fontSize: "11px", color: isDerived(a) ? B.info : B.textMut, fontWeight: 600 } }, sourceLabel(a)),
                h("span", { style: { fontSize: "12px", color: B.textSec } }, a.qty),
                h("span", { style: { fontSize: "12px", color: B.textSec, whiteSpace: "nowrap" } }, fmt(a.startDate) + " → " + fmt(a.endDate)),
                [h("span", { key: "s" }, stateSelect(a)), overdue(a) && h("span", { key: "o", style: { marginLeft: 6 } }, overdueChip())],
              ] };
            }) })
    );
  };
})();
