// Rentals — Kits / Packages
// A Kit is a named collection of equipment (+ optional containers) that maps to a quote line item
// and expands to individual items on a pull sheet.
// Depends on: rentals-utils.js
(function() {
  var h = React.createElement, useState = React.useState;

  var KIT_CATEGORIES = ["Lighting", "Audio", "SFX", "Video", "Full Production", "Other"];

  // ── Private: Equipment item picker with qty ─────────────────────────────────
  // Lets user search equipment, add it to the kit with a qty, and remove items.
  function EquipmentPicker({ equipment, items, onChange }) {
    var B = window.LTP_THEME, R = window.LTP_RENTALS;
    var [query,   setQuery]   = useState("");
    var [focused, setFocused] = useState(false);

    var selectedIds = items.map(function(i) { return i.equipmentId; });
    var q = query.toLowerCase();
    var filtered = equipment.filter(function(e) {
      if (selectedIds.includes(e.id)) return false;
      return e.name.toLowerCase().indexOf(q) !== -1 || (e.category || "").toLowerCase().indexOf(q) !== -1;
    });

    function addItem(eq) {
      onChange(items.concat([{ equipmentId: eq.id, qty: 1 }]));
      setQuery(""); setFocused(false);
    }
    function removeItem(eqId) {
      onChange(items.filter(function(i) { return i.equipmentId !== eqId; }));
    }
    function setQty(eqId, qty) {
      onChange(items.map(function(i) { return i.equipmentId === eqId ? Object.assign({}, i, { qty: Math.max(1, parseInt(qty) || 1) }) : i; }));
    }

    return h("div", null,
      // Selected items list
      items.length > 0 && h("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 } },
        items.map(function(item) {
          var eq = equipment.find(function(e) { return e.id === item.equipmentId; });
          if (!eq) return null;
          return h("div", { key: item.equipmentId, style: { display: "flex", alignItems: "center", gap: 8, background: B.bg, border: "1px solid " + B.border, borderRadius: 6, padding: "8px 10px" } },
            h("div", { style: { flex: 1 } },
              h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, eq.name),
              h("div", { style: { fontSize: "11px", color: B.textMut } }, eq.category + (eq.subcategory ? " · " + eq.subcategory : "") + " · $" + R.baseRate(eq) + "/3-day")
            ),
            h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
              h("label", { style: { fontSize: "11px", color: B.textMut, fontWeight: 600 } }, "Qty"),
              h("input", { type: "number", min: 1, value: item.qty, onChange: function(e) { setQty(item.equipmentId, e.target.value); },
                style: Object.assign({}, R.INP, { width: 60, padding: "4px 8px", textAlign: "center" }) }),
              h("div", { style: { fontSize: "11px", color: B.textMut } }, "$" + (R.baseRate(eq) * item.qty) + " /3-day")
            ),
            h("button", { onClick: function() { removeItem(item.equipmentId); },
              style: { background: "none", border: "none", color: B.danger, cursor: "pointer", fontSize: "16px", lineHeight: 1, padding: "0 4px" } }, "\u00d7")
          );
        })
      ),
      // Search-to-add
      h("div", { style: { position: "relative" } },
        h("input", { type: "text", value: query, placeholder: "Search equipment to add\u2026",
          onChange: function(e) { setQuery(e.target.value); setFocused(true); },
          onFocus: function() { setFocused(true); },
          onBlur:  function() { setTimeout(function() { setFocused(false); }, 180); },
          style: Object.assign({}, R.INP, { width: "100%" }) }),
        focused && h("div", { style: { position: "absolute", top: "100%", left: 0, right: 0, background: B.surface, border: "1px solid " + B.border, borderRadius: "0 0 6px 6px", maxHeight: 200, overflowY: "auto", zIndex: 20 } },
          filtered.length === 0
            ? h("div", { style: { padding: "10px 12px", fontSize: "12px", color: B.textMut, fontStyle: "italic" } }, query ? "No matches." : "Type to search equipment\u2026")
            : filtered.map(function(eq) {
                return h("div", { key: eq.id,
                  onMouseDown: function(e) { e.preventDefault(); },
                  onClick: function() { addItem(eq); },
                  style: { padding: "8px 12px", cursor: "pointer", borderBottom: "1px solid " + B.border },
                  onMouseOver: function(e) { e.currentTarget.style.background = B.raised; },
                  onMouseOut:  function(e) { e.currentTarget.style.background = "transparent"; } },
                  h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, eq.name),
                  h("div", { style: { fontSize: "11px", color: B.textMut } }, eq.category + (eq.subcategory ? " · " + eq.subcategory : "") + " · $" + R.baseRate(eq) + "/3-day · " + R.eqQty(eq) + " available")
                );
              })
        )
      )
    );
  }

  // ── Kit Rate Calculator ─────────────────────────────────────────────────────
  function calcRates(items, equipment) {
    var threeDay = 0, week = 0, month = 0;
    items.forEach(function(item) {
      var eq = equipment.find(function(e) { return e.id === item.equipmentId; });
      if (!eq) return;
      threeDay += (eq.rates.threeDay || 0) * item.qty;
      week     += (eq.rates.week     || 0) * item.qty;
      month    += (eq.rates.month    || 0) * item.qty;
    });
    return { threeDay: threeDay, week: week, month: month };
  }

  // ── Kit Form Modal ──────────────────────────────────────────────────────────
  window.RentalsKitForm = function({ initial, onClose, onSave, equipment }) {
    // The row this form is editing can change in another window while it sits
    // open. Field state was seeded when it opened and cannot be safely
    // re-seeded underneath the user, so say so rather than let Save quietly
    // overwrite the newer version. See theme.js::LTP_useRecordWatch.
    window.LTP_useRecordWatch("kits", initial && initial.id,
      { title: "This kit changed elsewhere",
        message: "Another window updated it while this form was open. Saving will replace the newer version." });
    var R = window.LTP_RENTALS, B = window.LTP_THEME;

    var blank = {
      name: "", category: "Lighting", description: "",
      items: [], containers: [],
      rates: { threeDay: "", week: "", month: "" },
      autoRate: true,
      notes: "", status: "active",
    };

    var init = initial ? Object.assign({}, blank, initial, {
      rates: {
        threeDay: initial.rates && initial.rates.threeDay != null ? String(initial.rates.threeDay) : "",
        week:     initial.rates && initial.rates.week     != null ? String(initial.rates.week)     : "",
        month:    initial.rates && initial.rates.month    != null ? String(initial.rates.month)    : "",
      },
    }) : blank;

    var [f,    setF]    = useState(init);
    var [items, setItems] = useState(initial ? (initial.items || []).slice() : []);
    var [err,  setErr]  = useState("");

    function set(k, v) { setF(function(p) { var o = {}; o[k] = v; return Object.assign({}, p, o); }); }
    function setRate(k, v) { setF(function(p) { var o = {}; o[k] = v; return Object.assign({}, p, { rates: Object.assign({}, p.rates, o) }); }); }

    var autoCalc = calcRates(items, equipment);

    function save() {
      if (!f.name.trim()) { setErr("Name is required."); return; }
      if (items.length === 0) { setErr("Add at least one equipment item."); return; }
      var rates = f.autoRate
        ? { threeDay: autoCalc.threeDay || null, week: autoCalc.week || null, month: autoCalc.month || null }
        : { threeDay: parseFloat(f.rates.threeDay) || null, week: parseFloat(f.rates.week) || null, month: parseFloat(f.rates.month) || null };
      onSave(Object.assign({}, f, { items: items, rates: rates }));
    }

    var g2 = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 };

    return h(window.LTPModal, { title: initial ? "Edit Kit" : "Create Kit", onClose: onClose, wide: true, disableBackdrop: true },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },
        err && h("div", { style: { background: B.dangerBg, border: "1px solid " + B.dangerBd, borderRadius: 6, padding: "8px 12px", color: B.danger, fontSize: "12px" } }, err),

        h("div", { style: g2 },
          R.Field("Kit Name *", h("input", { value: f.name, onChange: function(e) { set("name", e.target.value); }, placeholder: "e.g. Dance Concert — Wash Package", style: Object.assign({}, R.INP, { width: "100%" }) })),
          R.Field("Category", h("select", { value: f.category, onChange: function(e) { set("category", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) },
            KIT_CATEGORIES.map(function(c) { return h("option", { key: c, value: c }, c); })))
        ),

        R.Field("Description", h("textarea", { value: f.description || "", onChange: function(e) { set("description", e.target.value); }, rows: 2, placeholder: "Brief description of what this kit covers\u2026", style: Object.assign({}, R.INP, { width: "100%", resize: "vertical" }) })),

        // Equipment items
        h("div", { style: { background: B.raised, borderRadius: 8, padding: "14px", border: "1px solid " + B.border } },
          h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 } }, "Equipment Items *"),
          h(EquipmentPicker, { equipment: equipment, items: items, onChange: setItems })
        ),

        // Rates
        h("div", { style: { background: B.raised, borderRadius: 8, padding: "14px", border: "1px solid " + B.border } },
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 } },
            h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, "Rental Rates"),
            h("label", { style: { display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: "12px", color: B.textSec } },
              h("input", { type: "checkbox", checked: !!f.autoRate, onChange: function(e) { set("autoRate", e.target.checked); }, style: { accentColor: B.accent, width: 13, height: 13 } }),
              "Auto-calculate from items")
          ),
          f.autoRate
            ? h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 } },
                [["3-Day", autoCalc.threeDay], ["Week", autoCalc.week], ["Month", autoCalc.month]].map(function(pair) {
                  return h("div", { key: pair[0], style: { background: B.bg, borderRadius: 6, padding: "10px 12px", textAlign: "center", border: "1px solid " + B.border } },
                    h("div", { style: { fontSize: "10px", color: B.textMut, fontWeight: 600, textTransform: "uppercase", marginBottom: 4 } }, pair[0]),
                    h("div", { style: { fontSize: "16px", fontWeight: 700, color: pair[1] ? B.accent : B.textMut } }, pair[1] ? "$" + pair[1] : "—"));
                })
              )
            : h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 } },
                R.Field("3-Day ($)", h("input", { type: "number", min: 0, step: "0.01", value: f.rates.threeDay, onChange: function(e) { setRate("threeDay", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
                R.Field("Week ($)",  h("input", { type: "number", min: 0, step: "0.01", value: f.rates.week,     onChange: function(e) { setRate("week",     e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
                R.Field("Month ($)", h("input", { type: "number", min: 0, step: "0.01", value: f.rates.month,    onChange: function(e) { setRate("month",    e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) }))
              )
        ),

        h("div", { style: g2 },
          R.Field("Status", h("select", { value: f.status, onChange: function(e) { set("status", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) },
            [["active","Active"],["archived","Archived"]].map(function(s) { return h("option", { key: s[0], value: s[0] }, s[1]); }))),
          R.Field("Notes", h("input", { value: f.notes || "", onChange: function(e) { set("notes", e.target.value); }, placeholder: "Internal notes, discount policy, etc.", style: Object.assign({}, R.INP, { width: "100%" }) }))
        ),

        h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
          h(window.Btn, { variant: "ghost", onClick: onClose }, "Cancel"),
          h(window.Btn, { onClick: save }, initial ? "Save Changes" : "Create Kit")
        )
      )
    );
  };

  // ── Kit Detail Modal ────────────────────────────────────────────────────────
  window.RentalsKitDetail = function({ kit, equipment, onClose, onEdit, onDelete }) {
    var B = window.LTP_THEME, R = window.LTP_RENTALS;
    var fmt = window.LTP_formatDate;
    var [deleteConfirm, setDeleteConfirm] = useState(false);

    var calc = calcRates(kit.items || [], equipment);
    var displayRates = {
      threeDay: kit.autoRate ? calc.threeDay : (kit.rates && kit.rates.threeDay),
      week:     kit.autoRate ? calc.week     : (kit.rates && kit.rates.week),
      month:    kit.autoRate ? calc.month    : (kit.rates && kit.rates.month),
    };

    return h(window.LTPModal, { title: kit.name, onClose: onClose, wide: true },
      // Header
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 } },
        h("div", null,
          h("div", { style: { fontSize: "12px", color: B.textMut, marginBottom: 4 } }, kit.category + (kit.status === "archived" ? " · Archived" : "")),
          kit.description && h("div", { style: { fontSize: "13px", color: B.textSec, lineHeight: 1.6, maxWidth: 500 } }, kit.description)
        ),
        h("div", { style: { display: "flex", gap: 6, flexShrink: 0 } },
          h(window.Btn, { small: true, variant: "ghost",  onClick: onEdit }, "Edit"),
          h(window.Btn, { small: true, variant: "danger", onClick: function() { setDeleteConfirm(true); } }, "Delete")
        )
      ),

      // Rate cards
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 20 } },
        [["3-Day", displayRates.threeDay], ["Week", displayRates.week], ["Month", displayRates.month]].map(function(pair) {
          return h("div", { key: pair[0], style: { background: B.raised, borderRadius: 8, padding: "12px 14px", border: "1px solid " + B.border, textAlign: "center" } },
            h("div", { style: { fontSize: "10px", color: B.textMut, fontWeight: 600, textTransform: "uppercase", marginBottom: 6 } }, pair[0] + " Rate"),
            h("div", { style: { fontSize: "22px", fontWeight: 700, color: pair[1] ? B.accent : B.textMut } }, pair[1] ? "$" + pair[1].toLocaleString() : "—"),
            kit.autoRate && h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 3 } }, "auto-calculated"));
        })
      ),

      // Equipment breakdown
      h("div", { style: { marginBottom: 16 } },
        h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.textSec, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 } }, "Equipment (" + (kit.items || []).length + " items)"),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
          (kit.items || []).map(function(item) {
            var eq = equipment.find(function(e) { return e.id === item.equipmentId; });
            if (!eq) return null;
            var lineRate = R.baseRate(eq) * item.qty;
            var available = R.eqQty(eq);
            var short = item.qty > available;
            return h("div", { key: item.equipmentId, style: { display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", background: B.raised, borderRadius: 6, border: "1px solid " + (short ? B.dangerBd : B.border) } },
              h("div", { style: { flex: 1 } },
                h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, eq.name),
                h("div", { style: { fontSize: "11px", color: B.textMut } }, eq.category + (eq.subcategory ? " · " + eq.subcategory : ""))
              ),
              short && h("span", { style: { fontSize: "10px", color: B.danger, fontWeight: 700 } }, "only " + available + " available"),
              h("div", { style: { textAlign: "right", minWidth: 80 } },
                h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.text } }, "\u00d7" + item.qty),
                h("div", { style: { fontSize: "11px", color: B.accent } }, "$" + lineRate + "/3-day")
              )
            );
          })
        )
      ),

      // Totals summary line
      h("div", { style: { display: "flex", justifyContent: "flex-end", padding: "10px 12px", background: B.raised, borderRadius: 6, border: "1px solid " + B.border, marginBottom: kit.notes ? 14 : 0 } },
        h("div", { style: { textAlign: "right" } },
          h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 2 } }, kit.autoRate ? "Auto-calculated total" : "Custom rate"),
          h("div", { style: { fontSize: "16px", fontWeight: 700, color: B.accent } },
            displayRates.threeDay ? "$" + displayRates.threeDay.toLocaleString() + " / 3-day" : "Rate not set")
        )
      ),

      kit.notes && h("div", { style: { padding: "12px 14px", background: B.raised, borderRadius: 8, borderLeft: "3px solid " + B.accent, fontSize: "12px", color: B.textSec, lineHeight: 1.5 } }, kit.notes),

      deleteConfirm && h(window.LTPConfirmDialog, {
        dlg: {
          title: "Confirm Delete",
          message: 'Are you sure you want to delete "' + kit.name + '"? This cannot be undone.',
          variant: "danger", confirmLabel: "Delete",
          onConfirm: function() { setDeleteConfirm(false); onDelete(); },
        },
        onCancel: function() { setDeleteConfirm(false); },
      })
    );
  };

  // ── Kits List View ──────────────────────────────────────────────────────────
  window.RentalsKitsView = function({ kits, equipment, onOpenKit }) {
    var R = window.LTP_RENTALS, B = window.LTP_THEME;
    var isMobile = window.LTP_useIsMobile();
    var [catFilter,  setCatFilter]  = useState("all");
    var [search,     setSearch]     = useState("");
    var [sortMode,   setSortMode]   = useState("az");
    var [showArchived, setShowArchived] = useState(false);

    var cats = ["all"].concat(Array.from(new Set((kits || []).map(function(k) { return k.category; }))));
    var q = search.toLowerCase();

    var filtered = (kits || []).filter(function(k) {
      if (!showArchived && k.status === "archived") return false;
      if (catFilter !== "all" && k.category !== catFilter) return false;
      if (q && k.name.toLowerCase().indexOf(q) === -1 && (k.description || "").toLowerCase().indexOf(q) === -1) return false;
      return true;
    }).slice().sort(function(a, b) {
      if (sortMode === "za") return b.name.localeCompare(a.name);
      if (sortMode === "price-asc" || sortMode === "price-desc") {
        var ar = a.autoRate ? calcRates(a.items, equipment).threeDay : (a.rates && a.rates.threeDay || 0);
        var br = b.autoRate ? calcRates(b.items, equipment).threeDay : (b.rates && b.rates.threeDay || 0);
        return sortMode === "price-asc" ? ar - br : br - ar;
      }
      return a.name.localeCompare(b.name);
    });

    var sortBtnsEl = h("div", { style: { display: "flex", gap: 6 } },
      [{ k: "az", l: "A\u2192Z" }, { k: "za", l: "Z\u2192A" }, { k: "price-asc", l: "$ \u2191" }, { k: "price-desc", l: "$ \u2193" }].map(function(o) {
        return h("button", { key: o.k, onClick: function() { setSortMode(o.k); },
          style: { background: sortMode === o.k ? B.accent : B.raised, color: sortMode === o.k ? B.btnInk : B.textMut, border: "1px solid " + (sortMode === o.k ? B.accent : B.border), borderRadius: 4, padding: "4px 10px", fontSize: "11px", fontWeight: 600, cursor: "pointer" } }, o.l);
      }));

    // Show Archived \u2014 a filter chip like the categories, but tinted GREEN when
    // active (per request) to read as an inclusion toggle rather than a filter.
    var showArchivedBtn = h("button", { onClick: function() { setShowArchived(!showArchived); }, className: "ltp-tap",
      style: { flexShrink: 0, whiteSpace: "nowrap", background: showArchived ? B.success : B.raised, color: showArchived ? B.btnInk : B.textMut, border: "1px solid " + (showArchived ? B.success : B.border), borderRadius: isMobile ? "16px" : 4, padding: isMobile ? "8px 14px" : "4px 12px", fontSize: isMobile ? "13px" : "11px", fontWeight: 600, cursor: "pointer", minHeight: isMobile ? 36 : undefined } },
      showArchived ? "\u2713 Archived" : "Show Archived");

    return h("div", null,
      // Mobile: title + search share the top row (the shell suppresses its own
      // header for kits on mobile).
      isMobile && h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 12 } },
        h("h2", { style: { fontSize: "20px", fontWeight: 700, color: B.text, margin: 0, flexShrink: 0 } }, "Kits"),
        h("input", { value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search kits\u2026",
          style: Object.assign({}, R.INP, { flex: 1, minWidth: 0, borderRadius: "8px", padding: "9px 12px" }) })),

      // Category filters; Show Archived rides the right (mobile), or joins the
      // search + sort cluster (desktop).
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12, flexWrap: isMobile ? "nowrap" : "wrap" } },
        h(window.LTPScrollStrip, { isMobile: isMobile, mobileStyle: { display: "flex", gap: 8, overflowX: "auto", flexWrap: "nowrap", WebkitOverflowScrolling: "touch", scrollbarWidth: "none", paddingBottom: 4 }, wrapStyle: { flex: 1, minWidth: 0 }, desktopStyle: { display: "flex", gap: 6, flexWrap: "wrap" } },
          cats.map(function(c) {
            return h("button", { key: c, onClick: function() { setCatFilter(c); }, className: "ltp-tap",
              style: { flexShrink: 0, whiteSpace: "nowrap", background: catFilter === c ? B.accent : B.raised, color: catFilter === c ? B.btnInk : B.textMut, border: "1px solid " + (catFilter === c ? B.accent : B.border), borderRadius: isMobile ? "16px" : 4, padding: isMobile ? "8px 16px" : "4px 12px", fontSize: isMobile ? "13px" : "11px", fontWeight: 600, cursor: "pointer", minHeight: isMobile ? 36 : undefined } }, c === "all" ? "All" : c);
          })
        ),
        isMobile
          ? showArchivedBtn
          : h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
              h("input", { value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search kits\u2026", style: Object.assign({}, R.INP, { width: 180 }) }),
              sortBtnsEl,
              showArchivedBtn)
      ),

      // Mobile: sort row sits below the filters.
      isMobile && h("div", { style: { display: "flex", marginBottom: 12 } }, sortBtnsEl),

      filtered.length === 0
        ? h(window.EmptyState, { text: "No kits match your search." })
        : h(window.LTPList, null,
            filtered.map(function(kit) {
              var calc    = calcRates(kit.items || [], equipment);
              var rate3   = kit.autoRate ? calc.threeDay : (kit.rates && kit.rates.threeDay);
              var itemCt  = (kit.items || []).length;
              var archived = kit.status === "archived";

              return h(window.LTPRow, { key: kit.id, onClick: function() { onOpenKit(kit.id); },
                style: { padding: "14px 16px", opacity: archived ? 0.6 : 1 } },
                h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" } },
                  h("div", { style: { flex: 1 } },
                    h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 } },
                      h("div", { style: { fontSize: "14px", fontWeight: 600, color: B.text } }, kit.name),
                      archived && h("span", { style: { fontSize: "9px", fontWeight: 700, color: B.textMut, background: B.raised, border: "1px solid " + B.border, padding: "1px 6px", borderRadius: 3, textTransform: "uppercase" } }, "Archived")
                    ),
                    h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: kit.description ? 6 : 0 } }, kit.category + " · " + itemCt + " item" + (itemCt !== 1 ? "s" : "")),
                    kit.description && h("div", { style: { fontSize: "12px", color: B.textSec, lineHeight: 1.5 } }, kit.description.length > 100 ? kit.description.slice(0, 100) + "\u2026" : kit.description)
                  ),
                  h("div", { style: { textAlign: "right", flexShrink: 0, marginLeft: 16 } },
                    h("div", { style: { fontSize: "18px", fontWeight: 700, color: rate3 ? B.accent : B.textMut } }, rate3 ? "$" + rate3.toLocaleString() : "\u2014"),
                    h("div", { style: { fontSize: "10px", color: B.textMut } }, rate3 ? "/3-day" + (kit.autoRate ? " (auto)" : "") : "rate not set")
                  )
                )
              );
            })
          )
    );
  };
})();
