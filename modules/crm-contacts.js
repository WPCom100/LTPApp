// CRM Contacts — ContactDetail (view) + ContactForm (add/edit)
(function() {
  var B = window.LTP_THEME, h = React.createElement, useState = React.useState, fmt = window.LTP_formatDate;

  // ── Contact Detail — read-only overview panel ─────────────────────────────
  window.CRMContactDetail = function({ ctx }) {
    var nav = window.LTPRouter.navigate;
    var contact = ctx.editContactId ? ctx.contacts.find(function(c) { return c.id === ctx.editContactId; }) : null;
    if (!contact) return null;
    var linkedCompanies = ctx.companies.filter(function(co) { return contact.companyIds && contact.companyIds.includes(co.id); });
    var linkedProjects  = ctx.projects.filter(function(p) { return p.contactIds && p.contactIds.includes(contact.id); });

    // Edit form — shown when URL action is "edit"
    if (ctx.contactAction === "edit") {
      return h(window.CRMContactForm, { ctx: ctx,
        initial: contact,
        onClose: function() { nav("crm/contacts/" + contact.id); },
        onSave: function(d) {
          ctx.setContacts(function(p) { return p.map(function(c) { return c.id === contact.id ? Object.assign({}, c, d) : c; }); });
          nav("crm/contacts/" + contact.id);
        }
      });
    }

    return h(window.LTPModal, { title: contact.firstName + " " + contact.lastName, onClose: function() { ctx.setEditContactId(null); }, wide: false },
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 } },
        h("div", null,
          h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.accent, marginBottom: 4 } }, contact.role),
          linkedCompanies.length > 0 && h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
            linkedCompanies.map(function(co) {
              return h("span", { key: co.id, onClick: function() { ctx.setEditContactId(null); ctx.setSelectedCompanyId(co.id); },
                style: { background: B.accentMuted, color: B.accent, fontSize: "11px", padding: "2px 10px", borderRadius: "4px", fontWeight: 600, cursor: "pointer", border: "1px solid #5a3010" } }, co.name);
            })
          )
        ),
        h("div", { style: { display: "flex", gap: 6 } },
          h(window.Btn, { small: true, variant: "ghost", onClick: function() { nav("crm/contacts/" + contact.id + "/edit"); } }, "Edit"),
          h(window.Btn, { small: true, variant: "danger", onClick: function() { ctx.setDeleteConfirm({ type: "contact", id: contact.id, name: contact.firstName + " " + contact.lastName }); ctx.setEditContactId(null); } }, "Delete")
        )
      ),

      // Contact info
      h("div", { style: { display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", background: B.raised, borderRadius: "8px" } },
          h("span", { style: { fontSize: "16px", color: B.textMut } }, "\u2709"),
          h("div", null,
            h("div", { style: { fontSize: "10px", color: B.textMut, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" } }, "Email"),
            h("a", { href: "mailto:" + contact.email, style: { fontSize: "13px", color: B.accent, textDecoration: "none" } }, contact.email))
        ),
        h("div", { style: { display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", background: B.raised, borderRadius: "8px" } },
          h("span", { style: { fontSize: "16px", color: B.textMut } }, "\u260e"),
          h("div", null,
            h("div", { style: { fontSize: "10px", color: B.textMut, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" } }, "Phone"),
            h("a", { href: "tel:" + contact.phone, style: { fontSize: "13px", color: B.accent, textDecoration: "none" } }, contact.phone))
        )
      ),

      // Linked projects
      h("h4", { style: { fontSize: "12px", fontWeight: 700, color: B.textSec, margin: "0 0 10px", textTransform: "uppercase", letterSpacing: "0.06em" } },
        "Projects (" + linkedProjects.length + ")"),
      linkedProjects.length === 0
        ? h("div", { style: { fontSize: "12px", color: B.textMut, fontStyle: "italic", marginBottom: 8 } }, "No projects assigned.")
        : h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
            linkedProjects.map(function(p) {
              var co = ctx.companies.find(function(c) { return c.id === p.companyId; });
              return h("div", { key: p.id,
                onClick: function() { ctx.setEditContactId(null); ctx.setSelectedProjectId(p.id); },
                style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "10px 14px", cursor: "pointer", transition: "all 0.15s" },
                onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent + "44"; },
                onMouseOut:  function(e) { e.currentTarget.style.borderColor = B.border; } },
                h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.text, marginBottom: 2 } }, p.name),
                h("div", { style: { fontSize: "11px", color: B.textMut } }, (co ? co.name + " \u00b7 " : "") + fmt(p.startDate) + " \u2192 " + fmt(p.endDate)),
                h("div", { style: { marginTop: 4 } }, h(window.Badge, { status: p.status }))
              );
            })
          )
    );
  };

  // ── Contact Form — add + edit ──────────────────────────────────────────────
  window.CRMContactForm = function({ ctx, initial, onSave, onClose }) {
    var [fn, setFn] = useState(initial ? initial.firstName : "");
    var [ln, setLn] = useState(initial ? initial.lastName : "");
    var [email, setEmail] = useState(initial ? initial.email : "");
    var [phone, setPhone] = useState(initial ? initial.phone : "");
    var [role, setRole] = useState(initial ? initial.role : "");
    var [compIds, setCompIds] = useState(initial ? initial.companyIds : []);
    var [errors, setErrors] = useState({});
    function validate() { var e = {}; if (!fn.trim()) e.fn = 1; if (!ln.trim()) e.ln = 1; if (!email.trim()) e.email = 1; if (!phone.trim()) e.phone = 1; if (!role.trim()) e.role = 1; setErrors(e); return Object.keys(e).length === 0; }
    return h(window.LTPModal, { title: initial ? "Edit Contact" : "Add Contact", onClose: onClose, disableBackdrop: true },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
          h(window.LTPInput, { label: "First Name *", value: fn, onChange: setFn, placeholder: "First" }),
          h(window.LTPInput, { label: "Last Name *", value: ln, onChange: setLn, placeholder: "Last" })
        ),
        errors.fn && h("div", { style: { fontSize: "10px", color: B.danger, marginTop: -8 } }, "First and last name required"),
        h(window.LTPInput, { label: "Email *", value: email, onChange: setEmail, type: "email", placeholder: "email@example.com",
          validate: function(v) { return v && !window.LTP_isValidEmail(v) ? "Enter a valid email address" : null; } }),
        h(window.LTPInput, { label: "Phone *", value: phone, onChange: setPhone, placeholder: "(xxx) xxx-xxxx",
          validate: function(v) { return v && !window.LTP_isValidPhone(v) ? "Enter a valid phone number" : null; },
          onBlur: function() { if (phone) setPhone(window.LTP_formatPhone(phone)); } }),
        h(window.LTPInput, { label: "Role / Title *", value: role, onChange: setRole, placeholder: "e.g. Technical Director" }),
        (errors.email || errors.phone || errors.role) && h("div", { style: { fontSize: "10px", color: B.danger } }, "* All starred fields are required."),
        h(window.SearchSelect, { label: "Link to Companies (optional)", items: ctx.companies, selectedIds: compIds, onChange: setCompIds, nameField: "name" }),
        initial && h("div", { style: { display: "flex", justifyContent: "flex-end" } },
          h(window.Btn, { small: true, variant: "danger", onClick: function() { ctx.setDeleteConfirm({ type: "contact", id: initial.id, name: initial.firstName + " " + initial.lastName }); onClose(); } }, "Delete Contact")),
        h(window.Btn, { onClick: function() { if (!validate()) return; onSave({ firstName: fn, lastName: ln, email: email, phone: phone, role: role, companyIds: compIds }); } }, initial ? "Save Changes" : "Save Contact")
      )
    );
  };
})();
