"""Static-asset serving: the vendored barcode decoder must be served as JS.

modules/rentals-scan.js lazy-loads /assets/vendor/zxing.min.js via an injected
<script>. The server allow-lists which files are reachable (deny-by-default);
`assets/` was originally fonts/images/css only, so a .js under assets/ fell
through to the index.html SPA fallback and the browser (X-Content-Type-Options:
nosniff) refused to execute HTML as a script — the "barcode scanner didn't load"
bug. These tests lock in that assets/vendor/*.js is served with a JavaScript
content-type, while the deny-by-default posture is preserved elsewhere.

Runs under pytest (conftest pins env) or standalone:
    python tests/test_static_serving.py
"""
import os
import sys

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_static.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

from backend.main import _resolve_static  # noqa: E402


# ── Allowlist resolution (pure function; no app boot needed) ────────────────

def test_vendored_scanner_resolves():
    """assets/vendor/*.js and *.wasm must be reachable (the scan-import decoder)."""
    for rel in ("assets/vendor/zxing-wasm-reader.js", "assets/vendor/zxing_reader.wasm"):
        resolved = _resolve_static(rel)
        assert resolved is not None, f"{rel} should be allow-listed"
        assert resolved.replace(os.sep, "/").endswith(rel)


def test_vendored_files_exist_on_disk():
    """The decoder glue + binary are committed (not just allow-listed)."""
    assert os.path.isfile(os.path.join(_root, "assets", "vendor", "zxing-wasm-reader.js"))
    assert os.path.isfile(os.path.join(_root, "assets", "vendor", "zxing_reader.wasm"))


def test_crew_announcement_resolves():
    """The standalone crew announcement page must be reachable — it is the
    fallback crew are pointed at when their mail client mangles the email."""
    rel = "assets/crew-email/announcement.html"
    resolved = _resolve_static(rel)
    assert resolved is not None, f"{rel} should be allow-listed"
    assert resolved.replace(os.sep, "/").endswith(rel)


def test_crew_announcement_exists_on_disk():
    """The page and its toolbar script are committed, not just allow-listed."""
    assert os.path.isfile(os.path.join(_root, "assets", "crew-email", "announcement.html"))
    assert os.path.isfile(os.path.join(_root, "assets", "crew-email", "briefing.js"))


def test_crew_briefing_script_resolves():
    """The toolbar script must be reachable. It is a file rather than an inline
    block precisely because script-src is 'self' with no 'unsafe-inline'."""
    rel = "assets/crew-email/briefing.js"
    resolved = _resolve_static(rel)
    assert resolved is not None, f"{rel} should be allow-listed"
    assert resolved.replace(os.sep, "/").endswith(rel)


def test_deny_by_default_preserved():
    """Non-frontend files at the repo root stay unreachable — the allowlist must
    not have widened beyond assets/vendor/*.{js,wasm} and
    assets/crew-email/*.{html,js}."""
    for denied in ("requirements.txt", "backend/main.py", "alembic.ini", "pytest.ini",
                   "assets/foo.wasm", "assets/bar.js",  # .wasm/.js only under vendor/
                   "assets/rogue.html", "index2.html",   # .html only under crew-email/
                   "assets/rogue.js",                    # .js only under vendor/ + crew-email/
                   "assets/crew-email/notes.txt"):       # only .html/.js in there
        assert _resolve_static(denied) is None, f"{denied} must not be servable"


def test_control_module_js_resolves():
    """Sanity: a normal module .js still resolves (guards against a regression
    that breaks the existing trees while touching the allowlist)."""
    assert _resolve_static("modules/rentals-scan.js") is not None


# ── End-to-end content-type (the actual browser-facing behavior) ───────────

def test_scanner_glue_served_as_javascript():
    """GET the decoder glue through the real app: 200 + a JavaScript content-type
    (NOT text/html), which nosniff requires for the <script> to execute."""
    from fastapi.testclient import TestClient
    from backend.main import app
    with TestClient(app) as client:
        r = client.get("/assets/vendor/zxing-wasm-reader.js")
        assert r.status_code == 200, f"got {r.status_code}"
        ct = r.headers.get("content-type", "").lower()
        assert "javascript" in ct, f"expected a JS content-type, got {ct!r}"
        assert not r.text.lstrip().startswith("<!DOCTYPE"), "served the SPA fallback, not the JS"


def test_wasm_served_as_application_wasm():
    """The .wasm binary must be served as application/wasm — WebAssembly
    instantiateStreaming validates the MIME and refuses anything else."""
    from fastapi.testclient import TestClient
    from backend.main import app
    with TestClient(app) as client:
        r = client.get("/assets/vendor/zxing_reader.wasm")
        assert r.status_code == 200, f"got {r.status_code}"
        ct = r.headers.get("content-type", "").lower()
        assert "application/wasm" in ct, f"expected application/wasm, got {ct!r}"
        assert r.content[:4] == b"\x00asm", "not a valid wasm binary"


def test_crew_announcement_served_as_html():
    """GET the announcement page through the real app: 200 + text/html, and the
    page's OWN content — not the index.html SPA fallback, which also returns 200
    and is the failure mode this allow-list entry exists to prevent."""
    from fastapi.testclient import TestClient
    from backend.main import app
    with TestClient(app) as client:
        r = client.get("/assets/crew-email/announcement.html")
        assert r.status_code == 200, f"got {r.status_code}"
        ct = r.headers.get("content-type", "").lower()
        assert "text/html" in ct, f"expected text/html, got {ct!r}"
        # Distinguishing marker: the announcement's <title>, which the SPA shell
        # does not carry. A status-code-only check cannot tell these apart.
        assert "Your New Call Sheet" in r.text, "served the SPA fallback, not the page"
        assert "LTP Business Suite" not in r.text, "this is the app shell, not the page"


def test_crew_briefing_script_served_as_javascript():
    """The toolbar script must come back with a JavaScript content-type. If it
    falls through to the SPA fallback, nosniff blocks execution and the toolbar
    renders dead — the exact failure the file (vs inline) split exists to avoid."""
    from fastapi.testclient import TestClient
    from backend.main import app
    with TestClient(app) as client:
        r = client.get("/assets/crew-email/briefing.js")
        assert r.status_code == 200, f"got {r.status_code}"
        ct = r.headers.get("content-type", "").lower()
        assert "javascript" in ct, f"expected a JS content-type, got {ct!r}"
        assert not r.text.lstrip().startswith("<!DOCTYPE"), "served the SPA fallback, not the script"


def test_crew_page_has_no_inline_script():
    """The page must not carry an inline <script>: the CSP would refuse it and
    the toolbar would silently do nothing. Pins the build's file split."""
    path = os.path.join(_root, "assets", "crew-email", "announcement.html")
    with open(path, encoding="utf-8") as fh:
        html = fh.read()
    assert "<script src=" in html, "page should load its script from a file"
    assert "<script>" not in html, "inline <script> would be refused by the CSP"


def test_crew_page_hides_the_sender_toolbar():
    """The sender toolbar must not be painted for crew.

    It carries the `hidden` attribute, but that is only a UA-stylesheet
    `display:none` — and `.tools` sets `display:flex`, which as author CSS
    beats it. Without an explicit `[hidden]` reset the bar renders in full for
    every visitor while `element.hidden` still reads true, so checking the
    property (or the attribute) cannot catch this. Assert the reset exists.
    """
    path = os.path.join(_root, "assets", "crew-email", "announcement.html")
    with open(path, encoding="utf-8") as fh:
        html = fh.read()
    assert 'id="tools" hidden' in html, "the toolbar must carry the hidden attribute"
    assert "display:flex" in html, "sanity: .tools still sets a display that beats the UA rule"
    assert "[hidden]{display:none !important}" in html, (
        "no [hidden] reset — the toolbar would render for crew despite the attribute"
    )


def test_csp_allows_wasm():
    """The CSP script-src must include 'wasm-unsafe-eval' so the decoder can
    instantiate WebAssembly (without it the browser blocks the whole module)."""
    from fastapi.testclient import TestClient
    from backend.main import app
    with TestClient(app) as client:
        r = client.get("/")
        csp = r.headers.get("content-security-policy", "")
        assert "wasm-unsafe-eval" in csp, "CSP must allow WebAssembly instantiation"


def main() -> int:
    tests = [
        test_vendored_scanner_resolves,
        test_vendored_files_exist_on_disk,
        test_deny_by_default_preserved,
        test_control_module_js_resolves,
        test_scanner_glue_served_as_javascript,
        test_wasm_served_as_application_wasm,
        test_csp_allows_wasm,
    ]
    failures = 0
    for fn in tests:
        try:
            fn()
            print(f"  [PASS] {fn.__name__}")
        except AssertionError as e:
            failures += 1
            print(f"  [FAIL] {fn.__name__}: {e}")
    print()
    print(f"== {len(tests) - failures}/{len(tests)} checks passed ==")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
