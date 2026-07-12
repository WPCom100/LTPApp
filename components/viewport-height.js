// Reliable app viewport height for iOS.
//
// CSS 100vh / 100dvh — and even window.innerHeight — are wrong inside an
// installed iOS home-screen PWA: in standalone mode they report the height
// MINUS the top safe-area inset (status bar / Dynamic Island), even though the
// black-translucent webview actually spans the full screen. Measured on an
// iPhone 17 Pro Max: innerHeight = 100dvh = 894, safe-inset-top = 62,
// screen.height = 956, and 894 + 62 = 956. Sizing the shell to 894 leaves a
// 62px dead band at the bottom. A desktop emulator has no standalone/safe-area
// split, so it never reproduces this.
//
// Fix: publish the true drawable height as --app-h and size #root from it.
//   - Browser / Safari: innerHeight (tracks the dynamic toolbars correctly).
//   - Standalone: innerHeight + safe-area-inset-top, capped at screen.height,
//     to add back the inset iOS wrongly subtracts. In landscape the top inset
//     is 0, so this is a no-op there. #root keeps 100dvh as the pre-JS fallback.
//
// Loaded FIRST (before any other script) so --app-h is set before React mounts.
// We use innerHeight, not visualViewport.height: the latter shrinks when the
// keyboard opens, which would make the whole shell (and the bottom tab bar)
// jump — we want a stable full-height shell with the keyboard overlaying it.
(function () {
  "use strict";

  function isStandalone() {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
           window.navigator.standalone === true;
  }

  // Read env(safe-area-inset-top) in px via a hidden probe (0 when there's no
  // inset, or before viewport-fit=cover resolves).
  function safeInsetTop() {
    if (!document.body) return 0;
    var probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);";
    document.body.appendChild(probe);
    var v = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    probe.remove();
    return v;
  }

  function setAppHeight() {
    // innerHeight can be 0 very early in some engines; guard against it so we
    // never pin the shell to a zero height.
    var h = window.innerHeight;
    if (!h || h <= 0) return;
    if (isStandalone()) {
      var target = h + safeInsetTop();       // add back the inset iOS subtracts
      var sh = (window.screen && window.screen.height) || 0;
      if (sh && target > sh) target = sh;     // never exceed the physical screen
      h = target;
    }
    document.documentElement.style.setProperty("--app-h", h + "px");
  }
  setAppHeight();
  window.addEventListener("resize", setAppHeight);
  window.addEventListener("orientationchange", setAppHeight);
  // pageshow catches the bfcache restore (relaunching a backgrounded PWA), where
  // a resize may not fire but the height can have changed (rotation while away).
  window.addEventListener("pageshow", setAppHeight);

  // ── TEMPORARY on-screen diagnostic (remove once the iOS gap is resolved) ────
  // A standalone home-screen app has no address bar, so a URL flag can't be
  // typed. Instead we show a small "VH" button; tapping it toggles an overlay of
  // the raw viewport metrics (innerHeight vs CSS 100dvh vs screen vs safe-area
  // insets vs --app-h). Shown only on mobile-width / installed app, never on a
  // desktop browser. Also auto-opens if ?vhdebug is present (works in Safari).
  var standalone = isStandalone();
  var forceOn = /vhdebug/.test(location.search) || /vhdebug/.test(location.hash);
  if (standalone || window.innerWidth <= 600 || forceOn) {
    var overlayVisible = forceOn;

    function overlayText() {
      var probe = document.createElement("div");
      probe.style.cssText = "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;width:0;height:100dvh;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);";
      document.body.appendChild(probe);
      var cs = getComputedStyle(probe);
      var dvh = Math.round(probe.getBoundingClientRect().height);
      var sat = cs.paddingTop, sab = cs.paddingBottom;
      probe.remove();
      var vv = window.visualViewport || {};
      return [
        "standalone: " + standalone,
        "innerHeight: " + window.innerHeight,
        "clientHeight: " + document.documentElement.clientHeight,
        "100dvh(px): " + dvh,
        "screen.h: " + (window.screen && window.screen.height),
        "visualVP.h: " + Math.round(vv.height || 0) + " off:" + Math.round(vv.offsetTop || 0),
        "--app-h: " + document.documentElement.style.getPropertyValue("--app-h"),
        "safe t/b: " + sat + " / " + sab,
      ].join("\n");
    }

    function render() {
      var box = document.getElementById("__vhdebug");
      if (!overlayVisible) { if (box) box.remove(); return; }
      if (!box) {
        box = document.createElement("pre");
        box.id = "__vhdebug";
        box.style.cssText = "position:fixed;left:8px;top:calc(env(safe-area-inset-top) + 46px);z-index:99998;margin:0;padding:8px 10px;background:rgba(0,0,0,.85);color:#5FD08A;font:11px/1.5 ui-monospace,Menlo,monospace;border:1px solid #EF5822;border-radius:8px;max-width:80vw;white-space:pre;pointer-events:none;";
        document.body.appendChild(box);
      }
      box.textContent = overlayText();
    }

    function addButton() {
      if (!document.body || document.getElementById("__vhbtn")) return;
      var btn = document.createElement("button");
      btn.id = "__vhbtn";
      btn.type = "button";
      btn.textContent = "VH";
      btn.style.cssText = "position:fixed;top:calc(env(safe-area-inset-top) + 6px);right:8px;z-index:99999;width:38px;height:38px;border-radius:50%;background:#EF5822;color:#1B130D;border:none;font:700 12px/1 ui-monospace,Menlo,monospace;box-shadow:0 2px 10px rgba(0,0,0,.5);";
      btn.addEventListener("click", function () { overlayVisible = !overlayVisible; render(); });
      document.body.appendChild(btn);
      render();
    }

    if (document.body) addButton();
    else document.addEventListener("DOMContentLoaded", addButton);
    window.addEventListener("resize", render);
    window.addEventListener("orientationchange", render);
  }
})();
