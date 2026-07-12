// Reliable app viewport height for iOS.
//
// CSS 100vh / 100dvh are unreliable inside an installed iOS home-screen PWA:
// on several iOS builds they report the SAFE-AREA height (screen minus the
// status-bar / home-indicator insets) rather than the full screen, which
// leaves a dead band of background below a bottom-anchored shell. The desktop
// emulator has no standalone/safe-area split, so it never reproduces it.
//
// window.innerHeight (and visualViewport) report the true visible height in
// both Safari and standalone, so we publish it as the --app-h custom property
// and size #root from it. #root keeps `height: 100dvh` as the pre-JS fallback,
// so first paint is already close and this only corrects the iOS discrepancy.
//
// Loaded FIRST (before any other script) so --app-h is set before React mounts.
// We intentionally use innerHeight, not visualViewport.height: the latter
// shrinks when the on-screen keyboard opens, which would make the whole shell
// (and the bottom tab bar) jump — we want a stable full-height shell with the
// keyboard overlaying it.
(function () {
  "use strict";
  function setAppHeight() {
    // innerHeight can be 0 very early in some engines; guard against it so we
    // never pin the shell to a zero height.
    var h = window.innerHeight;
    if (h && h > 0) {
      document.documentElement.style.setProperty("--app-h", h + "px");
    }
  }
  setAppHeight();
  window.addEventListener("resize", setAppHeight);
  window.addEventListener("orientationchange", setAppHeight);
  // pageshow catches the bfcache restore (relaunching a backgrounded PWA), where
  // a resize may not fire but the height can have changed (rotation while away).
  window.addEventListener("pageshow", setAppHeight);
})();
