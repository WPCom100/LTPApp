// Quotes Products — sale items catalog. List + inline add/edit.
(function() {
  var h = React.createElement, useState = React.useState;
  var B = window.LTP_THEME;

  var UNITS = ["each", "roll", "jug", "tank", "bag", "pack", "sheet", "tube", "set"];

  // Options for the per-product QuickBooks income-account override. The default
  // choice names the account the Settings mapping resolves to (type-level →
  // global), so "default" is never a mystery. A saved id missing from the
  // cached list (Settings → QuickBooks → Update Account List) still shows,
  // as its raw id, instead of silently displaying as the default.
  function qbAccountOptions(currentVal, settings, qbo) {
    var accounts = (qbo && qbo.incomeAccounts) || [];
    function nameOf(id) {
      for (var i = 0; i < accounts.length; i++) if (String(accounts[i].id) === String(id)) return accounts[i].name || ("Account #" + id);
      return "Account #" + id;
    }
    var mapped = (settings && (settings.qboProductIncomeAccountId || settings.qboIncomeAccountId)) || null;
    var opts = [{ value: "", label: mapped ? "Default — " + nameOf(mapped) : "Default income account" }];
    var seen = false;
    accounts.forEach(function(a) {
      if (String(a.id) === String(currentVal || "")) seen = true;
      opts.push({ value: String(a.id), label: a.name || ("Account #" + a.id) });
    });
    if (currentVal && !seen) opts.push({ value: String(currentVal), label: "Account #" + currentVal });
    return opts;
  }

  function ProductForm({ initial, onSave, onCancel, onDelete, settings, qbo }) {
    var [name,      setName]      = useState(initial ? initial.name      : "");
    var [category,  setCategory]  = useState(initial ? initial.category  : "Consumables");
    var [unit,      setUnit]      = useState(initial ? initial.unit      : "each");
    var [unitPrice, setUnitPrice] = useState(initial ? initial.unitPrice : 0);
    var [cost,      setCost]      = useState(initial ? initial.cost      : 0);
    var [notes,     setNotes]     = useState(initial ? initial.notes     : "");
    var [qbAccount, setQbAccount] = useState(initial ? (initial.qbIncomeAccountId || "") : "");
    // Pricing variants — edited as raw rows (blank labels allowed while
    // typing); LTP_productVariants drops unlabeled rows everywhere they're
    // consumed, and submit() saves the same normalized list.
    var [variants, setVariants] = useState(
      initial && Array.isArray(initial.variants)
        ? initial.variants.map(function(v) { return Object.assign({}, v); })
        : []
    );

    function addVariant() {
      setVariants(function(prev) { return prev.concat([{ id: window.LTP_genId("var"), label: "", unitPrice: 0, cost: 0 }]); });
    }
    function patchVariant(id, patch) {
      setVariants(function(prev) { return prev.map(function(v) { return v.id === id ? Object.assign({}, v, patch) : v; }); });
    }
    function removeVariant(id) {
      setVariants(function(prev) { return prev.filter(function(v) { return v.id !== id; }); });
    }

    function submit() {
      if (!name.trim()) return;
      onSave({
        name: name.trim(), category: category.trim() || "Consumables", unit: unit,
        unitPrice: Number(unitPrice) || 0, cost: Number(cost) || 0, notes: notes,
        variants: window.LTP_productVariants({ variants: variants }),
        qbIncomeAccountId: qbAccount || null,
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
        // Pricing variants — alternative pricing structures for this product
        // (e.g. Transportation: Local Delivery / Per Mile / Client Goods).
        // When any exist, the quote/invoice pickers offer one row per variant
        // and the Sale Price above serves only as the "Base price" fallback.
        h("div", null,
          h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 } },
            h("div", { style: { fontSize: "10px", fontWeight: 600, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, "Pricing Variants"),
            h(window.Btn, { small: true, variant: "ghost", onClick: addVariant }, "+ Add Variant")),
          variants.length === 0 && h("div", { style: { fontSize: "10px", color: B.textMut, fontStyle: "italic" } },
            "Optional. Add variants to offer this product at multiple pricing structures (e.g. flat rate vs. per mile) — pickers then list one line per variant."),
          variants.length > 0 && h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
            variants.map(function(v) {
              var vMargin = (Number(v.unitPrice) || 0) > 0 ? Math.round(((Number(v.unitPrice) - Number(v.cost)) / Number(v.unitPrice)) * 100) : 0;
              return h("div", { key: v.id, style: { display: "grid", gridTemplateColumns: "2fr 1fr 1fr 50px 24px", gap: 8, alignItems: "center" } },
                h("input", { value: v.label || "", placeholder: "e.g. Local Delivery, Per Mile", autoFocus: !(v.label || "").length,
                  onChange: function(e) { patchVariant(v.id, { label: e.target.value }); },
                  style: { background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "5px 8px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none" } }),
                h("input", { type: "number", value: v.unitPrice, title: "Price ($)",
                  onChange: function(e) { patchVariant(v.id, { unitPrice: Number(e.target.value) || 0 }); },
                  style: { background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "5px 8px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", textAlign: "right" } }),
                h("input", { type: "number", value: v.cost, title: "Cost ($)",
                  onChange: function(e) { patchVariant(v.id, { cost: Number(e.target.value) || 0 }); },
                  style: { background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "5px 8px", color: B.textMut, fontSize: "11px", fontFamily: "inherit", outline: "none", textAlign: "right" } }),
                h("div", { style: { fontSize: "10px", fontWeight: 700, textAlign: "right", color: vMargin >= 30 ? B.success : vMargin >= 15 ? B.warn : B.danger } }, vMargin + "%"),
                h("button", { onClick: function() { removeVariant(v.id); }, title: "Remove variant",
                  style: { background: "transparent", border: "none", color: B.textMut, cursor: "pointer", fontSize: "14px", padding: 0 } }, "×"));
            }))),
        // QuickBooks override — shown only when connected. Blank = follow the
        // Settings income-account mapping for products.
        qbo && qbo.connected && h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "end" } },
          h(window.LTPSelect, { label: "QuickBooks Income Account", value: qbAccount, onChange: setQbAccount,
            options: qbAccountOptions(qbAccount, settings, qbo) }),
          h("div", { style: { fontSize: "10px", color: B.textMut, lineHeight: 1.5, paddingBottom: 6 } },
            "Where this product's revenue posts in QuickBooks. Applies from the next invoice push.")),
        h(window.LTPInput, { label: "Notes", value: notes, onChange: setNotes, placeholder: "Optional" }),
        h("div", { style: { display: "flex", gap: 8, justifyContent: initial ? "space-between" : "flex-end", alignItems: "center" } },
          // Edit mode only: delete lives here (in the item's details), matching
          // the equipment detail pattern — no row-level delete on the list.
          initial && h(window.Btn, { small: true, variant: "danger", onClick: onDelete }, "Delete"),
          h("div", { style: { display: "flex", gap: 8 } },
            h(window.Btn, { small: true, variant: "ghost", onClick: onCancel }, "Cancel"),
            h(window.Btn, { small: true, onClick: submit }, initial ? "Save Changes" : "Add Product")
          )
        )
      )
    );
  }

  window.QuotesProducts = function({ products, setProducts, quotes, settings, qbo }) {
    var isMobile = window.LTP_useIsMobile();
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
          setEditingId(null);
          setDlg(null);
        },
      });
    }

    return h("div", null,
      // Toolbar — filter chips scroll horizontally on mobile; "+ Add" → FAB.
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 } },
        h(window.LTPScrollStrip, { isMobile: isMobile, mobileStyle: { display: "flex", gap: 8, overflowX: "auto", flexWrap: "nowrap", WebkitOverflowScrolling: "touch", scrollbarWidth: "none", width: "100%", paddingBottom: 4 }, desktopStyle: { display: "flex", gap: 6, flexWrap: "wrap" } },
          categories.map(function(c) {
            var active = catFilter === c;
            return h("button", { key: c, onClick: function() { setCatFilter(c); }, className: "ltp-tap",
              style: { flexShrink: 0, whiteSpace: "nowrap", background: active ? B.accent : B.raised, color: active ? B.btnInk : B.textMut,
                       border: "1px solid " + (active ? B.accent : B.border), borderRadius: isMobile ? "16px" : "4px",
                       padding: isMobile ? "8px 16px" : "4px 12px", fontSize: isMobile ? "13px" : "11px", fontWeight: 600, cursor: "pointer", textTransform: "capitalize", minHeight: isMobile ? 36 : undefined } }, c === "all" ? "All" : c);
          })
        ),
        !isMobile && h(window.Btn, { small: true, onClick: function() { setShowAdd(true); setEditingId(null); } }, "+ Add Product")
      ),
      isMobile && h(window.LTPFab, { label: "Add product", onClick: function() { setShowAdd(true); setEditingId(null); } }),

      // Search
      h("div", { style: { marginBottom: 10 } },
        h("input", { type: "text", value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search products…",
          style: { background: B.raised, border: "1px solid " + B.border, borderRadius: isMobile ? "8px" : "6px", padding: isMobile ? "9px 12px" : "6px 12px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", width: isMobile ? "100%" : 260 } })
      ),

      // Add form
      showAdd && h(ProductForm, { initial: null, onSave: addProduct, onCancel: function() { setShowAdd(false); }, settings: settings, qbo: qbo }),

      // List — ruled ledger panel; an in-place edit form replaces its row
      // inside the panel (it renders as its own card between hairlines).
      h(window.LTPList, null,
        filtered.length === 0 && !showAdd && h("div", { style: { padding: "24px", textAlign: "center", color: B.textMut, fontSize: "13px", fontStyle: "italic" } }, "No products."),
        filtered.map(function(p) {
          if (editingId === p.id) {
            return h(ProductForm, { key: p.id, initial: p,
              onSave: function(d) { updateProduct(p.id, d); },
              onCancel: function() { setEditingId(null); },
              onDelete: function() { deleteProduct(p.id); },
              settings: settings, qbo: qbo });
          }
          var margin = p.unitPrice > 0 ? Math.round(((p.unitPrice - p.cost) / p.unitPrice) * 100) : 0;
          var pv = window.LTP_productVariants(p);
          return h(window.LTPRow, { key: p.id,
            onClick: function() { setEditingId(p.id); setShowAdd(false); },
            style: { display: "flex", alignItems: "center", gap: 12 } },
            h("div", { style: { flex: 1, minWidth: 0 } },
              h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, p.name),
              h("div", { style: { fontSize: "11px", color: B.textMut } }, p.category + " \u00b7 per " + p.unit + (p.notes ? " \u00b7 " + p.notes : "")),
              pv.length > 0 && h("div", { style: { fontSize: "10px", color: B.info, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
                pv.length + " pricing variant" + (pv.length === 1 ? "" : "s") + ": " + pv.map(function(v) { return v.label + " $" + v.unitPrice; }).join(" \u00b7 "))
            ),
            pv.length === 0 && h("div", { style: { fontSize: "12px", color: B.textSec, minWidth: 70, textAlign: "right" } }, "$" + p.unitPrice),
            pv.length === 0 && h("div", { style: { fontSize: "11px", color: B.textMut, minWidth: 60, textAlign: "right" } }, "cost $" + p.cost),
            pv.length === 0 && h("div", { style: { fontSize: "11px", fontWeight: 700, color: margin >= 30 ? B.success : margin >= 15 ? B.warn : B.danger, minWidth: 40, textAlign: "right" } }, margin + "%")
          );
        })
      ),
      dlg && h(window.LTPConfirmDialog, { dlg: dlg, onCancel: function() { setDlg(null); } })
    );
  };
})();
