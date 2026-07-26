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

  // Options for a "Primary Contact" <select> whose candidate list is narrowed
  // (to a project's contacts, or a company's).
  //
  // The narrowing can exclude a contact who is ALREADY selected — link a
  // project that doesn't list them, or pick a contact then switch company. A
  // native <select> whose value isn't among its options silently displays the
  // first one, so the field would read "(none)" while the draft still carried
  // that contact's id, and the quote would send addressed to someone the UI
  // said wasn't chosen. Appending the selected contact keeps display and state
  // honest; they're marked so it's clear why they're listed.
  H.contactSelectOptions = function(candidates, selectedId, allContacts) {
    var opts = (candidates || []).map(function(c) {
      return { value: c.id, label: H.contactName(c) + (c.role ? " — " + c.role : "") };
    });
    if (selectedId == null) return opts;
    var already = opts.some(function(o) { return o.value === selectedId; });
    if (already) return opts;
    var sel = H.findById(allContacts, selectedId);
    if (!sel) return opts;
    return opts.concat([{ value: sel.id, label: H.contactName(sel) + " — not on this list" }]);
  };

  window.LTP_HELPERS = H;
})();
