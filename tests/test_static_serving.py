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


# ── Health check ───────────────────────────────────────────────────────────
# There was no health endpoint and no healthcheckPath, so a boot that died in
# init_db()'s Alembic run just restart-looped (restartPolicyMaxRetries: 10)
# with nothing to distinguish it from a crash. The endpoint must be registered
# BEFORE the SPA catch-all: the fallback returns index.html with a 200 for any
# unmatched path, which would "pass" a health check for entirely the wrong
# reason.

def test_healthz_is_json_not_the_spa_fallback():
    from fastapi.testclient import TestClient
    from backend.main import app

    with TestClient(app) as c:
        r = c.get("/healthz")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("application/json"), r.headers
        body = r.json()
        assert body["status"] == "ok"
        # The tell: an unmatched path returns the HTML shell with a 200.
        shell = c.get("/definitely-not-a-route")
        assert shell.status_code == 200
        assert shell.headers["content-type"].startswith("text/html")
        assert "<html" not in r.text.lower()


def test_healthz_does_not_require_a_session():
    """It answers "is this process serving?", so it must work before anyone
    signs in — and must not depend on the database, or a transient DB blip
    would have the platform restart a process that would recover on its own."""
    from fastapi.testclient import TestClient
    from backend.main import app

    with TestClient(app) as c:
        r = c.get("/healthz")
        assert r.status_code == 200
        # Assert the content type, not just the status: the SPA fallback also
        # answers 200 for an unknown path, so a bare status check would pass
        # even with no health endpoint at all.
        assert r.headers["content-type"].startswith("application/json")


def test_healthcheck_path_is_wired_in_railway_json():
    import json, os
    cfg = json.load(open(os.path.join(_root, "railway.json")))
    assert cfg["deploy"]["healthcheckPath"] == "/healthz"


# ── DATABASE_URL fail-fast ─────────────────────────────────────────────────
# Without DATABASE_URL the app used to boot on a container-local SQLite file,
# run Alembic against it to create an empty schema, and hand the first Google
# sign-in an admin account — while every write landed on a filesystem the
# platform discards on the next restart. The logs looked like a healthy boot.
# database.py raises at import time, so this has to run in a subprocess.

def _probe_database_import(env_overrides):
    """Import backend.database in a clean interpreter. Returns (rc, stderr)."""
    import subprocess, sys as _sys, os as _os
    env = {k: v for k, v in _os.environ.items()
           if not k.startswith(("DATABASE_URL", "LTP_FORCE_HTTPS", "LTP_OAUTH_REDIRECT_URI"))}
    env.update(env_overrides)
    env.setdefault("PATH", _os.environ.get("PATH", ""))
    p = subprocess.run(
        [_sys.executable, "-c", "import backend.database"],
        cwd=_root, env=env, capture_output=True, text=True, timeout=120,
    )
    return p.returncode, (p.stderr or "")


def test_missing_database_url_refuses_to_boot_in_production():
    rc, err = _probe_database_import({"LTP_FORCE_HTTPS": "1"})
    assert rc != 0, "a production boot with no DATABASE_URL must fail loudly"
    assert "DATABASE_URL is not set" in err, err[-600:]

    # The https redirect URI is the other production signal main.py uses.
    rc, err = _probe_database_import(
        {"LTP_OAUTH_REDIRECT_URI": "https://app.example.com/auth/callback"})
    assert rc != 0
    assert "DATABASE_URL is not set" in err, err[-600:]


def test_missing_database_url_still_falls_back_for_local_dev():
    """Development must keep working with no configuration at all — the guard
    is about deployments, not about making a laptop harder to use."""
    rc, err = _probe_database_import(
        {"LTP_OAUTH_REDIRECT_URI": "http://localhost:8000/auth/callback"})
    assert rc == 0, err[-600:]

    rc, err = _probe_database_import({})   # nothing set at all
    assert rc == 0, err[-600:]
