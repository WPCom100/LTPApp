// LTP Persistent State — pure API-backed, and now two-way.
//
// One hook per persisted slice. On mount, waits for the live-sync stamp seed
// (see components/live-sync.js) and then fetches /api/{key} once. On every
// subsequent change, debounces (~400ms) and syncs to the API — entity arrays
// diff by id and send per-row POST/PUT/DELETE; settings PUT the whole payload.
//
// No localStorage. No offline cache. No bootstrap-upload. The server is the
// only source of truth, and failures surface loudly via console.error +
// window.LTP_API_ERRORS so they can't be missed.
//
// Return shape: [value, setValue, ready]. Existing 2-element destructures
// in app.js continue to work; the third element is the first-fetch latch
// used by the loading gate.
//
// ── What changed when this stopped being one-way ──────────────────────────
//
// It used to fetch once and never look back, which meant a second window went
// stale the moment either one wrote — and stayed stale until a hard refresh.
// Two things fix that here:
//
//   REFETCH ON CHANGE. Each hook subscribes to its collection's stamp
//   (components/live-sync.js). When the stamp moves, it refetches that one
//   collection and THREE-WAY MERGES the result against its own unsynced edits,
//   so a remote change never eats what the user is in the middle of typing.
//
//   If-Match ON WRITE. Every row the server hands us carries a `_rev` content
//   hash. We keep it out of state (see splitRevs — state stays exactly the
//   plain row shape every module already expects) and echo it back on PUT. If
//   the row moved underneath us the server answers 409 and we adopt its
//   version instead of overwriting. That is what stops a window that loaded
//   before a crew member accepted from silently reverting the acceptance when
//   the producer next saves the project.
//
// Live sync makes conflicts rare (a window is usually seconds fresh); If-Match
// is the backstop for the genuine race. They are not alternatives.
(function() {
  var API_PREFIX = "/api/";
  var DEBOUNCE_MS = 400;

  // Keys backed by /api/{key} as an array of {id, ...} rows
  // The key IS the URL segment (/api/{key}), so a hyphenated key must match the
  // route registered in backend/routes/api.py — and the collection name in
  // backend/livesync.py, which is what the stamps are keyed by.
  var ENTITY_KEYS = {
    companies: 1, contacts: 1, projects: 1, quotes: 1, invoices: 1,
    equipment: 1, products: 1, services: 1, fees: 1, "client-rates": 1,
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
    // out in another tab). Bounce to /auth/login so they can keep working
    // instead of letting the page keep firing failing PUTs.
    if (resp.status === 401) {
      window.location.href = "/auth/login";
      var unauth = new Error(label + " unauthorized — redirecting to login");
      unauth.status = 401;
      throw unauth;
    }
    return resp.text().then(function(body) {
      var parsed = null;
      try { parsed = JSON.parse(body); } catch (e) { /* not JSON — keep the text */ }
      // A 409 from a PUT is an EXPECTED outcome (someone else wrote first), not
      // a malfunction. syncEntity handles it by adopting the server's row, so
      // don't record it as an error or the user gets a red toast for something
      // the app resolved on its own.
      if (resp.status !== 409) {
        recordError(label, { status: resp.status, body: (body || "").slice(0, 300) });
      }
      // Attach the status to the error so callers can react to specific
      // codes (e.g. 409 on POST → fall back to PUT). Avoids string-parsing
      // err.message which is brittle.
      var e = new Error(label + " failed: " + resp.status);
      e.status = resp.status;
      e.detail = parsed && parsed.detail;
      throw e;
    });
  }

  function jsonReq(label, url, method, body, ifMatch, extraHeaders) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    // The optimistic-concurrency token. Absent (a row we have never seen a
    // server response for) means "no opinion", and the server falls back to
    // last-write-wins for that row — same as before this existed.
    if (ifMatch) opts.headers["If-Match"] = ifMatch;
    if (extraHeaders) {
      Object.keys(extraHeaders).forEach(function(h) { opts.headers[h] = extraHeaders[h]; });
    }
    return apiFetch(url, opts).then(function(r) { return checkResponse(label, r); });
  }

  // ── One-shot write headers ──────────────────────────────────────────────
  //
  // Some writes need a confirmation the row itself cannot carry — today that is
  // "yes, I really mean to change a day already paid in QuickBooks"
  // (X-LTP-Paid-Day-Override; see backend/routes/api.py::_paid_day_override).
  // The editor that showed the confirmation is not the code that issues the
  // PUT — persisted state does that, on a debounce — so it arms the header here
  // and the next sync of that row picks it up.
  //
  // Armed headers expire, and clear on a successful write, so a confirmation
  // can never leak onto an unrelated later save.
  var ARM_TTL_MS = 120000;
  var armed = {};

  function armKey(key, id) { return key + "/" + id; }

  function armWrite(key, id, headers) {
    armed[armKey(key, id)] = { headers: headers, expires: Date.now() + ARM_TTL_MS };
  }

  function peekArmed(key, id) {
    var slot = armed[armKey(key, id)];
    if (!slot) return null;
    if (slot.expires < Date.now()) { delete armed[armKey(key, id)]; return null; }
    return slot.headers;
  }

  // Cleared on SUCCESS, not on send: a write that fails for an unrelated reason
  // (a network blip) is retried by the next diff, and disarming mid-flight would
  // make that retry fail the very check the user already answered.
  function disarm(key, id) { delete armed[armKey(key, id)]; }

  // ── Revisions ───────────────────────────────────────────────────────────
  //
  // The server stamps every row with `_rev`. We strip it out of the value the
  // hook exposes and keep it in a side map, because state here is consumed by
  // ~30 modules that spread, JSON.stringify and diff these rows; a surprise
  // extra key would leak into payloads, comparisons and snapshots. Transport
  // metadata belongs on the transport.

  function splitRevs(list) {
    var rows = [], revs = {};
    (list || []).forEach(function(item) {
      if (!item || typeof item !== "object") { rows.push(item); return; }
      if (item.id != null && item._rev != null) revs[item.id] = item._rev;
      if ("_rev" in item) {
        var copy = Object.assign({}, item);
        delete copy._rev;
        rows.push(copy);
      } else {
        rows.push(item);
      }
    });
    return { rows: rows, revs: revs };
  }

  function stripRev(row) {
    if (!row || typeof row !== "object" || !("_rev" in row)) return row;
    var copy = Object.assign({}, row);
    delete copy._rev;
    return copy;
  }

  function indexById(list) {
    var out = {};
    (list || []).forEach(function(x) { if (x && x.id != null) out[x.id] = x; });
    return out;
  }

  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  // ── Initial fetch ───────────────────────────────────────────────────────

  // Always resolves (never rejects). Returns {value, revs} on 2xx, or null
  // on any failure (non-2xx HTTP, network error, JSON parse error). Failures
  // are surfaced via recordError() → toast + console + LTP_API_ERRORS, so the
  // caller can treat a null return as "no server data, keep fallback".
  // This contract is what guarantees the loading gate eventually lifts even
  // when the backend is down — callers don't need their own error handling.
  function fetchCollection(key) {
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
      return r.json().then(function(body) {
        if (kind === "entity" && Array.isArray(body)) return splitRevs(body);
        return { rows: body, revs: {} };
      });
    }).catch(function(e) {
      recordError("GET " + url, { error: String(e) });
      return null;
    });
  }

  // Settings is a singleton blob, not a row set: client defaults (data/
  // settings.js) supply tag colors / crew options / etc. when the server's blob
  // is empty or sparse, and server values win on overlapping keys. Shared by
  // hydration and by every later refetch so the two can never drift.
  function adoptSettings(fallback, serverValue) {
    var adopted = Object.assign({}, fallback || {}, serverValue || {});
    // emailTemplates is a nested object that GAINS keys as we ship new template
    // types (e.g. crewWithdrawn). A shallow assign lets a saved blob's
    // emailTemplates hide every newly-shipped default, so deep-merge it:
    // ship-defaults form the base; the server's saved per-template edits win on
    // top. (Any future nested-object setting that grows new default keys needs
    // the same treatment.)
    adopted.emailTemplates = Object.assign(
      {},
      (fallback || {}).emailTemplates || {},
      (serverValue || {}).emailTemplates || {}
    );
    return adopted;
  }

  // ── Three-way merge for a remote change ─────────────────────────────────
  //
  // `base`   what the server had as of our last fully-successful sync
  // `local`  current in-memory value, possibly holding unsynced edits
  // `server` the collection as just refetched
  //
  // Server order and server rows win by default; anything the user has touched
  // since `base` is re-applied on top so a background refresh can never eat an
  // in-flight edit. A row changed on BOTH sides keeps the local edit here and
  // resolves on write, where If-Match turns it into a visible 409 rather than a
  // silent overwrite.
  function mergeRemote(base, local, server, removedOut, keptOut) {
    var baseById = indexById(base);
    var localById = indexById(local);
    var out = (server || []).slice();
    var at = {};
    out.forEach(function(row, i) { if (row && row.id != null) at[row.id] = i; });

    Object.keys(localById).forEach(function(id) {
      var mine = localById[id];
      var wasBase = baseById[id];
      if (wasBase !== undefined && same(wasBase, mine)) return;   // untouched locally
      if (at[id] !== undefined) {                                  // locally edited
        out[at[id]] = mine;
        if (keptOut) keptOut.push(id);
        return;
      }
      if (baseById[id] !== undefined) {
        // We edited it; someone else DELETED it. Keeping our copy would not
        // just show a stale row — the next diff would see it as new and POST it
        // back, undoing their delete behind their back. A delete is the more
        // destructive intent and the harder one to notice was reverted, so it
        // wins; the caller says so rather than letting the row vanish silently.
        if (removedOut) removedOut.push(id);
        return;
      }
      out.push(mine);                                              // locally created
    });

    // Deleted locally but not yet synced — keep it deleted rather than letting
    // the refetch resurrect it.
    Object.keys(baseById).forEach(function(id) {
      if (localById[id] === undefined && at[id] !== undefined) out[at[id]] = null;
    });

    return out.filter(function(row) { return row !== null; });
  }

  // ── Sync (per-row diff for entities; whole-blob PUT for settings) ──────
  //
  // Resolves to {ok, conflicts, revs}:
  //   ok         true iff every request succeeded (a resolved 409 does NOT
  //              count as a failure — it was handled)
  //   conflicts  id → the server's current row, for rows we lost the race on
  //   revs       id → new _rev, for rows the server accepted
  //
  // The caller uses `ok` to decide whether to advance prevSyncedRef. If we
  // advanced unconditionally, items that failed to PUT would be missing from
  // the next diff baseline — the change would be silently dropped from the
  // server forever. Instead: leave prev alone on partial failure, so the next
  // user edit re-diffs from the OLD baseline and retries the failed rows.

  function syncEntity(key, prev, next, revs) {
    var prevById = indexById(prev);
    var nextById = indexById(next);
    var conflicts = {};
    var freshRevs = {};
    var requests = [];

    function capture(resp) {
      return resp.json().then(function(row) {
        if (row && row.id != null && row._rev != null) freshRevs[row.id] = row._rev;
        return true;
      }, function() { return true; });   // accepted; we just didn't learn the new rev
    }

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
          jsonReq(postLabel, API_PREFIX + key, "POST", item).then(capture, function(err) {
            if (err && err.status === 409) {
              // The row exists on the server; re-route as an update. No
              // If-Match: we have never seen this row, so we have no opinion
              // about what it should currently be.
              return jsonReq("PUT " + key + "/" + id + " (after 409)",
                             API_PREFIX + key + "/" + id, "PUT", item).then(capture);
            }
            throw err;
          })
        );
      } else if (!same(p, item)) {
        var putLabel = "PUT " + key + "/" + id;
        requests.push(
          jsonReq(putLabel, API_PREFIX + key + "/" + id, "PUT", item, revs[id], peekArmed(key, id))
            .then(function(resp) { disarm(key, id); return capture(resp); }, function(err) {
              // A day already paid in QuickBooks would be re-priced by this
              // write. The server refuses unless the user has confirmed it —
              // hand the decision to whoever is editing rather than swallowing
              // it, so a stale client is prompted instead of silently blocked.
              if (err && err.status === 409 && err.detail && err.detail.code === "paid_day_conflict") {
                recordError(putLabel, {
                  status: 409,
                  conflict: "changes days already paid in QuickBooks — awaiting confirmation",
                  days: err.detail.days,
                });
                try {
                  window.dispatchEvent(new CustomEvent("ltp-paid-day-conflict", {
                    detail: { collection: key, id: item.id, days: err.detail.days || [] },
                  }));
                } catch (e) { /* CustomEvent unsupported */ }
                throw err;   // NOT handled — the baseline must not advance
              }
              // Someone else wrote this row between our last read and now.
              // The server hands back its current version so we can adopt it
              // without another round trip.
              if (err && err.status === 409 && err.detail && err.detail.row) {
                conflicts[id] = err.detail.row;
                if (err.detail.row._rev != null) freshRevs[id] = err.detail.row._rev;
                // The write is settled, however it went: disarm, or a one-shot
                // header (today the paid-day override) stays live for its full
                // TTL and silently authorises a LATER, different edit the user
                // never confirmed.
                disarm(key, id);
                recordError(putLabel, {
                  status: 409,
                  conflict: "row changed in another window — server version adopted",
                  discardedLocalEdit: item,
                });
                return true;   // handled, not a failure
              }
              throw err;
            })
        );
      }
    });

    if (requests.length === 0) {
      return Promise.resolve({ ok: true, conflicts: conflicts, revs: freshRevs });
    }
    // Each request resolves to true on success, false on failure. The errors
    // were already logged via checkResponse → recordError → toast.
    return Promise.all(requests.map(function(p) {
      return p.then(function() { return true; }, function() { return false; });
    })).then(function(outcomes) {
      return {
        ok: outcomes.every(function(good) { return good; }),
        conflicts: conflicts,
        revs: freshRevs,
      };
    });
  }

  function syncToServer(key, prev, next, revs) {
    var kind = classify(key);
    if (kind === "entity") return syncEntity(key, prev, next, revs || {});
    if (kind === "settings") {
      // Settings is shallow-MERGED server-side, so two windows editing
      // different keys compose rather than clobber. No revision guard needed.
      return jsonReq("PUT settings", API_PREFIX + "settings", "PUT", next)
        .then(function() { return { ok: true, conflicts: {}, revs: {} }; },
              function() { return { ok: false, conflicts: {}, revs: {} }; });
    }
    return Promise.resolve({ ok: true, conflicts: {}, revs: {} });  // unknown keys are no-op syncs
  }

  function live() { return window.LTP_LIVE; }

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
    //      It flips true on EVERY exit path of the mount effect including
    //      failure — fetchCollection() catches/swallows all errors and resolves
    //      with null, and LTP_LIVE.ready() never rejects. The loading gate in
    //      app.js is therefore guaranteed to lift even if the API is down (the
    //      user sees fallback + error toast).
    //
    //   2. `prevSyncedRef.current` mirrors what the server has, AS OF the
    //      last fully-successful sync. The change-effect diffs current value
    //      against this to compute POST/PUT/DELETE. If ANY request in a batch
    //      fails, we deliberately DO NOT advance prevSyncedRef — that way
    //      the next user edit re-diffs from the old baseline and retries the
    //      failed rows. Trade-off: a persistent server-side error (e.g. a
    //      validation 422 on one bad row) will re-toast on every edit until
    //      the user fixes the bad row. Acceptable; the alternative is silent
    //      data loss, which is worse. If you change this drift logic, see
    //      syncEntity/syncToServer above — they're the source of truth.
    //
    //   3. `skipNextSyncRef.current === true` means the NEXT change-effect
    //      run is server-driven (adoption), not user-driven, so we must NOT
    //      echo it back as a sync. Set to true at mount and whenever we adopt
    //      a server payload wholesale. The change-effect consumes (and resets)
    //      the flag exactly once per occurrence. NOTE the remote-refresh path
    //      deliberately does NOT set it: a merge can legitimately leave local
    //      edits that still need to reach the server.
    //
    //   4. `latestValueRef.current` always points at the freshest state, even
    //      inside async closures captured at mount time. Use this, not the
    //      `value` closed over from render, when reading inside a .then().
    //
    //   5. `revsRef.current` is id → server `_rev`, the If-Match token per row.
    //      Updated from every server response. A missing entry just means "no
    //      opinion" and degrades to last-write-wins for that row.
    //
    //   6. `stampRef.current` is the live-sync stamp this collection was last
    //      FETCHED at — captured BEFORE the fetch, never after. See the
    //      ordering contract in components/live-sync.js.
    //
    // If you add a new code path that calls setValue, decide: is it user
    // input (sync it) or server adoption (set skipNextSyncRef = true first)?
    var hydratedRef     = useRef(false);
    var prevSyncedRef   = useRef(fallback);
    var debounceRef     = useRef(null);
    var skipNextSyncRef = useRef(true);   // initial render → no sync
    var latestValueRef  = useRef(value);
    var revsRef         = useRef({});
    var stampRef        = useRef(undefined);
    var refreshingRef   = useRef(false);
    var refreshAgainRef = useRef(false);
    var refreshFnRef    = useRef(null);
    var retryTimerRef   = useRef(null);
    var retryDelayRef   = useRef(0);
    // Bumped every time a remote refresh replaces the baseline. A sync that
    // started before that must NOT write its own (older) baseline back over it
    // — doing so would drop the rows the refresh just learned about, and the
    // next diff would try to re-create or re-delete them.
    var baselineEpochRef = useRef(0);

    latestValueRef.current = value;

    // Read-only mirror of every persisted collection, kept in step at render
    // time. theme.js::LTP_useRecordWatch reads it so a form can watch the row it
    // is editing without its parent having to thread the live array down — there
    // are a dozen such forms and threading a prop through each was a dozen
    // chances to wire one up wrong. Never write to this; it is a view of state,
    // not a second copy of it.
    if (!window.LTP_DATA_LIVE) window.LTP_DATA_LIVE = {};
    window.LTP_DATA_LIVE[key] = value;

    // One-shot hydration on mount.
    //
    // Belt-and-suspenders: the entire body is wrapped so that hydratedRef and
    // setReady ALWAYS fire, even if something unexpected throws inside the
    // adoption logic. The loading gate in app.js depends on `ready` going true
    // — a stuck gate would freeze the app on a blank "Loading…" screen with
    // no recovery.
    useEffect(function() {
      if (classify(key) === "unknown") {
        prevSyncedRef.current = value;
        hydratedRef.current = true;
        setReady(true);
        return;
      }
      var cancelled = false;

      // Wait for the stamp seed before the first fetch, then record the stamp
      // we fetched AT. Ordering matters: a write landing between the stamp read
      // and the fetch costs one redundant refetch, whereas the reverse order
      // would lose the change entirely (see live-sync.js).
      var lv = live();
      var gate = lv ? lv.ready() : Promise.resolve();

      // Read the stamp BEFORE the fetch, but only COMMIT it if the fetch works.
      // Recording it unconditionally meant a failed initial GET left the hook
      // claiming to hold data as of that stamp; refresh() then saw
      // stampNow === stampRef.current and returned, so the collection never
      // refetched for the life of the page and the window sat on `fallback`.
      var stampAtHydrate;
      gate.then(function() {
        if (cancelled) return null;
        stampAtHydrate = lv ? lv.stampFor(key) : undefined;
        return fetchCollection(key);
      }).then(function(fetched) {
        if (cancelled) return;
        try {
          var adopted;
          if (key === "settings") {
            adopted = adoptSettings(fallback, fetched ? fetched.rows : null);
          } else if (fetched && Array.isArray(fetched.rows)) {
            adopted = fetched.rows;
            revsRef.current = fetched.revs;
          } else {
            // Fetch failed (null) or non-array — keep fallback so the UI
            // renders something. The error already went to recordError().
            adopted = fallback;
          }
          prevSyncedRef.current = adopted;
          if (adopted !== value) {
            // Arm the skip ONLY when this really will re-render. On a failed
            // fetch `adopted` is the same `fallback` object the hook already
            // holds, React bails out, the change-effect never runs to consume
            // the flag — and the user's next edit was then swallowed as if it
            // were server adoption, silently never syncing.
            skipNextSyncRef.current = true;   // adoption isn't a user change
            setValue(adopted);
          }
          if (fetched) stampRef.current = stampAtHydrate;
        } catch (e) {
          recordError("hydrate " + key, { error: String(e) });
        } finally {
          // ALWAYS lift the loading gate. If we threw above, the user sees
          // an empty fallback + error toast, which is better than a frozen
          // splash screen.
          hydratedRef.current = true;
          setReady(true);
          // If the stamp seed timed out we fetched blind, and cannot tell
          // whether this collection moved underneath us. Now that stamps may
          // have arrived, let the refresh guard decide.
          if (refreshFnRef.current) refreshFnRef.current();
        }
      });
      return function() { cancelled = true; };
    }, []);

    // Refetch when this collection changes anywhere else.
    //
    // The stamp comparison is what keeps this cheap: the feed says WHICH
    // collection moved, so one window writing a contact never makes any other
    // window re-download projects.
    useEffect(function() {
      var lv = live();
      if (!lv || classify(key) === "unknown") return;

      // Exponential backoff, capped. Bounded because the failure we are riding out
      // is a transient one (a 502 from the edge, a dropped connection, the pool
      // briefly exhausted by the several collection GETs one multi-collection
      // stamp change kicks off); anything longer-lived is the user's problem to
      // see, and they will, via the error toast fetchCollection already raised.
      var RETRY_MIN_MS = 2000, RETRY_MAX_MS = 60000;
      function scheduleRetry() {
        if (retryTimerRef.current) return;
        retryDelayRef.current = retryDelayRef.current
          ? Math.min(retryDelayRef.current * 2, RETRY_MAX_MS)
          : RETRY_MIN_MS;
        retryTimerRef.current = setTimeout(function() {
          retryTimerRef.current = null;
          refresh();
        }, retryDelayRef.current);
      }

      function refresh() {
        if (!hydratedRef.current) return;         // mount fetch is still in flight
        var stampNow = lv.stampFor(key);
        if (stampNow === undefined) return;       // no stamp info — nothing says we are stale
        if (stampNow === stampRef.current) return;  // already current
        if (refreshingRef.current) {
          // Coalesce rather than drop: a change that lands mid-refresh would
          // otherwise be lost, because nothing re-fires until the NEXT change.
          refreshAgainRef.current = true;
          return;
        }
        refreshingRef.current = true;

        var stampAtFetch = stampNow;
        fetchCollection(key).then(function(fetched) {
          refreshingRef.current = false;
          if (refreshAgainRef.current) { refreshAgainRef.current = false; setTimeout(refresh, 0); }
          if (!fetched) {
            // Leaving the stamp stale is necessary but NOT sufficient: refresh()
            // only ever runs from a stamp-change notification, and live-sync has
            // already stored this stamp, so no further notification will carry
            // this value — and a focus revalidate re-reads that same map and sees
            // nothing new. Without an explicit retry one dropped GET stranded the
            // window until some unrelated later write moved the stamp again.
            scheduleRetry();
            return;
          }
          retryDelayRef.current = 0;              // a good fetch resets the backoff
          stampRef.current = stampAtFetch;
          try {
            if (key === "settings") {
              var merged = adoptSettings(fallback, fetched.rows);
              if (same(merged, latestValueRef.current)) return;
              prevSyncedRef.current = merged;
              baselineEpochRef.current += 1;
              skipNextSyncRef.current = true;
              setValue(merged);
              return;
            }
            if (!Array.isArray(fetched.rows)) return;
            var removed = [], keptLocal = [];
            var next = mergeRemote(prevSyncedRef.current, latestValueRef.current,
                                   fetched.rows, removed, keptLocal);
            // Adopt the server's revision for every row EXCEPT the ones the merge
            // just resolved in favour of our local copy.
            //
            // Those rows are precisely the ones If-Match exists for: our edit is
            // based on the revision we last read, and the write must be judged
            // against THAT. Taking the server's newer rev here handed the next PUT
            // a token the server already agrees with, so _require_fresh passed and
            // the other window's change was overwritten with no 409, no toast and
            // no LTP_API_ERRORS entry — the exact failure this whole mechanism was
            // built to make impossible.
            var keepStale = {};
            keptLocal.forEach(function(id) { keepStale[id] = true; });
            var freshRevs = {};
            Object.keys(fetched.revs || {}).forEach(function(id) {
              if (!keepStale[id]) freshRevs[id] = fetched.revs[id];
            });
            revsRef.current = Object.assign({}, revsRef.current, freshRevs);
            if (removed.length && window.LTP_toast) {
              window.LTP_toast("Deleted in another window", {
                message: removed.length === 1
                  ? "A record you were editing was deleted elsewhere, so your changes to it were dropped."
                  : removed.length + " records you were editing were deleted elsewhere, so your changes to them were dropped.",
                variant: "warn",
              });
            }
            // Baseline becomes what the SERVER actually holds, so the next diff
            // re-sends exactly the local edits the merge preserved — no more,
            // no less.
            prevSyncedRef.current = fetched.rows;
            baselineEpochRef.current += 1;
            if (same(next, latestValueRef.current)) return;   // nothing to re-render
            // Deliberately NOT skipping the next sync: if the merge kept a
            // local edit, it still has to reach the server.
            setValue(next);
          } catch (e) {
            recordError("refresh " + key, { error: String(e) });
          }
        }, function(e) {
          refreshingRef.current = false;
          recordError("refresh " + key, { error: String(e) });
          scheduleRetry();
        });
      }

      refreshFnRef.current = refresh;
      var unsubscribe = lv.subscribe(key, refresh);
      var stopRetry = function() {
        if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
      };
      // The stamp may already have moved between the mount fetch and this
      // effect running (React runs effects after paint).
      refresh();
      return function() { refreshFnRef.current = null; stopRetry(); unsubscribe(); };
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
        var epochAtStart = baselineEpochRef.current;
        syncToServer(key, prev, snapshot, revsRef.current).then(function(res) {
          revsRef.current = Object.assign({}, revsRef.current, res.revs);
          // A remote refresh landed while we were in flight and already
          // installed a newer baseline. Ours is stale by definition — leave it
          // alone. The rows we successfully wrote are in that newer baseline
          // too (we just read them back), so nothing is lost.
          var baselineIsOurs = baselineEpochRef.current === epochAtStart;

          var lostIds = Object.keys(res.conflicts);
          if (lostIds.length) {
            // Someone else's write won. Adopt their rows over ours — the
            // alternative is overwriting work we can see is newer. The
            // discarded local edit is in window.LTP_API_ERRORS, and the user
            // gets told rather than finding out later.
            //
            // Applied over latestValueRef, not `snapshot`, so edits the user
            // made while the request was in flight survive.
            var byId = res.conflicts;
            var applied = (latestValueRef.current || []).map(function(row) {
              return (row && row.id != null && byId[row.id]) ? stripRev(byId[row.id]) : row;
            });
            if (baselineIsOurs) {
              prevSyncedRef.current = (snapshot || []).map(function(row) {
                return (row && row.id != null && byId[row.id]) ? stripRev(byId[row.id]) : row;
              });
            }
            setValue(applied);
            if (window.LTP_toast) {
              window.LTP_toast("Changed in another window", {
                message: lostIds.length === 1
                  ? "One record was updated elsewhere while you were editing it. The newer version is now shown."
                  : lostIds.length + " records were updated elsewhere while you were editing them. The newer versions are now shown.",
                variant: "warn",
              });
            }
          } else if (res.ok && baselineIsOurs) {
            prevSyncedRef.current = snapshot;
          }
          // On failure, leave prevSyncedRef alone — the next user edit's
          // diff will include the failed rows again and try once more.

          if (res.ok) {
            // Nudge same-browser tabs so they don't wait on the server round
            // trip. Free, and it makes the two-window case feel instant.
            var lv = live();
            if (lv) lv.announceWrite([key]);
          }
        });
      }, DEBOUNCE_MS);
    }, [value]);

    return [value, setValue, ready];
  }

  window.LTP_STATE = {
    usePersistentState: usePersistentState,
    // Attach a one-shot header to the next write of one row. See the
    // "One-shot write headers" note above.
    armWrite: armWrite,
    // Exported for tests (tests/test_live_sync.js).
    _mergeRemote: mergeRemote,
    _splitRevs: splitRevs,
    _adoptSettings: adoptSettings,
  };
})();
