"""Tests for the WYSIWYG body editor pass:

  - LTP_textToHtml: block-level HTML passes through; inline HTML
    is paragraph-wrapped without escaping; plain text gets <p>+<br>
    wrapping. Critically, an <a> tag in a plain-text body should
    survive — the prior regex over-escaped it to "&lt;a&gt;", which
    caused the live-tested bug where the View Online link arrived
    as literal text instead of a clickable hyperlink.
  - LTP_bodyToEditableHtml: signature substituted with non-editable
    marker block; paragraph wrapping happens BEFORE substitution so
    a body around the signature stays paragraph-structured.
  - LTP_editableHtmlToBody: signature marker reverses back to the
    {{signature}} placeholder so the body sent to backend carries
    the placeholder for per-user resolution.
  - Roundtrip: body → editable HTML → back to body preserves
    {{signature}} (placeholder count and surrounding text intact).

All checks run as a Python port of the JS helpers (no JS runtime
available in this suite). The port MUST match theme.js byte-level
behavior; if you change either side, update the other in lockstep.

Runs as a plain script:
    python tests/test_wysiwyg_body_editor.py
"""
import os
import re
import sys

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)


_results: list[tuple[str, bool]] = []


def _check(label: str, cond: bool, detail: str = "") -> None:
    _results.append((label, cond))
    status = "PASS" if cond else "FAIL"
    suffix = f"  ({detail})" if detail else ""
    print(f"  [{status}] {label}{suffix}")


# ── Python ports of theme.js helpers (must match the JS implementation
# behaviorally — if either drifts, fix both and update this test).


_BLOCK_DETECT_RE = re.compile(
    r"<\/?(p|div|h[1-6]|table|tr|td|th|ul|ol|li|blockquote|hr|article|section)\b",
    re.IGNORECASE,
)


def py_text_to_html(s):
    """Python port of window.LTP_textToHtml."""
    if s is None:
        return ""
    s = str(s)
    if _BLOCK_DETECT_RE.search(s):
        return s
    paras = [p.strip() for p in re.split(r"\n\s*\n+", s)]
    paras = [p for p in paras if p]
    if not paras:
        return ""
    return "\n".join("<p>" + p.replace("\n", "<br>") + "</p>" for p in paras)


def py_render_signature(template, name="Sarah", email="sarah@x.com",
                       title="Producer", phone="555-1212", photo=""):
    """Tiny port of window.LTP_renderSignature — substitutes the four
    user variables. Photo defaults to "" since tests don't need it."""
    if not template:
        return ""
    return (
        template
        .replace("{{userName}}", name)
        .replace("{{userEmail}}", email)
        .replace("{{userTitle}}", title)
        .replace("{{userPhone}}", phone)
        .replace("{{userPhoto}}", photo)
    )


_HEADER_CTA = {
    "quote": "View &amp; Accept or Decline",
    "invoice": "View &amp; Pay",
    "receipt": "View Receipt",
}


def py_render_header(kind, vars):
    """Python port of window.LTP_renderHeader. Builds the per-type
    {{header}} action box (refNumber/projectName/total + a centered CTA
    button whose label depends on `kind`). {{viewUrl}} stays literal so
    the backend's per-recipient chain resolves it after the body reaches
    the server."""
    vars = vars or {}
    cta = _HEADER_CTA.get(kind) or _HEADER_CTA["quote"]
    return (
        '<div style="padding:0px">'
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" '
        'style="width:100%;margin-top:5px;background-color:#f7f9fa;border:1px solid #eceef0;border-radius:10px">'
        '<tbody><tr><td style="padding:22px;text-align:center">'
        '<div style="font-size:12px;color:#8a949e;text-transform:uppercase;letter-spacing:0.06em">'
        + (vars.get("refNumber", "") or "") + '</div>'
        '<div style="font-size:19px;font-weight:bold;color:#233038;margin:4px 0 2px">'
        + (vars.get("projectName", "") or "") + '</div>'
        '<div style="font-size:14px;color:#233038;margin-bottom:18px">'
        + (vars.get("total", "") or "") + '</div>'
        '<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:0 auto">'
        '<tbody><tr><td style="background-color:#f15927;border-radius:7px">'
        '<a href="{{viewUrl}}" style="display:inline-block;padding:14px 38px;font-size:15px;'
        'font-weight:bold;color:#ffffff;text-decoration:none">' + cta + '</a>'
        '</td></tr></tbody></table>'
        '</td></tr></tbody></table></div>'
    )


def py_body_to_editable_html(raw_body, sig_template, header_kind=None, header_vars=None):
    """Python port of window.LTP_bodyToEditableHtml.

    NOTE: we skip the LTP_SANITIZE.emailHtml step (DOMPurify isn't
    available in Python). The structural transformation is what matters
    for these tests; sanitization is exercised separately by the
    polish-pass tests.

    Walks every <p>...</p> that contains a marker token and splits it:
    text before becomes its own <p>, the block sits as a sibling, text
    after becomes its own <p>. Empty halves are dropped. Bare markers
    outside any <p> (admin templates with block HTML) fall through to
    the final replace. Marker wrapper is <section> not <div>, because
    the inner template HTML contains nested <div>s — a non-greedy
    regex on <div> would match the wrong closing tag."""
    if not raw_body:
        return ""
    with_paragraphs = py_text_to_html(str(raw_body))
    sig_block = (
        '<section class="ltp-sig-block">'
        + py_render_signature(sig_template or "")
        + '</section>'
    )
    header_block = (
        '<section class="ltp-header-block">'
        + py_render_header(header_kind or "", header_vars or {})
        + '</section>'
    )

    end_re = re.compile(r"^(?:\s|<br\s*/?>)+|(?:\s|<br\s*/?>)+$", re.IGNORECASE)

    def strip_ends(s):
        return end_re.sub("", s)

    def substitute(html, token, block):
        def replace_p(m):
            inner = m.group(1)
            if token not in inner:
                return m.group(0)
            pieces = inner.split(token)
            out = []
            for i, piece in enumerate(pieces):
                cleaned = strip_ends(piece)
                if cleaned:
                    out.append("<p>" + cleaned + "</p>")
                if i < len(pieces) - 1:
                    out.append(block)
            return "\n".join(out)

        return re.sub(r"<p>([\s\S]*?)</p>", replace_p, html).replace(token, block)

    with_header = substitute(with_paragraphs, "{{header}}", header_block)
    with_sig = substitute(with_header, "{{signature}}", sig_block)
    return with_sig


def py_editable_html_to_body(html):
    """Python port of window.LTP_editableHtmlToBody."""
    if not html:
        return ""
    result = re.sub(
        r'<section[^>]*class\s*=\s*["\']ltp-header-block["\'][^>]*>[\s\S]*?</section>',
        "{{header}}",
        str(html),
        flags=re.IGNORECASE,
    )
    result = re.sub(
        r'<section[^>]*class\s*=\s*["\']ltp-sig-block["\'][^>]*>[\s\S]*?</section>',
        "{{signature}}",
        result,
        flags=re.IGNORECASE,
    )
    return result


# ── textToHtml: block detection vs inline + plain ─────────────────────────


def test_text_to_html_block_html_passes_through():
    print("test_text_to_html_block_html_passes_through")
    src = "<p>Hello</p>\n<p>World</p>"
    _check("block-structured HTML passes through unchanged",
           py_text_to_html(src) == src)


def test_text_to_html_table_passes_through():
    print("test_text_to_html_table_passes_through")
    src = "<table><tr><td>A</td></tr></table>"
    _check("table HTML passes through unchanged",
           py_text_to_html(src) == src)


def test_text_to_html_plain_text_wraps_paragraphs():
    print("test_text_to_html_plain_text_wraps_paragraphs")
    src = "Hi Alice,\n\nPlease find the attached quote.\n\nThanks!"
    out = py_text_to_html(src)
    _check("3 paragraphs", out.count("<p>") == 3, f"got {out.count('<p>')}")
    _check("greeting preserved", "Hi Alice," in out)


def test_text_to_html_inline_anchor_paragraph_wrapped_without_escape():
    """The bug this rewrite fixes: a plain-text body with an inline
    <a href={{viewUrl}}>...</a> used to get escaped to "&lt;a&gt;"
    by the old textToHtml. After the fix the anchor survives AND the
    surrounding paragraphs still get wrapped."""
    print("test_text_to_html_inline_anchor_paragraph_wrapped_without_escape")
    src = (
        "Hi Alice,\n\n"
        "Quote Total: $197\n\n"
        '<a href="{{viewUrl}}">View, Accept, or Decline Online</a>\n\n'
        "Thanks!"
    )
    out = py_text_to_html(src)
    _check("4 paragraphs created", out.count("<p>") == 4, f"got {out.count('<p>')}")
    _check("anchor open tag NOT escaped", "&lt;a" not in out)
    _check("anchor close tag NOT escaped", "&lt;/a&gt;" not in out)
    _check("href attribute preserved", 'href="{{viewUrl}}"' in out)
    _check("link text intact", "View, Accept, or Decline Online" in out)


def test_text_to_html_single_newline_becomes_br():
    print("test_text_to_html_single_newline_becomes_br")
    src = "Line 1\nLine 2\nLine 3"
    out = py_text_to_html(src)
    _check("single newlines convert to <br>", out.count("<br>") == 2)
    _check("wrapped in one <p>", out.count("<p>") == 1)


def test_text_to_html_empty_inputs():
    print("test_text_to_html_empty_inputs")
    _check("None -> empty", py_text_to_html(None) == "")
    _check("empty string -> empty", py_text_to_html("") == "")
    _check("whitespace-only -> empty", py_text_to_html("   \n\t  ") == "")


# ── bodyToEditableHtml: paragraph wrap then signature substitute ──────────


def test_body_to_editable_html_paragraph_wraps_around_signature():
    """The signature substitution must NOT prevent paragraph wrapping
    of the surrounding plain text. The trick is: textToHtml runs FIRST
    on the body with {{signature}} as plain text, paragraph-wraps
    everything, THEN we swap the wrapped signature paragraph for the
    rendered signature block."""
    print("test_body_to_editable_html_paragraph_wraps_around_signature")
    body = (
        "Hi Alice,\n\n"
        "Quote Total: $197\n\n"
        '<a href="{{viewUrl}}">View Online</a>\n\n'
        "{{signature}}"
    )
    out = py_body_to_editable_html(body, "<table><tr><td>Sig: {{userName}}</td></tr></table>")
    _check("surrounding paragraphs wrapped",
           out.count("<p>") == 3, f"got {out.count('<p>')}")
    _check("signature is in a non-editable marker block",
           'class="ltp-sig-block"' in out)
    _check("rendered signature contains the user name",
           "Sig: Sarah" in out)
    _check("anchor survived",
           '<a href="{{viewUrl}}">View Online</a>' in out)
    _check("no leftover {{signature}} placeholder in display",
           "{{signature}}" not in out)
    # The signature should NOT be nested inside a <p> (block in inline =
    # invalid HTML). Confirm by looking for the wrapped-paragraph form.
    _check("signature <section> NOT nested in a <p>",
           "<p><section" not in out and "<p>\n<section" not in out)


def test_body_to_editable_html_bare_signature_token_substituted():
    """Admin-authored template might place {{signature}} inline with
    other text (no surrounding blank lines). The bare-token regex
    fallback should still substitute it."""
    print("test_body_to_editable_html_bare_signature_token_substituted")
    body = "Best,\n{{signature}}"  # single newline, no <p> wrap of token
    out = py_body_to_editable_html(body, "<p>Sig: {{userName}}</p>")
    _check("bare {{signature}} substituted", 'class="ltp-sig-block"' in out)
    _check("no leftover placeholder", "{{signature}}" not in out)


def test_body_to_editable_html_inline_signature_splits_paragraph():
    """REGRESSION GUARD: when {{signature}} sits mid-paragraph with
    surrounding text (e.g. 'Best, {{signature}}' single-line), the
    sig <table> can't live inside <p>...</p> — browsers auto-close
    the <p> at the first <table>, leaving orphan trailing text. The
    helper must SPLIT the paragraph: surrounding text in its own <p>,
    sig block as a block-level sibling."""
    print("test_body_to_editable_html_inline_signature_splits_paragraph")
    body = "Best, {{signature}}"
    out = py_body_to_editable_html(body, "<table><tr><td>S</td></tr></table>")
    _check("sig block NOT nested inside <p> (block-in-inline)",
           "<p><section" not in out and "<p>Best, <section" not in out)
    _check("surrounding text wrapped in its own <p>",
           "<p>Best,</p>" in out)
    _check("sig block rendered as sibling",
           'class="ltp-sig-block"' in out)
    _check("no leftover {{signature}}",
           "{{signature}}" not in out)


def test_body_to_editable_html_signature_between_text_pieces():
    """Multi-piece split: 'Hi {{signature}} bye' on one line should
    produce <p>Hi</p>, sig block, <p>bye</p>."""
    print("test_body_to_editable_html_signature_between_text_pieces")
    body = "Hi {{signature}} bye"
    out = py_body_to_editable_html(body, "<table><tr><td>S</td></tr></table>")
    _check("text before sig wrapped", "<p>Hi</p>" in out)
    _check("text after sig wrapped", "<p>bye</p>" in out)
    _check("sig block present", 'class="ltp-sig-block"' in out)
    _check("no invalid block-in-inline",
           "<p><section" not in out and "<p>Hi <section" not in out)


def test_body_to_editable_html_empty_inputs():
    print("test_body_to_editable_html_empty_inputs")
    _check("empty body -> empty", py_body_to_editable_html("", "<p>Sig</p>") == "")
    _check("None body -> empty", py_body_to_editable_html(None, "<p>Sig</p>") == "")


# ── editableHtmlToBody: reverse the substitution ──────────────────────────


def test_editable_html_to_body_restores_signature_placeholder():
    print("test_editable_html_to_body_restores_signature_placeholder")
    src = (
        '<p>Hi Alice,</p>\n'
        '<p>Quote Total: $197</p>\n'
        '<section class="ltp-sig-block">[rendered sig]</section>'
    )
    out = py_editable_html_to_body(src)
    _check("signature block reversed to placeholder",
           "{{signature}}" in out)
    _check("rendered sig content removed",
           "[rendered sig]" not in out)
    _check("surrounding paragraphs untouched",
           "<p>Hi Alice,</p>" in out)


def test_editable_html_to_body_tolerates_extra_attributes():
    """The EmailBodyEditor component adds contenteditable='false' +
    inline styles to the marker block via DOM API after innerHTML
    is set. The reverse must match regardless of extra attributes."""
    print("test_editable_html_to_body_tolerates_extra_attributes")
    src = (
        '<section class="ltp-sig-block" contenteditable="false" '
        'style="background:rgba(232,115,26,0.04);padding:8px">'
        '<table><tr><td>Sarah</td></tr></table>'
        '</section>'
    )
    out = py_editable_html_to_body(src)
    _check("reversed even with extra attrs", out == "{{signature}}")


def test_editable_html_to_body_tolerates_single_quotes_around_class():
    """Browser DOM serialization may use single or double quotes around
    attribute values. The regex accepts either."""
    print("test_editable_html_to_body_tolerates_single_quotes_around_class")
    src = "<section class='ltp-sig-block'>X</section>"
    out = py_editable_html_to_body(src)
    _check("single-quoted class handled", out == "{{signature}}")


def test_editable_html_to_body_handles_signature_with_nested_divs():
    """REGRESSION GUARD: the real signature template contains inner
    <div>s. The reverse regex MUST find the wrapper's closing tag,
    not the first inner one. Switching the wrapper to <section> (which
    the signature template doesn't contain) is what makes this work."""
    print("test_editable_html_to_body_handles_signature_with_nested_divs")
    src = (
        '<section class="ltp-sig-block">'
        '<table><tr><td><div>row 1</div><div>row 2</div></td></tr></table>'
        '</section>'
    )
    out = py_editable_html_to_body(src)
    _check("reversed cleanly across inner <div>s", out == "{{signature}}")


def test_body_to_editable_and_back_roundtrip():
    """body -> editable HTML -> body should preserve the {{signature}}
    placeholder count and the surrounding text. This is the critical
    invariant: the body sent to backend ALWAYS has placeholders intact
    for per-recipient substitution, no matter how many edit cycles the
    user goes through."""
    print("test_body_to_editable_and_back_roundtrip")
    body = (
        "Hi Alice,\n\n"
        "Please find the attached quote.\n\n"
        '<a href="{{viewUrl}}">View Online</a>\n\n'
        "{{signature}}"
    )
    sig_template = "<table><tr><td>Sig for {{userName}}</td></tr></table>"
    editable = py_body_to_editable_html(body, sig_template)
    roundtripped = py_editable_html_to_body(editable)
    _check("roundtrip preserves {{signature}} placeholder",
           "{{signature}}" in roundtripped)
    _check("roundtrip preserves anchor with placeholder href",
           'href="{{viewUrl}}"' in roundtripped)
    _check("roundtrip preserves greeting",
           "Hi Alice," in roundtripped)
    # Critically: rendered signature content is GONE from the body that
    # gets sent. The backend re-renders it per-user.
    _check("rendered signature content gone after reverse",
           "Sig for Sarah" not in roundtripped)


# ── Module sanity: theme.js exposes the helpers, components/email-body-
# editor.js exists and registers a window.EmailBodyEditor.


def test_theme_js_exposes_helpers():
    print("test_theme_js_exposes_helpers")
    path = os.path.join(_root, "theme.js")
    with open(path, encoding="utf-8") as f:
        src = f.read()
    _check("LTP_bodyToEditableHtml exposed",
           "window.LTP_bodyToEditableHtml" in src)
    _check("LTP_editableHtmlToBody exposed",
           "window.LTP_editableHtmlToBody" in src)
    _check("BLOCK_DETECT_RE present (new detection)",
           "BLOCK_DETECT_RE" in src)


def test_email_body_editor_component_loaded():
    print("test_email_body_editor_component_loaded")
    path = os.path.join(_root, "components", "email-body-editor.js")
    _check("component file exists", os.path.exists(path))
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            src = f.read()
        _check("window.EmailBodyEditor registered",
               "window.EmailBodyEditor" in src)
        _check("uses contentEditable",
               "contentEditable" in src or "contenteditable" in src)
        _check("calls bodyToEditableHtml on mount",
               "LTP_bodyToEditableHtml" in src)
        _check("calls editableHtmlToBody on input",
               "LTP_editableHtmlToBody" in src)
        _check("marks signature blocks non-editable via DOM API",
               'setAttribute("contenteditable", "false")' in src
               or "setAttribute('contenteditable', 'false')" in src)


def test_index_html_loads_component():
    print("test_index_html_loads_component")
    path = os.path.join(_root, "index.html")
    with open(path, encoding="utf-8") as f:
        src = f.read()
    _check("email-body-editor.js loaded in index.html",
           'components/email-body-editor.js' in src)


def test_send_modals_use_email_body_editor():
    print("test_send_modals_use_email_body_editor")
    for module in ("modules/quotes-builder.js", "modules/invoices.js"):
        path = os.path.join(_root, module)
        with open(path, encoding="utf-8") as f:
            src = f.read()
        _check(f"{module} uses EmailBodyEditor", "EmailBodyEditor" in src)
        _check(f"{module} no longer renders the textarea/preview split",
               "borderRight" not in src or src.count('gridTemplateColumns: "1fr 1fr", gap: 0') == 0,
               "found leftover split-pane grid")


# ── Main ──────────────────────────────────────────────────────────────────


def main() -> int:
    test_text_to_html_block_html_passes_through()
    test_text_to_html_table_passes_through()
    test_text_to_html_plain_text_wraps_paragraphs()
    test_text_to_html_inline_anchor_paragraph_wrapped_without_escape()
    test_text_to_html_single_newline_becomes_br()
    test_text_to_html_empty_inputs()
    test_body_to_editable_html_paragraph_wraps_around_signature()
    test_body_to_editable_html_bare_signature_token_substituted()
    test_body_to_editable_html_inline_signature_splits_paragraph()
    test_body_to_editable_html_signature_between_text_pieces()
    test_body_to_editable_html_empty_inputs()
    test_editable_html_to_body_restores_signature_placeholder()
    test_editable_html_to_body_tolerates_extra_attributes()
    test_editable_html_to_body_tolerates_single_quotes_around_class()
    test_editable_html_to_body_handles_signature_with_nested_divs()
    test_body_to_editable_and_back_roundtrip()
    test_theme_js_exposes_helpers()
    test_email_body_editor_component_loaded()
    test_index_html_loads_component()
    test_send_modals_use_email_body_editor()

    fail_count = sum(1 for _, ok in _results if not ok)
    print()
    print(f"== {len(_results) - fail_count}/{len(_results)} checks passed ==")
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
