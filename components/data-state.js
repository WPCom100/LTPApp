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
    equipment: 1, products: 1, services: 1, fees: 1,
    allocations: 1, containers: 1, kits: 1,
  };

  function classify(key) {
    if (ENTITY_KEYS[key]) return "entity";
    if (key === "settings") return "settings";
    return "unknown";
  }

  // Cookie-authenticated fetch wrapper. Every API call sends the session
  // cookie (`ltp_session`, set by /auth/callback on the backend) via
  // `credentials: "include"`. If the cookie is missing or expired, the
  // backend returns 401 and checkResponse() bounces the user to /auth/login.
  function apiFetch(url, opts) {
    opts = opts || {};
    return fetch(url, Object.assign({}, opts, { credentials: "include" }));
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
    // Dispatch a DOM event so the UI (components/error-toasts.js) can show
    // a toast. Wrapped in try/catch in case a very old browser lacks
    // CustomEvent — the console log + ring buffer still capture the error.
    try {
      window.dispatchEvent(new CustomEvent("ltp-api-error", { detail: entry }));
    } catch (e) { /* CustomEvent unsupported — silently skip */ }
  }

  function checkResponse(label, resp) {
    if (resp.ok) return resp;
    // 401 means our session is gone (expired, revoked, or the user logged
    // out in another tab). Bounce to /auth/login so they can re-auth instead
    // of letting the page keep firing failing PUTs.
    if (resp.status === 401) {
      window.location.href = "/auth/login";
      var unauth = new Error(label + " unauthorized — redirecting to login");
      unauth.status = 401;
      throw unauth;
    }
    return resp.text().then(function(body) {
      recordError(label, { status: resp.status, body: (body || "").slice(0, 300) });
      // Attach the status to the error so callers can react to specific
      // codes (e.g. 409 on POST → fall back to PUT). Avoids string-parsing
      // err.message which is brittle.
      var e = new Error(label + " failed: " + resp.status);
      e.status = resp.status;
      throw e;
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

  // Always resolves (never rejects). Returns the parsed JSON on 2xx, or null
  // on any failure (non-2xx HTTP, network error, JSON parse error). Failures
  // are surfaced via recordError() → toast + console + LTP_API_ERRORS, so the
  // caller can treat a null return as "no server data, keep fallback".
  // This contract is what guarantees the loading gate eventually lifts even
  // when the backend is down — callers don't need their own error handling.
  function fetchInitial(key) {
    var kind = classify(key);
    if (kind === "unknown") return Promise.resolve(null);
    var url = (kind === "entity") ? API_PREFIX + key : API_PREFIX + "settings";
    return apiFetch(url).then(function(r) {
      if (r.status === 401) {
        // Session is gone. Bounce to login; the redirect supersedes any
        // further loading. Return null so the calling chain doesn't try to
        // populate React state with garbage in the meantime.
        window.location.href = "/auth/login";
        return null;
      }
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
  //
  // Sync functions resolve to a boolean: true iff EVERY request succeeded.
  // The caller (the debounced change-effect) uses this to decide whether to
  // advance prevSyncedRef. If we advanced unconditionally, items that failed
  // to PUT would be missing from the next diff baseline — the change would
  // be silently dropped from the server forever. Instead: leave prev alone
  // on partial failure, so the next user edit re-diffs from the OLD baseline
  // and retries the failed rows automatically.

  function syncEntity(key, prev, next) {
    var prevList = Array.isArray(prev) ? prev : [];
    var nextList = Array.isArray(next) ? next : [];
    var prevById = {}, nextById = {};
    prevList.forEach(function(x) { if (x && x.id != null) prevById[x.id] = x; });
    nextList.forEach(function(x) { if (x && x.id != null) nextById[x.id] = x; });
    var requests = [];
    // Deletes
    Object.keys(prevById).forEach(function(id) {
      if (!(id in nextById)) {
        requests.push(jsonReq("DELETE " + key + "/" + id, API_PREFIX + key + "/" + id, "DELETE"));
      }
    });
    // Creates + updates — split on whether the id was already in the prior
    // diff baseline. New items use POST (server validates id uniqueness;
    // returns 409 on collision). Existing items use PUT. Proper REST shape;
    // prevents PUT-with-unknown-id from silently creating rows across the
    // entire ID space.
    Object.keys(nextById).forEach(function(id) {
      var item = nextById[id];
      var p = prevById[id];
      if (!p) {
        // New item — POST. If the server already has this id (two tabs
        // assigned the same one, or a previous sync succeeded but the
        // local prev baseline didn't advance), it returns 409. Fall back
        // to PUT in that case so we don't loop forever on the same row.
        var postLabel = "POST " + key + "/" + id;
        requests.push(
          jsonReq(postLabel, API_PREFIX + key, "POST", item).catch(function(err) {
            if (err && err.status === 409) {
              // The row exists on the server; re-route as an update.
              return jsonReq("PUT " + key + "/" + id + " (after 409)",
                             API_PREFIX + key + "/" + id, "PUT", item);
            }
            throw err;
          })
        );
      } else if (JSON.stringify(p) !== JSON.stringify(item)) {
        requests.push(jsonReq("PUT " + key + "/" + id, API_PREFIX + key + "/" + id, "PUT", item));
      }
    });
    if (requests.length === 0) return Promise.resolve(true);
    // Each request resolves to true on success, false on failure. The errors
    // were already logged via checkResponse → recordError → toast.
    return Promise.all(requests.map(function(p) {
      return p.then(function() { return true; }, function() { return false; });
    })).then(function(outcomes) {
      return outcomes.every(function(ok) { return ok; });
    });
  }

  function syncToServer(key, prev, next) {
    var kind = classify(key);
    if (kind === "entity") return syncEntity(key, prev, next);
    if (kind === "settings") {
      return jsonReq("PUT settings", API_PREFIX + "settings", "PUT", next)
        .then(function() { return true; }, function() { return false; });
    }
    return Promise.resolve(true);  // unknown keys are no-op syncs, treated as success
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

    // ── Ref dance — read this before changing anything below ──────────────
    //
    // INVARIANTS the change-effect relies on:
    //   1. `hydratedRef.current === true`  ⇔  initial fetch has settled.
    //      It flips true on EVERY exit path of fetchInitial().then(...)
    //      including failure — we never get stuck in "not ready". See
    //      fetchInitial() above: it catches/swallows all errors and resolves
    //      with null. The loading gate in app.js is therefore guaranteed to
    //      lift even if the API is down (the user sees fallback + error toast).
    //
    //   2. `prevSyncedRef.current` mirrors what the server has, AS OF the
    //      last fully-successful sync. The change-effect diffs current value
    //      against this to compute PUT/DELETE. If ANY request in a batch
    //      fails, we deliberately DO NOT advance prevSyncedRef — that way
    //      the next user edit re-diffs from the old baseline and retries the
    //      failed rows. Trade-off: a persistent server-side error (e.g. a
    //      validation 422 on one bad row) will re-toast on every edit until
    //      the user fixes the bad row. Acceptable; the alternative is silent
    //      data loss, which is worse. If you change this drift logic, see
    //      syncEntity/syncToServer below — they're the source of truth.
    //
    //   3. `skipNextSyncRef.current === true` means the NEXT change-effect
    //      run is server-driven (adoption), not user-driven, so we must NOT
    //      echo it back as a sync. Set to true at mount and whenever the
    //      mount effect calls setValue(serverValue). The change-effect
    //      consumes (and resets) the flag exactly once per occurrence.
    //
    //   4. `latestValueRef.current` always points at the freshest state, even
    //      inside async closures captured at mount time. Use this, not the
    //      `value` closed over from render, when reading inside a .then().
    //
    // If you add a new code path that calls setValue, decide: is it user
    // input (sync it) or server adoption (set skipNextSyncRef = true first)?
    var hydratedRef     = useRef(false);
    var prevSyncedRef   = useRef(fallback);
    var debounceRef     = useRef(null);
    var skipNextSyncRef = useRef(true);   // initial render → no sync
    var latestValueRef  = useRef(value);

    latestValueRef.current = value;

    // One-shot hydration on mount.
    //
    // Belt-and-suspenders: the entire body is wrapped so that hydratedRef and
    // setReady ALWAYS fire, even if something unexpected throws inside the
    // adoption logic. The loading gate in app.js depends on `ready` going true
    // — a stuck gate would freeze the app on a blank "Loading…" screen with
    // no recovery. fetchInitial() is already guaranteed to resolve (see its
    // comment), so the .then runs; the try/catch is for code-bug protection.
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
        try {
          var adopted;
          if (key === "settings") {
            // Merge: client defaults (from data/settings.js) provide tag
            // colors / crew options / etc. when the server's settings blob
            // is empty or sparse. Server values win on overlapping keys.
            adopted = Object.assign({}, fallback || {}, serverValue || {});
            // emailTemplates is a nested object that GAINS keys as we ship new
            // template types (e.g. crewWithdrawn). A shallow assign lets a saved
            // blob's emailTemplates hide every newly-shipped default, so deep-
            // merge it: ship-defaults form the base; the server's saved
            // per-template edits win on top. (Any future nested-object setting
            // that grows new default keys needs the same treatment.)
            adopted.emailTemplates = Object.assign(
              {},
              (fallback || {}).emailTemplates || {},
              (serverValue || {}).emailTemplates || {}
            );
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
        } catch (e) {
          recordError("hydrate " + key, { error: String(e) });
        } finally {
          // ALWAYS lift the loading gate. If we threw above, the user sees
          // an empty fallback + error toast, which is better than a frozen
          // splash screen.
          hydratedRef.current = true;
          setReady(true);
        }
      });
      return function() { cancelled = true; };
    }, []);

    // Debounced sync on every value change.
    //
    // prevSyncedRef advances ONLY on a fully-successful sync. If anything
    // fails, the next change-effect run re-diffs from the old baseline and
    // retries the failed rows. See invariant #2 above.
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
        syncToServer(key, prev, snapshot).then(function(allSucceeded) {
          if (allSucceeded) prevSyncedRef.current = snapshot;
          // On failure, leave prevSyncedRef alone — the next user edit's
          // diff will include the failed rows again and try once more.
        });
      }, DEBOUNCE_MS);
    }, [value]);

    return [value, setValue, ready];
  }

  window.LTP_STATE = {
    usePersistentState: usePersistentState,
  };
})();
