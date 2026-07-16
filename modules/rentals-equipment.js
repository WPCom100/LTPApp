// Rentals — Equipment Form + Equipment Detail Modal
// Depends on: rentals-utils.js, rentals-maintenance.js
(function() {
  var h = React.createElement, useState = React.useState;

  // Vendor typeahead now lives in rentals-utils.js (window.LTP_RENTALS.VendorSearch)
  // so the scan-import session can share the same picker. Referenced below as
  // R.VendorSearch (R = window.LTP_RENTALS inside each component).

  // ── Private: Serial typeahead — thin wrapper over the shared LTP_RENTALS
  // component with this surface's placeholder text.
  function SerialSearch(props) {
    return h(window.LTP_RENTALS.SerialSearch, Object.assign({
      placeholder: "Type barcode or serial to search...",
      emptyHint: "Type barcode or serial to search\u2026",
    }, props));
  }

  // ── Equipment Form Modal ────────────────────────────────────────────────────
  window.RentalsEquipmentForm = function({ initial, onClose, onSave, vendors }) {
    var R = window.LTP_RENTALS, B = window.LTP_THEME;
    var isMobile = window.LTP_useIsMobile();

    var blankRates = { threeDay: 0, week: 0, month: 0 };
    var blank = {
      name: "", category: "Lighting", subcategory: "", manufacturer: "", model: "",
      serialized: false, qty: 1,
      rates: Object.assign({}, blankRates),
      status: "available", vendorCompanyId: null,
      location: "", weight: "", notes: "",
      units: [],
    };

    var init = initial
      ? Object.assign({}, blank, initial, { rates: Object.assign({}, blankRates, initial.rates) })
      : blank;

    var [f,     setF]     = useState(init);
    var [units, setUnits] = useState(
      // For serialized, start with existing units or generate blanks for qty
      initial && initial.serialized
        ? (initial.units || []).map(function(u) { return Object.assign({}, u); })
        : []
    );
    var [err, setErr] = useState("");
    var [showScan, setShowScan] = useState(false);

    // Append one scanned unit to the form's local units (staged — persisted when
    // the form is saved). Shared shape with buildScannedUnit / the manual rows.
    function addScannedUnit(unit) { setUnits(function(prev) { return prev.concat([unit]); }); }
    function removeScannedUnit(id) { setUnits(function(prev) { return prev.filter(function(u) { return u.id !== id; }); }); }

    function set(k, v) { setF(function(p) { var o = {}; o[k] = v; return Object.assign({}, p, o); }); }
    function setRate(k, v) { setF(function(p) { var o = {}; o[k] = v; return Object.assign({}, p, { rates: Object.assign({}, p.rates, o) }); }); }

    // When serialized toggles on, generate blank unit slots for current qty
    function toggleSerialized(val) {
      set("serialized", val);
      if (val && units.length === 0) {
        var count = initial ? (initial.units || []).length || (initial.qty || 1) : 1;
        setUnits(Array.from({ length: count }, function(_, i) {
          return { id: Date.now() + i, serial: "", barcode: "", purchaseDate: "", purchaseVendor: "", purchaseCost: "", status: "available", maintenanceLogs: [] };
        }));
      }
    }

    // Add a new unit row
    function addUnit() {
      setUnits(function(prev) {
        return prev.concat([{ id: Date.now(), serial: "", barcode: "", purchaseDate: "", purchaseVendor: "", purchaseCost: "", status: "available", maintenanceLogs: [] }]);
      });
    }

    function removeUnit(idx) {
      setUnits(function(prev) { return prev.filter(function(_, i) { return i !== idx; }); });
    }

    function setUnit(idx, field, val) {
      setUnits(function(prev) {
        return prev.map(function(u, i) {
          if (i !== idx) return u;
          var o = {}; o[field] = val;
          return Object.assign({}, u, o);
        });
      });
    }

    function save() {
      if (!f.name.trim()) { setErr("Name is required."); return; }
      if (!f.category)    { setErr("Category is required."); return; }
      if (f.serialized && units.length === 0) { setErr("Add at least one serialized unit."); return; }
      if (!f.serialized && (isNaN(parseInt(f.qty)) || parseInt(f.qty) < 1)) { setErr("Quantity must be at least 1."); return; }

      var cleanUnits = units.map(function(u) {
        return Object.assign({}, u, {
          purchaseCost: parseFloat(u.purchaseCost) || null,
          purchaseVendorId: u.purchaseVendorId || null,
        });
      });

      onSave(Object.assign({}, f, {
        qty:         f.serialized ? cleanUnits.length : (parseInt(f.qty) || 1),
        weight:      parseFloat(f.weight) || null,
        rates: {
          threeDay: parseFloat(f.rates.threeDay) || 0,
          week:     parseFloat(f.rates.week)     || 0,
          month:    parseFloat(f.rates.month)    || 0,
        },
        units:              f.serialized ? cleanUnits : [],
        accessories:        initial ? initial.accessories        : [],
        defaultContainerId: initial ? initial.defaultContainerId : null,
        maintenanceLogs:    f.serialized ? [] : (initial ? initial.maintenanceLogs : []),
      }));
    }

    var g2 = { display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12 };
    var g3 = { display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr", gap: 10 };

    return h(window.LTPModal, { title: initial ? "Edit Equipment" : "Add Equipment", onClose: onClose, wide: true, disableBackdrop: true },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },
        err && h("div", { style: { background: B.dangerBg, border: "1px solid " + B.dangerBd, borderRadius: 6, padding: "8px 12px", color: B.danger, fontSize: "12px" } }, err),

        // Name + Category
        h("div", { style: g2 },
          R.Field("Equipment Name *", h("input", { value: f.name, onChange: function(e) { set("name", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
          R.Field("Category *", h("select", { value: f.category, onChange: function(e) { set("category", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) },
            R.CATEGORIES.map(function(c) { return h("option", { key: c, value: c }, c); })))
        ),

        h("div", { style: g2 },
          R.Field("Subcategory", h("input", { value: f.subcategory || "", onChange: function(e) { set("subcategory", e.target.value); }, placeholder: "e.g. Moving Profile", style: Object.assign({}, R.INP, { width: "100%" }) })),
          R.Field("Status", h("select", { value: f.status || "available", onChange: function(e) { set("status", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) },
            [["available", "Available"], ["under-maintenance", "Under Maintenance"], ["retired", "Retired"]].map(function(s) {
              return h("option", { key: s[0], value: s[0] }, s[1]);
            })))
        ),

        // Manufacturer + Model + Location + Weight
        h("div", { style: { display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr 80px", gap: 12 } },
          R.Field("Manufacturer", h("input", { value: f.manufacturer || "", onChange: function(e) { set("manufacturer", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
          R.Field("Model",        h("input", { value: f.model        || "", onChange: function(e) { set("model",        e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
          R.Field("Location",     h("input", { value: f.location     || "", onChange: function(e) { set("location",     e.target.value); }, placeholder: "Warehouse A", style: Object.assign({}, R.INP, { width: "100%" }) })),
          R.Field("Weight", h("input", { type: "number", min: 0, step: "0.1", value: f.weight || "", onChange: function(e) { set("weight", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) }))
        ),

        // Vendor from CRM — only for non-serialized (serialized items have per-unit vendor)
        !f.serialized && R.Field("Purchase Vendor (from CRM)", h("select", { value: f.vendorCompanyId || "", onChange: function(e) { set("vendorCompanyId", e.target.value ? Number(e.target.value) : null); }, style: Object.assign({}, R.INP, { width: "100%" }) },
          h("option", { value: "" }, "— Select vendor —"),
          (vendors || []).map(function(v) { return h("option", { key: v.id, value: v.id }, v.name); })
        )),

        // Rates (3-day is minimum / base rate)
        h("div", { style: { background: B.raised, borderRadius: 8, padding: "14px", border: "1px solid " + B.border } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 } }, "Rental Rates"),
          h("div", { style: g3 },
            R.Field("3-Day ($) *", h("input", { type: "number", min: 0, step: "0.01", value: f.rates.threeDay, onChange: function(e) { setRate("threeDay", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
            R.Field("Week ($)",    h("input", { type: "number", min: 0, step: "0.01", value: f.rates.week,     onChange: function(e) { setRate("week",     e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
            R.Field("Month ($)",   h("input", { type: "number", min: 0, step: "0.01", value: f.rates.month,    onChange: function(e) { setRate("month",    e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) }))
          )
        ),

        // Serialized toggle + qty
        h("div", { style: { background: B.raised, borderRadius: 8, padding: "14px", border: "1px solid " + B.border } },
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: f.serialized ? 14 : 0 } },
            h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "13px", color: B.text, fontWeight: 600 } },
              h("input", { type: "checkbox", checked: !!f.serialized, onChange: function(e) { toggleSerialized(e.target.checked); }, style: { accentColor: B.accent, width: 15, height: 15 } }),
              "Individually Serialized / Barcoded"),
            !f.serialized && h("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
              h("label", { style: Object.assign({}, R.LBL, { margin: 0 }) }, "Qty"),
              h("input", { type: "number", min: 1, value: f.qty || 1, onChange: function(e) { set("qty", e.target.value); }, style: Object.assign({}, R.INP, { width: 80 }) })
            )
          ),

          // Serialized unit rows
          f.serialized && h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
            h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 4 } }, "Each row = one physical unit. Add a row for each unit purchased."),
            units.map(function(u, i) {
              return h("div", { key: u.id, style: { background: B.bg, border: "1px solid " + B.border, borderRadius: 6, padding: "10px 12px" } },
                h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
                  h("span", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut } }, "Unit " + (i + 1)),
                  h("button", { onClick: function() { removeUnit(i); }, style: { background: "none", border: "none", color: B.danger, cursor: "pointer", fontSize: "16px", lineHeight: 1 } }, "\u00d7")
                ),
                h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 } },
                  R.Field("Serial #", h("input", { value: u.serial || "", onChange: function(e) { setUnit(i, "serial", e.target.value); }, placeholder: "SFR3K-001", style: Object.assign({}, R.INP, { width: "100%" }) })),
                  R.Field("Barcode / Asset #", h("input", { value: u.barcode || "", onChange: function(e) { setUnit(i, "barcode", e.target.value); }, placeholder: "LTP-SF3-001", style: Object.assign({}, R.INP, { width: "100%" }) }))
                ),
                h("div", { style: { display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr auto", gap: 8, alignItems: "end" } },
                  R.Field("Purchase Date", h("input", { type: "date", value: u.purchaseDate || "", onChange: function(e) { setUnit(i, "purchaseDate", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
                  R.Field("Purchase Vendor (CRM)", h(R.VendorSearch, { vendors: vendors, value: u.purchaseVendorId || null, onChange: function(id) { setUnit(i, "purchaseVendorId", id); } })),
                  R.Field("Cost ($)", h("input", { type: "number", min: 0, step: "0.01", value: u.purchaseCost || "", onChange: function(e) { setUnit(i, "purchaseCost", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
                  R.Field("Status", h("select", { value: u.status || "available", onChange: function(e) { setUnit(i, "status", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) },
                    [["available", "Available"], ["under-maintenance", "Under Maint."], ["retired", "Retired"]].map(function(s) {
                      return h("option", { key: s[0], value: s[0] }, s[1]);
                    })
                  ))
                )
              );
            }),
            h("div", { style: { display: "flex", gap: 8 } },
              h("button", { onClick: addUnit, style: { background: "none", border: "1px dashed " + B.border, borderRadius: 6, color: B.accent, cursor: "pointer", padding: "8px", fontSize: "12px", fontWeight: 600, flex: 1, textAlign: "center" } }, "+ Add Unit"),
              h("button", { onClick: function() { setShowScan(true); }, style: { background: "none", border: "1px dashed " + B.accent, borderRadius: 6, color: B.accent, cursor: "pointer", padding: "8px", fontSize: "12px", fontWeight: 700, flex: 1, textAlign: "center" } }, "📷 Scan Units")
            )
          )
        ),

        R.Field("Notes", h("textarea", { value: f.notes || "", onChange: function(e) { set("notes", e.target.value); }, rows: 3, placeholder: "Condition notes, special instructions...", style: Object.assign({}, R.INP, { width: "100%", resize: "vertical" }) })),

        h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
          h(window.Btn, { variant: "ghost", onClick: onClose }, "Cancel"),
          h(window.Btn, { onClick: save }, initial ? "Save Changes" : "Add Equipment")
        ),

        // Inline scan-import overlay (create flow: units stage into the form and
        // save with it). Rendered last so its full-screen sheet paints on top.
        showScan && h(window.RentalsScanSession, {
          eq: { name: f.name || "New Equipment" },
          existingUnits: units,
          vendors: vendors,
          onAddUnit:    addScannedUnit,
          onRemoveUnit: removeScannedUnit,
          onClose:      function() { setShowScan(false); },
        })
      )
    );
  };

  // ── Equipment Detail Modal ──────────────────────────────────────────────────
  window.RentalsEquipmentDetail = function({ eq, allocations, projects, vendors, containers, onClose, onEdit, onDelete, onScan, onMainLog, onMainResolve, onSetUnderMaintenance, onOpenContainer }) {
    var R = window.LTP_RENTALS, B = window.LTP_THEME;
    var fmt = window.LTP_formatDate;
    var isMobile = window.LTP_useIsMobile();

    var [tab,           setTab]           = useState("overview");
    var [showMaint,     setShowMaint]     = useState(false);
    var [maintUnit,     setMaintUnit]     = useState(null);
    var [deleteConfirm, setDeleteConfirm] = useState(false);

    var td = R.today();
    var totalQty    = R.eqQty(eq);  // rentable (excludes under-maintenance/retired)
    var rawQty      = eq.serialized ? (eq.units || []).length : (eq.qty || 0);  // all physical units
    var maintQty    = eq.serialized
      ? (eq.units || []).filter(function(u) { return u.status === "under-maintenance"; }).length
      // Non-serialized: full decommission (eq.status flag) takes
      // priority and reports the whole qty; otherwise sum the open-log
      // partial-out qtys via the canonical helper.
      : (eq.status === "under-maintenance"
          ? (eq.qty || 0)
          : R.outOfServiceQty(eq));
    var eqAllocs    = allocations.filter(function(a) { return a.equipmentId === eq.id; });
    var activeAllocs = eqAllocs.filter(function(a) { return a.state !== "returned"; });
    var currentAllocs = eqAllocs.filter(function(a) { return a.startDate <= td && a.endDate >= td && a.state !== "returned"; });
    var currentOut  = currentAllocs.reduce(function(s, a) { return s + a.qty; }, 0);
    // Available right now = everything not out for maintenance and not on rental.
    var remainingQty = Math.max(0, rawQty - maintQty - currentOut);
    var vendor      = eq.vendorCompanyId ? (vendors || []).find(function(v) { return v.id === eq.vendorCompanyId; }) : null;

    // For non-serialized: line-level maintenance logs
    var lineLogs = !eq.serialized ? (eq.maintenanceLogs || []) : [];
    var openLineLogs = lineLogs.filter(function(l) { return l.status === "open"; }).length;

    // For serialized: collect all unit logs
    var allUnitLogs = eq.serialized
      ? (eq.units || []).reduce(function(acc, u) {
          return acc.concat((u.maintenanceLogs || []).map(function(l) {
            return Object.assign({}, l, { unitLabel: u.barcode || u.serial || ("Unit " + u.id), unitId: u.id });
          }));
        }, [])
      : [];
    var openUnitLogs = allUnitLogs.filter(function(l) { return l.status === "open"; }).length;
    var openIssues = eq.serialized ? openUnitLogs : openLineLogs;

    var tabs = [
      { id: "overview",    label: "Overview" },
      { id: "units",       label: eq.serialized ? "Units (" + rawQty + ")" : "Details" },
      { id: "maintenance", label: "Maintenance", count: openIssues || undefined },
    ];

    return h(window.LTPModal, { title: eq.name, onClose: onClose, wide: true },
      // Header meta + action buttons
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 } },
        h("div", null,
          h("div", { style: { fontSize: "12px", color: B.textMut } },
            [eq.category, eq.subcategory, eq.manufacturer && eq.model ? eq.manufacturer + " " + eq.model : null].filter(Boolean).join(" · ")),
          !eq.serialized && vendor && h("div", { style: { fontSize: "11px", color: B.accent, marginTop: 4 } }, "Vendor: " + vendor.name)
        ),
        h("div", { style: { display: "flex", gap: 6 } },
          eq.serialized && onScan && h(window.Btn, { small: true, onClick: onScan }, "📷 Scan Units"),
          h(window.Btn, { small: true, variant: "ghost",  onClick: onEdit   }, "Edit"),
          h(window.Btn, { small: true, variant: "danger", onClick: function() { setDeleteConfirm(true); } }, "Delete")
        )
      ),

      h(window.LTPTabs, { tabs: tabs, active: tab, onChange: setTab }),

      // ── OVERVIEW ────────────────────────────────────────────────────────────
      tab === "overview" && h("div", null,
        // Stat row
        h("div", { style: { display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 18 } },
          h("div", { style: { background: B.raised, borderRadius: 8, padding: "12px 14px", border: "1px solid " + B.border } },
            h("div", { style: { fontSize: "10px", color: B.textMut, fontWeight: 600, textTransform: "uppercase", marginBottom: 6 } }, "Total"),
            h("div", { style: { fontSize: "22px", fontWeight: 700, color: B.text } }, rawQty)),
          h("div", { style: { background: maintQty > 0 ? B.dangerBg : B.raised, borderRadius: 8, padding: "12px 14px", border: "1px solid " + (maintQty > 0 ? B.dangerBd : B.border) } },
            h("div", { style: { fontSize: "10px", color: maintQty > 0 ? B.danger : B.textMut, fontWeight: 600, textTransform: "uppercase", marginBottom: 6 } }, "Out for Maint."),
            h("div", { style: { fontSize: "22px", fontWeight: 700, color: maintQty > 0 ? B.danger : B.textMut } }, maintQty)),
          h("div", { style: { background: B.raised, borderRadius: 8, padding: "12px 14px", border: "1px solid " + B.border } },
            h("div", { style: { fontSize: "10px", color: B.textMut, fontWeight: 600, textTransform: "uppercase", marginBottom: 6 } }, "On Rental"),
            h("div", { style: { fontSize: "22px", fontWeight: 700, color: currentOut > 0 ? B.accent : B.textMut } }, currentOut)),
          h("div", { style: { background: B.raised, borderRadius: 8, padding: "12px 14px", border: "1px solid " + B.border } },
            h("div", { style: { fontSize: "10px", color: B.textMut, fontWeight: 600, textTransform: "uppercase", marginBottom: 6 } }, "Remaining"),
            h("div", { style: { fontSize: "22px", fontWeight: 700, color: remainingQty > 0 ? B.success : B.textMut } }, remainingQty))
        ),

        // All rate tiers
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 18 } },
          R.RATE_KEYS.map(function(k) {
            return h("div", { key: k, style: { background: B.raised, borderRadius: 6, padding: "10px 12px", textAlign: "center", border: "1px solid " + B.border } },
              h("div", { style: { fontSize: "10px", color: B.textMut, fontWeight: 600, textTransform: "uppercase", marginBottom: 4 } }, R.RATE_LABELS[k]),
              h("div", { style: { fontSize: "16px", fontWeight: 700, color: B.accent } }, "$" + (eq.rates[k] || 0)));
          })
        ),

        // Current allocations
        currentAllocs.length > 0 && h("div", { style: { marginBottom: 14 } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.textSec, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 } }, "Currently Out"),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
            currentAllocs.map(function(a) {
              var proj = projects.find(function(p) { return p.id === a.projectId; });
              return h("div", { key: a.id, style: { background: B.raised, borderRadius: 6, padding: "10px 12px", border: "1px solid " + B.border, display: "flex", justifyContent: "space-between", alignItems: "center" } },
                h("div", null,
                  h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, proj ? proj.name : "Unknown Project"),
                  h("div", { style: { fontSize: "11px", color: B.textMut } }, "\u00d7" + a.qty + " \u00b7 " + fmt(a.startDate) + " \u2192 " + fmt(a.endDate))),
                R.allocBadge(a.state));
            })
          )
        ),

        // Open maintenance issues on overview
        openIssues > 0 && h("div", { style: { marginBottom: 14 } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.danger, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 } }, "Open Issues (" + openIssues + ")"),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
            (eq.serialized ? allUnitLogs : lineLogs).filter(function(l) { return l.status === "open"; }).map(function(l) {
              return h("div", { key: l.id, style: { background: B.dangerBg, borderRadius: 6, padding: "10px 12px", border: "1px solid " + B.dangerBd } },
                eq.serialized && h("div", { style: { fontSize: "10px", color: B.textMut, fontWeight: 600, marginBottom: 4 } }, "Unit: " + l.unitLabel),
                h("div", { style: { fontSize: "12px", color: B.text } }, l.issue),
                h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 3 } }, fmt(l.date)));
            })
          )
        ),

        // Containers assigned to this equipment
        (function() {
          var assignedContainers = (containers || []).filter(function(c) { return (c.defaultForEquipment || []).includes(eq.id); });
          if (assignedContainers.length === 0) return null;
          return h("div", { style: { marginBottom: 14 } },
            h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.textSec, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 } }, "Containers"),
            h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
              assignedContainers.map(function(c) {
                var rawQty = c.serialized ? (c.units || []).length : (c.qty || 0);
                return h("div", { key: c.id,
                  onClick: onOpenContainer ? function() { onClose(); onOpenContainer(c.id); } : null,
                  style: { background: B.raised, borderRadius: 6, padding: "10px 12px", border: "1px solid " + B.border, display: "flex", justifyContent: "space-between", alignItems: "center", cursor: onOpenContainer ? "pointer" : "default", transition: "all 0.15s" },
                  onMouseOver: onOpenContainer ? function(e) { e.currentTarget.style.borderColor = B.accent + "44"; } : null,
                  onMouseOut:  onOpenContainer ? function(e) { e.currentTarget.style.borderColor = B.border; } : null },
                  h("div", null,
                    h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, c.name),
                    h("div", { style: { fontSize: "11px", color: B.textMut } }, c.type + " \u00b7 " + rawQty + " units" + (c.optional ? " \u00b7 Optional" : ""))),
                  c.rentalRate
                    ? h("span", { style: { fontSize: "12px", fontWeight: 700, color: B.accent } }, "$" + c.rentalRate + "/3-day")
                    : h("span", { style: { fontSize: "11px", color: B.success } }, "Bundled"));
              })
            )
          );
        })(),

        eq.notes && h("div", { style: { padding: "12px 14px", background: B.raised, borderRadius: 8, borderLeft: "3px solid " + B.accent, fontSize: "12px", color: B.textSec, lineHeight: 1.5 } }, eq.notes)
      ),

      // ── UNITS / DETAILS TAB ─────────────────────────────────────────────────
      tab === "units" && h("div", null,
        eq.serialized
          // Serialized: show each unit
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
              (eq.units || []).map(function(u) {
                var unitOpenIssues = (u.maintenanceLogs || []).filter(function(l) { return l.status === "open"; }).length;
                return h("div", { key: u.id, style: { background: B.raised, borderRadius: 8, padding: "12px 14px", border: "1px solid " + (unitOpenIssues > 0 ? B.dangerBd : B.border) } },
                  h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 } },
                    h("div", null,
                      h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.text } }, u.barcode || u.serial || "No ID"),
                      u.barcode && u.serial && h("div", { style: { fontSize: "11px", color: B.textMut } }, "S/N: " + u.serial)),
                    h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                      unitOpenIssues > 0 && h("span", { style: { fontSize: "10px", color: B.danger, fontWeight: 700 } }, unitOpenIssues + " issue" + (unitOpenIssues > 1 ? "s" : "")),
                      h("span", { style: { fontSize: "10px", fontWeight: 700, color: u.status === "available" ? B.success : B.danger, textTransform: "uppercase" } }, u.status))
                  ),
                  h("div", { style: { display: "flex", gap: 16, fontSize: "11px", color: B.textMut } },
                    u.purchaseDate && h("span", null, "Purchased: " + fmt(u.purchaseDate)),
                    u.purchaseVendorId && h("span", null, (function() { var v = (vendors || []).find(function(x) { return x.id === u.purchaseVendorId; }); return v ? v.name : "Unknown vendor"; })()),
                    u.purchaseCost && h("span", null, "$" + Number(u.purchaseCost).toLocaleString())
                  )
                );
              })
            )
          // Non-serialized: show line-level details
          : h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
              [
                ["Total Quantity", eq.qty],
                ["Location",       eq.location],
                ["Weight",         eq.weight ? eq.weight + " lbs" : null],
                ["Manufacturer",   eq.manufacturer],
                ["Model",          eq.model],
                ["Vendor",         !eq.serialized && vendor ? vendor.name : null],
              ].filter(function(r) { return r[1]; }).map(function(r) {
                return h("div", { key: r[0], style: { display: "flex", justifyContent: "space-between", padding: "8px 12px", background: B.raised, borderRadius: 6 } },
                  h("span", { style: { fontSize: "12px", color: B.textMut, fontWeight: 600 } }, r[0]),
                  h("span", { style: { fontSize: "12px", color: B.text } }, r[1]));
              })
            )
      ),

      // ── MAINTENANCE TAB ─────────────────────────────────────────────────────
      tab === "maintenance" && h("div", null,

        // Serial search for serialized items
        eq.serialized && h("div", { style: { marginBottom: 14, padding: "12px 14px", background: B.raised, borderRadius: 8, border: "1px solid " + B.border } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 } }, "Log New Issue"),
          h("div", { style: { display: "flex", gap: 8, alignItems: "flex-end" } },
            h("div", { style: { flex: 1 } },
              h(SerialSearch, { units: eq.units || [], value: maintUnit, onChange: setMaintUnit })
            ),
            h(window.Btn, { small: true, onClick: function() { if (maintUnit) setShowMaint(true); }, style: { opacity: maintUnit ? 1 : 0.4 } }, "+ Log Issue")
          ),
          !maintUnit && h("div", { style: { fontSize: "11px", color: B.textMut, fontStyle: "italic", marginTop: 8 } }, "Search a serial number above to log an issue for that unit.")
        ),

        // Log issue button for non-serialized
        !eq.serialized && h("div", { style: { marginBottom: 12 } },
          h(window.Btn, { small: true, onClick: function() { setShowMaint(true); } }, "+ Log Issue")
        ),

        // Maintenance log list
        (eq.serialized ? allUnitLogs : lineLogs).length === 0
          ? h(window.EmptyState, { text: "No maintenance history." })
          : h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
              (eq.serialized ? allUnitLogs : lineLogs).slice().sort(function(a, b) { return a.date > b.date ? -1 : 1; }).map(function(log) {
                // Non-serialized partial-out: show "×N" alongside the
                // date so the user can see at a glance how many units
                // each log is consuming. Legacy logs (no qty) omit it.
                var logQty = !eq.serialized && Number(log.qty) > 0 ? Number(log.qty) : null;
                return h("div", { key: log.id, style: { background: B.raised, borderRadius: 8, padding: "12px 14px", border: "1px solid " + (log.status === "open" ? B.dangerBd : B.border) } },
                  h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 } },
                    h("div", null,
                      eq.serialized && h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.text, marginBottom: 2 } }, log.unitLabel),
                      h("span", { style: { fontSize: "11px", color: B.textMut } },
                        fmt(log.date) + (logQty ? " · ×" + logQty + " unit" + (logQty !== 1 ? "s" : "") : ""))),
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
          serialized: eq.serialized,
          selectedUnit: eq.serialized ? (eq.units || []).find(function(u) { return u.id === maintUnit; }) : null,
          // Non-serialized: tell the form how many units are still
          // available so it can clamp the qty input. R.eqQty already
          // accounts for prior open logs' qty + the full-decommission
          // eq.status flag, so this is the exact ceiling.
          availableQty: !eq.serialized ? R.eqQty(eq) : null,
          onSave: function(d, setUnderMaint) {
            onMainLog(d, eq.serialized ? maintUnit : null);
            if (setUnderMaint) onSetUnderMaintenance(eq.serialized ? maintUnit : null);
            setShowMaint(false);
            setMaintUnit(null);
          },
        })
      ),
      deleteConfirm && h(window.LTPConfirmDialog, {
        dlg: {
          title: "Confirm Delete",
          message: 'Are you sure you want to delete "' + eq.name + '"? This cannot be undone.',
          variant: "danger", confirmLabel: "Delete",
          onConfirm: function() { setDeleteConfirm(false); onDelete(); },
        },
        onCancel: function() { setDeleteConfirm(false); },
      })
    );
  };
})();
