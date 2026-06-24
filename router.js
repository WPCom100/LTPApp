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
    var raw   = (hash || "").replace(/^#\/?/, "") || "dashboard";
    // Split off the query portion BEFORE the path split so segments like
    // "abc?preview=1" don't end up in `id`. The "?" lives inside the hash
    // string; the browser doesn't peel it off for us.
    var qIdx  = raw.indexOf("?");
    var path  = qIdx >= 0 ? raw.substring(0, qIdx) : raw;
    var query = parseQuery(qIdx >= 0 ? raw.substring(qIdx + 1) : "");

    var parts  = path.split("/");
    var module = parts[0] || "dashboard";

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

  function navigate(path) {
    if (window.__LTP_UNSAVED) {
      if (!window.confirm("You have unsaved changes. Leave without saving?")) return;
      window.__LTP_UNSAVED = false;
    }
    window.location.hash = "/" + path;
  }

  function replace(path) {
    var base = window.location.href.split("#")[0];
    window.history.replaceState(null, "", base + "#/" + path);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
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

  // Default redirect to dashboard on bare load. DOES NOT fire when the user
  // arrives at a #view/... URL (that hash is non-empty).
  if (!window.location.hash || window.location.hash === "#") {
    window.location.hash = "/dashboard";
  }

  window.LTPRouter = { getRoute: getRoute, navigate: navigate, replace: replace, useRoute: useRoute };
})();
