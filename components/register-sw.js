// LTPApp — service-worker registration, update prompt, and standalone helpers.
//
// Loaded LAST (after mount.js) as a same-origin script, because the CSP
// script-src has no 'unsafe-inline' — registration cannot live inline in
// index.html. Kept framework-independent (plain DOM, no React) so the update
// banner works on every surface: sign-in, public quote/crew views, and the
// signed-in app alike.
//
// Responsibilities:
//   1. window.LTP_isStandalone() — true when launched from the iOS/Android home
//      screen (display-mode: standalone or iOS navigator.standalone). Used by
//      the shell to swap chrome and by this file to inset the update banner.
//   2. Register /sw.js at root scope.
//   3. Detect an updated worker that is WAITING and show a persistent
//      "New version available — tap to refresh" banner. Tapping activates the
//      new worker (postMessage SKIP_WAITING) and reloads once.
//   4. window.LTP_SHELL_VERSION — the CACHE_VERSION of the worker currently
//      controlling the page, published for the app footer to show.
(function() {
  "use strict";

  // ── Standalone detection ──────────────────────────────────────────────────
  // matchMedia covers installed PWAs on all platforms; navigator.standalone is
  // the iOS-Safari-specific signal for older iOS. Either being true = installed.
  window.LTP_isStandalone = function() {
    try {
      var mm = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
      return !!(mm || window.navigator.standalone === true);
    } catch (e) {
      return false;
    }
  };

  if (!("serviceWorker" in navigator)) return;  // non-secure context or unsupported

  // ── Which shell is running ────────────────────────────────────────────────
  // Read off the CONTROLLING worker, because that is the one whose cached files
  // the page is actually executing — the registration's `waiting` worker may be
  // a newer version the user hasn't accepted yet, and reporting that as "the
  // version you're on" would be a lie in exactly the situation where the
  // question matters. Stays null when nothing controls the page (the very first
  // load, a browser without service workers, a dev server over plain http); the
  // footer then shows no version rather than inventing one.
  window.LTP_SHELL_VERSION = null;
  function readShellVersion() {
    var ctrl = navigator.serviceWorker.controller;
    if (!ctrl) return;
    var ch;
    try { ch = new MessageChannel(); } catch (e) { return; }
    ch.port1.onmessage = function(e) {
      var v = e.data && e.data.version;
      if (!v || v === window.LTP_SHELL_VERSION) return;
      window.LTP_SHELL_VERSION = v;
      // The footer renders long before the worker answers, so it listens rather
      // than reading once at mount.
      window.dispatchEvent(new Event("ltp-shell-version"));
    };
    try { ctrl.postMessage({ type: "GET_VERSION" }, [ch.port2]); } catch (e) { /* older worker */ }
  }

  var refreshing = false;
  // When the active worker changes (after the new one skips waiting), reload
  // once so the fresh shell takes over. Guarded so we never loop.
  navigator.serviceWorker.addEventListener("controllerchange", function() {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  // ── Update banner (plain DOM, theme-tinted, safe-area aware) ───────────────
  var bannerShown = false;
  function showUpdateBanner(waitingWorker) {
    if (bannerShown) return;
    bannerShown = true;
    var T = window.LTP_THEME || {};
    var bg = T.surface || "#19242B";
    var border = T.accent || "#EF5822";
    var text = T.text || "#EDF3F2";
    var ink = T.btnInk || "#1B130D";

    var bar = document.createElement("div");
    bar.setAttribute("role", "status");
    bar.style.cssText = [
      "position:fixed", "left:12px", "right:12px",
      // Sit above the home indicator / any bottom nav via the safe-area inset.
      "bottom:calc(12px + env(safe-area-inset-bottom))",
      "z-index:4000",
      "display:flex", "align-items:center", "gap:12px",
      "max-width:520px", "margin:0 auto",
      "padding:12px 14px",
      "background:" + bg,
      "border:1px solid " + border,
      "border-radius:12px",
      "box-shadow:0 8px 28px rgba(0,0,0,0.45)",
      "font-family:'DM Sans','Segoe UI',system-ui,sans-serif",
      "color:" + text,
    ].join(";");

    var msg = document.createElement("div");
    msg.style.cssText = "flex:1;min-width:0;font-size:13px;line-height:1.35;font-weight:600";
    msg.textContent = "New version available";

    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Refresh";
    btn.style.cssText = [
      "flex-shrink:0",
      "min-height:44px", "padding:0 18px",
      "background:" + border, "color:" + ink,
      "border:none", "border-radius:8px",
      "font-family:inherit", "font-size:13px", "font-weight:700",
      "cursor:pointer",
    ].join(";");
    btn.addEventListener("click", function() {
      btn.disabled = true;
      btn.textContent = "Refreshing…";
      // Ask the waiting worker to take over; controllerchange then reloads.
      if (waitingWorker) waitingWorker.postMessage({ type: "SKIP_WAITING" });
      // Fallback: if there is no controllerchange within a moment, hard reload.
      setTimeout(function() { if (!refreshing) window.location.reload(); }, 2000);
    });

    var close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "✕";
    close.style.cssText = [
      "flex-shrink:0", "min-width:44px", "min-height:44px",
      "background:transparent", "border:none",
      "color:" + (T.textMut || "#6E7E86"),
      "font-size:16px", "cursor:pointer", "font-family:inherit",
    ].join(";");
    close.addEventListener("click", function() {
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    });

    bar.appendChild(msg);
    bar.appendChild(btn);
    bar.appendChild(close);
    document.body.appendChild(bar);
  }

  window.addEventListener("load", function() {
    readShellVersion();
    // A worker that took control mid-load (first visit, or after activate()
    // claims) wasn't there for the call above.
    navigator.serviceWorker.ready.then(readShellVersion).catch(function() {});

    navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(function(reg) {
      // Case 1: a worker is already waiting (update installed on a prior visit).
      if (reg.waiting && navigator.serviceWorker.controller) {
        showUpdateBanner(reg.waiting);
      }
      // Case 2: an update is found now — watch it install, then prompt.
      reg.addEventListener("updatefound", function() {
        var installing = reg.installing;
        if (!installing) return;
        installing.addEventListener("statechange", function() {
          // "installed" + an existing controller ⇒ this is an UPDATE (not the
          // first install), so it's safe to prompt the user to refresh.
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            showUpdateBanner(reg.waiting || installing);
          }
        });
      });
    }).catch(function() {
      // Registration failing (e.g. non-secure LAN dev over http) is non-fatal —
      // the app runs normally without offline support.
    });
  });
})();
