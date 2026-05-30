// ═══════════════════════════════════════════════════════════════════════════
//   SETTINGS MODULE — company info, branding, defaults
// ═══════════════════════════════════════════════════════════════════════════
(function() {
  "use strict";
  var h = React.createElement, B = window.LTP_THEME;
  var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef;

  var sectionStyle = { background: B.surface, border: "1px solid " + B.border, borderRadius: "8px", padding: "18px 20px", marginBottom: 14 };
  var sectionTitle = { fontSize: "13px", fontWeight: 700, color: B.text, fontFamily: "'Playfair Display', serif", marginBottom: 14 };

  window.SettingsView = function({ settings, setSettings }) {
    var [draft, setDraft] = useState(Object.assign({}, settings));
    var [isDirty, setIsDirty] = useState(false);
    window.LTP_useUnsavedGuard(isDirty);
    var [saved, setSaved] = useState(false);
    var [dlg, setDlg] = useState(null);
    var cleanRef = useRef(settings);

    useEffect(function() { setDraft(Object.assign({}, settings)); cleanRef.current = settings; setIsDirty(false); }, []);

    function set(key, val) {
      setDraft(function(d) { var n = Object.assign({}, d); n[key] = val; return n; });
      setIsDirty(true);
    }

    function save() {
      setSettings(draft);
      cleanRef.current = draft;
      setIsDirty(false);
      setSaved(true);
      setTimeout(function() { setSaved(false); }, 2000);
    }

    function discard() {
      setDraft(Object.assign({}, cleanRef.current));
      setIsDirty(false);
    }

    return h("div", { style: { maxWidth: 800, margin: "0 auto" } },
      // Header
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 } },
        h("h2", { style: { fontSize: "18px", fontWeight: 700, color: B.text, margin: 0, fontFamily: "'Playfair Display', serif" } }, "Company Settings"),
        h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
          saved && h("span", { style: { fontSize: "11px", fontWeight: 700, color: B.success, background: B.successBg, border: "1px solid " + B.successBd, padding: "5px 10px", borderRadius: "6px" } }, "\u2713 Saved"),
          isDirty && h(window.Btn, { small: true, variant: "ghost", onClick: discard }, "Discard"),
          isDirty && h(window.Btn, { small: true, onClick: save }, "Save Settings"))
      ),

      // ── Company Info ───────────────────────────────────────────────────────
      h("div", { style: sectionStyle },
        h("div", { style: sectionTitle }, "Company Information"),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
          h(window.LTPInput, { label: "Company Name", value: draft.companyName || "", onChange: function(v) { set("companyName", v); } }),
          h(window.LTPInput, { label: "Short Name", value: draft.companyShort || "", onChange: function(v) { set("companyShort", v); }, placeholder: "e.g. LTP" })
        ),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr", gap: 12, marginTop: 12 } },
          h(window.LTPInput, { label: "Tagline", value: draft.tagline || "", onChange: function(v) { set("tagline", v); }, placeholder: "e.g. Technical Production & Lighting Design" })
        ),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 } },
          h(window.LTPInput, { label: "Company Phone", value: draft.phone || "", onChange: function(v) { set("phone", v); },
            validate: function(v) { return v && !window.LTP_isValidPhone(v) ? "Enter a valid phone" : null; },
            onBlur: function() { if (draft.phone) set("phone", window.LTP_formatPhone(draft.phone)); } }),
          h(window.LTPInput, { label: "Website", value: draft.website || "", onChange: function(v) { set("website", v); } })
        )
      ),

      // ── Address ────────────────────────────────────────────────────────────
      h("div", { style: sectionStyle },
        h("div", { style: sectionTitle }, "Address"),
        h("div", { style: { display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 } },
          h(window.LTPInput, { label: "Street", value: draft.street || "", onChange: function(v) { set("street", v); } }),
          h(window.LTPInput, { label: "Suite / Unit", value: draft.suite || "", onChange: function(v) { set("suite", v); } })
        ),
        h("div", { style: { display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12, marginTop: 12 } },
          h(window.LTPInput, { label: "City", value: draft.city || "", onChange: function(v) { set("city", v); } }),
          h(window.LTPInput, { label: "State", value: draft.state || "", onChange: function(v) { set("state", v); } }),
          h(window.LTPInput, { label: "Zip", value: draft.zip || "", onChange: function(v) { set("zip", v); } })
        )
      ),

      // ── Branding ───────────────────────────────────────────────────────────
      h("div", { style: sectionStyle },
        h("div", { style: sectionTitle }, "Branding"),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
          h("div", null,
            h(window.LTPInput, { label: "Accent Color", value: draft.accentColor || "#E8731A", onChange: function(v) { set("accentColor", v); } }),
            h("div", { style: { display: "flex", gap: 8, marginTop: 6, alignItems: "center" } },
              h("div", { style: { width: 32, height: 32, borderRadius: "6px", background: draft.accentColor || "#E8731A", border: "1px solid " + B.border } }),
              h("input", { type: "color", value: draft.accentColor || "#E8731A", onChange: function(e) { set("accentColor", e.target.value); },
                style: { width: 32, height: 32, border: "none", padding: 0, cursor: "pointer", background: "transparent" } })
            )
          ),
          h(window.LTPInput, { label: "Logo URL (for PDFs & portal)", value: draft.logoUrl || "", onChange: function(v) { set("logoUrl", v); }, placeholder: "https://... or uploaded after backend" })
        ),
        // Preview card
        h("div", { style: { marginTop: 14, padding: 16, background: B.bg, borderRadius: "8px", border: "1px solid " + B.border } },
          h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 } }, "Preview"),
          h("div", { style: { display: "flex", alignItems: "center", gap: 14 } },
            draft.logoUrl
              ? h("img", { src: draft.logoUrl, style: { width: 48, height: 48, objectFit: "contain", borderRadius: "6px" } })
              : h("div", { style: { width: 48, height: 48, background: draft.accentColor || B.accent, borderRadius: "6px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "16px", fontWeight: 700, color: "#000", fontFamily: "'Playfair Display', serif" } }, (draft.companyShort || "LTP").substring(0, 3)),
            h("div", null,
              h("div", { style: { fontSize: "15px", fontWeight: 700, color: B.text, fontFamily: "'Playfair Display', serif" } }, draft.companyName || "Company Name"),
              h("div", { style: { fontSize: "11px", color: B.textMut } }, draft.tagline || ""),
              h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 2 } },
                (draft.street || "") + (draft.suite ? ", " + draft.suite : "") + " \u00b7 " +
                (draft.city || "") + ", " + (draft.state || "") + " " + (draft.zip || "")),
              h("div", { style: { fontSize: "10px", color: draft.accentColor || B.accent, marginTop: 1 } },
                (draft.phone || "") + " \u00b7 " + (draft.email || ""))
            )
          )
        )
      ),

      // ── Tag & Badge Colors ─────────────────────────────────────────────────
      h("div", { style: sectionStyle },
        h("div", { style: sectionTitle }, "Tag & Badge Colors"),
        h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 14, lineHeight: 1.5 } },
          "Customize colors for departments, statuses, and categories. Changes apply immediately across the app."),
        function() {
          var tc = draft.tagColors || {};
          function setTagColor(key, val) {
            var updated = Object.assign({}, tc);
            updated[key] = val;
            set("tagColors", updated);
          }
          var groups = [
            { label: "Departments", keys: ["Lighting", "Audio", "Video", "Stage", "Rigging", "Production"] },
            { label: "Document Status", keys: ["draft", "sent", "accepted", "declined", "paid", "partial", "overdue", "converted", "invoiced"] },
            { label: "Crew Status", keys: ["open", "requested", "confirmed"] },
            { label: "CRM", keys: ["active", "inactive", "client", "vendor", "prospect"] },
            { label: "Project Categories", keys: ["rental", "labor", "service", "full-production"] },
          ];
          return h("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },
            groups.map(function(g) {
              return h("div", { key: g.label },
                h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 } }, g.label),
                h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
                  g.keys.map(function(k) {
                    var color = tc[k] || "#666666";
                    return h("div", { key: k, style: { display: "flex", alignItems: "center", gap: 6, background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "4px 8px" } },
                      h("input", { type: "color", value: color, onChange: function(e) { setTagColor(k, e.target.value); },
                        style: { width: 20, height: 20, border: "none", padding: 0, cursor: "pointer", background: "transparent", borderRadius: "3px" } }),
                      h("span", { style: { fontSize: "10px", fontWeight: 600, color: color } }, k),
                      h("span", { style: { background: color + "1F", color: color, border: "1px solid " + color + "59", padding: "1px 6px", borderRadius: "3px", fontSize: "9px", fontWeight: 700, textTransform: "uppercase" } }, k)
                    );
                  })
                )
              );
            })
          );
        }()
      ),

      // ── Crew Options ──────────────────────────────────────────────────────
      h("div", { style: sectionStyle },
        h("div", { style: sectionTitle }, "Crew Options"),
        h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 14, lineHeight: 1.5 } },
          "Manage the available roles and departments for crew members. These appear as selectable tags on the crew form."),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 } },
          // Roles
          h("div", null,
            h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 } }, "Roles"),
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 } },
              (draft.crewRoleOptions || []).map(function(r, i) {
                return h("span", { key: r, style: { display: "flex", alignItems: "center", gap: 4, background: B.raised, border: "1px solid " + B.border, borderRadius: "4px", padding: "3px 8px", fontSize: "10px", fontWeight: 600, color: B.text } },
                  r,
                  h("button", { onClick: function() { set("crewRoleOptions", (draft.crewRoleOptions || []).filter(function(x) { return x !== r; })); },
                    style: { background: "none", border: "none", color: B.textMut, cursor: "pointer", fontSize: "12px", padding: "0 0 0 4px", lineHeight: 1 } }, "\u00d7"));
              })
            ),
            h("div", { style: { display: "flex", gap: 4 } },
              h("input", { id: "newRole", placeholder: "New role\u2026",
                style: { flex: 1, background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "4px 8px", color: B.text, fontSize: "10px", fontFamily: "inherit", outline: "none" },
                onKeyDown: function(e) {
                  if (e.key === "Enter" && e.target.value.trim()) {
                    var v = e.target.value.trim().toUpperCase();
                    if ((draft.crewRoleOptions || []).indexOf(v) === -1) set("crewRoleOptions", (draft.crewRoleOptions || []).concat([v]));
                    e.target.value = "";
                  }
                } }),
              h("button", { onClick: function() {
                var inp = document.getElementById("newRole"); if (!inp || !inp.value.trim()) return;
                var v = inp.value.trim().toUpperCase();
                if ((draft.crewRoleOptions || []).indexOf(v) === -1) set("crewRoleOptions", (draft.crewRoleOptions || []).concat([v]));
                inp.value = "";
              }, style: { background: B.accent, border: "none", borderRadius: "4px", padding: "4px 10px", color: "#000", fontSize: "10px", fontWeight: 700, cursor: "pointer" } }, "+"))),
          // Departments
          h("div", null,
            h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 } }, "Departments"),
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 } },
              (draft.crewDepartmentOptions || []).map(function(d) {
                return h("span", { key: d, style: { display: "flex", alignItems: "center", gap: 4, background: window.LTP_deptColor(d) + "18", border: "1px solid " + window.LTP_deptColor(d) + "44", borderRadius: "4px", padding: "3px 8px", fontSize: "10px", fontWeight: 600, color: window.LTP_deptColor(d) } },
                  d,
                  h("button", { onClick: function() { set("crewDepartmentOptions", (draft.crewDepartmentOptions || []).filter(function(x) { return x !== d; })); },
                    style: { background: "none", border: "none", color: B.textMut, cursor: "pointer", fontSize: "12px", padding: "0 0 0 4px", lineHeight: 1 } }, "\u00d7"));
              })
            ),
            h("div", { style: { display: "flex", gap: 4 } },
              h("input", { id: "newDept", placeholder: "New department\u2026",
                style: { flex: 1, background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "4px 8px", color: B.text, fontSize: "10px", fontFamily: "inherit", outline: "none" },
                onKeyDown: function(e) {
                  if (e.key === "Enter" && e.target.value.trim()) {
                    var v = e.target.value.trim();
                    if ((draft.crewDepartmentOptions || []).indexOf(v) === -1) set("crewDepartmentOptions", (draft.crewDepartmentOptions || []).concat([v]));
                    e.target.value = "";
                  }
                } }),
              h("button", { onClick: function() {
                var inp = document.getElementById("newDept"); if (!inp || !inp.value.trim()) return;
                var v = inp.value.trim();
                if ((draft.crewDepartmentOptions || []).indexOf(v) === -1) set("crewDepartmentOptions", (draft.crewDepartmentOptions || []).concat([v]));
                inp.value = "";
              }, style: { background: B.accent, border: "none", borderRadius: "4px", padding: "4px 10px", color: "#000", fontSize: "10px", fontWeight: 700, cursor: "pointer" } }, "+")))
        )
      ),

      // ── Document Defaults ───────────────────────────────────────────────────
      h("div", { style: sectionStyle },
        h("div", { style: sectionTitle }, "Document Defaults"),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 } },
          h(window.LTPSelect, { label: "Default Payment Terms", value: String(draft.defaultPaymentTerms || 30), onChange: function(v) { set("defaultPaymentTerms", Number(v)); },
            options: [{ value: "0", label: "Due on Receipt" }, { value: "15", label: "Net 15" }, { value: "20", label: "Net 20" }, { value: "30", label: "Net 30" }, { value: "45", label: "Net 45" }, { value: "60", label: "Net 60" }] }),
          h(window.LTPInput, { label: "Tax Rate (%)", value: draft.taxRate || "", onChange: function(v) { set("taxRate", Number(v) || 0); }, type: "number", placeholder: "0" }),
          h(window.LTPInput, { label: "Quote Validity (days)", value: draft.defaultQuoteValidity || "", onChange: function(v) { set("defaultQuoteValidity", Number(v) || 30); }, type: "number" })
        ),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 } },
          h("div", null,
            h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4, fontWeight: 600 } }, "Default Quote Notes"),
            h("textarea", { value: draft.defaultQuoteNotes || "", onChange: function(e) { set("defaultQuoteNotes", e.target.value); },
              style: { width: "100%", minHeight: 70, background: B.bg, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", resize: "vertical" } })),
          h("div", null,
            h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4, fontWeight: 600 } }, "Default Invoice Notes"),
            h("textarea", { value: draft.defaultInvoiceNotes || "", onChange: function(e) { set("defaultInvoiceNotes", e.target.value); },
              style: { width: "100%", minHeight: 70, background: B.bg, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", resize: "vertical" } }))
        )
      ),

      // ── Email Settings ─────────────────────────────────────────────────────
      h("div", { style: sectionStyle },
        h("div", { style: sectionTitle }, "Email Settings"),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
          h(window.LTPInput, { label: "Send From Email", value: draft.emailFrom || "", onChange: function(v) { set("emailFrom", v); }, type: "email",
            validate: function(v) { return v && !window.LTP_isValidEmail(v) ? "Enter a valid email" : null; } }),
          h(window.LTPInput, { label: "Reply-To Email", value: draft.emailReplyTo || "", onChange: function(v) { set("emailReplyTo", v); }, type: "email",
            validate: function(v) { return v && !window.LTP_isValidEmail(v) ? "Enter a valid email" : null; } })
        )
      ),

      // ── Email Templates ────────────────────────────────────────────────────
      h("div", { style: sectionStyle },
        h("div", { style: sectionTitle }, "Email Templates"),
        h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 14, lineHeight: 1.5 } },
          "Customize email templates for quotes, invoices, and crew. Use ", h("code", { style: { background: B.raised, padding: "1px 4px", borderRadius: "3px", fontSize: "10px" } }, "{{variable}}"), " placeholders for dynamic content."),
        h("div", { style: { background: B.bg, borderRadius: "6px", padding: "8px 12px", marginBottom: 14, border: "1px solid " + B.border } },
          h("div", { style: { fontSize: "9px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 } }, "Available Variables"),
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
            ["companyName", "refNumber", "projectName", "clientName", "total", "dueDate", "lineItems", "quoteValidity", "signature", "crewName", "role", "date", "callTime", "wrapTime", "location"].map(function(v) {
              return h("span", { key: v, style: { fontSize: "9px", background: B.accent + "22", color: B.accent, border: "1px solid " + B.accent + "44", padding: "2px 6px", borderRadius: "3px", fontFamily: "monospace", fontWeight: 600 } }, "{{" + v + "}}");
            })
          )
        ),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
          function() {
            var templates = draft.emailTemplates || {};
            var groups = [
              { label: "Quotes", keys: ["quoteSent", "quoteFollowUp"] },
              { label: "Invoices", keys: ["invoiceSent", "invoiceReminder", "paymentReceipt"] },
              { label: "Crew", keys: ["crewRequest", "crewConfirmed", "crewCancelled", "crewNotSelected"] },
            ];
            var elements = [];
            groups.forEach(function(group) {
              elements.push(h("div", { key: "h_" + group.label, style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", padding: "6px 0 2px" } }, group.label));
              group.keys.forEach(function(key) {
                var tmpl = templates[key] || { label: key, subject: "", body: "" };
                elements.push(h("details", { key: key, style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "6px" } },
                  h("summary", { style: { padding: "10px 14px", cursor: "pointer", fontSize: "12px", fontWeight: 600, color: B.text, display: "flex", justifyContent: "space-between", alignItems: "center" } },
                    h("span", null, tmpl.label || key),
                    h("span", { style: { fontSize: "9px", color: B.textMut, fontWeight: 400 } }, key)),
                  h("div", { style: { padding: "0 14px 14px" } },
                    h("div", { style: { marginBottom: 8 } },
                      h(window.LTPInput, { label: "Subject", value: tmpl.subject || "",
                        onChange: function(v) {
                          var t2 = Object.assign({}, templates);
                          t2[key] = Object.assign({}, tmpl, { subject: v });
                          set("emailTemplates", t2);
                        }, placeholder: "Email subject with {{variables}}" })),
                    h("div", null,
                      h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4, fontWeight: 600 } }, "Body"),
                      h("textarea", { value: tmpl.body || "",
                        onChange: function(e) {
                          var t2 = Object.assign({}, templates);
                          t2[key] = Object.assign({}, tmpl, { body: e.target.value });
                          set("emailTemplates", t2);
                        },
                        style: { width: "100%", minHeight: 120, background: B.bg, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none", resize: "vertical", lineHeight: 1.5 } }))
                  )
                ));
              });
            });
            return elements;
          }()
        )
      ),

      // Confirmation dialogs
      // ── Error Log ──────────────────────────────────────────────────────────
      h("div", { style: sectionStyle },
        h("div", { style: sectionTitle }, "Error Log"),
        h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 14, lineHeight: 1.5 } },
          "Recent application errors are captured here for diagnostics. " + ((window.__LTP_ERROR_LOG || []).length === 0 ? "No errors recorded." : (window.__LTP_ERROR_LOG || []).length + " error" + ((window.__LTP_ERROR_LOG || []).length !== 1 ? "s" : "") + " recorded.")),
        (window.__LTP_ERROR_LOG || []).length > 0 && h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
          (window.__LTP_ERROR_LOG || []).slice().reverse().slice(0, 10).map(function(err, i) {
            return h("div", { key: i, style: { background: B.danger + "08", border: "1px solid " + B.danger + "22", borderRadius: "6px", padding: "8px 12px" } },
              h("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: 4 } },
                h("span", { style: { fontSize: "10px", fontWeight: 700, color: B.danger } }, err.module),
                h("span", { style: { fontSize: "9px", color: B.textMut } }, err.timestamp ? err.timestamp.substring(0, 19).replace("T", " ") : "")),
              h("div", { style: { fontSize: "10px", color: B.textSec, wordBreak: "break-word" } }, err.message));
          }),
          h("div", { style: { display: "flex", gap: 8, marginTop: 8 } },
            h("button", { onClick: function() {
              var text = (window.__LTP_ERROR_LOG || []).map(function(e) {
                return "[" + e.timestamp + "] " + e.module + ": " + e.message + "\n" + (e.stack || "") + "\n" + (e.componentStack || "");
              }).join("\n---\n");
              if (navigator.clipboard) navigator.clipboard.writeText(text);
            }, style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "4px", padding: "4px 12px", color: B.textMut, fontSize: "10px", cursor: "pointer", fontFamily: "inherit" } }, "\u2398 Copy All"),
            h("button", { onClick: function() { window.__LTP_ERROR_LOG = []; set("_errorClear", Date.now()); },
              style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "4px", padding: "4px 12px", color: B.textMut, fontSize: "10px", cursor: "pointer", fontFamily: "inherit" } }, "Clear Log"))
        )
      ),

      dlg && h(window.LTPConfirmDialog, { dlg: dlg, onCancel: function() { setDlg(null); } })
    );
  };
})();
