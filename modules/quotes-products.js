// Quotes Products — sale items catalog. List + inline add/edit.
(function() {
  var h = React.createElement, useState = React.useState;
  var B = window.LTP_THEME;

  var UNITS = ["each", "roll", "jug", "tank", "bag", "pack", "sheet", "tube", "set"];

  function ProductForm({ initial, onSave, onCancel }) {
    var [name,      setName]      = useState(initial ? initial.name      : "");
    var [category,  setCategory]  = useState(initial ? initial.category  : "Consumables");
    var [unit,      setUnit]      = useState(initial ? initial.unit      : "each");
    var [unitPrice, setUnitPrice] = useState(initial ? initial.unitPrice : 0);
    var [cost,      setCost]      = useState(initial ? initial.cost      : 0);
    var [notes,     setNotes]     = useState(initial ? initial.notes     : "");

    function submit() {
      if (!name.trim()) return;
      onSave({
        name: name.trim(), category: category.trim() || "Consumables", unit: unit,
        unitPrice: Number(unitPrice) || 0, cost: Number(cost) || 0, notes: notes,
      });
    }

    var margin = unitPrice > 0 ? Math.round(((unitPrice - cost) / unitPrice) * 100) : 0;

    return h("div", { style: { background: B.raised, border: "1px solid " + B.accent + "44", borderRadius: "8px", padding: 14, marginBottom: 12 } },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
        h(window.LTPInput, { label: "Product Name *", value: name, onChange: setName, placeholder: "e.g. Gaff Tape — Black 2\"" }),
        h("div", { style: { display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 } },
          h(window.LTPInput, { label: "Category", value: category, onChange: setCategory, placeholder: "Consumables, Expendables, Hardware…" }),
          h(window.LTPSelect, { label: "Unit", value: unit, onChange: setUnit, options: UNITS.map(function(u) { return { value: u, label: u }; }) })
        ),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 } },
          h(window.LTPInput, { label: "Sale Price ($)", value: unitPrice, onChange: function(v) { setUnitPrice(Number(v) || 0); }, type: "number" }),
          h(window.LTPInput, { label: "Cost ($)", value: cost, onChange: function(v) { setCost(Number(v) || 0); }, type: "number" }),
          h("div", null,
            h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 2 } }, "Margin"),
            h("div", { style: { background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "6px 8px", fontSize: "12px", color: margin >= 30 ? B.success : margin >= 15 ? B.warn : B.danger, fontWeight: 700 } }, margin + "%")
          )
        ),
        h(window.LTPInput, { label: "Notes", value: notes, onChange: setNotes, placeholder: "Optional" }),
        h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
          h(window.Btn, { small: true, variant: "ghost", onClick: onCancel }, "Cancel"),
          h(window.Btn, { small: true, onClick: submit }, initial ? "Save Changes" : "Add Product")
        )
      )
    );
  }

  window.QuotesProducts = function({ products, setProducts, quotes }) {
    var [search, setSearch] = useState("");
    var [catFilter, setCatFilter] = useState("all");
    var [editingId, setEditingId] = useState(null);
    var [showAdd, setShowAdd]     = useState(false);
    var [dlg, setDlg]             = useState(null);

    var categories = ["all"].concat(Array.from(new Set(products.map(function(p) { return p.category; }))).sort());

    var q = search.trim().toLowerCase();
    var filtered = products.filter(function(p) {
      if (catFilter !== "all" && p.category !== catFilter) return false;
      if (q && p.name.toLowerCase().indexOf(q) === -1) return false;
      return true;
    }).sort(function(a, b) { return a.name.localeCompare(b.name); });

    function addProduct(d) {
      var newId = Math.max.apply(null, products.map(function(p) { return p.id; }).concat([0])) + 1;
      setProducts(function(prev) { return prev.concat([Object.assign({ id: newId }, d)]); });
      setShowAdd(false);
    }
    function updateProduct(id, d) {
      setProducts(function(prev) { return prev.map(function(p) { return p.id === id ? Object.assign({}, p, d) : p; }); });
      setEditingId(null);
    }
    function deleteProduct(id) {
      var p = products.find(function(x) { return x.id === id; });
      var name = p ? p.name : "this product";
      var refs = [];
      (quotes || []).forEach(function(q) {
        (q.sections || []).forEach(function(sec) {
          (sec.items || []).forEach(function(it) {
            if (it.productId === id) refs.push(window.LTP_QUOTE_REF(q) + " (" + sec.label + ")");
          });
        });
      });
      var refWarning = refs.length > 0 ? "\n\nThis product is on " + refs.length + " quote line item" + (refs.length > 1 ? "s" : "") + ":\n" + refs.slice(0, 5).join("\n") + (refs.length > 5 ? "\n..." : "") : "";
      setDlg({
        title: "Delete Product",
        message: "Delete \"" + name + "\"?" + refWarning,
        variant: "danger",
        confirmLabel: refs.length > 0 ? "Delete Anyway" : "Delete",
        onConfirm: function() {
          setProducts(function(prev) { return prev.filter(function(x) { return x.id !== id; }); });
          setDlg(null);
        },
      });
    }

    return h("div", null,
      // Toolbar
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 } },
        h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
          categories.map(function(c) {
            var active = catFilter === c;
            return h("button", { key: c, onClick: function() { setCatFilter(c); },
              style: { background: active ? B.accent : B.raised, color: active ? "#000" : B.textMut,
                       border: "1px solid " + (active ? B.accent : B.border), borderRadius: "4px",
                       padding: "4px 12px", fontSize: "11px", fontWeight: 600, cursor: "pointer", textTransform: "capitalize" } }, c === "all" ? "All" : c);
          })
        ),
        h(window.Btn, { small: true, onClick: function() { setShowAdd(true); setEditingId(null); } }, "+ Add Product")
      ),

      // Search
      h("div", { style: { marginBottom: 10 } },
        h("input", { type: "text", value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search products…",
          style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", width: 260 } })
      ),

      // Add form
      showAdd && h(ProductForm, { initial: null, onSave: addProduct, onCancel: function() { setShowAdd(false); } }),

      // List
      h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
        filtered.length === 0 && !showAdd && h("div", { style: { padding: "24px", textAlign: "center", color: B.textMut, fontSize: "13px", fontStyle: "italic" } }, "No products."),
        filtered.map(function(p) {
          if (editingId === p.id) {
            return h(ProductForm, { key: p.id, initial: p,
              onSave: function(d) { updateProduct(p.id, d); },
              onCancel: function() { setEditingId(null); } });
          }
          var margin = p.unitPrice > 0 ? Math.round(((p.unitPrice - p.cost) / p.unitPrice) * 100) : 0;
          return h("div", { key: p.id,
            style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "6px", padding: "10px 14px", display: "flex", alignItems: "center", gap: 12, cursor: "pointer" },
            onClick: function() { setEditingId(p.id); setShowAdd(false); },
            onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent + "44"; },
            onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; } },
            h("div", { style: { flex: 1, minWidth: 0 } },
              h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, p.name),
              h("div", { style: { fontSize: "11px", color: B.textMut } }, p.category + " \u00b7 per " + p.unit + (p.notes ? " \u00b7 " + p.notes : ""))
            ),
            h("div", { style: { fontSize: "12px", color: B.textSec, minWidth: 70, textAlign: "right" } }, "$" + p.unitPrice),
            h("div", { style: { fontSize: "11px", color: B.textMut, minWidth: 60, textAlign: "right" } }, "cost $" + p.cost),
            h("div", { style: { fontSize: "11px", fontWeight: 700, color: margin >= 30 ? B.success : margin >= 15 ? B.warn : B.danger, minWidth: 40, textAlign: "right" } }, margin + "%"),
            h("button", { onClick: function(e) { e.stopPropagation(); deleteProduct(p.id); },
              style: { background: "transparent", border: "none", color: B.textMut, cursor: "pointer", fontSize: "14px", padding: "2px 6px" } }, "\u00d7")
          );
        })
      ),
      dlg && h(window.LTPConfirmDialog, { dlg: dlg, onCancel: function() { setDlg(null); } })
    );
  };
})();
