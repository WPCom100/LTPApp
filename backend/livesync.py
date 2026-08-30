"""Live-sync change feed — tells every open window WHAT changed, never the data.

The problem this solves
=======================
components/data-state.js fetched /api/{key} exactly once, on mount, and after
that only ever pushed writes outward. Nothing ever came back in. Two windows on
the same workspace therefore drifted apart the moment either one wrote, and a
window could stay wrong indefinitely — only a hard refresh fixed it.

That is not merely cosmetic. Crew accept/decline is a SERVER-side write to
`Project.schedule[].positions[].status` (backend/routes/crew.py::_respond), so a
window holding the pre-accept project row would:
  - render the crew request with no project to resolve, so the Crew Requests tab
    showed the literal string "Project" and hid the Confirm button, and
  - PUT its stale row back on the next unrelated edit, reverting the crew
    member's acceptance. (backend/crew_integrity.py::enforce_status_floor is the
    scar tissue from exactly that.)

The design: stamps, not payloads
================================
The server never pushes row data over the live channel. It pushes a small map of
per-collection STAMPS:

    {"projects": "1756...:42:7", "contacts": "1756...:118:3", ...}

A client compares the map against its own and refetches ONLY the collections
whose stamp moved. Bandwidth on the live channel is therefore independent of how
much data the workspace holds — an idle connection costs a keepalive comment
every KEEPALIVE_SECONDS and nothing else.

Stamp format: "{max_updated_at_epoch_micros}:{row_count}:{seq}"

  max(updated_at)  every synced table carries `updated_at` with
                   onupdate=func.now(), so any row write moves it.
  count(*)         deletes are HARD deletes with no tombstone table, so
                   max(updated_at) alone would NOT move when a row is removed.
                   The count catches that.
  seq              an in-process counter, incremented whenever we recompute a
                   collection whose (max, count) pair did not move. SQLite's
                   CURRENT_TIMESTAMP is second-resolution, so two writes to one
                   row inside the same second produce an identical (max, count).
                   Postgres (production) is microsecond-resolution and rarely
                   needs this, but the tests run on SQLite and correctness
                   should not depend on which driver is underneath.

`seq` resets to 0 on restart, so every connected window refetches once after a
deploy. That is deliberate — a deploy is exactly when a forced revalidation is
worth its cost.

Fan-out is in-process
=====================
`railway.json` starts ONE uvicorn process with no --workers, and the app is
explicitly single-pod/single-tenant (see backend/rate_limit.py's module
docstring). A plain set of asyncio queues is therefore a complete and correct
broadcast bus — no Redis, no external message broker.

IF THAT EVER CHANGES — more than one worker or more than one pod — this module
silently becomes wrong: a write served by worker A would never reach a window
subscribed to worker B. The safety sweep below limits the damage (every window
still converges within SWEEP_SECONDS because the sweep reads the DB, which IS
shared), but the push would effectively degrade to slow polling. Swap
_broadcast() for a real bus at that point.

Who publishes
=============
  - Request-scoped writes mark their session dirty via mark_dirty() and are
    published by backend/database.py::get_db AFTER the commit lands. Publishing
    before the commit would be a lost-update bug: a window told "projects
    changed" could refetch on another connection, read the pre-commit rows, and
    then never refetch again because it had already stored the new stamp.
  - Background writers that bypass get_db (backend/qbo_sync.py,
    qbo_bill_poll.py, qbo_receipts.py all open their own async_session) do not
    mark anything dirty. The safety sweep is what surfaces their writes; it
    recomputes the full map every SWEEP_SECONDS and broadcasts if anything
    moved. One shared task, so the cost is O(1) in connected windows.
"""
import asyncio
import json
import os
import time

from sqlalchemy import func, select

# Collection name → attribute name on backend.models.
#
# The KEY is the wire name the frontend uses, which for entity collections is
# also the /api/{key} URL segment (components/data-state.js derives the URL from
# the state key verbatim), so "client-rates" is hyphenated here to match.
#
# `settings` is the singleton blob and `crew-requests` is read by the Labor tab
# through its own endpoint — neither is an ENTITY_KEYS collection on the client,
# but both change under a window's feet and both belong in the feed.
_COLLECTION_MODELS = {
    "companies":     "Company",
    "contacts":      "Contact",
    "projects":      "Project",
    "quotes":        "Quote",
    "invoices":      "Invoice",
    "equipment":     "Equipment",
    "products":      "Product",
    "services":      "Service",
    "fees":          "Fee",
    "client-rates":  "ClientRate",
    "allocations":   "Allocation",
    "containers":    "Container",
    "kits":          "Kit",
    "settings":      "Settings",
    "crew-requests": "CrewRequest",
}

COLLECTIONS = tuple(_COLLECTION_MODELS)

# Session-scoped key under which a request's dirty collections are parked.
# Lives in Session.info (a plain dict SQLAlchemy hands us for exactly this) so
# concurrent requests can never see each other's pending set — a global set
# would let request B publish request A's collections before A had committed,
# reintroducing the lost-update race described above.
_DIRTY_KEY = "ltp_livesync_dirty"

# How long an idle SSE connection waits before emitting a keepalive comment.
# Proxies and load balancers commonly cut idle connections at 60s; 25s stays
# comfortably under that with room for one missed tick.
KEEPALIVE_SECONDS = 25

# How often the shared background task re-reads every collection's stamp from
# the database. This is the backstop for writers that bypass get_db and for the
# multi-worker degradation described above — not the primary path, so it can be
# slow and cheap.
SWEEP_SECONDS = 30

# How long one stream may stay open before the server recycles it. Auth is
# checked when the connection OPENS and never again, so without this a stream
# opened by a session that later expires (or is revoked) would keep receiving
# for as long as the tab lived. Recycling bounds that to one window: the client
# reconnects and re-authenticates.
#
# Nothing is lost across a recycle — the reconnect opens with a full snapshot,
# and the client compares it against what it holds. Note the server ends these
# with a `bye` frame so the client can tell a scheduled recycle from a failure
# and reconnect immediately instead of backing off.
# Override with LTP_LIVESYNC_MAX_STREAM_SECONDS (an integer, seconds). Mostly
# there so the recycle path can be exercised end to end without waiting half an
# hour; a deployment has no reason to change it.
def _env_seconds(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        print(f"[LTP] livesync: {name}={raw!r} is not an integer; using {default}", flush=True)
        return default
    return value if value > 0 else default


MAX_STREAM_SECONDS = _env_seconds("LTP_LIVESYNC_MAX_STREAM_SECONDS", 30 * 60)

# Bounded per-subscriber queue. Every message carries the FULL stamp map, so a
# queued message is strictly redundant with any newer one and a backlog can
# always be collapsed rather than disconnecting a slow reader.
_QUEUE_MAXSIZE = 8

_subscribers: set[asyncio.Queue] = set()
_stamps: dict[str, str] = {}
_seq = 0


def _models():
    """Import backend.models lazily.

    backend/database.py imports THIS module (get_db publishes after commit) and
    backend/models.py imports backend.database for Base — so a module-level
    `from backend import models` here would close an import cycle. Nothing in
    this module needs models at import time, so defer it.
    """
    from backend import models
    return models


def model_for(collection: str):
    """The SQLAlchemy model backing a collection name, or None if unknown."""
    attr = _COLLECTION_MODELS.get(collection)
    return getattr(_models(), attr) if attr else None


# ── Stamp computation ───────────────────────────────────────────────────────

async def _compute(db, collection: str) -> str:
    """Read one collection's (max(updated_at), count(*)) pair as a stamp body.

    Two aggregates over one table in a single round trip. No row data crosses
    the wire, which is the whole point — this stays cheap no matter how large
    the workspace grows.
    """
    model = model_for(collection)
    if model is None:
        return "0:0"
    row = (await db.execute(
        select(func.max(model.updated_at), func.count(model.id))
    )).one()
    newest, count = row[0], row[1] or 0
    # Postgres hands back an aware datetime, SQLite a naive one. timestamp() is
    # correct for both here: the naive value is UTC (server_default=func.now()
    # under CURRENT_TIMESTAMP) and is only ever compared against itself.
    micros = int(newest.timestamp() * 1_000_000) if newest is not None else 0
    return f"{micros}:{count}"


async def refresh(db, collections=None) -> dict:
    """Recompute the given collections (all of them when None) and return the
    full current stamp map.

    A collection whose (max, count) body is unchanged but which we were
    explicitly asked to refresh gets its `seq` advanced — that is the
    sub-second-resolution guard described in the module docstring. Refreshing
    everything (the sweep) deliberately does NOT advance seq on unchanged
    collections, or every sweep would look like a change to every window.
    """
    global _seq
    targets = tuple(collections) if collections is not None else COLLECTIONS
    explicit = collections is not None
    for name in targets:
        if name not in _COLLECTION_MODELS:
            continue
        body = await _compute(db, name)
        current = _stamps.get(name)
        if current is not None and current.rsplit(":", 1)[0] == body:
            if not explicit:
                continue          # sweep found no movement — leave the stamp alone
            _seq += 1             # asked to bump but the body didn't move
        _stamps[name] = f"{body}:{_seq}"
    return dict(_stamps)


async def ensure_seeded(db) -> dict:
    """Populate any collection we have not stamped yet, then return the map.

    Called by GET /api/versions and when an SSE connection opens, so the first
    reader after a cold start pays the seeding cost once rather than every
    window guessing at an empty map.
    """
    missing = [name for name in COLLECTIONS if name not in _stamps]
    if missing:
        await refresh(db, missing)
    return dict(_stamps)


def current_map() -> dict:
    """The cached stamp map without touching the database."""
    return dict(_stamps)


# ── Marking writes ──────────────────────────────────────────────────────────

def mark_dirty(db, *collections) -> None:
    """Record that this request WROTE to `collections`.

    Deliberately synchronous and DB-free: it runs inside the route, while the
    transaction is still open. The stamp recompute and the broadcast happen in
    backend/database.py::get_db once the commit has landed.

    Call this only when a write actually happened. An explicitly-marked
    collection whose (max, count) body has not moved still gets its `seq`
    advanced — that is the sub-second-resolution guard, and it means a handler
    that marks itself dirty on a read path publishes a phantom change. On a GET
    that is a refetch LOOP: every window refetches, each refetch republishes.
    Read paths that heal data (backend/routes/crew.py) therefore mark dirty only
    when the heal reports it changed something.
    """
    if db is None:
        return
    pending = db.info.setdefault(_DIRTY_KEY, set())
    for name in collections:
        if name in _COLLECTION_MODELS:
            pending.add(name)


def take_dirty(db) -> set:
    """Remove and return this session's pending collections."""
    if db is None:
        return set()
    return db.info.pop(_DIRTY_KEY, set()) or set()


async def flush(db) -> None:
    """Publish whatever this session marked dirty. Call ONLY after commit.

    Best-effort by contract: the write already succeeded and the client already
    has its response, so a failure here must never turn a good write into an
    error. The worst case is a missed push, and the safety sweep picks it up
    within SWEEP_SECONDS.
    """
    pending = take_dirty(db)
    if not pending:
        return
    try:
        payload = await refresh(db, pending)
    except Exception as e:                                    # noqa: BLE001
        print(f"[LTP] livesync: stamp refresh failed for {sorted(pending)}: {e}", flush=True)
        return
    _broadcast(payload)


# ── Subscriber fan-out ──────────────────────────────────────────────────────

def subscribe() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)
    _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    _subscribers.discard(q)


def subscriber_count() -> int:
    return len(_subscribers)


def _broadcast(payload: dict) -> None:
    for q in list(_subscribers):
        try:
            q.put_nowait(payload)
        except asyncio.QueueFull:
            # Collapse the backlog rather than drop the subscriber: the newest
            # map supersedes every queued one.
            try:
                while True:
                    q.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:      # pragma: no cover — drained above
                pass


# ── Safety sweep ────────────────────────────────────────────────────────────

async def sweep_once(db) -> bool:
    """Recompute every collection; broadcast and return True if any moved."""
    before = dict(_stamps)
    after = await refresh(db, None)
    if after != before:
        _broadcast(after)
        return True
    return False


async def sweeper(session_factory, interval: float = SWEEP_SECONDS) -> None:
    """Background task: catch writes that never went through get_db.

    One task for the whole process, started from the FastAPI lifespan, so the
    cost does not scale with the number of connected windows. Errors are logged
    and swallowed — a transient DB hiccup must not kill the loop, because
    nothing would restart it short of a redeploy.
    """
    while True:
        try:
            await asyncio.sleep(interval)
            # Nobody connected — nobody to broadcast to. Skipping keeps an idle
            # deployment genuinely idle (this is a small internal tool; it sits
            # unused most nights and weekends) instead of running fifteen
            # aggregates a minute against the database forever.
            if not _subscribers:
                continue
            async with session_factory() as db:
                await sweep_once(db)
        except asyncio.CancelledError:
            raise
        except Exception as e:                                # noqa: BLE001
            print(f"[LTP] livesync: sweep failed: {e}", flush=True)


# ── SSE event stream ────────────────────────────────────────────────────────

async def event_stream(initial: dict):
    """Yield an SSE body: an immediate snapshot, then stamp maps as they change.

    The snapshot matters — a window that connects mid-session must be able to
    reconcile without a separate /api/versions round trip.

    A keepalive comment goes out every KEEPALIVE_SECONDS of silence. Comments
    are the cheapest legal SSE frame (":\\n\\n"), which is what keeps an idle
    connection's cost down around single-digit KB/hour.
    """
    q = subscribe()
    deadline = time.monotonic() + MAX_STREAM_SECONDS
    try:
        yield _frame("sync", {"stamps": initial, "at": now_ms()})
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                # Scheduled recycle. The explicit frame is what stops the client
                # counting this as a failure and backing off — see
                # components/live-sync.js.
                yield _frame("bye", {"reason": "recycle"})
                return
            try:
                payload = await asyncio.wait_for(
                    q.get(), timeout=min(KEEPALIVE_SECONDS, remaining))
            except asyncio.TimeoutError:
                # Either an idle keepalive or the deadline — the loop top sorts
                # out which on the next pass.
                if deadline - time.monotonic() > 0:
                    yield ": keepalive\n\n"
                continue
            # Collapse anything that queued up behind it — the newest map wins.
            while not q.empty():
                payload = q.get_nowait()
            yield _frame("sync", {"stamps": payload, "at": now_ms()})
    except asyncio.CancelledError:
        raise
    finally:
        unsubscribe(q)


def _frame(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


def now_ms() -> int:
    return int(time.time() * 1000)


def _reset_for_tests() -> None:
    """Drop all cached state. Test-only — production has no reason to call it."""
    global _seq
    _stamps.clear()
    _subscribers.clear()
    _seq = 0
