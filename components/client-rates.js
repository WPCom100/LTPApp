// ═══════════════════════════════════════════════════════════════════════════
//   CLIENT SERVICE RATES — per-client overrides of the labor rate card
// ═══════════════════════════════════════════════════════════════════════════
//
// One client negotiates a different rate for SPECIFIC roles — "A1 for FUMC is a
// reduced day rate, but carries a full 10-hour day minimum". Each override is
// added per service, never toggled on for the whole catalog: a role with no row
// bills the base card exactly as before.
//
// This file owns the EDITOR (window.ClientRatesEditor) plus the small chip
// (window.ClientRateChip) that marks an overridden rate everywhere it surfaces —
// schedule editor, quote builder, invoice editor.
//
// Resolution lives in theme.js (LTP_servicesForClient / LTP_applyClientRate) and
// the minimum-hours math in LTP_calcDayLabor. Nothing here does pricing.
(function() {
  var B = window.LTP_THEME, h = React.createElement, useState = React.useState;

  var TIERS = [
    { rate: "dayRate",    cost: "dayCost",     label: "Day" },
    { rate: "halfDay",    cost: "halfDayCost", label: "Half Day" },
    { rate: "hourlyRate", cost: "hourlyCost",  label: "Hourly" },
    { rate: "otRate",     cost: "otCost",      label: "Overtime" },
  ];

  // A blank field means "inherit the base card" — distinct from a typed 0.
  function toNum(v) {
    if (v === "" || v === null || v === undefined) return null;
    var n = Number(v);
    return isFinite(n) && n >= 0 ? n : null;
  }
  function fromNum(v) { return (v === null || v === undefined) ? "" : String(v); }
  function money(n) { return "$" + (Math.round(Number(n) * 100) / 100).toLocaleString(); }

  // What the client actually pays for a tier once the override resolves —
  // used for the inherited-value placeholders and the list row summary.
  function effective(svc, row) {
    var resolved = row ? window.LTP_applyClientRate(svc, row) : svc;
    return window.LTP_serviceRateMaps(resolved);
  }

  // ── Chip: "this price came from a client rate" ────────────────────────────
  // `svc` is a RESOLVED service (theme.js::LTP_servicesForClient); it carries
  // `clientRate` only when an override applied. Renders nothing otherwise, so
  // call sites can drop it in unconditionally.
  window.ClientRateChip = function({ svc, tiny, title }) {
    if (!svc || !svc.clientRate) return null;
    var bits = [];
    if (svc.clientRate.label) bits.push(svc.clientRate.label);
    if (svc.minHours > 0) bits.push(svc.minHours + "h billing minimum");
    if (svc.minCostHours > 0) bits.push(svc.minCostHours + "h payout minimum");
    return h("span", {
      title: title || ("Client rate" + (bits.length ? " — " + bits.join(" · ") : "") + ". Negotiated for this client; edit under CRM → the client → Service Rates."),
      style: { display: "inline-flex", alignItems: "center", gap: 3, background: B.info + "1c", border: "1px solid " + B.info + "55",
               color: B.info, borderRadius: "3px", padding: tiny ? "0 3px" : "1px 5px", fontSize: tiny ? "8px" : "9px",
               fontWeight: 700, whiteSpace: "nowrap", cursor: "help" } },
      "CLIENT RATE", svc.minHours > 0 && h("span", { style: { fontWeight: 600, opacity: 0.85 } }, "· " + svc.minHours + "h min"));
  };

  // ── Add / edit form ───────────────────────────────────────────────────────
  function RateForm({ initial, services, taken, onSave, onCancel, onDelete }) {
    // The row this form is editing can change in another window while it sits
    // open. Field state was seeded when it opened and cannot be safely
    // re-seeded underneath the user, so say so rather than let Save quietly
    // overwrite the newer version. See theme.js::LTP_useRecordWatch.
    window.LTP_useRecordWatch("client-rates", initial && initial.id,
      { title: "This client rate changed elsewhere",
        message: "Another window updated it while this form was open. Saving will replace the newer version." });
    var isMobile = window.LTP_useIsMobile();
    var [serviceId, setServiceId] = useState(initial ? initial.serviceId : "");
    var [label, setLabel]   = useState(initial ? (initial.label || "") : "");
    var [notes, setNotes]   = useState(initial ? (initial.notes || "") : "");
    var [active, setActive] = useState(initial ? initial.active !== false : true);
    var [minHours, setMinHours] = useState(initial ? fromNum(initial.minHours) : "");
    var [minCostHours, setMinCostHours] = useState(initial ? fromNum(initial.minCostHours) : "");
    // One piece of state per rate/cost cell, keyed "dayRate" / "dayCost" / …
    var [vals, setVals] = useState(function() {
      var v = {};
      TIERS.forEach(function(t) {
        v[t.rate] = initial ? fromNum(initial[t.rate]) : "";
        v[t.cost] = initial ? fromNum(initial[t.cost]) : "";
      });
      return v;
    });
    function setVal(k, x) { setVals(function(prev) { var n = Object.assign({}, prev); n[k] = x; return n; }); }

    var svc = (services || []).find(function(s) { return s.id === serviceId; }) || null;
    // Preview: the card as it will resolve, so the placeholders show what the
    // client would pay for a tier left blank.
    var preview = svc ? effective(svc, {
      dayRate: toNum(vals.dayRate), halfDay: toNum(vals.halfDay), hourlyRate: toNum(vals.hourlyRate), otRate: toNum(vals.otRate),
      dayCost: toNum(vals.dayCost), halfDayCost: toNum(vals.halfDayCost), hourlyCost: toNum(vals.hourlyCost), otCost: toNum(vals.otCost),
    }) : null;
    var TIER_KEY = { dayRate: "day", halfDay: "half", hourlyRate: "hourly", otRate: "ot" };

    var effDay = preview ? preview.priceMap.day : 0;
    var effDayCost = preview ? preview.costMap.day : 0;
    var margin = effDay > 0 ? Math.round(((effDay - effDayCost) / effDay) * 100) : 0;

    // Only roles that don't already have a row for this client (plus the one
    // being edited) — a second row for the same service would be ambiguous.
    var options = [{ value: "", label: "Select a role…" }].concat(
      (services || []).filter(function(s) { return !taken[s.id] || s.id === serviceId; })
        .map(function(s) { return { value: s.id, label: s.role, sublabel: s.description + " · " + money(s.dayRate || 0) + "/day" }; }));

    function submit() {
      if (serviceId === "" || serviceId == null) return;
      var out = {
        serviceId: Number(serviceId), label: label.trim(), notes: notes, active: !!active,
        minHours: toNum(minHours) || 0, minCostHours: toNum(minCostHours) || 0,
      };
      TIERS.forEach(function(t) { out[t.rate] = toNum(vals[t.rate]); out[t.cost] = toNum(vals[t.cost]); });
      onSave(out);
    }

    var cell = { display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "90px 1fr 1fr", gap: 8, alignItems: "end" };

    return h("div", { style: { background: B.raised, border: "1px solid " + B.accent + "44", borderRadius: "8px", padding: 14, marginBottom: 12 } },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
        h("div", { style: { display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 10 } },
          h("div", null,
            h("div", { style: { fontSize: "11px", fontWeight: 600, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 } }, "Role *"),
            h(window.LTPSearchSelect, {
              value: serviceId, onChange: function(v) { setServiceId(v === "" ? "" : Number(v)); },
              options: options, searchPlaceholder: "Search roles…", disabled: !!initial, panelMinWidth: 260 })),
          h(window.LTPInput, { label: "Contract Label", value: label, onChange: setLabel, placeholder: "e.g. FUMC A1 agreement" })
        ),

        // Rate / cost grid. A blank cell inherits the base card — the
        // placeholder shows what that inherited value resolves to.
        h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
          h("div", { style: { display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "90px 1fr 1fr", gap: 8 } },
            !isMobile && h("div", null),
            h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, "Client Rate"),
            h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, "Crew Pay (margin)")
          ),
          TIERS.map(function(t) {
            // The placeholder is what the BLANK field actually resolves to right
            // now — which follows an overridden day rate (set Day to 800 and the
            // blank half-day reads 400, not the base card's 500). Anything else
            // would advertise a price the line would never be billed at.
            var k = TIER_KEY[t.rate];
            var basePrice = preview ? Math.round(preview.priceMap[k] * 100) / 100 : 0;
            var baseCost  = preview ? Math.round(preview.costMap[k] * 100) / 100 : 0;
            return h("div", { key: t.rate, style: cell },
              !isMobile && h("div", { style: { fontSize: "11px", color: B.textSec, fontWeight: 600, paddingBottom: 9 } }, t.label),
              h(window.LTPInput, { label: isMobile ? t.label + " rate" : null, value: vals[t.rate], onChange: function(v) { setVal(t.rate, v); },
                type: "number", inputMode: "decimal", step: "0.01", placeholder: svc ? String(basePrice) : "inherit" }),
              h(window.LTPInput, { label: isMobile ? t.label + " pay" : null, value: vals[t.cost], onChange: function(v) { setVal(t.cost, v); },
                type: "number", inputMode: "decimal", step: "0.01", placeholder: svc ? String(baseCost) : "inherit" })
            );
          }),
          h("div", { style: { fontSize: "10px", color: B.textMut, lineHeight: 1.5 } },
            "Leave a field blank to inherit the base rate card. Set only the Day row and the half / hourly / overtime tiers derive from it (÷2, ÷10, ÷10×1.5) — exactly like the base card.")
        ),

        // Minimum charges — the second half of the feature.
        h("div", { style: { borderTop: "1px solid " + B.border, paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 } },
          h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, "Minimum Charge"),
          h("div", { style: { display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 2fr", gap: 8, alignItems: "end" } },
            h(window.LTPInput, { label: "Bill Min (hrs)", value: minHours, onChange: setMinHours, type: "number", inputMode: "decimal", step: "0.5", placeholder: "0" }),
            h(window.LTPInput, { label: "Pay Min (hrs)", value: minCostHours, onChange: setMinCostHours, type: "number", inputMode: "decimal", step: "0.5", placeholder: "0" }),
            !isMobile && h("div", { style: { fontSize: "10px", color: B.textMut, lineHeight: 1.5, paddingBottom: 6 } },
              "A day bills (or pays) as if at least this many hours were worked — a 4-hour call on a 10-hour minimum bills the full day rate, not the half day. Meal-penalty hours still add on top. 0 = no minimum.")
          ),
          isMobile && h("div", { style: { fontSize: "10px", color: B.textMut, lineHeight: 1.5 } },
            "A day bills (or pays) as if at least this many hours were worked. 0 = no minimum.")
        ),

        // Live resolution summary so the negotiated numbers are legible before saving.
        svc && h("div", { style: { background: B.bg, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px 10px", display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", fontSize: "11px" } },
          h("span", { style: { color: B.textMut } }, "Resolves to:"),
          h("span", { style: { color: B.accent, fontWeight: 700 } }, money(effDay) + "/day"),
          h("span", { style: { color: B.textMut } }, "half " + money(preview.priceMap.half)),
          h("span", { style: { color: B.textMut } }, "OT " + money(preview.priceMap.ot) + "/h"),
          h("span", { style: { color: B.textSec } }, "pay " + money(effDayCost)),
          h("span", { style: { fontWeight: 700, color: margin >= 30 ? B.success : margin >= 15 ? B.warn : B.danger } }, margin + "% margin"),
          (toNum(minHours) > 0) && h("span", { style: { color: B.info, fontWeight: 700 } }, toNum(minHours) + "h bill min"),
          (toNum(minCostHours) > 0) && h("span", { style: { color: B.info, fontWeight: 700 } }, toNum(minCostHours) + "h pay min")
        ),

        h(window.LTPInput, { label: "Notes", value: notes, onChange: setNotes, placeholder: "Contract reference, term dates, who agreed it…" }),

        h("div", { style: { display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" } },
          h("button", { onClick: function() { setActive(!active); },
            style: { background: active ? B.accent : B.raised, color: active ? B.btnInk : B.textMut, border: "1px solid " + (active ? B.accent : B.border),
                     borderRadius: "4px", padding: "4px 14px", fontSize: "11px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" } },
            active ? "Active" : "Paused"),
          h("div", { style: { display: "flex", gap: 8 } },
            initial && h(window.Btn, { small: true, variant: "danger", onClick: onDelete }, "Delete"),
            h(window.Btn, { small: true, variant: "ghost", onClick: onCancel }, "Cancel"),
            h(window.Btn, { small: true, onClick: submit }, initial ? "Save Rate" : "Add Rate")
          )
        )
      )
    );
  }

  // ── Editor ────────────────────────────────────────────────────────────────
  // Drops into any surface that already knows WHICH client is selected: the CRM
  // company detail, and the Quotes → Client Rates tab (which adds the picker).
  //
  //   clientType   "company" | "contact"
  //   companyId / clientContactId   whichever the type names
  //   clientName   for the empty state + confirm copy
  window.ClientRatesEditor = function({ clientType, companyId, clientContactId, clientName, services, clientRates, setClientRates }) {
    var isMobile = window.LTP_useIsMobile();
    var [editingId, setEditingId] = useState(null);
    var [showAdd, setShowAdd] = useState(false);
    var [dlg, setDlg] = useState(null);

    var ref = window.LTP_clientRef({ clientType: clientType, companyId: companyId, clientContactId: clientContactId });
    var rows = (clientRates || []).filter(function(r) {
      // Inactive rows are shown here (this IS their editor) but excluded by the
      // resolver — so match on identity, not LTP_clientRateMatches.
      if (!ref || r.serviceId == null) return false;
      return ref.clientType === "contact"
        ? (r.clientType === "contact" && r.clientContactId === ref.clientContactId)
        : (r.clientType !== "contact" && r.companyId === ref.companyId);
    });
    var svcById = {}; (services || []).forEach(function(s) { svcById[s.id] = s; });
    rows = rows.slice().sort(function(a, b) {
      var ra = (svcById[a.serviceId] || {}).role || "", rb = (svcById[b.serviceId] || {}).role || "";
      return ra.localeCompare(rb);
    });
    var taken = {}; rows.forEach(function(r) { taken[r.serviceId] = true; });

    function addRate(d) {
      if (!ref) return;
      var newId = Math.max.apply(null, (clientRates || []).map(function(r) { return r.id; }).concat([0])) + 1;
      var row = Object.assign({
        id: newId, clientType: ref.clientType,
        companyId: ref.companyId, clientContactId: ref.clientContactId,
      }, d);
      setClientRates(function(prev) { return (prev || []).concat([row]); });
      setShowAdd(false);
    }
    function updateRate(id, d) {
      setClientRates(function(prev) { return (prev || []).map(function(r) { return r.id === id ? Object.assign({}, r, d) : r; }); });
      setEditingId(null);
    }
    function deleteRate(id) {
      var r = rows.find(function(x) { return x.id === id; });
      var svc = r ? svcById[r.serviceId] : null;
      setDlg({
        title: "Delete Client Rate",
        message: "Remove the negotiated rate for " + (svc ? svc.role + " — " + svc.description : "this role")
          + (clientName ? " with " + clientName : "") + "? Future schedules, quotes, and invoices go back to the base rate card — "
          + "lines already priced and pay already locked keep their saved amounts.",
        variant: "danger",
        confirmLabel: "Delete",
        onConfirm: function() {
          setClientRates(function(prev) { return (prev || []).filter(function(x) { return x.id !== id; }); });
          setEditingId(null); setDlg(null);
        },
      });
    }

    return h("div", null,
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" } },
        h("div", { style: { fontSize: "10px", color: B.textMut, lineHeight: 1.5, flex: 1, minWidth: 200 } },
          "Negotiated rates for specific roles. Everything not listed bills the base rate card."),
        h(window.Btn, { small: true, disabled: !ref, onClick: function() { setShowAdd(true); setEditingId(null); } }, "+ Add Rate")
      ),

      showAdd && h(RateForm, { initial: null, services: services, taken: taken,
        onSave: addRate, onCancel: function() { setShowAdd(false); } }),

      h(window.LTPList, null,
        rows.length === 0 && !showAdd && h("div", { style: { padding: "18px", textAlign: "center", color: B.textMut, fontSize: "12px", fontStyle: "italic" } },
          "No negotiated rates" + (clientName ? " for " + clientName : "") + " — every role bills the base card."),
        rows.map(function(r) {
          var svc = svcById[r.serviceId];
          if (editingId === r.id) {
            return h(RateForm, { key: r.id, initial: r, services: services, taken: taken,
              onSave: function(d) { updateRate(r.id, d); },
              onCancel: function() { setEditingId(null); },
              onDelete: function() { deleteRate(r.id); } });
          }
          if (!svc) {
            // The service was deleted out from under the override (FK CASCADE
            // clears it server-side; this covers the in-session window).
            return h(window.LTPRow, { key: r.id, onClick: function() { deleteRate(r.id); }, style: { display: "flex", gap: 10, alignItems: "center" } },
              h("span", { style: { fontSize: "12px", color: B.warn } }, "Rate for a deleted role — click to remove"));
          }
          var maps = effective(svc, r), base = window.LTP_serviceRateMaps(svc);
          var day = Math.round(maps.priceMap.day * 100) / 100, dayCost = Math.round(maps.costMap.day * 100) / 100;
          var baseDay = Math.round(base.priceMap.day * 100) / 100;
          var margin = day > 0 ? Math.round(((day - dayCost) / day) * 100) : 0;
          var paused = r.active === false;
          return h(window.LTPRow, { key: r.id, onClick: function() { setEditingId(r.id); setShowAdd(false); },
            style: { display: "flex", alignItems: "center", gap: 10, flexWrap: isMobile ? "wrap" : "nowrap", opacity: paused ? 0.55 : 1 } },
            h("div", { style: { width: 44, textAlign: "center", flexShrink: 0 } },
              h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.accent } }, svc.role)),
            h("div", { style: { flex: 1, minWidth: 0 } },
              h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
                svc.description + (r.label ? " · " + r.label : "")),
              h("div", { style: { fontSize: "10px", color: B.textMut, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" } },
                paused && h("span", { style: { color: B.warn, fontWeight: 700 } }, "PAUSED"),
                r.minHours > 0 && h("span", { style: { color: B.info, fontWeight: 700 } }, r.minHours + "h bill min"),
                r.minCostHours > 0 && h("span", { style: { color: B.info, fontWeight: 700 } }, r.minCostHours + "h pay min"),
                r.notes && h("span", null, r.notes))),
            h("div", { style: { minWidth: 110, textAlign: "right" } },
              h("div", { style: { fontSize: "12px", color: B.text, fontWeight: 600 } }, money(day) + "/day"),
              day !== baseDay && h("div", { style: { fontSize: "10px", color: B.textMut, textDecoration: "line-through" } }, money(baseDay))),
            h("div", { style: { fontSize: "11px", color: B.textMut, minWidth: 80, textAlign: "right" } }, "pay " + money(dayCost)),
            h("div", { style: { fontSize: "11px", fontWeight: 700, minWidth: 40, textAlign: "right",
                                color: margin >= 30 ? B.success : margin >= 15 ? B.warn : B.danger } }, margin + "%")
          );
        })
      ),
      dlg && h(window.LTPConfirmDialog, { dlg: dlg, onCancel: function() { setDlg(null); } })
    );
  };
})();
