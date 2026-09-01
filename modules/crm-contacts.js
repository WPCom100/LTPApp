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
                style: { background: B.accentMuted, color: B.accent, fontSize: "11px", padding: "2px 10px", borderRadius: "4px", fontWeight: 600, cursor: "pointer", border: "1px solid " + B.accent + "44" } }, co.name);
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
          h("div", null,
            h("div", { style: { fontSize: "10px", color: B.textMut, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" } }, "Email"),
            h("a", { href: "mailto:" + contact.email, style: { fontSize: "13px", color: B.accent, textDecoration: "none" } }, contact.email))
        ),
        h("div", { style: { display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", background: B.raised, borderRadius: "8px" } },
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
  // `prefill` / `modalZIndex`: see the note on window.CRMCompanyForm. Creating
  // a contact from a quote's Primary Contact field arrives here prefilled with
  // the typed name and the document's company already linked.
  window.CRMContactForm = function({ ctx, initial, prefill, onSave, onClose, modalZIndex }) {
    var seed = initial || prefill || {};
    // The row this form is editing can change in another window while it sits
    // open. Field state was seeded when it opened and cannot be safely
    // re-seeded underneath the user, so say so rather than let Save quietly
    // overwrite the newer version. See theme.js::LTP_useRecordWatch.
    window.LTP_useRecordWatch("contacts", initial && initial.id,
      { title: "This contact changed elsewhere",
        message: "Another window updated it while this form was open. Saving will replace the newer version." });
    var [fn, setFn] = useState(seed.firstName || "");
    var [ln, setLn] = useState(seed.lastName || "");
    var [email, setEmail] = useState(seed.email || "");
    var [phone, setPhone] = useState(seed.phone || "");
    var [role, setRole] = useState(seed.role || "");
    var [compIds, setCompIds] = useState(seed.companyIds || []);
    // Billing address — only relevant when this contact is invoiced directly
    // (client_type="contact"). Feeds the QuickBooks customer for sales tax.
    var [cAddress, setCAddress] = useState(seed.address || "");
    var [cCity, setCCity] = useState(seed.city || "");
    var [cState, setCState] = useState(seed.state || "");
    var [cZip, setCZip] = useState(seed.zip || "");
    var [errors, setErrors] = useState({});
    function validate() { var e = {}; if (!fn.trim()) e.fn = 1; if (!ln.trim()) e.ln = 1; if (!email.trim()) e.email = 1; if (!phone.trim()) e.phone = 1; if (!role.trim()) e.role = 1; setErrors(e); return Object.keys(e).length === 0; }
    return h(window.LTPModal, { title: initial ? "Edit Contact" : "Add Contact", onClose: onClose, disableBackdrop: true, zIndex: modalZIndex },
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
        h(window.SearchSelect, { label: "Link to Companies (optional)", items: ctx.companies, selectedIds: compIds, onChange: setCompIds, nameField: "name",
          createKind: "company", allowEdit: true }),
        // Billing address — for contacts invoiced directly. Feeds QuickBooks tax.
        h("div", { style: { borderTop: "1px solid " + B.border, paddingTop: 10 } },
          h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 } }, "Billing Address (for direct invoicing)"),
          h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 8, fontStyle: "italic" } }, "Directly-billed contacts are always taxable in QuickBooks."),
          h(window.LTPInput, { label: "Street Address", value: cAddress, onChange: setCAddress, placeholder: "123 Main St" }),
          h("div", { style: { display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8, marginTop: 8 } },
            h(window.LTPInput, { label: "City", value: cCity, onChange: setCCity, placeholder: "Dallas" }),
            h(window.LTPInput, { label: "State", value: cState, onChange: setCState, placeholder: "TX" }),
            h(window.LTPInput, { label: "ZIP", value: cZip, onChange: setCZip, placeholder: "75201" })
          )
        ),
        initial && h("div", { style: { display: "flex", justifyContent: "flex-end" } },
          h(window.Btn, { small: true, variant: "danger", onClick: function() { ctx.setDeleteConfirm({ type: "contact", id: initial.id, name: initial.firstName + " " + initial.lastName }); onClose(); } }, "Delete Contact")),
        h(window.Btn, { onClick: function() { if (!validate()) return; onSave({ firstName: fn, lastName: ln, email: email, phone: phone, role: role, companyIds: compIds, address: cAddress, city: cCity, state: cState, zip: cZip }); } }, initial ? "Save Changes" : "Save Contact")
      )
    );
  };
})();
