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


def test_deny_by_default_preserved():
    """Non-frontend files at the repo root stay unreachable — the allowlist must
    not have widened beyond assets/vendor/*.{js,wasm}."""
    for denied in ("requirements.txt", "backend/main.py", "alembic.ini", "pytest.ini",
                   "assets/foo.wasm", "assets/bar.js"):  # .wasm/.js only under vendor/
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
