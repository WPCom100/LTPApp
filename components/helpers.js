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

  // Two-tier candidate list for a "Primary Contact" picker whose candidates are
  // narrowed (to a project's contacts, or a company's). Feeds the chip-style
  // ContactSearchField in components/search-select.js, which renders contact
  // RECORDS itself — name on one line, role/email beneath.
  //
  // Tier 1 is the contacts attached to this client or project; tier 2 is
  // everyone else, behind a deliberate click — the same pattern the crew pickers
  // use (LTP_crewSelectOptions), and for the same reason: a name match from an
  // unrelated client shouldn't bury the handful of people who belong to this
  // one. Without the second tier, a client whose contact was never linked is
  // simply unpickable, which is the state a narrowed one-tier list leaves you in.
  //
  // Crew are excluded from tier 2: they're staff, not people to bill.
  //
  // An already-selected contact who fails the narrowing is lifted into TIER 1 —
  // link a project that doesn't list them, or pick a contact then switch
  // company, and re-opening the list to change your mind must still show who is
  // currently picked without first expanding tier 2.
  //
  // Returns { primary: [contact], rest: [contact], moreLabel: str|null }.
  H.contactFieldTiers = function (candidates, selectedId, allContacts) {
    var seen = {};
    var primary = [];
    (candidates || []).forEach(function (c) {
      if (!c || c.id == null || seen[c.id]) return;
      seen[c.id] = 1;
      primary.push(c);
    });
    if (selectedId != null && !seen[selectedId]) {
      var sel = H.findById(allContacts, selectedId);
      if (sel) { seen[sel.id] = 1; primary.push(sel); }
    }
    var rest = (allContacts || [])
      .filter(function (c) { return c && c.id != null && !seen[c.id] && !c.isCrew; })
      .sort(function (a, b) { return H.contactName(a).localeCompare(H.contactName(b)); });
    return {
      primary: primary,
      rest: rest,
      moreLabel: rest.length ? "Other contacts (" + rest.length + ") — not linked to this client" : null,
    };
  };

  // Saved-venue suggestions for the project form's venue field (README.md
  // "Saved venues"). `venues` is the read-only /api/venues collection; `query`
  // is whatever is typed in the Venue Name box. Matches on the name or the
  // address, so "Austin" finds every venue there. Names that START with the
  // query sort first, then the rest alphabetically; an empty query browses the
  // whole list. Capped like the other pickers so a long memory never renders in
  // full on focus.
  H.venueSuggestions = function (venues, query, cap) {
    var q = (query || "").trim().toLowerCase();
    var limit = cap == null ? 50 : cap;
    var rows = (venues || []).filter(function (v) {
      if (!v || !(v.name || "").trim()) return false;
      if (!q) return true;
      return (v.name || "").toLowerCase().indexOf(q) !== -1
          || (v.address || "").toLowerCase().indexOf(q) !== -1;
    });
    rows.sort(function (a, b) {
      var an = (a.name || "").toLowerCase(), bn = (b.name || "").toLowerCase();
      if (q) {
        var ap = an.indexOf(q) === 0 ? 0 : 1, bp = bn.indexOf(q) === 0 ? 0 : 1;
        if (ap !== bp) return ap - bp;
      }
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    return rows.length > limit ? rows.slice(0, limit) : rows;
  };

  // What picking a saved venue fills into a project form: the venue's name
  // always; its address and instructions only when the venue has them, so a
  // venue remembered by name alone never blanks what was already typed. The
  // address, when taken, is a TYPED address — the "use the client company's
  // address" switch is turned off so the venue's own address shows.
  H.venueFill = function (venue, current) {
    var cur = current || {};
    var out = { venue: (venue && venue.name) || "" };
    var addr = ((venue && venue.address) || "").trim();
    var instr = ((venue && venue.instructions) || "").trim();
    out.siteAddress = addr || cur.siteAddress || "";
    out.siteUseCompanyAddress = addr ? false : !!cur.siteUseCompanyAddress;
    out.siteInstructions = instr || cur.siteInstructions || "";
    return out;
  };

  window.LTP_HELPERS = H;
})();
