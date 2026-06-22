"""Re-encrypt all stored OAuth tokens under the current primary encryption key.

Use this to ROTATE LTP_TOKEN_ENCRYPTION_KEY without losing access (and to
recover after a key change). The crypto layer uses MultiFernet: the FIRST key
in the comma-separated list encrypts, ANY listed key decrypts.

Rotation procedure
==================
  1. Generate a new key:
       python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
  2. Deploy with both keys, NEW first:
       LTP_TOKEN_ENCRYPTION_KEY="<NEW>,<OLD>"
  3. Run this script (it decrypts each token with the keyring and re-encrypts
     under <NEW>):
       python -m backend.rotate_encryption_key
  4. When it reports success, redeploy with only the new key and retire <OLD>:
       LTP_TOKEN_ENCRYPTION_KEY="<NEW>"

This directly supports the C2 remediation (rotating the key after the
committed-token exposure) and removes the operational blocker M3 noted (no
re-encryption tooling). Idempotent and safe to re-run. Tokens that can't be
decrypted under the current keyring are reported and skipped — add the missing
key to the comma list and re-run. Exit code is non-zero if anything was skipped.
"""
import asyncio

from sqlalchemy import select

from backend import crypto, models
from backend.crypto import InvalidToken
from backend.database import async_session


_USER_TOKEN_COLS = ("gmail_refresh_token", "gmail_access_token")
_QBO_TOKEN_COLS = ("access_token_enc", "refresh_token_enc")


def _reencrypt(value):
    """Decrypt then re-encrypt under the current primary key. Returns the new
    ciphertext, or None for an empty value. Raises InvalidToken when the value
    can't be decrypted under the current keyring."""
    if not value:
        return None
    return crypto.encrypt_token(crypto.decrypt_token(value))


async def rotate() -> int:
    rotated = skipped = 0
    async with async_session() as db:
        users = (await db.execute(select(models.User))).scalars().all()
        for u in users:
            for col in _USER_TOKEN_COLS:
                val = getattr(u, col, None)
                if not val:
                    continue
                try:
                    setattr(u, col, _reencrypt(val))
                    rotated += 1
                except InvalidToken:
                    print(f"[rotate] SKIP user id={u.id} {col}: undecryptable under current keyring")
                    skipped += 1

        conn = (
            await db.execute(select(models.QboConnection).where(models.QboConnection.id == 1))
        ).scalar_one_or_none()
        if conn is not None:
            for col in _QBO_TOKEN_COLS:
                val = getattr(conn, col, None)
                if not val:
                    continue
                try:
                    setattr(conn, col, _reencrypt(val))
                    rotated += 1
                except InvalidToken:
                    print(f"[rotate] SKIP qbo_connection {col}: undecryptable under current keyring")
                    skipped += 1

        await db.commit()
    print(f"[rotate] done: {rotated} token(s) re-encrypted, {skipped} skipped")
    return 1 if skipped else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(rotate()))
