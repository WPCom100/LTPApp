// Search Select Components — reusable across all modules
(function() {
  var B = window.LTP_THEME, h = React.createElement, useState = React.useState;

  // Multi-select search (contacts, companies linking, attendees, etc.)
  window.SearchSelect = function({ label, items, selectedIds, onChange, nameField }) {
    var [query, setQuery] = useState("");
    var [focused, setFocused] = useState(false);
    var getName = function(item) { return typeof nameField === "function" ? nameField(item) : item[nameField || "name"]; };
    var filtered = items.filter(function(item) { return getName(item).toLowerCase().indexOf(query.toLowerCase()) !== -1; });
    return h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
      label && h("label", { style: { fontSize: "11px", fontWeight: 600, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, label),
      selectedIds.length > 0 && h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 4 } },
        selectedIds.map(function(id) {
          var item = items.find(function(i) { return i.id === id; }); if (!item) return null;
          return h("span", { key: id, style: { display: "inline-flex", alignItems: "center", gap: 4, background: B.accent, color: "#000", fontSize: "11px", padding: "2px 8px", borderRadius: "4px", fontWeight: 600 } },
            getName(item), h("button", { onClick: function() { onChange(selectedIds.filter(function(x) { return x !== id; })); }, style: { background: "none", border: "none", color: "#000", cursor: "pointer", fontSize: "12px", fontWeight: 700, padding: "0 0 0 2px", lineHeight: 1 } }, "\u00d7"));
        })
      ),
      h("div", { style: { position: "relative" } },
        h("input", { type: "text", value: query, placeholder: "Search...", onChange: function(e) { setQuery(e.target.value); }, onFocus: function() { setFocused(true); }, onBlur: function() { setTimeout(function() { setFocused(false); }, 200); }, style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px 12px", color: B.text, fontSize: "13px", fontFamily: "inherit", outline: "none", width: "100%" } }),
        focused && query.length > 0 && filtered.length > 0 && h("div", { style: { position: "absolute", top: "100%", left: 0, right: 0, background: B.surface, border: "1px solid " + B.border, borderRadius: "0 0 6px 6px", maxHeight: 180, overflow: "auto", zIndex: 10 } },
          filtered.map(function(item) { var id = item.id, isSel = selectedIds.includes(id); return h("div", { key: id, onMouseDown: function(e) { e.preventDefault(); }, onClick: function() { if (isSel) onChange(selectedIds.filter(function(x) { return x !== id; })); else onChange(selectedIds.concat([id])); setQuery(""); }, style: { padding: "8px 12px", fontSize: "12px", cursor: "pointer", color: isSel ? B.accent : B.text, background: isSel ? B.accentMuted : "transparent", borderBottom: "1px solid " + B.border } }, (isSel ? "\u2713 " : "") + getName(item)); }))
      )
    );
  };

  // Single-select inline chip search (for company field in project forms)
  window.CompanySearchField = function({ label, compId, setCompId, companies, onClear }) {
    var [query, setQuery] = useState("");
    var [focused, setFocused] = useState(false);
    var comps = companies || [];
    var selCompany = compId ? comps.find(function(c) { return c.id === compId; }) : null;
    var filtered = comps.filter(function(c) { return c.name.toLowerCase().indexOf(query.toLowerCase()) !== -1; });
    return h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
      label && h("label", { style: { fontSize: "11px", fontWeight: 600, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, label),
      h("div", { style: { position: "relative" } },
        h("div", { style: { display: "flex", alignItems: "center", background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "0 12px", minHeight: 37 } },
          selCompany && h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4, background: B.accent, color: "#000", fontSize: "11px", padding: "2px 8px", borderRadius: "4px", fontWeight: 600, marginRight: 6, flexShrink: 0 } },
            selCompany.name,
            h("button", { onClick: function(e) { e.stopPropagation(); setCompId(null); setQuery(""); if (onClear) onClear(); }, style: { background: "none", border: "none", color: "#000", cursor: "pointer", fontSize: "12px", fontWeight: 700, padding: "0 0 0 2px", lineHeight: 1 } }, "\u00d7")
          ),
          h("input", { type: "text", value: selCompany ? "" : query, placeholder: selCompany ? "" : "Search companies...",
            onChange: function(e) { if (!selCompany) setQuery(e.target.value); },
            onFocus: function() { if (!selCompany) setFocused(true); },
            onBlur: function() { setTimeout(function() { setFocused(false); }, 200); },
            onClick: function() { if (selCompany) { setCompId(null); setQuery(""); setFocused(true); if (onClear) onClear(); } },
            style: { background: "transparent", border: "none", color: B.text, fontSize: "13px", fontFamily: "inherit", outline: "none", flex: 1, padding: "8px 0", minWidth: 60, cursor: selCompany ? "pointer" : "text" }
          })
        ),
        focused && !selCompany && query.length > 0 && filtered.length > 0 && h("div", { style: { position: "absolute", top: "100%", left: 0, right: 0, background: B.surface, border: "1px solid " + B.border, borderRadius: "0 0 6px 6px", maxHeight: 150, overflow: "auto", zIndex: 10 } },
          filtered.map(function(c) { return h("div", { key: c.id, onMouseDown: function(e) { e.preventDefault(); }, onClick: function() { setCompId(c.id); setQuery(""); setFocused(false); }, style: { padding: "8px 12px", fontSize: "12px", cursor: "pointer", color: B.text, borderBottom: "1px solid " + B.border } }, c.name); }))
      )
    );
  };

  // Single-select inline chip search for a contact. Mirrors CompanySearchField.
  // Accepts optional `filter` function to restrict candidates (e.g. only contacts
  // without a company, or contacts belonging to a specific company).
  window.ContactSearchField = function({ label, contactId, setContactId, contacts, filter, placeholder, onClear }) {
    var [query, setQuery] = useState("");
    var [focused, setFocused] = useState(false);
    var list = contacts || [];
    if (typeof filter === "function") list = list.filter(filter);
    var selContact = contactId ? (contacts || []).find(function(c) { return c.id === contactId; }) : null;
    var q = query.toLowerCase();
    var filtered = list.filter(function(c) {
      var hay = (c.firstName + " " + c.lastName + " " + (c.email || "") + " " + (c.role || "")).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    function fullName(c) { return c.firstName + " " + c.lastName; }
    return h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
      label && h("label", { style: { fontSize: "11px", fontWeight: 600, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, label),
      h("div", { style: { position: "relative" } },
        h("div", { style: { display: "flex", alignItems: "center", background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "0 12px", minHeight: 37 } },
          selContact && h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4, background: B.accent, color: "#000", fontSize: "11px", padding: "2px 8px", borderRadius: "4px", fontWeight: 600, marginRight: 6, flexShrink: 0 } },
            fullName(selContact),
            h("button", { onClick: function(e) { e.stopPropagation(); setContactId(null); setQuery(""); if (onClear) onClear(); }, style: { background: "none", border: "none", color: "#000", cursor: "pointer", fontSize: "12px", fontWeight: 700, padding: "0 0 0 2px", lineHeight: 1 } }, "\u00d7")
          ),
          h("input", { type: "text", value: selContact ? "" : query, placeholder: selContact ? "" : (placeholder || "Search contacts..."),
            onChange: function(e) { if (!selContact) setQuery(e.target.value); },
            onFocus: function() { if (!selContact) setFocused(true); },
            onBlur: function() { setTimeout(function() { setFocused(false); }, 200); },
            onClick: function() { if (selContact) { setContactId(null); setQuery(""); setFocused(true); if (onClear) onClear(); } },
            style: { background: "transparent", border: "none", color: B.text, fontSize: "13px", fontFamily: "inherit", outline: "none", flex: 1, padding: "8px 0", minWidth: 60, cursor: selContact ? "pointer" : "text" }
          })
        ),
        focused && !selContact && query.length > 0 && filtered.length > 0 && h("div", { style: { position: "absolute", top: "100%", left: 0, right: 0, background: B.surface, border: "1px solid " + B.border, borderRadius: "0 0 6px 6px", maxHeight: 180, overflow: "auto", zIndex: 10 } },
          filtered.map(function(c) { return h("div", { key: c.id, onMouseDown: function(e) { e.preventDefault(); }, onClick: function() { setContactId(c.id); setQuery(""); setFocused(false); },
            style: { padding: "8px 12px", fontSize: "12px", cursor: "pointer", color: B.text, borderBottom: "1px solid " + B.border } },
            h("div", { style: { fontWeight: 600 } }, fullName(c)),
            c.role && h("div", { style: { fontSize: "10px", color: B.textMut } }, c.role + (c.email ? " \u00b7 " + c.email : ""))
          ); }))
      )
    );
  };
})();
