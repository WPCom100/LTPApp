"""Credentials for the crew portal — password hashing, one-time tokens, policy.

The crew portal is the crew member's OWN sign-in (email + password) to the
dashboard at #/crew-portal: their upcoming calls, the requests waiting on
them, and what they are owed. It is deliberately a separate credential system
from the staff app:

  - Staff sign in with Google (backend/routes/auth.py) and carry the
    `ltp_session` cookie, which is what every /api/* route checks.
  - Crew sign in here with a password and carry `ltp_crew_session`, which is
    checked ONLY by backend/routes/crew_portal.py. A crew session can never
    reach a staff route and a staff session never reaches the portal — the
    two cookies are read by different dependencies against different tables.

Passwords
=========
scrypt from the standard library (OpenSSL-backed, Python 3.6+), so no new
dependency. Parameters n=2^14, r=8, p=1, 32-byte key, 16-byte random salt —
the OWASP floor for scrypt. The stored string is self-describing
(`scrypt$<n>$<r>$<p>$<salt>$<key>`), so the cost can be raised later and old
hashes still verify (and get re-hashed on the next successful login, see
`needs_rehash`). Verification is constant-time (hmac.compare_digest).

One-time tokens
===============
Invitations and password resets travel as `secrets.token_urlsafe(32)` links.
Like the session tokens (backend/auth_deps.py), only the SHA-256 of a token is
stored, so a database read yields nothing a link could be rebuilt from. Each
token is single-use and expires (invites in 7 days, resets in 1 hour).
"""
import base64
import hashlib
import hmac
import secrets
from datetime import timedelta

# scrypt cost. 2^14 × 8 × 128 = 16 MiB of memory per hash, ~40-60 ms on a
# small pod — slow enough to blunt offline guessing, fast enough that a sign-in
# never feels laggy. OpenSSL's default maxmem (32 MiB) comfortably covers it.
SCRYPT_N = 2 ** 14
SCRYPT_R = 8
SCRYPT_P = 1
_DKLEN = 32
_SALT_BYTES = 16

# Password policy. A length floor is the one rule that measurably helps; the
# rest (character classes, rotation) mostly produces "Summer2026!" and sticky
# notes. 128 caps the scrypt input so a 10 MB "password" can't pin the CPU.
PASSWORD_MIN = 8
PASSWORD_MAX = 128

INVITE_LIFETIME = timedelta(days=7)
RESET_LIFETIME = timedelta(hours=1)

# Failed-login lockout: after this many wrong passwords in a row the account
# refuses sign-in for LOCKOUT_MINUTES. Per-account, on top of the per-IP rate
# limit in backend/rate_limit.py — the two cover different attackers (one IP
# hammering many accounts vs. many IPs hammering one account).
LOCKOUT_ATTEMPTS = 10
LOCKOUT_MINUTES = 15


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def hash_password(password: str) -> str:
    """scrypt-hash a password with a fresh random salt. Self-describing output."""
    if not isinstance(password, str):
        raise TypeError("password must be a string")
    salt = secrets.token_bytes(_SALT_BYTES)
    key = hashlib.scrypt(password.encode("utf-8"), salt=salt,
                         n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=_DKLEN)
    return "scrypt$%d$%d$%d$%s$%s" % (SCRYPT_N, SCRYPT_R, SCRYPT_P, _b64(salt), _b64(key))


def _parse(stored: str):
    """(n, r, p, salt, key) out of a stored hash, or None when malformed."""
    try:
        algo, n, r, p, salt, key = (stored or "").split("$")
        if algo != "scrypt":
            return None
        return int(n), int(r), int(p), _unb64(salt), _unb64(key)
    except (ValueError, TypeError):
        return None


def verify_password(password: str, stored: str) -> bool:
    """Constant-time check of `password` against a stored hash. A malformed or
    empty stored value (an account that never set a password) never verifies."""
    parsed = _parse(stored)
    if parsed is None or not isinstance(password, str):
        return False
    n, r, p, salt, key = parsed
    if len(password) > PASSWORD_MAX:
        return False
    try:
        cand = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=len(key))
    except (ValueError, MemoryError):
        return False
    return hmac.compare_digest(cand, key)


def needs_rehash(stored: str) -> bool:
    """True when a hash was made with weaker parameters than the current ones
    (or is malformed). The login path re-hashes on the next success."""
    parsed = _parse(stored)
    if parsed is None:
        return True
    n, r, p, _salt, key = parsed
    return (n, r, p) != (SCRYPT_N, SCRYPT_R, SCRYPT_P) or len(key) != _DKLEN


def password_problem(password, email: str = "") -> str | None:
    """Why a candidate password is unacceptable, or None when it is fine.
    The message is crew-facing — it comes back on the form."""
    if not isinstance(password, str):
        return "Enter a password."
    if len(password) < PASSWORD_MIN:
        return "Use at least %d characters." % PASSWORD_MIN
    if len(password) > PASSWORD_MAX:
        return "Use at most %d characters." % PASSWORD_MAX
    if not password.strip():
        return "A password can't be only spaces."
    if email and password.strip().lower() == email.strip().lower():
        return "Your password can't be your email address."
    return None


def mint_token() -> tuple[str, str]:
    """(raw, sha256-hex). The raw token goes in the link, only the hash is stored."""
    raw = secrets.token_urlsafe(32)
    return raw, hash_token(raw)


def hash_token(raw: str) -> str:
    """SHA-256 hex of a raw link/session token — what the tables index."""
    return hashlib.sha256((raw or "").encode("utf-8")).hexdigest()


def normalize_email(email) -> str:
    """Lower-cased, trimmed login identity. '' for anything not a string."""
    return (email or "").strip().lower() if isinstance(email, str) else ""
