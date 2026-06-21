// CRM Companies — CompanyDetail + CompanyForm
(function() {
  var B = window.LTP_THEME, CAT_KEYS = window.LTP_CAT_KEYS, CAT_COLORS = window.LTP_CAT_COLORS, fmt = window.LTP_formatDate, h = React.createElement, useState = React.useState;

  window.CRMCompanyDetail = function({ ctx }) {
    var company = ctx.selectedCompany; if (!company) return null;
    var compContacts = ctx.contacts.filter(function(c) { return c.companyIds.includes(company.id); });
    var compProjects = ctx.projects.filter(function(p) { return p.companyId === company.id; });
    var activeP = compProjects.filter(function(p) { return p.status === "in-progress"; }).length;
    var upcomingP = compProjects.filter(function(p) { return p.status === "upcoming"; }).length;
    var completedP = compProjects.filter(function(p) { return p.status === "completed"; }).length;
    var last5 = compProjects.slice().sort(function(a, b) { return b.startDate > a.startDate ? 1 : -1; }).slice(0, 5);
    function typeBadges() { var b=[]; if(company.isClient) b.push(h(window.Badge,{key:"cl",status:"client"})); if(company.isVendor) b.push(h(window.Badge,{key:"vn",status:"vendor"})); return b; }

    return h(window.LTPModal, { title: company.name, onClose: function() { ctx.setSelectedCompanyId(null); }, wide: true },
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 } },
        h("div", { style: { display: "flex", gap: 14, alignItems: "center" } },
          h(window.CompanyLogo, { src: company.logo, size: 48 }),
          h("div", null,
            h("div", { style: { display: "flex", gap: 8, marginBottom: 6, flexWrap: "wrap" } }, typeBadges(), h(window.Badge, { status: company.status })),
            company.address && h("div", { style: { fontSize: "12px", color: B.textMut, marginBottom: 2 } }, company.address),
            company.website && h("a", { href: company.website.startsWith("http") ? company.website : "https://" + company.website, target: "_blank", rel: "noopener noreferrer", style: { fontSize: "11px", color: B.info, textDecoration: "none" } }, company.website + " \u2197")
          )
        ),
        h("div", { style: { display: "flex", gap: 6 } },
          h(window.Btn, { small: true, variant: "ghost", onClick: function() { ctx.setEditCompanyId(company.id); } }, "Edit"),
          h(window.Btn, { small: true, variant: "danger", onClick: function() { ctx.setDeleteConfirm({ type: "company", id: company.id, name: company.name }); } }, "Delete"))
      ),
      company.notes && h("div", { style: { fontSize: "13px", color: B.textSec, marginBottom: 16, padding: "10px 14px", background: B.raised, borderRadius: "6px", borderLeft: "3px solid " + B.accent } }, company.notes),
      h("h4", { style: { fontSize: "13px", fontWeight: 700, color: B.textSec, margin: "0 0 10px", textTransform: "uppercase", letterSpacing: "0.06em" } }, "Projects"),
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 20 } },
        h("div", { style: { background: B.raised, borderRadius: "8px", padding: "12px 14px" } }, h("div", { style: { fontSize: "10px", color: B.textMut, textTransform: "uppercase", marginBottom: 4, fontWeight: 600 } }, "Active"), h("div", { style: { fontSize: "20px", fontWeight: 700, color: B.warn, fontFamily: "'Playfair Display', serif" } }, activeP)),
        h("div", { style: { background: B.raised, borderRadius: "8px", padding: "12px 14px" } }, h("div", { style: { fontSize: "10px", color: B.textMut, textTransform: "uppercase", marginBottom: 4, fontWeight: 600 } }, "Upcoming"), h("div", { style: { fontSize: "20px", fontWeight: 700, color: B.info, fontFamily: "'Playfair Display', serif" } }, upcomingP)),
        h("div", { style: { background: B.raised, borderRadius: "8px", padding: "12px 14px" } }, h("div", { style: { fontSize: "10px", color: B.textMut, textTransform: "uppercase", marginBottom: 4, fontWeight: 600 } }, "Completed"), h("div", { style: { fontSize: "20px", fontWeight: 700, color: B.success, fontFamily: "'Playfair Display', serif" } }, completedP))
      ),
      h("h4", { style: { fontSize: "13px", fontWeight: 700, color: B.textSec, margin: "0 0 10px", textTransform: "uppercase", letterSpacing: "0.06em" } }, "Contacts (" + compContacts.length + ")"),
      h("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 20 } },
        compContacts.map(function(c) { return h("div", { key: c.id, onClick: function() { ctx.setSelectedCompanyId(null); ctx.setEditContactId(c.id); }, style: { background: B.bg, border: "1px solid " + B.border, borderRadius: "6px", padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", transition: "all 0.15s" }, onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent + "44"; }, onMouseOut: function(e) { e.currentTarget.style.borderColor = B.border; } }, h("div", null, h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.text } }, c.firstName + " " + c.lastName), h("div", { style: { fontSize: "11px", color: B.textMut } }, c.role + " \u00b7 " + c.email + " \u00b7 " + c.phone)), h("span", { style: { fontSize: "11px", color: B.accent } }, "View \u2192")); }),
        compContacts.length === 0 && h("div", { style: { fontSize: "12px", color: B.textMut, fontStyle: "italic" } }, "No contacts linked.")
      ),
      h("h4", { style: { fontSize: "13px", fontWeight: 700, color: B.textSec, margin: "0 0 10px", textTransform: "uppercase", letterSpacing: "0.06em" } }, "Recent Projects (" + compProjects.length + " total)"),
      h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
        last5.map(function(p) { var total = Object.values(p.budget).reduce(function(a, b) { return a + b; }, 0); var pc = ctx.contacts.filter(function(c) { return p.contactIds.includes(c.id); }); return h("div", { key: p.id, onClick: function() { ctx.setSelectedCompanyId(null); ctx.setSelectedProjectId(p.id); }, style: { background: B.bg, border: "1px solid " + B.border, borderRadius: "6px", padding: "12px 14px", cursor: "pointer", transition: "all 0.15s", borderLeft: "3px solid " + CAT_COLORS[p.category] }, onMouseOver: function(e) { e.currentTarget.style.borderColor = B.accent + "44"; e.currentTarget.style.borderLeft = "3px solid " + CAT_COLORS[p.category]; }, onMouseOut: function(e) { e.currentTarget.style.borderColor = B.border; e.currentTarget.style.borderLeft = "3px solid " + CAT_COLORS[p.category]; } }, h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 } }, h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.text } }, p.name), h("div", { style: { display: "flex", gap: 6 } }, h(window.Badge, { status: CAT_KEYS[p.category] }), h(window.Badge, { status: p.status }))), h("div", { style: { fontSize: "11px", color: B.textMut } }, fmt(p.startDate) + " \u2192 " + fmt(p.endDate) + " \u00b7 $" + total.toLocaleString()), pc.length > 0 && h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 4 } }, "Contacts: " + pc.map(function(c) { return c.firstName + " " + c.lastName; }).join(", "))); }),
        compProjects.length === 0 && h("div", { style: { fontSize: "12px", color: B.textMut, fontStyle: "italic" } }, "No projects yet.")
      )
    );
  };

  window.CRMCompanyForm = function({ ctx, initial, onSave, onClose }) {
    var [name, setName] = useState(initial ? initial.name : "");
    var [isClient, setIsClient] = useState(initial ? !!initial.isClient : true);
    var [isVendor, setIsVendor] = useState(initial ? !!initial.isVendor : false);
    var [status, setStatus] = useState(initial ? initial.status : "prospect");
    var [address, setAddress] = useState(initial ? initial.address || "" : "");
    var [website, setWebsite] = useState(initial ? initial.website || "" : "");
    var [logo, setLogo] = useState(initial ? initial.logo || "" : "");
    var [notes, setNotes] = useState(initial ? initial.notes || "" : "");
    // Billing city/state/zip + taxable feed the QuickBooks customer so Automated
    // Sales Tax can geocode the jurisdiction (see backend/qbo_sync.py).
    var [city, setCity] = useState(initial ? initial.city || "" : "");
    var [stateRegion, setStateRegion] = useState(initial ? initial.state || "" : "");
    var [zip, setZip] = useState(initial ? initial.zip || "" : "");
    var [taxable, setTaxable] = useState(initial ? !!initial.taxable : false);
    var cbStyle = function(on) { return { background: on ? B.accent : B.raised, color: on ? "#000" : B.textMut, border: "1px solid " + (on ? B.accent : B.border), borderRadius: "4px", padding: "4px 14px", fontSize: "11px", fontWeight: 600, cursor: "pointer" }; };

    return h(window.LTPModal, { title: initial ? "Edit Company" : "Add Company", onClose: onClose, disableBackdrop: true },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
        h(window.LTPInput, { label: "Company Name *", value: name, onChange: setName, placeholder: "e.g. Dallas Theater Center" }),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
          h("label", { style: { fontSize: "11px", fontWeight: 600, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, "Type"),
          h("div", { style: { display: "flex", gap: 6 } },
            h("button", { onClick: function() { setIsClient(!isClient); }, style: cbStyle(isClient) }, "Client"),
            h("button", { onClick: function() { setIsVendor(!isVendor); }, style: cbStyle(isVendor) }, "Vendor")
          )
        ),
        h(window.LTPSelect, { label: "Status", value: status, onChange: setStatus, options: [{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }, { value: "one-time", label: "One-Time" }, { value: "prospect", label: "Prospect" }] }),
        h(window.LTPInput, { label: "Street Address", value: address, onChange: setAddress, placeholder: "123 Main St" }),
        h("div", { style: { display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8 } },
          h(window.LTPInput, { label: "City", value: city, onChange: setCity, placeholder: "Dallas" }),
          h(window.LTPInput, { label: "State", value: stateRegion, onChange: setStateRegion, placeholder: "TX" }),
          h(window.LTPInput, { label: "ZIP", value: zip, onChange: setZip, placeholder: "75201" })
        ),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
          h("label", { style: { fontSize: "11px", fontWeight: 600, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, "Sales Tax"),
          h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
            h("button", { onClick: function() { setTaxable(!taxable); }, style: cbStyle(taxable) }, taxable ? "Taxable" : "Tax-exempt"),
            h("span", { style: { fontSize: "10px", color: B.textMut } }, "QuickBooks calculates sales tax for taxable customers")
          )
        ),
        h(window.LTPInput, { label: "Website", value: website, onChange: setWebsite, placeholder: "https://example.com" }),
        h(window.ImageUpload, { label: "Logo", value: logo, onChange: setLogo }),
        h(window.LTPInput, { label: "Notes", value: notes, onChange: setNotes, textarea: true, placeholder: "Internal notes..." }),
        h(window.Btn, { onClick: function() { if (!name.trim()) return; onSave({ name: name, isClient: isClient, isVendor: isVendor, status: status, address: address, city: city, state: stateRegion, zip: zip, taxable: taxable, website: website, logo: logo, notes: notes }); } }, initial ? "Save Changes" : "Save Company")
      )
    );
  };
})();
