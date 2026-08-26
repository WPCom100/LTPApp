"""The brand images in outbound email must be renderable by an email client.

Every response carries `Cross-Origin-Resource-Policy: same-origin`, which tells
browsers to refuse our resources to any other origin. Right for the app, wrong
for the two images we deliberately embed in mail — the masthead at the top of a
quote/invoice/receipt, and the sender's signature avatar. Outlook and Gmail
render those from THEIR origin, so the browser blocked them
(net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin) and every recipient saw a
broken-image box where the logo should be.

This pins both halves, because the fix is only correct if it stays narrow:
  - the embeddable paths say `cross-origin`
  - everything else — API, app shell, PDFs, share links — still says
    `same-origin`, and the other security headers are untouched everywhere

Runs both as pytest and as a plain script:
    python tests/test_email_image_headers.py
"""
import os
import sys

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_email_headers.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

import pytest  # noqa: E402

from backend import email_compose, main  # noqa: E402

CORP = "cross-origin-resource-policy"


# ── The classification itself ───────────────────────────────────────────────

@pytest.mark.parametrize("path", [
    "/assets/logos/luminary-masthead.png",   # the masthead on every document email
    "/assets/logos/ltp-avatar.png",          # the signature avatar fallback
    "/assets/icons/icon-192.png",
    "/assets/fonts.css",
    "/favicon.ico",
    "/api/users/photo/abc123",               # the app-cached sender avatar
])
def test_embeddable_paths(path):
    assert main._is_embeddable(path), path


@pytest.mark.parametrize("path", [
    "/",
    "/index.html",
    "/app.js",
    "/theme.js",
    "/sw.js",
    "/api/quotes",
    "/api/quotes/1",
    "/api/view/sometoken",
    "/auth/me",
    "/pdf/quote/1",
    # Near-misses: the prefix rule must not be fooled by a path that merely
    # mentions the embeddable segment somewhere other than the start.
    "/api/photo/users/1",
    "/api/users/photos",
    "/notassets/logos/x.png",
])
def test_everything_else_stays_locked_down(path):
    assert not main._is_embeddable(path), path


# ── The header the middleware actually emits ────────────────────────────────

def _emitted(path):
    """Header dict the middleware would produce for `path`, without running a
    request through the whole app."""
    mw = main.SecurityHeadersMiddleware(None, main._SECURITY_HEADERS)
    chosen = mw.embeddable_headers if main._is_embeddable(path) else mw.headers
    return {n.decode(): v.decode() for (n, v) in chosen}


def test_masthead_is_embeddable_by_an_email_client():
    # The exact asset in the broken email.
    got = _emitted(email_compose._LOGO_ASSET_PATH)
    assert got[CORP] == "cross-origin", got[CORP]


def test_signature_avatar_is_embeddable():
    got = _emitted(email_compose._AVATAR_ASSET_PATH)
    assert got[CORP] == "cross-origin", got[CORP]


def test_app_and_api_are_not():
    for path in ("/index.html", "/app.js", "/api/quotes/1", "/pdf/quote/1"):
        assert _emitted(path)[CORP] == "same-origin", path


def test_only_corp_differs():
    # The relaxation must be surgical: CSP, nosniff, frame-options, referrer
    # policy and the rest are identical on both paths. A blanket "public asset"
    # exemption that dropped those would be a much bigger change than intended.
    embeddable = _emitted("/assets/logos/luminary-masthead.png")
    normal = _emitted("/index.html")
    assert set(embeddable) == set(normal)
    differing = {k for k in normal if embeddable[k] != normal[k]}
    assert differing == {CORP}, differing


def test_the_email_still_points_at_those_paths():
    # If the composer stops using these paths, the exemption above is aimed at
    # the wrong thing and the images break again — silently.
    assert email_compose._LOGO_ASSET_PATH.startswith("/assets/")
    assert email_compose._AVATAR_ASSET_PATH.startswith("/assets/")
    assert main._is_embeddable(email_compose._LOGO_ASSET_PATH)
    assert main._is_embeddable(email_compose._AVATAR_ASSET_PATH)


def main_() -> int:
    simple = [
        test_masthead_is_embeddable_by_an_email_client,
        test_signature_avatar_is_embeddable,
        test_app_and_api_are_not,
        test_only_corp_differs,
        test_the_email_still_points_at_those_paths,
    ]
    failed = 0
    for t in simple:
        try:
            t()
            print(f"  [PASS] {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  [FAIL] {t.__name__}: {e}")
    # The parametrized pair, driven by hand in script mode.
    for path in ("/assets/logos/luminary-masthead.png", "/favicon.ico", "/api/users/photo/x"):
        ok = main._is_embeddable(path)
        print(f"  [{'PASS' if ok else 'FAIL'}] embeddable: {path}")
        failed += 0 if ok else 1
    for path in ("/index.html", "/api/quotes/1", "/api/users/photos"):
        ok = not main._is_embeddable(path)
        print(f"  [{'PASS' if ok else 'FAIL'}] locked down: {path}")
        failed += 0 if ok else 1
    print(f"\n== {'all' if not failed else str(failed) + ' FAILED'} ==")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main_())
