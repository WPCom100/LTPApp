// Rich Text Editor Component
(function() {
  var B = window.LTP_THEME, h = React.createElement;

  window.RichTextEditor = function({ value, onChange, placeholder }) {
    var editorRef = React.useRef(null);
    var isInit = React.useRef(false);
    React.useEffect(function() {
      if (editorRef.current && !isInit.current) { editorRef.current.innerHTML = value || ""; isInit.current = true; }
    }, []);
    function exec(cmd, val) { document.execCommand(cmd, false, val || null); editorRef.current && editorRef.current.focus(); }
    var bs = { background: B.raised, border: "1px solid " + B.border, borderRadius: "3px", color: B.textSec, cursor: "pointer", padding: "3px 8px", fontSize: "12px", fontWeight: 600, lineHeight: 1.2 };
    return h("div", { style: { border: "1px solid " + B.border, borderRadius: "6px", overflow: "hidden" } },
      h("div", { style: { display: "flex", gap: 2, padding: "6px 8px", background: B.surface, borderBottom: "1px solid " + B.border, flexWrap: "wrap" } },
        h("button", { type: "button", onClick: function() { exec("bold"); }, style: Object.assign({}, bs, { fontWeight: 800 }), title: "Bold" }, "B"),
        h("button", { type: "button", onClick: function() { exec("italic"); }, style: Object.assign({}, bs, { fontStyle: "italic" }), title: "Italic" }, "I"),
        h("button", { type: "button", onClick: function() { exec("underline"); }, style: Object.assign({}, bs, { textDecoration: "underline" }), title: "Underline" }, "U"),
        h("button", { type: "button", onClick: function() { exec("strikeThrough"); }, style: Object.assign({}, bs, { textDecoration: "line-through" }), title: "Strikethrough" }, "S"),
        h("span", { style: { width: 1, background: B.border, margin: "0 4px" } }),
        h("button", { type: "button", onClick: function() { exec("insertUnorderedList"); }, style: bs, title: "Bullet list" }, "\u2022 List"),
        h("button", { type: "button", onClick: function() { exec("insertOrderedList"); }, style: bs, title: "Numbered list" }, "1. List"),
        h("span", { style: { width: 1, background: B.border, margin: "0 4px" } }),
        h("button", { type: "button", onClick: function() { exec("formatBlock", "H3"); }, style: bs, title: "Heading" }, "H"),
        h("button", { type: "button", onClick: function() { exec("formatBlock", "BLOCKQUOTE"); }, style: bs, title: "Quote" }, "\u201c"),
        h("button", { type: "button", onClick: function() { exec("removeFormat"); }, style: bs, title: "Clear formatting" }, "\u00d7 Clear")
      ),
      h("div", { ref: editorRef, contentEditable: true, onInput: function() { if (editorRef.current) onChange(editorRef.current.innerHTML); },
        "data-placeholder": placeholder || "Start typing...",
        style: { minHeight: 120, padding: "10px 12px", background: B.raised, color: B.text, fontSize: "13px", fontFamily: "inherit", outline: "none", lineHeight: 1.6, overflow: "auto", maxHeight: 300 }
      })
    );
  };
})();
