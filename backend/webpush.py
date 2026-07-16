"""Web Push (iOS 16.4+ home-screen PWA notifications).

VAPID-signed, aes128gcm-encrypted pushes to each subscribed browser's push
service. Config lives in three env vars (Railway Variables for prod, a shell
export / local .env for dev):

  LTP_VAPID_PUBLIC_KEY   base64url uncompressed EC P-256 point (~87 chars).
                         Handed to the browser as applicationServerKey.
  LTP_VAPID_PRIVATE_KEY  base64url raw 32-byte scalar. Signs the send-time JWT.
  LTP_VAPID_SUBJECT      "mailto:you@example.com" — contact for the push service.

Generate a keypair once (see the README / py_vapid). Push is OPTIONAL: if the
vars are unset the app still boots, sends become no-ops, and the Settings
"Notifications" toggle reports "not configured". This is the graceful-degrade
posture of the Gmail path — NOT the fail-fast posture of crypto.py, where token
encryption is mandatory. Notifications are a convenience, not a security
control, so a missing key must never take the app down.
"""
import asyncio
import json
import os

from sqlalchemy import delete, select

from backend import models

_PUB = "LTP_VAPID_PUBLIC_KEY"
_PRIV = "LTP_VAPID_PRIVATE_KEY"
_SUBJ = "LTP_VAPID_SUBJECT"

# Stay clear of the push protocol's ~4 KB payload ceiling.
_MAX_PAYLOAD_BYTES = 3800
# Ask the push service to hold an undelivered message for a day, then drop it.
_TTL_SECONDS = 60 * 60 * 24


def public_key() -> str:
    """The VAPID public key the browser needs as applicationServerKey ('' if unset)."""
    return os.environ.get(_PUB, "").strip()


def is_configured() -> bool:
    """True only when all three VAPID vars are present — the gate every send
    and the subscribe UI check first."""
    return bool(
        public_key()
        and os.environ.get(_PRIV, "").strip()
        and os.environ.get(_SUBJ, "").strip()
    )


def _send_one(sub_info: dict, payload: str) -> None:
    """Blocking pywebpush call — runs in a worker thread (see send_to_user).
    Raises WebPushException on a push-service error (e.g. 404/410 dead endpoint)."""
    from pywebpush import webpush

    webpush(
        subscription_info=sub_info,
        data=payload,
        vapid_private_key=os.environ[_PRIV].strip(),
        vapid_claims={"sub": os.environ[_SUBJ].strip()},
        ttl=_TTL_SECONDS,
    )


async def send_to_user(db, user_id, title: str, body: str, url: str = "/#/dashboard") -> int:
    """Push (title, body, url) to every device the given INTERNAL user has
    subscribed. Best-effort: prunes dead subscriptions on 404/410 and swallows
    every other error so a failed push never breaks the request that triggered
    it. Returns how many pushes were accepted by a push service.

    `db` is the caller's live AsyncSession — the delete rides its transaction,
    committed by get_db alongside the triggering write."""
    if not user_id or not is_configured():
        return 0

    from pywebpush import WebPushException

    rows = (
        await db.execute(
            select(models.PushSubscription).where(
                models.PushSubscription.user_id == user_id
            )
        )
    ).scalars().all()
    if not rows:
        return 0

    payload = json.dumps({"title": title, "body": body, "url": url})
    if len(payload.encode("utf-8")) > _MAX_PAYLOAD_BYTES:
        payload = json.dumps({"title": title, "body": (body or "")[:180], "url": url})

    sent = 0
    dead = []
    for s in rows:
        info = {"endpoint": s.endpoint, "keys": {"p256dh": s.p256dh, "auth": s.auth}}
        try:
            await asyncio.to_thread(_send_one, info, payload)
            sent += 1
        except WebPushException as e:
            code = getattr(getattr(e, "response", None), "status_code", None)
            if code in (404, 410):
                dead.append(s.endpoint)  # subscription is gone — prune it
            else:
                print(f"[LTP] webpush: send failed ({code}) for sub {s.id}: {e}", flush=True)
        except Exception as e:  # never let a push break the caller
            print(f"[LTP] webpush: unexpected send error for sub {s.id}: {e}", flush=True)

    if dead:
        await db.execute(
            delete(models.PushSubscription).where(
                models.PushSubscription.endpoint.in_(dead)
            )
        )
        print(f"[LTP] webpush: pruned {len(dead)} dead subscription(s)", flush=True)

    return sent
