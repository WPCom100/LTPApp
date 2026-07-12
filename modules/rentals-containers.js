// Rentals — Containers List, Container Detail, Container Form
// Depends on: rentals-utils.js
(function() {
  var h = React.createElement, useState = React.useState;

  var CONTAINER_TYPES = ["Road Case", "Pelican Case", "Soft Bag", "Trunk", "Crate", "Rack", "Other"];

  // ── Private: Multi-item searchable typeahead ────────────────────────────────
  // items: array of { id, name }   selectedIds: array of ids   onChange: fn(ids)
  function MultiSearch({ items, selectedIds, onChange, placeholder, accentColor }) {
    var B = window.LTP_THEME;
    var accent = accentColor || B.accent;
    var accentBg = accentColor ? accentColor + "18" : B.accentMuted;
    var [query,   setQuery]   = useState("");
    var [focused, setFocused] = useState(false);
    var q = query.toLowerCase();
    var filtered = items.filter(function(item) {
      if (selectedIds.includes(item.id)) return false;
      return item.name.toLowerCase().indexOf(q) !== -1;
    });

    return h("div", null,
      // Selected chips
      selectedIds.length > 0 && h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 } },
        selectedIds.map(function(id) {
          var item = items.find(function(x) { return x.id === id; });
          if (!item) return null;
          return h("span", { key: id, style: { display: "inline-flex", alignItems: "center", gap: 4, background: accent, color: B.btnInk, fontSize: "11px", padding: "3px 8px", borderRadius: 4, fontWeight: 700 } },
            item.name,
            h("button", { onClick: function() { onChange(selectedIds.filter(function(x) { return x !== id; })); },
              style: { background: "none", border: "none", color: B.btnInk, cursor: "pointer", fontSize: "13px", fontWeight: 700, padding: "0 0 0 3px", lineHeight: 1 } }, "\u00d7"));
        })
      ),
      // Search input + dropdown
      h("div", { style: { position: "relative" } },
        h("input", { type: "text", value: query, placeholder: placeholder || "Type to search\u2026",
          onChange: function(e) { setQuery(e.target.value); setFocused(true); },
          onFocus: function() { setFocused(true); },
          onBlur:  function() { setTimeout(function() { setFocused(false); }, 180); },
          style: Object.assign({}, window.LTP_RENTALS.INP, { width: "100%" }) }),
        focused && h("div", { style: { position: "absolute", top: "100%", left: 0, right: 0, background: B.surface, border: "1px solid " + B.border, borderRadius: "0 0 6px 6px", maxHeight: 180, overflowY: "auto", zIndex: 20 } },
          filtered.length === 0
            ? h("div", { style: { padding: "10px 12px", fontSize: "12px", color: B.textMut, fontStyle: "italic" } }, query ? "No matches." : "Type to search\u2026")
            : filtered.map(function(item) {
                return h("div", { key: item.id, onMouseDown: function(e) { e.preventDefault(); }, onClick: function() { onChange(selectedIds.concat([item.id])); setQuery(""); },
                  style: { padding: "8px 12px", fontSize: "12px", cursor: "pointer", borderBottom: "1px solid " + B.border, color: B.text },
                  onMouseOver: function(e) { e.currentTarget.style.background = B.raised; },
                  onMouseOut:  function(e) { e.currentTarget.style.background = "transparent"; } }, item.name);
              })
        )
      )
    );
  }

  // ── Container Form Modal ────────────────────────────────────────────────────
  window.RentalsContainerForm = function({ initial, onClose, onSave, equipment, containers }) {
    var R = window.LTP_RENTALS, B = window.LTP_THEME;

    var blank = {
      name: "", type: "Road Case", manufacturer: "", model: "",
      serialized: false, qty: 1,
      dimensions: { l: "", w: "", h: "" },
      weightEmpty: "", color: "", notes: "",
      defaultForEquipment: [],
      canNestIds: [],
      optional: false,
      rates: { threeDay: "", week: "", month: "" },
      status: "available",
      maintenanceLogs: [], units: [],
    };

    var init = initial ? Object.assign({}, blank, initial, {
      dimensions: Object.assign({}, blank.dimensions, initial.dimensions),
      rates: {
        threeDay: initial.rates ? (initial.rates.threeDay != null ? String(initial.rates.threeDay) : "") : (initial.rentalRate != null ? String(initial.rentalRate) : ""),
        week:     initial.rates ? (initial.rates.week     != null ? String(initial.rates.week)     : "") : "",
        month:    initial.rates ? (initial.rates.month    != null ? String(initial.rates.month)    : "") : "",
      },
    }) : blank;

    var [f,     setF]     = useState(init);
    var [units, setUnits] = useState(initial && initial.serialized ? (initial.units || []).map(function(u) { return Object.assign({}, u); }) : []);
    var [err,   setErr]   = useState("");

    function set(k, v) { setF(function(p) { var o = {}; o[k] = v; return Object.assign({}, p, o); }); }
    function setRate(k, v) { setF(function(p) { var o = {}; o[k] = v; return Object.assign({}, p, { rates: Object.assign({}, p.rates, o) }); }); }
    function setDim(k, v) { setF(function(p) { return Object.assign({}, p, { dimensions: Object.assign({}, p.dimensions, (function() { var o = {}; o[k] = v; return o; })()) }); }); }

    function addUnit() {
      setUnits(function(prev) { return prev.concat([{ id: Date.now(), serial: "", barcode: "", purchaseDate: "", purchaseVendorId: null, purchaseCost: "", status: "available", maintenanceLogs: [] }]); });
    }
    function removeUnit(idx) { setUnits(function(prev) { return prev.filter(function(_, i) { return i !== idx; }); }); }
    function setUnit(idx, field, val) {
      setUnits(function(prev) { return prev.map(function(u, i) { if (i !== idx) return u; var o = {}; o[field] = val; return Object.assign({}, u, o); }); });
    }

    function save() {
      if (!f.name.trim()) { setErr("Name is required."); return; }
      if (f.serialized && units.length === 0) { setErr("Add at least one serialized unit."); return; }
      if (!f.serialized && (isNaN(parseInt(f.qty)) || parseInt(f.qty) < 1)) { setErr("Quantity must be at least 1."); return; }
      onSave(Object.assign({}, f, {
        qty:          f.serialized ? units.length : (parseInt(f.qty) || 1),
        weightEmpty:  parseFloat(f.weightEmpty) || null,
        rates: {
          threeDay: parseFloat(f.rates.threeDay) || null,
          week:     parseFloat(f.rates.week)     || null,
          month:    parseFloat(f.rates.month)    || null,
        },
        // keep rentalRate as the threeDay value for display compatibility
        rentalRate: parseFloat(f.rates.threeDay) || null,
        dimensions:   { l: parseFloat(f.dimensions.l) || null, w: parseFloat(f.dimensions.w) || null, h: parseFloat(f.dimensions.h) || null },
        units:        f.serialized ? units.map(function(u) { return Object.assign({}, u, { purchaseCost: parseFloat(u.purchaseCost) || null }); }) : [],
        maintenanceLogs: initial ? initial.maintenanceLogs : [],
      }));
    }

    // Items for MultiSearch
    var equipmentItems = equipment.filter(function(e) { return e.category !== "Accessories"; }).map(function(e) { return { id: e.id, name: e.name }; });
    var containerItems = (containers || []).filter(function(c) { return !initial || c.id !== initial.id; }).map(function(c) { return { id: c.id, name: c.name }; });

    var g2 = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 };

    return h(window.LTPModal, { title: initial ? "Edit Container" : "Add Container", onClose: onClose, wide: true, disableBackdrop: true },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },
        err && h("div", { style: { background: B.dangerBg, border: "1px solid " + B.dangerBd, borderRadius: 6, padding: "8px 12px", color: B.danger, fontSize: "12px" } }, err),

        h("div", { style: g2 },
          R.Field("Container Name *", h("input", { value: f.name, onChange: function(e) { set("name", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
          R.Field("Type", h("select", { value: f.type, onChange: function(e) { set("type", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) },
            CONTAINER_TYPES.map(function(t) { return h("option", { key: t, value: t }, t); })))
        ),

        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 80px", gap: 12 } },
          R.Field("Manufacturer", h("input", { value: f.manufacturer || "", onChange: function(e) { set("manufacturer", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
          R.Field("Model",        h("input", { value: f.model        || "", onChange: function(e) { set("model",        e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
          R.Field("Color",        h("input", { value: f.color        || "", onChange: function(e) { set("color",        e.target.value); }, placeholder: "Black", style: Object.assign({}, R.INP, { width: "100%" }) }))
        ),

        // Dimensions + weight
        h("div", { style: { background: B.raised, borderRadius: 8, padding: "14px", border: "1px solid " + B.border } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 } }, "Physical"),
          h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 } },
            R.Field("Length (in)", h("input", { type: "number", min: 0, value: f.dimensions.l || "", onChange: function(e) { setDim("l", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
            R.Field("Width (in)",  h("input", { type: "number", min: 0, value: f.dimensions.w || "", onChange: function(e) { setDim("w", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
            R.Field("Height (in)", h("input", { type: "number", min: 0, value: f.dimensions.h || "", onChange: function(e) { setDim("h", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
            R.Field("Weight (lbs)", h("input", { type: "number", min: 0, step: "0.1", value: f.weightEmpty || "", onChange: function(e) { set("weightEmpty", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) }))
          )
        ),

        // Rates section
        h("div", { style: { background: B.raised, borderRadius: 8, padding: "14px", border: "1px solid " + B.border } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 } }, "Rental Rates"),
          h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 12 } }, "Leave all blank if this container is bundled into the equipment rate."),
          h("div", { style: { display: "grid", gridTemplateColumns: f.serialized ? "1fr 1fr 1fr auto" : "1fr 1fr 1fr 100px auto", gap: 10, alignItems: "end" } },
            R.Field("3-Day ($)",  h("input", { type: "number", min: 0, step: "0.01", value: f.rates.threeDay, onChange: function(e) { setRate("threeDay", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
            R.Field("Week ($)",   h("input", { type: "number", min: 0, step: "0.01", value: f.rates.week,     onChange: function(e) { setRate("week",     e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
            R.Field("Month ($)",  h("input", { type: "number", min: 0, step: "0.01", value: f.rates.month,    onChange: function(e) { setRate("month",    e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
            !f.serialized && R.Field("Status", h("select", { value: f.status, onChange: function(e) { set("status", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%", fontSize: "11px", padding: "8px 6px" }) },
              [["available","Available"],["under-maintenance","Under Maint."],["retired","Retired"]].map(function(s) { return h("option", { key: s[0], value: s[0] }, s[1]); })
            )),
            h("label", { style: { display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: "12px", color: B.textSec, paddingBottom: 10, whiteSpace: "nowrap" } },
              h("input", { type: "checkbox", checked: !!f.optional, onChange: function(e) { set("optional", e.target.checked); }, style: { accentColor: B.accent, width: 14, height: 14 } }),
              "Optional")
          )
        ),

        // Serialized / qty
        h("div", { style: { background: B.raised, borderRadius: 8, padding: "14px", border: "1px solid " + B.border } },
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: f.serialized ? 14 : 0 } },
            h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "13px", color: B.text, fontWeight: 600 } },
              h("input", { type: "checkbox", checked: !!f.serialized, onChange: function(e) {
                set("serialized", e.target.checked);
                if (e.target.checked && units.length === 0) setUnits([{ id: Date.now(), serial: "", barcode: "", purchaseDate: "", purchaseVendorId: null, purchaseCost: "", status: "available", maintenanceLogs: [] }]);
              }, style: { accentColor: B.accent, width: 15, height: 15 } }),
              "Individually Serialized / Barcoded"),
            !f.serialized && h("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
              h("label", { style: Object.assign({}, R.LBL, { margin: 0 }) }, "Qty"),
              h("input", { type: "number", min: 1, value: f.qty || 1, onChange: function(e) { set("qty", e.target.value); }, style: Object.assign({}, R.INP, { width: 80 }) })
            )
          ),
          f.serialized && h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
            h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 4 } }, "Each row = one physical case."),
            units.map(function(u, i) {
              return h("div", { key: u.id, style: { background: B.bg, border: "1px solid " + B.border, borderRadius: 6, padding: "10px 12px" } },
                h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
                  h("span", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut } }, "Unit " + (i + 1)),
                  h("button", { onClick: function() { removeUnit(i); }, style: { background: "none", border: "none", color: B.danger, cursor: "pointer", fontSize: "16px" } }, "\u00d7")),
                h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 110px", gap: 8 } },
                  R.Field("Barcode / Asset #", h("input", { value: u.barcode || "", onChange: function(e) { setUnit(i, "barcode", e.target.value); }, placeholder: "LTP-CASE-001", style: Object.assign({}, R.INP, { width: "100%" }) })),
                  R.Field("Serial #",          h("input", { value: u.serial  || "", onChange: function(e) { setUnit(i, "serial",  e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
                  R.Field("Purchase Date",     h("input", { type: "date", value: u.purchaseDate || "", onChange: function(e) { setUnit(i, "purchaseDate", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
                  R.Field("Cost ($)",          h("input", { type: "number", min: 0, step: "0.01", value: u.purchaseCost || "", onChange: function(e) { setUnit(i, "purchaseCost", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
                  R.Field("Status",            h("select", { value: u.status || "available", onChange: function(e) { setUnit(i, "status", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%", fontSize: "11px", padding: "8px 4px" }) },
                    [["available","Available"],["under-maintenance","Under Maint."],["retired","Retired"]].map(function(s) { return h("option", { key: s[0], value: s[0] }, s[1]); })
                  ))
                )
              );
            }),
            h("button", { onClick: addUnit, style: { background: "none", border: "1px dashed " + B.border, borderRadius: 6, color: B.accent, cursor: "pointer", padding: "8px", fontSize: "12px", fontWeight: 600, width: "100%", textAlign: "center" } }, "+ Add Unit")
          )
        ),

        // Equipment assignments — searchable multi-select
        h("div", { style: { background: B.raised, borderRadius: 8, padding: "14px", border: "1px solid " + B.border } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 } }, "Default Container For Equipment"),
          h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 10 } }, "This container will auto-populate on quotes for the selected equipment."),
          h(MultiSearch, { items: equipmentItems, selectedIds: f.defaultForEquipment, onChange: function(ids) { set("defaultForEquipment", ids); }, placeholder: "Search equipment to assign\u2026" })
        ),

        // Nesting — searchable multi-select
        containerItems.length > 0 && h("div", { style: { background: B.raised, borderRadius: 8, padding: "14px", border: "1px solid " + B.border } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 } }, "Smaller Containers That Fit Inside This One"),
          h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 10 } },
            "e.g. a small Pelican lens case that rides inside a larger trunk. The selected containers will show \"Fits Inside: [this container]\" on their detail screen."),
          h(MultiSearch, { items: containerItems, selectedIds: f.canNestIds, onChange: function(ids) { set("canNestIds", ids); }, placeholder: "Search containers that nest inside\u2026", accentColor: B.info })
        ),

        R.Field("Notes", h("textarea", { value: f.notes || "", onChange: function(e) { set("notes", e.target.value); }, rows: 2, placeholder: "Foam configuration, special handling, etc.", style: Object.assign({}, R.INP, { width: "100%", resize: "vertical" }) })),

        h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
          h(window.Btn, { variant: "ghost", onClick: onClose }, "Cancel"),
          h(window.Btn, { onClick: save }, initial ? "Save Changes" : "Add Container")
        )
      )
    );
  };

  // ── Private: Unit serial/barcode search — thin wrapper over the shared
  // LTP_RENTALS SerialSearch with this surface's placeholder text.
  function ContainerSerialSearch(props) {
    return h(window.LTP_RENTALS.SerialSearch, Object.assign({
      placeholder: "Type barcode or serial\u2026",
      emptyHint: "Type to search\u2026",
    }, props));
  }

  // ── Container Detail Modal ──────────────────────────────────────────────────
  window.RentalsContainerDetail = function({ container, equipment, containers, onClose, onEdit, onDelete, onOpenEquipment, onOpenContainer, onMainLog, onMainResolve, onSetUnderMaintenance }) {
    var B = window.LTP_THEME, R = window.LTP_RENTALS;
    var fmt = window.LTP_formatDate;

    var [tab,           setTab]           = useState("overview");
    var [showMaint,     setShowMaint]     = useState(false);
    var [maintUnit,     setMaintUnit]     = useState(null);
    var [deleteConfirm, setDeleteConfirm] = useState(false);

    var linkedEquipment  = equipment.filter(function(eq) { return container.defaultForEquipment.includes(eq.id); });
    var nestedContainers = (containers || []).filter(function(c) { return container.canNestIds.includes(c.id); });
    var parentContainers = (containers || []).filter(function(c) { return (c.canNestIds || []).includes(container.id); });

    var rawQty   = container.serialized ? (container.units || []).length : (container.qty || 0);
    var maintQty = container.serialized
      ? (container.units || []).filter(function(u) { return u.status === "under-maintenance"; }).length
      : (container.status === "under-maintenance" ? rawQty : 0);

    // Collect all logs for maintenance tab
    var lineLogs = !container.serialized ? (container.maintenanceLogs || []) : [];
    var allUnitLogs = container.serialized
      ? (container.units || []).reduce(function(acc, u) {
          return acc.concat((u.maintenanceLogs || []).map(function(l) {
            return Object.assign({}, l, { unitLabel: u.barcode || u.serial || ("Unit " + u.id), unitId: u.id });
          }));
        }, [])
      : [];
    var openIssues = container.serialized
      ? allUnitLogs.filter(function(l) { return l.status === "open"; }).length
      : lineLogs.filter(function(l) { return l.status === "open"; }).length;

    var dims = container.dimensions;
    var dimStr = (dims && (dims.l || dims.w || dims.h))
      ? [dims.l, dims.w, dims.h].filter(Boolean).join(" × ") + " in"
      : null;

    var tabs = [
      { id: "overview",    label: "Overview" },
      { id: "units",       label: container.serialized ? "Units (" + rawQty + ")" : "Details" },
      { id: "maintenance", label: "Maintenance", count: openIssues || undefined },
    ];

    return h(window.LTPModal, { title: container.name, onClose: onClose, wide: true },

      // Header row
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 } },
        h("div", null,
          h("div", { style: { fontSize: "12px", color: B.textMut } }, [container.type, container.manufacturer, container.model, container.color].filter(Boolean).join(" · ")),
          container.optional && h("span", { style: { fontSize: "10px", color: B.info, fontWeight: 700, background: B.infoBg, border: "1px solid " + B.infoBd, padding: "2px 8px", borderRadius: 4, textTransform: "uppercase", marginTop: 4, display: "inline-block" } }, "Optional Add-On")
        ),
        h("div", { style: { display: "flex", gap: 6 } },
          h(window.Btn, { small: true, variant: "ghost",  onClick: onEdit   }, "Edit"),
          h(window.Btn, { small: true, variant: "danger", onClick: function() { setDeleteConfirm(true); } }, "Delete")
        )
      ),

      h(window.LTPTabs, { tabs: tabs, active: tab, onChange: setTab }),

      // ── OVERVIEW ────────────────────────────────────────────────────────────
      tab === "overview" && h("div", null,
        // Stats
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 18 } },
          h("div", { style: { background: B.raised, borderRadius: 8, padding: "12px 14px", border: "1px solid " + B.border } },
            h("div", { style: { fontSize: "10px", color: B.textMut, fontWeight: 600, textTransform: "uppercase", marginBottom: 6 } }, "Total Units"),
            h("div", { style: { fontSize: "22px", fontWeight: 700, color: B.text } }, rawQty)),
          h("div", { style: { background: maintQty > 0 ? B.dangerBg : B.raised, borderRadius: 8, padding: "12px 14px", border: "1px solid " + (maintQty > 0 ? B.dangerBd : B.border) } },
            h("div", { style: { fontSize: "10px", color: maintQty > 0 ? B.danger : B.textMut, fontWeight: 600, textTransform: "uppercase", marginBottom: 6 } }, "Under Maint."),
            h("div", { style: { fontSize: "22px", fontWeight: 700, color: maintQty > 0 ? B.danger : B.textMut } }, maintQty)),
          h("div", { style: { background: B.raised, borderRadius: 8, padding: "12px 14px", border: "1px solid " + B.border } },
            h("div", { style: { fontSize: "10px", color: B.textMut, fontWeight: 600, textTransform: "uppercase", marginBottom: 6 } }, "Rate"),
            (container.rates && container.rates.threeDay)
              ? h("div", null,
                  h("div", { style: { fontSize: "18px", fontWeight: 700, color: B.accent } }, "$" + container.rates.threeDay),
                  h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } },
                    [container.rates.week ? "Wk $" + container.rates.week : null, container.rates.month ? "Mo $" + container.rates.month : null].filter(Boolean).join("  \u00b7  ")))
              : h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.textMut } }, "Bundled"))
        ),

        // Physical details
        (dimStr || container.weightEmpty) && h("div", { style: { display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" } },
          dimStr && h("div", { style: { background: B.raised, borderRadius: 6, padding: "8px 14px", fontSize: "12px", color: B.textSec } }, dimStr),
          container.weightEmpty && h("div", { style: { background: B.raised, borderRadius: 6, padding: "8px 14px", fontSize: "12px", color: B.textSec } }, container.weightEmpty + " lbs empty")
        ),

        // Open issues summary on overview
        openIssues > 0 && h("div", { style: { marginBottom: 14 } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.danger, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 } }, "Open Issues (" + openIssues + ")"),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
            (container.serialized ? allUnitLogs : lineLogs).filter(function(l) { return l.status === "open"; }).map(function(l) {
              return h("div", { key: l.id, style: { background: B.dangerBg, borderRadius: 6, padding: "10px 12px", border: "1px solid " + B.dangerBd } },
                container.serialized && h("div", { style: { fontSize: "10px", color: B.textMut, fontWeight: 600, marginBottom: 3 } }, l.unitLabel),
                h("div", { style: { fontSize: "12px", color: B.text } }, l.issue),
                h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 3 } }, fmt(l.date)));
            })
          )
        ),

        // Linked equipment chips
        linkedEquipment.length > 0 && h("div", { style: { marginBottom: 14 } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.textSec, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 } }, "Default Container For"),
          h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
            linkedEquipment.map(function(eq) {
              return h("span", { key: eq.id, onClick: onOpenEquipment ? function() { onClose(); onOpenEquipment(eq.id); } : null,
                style: { background: B.accentMuted, color: B.accent, fontSize: "11px", padding: "3px 10px", borderRadius: 4, fontWeight: 600, border: "1px solid " + B.accent + "44", cursor: onOpenEquipment ? "pointer" : "default" } }, eq.name);
            })
          )
        ),

        // Nesting
        nestedContainers.length > 0 && h("div", { style: { marginBottom: 14 } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.textSec, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 } }, "Can Nest Inside"),
          h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
            nestedContainers.map(function(c) {
              return h("span", { key: c.id, onClick: onOpenContainer ? function() { onClose(); onOpenContainer(c.id); } : null,
                style: { background: B.infoBg, color: B.info, fontSize: "11px", padding: "3px 10px", borderRadius: 4, fontWeight: 600, border: "1px solid " + B.infoBd, cursor: onOpenContainer ? "pointer" : "default" } }, c.name);
            })
          )
        ),
        parentContainers.length > 0 && h("div", { style: { marginBottom: 14 } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.textSec, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 } }, "Fits Inside"),
          h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
            parentContainers.map(function(c) {
              return h("span", { key: c.id, onClick: onOpenContainer ? function() { onClose(); onOpenContainer(c.id); } : null,
                style: { background: B.raised, color: B.textSec, fontSize: "11px", padding: "3px 10px", borderRadius: 4, fontWeight: 600, border: "1px solid " + B.border, cursor: onOpenContainer ? "pointer" : "default" } }, c.name);
            })
          )
        ),

        container.notes && h("div", { style: { padding: "12px 14px", background: B.raised, borderRadius: 8, borderLeft: "3px solid " + B.accent, fontSize: "12px", color: B.textSec, lineHeight: 1.5 } }, container.notes)
      ),

      // ── UNITS / DETAILS TAB ─────────────────────────────────────────────────
      tab === "units" && h("div", null,
        container.serialized
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
              (container.units || []).map(function(u) {
                var assignedEqNames = linkedEquipment.map(function(eq) { return eq.name; }).join(", ");
                var unitOpenIssues = (u.maintenanceLogs || []).filter(function(l) { return l.status === "open"; }).length;
                return h("div", { key: u.id, style: { background: B.raised, borderRadius: 8, padding: "12px 14px", border: "1px solid " + (unitOpenIssues > 0 ? B.dangerBd : B.border) } },
                  h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 } },
                    h("div", null,
                      assignedEqNames && h("div", { style: { fontSize: "10px", color: B.textMut, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 } }, assignedEqNames),
                      h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.text } }, u.barcode || u.serial || "No ID"),
                      u.barcode && u.serial && h("div", { style: { fontSize: "11px", color: B.textMut } }, "S/N: " + u.serial)),
                    h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                      unitOpenIssues > 0 && h("span", { style: { fontSize: "10px", color: B.danger, fontWeight: 700 } }, unitOpenIssues + " issue" + (unitOpenIssues > 1 ? "s" : "")),
                      h("span", { style: { fontSize: "10px", fontWeight: 700, color: u.status === "available" ? B.success : B.danger, textTransform: "uppercase" } }, u.status))
                  )
                );
              })
            )
          : h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
              [
                ["Type",         container.type],
                ["Manufacturer", container.manufacturer],
                ["Model",        container.model],
                ["Color",        container.color],
                ["Dimensions",   dimStr],
                ["Weight Empty", container.weightEmpty ? container.weightEmpty + " lbs" : null],
                ["Quantity",     container.qty],
                ["Status",       container.status],
              ].filter(function(r) { return r[1]; }).map(function(r) {
                return h("div", { key: r[0], style: { display: "flex", justifyContent: "space-between", padding: "8px 12px", background: B.raised, borderRadius: 6 } },
                  h("span", { style: { fontSize: "12px", color: B.textMut, fontWeight: 600 } }, r[0]),
                  h("span", { style: { fontSize: "12px", color: B.text } }, r[1]));
              })
            )
      ),

      // ── MAINTENANCE TAB ─────────────────────────────────────────────────────
      tab === "maintenance" && h("div", null,

        // Serialized: serial search panel
        container.serialized && h("div", { style: { marginBottom: 14, padding: "12px 14px", background: B.raised, borderRadius: 8, border: "1px solid " + B.border } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 } }, "Log New Issue"),
          h("div", { style: { display: "flex", gap: 8, alignItems: "flex-end" } },
            h("div", { style: { flex: 1 } },
              h(ContainerSerialSearch, { units: container.units || [], value: maintUnit, onChange: setMaintUnit })
            ),
            h(window.Btn, { small: true, onClick: function() { if (maintUnit) setShowMaint(true); }, style: { opacity: maintUnit ? 1 : 0.4 } }, "+ Log Issue")
          ),
          !maintUnit && h("div", { style: { fontSize: "11px", color: B.textMut, fontStyle: "italic", marginTop: 8 } }, "Search a barcode or serial above to log an issue for that unit.")
        ),

        // Non-serialized: simple button
        !container.serialized && h("div", { style: { marginBottom: 12 } },
          h(window.Btn, { small: true, onClick: function() { setShowMaint(true); } }, "+ Log Issue")
        ),

        // Log list
        (container.serialized ? allUnitLogs : lineLogs).length === 0
          ? h(window.EmptyState, { text: "No maintenance history." })
          : h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
              (container.serialized ? allUnitLogs : lineLogs).slice().sort(function(a, b) { return a.date > b.date ? -1 : 1; }).map(function(log) {
                return h("div", { key: log.id, style: { background: B.raised, borderRadius: 8, padding: "12px 14px", border: "1px solid " + (log.status === "open" ? B.dangerBd : B.border) } },
                  h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 } },
                    h("div", null,
                      container.serialized && h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.text, marginBottom: 2 } }, log.unitLabel),
                      h("span", { style: { fontSize: "11px", color: B.textMut } }, fmt(log.date))),
                    h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                      h("span", { style: { fontSize: "10px", fontWeight: 700, color: log.status === "open" ? B.danger : B.success, textTransform: "uppercase" } }, log.status),
                      log.status === "open" && h("button", { onClick: function() { onMainResolve(log.id, log.unitId || null); },
                        style: { fontSize: "11px", color: B.success, background: "none", border: "1px solid " + B.successBd, borderRadius: 4, cursor: "pointer", padding: "2px 8px" } }, "Resolve")
                    )
                  ),
                  h("div", { style: { fontSize: "12px", color: B.textSec } }, log.issue),
                  log.resolvedDate && h("div", { style: { fontSize: "11px", color: B.textMut, marginTop: 4 } }, "Resolved: " + fmt(log.resolvedDate))
                );
              })
            ),

        showMaint && h(window.RentalsMaintenanceForm, {
          onClose: function() { setShowMaint(false); },
          serialized: container.serialized,
          selectedUnit: container.serialized ? (container.units || []).find(function(u) { return u.id === maintUnit; }) : null,
          onSave: function(d, setUnderMaint) {
            onMainLog(d, container.serialized ? maintUnit : null);
            if (setUnderMaint) onSetUnderMaintenance(container.serialized ? maintUnit : null);
            setShowMaint(false);
            setMaintUnit(null);
          },
        })
      ),
      deleteConfirm && h(window.LTPConfirmDialog, {
        dlg: {
          title: "Confirm Delete",
          message: 'Are you sure you want to delete "' + container.name + '"? This cannot be undone.',
          variant: "danger", confirmLabel: "Delete",
          onConfirm: function() { setDeleteConfirm(false); onDelete(); },
        },
        onCancel: function() { setDeleteConfirm(false); },
      })
    );
  };

  // ── Containers List View ────────────────────────────────────────────────────
  window.RentalsContainersView = function({ containers, equipment, onOpenContainer }) {
    var R = window.LTP_RENTALS, B = window.LTP_THEME;
    var isMobile = window.LTP_useIsMobile();
    var [typeFilter, setTypeFilter] = useState("all");
    var [search,     setSearch]     = useState("");
    var [sortMode,   setSortMode]   = useState("az");

    var types = ["all"].concat(Array.from(new Set((containers || []).map(function(c) { return c.type; }))));
    var q = search.toLowerCase();

    var filtered = (containers || []).filter(function(c) {
      if (typeFilter !== "all" && c.type !== typeFilter) return false;
      if (q && c.name.toLowerCase().indexOf(q) === -1 && (c.manufacturer || "").toLowerCase().indexOf(q) === -1) return false;
      return true;
    }).slice().sort(function(a, b) {
      if (sortMode === "za") return b.name.localeCompare(a.name);
      return a.name.localeCompare(b.name);
    });

    return h("div", null,
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12, flexWrap: "wrap" } },
        h("div", { className: "ltp-tabs-strip", style: isMobile ? { display: "flex", gap: 8, overflowX: "auto", flexWrap: "nowrap", WebkitOverflowScrolling: "touch", scrollbarWidth: "none", width: "100%", paddingBottom: 4 } : { display: "flex", gap: 6, flexWrap: "wrap" } },
          types.map(function(t) {
            return h("button", { key: t, onClick: function() { setTypeFilter(t); }, className: "ltp-tap",
              style: { flexShrink: 0, whiteSpace: "nowrap", background: typeFilter === t ? B.accent : B.raised, color: typeFilter === t ? B.btnInk : B.textMut, border: "1px solid " + (typeFilter === t ? B.accent : B.border), borderRadius: isMobile ? "16px" : 4, padding: isMobile ? "8px 16px" : "4px 12px", fontSize: isMobile ? "13px" : "11px", fontWeight: 600, cursor: "pointer", minHeight: isMobile ? 36 : undefined } }, t === "all" ? "All" : t);
          })
        ),
        h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
          h("input", { value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search containers...", style: Object.assign({}, R.INP, { width: isMobile ? "100%" : 180 }, isMobile ? { borderRadius: "8px", padding: "9px 12px" } : {}) }),
          [{ k: "az", l: "A\u2192Z" }, { k: "za", l: "Z\u2192A" }].map(function(o) {
            return h("button", { key: o.k, onClick: function() { setSortMode(o.k); },
              style: { background: sortMode === o.k ? B.accent : B.raised, color: sortMode === o.k ? B.btnInk : B.textMut, border: "1px solid " + (sortMode === o.k ? B.accent : B.border), borderRadius: 4, padding: "4px 10px", fontSize: "11px", fontWeight: 600, cursor: "pointer" } }, o.l);
          })
        )
      ),

      filtered.length === 0 ? h(window.EmptyState, { text: "No containers match your search." }) :
      h(window.LTPList, null,
        filtered.map(function(c) {
          var rawQty   = c.serialized ? (c.units || []).length : (c.qty || 0);
          var maintQty = c.serialized
            ? (c.units || []).filter(function(u) { return u.status === "under-maintenance"; }).length
            : (c.status === "under-maintenance" ? rawQty : 0);
          var openLogs = (c.maintenanceLogs || []).filter(function(l) { return l.status === "open"; }).length;
          var linkedEq = equipment.filter(function(eq) { return c.defaultForEquipment.includes(eq.id); });

          return h(window.LTPRow, { key: c.id, onClick: function() { onOpenContainer(c.id); },
            style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },

            h("div", null,
              h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 3 } },
                h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.text } }, c.name),
                c.optional && h("span", { style: { fontSize: "9px", fontWeight: 700, color: B.info, background: B.infoBg, border: "1px solid " + B.infoBd, padding: "1px 6px", borderRadius: 3, textTransform: "uppercase" } }, "Optional")
              ),
              h("div", { style: { fontSize: "11px", color: B.textMut } },
                [c.type, c.manufacturer, c.model].filter(Boolean).join(" · ") +
                (linkedEq.length > 0 ? " · Default for: " + linkedEq.map(function(e) { return e.name; }).join(", ") : ""))
            ),

            h("div", { style: { display: "flex", gap: 12, alignItems: "center" } },
              openLogs > 0 && h("span", { style: { fontSize: "10px", color: B.danger, fontWeight: 700 } }, openLogs + " issue" + (openLogs > 1 ? "s" : "")),
              c.rentalRate && h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.accent } }, "$" + c.rentalRate + "/3-day"),
              h("div", { style: { textAlign: "right" } },
                h("div", { style: { fontSize: "12px", color: B.textMut } }, rawQty + " units"),
                maintQty > 0 && h("div", { style: { fontSize: "10px", color: B.danger, fontWeight: 600 } }, maintQty + " under maint."))
            )
          );
        })
      )
    );
  };
})();
