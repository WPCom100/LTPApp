// Recipient editor for the quote / invoice send modals.
//
// Shows the email recipients as removable chips split into To (one primary) and
// Cc (the rest), with an Add control that searches the CRM contact list or
// accepts a typed-in address. Resolves to { to: [email...], cc: [email...] } —
// the shape stored on the record (send_recipients) and serialized to the
// /api/email/send `to`/`cc` strings.
(function() {
  var h = React.createElement, useState = React.useState;
  var B = window.LTP_THEME;

  function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || "").trim()); }

  // Default recipients from a project's linked contacts (or, with no project,
  // the company's contacts). Primary (To) = the client contact if it has an
  // email, else the first contact; the rest go to Cc. Contacts without an email
  // are skipped. Returns { to: [email], cc: [email...] }.
  window.LTP_deriveRecipients = function(project, contacts, clientContactId, companyId) {
    contacts = contacts || [];
    var byId = {}; contacts.forEach(function(c) { byId[c.id] = c; });
    var ids = (project && (project.contactIds || []).length)
      ? project.contactIds.slice()
      : contacts.filter(function(c) { return !c.isCrew && (c.companyIds || []).indexOf(companyId) !== -1; }).map(function(c) { return c.id; });
    var people = ids.map(function(id) { return byId[id]; }).filter(function(c) { return c && c.email; });
    var primary = null;
    if (clientContactId) {
      primary = people.filter(function(c) { return c.id === clientContactId; })[0]
        || (byId[clientContactId] && byId[clientContactId].email ? byId[clientContactId] : null);
    }
    if (!primary) primary = people[0] || null;
    var to = primary ? [primary.email] : [];
    var seen = {}; to.forEach(function(e) { seen[e.toLowerCase()] = true; });
    var cc = [];
    people.forEach(function(c) {
      var e = c.email; if (e && !seen[e.toLowerCase()]) { seen[e.toLowerCase()] = true; cc.push(e); }
    });
    return { to: to, cc: cc };
  };

  window.RecipientEditor = function(props) {
    var contacts = props.contacts || [];
    var onChange = props.onChange;
    var v = props.value || { to: [], cc: [] };
    var queryPair = useState(""); var query = queryPair[0], setQuery = queryPair[1];
    var openPair = useState(false); var open = openPair[0], setOpen = openPair[1];

    function contactByEmail(email) {
      var e = (email || "").toLowerCase();
      return contacts.filter(function(c) { return (c.email || "").toLowerCase() === e; })[0];
    }
    function nameFor(email) {
      var c = contactByEmail(email);
      return c ? ((c.firstName + " " + c.lastName).trim() || email) : null;
    }
    function all() { return (v.to || []).concat(v.cc || []); }
    function has(email) { var e = (email || "").toLowerCase(); return all().some(function(x) { return x.toLowerCase() === e; }); }
    function emit(next) { if (onChange) onChange(next); }

    function removeEmail(email) {
      var to = (v.to || []).filter(function(e) { return e !== email; });
      var cc = (v.cc || []).filter(function(e) { return e !== email; });
      if (to.length === 0 && cc.length > 0) { to = [cc[0]]; cc = cc.slice(1); }  // keep a primary
      emit({ to: to, cc: cc });
    }
    function makePrimary(email) {
      emit({ to: [email], cc: all().filter(function(e) { return e !== email; }) });
    }
    function addEmail(email) {
      email = (email || "").trim();
      if (!email || has(email)) { setQuery(""); setOpen(false); return; }
      if (!(v.to || []).length) emit({ to: [email], cc: (v.cc || []).slice() });
      else emit({ to: (v.to || []).slice(), cc: (v.cc || []).concat([email]) });
      setQuery(""); setOpen(false);
    }

    var chipWrap = { display: "inline-flex", alignItems: "center", gap: 6, background: B.raised, border: "1px solid " + B.border, borderRadius: "5px", padding: "3px 6px 3px 8px", maxWidth: "100%" };
    var xBtn = { background: "transparent", border: "none", color: B.textMut, fontSize: "11px", lineHeight: 1, cursor: "pointer", padding: "0 2px", fontFamily: "inherit", flexShrink: 0 };

    function chip(email, primary) {
      var nm = nameFor(email);
      return h("span", { key: (primary ? "to:" : "cc:") + email, style: chipWrap, title: email },
        h("span", { style: { fontSize: "11px", color: B.text, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, nm || email),
        nm && h("span", { style: { fontSize: "10px", color: B.textMut, whiteSpace: "nowrap" } }, email),
        !primary && h("button", { onClick: function() { makePrimary(email); }, title: "Move to To (make primary)",
          style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "3px", color: B.textSec, fontSize: "9px", cursor: "pointer", padding: "1px 5px", fontFamily: "inherit", flexShrink: 0 } }, "→ To"),
        h("button", { onClick: function() { removeEmail(email); }, title: "Remove", "aria-label": "Remove " + email, style: xBtn }, "✕"));
    }

    function row(label, emails, primary) {
      return h("div", { style: { display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8 } },
        h("span", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.05em", width: 24, flexShrink: 0, paddingTop: 5 } }, label),
        h("div", { style: { display: "flex", flexWrap: "wrap", gap: 5, flex: 1, minWidth: 0 } },
          emails.length ? emails.map(function(e) { return chip(e, primary); })
            : h("span", { style: { fontSize: "11px", color: B.textMut, fontStyle: "italic", paddingTop: 4 } }, primary ? "no primary recipient" : "none")));
    }

    var q = query.trim().toLowerCase();
    var matches = q ? contacts.filter(function(c) {
      if (!c.email || has(c.email)) return false;
      var name = ((c.firstName || "") + " " + (c.lastName || "")).toLowerCase();
      return name.indexOf(q) !== -1 || (c.email || "").toLowerCase().indexOf(q) !== -1;
    }).slice(0, 8) : [];
    var canCustom = isEmail(query) && !has(query.trim());

    return h("div", null,
      row("To", v.to || [], true),
      row("Cc", v.cc || [], false),
      h("div", { style: { position: "relative", marginTop: 2 } },
        h("input", { type: "text", value: query, placeholder: "Add a contact or type an email…",
          onChange: function(e) { setQuery(e.target.value); setOpen(true); },
          onFocus: function() { setOpen(true); },
          onBlur: function() { setTimeout(function() { setOpen(false); }, 150); },
          onKeyDown: function(e) { if (e.key === "Enter" && canCustom) { e.preventDefault(); addEmail(query.trim()); } },
          style: { width: "100%", background: B.bg, border: "1px solid " + B.border, borderRadius: "5px", padding: "6px 10px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none", boxSizing: "border-box" } }),
        open && (matches.length > 0 || canCustom) && h("div", { style: { position: "absolute", top: "calc(100% + 2px)", left: 0, right: 0, background: B.surface, border: "1px solid " + B.border, borderRadius: "6px", boxShadow: "0 6px 18px rgba(0,0,0,0.4)", zIndex: 50, maxHeight: 220, overflowY: "auto" } },
          matches.map(function(c) {
            var sub = (c.role || "") + (c.role && c.email ? " · " : "") + c.email;
            return h("div", { key: c.id, onMouseDown: function(e) { e.preventDefault(); addEmail(c.email); },
              style: { padding: "7px 10px", cursor: "pointer", borderBottom: "1px solid " + B.border } },
              h("div", { style: { fontSize: "12px", color: B.text, fontWeight: 600 } }, (c.firstName + " " + c.lastName).trim()),
              h("div", { style: { fontSize: "10px", color: B.textMut } }, sub));
          }),
          canCustom && h("div", { onMouseDown: function(e) { e.preventDefault(); addEmail(query.trim()); },
            style: { padding: "7px 10px", cursor: "pointer", fontSize: "12px", color: B.accent, fontWeight: 600 } }, "Add “" + query.trim() + "”"))));
  };
})();
