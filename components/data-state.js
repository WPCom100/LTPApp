// LTP Persistent State — pure API-backed.
//
// One hook per persisted slice. On mount, fetches /api/{key} once. On every
// subsequent change, debounces (~400ms) and syncs to the API — entity arrays
// diff by id and send per-row PUT/DELETE; settings and counters PUT the
// whole payload.
//
// No localStorage. No offline cache. No bootstrap-upload. The server is the
// only source of truth, and failures surface loudly via console.error +
// window.LTP_API_ERRORS so they can't be missed.
//
// Return shape: [value, setValue, ready]. Existing 2-element destructures
// in app.js continue to work; the third element is the first-fetch latch
// used by the loading gate.
(function() {
  var API_PREFIX = "/api/";
  var DEBOUNCE_MS = 400;

  // Keys backed by /api/{key} as an array of {id, ...} rows
  var ENTITY_KEYS = {
    companies: 1, contacts: 1, projects: 1, quotes: 1, invoices: 1,
    equipment: 1, products: 1, services: 1,
    allocations: 1, containers: 1, kits: 1,
  };

  function classify(key) {
    if (ENTITY_KEYS[key]) return "entity";
    if (key === "settings") return "settings";
    return "unknown";
  }

  // Authenticated fetch wrapper — injects Authorization: Bearer header from
  // window.LTP_API_KEY (set by /config.js). If unset (local dev), no header
  // is added and the backend allows the request through.
  function apiFetch(url, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    var key = window.LTP_API_KEY;
    if (key) headers["Authorization"] = "Bearer " + key;
    return fetch(url, Object.assign({}, opts, { headers: headers }));
  }

  // ── Error visibility ───────────────────────────────────────────────────
  // Every sync failure pushes onto a ring buffer so the user can inspect
  // recent failures from the console (window.LTP_API_ERRORS) without
  // hunting through DevTools' Network tab.
  if (!window.LTP_API_ERRORS) window.LTP_API_ERRORS = [];
  function recordError(label, info) {
    var entry = Object.assign({ at: new Date().toISOString(), label: label }, info || {});
    console.error("[LTP] sync error:", label, entry);
    window.LTP_API_ERRORS.push(entry);
    if (window.LTP_API_ERRORS.length > 50) window.LTP_API_ERRORS.shift();
  }

  function checkResponse(label, resp) {
    if (resp.ok) return resp;
    return resp.text().then(function(body) {
      recordError(label, { status: resp.status, body: (body || "").slice(0, 300) });
      throw new Error(label + " failed: " + resp.status);
    });
  }

  function jsonReq(label, url, method, body) {
    var opts = { method: method };
    if (body !== undefined) {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(body);
    }
    return apiFetch(url, opts).then(function(r) { return checkResponse(label, r); });
  }

  // ── Initial fetch ───────────────────────────────────────────────────────

  function fetchInitial(key) {
    var kind = classify(key);
    if (kind === "unknown") return Promise.resolve(null);
    var url = (kind === "entity") ? API_PREFIX + key : API_PREFIX + "settings";
    return apiFetch(url).then(function(r) {
      if (!r.ok) {
        return r.text().then(function(body) {
          recordError("GET " + url, { status: r.status, body: (body || "").slice(0, 300) });
          return null;
        });
      }
      return r.json();
    }).catch(function(e) {
      recordError("GET " + url, { error: String(e) });
      return null;
    });
  }

  // ── Sync (per-row diff for entities; whole-blob PUT for settings) ──────

  function syncEntity(key, prev, next) {
    var prevList = Array.isArray(prev) ? prev : [];
    var nextList = Array.isArray(next) ? next : [];
    var prevById = {}, nextById = {};
    prevList.forEach(function(x) { if (x && x.id != null) prevById[x.id] = x; });
    nextList.forEach(function(x) { if (x && x.id != null) nextById[x.id] = x; });
    var requests = [];
    Object.keys(prevById).forEach(function(id) {
      if (!(id in nextById)) {
        requests.push(jsonReq("DELETE " + key + "/" + id, API_PREFIX + key + "/" + id, "DELETE"));
      }
    });
    Object.keys(nextById).forEach(function(id) {
      var item = nextById[id];
      var p = prevById[id];
      if (!p || JSON.stringify(p) !== JSON.stringify(item)) {
        requests.push(jsonReq("PUT " + key + "/" + id, API_PREFIX + key + "/" + id, "PUT", item));
      }
    });
    return Promise.all(requests.map(function(p) {
      return p.catch(function() { /* already logged in checkResponse */ });
    }));
  }

  function syncToServer(key, prev, next) {
    var kind = classify(key);
    if (kind === "entity") return syncEntity(key, prev, next);
    if (kind === "settings") {
      return jsonReq("PUT settings", API_PREFIX + "settings", "PUT", next)
        .catch(function() { /* already logged */ });
    }
    return Promise.resolve();
  }

  // ── React hook ──────────────────────────────────────────────────────────

  function usePersistentState(key, fallback) {
    var useState  = React.useState;
    var useEffect = React.useEffect;
    var useRef    = React.useRef;

    var pair = useState(fallback);
    var value = pair[0], setValue = pair[1];
    var readyPair = useState(false);
    var ready = readyPair[0], setReady = readyPair[1];

    // hydratedRef: gates outbound syncs until the initial fetch resolves.
    // Without this, the first setValue triggered by adopting server state
    // would echo right back out as a sync.
    var hydratedRef     = useRef(false);
    var prevSyncedRef   = useRef(fallback);
    var debounceRef     = useRef(null);
    var skipNextSyncRef = useRef(true);   // initial render → no sync
    var latestValueRef  = useRef(value);

    latestValueRef.current = value;

    // One-shot hydration on mount
    useEffect(function() {
      if (classify(key) === "unknown") {
        prevSyncedRef.current = value;
        hydratedRef.current = true;
        setReady(true);
        return;
      }
      var cancelled = false;
      fetchInitial(key).then(function(serverValue) {
        if (cancelled) return;
        var adopted;
        if (key === "settings") {
          // Merge: client defaults (from data/settings.js) provide tag
          // colors / crew options / etc. when the server's settings blob
          // is empty or sparse. Server values win on overlapping keys.
          adopted = Object.assign({}, fallback || {}, serverValue || {});
        } else if (Array.isArray(serverValue)) {
          adopted = serverValue;
        } else {
          // Fetch failed (null) or non-array — keep fallback so the UI
          // renders something. The error already went to recordError().
          adopted = fallback;
        }
        prevSyncedRef.current = adopted;
        skipNextSyncRef.current = true;  // adoption isn't a user change
        setValue(adopted);
        hydratedRef.current = true;
        setReady(true);
      });
      return function() { cancelled = true; };
    }, []);

    // Debounced sync on every value change
    useEffect(function() {
      if (skipNextSyncRef.current) {
        skipNextSyncRef.current = false;
        return;
      }
      if (!hydratedRef.current) return;
      if (classify(key) === "unknown") return;

      if (debounceRef.current) clearTimeout(debounceRef.current);
      var snapshot = value;
      debounceRef.current = setTimeout(function() {
        var prev = prevSyncedRef.current;
        prevSyncedRef.current = snapshot;
        syncToServer(key, prev, snapshot);
      }, DEBOUNCE_MS);
    }, [value]);

    return [value, setValue, ready];
  }

  window.LTP_STATE = {
    usePersistentState: usePersistentState,
  };
})();
