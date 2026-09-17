// LTP navigation registry — the declared route hierarchy, cold-entry seeding,
// tab (peer) navigation, the post-login return-to stash, and per-history-entry
// state (scroll position, list filters). Loads right after router.js.
// Design and rules: docs/NAVIGATION_DESIGN.md. Audit: docs/NAVIGATION_AUDIT.md.
//
// Parents are DECLARED here, never derived by chopping URL segments:
//   dashboard                       → (none: app home)
//   every area root / sibling tab   → dashboard        (crm/companies, rentals/kits, labor/payouts …)
//   list/new, list/:id (modals)     → the list
//   list/:id/edit, /:id/scan        → list/:id
//   quotes/new|:id, invoices/new|:id, projects/:id/schedule (full-screen
//   editors)                        → the LIST (quotes, invoices, projects)
//   crew-portal tabs                → crew-portal/overview; its auth screens → crew-portal/login
//   view/*, crew/<token>            → (none: standalone public pages, never seeded)
(function() {
  var HOME = "dashboard";
  // Modules whose list-level routes are sibling tabs of one another. `subs`
  // lists the valid tab segments (null = the bare module path is itself a
  // tab); `bare` is what an invalid or missing tab canonicalises to.
  var TABS = {
    crm:           { subs: ["companies", "contacts"], bare: "crm/companies" },
    rentals:       { subs: [null, "equipment", "containers", "kits", "cross-rentals"], bare: "rentals" },
    quotes:        { subs: [null, "products", "services", "fees", "client-rates"], bare: "quotes" },
    labor:         { subs: ["assignments", "requests", "roster", "calendar", "schedule", "payouts"], bare: "labor/assignments" },
    "crew-portal": { subs: ["overview", "schedule", "payouts", "account"], bare: "crew-portal/overview" },
  };
  var PLAIN_ROOTS = { dashboard: 1, projects: 1, calendar: 1, invoices: 1, settings: 1 };
  var STANDALONE = { view: 1, crew: 1 };
  // Crew portal auth screens: parent, or null for the sign-in root.
  var CREW_AUTH = { login: null, forgot: "crew-portal/login", "request-access": "crew-portal/login",
                    signup: "crew-portal/login", reset: "crew-portal/login", "confirm-email": "crew-portal/overview" };
  var CHILD_OF_ID = { edit: 1, scan: 1 };

  function listPath(r) { return r.module + (r.sub ? "/" + r.sub : ""); }
  function idPath(r)   { return listPath(r) + "/" + r.id; }
  function hasTab(m, sub) { return TABS[m] && TABS[m].subs.indexOf(sub) !== -1; }
  function isListLevel(r) { return r.id === null && r.action === null; }

  // parentOf(route) → path | null. route is LTPRouter.getRoute() shaped.
  function parentOf(r) {
    var m = r.module;
    if (STANDALONE[m]) return null;
    if (m === HOME) return null;
    if (m === "crew-portal") {
      if (!r.sub) return null;
      if (r.sub in CREW_AUTH) return CREW_AUTH[r.sub];
      if (r.sub === "overview") return null;
      return "crew-portal/overview";
    }
    if (m === "projects") {
      if (r.id === null) return r.action ? "projects" : HOME;   // projects/new (or junk) → list; bare → home
      if (r.action === "edit") return idPath(r);
      return "projects";            // detail modal (any tab) and the full-screen schedule editor
    }
    if (m === "invoices") return (r.id !== null || r.action === "new") ? "invoices" : HOME;
    if (m === "quotes" && !r.sub) return (r.id !== null || r.action === "new") ? "quotes" : HOME;
    if (TABS[m]) {
      if (isListLevel(r)) return HOME;                       // a tab (valid or not: canonical() fixes the URL)
      var list = hasTab(m, r.sub) ? listPath(r) : TABS[m].bare;
      if (r.id !== null && CHILD_OF_ID[r.action]) return idPath(r);
      return list;                                          // /new, /:id, or anything else under the tab
    }
    if (PLAIN_ROOTS[m]) return HOME;
    return null;                                            // unknown module: canonical() sends it home
  }

  // canonical(route) → the path this URL should be replaced with, or null if
  // it is already canonical. Bare `crm` → crm/companies, `labor` →
  // labor/assignments, an unknown module or tab → its area default / home.
  function canonical(r) {
    var m = r.module;
    if (STANDALONE[m] || m === "crew-portal") return null;   // the portal picks login/overview by auth
    if (m === HOME || m === "projects" || m === "invoices" || m === "calendar" || m === "settings") return null;
    if (TABS[m]) {
      if (hasTab(m, r.sub)) return null;
      return isListLevel(r) ? TABS[m].bare : null;           // a bad tab with an id: leave it to the module
    }
    return HOME;
  }

  // Ancestor chain, root first, excluding the route itself.
  function chainFor(r) {
    var chain = [], p = parentOf(r), guard = 0;
    while (p && guard++ < 8) { chain.unshift(p); p = parentOf(window.LTPRouter.parsePath("#/" + p)); }
    return chain;
  }

  // Two list-level routes in the same tab set are peers: switching between
  // them replaces the entry (Back leaves the area) rather than pushing.
  function tabGroup(r) {
    if (!isListLevel(r) || !TABS[r.module]) return null;
    return hasTab(r.module, r.sub) ? r.module : null;
  }
  function isPeer(a, b) { var g = tabGroup(a); return !!g && g === tabGroup(b); }
  // Tab / sub-nav click: replace when already on a sibling tab, push when
  // entering the area from elsewhere.
  function goTab(path) {
    var R = window.LTPRouter;
    var target = R.parsePath("#/" + path);
    if (isPeer(R.getRoute(), target)) R.replace(path); else R.navigate(path);
  }

  // ── Post-login return-to ─────────────────────────────────────────────────
  // The hash never reaches the server (/auth/callback lands on "/"), so the
  // requested screen is stashed in this tab before any hop to /auth/login and
  // restored — by replace, so the sign-in entry never survives — on boot.
  var RETURN_KEY = "ltp.nav.returnTo";
  function stashReturnTo() {
    var hash = String(window.location.hash || "").replace(/^#\/?/, "");
    var r = window.LTPRouter.parsePath(window.location.hash);
    if (!hash || STANDALONE[r.module] || r.module === "crew-portal") return;
    try { window.sessionStorage.setItem(RETURN_KEY, hash); } catch (e) { /* no storage: land on home */ }
  }
  function consumeReturnTo() {
    var v = null;
    try { v = window.sessionStorage.getItem(RETURN_KEY); if (v) window.sessionStorage.removeItem(RETURN_KEY); } catch (e) { /* none */ }
    return v || null;
  }

  // ── Cold-entry seeding ───────────────────────────────────────────────────
  // Call once the screen can be shown (staff: after auth resolves; portal: at
  // mount). A no-op when this session already stamped the entry (reload,
  // in-app navigation) or on a standalone public page.
  function seedIfCold() {
    var R = window.LTPRouter;
    if (R.entryKey() !== null) return false;
    var stash = consumeReturnTo();
    var route = stash ? R.parsePath("#/" + stash) : R.getRoute();
    if (STANDALONE[route.module]) return false;
    var canon = canonical(route);
    var path = canon || (stash ? stash : String(window.location.hash || "").replace(/^#\/?/, "")) || R.defaultRoute;
    var target = canon ? R.parsePath("#/" + canon) : route;
    return R.seed(chainFor(target), path);
  }

  // ── Per-entry state: scroll + list filters ───────────────────────────────
  // Keyed by the router's entryKey (sid:idx) in sessionStorage, so Back to an
  // entry restores what that entry had; a replaced entry drops its state.
  var STORE_KEY = "ltp.nav.store";
  var MAX_ENTRIES = 60;          // deepest-N kept; a session rarely goes near this
  // Parsed once and kept: this tab is the only writer, and the alternative is a
  // JSON.parse of the whole store on every render of every list hook — which on
  // a search box is once per keystroke per field.
  var cache = null;
  function readStore() {
    if (cache) return cache;
    try { cache = JSON.parse(window.sessionStorage.getItem(STORE_KEY) || "{}") || {}; }
    catch (e) { cache = {}; }
    return cache;
  }
  function writeStore(s) {
    cache = s;
    // Drop the shallowest entries when the session has wandered far. Keys are
    // "<sid>:<idx>", so the depth orders them; the entries a Back could still
    // reach are the deep ones.
    var keys = Object.keys(s);
    if (keys.length > MAX_ENTRIES) {
      keys.sort(function(a, b) { return (parseInt(a.split(":")[1], 10) || 0) - (parseInt(b.split(":")[1], 10) || 0); })
          .slice(0, keys.length - MAX_ENTRIES)
          .forEach(function(k) { delete s[k]; });
    }
    try { window.sessionStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* quota or blocked: the in-memory cache still serves this tab */ }
  }
  function entryState(key) { return key ? (readStore()[key] || null) : null; }
  function setEntryField(key, name, value) {
    if (!key) return;
    var s = readStore(); var e = s[key] || (s[key] = {}); e[name] = value; writeStore(s);
  }
  function clearEntry(key) { if (!key) return; var s = readStore(); if (s[key]) { delete s[key]; writeStore(s); } }

  var SCROLL_EL = "ltp-content";   // the shell's scrolling content div (app.js)
  function saveScroll(key) {
    var el = typeof document !== "undefined" && document.getElementById ? document.getElementById(SCROLL_EL) : null;
    if (el && key) setEntryField(key, "scroll", el.scrollTop);
  }
  // Restore the scroll saved for the current entry — call after the screen
  // for the new route has rendered (app.js does this in a route effect).
  function restoreScroll() {
    var st = entryState(window.LTPRouter.entryKey());
    var el = typeof document !== "undefined" && document.getElementById ? document.getElementById(SCROLL_EL) : null;
    // Only an entry with a remembered position is touched: opening a modal
    // over a list, or drilling in, must not scroll the list beneath it.
    if (el && st && typeof st.scroll === "number") el.scrollTop = st.scroll;
  }
  // Programmatic leaves: save (push/back) or drop (replace) the entry's state.
  if (window.LTPRouter && window.LTPRouter.onLeave) {
    window.LTPRouter.onLeave(function(key, kind) { if (kind === "replace") clearEntry(key); else saveScroll(key); });
  }
  // Hardware / browser Back never passes through the router: popstate fires
  // before React re-renders, so the old screen's scroll is still readable —
  // but history.state is already the NEW entry's, hence the remembered key.
  var lastKey = window.LTPRouter ? window.LTPRouter.entryKey() : null;
  if (window.addEventListener) {
    window.addEventListener("popstate", function() { saveScroll(lastKey); });
    window.addEventListener("hashchange", function() { lastKey = window.LTPRouter.entryKey(); });
  }

  // Like useState, but the value is remembered on the current history entry
  // and comes back when the user returns to it with Back. For list filters,
  // sort and search (which are deliberately NOT in the URL).
  window.LTP_useNavState = function(name, initial) {
    var key = window.LTPRouter.entryKey();
    var saved = entryState(key);
    var pair = React.useState(saved && (name in saved) ? saved[name] : initial);
    var ref = React.useRef(pair[0]); ref.current = pair[0];
    var setBoth = React.useCallback(function(v) {
      var next = (typeof v === "function") ? v(ref.current) : v;
      ref.current = next; pair[1](next);
      setEntryField(window.LTPRouter.entryKey(), name, next);
    }, [name]);
    // After a replace the entry's state is dropped, but this value is still
    // what is on screen — write it back so the entry stays a full record of it.
    React.useEffect(function() {
      var k = window.LTPRouter.entryKey(), s = entryState(k);
      if (k && (!s || !(name in s))) setEntryField(k, name, ref.current);
    });
    // The entry changed under a component that is still mounted — a Back to an
    // earlier entry, or a push that left this list on screen underneath a modal.
    //
    // Adopt ONLY when the new entry actually remembers a value. It is tempting
    // to fall back to `initial` otherwise, but a forward entry remembers
    // nothing yet, and opening a record's modal over a list makes exactly that:
    // the list stays mounted and visible behind the modal, so resetting emptied
    // its search box and showed every row while the modal sat on top. Keeping
    // what is on screen is right in that case, and the effect above records it
    // against the new entry so a later Back still finds it.
    //
    // Leaving for a different screen does not come through here at all: that
    // unmounts this component, and the next one starts from its own useState
    // initialiser above, so nothing leaks between lists.
    React.useEffect(function() {
      var s = entryState(key);
      if (!s || !(name in s)) return;
      var want = s[name];
      if (JSON.stringify(want) !== JSON.stringify(ref.current)) { ref.current = want; pair[1](want); }
    }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps
    return [pair[0], setBoth];
  };

  // ── A route naming a record that is not there ────────────────────────────
  // A stale bookmark, a link to something since deleted, an id typed by hand,
  // or an ancestor seeded for a record that has since gone. Sitting on a dead
  // URL is worse than it looks: Back walks back through it, a reload lands
  // nowhere, and both document builders quietly present a BLANK draft under
  // the dead id, which a user can type into and save.
  //
  // `fallback` is the path to land on. Pass it whenever the declared parent
  // could name the same dead record (`…/:id/edit` → `…/:id`): the list always
  // exists, so one replace settles it instead of a cascade.
  //
  // Callers holding an editable draft pass a verdict taken WHEN THE SCREEN
  // OPENED, not a live one. A record that vanishes while the screen is up
  // (another window deleted it) may have unsaved work on it, and yanking the
  // user out would destroy it with no explanation — modules/projects.js shows
  // a written explanation for exactly that case instead.
  window.LTP_useMissingRecord = function(isMissing, fallback) {
    React.useEffect(function() {
      if (!isMissing) return;
      var R = window.LTPRouter;
      R.replace(fallback || parentOf(R.getRoute()) || R.defaultRoute);
    }, [isMissing, fallback]);
  };

  window.LTP_NAV_REGISTRY = {
    parentOf: parentOf, chainFor: chainFor, canonical: canonical,
    tabGroup: tabGroup, isPeer: isPeer, goTab: goTab,
    stashReturnTo: stashReturnTo, consumeReturnTo: consumeReturnTo, seedIfCold: seedIfCold,
    entryState: function() { return entryState(window.LTPRouter.entryKey()); },
    setEntryField: function(name, value) { setEntryField(window.LTPRouter.entryKey(), name, value); },
    restoreScroll: restoreScroll,
    _tabs: TABS,
  };
})();
