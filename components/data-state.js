// LTP Persistent State — API-backed with localStorage cache.
//
// Lifecycle for each persisted slice (companies, quotes, settings, counters…):
//   1. useState() seeds synchronously from localStorage so the first render
//      is instant — no spinner, no flash of empty data.
//   2. On mount, fetch /api/{key} once. If the server has content, replace
//      local state with the server's (server is source of truth). If the
//      server is empty AND we have local data, bootstrap-upload the local
//      slice so the server adopts what's in the browser.
//   3. Every subsequent setValue() schedules a debounced sync. Entity arrays
//      diff old vs new by id → PUT for upserts, DELETE for removals.
//      Settings and counters PUT their whole payload.
//   4. localStorage is mirrored on every change so reloads stay instant and
//      offline edits don't blow away while the network is down.
(function() {
  var API_PREFIX = "/api/";
  var DEBOUNCE_MS = 400;

  // Authenticated fetch wrapper — injects Authorization: Bearer header from
  // window.LTP_API_KEY (set by /config.js, served by the FastAPI backend
  // before this script runs). If the key is empty (local dev), no header
  // is added and the backend lets requests through unauthenticated.
  function apiFetch(url, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    var key = window.LTP_API_KEY;
    if (key) headers["Authorization"] = "Bearer " + key;
    return fetch(url, Object.assign({}, opts, { headers: headers }));
  }

  // Keys backed by /api/{key} as an array of {id, ...} rows
  var ENTITY_KEYS = {
    companies: 1, contacts: 1, projects: 1, quotes: 1, invoices: 1,
    equipment: 1, products: 1, services: 1,
    allocations: 1, containers: 1, kits: 1,
  };
  // Keys backed by /api/counters/{key} as a single integer
  var COUNTER_KEYS = { quotes_next_id: 1, invoices_next_id: 1 };

  function classify(key) {
    if (ENTITY_KEYS[key]) return "entity";
    if (COUNTER_KEYS[key]) return "counter";
    if (key === "settings") return "settings";
    return "local";
  }

  function emptyBaseline(key) {
    var k = classify(key);
    if (k === "entity") return [];
    if (k === "settings") return {};
    if (k === "counter") return null;
    return null;
  }

  function hasContent(key, value) {
    var k = classify(key);
    if (k === "entity")   return Array.isArray(value) && value.length > 0;
    if (k === "settings") return value && typeof value === "object" && Object.keys(value).length > 0;
    if (k === "counter")  return typeof value === "number";
    return false;
  }

  function loadState(key, fallback) {
    try {
      var d = localStorage.getItem("ltp_" + key);
      return d ? JSON.parse(d) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveState(key, val) {
    try { localStorage.setItem("ltp_" + key, JSON.stringify(val)); } catch (e) {}
  }

  // ── Network helpers ─────────────────────────────────────────────────────

  function fetchInitial(key) {
    var kind = classify(key);
    if (kind === "local") return Promise.resolve(null);
    var url = (kind === "entity")   ? API_PREFIX + key
            : (kind === "settings") ? API_PREFIX + "settings"
            :                         API_PREFIX + "counters/" + key;
    return apiFetch(url).then(function(r) {
      if (!r.ok) return null;
      return r.json();
    }).then(function(data) {
      if (data == null) return null;
      if (kind === "counter") return (data.value == null) ? null : data.value;
      return data;
    }).catch(function() { return null; });
  }

  function jsonReq(url, method, body) {
    var opts = { method: method };
    if (body !== undefined) {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(body);
    }
    return apiFetch(url, opts);
  }

  function syncEntity(key, prev, next) {
    var prevList = Array.isArray(prev) ? prev : [];
    var nextList = Array.isArray(next) ? next : [];
    var prevById = {}, nextById = {};
    prevList.forEach(function(x) { if (x && x.id != null) prevById[x.id] = x; });
    nextList.forEach(function(x) { if (x && x.id != null) nextById[x.id] = x; });
    var requests = [];
    Object.keys(prevById).forEach(function(id) {
      if (!(id in nextById)) {
        requests.push(jsonReq(API_PREFIX + key + "/" + id, "DELETE"));
      }
    });
    Object.keys(nextById).forEach(function(id) {
      var item = nextById[id];
      var p = prevById[id];
      if (!p || JSON.stringify(p) !== JSON.stringify(item)) {
        requests.push(jsonReq(API_PREFIX + key + "/" + id, "PUT", item));
      }
    });
    return Promise.all(requests).catch(function(e) {
      console.warn("[LTP] sync failed for " + key, e);
    });
  }

  function syncToServer(key, prev, next) {
    var kind = classify(key);
    if (kind === "entity")   return syncEntity(key, prev, next);
    if (kind === "settings") return jsonReq(API_PREFIX + "settings", "PUT", next).catch(function(e) {
      console.warn("[LTP] sync failed for settings", e);
    });
    if (kind === "counter")  return jsonReq(API_PREFIX + "counters/" + key, "PUT", { value: next }).catch(function(e) {
      console.warn("[LTP] sync failed for counter " + key, e);
    });
    return Promise.resolve();
  }

  // ── React hook ──────────────────────────────────────────────────────────

  function usePersistentState(key, fallback) {
    var useState  = React.useState;
    var useEffect = React.useEffect;
    var useRef    = React.useRef;

    var pair = useState(function() { return loadState(key, fallback); });
    var value = pair[0], setValue = pair[1];

    // hydratedRef: gates outbound syncs until the initial fetch (and any
    // bootstrap upload) has resolved. Prevents premature DELETE-everything.
    var hydratedRef     = useRef(false);
    var prevSyncedRef   = useRef(loadState(key, fallback));
    var debounceRef     = useRef(null);
    var skipNextSyncRef = useRef(true);   // initial render → no sync
    var latestValueRef  = useRef(value);  // always points at the freshest state

    // Keep latestValueRef in sync with the most recent value.
    // Without this, the bootstrap closure would upload stale data if the
    // user typed something between mount and the fetch resolving.
    latestValueRef.current = value;

    // One-shot hydration on mount
    useEffect(function() {
      if (classify(key) === "local") {
        hydratedRef.current = true;
        return;
      }
      var cancelled = false;
      fetchInitial(key).then(function(serverValue) {
        if (cancelled) return;
        var serverHasData = serverValue !== null && hasContent(key, serverValue);
        if (serverHasData) {
          prevSyncedRef.current = serverValue;
          skipNextSyncRef.current = true;  // adoption isn't a user change
          setValue(serverValue);
          saveState(key, serverValue);
          hydratedRef.current = true;
          return;
        }
        // Server has nothing — bootstrap from local using whatever's freshest.
        var baseline = emptyBaseline(key);
        var seedSnapshot = latestValueRef.current;
        prevSyncedRef.current = baseline;
        if (hasContent(key, seedSnapshot)) {
          syncToServer(key, baseline, seedSnapshot).then(function() {
            if (cancelled) return;
            prevSyncedRef.current = seedSnapshot;
            hydratedRef.current = true;
            // Sync any edits the user made during the bootstrap window
            var current = latestValueRef.current;
            if (JSON.stringify(current) !== JSON.stringify(seedSnapshot)) {
              prevSyncedRef.current = current;
              syncToServer(key, seedSnapshot, current);
            }
          });
        } else {
          hydratedRef.current = true;
        }
      });
      return function() { cancelled = true; };
    }, []);

    // Mirror to localStorage + debounced API sync on every change
    useEffect(function() {
      saveState(key, value);
      if (skipNextSyncRef.current) {
        skipNextSyncRef.current = false;
        return;
      }
      if (!hydratedRef.current) return;
      if (classify(key) === "local") return;

      if (debounceRef.current) clearTimeout(debounceRef.current);
      var snapshot = value;
      debounceRef.current = setTimeout(function() {
        var prev = prevSyncedRef.current;
        prevSyncedRef.current = snapshot;
        syncToServer(key, prev, snapshot);
      }, DEBOUNCE_MS);
    }, [value]);

    // Cross-tab stale-flag (preserved from the localStorage-only impl)
    useEffect(function() {
      function onStorage(e) {
        if (e.key === "ltp_" + key) {
          if (!window.__LTP_STALE_KEYS) window.__LTP_STALE_KEYS = {};
          window.__LTP_STALE_KEYS[key] = true;
        }
      }
      window.addEventListener("storage", onStorage);
      return function() { window.removeEventListener("storage", onStorage); };
    }, [key]);

    return [value, setValue];
  }

  // ── Manual seed migration (one-shot from console / settings UI) ─────────
  // Dumps every "ltp_*" key from localStorage to POST /api/sync, replacing
  // the server's state with the browser's. Useful when first connecting an
  // existing localStorage-only client to the backend.
  function migrateFromLocal() {
    var payload = {};
    Object.keys(ENTITY_KEYS).forEach(function(k) {
      payload[k] = loadState(k, []);
    });
    payload.settings = loadState("settings", {});
    payload.counters = {};
    Object.keys(COUNTER_KEYS).forEach(function(k) {
      var v = loadState(k, null);
      if (typeof v === "number") payload.counters[k] = v;
    });
    return apiFetch(API_PREFIX + "sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function(r) { return r.json(); });
  }

  window.LTP_STATE = {
    loadState: loadState,
    saveState: saveState,
    usePersistentState: usePersistentState,
    migrateFromLocal: migrateFromLocal,
    classify: classify,
  };
})();
