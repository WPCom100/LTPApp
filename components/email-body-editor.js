// EmailBodyEditor — single-pane WYSIWYG editor for the Send modal.
//
// Replaces the prior textarea + sanitized-preview split-pane. The user
// edits the rendered email directly instead of looking at raw HTML;
// HTML-level editing lives in the template editor (Settings).
//
// Contract with parent:
//   props.value           — the stored body string (with {{viewUrl}} +
//                           {{signature}} placeholders left intact for
//                           backend per-recipient substitution).
//   props.signatureTemplate — workspace signature template (settings
//                           emailSignatureTemplate with fallback chain
//                           handled by the caller).
//   props.onChange(body)  — fires on every user input. Body still has
//                           placeholders intact (signature block reversed
//                           back to {{signature}} token).
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
//      Safari ignores it and uses <div>. Both are sanitizer-allowed
//      and render fine — we accept the inconsistency for v1.
(function() {
  var h = React.createElement;
  var useRef = React.useRef;
  var useEffect = React.useEffect;
  var B = window.LTP_THEME;

  window.EmailBodyEditor = function(props) {
    var value = props.value || "";
    var signatureTemplate = props.signatureTemplate || "";
    var onChange = props.onChange;
    var heightStyle = props.minHeight || 220;

    var ref = useRef(null);
    var initializedRef = useRef(false);

    // eslint-disable-next-line react-hooks/exhaustive-deps -- init-once for contentEditable; see header
    useEffect(function() {
      if (initializedRef.current || !ref.current) return;
      initializedRef.current = true;

      // 1. Render initial editable HTML (signature substituted in,
      //    viewUrl left as placeholder in hrefs).
      var displayHtml = window.LTP_bodyToEditableHtml(value, signatureTemplate);
      ref.current.innerHTML = displayHtml;

      // 2. Mark signature blocks non-editable. The sanitizer dropped
      //    contenteditable attrs; we add them back via DOM API. Also
      //    add a subtle UI hint that the block is auto-managed.
      var sigBlocks = ref.current.querySelectorAll(".ltp-sig-block");
      for (var i = 0; i < sigBlocks.length; i++) {
        var el = sigBlocks[i];
        el.setAttribute("contenteditable", "false");
        el.style.userSelect = "none";
        el.style.cursor = "default";
        // Faint background tint so the user understands this block is
        // not editable and gets re-rendered per-recipient at send time.
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
      // Extract the current display HTML and reverse the signature
      // substitution. The stored body keeps {{signature}} so the
      // backend can render per-user at send time.
      var raw = ref.current.innerHTML;
      onChange(window.LTP_editableHtmlToBody(raw));
    }

    // Paste handling: when users paste rich content from Word/Gmail,
    // browsers insert all kinds of inline styles. We accept it for v1
    // — the backend sanitizer normalizes — but flag this comment so
    // future me knows the spot to intercept if we want to strip
    // styles down to allowlist on paste.

    return h("div", {
      ref: ref,
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
        lineHeight: 1.5,
        minHeight: heightStyle,
      },
    });
  };
})();
