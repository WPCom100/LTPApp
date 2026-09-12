// ═══════════════════════════════════════════════════════════════════════════
//   VENDOR RENTAL RATES — what each vendor charges US per catalog item
// ═══════════════════════════════════════════════════════════════════════════
//
// The price memory behind cross rentals (docs/CROSS_RENTAL_PLAN.md). One row
// per (vendor, item): the vendor's 3-day / week / month price, what they call
// the item, when the price was last quoted, a preferred flag, and active /
// paused. Saving a cross-rental order refreshes these rows; this editor is the
// direct way in.
//
// This file owns the EDITOR (window.VendorRatesEditor), which drops into any
// surface that already knows ONE side of the pair: the CRM vendor screen
// (scoped by vendorCompanyId — you pick the item) and the equipment popup
// (scoped by equipmentId — you pick the vendor). Plus the vendor's order
// history (window.VendorCrossHistory). Resolution and costing live in
// modules/rentals-utils.js (vendorOptions / calcRentalPrice). Nothing here
// does pricing.
(function() {
  var B = window.LTP_THEME, h = React.createElement, useState = React.useState;

  function money(n) { return "$" + window.LTP_money(n || 0); }
  function toNum(v) { if (v === "" || v === null || v === undefined) return null; var n = Number(v); return isFinite(n) && n >= 0 ? n : null; }
  function fromNum(v) { return (v === null || v === undefined) ? "" : String(v); }

  // ── Add / edit form ───────────────────────────────────────────────────────
  function RateForm({ initial, scope, equipment, companies, taken, onSave, onCancel, onDelete }) {
    window.LTP_useRecordWatch("vendor-rates", initial && initial.id,
      { title: "This vendor price changed elsewhere",
        message: "Another window updated it while this form was open. Saving will replace the newer version." });
    var R = window.LTP_RENTALS;
    var isMobile = window.LTP_useIsMobile();
    var [equipmentId, setEquipmentId] = useState(initial ? initial.equipmentId : (scope.equipmentId != null ? scope.equipmentId : ""));
    var [vendorId, setVendorId] = useState(initial ? initial.vendorCompanyId : (scope.vendorCompanyId != null ? scope.vendorCompanyId : null));
    var [rates, setRates] = useState({
      threeDay: initial ? fromNum(initial.rates && initial.rates.threeDay) : "",
      week:     initial ? fromNum(initial.rates && initial.rates.week) : "",
      month:    initial ? fromNum(initial.rates && initial.rates.month) : "",
    });
    var [vendorItem, setVendorItem] = useState(initial ? (initial.vendorItem || "") : "");
    var [quotedDate, setQuotedDate] = useState(initial ? (initial.quotedDate || "") : R.today());
    var [preferred, setPreferred] = useState(initial ? !!initial.preferred : false);
    var [active, setActive] = useState(initial ? initial.active !== false : true);
    var [notes, setNotes] = useState(initial ? (initial.notes || "") : "");
    var [err, setErr] = useState("");
    function setRate(k, v) { setRates(function(p) { var o = {}; o[k] = v; return Object.assign({}, p, o); }); }

    var vendors = (companies || []).filter(function(c) { return c.isVendor; });
    var itemOptions = [{ value: "", label: "Select an item…" }].concat(
      (equipment || []).filter(function(e) { return !taken[e.id] || e.id === equipmentId; })
        .map(function(e) { return { value: e.id, label: e.name, sublabel: [e.category, e.subcategory].filter(Boolean).join(" · ") + " · " + (e.crossRentalOnly ? "cross-rental only" : R.eqQty(e) + " owned") }; }));

    function submit() {
      if (equipmentId === "" || equipmentId == null) { setErr("Pick the item this price is for."); return; }
      if (vendorId == null) { setErr("Pick the vendor."); return; }
      if (!R.RATE_KEYS.some(function(k) { return (toNum(rates[k]) || 0) > 0; })) { setErr("Enter at least one rate."); return; }
      setErr("");
      onSave({
        vendorCompanyId: vendorId, equipmentId: Number(equipmentId),
        rates: { threeDay: toNum(rates.threeDay) || 0, week: toNum(rates.week) || 0, month: toNum(rates.month) || 0 },
        vendorItem: vendorItem.trim(), quotedDate: quotedDate || "", preferred: !!preferred, active: !!active, notes: notes,
      });
    }

    var toggle = function(on, onClick, labelOn, labelOff) {
      return h("button", { onClick: onClick,
        style: { background: on ? B.accent : B.raised, color: on ? B.btnInk : B.textMut, border: "1px solid " + (on ? B.accent : B.border),
                 borderRadius: "4px", padding: "4px 14px", fontSize: "11px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" } },
        on ? labelOn : labelOff);
    };

    return h("div", { style: { background: B.raised, border: "1px solid " + B.accent + "44", borderRadius: "8px", padding: 14, marginBottom: 12 } },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
        err && h("div", { style: { background: B.dangerBg, border: "1px solid " + B.dangerBd, borderRadius: 6, padding: "8px 12px", color: B.danger, fontSize: "12px" } }, err),
        h("div", { style: { display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 10 } },
          // Whichever side the scope does not fix is the one to pick.
          scope.equipmentId == null
            ? h("div", null,
                h("div", { style: { fontSize: "11px", fontWeight: 600, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 } }, "Item *"),
                h(window.LTPSearchSelect, { value: equipmentId, onChange: function(v) { setEquipmentId(v === "" ? "" : Number(v)); },
                  options: itemOptions, searchPlaceholder: "Search the catalog…", disabled: !!initial, panelMinWidth: 260 }))
            : h("div", null,
                h("div", { style: { fontSize: "11px", fontWeight: 600, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 } }, "Vendor *"),
                initial
                  ? h("div", { style: { padding: "8px 12px", fontSize: "13px", color: B.text } }, (vendors.find(function(v) { return v.id === vendorId; }) || {}).name || "Vendor #" + vendorId)
                  : h(R.VendorSearch, { vendors: vendors.filter(function(v) { return !taken[v.id]; }), value: vendorId, onChange: setVendorId })),
          h(window.LTPInput, { label: "Vendor's item name / SKU", value: vendorItem, onChange: setVendorItem, placeholder: "What the vendor calls it" })
        ),
        h("div", { style: { display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr 1fr", gap: 8, alignItems: "end" } },
          R.RATE_KEYS.map(function(k) {
            return h(window.LTPInput, { key: k, label: R.RATE_LABELS[k] + " ($)", value: rates[k], onChange: function(v) { setRate(k, v); },
              type: "number", inputMode: "decimal", step: "0.01", placeholder: "0" });
          }),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
            h("label", { style: { fontSize: "11px", fontWeight: 600, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, "Quoted on"),
            h(window.LTPDateField, { value: quotedDate, onChange: setQuotedDate, ariaLabel: "Quoted date", style: Object.assign({}, R.INP, { width: "100%", boxSizing: "border-box" }) }))
        ),
        h("div", { style: { fontSize: "10px", color: B.textMut, lineHeight: 1.5 } },
          "Per unit, what the vendor charges us. The same 3-day / week / month tiers as our own rates, so a cross-rental line is costed by the same engine that prices the quote."),
        h(window.LTPInput, { label: "Notes", value: notes, onChange: setNotes, placeholder: "Minimums, delivery, who quoted it…" }),
        h("div", { style: { display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" } },
          h("div", { style: { display: "flex", gap: 6 } },
            toggle(preferred, function() { setPreferred(!preferred); }, "★ Preferred", "Preferred"),
            toggle(active, function() { setActive(!active); }, "Active", "Paused")),
          h("div", { style: { display: "flex", gap: 8 } },
            initial && h(window.Btn, { small: true, variant: "danger", onClick: onDelete }, "Delete"),
            h(window.Btn, { small: true, variant: "ghost", onClick: onCancel }, "Cancel"),
            h(window.Btn, { small: true, onClick: submit }, initial ? "Save Price" : "Add Price")))
      )
    );
  }

  // ── Editor ────────────────────────────────────────────────────────────────
  // scope: { vendorCompanyId } on the CRM vendor screen, { equipmentId } on the
  // equipment popup. `compact` drops the header line for the popup.
  window.VendorRatesEditor = function({ vendorCompanyId, equipmentId, equipment, companies, vendorRates, setVendorRates, compact }) {
    var R = window.LTP_RENTALS;
    var fmt = window.LTP_formatDate;
    var [editing, setEditing] = useState(null);   // null | "new" | row id
    var scope = { vendorCompanyId: vendorCompanyId != null ? vendorCompanyId : null, equipmentId: equipmentId != null ? equipmentId : null };

    var rows = (vendorRates || []).filter(function(v) {
      if (scope.vendorCompanyId != null && v.vendorCompanyId !== scope.vendorCompanyId) return false;
      if (scope.equipmentId != null && v.equipmentId !== scope.equipmentId) return false;
      return true;
    });
    // The other side of each existing pair, so the add form can't create a
    // second row for the same (vendor, item).
    var taken = {};
    rows.forEach(function(v) { taken[scope.vendorCompanyId != null ? v.equipmentId : v.vendorCompanyId] = true; });
    rows = rows.slice().sort(function(a, b) {
      if (!!a.preferred !== !!b.preferred) return a.preferred ? -1 : 1;
      if ((a.active !== false) !== (b.active !== false)) return a.active !== false ? -1 : 1;
      return ((a.rates && a.rates.threeDay) || 0) - ((b.rates && b.rates.threeDay) || 0);
    });

    function eqName(id) { var e = (equipment || []).find(function(x) { return x.id === id; }); return e ? e.name : "Item #" + id; }
    function vendorName(id) { var c = (companies || []).find(function(x) { return x.id === id; }); return c ? c.name : "Vendor #" + id; }

    function save(data) {
      if (editing === "new") {
        setVendorRates(function(prev) {
          var nextId = Math.max.apply(null, prev.map(function(v) { return v.id; }).concat([0])) + 1;
          return prev.concat([Object.assign({ id: nextId }, data)]);
        });
      } else {
        var id = editing;
        setVendorRates(function(prev) { return prev.map(function(v) { return v.id === id ? Object.assign({}, v, data) : v; }); });
      }
      setEditing(null);
    }
    function remove(id) {
      setVendorRates(function(prev) { return prev.filter(function(v) { return v.id !== id; }); });
      setEditing(null);
    }

    var current = editing !== null && editing !== "new" ? rows.find(function(v) { return v.id === editing; }) : null;

    return h("div", null,
      !compact && h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 8, lineHeight: 1.5 } },
        "What this vendor charges us per item. Saving a cross rental with “remember these prices” on updates these rows too."),
      rows.length === 0 && editing === null && h("div", { style: { fontSize: "12px", color: B.textMut, fontStyle: "italic", marginBottom: 8 } },
        scope.equipmentId != null ? "No vendor has priced this item yet." : "No prices on file for this vendor yet."),
      rows.length > 0 && h("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 } },
        rows.map(function(v) {
          if (editing === v.id) {
            return h(RateForm, { key: v.id, initial: v, scope: scope, equipment: equipment, companies: companies, taken: taken,
              onSave: save, onCancel: function() { setEditing(null); }, onDelete: function() { remove(v.id); } });
          }
          var paused = v.active === false;
          var r = v.rates || {};
          return h("div", { key: v.id, onClick: function() { setEditing(v.id); },
            style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, background: B.bg, border: "1px solid " + B.border, borderRadius: 6, padding: "8px 12px", cursor: "pointer", opacity: paused ? 0.6 : 1 },
            onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent + "44"; },
            onMouseOut: function(e) { e.currentTarget.style.borderColor = B.border; } },
            h("div", { style: { minWidth: 0 } },
              h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
                h("span", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, scope.vendorCompanyId != null ? eqName(v.equipmentId) : vendorName(v.vendorCompanyId)),
                v.preferred && h("span", { style: { fontSize: "9px", fontWeight: 700, color: B.accent, background: B.accent + "1c", border: "1px solid " + B.accent + "55", padding: "1px 5px", borderRadius: 3 } }, "★ PREFERRED"),
                paused && h("span", { style: { fontSize: "9px", fontWeight: 700, color: B.textMut, background: B.raised, border: "1px solid " + B.border, padding: "1px 5px", borderRadius: 3 } }, "PAUSED")),
              h("div", { style: { fontSize: "10px", color: B.textMut } },
                [v.vendorItem, v.quotedDate ? "quoted " + fmt(v.quotedDate) : "", v.notes].filter(Boolean).join(" · ") || " ")),
            h("div", { style: { display: "flex", gap: 10, flexShrink: 0, fontSize: "11px", color: B.textSec, whiteSpace: "nowrap" } },
              R.RATE_KEYS.map(function(k) {
                return h("span", { key: k },
                  h("span", { style: { color: B.textMut, fontSize: "9px", textTransform: "uppercase", fontWeight: 700, marginRight: 3 } }, R.RATE_LABELS[k]),
                  h("span", { style: { fontWeight: 700, color: B.accent } }, money(r[k])));
              }))
          );
        })),
      editing === "new"
        ? h(RateForm, { scope: scope, equipment: equipment, companies: companies, taken: taken, onSave: save, onCancel: function() { setEditing(null); } })
        : h(window.Btn, { small: true, variant: "ghost", onClick: function() { setEditing("new"); } }, "+ Add price")
    );
  };

  // ── Order history for one vendor ───────────────────────────────────────────
  window.VendorCrossHistory = function({ vendorCompanyId, crossRentals, onOpenOrder }) {
    var R = window.LTP_RENTALS;
    var fmt = window.LTP_formatDate;
    var orders = (crossRentals || []).filter(function(o) { return o.vendorCompanyId === vendorCompanyId; })
      .sort(function(a, b) { return (b.startDate || "") > (a.startDate || "") ? 1 : -1; });
    var year = R.today().slice(0, 4);
    var spend = orders.filter(function(o) { return o.status !== "cancelled" && (o.startDate || "").slice(0, 4) === year; })
      .reduce(function(s, o) { return s + R.orderCost(o); }, 0);
    if (orders.length === 0) return h("div", { style: { fontSize: "12px", color: B.textMut, fontStyle: "italic" } }, "Nothing rented from this vendor yet.");
    return h("div", null,
      h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 8 } }, orders.length + " order" + (orders.length === 1 ? "" : "s") + " · " + money(spend) + " this year (excl. cancelled)"),
      h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
        orders.slice(0, 8).map(function(o) {
          var summary = (o.lines || []).map(function(l) { return (l.qty || 0) + "× " + (l.name || "item"); }).slice(0, 3).join(", ");
          return h("div", { key: o.id, onClick: function() { onOpenOrder(o.id); },
            style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, background: B.bg, border: "1px solid " + B.border, borderRadius: 6, padding: "8px 12px", cursor: "pointer" },
            onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent + "44"; },
            onMouseOut: function(e) { e.currentTarget.style.borderColor = B.border; } },
            h("div", { style: { minWidth: 0 } },
              h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, (o.reference ? o.reference + " · " : "") + summary),
              h("div", { style: { fontSize: "10px", color: B.textMut } }, fmt(o.startDate) + " → " + fmt(o.endDate))),
            h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 } },
              h("span", { style: { fontSize: "12px", fontWeight: 700, color: B.accent } }, money(R.orderCost(o))),
              R.crossBadge(o.status)));
        })));
  };
})();
