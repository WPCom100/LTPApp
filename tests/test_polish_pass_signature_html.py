"""Tests for the polish pass on the email feature:

  - Backend signature fallback when no template is configured
  - Custom signature template wins over fallback
  - All user variables (name/email/title/phone) substitute correctly
  - JS-side textToHtml heuristic (run via a Node-free sanity check
    against a Python port of the same logic — true cross-language
    parity would need a JS runner, out of scope for this suite).
"""
import asyncio
import os
import re
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_polish.db")
os.environ.setdefault("GOOGLE_CLIENT_ID", "fake-client-id")
os.environ.setdefault("GOOGLE_CLIENT_SECRET", "fake-client-secret")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

_db_path = os.path.join(_root, "_test_polish.db")
if os.path.exists(_db_path):
    os.remove(_db_path)

from backend import crypto, models  # noqa: E402
from backend.email_compose import _render_signature, _FALLBACK_SIGNATURE  # noqa: E402


_results: list[tuple[str, bool]] = []


def _check(label: str, cond: bool, detail: str = "") -> None:
    _results.append((label, cond))
    status = "PASS" if cond else "FAIL"
    suffix = f"  ({detail})" if detail else ""
    print(f"  [{status}] {label}{suffix}")
    assert cond, f"{label} {detail}"


# ── Backend signature fallback ────────────────────────────────────────────


def test_signature_fallback_when_settings_empty():
    print("test_signature_fallback_when_settings_empty")
    u = models.User(
        google_sub="g", email="alice@x.com", name="Alice",
        title="Producer", phone="555-1212",
    )
    out = _render_signature(u, {})
    _check("name substituted", "Alice" in out)
    _check("title substituted", "Producer" in out)
    _check("phone substituted", "555-1212" in out)
    _check("email substituted", "alice@x.com" in out)
    _check("contains an HTML tag (not raw text)", "<table" in out)
    _check("mailto link present", 'href="mailto:alice@x.com"' in out)
    _check("rich fallback includes brand color", "#ef5822" in out)
    _check("rich fallback includes social icons", "facebook" in out and "instagram" in out)


def test_signature_fallback_when_settings_has_other_keys():
    """Settings blob exists but lacks emailSignatureTemplate — still
    falls back."""
    print("test_signature_fallback_when_settings_has_other_keys")
    u = models.User(google_sub="g", email="b@x.com", name="Bob")
    out = _render_signature(u, {"companyName": "LTP", "emailFrom": "info@ltp.com"})
    _check("uses fallback when key missing", "<table" in out and "Bob" in out)


def test_signature_fallback_when_template_is_whitespace_only():
    print("test_signature_fallback_when_template_is_whitespace_only")
    u = models.User(google_sub="g", email="c@x.com", name="Carol")
    out = _render_signature(u, {"emailSignatureTemplate": "   \n\t  "})
    _check("whitespace-only template -> fallback", "<table" in out and "Carol" in out)


def test_backend_fallback_matches_frontend_default_structure():
    """The backend _FALLBACK_SIGNATURE should mirror the frontend's
    data/settings.js emailSignatureTemplate so the Send-modal preview
    (which renders the frontend default) matches what the recipient
    actually gets (rendered by the backend fallback). Strict byte
    equality is brittle across line-ending / minor formatting drift,
    so we pin specific shared markers — if these diverge it's almost
    certainly a regression."""
    print("test_backend_fallback_matches_frontend_default_structure")
    ds_path = os.path.join(_root, "data", "settings.js")
    with open(ds_path, encoding="utf-8") as f:
        frontend_src = f.read()
    # Markers that MUST appear in both
    markers = [
        "border-left:3px solid #dddddd",         # accent border
        "#ef5822",                                # LTP brand color
        "3786 Arapaho Rd.",                       # address line 1
        "Addison, TX 75001",                      # address line 2
        "https://LuminaryTechnology.Productions", # website (HTTPS)
        "facebook.com/profile.php?id=61563798680454",  # FB link
        "instagram.com/luminarytechnologyproductions",  # IG link
        "border-radius:50%",                      # circular profile photo
        "object-fit:cover",                       # photo crop policy
        "{{userPhoto}}",                          # per-user Google photo
        "{{userName}}", "{{userEmail}}",
        "{{userTitle}}", "{{userPhone}}",
    ]
    for marker in markers:
        _check(f"frontend has '{marker[:40]}...'", marker in frontend_src)
        _check(f"backend has '{marker[:40]}...'", marker in _FALLBACK_SIGNATURE)


def test_render_signature_html_escapes_user_fields():
    """Defense in depth: a user with <script> or & in their name should
    not leak into the rendered signature unescaped. The downstream bleach
    sanitizer would catch script tags too, but we escape here so dropping
    one layer doesn't reopen the hole."""
    print("test_render_signature_html_escapes_user_fields")
    u = models.User(
        google_sub="g", email="x@y.com",
        name="<script>alert(1)</script>", title="Boss & CEO", phone="555 < 1212",
        picture_url="https://lh3.googleusercontent.com/a/fake-photo",
    )
    out = _render_signature(u, {})
    _check("script tag escaped", "&lt;script&gt;" in out and "<script>alert" not in out)
    _check("ampersand escaped", "Boss &amp; CEO" in out)
    _check("less-than in phone escaped", "555 &lt; 1212" in out)


def test_signature_userphoto_substituted_from_picture_url():
    """The {{userPhoto}} placeholder should resolve to the user's Google
    profile picture URL."""
    print("test_signature_userphoto_substituted_from_picture_url")
    u = models.User(
        google_sub="g", email="alice@x.com", name="Alice",
        picture_url="https://lh3.googleusercontent.com/a/ACg8oc-FAKE=s96-c",
    )
    out = _render_signature(u, {})
    _check("picture_url appears in rendered signature",
           "https://lh3.googleusercontent.com/a/ACg8oc-FAKE=s96-c" in out)
    _check("no literal {{userPhoto}} left", "{{userPhoto}}" not in out)


def test_signature_userphoto_falls_back_when_picture_url_empty():
    """If a User row has no picture_url (rare for Google OAuth, but
    possible — pre-grant-scope users, or test seeds), {{userPhoto}}
    falls back to the self-hosted LTP avatar so the layout doesn't break.
    The avatar is served by the app (not the marketing site, whose old URL
    started 404ing) — a broken signature image looks unprofessional and
    is a deliverability penalty."""
    print("test_signature_userphoto_falls_back_when_picture_url_empty")
    u = models.User(google_sub="g", email="bob@x.com", name="Bob", picture_url="")
    out = _render_signature(u, {})
    _check("self-hosted avatar URL substituted",
           "/assets/logos/ltp-avatar.png" in out)
    _check("no broken marketing-site fallback",
           "wp-content/uploads/2024/07/LTP-Logo-Stacked.png" not in out)
    _check("no literal {{userPhoto}} left", "{{userPhoto}}" not in out)

    u2 = models.User(google_sub="g", email="c@x.com", name="Carol", picture_url=None)
    out2 = _render_signature(u2, {})
    _check("None picture_url also falls back",
           "/assets/logos/ltp-avatar.png" in out2)


def test_signature_userphoto_html_escaped():
    """picture_url comes from Google but defense-in-depth — should be
    escaped before substitution so even a hijacked Google response
    can't inject HTML."""
    print("test_signature_userphoto_html_escaped")
    u = models.User(
        google_sub="g", email="x@y.com", name="X",
        picture_url='https://x.com/photo.png"><script>alert(1)</script>',
    )
    out = _render_signature(u, {})
    _check("<script> in picture_url escaped",
           "&lt;script&gt;" in out and "<script>alert" not in out)
    _check("quote in picture_url escaped",
           "&quot;" in out or "&#x27;" in out or '&#34;' in out,
           f"got {out[:200]!r}")


def test_signature_custom_template_wins():
    print("test_signature_custom_template_wins")
    u = models.User(google_sub="g", email="d@x.com", name="Dee", title="VP")
    out = _render_signature(u, {
        "emailSignatureTemplate": "<p>Best,<br>{{userName}}, {{userTitle}}</p>"
    })
    _check("custom template used", out == "<p>Best,<br>Dee, VP</p>")
    _check("fallback NOT used when custom present",
           "{{userName}}" not in out and "Producer" not in out)


def test_signature_null_user_fields_handled():
    print("test_signature_null_user_fields_handled")
    u = models.User(google_sub="g", email="e@x.com", name=None,
                    title=None, phone=None)
    out = _render_signature(u, {})
    # Should not crash, and no literal {{...}} should appear
    _check("no placeholder leakage when fields are None",
           "{{" not in out, f"got {out!r}")


# ── data/settings.js — defaults shipped ───────────────────────────────────


def test_data_settings_has_rich_signature_default():
    """Verify the LTP-specific structure (logo, accent color, social
    icons) is in the data/settings.js default so admins see the
    intended layout in the preview without having to author it.

    Uses substring checks rather than regex extraction because the
    signature is a JS single-quoted string with embedded \\' escapes,
    which makes balanced-quote regex extraction brittle. The substrings
    we look for are sufficiently distinctive that a false positive
    (matching content elsewhere in the file) is implausible."""
    print("test_data_settings_has_rich_signature_default")
    path = os.path.join(_root, "data", "settings.js")
    with open(path, encoding="utf-8") as f:
        src = f.read()
    _check("emailSignatureTemplate key present", "emailSignatureTemplate:" in src)
    _check("rich signature uses <table>", "<table " in src)
    _check("rich signature includes {{userName}}", "{{userName}}" in src)
    _check("rich signature includes {{userEmail}}", "{{userEmail}}" in src)
    _check("rich signature includes {{userTitle}}", "{{userTitle}}" in src)
    _check("rich signature includes {{userPhone}}", "{{userPhone}}" in src)
    _check("accent color present (#ef5822)", "#ef5822" in src)
    _check("address present", "Addison" in src)
    _check("no Gmail-image-proxy URLs (broken in non-Gmail clients)",
           "googleusercontent.com/meips" not in src)


def test_data_settings_email_templates_wrap_viewurl_in_anchor():
    """Wherever {{viewUrl}} is rendered it must be wrapped in an <a> so the
    recipient sees a hyperlink, not a raw URL pasted inline.

    The View button now lives in theme.js::LTP_renderHeader (the per-type
    {{header}} action box) rather than a stored data/settings.js template,
    so that's where the anchor wrapper is pinned. data/settings.js must
    still never carry a BARE {{viewUrl}} on a body line."""
    print("test_data_settings_email_templates_wrap_viewurl_in_anchor")
    settings_path = os.path.join(_root, "data", "settings.js")
    with open(settings_path, encoding="utf-8") as f:
        src = f.read()
    theme_path = os.path.join(_root, "theme.js")
    with open(theme_path, encoding="utf-8") as f:
        theme = f.read()
    # The header generator wraps {{viewUrl}} in an anchor.
    _check("LTP_renderHeader wraps {{viewUrl}} in an <a>",
           'href="{{viewUrl}}"' in theme)
    # Each of the four templates that link to the live view should still
    # be present (so we didn't accidentally lose one in the refactor).
    for tmpl_key in ("quoteSent", "quoteFollowUp", "invoiceSent", "invoiceReminder"):
        _check(f"{tmpl_key} template still in file", tmpl_key + ":" in src)
    # No template body should have a naked {{viewUrl}} on a line by itself
    # (the bug the polish pass fixed). The Available: comment lists the
    # token but lives on a "//" line, so it's excluded.
    bare_viewurl_lines = [
        line for line in src.split("\n")
        if "{{viewUrl}}" in line and "href" not in line and "//" not in line
    ]
    _check("no bare {{viewUrl}} outside an href",
           len(bare_viewurl_lines) == 0,
           f"bare lines: {bare_viewurl_lines}")


# ── theme.js textToHtml — port the heuristic to Python so we can test
# the algorithm without a JS runtime. The implementation MUST match the
# JS one byte-for-byte at the contract level; if you change one, change
# the other and update this test in lockstep.


_HTML_DETECT_RE = re.compile(
    r"<\/?(p|div|h[1-6]|table|tr|td|th|ul|ol|li|blockquote|hr|article|section)\b",
    re.IGNORECASE,
)


def _py_text_to_html(s):
    """Python port of window.LTP_textToHtml for testing the algorithm.

    Critically does NOT escape `<` / `>` / `&` — that was the live bug
    this rewrite fixed. Inline tags (<a>, <strong>) in plain-text
    templates must survive to the recipient as clickable HTML; the
    downstream sanitizer (bleach/DOMPurify) is the trust boundary.
    """
    if s is None:
        return ""
    s = str(s)
    if _HTML_DETECT_RE.search(s):
        return s
    paras = [p.strip() for p in re.split(r"\n\s*\n+", s)]
    paras = [p for p in paras if p]
    if not paras:
        return ""
    return "\n".join("<p>" + p.replace("\n", "<br>") + "</p>" for p in paras)


def test_text_to_html_plain_text():
    print("test_text_to_html_plain_text")
    body = "Hi Alice,\n\nPlease find the attached quote.\n\nThanks!"
    out = _py_text_to_html(body)
    _check("3 paragraphs from blank-line-separated text",
           out.count("<p>") == 3, f"got {out.count('<p>')} <p> tags")
    _check("comma preserved", "Hi Alice," in out)


def test_text_to_html_passes_html_through():
    print("test_text_to_html_passes_html_through")
    body = "<p>Hello</p>\n<p>World</p>"
    out = _py_text_to_html(body)
    _check("HTML body unchanged", out == body)


def test_text_to_html_single_newlines_become_br():
    print("test_text_to_html_single_newlines_become_br")
    body = "Line 1\nLine 2\nLine 3"
    out = _py_text_to_html(body)
    _check("single newlines → <br>", out.count("<br>") == 2)
    _check("wrapped in one <p>", out.count("<p>") == 1)


def test_text_to_html_does_not_escape_inline_html():
    """REGRESSION GUARD for the bug this rewrite fixed: textToHtml used
    to escape <, > and & in plain-text bodies, turning inline <a> tags
    into literal '&lt;a&gt;' text in recipients' inboxes (broke the
    'View Online' link). Plain-text path now passes raw inline HTML
    through; the downstream sanitizer is the trust boundary."""
    print("test_text_to_html_does_not_escape_inline_html")
    body = '<a href="{{viewUrl}}">View Quote</a>\n\nThanks!'
    out = _py_text_to_html(body)
    _check("anchor open tag NOT escaped", "&lt;a" not in out)
    _check("anchor close tag NOT escaped", "&lt;/a&gt;" not in out)
    _check("href preserved", 'href="{{viewUrl}}"' in out)
    _check("paragraph-wrapped (inline tag does not trigger pass-through)",
           out.count("<p>") == 2, f"got {out.count('<p>')}")


def test_text_to_html_empty_and_whitespace():
    print("test_text_to_html_empty_and_whitespace")
    _check("None → ''", _py_text_to_html(None) == "")
    _check("'' → ''", _py_text_to_html("") == "")
    _check("whitespace-only → ''", _py_text_to_html("   \n\t  ") == "")


def test_text_to_html_detects_table_as_html():
    """A rich signature pasted as a table should pass through unchanged."""
    print("test_text_to_html_detects_table_as_html")
    body = '<table><tr><td>Hello</td></tr></table>'
    _check("table detected as HTML", _py_text_to_html(body) == body)


# ── modules/quotes-builder.js + invoices.js — verify they call the
# helpers (sanity test against regression of the polish pass).


def test_quotes_builder_send_paragraph_wraps_then_injects_header():
    """Quote send path: paragraph-wrap the (possibly plain-text) body FIRST
    (LTP_textToHtml on sendMessage), THEN drop the rendered header in at block
    level via LTP_injectBlock. Injecting the header before textToHtml lets its
    <table> trip block-detection, which passes the whole body through and
    collapses the body's plain-text paragraph breaks — the bug this fixes."""
    print("test_quotes_builder_send_paragraph_wraps_then_injects_header")
    path = os.path.join(_root, "modules", "quotes-builder.js")
    with open(path, encoding="utf-8") as f:
        src = f.read()
    _check("calls LTP_renderHeader to build the {{header}} box",
           "LTP_renderHeader" in src)
    _check("paragraph-wraps sendMessage BEFORE injecting the header",
           "LTP_injectBlock(window.LTP_textToHtml(String(sendMessage))" in src)
    _check("injects the header at block level via LTP_injectBlock",
           '"{{header}}", headerHtml' in src)
    _check("does NOT textToHtml the header-injected body (the collapse bug)",
           "LTP_textToHtml(bodyWithHeader)" not in src)


def test_quotes_builder_uses_helpers():
    """Preview pane is the EmailBodyEditor (single WYSIWYG component)
    instead of the prior split-pane + LTP_renderPreviewBody. The editor
    calls LTP_bodyToEditableHtml internally."""
    print("test_quotes_builder_uses_helpers")
    path = os.path.join(_root, "modules", "quotes-builder.js")
    with open(path, encoding="utf-8") as f:
        src = f.read()
    _check("Send modal renders EmailBodyEditor (replaces split-pane preview)",
           "window.EmailBodyEditor" in src)


def test_invoices_uses_helpers():
    print("test_invoices_uses_helpers")
    path = os.path.join(_root, "modules", "invoices.js")
    with open(path, encoding="utf-8") as f:
        src = f.read()
    _check("Send + Receipt modals render EmailBodyEditor",
           src.count("window.EmailBodyEditor") >= 2,
           f"got {src.count('window.EmailBodyEditor')} EmailBodyEditor refs")
    _check("Both send paths paragraph-wrap THEN inject the header (not the reverse)",
           src.count("LTP_renderHeader") >= 2
           and src.count("LTP_injectBlock(window.LTP_textToHtml(String(sendMessage))") >= 2
           and "LTP_textToHtml(bodyWithHeader)" not in src,
           f"renderHeader={src.count('LTP_renderHeader')}, "
           f"wrap-then-inject={src.count('LTP_injectBlock(window.LTP_textToHtml(String(sendMessage))')}")


def test_theme_js_exposes_helpers():
    print("test_theme_js_exposes_helpers")
    path = os.path.join(_root, "theme.js")
    with open(path, encoding="utf-8") as f:
        src = f.read()
    _check("window.LTP_textToHtml exposed",
           "window.LTP_textToHtml" in src)
    _check("window.LTP_renderSignature exposed",
           "window.LTP_renderSignature" in src)
    _check("window.LTP_renderPreviewBody exposed",
           "window.LTP_renderPreviewBody" in src)
    _check("window.LTP_injectBlock exposed (block-level token injector)",
           "window.LTP_injectBlock" in src)


def test_app_js_exposes_sender_title_phone():
    print("test_app_js_exposes_sender_title_phone")
    path = os.path.join(_root, "app.js")
    with open(path, encoding="utf-8") as f:
        src = f.read()
    _check("LTP_SENDER_TITLE set", "window.LTP_SENDER_TITLE" in src)
    _check("LTP_SENDER_PHONE set", "window.LTP_SENDER_PHONE" in src)


# ── Main ──────────────────────────────────────────────────────────────────


def main() -> int:
    test_signature_fallback_when_settings_empty()
    test_signature_fallback_when_settings_has_other_keys()
    test_signature_fallback_when_template_is_whitespace_only()
    test_backend_fallback_matches_frontend_default_structure()
    test_render_signature_html_escapes_user_fields()
    test_signature_userphoto_substituted_from_picture_url()
    test_signature_userphoto_falls_back_when_picture_url_empty()
    test_signature_userphoto_html_escaped()
    test_signature_custom_template_wins()
    test_signature_null_user_fields_handled()
    test_data_settings_has_rich_signature_default()
    test_data_settings_email_templates_wrap_viewurl_in_anchor()
    test_text_to_html_plain_text()
    test_text_to_html_passes_html_through()
    test_text_to_html_single_newlines_become_br()
    test_text_to_html_does_not_escape_inline_html()
    test_text_to_html_empty_and_whitespace()
    test_text_to_html_detects_table_as_html()
    test_quotes_builder_send_paragraph_wraps_then_injects_header()
    test_quotes_builder_uses_helpers()
    test_invoices_uses_helpers()
    test_theme_js_exposes_helpers()
    test_app_js_exposes_sender_title_phone()

    fail_count = sum(1 for _, ok in _results if not ok)
    print()
    print(f"== {len(_results) - fail_count}/{len(_results)} checks passed ==")
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
