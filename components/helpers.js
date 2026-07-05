// LTP Shared Helpers — cross-cutting utilities used by every feature module.
//
// Goal: kill copy-pasted one-liners. If you find yourself writing
// `list.find(x => x.id === id)` in a module, use LTP_HELPERS.findById instead.
// Adding to this file is preferred over re-inventing in a module — keeps logic
// in one place where it can be tested and updated.
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

  // ── Entity-name conveniences ────────────────────────────────────────────
  H.contactName = function(contact) {
    if (!contact) return "";
    return ((contact.firstName || "") + " " + (contact.lastName || "")).trim();
  };

  window.LTP_HELPERS = H;
})();
