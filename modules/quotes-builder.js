// Quotes Builder — full-screen quote editor.
//
// Features:
//   - Link company/contact/project or use custom name + dates
//   - Sectioned line items with labels (Lighting, Audio, etc.)
//   - Line item types: equipment, product, service (days), note
//   - Inline price adjustments → auto-discount line in totals
//   - Global discount: percent / amount / target-price
//   - Margin tracking (internal only; equipment = 100% margin)
//   - Drag-and-drop reorder for sections and items (cross-section moves supported)
//   - Add Item picker modal with tabbed browser
//
// State model:
//   draft = live in-progress quote, held in local useState
//   Save commits draft to quotes array via setQuotes
//   Discard / back navigation abandons changes (no autosave in phase 1)
(function() {
  var h = React.createElement, useState = React.useState, useRef = React.useRef, useMemo = React.useMemo;
  var useEffect = React.useEffect;
  var B = window.LTP_THEME;
  var nav = window.LTPRouter.navigate;
  var fmt = window.LTP_formatDate;
  var genId = window.LTP_genId;
  var todayISO = window.LTP_todayISO;

  function emptyDraft() {
    return {
      id: null,
      clientType: "company",        // "company" | "contact"
      projectId: null, companyId: null, clientContactId: null,
      customName: "", customStartDate: "", customEndDate: "",
      rentalStartDate: null, rentalEndDate: null,
      status: "draft", createdDate: todayISO(), sentDate: null,
      globalDiscount: { type: "none", value: 0 },
      sections: [{ id: genId("sec"), label: "Equipment", items: [], customDates: false, startDate: "", endDate: "" }],
      notes: window.LTP_DEFAULT_QUOTE_NOTES || "",
      activity: [{ id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0,5), type: "created", message: "Quote created", user: (window.LTP_CURRENT_USER || "User") }],
    };
  }

  // Deep clone a draft so local edits don't mutate the saved quote
  function cloneDraft(q) {
    return {
      id: q.id,
      shareToken: q.shareToken || null,
      clientType: q.clientType || (q.companyId ? "company" : "contact"),
      projectId: q.projectId, companyId: q.companyId, clientContactId: q.clientContactId,
      customName: q.customName || "", customStartDate: q.customStartDate || "", customEndDate: q.customEndDate || "",
      rentalStartDate: q.rentalStartDate || null, rentalEndDate: q.rentalEndDate || null,
      status: q.status || "draft", createdDate: q.createdDate || todayISO(), sentDate: q.sentDate || null,
      globalDiscount: Object.assign({ type: "none", value: 0 }, q.globalDiscount || {}),
      sections: (q.sections || []).map(function(s) {
        return { id: s.id, label: s.label, customDates: !!s.customDates, startDate: s.startDate || "", endDate: s.endDate || "",
                 items: (s.items || []).map(function(i) { return Object.assign({}, i); }) };
      }),
      notes: q.notes || "",
      activity: (q.activity || []).map(function(a) { return Object.assign({}, a); }),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   ADD ITEM PICKER
  // ═══════════════════════════════════════════════════════════════════════════

  // Calculate rental pricing from a date range.
  // Calculate rental pricing by stacking tiers from largest to smallest.
  // Consumes days greedily: months first, then weeks, then 3-day blocks.
  //
  // Returns { breakdown: [{tier, count, unitRate, subtotal}], totalPrice, label }
  //   31 days → 1× month + 1× 3-day
  //   38 days → 1× month + 1× week + 1× 3-day
  //   64 days → 2× month + 1× 3-day + 1× 3-day  (4 remaining days → week is cheaper check)
  //
  // The function picks the cheapest option for the remainder at each step:
  //   remainder 4-7 days → compare 1× week vs ceil(days/3)× 3-day, pick cheaper
  //   remainder 1-3 days → 1× 3-day
  function calcRentalPrice(startDate, endDate, rates) {
    rates = rates || {};
    var r3 = rates.threeDay || 0, rw = rates.week || 0, rm = rates.month || 0;
    if (!startDate || !endDate) return { breakdown: [{ tier: "threeDay", count: 1, unitRate: r3, subtotal: r3 }], totalPrice: r3, label: "3-Day rate" };
    var start = new Date(startDate), end = new Date(endDate);
    var days = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1; // inclusive
    if (days <= 0) days = 1;

    var breakdown = [];
    var remaining = days;

    // Consume full months (30-day blocks)
    if (remaining >= 30 && rm > 0) {
      var months = Math.floor(remaining / 30);
      breakdown.push({ tier: "month", count: months, unitRate: rm, subtotal: rm * months });
      remaining -= months * 30;
    }

    // Remainder: pick cheapest combo of weeks and 3-days
    if (remaining > 0) {
      if (remaining >= 4 && rw > 0) {
        // Compare: 1 week vs multiple 3-day blocks
        var threeDayCost = Math.ceil(remaining / 3) * r3;
        if (rw <= threeDayCost && remaining <= 7) {
          breakdown.push({ tier: "week", count: 1, unitRate: rw, subtotal: rw });
          remaining = 0;
        } else if (remaining > 7) {
          // More than a week left but less than a month — use week + remainder
          var weeks = Math.floor(remaining / 7);
          breakdown.push({ tier: "week", count: weeks, unitRate: rw, subtotal: rw * weeks });
          remaining -= weeks * 7;
        }
      }

      // Remaining days as 3-day blocks
      if (remaining > 0 && r3 > 0) {
        var blocks = Math.ceil(remaining / 3);
        breakdown.push({ tier: "threeDay", count: blocks, unitRate: r3, subtotal: r3 * blocks });
      }
    }

    // Edge case: no rates set
    if (breakdown.length === 0) {
      breakdown.push({ tier: "threeDay", count: 1, unitRate: 0, subtotal: 0 });
    }

    var totalPrice = breakdown.reduce(function(s, b) { return s + b.subtotal; }, 0);

    // Build a human-readable label
    var label = breakdown.map(function(b) {
      var tl = b.tier === "month" ? "Mo" : b.tier === "week" ? "Wk" : "3-Day";
      return b.count + "\u00d7 " + tl;
    }).join(" + ");

    // Primary rateType = the largest tier used (for display purposes)
    var rateType = breakdown[0].tier;

    return { breakdown: breakdown, totalPrice: totalPrice, rateType: rateType, label: label };
  }

  // Simplified version when we just need the rate type (no price calc)
  function calcRateType(startDate, endDate) {
    return calcRentalPrice(startDate, endDate, {}).rateType;
  }

  function rateLabel(rt) {
    return rt === "threeDay" ? "3-Day" : rt === "week" ? "Week" : "Month";
  }

  function AddItemPicker({ sectionId, sectionLabel, sectionItems, allSections, onAdd, onClose, equipment, products, services, allocations, quoteDates }) {
    // Rate is always auto-calculated from dates — never manually selected
    var autoRate = quoteDates ? calcRateType(quoteDates.start, quoteDates.end) : "threeDay";
    var [tab, setTab]       = useState("equipment");
    var [search, setSearch] = useState("");
    var [noteText, setNoteText] = useState("");
    // Per-equipment qty state in the picker: { equipmentId: number }
    var [eqQtys, setEqQtys] = useState({});

    var q = search.trim().toLowerCase();

    // IDs already in THIS section (for orange outline)
    var sectionEquipIds = {};
    var sectionProductIds = {};
    var sectionServiceIds = {};
    (sectionItems || []).forEach(function(it) {
      if (it.type === "equipment" && it.equipmentId) sectionEquipIds[it.equipmentId] = true;
      if (it.type === "product"   && it.productId)   sectionProductIds[it.productId] = true;
      if (it.type === "service"   && it.serviceId)   sectionServiceIds[it.serviceId] = true;
    });

    // Total quoted qty per equipment across ALL sections of this quote
    var quotedQtyMap = {};
    (allSections || []).forEach(function(sec) {
      (sec.items || []).forEach(function(it) {
        if (it.type === "equipment" && it.equipmentId) {
          quotedQtyMap[it.equipmentId] = (quotedQtyMap[it.equipmentId] || 0) + (Number(it.qty) || 0);
        }
      });
    });

    // Equipment availability: count total units, count allocated/checked-out during quote dates
    function getAvailability(eq) {
      var totalQty = eq.serialized ? (eq.units || []).filter(function(u) { return u.status !== "under-maintenance" && u.status !== "retired"; }).length : (eq.qty || 0);
      if (!quoteDates || !quoteDates.start || !quoteDates.end) return { total: totalQty, allocated: 0, available: totalQty };
      var start = quoteDates.start, end = quoteDates.end;
      var allocated = 0;
      (allocations || []).forEach(function(a) {
        if (a.equipmentId !== eq.id) return;
        if (a.state === "returned" || a.state === "cancelled") return;
        // Check date overlap
        if (a.startDate <= end && a.endDate >= start) allocated += (a.qty || 1);
      });
      return { total: totalQty, allocated: allocated, available: totalQty - allocated };
    }

    function filterList(list, fields) {
      if (!q) return list;
      return list.filter(function(item) {
        var hay = fields.map(function(f) { return (item[f] || "").toString().toLowerCase(); }).join(" ");
        return hay.indexOf(q) !== -1;
      });
    }

    function getEqQty(eqId) { return eqQtys[eqId] || 1; }
    function setEqQty(eqId, val) {
      var v = Math.max(1, Number(val) || 1);
      setEqQtys(function(prev) { var n = Object.assign({}, prev); n[eqId] = v; return n; });
    }

    function addEquipment(eq) {
      var qty = getEqQty(eq.id);
      var rp = calcRentalPrice(quoteDates ? quoteDates.start : null, quoteDates ? quoteDates.end : null, eq.rates);
      onAdd({
        id: genId("item"), type: "equipment",
        equipmentId: eq.id, name: eq.name, qty: qty,
        rateType: rp.rateType, rentalLabel: rp.label, unitPrice: rp.totalPrice, adjustedPrice: null,
        cost: 0, notes: "",
      });
    }
    function addProduct(p) {
      onAdd({
        id: genId("item"), type: "product",
        productId: p.id, name: p.name, qty: 1,
        unitPrice: p.unitPrice || 0, adjustedPrice: null,
        cost: p.cost || 0, notes: "",
      });
    }
    function addService(s) {
      onAdd({
        id: genId("item"), type: "service",
        serviceId: s.id, name: s.role + " \u2014 " + s.description, qty: 1,
        rateType: "day",
        unitPrice: s.dayRate || 0, adjustedPrice: null,
        cost: s.dayCost || 0, notes: "",
      });
    }
    function addNote() {
      if (!noteText.trim()) return;
      onAdd({ id: genId("item"), type: "note", text: noteText.trim() });
      setNoteText("");
    }

    var tabs = [
      { k: "equipment", l: "Equipment" },
      { k: "product",   l: "Products"  },
      { k: "service",   l: "Services"  },
      { k: "note",      l: "Note"      },
    ];

    return h(window.LTPModal, { title: "Add to \"" + sectionLabel + "\"", onClose: onClose, wide: true },
      // Tab bar
      h("div", { style: { display: "flex", gap: 0, borderBottom: "1px solid " + B.border, marginBottom: 12 } },
        tabs.map(function(t) {
          var active = tab === t.k;
          return h("button", { key: t.k, onClick: function() { setTab(t.k); setSearch(""); },
            style: { background: "transparent", border: "none", borderBottom: active ? "2px solid " + B.accent : "2px solid transparent",
                     padding: "8px 14px", fontSize: "12px", fontWeight: active ? 700 : 500,
                     color: active ? B.accent : B.textMut, cursor: "pointer" } }, t.l);
        })
      ),

      // Equipment tab
      tab === "equipment" && h("div", null,
        h("div", { style: { display: "flex", gap: 10, marginBottom: 10, alignItems: "center" } },
          h("input", { type: "text", value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search equipment…",
            style: { flex: 1, background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none" } }),
          h("span", { style: { fontSize: "11px", color: B.accent, fontWeight: 600 } }, rateLabel(autoRate) + " Rate"),
          !quoteDates && h("span", { style: { fontSize: "9px", color: B.textMut, fontStyle: "italic" } }, "(set dates for pricing)")
        ),
        h("div", { style: { maxHeight: 380, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 } },
          filterList(equipment, ["name", "category", "subcategory", "manufacturer", "model"]).slice(0, 80).map(function(eq) {
            var rp = calcRentalPrice(quoteDates ? quoteDates.start : null, quoteDates ? quoteDates.end : null, eq.rates);
            var av = getAvailability(eq);
            var inSection = !!sectionEquipIds[eq.id];
            var quoted = quotedQtyMap[eq.id] || 0;
            var totalCommitted = av.allocated + quoted;
            var overquoted = totalCommitted > av.total;
            var avColor = av.available > 0 ? B.success : B.danger;
            var curQty = getEqQty(eq.id);
            return h("div", { key: eq.id,
              style: { background: B.raised, border: inSection ? "2px solid " + B.accent : "1px solid " + B.border, borderRadius: "4px", padding: "8px 12px", display: "flex", alignItems: "center", gap: 8 },
              onMouseOver: function(e) { if (!inSection) e.currentTarget.style.borderColor = B.accent + "66"; },
              onMouseOut:  function(e) { if (!inSection) e.currentTarget.style.borderColor = B.border; } },
              // Name + category
              h("div", { style: { flex: 1, minWidth: 0 } },
                h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, eq.name),
                h("div", { style: { fontSize: "10px", color: B.textMut } }, eq.category + (eq.subcategory ? " \u00b7 " + eq.subcategory : ""))
              ),
              // Availability + quoted
              h("div", { style: { textAlign: "right", minWidth: 65 } },
                h("div", { style: { fontSize: "10px", fontWeight: 600, color: avColor } }, av.available + " / " + av.total + " avail"),
                quoted > 0 && h("div", { style: { fontSize: "9px", fontWeight: 600, color: overquoted ? B.danger : B.warn } },
                  quoted + " quoted" + (overquoted ? " \u26a0" : ""))
              ),
              // Qty input
              h("div", { style: { display: "flex", alignItems: "center", gap: 2 } },
                h("button", { onClick: function(e) { e.stopPropagation(); setEqQty(eq.id, curQty - 1); },
                  style: { background: B.bg, border: "1px solid " + B.border, borderRadius: "3px", color: B.textSec, cursor: "pointer", width: 22, height: 22, fontSize: "13px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", padding: 0 } }, "\u2212"),
                h("input", { type: "number", value: curQty, min: 1,
                  onChange: function(e) { setEqQty(eq.id, e.target.value); },
                  onClick: function(e) { e.stopPropagation(); },
                  style: { width: 36, background: B.bg, border: "1px solid " + B.border, borderRadius: "3px", padding: "2px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", textAlign: "center" } }),
                h("button", { onClick: function(e) { e.stopPropagation(); setEqQty(eq.id, curQty + 1); },
                  style: { background: B.bg, border: "1px solid " + B.border, borderRadius: "3px", color: B.textSec, cursor: "pointer", width: 22, height: 22, fontSize: "13px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", padding: 0 } }, "+")
              ),
              // Price
              h("div", { style: { textAlign: "right", minWidth: 65 } },
                h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.accent } }, "$" + rp.totalPrice),
                rp.breakdown.length > 1 && h("div", { style: { fontSize: "9px", color: B.textMut } }, rp.label)
              ),
              // Add button
              h("button", { onClick: function(e) { e.stopPropagation(); addEquipment(eq); },
                style: { background: B.accent, border: "none", borderRadius: "4px", color: "#000", cursor: "pointer", fontSize: "11px", fontWeight: 700, padding: "5px 10px", whiteSpace: "nowrap" } }, "Add")
            );
          })
        )
      ),

      // Products tab
      tab === "product" && h("div", null,
        h("input", { type: "text", value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search products…",
          style: { width: "100%", background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", marginBottom: 10 } }),
        h("div", { style: { maxHeight: 380, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 } },
          filterList(products, ["name", "category"]).slice(0, 80).map(function(p) {
            var inSection = !!sectionProductIds[p.id];
            return h("div", { key: p.id, onClick: function() { addProduct(p); },
              style: { background: B.raised, border: inSection ? "2px solid " + B.accent : "1px solid " + B.border, borderRadius: "4px", padding: "8px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 },
              onMouseOver: function(e) { if (!inSection) e.currentTarget.style.borderColor = B.accent; },
              onMouseOut:  function(e) { if (!inSection) e.currentTarget.style.borderColor = B.border; } },
              h("div", { style: { flex: 1, minWidth: 0 } },
                h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, p.name),
                h("div", { style: { fontSize: "10px", color: B.textMut } }, p.category + " \u00b7 per " + p.unit)
              ),
              h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.accent } }, "$" + p.unitPrice)
            );
          })
        )
      ),

      // Services tab
      tab === "service" && h("div", null,
        h("input", { type: "text", value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search services…",
          style: { width: "100%", background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", marginBottom: 10 } }),
        h("div", { style: { maxHeight: 380, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 } },
          filterList(services, ["role", "description", "department"]).slice(0, 80).map(function(s) {
            var inSection = !!sectionServiceIds[s.id];
            return h("div", { key: s.id, onClick: function() { addService(s); },
              style: { background: B.raised, border: inSection ? "2px solid " + B.accent : "1px solid " + B.border, borderRadius: "4px", padding: "8px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 },
              onMouseOver: function(e) { if (!inSection) e.currentTarget.style.borderColor = B.accent; },
              onMouseOut:  function(e) { if (!inSection) e.currentTarget.style.borderColor = B.border; } },
              h("div", { style: { width: 40, fontSize: "12px", fontWeight: 700, color: B.accent, fontFamily: "'Playfair Display', serif" } }, s.role),
              h("div", { style: { flex: 1, minWidth: 0 } },
                h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, s.description),
                h("div", { style: { fontSize: "10px", color: B.textMut } }, s.department)
              ),
              h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.accent } }, "$" + s.dayRate + "/day")
            );
          })
        )
      ),

      // Note tab
      tab === "note" && h("div", null,
        h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 6 } }, "Notes appear as line items on the quote but have no price."),
        h("textarea", { value: noteText, onChange: function(e) { setNoteText(e.target.value); }, placeholder: "Enter note text…", rows: 4,
          style: { width: "100%", background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px 10px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", resize: "vertical", marginBottom: 10 } }),
        h("div", { style: { display: "flex", justifyContent: "flex-end" } },
          h(window.Btn, { small: true, onClick: addNote }, "Add Note")
        )
      )
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   LINE ITEM ROW
  // ═══════════════════════════════════════════════════════════════════════════

  function LineItemRow({ item, sectionId, quoteStatus, onUpdate, onDelete, onDragStart, onDragOver, onDrop, services }) {
    if (item.type === "note") {
      return h("div", {
        draggable: true,
        onDragStart: function(e) { onDragStart(sectionId, item.id); e.dataTransfer.effectAllowed = "move"; },
        onDragOver:  function(e) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; },
        onDrop:      function(e) { e.preventDefault(); onDrop(sectionId, item.id); },
        style: { background: B.bg, border: "1px dashed " + B.border, borderRadius: "4px", padding: "8px 12px", display: "flex", alignItems: "center", gap: 10 }
      },
        h("span", { style: { fontSize: "12px", color: B.textMut, cursor: "grab" } }, "\u2630"),
        h("span", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.05em" } }, "Note"),
        h("div", { style: { flex: 1, fontSize: "12px", color: B.textSec, fontStyle: "italic" } }, item.text),
        h("button", { onClick: function() { onDelete(sectionId, item.id); },
          style: { background: "transparent", border: "none", color: B.textMut, cursor: "pointer", fontSize: "14px", padding: "2px 6px" } }, "\u00d7")
      );
    }

    // Equipment / product / service row
    var typeBadge = item.type === "equipment" ? "EQ" : item.type === "product" ? "PR" : "SV";
    var typeBadgeColor = item.type === "equipment" ? B.info : item.type === "product" ? B.success : B.warn;
    var RATE_TYPES = { day: "days", half: "half days", hourly: "hours", ot: "OT hours" };
    var svcRateType = item.type === "service" ? (item.rateType || "day") : null;
    var qtyLabel = svcRateType ? (RATE_TYPES[svcRateType] || "days") : "qty";
    var isAccepted = quoteStatus === "accepted";
    var isLocked = quoteStatus === "accepted" || quoteStatus === "converted";

    // Lookup service for rate type changes
    var svcData = item.type === "service" && item.serviceId ? (services || []).find(function(sv) { return sv.id === item.serviceId; }) : null;

    var effectivePrice = item.adjustedPrice != null ? item.adjustedPrice : item.unitPrice;
    var lineTotal = effectivePrice * (Number(item.qty) || 0);
    var origTotal = item.unitPrice * (Number(item.qty) || 0);
    var adjusted  = item.adjustedPrice != null && item.adjustedPrice !== item.unitPrice;

    var delivQty = Number(item.deliveredQty) || 0;
    var invQty = Number(item.invoicedQty) || 0;
    var qty = Number(item.qty) || 0;
    var uninvoiced = delivQty - invQty;

    return h("div", {
      draggable: !isLocked,
      onDragStart: isLocked ? undefined : function(e) { onDragStart(sectionId, item.id); e.dataTransfer.effectAllowed = "move"; },
      onDragOver:  isLocked ? undefined : function(e) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; },
      onDrop:      isLocked ? undefined : function(e) { e.preventDefault(); onDrop(sectionId, item.id); },
      style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "4px", padding: "8px 12px", display: "flex", alignItems: "center", gap: 10 }
    },
      !isLocked && h("span", { style: { fontSize: "12px", color: B.textMut, cursor: "grab", userSelect: "none" } }, "\u2630"),
      h("span", { style: { fontSize: "9px", fontWeight: 700, color: typeBadgeColor, background: typeBadgeColor + "22", border: "1px solid " + typeBadgeColor + "44", padding: "2px 5px", borderRadius: "3px", minWidth: 22, textAlign: "center" } }, typeBadge),
      h("div", { style: { flex: 1, minWidth: 0 } },
        h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, item.name),
        item.type === "equipment" && h("div", { style: { fontSize: "10px", color: B.textMut } }, item.rentalLabel || rateLabel(item.rateType) + " rate"),
        item.notes && h("div", { style: { fontSize: "10px", color: B.textMut, fontStyle: "italic" } }, item.notes)
      ),
      // Rate type selector (services only)
      item.type === "service" && !isLocked && svcData && h("select", { value: svcRateType, onChange: function(e) {
        var rt = e.target.value;
        var priceMap = { day: svcData.dayRate, half: svcData.halfDay || svcData.dayRate * 0.5, hourly: svcData.hourlyRate || svcData.dayRate / 10, ot: svcData.otRate || svcData.dayRate / 10 * 1.5 };
        var costMap  = { day: svcData.dayCost, half: svcData.halfDayCost || svcData.dayCost * 0.5, hourly: svcData.hourlyCost || svcData.dayCost / 10, ot: svcData.otCost || svcData.dayCost / 10 * 1.5 };
        onUpdate(sectionId, item.id, { rateType: rt, unitPrice: priceMap[rt] || 0, cost: costMap[rt] || 0, adjustedPrice: null });
      }, style: { width: 82, background: B.bg, border: "1px solid " + B.border, borderRadius: "3px", padding: "3px 4px", color: B.text, fontSize: "10px", fontFamily: "inherit", outline: "none" } },
        h("option", { value: "day" }, "Day"),
        h("option", { value: "half" }, "Half Day"),
        h("option", { value: "hourly" }, "Hourly"),
        h("option", { value: "ot" }, "OT")
      ),
      item.type === "service" && isLocked && h("div", { style: { fontSize: "10px", color: B.warn, fontWeight: 600, width: 82, textAlign: "center" } },
        svcRateType === "day" ? "Day" : svcRateType === "half" ? "Half Day" : svcRateType === "hourly" ? "Hourly" : "OT"),
      // Qty — locked when accepted/converted
      h("div", { style: { width: 60 } },
        h("div", { style: { fontSize: "9px", color: B.textMut, textAlign: "center" } }, qtyLabel),
        isLocked
          ? h("div", { style: { fontSize: "11px", color: B.text, textAlign: "center", padding: "3px 0" } }, item.qty)
          : h("input", { type: "number", value: item.qty, min: 0,
              onChange: function(e) { onUpdate(sectionId, item.id, { qty: Number(e.target.value) || 0 }); },
              style: { width: "100%", background: B.bg, border: "1px solid " + B.border, borderRadius: "3px", padding: "3px 6px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", textAlign: "center" } })
      ),
      // Delivered (only in accepted status)
      isAccepted && h("div", { style: { width: 55 } },
        h("div", { style: { fontSize: "9px", color: delivQty >= qty && qty > 0 ? B.success : B.textMut, textAlign: "center", fontWeight: delivQty >= qty && qty > 0 ? 700 : 400 } }, "dlvd"),
        h("input", { type: "number", value: delivQty, min: 0, max: qty,
          onChange: function(e) { var v = Math.min(qty, Math.max(0, Number(e.target.value) || 0)); onUpdate(sectionId, item.id, { deliveredQty: v }); },
          style: { width: "100%", background: B.bg, border: "1px solid " + (delivQty >= qty && qty > 0 ? B.success : B.border), borderRadius: "3px", padding: "3px 6px", color: delivQty >= qty && qty > 0 ? B.success : B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", textAlign: "center" } })
      ),
      // Invoiced (only in accepted status, read-only)
      isAccepted && invQty > 0 && h("div", { style: { width: 45, textAlign: "center" } },
        h("div", { style: { fontSize: "9px", color: B.textMut } }, "inv\u2019d"),
        h("div", { style: { fontSize: "11px", color: invQty >= qty ? B.success : B.info, fontWeight: 600, padding: "3px 0" } }, invQty + "/" + qty)
      ),
      // Unit price — locked when accepted/converted
      h("div", { style: { width: 80 } },
        h("div", { style: { fontSize: "9px", color: B.textMut, textAlign: "right" } }, "unit"),
        h("div", { style: { fontSize: "11px", color: B.textMut, textAlign: "right", padding: "3px 6px", textDecoration: adjusted ? "line-through" : "none" } }, "$" + item.unitPrice)
      ),
      // Adjusted price — locked when accepted/converted
      h("div", { style: { width: 80 } },
        h("div", { style: { fontSize: "9px", color: B.textMut, textAlign: "right" } }, "adj"),
        isLocked
          ? h("div", { style: { fontSize: "11px", color: adjusted ? B.accent : B.textMut, textAlign: "right", padding: "3px 0" } }, item.adjustedPrice != null ? "$" + item.adjustedPrice : "\u2014")
          : h("input", { type: "number", value: item.adjustedPrice != null ? item.adjustedPrice : "",
              placeholder: String(item.unitPrice),
              onChange: function(e) {
                var v = e.target.value;
                onUpdate(sectionId, item.id, { adjustedPrice: v === "" ? null : Number(v) });
              },
              style: { width: "100%", background: B.bg, border: "1px solid " + (adjusted ? B.accent : B.border), borderRadius: "3px", padding: "3px 6px", color: adjusted ? B.accent : B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", textAlign: "right" } })
      ),
      // Line total
      h("div", { style: { width: 90, textAlign: "right" } },
        h("div", { style: { fontSize: "9px", color: B.textMut } }, "total"),
        h("div", { style: { fontSize: "12px", fontWeight: 700, color: B.accent } }, "$" + Math.round(lineTotal).toLocaleString())
      ),
      // Delete — hidden when locked
      !isLocked && h("button", { onClick: function() { onDelete(sectionId, item.id); },
        style: { background: "transparent", border: "none", color: B.textMut, cursor: "pointer", fontSize: "14px", padding: "2px 6px" } }, "\u00d7")
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   SECTION BLOCK
  // ═══════════════════════════════════════════════════════════════════════════

  function SectionBlock({ section, quoteDates, quoteStatus, onLabelChange, onUpdate, onDelete, onAddItem, onItemUpdate, onItemDelete,
                          onItemDragStart, onItemDrop, onSectionDragStart, onSectionDragOver, onSectionDrop,
                          sectionSubtotal, sectionMargin, services }) {
    var isLocked = quoteStatus === "accepted" || quoteStatus === "converted";
    var effectiveDates = section.customDates && section.startDate && section.endDate
      ? { start: section.startDate, end: section.endDate }
      : quoteDates;
    return h("div", {
      onDragOver: isLocked ? undefined : function(e) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; },
      onDrop:     isLocked ? undefined : function(e) { e.preventDefault(); onSectionDrop(section.id); },
      style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: 12, marginBottom: 12 }
    },
      // Section header
      h("div", {
        draggable: !isLocked,
        onDragStart: isLocked ? undefined : function(e) { onSectionDragStart(section.id); e.dataTransfer.effectAllowed = "move"; },
        onDragOver:  isLocked ? undefined : function(e) { e.preventDefault(); },
        style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10, cursor: isLocked ? "default" : "grab" }
      },
        !isLocked && h("span", { style: { fontSize: "14px", color: B.textMut, userSelect: "none" } }, "\u2630"),
        isLocked
          ? h("div", { style: { flex: 1, fontSize: "14px", fontWeight: 700, color: B.text, fontFamily: "'Playfair Display', serif", padding: "4px 0" } }, section.label)
          : h("input", { type: "text", value: section.label,
              onChange: function(e) { onLabelChange(section.id, e.target.value); },
              style: { flex: 1, background: "transparent", border: "none", borderBottom: "1px solid " + B.border, color: B.text, fontSize: "14px", fontWeight: 700, fontFamily: "'Playfair Display', serif", outline: "none", padding: "4px 0" } }),
        h("div", { style: { fontSize: "11px", color: B.textMut, textAlign: "right" } },
          h("div", null, "$" + Math.round(sectionSubtotal).toLocaleString()),
          h("div", { style: { fontSize: "9px" } }, "margin: $" + Math.round(sectionMargin).toLocaleString())
        ),
        !isLocked && h("button", { onClick: function() { onDelete(section.id); },
          style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "4px", color: B.textMut, cursor: "pointer", fontSize: "11px", padding: "3px 8px" } }, "Delete Section")
      ),

      // Per-section rental period override — locked when accepted/converted
      h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10, paddingLeft: isLocked ? 0 : 24 } },
        !isLocked && h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: "11px", color: B.textMut, cursor: "pointer" } },
          h("input", { type: "checkbox", checked: section.customDates,
            onChange: function(e) { onUpdate(section.id, { customDates: e.target.checked }); },
            style: { accentColor: B.accent } }),
          "Custom rental period"
        ),
        !isLocked && section.customDates && h("div", { style: { display: "inline-flex", gap: 8, alignItems: "center" } },
          h(window.LTPInput, { label: "Start", value: section.startDate || "",
            onChange: function(v) { onUpdate(section.id, { startDate: v }); }, type: "date" }),
          h("span", { style: { fontSize: "11px", color: B.textMut, marginTop: 14 } }, "\u2192"),
          h(window.LTPInput, { label: "End", value: section.endDate || "",
            onChange: function(v) { onUpdate(section.id, { endDate: v }); }, type: "date" })
        ),
        // Always show the effective dates as info text when locked or when using quote dates
        (isLocked || !section.customDates) && effectiveDates && effectiveDates.start && h("span", { style: { fontSize: "10px", color: B.textMut, fontStyle: "italic" } },
          (section.customDates ? "Rental period: " : "Using quote dates: ") + fmt(effectiveDates.start) + " \u2192 " + fmt(effectiveDates.end))
      ),

      // Items
      h("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 } },
        section.items.length === 0 && h("div", { style: { padding: "14px", textAlign: "center", color: B.textMut, fontSize: "11px", fontStyle: "italic", background: B.surface, borderRadius: "4px", border: "1px dashed " + B.border } }, "No items. Click \"Add Item\" below to start."),
        section.items.map(function(it) {
          return h(LineItemRow, { key: it.id, item: it, sectionId: section.id, quoteStatus: quoteStatus,
            onUpdate: function(sid, iid, patch) { onItemUpdate(sid, iid, patch); },
            onDelete: onItemDelete,
            onDragStart: onItemDragStart, onDrop: onItemDrop, services: services });
        })
      ),

      // Add item button — hidden when locked
      !isLocked && h("button", { onClick: function() { onAddItem(section.id); },
        style: { background: "transparent", border: "1px dashed " + B.accent + "66", color: B.accent, cursor: "pointer", fontSize: "11px", fontWeight: 600, padding: "8px", borderRadius: "4px", width: "100%" } }, "+ Add Item to " + section.label)
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   TOTALS PANEL
  // ═══════════════════════════════════════════════════════════════════════════

  function TotalsPanel({ draft, isLocked, onDiscountChange }) {
    var t = window.LTP_QUOTE_TOTALS(draft);
    var autoAdjustment = t.subtotal - t.adjusted; // positive = client got a discount
    var globalDiscountAmount = t.adjusted - t.total;
    var marginTotal = t.total - t.cost;
    var marginPct = t.total > 0 ? Math.round((marginTotal / t.total) * 100) : 0;
    var gd = draft.globalDiscount || { type: "none", value: 0 };

    var row = function(label, value, opts) {
      opts = opts || {};
      return h("div", { style: { display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: opts.big ? "14px" : "12px", color: opts.color || B.textSec, fontWeight: opts.bold ? 700 : 400, borderTop: opts.topBorder ? "1px solid " + B.border : "none", marginTop: opts.topBorder ? 6 : 0, paddingTop: opts.topBorder ? 10 : 6 } },
        h("span", null, label),
        h("span", null, value)
      );
    };

    return h("div", { style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: "14px 18px" } },
      h("h4", { style: { fontSize: "12px", fontWeight: 700, color: B.textSec, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 8px" } }, "Totals"),
      row("Subtotal", "$" + Math.round(t.subtotal).toLocaleString()),
      autoAdjustment !== 0 && row("Line adjustments",
        (autoAdjustment > 0 ? "\u2212" : "+") + "$" + Math.round(Math.abs(autoAdjustment)).toLocaleString(),
        { color: autoAdjustment > 0 ? B.success : B.danger }),

      // Global discount row
      h("div", { style: { borderTop: "1px solid " + B.border, marginTop: 6, paddingTop: 10 } },
        !isLocked
          ? h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 } },
              h("span", { style: { fontSize: "11px", color: B.textMut, flex: 1 } }, "Global Discount"),
              h("select", { value: gd.type, onChange: function(e) { onDiscountChange({ type: e.target.value, value: gd.value }); },
                style: { background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 6px", color: B.text, fontSize: "11px", fontFamily: "inherit" } },
                h("option", { value: "none"    }, "None"       ),
                h("option", { value: "percent" }, "Percent (%)" ),
                h("option", { value: "amount"  }, "Amount ($)"  ),
                h("option", { value: "target"  }, "Target ($)"  )
              ),
              gd.type !== "none" && h("input", { type: "number", value: gd.value,
                onChange: function(e) { onDiscountChange({ type: gd.type, value: Number(e.target.value) || 0 }); },
                style: { width: 90, background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 6px", color: B.text, fontSize: "11px", fontFamily: "inherit", textAlign: "right", outline: "none" } })
            )
          : gd.type !== "none" && h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "11px", color: B.textMut, marginBottom: 6 } },
              h("span", null, "Global Discount"),
              h("span", null, gd.type === "percent" ? gd.value + "%" : "$" + gd.value)
            ),
        globalDiscountAmount !== 0 && h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "11px", color: B.textMut } },
          h("span", null, gd.type === "percent" ? "(\u2212" + gd.value + "%)" : gd.type === "target" ? "(target)" : "(\u2212$" + gd.value + ")"),
          h("span", null, "\u2212$" + Math.round(globalDiscountAmount).toLocaleString())
        )
      ),

      row("TOTAL", "$" + Math.round(t.total).toLocaleString(), { big: true, bold: true, color: B.accent, topBorder: true }),

      // Internal margin section
      h("div", { style: { marginTop: 12, paddingTop: 10, borderTop: "2px dashed " + B.border } },
        h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "12px", color: B.textMut, padding: "2px 0" } },
          h("span", null, "Total Cost"),
          h("span", null, "$" + Math.round(t.cost).toLocaleString())
        ),
        h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "12px", color: B.textMut, padding: "2px 0" } },
          h("span", null, "Margin"),
          h("span", { style: { color: marginPct >= 40 ? B.success : marginPct >= 20 ? B.warn : B.danger, fontWeight: 700 } }, "$" + Math.round(marginTotal).toLocaleString() + " (" + marginPct + "%)")
        )
      )
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   CHANGE DIFF — computes what changed between two quote snapshots
  // ═══════════════════════════════════════════════════════════════════════════

  function computeChanges(before, after, projects, companies) {
    if (!before || !after) return null;
    var changes = [];
    projects = projects || [];
    companies = companies || [];

    // Helper: resolve effective dates for a quote snapshot
    function effectiveDates(q) {
      if (q.projectId) {
        var p = projects.find(function(pr) { return pr.id === q.projectId; });
        return p ? { start: p.startDate, end: p.endDate } : { start: "", end: "" };
      }
      return { start: q.customStartDate || "", end: q.customEndDate || "" };
    }

    // Totals
    var tBefore = window.LTP_QUOTE_TOTALS(before);
    var tAfter  = window.LTP_QUOTE_TOTALS(after);
    if (Math.round(tBefore.total) !== Math.round(tAfter.total)) {
      changes.push({ cat: "Quote Total", detail: "$" + Math.round(tBefore.total).toLocaleString() + " → $" + Math.round(tAfter.total).toLocaleString() });
    }

    // Status
    if (before.status !== after.status) {
      changes.push({ cat: "Status", detail: (before.status || "draft") + " \u2192 " + (after.status || "draft") });
    }

    // Client type
    if (before.clientType !== after.clientType) {
      changes.push({ cat: "Client Type", detail: (before.clientType || "company") + " \u2192 " + (after.clientType || "company") });
    }

    // Company
    if (before.companyId !== after.companyId) {
      var cB = before.companyId ? ((companies.find(function(c) { return c.id === before.companyId; }) || {}).name || "ID " + before.companyId) : "None";
      var cA = after.companyId ? ((companies.find(function(c) { return c.id === after.companyId; }) || {}).name || "ID " + after.companyId) : "None";
      changes.push({ cat: "Company", detail: cB + " \u2192 " + cA });
    }

    // Custom name
    if (before.customName !== after.customName) {
      changes.push({ cat: "Quote Name", detail: (before.customName || "None") + " \u2192 " + (after.customName || "None") });
    }

    // Global discount
    var gdB = before.globalDiscount || {}, gdA = after.globalDiscount || {};
    if (gdB.type !== gdA.type || gdB.value !== gdA.value) {
      var gdBLabel = gdB.type === "none" || !gdB.type ? "None" : gdB.type === "percent" ? gdB.value + "%" : gdB.type === "target" ? "Target $" + gdB.value : "$" + gdB.value;
      var gdALabel = gdA.type === "none" || !gdA.type ? "None" : gdA.type === "percent" ? gdA.value + "%" : gdA.type === "target" ? "Target $" + gdA.value : "$" + gdA.value;
      changes.push({ cat: "Global Discount", detail: gdBLabel + " \u2192 " + gdALabel });
    }

    // Notes
    if ((before.notes || "") !== (after.notes || "")) {
      changes.push({ cat: "Notes", detail: "Updated" });
    }

    // Project / dates — compare effective dates (project dates when linked, custom when not)
    if (before.projectId !== after.projectId) {
      var bProj = before.projectId ? projects.find(function(p) { return p.id === before.projectId; }) : null;
      var aProj = after.projectId ? projects.find(function(p) { return p.id === after.projectId; }) : null;
      var bName = bProj ? bProj.name : (before.projectId ? "Project #" + before.projectId : "No project");
      var aName = aProj ? aProj.name : (after.projectId ? "Project #" + after.projectId : "Custom dates");
      changes.push({ cat: "Project", detail: bName + " → " + aName });
    }
    var bDates = effectiveDates(before);
    var aDates = effectiveDates(after);
    if (bDates.start !== aDates.start || bDates.end !== aDates.end) {
      var bRange = bDates.start ? (fmt(bDates.start) + " — " + fmt(bDates.end)) : "No dates";
      var aRange = aDates.start ? (fmt(aDates.start) + " — " + fmt(aDates.end)) : "No dates";
      changes.push({ cat: "Quote Dates", detail: bRange + " → " + aRange });
    }

    // Section-level changes
    var bSecMap = {}; (before.sections || []).forEach(function(s) { bSecMap[s.id] = s; });
    var aSecMap = {}; (after.sections || []).forEach(function(s) { aSecMap[s.id] = s; });

    // Added sections
    (after.sections || []).forEach(function(s) {
      if (!bSecMap[s.id]) changes.push({ cat: "Section Added", detail: "\"" + s.label + "\"" });
    });
    // Removed sections
    (before.sections || []).forEach(function(s) {
      if (!aSecMap[s.id]) changes.push({ cat: "Section Removed", detail: "\"" + s.label + "\"" });
    });

    // Per-section diffs
    (after.sections || []).forEach(function(aSec) {
      var bSec = bSecMap[aSec.id];
      if (!bSec) return;

      // Label change
      if (bSec.label !== aSec.label) changes.push({ cat: "Section Renamed", detail: "\"" + bSec.label + "\" → \"" + aSec.label + "\"" });

      // Custom dates change
      if (bSec.customDates !== aSec.customDates || bSec.startDate !== aSec.startDate || bSec.endDate !== aSec.endDate) {
        if (aSec.customDates) {
          var secRange = aSec.startDate && aSec.endDate ? fmt(aSec.startDate) + " \u2192 " + fmt(aSec.endDate) : "Not set";
          var prevRange = bSec.customDates && bSec.startDate && bSec.endDate ? fmt(bSec.startDate) + " \u2192 " + fmt(bSec.endDate) : "Quote dates";
          changes.push({ cat: aSec.label + " Rental Period", detail: prevRange + " \u2192 " + secRange });
        } else if (bSec.customDates) {
          changes.push({ cat: aSec.label + " Rental Period", detail: "Reset to quote dates" });
        }
      }

      // Section subtotal
      var stB = 0, stA = 0;
      (bSec.items || []).forEach(function(i) { if (i.type !== "note") stB += ((i.adjustedPrice != null ? i.adjustedPrice : i.unitPrice) || 0) * (i.qty || 0); });
      (aSec.items || []).forEach(function(i) { if (i.type !== "note") stA += ((i.adjustedPrice != null ? i.adjustedPrice : i.unitPrice) || 0) * (i.qty || 0); });
      if (Math.round(stB) !== Math.round(stA)) {
        changes.push({ cat: aSec.label + " Subtotal", detail: "$" + Math.round(stB).toLocaleString() + " → $" + Math.round(stA).toLocaleString() });
      }

      // Item-level diffs
      var bItemMap = {}; (bSec.items || []).forEach(function(i) { bItemMap[i.id] = i; });
      var aItemMap = {}; (aSec.items || []).forEach(function(i) { aItemMap[i.id] = i; });

      (aSec.items || []).forEach(function(i) {
        if (!bItemMap[i.id] && i.type !== "note") {
          changes.push({ cat: aSec.label + " — Item Added", detail: i.name + " (×" + i.qty + ")" });
        } else if (bItemMap[i.id] && i.type !== "note") {
          var bi = bItemMap[i.id];
          if (bi.qty !== i.qty) changes.push({ cat: aSec.label + " — Qty", detail: i.name + ": " + bi.qty + " → " + i.qty });
          if (bi.unitPrice !== i.unitPrice) changes.push({ cat: aSec.label + " — Price", detail: i.name + ": $" + bi.unitPrice + " → $" + i.unitPrice });
          if ((bi.adjustedPrice || null) !== (i.adjustedPrice || null)) {
            var adjB = bi.adjustedPrice != null ? "$" + bi.adjustedPrice : "$" + bi.unitPrice + " (base)";
            var adjA = i.adjustedPrice != null ? "$" + i.adjustedPrice : "$" + i.unitPrice + " (base)";
            changes.push({ cat: aSec.label + " — Adj. Price", detail: i.name + ": " + adjB + " \u2192 " + adjA });
          }
          var dB = Number(bi.deliveredQty) || 0, dA = Number(i.deliveredQty) || 0;
          if (dB !== dA) changes.push({ cat: aSec.label + " — Delivered", detail: i.name + ": " + dB + " \u2192 " + dA + " of " + (i.qty || 0) });
          var iB = Number(bi.invoicedQty) || 0, iA = Number(i.invoicedQty) || 0;
          if (iB !== iA) changes.push({ cat: aSec.label + " — Invoiced", detail: i.name + ": " + iB + " \u2192 " + iA + " of " + (i.qty || 0) });
        }
      });
      (bSec.items || []).forEach(function(i) {
        if (!aItemMap[i.id] && i.type !== "note") {
          changes.push({ cat: aSec.label + " — Item Removed", detail: i.name });
        }
      });
    });

    return changes.length > 0 ? changes : null;
  }


  window.QuotesBuilder = function({ quoteId, isNew, quotes, setQuotes, getNextQuoteId, products, services, equipment, allocations, companies, contacts, projects, setProjects, invoices, setInvoices, getNextInvoiceId, settings }) {
    // Load initial draft
    var initial = useMemo(function() {
      if (isNew) {
        var d = emptyDraft();
        // Check for prefill from project screen (or other external navigators)
        var pf = window.__LTP_PREFILL_QUOTE;
        if (pf) {
          if (pf.projectId) {
            d.projectId = pf.projectId;
            var pfProj = projects.find(function(p) { return p.id === pf.projectId; });
            d.activity[0].message = "Quote created for " + (pfProj ? pfProj.name : "project #" + pf.projectId);
            d.activity[0].changes = [{ cat: "Project", detail: pfProj ? pfProj.name : "ID " + pf.projectId }];
          }
          if (pf.companyId) { d.companyId = pf.companyId; d.clientType = "company"; }
          window.__LTP_PREFILL_QUOTE = null;
        }
        return d;
      }
      var q = quotes.find(function(x) { return x.id === quoteId; });
      return q ? cloneDraft(q) : emptyDraft();
    }, [quoteId, isNew]);

    // Two-tier setter:
    //   setDraftRaw — internal, does NOT mark dirty (used by reset and post-save sync)
    //   setDraft    — public wrapper used by all mutators, automatically marks dirty
    var [draft, setDraftRaw] = useState(initial);
    // Owns dirty state AND mirrors to window.__LTP_UNSAVED synchronously.
    // See theme.js — the synchronous mirror is what makes save+nav not
    // trigger a bogus "unsaved changes" prompt.
    var unsavedPair = window.LTP_useUnsavedGuard();
    var isDirty = unsavedPair[0];
    var setIsDirty = unsavedPair[1];
    // cleanRef tracks the last "clean" state — what Discard should reset to.
    // Updated on mount, after save, and after automated price recalculations.
    var cleanRef = useRef(initial);
    var warnedSentEdit = React.useRef(false);
    // Silent draft updates — no sent-edit warning (for delivered/invoiced fields)
    function setDraftSilent(updater) { setDraftRaw(updater); setIsDirty(true); }
    function setDraft(updater) {
      if (!warnedSentEdit.current && draft.status && draft.status !== "draft") {
        warnedSentEdit.current = true;
        showAlert("Editing Sent Quote", "This quote has been sent to the client. Changes won't be visible to them until you resend.");
      }
      setDraftRaw(updater); setIsDirty(true);
    }

    // When the user navigates to a different quote (or new ↔ existing), reset the
    // local draft to match. Otherwise stale draft from previous quote would persist.
    useEffect(function() {
      setDraftRaw(initial);
      cleanRef.current = initial;
      setIsDirty(false);
    }, [quoteId, isNew]);

    var [pickerForSection, setPickerForSection] = useState(null);
    var [dlg, setDlg] = useState(null);
    var [justSaved, setJustSaved] = useState(false);
    var [viewActivity, setViewActivity] = useState(null);
    var [invPickerData, setInvPickerData] = useState(null);
    var [showSendModal, setShowSendModal] = useState(false);
    var [sendEmail, setSendEmail] = useState("");
    var [sendCc, setSendCc] = useState("");
    var [sendSubject, setSendSubject] = useState("");
    var [sendMessage, setSendMessage] = useState("");
    // Per-entity values that get baked into the header HTML at send time.
    // Captured at openSendModal so a later draft mutation doesn't change
    // what the user sees in the modal preview.
    var [sendHeaderVars, setSendHeaderVars] = useState(null);
    var [sending, setSending] = useState(false);  // disables Send button while POST is in flight
    var [generatingPdf, setGeneratingPdf] = useState(false);

    // Generate PDF: POST /api/quotes/{id}/pdf → triggers archive + activity
    // append on the server → returns {token, downloadUrl, filename}. We then
    // navigate the browser to that URL to download. The server-side activity
    // entry is reflected locally by appending to draft.activity so the user
    // sees the new "PDF generated" entry without a full refetch.
    function generatePdf() {
      if (draft.id == null || generatingPdf) return;
      setGeneratingPdf(true);
      fetch("/api/quotes/" + draft.id + "/pdf", { method: "POST", credentials: "include" })
        .then(function(r) {
          if (!r.ok) {
            return r.text().then(function(body) {
              throw new Error("PDF generation failed: " + r.status + " " + body.slice(0, 200));
            });
          }
          return r.json();
        })
        .then(function(resp) {
          // Trigger download. <a download> on a same-origin URL just works.
          var a = document.createElement("a");
          a.href = resp.downloadUrl;
          a.download = resp.filename || ("Q-" + draft.id + ".pdf");
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          // Mirror the server's activity entry into local state so the
          // activity feed updates immediately. The server is the source of
          // truth; this is just an optimistic display so the user sees the
          // entry before the next save sync.
          var actEntry = {
            id: "pdf-" + Date.now(),
            date: todayISO(),
            time: new Date().toTimeString().substring(0, 5),
            type: "pdf_generated",
            user: (window.LTP_CURRENT_USER || "User"),
            userId: window.LTP_CURRENT_USER_ID || null,
            message: "PDF generated",
            pdfToken: resp.token,
            pdfFilename: resp.filename,
          };
          var updated = Object.assign({}, draft, { activity: (draft.activity || []).concat([actEntry]) });
          setDraftRaw(updated);
          cleanRef.current = updated;
          // Also update the quotes list state so the activity persists if
          // the user navigates away and back.
          setQuotes(function(prev) { return prev.map(function(q) { return q.id === draft.id ? updated : q; }); });
        })
        .catch(function(err) {
          // The fetch wrapper in data-state.js handles 401 by redirecting;
          // here we just surface via the existing toast system.
          if (window.LTP_API_ERRORS) {
            window.LTP_API_ERRORS.push({ at: new Date().toISOString(), label: "POST quotes/" + draft.id + "/pdf", error: String(err) });
          }
          try {
            window.dispatchEvent(new CustomEvent("ltp-api-error", { detail: { label: "PDF generation", error: String(err), at: new Date().toISOString() } }));
          } catch (e) {}
          showAlert("PDF Error", "Could not generate the PDF. " + (err && err.message || err));
        })
        .finally(function() { setGeneratingPdf(false); });
    }

    // Drag tracking — ref so drag events don't trigger re-renders
    var dragRef = useRef(null); // { type: "item"|"section", sectionId, itemId? }

    // ── Draft mutators ─────────────────────────────────────────────────────────
    function patchDraft(patch) { setDraft(function(d) { return Object.assign({}, d, patch); }); }

    function updateSection(secId, patch) {
      setDraft(function(d) {
        return Object.assign({}, d, { sections: d.sections.map(function(s) { return s.id === secId ? Object.assign({}, s, patch) : s; }) });
      });
    }
    function addSection() {
      setDraft(function(d) {
        return Object.assign({}, d, { sections: d.sections.concat([{ id: genId("sec"), label: "New Section", items: [], customDates: false, startDate: "", endDate: "" }]) });
      });
    }
    function deleteSection(secId) {
      var sec = draft.sections.find(function(s) { return s.id === secId; });
      var label = sec ? sec.label : "this section";
      setDlg({
        title: "Delete Section",
        message: "Delete \"" + label + "\" and all its items? This cannot be undone.",
        variant: "danger",
        confirmLabel: "Delete",
        onConfirm: function() {
          setDraft(function(d) {
            return Object.assign({}, d, { sections: d.sections.filter(function(s) { return s.id !== secId; }) });
          });
          setDlg(null);
        },
      });
    }
    function addItemToSection(secId, item) {
      setDraft(function(d) {
        return Object.assign({}, d, { sections: d.sections.map(function(s) {
          return s.id === secId ? Object.assign({}, s, { items: s.items.concat([item]) }) : s;
        }) });
      });
    }
    function updateItem(secId, itemId, patch) {
      // Delivered/invoiced changes are operational — don't warn about editing sent quote
      var isOperational = Object.keys(patch).every(function(k) { return k === "deliveredQty" || k === "invoicedQty"; });
      var setter = isOperational ? setDraftSilent : setDraft;
      setter(function(d) {
        return Object.assign({}, d, { sections: d.sections.map(function(s) {
          if (s.id !== secId) return s;
          return Object.assign({}, s, { items: s.items.map(function(i) { return i.id === itemId ? Object.assign({}, i, patch) : i; }) });
        }) });
      });
    }
    function deleteItem(secId, itemId) {
      setDraft(function(d) {
        return Object.assign({}, d, { sections: d.sections.map(function(s) {
          if (s.id !== secId) return s;
          return Object.assign({}, s, { items: s.items.filter(function(i) { return i.id !== itemId; }) });
        }) });
      });
    }

    // ── Drag & drop handlers ───────────────────────────────────────────────────
    function onItemDragStart(sectionId, itemId) { dragRef.current = { type: "item", sectionId: sectionId, itemId: itemId }; }

    function onItemDrop(targetSectionId, targetItemId) {
      var src = dragRef.current;
      dragRef.current = null;
      if (!src || src.type !== "item") return;
      if (src.sectionId === targetSectionId && src.itemId === targetItemId) return;

      setDraft(function(d) {
        var newSections = d.sections.map(function(s) { return Object.assign({}, s, { items: s.items.slice() }); });
        // Find + remove source item
        var srcSec = newSections.find(function(s) { return s.id === src.sectionId; });
        if (!srcSec) return d;
        var srcIdx = srcSec.items.findIndex(function(i) { return i.id === src.itemId; });
        if (srcIdx === -1) return d;
        var movedItem = srcSec.items.splice(srcIdx, 1)[0];

        // Insert into target section before target item
        var tgtSec = newSections.find(function(s) { return s.id === targetSectionId; });
        if (!tgtSec) return d;
        var tgtIdx = tgtSec.items.findIndex(function(i) { return i.id === targetItemId; });
        if (tgtIdx === -1) tgtSec.items.push(movedItem);
        else                tgtSec.items.splice(tgtIdx, 0, movedItem);

        return Object.assign({}, d, { sections: newSections });
      });
    }

    function onSectionDrop(targetSectionId) {
      var src = dragRef.current;
      dragRef.current = null;
      if (!src) return;

      setDraft(function(d) {
        if (src.type === "item") {
          // Item dropped on section body → append to that section
          var newSections = d.sections.map(function(s) { return Object.assign({}, s, { items: s.items.slice() }); });
          var srcSec = newSections.find(function(s) { return s.id === src.sectionId; });
          if (!srcSec) return d;
          var srcIdx = srcSec.items.findIndex(function(i) { return i.id === src.itemId; });
          if (srcIdx === -1) return d;
          var moved = srcSec.items.splice(srcIdx, 1)[0];
          var tgtSec = newSections.find(function(s) { return s.id === targetSectionId; });
          if (!tgtSec) return d;
          tgtSec.items.push(moved);
          return Object.assign({}, d, { sections: newSections });
        }
        if (src.type === "section") {
          if (src.sectionId === targetSectionId) return d;
          var secs = d.sections.slice();
          var srcIdx2 = secs.findIndex(function(s) { return s.id === src.sectionId; });
          var tgtIdx2 = secs.findIndex(function(s) { return s.id === targetSectionId; });
          if (srcIdx2 === -1 || tgtIdx2 === -1) return d;
          var movedSec = secs.splice(srcIdx2, 1)[0];
          secs.splice(tgtIdx2, 0, movedSec);
          return Object.assign({}, d, { sections: secs });
        }
        return d;
      });
    }

    function onSectionDragStart(sectionId) { dragRef.current = { type: "section", sectionId: sectionId }; }

    // ── Save / discard ─────────────────────────────────────────────────────────
    function showAlert(title, message) {
      setDlg({
        title: title, message: message,
        variant: "primary", confirmLabel: "OK", alertOnly: true,
        onConfirm: function() { setDlg(null); },
      });
    }

    function save() {
      if (draft.clientType === "company" && !draft.companyId) {
        showAlert("Missing Information", "Please select a company before saving.");
        return;
      }
      if (draft.clientType === "contact" && !draft.clientContactId) {
        showAlert("Missing Information", "Please select a contact before saving.");
        return;
      }
      if (!draft.projectId && !draft.customName) {
        showAlert("Missing Information", "Please link a project or enter a custom quote name before saving.");
        return;
      }
      // Compute changes vs last saved state for the activity log
      var changes = computeChanges(cleanRef.current, draft, projects, companies);
      var changeCount = changes ? changes.length : 0;
      var saveMsg = "Quote saved" + (changeCount > 0 ? " (" + changeCount + " change" + (changeCount > 1 ? "s" : "") + ")" : "");
      var saveEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0,5), type: "saved", message: saveMsg, user: (window.LTP_CURRENT_USER || "User"), changes: changes };
      if (draft.id == null) {
        var newId = getNextQuoteId();
        // Mint shareToken client-side so the Preview button (gated on
        // draft.shareToken) appears immediately. The backend respects a
        // client-supplied token (only mints when absent), so this is the
        // source of truth and matches the same value on the server.
        var newToken = draft.shareToken || window.LTP_genShareToken();
        var toSave = Object.assign({}, draft, { id: newId, shareToken: newToken, activity: (draft.activity || []).concat([saveEntry]) });
        setQuotes(function(prev) { return prev.concat([toSave]); });
        setDraftRaw(toSave);
        cleanRef.current = toSave;
        setIsDirty(false);
        nav("quotes/" + newId);
      } else {
        // Backfill shareToken on existing-but-tokenless quotes (older rows
        // from before the share_token column was added). Once minted on
        // first save, the token persists via the standard spread.
        var existingPatch = { activity: (draft.activity || []).concat([saveEntry]) };
        if (!draft.shareToken) existingPatch.shareToken = window.LTP_genShareToken();
        var updated = Object.assign({}, draft, existingPatch);
        setQuotes(function(prev) { return prev.map(function(q) { return q.id === updated.id ? updated : q; }); });
        setDraftRaw(updated);
        cleanRef.current = updated;
        setIsDirty(false);
      }
      setJustSaved(true);
      setTimeout(function() { setJustSaved(false); }, 2200);
    }

    function discard() {
      setDlg({
        title: "Discard Changes",
        message: "Reset all unsaved changes back to the last saved version?",
        variant: "danger",
        confirmLabel: "Discard Changes",
        onConfirm: function() {
          setDraftRaw(cleanRef.current);
          setIsDirty(false);
          setDlg(null);
        },
      });
    }

    // ── Send Quote ─────────────────────────────────────────────────────────
    function openQuoteSendModal() {
      // Validate before opening the modal
      var itemCount = draft.sections.reduce(function(n, s) { return n + s.items.filter(function(i) { return i.type !== "note"; }).length; }, 0);
      if (itemCount === 0) { showAlert("No Items", "Add at least one line item before sending."); return; }
      if (!draft.companyId && !draft.clientContactId) { showAlert("No Client", "Select a company or contact before sending."); return; }
      var email = "";
      var clientName = "";
      if (draft.clientContactId) {
        var ct = contacts.find(function(c) { return c.id === draft.clientContactId; });
        if (ct) { email = ct.email || ""; clientName = ct.firstName + " " + ct.lastName; }
      } else if (draft.companyId) {
        var compContacts = contacts.filter(function(c) { return (c.companyIds || []).includes(draft.companyId); });
        if (compContacts.length > 0) { email = compContacts[0].email || ""; clientName = compContacts[0].firstName; }
      }
      var projName = selectedProject ? selectedProject.name : (draft.customName || "");
      var ref = draft.id != null ? window.LTP_QUOTE_REF(draft) : "Quote";
      var totals = window.LTP_QUOTE_TOTALS(draft);
      var resolve = window.LTP_resolveTemplate;
      var s = settings || {};
      var templateKey = draft.status === "draft" ? "quoteSent" : "quoteFollowUp";
      var tmpl = (s.emailTemplates || {})[templateKey] || {};
      // viewUrl and signature are intentionally LEFT as placeholders in the
      // body the user sees and edits — backend re-resolves them at send time:
      //   {{viewUrl}}   becomes the per-recipient tracked URL (with ?r=<token>)
      //   {{signature}} becomes the workspace signature template rendered
      //                 with the sender's userName/userTitle/userPhone.
      // Substituting them here would either inject a non-tracking URL or a
      // stale signature. All OTHER variables get substituted now since they
      // depend on the entity, not on per-recipient state.
      var vars = {
        companyName: s.companyName || "LTP",
        refNumber: ref,
        projectName: projName,
        clientName: clientName || "there",
        total: "$" + Math.round(totals.total).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        quoteValidity: String(s.defaultQuoteValidity || 30),
      };
      setSendEmail(email);
      setSendCc(resolve(tmpl.cc || "", vars));
      setSendSubject(resolve(tmpl.subject || "{{refNumber}} — {{projectName}} from {{companyName}}", vars));
      setSendMessage(resolve(tmpl.body || "{{header}}\n\nHi {{clientName}},\n\nPlease find the attached quote {{refNumber}}.\n\n{{signature}}", vars));
      // headerVars feed both (a) the editor's preview render of the
      // {{header}} block and (b) the send-time expansion in executeSendQuote.
      // viewUrl is left blank — backend resolves it per-recipient.
      setSendHeaderVars({ refNumber: ref, projectName: projName, total: vars.total, viewUrl: "" });
      setShowSendModal(true);
    }

    function executeSendQuote() {
      if (!sendEmail || !window.LTP_isValidEmail(sendEmail)) { showAlert("Invalid Email", "Enter a valid email address."); return; }
      if (draft.id == null || !draft.shareToken) { showAlert("Save First", "Save the quote before sending so it has a stable share link."); return; }
      if (!window.LTP_GMAIL_CONNECTED) {
        showAlert("Gmail Not Connected", "Sign out and back in with Google to grant the gmail.send permission, then try again.");
        return;
      }
      var isResend = draft.status !== "draft";
      // Backend owns the activity entry now \u2014 see backend/routes/email.py.
      // Frontend posts the message; on 2xx we just refresh the draft from
      // setQuotes since the server already appended `email_sent` to the
      // activity log + minted email_recipients rows with tracking tokens.
      setSending(true);
      // Expand {{header}} into its rendered HTML (with refNumber /
      // projectName / total baked in) JUST before send. We keep
      // {{header}} literal in sendMessage state so the editor can wrap
      // it as a non-editable block; backend stays simple and only
      // resolves the per-recipient {{viewUrl}} + per-sender {{signature}}.
      var headerHtml = window.LTP_renderHeader(
        ((settings || {}).emailHeaderTemplate || (window.LTP_DATA_SETTINGS || {}).emailHeaderTemplate),
        sendHeaderVars || {}
      );
      var bodyWithHeader = String(sendMessage).split("{{header}}").join(headerHtml);
      fetch("/api/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "quote",
          entityId: draft.id,
          to: sendEmail,
          cc: (sendCc || "").trim() || null,  // whitespace-only → omit
          subject: sendSubject,
          // textToHtml converts blank-line paragraphs + single newlines
          // when the body is plain text. If the admin authored HTML in
          // the template editor, it passes through untouched. Server
          // re-resolves {{viewUrl}} and {{signature}} and sanitizes via
          // bleach before sending.
          bodyHtml: window.LTP_textToHtml(bodyWithHeader),
        }),
      })
        .then(function(r) {
          return r.json().then(function(body) { return { status: r.status, body: body }; });
        })
        .then(function(resp) {
          setSending(false);
          if (resp.status === 200) {
            // Mark the quote sent locally so the UI flips status without a
            // round-trip. Backend already stamped `email_sent` on the
            // entity's activity \u2014 the next list refresh will surface it.
            var today = todayISO();
            var updated = Object.assign({}, draft, {
              status: isResend ? draft.status : "sent",
              sentDate: isResend ? draft.sentDate : today,
            });
            setQuotes(function(prev) { return prev.map(function(q) { return q.id === updated.id ? updated : q; }); });
            setDraftRaw(updated); cleanRef.current = updated; setIsDirty(false);
            setShowSendModal(false);
            setDlg({ title: isResend ? "Quote Resent" : "Quote Sent", message: "Quote " + (isResend ? "resent" : "sent") + " to " + sendEmail + ".", confirmLabel: "OK", onConfirm: function() { setDlg(null); } });
            return;
          }
          if (resp.status === 409 && resp.body && resp.body.detail && resp.body.detail.reason === "reconnect") {
            // Token revoked / refresh failed \u2014 Gmail send won't work until
            // the user re-consents.
            showAlert("Reconnect Google", "Your Google connection no longer has Gmail send permission. Sign out and back in to reconnect.");
            return;
          }
          var msg = "Send failed (HTTP " + resp.status + ").";
          if (resp.body && resp.body.detail) {
            var d = resp.body.detail;
            if (typeof d === "string") msg = d;
            else if (d.error) msg = d.error;
            else if (d.reason) msg = d.reason;
          }
          showAlert("Send Failed", msg);
        })
        .catch(function(e) {
          setSending(false);
          showAlert("Send Failed", "Network or server error: " + String(e.message || e));
        });
    }

    function recallQuoteToDraft() {
      if (draft.status === "draft") return;
      if (draft.status === "accepted" || draft.status === "converted") {
        var linkedInvs = (invoices || []).filter(function(inv) { return inv.quoteId === draft.id; });
        if (linkedInvs.length > 0) {
          showAlert("Cannot Recall", "This quote has " + linkedInvs.length + " linked invoice(s). Delete all linked invoices before recalling.");
          return;
        }
      }
      // Check for confirmed/requested crew on the project schedule
      var crewWarning = "";
      if (draft.projectId) {
        var proj = (projects || []).find(function(p) { return p.id === draft.projectId; });
        if (proj && proj.schedule) {
          var activeCrew = [];
          proj.schedule.forEach(function(s) {
            (s.positions || []).forEach(function(p) {
              if (p.crewId && (p.status === "confirmed" || p.status === "accepted" || p.status === "requested")) {
                var cm = contacts.find(function(c) { return c.id === p.crewId; });
                activeCrew.push((cm ? cm.firstName + " " + cm.lastName : "Unknown") + " (" + p.status + ")");
              }
            });
          });
          if (activeCrew.length > 0) {
            crewWarning = "\n\n\u26a0 Warning: The linked project has " + activeCrew.length + " active crew assignment" + (activeCrew.length > 1 ? "s" : "") + ": " + activeCrew.slice(0, 5).join(", ") + (activeCrew.length > 5 ? "..." : "") + ". Consider addressing crew assignments in the Labor module before recalling this quote.";
          }
        }
      }
      var sentTo = "";
      (draft.activity || []).forEach(function(a) {
        if (a.type === "sent" && a.changes) a.changes.forEach(function(ch) { if (ch.cat === "Sent To") sentTo = ch.detail; });
      });
      var warningMsg = draft.status === "accepted"
        ? "This quote was accepted. Recalling will unlock it for editing, clear all delivered and invoiced quantities, and the client should be notified of changes." + crewWarning
        : "This quote was sent" + (sentTo ? " to " + sentTo : "") + ". Recalling will unlock it for editing. You will need to resend after making changes." + crewWarning;
      setDlg({
        title: "Recall Quote to Draft", message: warningMsg, variant: "danger", confirmLabel: "Recall to Draft",
        onConfirm: function() {
          var clearedSections = (draft.status === "accepted" || draft.status === "converted")
            ? draft.sections.map(function(sec) { return Object.assign({}, sec, { items: sec.items.map(function(it) { return it.type === "note" ? it : Object.assign({}, it, { deliveredQty: 0, invoicedQty: 0 }); }) }); })
            : draft.sections;
          var actEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0, 5),
            type: "status", user: (window.LTP_CURRENT_USER || "User"), message: "Quote recalled to draft" + (draft.status === "accepted" ? " (delivery/invoiced quantities cleared)" : ""),
 changes: [{ cat: "Status", detail: draft.status + " \u2192 draft" }] };
          var recallPatch = { status: "draft", sections: clearedSections, activity: (draft.activity || []).concat([actEntry]) };
          if (!draft.shareToken) recallPatch.shareToken = window.LTP_genShareToken();
          var updated = Object.assign({}, draft, recallPatch);
          setQuotes(function(prev) { return prev.map(function(q) { return q.id === updated.id ? updated : q; }); });
          setDraftRaw(updated); cleanRef.current = updated; setIsDirty(false); setDlg(null);
        }
      });
    }

    function acceptQuote() {
      var actEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0, 5),
        type: "status", message: "Quote accepted by client", user: (window.LTP_CURRENT_USER || "User"),
        changes: [{ cat: "Status", detail: "sent \u2192 accepted" }] };
      var updated = Object.assign({}, draft, { status: "accepted", activity: (draft.activity || []).concat([actEntry]) });
      setQuotes(function(prev) { return prev.map(function(q) { return q.id === updated.id ? updated : q; }); });
      setDraftRaw(updated); cleanRef.current = updated; setIsDirty(false);
    }

    function declineQuote() {
      setDlg({ title: "Decline Quote", message: "Mark this quote as declined? You can reopen it later if needed.", variant: "danger", confirmLabel: "Mark Declined",
        onConfirm: function() {
          var actEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0, 5),
            type: "status", message: "Quote declined by client", user: (window.LTP_CURRENT_USER || "User"),
            changes: [{ cat: "Status", detail: draft.status + " \u2192 declined" }] };
          var updated = Object.assign({}, draft, { status: "declined", activity: (draft.activity || []).concat([actEntry]) });
          setQuotes(function(prev) { return prev.map(function(q) { return q.id === updated.id ? updated : q; }); });
          setDraftRaw(updated); cleanRef.current = updated; setIsDirty(false); setDlg(null);
        }
      });
    }

    function deleteQuote() {
      if (draft.id == null) return;
      var linkedInvoices = (invoices || []).filter(function(inv) { return inv.quoteId === draft.id; });
      if (linkedInvoices.length > 0) {
        var invRefs = linkedInvoices.map(function(inv) { return window.LTP_INVOICE_REF(inv); }).join(", ");
        showAlert("Cannot Delete Quote", "This quote has " + linkedInvoices.length + " linked invoice(s): " + invRefs + ". Delete all linked invoices first to maintain a clean paper trail.");
        return;
      }
      var refStr = window.LTP_QUOTE_REF(draft);
      setDlg({
        title: "Delete Quote",
        message: "Permanently delete " + refStr + "? This cannot be undone, and the reference number will not be reused.",
        variant: "danger",
        confirmLabel: "Delete Quote",
        onConfirm: function() {
          setQuotes(function(prev) { return prev.filter(function(q) { return q.id !== draft.id; }); });
          setDlg(null);
          nav("quotes");
        },
      });
    }

    // Check if there are delivered-but-uninvoiced items
    var hasUninvoiced = draft.status === "accepted" && draft.sections.some(function(sec) {
      return sec.items.some(function(it) {
        if (it.type === "note") return false;
        var d = Number(it.deliveredQty) || 0;
        var i = Number(it.invoicedQty) || 0;
        return d > i;
      });
    });

    // Check if any items still need to be marked as delivered
    var hasUndelivered = draft.status === "accepted" && draft.sections.some(function(sec) {
      return sec.items.some(function(it) {
        if (it.type === "note") return false;
        return (Number(it.deliveredQty) || 0) < (Number(it.qty) || 0);
      });
    });

    function markAllDelivered() {
      setDraftSilent(function(d) {
        return Object.assign({}, d, {
          sections: d.sections.map(function(sec) {
            return Object.assign({}, sec, {
              items: sec.items.map(function(it) {
                if (it.type === "note") return it;
                var qty = Number(it.qty) || 0;
                if ((Number(it.deliveredQty) || 0) >= qty) return it;
                return Object.assign({}, it, { deliveredQty: qty });
              })
            });
          })
        });
      });
      setIsDirty(true);
    }

    function sendToInvoice() {
      if (!hasUninvoiced) return;

      // Collect delivered-but-uninvoiced items
      var invSections = [];
      var updatedQuoteSections = draft.sections.map(function(sec) {
        var invItems = [];
        var updatedItems = sec.items.map(function(it) {
          if (it.type === "note") return it;
          var d = Number(it.deliveredQty) || 0;
          var inv = Number(it.invoicedQty) || 0;
          var toInvoice = d - inv;
          if (toInvoice <= 0) return it;
          // linkedQty caps how much of this invoice line counts against the
          // source quote's invoicedQty. Starts equal to qty; only ever shrinks
          // (when invoice qty is reduced below it). Extra qty added directly
          // on the invoice sits above linkedQty and is treated as a direct
          // bill, NOT additional draw against the quote.
          invItems.push(Object.assign({}, it, { id: genId("item"), qty: toInvoice, deliveredQty: toInvoice, invoicedQty: 0, sourceItemId: it.id, linkedQty: toInvoice }));
          return Object.assign({}, it, { invoicedQty: d });
        });
        if (invItems.length > 0) {
          invSections.push({ id: genId("sec"), label: sec.label, customDates: sec.customDates, startDate: sec.startDate, endDate: sec.endDate, items: invItems });
        }
        return Object.assign({}, sec, { items: updatedItems });
      });

      if (invSections.length === 0) return;

      // Convert discount
      var quoteGd = draft.globalDiscount || { type: "none", value: 0 };
      var invoiceDiscount = { type: "none", value: 0 };
      var discountNote = "";
      if (quoteGd.type === "percent") {
        invoiceDiscount = { type: "percent", value: quoteGd.value };
      } else if (quoteGd.type === "amount" || quoteGd.type === "target") {
        var quoteTotals = window.LTP_QUOTE_TOTALS(draft);
        var adjustedTotal = quoteTotals.adjusted;
        if (adjustedTotal > 0) {
          var effectiveAmount = quoteGd.type === "amount" ? quoteGd.value : (adjustedTotal - quoteGd.value);
          var pct = Math.round((effectiveAmount / adjustedTotal) * 10000) / 100;
          if (pct > 0) {
            invoiceDiscount = { type: "percent", value: pct };
            discountNote = quoteGd.type === "amount"
              ? "Discount converted: $" + quoteGd.value + " amount \u2192 " + pct + "%"
              : "Discount converted: $" + quoteGd.value + " target \u2192 " + pct + "%";
          }
        }
      }

      // Show the invoice target picker
      setInvPickerData({ invSections: invSections, updatedQuoteSections: updatedQuoteSections, invoiceDiscount: invoiceDiscount, discountNote: discountNote });
    }

    function executeSendToInvoice(targetInvoiceId) {
      var data = invPickerData;
      if (!data) return;
      setInvPickerData(null);

      var invSections = data.invSections;
      var updatedQuoteSections = data.updatedQuoteSections;
      var today = todayISO();
      var yr = (draft.createdDate || "").substring(0, 4) || String(new Date().getFullYear());
      var targetId;

      if (targetInvoiceId) {
        // Append to existing draft invoice
        targetId = targetInvoiceId;
        setInvoices(function(prev) {
          return prev.map(function(inv) {
            if (inv.id !== targetInvoiceId) return inv;
            // Append items to existing sections or add new sections
            var newSections = inv.sections.slice();
            invSections.forEach(function(iSec) {
              // Try to find matching section label
              var existing = newSections.find(function(es) { return es.label === iSec.label; });
              if (existing) {
                existing = Object.assign({}, existing, { items: existing.items.concat(iSec.items) });
                newSections = newSections.map(function(es) { return es.id === existing.id ? existing : es; });
              } else {
                newSections.push(iSec);
              }
            });
            var actEntry = { id: genId("act"), date: today, time: new Date().toTimeString().substring(0,5), type: "updated",
              message: "Items added from " + window.LTP_QUOTE_REF(draft), user: (window.LTP_CURRENT_USER || "User"),
              changes: invSections.map(function(s) { return { cat: s.label, detail: s.items.map(function(i) { return i.name + " \u00d7" + i.qty; }).join(", ") }; }) };
            return Object.assign({}, inv, { sections: newSections, activity: (inv.activity || []).concat([actEntry]) });
          });
        });
      } else {
        // Create new invoice
        targetId = getNextInvoiceId();
        var dueDate30 = function() { var d = new Date(); d.setDate(d.getDate() + (window.LTP_DEFAULT_TERMS || 30)); return d.toISOString().substring(0, 10); }();
        var creationChanges = invSections.map(function(s) { return { cat: s.label, detail: s.items.map(function(i) { return i.name + " \u00d7" + i.qty; }).join(", ") }; });
        if (data.discountNote) creationChanges.push({ cat: "Discount", detail: data.discountNote });
        var newInvoice = {
          id: targetId, quoteId: draft.id,
          shareToken: window.LTP_genShareToken(),
          clientType: draft.clientType, companyId: draft.companyId, clientContactId: draft.clientContactId,
          projectId: draft.projectId, customName: "", status: "draft",
          invoiceDate: today, createdDate: today, sentDate: null,
          dueDate: dueDate30, paidDate: null,
          globalDiscount: data.invoiceDiscount,
          sections: invSections, notes: "", payments: [],
          activity: [{ id: genId("act"), date: today, time: new Date().toTimeString().substring(0,5), type: "created",
            message: "Invoice created from " + window.LTP_QUOTE_REF(draft), user: (window.LTP_CURRENT_USER || "User"), changes: creationChanges }],
        };
        setInvoices(function(prev) { return prev.concat([newInvoice]); });
      }

      // Update quote: mark items as invoiced, check for auto-convert
      var allInvoiced = updatedQuoteSections.every(function(sec) {
        return sec.items.every(function(it) {
          if (it.type === "note") return true;
          return (Number(it.invoicedQty) || 0) >= (Number(it.qty) || 0);
        });
      });

      var invRef = targetInvoiceId
        ? window.LTP_INVOICE_REF(invoices.find(function(i) { return i.id === targetInvoiceId; }) || { id: targetInvoiceId })
        : "INV-" + yr + "-" + String(targetId).padStart(3, "0");
      var actEntry = {
        id: genId("act"), date: today, time: new Date().toTimeString().substring(0,5),
        type: "invoiced", user: (window.LTP_CURRENT_USER || "User"), message: (targetInvoiceId ? "Items added to " : "Invoice created: ") + invRef + (allInvoiced ? " \u2014 all items invoiced" : ""),

        changes: invSections.map(function(s) { return { cat: s.label, detail: s.items.map(function(i) { return i.name + " \u00d7" + i.qty; }).join(", ") }; })
          .concat(allInvoiced ? [{ cat: "Status", detail: "accepted \u2192 converted" }] : [])
      };

      var updatedQuote = Object.assign({}, draft, {
        sections: updatedQuoteSections,
        status: allInvoiced ? "converted" : draft.status,
        activity: (draft.activity || []).concat([actEntry])
      });

      setQuotes(function(prev) { return prev.map(function(q) { return q.id === updatedQuote.id ? updatedQuote : q; }); });
      setDraftRaw(updatedQuote);
      cleanRef.current = updatedQuote;
      setIsDirty(false);

      setTimeout(function() { nav("invoices/" + targetId); }, 100);
    }

    // ── Derived data ───────────────────────────────────────────────────────────
    var selectedProject = draft.projectId ? projects.find(function(p) { return p.id === draft.projectId; }) : null;
    var selectedCompany = draft.companyId ? companies.find(function(c) { return c.id === draft.companyId; }) : null;
    var projectContacts = selectedProject
      ? contacts.filter(function(c) { return (selectedProject.contactIds || []).includes(c.id); })
      : (selectedCompany ? contacts.filter(function(c) { return (c.companyIds || []).includes(selectedCompany.id); }) : []);

    // Quote-level dates (project dates or custom dates) — used as default for all sections
    var quoteDates = selectedProject
      ? { start: selectedProject.startDate, end: selectedProject.endDate }
      : (draft.customStartDate && draft.customEndDate)
        ? { start: draft.customStartDate, end: draft.customEndDate }
        : null;

    // ── Recompute equipment prices when dates change ───────────────────────────
    // Equipment unitPrice and rateType are derived from the effective rental dates
    // for each section. When project dates, custom dates, or section custom dates
    // change, we recalculate all equipment line items so the quote stays in sync.
    // adjustedPrice (manual overrides) are preserved — only the base unitPrice changes.
    var equipLookup = {};
    (equipment || []).forEach(function(eq) { equipLookup[eq.id] = eq; });

    // Build a string key that changes whenever any date-related input changes
    var dateKey = JSON.stringify({
      proj: selectedProject ? { s: selectedProject.startDate, e: selectedProject.endDate } : null,
      custom: { s: draft.customStartDate, e: draft.customEndDate },
      sections: draft.sections.map(function(sec) { return { cd: sec.customDates, s: sec.startDate, e: sec.endDate }; })
    });

    useEffect(function() {
      var changed = false;
      var newSections = draft.sections.map(function(sec) {
        var effDates = sec.customDates && sec.startDate && sec.endDate
          ? { start: sec.startDate, end: sec.endDate }
          : quoteDates;
        var newItems = sec.items.map(function(it) {
          if (it.type !== "equipment") return it;
          var eq = equipLookup[it.equipmentId];
          if (!eq) return it;
          var rp = calcRentalPrice(effDates ? effDates.start : null, effDates ? effDates.end : null, eq.rates);
          if (it.rateType === rp.rateType && it.unitPrice === rp.totalPrice && it.rentalLabel === rp.label) return it;
          changed = true;
          return Object.assign({}, it, { rateType: rp.rateType, rentalLabel: rp.label, unitPrice: rp.totalPrice });
        });
        return Object.assign({}, sec, { items: newItems });
      });
      if (changed) {
        var updated = Object.assign({}, draft, { sections: newSections });
        setDraftRaw(function() { return updated; });
        // If user hasn't made changes, this recalculation is the new clean baseline
        if (!isDirty) cleanRef.current = updated;
      }
    }, [dateKey]);

    var refDisplay = draft.id != null ? window.LTP_QUOTE_REF(draft) : "Q-" + (draft.createdDate || "").substring(0, 4) + "-NEW";
    var displayName = selectedProject ? selectedProject.name : (draft.customName || "Untitled Quote");

    // Section subtotals + margins (per-section display only)
    function sectionTotals(sec) {
      var sub = 0, cst = 0;
      sec.items.forEach(function(it) {
        if (it.type === "note") return;
        var qty = Number(it.qty) || 0;
        var eff = it.adjustedPrice != null ? it.adjustedPrice : it.unitPrice;
        sub += eff * qty;
        cst += (it.cost || 0) * qty;
      });
      return { subtotal: sub, margin: sub - cst };
    }

    // ── Render ─────────────────────────────────────────────────────────────────
    return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" } },
      // Sticky header bar
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: "12px 16px", flexShrink: 0, zIndex: 5 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 14 } },
          h("button", { onClick: function() { nav("quotes"); },
            style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.textSec, fontSize: "11px", fontFamily: "inherit", cursor: "pointer" } }, "\u2190 Back"),
          h("div", null,
            h("div", { style: { fontSize: "22px", fontWeight: 700, color: B.accent, fontFamily: "'Playfair Display', serif", letterSpacing: "0.02em", lineHeight: 1.1 } }, refDisplay),
            h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 3 } },
              h("span", { style: { fontSize: "12px", color: B.textSec } }, displayName),
              h(window.Badge, { status: draft.status })
            )
          )
        ),
        h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
          justSaved && h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.success, background: B.successBg, border: "1px solid " + B.successBd, padding: "5px 10px", borderRadius: "6px", transition: "opacity 0.2s" } }, "\u2713 Saved"),
          (draft.status === "accepted" || draft.status === "converted") && h("div", { style: { fontSize: "10px", color: B.warn, padding: "4px 10px", border: "1px solid " + B.warn, borderRadius: "6px" } }, "\ud83d\udd12 Locked"),
          draft.id != null && h("button", {
              onClick: generatePdf,
              disabled: generatingPdf,
              style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: generatingPdf ? B.textMut : B.textSec, fontSize: "11px", fontFamily: "inherit", cursor: generatingPdf ? "wait" : "pointer", display: "flex", alignItems: "center", gap: 5, opacity: generatingPdf ? 0.6 : 1 } },
            generatingPdf ? "\u23f3 Generating\u2026" : "\ud83d\udcc4 Generate PDF"
          ),
          // Preview the client-facing view in a new tab (?preview=1 disables
          // accept/decline so the LTP user can't accidentally finalize).
          draft.id != null && draft.shareToken && h("a", {
              href: "#/view/quote/" + draft.shareToken + "?preview=1",
              target: "_blank",
              rel: "noopener",
              style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.textSec, fontSize: "11px", fontFamily: "inherit", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, textDecoration: "none" } },
            "\ud83d\udc41 Preview"
          ),
          // ── Status action buttons ──────────────────────────────────────
          // Draft: Send Quote
          draft.status === "draft" && draft.id != null && h("button", { onClick: openQuoteSendModal,
            style: { background: B.success, border: "none", borderRadius: "6px", padding: "6px 16px", color: "#000", fontSize: "11px", fontWeight: 700, fontFamily: "inherit", cursor: "pointer" } }, "\u2709 Send Quote"),
          // Sent: Accept / Decline / Recall / Resend
          draft.status === "sent" && h("button", { onClick: acceptQuote,
            style: { background: B.info, border: "none", borderRadius: "6px", padding: "6px 14px", color: "#000", fontSize: "11px", fontWeight: 700, fontFamily: "inherit", cursor: "pointer" } }, "\u2713 Mark Accepted"),
          draft.status === "sent" && h("button", { onClick: declineQuote,
            style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.textMut, fontSize: "11px", fontFamily: "inherit", cursor: "pointer" },
            onMouseOver: function(e) { e.currentTarget.style.borderColor = B.danger; e.currentTarget.style.color = B.danger; },
            onMouseOut: function(e) { e.currentTarget.style.borderColor = B.border; e.currentTarget.style.color = B.textMut; } }, "\u2717 Decline"),
          (draft.status === "sent" || draft.status === "accepted") && h("button", { onClick: recallQuoteToDraft,
            style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.textMut, fontSize: "11px", fontFamily: "inherit", cursor: "pointer" },
            onMouseOver: function(e) { e.currentTarget.style.borderColor = B.warn; e.currentTarget.style.color = B.warn; },
            onMouseOut: function(e) { e.currentTarget.style.borderColor = B.border; e.currentTarget.style.color = B.textMut; } }, "\u21a9 Recall to Draft"),
          (draft.status === "sent" || draft.status === "accepted") && h("button", { onClick: openQuoteSendModal,
            style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.textSec, fontSize: "11px", fontFamily: "inherit", cursor: "pointer" } }, "\u2709 Resend"),
          // Declined: Reopen
          draft.status === "declined" && h("button", { onClick: function() {
            var actEntry = { id: genId("act"), date: todayISO(), time: new Date().toTimeString().substring(0, 5),
              type: "status", message: "Quote reopened from declined", user: (window.LTP_CURRENT_USER || "User"),
              changes: [{ cat: "Status", detail: "declined \u2192 draft" }] };
            var updated = Object.assign({}, draft, { status: "draft", activity: (draft.activity || []).concat([actEntry]) });
            setQuotes(function(prev) { return prev.map(function(q) { return q.id === updated.id ? updated : q; }); });
            setDraftRaw(updated); cleanRef.current = updated; setIsDirty(false);
          }, style: { background: "transparent", border: "1px solid " + B.accent, borderRadius: "6px", padding: "6px 12px", color: B.accent, fontSize: "11px", fontWeight: 600, fontFamily: "inherit", cursor: "pointer" } }, "\u21a9 Reopen as Draft"),
          // Converted: badge
          draft.status === "converted" && h("div", { style: { fontSize: "10px", color: B.success, padding: "4px 10px", border: "1px solid " + B.success, borderRadius: "6px", fontWeight: 600 } }, "CONVERTED"),
          // Mark All Delivered — only when accepted and items are undelivered
          hasUndelivered && h("button", { onClick: markAllDelivered,
            style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.textSec, fontSize: "11px", fontFamily: "inherit", cursor: "pointer", display: "flex", alignItems: "center", gap: 5 } },
            "\u2714 Mark All Delivered"
          ),
          // Send to Invoice — only when accepted and has uninvoiced delivered items
          hasUninvoiced && h("button", { onClick: sendToInvoice,
            style: { background: B.success, border: "none", borderRadius: "6px", color: "#000", cursor: "pointer", fontSize: "11px", fontWeight: 700, padding: "4px 10px", letterSpacing: "0.02em" } },
            "\u2192 Send to Invoice"),
          draft.id != null && h(window.Btn, { small: true, variant: "danger", onClick: deleteQuote }, "Delete"),
          isDirty && h(window.Btn, { small: true, variant: "ghost", onClick: discard }, "Discard"),
          isDirty && h(window.Btn, { small: true, onClick: save }, isNew || draft.id == null ? "Save Quote" : "Save Changes")
        )
      ),

      // Body: main content (left) + side panel (right)
      h("div", { style: { flex: 1, display: "flex", gap: 14, overflow: "hidden", paddingTop: 14 } },

        // ── Main scrollable content (left) ─────────────────────────────────
        h("div", { style: { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14, minWidth: 0 } },

      // Metadata card
      h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: 16 } },
        h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 12px" } }, "Quote Details"),

        // When locked — show read-only summary
        (draft.status === "accepted" || draft.status === "converted")
          ? h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 } },
              h("div", null,
                h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4 } }, "Client"),
                h("div", { style: { fontSize: "12px", color: B.text, fontWeight: 600 } },
                  selectedCompany ? selectedCompany.name :
                  draft.clientContactId ? ((contacts.find(function(c) { return c.id === draft.clientContactId; }) || {}).name || "\u2014") : "\u2014")),
              h("div", null,
                h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4 } }, "Project"),
                h("div", { style: { fontSize: "12px", color: B.text, fontWeight: 600 } }, selectedProject ? selectedProject.name : (draft.customName || "\u2014"))),
              h("div", null,
                h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4 } }, "Dates"),
                h("div", { style: { fontSize: "11px", color: B.text } },
                  quoteDates && quoteDates.start ? fmt(quoteDates.start) + " \u2192 " + fmt(quoteDates.end) : "\u2014"))
            )
          : h("div", null,
              // Client type toggle
              h("div", { style: { display: "flex", gap: 6, marginBottom: 12 } },
                h("div", { style: { fontSize: "10px", color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, alignSelf: "center", marginRight: 6 } }, "Quote To:"),
                ["company", "contact"].map(function(t) {
                  var active = draft.clientType === t;
                  return h("button", { key: t, onClick: function() {
                      if (t === "company") patchDraft({ clientType: "company", clientContactId: null });
                      else                 patchDraft({ clientType: "contact", companyId: null, projectId: null });
                    },
                    style: { background: active ? B.accent : B.raised, color: active ? "#000" : B.textMut,
                             border: "1px solid " + (active ? B.accent : B.border), borderRadius: "4px",
                             padding: "5px 14px", fontSize: "11px", fontWeight: 600, cursor: "pointer", textTransform: "capitalize" } },
                    t === "company" ? "Company" : "Individual Contact");
                })
              ),

              // Company mode
              draft.clientType === "company" && h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
                h(window.CompanySearchField, {
                  label: "Company *", compId: draft.companyId,
                  setCompId: function(id) { patchDraft({ companyId: id, clientContactId: null }); },
                  companies: companies, onClear: function() { patchDraft({ companyId: null, clientContactId: null }); }
                }),
                h(window.LTPSelect, { label: "Primary Contact",
                  value: draft.clientContactId || "",
                  onChange: function(v) { patchDraft({ clientContactId: v ? Number(v) : null }); },
                  options: [{ value: "", label: "(none)" }].concat(projectContacts.map(function(c) { return { value: c.id, label: c.firstName + " " + c.lastName + (c.role ? " \u2014 " + c.role : "") }; }))
                })
              ),

              // Contact mode
              draft.clientType === "contact" && h("div", null,
                h(window.ContactSearchField, {
                  label: "Contact *", contactId: draft.clientContactId,
                  setContactId: function(id) { patchDraft({ clientContactId: id }); },
                  contacts: contacts, placeholder: "Search all contacts..."
                })
              ),

              h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 } },
                h(window.LTPSelect, { label: "Linked Project",
                  value: draft.projectId || "",
                  onChange: function(v) {
                    var pid = v ? Number(v) : null;
                    if (pid && draft.companyId) {
                      var proj = projects.find(function(p) { return p.id === pid; });
                      if (proj && proj.companyId && proj.companyId !== draft.companyId) {
                        var projComp = companies.find(function(c) { return c.id === proj.companyId; });
                        var quoteComp = companies.find(function(c) { return c.id === draft.companyId; });
                        showAlert("Company Mismatch", "This project belongs to " + (projComp ? projComp.name : "a different company") + " but this quote is for " + (quoteComp ? quoteComp.name : "another company") + ". You may want to update the company.");
                      }
                    }
                    patchDraft({ projectId: pid });
                  },
                  options: [{ value: "", label: "(no project \u2014 use custom name)" }].concat(
                    (draft.clientType === "company" && draft.companyId ? projects.filter(function(p) { return p.companyId === draft.companyId; }) : projects)
                      .filter(function(p) { return p.status !== "completed"; })
                      .map(function(p) { return { value: p.id, label: p.name + " \u00b7 " + fmt(p.startDate) }; })
                  )
                }),
                !draft.projectId && h(window.LTPInput, {
                  label: "Custom Quote Name", value: draft.customName,
                  onChange: function(v) { patchDraft({ customName: v }); },
                  placeholder: "e.g. Fall Gala Equipment Package"
                })
              ),
              !draft.projectId && h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 } },
                h(window.LTPInput, { label: "Start Date", value: draft.customStartDate, onChange: function(v) { patchDraft({ customStartDate: v }); }, type: "date" }),
                h(window.LTPInput, { label: "End Date",   value: draft.customEndDate,   onChange: function(v) { patchDraft({ customEndDate: v   }); }, type: "date" })
              ),
              draft.projectId && selectedProject && h("div", { style: { marginTop: 10, padding: "8px 12px", background: B.raised, borderRadius: "6px", fontSize: "11px", color: B.textMut } },
                "Project dates: " + fmt(selectedProject.startDate) + " \u2192 " + fmt(selectedProject.endDate) + " \u00b7 rental pricing will use this period."
              )
            )
      ),

      // Sections
      h("div", null,
        draft.sections.map(function(sec) {
          var t = sectionTotals(sec);
          // Per-section effective dates (for availability checks in the picker)
          var secDates = sec.customDates && sec.startDate && sec.endDate
            ? { start: sec.startDate, end: sec.endDate }
            : quoteDates;
          return h(SectionBlock, { key: sec.id, section: sec,
            quoteDates: quoteDates, quoteStatus: draft.status,
            sectionSubtotal: t.subtotal, sectionMargin: t.margin,
            services: services,
            onLabelChange: function(sid, v) { updateSection(sid, { label: v }); },
            onUpdate: updateSection,
            onDelete: deleteSection,
            onAddItem: function(sid) { setPickerForSection(sid); },
            onItemUpdate: updateItem,
            onItemDelete: deleteItem,
            onItemDragStart: onItemDragStart,
            onItemDrop: onItemDrop,
            onSectionDragStart: onSectionDragStart,
            onSectionDragOver: function() {},
            onSectionDrop: onSectionDrop,
          });
        }),
        !(draft.status === "accepted" || draft.status === "converted") && h("button", { onClick: addSection,
          style: { background: "transparent", border: "1px dashed " + B.border, color: B.textMut, cursor: "pointer", fontSize: "12px", fontWeight: 600, padding: "12px", borderRadius: "8px", width: "100%" } }, "+ Add Section")
      ),

      // Totals
      h(TotalsPanel, { draft: draft, isLocked: draft.status === "accepted" || draft.status === "converted", onDiscountChange: function(gd) { patchDraft({ globalDiscount: gd }); } })

      ), // end main scrollable content

        // ── Side Panel (right) ─────────────────────────────────────────────
        h("div", { style: { width: 280, flexShrink: 0, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto" } },

          // QUOTE SUMMARY (top)
          h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: 14 } },
            h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 10px" } }, "Quote Summary"),

            // Section breakdown
            draft.sections.map(function(sec) {
              var st = sectionTotals(sec);
              var itemCount = sec.items.filter(function(i) { return i.type !== "note"; }).length;
              return h("div", { key: sec.id, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid " + B.border } },
                h("div", null,
                  h("div", { style: { fontSize: "11px", fontWeight: 600, color: B.text } }, sec.label),
                  h("div", { style: { fontSize: "9px", color: B.textMut } }, itemCount + " items")
                ),
                h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.accent, textAlign: "right" } }, "$" + Math.round(st.subtotal).toLocaleString())
              );
            }),

            // Totals summary
            function() {
              var t = window.LTP_QUOTE_TOTALS(draft);
              var marginTotal = t.total - t.cost;
              var marginPct = t.total > 0 ? Math.round((marginTotal / t.total) * 100) : 0;
              return h("div", { style: { marginTop: 8 } },
                t.subtotal !== t.adjusted && h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "10px", color: B.textMut, padding: "2px 0" } },
                  h("span", null, "Adjustments"),
                  h("span", null, "-$" + Math.round(t.subtotal - t.adjusted).toLocaleString())
                ),
                draft.globalDiscount && draft.globalDiscount.type !== "none" && h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "10px", color: B.textMut, padding: "2px 0" } },
                  h("span", null, "Discount"),
                  h("span", null, "-$" + Math.round(t.adjusted - (t.preTax || t.total)).toLocaleString())
                ),
                t.taxAmount > 0 && h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "10px", color: B.textMut, padding: "2px 0" } },
                  h("span", null, "Tax (" + t.taxRate + "%)"),
                  h("span", null, "$" + Math.round(t.taxAmount).toLocaleString())
                ),
                h("div", { style: { display: "flex", justifyContent: "space-between", padding: "6px 0 4px", borderTop: "2px solid " + B.accent, marginTop: 4 } },
                  h("span", { style: { fontSize: "13px", fontWeight: 700, color: B.text } }, "Total"),
                  h("span", { style: { fontSize: "14px", fontWeight: 700, color: B.accent } }, "$" + Math.round(t.total).toLocaleString())
                ),
                h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "10px", color: B.textMut, padding: "2px 0", borderTop: "1px dashed " + B.border, marginTop: 2 } },
                  h("span", null, "Margin"),
                  h("span", { style: { color: marginPct >= 40 ? B.success : marginPct >= 20 ? B.warn : B.danger, fontWeight: 700 } }, "$" + Math.round(marginTotal).toLocaleString() + " (" + marginPct + "%)")
                )
              );
            }()
          ),

          // NOTES (middle)
          h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: 14 } },
            h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 8px" } }, "Internal Notes"),
            h("textarea", { value: draft.notes || "", onChange: function(e) { patchDraft({ notes: e.target.value }); },
              placeholder: "Add internal notes about this quote...",
              style: { width: "100%", background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", resize: "vertical", minHeight: 60 } })
          ),

          // LINKED INVOICES (only when accepted/converted and invoices exist)
          function() {
            var linked = draft.id != null ? (invoices || []).filter(function(inv) { return inv.quoteId === draft.id; }) : [];
            if (linked.length === 0) return null;
            return h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: 14 } },
              h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 8px" } }, "Linked Invoices (" + linked.length + ")"),
              h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                linked.map(function(inv) {
                  var ref = window.LTP_INVOICE_REF(inv);
                  var it = window.LTP_INVOICE_TOTALS(inv);
                  return h("div", { key: inv.id,
                    onClick: function() { nav("invoices/" + inv.id); },
                    style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", background: B.raised, borderRadius: "4px", cursor: "pointer", border: "1px solid " + B.border },
                    onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent + "44"; },
                    onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; } },
                    h("div", null,
                      h("div", { style: { fontSize: "11px", fontWeight: 600, color: B.accent } }, ref),
                      h("div", { style: { fontSize: "9px", color: B.textMut } }, inv.dueDate ? "Due: " + fmt(inv.dueDate) : "No due date")
                    ),
                    h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                      h("span", { style: { fontSize: "11px", fontWeight: 700, color: B.text } }, "$" + Math.round(it.total).toLocaleString()),
                      h(window.Badge, { status: inv.status })
                    )
                  );
                })
              )
            );
          }(),

          // ACTIVITY LOG (bottom)
          h("div", { style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: 14, flex: 1, display: "flex", flexDirection: "column", minHeight: 120 } },
            h("h4", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 8px" } }, "Activity"),
            h("div", { style: { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 0 } },
              (draft.activity || []).slice().reverse().map(function(a) {
                var typeColors = { created: B.info, saved: B.success, status: B.warn, viewed: B.accent, adjusted: B.textSec, sent: B.accent, accepted: B.success, declined: B.danger, invoiced: B.warn, pdf_generated: B.accent, client_accepted: B.success, client_declined: B.danger,
                  // Email + view-tracking types (commits 2 + 3)
                  email_sent: B.accent, email_failed: B.danger,
                  recipient_opened: B.info, recipient_downloaded_pdf: B.info,
                  client_viewed: B.textMut, client_downloaded_pdf: B.textMut };
                var tc = typeColors[a.type] || B.textMut;
                var hasChanges = a.changes && a.changes.length > 0;
                var isPdf = a.type === "pdf_generated" && a.pdfToken;
                var isClientAction = (a.type === "client_accepted" || a.type === "client_declined");
                // PDF entries get a click-to-download instead of details-modal behavior
                var rowOnClick = isPdf
                  ? undefined  // the inner link handles its own click
                  : (hasChanges ? function() { setViewActivity(a); } : undefined);
                var rowClickable = isPdf || hasChanges;
                return h("div", { key: a.id,
                  onClick: rowOnClick,
                  style: { padding: "6px 0", borderBottom: "1px solid " + B.border, display: "flex", gap: 8, cursor: rowClickable && !isPdf ? "pointer" : "default", borderRadius: "3px" },
                  onMouseOver: rowClickable ? function(e) { e.currentTarget.style.background = B.raised; } : undefined,
                  onMouseOut: rowClickable ? function(e) { e.currentTarget.style.background = "transparent"; } : undefined },
                  h("div", { style: { width: 6, borderRadius: "3px", background: tc, flexShrink: 0, marginTop: 2 } }),
                  h("div", { style: { flex: 1, minWidth: 0 } },
                    h("div", { style: { fontSize: "11px", color: B.text, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 } },
                      a.message,
                      hasChanges && h("span", { style: { fontSize: "9px", color: B.accent, fontWeight: 600 } }, "\u25b8 details"),
                      isPdf && h("a", {
                        href: "/pdf/" + a.pdfToken,
                        download: a.pdfFilename || "quote.pdf",
                        onClick: function(e) { e.stopPropagation(); },
                        style: { fontSize: "10px", color: B.accent, fontWeight: 600, textDecoration: "none", border: "1px solid " + B.accent, borderRadius: "4px", padding: "1px 6px" }
                      }, "\u2193 Download"),
                      // Client accepted/declined entries: surface the comment
                      // (if any) and a "View signature" link (accept-only) that
                      // opens the signature in a tiny popup window.
                      isClientAction && a.signatureDataUrl && h("button", {
                        type: "button",
                        onClick: function(e) {
                          e.stopPropagation();
                          var w = window.open("", "_blank", "width=420,height=240");
                          if (w) {
                            w.document.write('<title>Signature \u2014 ' + (a.user || "client") + '</title><body style="margin:0;background:#fff;display:flex;align-items:center;justify-content:center;height:100vh"><img src="' + a.signatureDataUrl + '" alt="signature" style="max-width:100%;max-height:100%"></body>');
                          }
                        },
                        style: { fontSize: "10px", color: B.accent, fontWeight: 600, background: "transparent", border: "1px solid " + B.accent, borderRadius: "4px", padding: "1px 6px", cursor: "pointer", fontFamily: "inherit" }
                      }, "View signature")
                    ),
                    isClientAction && a.comment && h("div", { style: { fontSize: "10px", color: B.textSec, fontStyle: "italic", marginTop: 2 } }, "\u201c" + a.comment + "\u201d"),
                    h("div", { style: { fontSize: "9px", color: B.textMut } },
                      (a.user || "") + (a.user && a.date ? " \u00b7 " : "") + (a.date ? window.LTP_formatDate(a.date) : "") + (a.time ? " " + window.LTP_formatTime(a.time) : ""))
                  )
                );
              }),
              (draft.activity || []).length === 0 && h("div", { style: { fontSize: "11px", color: B.textMut, fontStyle: "italic", padding: "12px 0", textAlign: "center" } }, "No activity yet.")
            )
          )
        )
      ), // end body flex row

      // Modals (outside layout — overlays)
      pickerForSection && function() {
        var pickerSec = draft.sections.find(function(s) { return s.id === pickerForSection; });
        var pickerDates = pickerSec && pickerSec.customDates && pickerSec.startDate && pickerSec.endDate
          ? { start: pickerSec.startDate, end: pickerSec.endDate }
          : quoteDates;
        return h(AddItemPicker, {
          sectionId: pickerForSection,
          sectionLabel: (pickerSec || {}).label || "",
          sectionItems: pickerSec ? pickerSec.items : [],
          allSections: draft.sections,
          equipment: equipment, products: products, services: services,
          allocations: allocations,
          quoteDates: pickerDates,
          onAdd: function(item) { addItemToSection(pickerForSection, item); },
          onClose: function() { setPickerForSection(null); }
        });
      }(),

      // Generic confirm / alert dialog
      dlg && h(window.LTPConfirmDialog, { dlg: dlg, onCancel: function() { setDlg(null); } }),

      // Activity detail popup
      viewActivity && h(window.LTPModal, { title: viewActivity.message, onClose: function() { setViewActivity(null); } },
        h("div", { style: { marginBottom: 10, fontSize: "11px", color: B.textMut } },
          (viewActivity.user || "") + " \u00b7 " + (viewActivity.date ? window.LTP_formatDate(viewActivity.date) : "") + (viewActivity.time ? " " + window.LTP_formatTime(viewActivity.time) : "")
        ),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 0 } },
          (viewActivity.changes || []).map(function(ch, i) {
            return h("div", { key: i, style: { display: "flex", gap: 10, padding: "7px 0", borderBottom: "1px solid " + B.border } },
              h("div", { style: { width: 140, flexShrink: 0, fontSize: "11px", fontWeight: 600, color: B.accent } }, ch.cat),
              h("div", { style: { flex: 1, fontSize: "11px", color: B.textSec } }, ch.detail)
            );
          })
        ),
        (viewActivity.changes || []).length === 0 && h("div", { style: { fontSize: "12px", color: B.textMut, fontStyle: "italic", padding: 16, textAlign: "center" } }, "No detailed changes recorded.")
      ),

      // Invoice target picker
      invPickerData && h(window.LTPModal, { title: "Send to Invoice", onClose: function() { setInvPickerData(null); } },
        h("p", { style: { fontSize: "12px", color: B.textMut, marginBottom: 14 } },
          "Choose an existing draft invoice or create a new one."),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 } },
          (function() {
            var projectInvDrafts = invoices.filter(function(inv) {
              return inv.status === "draft" && inv.projectId === draft.projectId && inv.projectId;
            });
            return projectInvDrafts.length > 0
              ? projectInvDrafts.map(function(inv) {
                  var ref = window.LTP_INVOICE_REF(inv);
                  var itemCount = (inv.sections || []).reduce(function(n, s) { return n + (s.items || []).filter(function(i) { return i.type !== "note"; }).length; }, 0);
                  var total = window.LTP_INVOICE_TOTALS(inv);
                  return h("button", { key: inv.id, onClick: function() { executeSendToInvoice(inv.id); },
                    style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "6px", padding: "10px 14px", cursor: "pointer", textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center" },
                    onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent; },
                    onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; } },
                    h("div", null,
                      h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text } }, ref),
                      h("div", { style: { fontSize: "10px", color: B.textMut } }, itemCount + " item" + (itemCount !== 1 ? "s" : "") + " \u00b7 " + window.LTP_formatDate(inv.invoiceDate))),
                    h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.accent } }, "$" + (total.total || 0).toLocaleString())
                  );
                })
              : [h("div", { key: "_empty", style: { fontSize: "11px", color: B.textMut, fontStyle: "italic", padding: "8px 0" } }, "No existing draft invoices for this project.")];
          })()
        ),
        h(window.Btn, { onClick: function() { executeSendToInvoice(null); } }, "+ Create New Invoice")
      ),

      // Send Quote modal
      showSendModal && h(window.LTPModal, { title: draft.status === "draft" ? "Send Quote" : "Resend Quote", onClose: function() { setShowSendModal(false); }, wide: true },
        h("div", { style: { display: "flex", gap: 16, minHeight: 380 } },
          // Left: Quote preview
          h("div", { style: { width: 260, flexShrink: 0, background: B.raised, border: "1px solid " + B.border, borderRadius: "8px", padding: 16, display: "flex", flexDirection: "column" } },
            h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 } }, "Quote Preview"),
            h("div", { style: { fontSize: "16px", fontWeight: 700, color: B.accent, marginBottom: 4 } }, refDisplay),
            h("div", { style: { fontSize: "11px", color: B.textSec, marginBottom: 2 } }, displayName),
            selectedCompany && h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 10 } }, selectedCompany.name),
            h("div", { style: { borderTop: "1px solid " + B.border, paddingTop: 8, flex: 1 } },
              draft.sections.map(function(sec) {
                var cnt = sec.items.filter(function(i) { return i.type !== "note"; }).length;
                return h("div", { key: sec.id, style: { display: "flex", justifyContent: "space-between", fontSize: "10px", padding: "3px 0" } },
                  h("span", { style: { color: B.textMut } }, sec.label + " (" + cnt + ")"),
                  h("span", { style: { color: B.text } }, "$" + Math.round(sec.items.reduce(function(s, i) { return s + ((i.adjustedPrice != null ? i.adjustedPrice : i.unitPrice) || 0) * ((Number(i.qty) || 0)); }, 0)).toLocaleString()));
              }),
              h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "14px", fontWeight: 700, paddingTop: 8, borderTop: "1px solid " + B.border, marginTop: 6 } },
                h("span", { style: { color: B.text } }, "Total"),
                h("span", { style: { color: B.accent } }, "$" + Math.round((window.LTP_QUOTE_TOTALS(draft) || {}).total || 0).toLocaleString()))
            )
          ),
          // Right: Email preview
          h("div", { style: { flex: 1, background: B.bg, border: "1px solid " + B.border, borderRadius: "8px", display: "flex", flexDirection: "column", overflow: "hidden" } },
            h("div", { style: { padding: "10px 14px", borderBottom: "1px solid " + B.border, background: B.surface } },
              h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 } }, "Email Preview"),
              // From: read-only \u2014 the recipient sees the signed-in LTP user's
              // Google identity. Surfacing this here removes the "who's it
              // actually from?" surprise some users get with multi-account apps.
              h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 5 } },
                h("span", { style: { fontSize: "10px", color: B.textMut, width: 35 } }, "From:"),
                h("span", { style: { fontSize: "11px", color: B.text } },
                  (window.LTP_SENDER_NAME || "") + (window.LTP_SENDER_EMAIL ? " <" + window.LTP_SENDER_EMAIL + ">" : ""))),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 5 } },
                h("span", { style: { fontSize: "10px", color: B.textMut, width: 35 } }, "To:"),
                h("input", { value: sendEmail, onChange: function(e) { setSendEmail(e.target.value); },
                  style: { flex: 1, background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 8px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none" }, placeholder: "client@example.com" })),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 5 } },
                h("span", { style: { fontSize: "10px", color: B.textMut, width: 35 } }, "CC:"),
                h("input", { value: sendCc, onChange: function(e) { setSendCc(e.target.value); },
                  style: { flex: 1, background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 8px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none" }, placeholder: "comma-separated (optional)" })),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                h("span", { style: { fontSize: "10px", color: B.textMut, width: 35 } }, "Subj:"),
                h("input", { value: sendSubject, onChange: function(e) { setSendSubject(e.target.value); },
                  style: { flex: 1, background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 8px", color: B.text, fontSize: "11px", fontWeight: 600, fontFamily: "inherit", outline: "none" } }))),
            // Reconnect banner \u2014 surfaced inside the modal so the user sees
            // it AT the moment they're trying to send rather than at app load.
            !window.LTP_GMAIL_CONNECTED && h("div", { style: { padding: "8px 14px", background: B.warn + "11", borderBottom: "1px solid " + B.warn + "44", fontSize: "11px", color: B.warn } },
              "\u26a0 Gmail isn't connected for your account. Sign out and back in with Google to grant the gmail.send permission."),
            // WYSIWYG body editor — replaces the prior split-pane.
            // User sees the rendered email and edits text inline; the
            // signature block is rendered + locked (contenteditable="false"
            // applied inside EmailBodyEditor), {{viewUrl}} lives in href
            // attributes invisibly. HTML editing happens in the template
            // editor in Settings, not at send time.
            //
            // sendMessage state still carries placeholders intact —
            // EmailBodyEditor extracts the editable HTML and reverses
            // the signature substitution on every input, so what we
            // POST to /api/email/send still has {{signature}} for the
            // backend to render per-user.
            h(window.EmailBodyEditor, {
              value: sendMessage,
              signatureTemplate: ((settings || {}).emailSignatureTemplate || (window.LTP_DATA_SETTINGS || {}).emailSignatureTemplate),
              headerTemplate: ((settings || {}).emailHeaderTemplate || (window.LTP_DATA_SETTINGS || {}).emailHeaderTemplate),
              headerVars: sendHeaderVars,
              onChange: setSendMessage,
              minHeight: 240,
            })
          )
        ),
        h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14, paddingTop: 14, borderTop: "1px solid " + B.border } },
          h(window.Btn, { variant: "ghost", onClick: function() { setShowSendModal(false); } }, "Cancel"),
          h(window.Btn, {
            onClick: executeSendQuote,
            disabled: sending || !window.LTP_GMAIL_CONNECTED,
          }, sending ? "Sending\u2026" : (draft.status === "draft" ? "\u2709 Send Quote" : "\u2709 Resend")))
      )
    );
  };
})();
