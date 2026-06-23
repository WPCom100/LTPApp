"""Tests for the shared branded email container + masthead.

Every email — crew AND customer (quotes/invoices/receipts) — is wrapped at send
time in the SAME container (crew.py::email_shell: light canvas -> white card with
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
import sys

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _root)


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
    from backend.routes import crew
    html = crew.render_masthead(_brand())
    assert html.strip().startswith("<table") and html.strip().endswith("</table>")
    for pin in _PINS:
        assert pin in html, f"masthead missing: {pin}"


def test_email_shell_wraps_with_masthead_on_top_and_footer_below():
    from backend.routes import crew
    shell = crew.email_shell("<p>HELLO BODY</p>", _brand())
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
    crew = _read("backend", "routes", "crew.py")
    assert "def email_shell(" in crew
    assert "render_masthead(brand)" in crew      # shell renders the shared masthead
    assert "email_shell(inner, brand)" in crew   # crew sends use the same shell


def main() -> int:
    tests = [
        test_render_masthead_block,
        test_email_shell_wraps_with_masthead_on_top_and_footer_below,
        test_customer_emails_wrapped_in_container_on_send,
        test_crew_shell_is_the_shared_container,
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
