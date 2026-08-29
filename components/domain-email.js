// LTP domain — outbound email composition: signature, header, body rendering.
//
// Split out of theme.js. This is the CLIENT-FACING half of the email pipeline;
// backend/sanitize.py is the authoritative sanitizer at save and send time, and
// components/sanitize.js mirrors its allowlist for the preview. Anything here
// that changes what a recipient sees should be checked against both.
//
// LTP_SIGNATURE_PHOTO_FALLBACK is computed at load (it reads
// window.location.origin) and LTP_textToHtml is an IIFE result whose body runs
// at load to build its regexes — both are self-contained and order-independent,
// but they are real work at load rather than plain assignments.
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


// ── textToHtml ──────────────────────────────────────────────────────────
// Convert a body that was typed as plain text (blank lines = paragraphs,
// single newlines = line breaks) into the HTML that the email pipeline
// expects. If the input already contains HTML structure (a <p>, <div>,
// <br>, <h*>, or <table> tag — common when the admin pasted from a
// marketing-tool export), pass it through unchanged.
//
// Why this exists: the email body field accepts both plain text and
// HTML. The send pipeline ALWAYS sends as text/html (multipart/alt with
// a derived text/plain), so plain-text bodies typed at the textarea get
// their whitespace collapsed by every HTML rendering layer downstream
// (Send modal preview, backend sanitizer, recipient mail client).
// This helper bridges the gap so what the user sees in the preview
// matches what their recipient gets.
//
// Detection heuristic: presence of any common block-level or
// line-break tag means "treat as HTML." Markup-free user input gets
// the paragraph + br conversion. The check is intentionally loose —
// false positives (HTML passes through untouched) are fine; false
// negatives (plain-text wrongly classified as HTML) lose the
// formatting we're trying to add.
// Fallback photo URL used when the signed-in user has no Google profile
// picture (rare). Served by the app itself (absolute, so the same URL works
// in the sent email) — the old marketing-site URL started 404ing, leaving a
// broken image in the signature. MUST stay in sync with
// backend/email_compose.py::_photo_fallback_url (_AVATAR_ASSET_PATH).
window.LTP_SIGNATURE_PHOTO_FALLBACK =
  (typeof window !== "undefined" && window.location ? window.location.origin : "")
  + "/assets/logos/ltp-avatar.png";

// Render the {{signature}} placeholder against the currently signed-in
// user, using the workspace-wide signature template from settings.
// This is the FRONTEND counterpart of backend/routes/email.py::_render_signature;
// it exists so the Send-modal preview shows what the recipient will see
// instead of literal {{signature}}. The real substitution at send time
// still happens server-side (authoritative).
//
// {{userPhoto}} resolves to the Google profile picture, falling back
// to the LTP logo when absent. Other placeholders coerce missing
// values to empty string so the template never leaks literal {{...}}.
window.LTP_renderSignature = function(template) {
  if (!template) return "";
  return template
    .replace(/\{\{userName\}\}/g, window.LTP_SENDER_NAME || "")
    .replace(/\{\{userEmail\}\}/g, window.LTP_SENDER_EMAIL || "")
    .replace(/\{\{userTitle\}\}/g, window.LTP_SENDER_TITLE || "")
    .replace(/\{\{userPhone\}\}/g, window.LTP_SENDER_PHONE || "")
    .replace(/\{\{userPhoto\}\}/g, window.LTP_SENDER_PHOTO || window.LTP_SIGNATURE_PHOTO_FALLBACK);
};

// ── Customer-facing email {{header}} block ───────────────────────────────
// The {{header}} placeholder renders a branded "action box" at the top of
// quote / invoice / receipt emails: a card with the refNumber + project +
// total summary and one centered call-to-action button. The box container
// is identical across types (the same crew-availability box, so every email
// reads the same); ONLY the CTA label differs by type — hence the per-type
// map below. This used to be a single editable emailHeaderTemplate in
// Settings, but each email type needs its own button wording, so the header
// is generated here per type instead of stored as one shared string.
//
// `kind` is one of "quote" | "invoice" | "receipt" (passed by each send
// modal). Unknown/empty kinds fall back to the quote label so a header
// never renders an empty button.
window.LTP_HEADER_CTA = {
  quote: "View &amp; Accept or Decline",
  invoice: "View &amp; Download",
  receipt: "View Receipt",
};

// Build the {{header}} block for `kind`, baking in the per-entity tokens
// (refNumber / projectName / total) so the Send-modal preview shows real
// values AND the expanded HTML carries them to the backend. {{viewUrl}} is
// INTENTIONALLY left literal: it's per-recipient (each To/CC gets its own
// tracking_token) and only the backend knows the token — the backend's
// per-recipient chain swaps href="{{viewUrl}}" for the real URL just before
// the wire. Kept structurally in sync with the box the crew emails use
// (backend/routes/crew.py::_crew_header_html) so the card reads identically;
// tests/test_header_block.py pins the structure + per-type labels.
window.LTP_renderHeader = function(kind, vars) {
  vars = vars || {};
  var cta = window.LTP_HEADER_CTA[kind] || window.LTP_HEADER_CTA.quote;
  // Invoice emails emphasize the financials: a larger reference + total plus a
  // due-date line. Quotes/receipts keep the standard (smaller) sizing and have
  // no due date.
  var invoice = (kind === "invoice");
  var refPx = invoice ? 14 : 12;
  var totalPx = invoice ? 17 : 14;
  var totalWeight = invoice ? "font-weight:bold;" : "";
  // The total's bottom gap closes up when a due-date line follows it.
  var totalGap = (invoice && vars.dueDate) ? 2 : 18;
  var dueLine = (invoice && vars.dueDate)
    ? '<div style="font-size:14px;color:#233038;margin-bottom:18px">Due ' + vars.dueDate + '</div>'
    : '';
  return '<div style="padding:0px">'
    + '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" '
    + 'style="width:100%;margin-top:5px;background-color:#f7f9fa;border:1px solid #eceef0;border-radius:10px">'
    + '<tbody><tr><td style="padding:22px;text-align:center">'
    + '<div style="font-size:' + refPx + 'px;color:#8a949e;text-transform:uppercase;letter-spacing:0.06em">' + (vars.refNumber || "") + '</div>'
    + '<div style="font-size:19px;font-weight:bold;color:#233038;margin:4px 0 2px">' + (vars.projectName || "") + '</div>'
    + '<div style="font-size:' + totalPx + 'px;color:#233038;' + totalWeight + 'margin-bottom:' + totalGap + 'px">' + (vars.total || "") + '</div>'
    + dueLine
    + '<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:0 auto">'
    + '<tbody><tr><td style="background-color:#f15927;border-radius:7px">'
    + '<a href="{{viewUrl}}" style="display:inline-block;padding:14px 38px;font-size:15px;'
    + 'font-weight:bold;color:#ffffff;text-decoration:none">' + cta + '</a>'
    + '</td></tr></tbody></table>'
    + '</td></tr></tbody></table></div>';
};

// Build a Send-modal preview body: substitute the placeholders the
// backend would normally fill in at send time, so the preview pane
// shows the SAME shape the recipient gets. Real send still leaves
// these placeholders intact for backend resolution.
//
// `viewUrl` should be the entity's share-link URL with no `?r=` (or a
// sample one); `signatureTemplate` should be the workspace signature
// template string (frontend reads settings.emailSignatureTemplate with
// the data/settings.js default).
window.LTP_renderPreviewBody = function(body, viewUrl, signatureTemplate) {
  if (!body) return "";
  var sig = window.LTP_renderSignature(signatureTemplate || "");
  return String(body)
    .replace(/\{\{viewUrl\}\}/g, viewUrl || "")
    .replace(/\{\{signature\}\}/g, sig);
};

// ── EmailBodyEditor bidirectional conversion ─────────────────────────────
// The Send modal uses a WYSIWYG contentEditable rather than a textarea —
// the user shouldn't have to look at raw HTML to tweak an email. The
// body that gets STORED + SENT keeps placeholders intact ({{viewUrl}},
// {{signature}}, {{header}}) so the backend can substitute per-recipient
// values. The body that gets DISPLAYED has signature and header
// substituted as non-editable marker blocks (so the user sees what the
// recipient sees without being able to accidentally mangle the
// table-based structure). {{viewUrl}} stays inline in href attributes
// — invisible to the user because it lives in attribute space, not
// text content.
//
// `LTP_bodyToEditableHtml(rawBody, signatureTemplate, headerKind, headerVars)`
//   — call when opening the modal. Produces HTML safe to drop into a
//   contentEditable. headerKind ("quote"|"invoice"|"receipt") selects the
//   header's CTA label; headerVars is {refNumber, projectName, total} for
//   the preview render; if missing the summary lines render empty (only
//   matters in tests or call sites without entity context).
//
// `LTP_editableHtmlToBody(html)` — call on every input event. Reverses
// both substitutions so the stored body still has {{signature}} +
// {{header}} for the backend to resolve.
//
// MARKER WRAPPER: <section class="ltp-sig-block"> and <section
// class="ltp-header-block">. We use <section> instead of <div> because
// the inner template HTML for BOTH blocks contains <div>s — a non-greedy
// /<div[^>]*class="ltp-sig-block"[^>]*>...<\/div>/ regex would match
// the first inner </div> instead of the wrapper's close. <section> is
// chosen because neither the signature template nor the header template
// contains a <section> tag, so the non-greedy /<section[^>]*>...
// <\/section>/ pattern matches exactly the wrapper. Both class and
// section are in the email sanitizer allowlist; contenteditable is NOT
// (admin-authored templates can't pre-mark blocks as non-editable). The
// editor component re-applies contenteditable="false" via DOM API after
// setting innerHTML.
// Drop a block-level HTML fragment (a <table>-based header/signature, or a
// literal token the backend will expand) into a paragraph-wrapped body at
// BLOCK level. If `token` sits inside a <p>...</p>, the paragraph is split so
// `block` is NOT nested inside the inline <p> — browsers/email clients
// auto-close the <p> at the first <table>, which strands trailing text and
// leaves a stray empty paragraph. Surrounding text in the same <p> stays
// wrapped; empty halves are dropped so "<p>{{token}}</p>" collapses to just
// `block`. Bare tokens outside any <p> are replaced directly. Passing
// block === token re-flattens a wrapped token back to a bare one (used so the
// backend-resolved {{signature}} <table> also lands at block level).
window.LTP_injectBlock = function(html, token, block) {
  if (!html) return html;
  var stripEnds = function(s) {
    return s.replace(/^(?:\s|<br\s*\/?>)+/i, '').replace(/(?:\s|<br\s*\/?>)+$/i, '');
  };
  return String(html).replace(/<p>([\s\S]*?)<\/p>/g, function(match, inner) {
    if (inner.indexOf(token) === -1) return match;
    var pieces = inner.split(token);
    var out = [];
    for (var i = 0; i < pieces.length; i++) {
      var clean = stripEnds(pieces[i]);
      if (clean) out.push('<p>' + clean + '</p>');
      if (i < pieces.length - 1) out.push(block);
    }
    return out.join('\n');
  }).split(token).join(block);  // catch any bare token outside <p>
};

window.LTP_bodyToEditableHtml = function(rawBody, signatureTemplate, headerKind, headerVars) {
  if (!rawBody) return "";
  // 1. Paragraph-wrap FIRST, while the body still has placeholders as
  //    plain-text tokens. If we substituted the blocks first, the
  //    rendered <table>/<div> would trigger textToHtml's block-detection
  //    early and the surrounding plain-text paragraphs wouldn't get
  //    wrapped — collapsing all whitespace in the editor.
  var withParagraphs = window.LTP_textToHtml(String(rawBody));
  // 2. Build the marker blocks.
  var sigBlock = '<section class="ltp-sig-block">'
    + window.LTP_renderSignature(signatureTemplate || "") + '</section>';
  var headerBlock = '<section class="ltp-header-block">'
    + window.LTP_renderHeader(headerKind || "", headerVars || {}) + '</section>';

  // 3. Drop the marker blocks in at block level — LTP_injectBlock splits any
  //    surrounding <p> so the <section><table> isn't nested inside an inline
  //    <p>. Header first (top of body), then signature; order doesn't affect
  //    correctness since paragraphs are split independently.
  var withHeader = window.LTP_injectBlock(withParagraphs, '{{header}}', headerBlock);
  var withSig = window.LTP_injectBlock(withHeader, '{{signature}}', sigBlock);
  return window.LTP_SANITIZE.emailHtml(withSig);
};

window.LTP_editableHtmlToBody = function(html) {
  if (!html) return "";
  // Reverse both marker substitutions. Tolerates single OR double
  // quoted class attribute and any additional attributes (e.g.
  // contenteditable="false" + inline styles added by the editor).
  return String(html)
    .replace(
      /<section[^>]*class\s*=\s*["']ltp-header-block["'][^>]*>[\s\S]*?<\/section>/gi,
      '{{header}}'
    )
    .replace(
      /<section[^>]*class\s*=\s*["']ltp-sig-block["'][^>]*>[\s\S]*?<\/section>/gi,
      '{{signature}}'
    );
};

window.LTP_textToHtml = (function() {
  // Detect block-level structure. If the body already has paragraphs,
  // divs, tables, headings, etc. then it was authored as full HTML and
  // we leave it alone. If only inline tags (<a>, <strong>, <img>) appear
  // — or no tags at all — we paragraph-wrap so blank lines render as
  // <p> blocks and single newlines as <br>. Crucially we DON'T escape
  // inline tags in the plain-text path; the downstream sanitizer
  // (bleach server-side, DOMPurify in-app) is the trust boundary that
  // strips anything dangerous. Escaping here would turn legitimate
  // <a href="{{viewUrl}}">...</a> in plain-text templates into literal
  // "&lt;a href=...&gt;" text in the recipient's inbox — the exact bug
  // this rewrite fixes.
  var BLOCK_DETECT_RE = /<\/?(p|div|h[1-6]|table|tr|td|th|ul|ol|li|blockquote|hr|article|section)\b/i;
  var PLACEHOLDER_RE = /^\{\{\s*\w+\s*\}\}$/;

  // Canonical paragraph styling for every email body. Applied INLINE (email
  // clients strip <style>; bleach's CSS allowlist keeps margin + line-height)
  // so a single source of truth controls paragraph spacing in the sent mail.
  // margin:0 = paragraphs are single-spaced (one line apart) by default; the
  // sender adds blank lines (empty paragraphs) manually for bigger gaps. MUST
  // match the editor's `.ltp-email-editor` rule in index.html so the Send-modal
  // preview renders the same spacing the recipient sees.
  var PARA_STYLE = "margin:0;line-height:1";

  // Give top-level text paragraphs the canonical spacing. This is what makes a
  // body authored across browsers render consistently: Chrome's Enter inserts
  // <p>, Safari's inserts <div>, and a plain-text template has neither — here
  // they all converge on the same inline margin. Idempotent (skips anything
  // that already carries a margin), and leaves structural blocks (tables,
  // lists, nested layout) and lone {{placeholder}} lines untouched so the
  // header/signature blocks substituted downstream aren't disturbed.
  function normalizeParagraphs(htmlStr) {
    if (!htmlStr || typeof document === "undefined") return htmlStr;
    var tmp = document.createElement("div");
    tmp.innerHTML = String(htmlStr);
    var kids = tmp.children;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      var tag = el.tagName.toLowerCase();
      if (tag !== "p" && tag !== "div") continue;
      var st = el.getAttribute("style") || "";
      if (/margin/i.test(st)) continue;                                  // already spaced
      if (PLACEHOLDER_RE.test((el.textContent || "").trim())) continue;  // lone {{placeholder}}
      if (el.querySelector("table,ul,ol,p,div,blockquote,h1,h2,h3,h4,section,hr")) continue;  // structural
      el.setAttribute("style", PARA_STYLE + (st ? ";" + st : ""));
    }
    return tmp.innerHTML;
  }

  return function(input) {
    if (input == null) return "";
    var s = String(input);
    // Already block-structured (full HTML, or content round-tripped through the
    // contentEditable editor) — normalize the paragraph spacing in place.
    if (BLOCK_DETECT_RE.test(s)) return normalizeParagraphs(s);
    // Plain-text-with-maybe-inline-HTML path: render newlines LITERALLY so the
    // textarea is WYSIWYG — every line becomes its own line, and a blank line
    // becomes a visible empty paragraph (a gap). This matches the contentEditable
    // editor (Enter = next line, Enter-twice = a blank line) so a template and a
    // hand-edited body space identically. No escape — inline tags pass through to
    // the sanitizer. A lone {{placeholder}} line stays bare so the downstream
    // block injection can split it.
    var lines = String(s).split("\n");
    while (lines.length && lines[0].trim() === "") lines.shift();               // trim leading blank lines
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();  // trim trailing blank lines
    if (lines.length === 0) return "";
    return lines.map(function(line) {
      var t = line.trim();
      if (t === "") return '<p style="' + PARA_STYLE + '"><br></p>';            // blank line → gap
      var attr = PLACEHOLDER_RE.test(t) ? "" : ' style="' + PARA_STYLE + '"';
      return "<p" + attr + ">" + line + "</p>";
    }).join("\n");
  };
})();
