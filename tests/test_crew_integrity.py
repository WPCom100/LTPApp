"""Tests for crew-request referential integrity (backend/crew_integrity.py).

Two layers:
  - Pure reconcile_one logic (no DB): a healthy request is untouched; a partial
    removal trims position_ids to the survivors (status preserved); a full
    removal (or a deleted project) auto-withdraws; terminal requests are left
    alone. Covers both pending and accepted.
  - Real temp-DB integration: reconcile_project (save + delete), reconcile_all
    (the producer-list sweep / backfill), and reconcile_request (the crew-link /
    accept-decline heal).

Runs both as pytest and as a plain script:
    python tests/test_crew_integrity.py
"""
import asyncio
import os
import sys

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "http://localhost:8000/auth/callback")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

from sqlalchemy import select  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from backend import crew_integrity as ci  # noqa: E402
from backend import models  # noqa: E402

_DB_PATH = os.path.join(_here, "scratch_crew_integrity.db")
engine = create_async_engine("sqlite+aiosqlite:///" + _DB_PATH)
async_session = async_sessionmaker(engine, expire_on_commit=False)


_results: list[tuple[str, bool]] = []


def _check(label: str, cond: bool, detail: str = "") -> None:
    _results.append((label, bool(cond)))
    status = "PASS" if cond else "FAIL"
    suffix = f"  ({detail})" if detail else ""
    print(f"  [{status}] {label}{suffix}")


def _project(days, pid=1):
    """days: list of lists of position-id strings (one inner list per schedule day)."""
    schedule = []
    for i, pids in enumerate(days):
        schedule.append({
            "id": f"day-{i}", "date": f"2026-07-{i + 1:02d}", "title": f"Day {i}",
            "positions": [{"id": p, "status": "requested"} for p in pids],
        })
    return models.Project(id=pid, name="Gala", schedule=schedule)


def _req(position_ids, status="pending", project_id=1, rid=1):
    return models.CrewRequest(
        id=rid, token=("tok-" + "x" * 20 + str(rid)), project_id=project_id,
        position_ids=list(position_ids), status=status,
    )


# ── Pure reconcile_one ───────────────────────────────────────────────────────

def test_healthy_untouched():
    print("test_healthy_untouched")
    req = _req(["p1", "p2"])
    proj = _project([["p1", "p2"]])
    _check("no change when all positions present", ci.reconcile_one(req, proj) is None)
    _check("status preserved", req.status == "pending")
    _check("position_ids preserved", req.position_ids == ["p1", "p2"])


def test_partial_removal_trims():
    print("test_partial_removal_trims")
    req = _req(["p1", "p2", "p3"])
    proj = _project([["p1"], ["p3"]])  # p2's day removed
    ch = ci.reconcile_one(req, proj)
    _check("reports trimmed", ch and ch["action"] == "trimmed", str(ch))
    _check("removed p2", ch and ch["removed"] == ["p2"])
    _check("position_ids trimmed to survivors", req.position_ids == ["p1", "p3"])
    _check("status stays pending", req.status == "pending")


def test_full_removal_withdraws():
    print("test_full_removal_withdraws")
    req = _req(["p1", "p2"])
    proj = _project([[]])  # all positions gone
    ch = ci.reconcile_one(req, proj)
    _check("reports withdrawn", ch and ch["action"] == "withdrawn", str(ch))
    _check("reason positions_removed", ch and ch["reason"] == "positions_removed")
    _check("status withdrawn", req.status == "withdrawn")


def test_deleted_project_withdraws():
    print("test_deleted_project_withdraws")
    req = _req(["p1"])
    ch = ci.reconcile_one(req, None)
    _check("withdrawn on missing project", ch and ch["action"] == "withdrawn")
    _check("reason project_deleted", ch and ch["reason"] == "project_deleted")
    _check("status withdrawn", req.status == "withdrawn")


def test_accepted_partial_keeps_accepted():
    print("test_accepted_partial_keeps_accepted")
    req = _req(["p1", "p2"], status="accepted")
    proj = _project([["p1"]])
    ch = ci.reconcile_one(req, proj)
    _check("trimmed", ch and ch["action"] == "trimmed")
    _check("stays accepted", req.status == "accepted")
    _check("trimmed to p1", req.position_ids == ["p1"])


def test_accepted_full_removal_withdraws():
    print("test_accepted_full_removal_withdraws")
    req = _req(["p1"], status="accepted")
    proj = _project([[]])
    ci.reconcile_one(req, proj)
    _check("accepted-but-stale is withdrawn", req.status == "withdrawn")


def test_terminal_untouched():
    print("test_terminal_untouched")
    for term in ("declined", "withdrawn"):
        req = _req(["p1"], status=term)
        proj = _project([[]])  # everything gone
        _check(f"{term} not reconciled", ci.reconcile_one(req, proj) is None)
        _check(f"{term} status preserved", req.status == term)


def _assigned_project(positions, pid=1):
    """A one-day project whose positions carry an explicit crewId — for the
    crew-aware (reassignment) cases. `positions` = list of (id, crewId, status)."""
    return models.Project(id=pid, name="Gala", schedule=[{
        "id": "day-0", "date": "2026-07-01", "title": "Day 0",
        "positions": [{"id": i, "crewId": c, "status": s} for (i, c, s) in positions],
    }])


def test_reassigned_position_trimmed():
    print("test_reassigned_position_trimmed")
    # Crew 5 holds p1 + p2; p2 is reassigned to crew 9 → trim p2, keep p1.
    req = models.CrewRequest(id=1, token="tok-" + "x" * 20, project_id=1, contact_id=5,
                             position_ids=["p1", "p2"], status="accepted")
    proj = _assigned_project([("p1", 5, "accepted"), ("p2", 9, "open")])
    ch = ci.reconcile_one(req, proj)
    _check("reports trimmed", ch and ch["action"] == "trimmed", str(ch))
    _check("p2 trimmed (no longer this crew's)", ch and ch["removed"] == ["p2"])
    _check("keeps p1", req.position_ids == ["p1"])
    _check("stays accepted", req.status == "accepted")


def test_all_positions_reassigned_withdraws():
    print("test_all_positions_reassigned_withdraws")
    # Crew 5's only shift is reassigned to crew 9 → the request withdraws.
    req = models.CrewRequest(id=2, token="tok-" + "y" * 20, project_id=1, contact_id=5,
                             position_ids=["p1"], status="pending")
    proj = _assigned_project([("p1", 9, "requested")])
    ch = ci.reconcile_one(req, proj)
    _check("withdrawn once none remain this crew's", ch and ch["action"] == "withdrawn", str(ch))
    _check("status withdrawn", req.status == "withdrawn")


def test_cleared_position_withdraws():
    print("test_cleared_position_withdraws")
    # p1 unassigned entirely (crewId None) → no longer this crew's → withdraw.
    req = models.CrewRequest(id=3, token="tok-" + "z" * 20, project_id=1, contact_id=5,
                             position_ids=["p1"], status="accepted")
    proj = _assigned_project([("p1", None, "open")])
    ci.reconcile_one(req, proj)
    _check("cleared position withdraws request", req.status == "withdrawn")


def test_held_position_untouched():
    print("test_held_position_untouched")
    # All positions still the crew member's → nothing changes.
    req = models.CrewRequest(id=4, token="tok-" + "w" * 20, project_id=1, contact_id=5,
                             position_ids=["p1", "p2"], status="accepted")
    proj = _assigned_project([("p1", 5, "accepted"), ("p2", 5, "confirmed")])
    _check("no change when member still holds all", ci.reconcile_one(req, proj) is None)
    _check("position_ids preserved", req.position_ids == ["p1", "p2"])


def _dated_project(days, pid=1):
    """A multi-day project with an explicit per-day date — for the date-cleared
    cases. `days` = list of (date, [(posId, crewId, status), ...]); pass date=""
    to make that day "unscheduled"."""
    schedule = []
    for i, (date, positions) in enumerate(days):
        schedule.append({
            "id": f"day-{i}", "date": date, "title": f"Day {i}",
            "positions": [{"id": p, "crewId": c, "status": s} for (p, c, s) in positions],
        })
    return models.Project(id=pid, name="Gala", schedule=schedule)


def test_cleared_date_trims_position():
    print("test_cleared_date_trims_position")
    # Crew 5 holds p1 (a dated day) + p2 whose day's date was later cleared. The
    # unscheduled day is no longer a real shift → trim p2, keep p1.
    req = models.CrewRequest(id=11, token="tok-" + "d" * 20, project_id=1, contact_id=5,
                             position_ids=["p1", "p2"], status="accepted")
    proj = _dated_project([
        ("2026-07-01", [("p1", 5, "accepted")]),
        ("", [("p2", 5, "requested")]),
    ])
    ch = ci.reconcile_one(req, proj)
    _check("reports trimmed", ch and ch["action"] == "trimmed", str(ch))
    _check("p2 trimmed (its day unscheduled)", ch and ch["removed"] == ["p2"])
    _check("keeps p1", req.position_ids == ["p1"])
    _check("stays accepted", req.status == "accepted")


def test_cleared_date_only_day_withdraws():
    print("test_cleared_date_only_day_withdraws")
    # The request's only day has its date cleared → no live shift remains →
    # auto-withdraw, exactly as if the day had been deleted.
    req = models.CrewRequest(id=12, token="tok-" + "e" * 20, project_id=1, contact_id=5,
                             position_ids=["p1"], status="pending")
    proj = _dated_project([("", [("p1", 5, "requested")])])
    ch = ci.reconcile_one(req, proj)
    _check("withdrawn when only day is unscheduled", ch and ch["action"] == "withdrawn", str(ch))
    _check("status withdrawn", req.status == "withdrawn")


# ── Real-DB integration ──────────────────────────────────────────────────────

async def _reset_schema():
    async with engine.begin() as conn:
        await conn.run_sync(models.Base.metadata.drop_all)
        await conn.run_sync(models.Base.metadata.create_all)


async def _seed_project_and_request(position_ids_on_schedule, request_position_ids, *, status="accepted"):
    async with async_session() as db:
        proj = models.Project(
            name="Gala",
            schedule=[{"id": "day-0", "date": "2026-07-01", "title": "Day 0",
                       "positions": [{"id": p, "status": "requested"} for p in position_ids_on_schedule]}],
        )
        db.add(proj)
        await db.flush()
        req = models.CrewRequest(
            token="tok-" + os.urandom(8).hex(), project_id=proj.id,
            position_ids=list(request_position_ids), status=status,
        )
        db.add(req)
        await db.flush()
        ids = (proj.id, req.id)
        await db.commit()
        return ids


async def _get_request(req_id):
    async with async_session() as db:
        r = await db.execute(select(models.CrewRequest).where(models.CrewRequest.id == req_id))
        return r.scalar_one()


async def test_reconcile_project_trims_and_withdraws():
    print("test_reconcile_project_trims_and_withdraws")
    await _reset_schema()
    # Schedule has only p1 now; request still references p1 + p2 → trim to p1.
    proj_id, req_id = await _seed_project_and_request(["p1"], ["p1", "p2"])
    async with async_session() as db:
        proj = (await db.execute(select(models.Project).where(models.Project.id == proj_id))).scalar_one()
        await ci.reconcile_project(db, proj)
        await db.commit()
    req = await _get_request(req_id)
    _check("trimmed to surviving p1", req.position_ids == ["p1"])
    _check("still accepted", req.status == "accepted")

    # Now remove p1 too → next reconcile withdraws.
    async with async_session() as db:
        proj = (await db.execute(select(models.Project).where(models.Project.id == proj_id))).scalar_one()
        proj.schedule = [{"id": "day-0", "date": "2026-07-01", "title": "Day 0", "positions": []}]
        await ci.reconcile_project(db, proj)
        await db.commit()
    req = await _get_request(req_id)
    _check("withdrawn once no shifts remain", req.status == "withdrawn")


async def test_reconcile_project_deleted_withdraws():
    print("test_reconcile_project_deleted_withdraws")
    await _reset_schema()
    proj_id, req_id = await _seed_project_and_request(["p1", "p2"], ["p1", "p2"])
    async with async_session() as db:
        proj = (await db.execute(select(models.Project).where(models.Project.id == proj_id))).scalar_one()
        await ci.reconcile_project(db, proj, deleted=True)
        await db.commit()
    req = await _get_request(req_id)
    _check("project-deleted withdraws the request", req.status == "withdrawn")


async def test_reconcile_all_backfills_orphans():
    print("test_reconcile_all_backfills_orphans")
    await _reset_schema()
    # Healthy request (p1 present) + an orphan whose project_id is null.
    proj_id, healthy_id = await _seed_project_and_request(["p1"], ["p1"])
    async with async_session() as db:
        orphan = models.CrewRequest(token="tok-orphan-xyz123", project_id=None,  # gitleaks:allow - hand-typed fake fixture token, not a real secret
                                    position_ids=["gone1", "gone2"], status="accepted")
        db.add(orphan)
        await db.flush()
        orphan_id = orphan.id
        await db.commit()
    async with async_session() as db:
        changed = await ci.reconcile_all(db)
        await db.commit()
    _check("sweep changed exactly the orphan", changed == 1, f"changed={changed}")
    _check("orphan withdrawn", (await _get_request(orphan_id)).status == "withdrawn")
    _check("healthy request untouched", (await _get_request(healthy_id)).status == "accepted")


async def test_reconcile_request_loads_project():
    print("test_reconcile_request_loads_project")
    await _reset_schema()
    # Schedule emptied; request references a now-gone position → withdraw on heal.
    proj_id, req_id = await _seed_project_and_request([], ["p1"], status="pending")
    async with async_session() as db:
        req = (await db.execute(select(models.CrewRequest).where(models.CrewRequest.id == req_id))).scalar_one()
        ch = await ci.reconcile_request(db, req)
        await db.commit()
    _check("reconcile_request withdrew it", ch and ch["action"] == "withdrawn", str(ch))
    _check("status persisted withdrawn", (await _get_request(req_id)).status == "withdrawn")


def main():
    sync_tests = [
        test_healthy_untouched, test_partial_removal_trims, test_full_removal_withdraws,
        test_deleted_project_withdraws, test_accepted_partial_keeps_accepted,
        test_accepted_full_removal_withdraws, test_terminal_untouched,
        test_reassigned_position_trimmed, test_all_positions_reassigned_withdraws,
        test_cleared_position_withdraws, test_held_position_untouched,
        test_cleared_date_trims_position, test_cleared_date_only_day_withdraws,
    ]
    async_tests = [
        test_reconcile_project_trims_and_withdraws, test_reconcile_project_deleted_withdraws,
        test_reconcile_all_backfills_orphans, test_reconcile_request_loads_project,
    ]
    try:
        for t in sync_tests:
            t()
        for t in async_tests:
            asyncio.run(t())
    finally:
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(_DB_PATH + suffix)
            except OSError:
                pass
    passed = sum(1 for _, ok in _results if ok)
    total = len(_results)
    print(f"\n{passed}/{total} checks passed")
    if passed != total:
        print("FAILURES:")
        for label, ok in _results:
            if not ok:
                print("  -", label)
        sys.exit(1)


if __name__ == "__main__":
    main()
