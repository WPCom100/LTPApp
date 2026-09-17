// ═══════════════════════════════════════════════════════════════════════════
//   TABLE VIEWS — per-user saved sort/filter views + the standardized toolbar
// ═══════════════════════════════════════════════════════════════════════════
//
// Every desktop record list (window.LTPTable) carries the same three controls
// in the same order — filter chips, the Show/Hide toggles, then search — and,
// on the right, a small dropdown that saves the CURRENT arrangement (column
// sort + which filter chip + which toggles) as a named view. One view, named
// "Default", always exists: it can be saved over but never deleted, and it is
// what a list falls back to for a user who has saved nothing.
//
// Storage is per USER and follows them across devices: the views live in the
// User.preferences JSON column, read once via GET /api/me/preferences and
// written back per table via PUT /api/me/preferences/table-views/{key}
// (backend/routes/api.py). A signed-out or offline page simply shows every
// list in its built-in Default order — nothing here is required to render.
//
// A "view" is a plain snapshot the table owns the shape of:
//     { sort: {key,dir}, filters: {<id>: value}, toggles: {<id>: bool} }
// Search text is deliberately NOT part of it — a saved view restores how the
// list is ordered and filtered, not a stale query someone was mid-typing.
//
//   var vw = window.LTP_useTableView({
//     tableKey: "quotes",
//     defaults: DEFAULT_VIEW,               // the built-in "Default" snapshot
//     snapshot: { sort: sort, filters: { status: filter },
//                 toggles: { showConverted: showConverted } },
//     apply: function(v) {                   // set the table's own state
//       if (v.sort) setSort(v.sort);
//       if (v.filters) setFilter(v.filters.status);
//       if (v.toggles) setShowConverted(!!v.toggles.showConverted);
//     },
//   });
//   h(window.LTPTableToolbar, { isMobile: isMobile,
//     filters: chipStrip, toggles: showConvertedBtn, search: searchInput,
//     sortChips: isMobile ? sortChipsEl : null,
//     view: h(window.LTPViewMenu, { vw: vw }) })
(function() {
  "use strict";
  var h = React.createElement;
  var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef;

  var DEFAULT_NAME = "Default";

  // ── Global preferences store ────────────────────────────────────────────
  // One fetch of the whole preferences blob, shared by every table on the
  // page; writes are namespaced per table so two lists saved from different
  // tabs can't clobber each other. Optimistic: the cache updates immediately
  // and the PUT settles in the background (a failed write just means the next
  // reload re-reads the server copy).
  var STORE = { loaded: false, loading: false, data: {}, subs: [] };

  function notify() { STORE.subs.slice().forEach(function(fn) { try { fn(); } catch (e) {} }); }

  function ensureLoaded() {
    if (STORE.loaded || STORE.loading) return;
    STORE.loading = true;
    fetch("/api/me/preferences", { credentials: "include" })
      .then(function(r) { return r.ok ? r.json() : {}; })
      .then(function(j) { STORE.data = (j && typeof j === "object") ? j : {}; })
      .catch(function() { STORE.data = {}; })
      .then(function() { STORE.loaded = true; STORE.loading = false; notify(); });
  }

  function tableEntry(tableKey) {
    var tv = (STORE.data && STORE.data.tableViews) || {};
    var e = tv[tableKey];
    return (e && typeof e === "object") ? e : null;
  }

  function persistTable(tableKey, entry) {
    var data = (STORE.data && typeof STORE.data === "object") ? STORE.data : {};
    var tv = Object.assign({}, data.tableViews || {});
    tv[tableKey] = entry;
    STORE.data = Object.assign({}, data, { tableViews: tv });
    notify();
    return fetch("/api/me/preferences/table-views/" + encodeURIComponent(tableKey), {
      method: "PUT", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    }).catch(function() { /* keep the optimistic copy; a reload re-syncs */ });
  }

  window.LTP_PREFS = {
    ensureLoaded: ensureLoaded,
    isLoaded: function() { return STORE.loaded; },
    tableEntry: tableEntry,
    persistTable: persistTable,
    subscribe: function(fn) { STORE.subs.push(fn); return function() { var i = STORE.subs.indexOf(fn); if (i >= 0) STORE.subs.splice(i, 1); }; },
    // Test/reset seam — never used by the app.
    _reset: function() { STORE.loaded = false; STORE.loading = false; STORE.data = {}; },
  };

  // ── Stable structural compare (for the unsaved-changes dot) ──────────────
  // JSON.stringify with keys sorted at every level, so two snapshots built in a
  // different key order still compare equal.
  function stable(o) {
    if (o === null || typeof o !== "object") return JSON.stringify(o);
    if (Array.isArray(o)) return "[" + o.map(stable).join(",") + "]";
    return "{" + Object.keys(o).sort().map(function(k) { return JSON.stringify(k) + ":" + stable(o[k]); }).join(",") + "}";
  }
  function sameSnap(a, b) { return stable(a || {}) === stable(b || {}); }

  // ── The hook ─────────────────────────────────────────────────────────────
  window.LTP_useTableView = function(opts) {
    opts = opts || {};
    var tableKey = opts.tableKey;
    var defaults = opts.defaults || {};
    var snapshot = opts.snapshot || {};
    var apply = typeof opts.apply === "function" ? opts.apply : function() {};

    // Re-render this hook's owner whenever the shared store changes.
    var tick = useState(0);
    var rerender = function() { tick[1](function(n) { return n + 1; }); };
    useEffect(function() {
      ensureLoaded();
      return window.LTP_PREFS.subscribe(rerender);
    }, []);

    // Restore the saved active view ONCE, after the first load settles — never
    // again, or it would fight the user's own header clicks and chip taps.
    var applied = useRef(false);
    useEffect(function() {
      if (applied.current || !STORE.loaded) return;
      applied.current = true;
      var e = tableEntry(tableKey);
      if (e && e.views && e.active && e.views[e.active]) apply(e.views[e.active]);
    }, [STORE.loaded]);

    // The current entry, always with a Default present (seeded from the
    // built-in defaults) so the list can't end up with no baseline.
    var saved = tableEntry(tableKey);
    var views = Object.assign({}, (function() { var o = {}; o[DEFAULT_NAME] = defaults; return o; })(),
                              (saved && saved.views) || {});
    if (!views[DEFAULT_NAME]) views[DEFAULT_NAME] = defaults;
    var active = (saved && saved.active && views[saved.active]) ? saved.active : DEFAULT_NAME;
    var names = [DEFAULT_NAME].concat(Object.keys(views).filter(function(n) { return n !== DEFAULT_NAME; }));

    function persist(nextViews, nextActive) {
      persistTable(tableKey, { active: nextActive, views: nextViews });
    }

    return {
      ready: STORE.loaded,
      names: names,
      active: active,
      // Current on-screen state differs from what the active view saved.
      dirty: STORE.loaded && !sameSnap(snapshot, views[active]),
      canDelete: function(name) { return name !== DEFAULT_NAME; },
      select: function(name) {
        if (!views[name]) return;
        apply(views[name]);
        persist(views, name);
      },
      // Save the CURRENT on-screen arrangement under `name` (creating it or
      // overwriting a same-named view) and make it the active view.
      save: function(name) {
        name = (name || "").trim();
        if (!name) return;
        var next = Object.assign({}, views);
        next[name] = snapshot;
        persist(next, name);
      },
      remove: function(name) {
        if (name === DEFAULT_NAME || !views[name]) return;
        var next = Object.assign({}, views);
        delete next[name];
        var nextActive = active === name ? DEFAULT_NAME : active;
        if (active === name) apply(next[DEFAULT_NAME] || defaults);
        persist(next, nextActive);
      },
    };
  };

  // ── The saved-view dropdown ──────────────────────────────────────────────
  // A single small control on the right of the toolbar: the active view's name
  // (with a • when there are unsaved changes) opening a compact menu — pick a
  // view, delete a custom one, or type a name and Save. Saving the same name
  // overwrites; "Default" is offered but never gets a delete.
  window.LTPViewMenu = function(props) {
    var B = window.LTP_THEME;
    var vw = props.vw;
    var open = useState(false), isOpen = open[0], setOpen = open[1];
    var draft = useState(""), name = draft[0], setName = draft[1];
    var rootRef = useRef(null);

    // Close on outside click / Escape — the app's popovers all behave this way.
    useEffect(function() {
      if (!isOpen) return;
      function onDoc(e) { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); }
      function onKey(e) { if (e.key === "Escape") setOpen(false); }
      document.addEventListener("mousedown", onDoc);
      document.addEventListener("keydown", onKey);
      return function() { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
    }, [isOpen]);

    function openMenu() { setName(vw.active === "Default" ? "" : vw.active); setOpen(true); }
    function doSave() {
      var n = (name || "").trim() || vw.active;   // blank Save = save over the active view
      vw.save(n);
      setOpen(false);
    }

    var btn = h("button", {
      type: "button", onClick: function() { isOpen ? setOpen(false) : openMenu(); },
      title: "Saved views",
      style: { display: "flex", alignItems: "center", gap: 6, background: B.raised,
               color: B.textSec, border: "1px solid " + B.border, borderRadius: "6px",
               padding: "5px 10px", fontSize: "11px", fontWeight: 600, cursor: "pointer",
               fontFamily: "inherit", whiteSpace: "nowrap", maxWidth: 200 } },
      h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, vw.active),
      vw.dirty && h("span", { title: "Unsaved changes", style: { color: B.accent, fontSize: "13px", lineHeight: 1 } }, "•"),
      h("span", { style: { color: B.textMut, fontSize: "9px" } }, "▾"));

    var menu = isOpen && h("div", {
      style: { position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 40,
               minWidth: 190, background: B.surface, border: "1px solid " + B.border,
               borderRadius: "8px", boxShadow: "0 8px 24px rgba(0,0,0,0.28)", overflow: "hidden" } },
      // The saved views.
      h("div", { style: { maxHeight: 220, overflowY: "auto", padding: "4px" } },
        vw.names.map(function(n) {
          var isActive = n === vw.active;
          return h("div", { key: n, style: { display: "flex", alignItems: "center", gap: 6, borderRadius: "5px" } },
            h("button", { type: "button", onClick: function() { vw.select(n); setOpen(false); },
              style: { flex: 1, minWidth: 0, textAlign: "left", background: isActive ? B.accentMuted : "transparent",
                       color: isActive ? B.accent : B.text, border: "none", borderRadius: "5px",
                       padding: "6px 8px", fontSize: "12px", fontWeight: isActive ? 700 : 500,
                       cursor: "pointer", fontFamily: "inherit", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
              (isActive ? "✓ " : "") + n),
            vw.canDelete(n) && h("button", { type: "button", title: "Delete view",
              onClick: function(e) { e.stopPropagation(); vw.remove(n); },
              style: { flexShrink: 0, background: "transparent", border: "none", color: B.textMut,
                       cursor: "pointer", fontSize: "12px", padding: "4px 8px", fontFamily: "inherit" } }, "✕"));
        })),
      // Save-as row.
      h("div", { style: { display: "flex", gap: 6, padding: "8px", borderTop: "1px solid " + B.border } },
        h("input", { type: "text", value: name, placeholder: "View name…",
          onChange: function(e) { setName(e.target.value); },
          onKeyDown: function(e) { if (e.key === "Enter") { e.preventDefault(); doSave(); } },
          style: { flex: 1, minWidth: 0, background: B.bg, border: "1px solid " + B.border, borderRadius: "5px",
                   padding: "5px 8px", color: B.text, fontSize: "12px", fontFamily: "inherit", outline: "none" } }),
        h("button", { type: "button", onClick: doSave,
          style: { flexShrink: 0, background: B.accent, color: B.btnInk, border: "none", borderRadius: "5px",
                   padding: "5px 12px", fontSize: "12px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" } }, "Save")));

    return h("div", { ref: rootRef, style: { position: "relative", flexShrink: 0 } }, btn, menu);
  };

  // ── The standardized toolbar ─────────────────────────────────────────────
  // Left → right: filter chips │ Show/Hide toggles · search … (right) view menu.
  // A hairline divides the filters from the toggles. Any slot may be omitted;
  // the divider only appears when there's something on both of its sides.
  window.LTPTableToolbar = function(props) {
    var B = window.LTP_THEME;
    var isMobile = props.isMobile;
    var filters = props.filters, toggles = props.toggles, search = props.search;
    var view = props.view, sortChips = props.sortChips, action = props.action;

    function divider() {
      return h("span", { "aria-hidden": "true",
        style: { flexShrink: 0, width: 1, alignSelf: "stretch", minHeight: 20, background: B.border, margin: "0 2px" } });
    }

    if (isMobile) {
      // Phone: the chips scroll on their own line; sort + the view menu share a
      // row; the toggles and search sit under them. Stacked, but the same slots
      // in the same order.
      return h("div", { style: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 } },
        filters && h("div", null, filters),
        (sortChips || view || action) && h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
          sortChips || h("span", null),
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 } }, view || null, action || null)),
        (toggles || search) && h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
          toggles || null, search ? h("div", { style: { flex: 1, minWidth: 140 } }, search) : null));
    }

    // Desktop: one row. The left cluster carries filters │ toggles · search; the
    // saved-view menu (and any primary action, e.g. "+ New") are pushed right.
    var hasLeftAfterDivider = !!(toggles || search);
    return h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" } },
      h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flex: 1, minWidth: 0 } },
        filters ? h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 } }, filters) : null,
        (filters && hasLeftAfterDivider) ? divider() : null,
        toggles || null,
        search || null),
      (view || action) ? h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0, marginLeft: "auto" } }, view || null, action || null) : null);
  };
})();
