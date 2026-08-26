// Inline entity add/edit — create or fix the record you're picking, without
// leaving the page you're on.
//
// WHY
//   Every entity picker in the app used to dead-end when the record you wanted
//   didn't exist yet: building a quote for a brand-new client meant abandoning
//   the draft, going to CRM, creating the company, and navigating back. Worse,
//   the typeahead fields hid their dropdown entirely when nothing matched, so
//   the "it isn't here" case looked like a broken search box.
//
// HOW
//   ONE host (window.LTPEntityFormHost) is mounted at the app root, where all
//   the persistent state setters live. It publishes a global imperative opener:
//
//     window.LTP_openEntityForm({
//       kind: "company" | "contact" | "project",
//       id: null,                            // null → create; an id → edit it
//       prefill: { name: "Dallas Thea" },    // create-mode seed (ignored on edit)
//       onSaved: function(record) { ... },   // record carries its new/kept id
//     });
//
//   Because the host owns the writes, no picker needs setCompanies /
//   setContacts / setProjects threaded down to it. That matters: the quote
//   builder was never handed setCompanies and the invoice builder was never
//   handed setProjects, so without this indirection half the pickers in the app
//   simply could not create anything.
//
//   Requests STACK. Creating a project from a quote, then creating that
//   project's company from inside the project form, both work — each modal
//   sits above the one that opened it (z-index climbs per depth).
//
// SCOPE — deliberately only the three "client record" kinds. Fixed or
// enumerated lists must NOT be added here: picking a crew member is picking
// from a roster, and statuses / categories / QuickBooks accounts aren't ours to
// author. If you find yourself adding a kind, check that the user is naming a
// new record rather than choosing from a known set.
(function() {
  var h = React.createElement, useState = React.useState, useEffect = React.useEffect, useRef = React.useRef;
  var B = window.LTP_THEME;

  // The closed set of authorable kinds. The label is the lowercase noun used in
  // every affordance's tooltip and create row ("Add a new company").
  var KIND_LABEL = { company: "company", contact: "contact", project: "project" };
  window.LTP_ENTITY_KIND_LABEL = KIND_LABEL;

  var _handler = null;   // installed by the mounted host; null when unmounted
  var _seq = 0;

  // Open a create/edit form. Returns false (and warns) rather than throwing if
  // the kind is unknown or the host isn't mounted, so a picker can call this
  // without defensive wrapping.
  window.LTP_openEntityForm = function(req) {
    if (!req || !KIND_LABEL[req.kind]) {
      console.warn("[LTP] openEntityForm: unsupported kind", req && req.kind);
      return false;
    }
    if (!_handler) {
      console.warn("[LTP] openEntityForm: no LTPEntityFormHost mounted");
      return false;
    }
    _handler(req);
    return true;
  };

  // Turn whatever the user typed in the picker's search box into a seed for the
  // create form, so typing "Dallas Thea" and clicking create lands in a form
  // that already knows the name.
  window.LTP_entityPrefillFromQuery = function(kind, query) {
    var q = String(query == null ? "" : query).trim();
    if (!q) return {};
    if (kind === "contact") {
      var parts = q.split(/\s+/);
      return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
    }
    return { name: q };
  };

  window.LTP_entityIdOf = function(rec) { return rec && rec.id != null ? rec.id : null; };

  // ── Affordances ───────────────────────────────────────────────────────────

  // The ＋ / ✎ button that rides at the right edge of a picker field (or beside
  // a native <select>'s label). Shows ✎ when something is selected, ＋ when not.
  // onMouseDown preventDefault keeps a typeahead's onBlur from closing the
  // dropdown out from under the click.
  window.LTPEntityQuickAction = function({ kind, id, prefill, onSaved, size, title }) {
    if (!KIND_LABEL[kind]) return null;
    var noun = KIND_LABEL[kind];
    var editing = id != null;
    var s = size || 26;
    var tip = title || (editing ? "Edit this " + noun : "Add a new " + noun);
    return h("button", {
      type: "button",
      "aria-label": tip,
      title: tip,
      className: "ltp-tap",
      onMouseDown: function(e) { e.preventDefault(); },
      onClick: function(e) {
        e.preventDefault();
        e.stopPropagation();
        window.LTP_openEntityForm({
          kind: kind,
          id: editing ? id : null,
          prefill: editing ? null : (prefill || null),
          onSaved: onSaved,
        });
      },
      style: {
        flexShrink: 0, width: s, height: s, borderRadius: (s <= 18 ? 4 : 6) + "px", padding: 0,
        background: "transparent", border: "1px solid " + B.border, color: B.accent,
        // Glyph and corner scale with the box, so a label-row instance sized to
        // LTP_FIELD_LABEL_HEIGHT still reads as the same control rather than a
        // 15px "+" crammed into a 16px square. The ratios reproduce the
        // original 12/15px at the default size of 26.
        fontSize: Math.max(9, Math.round(s * (editing ? 0.46 : 0.58))) + "px",
        lineHeight: 1, cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit",
      },
    }, editing ? "✎" : "+");
  };

  // The "＋ Create …" row that closes out a typeahead's result list. This is the
  // fix for the old dead-end: the dropdown now stays open on zero matches and
  // offers to author the thing you were searching for.
  window.LTPEntityCreateRow = function({ kind, query, prefill, onSaved, first }) {
    if (!KIND_LABEL[kind]) return null;
    var noun = KIND_LABEL[kind];
    var q = String(query == null ? "" : query).trim();
    var seed = Object.assign({}, window.LTP_entityPrefillFromQuery(kind, q), prefill || {});
    return h("div", {
      onMouseDown: function(e) { e.preventDefault(); },
      onClick: function() {
        window.LTP_openEntityForm({ kind: kind, id: null, prefill: seed, onSaved: onSaved });
      },
      style: {
        padding: "9px 12px", fontSize: "12px", cursor: "pointer", color: B.accent,
        fontWeight: 600, background: B.accentMuted,
        borderTop: first ? "none" : "1px solid " + B.border,
        display: "flex", alignItems: "center", gap: 6,
      },
    },
      h("span", { style: { fontSize: "14px", lineHeight: 1 } }, "+"),
      q ? h("span", null, "Create “" + q + "” as a new " + noun)
        : h("span", null, "Add a new " + noun));
  };

  // ── Host ──────────────────────────────────────────────────────────────────

  function nextId(list) {
    return Math.max.apply(null, (list || []).map(function(x) { return x.id; }).concat([0])) + 1;
  }

  // Mounted once, at the app root. Props are the three entity arrays and their
  // setters — nothing else in the app needs to know this exists.
  window.LTPEntityFormHost = function(props) {
    var stackPair = useState([]);
    var stack = stackPair[0], setStack = stackPair[1];
    var noticePair = useState(null);
    var notice = noticePair[0], setNotice = noticePair[1];

    // Save handlers run from modal callbacks long after render, so they read
    // state through a ref rather than the closed-over props — otherwise a
    // second create in the same session would compute its id from a stale array
    // and collide with the first.
    var pRef = useRef(props);
    pRef.current = props;

    useEffect(function() {
      _handler = function(req) {
        _seq++;
        var entry = {
          key: "eqf-" + _seq,
          kind: req.kind,
          id: (req.id == null ? null : req.id),
          prefill: req.prefill || null,
          onSaved: typeof req.onSaved === "function" ? req.onSaved : null,
        };
        setStack(function(s) { return s.concat([entry]); });
      };
      return function() { _handler = null; };
    }, []);

    function close(key) {
      setStack(function(s) { return s.filter(function(e) { return e.key !== key; }); });
    }

    // Create / update, mirroring the canonical call sites so behaviour stays
    // identical wherever a record is authored from:
    //   company → modules/crm-shell.js:240   contact → modules/crm-shell.js:255
    //   project → modules/projects.js:275 (create) / :283 (edit)
    // Returns the saved record (with its id) or null if the save was aborted.
    function commit(entry, d) {
      var p = pRef.current;
      var creating = entry.id == null;

      if (entry.kind === "company") {
        if (creating) {
          var newComp = Object.assign({ id: nextId(p.companies) }, entry.prefill || {}, d);
          p.setCompanies(function(prev) { return prev.concat([newComp]); });
          return newComp;
        }
        var comp = (p.companies || []).find(function(c) { return c.id === entry.id; });
        if (!comp) return null;
        var mergedComp = Object.assign({}, comp, d);
        p.setCompanies(function(prev) {
          return prev.map(function(c) { return c.id === entry.id ? Object.assign({}, c, d) : c; });
        });
        return mergedComp;
      }

      if (entry.kind === "contact") {
        if (creating) {
          // Same duplicate guard the CRM add form uses — a quote builder is if
          // anything MORE likely to mint a second "John Smith" than CRM is.
          var dupes = (p.contacts || []).filter(function(c) {
            if (d.firstName && d.lastName && c.firstName && c.lastName
                && c.firstName.toLowerCase() === d.firstName.toLowerCase()
                && c.lastName.toLowerCase() === d.lastName.toLowerCase()) return true;
            if (d.email && c.email && c.email.toLowerCase() === d.email.toLowerCase()) return true;
            return false;
          });
          if (dupes.length > 0) {
            var names = dupes.map(function(c) {
              return c.firstName + " " + c.lastName + (c.email ? " (" + c.email + ")" : "");
            }).join(", ");
            if (!window.confirm("A similar contact already exists:\n\n" + names + "\n\nCreate anyway?")) return null;
          }
          var newContact = Object.assign({ id: nextId(p.contacts) }, entry.prefill || {}, d);
          // The form owns companyIds, so a prefilled link would be dropped by
          // the assign above; union the two instead.
          newContact.companyIds = mergeIds((entry.prefill || {}).companyIds, d.companyIds);
          p.setContacts(function(prev) { return prev.concat([newContact]); });
          return newContact;
        }
        var ct = (p.contacts || []).find(function(c) { return c.id === entry.id; });
        if (!ct) return null;
        var mergedContact = Object.assign({}, ct, d);
        p.setContacts(function(prev) {
          return prev.map(function(c) { return c.id === entry.id ? Object.assign({}, c, d) : c; });
        });
        return mergedContact;
      }

      if (entry.kind === "project") {
        if (creating) {
          var newProject = Object.assign(
            { id: nextId(p.projects), notes: [], meetings: [] },
            entry.prefill || {}, d, { schedule: d.schedule || [] });
          p.setProjects(function(prev) { return prev.concat([newProject]); });
          return newProject;
        }
        var proj = (p.projects || []).find(function(x) { return x.id === entry.id; });
        if (!proj) return null;
        // schedule is owned by the Schedule Builder; keep it when the form
        // doesn't send one (matches modules/projects.js:284).
        var mergedProject = Object.assign({}, proj, d, { schedule: d.schedule || proj.schedule });
        p.setProjects(function(prev) {
          return prev.map(function(x) {
            return x.id === entry.id ? Object.assign({}, x, d, { schedule: d.schedule || x.schedule }) : x;
          });
        });
        return mergedProject;
      }

      return null;
    }

    function mergeIds(a, b) {
      var out = [];
      (a || []).concat(b || []).forEach(function(id) { if (out.indexOf(id) === -1) out.push(id); });
      return out;
    }

    function handleSave(entry, d) {
      var saved = commit(entry, d);
      if (!saved) return;               // aborted (duplicate declined / record vanished)
      close(entry.key);
      if (entry.onSaved) entry.onSaved(saved);
    }

    var p = props;

    // Deleting from here would bypass CRM's guided teardown (which unlinks
    // quotes, invoices, and crew assignments first), and you'd be deleting the
    // very record the page behind this modal is pointing at. Send them to CRM.
    function refuseDelete(dc) {
      setNotice({
        title: "Delete from CRM",
        message: "“" + (dc && dc.name ? dc.name : "This record")
          + "” can only be deleted from CRM, where linked quotes, invoices, and "
          + "crew assignments are reviewed first. Close this form and open CRM to delete it.",
      });
    }

    function lookup(kind, id) {
      var p = pRef.current;
      var list = kind === "company" ? p.companies : kind === "contact" ? p.contacts : p.projects;
      return (list || []).find(function(x) { return x.id === id; }) || null;
    }

    // An edit target can disappear underneath us (deleted in another tab, or in
    // CRM behind this modal). Drop those entries from an effect rather than
    // mid-render — calling close() during render would be a setState-in-render.
    useEffect(function() {
      var orphaned = stack.filter(function(e) { return e.id != null && !lookup(e.kind, e.id); });
      if (!orphaned.length) return;
      setStack(function(s) {
        return s.filter(function(e) { return e.id == null || !!lookup(e.kind, e.id); });
      });
    });

    function renderEntry(entry, depth) {
      // The stack sits above everything else in the app, including the mobile
      // create sheet (z-index 1500), and climbs with depth so a nested form
      // never renders behind its parent.
      var z = 2000 + depth * 10;
      var ctx = {
        companies: p.companies || [],
        contacts: p.contacts || [],
        projects: p.projects || [],
        setDeleteConfirm: refuseDelete,
      };
      var initial = entry.id == null ? null : lookup(entry.kind, entry.id);
      // Deleted underneath us — the effect above prunes the entry next tick.
      if (entry.id != null && !initial) return null;

      var common = {
        key: entry.key,
        ctx: ctx,
        initial: initial || null,
        prefill: entry.id == null ? (entry.prefill || null) : null,
        modalZIndex: z,
        onClose: function() { close(entry.key); },
        onSave: function(d) { handleSave(entry, d); },
      };

      if (entry.kind === "company") return h(window.CRMCompanyForm, common);
      if (entry.kind === "contact") return h(window.CRMContactForm, common);
      return h(window.CRMProjectForm, common);
    }

    // The notice is rendered directly rather than via LTPConfirmDialog because
    // it has to sit ABOVE the form stack that raised it, and the confirm dialog
    // has no way to lift its z-index.
    return h(React.Fragment, null,
      stack.map(function(entry, i) { return renderEntry(entry, i); }),
      notice && h(window.LTPModal, {
        title: notice.title, zIndex: 2000 + stack.length * 10 + 5,
        onClose: function() { setNotice(null); },
      },
        h("div", { style: { marginBottom: 16, fontSize: "13px", color: B.textSec, lineHeight: 1.5 } }, notice.message),
        h("div", { style: { display: "flex", justifyContent: "flex-end" } },
          h(window.Btn, { onClick: function() { setNotice(null); } }, "OK")))
    );
  };
})();
