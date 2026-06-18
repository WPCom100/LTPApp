"""Token-at-rest encryption.

Why Fernet
==========
We store Google OAuth refresh tokens (and short-lived access tokens) in the
`users` table so the backend can mint Gmail send requests on behalf of the
signed-in user without re-prompting. A refresh token, once leaked, lets an
attacker impersonate the user toward Google for as long as the user doesn't
manually revoke at myaccount.google.com — practically forever for most
users. The threat we're guarding against here is *database disclosure*: a
backup theft, an accidental `SELECT *` in a log, an admin with read access
to the DB but no app shell. Fernet (AES-128-CBC + HMAC-SHA256) is the right
weight: symmetric, fast, no key-management ceremony beyond one env var.

This is NOT a defense against attackers who pwn the running backend — they
have the key in process memory. For that threat we'd need an HSM/KMS, which
is overkill for a single-tenant business tool.

Key handling
============
The key lives in env var `LTP_TOKEN_ENCRYPTION_KEY`, a 32-byte url-safe-
base64 string (generate via `python -c "from cryptography.fernet import
Fernet; print(Fernet.generate_key().decode())"`). We fail-fast at import
time if the var is missing — better a loud startup error than silently
encrypting against a default key that ships unchanged to production.

Key rotation
============
Fernet supports multi-key rotation natively via MultiFernet: deploy the new
key alongside the old (comma-separated, new first), let token refreshes
gradually re-encrypt rows under the new key, then retire the old key in a
follow-up deploy. v1 just supports a single key — the comma-split is
forward-compatible but unused.
"""
import os

from cryptography.fernet import Fernet, InvalidToken, MultiFernet


_ENV_KEY = "LTP_TOKEN_ENCRYPTION_KEY"


def _load_fernet() -> MultiFernet:
    raw = os.environ.get(_ENV_KEY, "").strip()
    if not raw:
        raise RuntimeError(
            f"{_ENV_KEY} is not set. Generate one with:\n"
            f'  python -c "from cryptography.fernet import Fernet; '
            f'print(Fernet.generate_key().decode())"\n'
            f"Then add it to the environment (Railway Variables tab for prod, "
            f"a local .env or shell export for dev)."
        )
    # Comma-separated keys → MultiFernet. First key encrypts new values; any
    # listed key can decrypt. Trim whitespace per key for forgiving formatting.
    keys = [Fernet(k.strip().encode("ascii")) for k in raw.split(",") if k.strip()]
    if not keys:
        raise RuntimeError(f"{_ENV_KEY} parsed to zero usable keys")
    return MultiFernet(keys)


# Lazy: the key is loaded on first encrypt/decrypt, NOT at import time.
# That's deliberate — modules that import crypto for type/symbol reasons
# (e.g. tests stubbing out behavior) shouldn't blow up just because no key
# is configured. The first real use happens in the OAuth callback, where a
# RuntimeError surfaces as a 500 with a clear log line.
_fernet: MultiFernet | None = None


def _get() -> MultiFernet:
    global _fernet
    if _fernet is None:
        _fernet = _load_fernet()
    return _fernet


def encrypt_token(plaintext: str) -> str:
    """Encrypt a token and return base64url ciphertext (the Fernet token
    format). Safe to round-trip through a Text column."""
    if plaintext is None:
        raise ValueError("encrypt_token does not accept None — caller must guard")
    return _get().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_token(ciphertext: str) -> str:
    """Decrypt a previously-encrypted token. Raises InvalidToken on:
      - tampered ciphertext
      - ciphertext encrypted under a key not in the current keyring
    Callers should treat InvalidToken as "the stored token is unusable;
    clear it and force the user to reconnect."""
    if ciphertext is None:
        raise ValueError("decrypt_token does not accept None — caller must guard")
    return _get().decrypt(ciphertext.encode("ascii")).decode("utf-8")


# Re-export for callers' exception handling
__all__ = ("encrypt_token", "decrypt_token", "InvalidToken")
