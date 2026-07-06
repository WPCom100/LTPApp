// Quotes Services — labor rate card. List + inline add/edit.
// Used by the quote builder as type: "service" line items (qty = days).
(function() {
  var h = React.createElement, useState = React.useState;
  var B = window.LTP_THEME;

  var DEPARTMENTS = ["Lighting", "Audio", "Video", "Stage", "Rigging", "Production", "Other"];

  // Options for the per-service QuickBooks income-account override. The default
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
    var mapped = (settings && (settings.qboServiceIncomeAccountId || settings.qboIncomeAccountId)) || null;
    var opts = [{ value: "", label: mapped ? "Default — " + nameOf(mapped) : "Default income account" }];
    var seen = false;
    accounts.forEach(function(a) {
      if (String(a.id) === String(currentVal || "")) seen = true;
      opts.push({ value: String(a.id), label: a.name || ("Account #" + a.id) });
    });
    if (currentVal && !seen) opts.push({ value: String(currentVal), label: "Account #" + currentVal });
    return opts;
  }

  function ServiceForm({ initial, onSave, onCancel, onDelete, settings, qbo }) {
    var [role,        setRole]        = useState(initial ? initial.role        : "");
    var [description, setDescription] = useState(initial ? initial.description : "");
    var [department,  setDepartment]  = useState(initial ? initial.department  : "Lighting");
    var [dayRate,     setDayRate]     = useState(initial ? initial.dayRate     : 0);
    var [dayCost,     setDayCost]     = useState(initial ? initial.dayCost     : 0);
    var [notes,       setNotes]       = useState(initial ? initial.notes       : "");
    var [qbAccount,   setQbAccount]   = useState(initial ? (initial.qbIncomeAccountId || "") : "");

    function submit() {
      if (!role.trim() || !description.trim()) return;
      onSave({
        role: role.trim(), description: description.trim(), department: department,
        dayRate: Number(dayRate) || 0, dayCost: Number(dayCost) || 0, notes: notes,
        qbIncomeAccountId: qbAccount || null,
      });
    }

    var margin = dayRate > 0 ? Math.round(((dayRate - dayCost) / dayRate) * 100) : 0;

    return h("div", { style: { background: B.raised, border: "1px solid " + B.accent + "44", borderRadius: "8px", padding: 14, marginBottom: 12 } },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 2fr 1fr", gap: 10 } },
          h(window.LTPInput, { label: "Role *", value: role, onChange: setRole, placeholder: "e.g. L1, A2, SH" }),
          h(window.LTPInput, { label: "Description *", value: description, onChange: setDescription, placeholder: "e.g. Lead Lighting Tech" }),
          h(window.LTPSelect, { label: "Department", value: department, onChange: setDepartment, options: DEPARTMENTS.map(function(d) { return { value: d, label: d }; }) })
        ),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 } },
          h(window.LTPInput, { label: "Day Rate ($)", value: dayRate, onChange: function(v) { setDayRate(Number(v) || 0); }, type: "number" }),
          h(window.LTPInput, { label: "Day Cost ($)", value: dayCost, onChange: function(v) { setDayCost(Number(v) || 0); }, type: "number" }),
          h("div", null,
            h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 2 } }, "Margin"),
            h("div", { style: { background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "6px 8px", fontSize: "12px", color: margin >= 30 ? B.success : margin >= 15 ? B.warn : B.danger, fontWeight: 700 } }, margin + "%")
          )
        ),
        // QuickBooks override — shown only when connected. Blank = follow the
        // Settings income-account mapping for services.
        qbo && qbo.connected && h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "end" } },
          h(window.LTPSelect, { label: "QuickBooks Income Account", value: qbAccount, onChange: setQbAccount,
            options: qbAccountOptions(qbAccount, settings, qbo) }),
          h("div", { style: { fontSize: "10px", color: B.textMut, lineHeight: 1.5, paddingBottom: 6 } },
            "Where this service's revenue posts in QuickBooks. Applies from the next invoice push.")),
        h(window.LTPInput, { label: "Notes", value: notes, onChange: setNotes, placeholder: "Optional" }),
        h("div", { style: { display: "flex", gap: 8, justifyContent: initial ? "space-between" : "flex-end", alignItems: "center" } },
          // Edit mode only: delete lives here (in the item's details), matching
          // the equipment detail pattern — no row-level delete on the list.
          initial && h(window.Btn, { small: true, variant: "danger", onClick: onDelete }, "Delete"),
          h("div", { style: { display: "flex", gap: 8 } },
            h(window.Btn, { small: true, variant: "ghost", onClick: onCancel }, "Cancel"),
            h(window.Btn, { small: true, onClick: submit }, initial ? "Save Changes" : "Add Service")
          )
        )
      )
    );
  }

  window.QuotesServices = function({ services, setServices, projects, quotes, settings, qbo }) {
    var [search, setSearch] = useState("");
    var [deptFilter, setDeptFilter] = useState("all");
    var [editingId, setEditingId] = useState(null);
    var [showAdd, setShowAdd]     = useState(false);
    var [dlg, setDlg]             = useState(null);

    var departments = ["all"].concat(Array.from(new Set(services.map(function(s) { return s.department; }))).sort());

    var q = search.trim().toLowerCase();
    var filtered = services.filter(function(s) {
      if (deptFilter !== "all" && s.department !== deptFilter) return false;
      if (q) {
        var hay = (s.role + " " + s.description).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    }).sort(function(a, b) {
      if (a.department !== b.department) return a.department.localeCompare(b.department);
      return a.role.localeCompare(b.role);
    });

    function addService(d) {
      var newId = Math.max.apply(null, services.map(function(s) { return s.id; }).concat([0])) + 1;
      setServices(function(prev) { return prev.concat([Object.assign({ id: newId }, d)]); });
      setShowAdd(false);
    }
    function updateService(id, d) {
      setServices(function(prev) { return prev.map(function(s) { return s.id === id ? Object.assign({}, s, d) : s; }); });
      setEditingId(null);
    }
    function deleteService(id) {
      var s = services.find(function(x) { return x.id === id; });
      var name = s ? (s.role + " — " + s.description) : "this service";
      // Check for references
      var refs = [];
      (projects || []).forEach(function(p) {
        (p.schedule || []).forEach(function(sc) {
          (sc.positions || []).forEach(function(pos) {
            if (pos.serviceId === id) refs.push(p.name + " (" + sc.title + ")");
          });
        });
      });
      (quotes || []).forEach(function(q) {
        (q.sections || []).forEach(function(sec) {
          (sec.items || []).forEach(function(it) {
            if (it.serviceId === id) refs.push(window.LTP_QUOTE_REF(q) + " (" + sec.label + ")");
          });
        });
      });
      var refWarning = refs.length > 0 ? "\n\nThis service is referenced in " + refs.length + " place" + (refs.length > 1 ? "s" : "") + ":\n" + refs.slice(0, 5).join("\n") + (refs.length > 5 ? "\n..." : "") + "\n\nQuote/invoice line items keep their last quoted price but can no longer switch rate type; schedule positions lose their rate lookup." : "";
      setDlg({
        title: "Delete Service",
        message: "Delete \"" + name + "\"?" + refWarning,
        variant: "danger",
        confirmLabel: refs.length > 0 ? "Delete Anyway" : "Delete",
        onConfirm: function() {
          setServices(function(prev) { return prev.filter(function(x) { return x.id !== id; }); });
          setEditingId(null);
          setDlg(null);
        },
      });
    }

    return h("div", null,
      // Toolbar
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 } },
        h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
          departments.map(function(d) {
            var active = deptFilter === d;
            return h("button", { key: d, onClick: function() { setDeptFilter(d); },
              style: { background: active ? B.accent : B.raised, color: active ? B.btnInk : B.textMut,
                       border: "1px solid " + (active ? B.accent : B.border), borderRadius: "4px",
                       padding: "4px 12px", fontSize: "11px", fontWeight: 600, cursor: "pointer" } }, d === "all" ? "All" : d);
          })
        ),
        h(window.Btn, { small: true, onClick: function() { setShowAdd(true); setEditingId(null); } }, "+ Add Service")
      ),

      // Search
      h("div", { style: { marginBottom: 10 } },
        h("input", { type: "text", value: search, onChange: function(e) { setSearch(e.target.value); }, placeholder: "Search by role or description…",
          style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 12px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", width: 300 } })
      ),

      // Add form
      showAdd && h(ServiceForm, { initial: null, onSave: addService, onCancel: function() { setShowAdd(false); }, settings: settings, qbo: qbo }),

      // List — ruled ledger panel; an in-place edit form replaces its row
      // inside the panel (it renders as its own card between hairlines).
      h(window.LTPList, null,
        filtered.length === 0 && !showAdd && h("div", { style: { padding: "24px", textAlign: "center", color: B.textMut, fontSize: "13px", fontStyle: "italic" } }, "No services."),
        filtered.map(function(s) {
          if (editingId === s.id) {
            return h(ServiceForm, { key: s.id, initial: s,
              onSave: function(d) { updateService(s.id, d); },
              onCancel: function() { setEditingId(null); },
              onDelete: function() { deleteService(s.id); },
              settings: settings, qbo: qbo });
          }
          var margin = s.dayRate > 0 ? Math.round(((s.dayRate - s.dayCost) / s.dayRate) * 100) : 0;
          return h(window.LTPRow, { key: s.id,
            onClick: function() { setEditingId(s.id); setShowAdd(false); },
            style: { display: "flex", alignItems: "center", gap: 12 } },
            h("div", { style: { width: 48, textAlign: "center" } },
              h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.accent } }, s.role)
            ),
            h("div", { style: { flex: 1, minWidth: 0 } },
              h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, s.description),
              h("div", { style: { fontSize: "11px", color: B.textMut } }, s.department + (s.notes ? " \u00b7 " + s.notes : ""))
            ),
            h("div", { style: { fontSize: "12px", color: B.textSec, minWidth: 80, textAlign: "right" } }, "$" + s.dayRate + "/day"),
            h("div", { style: { fontSize: "11px", color: B.textMut, minWidth: 70, textAlign: "right" } }, "cost $" + s.dayCost),
            h("div", { style: { fontSize: "11px", fontWeight: 700, color: margin >= 30 ? B.success : margin >= 15 ? B.warn : B.danger, minWidth: 40, textAlign: "right" } }, margin + "%")
          );
        })
      ),
      dlg && h(window.LTPConfirmDialog, { dlg: dlg, onCancel: function() { setDlg(null); } })
    );
  };
})();
