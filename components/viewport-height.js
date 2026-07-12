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
})();
