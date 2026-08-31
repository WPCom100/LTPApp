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
    return function() { window.removeEventListener("beforeunload", onBeforeUnload); };
  }, [isDirty]);

  // "No longer owns any dirty state" is an UNMOUNT concern, so it gets its own
  // effect with empty deps. It used to live in the cleanup above, which re-runs
  // on every isDirty change — and React runs that cleanup AFTER the render-time
  // mirror, so the flag was wiped by the very transition it exists to record:
  //
  //   setIsDirty(true) → global = true      (synchronous setter)
  //   re-render        → global = true      (render-time mirror)
  //   effect cleanup   → global = FALSE     ← deps [isDirty] changed
  //   effect body      → (never restored it)
  //
  // The result was an editor full of unsaved work that router.navigate() saw as
  // clean, so leaving the page discarded it with no prompt at all.
  React.useEffect(function() {
    return function() { window.__LTP_UNSAVED = false; };
  }, []);

  return [isDirty, setIsDirty];
};

// Warn-only companion to LTP_useRemoteEdits, for the ~dozen modal forms that
// seed one useState PER FIELD from a row rather than holding a single draft.
//
// Those forms cannot adopt a newer version — re-seeding fifteen independent
// setters mid-edit is not something to do behind someone's back — but they can
// and must SAY when the row moved, because otherwise their save silently
// overwrites it. (If-Match does not catch this on its own: live sync refreshes
// the row's revision underneath a form that is holding field values from before
// it, so the write looks current to the server.)
//
// Self-sufficient by design: it finds the record itself in
// window.LTP_DATA_LIVE, so a form needs one line and no new props threaded down
// from its parent.
//
//   collection  a persisted state key ("companies", "services", …). A singleton
//               blob like "settings" works too — id is then ignored.
//   id          the row's id.
//   notice      { title, message } for the warning.
//   pick        optional record → the slice this editor actually owns, so an
//               editor of one note inside a project is not woken by an unrelated
//               change to the same project.
//
// Deliberately fires even when the form is untouched: what it is showing is
// stale either way, and unlike a draft editor there is nothing safe to silently
// refresh. It does NOT fire on this window's own writes — a form that saves and
// stays mounted for a commit used to tell the person who saved that another
// window had changed the row; see the remote-epoch note in LTP_useRemoteEdits.
window.LTP_useRecordWatch = function(collection, id, notice, pick) {
  // Latch the first real id we are given. Callers usually pass something like
  // `initial && initial.id`, which goes undefined the moment the row is deleted
  // elsewhere — and since the id is part of the resetKey, that flipped the key,
  // which reset the seen baseline, which made the deletion look like "a fresh
  // editor on nothing" instead of the change it is. The warning never fired and
  // the form went on accepting edits it could no longer save anywhere.
  var idRef = React.useRef(null);
  if (id != null && idRef.current === null) idRef.current = id;
  var watchId = id != null ? id : idRef.current;

  var live = (window.LTP_DATA_LIVE || {})[collection];
  var record = null;
  if (Array.isArray(live)) {
    if (watchId != null) {
      for (var i = 0; i < live.length; i++) {
        if (live[i] && live[i].id === watchId) { record = live[i]; break; }
      }
    }
  } else if (live && typeof live === "object") {
    record = live;                       // singleton blob
  }
  window.LTP_useRemoteEdits(
    record,
    pick || function(r) { return r; },
    true,                                // always "dirty": warn, never adopt
    null,
    notice,
    // Keyed on the LATCHED id, so a deletion is a change to report rather than a
    // reset that hides it.
    String(collection) + ":" + String(watchId),
    collection);
};


// ═══════════════════════════════════════════════════════════════════════════
//   A RECORD CHANGING WHILE AN EDITOR HAS IT OPEN
// ═══════════════════════════════════════════════════════════════════════════
//
// The three big editors — schedule builder, quote builder, invoice builder —
// all work the same way: deep-clone the record into a local `draft`, reseed
// only when the record's ID changes. That is what stops a background refresh
// from eating half-typed work, but it also means a record that moved
// underneath them (live sync — components/live-sync.js) stays invisible right
// up until the editor saves over it.
//
// This hook is the shared response, and the branch is whether there is unsaved
// work to protect:
//
//   nothing unsaved → adopt the newer version silently. Strictly better than
//                     continuing to show data we already know is stale.
//   unsaved edits   → keep them and say so, ONCE per editing session.
//                     Discarding someone's typing to win a race is the wrong
//                     trade for a workspace this size, and repeating the notice
//                     on every remote change would be noise.
//
// Args:
//   record    the live row out of persisted state. Live sync hands back a new
//             object identity whenever it refetches, which is the trigger.
//             Falsy (a brand-new unsaved record) makes this a no-op.
//   snapshot  record → the editor's draft shape. Must be deterministic: its
//             JSON is compared against the previous call to decide "moved".
//   isDirty   from LTP_useUnsavedGuard.
//   onAdopt   called with a fresh snapshot when it is safe to swap it in.
//   notice    { title, message } shown in the dirty case.
//   resetKey  changing it forgets everything — the editor switched records.
window.LTP_useRemoteEdits = function(record, snapshot, isDirty, onAdopt, notice, resetKey, collection) {
  var seenRef = React.useRef(null);
  var warnedRef = React.useRef(false);
  // The remote epoch as of the last time we looked at this record.
  //
  // A row changing is not by itself news: the commonest reason a watched row
  // changes is that the person watching it just saved. Both cases arrive here
  // identically — a new object with new content — so the only way to tell them
  // apart is to ask the state layer, which knows whether IT installed those
  // rows from a server response. data-state.js bumps this counter exactly
  // there. Unchanged since our last look ⇒ this window caused the change ⇒
  // nothing happened "elsewhere" and there is nothing to warn about.
  var epochRef = React.useRef(undefined);

  // Switching records starts a fresh editing session: nothing seen, nothing
  // warned. Declared BEFORE the compare effect so it lands first in the same
  // commit — the compare then simply re-seeds instead of firing on a change
  // that is really just "different record".
  React.useEffect(function() {
    seenRef.current = null;
    warnedRef.current = false;
    epochRef.current = undefined;
  }, [resetKey]);

  React.useEffect(function() {
    var epochNow = collection != null
      ? (window.LTP_DATA_REMOTE_EPOCH || {})[collection]
      : undefined;
    var incoming;
    if (!record) {
      // No record at all. Either this editor is on something brand new and
      // unsaved (nothing to watch), or the row we WERE watching has just been
      // deleted in another window — which is very much worth saying.
      if (seenRef.current === null) return;
      incoming = "\u0000deleted";
    } else {
      try { incoming = JSON.stringify(snapshot(record)); }
      catch (e) { return; }               // unserializable — nothing safe to compare
    }
    if (seenRef.current === null) {
      seenRef.current = incoming;
      epochRef.current = epochNow;
      return;
    }
    if (incoming === seenRef.current) { epochRef.current = epochNow; return; }
    seenRef.current = incoming;

    // Ours, not theirs. Re-baseline and say nothing — but DO clear the
    // once-per-session gate: having just saved, this editor is level with the
    // stored row again, so the next change that really does come from
    // somewhere else is worth hearing about.
    //
    // Suppress ONLY on a positive answer — two real epochs that agree. No
    // collection, or no epoch published for it (a collection the state layer
    // does not manage, a watch mounted before it), falls back to warning. A
    // warning that fires when it need not is a nuisance; one that has quietly
    // stopped firing is the data loss it was put here to prevent.
    var fromServer = collection == null
      || epochNow == null || epochRef.current == null
      || epochNow !== epochRef.current;
    epochRef.current = epochNow;
    if (!fromServer) { warnedRef.current = false; return; }

    if (!isDirty && record && onAdopt) {
      warnedRef.current = false;
      onAdopt(snapshot(record));
      return;
    }
    if (warnedRef.current) return;
    warnedRef.current = true;
    if (window.LTP_toast) {
      window.LTP_toast((notice && notice.title) || "Changed elsewhere", {
        message: (notice && notice.message) ||
          "Another window updated this while you were editing. Your unsaved changes are kept \u2014 saving will replace the newer version.",
        variant: "warn",
        // No timer: this describes the form still in front of you, and the very
        // person it is for is the one most likely to be away from the desk when
        // it lands. Page-scoped because it is a statement about THIS form —
        // once they have left it, "saving will replace the newer version"
        // describes nothing.
        sticky: true,
        retireOnLeave: true,
      });
    }
  }, [record]);
};

// ═══════════════════════════════════════════════════════════════════════════
//   A PUBLIC PAGE NOTICING THAT ITS DOCUMENT MOVED
// ═══════════════════════════════════════════════════════════════════════════
//
// The share views — a client on a quote or invoice, a crew member on a shift
// request — have no session, so none of the app's live sync reaches them. There
// is nothing to hold a stream open for an anonymous reader, and it would be the
// wrong thing to open for one anyway.
//
// They poll one small endpoint instead. A client reading a quote does not need
// sub-second news; they need to not be looking at last week's price, and a crew
// member needs to not turn up for a call time that moved. Paused while the tab
// is hidden and checked the moment it comes back, because the case this exists
// for IS the tab left open in the background.
//
//   versionUrl  "/api/view/<token>/version" or "/api/crew/<token>/version",
//               answering { doc, app }. Falsy disables the watch.
//   current     the `_v` handed over with the page being displayed. The
//               comparison baseline; changing it (a reload) resets the state.
//
// Returns "fresh", "stale" (the stored document no longer matches what is on
// screen) or "gone" (there is no document there any more). Both public views
// replace the whole page on the latter two, rather than leaving content up that
// is no longer true.
window.LTP_useDocFreshness = function(versionUrl, current) {
  var pair = React.useState("fresh");
  var state = pair[0], setState = pair[1];
  var curRef = React.useRef(current);
  curRef.current = current;

  // Whatever was just loaded is, by definition, current.
  React.useEffect(function() { setState("fresh"); }, [current]);

  React.useEffect(function() {
    if (!versionUrl) return undefined;
    // Ten seconds, not sixty. This is watched by someone who has been told the
    // document is live; a minute of a stale price still on screen reads as the
    // check not working at all. One small request every ten seconds sits far
    // inside the /api/view rate limit that already covers this route.
    var POLL_MS = 10000;
    var timer = null;
    var cancelled = false;

    function check() {
      if (cancelled) return;
      fetch(versionUrl)
        .then(function(r) {
          // 404 is the document itself going away — deleted, or its link
          // revoked. It was silently indistinguishable from a network blip
          // here, so a client left on a deleted quote was told nothing at all
          // and went on reading it. It is not a blip: it will not come back,
          // and "refresh this page" would be the wrong thing to say.
          if (r.status === 404) { setState("gone"); return null; }
          return r.ok ? r.json() : null;
        })
        .then(function(v) {
          if (cancelled || !v) return;
          // A public tab has no live feed to hear a deploy on, so it raises the
          // same event the signed-in app does and components/register-sw.js
          // takes it from there.
          if (v.app) {
            try {
              window.dispatchEvent(new CustomEvent("ltp-app-version", { detail: { version: v.app } }));
            } catch (e) { /* CustomEvent unsupported */ }
          }
          // Before the first load lands there is nothing to compare against.
          if (!curRef.current || !v.doc) return;
          // Set both ways: a 404 that turns out to have been wrong, or a
          // document edited back to exactly what is on screen, both recover.
          setState(v.doc === curRef.current ? "fresh" : "stale");
        })
        .catch(function() { /* offline or a blip — the next tick retries */ });
    }

    function tick() {
      if (!document.hidden) check();
      timer = setTimeout(tick, POLL_MS);
    }
    function onVisible() { if (!document.hidden) check(); }

    timer = setTimeout(tick, POLL_MS);
    check();                               // and once now, not in ten seconds
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return function() {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [versionUrl]);

  return state;
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
