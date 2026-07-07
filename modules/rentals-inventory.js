// Rentals — Equipment Inventory View
// Depends on: rentals-utils.js
(function() {
  var h = React.createElement, useState = React.useState;

  window.RentalsInventoryView = function({ equipment, allocations, onOpenEquipment }) {
    var R = window.LTP_RENTALS, B = window.LTP_THEME;

    var [catFilter, setCatFilter] = useState("all");
    var [search,    setSearch]    = useState("");
    var [sortMode,  setSortMode]  = useState("az");

    var cats = ["all"].concat(Array.from(new Set(equipment.map(function(e) { return e.category; }))));
    var q = search.toLowerCase();

    var filtered = equipment.filter(function(e) {
      if (catFilter !== "all" && e.category !== catFilter) return false;
      if (q && e.name.toLowerCase().indexOf(q) === -1 && (e.manufacturer || "").toLowerCase().indexOf(q) === -1 && (e.model || "").toLowerCase().indexOf(q) === -1) return false;
      return true;
    }).slice().sort(function(a, b) {
      if (sortMode === "za")         return b.name.localeCompare(a.name);
      if (sortMode === "price-asc")  return (a.rates.threeDay || 0) - (b.rates.threeDay || 0);
      if (sortMode === "price-desc") return (b.rates.threeDay || 0) - (a.rates.threeDay || 0);
      return a.name.localeCompare(b.name); // az default
    });

    var totalUnits = equipment.reduce(function(s, e) { return s + e.qty; }, 0);
    var totalCost  = equipment.reduce(function(s, e) { return s + (e.purchaseCost || 0) * e.qty; }, 0);
    var checkedOut = allocations.filter(function(a) { return a.state === "checked-out"; }).length;

    return h("div", null,

      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12, flexWrap: "wrap" } },
        h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
          cats.map(function(c) {
            return h("button", { key: c, onClick: function() { setCatFilter(c); },
              style: { background: catFilter === c ? B.accent : B.raised, color: catFilter === c ? B.btnInk : B.textMut, border: "1px solid " + (catFilter === c ? B.accent : B.border), borderRadius: 4, padding: "4px 12px", fontSize: "11px", fontWeight: 600, cursor: "pointer", textTransform: "capitalize" } }, c);
          })
        ),
        h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
          h("input", { value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search inventory...", style: Object.assign({}, R.INP, { width: 180 }) }),
          [{ k: "az", l: "A\u2192Z" }, { k: "za", l: "Z\u2192A" }, { k: "price-asc", l: "$ \u2191" }, { k: "price-desc", l: "$ \u2193" }].map(function(o) {
            return h("button", { key: o.k, onClick: function() { setSortMode(o.k); },
              style: { background: sortMode === o.k ? B.accent : B.raised, color: sortMode === o.k ? B.btnInk : B.textMut, border: "1px solid " + (sortMode === o.k ? B.accent : B.border), borderRadius: 4, padding: "4px 10px", fontSize: "11px", fontWeight: 600, cursor: "pointer" } }, o.l);
          })
        )
      ),

      filtered.length === 0 ? h(window.EmptyState, { text: "No equipment matches your search." }) :
      h(window.LTPList, null,
        filtered.map(function(eq) {
          var totalUnitQty = R.eqQty(eq);
          var activeOut  = allocations.filter(function(a) { return a.equipmentId === eq.id && a.state !== "returned"; }).reduce(function(s, a) { return s + a.qty; }, 0);
          var openIssues = eq.serialized
            ? (eq.units || []).reduce(function(s, u) { return s + (u.maintenanceLogs || []).filter(function(l) { return l.status === "open"; }).length; }, 0)
            : (eq.maintenanceLogs || []).filter(function(l) { return l.status === "open"; }).length;

          return h(window.LTPRow, { key: eq.id, onClick: function() { onOpenEquipment(eq.id); },
            style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },

            h("div", null,
              h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.text, marginBottom: 3 } }, eq.name),
              h("div", { style: { fontSize: "11px", color: B.textMut } }, [eq.category, eq.subcategory, eq.manufacturer].filter(Boolean).join(" \u00b7 "))
            ),

            h("div", { style: { display: "flex", gap: 16, alignItems: "center" } },
              openIssues > 0 && h("span", { style: { fontSize: "10px", color: B.danger, fontWeight: 700 } }, openIssues + " issue" + (openIssues > 1 ? "s" : "")),
              h("div", { style: { textAlign: "right" } },
                h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.accent } }, "$" + R.baseRate(eq) + "/3-day"),
                h("div", { style: { fontSize: "11px", color: B.textMut } }, totalUnitQty + " units" + (activeOut > 0 ? " \u00b7 " + activeOut + " out" : ""))
              ),
              activeOut > 0
                ? h("span", { style: { fontSize: "10px", fontWeight: 700, background: B.accentMuted, color: B.accent, border: "1px solid " + B.accent + "44", padding: "2px 8px", borderRadius: 4, textTransform: "uppercase" } }, "partial")
                : h("span", { style: { fontSize: "10px", fontWeight: 700, background: B.successBg, color: B.success, border: "1px solid " + B.successBd, padding: "2px 8px", borderRadius: 4, textTransform: "uppercase" } }, "available")
            )
          );
        })
      )
    );
  };
})();
