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
// Examples:
//   crm/companies/5/edit     → { module:"crm",     sub:"companies", id:5,    action:"edit" }
//   projects/new             → { module:"projects", sub:null,        id:null, action:"new"  }
//   rentals/equipment/3      → { module:"rentals",  sub:"equipment", id:3,    action:null   }
(function() {

  function isNumericId(s) {
    return s && s !== "new" && s !== "edit" && !isNaN(Number(s));
  }

  function parsePath(hash) {
    var path  = (hash || "").replace(/^#\/?/, "") || "dashboard";
    var parts = path.split("/");
    var module = parts[0] || "dashboard";
    var p1 = parts[1] || null;
    var p2 = parts[2] || null;
    var p3 = parts[3] || null;

    var sub, id, action;

    if (!p1) {
      // module
      sub = null; id = null; action = null;
    } else if (p1 === "new") {
      // module/new
      sub = null; id = null; action = "new";
    } else if (isNumericId(p1)) {
      // module/:id[/edit]
      sub = null; id = Number(p1); action = p2 || null;
    } else {
      // module/sub[/...]
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

    return { module: module, sub: sub, id: id, action: action };
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

  if (!window.location.hash || window.location.hash === "#") {
    window.location.hash = "/dashboard";
  }

  window.LTPRouter = { getRoute: getRoute, navigate: navigate, replace: replace, useRoute: useRoute };
})();
