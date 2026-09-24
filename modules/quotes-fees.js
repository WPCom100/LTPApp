// Quotes Fees — catalog of miscellaneous billable line items that aren't
// equipment, services, or products: Lodging, Meal Expenses, Travel (air /
// ground / mileage), Consultation, Project Prep, etc. Used by the quote/invoice
// builder as type: "fee" line items (carrying feeId).
//
// A fee's price here is only a DEFAULT — fee prices vary per project, so the
// quote/invoice line edits its own unitPrice directly and never uses
// adjustedPrice. See backend/models.py::Fee.
(function() {
  var h = React.createElement, useState = React.useState, useRef = React.useRef;
  var B = window.LTP_THEME;

  var FEE = "#B794F6";  // fee accent (matches the FEE badge in the builder)

  // Billing units a fee can be priced by. "flat" = a single lump amount (qty 1);
  // the others give the line a meaningful qty (nights, miles, hours, …).
  var UNITS = ["flat", "night", "day", "trip", "mile", "hour", "each"];

  // Common fee categories offered as datalist suggestions (free-typed, not
  // enforced — mirrors how Products/Services categories work).
  var CATEGORY_SUGGESTIONS = ["Travel", "Lodging", "Meals", "Production", "Consultation", "Other"];

  // Options for the per-fee QuickBooks income-account override. The default
  // choice names the account the Settings mapping resolves to (fee-level →
  // global), so "default" is never a mystery. A saved id missing from the
  // cached list still shows as its raw id instead of silently reading as default.
  function qbAccountOptions(currentVal, settings, qbo) {
    var accounts = (qbo && qbo.incomeAccounts) || [];
    return window.LTP_qboIncomeAccountOptions(accounts, currentVal, window.LTP_qboFeeDefaultLabel(settings, accounts));
  }

  function FeeForm({ initial, onSave, onCancel, onDelete, settings, qbo }) {
    // The row this form is editing can change in another window while it sits
    // open. Field state was seeded when it opened and cannot be safely
    // re-seeded underneath the user, so say so rather than let Save quietly
    // overwrite the newer version. See theme.js::LTP_useRecordWatch.
    window.LTP_useRecordWatch("fees", initial && initial.id,
      { title: "This fee changed elsewhere",
        message: "Another window updated it while this form was open. Saving will replace the newer version." });
    var [name,      setName]      = useState(initial ? initial.name      : "");
    var [category,  setCategory]  = useState(initial ? (initial.category || "") : "Travel");
    var [unit,      setUnit]      = useState(initial ? (initial.unit || "flat") : "flat");
    var [unitPrice, setUnitPrice] = useState(initial ? initial.unitPrice : 0);
    var [cost,      setCost]      = useState(initial ? (initial.cost || 0) : 0);
    var [notes,     setNotes]     = useState(initial ? initial.notes     : "");
    var [qbAccount, setQbAccount] = useState(initial ? (initial.qbIncomeAccountId || "") : "");

    function submit() {
      if (!name.trim()) return;
      onSave({
        name: name.trim(), category: category.trim(), unit: unit,
        unitPrice: Number(unitPrice) || 0, cost: Number(cost) || 0, notes: notes,
        qbIncomeAccountId: qbAccount || null,
      });
    }

    var margin = unitPrice > 0 && cost > 0 ? Math.round(((unitPrice - cost) / unitPrice) * 100) : null;

    return h("div", { style: { background: B.raised, border: "1px solid " + FEE + "55", borderRadius: "8px", padding: 14, marginBottom: 12 } },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
        h(window.LTPInput, { label: "Fee Name *", value: name, onChange: setName, placeholder: "e.g. Lodging, Airfare, Consultation" }),
        h("div", { style: { display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 } },
          h("div", null,
            h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 2 } }, "Category"),
            h("input", { list: "ltp-fee-cats", value: category, onChange: function(e) { setCategory(e.target.value); }, placeholder: "Travel, Lodging, Production…",
              style: { width: "100%", background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "8px 10px", color: B.text, fontSize: "13px", fontFamily: "inherit", outline: "none" } }),
            h("datalist", { id: "ltp-fee-cats" }, CATEGORY_SUGGESTIONS.map(function(c) { return h("option", { key: c, value: c }); }))),
          h(window.LTPSelect, { label: "Priced Per", value: unit, onChange: setUnit, options: UNITS.map(function(u) { return { value: u, label: u === "flat" ? "Flat (lump sum)" : u }; }) })
        ),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 } },
          h(window.LTPInput, { label: "Default Amount ($)", value: unitPrice, onChange: function(v) { setUnitPrice(Number(v) || 0); }, type: "number" }),
          h(window.LTPInput, { label: "Cost ($)", value: cost, onChange: function(v) { setCost(Number(v) || 0); }, type: "number" }),
          h("div", null,
            h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 2 } }, "Margin"),
            h("div", { style: { background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "6px 8px", fontSize: "12px", color: margin == null ? B.textMut : margin >= 30 ? B.success : margin >= 15 ? B.warn : B.danger, fontWeight: 700 } }, margin == null ? "—" : margin + "%"))
        ),
        h("div", { style: { fontSize: "10px", color: B.textMut, lineHeight: 1.5, marginTop: -2 } },
          "The amount is a default — a fee's price is set per project on the quote/invoice line, so it never counts as a line discount."),
        // QuickBooks override — shown only when connected. Blank = follow the
        // Settings income-account mapping for fees.
        qbo && qbo.connected && h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "end" } },
          h(window.LTPSelect, { label: "QuickBooks Income Account", value: qbAccount, onChange: setQbAccount,
            options: qbAccountOptions(qbAccount, settings, qbo) }),
          h("div", { style: { fontSize: "10px", color: B.textMut, lineHeight: 1.5, paddingBottom: 6 } },
            "Where this fee's revenue posts in QuickBooks. Applies from the next invoice push.")),
        h(window.LTPInput, { label: "Notes", value: notes, onChange: setNotes, placeholder: "Optional" }),
        h("div", { style: { display: "flex", gap: 8, justifyContent: initial ? "space-between" : "flex-end", alignItems: "center" } },
          initial && h(window.Btn, { small: true, variant: "danger", onClick: onDelete }, "Delete"),
          h("div", { style: { display: "flex", gap: 8 } },
            h(window.Btn, { small: true, variant: "ghost", onClick: onCancel }, "Cancel"),
            h(window.Btn, { small: true, onClick: submit }, initial ? "Save Changes" : "Add Fee")
          )
        )
      )
    );
  }

  // Editor for the "quick-add" fee names — the one-tap chips that pre-fill a
  // CUSTOM fee in the quote/invoice Add-Item → Fees tab — and, once QuickBooks
  // is connected with its income accounts loaded, the account each name
  // presets on the fee. Persists to settings.feeQuickNames and
  // settings.feeQuickNameAccounts (admin-only write), which the pickers read
  // through window.LTP_feeQuickPicks. Local state is the editing surface; text
  // edits commit on blur, add/remove and account picks commit immediately, so
  // typing stays smooth and the whole app doesn't re-render on every keystroke.
  function FeeQuickNamesEditor({ settings, setSettings, qbo }) {
    var isMobile = window.LTP_useIsMobile();
    var [rows, setRows] = useState(function() { return window.LTP_feeQuickPicks(settings); });
    // Seeded once at mount and written back whole, so another admin's additions
    // were dropped without a word. Watch just this slice of the settings blob —
    // an unrelated settings change is not this editor's business.
    window.LTP_useRecordWatch("settings", null,
      { title: "Quick-add names changed elsewhere",
        message: "Another window updated them while this list was open. Saving will replace the newer version." },
      function(s) { return window.LTP_feeQuickPicks(s); });
    var rowsRef = useRef(rows);
    rowsRef.current = rows;
    // Without QuickBooks accounts to pick from this is the list of name chips
    // it always was — and each name's saved account rides through every edit.
    var picker = window.LTP_qboFeeAccountPicker(settings, qbo);

    function persist(list) {
      var patch = window.LTP_feeQuickPicksPatch(list);
      setSettings(function(prev) { return Object.assign({}, prev || {}, patch); });
    }
    function edit(i, fields) { var n = rowsRef.current.slice(); n[i] = Object.assign({}, n[i], fields); setRows(n); return n; }
    function addName() { setRows(rowsRef.current.concat([{ name: "", qbIncomeAccountId: null }])); }   // blank row — commits on blur once typed
    function removeName(i) { var n = rowsRef.current.slice(); n.splice(i, 1); setRows(n); persist(n); }
    function commitBlur() { persist(rowsRef.current); }

    function nameInput(r, i, style) {
      return h("input", { value: r.name, size: Math.max((r.name || "").length, 6), placeholder: "name", "aria-label": "Quick-add fee name",
        onChange: function(e) { edit(i, { name: e.target.value }); },
        onBlur: commitBlur,
        onKeyDown: function(e) { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } },
        style: Object.assign({ color: B.text, fontWeight: 600, fontFamily: "inherit", outline: "none" }, style) });
    }
    function removeBtn(r, i) {
      return h("button", { onClick: function() { removeName(i); }, "aria-label": "Remove " + (r.name || "name"), title: "Remove",
        style: { background: "transparent", border: "none", color: B.textMut, cursor: "pointer", fontSize: "15px", lineHeight: 1, padding: "0 4px" } }, "×");
    }
    var addBtn = h("button", { onClick: addName,
      style: { alignSelf: picker ? "flex-start" : undefined, background: "transparent", border: "1px dashed " + B.border, borderRadius: "14px", color: B.textSec, cursor: "pointer", fontSize: "11px", fontWeight: 600, padding: "5px 12px" } }, "+ Add name");
    var field = { background: B.bg, border: "1px solid " + B.border, borderRadius: "6px", padding: isMobile ? "7px 10px" : "5px 10px",
                  fontSize: isMobile ? "16px" : "12px", minWidth: 0, width: "100%", boxSizing: "border-box" };
    var colHead = { fontSize: "9px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" };

    return h("div", { style: { background: B.raised, border: "1px solid " + FEE + "44", borderRadius: "8px", padding: "12px 14px", marginBottom: 16 } },
      h("div", { style: { fontSize: "10px", fontWeight: 700, color: FEE, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 } }, "Quick-Add Fee Names"),
      h("div", { style: { fontSize: "11px", color: B.textMut, lineHeight: 1.5, marginBottom: 10 } },
        picker
          ? "One-tap names shown when adding a custom fee to a quote or invoice. Each fills in the description and presets the QuickBooks income account beside it — never a price. The account can still be changed on the fee."
          : "One-tap names shown when adding a custom fee to a quote or invoice. These pre-fill the description only — they carry no price."),
      picker
        // Name → account rows. A phone stacks each pair: name and × on top,
        // the account under it at full width.
        ? h("div", { style: { display: "flex", flexDirection: "column", gap: isMobile ? 10 : 6, maxWidth: isMobile ? undefined : 760 } },
            !isMobile && rows.length > 0 && h("div", { style: { display: "grid", gridTemplateColumns: "minmax(140px, 1fr) minmax(180px, 1.3fr) 24px", gap: 8 } },
              h("div", { style: colHead }, "Name"), h("div", { style: colHead }, "QuickBooks income account")),
            rows.map(function(r, i) {
              var sel = h("select", { value: r.qbIncomeAccountId || "", "aria-label": "QuickBooks income account for " + (r.name || "this name"),
                  onChange: function(e) { persist(edit(i, { qbIncomeAccountId: e.target.value || null })); },
                  style: Object.assign({ color: B.text, fontFamily: "inherit", outline: "none", appearance: "auto" }, field, isMobile ? { gridColumn: "1 / -1" } : null) },
                window.LTP_qboIncomeAccountOptions(picker.accounts, r.qbIncomeAccountId, picker.defaultLabel).map(function(o) {
                  return h("option", { key: o.value, value: o.value }, o.label);
                }));
              return h("div", { key: i, style: { display: "grid", gridTemplateColumns: isMobile ? "1fr auto" : "minmax(140px, 1fr) minmax(180px, 1.3fr) 24px", gap: isMobile ? 6 : 8, alignItems: "center" } },
                nameInput(r, i, field),
                isMobile ? removeBtn(r, i) : sel,
                isMobile ? sel : removeBtn(r, i));
            }),
            addBtn)
        : h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
            rows.map(function(r, i) {
              return h("div", { key: i, style: { display: "inline-flex", alignItems: "center", gap: 4, background: B.bg, border: "1px solid " + B.border, borderRadius: "14px", padding: "3px 4px 3px 10px" } },
                nameInput(r, i, { background: "transparent", border: "none", fontSize: "12px", minWidth: 40 }),
                removeBtn(r, i));
            }),
            addBtn)
    );
  }

  window.QuotesFees = function({ fees, setFees, quotes, invoices, settings, setSettings, isAdmin, qbo }) {
    var isMobile = window.LTP_useIsMobile();
    var [search, setSearch] = useState("");
    var [catFilter, setCatFilter] = useState("all");
    var [editingId, setEditingId] = useState(null);
    var [showAdd, setShowAdd]     = useState(false);
    var [dlg, setDlg]             = useState(null);

    var categories = ["all"].concat(Array.from(new Set((fees || []).map(function(f) { return f.category || "Uncategorized"; }))).sort());

    var q = search.trim().toLowerCase();
    var filtered = (fees || []).filter(function(f) {
      if (catFilter !== "all" && (f.category || "Uncategorized") !== catFilter) return false;
      if (q && f.name.toLowerCase().indexOf(q) === -1) return false;
      return true;
    }).sort(function(a, b) { return a.name.localeCompare(b.name); });

    function addFee(d) {
      var newId = Math.max.apply(null, (fees || []).map(function(f) { return f.id; }).concat([0])) + 1;
      setFees(function(prev) { return (prev || []).concat([Object.assign({ id: newId }, d)]); });
      setShowAdd(false);
    }
    function updateFee(id, d) {
      setFees(function(prev) { return (prev || []).map(function(f) { return f.id === id ? Object.assign({}, f, d) : f; }); });
      setEditingId(null);
    }
    function deleteFee(id) {
      var f = (fees || []).find(function(x) { return x.id === id; });
      var name = f ? f.name : "this fee";
      // Reference scan — quote AND invoice line items that carry this feeId.
      // A deleted fee doesn't change any existing line (each line keeps its own
      // name + price), so this warning is informational only.
      var refs = [];
      (quotes || []).forEach(function(qt) {
        (qt.sections || []).forEach(function(sec) {
          (sec.items || []).forEach(function(it) {
            if (it.feeId === id) refs.push(window.LTP_QUOTE_REF(qt) + " (" + sec.label + ")");
          });
        });
      });
      (invoices || []).forEach(function(inv) {
        (inv.sections || []).forEach(function(sec) {
          (sec.items || []).forEach(function(it) {
            if (it.feeId === id) refs.push(window.LTP_INVOICE_REF(inv) + " (" + sec.label + ")");
          });
        });
      });
      var refWarning = refs.length > 0 ? "\n\nThis fee is on " + refs.length + " line item" + (refs.length > 1 ? "s" : "") + ":\n" + refs.slice(0, 5).join("\n") + (refs.length > 5 ? "\n..." : "") + "\n\nThose lines keep their own name and price — only this catalog entry is removed." : "";
      setDlg({
        title: "Delete Fee",
        message: "Delete \"" + name + "\"?" + refWarning,
        variant: "danger",
        confirmLabel: refs.length > 0 ? "Delete Anyway" : "Delete",
        onConfirm: function() {
          setFees(function(prev) { return (prev || []).filter(function(x) { return x.id !== id; }); });
          setEditingId(null);
          setDlg(null);
        },
      });
    }

    function priceLabel(f) {
      return "$" + (f.unitPrice || 0) + (f.unit && f.unit !== "flat" ? " / " + f.unit : "");
    }

    return h("div", null,
      // Quick-add fee-name editor (admin-only — it writes app settings). The
      // catalog list below is unaffected by whether this renders.
      isAdmin && setSettings && h(FeeQuickNamesEditor, { settings: settings, setSettings: setSettings, qbo: qbo }),

      // Toolbar — category chips scroll horizontally on mobile; "+ Add" → FAB.
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
        !isMobile && h(window.Btn, { small: true, onClick: function() { setShowAdd(true); setEditingId(null); } }, "+ Add Fee")
      ),
      // Hidden while a form is open — it sat on top of the form's Add button.
      isMobile && !showAdd && editingId == null && h(window.LTPFab, { label: "Add fee", onClick: function() { setShowAdd(true); setEditingId(null); } }),

      // Search
      h("div", { style: { marginBottom: 10 } },
        h("input", { type: "text", value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search fees…",
          style: { background: B.raised, border: "1px solid " + B.border, borderRadius: isMobile ? "8px" : "6px", padding: isMobile ? "9px 12px" : "6px 12px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", width: isMobile ? "100%" : 260 } })
      ),

      // Add form
      showAdd && h(FeeForm, { initial: null, onSave: addFee, onCancel: function() { setShowAdd(false); }, settings: settings, qbo: qbo }),

      // List — ruled ledger panel; an in-place edit form replaces its row.
      h(window.LTPList, null,
        filtered.length === 0 && !showAdd && h("div", { style: { padding: "24px", textAlign: "center", color: B.textMut, fontSize: "13px", fontStyle: "italic" } },
          (fees || []).length === 0 ? "No fees yet. Add reusable fees like Lodging, Meals, Travel, Consultation, or Project Prep." : "No fees match your search."),
        filtered.map(function(f) {
          if (editingId === f.id) {
            return h(FeeForm, { key: f.id, initial: f,
              onSave: function(d) { updateFee(f.id, d); },
              onCancel: function() { setEditingId(null); },
              onDelete: function() { deleteFee(f.id); },
              settings: settings, qbo: qbo });
          }
          return h(window.LTPRow, { key: f.id,
            onClick: function() { setEditingId(f.id); setShowAdd(false); },
            style: { display: "flex", alignItems: "center", gap: 12 } },
            h("span", { style: { fontSize: "9px", fontWeight: 700, color: FEE, background: FEE + "22", border: "1px solid " + FEE + "44", padding: "2px 5px", borderRadius: "3px", minWidth: 30, textAlign: "center", flexShrink: 0 } }, "FEE"),
            h("div", { style: { flex: 1, minWidth: 0 } },
              h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, f.name),
              h("div", { style: { fontSize: "11px", color: B.textMut } }, (f.category || "Uncategorized") + (f.notes ? " · " + f.notes : ""))
            ),
            h("div", { style: { fontSize: "12px", color: B.textSec, minWidth: 90, textAlign: "right" } }, priceLabel(f)),
            (f.cost || 0) > 0 && h("div", { style: { fontSize: "11px", color: B.textMut, minWidth: 60, textAlign: "right" } }, "cost $" + f.cost)
          );
        })
      ),
      dlg && h(window.LTPConfirmDialog, { dlg: dlg, onCancel: function() { setDlg(null); } })
    );
  };
})();
