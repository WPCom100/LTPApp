// Quotes Services — labor rate card. List + inline add/edit.
// Used by the quote builder as type: "service" line items (qty = days).
(function() {
  var h = React.createElement, useState = React.useState;
  var B = window.LTP_THEME;

  var DEPARTMENTS = ["Lighting", "Audio", "Video", "Stage", "Rigging", "Production", "Other"];

  function ServiceForm({ initial, onSave, onCancel }) {
    var [role,        setRole]        = useState(initial ? initial.role        : "");
    var [description, setDescription] = useState(initial ? initial.description : "");
    var [department,  setDepartment]  = useState(initial ? initial.department  : "Lighting");
    var [dayRate,     setDayRate]     = useState(initial ? initial.dayRate     : 0);
    var [dayCost,     setDayCost]     = useState(initial ? initial.dayCost     : 0);
    var [notes,       setNotes]       = useState(initial ? initial.notes       : "");

    function submit() {
      if (!role.trim() || !description.trim()) return;
      onSave({
        role: role.trim(), description: description.trim(), department: department,
        dayRate: Number(dayRate) || 0, dayCost: Number(dayCost) || 0, notes: notes,
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
        h(window.LTPInput, { label: "Notes", value: notes, onChange: setNotes, placeholder: "Optional" }),
        h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
          h(window.Btn, { small: true, variant: "ghost", onClick: onCancel }, "Cancel"),
          h(window.Btn, { small: true, onClick: submit }, initial ? "Save Changes" : "Add Service")
        )
      )
    );
  }

  window.QuotesServices = function({ services, setServices, projects, quotes }) {
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
      var refWarning = refs.length > 0 ? "\n\nThis service is referenced in " + refs.length + " place" + (refs.length > 1 ? "s" : "") + ":\n" + refs.slice(0, 5).join("\n") + (refs.length > 5 ? "\n..." : "") + "\n\nPositions and line items using this service will lose their rate data." : "";
      setDlg({
        title: "Delete Service",
        message: "Delete \"" + name + "\"?" + refWarning,
        variant: "danger",
        confirmLabel: refs.length > 0 ? "Delete Anyway" : "Delete",
        onConfirm: function() {
          setServices(function(prev) { return prev.filter(function(x) { return x.id !== id; }); });
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
              style: { background: active ? B.accent : B.raised, color: active ? "#000" : B.textMut,
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
      showAdd && h(ServiceForm, { initial: null, onSave: addService, onCancel: function() { setShowAdd(false); } }),

      // List
      h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
        filtered.length === 0 && !showAdd && h("div", { style: { padding: "24px", textAlign: "center", color: B.textMut, fontSize: "13px", fontStyle: "italic" } }, "No services."),
        filtered.map(function(s) {
          if (editingId === s.id) {
            return h(ServiceForm, { key: s.id, initial: s,
              onSave: function(d) { updateService(s.id, d); },
              onCancel: function() { setEditingId(null); } });
          }
          var margin = s.dayRate > 0 ? Math.round(((s.dayRate - s.dayCost) / s.dayRate) * 100) : 0;
          return h("div", { key: s.id,
            style: { background: B.surface, border: "1px solid " + B.border, borderRadius: "6px", padding: "10px 14px", display: "flex", alignItems: "center", gap: 12, cursor: "pointer" },
            onClick: function() { setEditingId(s.id); setShowAdd(false); },
            onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent + "44"; },
            onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; } },
            h("div", { style: { width: 48, textAlign: "center" } },
              h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.accent, fontFamily: "'Playfair Display', serif" } }, s.role)
            ),
            h("div", { style: { flex: 1, minWidth: 0 } },
              h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, s.description),
              h("div", { style: { fontSize: "11px", color: B.textMut } }, s.department + (s.notes ? " \u00b7 " + s.notes : ""))
            ),
            h("div", { style: { fontSize: "12px", color: B.textSec, minWidth: 80, textAlign: "right" } }, "$" + s.dayRate + "/day"),
            h("div", { style: { fontSize: "11px", color: B.textMut, minWidth: 70, textAlign: "right" } }, "cost $" + s.dayCost),
            h("div", { style: { fontSize: "11px", fontWeight: 700, color: margin >= 30 ? B.success : margin >= 15 ? B.warn : B.danger, minWidth: 40, textAlign: "right" } }, margin + "%"),
            h("button", { onClick: function(e) { e.stopPropagation(); deleteService(s.id); },
              style: { background: "transparent", border: "none", color: B.textMut, cursor: "pointer", fontSize: "14px", padding: "2px 6px" } }, "\u00d7")
          );
        })
      ),
      dlg && h(window.LTPConfirmDialog, { dlg: dlg, onCancel: function() { setDlg(null); } })
    );
  };
})();
