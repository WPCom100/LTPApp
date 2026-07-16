// LTPApp — Web Push subscription helper (iOS 16.4+ home-screen PWA).
//
// Loaded as a same-origin script (CSP script-src has no 'unsafe-inline'), so
// like register-sw.js this is plain DOM + fetch, no React. It owns the browser
// side of push: feature-detect, request permission, subscribe against the
// server's VAPID key, and mirror the PushSubscription to /api/push/subscribe
// (and tear it down on /api/push/unsubscribe). The Settings "Notifications"
// toggle (modules/settings.js) is the only caller.
//
// iOS is the constraining platform:
//   • Web Push only works when the app is launched from the HOME SCREEN
//     (display-mode: standalone). In a normal Safari tab, PushManager is
//     absent — so supported() gates on both the APIs AND standalone.
//   • Notification.requestPermission() must run inside a user gesture. enable()
//     is therefore only ever called straight from the toggle's onClick.
//   • Every delivered push MUST show a notification (handled in sw.js) or the
//     subscription is revoked.
//
// window.LTP_Push API (all the async ones resolve, never reject — they return
// a result object so the UI can show a reason instead of crashing):
//   supported()      → bool   — APIs present AND running standalone
//   apisPresent()    → bool   — APIs present, ignoring standalone (for messaging)
//   isStandalone()   → bool   — launched from the home screen
//   getState()       → Promise<{supported, apisPresent, standalone, configured,
//                               permission, subscribed}>
//   enable()         → Promise<{ok, subscribed, reason?}>
//   disable()        → Promise<{ok, reason?}>
(function() {
  "use strict";

  // VAPID public key is base64url; PushManager wants a Uint8Array.
  function urlBase64ToUint8Array(base64String) {
    var padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    var raw = window.atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function apisPresent() {
    return (
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window
    );
  }

  function isStandalone() {
    return typeof window.LTP_isStandalone === "function"
      ? window.LTP_isStandalone()
      : false;
  }

  // Push is only actually usable when the APIs exist AND we're a home-screen
  // app (the iOS constraint; harmless-but-correct elsewhere).
  function supported() {
    return apisPresent() && isStandalone();
  }

  function permission() {
    try { return Notification.permission; } catch (e) { return "default"; }
  }

  // Fetch the server VAPID key + configured flag. Cached after first success so
  // repeated toggles don't re-hit the endpoint.
  var _vapidCache = null;
  function fetchVapid() {
    if (_vapidCache) return Promise.resolve(_vapidCache);
    return fetch("/api/push/vapid-public-key", { credentials: "include" })
      .then(function(r) { return r.ok ? r.json() : { publicKey: "", configured: false }; })
      .then(function(j) { _vapidCache = j; return j; })
      .catch(function() { return { publicKey: "", configured: false }; });
  }

  // The active service-worker registration (register-sw.js registered it).
  function getRegistration() {
    if (!("serviceWorker" in navigator)) return Promise.resolve(null);
    return navigator.serviceWorker.ready.catch(function() { return null; });
  }

  // Snapshot of everything the toggle needs to render its current state.
  function getState() {
    var base = {
      supported: supported(),
      apisPresent: apisPresent(),
      standalone: isStandalone(),
      configured: false,
      permission: permission(),
      subscribed: false,
    };
    if (!apisPresent()) return Promise.resolve(base);
    return Promise.all([fetchVapid(), getRegistration()]).then(function(res) {
      var vapid = res[0], reg = res[1];
      base.configured = !!(vapid && vapid.configured);
      if (!reg || !reg.pushManager) return base;
      return reg.pushManager.getSubscription().then(function(sub) {
        base.subscribed = !!sub;
        return base;
      }).catch(function() { return base; });
    });
  }

  // Serialize a PushSubscription to the shape /api/push/subscribe expects.
  function subToBody(sub) {
    var json = sub.toJSON ? sub.toJSON() : sub;
    return { endpoint: json.endpoint, keys: json.keys || {} };
  }

  // Turn push ON: permission → subscribe → mirror to server. Must be invoked
  // from a user gesture (see file header). Resolves with a reason on any
  // failure rather than throwing, so the toggle can surface it.
  function enable() {
    if (!apisPresent()) {
      return Promise.resolve({ ok: false, subscribed: false, reason: "unsupported" });
    }
    if (!isStandalone()) {
      return Promise.resolve({ ok: false, subscribed: false, reason: "not-standalone" });
    }
    return fetchVapid().then(function(vapid) {
      if (!vapid || !vapid.configured || !vapid.publicKey) {
        return { ok: false, subscribed: false, reason: "not-configured" };
      }
      // requestPermission returns a promise on modern browsers; the callback
      // form on very old ones. We're on iOS 16.4+/modern Chrome, so promise.
      return Promise.resolve(Notification.requestPermission()).then(function(perm) {
        if (perm !== "granted") {
          return { ok: false, subscribed: false, reason: "denied" };
        }
        return getRegistration().then(function(reg) {
          if (!reg || !reg.pushManager) {
            return { ok: false, subscribed: false, reason: "no-registration" };
          }
          var appServerKey = urlBase64ToUint8Array(vapid.publicKey);
          // Reuse an existing subscription if the browser already has one
          // (avoids InvalidStateError when the key matches).
          return reg.pushManager.getSubscription().then(function(existing) {
            if (existing) return existing;
            return reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: appServerKey,
            });
          });
        }).then(function(sub) {
          if (!sub || !sub.endpoint) {
            return { ok: false, subscribed: false, reason: "subscribe-failed" };
          }
          return fetch("/api/push/subscribe", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(subToBody(sub)),
          }).then(function(r) {
            return r.ok
              ? { ok: true, subscribed: true }
              : { ok: false, subscribed: true, reason: "server-error" };
          }).catch(function() {
            // Browser is subscribed but the server didn't record it. Report as
            // not-ok so the UI doesn't claim success it can't back up.
            return { ok: false, subscribed: true, reason: "network" };
          });
        });
      }).catch(function(e) {
        return { ok: false, subscribed: false, reason: String((e && e.message) || e) };
      });
    });
  }

  // Turn push OFF: unsubscribe the browser AND drop the server row. Best-effort
  // on both — either half failing still resolves ok:true if the sub is gone.
  function disable() {
    if (!apisPresent()) return Promise.resolve({ ok: true });
    return getRegistration().then(function(reg) {
      if (!reg || !reg.pushManager) return { ok: true };
      return reg.pushManager.getSubscription().then(function(sub) {
        if (!sub) return { ok: true };
        var body = subToBody(sub);
        // Tell the server first (while we still have the endpoint), then drop
        // the browser subscription.
        return fetch("/api/push/unsubscribe", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }).catch(function() { /* prune server-side later on 410 */ })
          .then(function() { return sub.unsubscribe().catch(function() { return false; }); })
          .then(function() { return { ok: true }; });
      });
    }).catch(function() { return { ok: true }; });
  }

  window.LTP_Push = {
    supported: supported,
    apisPresent: apisPresent,
    isStandalone: isStandalone,
    permission: permission,
    getState: getState,
    enable: enable,
    disable: disable,
  };
})();
