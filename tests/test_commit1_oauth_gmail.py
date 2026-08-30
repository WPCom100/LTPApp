"""Tests covering commit 1 of the email feature: OAuth scope extension,
Fernet token-at-rest encryption, _persist_gmail_tokens helper, scope
detection, _client_ip XFF parsing with spoofing scenarios, /auth/me shape.

Runs as a plain script (no pytest required): `python tests/test_commit1_oauth_gmail.py`
from the repo root. Self-contained — sets all required env vars before
importing backend so no test runner / fixture machinery is needed.

A real pytest harness can be layered later; this file is intentionally
runnable both ways (functions named test_* + a main() entry point).
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

# Set required env vars BEFORE importing backend so module-level loads succeed.
os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "http://localhost:8000/auth/callback")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

# Path setup so this works from any cwd
_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

from backend import crypto, models  # noqa: E402
from backend.rate_limit import _client_ip  # noqa: E402
from backend.routes.auth import (  # noqa: E402
    _persist_gmail_tokens,
    _has_gmail_send_scope,
    GMAIL_SEND_SCOPE,
)


_results: list[tuple[str, bool]] = []


def _check(label: str, cond: bool, detail: str = "") -> None:
    _results.append((label, cond))
    status = "PASS" if cond else "FAIL"
    suffix = f"  ({detail})" if detail else ""
    print(f"  [{status}] {label}{suffix}")
    assert cond, f"{label} {detail}"


def test_crypto_roundtrip() -> None:
    print("test_crypto_roundtrip")
    pt = "1//09this-is-a-google-refresh-token"
    ct = crypto.encrypt_token(pt)
    _check("ciphertext differs from plaintext", ct != pt)
    _check("ciphertext is non-empty", len(ct) > 50)
    _check("decrypt roundtrips", crypto.decrypt_token(ct) == pt)
    try:
        crypto.decrypt_token(ct[:-1] + ("A" if ct[-1] != "A" else "B"))
        _check("tampered ciphertext raises", False)
    except Exception:
        _check("tampered ciphertext raises", True)


def test_crypto_missing_key_raises() -> None:
    """Confirm the helper fails loudly when LTP_TOKEN_ENCRYPTION_KEY is absent.
    Runs in a subprocess so unsetting the env var doesn't leak into the rest
    of the test run."""
    print("test_crypto_missing_key_raises")
    import subprocess
    code = (
        "import os\n"
        "os.environ.pop('LTP_TOKEN_ENCRYPTION_KEY', None)\n"
        "from backend.crypto import encrypt_token\n"
        "try:\n"
        "    encrypt_token('x')\n"
        "    print('NO_RAISE')\n"
        "except RuntimeError as e:\n"
        "    print('RAISED' if 'LTP_TOKEN_ENCRYPTION_KEY' in str(e) else 'WRONG_MSG')\n"
    )
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    env.pop("LTP_TOKEN_ENCRYPTION_KEY", None)
    out = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True, text=True, cwd=_root, env=env,
    )
    _check("missing key raises RuntimeError mentioning the env var",
           "RAISED" in out.stdout,
           f"stdout={out.stdout!r} stderr={out.stderr!r}")


def test_persist_full_payload() -> None:
    print("test_persist_full_payload")
    u = models.User(google_sub="g1", email="a@b.com", name="A")
    now = datetime.now(timezone.utc)
    tok = {
        "access_token": "ya29.access",
        "refresh_token": "1//refresh-tok",
        "expires_in": 3599,
        "scope": f"openid email profile {GMAIL_SEND_SCOPE}",
    }
    _persist_gmail_tokens(u, tok, now)
    _check("access token stored encrypted",
           bool(u.gmail_access_token) and u.gmail_access_token != "ya29.access")
    _check("access token decrypts to original",
           crypto.decrypt_token(u.gmail_access_token) == "ya29.access")
    _check("refresh token decrypts to original",
           crypto.decrypt_token(u.gmail_refresh_token) == "1//refresh-tok")
    _check("scope persisted verbatim", u.gmail_granted_scopes == tok["scope"])
    _check("expires_at is ~3599s from now",
           abs((u.gmail_token_expires_at - now).total_seconds() - 3599) < 2)


def test_persist_no_refresh_preserves_old() -> None:
    print("test_persist_no_refresh_preserves_old")
    u = models.User(google_sub="g2", email="x@y.com", name="X")
    u.gmail_refresh_token = crypto.encrypt_token("OLD-REFRESH")
    now = datetime.now(timezone.utc)
    tok = {"access_token": "new-access", "expires_in": 100, "scope": GMAIL_SEND_SCOPE}
    _persist_gmail_tokens(u, tok, now)
    _check("old refresh token NOT overwritten when new is absent",
           crypto.decrypt_token(u.gmail_refresh_token) == "OLD-REFRESH")
    _check("access token still updated",
           crypto.decrypt_token(u.gmail_access_token) == "new-access")


def test_persist_expires_at_epoch() -> None:
    print("test_persist_expires_at_epoch")
    u = models.User(google_sub="g3", email="x@y.com", name="X")
    now = datetime.now(timezone.utc)
    epoch = int((now + timedelta(seconds=500)).timestamp())
    tok = {"access_token": "a", "refresh_token": "r", "expires_at": epoch, "scope": "openid"}
    _persist_gmail_tokens(u, tok, now)
    delta = (u.gmail_token_expires_at - now).total_seconds()
    _check("expires_at parsed from epoch field", abs(delta - 500) < 2)


def test_persist_expires_at_independent_of_access_token() -> None:
    """Regression for review finding (Critical 3): if Google ever returns
    refresh_token + expires_at without access_token, the computed expiry
    must still be persisted (was previously gated on access_token presence)."""
    print("test_persist_expires_at_independent_of_access_token")
    u = models.User(google_sub="g7", email="x@y.com", name="X")
    now = datetime.now(timezone.utc)
    tok = {"refresh_token": "r", "expires_in": 3600, "scope": GMAIL_SEND_SCOPE}
    _persist_gmail_tokens(u, tok, now)
    _check("expires_at persisted even when access_token absent",
           u.gmail_token_expires_at is not None
           and abs((u.gmail_token_expires_at - now).total_seconds() - 3600) < 2)


def test_persist_bad_expires_in_logged() -> None:
    """Confirm a malformed expires_in is caught and logged (no crash)."""
    print("test_persist_bad_expires_in_logged")
    u = models.User(google_sub="g8", email="x@y.com", name="X")
    now = datetime.now(timezone.utc)
    tok = {"access_token": "a", "refresh_token": "r", "expires_in": "not-a-number", "scope": "openid"}
    _persist_gmail_tokens(u, tok, now)  # should not raise
    _check("bad expires_in handled gracefully (no expiry persisted)",
           u.gmail_token_expires_at is None)


def test_has_gmail_send_scope() -> None:
    print("test_has_gmail_send_scope")
    u = models.User(google_sub="g4", email="x@y.com", name="X")
    _check("absent scopes -> False", _has_gmail_send_scope(u) is False)
    u.gmail_granted_scopes = "openid email profile"
    _check("scopes without gmail.send -> False", _has_gmail_send_scope(u) is False)
    u.gmail_granted_scopes = f"openid email profile {GMAIL_SEND_SCOPE}"
    _check("scopes with gmail.send -> True", _has_gmail_send_scope(u) is True)


def _scope(xff_value=None, socket_ip="127.0.0.1"):
    headers = []
    if xff_value is not None:
        headers.append((b"x-forwarded-for", xff_value.encode("ascii")))
    return {"headers": headers, "client": (socket_ip, 12345)}


def test_client_ip_railway_default() -> None:
    print("test_client_ip_railway_default (LTP_TRUST_PROXY_HOPS=1)")
    ip = _client_ip(_scope(xff_value="203.0.113.45"))
    _check("single-hop XFF -> returns client IP", ip == "203.0.113.45")

    # Spoofing scenario: client sends `X-Forwarded-For: 1.2.3.4`, Railway
    # appends its observed IP. We must return Railway's view, NOT the spoof.
    ip = _client_ip(_scope(xff_value="1.2.3.4, 203.0.113.45"))
    _check("spoofed XFF -> returns rightmost (real proxy view)",
           ip == "203.0.113.45", f"got {ip!r}")

    ip = _client_ip(_scope(xff_value=None, socket_ip="10.0.0.1"))
    _check("no XFF -> socket IP", ip == "10.0.0.1")

    ip = _client_ip(_scope(xff_value="", socket_ip="10.0.0.2"))
    _check("empty XFF -> socket IP", ip == "10.0.0.2")


async def test_auth_me_shape() -> None:
    print("test_auth_me_shape")
    from backend.routes.auth import me
    u = models.User(
        id=42, google_sub="g5", email="alice@workspace.com", name="Alice",
        picture_url="https://...", role="admin", title="Producer", phone="555-1212",
    )
    out = await me(user=u)
    _check("returns id, email, name, role",
           out["id"] == 42 and out["email"] == "alice@workspace.com")
    _check("title + phone surfaced",
           out["title"] == "Producer" and out["phone"] == "555-1212")
    _check("gmailConnected False when no refresh token",
           out["gmailConnected"] is False)
    _check("gmailScope 'none' when no scopes", out["gmailScope"] == "none")

    u.gmail_refresh_token = crypto.encrypt_token("rt")
    u.gmail_granted_scopes = f"openid {GMAIL_SEND_SCOPE}"
    out = await me(user=u)
    _check("gmailConnected True after refresh-token set",
           out["gmailConnected"] is True)
    _check("gmailScope 'send' when scope present", out["gmailScope"] == "send")


async def test_auth_me_null_safe_for_pre_feature_users() -> None:
    """A User row created before this commit has NULL in title/phone/gmail_*
    columns. /auth/me must return a JSON-safe response without raising."""
    print("test_auth_me_null_safe_for_pre_feature_users")
    from backend.routes.auth import me
    u = models.User(id=1, google_sub="x", email="legacy@x.com", name="Legacy", role="member")
    # title, phone, gmail_* all left at SQLAlchemy default (None)
    out = await me(user=u)
    _check("title coerces to empty string when NULL", out["title"] == "")
    _check("phone coerces to empty string when NULL", out["phone"] == "")
    _check("gmailConnected False when refresh token NULL", out["gmailConnected"] is False)
    _check("gmailScope 'none' when granted_scopes NULL", out["gmailScope"] == "none")


def main() -> int:
    test_crypto_roundtrip()
    test_crypto_missing_key_raises()
    test_persist_full_payload()
    test_persist_no_refresh_preserves_old()
    test_persist_expires_at_epoch()
    test_persist_expires_at_independent_of_access_token()
    test_persist_bad_expires_in_logged()
    test_has_gmail_send_scope()
    test_client_ip_railway_default()
    asyncio.run(test_auth_me_shape())
    asyncio.run(test_auth_me_null_safe_for_pre_feature_users())

    fail_count = sum(1 for _, ok in _results if not ok)
    print()
    print(f"== {len(_results) - fail_count}/{len(_results)} checks passed ==")
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
