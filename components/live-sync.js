// LTP Live Sync — one shared change channel for the whole page.
//
// WHY
// ===
// components/data-state.js used to fetch each collection once, on mount, and
// then only ever push writes outward. Nothing came back in, so two windows on
// one workspace drifted apart the moment either wrote — and stayed wrong until
// a hard refresh. Worse, some writes are made by the SERVER, not by any window:
// a crew member accepting from their emailed link moves position statuses on the
// project row (backend/routes/crew.py::_respond). No open window could ever
// learn about that.
//
// WHAT TRAVELS
// ============
// Stamps, never rows. The server publishes a map of per-collection version
// stamps (see backend/livesync.py); this module diffs it against what it last
// saw and tells subscribers which collections moved. They refetch just those.
// So the cost of staying live is independent of how much data the workspace
// holds:
//
//   SSE, idle          one ": keepalive" comment per 25s  ≈ single-digit KB/hr
//   /api/versions poll ~400 bytes of JSON per tick, foreground tabs only
//   BroadcastChannel   zero — same-browser tabs, never touches the network
//   refetch            only the collections that actually changed
//
// THREE CHANNELS, ONE PATH
// ========================
// Everything funnels through applyStamps(), so the channels are free to overlap
// — whichever notices first wins and the others see no stamp change and do
// nothing. That redundancy is the point; each covers the others' blind spot.
//
//   1. BroadcastChannel — instant, free, same-browser tabs only. A tab that
//      finishes a write pings its siblings. Purely a "revalidate now" hint: it
//      carries no data, so a sibling still learns the truth from the server.
//   2. SSE (/api/stream) — the real push channel, cross-browser and
//      cross-device. Reconnects with exponential backoff.
//   3. Polling (/api/versions) — fallback when SSE will not stay up, plus a
//      one-shot revalidation whenever the tab becomes visible or focused. A
//      hidden tab does NOT poll; SSE, if connected, keeps it live for free.
//
// ORDERING CONTRACT
// =================
// Read the stamp BEFORE fetching the data it describes. Fetching first and
// stamping after loses any write that lands between the two: the window would
// hold pre-write rows next to a post-write stamp and never refetch. Getting it
// backwards costs at most one redundant refetch, which is why ready() exists —
// data-state.js waits for the first stamp map before its initial fetch, so
// every collection starts life with a stamp it can trust.
(function() {
  var VERSIONS_URL = "/api/versions";
  var STREAM_URL   = "/api/stream";

  // Fallback poll cadence, foreground tabs only. 15s is well inside "feels
  // live" for a scheduling tool and costs ~240 small requests/hour/tab — two
  // orders of magnitude under refetching the collections themselves.
  var POLL_MS = 15000;

  // SSE reconnect backoff. EventSource retries on its own at a fixed interval,
  // which turns a server restart into a reconnect storm from every open window
  // at once (and trips the /api/stream rate-limit bucket). So we close on error
  // and reopen ourselves, backing off with jitter.
  var BACKOFF_MIN_MS = 1000;
  var BACKOFF_MAX_MS = 30000;

  // Consecutive SSE failures before we stop trusting it and start polling. We
  // keep retrying SSE in the background either way.
  var SSE_GIVE_UP_AFTER = 3;
  var SSE_RETRY_WHILE_POLLING_MS = 60000;

  // Hard ceiling on how long the initial stamp read may hold up the app's
  // loading gate. data-state.js waits on ready() before its first fetch, so a
  // backend that accepts connections but answers slowly would otherwise park
  // the user on "Loading…" indefinitely. Past this we boot without stamps and
  // reconcile when they arrive.
  var READY_TIMEOUT_MS = 5000;

  var CHANNEL_NAME = "ltp_live_sync";

  var stamps = {};              // collection → last stamp we have seen
  var listeners = {};           // collection → [fn]
  var seeded = false;
  // The shell version the SERVER says it is serving, as of the last frame.
  // Null until something reports one. See noteAppVersion.
  var appVersion = null;
  var readyPromise = null;

  var source = null;            // live EventSource, if any
  var sseFailures = 0;
  var backoffMs = BACKOFF_MIN_MS;
  var reconnectTimer = null;
  var pollTimer = null;
  var polling = false;
  var channel = null;
  var started = false;
  var recycling = false;        // true between a `bye` frame and its reconnect
  var inFlightRevalidate = null;

  function log(msg, extra) {
    if (window.LTP_LIVE_DEBUG) console.log("[LTP live] " + msg, extra || "");
  }

  function apiFetch(url) {
    return fetch(url, { credentials: "include", headers: { "Accept": "application/json" } });
  }

  // ── Stamp diffing — the single point every channel funnels through ────────

  // Returns the list of collections whose stamp moved. On the FIRST map we only
  // seed: nothing has been fetched against an older stamp yet, so there is
  // nothing to invalidate. (data-state.js waits on ready() precisely so that
  // stays true.)
  function applyStamps(next) {
    if (!next || typeof next !== "object") return [];
    var changed = [];
    Object.keys(next).forEach(function(key) {
      if (seeded && stamps[key] !== undefined && stamps[key] !== next[key]) changed.push(key);
      stamps[key] = next[key];
    });
    if (!seeded) {
      seeded = true;
      log("seeded", stamps);
      // Normally nothing has fetched yet, so the seed invalidates nothing and we
      // stay quiet. But ready() is bounded (READY_TIMEOUT_MS) and revalidate()
      // swallows failures — so on a slow or failed /api/versions the hooks fetch
      // BLIND and the seed arrives afterwards. Anything written between their
      // fetch and this moment is then baked into a stamp they trust while they
      // hold pre-write rows, and nothing ever re-checks.
      //
      // Subscribers existing at seed time is exactly that situation: wake them so
      // they compare their own stamp against this one. In the normal path they
      // recorded the seeded stamp already and no-op.
      Object.keys(listeners).forEach(function(key) {
        if (listeners[key] && listeners[key].length) notify(key);
      });
      return [];
    }
    if (changed.length) {
      log("changed", changed);
      changed.forEach(notify);
    }
    return changed;
  }

  // ── Which shell the server is serving ─────────────────────────────────────
  //
  // Rides along on the feed the window is already listening to, so a tab open
  // across a deploy finds out without being reloaded first — which was the
  // catch-22 before: the update banner appeared on load, so you had to refresh
  // to learn that you needed to refresh.
  //
  // The delivery is a consequence of how a deploy goes: it replaces the server
  // process, the old one releases its streams on the way out, every window
  // reconnects, and the first frame from the new process carries the new
  // version. Nothing has to be pushed to a live connection.
  //
  // Announced on change only (null → value counts), because the interesting
  // moment is the transition, and every frame carries the field.
  function noteAppVersion(v) {
    if (typeof v !== "string" || !v || v === appVersion) return;
    var first = appVersion === null;
    appVersion = v;
    log(first ? "server shell" : "server shell changed", v);
    try {
      window.dispatchEvent(new CustomEvent("ltp-app-version", { detail: { version: v } }));
    } catch (e) { /* CustomEvent unsupported — the footer just won't update */ }
  }

  function notify(collection) {
    (listeners[collection] || []).slice().forEach(function(fn) {
      // One subscriber throwing must never stop the others from refreshing.
      try { fn(collection, stamps[collection]); }
      catch (e) { console.error("[LTP live] subscriber failed for " + collection, e); }
    });
  }

  // ── Polling / on-demand revalidation ──────────────────────────────────────

  // One GET /api/versions. Concurrent callers share the in-flight request so a
  // BroadcastChannel ping, a focus event and a poll tick landing together cost
  // one round trip, not three.
  function revalidate() {
    if (inFlightRevalidate) return inFlightRevalidate;
    inFlightRevalidate = apiFetch(VERSIONS_URL)
      .then(function(r) {
        if (r.status === 401) { window.location.href = "/auth/login"; return null; }
        return r.ok ? r.json() : null;
      })
      .then(function(body) {
        if (!body) return [];
        noteAppVersion(body.app);
        return applyStamps(body.stamps);
      })
      .catch(function(e) { log("revalidate failed", e); return []; })
      .then(function(changed) { inFlightRevalidate = null; return changed; });
    return inFlightRevalidate;
  }

  function startPolling() {
    if (polling) return;
    polling = true;
    log("falling back to polling");
    schedulePoll();
  }

  function stopPolling() {
    polling = false;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(function() {
      pollTimer = null;
      if (!polling) return;
      // A hidden tab does not poll. It is not being read, and it revalidates
      // the moment it becomes visible again — so the bandwidth would buy
      // nothing. SSE, when connected, keeps a hidden tab live for free.
      if (document.hidden) { schedulePoll(); return; }
      revalidate().then(schedulePoll, schedulePoll);
    }, POLL_MS);
  }

  // ── SSE ───────────────────────────────────────────────────────────────────

  function connect() {
    if (source || typeof window.EventSource !== "function") {
      if (typeof window.EventSource !== "function") startPolling();
      return;
    }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    var es;
    try { es = new EventSource(STREAM_URL, { withCredentials: true }); }
    catch (e) { log("EventSource unavailable", e); startPolling(); return; }
    source = es;

    es.addEventListener("open", function() {
      log("stream open");
      recycling = false;          // a live connection ends any recycle in progress
      sseFailures = 0;
      backoffMs = BACKOFF_MIN_MS;
      // SSE is carrying us again; drop the fallback poll and its bandwidth.
      stopPolling();
    });

    es.addEventListener("sync", function(ev) {
      var payload;
      try { payload = JSON.parse(ev.data); } catch (e) { return; }
      if (!payload) return;
      noteAppVersion(payload.app);
      if (payload.stamps) applyStamps(payload.stamps);
    });

    // The server recycles a stream every livesync.MAX_STREAM_SECONDS so a
    // connection cannot outlive the session that opened it. That is a healthy
    // close, not a fault: reconnect straight away and do NOT let it count
    // toward the failure budget, or a long-lived tab would eventually decide
    // SSE was broken and downgrade itself to polling.
    es.addEventListener("bye", function() {
      log("stream recycled by the server");
      recycling = true;
      try { es.close(); } catch (e) { /* already gone */ }
      if (source === es) source = null;
      sseFailures = 0;
      backoffMs = BACKOFF_MIN_MS;
      connect();
    });

    es.addEventListener("error", function() {
      // Ignore an error from a socket we have already replaced. Identity is the
      // reliable test: the previous version cleared a sticky `recycling` flag
      // here, but a recycled socket does not always emit error after close — so
      // the flag could stay set and swallow the NEXT genuine failure, leaving the
      // window with no stream and no reconnect scheduled.
      if (es !== source) return;
      if (recycling) return;      // cleared by the replacement's open handler
      // EventSource retries on its own, so close it first — otherwise our
      // backoff and its built-in retry race and we get both.
      try { es.close(); } catch (e) { /* already gone */ }
      if (source === es) source = null;
      sseFailures += 1;
      log("stream error, failures=" + sseFailures);
      if (sseFailures >= SSE_GIVE_UP_AFTER) startPolling();
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    var base = polling ? SSE_RETRY_WHILE_POLLING_MS : backoffMs;
    // Jitter so every open window does not reconnect on the same tick after a
    // deploy — that is what would trip the rate-limit bucket.
    var delay = base * (0.5 + Math.random() * 0.5);
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    reconnectTimer = setTimeout(function() {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  // ── Same-browser tabs ─────────────────────────────────────────────────────

  function openChannel() {
    if (typeof window.BroadcastChannel !== "function") return;
    try { channel = new BroadcastChannel(CHANNEL_NAME); }
    catch (e) { return; }
    channel.onmessage = function(ev) {
      var msg = ev && ev.data;
      if (!msg || msg.type !== "wrote") return;
      // Deliberately NOT a data channel: a sibling tells us only that it wrote,
      // and we go ask the server what the truth is. Trusting a peer's payload
      // would let two tabs converge on something the server never accepted.
      log("sibling wrote", msg.collections);
      revalidate();
    };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function start() {
    if (started) return readyPromise;
    started = true;
    openChannel();

    // Seed stamps BEFORE anything fetches data — see the ordering contract.
    // Bounded, though: a stamp is an optimization, and waiting forever for one
    // would make a slow /api/versions look like a hung app.
    var seeding = revalidate();
    readyPromise = Promise.race([
      seeding,
      new Promise(function(resolve) { setTimeout(resolve, READY_TIMEOUT_MS); }),
    ]).then(function() { return stamps; }, function() { return stamps; });
    // Open the stream off the real request, not the race, so a timed-out seed
    // does not also start a stream against a backend still busy answering.
    seeding.then(connect, connect);

    document.addEventListener("visibilitychange", function() {
      if (document.hidden) return;
      // Coming back from the background is the one moment a window is most
      // likely to be wrong: a phone may have frozen the tab for hours and
      // silently killed the stream.
      revalidate();
      if (!source) { backoffMs = BACKOFF_MIN_MS; connect(); }
      if (polling) schedulePoll();
    });
    window.addEventListener("focus", function() { revalidate(); });
    // A tab restored from the bfcache resumes with state as old as its last
    // paint and does not fire visibilitychange.
    window.addEventListener("pageshow", function(e) { if (e.persisted) revalidate(); });

    return readyPromise;
  }

  window.LTP_LIVE = {
    // Resolves once the first stamp map has landed (or failed — it never
    // rejects, so a dead backend can't wedge the loading gate). Callers MUST
    // await this before their first fetch; see the ordering contract.
    ready: function() { return start(); },

    // Fire `fn(collection, stamp)` whenever `collection` changes. Returns an
    // unsubscribe function.
    subscribe: function(collection, fn) {
      if (!listeners[collection]) listeners[collection] = [];
      listeners[collection].push(fn);
      start();
      return function() {
        listeners[collection] = (listeners[collection] || []).filter(function(x) { return x !== fn; });
      };
    },

    // The stamp a collection was last seen at. Record this BEFORE fetching, and
    // compare after, so a write racing your fetch is caught rather than lost.
    stampFor: function(collection) { return stamps[collection]; },

    // Ask the server what changed, now. Safe to call freely — concurrent calls
    // share one request.
    revalidate: revalidate,

    // Tell same-browser tabs we just wrote, so they revalidate without waiting
    // for the server round trip. Best-effort and free.
    announceWrite: function(collections) {
      if (!channel || !collections || !collections.length) return;
      try { channel.postMessage({ type: "wrote", collections: collections, at: Date.now() }); }
      catch (e) { /* channel closed with the page */ }
    },

    // Diagnostics for the console — mirrors window.LTP_API_ERRORS in spirit.
    status: function() {
      return {
        connected: !!source, polling: polling, sseFailures: sseFailures,
        seeded: seeded, appVersion: appVersion, stamps: Object.assign({}, stamps),
        subscribers: Object.keys(listeners).reduce(function(acc, k) {
          if (listeners[k].length) acc[k] = listeners[k].length;
          return acc;
        }, {}),
      };
    },

    // The shell version the server last reported, for anything that missed the
    // ltp-app-version event (components/register-sw.js loads after this one).
    appVersion: function() { return appVersion; },

    // Test seam. Not used by the app.
    _applyStamps: applyStamps,
    _noteAppVersion: noteAppVersion,
    _reset: function() {
      stamps = {}; listeners = {}; seeded = false; started = false; readyPromise = null;
      appVersion = null;
      sseFailures = 0; backoffMs = BACKOFF_MIN_MS; inFlightRevalidate = null; recycling = false;
      stopPolling();
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (source) { try { source.close(); } catch (e) {} source = null; }
      if (channel) { try { channel.close(); } catch (e) {} channel = null; }
    },
  };
})();
