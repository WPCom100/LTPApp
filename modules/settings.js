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
    // Owned-state guard — see theme.js. Synchronous global mirror prevents
    // a save+nav from flashing a bogus "unsaved changes" prompt.
    var unsavedPair = window.LTP_useUnsavedGuard();
    var isDirty = unsavedPair[0];
    var setIsDirty = unsavedPair[1];
    var [saved, setSaved] = useState(false);
    var [dlg, setDlg] = useState(null);
    var cleanRef = useRef(settings);
    // Clean snapshot of the team-member rows — used to diff which users
    // changed on Save and to revert them on Discard. Team-member edits now
    // flow through the page's Save button instead of auto-saving on blur.
    var usersCleanRef = useRef(null);
    // Team Members section — fetched from /api/users (admin-only on the
    // backend so a non-admin reaching this view sees a graceful empty list
    // + a 403 message, not a crash). users is null while loading, [] for
    // empty, otherwise an array of user dicts.
    var [users, setUsers] = useState(null);
    var [usersErr, setUsersErr] = useState(null);
    // QuickBooks Online connection status (non-secret booleans + masked
    // metadata from /api/qbo/status). null while loading.
    var [qbo, setQbo] = useState(null);

    useEffect(function() { setDraft(Object.assign({}, settings)); cleanRef.current = settings; setIsDirty(false); }, []);

    function loadUsers() {
      fetch("/api/users")
        .then(function(r) {
          if (r.status === 403) { setUsers([]); setUsersErr("Admin access required to manage team members."); return null; }
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then(function(data) { if (data) { setUsers(data); usersCleanRef.current = data.map(function(u) { return Object.assign({}, u); }); setUsersErr(null); } })
        .catch(function(e) { setUsers([]); setUsersErr("Could not load users: " + String(e.message || e)); });
    }
    useEffect(loadUsers, []);

    function patchUser(userId, patch) {
      // Optimistic update — apply the patch locally so the UI doesn't feel
      // laggy, then reconcile with the server response. On error, reload
      // the canonical list so the optimistic change doesn't stick.
      setUsers(function(prev) {
        if (!Array.isArray(prev)) return prev;
        return prev.map(function(u) { return u.id === userId ? Object.assign({}, u, patch) : u; });
      });
      fetch("/api/users/" + userId, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      })
        .then(function(r) {
          if (!r.ok) return r.json().then(function(err) { throw new Error(err.detail && err.detail.reason ? err.detail.reason : "HTTP " + r.status); });
          return r.json();
        })
        .then(function(saved) {
          setUsers(function(prev) {
            if (!Array.isArray(prev)) return prev;
            return prev.map(function(u) { return u.id === userId ? saved : u; });
          });
          // Reconcile the clean snapshot to the authoritative server row so a
          // later edit diffs against what's actually persisted.
          if (Array.isArray(usersCleanRef.current)) {
            usersCleanRef.current = usersCleanRef.current.map(function(u) { return u.id === userId ? saved : u; });
          }
          setUsersErr(null);
        })
        .catch(function(e) {
          setUsersErr("Save failed: " + String(e.message || e));
          loadUsers();  // reload to drop the stale optimistic patch
        });
    }

    // Apply a team-member edit to local state and mark the page dirty (the PUT
    // is deferred to Save, so title/phone/role join the page's Save/Discard
    // flow instead of auto-saving on blur).
    function editUser(userId, patch) {
      setUsers(function(prev) {
        if (!Array.isArray(prev)) return prev;
        return prev.map(function(u) { return u.id === userId ? Object.assign({}, u, patch) : u; });
      });
      setIsDirty(true);
    }

    function loadQbo() {
      fetch("/api/qbo/status", { credentials: "include" })
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(s) { if (s) setQbo(s); })
        .catch(function() {});
    }
    useEffect(loadQbo, []);

    function connectQbo() { window.location.href = "/api/qbo/connect"; }
    function disconnectQbo() {
      setDlg({ title: "Disconnect QuickBooks",
        message: "Disconnect QuickBooks? Invoices already pushed stay in QuickBooks, but you won't be able to push or update invoices until you reconnect.",
        variant: "danger", confirmLabel: "Disconnect",
        onConfirm: function() {
          fetch("/api/qbo/disconnect", { method: "POST", credentials: "include" })
            .then(function() { setDlg(null); loadQbo(); if (window.LTP_toast) window.LTP_toast("QuickBooks disconnected", { variant: "info" }); })
            .catch(function() { setDlg(null); loadQbo(); if (window.LTP_toast) window.LTP_toast("Disconnect failed", { message: "Could not reach the server — try again.", variant: "error" }); });
        } });
    }

    function set(key, val) {
      setDraft(function(d) { var n = Object.assign({}, d); n[key] = val; return n; });
      setIsDirty(true);
    }

    function save() {
      setSettings(draft);
      cleanRef.current = draft;
      // Persist team-member edits (title/phone/role) that differ from the
      // loaded snapshot. Each PUT goes through patchUser, which reconciles
      // users + usersCleanRef on success and surfaces an error + reloads on
      // failure (e.g. a rejected role change).
      var clean = usersCleanRef.current;
      if (Array.isArray(users) && Array.isArray(clean)) {
        users.forEach(function(u) {
          var c = clean.find(function(x) { return x.id === u.id; });
          if (!c) return;
          var patch = {};
          if ((u.title || "") !== (c.title || "")) patch.title = u.title || "";
          if ((u.phone || "") !== (c.phone || "")) patch.phone = u.phone || "";
          if ((u.role || "member") !== (c.role || "member")) patch.role = u.role || "member";
          if (Object.keys(patch).length > 0) patchUser(u.id, patch);
        });
      }
      setIsDirty(false);
      setSaved(true);
      setTimeout(function() { setSaved(false); }, 2000);
    }

    function discard() {
      setDraft(Object.assign({}, cleanRef.current));
      // Revert team-member edits to the loaded snapshot as well.
      if (Array.isArray(usersCleanRef.current)) {
        setUsers(usersCleanRef.current.map(function(u) { return Object.assign({}, u); }));
      }
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

      // ── Email Signature Template ───────────────────────────────────────────
      // Single workspace-wide HTML template. The send pipeline substitutes
      // {{userName}}/{{userEmail}}/{{userTitle}}/{{userPhone}}/{{userPhoto}} against the
      // sender's User row when an email body contains {{signature}}. Stored
      // pre-sanitized server-side (PUT /api/settings runs email_html on it).
      h("div", { style: sectionStyle },
        h("div", { style: sectionTitle }, "Email Signature Template"),
        h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 10, lineHeight: 1.5 } },
          "HTML signature rendered per-user when a template body uses ",
          h("code", { style: { background: B.raised, padding: "1px 4px", borderRadius: "3px", fontSize: "10px" } }, "{{signature}}"),
          ". Per-user values come from each team member's Title and Phone (edit below)."),
        h("div", { style: { background: B.bg, borderRadius: "6px", padding: "6px 10px", marginBottom: 10, border: "1px solid " + B.border } },
          h("div", { style: { fontSize: "9px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 } }, "Available variables"),
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
            ["userName", "userEmail", "userTitle", "userPhone", "userPhoto"].map(function(v) {
              return h("span", { key: v, style: { fontSize: "9px", background: B.accent + "22", color: B.accent, border: "1px solid " + B.accent + "44", padding: "2px 6px", borderRadius: "3px", fontFamily: "monospace", fontWeight: 600 } }, "{{" + v + "}}");
            }))
        ),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
          // Left: raw HTML textarea
          h("div", null,
            h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4, fontWeight: 600 } }, "HTML"),
            h("textarea", { value: draft.emailSignatureTemplate || "",
              onChange: function(e) { set("emailSignatureTemplate", e.target.value); },
              style: { width: "100%", minHeight: 140, background: B.bg, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px", color: B.text, fontSize: "11px", fontFamily: "monospace", outline: "none", resize: "vertical", lineHeight: 1.5 } })
          ),
          // Right: sanitized preview rendered with placeholder values so the
          // admin sees what a real send will look like
          h("div", null,
            h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4, fontWeight: 600 } }, "Preview (sample values)"),
            h("div", {
              style: { width: "100%", minHeight: 140, background: B.bg, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px", color: B.text, fontSize: "11px", lineHeight: 1.5, overflowY: "auto" },
              dangerouslySetInnerHTML: { __html: window.LTP_SANITIZE.emailHtml(window.LTP_textToHtml(
                // Fall back to the data/settings.js default when the draft
                // signature is empty/missing, so admins editing a fresh
                // install see the rich starter template they'll get sent.
                // Sample values for name/title/phone/email; {{userPhoto}}
                // uses the admin's OWN photo so they see a real image
                // (their own) rather than a placeholder.
                (draft.emailSignatureTemplate || (window.LTP_DATA_SETTINGS || {}).emailSignatureTemplate || "")
                  .replace(/\{\{userName\}\}/g, "Sarah Chen")
                  .replace(/\{\{userTitle\}\}/g, "Production Manager")
                  .replace(/\{\{userPhone\}\}/g, "(555) 123-4567")
                  .replace(/\{\{userEmail\}\}/g, "sarah@example.com")
                  .replace(/\{\{userPhoto\}\}/g, window.LTP_SENDER_PHOTO || window.LTP_SIGNATURE_PHOTO_FALLBACK)
              )) }
            })
          )
        )
      ),

      // ── Email Header Template ──────────────────────────────────────────────
      // Customer-facing banner block at the top of quote / invoice / receipt
      // emails. The send pipeline expands {{header}} into this HTML with
      // per-entity tokens ({{refNumber}}, {{projectName}}, {{total}})
      // substituted client-side; {{viewUrl}} is left literal for the
      // backend's per-recipient resolver. Stored pre-sanitized server-side
      // (PUT /api/settings runs email_html on it, same as the signature).
      h("div", { style: sectionStyle },
        h("div", { style: sectionTitle }, "Email Header Template"),
        h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 10, lineHeight: 1.5 } },
          "HTML banner rendered at the top of customer emails when a template body uses ",
          h("code", { style: { background: B.raised, padding: "1px 4px", borderRadius: "3px", fontSize: "10px" } }, "{{header}}"),
          ". Per-entity values (refNumber, projectName, total) come from the quote or invoice; viewUrl is per-recipient and resolved at send time."),
        h("div", { style: { background: B.bg, borderRadius: "6px", padding: "6px 10px", marginBottom: 10, border: "1px solid " + B.border } },
          h("div", { style: { fontSize: "9px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 } }, "Available variables"),
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
            ["viewUrl", "refNumber", "projectName", "total"].map(function(v) {
              return h("span", { key: v, style: { fontSize: "9px", background: B.accent + "22", color: B.accent, border: "1px solid " + B.accent + "44", padding: "2px 6px", borderRadius: "3px", fontFamily: "monospace", fontWeight: 600 } }, "{{" + v + "}}");
            }))
        ),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
          // Left: raw HTML textarea
          h("div", null,
            h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4, fontWeight: 600 } }, "HTML"),
            h("textarea", { value: draft.emailHeaderTemplate || "",
              onChange: function(e) { set("emailHeaderTemplate", e.target.value); },
              style: { width: "100%", minHeight: 140, background: B.bg, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px", color: B.text, fontSize: "11px", fontFamily: "monospace", outline: "none", resize: "vertical", lineHeight: 1.5 } })
          ),
          // Right: sanitized preview with sample per-entity values so the
          // admin sees a realistic banner. {{viewUrl}} is given a sample
          // URL ("#preview") rather than left literal so the View button
          // looks plausibly clickable in the preview pane.
          h("div", null,
            h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4, fontWeight: 600 } }, "Preview (sample values)"),
            h("div", {
              style: { width: "100%", minHeight: 140, background: B.bg, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px", color: B.text, fontSize: "11px", lineHeight: 1.5, overflowY: "auto" },
              dangerouslySetInnerHTML: { __html: window.LTP_SANITIZE.emailHtml(window.LTP_textToHtml(
                (draft.emailHeaderTemplate || (window.LTP_DATA_SETTINGS || {}).emailHeaderTemplate || "")
                  .replace(/\{\{viewUrl\}\}/g, "#preview")
                  .replace(/\{\{refNumber\}\}/g, "QT-2026-007")
                  .replace(/\{\{projectName\}\}/g, "Spring Showcase")
                  .replace(/\{\{total\}\}/g, "$1,234.00")
              )) }
            })
          )
        )
      ),

      // ── Team Members ───────────────────────────────────────────────────────
      // Admin-only roster of users who have signed in. Editable: title,
      // phone, role. Identity fields (name/email/picture) come from Google
      // and refresh on every login — not editable here. Self-demotion is
      // blocked server-side.
      h("div", { style: sectionStyle },
        h("div", { style: sectionTitle }, "Team Members"),
        h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 10, lineHeight: 1.5 } },
          "Title and Phone feed the email signature template above. Role changes take effect on the user's next request — they don't need to sign out."),
        usersErr && h("div", { style: { background: B.danger + "08", border: "1px solid " + B.danger + "22", borderRadius: "6px", padding: "8px 12px", fontSize: "11px", color: B.danger, marginBottom: 10 } }, usersErr),
        users === null && !usersErr && h("div", { style: { fontSize: "11px", color: B.textMut, fontStyle: "italic" } }, "Loading team members…"),
        Array.isArray(users) && users.length === 0 && !usersErr && h("div", { style: { fontSize: "11px", color: B.textMut, fontStyle: "italic" } }, "No team members yet."),
        // Team Members rows use raw <input> / <select> instead of LTPInput /
        // LTPSelect deliberately: LTPInput renders an above-the-field label
        // wrapper, which would break the single-row grid alignment. Raw
        // controls keep all five cells on the same visual baseline.
        Array.isArray(users) && users.length > 0 && h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
          users.map(function(u) {
            return h("div", { key: u.id,
              style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "10px 12px", display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 0.8fr 0.8fr", gap: 8, alignItems: "center" } },
              // Identity (read-only): circular Google profile photo + name/email.
              // The photo is the same image that feeds {{userPhoto}} in the
              // email signature template — showing it here makes it visible to
              // the admin which photo each team member's signature will use.
              h("div", { style: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 } },
                // URL scheme guard: only render an <img> when pictureUrl is
                // explicitly http(s). CSP would already block javascript:/
                // data: at runtime, but rejecting them here means a stored
                // bad value can't even reach the DOM. Falls back to the
                // initial-letter placeholder otherwise.
                (u.pictureUrl && /^https?:\/\//i.test(u.pictureUrl))
                  ? h("img", { src: u.pictureUrl, alt: u.name || u.email,
                      style: { width: 32, height: 32, borderRadius: "50%", objectFit: "cover", flexShrink: 0, border: "1px solid " + B.border } })
                  : h("div", { style: { width: 32, height: 32, borderRadius: "50%", background: B.bg, border: "1px solid " + B.border, display: "flex", alignItems: "center", justifyContent: "center", color: B.textMut, fontSize: "11px", fontWeight: 700, flexShrink: 0 } },
                      (u.name || u.email || "?").charAt(0).toUpperCase()),
                h("div", { style: { display: "flex", flexDirection: "column", minWidth: 0, flex: 1 } },
                  h("div", { style: { fontSize: "12px", fontWeight: 600, color: B.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, u.name || u.email),
                  h("div", { style: { fontSize: "10px", color: B.textMut, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, u.email),
                  u.gmailConnected === false && h("div", { style: { fontSize: "9px", color: B.warn, marginTop: 2 } }, "Gmail not connected")
                )
              ),
              // Title (editable — joins the page's Save/Discard flow)
              h("input", { type: "text", value: u.title || "", placeholder: "Title",
                onChange: function(e) { editUser(u.id, { title: e.target.value }); },
                style: { background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "5px 8px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none" }
              }),
              // Phone (editable — joins the page's Save/Discard flow)
              h("input", { type: "text", value: u.phone || "", placeholder: "Phone",
                onChange: function(e) { editUser(u.id, { phone: e.target.value }); },
                style: { background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "5px 8px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none" }
              }),
              // Role (editable — joins the page's Save/Discard flow)
              h("select", { value: u.role || "member",
                onChange: function(e) { editUser(u.id, { role: e.target.value }); },
                style: { background: B.bg, border: "1px solid " + B.border, borderRadius: "4px", padding: "5px 6px", color: B.text, fontSize: "11px", fontFamily: "inherit", outline: "none" } },
                h("option", { value: "member" }, "Member"),
                h("option", { value: "admin" }, "Admin")
              ),
              // Last login (read-only display, helps admins spot stale accounts)
              h("div", { style: { fontSize: "10px", color: B.textMut, textAlign: "right", whiteSpace: "nowrap" } },
                u.lastLogin ? "Last seen " + u.lastLogin.substring(0, 10) : "Never signed in")
            );
          })
        )
      ),

      // ── QuickBooks Online ──────────────────────────────────────────────────
      // Company-wide accounting connection (admin-managed). Tokens live
      // encrypted server-side; this panel only ever sees booleans + masked
      // metadata. See backend/routes/qbo.py.
      h("div", { style: sectionStyle },
        h("div", { style: sectionTitle }, "QuickBooks Online"),
        h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 12, lineHeight: 1.5 } },
          "Connect your QuickBooks Online company to push generated invoices. Customers and products/services are created in QuickBooks automatically if they're missing, and QuickBooks calculates sales tax. The connection is company-wide."),
        qbo === null && h("div", { style: { fontSize: "11px", color: B.textMut, fontStyle: "italic" } }, "Checking connection…"),
        qbo && qbo.configured === false && h("div", { style: { background: B.warn + "10", border: "1px solid " + B.warn + "33", borderRadius: "6px", padding: "8px 12px", fontSize: "11px", color: B.warn, marginBottom: 10 } },
          "QuickBooks credentials are not configured on the server. Set QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI and QBO_ENVIRONMENT, then redeploy."),
        qbo && !qbo.connected && h("button", { onClick: connectQbo, disabled: qbo.configured === false,
          style: { background: qbo.configured === false ? B.raised : "#2CA01C", border: "1px solid " + (qbo.configured === false ? B.border : "#2CA01C"), borderRadius: "6px", padding: "8px 16px", color: qbo.configured === false ? B.textMut : "#fff", fontSize: "12px", fontWeight: 700, fontFamily: "inherit", cursor: qbo.configured === false ? "not-allowed" : "pointer" } }, "Connect QuickBooks"),
        qbo && qbo.connected && h("div", { style: { background: B.raised, border: "1px solid " + B.border, borderRadius: "6px", padding: "12px 14px" } },
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 } },
            h("span", { style: { width: 8, height: 8, borderRadius: "50%", background: qbo.needsReconnect ? B.warn : B.success, display: "inline-block" } }),
            h("span", { style: { fontSize: "12px", fontWeight: 700, color: B.text } }, qbo.needsReconnect ? "Reconnect required" : "Connected"),
            h("span", { style: { fontSize: "9px", fontWeight: 700, color: qbo.environment === "production" ? B.success : B.warn, background: (qbo.environment === "production" ? B.success : B.warn) + "18", border: "1px solid " + (qbo.environment === "production" ? B.success : B.warn) + "44", padding: "2px 7px", borderRadius: "4px", textTransform: "uppercase", letterSpacing: "0.05em" } }, qbo.environment || "sandbox")),
          h("div", { style: { fontSize: "11px", color: B.textMut, lineHeight: 1.6 } },
            h("div", null, "Company (realm): ", h("span", { style: { color: B.textSec } }, qbo.realmMasked || "—")),
            qbo.connectedBy && h("div", null, "Connected by ", h("span", { style: { color: B.textSec } }, qbo.connectedBy), qbo.connectedAt ? " on " + qbo.connectedAt.substring(0, 10) : ""),
            qbo.refreshTokenExpiresAt && h("div", null, "Authorization valid until ", h("span", { style: { color: B.textSec } }, qbo.refreshTokenExpiresAt.substring(0, 10)))),
          h("div", { style: { display: "flex", gap: 8, marginTop: 12 } },
            qbo.needsReconnect && h("button", { onClick: connectQbo, style: { background: "#2CA01C", border: "none", borderRadius: "6px", padding: "6px 14px", color: "#fff", fontSize: "11px", fontWeight: 700, fontFamily: "inherit", cursor: "pointer" } }, "Reconnect"),
            h("button", { onClick: disconnectQbo, style: { background: "transparent", border: "1px solid " + B.border, borderRadius: "6px", padding: "6px 14px", color: B.danger, fontSize: "11px", fontWeight: 600, fontFamily: "inherit", cursor: "pointer" } }, "Disconnect")))
      ),

      // ── Email Templates ────────────────────────────────────────────────────
      h("div", { style: sectionStyle },
        h("div", { style: sectionTitle }, "Email Templates"),
        h("div", { style: { fontSize: "11px", color: B.textMut, marginBottom: 14, lineHeight: 1.5 } },
          "Customize email templates for quotes, invoices, and crew. Use ", h("code", { style: { background: B.raised, padding: "1px 4px", borderRadius: "3px", fontSize: "10px" } }, "{{variable}}"), " placeholders for dynamic content."),
        h("div", { style: { background: B.bg, borderRadius: "6px", padding: "8px 12px", marginBottom: 14, border: "1px solid " + B.border } },
          h("div", { style: { fontSize: "9px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 } }, "Available Variables"),
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
            // Keep this list in sync with the canonical Available
            // comment in data/settings.js (above emailTemplates). The
            // order groups by usage: entity fields → money/dates →
            // block-level placeholders (signature/header expand to
            // HTML) → crew-specific → quote-specific → per-recipient.
            ["companyName", "refNumber", "projectName", "clientName", "total", "dueDate", "lineItems", "signature", "header", "crewName", "role", "date", "callTime", "wrapTime", "location", "quoteValidity", "viewUrl"].map(function(v) {
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
                    h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 } },
                      h(window.LTPInput, { label: "Subject", value: tmpl.subject || "",
                        onChange: function(v) {
                          var t2 = Object.assign({}, templates);
                          t2[key] = Object.assign({}, tmpl, { subject: v });
                          set("emailTemplates", t2);
                        }, placeholder: "Email subject with {{variables}}" }),
                      h(window.LTPInput, { label: "CC (optional)", value: tmpl.cc || "",
                        onChange: function(v) {
                          var t2 = Object.assign({}, templates);
                          t2[key] = Object.assign({}, tmpl, { cc: v });
                          set("emailTemplates", t2);
                        }, placeholder: "comma-separated emails" })
                    ),
                    // Split-pane body editor: raw HTML on the left, sanitized
                    // live preview on the right. Preview pipes through
                    // LTP_SANITIZE.emailHtml so what the admin sees matches
                    // what the recipient will actually get (backend re-sanitizes
                    // at send time using a near-identical allowlist).
                    h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 } },
                      h("div", null,
                        h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4, fontWeight: 600 } }, "Body (HTML)"),
                        h("textarea", { value: tmpl.body || "",
                          onChange: function(e) {
                            var t2 = Object.assign({}, templates);
                            t2[key] = Object.assign({}, tmpl, { body: e.target.value });
                            set("emailTemplates", t2);
                          },
                          style: { width: "100%", minHeight: 160, background: B.bg, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px", color: B.text, fontSize: "11px", fontFamily: "monospace", outline: "none", resize: "vertical", lineHeight: 1.5 } })
                      ),
                      h("div", null,
                        h("div", { style: { fontSize: "10px", color: B.textMut, marginBottom: 4, fontWeight: 600 } }, "Preview"),
                        h("div", {
                          style: { width: "100%", minHeight: 160, background: B.bg, border: "1px solid " + B.border, borderRadius: "6px", padding: "8px", color: B.text, fontSize: "11px", lineHeight: 1.5, overflowY: "auto" },
                          // textToHtml first so plain-text templates keep
                          // their paragraph spacing (admin can type
                          // newlines without authoring <p> tags by hand).
                          dangerouslySetInnerHTML: { __html: window.LTP_SANITIZE.emailHtml(window.LTP_textToHtml(tmpl.body || "")) }
                        })
                      )
                    )
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
