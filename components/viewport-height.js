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

  // ── Opt-in diagnostic ──────────────────────────────────────────────────────
  // Add ?vhdebug to the URL (e.g. https://…/?vhdebug#/dashboard) to overlay the
  // raw viewport metrics. Off by default — never shows in normal use. Lets us
  // see exactly what the device reports (innerHeight vs CSS 100dvh vs screen vs
  // safe-area insets) without a Mac + Web Inspector.
  if (/vhdebug/.test(location.search) || /vhdebug/.test(location.hash)) {
    var draw = function () {
      if (!document.body) { return; }
      var probe = document.createElement("div");
      probe.style.cssText = "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;width:0;height:100dvh;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);";
      document.body.appendChild(probe);
      var cs = getComputedStyle(probe);
      var dvh = Math.round(probe.getBoundingClientRect().height);
      var sat = cs.paddingTop, sab = cs.paddingBottom;
      probe.remove();
      var vv = window.visualViewport || {};
      var standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
      var box = document.getElementById("__vhdebug") || document.createElement("pre");
      box.id = "__vhdebug";
      box.style.cssText = "position:fixed;left:8px;top:8px;z-index:99999;margin:0;padding:8px 10px;background:rgba(0,0,0,.82);color:#5FD08A;font:11px/1.5 ui-monospace,Menlo,monospace;border:1px solid #EF5822;border-radius:8px;max-width:70vw;white-space:pre;pointer-events:none;";
      box.textContent = [
        "standalone: " + standalone,
        "innerHeight: " + window.innerHeight,
        "clientHeight: " + document.documentElement.clientHeight,
        "100dvh(px): " + dvh,
        "screen.height: " + (window.screen && window.screen.height),
        "visualVP.h: " + Math.round(vv.height || 0) + " off:" + Math.round(vv.offsetTop || 0),
        "--app-h: " + document.documentElement.style.getPropertyValue("--app-h"),
        "safe top/bot: " + sat + " / " + sab,
      ].join("\n");
      if (!box.parentNode) document.body.appendChild(box);
    };
    draw();
    window.addEventListener("resize", draw);
    window.addEventListener("orientationchange", draw);
    // body may not be parsed yet if this ever moves into <head>.
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", draw);
  }
})();
