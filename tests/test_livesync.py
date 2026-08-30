"""Live sync — change stamps, the SSE feed, and the stale-write guard.

Covers backend/livesync.py plus the three surfaces it drives:

  GET /api/versions      per-collection stamps; session-gated
  GET /api/stream        SSE snapshot + headers; session-gated
  PUT /api/{path}/{id}   If-Match optimistic concurrency

The load-bearing test is test_stale_put_after_crew_accept_is_rejected: it
reproduces the original report end to end — a producer window loads a project,
a crew member accepts from the public link, and the window then PUTs its stale
row back. Before If-Match that silently reverted the acceptance.

Under pytest this module shares the session-wide DB from tests/conftest.py; run
as a plain script it uses its own DATABASE_URL (the setdefault below).
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_livesync.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

_db_path = os.path.join(_root, "_test_livesync.db")
if os.environ["DATABASE_URL"].endswith("_test_livesync.db") and os.path.exists(_db_path):
    os.remove(_db_path)

from backend import livesync, models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402


# Fixture ids, kept clear of the other modules' ranges (they share one DB
# under a combined pytest run).
U_ADMIN_SUB = "livesync-admin-sub"
_ADMIN_TOK = "livesync-admin-session"

C_CREW = 9401          # crew member with an email
S_ROLE = 8401          # service
P_STAMP = 7401         # stamp movement on write
P_REV = 7402           # If-Match happy path / stale path
P_ACCEPT = 7403        # the crew-accept stale-write reproduction
P_DEL = 7404           # delete moves the stamp via count(*)
CO_GZIP = 6401         # company used for the gzip payload check

_client = None
_seeded = False


def _setup():
    global _client, _seeded
    if _client is None:
        from fastapi.testclient import TestClient
        from backend.main import app
        _client = TestClient(app)
        _client.__enter__()

    if not _seeded:
        from backend.database import async_session

        def _pos(pid, crew, status="open", service=None, role=""):
            return {"id": pid, "role": role, "serviceId": service, "crewId": crew, "status": status}

        def _shift(sid, title, date, positions):
            return {"id": sid, "title": title, "date": date, "time": "09:00",
                    "endTime": "17:00", "positions": positions}

        async def seed():
            async with async_session() as db:
                admin = models.User(google_sub=U_ADMIN_SUB, email="livesync-admin@biz.com",
                                    name="Livesync Admin", role="admin")
                db.add(admin)
                await db.flush()
                db.add(models.Session(id=hash_session_token(_ADMIN_TOK), user_id=admin.id,
                                      expires_at=datetime.now(timezone.utc) + timedelta(days=7)))
                db.add(models.Contact(id=C_CREW, first_name="Sync", last_name="Crew",
                                      email="sync@crew.com", is_crew=True, crew_status="active"))
                db.add(models.Service(id=S_ROLE, role="A1", description="Audio Lead",
                                      department="Audio"))
                db.add(models.Project(id=P_STAMP, name="Stamp Project", schedule=[]))
                db.add(models.Project(id=P_REV, name="Rev Project", schedule=[]))
                # The manual-shift shape from the original report: one shift,
                # two roles, both penciled to the same crew member.
                db.add(models.Project(id=P_ACCEPT, name="Warehouse Load", schedule=[
                    _shift("acc_s1", "Warehouse", "2026-09-14",
                           [_pos("acc_p1", C_CREW, service=S_ROLE),
                            _pos("acc_p2", C_CREW, service=S_ROLE)]),
                ]))
                db.add(models.Project(id=P_DEL, name="Delete Me", schedule=[]))
                await db.commit()

        _run(seed())
        _seeded = True

    return _client, _ADMIN_TOK


def _run(coro):
    """Run an async helper on a private loop (the TestClient owns its own)."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _teardown():
    global _client
    if _client is not None:
        _client.__exit__(None, None, None)
        _client = None


def _stamps(client, tok):
    r = client.get("/api/versions", cookies={"ltp_session": tok})
    assert r.status_code == 200, r.text
    return r.json()["stamps"]


# ── /api/versions ───────────────────────────────────────────────────────────

def test_versions_requires_a_session():
    client, _ = _setup()
    r = client.get("/api/versions")
    assert r.status_code == 401, f"expected 401 without a session, got {r.status_code}"


def test_versions_covers_every_synced_collection():
    client, tok = _setup()
    stamps = _stamps(client, tok)
    missing = [c for c in livesync.COLLECTIONS if c not in stamps]
    assert not missing, f"collections absent from /api/versions: {missing}"
    # The client keys its state off these names verbatim, so the two that are
    # easy to get wrong are worth pinning explicitly.
    assert "client-rates" in stamps, "hyphenated key must match the frontend state key"
    assert "crew-requests" in stamps, "the Labor tab needs crew-requests in the feed"


def test_versions_is_stable_when_nothing_changes():
    client, tok = _setup()
    first = _stamps(client, tok)
    second = _stamps(client, tok)
    assert first == second, "a read must never move a stamp — that would be a refetch loop"


def test_write_moves_only_its_own_collection_stamp():
    client, tok = _setup()
    before = _stamps(client, tok)
    r = client.put(f"/api/projects/{P_STAMP}",
                   json={"id": P_STAMP, "name": "Stamp Project Renamed"},
                   cookies={"ltp_session": tok})
    assert r.status_code == 200, r.text
    after = _stamps(client, tok)
    assert after["projects"] != before["projects"], "a project write must move the projects stamp"
    for other in ("contacts", "quotes", "invoices", "equipment", "services"):
        assert after[other] == before[other], f"{other} moved on a project-only write"


def test_delete_moves_the_stamp_even_though_updated_at_cannot():
    """Hard deletes leave no tombstone, so max(updated_at) does not move.
    The count(*) half of the stamp is what catches them."""
    client, tok = _setup()
    before = _stamps(client, tok)
    r = client.delete(f"/api/projects/{P_DEL}", cookies={"ltp_session": tok})
    assert r.status_code == 200, r.text
    after = _stamps(client, tok)
    assert after["projects"] != before["projects"], "a delete must move the projects stamp"


# ── _rev / If-Match ─────────────────────────────────────────────────────────

def test_rows_carry_a_rev_on_every_read_and_write():
    client, tok = _setup()
    got = client.get(f"/api/projects/{P_REV}", cookies={"ltp_session": tok}).json()
    assert got.get("_rev"), "GET one must carry _rev"
    listed = client.get("/api/projects", cookies={"ltp_session": tok}).json()
    row = next(p for p in listed if p["id"] == P_REV)
    assert row["_rev"] == got["_rev"], "GET all and GET one must agree on _rev"
    put = client.put(f"/api/projects/{P_REV}", json={"id": P_REV, "name": "Rev Project v2"},
                     cookies={"ltp_session": tok}).json()
    assert put.get("_rev"), "PUT must return the new _rev"
    assert put["_rev"] != got["_rev"], "_rev must move when the row changes"


def test_put_with_a_current_if_match_succeeds():
    client, tok = _setup()
    row = client.get(f"/api/projects/{P_REV}", cookies={"ltp_session": tok}).json()
    r = client.put(f"/api/projects/{P_REV}", json={"id": P_REV, "name": "Fresh Write"},
                   headers={"If-Match": row["_rev"]}, cookies={"ltp_session": tok})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Fresh Write"


def test_put_with_a_stale_if_match_is_rejected_and_returns_the_current_row():
    client, tok = _setup()
    stale = client.get(f"/api/projects/{P_REV}", cookies={"ltp_session": tok}).json()
    # Someone else writes first.
    client.put(f"/api/projects/{P_REV}", json={"id": P_REV, "name": "Written By Another Window"},
               cookies={"ltp_session": tok})
    r = client.put(f"/api/projects/{P_REV}", json={"id": P_REV, "name": "Stale Overwrite"},
                   headers={"If-Match": stale["_rev"]}, cookies={"ltp_session": tok})
    assert r.status_code == 409, f"expected 409 on a stale If-Match, got {r.status_code}"
    detail = r.json()["detail"]
    assert detail["code"] == "stale_write"
    assert detail["row"]["name"] == "Written By Another Window", \
        "the 409 must carry the CURRENT row so the client can adopt it without a second round trip"
    assert detail["rev"] == detail["row"]["_rev"]
    # And the write must not have landed.
    now = client.get(f"/api/projects/{P_REV}", cookies={"ltp_session": tok}).json()
    assert now["name"] == "Written By Another Window", "a rejected PUT must not mutate the row"


def test_put_without_if_match_keeps_last_write_wins():
    """The header is optional so the two hand-rolled PUT call sites
    (modules/settings.js, modules/invoices.js) keep working untouched."""
    client, tok = _setup()
    client.get(f"/api/projects/{P_REV}", cookies={"ltp_session": tok}).json()
    r = client.put(f"/api/projects/{P_REV}", json={"id": P_REV, "name": "Unguarded Write"},
                   cookies={"ltp_session": tok})
    assert r.status_code == 200, r.text


def test_an_identical_rewrite_is_not_a_conflict():
    """_rev is a CONTENT hash, so a write that changes nothing still matches."""
    client, tok = _setup()
    row = client.get(f"/api/projects/{P_REV}", cookies={"ltp_session": tok}).json()
    body = {k: v for k, v in row.items() if k != "_rev"}
    first = client.put(f"/api/projects/{P_REV}", json=body,
                       headers={"If-Match": row["_rev"]}, cookies={"ltp_session": tok})
    assert first.status_code == 200, first.text
    second = client.put(f"/api/projects/{P_REV}", json=body,
                        headers={"If-Match": row["_rev"]}, cookies={"ltp_session": tok})
    assert second.status_code == 200, \
        "a no-op rewrite leaves the content hash unchanged, so it must not conflict"


# ── The original report, end to end ─────────────────────────────────────────

def test_stale_put_after_crew_accept_is_rejected():
    """The bug this whole change exists for.

    A producer window loads the project. A crew member accepts from the public
    link, which is a SERVER-side write to schedule[].positions[].status. The
    window then saves an unrelated edit, PUTting its pre-accept snapshot. Before
    If-Match that silently reverted the acceptance."""
    client, tok = _setup()

    # 1. The producer window's snapshot, taken before anything is sent.
    snapshot = client.get(f"/api/projects/{P_ACCEPT}", cookies={"ltp_session": tok}).json()

    # 2. Send the crew request, then accept it from the public link.
    sent = client.post("/api/crew-requests/send",
                       json={"projectId": P_ACCEPT, "contactId": C_CREW},
                       cookies={"ltp_session": tok})
    assert sent.status_code == 200, sent.text
    token = sent.json()["token"]
    stamps_before_accept = _stamps(client, tok)

    accepted = client.post(f"/api/crew/{token}/accept", json={"comment": "See you there"})
    assert accepted.status_code == 200, accepted.text

    # 3. The accept must publish BOTH collections — the request AND the project,
    #    because it moved position statuses on the project row. Publishing only
    #    crew-requests is exactly what left the Crew Requests tab unable to
    #    resolve the project (shift name "Project", no Confirm button).
    after_accept = _stamps(client, tok)
    assert after_accept["crew-requests"] != stamps_before_accept["crew-requests"], \
        "accept must move the crew-requests stamp"
    assert after_accept["projects"] != stamps_before_accept["projects"], \
        "accept writes position statuses on the project row — projects must move too"

    live = client.get(f"/api/projects/{P_ACCEPT}", cookies={"ltp_session": tok}).json()
    statuses = [p["status"] for s in live["schedule"] for p in s["positions"]]
    assert statuses == ["accepted", "accepted"], f"expected both accepted, got {statuses}"

    # 4. The stale window saves. Its _rev is from before the accept, so it is
    #    refused rather than clobbering the crew member's answer.
    body = {k: v for k, v in snapshot.items() if k != "_rev"}
    body["venue"] = "Dock B"
    stale = client.put(f"/api/projects/{P_ACCEPT}", json=body,
                       headers={"If-Match": snapshot["_rev"]}, cookies={"ltp_session": tok})
    assert stale.status_code == 409, \
        f"a stale window's PUT must be refused, got {stale.status_code}"

    still = client.get(f"/api/projects/{P_ACCEPT}", cookies={"ltp_session": tok}).json()
    kept = [p["status"] for s in still["schedule"] for p in s["positions"]]
    assert kept == ["accepted", "accepted"], \
        f"the acceptance must survive the stale save, got {kept}"

    # 5. And the 409 hands back the live row, so the window can adopt it and
    #    retry against fresh state.
    fresh = stale.json()["detail"]["row"]
    retry_body = {k: v for k, v in fresh.items() if k != "_rev"}
    retry_body["venue"] = "Dock B"
    retry = client.put(f"/api/projects/{P_ACCEPT}", json=retry_body,
                       headers={"If-Match": fresh["_rev"]}, cookies={"ltp_session": tok})
    assert retry.status_code == 200, retry.text
    assert retry.json()["venue"] == "Dock B", "the retry must land the producer's real edit"
    final = [p["status"] for s in retry.json()["schedule"] for p in s["positions"]]
    assert final == ["accepted", "accepted"], "and must still not disturb the acceptance"


# ── SSE feed ────────────────────────────────────────────────────────────────
#
# These drive the ASGI app directly instead of going through TestClient.
# TestClient BUFFERS: starlette/testclient.py runs the app to completion and
# only then builds the response, so even client.stream() blocks forever on an
# endpoint that never ends. Driving the app by hand is the only way to read a
# live feed's first frames and then hang up — which is what a browser does
# anyway, and it still exercises the real middleware stack (gzip included).

def _drive_stream(cookie=None, max_frames=1, after_first=None):
    """Open GET /api/stream, collect up to `max_frames` body chunks, hang up.

    `after_first` is an optional coroutine function run once the first frame has
    arrived — used to make a write land while the feed is genuinely open.
    Returns (status, headers, frames)."""
    from backend.main import app

    async def body():
        headers = [(b"host", b"testserver"), (b"accept-encoding", b"gzip")]
        if cookie:
            headers.append((b"cookie", f"ltp_session={cookie}".encode()))
        scope = {
            "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1", "method": "GET", "scheme": "http",
            "path": "/api/stream", "raw_path": b"/api/stream", "query_string": b"",
            "root_path": "", "headers": headers,
            "client": ("127.0.0.1", 51000), "server": ("testserver", 80),
        }
        started: dict = {}
        frames: list = []
        first = asyncio.Event()
        done = asyncio.Event()

        async def receive():
            await asyncio.Event().wait()      # never disconnect; the cancel is the hang-up

        async def send(message):
            if message["type"] == "http.response.start":
                started["status"] = message["status"]
                started["headers"] = {k.decode().lower(): v.decode()
                                      for k, v in message["headers"]}
            elif message["type"] == "http.response.body":
                chunk = message.get("body", b"")
                if chunk:
                    frames.append(chunk.decode())
                    first.set()
                if len(frames) >= max_frames or not message.get("more_body", False):
                    done.set()

        task = asyncio.ensure_future(app(scope, receive, send))
        try:
            if after_first is not None:
                await asyncio.wait_for(first.wait(), timeout=10)
                await after_first()
            await asyncio.wait_for(done.wait(), timeout=10)
        finally:
            task.cancel()
            try:
                await task
            except BaseException:
                pass
        return started.get("status"), started.get("headers", {}), frames

    return _run(body())


def _parse_frame(text):
    """('sync', {...}) from one SSE frame."""
    import json as _json
    event, data = None, None
    for line in text.strip().splitlines():
        if line.startswith("event: "):
            event = line[len("event: "):]
        elif line.startswith("data: "):
            data = _json.loads(line[len("data: "):])
    return event, data


def test_stream_requires_a_session():
    status, _, _ = _drive_stream(cookie=None)
    assert status == 401, f"expected 401 without a session, got {status}"


def test_stream_opens_with_a_snapshot_and_correct_headers():
    client, tok = _setup()
    status, headers, frames = _drive_stream(cookie=tok)
    assert status == 200, f"expected 200, got {status}"
    assert headers["content-type"].startswith("text/event-stream")
    # Buffering anywhere in the chain defeats the point of a push feed.
    assert "no-transform" in headers.get("cache-control", "")
    assert headers.get("x-accel-buffering") == "no"
    # SSE must never be gzipped. Starlette excludes text/event-stream by
    # default; if that ever regresses the feed stalls instead of failing loudly,
    # so pin it here even though we do not own the behaviour.
    assert "gzip" not in headers.get("content-encoding", ""), \
        "SSE must not be compressed — gzip buffering would stall the feed"

    event, data = _parse_frame(frames[0])
    assert event == "sync"
    assert set(data["stamps"]) >= set(livesync.COLLECTIONS), \
        "a window connecting mid-session must get a full snapshot to reconcile against"
    assert data["stamps"] == _stamps(client, tok), \
        "the stream snapshot and /api/versions must agree"


def test_a_write_pushes_a_frame_to_an_open_stream():
    """The whole point: a change reaches an already-open window without it
    asking. Writes here go through the same mark_dirty → post-commit flush path
    the routes use (backend/database.py::get_db)."""
    client, tok = _setup()
    from backend.database import async_session

    async def rename_project():
        async with async_session() as db:
            row = (await db.execute(
                __import__("sqlalchemy").select(models.Project)
                .where(models.Project.id == P_STAMP)
            )).scalar_one()
            row.name = "Pushed While You Watched"
            livesync.mark_dirty(db, "projects")
            await db.commit()
            await livesync.flush(db)

    status, _, frames = _drive_stream(cookie=tok, max_frames=2, after_first=rename_project)
    assert status == 200
    assert len(frames) >= 2, f"a write must push a second frame, got {len(frames)}"

    _, snapshot = _parse_frame(frames[0])
    _, pushed = _parse_frame(frames[1])
    assert pushed["stamps"]["projects"] != snapshot["stamps"]["projects"], \
        "the pushed frame must carry a moved projects stamp"
    for quiet in ("contacts", "quotes", "invoices"):
        assert pushed["stamps"][quiet] == snapshot["stamps"][quiet], \
            f"{quiet} moved on a project-only write — windows would refetch it for nothing"


def test_stream_recycles_itself_with_a_goodbye_frame():
    """Auth is checked when a stream OPENS and never again, so a connection is
    capped and recycled. The explicit `bye` frame is what lets the client tell a
    scheduled recycle from a fault — without it, a tab left open all day would
    count each recycle as a failure and eventually downgrade itself to polling
    (components/live-sync.js)."""
    client, tok = _setup()
    original = livesync.MAX_STREAM_SECONDS
    livesync.MAX_STREAM_SECONDS = 0.4
    try:
        status, _, frames = _drive_stream(cookie=tok, max_frames=2)
    finally:
        livesync.MAX_STREAM_SECONDS = original

    assert status == 200
    assert len(frames) >= 2, f"expected a snapshot then a recycle, got {frames}"
    first_event, _ = _parse_frame(frames[0])
    last_event, last_data = _parse_frame(frames[-1])
    assert first_event == "sync"
    assert last_event == "bye", f"a recycled stream must announce itself, got {last_event!r}"
    assert last_data.get("reason") == "recycle"


def test_stream_does_not_recycle_early():
    """The deadline must not be confused with the keepalive tick — an idle
    stream inside its lifetime keeps serving, it does not say goodbye."""
    client, tok = _setup()
    original_max = livesync.MAX_STREAM_SECONDS
    original_keepalive = livesync.KEEPALIVE_SECONDS
    livesync.MAX_STREAM_SECONDS = 30
    livesync.KEEPALIVE_SECONDS = 0.2
    try:
        # Two keepalive ticks' worth of waiting, well inside the lifetime.
        status, _, frames = _drive_stream(cookie=tok, max_frames=1)
        assert status == 200
        assert _parse_frame(frames[0])[0] == "sync"
        assert not any("bye" in f for f in frames), f"recycled early: {frames}"
    finally:
        livesync.MAX_STREAM_SECONDS = original_max
        livesync.KEEPALIVE_SECONDS = original_keepalive


# ── Safety sweep ────────────────────────────────────────────────────────────

def test_the_sweep_stays_idle_when_nobody_is_connected():
    """This is a small internal tool that sits unused most nights. With no
    subscribers there is nobody to broadcast to, so the sweep must not keep
    running aggregates against the database forever."""
    from backend.database import async_session

    opened = {"count": 0}

    def counting_factory():
        opened["count"] += 1
        return async_session()

    async def body():
        livesync._reset_for_tests()
        task = asyncio.ensure_future(livesync.sweeper(counting_factory, interval=0.05))
        await asyncio.sleep(0.4)                     # several intervals
        idle_calls = opened["count"]

        q = livesync.subscribe()                      # someone connects
        await asyncio.sleep(0.4)
        busy_calls = opened["count"]
        livesync.unsubscribe(q)

        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        return idle_calls, busy_calls

    idle_calls, busy_calls = _run(body())
    assert idle_calls == 0, f"the sweep queried the database {idle_calls}x with nobody connected"
    assert busy_calls > 0, "the sweep must resume once a window is connected"


def test_stream_cleans_up_its_subscriber_on_disconnect():
    client, tok = _setup()
    before = livesync.subscriber_count()
    _drive_stream(cookie=tok)
    assert livesync.subscriber_count() == before, \
        "a closed stream must unsubscribe, or every reconnect leaks a queue"


# ── The broadcaster itself (no HTTP — the fan-out is pure asyncio) ──────────

def test_broadcast_reaches_every_subscriber():
    async def body():
        livesync._reset_for_tests()
        a, b = livesync.subscribe(), livesync.subscribe()
        livesync._broadcast({"projects": "1:2:3"})
        assert (await a.get())["projects"] == "1:2:3"
        assert (await b.get())["projects"] == "1:2:3"
        livesync.unsubscribe(a)
        livesync.unsubscribe(b)
    _run(body())


def test_a_full_queue_collapses_its_backlog_instead_of_dropping_the_subscriber():
    """Every frame carries the FULL stamp map, so an older queued frame is
    strictly redundant. A slow reader must end up with the NEWEST map, not be
    disconnected and not be stuck holding a stale one."""
    async def body():
        livesync._reset_for_tests()
        q = livesync.subscribe()
        for i in range(livesync._QUEUE_MAXSIZE + 5):
            livesync._broadcast({"projects": f"stamp-{i}"})
        newest = f"stamp-{livesync._QUEUE_MAXSIZE + 4}"
        seen = []
        while not q.empty():
            seen.append((await q.get())["projects"])
        assert seen[-1] == newest, f"newest frame must survive the collapse, got {seen}"
        assert len(seen) <= livesync._QUEUE_MAXSIZE, "queue must stay bounded"
        livesync.unsubscribe(q)
    _run(body())


# ── gzip ────────────────────────────────────────────────────────────────────

def test_json_collections_are_gzipped():
    client, tok = _setup()
    # Make the payload comfortably clear of GZipMiddleware's 500-byte floor.
    for i in range(12):
        client.post("/api/companies",
                    json={"id": CO_GZIP + i, "name": f"Gzip Test Company {i}",
                          "address": "1000 Example Boulevard, Suite 400\nLos Angeles",
                          "city": "Los Angeles", "state": "CA", "zip": "90001"},
                    cookies={"ltp_session": tok})
    r = client.get("/api/companies", cookies={"ltp_session": tok},
                   headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200, r.text
    assert r.headers.get("content-encoding") == "gzip", \
        "collection GETs must compress — repeated JSON keys are gzip's best case"


def main():
    tests = [
        test_versions_requires_a_session,
        test_versions_covers_every_synced_collection,
        test_versions_is_stable_when_nothing_changes,
        test_write_moves_only_its_own_collection_stamp,
        test_delete_moves_the_stamp_even_though_updated_at_cannot,
        test_rows_carry_a_rev_on_every_read_and_write,
        test_put_with_a_current_if_match_succeeds,
        test_put_with_a_stale_if_match_is_rejected_and_returns_the_current_row,
        test_put_without_if_match_keeps_last_write_wins,
        test_an_identical_rewrite_is_not_a_conflict,
        test_stale_put_after_crew_accept_is_rejected,
        test_stream_requires_a_session,
        test_stream_opens_with_a_snapshot_and_correct_headers,
        test_a_write_pushes_a_frame_to_an_open_stream,
        test_stream_recycles_itself_with_a_goodbye_frame,
        test_stream_does_not_recycle_early,
        test_the_sweep_stays_idle_when_nobody_is_connected,
        test_stream_cleans_up_its_subscriber_on_disconnect,
        test_broadcast_reaches_every_subscriber,
        test_a_full_queue_collapses_its_backlog_instead_of_dropping_the_subscriber,
        test_json_collections_are_gzipped,
    ]
    failed = 0
    try:
        for t in tests:
            try:
                t()
                print(f"  [PASS] {t.__name__}")
            except Exception as e:
                failed += 1
                print(f"  [FAIL] {t.__name__}: {e!r}")
    finally:
        _teardown()
    print(f"\n== {len(tests) - failed}/{len(tests)} tests passed ==")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
