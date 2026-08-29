// EmailBodyEditor — single-pane WYSIWYG editor for the Send modal.
//
// Replaces the prior textarea + sanitized-preview split-pane. The user
// edits the rendered email directly instead of looking at raw HTML;
// HTML-level editing lives in the template editor (Settings).
//
// Contract with parent:
//   props.value           — the stored body string (with {{viewUrl}} +
//                           {{signature}} + {{header}} placeholders left
//                           intact for backend per-recipient substitution).
//   props.signatureTemplate — workspace signature template (settings
//                           emailSignatureTemplate with fallback chain
//                           handled by the caller).
//   props.headerKind      — which customer-facing header to render:
//                           "quote" | "invoice" | "receipt" (selects the
//                           CTA label). Empty/omitted for crew emails or
//                           bodies without a {{header}} placeholder.
//   props.headerVars      — {refNumber, projectName, total} for the
//                           editor's preview render of the header block.
//                           Backend re-resolves {{viewUrl}} per-recipient
//                           at send time.
//   props.onChange(body)  — fires on every user input. Body still has
//                           placeholders intact (signature + header blocks
//                           reversed back to {{signature}} / {{header}}).
//
// React + contentEditable gotchas the implementation works around:
//   1. React diffs DOM; contentEditable owns its DOM. Setting innerHTML
//      via React would clobber cursor position on every keystroke. We
//      attach a ref and write innerHTML ONCE on mount, then read it back
//      via onInput. React's `value` prop isn't synced after init.
//   2. The contenteditable attribute on child elements (used to mark
//      the signature block read-only) gets stripped by our sanitizer's
//      allowlist. We set it via DOM API after the innerHTML write.
//   3. Browsers differ on what tag to insert when the user presses
//      Enter. defaultParagraphSeparator picks <p> in Chrome/Firefox;
//      Safari ignores it and uses <div>. We no longer care which: the
//      `.ltp-email-editor` CSS (index.html) gives <p> AND <div> the same
//      paragraph spacing in this live preview, and domain-email.js's PARA_STYLE
//      (via LTP_textToHtml) stamps the SAME inline margin onto the body at
//      send time — so the editor, both <p>/<div>, and the recipient's mail
//      all line up. Keep the CSS value and PARA_STYLE in sync.
(function() {
  var h = React.createElement;
  var useRef = React.useRef;
  var useEffect = React.useEffect;
  var B = window.LTP_THEME;

  window.EmailBodyEditor = function(props) {
    var value = props.value || "";
    var signatureTemplate = props.signatureTemplate || "";
    var headerKind = props.headerKind || "";
    var headerVars = props.headerVars || null;
    var onChange = props.onChange;
    var heightStyle = props.minHeight || 220;

    var ref = useRef(null);
    var initializedRef = useRef(false);

    // eslint-disable-next-line react-hooks/exhaustive-deps -- init-once for contentEditable; see header
    useEffect(function() {
      if (initializedRef.current || !ref.current) return;
      initializedRef.current = true;

      // 1. Render initial editable HTML (signature + header substituted
      //    in, viewUrl left as placeholder in hrefs for backend resolution).
      var displayHtml = window.LTP_bodyToEditableHtml(
        value, signatureTemplate, headerKind, headerVars
      );
      ref.current.innerHTML = displayHtml;

      // 2. Mark signature + header blocks non-editable. The sanitizer
      //    dropped contenteditable attrs; we add them back via DOM API.
      //    Both blocks get the same subtle accent tint so they read as
      //    "auto-managed system block" — visually consistent so the user
      //    learns the convention once.
      var markers = ref.current.querySelectorAll(".ltp-sig-block, .ltp-header-block");
      for (var i = 0; i < markers.length; i++) {
        var el = markers[i];
        el.setAttribute("contenteditable", "false");
        el.style.userSelect = "none";
        el.style.cursor = "default";
        el.style.background = "rgba(232, 115, 26, 0.04)";
        el.style.borderLeft = "2px solid " + B.accent + "44";
        el.style.padding = "8px 10px";
        el.style.marginTop = "8px";
      }

      // 3. Force <p> as the paragraph separator (Chrome/Firefox honor
      //    this; Safari falls back to <div> which the sanitizer
      //    accepts). Wrapped in try/catch since the API is deprecated.
      try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch (e) {}
    }, []);

    function handleInput() {
      if (!ref.current || !onChange) return;
      // Extract the current display HTML and reverse the marker-block
      // substitutions. The stored body keeps {{signature}} + {{header}}
      // so the backend can render per-user / per-recipient at send time.
      // Defense-in-depth (SECURITY_REVIEW.md M7): run the reversed body through
      // the email allowlist before storing it, so pasted/typed markup is
      // scrubbed client-side too — not just by the server's authoritative pass
      // at save/send. The {{signature}}/{{header}}/{{viewUrl}} placeholders
      // survive the allowlist.
      var body = window.LTP_editableHtmlToBody(ref.current.innerHTML);
      onChange(window.LTP_SANITIZE.emailHtml(body));
    }

    // Paste handling: when users paste rich content from Word/Gmail,
    // browsers insert all kinds of inline styles. We accept it for v1
    // — the backend sanitizer normalizes — but flag this comment so
    // future me knows the spot to intercept if we want to strip
    // styles down to allowlist on paste.

    return h("div", {
      ref: ref,
      className: "ltp-email-editor",
      contentEditable: true,
      suppressContentEditableWarning: true,
      onInput: handleInput,
      style: {
        flex: 1,
        background: B.bg,
        border: "none",
        borderTop: "1px solid " + B.border,
        color: B.text,
        fontSize: "12px",
        fontFamily: "inherit",
        padding: "14px 18px",
        outline: "none",
        overflowY: "auto",
        lineHeight: 1,
        minHeight: heightStyle,
      },
    });
  };
})();
