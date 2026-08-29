// LTP domain — shared utilities: dates, times, ids, URLs, addresses, notes.
//
// Split out of theme.js, which was 96% not-theme. Nothing here encodes a
// business rule; it is the formatting and identity layer everything else uses.
// If you are looking for pricing, see domain-labor.js or domain-docs.js.
//
// Also carries the app-wide number-input select-on-focus listener at the
// bottom — the only load-time DOM side effect in the original file. It is
// idempotent behind window.__LTP_NUM_SELECT_BOUND.
//
// LOAD ORDER CONTRACT — read before moving this <script> tag.
//   These domain-*.js files were split out of theme.js. They must stay in
//   index.html's THEME slot (group 3), together and in the listed order, and
//   BEFORE every components/ and modules/ file — NOT down in the components
//   group where their path suggests they belong. 46 frontend files alias these
//   exports into IIFE-locals at their OWN load time (modules/quotes-list.js:9
//   is `var computeTotals = window.LTP_QUOTE_TOTALS;`), so a symbol defined
//   after its consumer's <script> is captured as undefined, not late-bound.
//   They also belong in sw.js's SAME_ORIGIN_PRECACHE boot chain beside
//   /theme.js, or the shell drops them on a cold offline launch.
//
// Nothing here reads another LTP_ symbol at load time, so the order AMONG
// these files is free; it is fixed only for readability. The one genuine
// load-order edge in the original file (the LTP_STATUS_COLORS IIFE calling
// LTP_badgeFromHex) stayed behind in theme.js on purpose.


// Global date formatter: "2026-04-22" => "April 22nd, 2026"
window.LTP_formatDate = function(dateStr) {
  if (!dateStr) return "";
  var parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  var months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  var y = parts[0], m = parseInt(parts[1], 10), d = parseInt(parts[2], 10);
  var suffix = "th";
  if (d === 1 || d === 21 || d === 31) suffix = "st";
  else if (d === 2 || d === 22) suffix = "nd";
  else if (d === 3 || d === 23) suffix = "rd";
  return months[m - 1] + " " + d + suffix + ", " + y;
};

// Duration calculator: given start date/time and end date/time, return human string
window.LTP_calcDuration = function(startDate, startTime, endDate, endTime) {
  if (!startDate || !startTime || !endDate || !endTime) return "";
  var s = new Date(startDate + "T" + startTime);
  var e = new Date(endDate + "T" + endTime);
  var diff = e - s;
  if (diff <= 0) return "";
  var hrs = Math.floor(diff / 3600000);
  var mins = Math.floor((diff % 3600000) / 60000);
  if (hrs > 0 && mins > 0) return hrs + "h " + mins + "m";
  if (hrs > 0) return hrs + "h";
  return mins + "m";
};

// Time formatter: "14:00" => "2:00 PM", "08:30" => "8:30 AM"
window.LTP_formatTime = function(timeStr) {
  if (!timeStr) return "";
  var parts = timeStr.split(":");
  if (parts.length < 2) return timeStr;
  var hr = parseInt(parts[0], 10);
  var min = parts[1];
  var ampm = hr >= 12 ? "PM" : "AM";
  var hr12 = hr % 12;
  if (hr12 === 0) hr12 = 12;
  return hr12 + ":" + min + " " + ampm;
};

// ── Shared Utilities ─────────────────────────────────────────────────────────
var _idCounter = 0;
window.LTP_genId = function(prefix) { _idCounter++; return (prefix || "x") + "-" + Date.now() + "-" + _idCounter; };
window.LTP_todayISO = function() { return new Date().toISOString().substring(0, 10); };

// 256-bit URL-safe random token, equivalent to Python's secrets.token_urlsafe(32).
// Used by quote/invoice save flows to mint a share_token at the moment of
// creation, so the entity's React state has the token immediately — the
// Preview button (gated on draft.shareToken) appears without waiting for
// the server round-trip. Backend's create() respects a client-supplied
// shareToken (only mints when absent), so this is the source of truth.
window.LTP_genShareToken = function() {
  var bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // Base64-encode → URL-safe → strip padding.
  var b64 = "";
  for (var i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
  return btoa(b64).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// Unsaved-changes guard. Owns the dirty-state for the calling component
// and keeps window.__LTP_UNSAVED in sync — synchronously, not via useEffect.
//
// Why synchronous matters: router.navigate() reads window.__LTP_UNSAVED in
// the click handler. If a save() does
//     setIsDirty(false);
//     nav("quotes/" + newId);
// React queues the state update but doesn't commit until the handler
// returns. A useEffect-based mirror would still see the OLD value of
// isDirty when nav() runs, and the user would get a bogus "You have
// unsaved changes" prompt right after a successful save.
//
// API change: this hook used to take `isDirty` as an arg and just mirror
// to the global from a useEffect. It now OWNS the state — caller does:
//     var [isDirty, setIsDirty] = window.LTP_useUnsavedGuard();
// Every call to setIsDirty writes the global immediately, then schedules
// the React update. Both are in sync at every observable moment.
//
// (Render-time mirror is also kept as belt-and-suspenders — covers the
// rare cases where state changes from somewhere other than the returned
// setter, e.g. component re-mount.)
window.LTP_useUnsavedGuard = function() {
  var pair = React.useState(false);
  var isDirty = pair[0];
  var setRaw = pair[1];

  // Render-time mirror keeps the global in sync with whatever value React
  // is currently rendering. Catches the unmount/remount case.
  window.__LTP_UNSAVED = !!isDirty;

  // Setter that writes the global FIRST (synchronously), then schedules
  // the React state update. Supports the (prev) => next functional form.
  function setIsDirty(next) {
    var resolved = typeof next === "function" ? !!next(isDirty) : !!next;
    window.__LTP_UNSAVED = resolved;
    setRaw(resolved);
  }

  React.useEffect(function() {
    function onBeforeUnload(e) { if (isDirty) { e.preventDefault(); e.returnValue = ""; } }
    window.addEventListener("beforeunload", onBeforeUnload);
    return function() {
      window.removeEventListener("beforeunload", onBeforeUnload);
      // Component leaving the tree no longer owns any dirty state.
      window.__LTP_UNSAVED = false;
    };
  }, [isDirty]);

  return [isDirty, setIsDirty];
};

// ── Invoice & Quote display helpers (used across modules) ────────────────
// Format a client's billing address (Company or Contact) into one string:
// "<street>, City, ST ZIP". `joiner` (default ", ") also replaces newlines in
// the multi-line street field. Used everywhere a client address is displayed
// (CRM, client view) so the structured city/state/zip fields show up too.
// Protocol-guard a user/calendar-supplied URL before using it as an href.
// Anything with an explicit scheme other than http/https/mailto/tel (notably
// javascript:) becomes "" so the link is inert; relative/scheme-relative URLs
// pass (they can't carry a javascript: payload). Control chars are stripped
// first so "java\tscript:" can't slip past. SECURITY_REVIEW.md L7.
window.LTP_safeUrl = function(url) {
  if (!url) return "";
  var s = String(url).replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (/^[a-z][a-z0-9+.\-]*:/i.test(s)) {
    return /^(https?|mailto|tel):/i.test(s) ? s : "";
  }
  return s;
};

// ── Note line items ─────────────────────────────────────────────────────────
// Notes are authored in a plain <textarea> on quotes and invoices, so the
// author's blank lines, indentation and runs of spaces are part of the content
// — they carry meaning (bulleted call-times, indented sub-points). Historically
// the builders stored `noteText.trim()`, which was fine for the emptiness check
// but silently ate a leading indent on the first line.
//
// LTP_noteText normalizes line endings and drops only TRAILING whitespace (a
// stray newline left by the Enter key renders as a blank gap in the PDF and
// client view, and is never intentional). Everything else survives verbatim —
// leading indentation included.
window.LTP_noteText = function(raw) {
  if (raw == null) return "";
  return String(raw).replace(/\r\n?/g, "\n").replace(/[ \t\n]+$/, "");
};

// True when a note has any visible content — the guard for "Add Note".
window.LTP_noteHasText = function(raw) {
  return window.LTP_noteText(raw).trim() !== "";
};

// One-line digest of a note for places that can only show a single line — the
// quote/invoice change log. Takes the first line that has content, collapses
// its internal whitespace and ellipsizes past `max` (default 60).
window.LTP_noteSummary = function(raw, max) {
  var lines = window.LTP_noteText(raw).split("\n");
  var first = "";
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].trim()) { first = lines[i].trim().replace(/\s+/g, " "); break; }
  }
  var lim = max || 60;
  if (first.length > lim) first = first.slice(0, lim - 1).replace(/\s+$/, "") + "…";
  return first;
};

// Shared style fragment for every surface that DISPLAYS note text (builder
// rows, invoice rows, the client-facing view). `pre-wrap` is what makes the
// authored newlines and spacing survive into the DOM; the break rules keep a
// long unbroken token from blowing out the column.
window.LTP_NOTE_TEXT_STYLE = {
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  wordBreak: "break-word",
};

window.LTP_formatAddress = function(e, joiner) {
  if (!e) return "";
  joiner = joiner || ", ";
  var street = (e.address || "").replace(/\n+/g, joiner).trim();
  var city = (e.city || "").trim(), st = (e.state || "").trim(), zip = (e.zip || "").trim();
  var sz = [st, zip].filter(function(x) { return x; }).join(" ");
  var cityLine = (city && sz) ? (city + ", " + sz) : (city || sz);
  return [street, cityLine].filter(function(x) { return x; }).join(joiner);
};

// Settings-shaped address (street/suite/city/state/zip) → single inline string.
// Used by the public client-view and crew-view headers. Distinct from
// LTP_formatAddress, which works on CRM entity shapes (address/city/state/zip).
window.LTP_settingsAddress = function(s) {
  if (!s) return "";
  var line1 = (s.street || "") + (s.suite ? ", " + s.suite : "");
  var line2 = (s.city || "") + (s.state ? ", " + s.state : "") + (s.zip ? " " + s.zip : "");
  return [line1, line2].filter(function(p) { return p && p.trim(); }).join(". ");
};

// Build a Google Calendar "add event" template URL. Shared by the CRM meetings
// and projects views and the public crew call sheet. When {endTime} is given it
// sets the wrap (rolling to the next day for an overnight shift whose wrap is
// earlier than the call); otherwise the event runs one hour (same minutes, hour
// clamped to 23). {location} adds a place; attendees is an array of emails;
// details is optional. Times are floating (no timezone) so they render as the
// posted wall-clock wherever the crew member opens the link.
window.LTP_gcalUrl = function(opts) {
  opts = opts || {};
  var time = opts.time || "00:00";
  var d = (opts.date || "").replace(/-/g, "");
  var startStamp = d + "T" + time.replace(":", "") + "00";
  var endStamp;
  if (opts.endTime) {
    // A wrap earlier than the call means the shift runs past midnight, so the
    // end date advances one calendar day.
    var endD = d;
    if (opts.date && opts.endTime < time) {
      var nd = new Date(opts.date + "T00:00:00");
      nd.setDate(nd.getDate() + 1);
      endD = "" + nd.getFullYear() + String(nd.getMonth() + 1).padStart(2, "0") + String(nd.getDate()).padStart(2, "0");
    }
    endStamp = endD + "T" + opts.endTime.replace(":", "") + "00";
  } else {
    var eh = String(Math.min(23, parseInt(time.split(":")[0]) + 1)).padStart(2, "0");
    endStamp = d + "T" + eh + time.split(":")[1] + "00";
  }
  var url = "https://calendar.google.com/calendar/render?action=TEMPLATE"
    + "&text=" + encodeURIComponent(opts.title || "")
    + "&dates=" + startStamp + "/" + endStamp;
  if (opts.details) url += "&details=" + encodeURIComponent(opts.details);
  if (opts.location) url += "&location=" + encodeURIComponent(opts.location);
  return url + "&add=" + (opts.attendees || []).join(",");
};

// Resolve an entity's display name for an activity-log diff: its name, else
// "ID <n>" when the row is missing, else "None" when unset. Shared by the
// quote/invoice change-diff engines (company + project fields).
window.LTP_diffEntityName = function(list, id) {
  if (!id) return "None";
  return (((list || []).find(function(x) { return x.id === id; }) || {}).name) || ("ID " + id);
};

// Currency display — always to the cent. Line items can carry fractional
// quantities, so totals and subtotals have real cents; rounding them to whole
// dollars (the app's former display convention) silently dropped that money.
// Returns a thousands-separated two-decimal string WITHOUT a currency symbol,
// so callers keep their own "$" / "−$" prefix. Mirrors the PDF's _fmt_money
// and the client view's fmtMoney so every surface reads to the same cent.
window.LTP_money = function(n) {
  return (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// Select a number field's contents when it gains focus, so the user's first
// keystroke replaces the current value (e.g. a default 0) instead of
// appending to it — no more "type, then go back and delete the leading 0".
// Bound once at the document level (event delegation) so it covers EVERY
// numeric input app-wide, regardless of which component renders it (LTPInput,
// the rentals R.INP inputs, raw <input type="number">, etc.). The setTimeout
// lets the browser's own click cursor-placement settle first, then we select.
if (typeof document !== "undefined" && !window.__LTP_NUM_SELECT_BOUND) {
  window.__LTP_NUM_SELECT_BOUND = true;
  document.addEventListener("focusin", function(e) {
    var el = e.target;
    if (el && el.tagName === "INPUT" && el.type === "number") {
      setTimeout(function() { try { el.select(); } catch (_e) {} }, 0);
    }
  });
}
