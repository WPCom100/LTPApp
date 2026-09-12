// Rentals — Cross Rentals: orders of gear rented IN from a vendor.
// docs/CROSS_RENTAL_PLAN.md. One order per vendor, with lines: the fixtures
// (catalog items, which count as our inventory once the order is confirmed)
// and the parts and accessories that come with them (cost only).
//
// Exposes:
//   window.RentalsCrossView    the orders list (desktop table / phone rows)
//   window.RentalsCrossForm    create / edit an order and its lines
//   window.RentalsCrossDetail  one order's popup
//
// Depends on: rentals-utils.js (pricing engine, crossBadge, lineCost,
// VendorSearch), search-select.js (ProjectSearchField), ui.js.
(function() {
  var h = React.createElement, useState = React.useState;
  var genId = window.LTP_genId;

  function money(n) { return "$" + window.LTP_money(n || 0); }
  function vendorOf(companies, id) {
    return id == null ? null : (companies || []).find(function(c) { return c.id === id; }) || null;
  }
  function vendorLabel(companies, id) {
    var v = vendorOf(companies, id);
    return v ? v.name : (id == null ? "No vendor" : "Vendor #" + id);
  }
  function eqOf(equipment, id) {
    return id == null ? null : (equipment || []).find(function(e) { return e.id === id; }) || null;
  }
  function projectOf(projects, id) {
    return id == null ? null : (projects || []).find(function(p) { return p.id === id; }) || null;
  }
  function findVendorRate(vendorRates, vendorId, eqId) {
    if (vendorId == null || eqId == null) return null;
    return (vendorRates || []).find(function(v) {
      return v.vendorCompanyId === vendorId && v.equipmentId === eqId && v.active !== false;
    }) || null;
  }
  function ratesEqual(a, b) {
    return ["threeDay", "week", "month"].every(function(k) { return (Number(a && a[k]) || 0) === (Number(b && b[k]) || 0); });
  }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  // Form lines hold strings (inputs); the engine and the API want numbers.
  function toNumericLine(l) {
    return {
      id: l.id, equipmentId: l.equipmentId == null ? null : l.equipmentId, name: (l.name || "").trim(),
      qty: Math.max(0, parseInt(l.qty, 10) || 0),
      startDate: l.ownDates ? (l.startDate || "") : "", endDate: l.ownDates ? (l.endDate || "") : "",
      rates: { threeDay: num(l.rates.threeDay), week: num(l.rates.week), month: num(l.rates.month) },
      costOverride: (l.costOverride === "" || l.costOverride == null) ? null : Math.max(0, num(l.costOverride)),
      notes: l.notes || "",
    };
  }
  function fromStoredLine(l) {
    var r = l.rates || {};
    return {
      id: l.id || genId("crl"), equipmentId: l.equipmentId == null ? null : l.equipmentId, name: l.name || "",
      qty: l.qty != null ? String(l.qty) : "1",
      ownDates: !!(l.startDate || l.endDate), startDate: l.startDate || "", endDate: l.endDate || "",
      rates: { threeDay: r.threeDay != null ? String(r.threeDay) : "", week: r.week != null ? String(r.week) : "", month: r.month != null ? String(r.month) : "" },
      costOverride: l.costOverride == null ? "" : String(l.costOverride),
      notes: l.notes || "",
    };
  }
  function ratesFromRow(row) {
    var r = (row && row.rates) || {};
    return { threeDay: r.threeDay != null ? String(r.threeDay) : "", week: r.week != null ? String(r.week) : "", month: r.month != null ? String(r.month) : "" };
  }
  // "6× Mac Aura XB, 6× Safety cables" for a list row.
  function linesSummary(order) {
    var parts = (order.lines || []).map(function(l) { return (l.qty || 0) + "× " + (l.name || "item"); });
    var s = parts.slice(0, 2).join(", ");
    if (parts.length > 2) s += " +" + (parts.length - 2) + " more";
    return s || "No lines";
  }

  // ── Order form ──────────────────────────────────────────────────────────────
  // `prefill` seeds a CREATE form (ignored when `initial` is set): the checker
  // and the quote picker open it with the item, the dates and a chosen vendor.
  window.RentalsCrossForm = function({ initial, prefill, vendors, companies, equipment, projects, vendorRates, onSave, onClose, modalZIndex }) {
    var R = window.LTP_RENTALS, B = window.LTP_THEME;
    var isMobile = window.LTP_useIsMobile();
    window.LTP_useRecordWatch("cross-rentals", initial && initial.id,
      { title: "This cross rental changed elsewhere",
        message: "Another window updated it while this form was open. Saving will replace the newer version." });

    var seed = initial || prefill || {};
    var [f, setF] = useState({
      vendorCompanyId: seed.vendorCompanyId != null ? seed.vendorCompanyId : null,
      reference: seed.reference || "",
      status: seed.status || "quoted",
      startDate: seed.startDate || R.today(),
      endDate: seed.endDate || R.addDays(seed.startDate || R.today(), 6),
      projectId: seed.projectId != null ? seed.projectId : null,
      rememberRates: seed.rememberRates == null ? true : !!seed.rememberRates,
      notes: seed.notes || "",
    });
    var [lines, setLines] = useState(function() {
      if (initial) return (initial.lines || []).map(fromStoredLine);
      if (prefill && prefill.equipmentId != null) {
        var eq = eqOf(equipment, prefill.equipmentId);
        var row = findVendorRate(vendorRates, prefill.vendorCompanyId, prefill.equipmentId);
        return [{ id: genId("crl"), equipmentId: prefill.equipmentId, name: eq ? eq.name : "", qty: String(prefill.qty || 1),
                  ownDates: false, startDate: "", endDate: "", rates: ratesFromRow(row), costOverride: "", notes: "" }];
      }
      return [];
    });
    var [err, setErr] = useState("");
    var [query, setQuery] = useState("");
    var [focused, setFocused] = useState(false);

    function set(k, v) { setF(function(p) { var o = {}; o[k] = v; return Object.assign({}, p, o); }); }
    function patchLine(id, patch) {
      setLines(function(prev) { return prev.map(function(l) { return l.id === id ? Object.assign({}, l, patch) : l; }); });
    }
    function patchLineRate(id, k, v) {
      setLines(function(prev) { return prev.map(function(l) {
        if (l.id !== id) return l;
        var o = {}; o[k] = v;
        return Object.assign({}, l, { rates: Object.assign({}, l.rates, o) });
      }); });
    }
    function removeLine(id) { setLines(function(prev) { return prev.filter(function(l) { return l.id !== id; }); }); }

    // Picking a vendor re-seeds every catalog line from that vendor's price
    // rows — the price memory is the whole point. Lines with no row on file
    // keep whatever was typed.
    function chooseVendor(id) {
      set("vendorCompanyId", id);
      setLines(function(prev) { return prev.map(function(l) {
        var row = findVendorRate(vendorRates, id, l.equipmentId);
        return row ? Object.assign({}, l, { rates: ratesFromRow(row) }) : l;
      }); });
    }
    function addEquipment(eq) {
      var row = findVendorRate(vendorRates, f.vendorCompanyId, eq.id);
      setLines(function(prev) { return prev.concat([{ id: genId("crl"), equipmentId: eq.id, name: eq.name, qty: "1",
        ownDates: false, startDate: "", endDate: "", rates: ratesFromRow(row), costOverride: "", notes: "" }]); });
      setQuery(""); setFocused(false);
    }
    function addPart() {
      setLines(function(prev) { return prev.concat([{ id: genId("crl"), equipmentId: null, name: "", qty: "1",
        ownDates: false, startDate: "", endDate: "", rates: { threeDay: "", week: "", month: "" }, costOverride: "", notes: "" }]); });
    }

    var q = query.trim().toLowerCase();
    var matches = (equipment || []).filter(function(e) {
      if (!q) return true;
      return (e.name || "").toLowerCase().indexOf(q) !== -1 || (e.category || "").toLowerCase().indexOf(q) !== -1
          || (e.manufacturer || "").toLowerCase().indexOf(q) !== -1;
    }).slice(0, 40);

    var orderLike = { startDate: f.startDate, endDate: f.endDate };
    var numericLines = lines.map(toNumericLine);
    var total = numericLines.reduce(function(s, l) { return s + R.lineCost(orderLike, l); }, 0);

    function save() {
      if (f.vendorCompanyId == null) { setErr("Pick the vendor this order is with."); return; }
      if (!f.startDate || !f.endDate) { setErr("Set the rental period."); return; }
      if (f.startDate > f.endDate) { setErr("The rental period ends before it starts."); return; }
      if (lines.length === 0) { setErr("Add at least one line."); return; }
      for (var i = 0; i < numericLines.length; i++) {
        var l = numericLines[i];
        if (l.qty < 1) { setErr("Every line needs a quantity of at least 1."); return; }
        if (l.equipmentId == null && !l.name) { setErr("Give every part or accessory a name."); return; }
        if (l.startDate && l.endDate && l.startDate > l.endDate) { setErr("A line's own period ends before it starts."); return; }
      }
      setErr("");
      onSave(Object.assign({}, f, { reference: f.reference.trim(), notes: f.notes, lines: numericLines }));
    }

    var vendorRow = f.vendorCompanyId != null ? vendorOf(companies, f.vendorCompanyId) : null;
    var g2 = { display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12 };
    var small = Object.assign({}, R.INP, { width: "100%", boxSizing: "border-box", padding: "6px 8px" });

    function lineRow(l) {
      var n = toNumericLine(l);
      var eq = eqOf(equipment, l.equipmentId);
      var row = findVendorRate(vendorRates, f.vendorCompanyId, l.equipmentId);
      var onFile = row && ratesEqual(row.rates, n.rates);
      var cost = R.lineCost(orderLike, n);
      var d = R.lineDates(orderLike, n);
      var engine = R.calcRentalPrice(d.start || null, d.end || null, n.rates);
      var isPart = l.equipmentId == null;
      return h("div", { key: l.id, style: { background: B.bg, border: "1px solid " + B.border, borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 } },
        // Name · qty · remove
        h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
          isPart
            ? h("input", { value: l.name, placeholder: "Part or accessory (e.g. safety cables)", onChange: function(e) { patchLine(l.id, { name: e.target.value }); }, style: Object.assign({}, small, { flex: 1 }) })
            : h("div", { style: { flex: 1, minWidth: 0 } },
                h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, l.name || (eq ? eq.name : "Item")),
                eq && h("div", { style: { fontSize: "10px", color: B.textMut } }, [eq.category, eq.subcategory].filter(Boolean).join(" · ") + " · " + R.eqQty(eq) + " owned")),
          h("label", { style: { fontSize: "10px", color: B.textMut, fontWeight: 600, textTransform: "uppercase" } }, "Qty"),
          h("input", { type: "number", min: 1, value: l.qty, onChange: function(e) { patchLine(l.id, { qty: e.target.value }); }, style: Object.assign({}, small, { width: 64, textAlign: "center" }) }),
          h("button", { onClick: function() { removeLine(l.id); }, "aria-label": "Remove line", style: { background: "none", border: "none", color: B.danger, cursor: "pointer", fontSize: "16px", lineHeight: 1, padding: "0 4px" } }, "×")
        ),
        // Vendor rates · cost
        h("div", { style: { display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr 1fr" : "1fr 1fr 1fr 1.4fr", gap: 8, alignItems: "end" } },
          R.RATE_KEYS.map(function(k) {
            return h("div", { key: k, style: { display: "flex", flexDirection: "column", gap: 3 } },
              h("label", { style: { fontSize: "10px", fontWeight: 600, color: B.textMut, textTransform: "uppercase" } }, "Vendor " + R.RATE_LABELS[k] + " ($)"),
              h("input", { type: "number", min: 0, step: "0.01", value: l.rates[k], onChange: function(e) { patchLineRate(l.id, k, e.target.value); }, style: small }));
          }),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 3, gridColumn: isMobile ? "1 / -1" : undefined } },
            h("label", { style: { fontSize: "10px", fontWeight: 600, color: B.textMut, textTransform: "uppercase" } }, "Line cost"),
            h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
              h("input", { type: "number", min: 0, step: "0.01", value: l.costOverride, placeholder: money(engine.totalPrice * n.qty),
                title: "Type a negotiated flat total to override the computed cost",
                onChange: function(e) { patchLine(l.id, { costOverride: e.target.value }); }, style: Object.assign({}, small, { flex: 1 }) }),
              h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.accent, whiteSpace: "nowrap" } }, money(cost))))
        ),
        // Rate-on-file chip · engine label · own dates · notes
        h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: "10px", color: B.textMut } },
          !isPart && onFile && h("span", { style: { background: B.info + "1c", border: "1px solid " + B.info + "55", color: B.info, borderRadius: 3, padding: "1px 5px", fontSize: "9px", fontWeight: 700, whiteSpace: "nowrap" } },
            "RATE ON FILE" + (row.quotedDate ? " · quoted " + window.LTP_formatDate(row.quotedDate) : "")),
          !isPart && row && !onFile && h("span", { style: { color: B.warn, fontWeight: 600 } }, "differs from the price on file (" + money(row.rates && row.rates.threeDay) + "/3-day)"),
          !isPart && !row && f.vendorCompanyId != null && h("span", null, "no price on file for this vendor yet"),
          n.costOverride == null && h("span", null, engine.label + (n.qty > 1 ? " × " + n.qty : "")),
          h("label", { style: { display: "flex", alignItems: "center", gap: 4, cursor: "pointer", marginLeft: "auto" } },
            h("input", { type: "checkbox", checked: !!l.ownDates, onChange: function(e) { patchLine(l.id, { ownDates: e.target.checked, startDate: e.target.checked ? (l.startDate || f.startDate) : "", endDate: e.target.checked ? (l.endDate || f.endDate) : "" }); }, style: { accentColor: B.accent } }),
            "own dates")
        ),
        l.ownDates && h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 } },
          h(window.LTPDateField, { value: l.startDate, onChange: function(v) { patchLine(l.id, { startDate: v }); }, ariaLabel: "Line start date", style: small }),
          h(window.LTPDateField, { value: l.endDate, onChange: function(v) { patchLine(l.id, { endDate: v }); }, ariaLabel: "Line end date", style: small })),
        h("input", { value: l.notes, placeholder: "Line notes (optional)", onChange: function(e) { patchLine(l.id, { notes: e.target.value }); }, style: small })
      );
    }

    return h(window.LTPModal, { title: initial ? "Edit Cross Rental" : "New Cross Rental", onClose: onClose, wide: true, disableBackdrop: true, zIndex: modalZIndex },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },
        err && h("div", { style: { background: B.dangerBg, border: "1px solid " + B.dangerBd, borderRadius: 6, padding: "8px 12px", color: B.danger, fontSize: "12px" } }, err),

        h("div", { style: g2 },
          R.Field("Vendor *", h(R.VendorSearch, { vendors: vendors, value: f.vendorCompanyId, onChange: chooseVendor })),
          R.Field("Reference / PO", h("input", { value: f.reference, onChange: function(e) { set("reference", e.target.value); }, placeholder: "Vendor quote, PO or confirmation #", style: Object.assign({}, R.INP, { width: "100%", boxSizing: "border-box" }) }))
        ),
        h("div", { style: { display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr", gap: 12 } },
          R.Field("From *", h(window.LTPDateField, { value: f.startDate, onChange: function(v) { set("startDate", v); }, ariaLabel: "Order start date", style: Object.assign({}, R.INP, { width: "100%", boxSizing: "border-box" }) })),
          R.Field("To *", h(window.LTPDateField, { value: f.endDate, onChange: function(v) { set("endDate", v); }, ariaLabel: "Order end date", style: Object.assign({}, R.INP, { width: "100%", boxSizing: "border-box" }) })),
          R.Field("Status", h("select", { value: f.status, onChange: function(e) { set("status", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) },
            R.CROSS_STATES.map(function(s) { return h("option", { key: s, value: s }, R.CROSS_LABELS[s]); })))
        ),
        h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
          [{ l: "3 Days", d: 2 }, { l: "1 Week", d: 6 }, { l: "2 Weeks", d: 13 }, { l: "1 Month", d: 29 }].map(function(p) {
            return h("button", { key: p.l, onClick: function() { set("endDate", R.addDays(f.startDate || R.today(), p.d)); },
              style: { background: B.raised, border: "1px solid " + B.border, borderRadius: 4, color: B.textMut, padding: "5px 10px", fontSize: "11px", fontWeight: 600, cursor: "pointer" } }, p.l);
          }),
          h("span", { style: { fontSize: "10px", color: B.textMut, alignSelf: "center" } }, "A quoted order is flagged in availability; it counts as stock once confirmed.")
        ),
        h(window.ProjectSearchField, { label: "Project (optional)", projectId: f.projectId,
          setProjectId: function(id) { set("projectId", id); }, projects: projects || [], companies: companies || [],
          placeholder: "Leave empty when the order spans several jobs",
          filter: function(p) { return !p.internal && p.status !== "completed"; } }),

        // Lines
        h("div", { style: { background: B.raised, borderRadius: 8, padding: "14px", border: "1px solid " + B.border } },
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8, flexWrap: "wrap" } },
            h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, "Lines *"),
            h(window.Btn, { small: true, variant: "ghost", onClick: addPart }, "+ Part / accessory")),
          lines.length > 0 && h("div", { style: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 } }, lines.map(lineRow)),
          h("div", { style: { position: "relative" } },
            h("input", { type: "text", value: query, placeholder: "Search the catalog to add an item…",
              onChange: function(e) { setQuery(e.target.value); setFocused(true); },
              onFocus: function() { setFocused(true); },
              onBlur: function() { setTimeout(function() { setFocused(false); }, 180); },
              style: Object.assign({}, R.INP, { width: "100%", boxSizing: "border-box" }) }),
            focused && h("div", { style: { position: "absolute", top: "100%", left: 0, right: 0, background: B.surface, border: "1px solid " + B.border, borderRadius: "0 0 6px 6px", maxHeight: 220, overflowY: "auto", zIndex: 20 } },
              matches.length === 0
                ? h("div", { style: { padding: "10px 12px", fontSize: "12px", color: B.textMut, fontStyle: "italic" } }, q ? "No matches. Add it to the equipment list first, or add it as a part." : "Type to search the catalog…")
                : matches.map(function(eq) {
                    var row = findVendorRate(vendorRates, f.vendorCompanyId, eq.id);
                    return h("div", { key: eq.id, onMouseDown: function(e) { e.preventDefault(); }, onClick: function() { addEquipment(eq); },
                      style: { padding: "8px 12px", cursor: "pointer", borderBottom: "1px solid " + B.border },
                      onMouseOver: function(e) { e.currentTarget.style.background = B.raised; },
                      onMouseOut: function(e) { e.currentTarget.style.background = "transparent"; } },
                      h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, eq.name + (eq.crossRentalOnly ? "  · cross-rental only" : "")),
                      h("div", { style: { fontSize: "11px", color: B.textMut } }, [eq.category, eq.subcategory].filter(Boolean).join(" · ") + " · " + R.eqQty(eq) + " owned"
                        + (row ? " · on file: " + money(row.rates && row.rates.threeDay) + "/3-day" : "")));
                  })))
        ),

        // Total · remember · notes
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" } },
          h("label", { style: { display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: "12px", color: B.textSec } },
            h("input", { type: "checkbox", checked: !!f.rememberRates, onChange: function(e) { set("rememberRates", e.target.checked); }, style: { accentColor: B.accent, width: 13, height: 13 } }),
            "Remember these prices for " + (vendorRow ? vendorRow.name : "this vendor")),
          h("div", { style: { textAlign: "right" } },
            h("div", { style: { fontSize: "10px", color: B.textMut, textTransform: "uppercase", fontWeight: 600 } }, "Order cost"),
            h("div", { style: { fontSize: "18px", fontWeight: 700, color: B.accent } }, money(total)))
        ),
        R.Field("Notes", h("textarea", { value: f.notes, onChange: function(e) { set("notes", e.target.value); }, rows: 2, placeholder: "Delivery, pickup contact, terms…", style: Object.assign({}, R.INP, { width: "100%", boxSizing: "border-box", resize: "vertical" }) })),

        h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
          h(window.Btn, { variant: "ghost", onClick: onClose }, "Cancel"),
          h(window.Btn, { onClick: save }, initial ? "Save Changes" : "Save Cross Rental"))
      )
    );
  };

  // ── Order detail ────────────────────────────────────────────────────────────
  window.RentalsCrossDetail = function({ order, companies, equipment, projects, vendorRates, onClose, onEdit, onDelete, onStatus, onOpenEquipment }) {
    var R = window.LTP_RENTALS, B = window.LTP_THEME;
    var fmt = window.LTP_formatDate;
    var isMobile = window.LTP_useIsMobile();
    var [deleteConfirm, setDeleteConfirm] = useState(false);

    var vendor = vendorOf(companies, order.vendorCompanyId);
    var project = projectOf(projects, order.projectId);
    var overdue = R.crossOverdue(order, R.today());
    var total = R.orderCost(order);

    return h(window.LTPModal, { title: (vendor ? vendor.name : "Cross Rental") + (order.reference ? " · " + order.reference : ""), onClose: onClose, wide: true },
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14, gap: 10, flexWrap: "wrap" } },
        h("div", null,
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 } },
            R.crossBadge(order.status),
            overdue && h("span", { style: { fontSize: "10px", fontWeight: 700, color: B.danger, background: B.dangerBg, border: "1px solid " + B.dangerBd, padding: "2px 8px", borderRadius: 4, textTransform: "uppercase" } }, "Overdue"),
            h("select", { value: order.status, onChange: function(e) { onStatus(e.target.value); }, "aria-label": "Change status",
              style: Object.assign({}, R.INP, { padding: "3px 8px", fontSize: "11px" }) },
              R.CROSS_STATES.map(function(s) { return h("option", { key: s, value: s }, "→ " + R.CROSS_LABELS[s]); }))),
          h("div", { style: { fontSize: "12px", color: B.textMut } }, fmt(order.startDate) + " → " + fmt(order.endDate)
            + (project ? " · " + project.name : " · no project (spans jobs)")),
          !vendor && order.vendorCompanyId == null && h("div", { style: { fontSize: "11px", color: B.warn, marginTop: 2 } }, "The vendor on this order no longer exists in CRM.")
        ),
        h("div", { style: { display: "flex", gap: 6, flexShrink: 0 } },
          h(window.Btn, { small: true, variant: "ghost", onClick: onEdit }, "Edit"),
          h(window.Btn, { small: true, variant: "danger", onClick: function() { setDeleteConfirm(true); } }, "Delete"))
      ),
      order.status === "quoted" && h("div", { style: { fontSize: "11px", color: B.info, background: B.info + "14", border: "1px solid " + B.info + "44", borderRadius: 6, padding: "8px 12px", marginBottom: 14 } },
        "Quoted: shown as “quoted” in availability but not counted as stock until this order is confirmed."),

      h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.textSec, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 } }, "Lines (" + (order.lines || []).length + ")"),
      h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 } },
        (order.lines || []).map(function(l) {
          var eq = eqOf(equipment, l.equipmentId);
          var d = R.lineDates(order, l);
          var cost = R.lineCost(order, l);
          var engine = R.calcRentalPrice(d.start || null, d.end || null, l.rates);
          // Other vendors' prices for the same item and period, for the record.
          var others = l.equipmentId == null ? [] : R.vendorOptions(vendorRates, companies, l.equipmentId, d.start, d.end)
            .filter(function(o) { return o.rate.vendorCompanyId !== order.vendorCompanyId; });
          return h("div", { key: l.id, style: { background: B.raised, borderRadius: 6, padding: "10px 12px", border: "1px solid " + B.border } },
            h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 } },
              h("div", { style: { minWidth: 0 } },
                h("div", { onClick: eq ? function() { onOpenEquipment(eq.id); } : null,
                  style: { fontSize: "12px", fontWeight: 600, color: eq ? B.accent : B.text, cursor: eq ? "pointer" : "default" } },
                  "×" + (l.qty || 0) + "  " + (l.name || (eq ? eq.name : "Item")) + (l.equipmentId == null ? "  · part" : "")),
                h("div", { style: { fontSize: "11px", color: B.textMut } },
                  (l.startDate || l.endDate ? fmt(d.start) + " → " + fmt(d.end) + " · " : "")
                  + (l.costOverride != null ? "flat " + money(l.costOverride) : engine.label + " @ " + money(engine.totalPrice) + " each"))),
              h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.accent, whiteSpace: "nowrap" } }, money(cost))),
            others.length > 0 && h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 4 } },
              "Also priced: " + others.map(function(o) { return o.vendorName + " " + money(o.cost); }).join(" · ")),
            l.notes && h("div", { style: { fontSize: "11px", color: B.textSec, marginTop: 4, fontStyle: "italic" } }, l.notes)
          );
        })
      ),
      h("div", { style: { display: "flex", justifyContent: "flex-end", padding: "10px 12px", background: B.raised, borderRadius: 6, border: "1px solid " + B.border, marginBottom: order.notes ? 12 : 0 } },
        h("div", { style: { textAlign: "right" } },
          h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 2 } }, "Order cost"),
          h("div", { style: { fontSize: "16px", fontWeight: 700, color: B.accent } }, money(total)))),
      order.notes && h("div", { style: { padding: "12px 14px", background: B.raised, borderRadius: 8, borderLeft: "3px solid " + B.accent, fontSize: "12px", color: B.textSec, lineHeight: 1.5, whiteSpace: "pre-wrap" } }, order.notes),

      deleteConfirm && h(window.LTPConfirmDialog, {
        dlg: { title: "Delete this cross rental?",
               message: "The order and its lines are removed. Prices remembered from it stay on the vendor.",
               variant: "danger", confirmLabel: "Delete",
               onConfirm: function() { setDeleteConfirm(false); onDelete(); } },
        onCancel: function() { setDeleteConfirm(false); },
      })
    );
  };

  // ── Orders list ─────────────────────────────────────────────────────────────
  window.RentalsCrossView = function({ crossRentals, companies, equipment, projects, onOpen }) {
    var R = window.LTP_RENTALS, B = window.LTP_THEME;
    var fmt = window.LTP_formatDate;
    var isMobile = window.LTP_useIsMobile();
    var [statusFilter, setStatusFilter] = useState("open");
    var [vendorFilter, setVendorFilter] = useState("all");
    var [search, setSearch] = useState("");
    var [sort, setSort] = useState({ key: "dates", dir: "asc" });
    var today = R.today();

    var OPEN = { "quoted": true, "confirmed": true, "picked-up": true };
    var vendorIds = Array.from(new Set((crossRentals || []).map(function(o) { return o.vendorCompanyId; }).filter(function(x) { return x != null; })));
    var q = search.trim().toLowerCase();

    var filtered = (crossRentals || []).filter(function(o) {
      if (statusFilter === "open" ? !OPEN[o.status] : (statusFilter !== "all" && o.status !== statusFilter)) return false;
      if (vendorFilter !== "all" && String(o.vendorCompanyId) !== String(vendorFilter)) return false;
      if (q) {
        var hay = [vendorLabel(companies, o.vendorCompanyId), o.reference || "", (o.lines || []).map(function(l) { return l.name || ""; }).join(" "), o.notes || ""].join(" ").toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    var COLS = [
      { key: "vendor", label: "Vendor", w: "minmax(0,1.2fr)", sort: function(o) { return vendorLabel(companies, o.vendorCompanyId); } },
      { key: "ref",    label: "Reference", w: "minmax(0,0.9fr)", sort: function(o) { return o.reference || ""; } },
      { key: "items",  label: "Items", w: "minmax(0,1.8fr)", sort: function(o) { return (o.lines || []).length; } },
      { key: "dates",  label: "Dates", w: "150px", sort: function(o) { return (o.startDate || "") + (o.endDate || ""); } },
      { key: "status", label: "Status", w: "112px", sort: function(o) { return R.CROSS_STATES.indexOf(o.status); } },
      { key: "cost",   label: "Cost", w: "100px", align: "right", mono: true, dir: "desc", sort: function(o) { return R.orderCost(o); } },
      { key: "project", label: "Project", w: "minmax(0,1fr)", sort: function(o) { var p = projectOf(projects, o.projectId); return p ? p.name : ""; } },
    ];
    var ordered = window.LTP_sortRows(filtered, COLS, sort);

    var chipStyle = function(on) { return { flexShrink: 0, whiteSpace: "nowrap", background: on ? B.accent : B.raised, color: on ? B.btnInk : B.textMut, border: "1px solid " + (on ? B.accent : B.border), borderRadius: isMobile ? "16px" : 4, padding: isMobile ? "8px 14px" : "4px 12px", fontSize: isMobile ? "13px" : "11px", fontWeight: 600, cursor: "pointer", minHeight: isMobile ? 36 : undefined }; };
    var chips = [{ v: "open", l: "Open" }].concat(R.CROSS_STATES.map(function(s) { return { v: s, l: R.CROSS_LABELS[s] }; })).concat([{ v: "all", l: "All" }]);

    function overdueChip() {
      return h("span", { style: { fontSize: "9px", fontWeight: 700, color: B.danger, background: B.dangerBg, border: "1px solid " + B.dangerBd, padding: "1px 6px", borderRadius: 3, textTransform: "uppercase", flexShrink: 0 } }, "Overdue");
    }

    return h("div", null,
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12, flexWrap: "wrap" } },
        h(window.LTPScrollStrip, { isMobile: isMobile, mobileStyle: { display: "flex", gap: 8, overflowX: "auto", flexWrap: "nowrap", WebkitOverflowScrolling: "touch", scrollbarWidth: "none", width: "100%", paddingBottom: 4 }, desktopStyle: { display: "flex", gap: 6, flexWrap: "wrap" } },
          chips.map(function(c) { return h("button", { key: c.v, className: "ltp-tap", onClick: function() { setStatusFilter(c.v); }, style: chipStyle(statusFilter === c.v) }, c.l); })),
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
          vendorIds.length > 1 && h("select", { value: vendorFilter, onChange: function(e) { setVendorFilter(e.target.value); }, style: Object.assign({}, R.INP, { padding: "6px 8px" }) },
            [h("option", { key: "all", value: "all" }, "All vendors")].concat(vendorIds.map(function(id) { return h("option", { key: id, value: id }, vendorLabel(companies, id)); }))),
          h("input", { value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search vendor, PO, item…", style: Object.assign({}, R.INP, { width: isMobile ? "100%" : 200 }) }))
      ),

      ordered.length === 0
        ? h(window.EmptyState, { text: statusFilter === "open" ? "No open cross rentals. Add one when a job needs gear you don't have." : "No cross rentals match." })
        : isMobile
        ? h(window.LTPList, null, ordered.map(function(o) {
            var p = projectOf(projects, o.projectId);
            return h(window.LTPRow, { key: o.id, onClick: function() { onOpen(o.id); }, style: { padding: "12px 14px" } },
              h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 } },
                h("div", { style: { minWidth: 0, flex: 1 } },
                  h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 3, flexWrap: "wrap" } },
                    h("span", { style: { fontSize: "13px", fontWeight: 600, color: B.text } }, vendorLabel(companies, o.vendorCompanyId)),
                    o.reference && h("span", { style: { fontSize: "11px", color: B.textMut } }, o.reference),
                    R.crossOverdue(o, today) && overdueChip()),
                  h("div", { style: { fontSize: "11px", color: B.textSec, marginBottom: 3 } }, linesSummary(o)),
                  h("div", { style: { fontSize: "11px", color: B.textMut } }, fmt(o.startDate) + " → " + fmt(o.endDate) + (p ? " · " + p.name : ""))),
                h("div", { style: { textAlign: "right", flexShrink: 0 } },
                  h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.accent, marginBottom: 4 } }, money(R.orderCost(o))),
                  R.crossBadge(o.status))));
          }))
        : h(window.LTPTable, { columns: COLS, sort: sort, onSort: setSort,
            rows: ordered.map(function(o) {
              var p = projectOf(projects, o.projectId);
              return { key: o.id, onClick: function() { onOpen(o.id); }, cells: [
                h("span", { style: { fontSize: "13px", fontWeight: 600, color: B.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, vendorLabel(companies, o.vendorCompanyId)),
                h("span", { style: { fontSize: "12px", color: B.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, o.reference || "—"),
                h("span", { style: { fontSize: "12px", color: B.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, linesSummary(o)),
                h("span", { style: { fontSize: "12px", color: B.textSec, whiteSpace: "nowrap" } }, fmt(o.startDate) + " → " + fmt(o.endDate)),
                [h("span", { key: "s" }, R.crossBadge(o.status)), R.crossOverdue(o, today) && h("span", { key: "o", style: { marginLeft: 4 } }, overdueChip())],
                h("span", { style: { fontSize: "13px", fontWeight: 700, color: B.accent } }, money(R.orderCost(o))),
                h("span", { style: { fontSize: "12px", color: B.textMut, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, p ? p.name : "—"),
              ] };
            }) })
    );
  };
})();
