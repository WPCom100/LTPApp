"""Tests for the shared email {{masthead}} block.

{{masthead}} renders the branded masthead — the linear Luminary lockup butting
a 4px brand-orange rule that starts at the mask's left edge and bleeds to the
right edge — at the top of any email. It's the SAME block the crew emails use,
now exposed as a reusable token so quotes/invoices/receipts can insert it too.

Substitution split (mirrors {{signature}}):
  - Backend (authoritative): email.py substitutes {{masthead}} at send time via
    crew.py::render_masthead. crew.py also uses it directly in the crew shell.
  - Frontend (preview only): theme.js::window.LTP_renderMasthead, wired into
    LTP_renderPreviewBody so the Send-modal preview shows the real block.

This file pins the two renderings together (structural substrings) so they can't
drift, and checks the token is wired through send + preview + the editor chips.
"""
import os
import sys

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _root)


def _read(*parts):
    with open(os.path.join(_root, *parts), encoding="utf-8") as f:
        return f.read()


# Structural substrings the masthead MUST contain on both the rendered backend
# output and the frontend source. Drift on either side fails the test.
_PINS = [
    "/assets/logos/luminary-masthead.png",            # self-hosted linear lockup
    "border-bottom:4px solid #f15927",                # 4px brand-orange rule
    'width="31"',                                     # left spacer = mask edge + 1px
    "width:31px",
    "max-width:380px",                                # responsive logo
    "margin:0 0 -1px 0",                              # 1px overlap (browsers)
    "border-collapse:collapse",                       # email seam removal
    "font-size:0;line-height:0",                      # email seam removal
]


def _backend_masthead():
    from backend.routes import crew
    return crew.render_masthead(
        {"logo": "https://h.example/assets/logos/luminary-masthead.png",
         "company": "Luminary Technology & Productions"}
    )


def test_backend_render_masthead_has_all_pins():
    html = _backend_masthead()
    assert html.strip().startswith("<table") and html.strip().endswith("</table>")
    for pin in _PINS:
        assert pin in html, f"backend masthead missing: {pin}"


def test_frontend_masthead_source_has_all_pins():
    theme = _read("theme.js")
    assert "window.LTP_renderMasthead" in theme
    for pin in _PINS:
        assert pin in theme, f"frontend LTP_renderMasthead missing: {pin}"


def test_masthead_substituted_server_side_on_send():
    email = _read("backend", "routes", "email.py")
    assert 'replace("{{masthead}}"' in email
    assert "render_masthead(_email_brand(settings_data))" in email


def test_masthead_wired_into_preview_and_settings():
    theme = _read("theme.js")
    # wired into the Send-modal preview body
    assert "{{masthead}}" in theme and "LTP_renderMasthead()" in theme
    # offered as an insertable variable chip in the Settings editor
    assert '"masthead"' in _read("modules", "settings.js")
    # documented in the canonical variable list
    assert "{{masthead}}" in _read("data", "settings.js")


def test_crew_shell_still_uses_the_shared_masthead():
    # the crew email shell renders via the same render_masthead (no divergence)
    crew = _read("backend", "routes", "crew.py")
    assert "render_masthead(brand)" in crew


def main() -> int:
    tests = [
        test_backend_render_masthead_has_all_pins,
        test_frontend_masthead_source_has_all_pins,
        test_masthead_substituted_server_side_on_send,
        test_masthead_wired_into_preview_and_settings,
        test_crew_shell_still_uses_the_shared_masthead,
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
