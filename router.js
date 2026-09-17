// LTP Hash Router — unified schema with action field
//
// URL patterns (works for all modules):
//   module                   → { module, sub:null, id:null, action:null }
//   module/new               → { module, sub:null, id:null, action:"new" }
//   module/:id               → { module, sub:null, id:N,    action:null }
//   module/:id/edit          → { module, sub:null, id:N,    action:"edit" }
//   module/sub               → { module, sub,      id:null, action:null }
//   module/sub/new           → { module, sub,      id:null, action:"new" }
//   module/sub/:id           → { module, sub,      id:N,    action:null }
//   module/sub/:id/edit      → { module, sub,      id:N,    action:"edit" }
//
// Special module — public client view (token-only, no session):
//   view/quote/<token>       → { module:"view", sub:"quote",   id:<token>, action:null }
//   view/invoice/<token>     → { module:"view", sub:"invoice", id:<token>, action:null }
//   crew/<token>             → { module:"crew", sub:null, id:<token> }   (call sheet)
//   crew-portal/<screen>[/<token>] → { module:"crew-portal", sub:<screen>, id:<token|null> }
//   ?preview=1               → query.preview = "1" (used by Preview button to
//                               disable accept/decline so the LTP user doesn't
//                               accidentally finalize a quote during preview)
//
// All parsed routes now include a `query` object (parsed from anything after
// `?` in the hash). Existing modules ignore it; only the public view uses it.
//
// Examples:
//   crm/companies/5/edit              → { module:"crm",  sub:"companies", id:5, action:"edit", query:{} }
//   view/quote/abc123?preview=1       → { module:"view", sub:"quote",     id:"abc123", action:null, query:{preview:"1"} }
(function() {

  // Where a bare visit lands. The staff dashboard — unless the page says
  // otherwise: on the crew portal's own domain the server serves index.html
  // with <meta name="ltp-default-route" content="crew-portal"> (backend/
  // main.py, docs/CREW_DOMAIN.md), so a crew member typing the address reaches
  // their portal, not the staff Google sign-in. Read once at load; the tag is
  // absent on every other host and the value is validated to a route name.
  function defaultRoute() {
    try {
      var meta = (typeof document !== "undefined" && document.querySelector)
        ? document.querySelector('meta[name="ltp-default-route"]') : null;
      var v = meta && meta.getAttribute("content");
      if (v && /^[a-z][a-z-]*$/.test(v)) return v;
    } catch (e) { /* no DOM (tests) → the staff default */ }
    return "dashboard";
  }
  var DEFAULT_ROUTE = defaultRoute();

  function isNumericId(s) {
    return s && s !== "new" && s !== "edit" && !isNaN(Number(s));
  }

  function parseQuery(str) {
    var q = {};
    if (!str) return q;
    str.split("&").forEach(function(pair) {
      if (!pair) return;
      var eq = pair.indexOf("=");
      if (eq < 0) { q[decodeURIComponent(pair)] = ""; return; }
      try {
        q[decodeURIComponent(pair.substring(0, eq))] = decodeURIComponent(pair.substring(eq + 1));
      } catch (e) {
        // Malformed percent-encoding — ignore the entry rather than crash.
      }
    });
    return q;
  }

  function parsePath(hash) {
    var raw   = (hash || "").replace(/^#\/?/, "") || DEFAULT_ROUTE;
    // Split off the query portion BEFORE the path split so segments like
    // "abc?preview=1" don't end up in `id`. The "?" lives inside the hash
    // string; the browser doesn't peel it off for us.
    var qIdx  = raw.indexOf("?");
    var path  = qIdx >= 0 ? raw.substring(0, qIdx) : raw;
    var query = parseQuery(qIdx >= 0 ? raw.substring(qIdx + 1) : "");

    var parts  = path.split("/");
    var module = parts[0] || DEFAULT_ROUTE;

    // Public client view: dedicated parsing because the third segment is an
    // opaque token (non-numeric, longer than any normal ID) and the existing
    // parser would mis-classify it as an `action`.
    if (module === "view") {
      return {
        module: "view",
        sub: parts[1] || null,     // "quote" or "invoice"
        id: parts[2] || null,      // share token
        action: null,
        query: query,
      };
    }

    // Public crew-request view: #/crew/<token>. Like "view", the token is an
    // opaque credential (non-numeric, longer than any normal id); special-case
    // it so the token lands in `id` rather than being mis-parsed as `sub`.
    if (module === "crew") {
      return {
        module: "crew",
        sub: null,
        id: parts[1] || null,      // crew request token
        action: null,
        query: query,
      };
    }

    // Crew portal: #/crew-portal[/<screen>[/<token>]]. The second segment is a
    // screen name (login, forgot, request-access, signup, reset, overview,
    // schedule, payouts, account) and the third — for signup/reset — is an
    // opaque one-time token, which the generic parser below would otherwise
    // mistake for an `action`. Handled here like "crew" so the token lands in
    // `id` untouched (modules/crew-portal.js).
    if (module === "crew-portal") {
      return {
        module: "crew-portal",
        sub: parts[1] || null,     // screen
        id: parts[2] || null,      // invitation / reset token
        action: null,
        query: query,
      };
    }

    var p1 = parts[1] || null;
    var p2 = parts[2] || null;
    var p3 = parts[3] || null;
    var sub, id, action;

    if (!p1) {
      sub = null; id = null; action = null;
    } else if (p1 === "new") {
      sub = null; id = null; action = "new";
    } else if (isNumericId(p1)) {
      sub = null; id = Number(p1); action = p2 || null;
    } else {
      sub = p1;
      if (!p2) {
        id = null; action = null;
      } else if (p2 === "new") {
        id = null; action = "new";
      } else if (isNumericId(p2)) {
        id = Number(p2); action = p3 || null;
      } else {
        id = null; action = p2;
      }
    }

    return { module: module, sub: sub, id: id, action: action, query: query };
  }

  function getRoute() {
    return parsePath(window.location.hash);
  }

  // ── In-app history tracking ──────────────────────────────────────────────
  // Every entry this router writes carries history.state.ltp = { sid, idx }.
  // sid is a per-tab session id (sessionStorage: survives a reload, fresh on
  // a new tab / PWA launch); idx counts entries within that session. An entry
  // without our stamp is "foreign" — reached by URL, bookmark, notification,
  // or created before the app loaded — and goBack() never calls
  // history.back() from one. See docs/NAVIGATION_DESIGN.md.
  var SID_KEY = "ltp.nav.sid";
  var memSid = null;
  function sessionId() {
    if (memSid) return memSid;
    var s = null;
    try { s = window.sessionStorage && window.sessionStorage.getItem(SID_KEY); } catch (e) { /* blocked storage */ }
    if (!s) {
      s = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      try { window.sessionStorage && window.sessionStorage.setItem(SID_KEY, s); } catch (e) { /* in-memory only */ }
    }
    memSid = s;
    return s;
  }
  function stateOf() {
    var st = null;
    try { st = window.history && window.history.state; } catch (e) { /* no history */ }
    return (st && st.ltp && st.ltp.sid === sessionId()) ? st.ltp : null;
  }
  function stamp(idx, extra) {
    var ltp = { sid: sessionId(), idx: idx };
    if (extra) Object.keys(extra).forEach(function(k) { ltp[k] = extra[k]; });
    return { ltp: ltp };
  }
  function currentIndex() { var s = stateOf(); return s ? s.idx : null; }
  function hasInAppPrev() { var s = stateOf(); return !!(s && s.idx > 0); }
  // Stable key for per-entry state (scroll, filters): null on a foreign entry.
  function entryKey() { var s = stateOf(); return s ? s.sid + ":" + s.idx : null; }

  function urlFor(path) { return String(window.location.href || "").split("#")[0] + "#/" + path; }
  function fireHashChange() {
    try { window.dispatchEvent(new HashChangeEvent("hashchange")); }
    catch (e) { try { window.dispatchEvent(new Event("hashchange")); } catch (e2) { /* no DOM */ } }
  }
  function canPush() { return !!(window.history && typeof window.history.pushState === "function"); }
  function canReplace() { return !!(window.history && typeof window.history.replaceState === "function"); }
  function guardUnsaved() {
    if (window.__LTP_UNSAVED) {
      if (!window.confirm("You have unsaved changes. Leave without saving?")) return false;
      window.__LTP_UNSAVED = false;
    }
    return true;
  }
  // Leave listeners: (entryKey, kind) with kind ∈ "push" | "replace" | "back",
  // fired just before the URL changes. nav-registry.js saves scroll/filter
  // state for the entry being left ("push"/"back") or drops it ("replace").
  var leaveFns = [];
  function onLeave(fn) { leaveFns.push(fn); return function() { leaveFns = leaveFns.filter(function(f) { return f !== fn; }); }; }
  function emitLeave(kind) { var key = entryKey(); leaveFns.forEach(function(fn) { try { fn(key, kind); } catch (e) { /* listener bug must not block nav */ } }); }

  // Drill in: a new history entry. The rule table in docs/NAVIGATION_DESIGN.md
  // says which actions push; tabs, redirects and post-save use replace/goBack.
  function navigate(path) {
    if (!guardUnsaved()) return;
    if (window.location.hash === "#/" + path) return;   // same target: no-op, as location.hash= was
    emitLeave("push");
    if (!canPush()) { window.location.hash = "/" + path; return; }
    var idx = currentIndex();
    window.history.pushState(stamp(idx === null ? 1 : idx + 1), "", urlFor(path));
    fireHashChange();
  }

  // Swap the current entry: redirects, canonicalisation, tab changes, the
  // /new → /:id hop after a create. Keeps the entry's index.
  function replace(path) {
    emitLeave("replace");
    if (!canReplace()) { window.location.hash = "/" + path; return; }
    var idx = currentIndex();
    window.history.replaceState(stamp(idx === null ? 0 : idx), "", urlFor(path));
    fireHashChange();
  }

  // The one Back for every in-app back control: one real step if this session
  // created the previous entry, else the declared logical parent (never the
  // browser's previous site, never an unrelated area).
  function goBack() {
    if (!guardUnsaved()) return;
    if (hasInAppPrev()) { emitLeave("back"); window.history.back(); return; }
    var reg = window.LTP_NAV_REGISTRY;
    var parent = reg ? reg.parentOf(getRoute()) : null;
    replace(parent || DEFAULT_ROUTE);
  }

  // Rewrite the current (cold) entry into [chain..., current] so Back walks
  // the declared hierarchy. Synchronous, one hashchange at the end: React
  // renders the final route once and the ancestor screens never mount.
  function seed(chain, currentPath) {
    if (!canPush() || !canReplace()) return false;
    var paths = (chain || []).concat([currentPath]);
    window.history.replaceState(stamp(0, { seeded: true }), "", urlFor(paths[0]));
    for (var i = 1; i < paths.length; i++) {
      window.history.pushState(stamp(i, { seeded: true }), "", urlFor(paths[i]));
    }
    fireHashChange();
    return true;
  }

  function useRoute() {
    var useState = React.useState, useEffect = React.useEffect;
    var [route, setRoute] = useState(getRoute);
    useEffect(function() {
      function onHash() { setRoute(getRoute()); }
      window.addEventListener("hashchange", onHash);
      return function() { window.removeEventListener("hashchange", onHash); };
    }, []);
    return route;
  }

  // Default redirect on a bare load — the dashboard, or the crew portal on its
  // own host (see defaultRoute above). A replace, not a push: the bare "/"
  // must not linger under the first screen as a dead Back stop. DOES NOT fire
  // when the user arrives at a #view/... URL (that hash is non-empty).
  if (!window.location.hash || window.location.hash === "#") {
    if (canReplace()) window.history.replaceState(null, "", urlFor(DEFAULT_ROUTE));
    else window.location.hash = "/" + DEFAULT_ROUTE;
  }

  window.LTPRouter = {
    getRoute: getRoute, parsePath: parsePath, useRoute: useRoute,
    navigate: navigate, replace: replace, goBack: goBack,
    hasInAppPrev: hasInAppPrev, currentIndex: currentIndex, entryKey: entryKey,
    seed: seed, onLeave: onLeave, defaultRoute: DEFAULT_ROUTE,
  };
})();
