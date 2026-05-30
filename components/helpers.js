// LTP Shared Helpers — cross-cutting utilities used by every feature module.
//
// Goal: kill copy-pasted one-liners. If you find yourself writing
// `list.find(x => x.id === id)` or `companies.find(...)` in a module, use
// LTP_HELPERS.findById / lookupCompany / etc. instead. Adding to this file is
// preferred over re-inventing in a module — keeps logic in one place where
// it can be tested and updated.
//
// All helpers are pure (no side effects, no DOM, no state). They're safe to
// call from render bodies.
(function() {
  var H = {};

  // ── ID lookups ──────────────────────────────────────────────────────────
  // Returns the first item whose .id matches, or undefined. Tolerates null
  // lists (returns undefined) so callers don't need a null-check before.
  H.findById = function(list, id) {
    if (!list || id == null) return undefined;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return undefined;
  };

  // For hot paths where the same lookup runs many times (e.g. mapping a
  // list of allocations to their equipment names), build a Map once and
  // reuse. O(n) build, O(1) lookup. Caller is responsible for rebuilding
  // when the source list changes.
  H.byId = function(list) {
    var map = {};
    if (!list) return map;
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (item && item.id != null) map[item.id] = item;
    }
    return map;
  };

  // ── Entity-name conveniences ────────────────────────────────────────────
  H.contactName = function(contact) {
    if (!contact) return "";
    return ((contact.firstName || "") + " " + (contact.lastName || "")).trim();
  };

  H.companyName = function(companies, id) {
    var c = H.findById(companies, id);
    return c ? c.name : "";
  };

  H.projectName = function(projects, id) {
    var p = H.findById(projects, id);
    return p ? p.name : "";
  };

  // ── UI behavior helpers ────────────────────────────────────────────────
  // Spread `LTP_HELPERS.hoverBg(B)` onto any row/button to get the standard
  // "background lightens on hover" treatment. Avoids repeating the inline
  // onMouseOver/onMouseOut pattern that lives in ~8 modules today.
  H.hoverBg = function(B, restingColor) {
    var resting = restingColor != null ? restingColor : "transparent";
    var hover = B && B.raised ? B.raised : "#1a1a1a";
    return {
      onMouseOver: function(e) { e.currentTarget.style.background = hover; },
      onMouseOut:  function(e) { e.currentTarget.style.background = resting; },
    };
  };

  // Dropdown/search-select blur trick: dropdowns close before the click on
  // a result fires unless we delay the blur. Use this instead of inlining
  // `setTimeout(fn, 200)` — keeps the magic number in one place.
  H.BLUR_DELAY_MS = 200;
  H.delayedBlur = function(fn) {
    return function() { setTimeout(fn, H.BLUR_DELAY_MS); };
  };

  window.LTP_HELPERS = H;
})();
