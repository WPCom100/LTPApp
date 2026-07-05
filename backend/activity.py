"""Shared activity-log append for entity JSON ``activity`` arrays.

Every route/sync path that records an activity entry (PDF generated, email
sent/failed, client viewed/accepted/declined, QuickBooks sync) builds the same
id/date/time/type/user/userId/message scaffold, appends it to the entity's
``activity`` list, and flags the JSON column modified so SQLAlchemy persists
the in-place mutation. This centralizes that scaffold.

Lives at the ``backend`` package root (not under ``routes/``) so both the
route modules and the core ``qbo_sync`` engine can import it without a
layering inversion.
"""
import secrets

from sqlalchemy.orm.attributes import flag_modified


def append_activity(entity, *, id_prefix, type_, user, message, now,
                    user_id=None, attr="activity", **extra):
    """Append a standardized activity entry to ``entity.<attr>`` and mark the
    JSON column modified. Returns the entry dict; the caller commits/flushes.

    ``now`` is the timestamp source — the caller passes it so UTC-vs-local
    behavior is preserved per call site (date/time are formatted from it).
    Extra entry fields (changes, recipients, pdfToken, comment, ip, ...) are
    passed as kwargs and placed after ``message``.
    """
    entry = {
        "id": id_prefix + secrets.token_urlsafe(6),
        "date": now.strftime("%Y-%m-%d"),
        "time": now.strftime("%H:%M"),
        "type": type_,
        "user": user,
        "userId": user_id,
        "message": message,
        **extra,
    }
    current = list(getattr(entity, attr) or [])
    current.append(entry)
    setattr(entity, attr, current)
    flag_modified(entity, attr)
    return entry
