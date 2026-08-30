"""Tests for the shared branded email container + masthead.

Every email — crew AND customer (quotes/invoices/receipts) — is wrapped at send
time in the SAME container (email_compose.email_shell: light canvas -> white card with
the masthead on top + footer), so the masthead and layout are identical
everywhere. The masthead is NOT a body token; the container provides it.

Covered:
  - render_masthead renders the linear-lockup masthead block (structural pins).
  - email_shell wraps content in the card container with the masthead on top
    and the footer below.
  - email.py wraps every sent email in email_shell and strips any stray
    {{masthead}} token so it never renders literally.
  - the crew email shell IS the same email_shell / render_masthead (one
    container, no divergence between crew and customer email).
"""
import os
import re
import sys

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _root)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _domain_source import domain_source  # noqa: E402


def _read(*parts):
    with open(os.path.join(_root, *parts), encoding="utf-8") as f:
        return f.read()


# Structural substrings the rendered masthead must contain.
_PINS = [
    "/assets/logos/luminary-masthead.png",   # self-hosted linear lockup
    "border-bottom:4px solid #f15927",        # 4px brand-orange rule
    'width="31"',                            # left spacer = mask edge + 1px
    "max-width:380px",                        # responsive logo
    "margin:0 0 -1px 0",                      # 1px overlap (browsers)
    "border-collapse:collapse",               # email seam removal
]


def _brand():
    return {"logo": "https://h.example/assets/logos/luminary-masthead.png",
            "company": "Luminary Technology & Productions", "website": "ltp.example"}


def test_render_masthead_block():
    from backend import email_compose
    html = email_compose.render_masthead(_brand())
    assert html.strip().startswith("<table") and html.strip().endswith("</table>")
    for pin in _PINS:
        assert pin in html, f"masthead missing: {pin}"


def test_masthead_falls_back_to_text_without_absolute_logo():
    """A relative or empty logo URL — what _email_brand yields when the app
    origin is unknown (LTP_OAUTH_REDIRECT_URI unset) — can't be resolved by an
    email client, so it must render the styled text wordmark instead of a broken
    <img>. Regression: the receipt in the bug report showed a broken-image box at
    the top because the masthead emitted an <img> with a relative src."""
    from backend import email_compose
    for bad_logo in ("/assets/logos/luminary-masthead.png", "", "assets/logos/x.png"):
        brand = {"logo": bad_logo, "company": "Luminary Technology & Productions",
                 "website": "ltp.example"}
        html = email_compose.render_masthead(brand)
        assert "<img" not in html, f"broken <img> emitted for logo={bad_logo!r}"
        assert "Luminary Technology &amp; Productions" in html  # text wordmark
        assert "border-bottom:4px solid #f15927" in html         # rule still present
    # An absolute https logo is served through as an <img> (unchanged path).
    ok = email_compose.render_masthead(_brand())
    assert "<img" in ok and "luminary-masthead.png" in ok


def test_email_brand_relative_logo_degrades_in_shell(monkeypatch):
    """End to end: with no app origin, _email_brand's relative logo must not
    reach the sent email as a broken <img> — email_shell renders the text
    wordmark."""
    monkeypatch.delenv("LTP_OAUTH_REDIRECT_URI", raising=False)
    monkeypatch.delenv("LTP_FORCE_HTTPS", raising=False)
    from backend import email_compose
    brand = email_compose._email_brand({"companyName": "Luminary Technology & Productions"})
    assert not brand["logo"].startswith(("http://", "https://"))  # relative in this env
    shell = email_compose.email_shell("<p>BODY</p>", brand)
    assert "<img" not in shell


def test_email_shell_wraps_with_masthead_on_top_and_footer_below():
    from backend import email_compose
    shell = email_compose.email_shell("<p>HELLO BODY</p>", _brand())
    # the card container
    assert "max-width:580px" in shell and "border-radius:14px" in shell
    # masthead present and ABOVE the body content
    assert "/assets/logos/luminary-masthead.png" in shell
    assert shell.index("luminary-masthead.png") < shell.index("HELLO BODY")
    # footer (company) renders below the body
    assert "Luminary Technology" in shell.rsplit("HELLO BODY", 1)[1]


def test_customer_emails_wrapped_in_container_on_send():
    email = _read("backend", "routes", "email.py")
    assert "email_shell(inner_html, _email_brand(settings_data))" in email
    # the body token is stripped — the container provides the masthead
    assert 'replace("{{masthead}}", "")' in email


def test_crew_shell_is_the_shared_container():
    # The shared shell now lives in the neutral email_compose module; crew and
    # email both import it, so there is genuinely one container (no divergence).
    compose = _read("backend", "email_compose.py")
    assert "def email_shell(" in compose
    assert "render_masthead(brand)" in compose   # shell renders the shared masthead
    crew = _read("backend", "routes", "crew.py")
    assert "email_shell(inner, brand)" in crew   # crew sends use the same shell


def test_all_email_content_is_fluid_for_small_screens():
    """No element forces width beyond a phone screen, across every template."""
    email = _read("backend", "routes", "email.py")
    compose = _read("backend", "email_compose.py")
    settings = _read("data", "settings.js")
    theme = domain_source()
    # The customer {{header}} action box is generated per type by
    # components/domain-email.js::LTP_renderHeader (no longer a stored settings
    # template). Slice to the NEXT top-level export rather than naming the one
    # that happens to follow — that coupling broke when the neighbouring dead
    # LTP_renderPreviewBody was removed.
    _seg = theme.split("LTP_renderHeader = function", 1)[1]
    _next = re.search(r"\nwindow\.LTP_\w+\s*=", _seg)
    assert _next, "could not find the export following LTP_renderHeader"
    header_js = _seg[: _next.start()]
    sig_js = settings.split("emailSignatureTemplate:")[1].split("',")[0]
    # customer header wraps (no nowrap) and stacks via inline-block on narrow screens
    assert "white-space:nowrap" not in header_js
    assert "display:inline-block" in header_js
    # nothing in the relayed customer email forces a fixed wide width
    assert "white-space:nowrap" not in email
    # signature: long email/links can break + the table can't exceed the screen
    # (the server-side fallback signature now lives in backend/email_compose.py)
    assert "word-break:break-word" in compose and "word-break:break-word" in sig_js
    assert "border-collapse:collapse;max-width:100%" in compose and "border-collapse:collapse;max-width:100%" in sig_js
    # sanitizer permits the safe wrapping properties
    sani = _read("backend", "sanitize.py")
    assert '"word-break"' in sani and '"overflow-wrap"' in sani


def main() -> int:
    tests = [
        test_render_masthead_block,
        test_email_shell_wraps_with_masthead_on_top_and_footer_below,
        test_customer_emails_wrapped_in_container_on_send,
        test_crew_shell_is_the_shared_container,
        test_all_email_content_is_fluid_for_small_screens,
    ]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  [PASS] {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  [FAIL] {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
