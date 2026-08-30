"""Tests for crew-request referential integrity (backend/crew_integrity.py).

Three layers:
  - Pure reconcile_one logic (no DB): a healthy request is untouched; a partial
    removal trims position_ids to the survivors (status preserved); a full
    removal (or a deleted project) auto-withdraws; terminal requests are left
    alone; positions that drifted BELOW a live request's status floor (a stale
    project save reverted requested/accepted → open) are healed back up.
    Covers both pending and accepted.
  - Pure enforce_status_floor logic (no DB): a project write keeping the same
    crew member but a lower-ranked position status is a stale echo and gets the
    stored status restored; deliberate downgrades (crew cleared/changed) and
    upgrades pass through.
  - Real temp-DB integration: reconcile_project (save + delete), reconcile_all
    (the producer-list sweep / backfill / drift heal), and reconcile_request
    (the crew-link / accept-decline heal).

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
    assert cond, f"{label} {detail}"


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


# ── Status-floor healing (drift from a stale project save) ───────────────────

def test_accepted_request_heals_drifted_positions():
    print("test_accepted_request_heals_drifted_positions")
    # The reported bug: request accepted, but a stale save reverted its
    # positions to open/requested (crew still assigned) → heal to accepted.
    req = models.CrewRequest(id=20, token="tok-" + "h" * 20, project_id=1, contact_id=5,
                             position_ids=["p1", "p2"], status="accepted")
    proj = _assigned_project([("p1", 5, "open"), ("p2", 5, "requested")])
    ch = ci.reconcile_one(req, proj)
    _check("reports healed", ch and ch["action"] == "healed", str(ch))
    _check("both positions advanced", ch and sorted(ch["healed"]) == ["p1", "p2"])
    statuses = {p["id"]: p["status"] for p in proj.schedule[0]["positions"]}
    _check("p1 open → accepted", statuses["p1"] == "accepted")
    _check("p2 requested → accepted", statuses["p2"] == "accepted")
    _check("position_ids untouched", req.position_ids == ["p1", "p2"])
    _check("request stays accepted", req.status == "accepted")


def test_pending_request_heals_open_to_requested():
    print("test_pending_request_heals_open_to_requested")
    # A pending request's positions reverted to open would count as sendable
    # again (duplicate-request footgun) — heal them back to requested.
    req = models.CrewRequest(id=21, token="tok-" + "i" * 20, project_id=1, contact_id=5,
                             position_ids=["p1"], status="pending")
    proj = _assigned_project([("p1", 5, "open")])
    ch = ci.reconcile_one(req, proj)
    _check("reports healed", ch and ch["action"] == "healed", str(ch))
    _check("p1 open → requested", proj.schedule[0]["positions"][0]["status"] == "requested")
    _check("request stays pending", req.status == "pending")


def test_heal_never_downgrades_or_overrides():
    print("test_heal_never_downgrades_or_overrides")
    # Confirmed is above every floor; declined is a settled answer; accepted
    # under a pending request is above ITS floor. None may be touched.
    req = models.CrewRequest(id=22, token="tok-" + "j" * 20, project_id=1, contact_id=5,
                             position_ids=["p1", "p2"], status="accepted")
    proj = _assigned_project([("p1", 5, "confirmed"), ("p2", 5, "declined")])
    _check("confirmed/declined untouched → no change", ci.reconcile_one(req, proj) is None)
    pend = models.CrewRequest(id=23, token="tok-" + "k" * 20, project_id=1, contact_id=5,
                              position_ids=["p3"], status="pending")
    proj2 = _assigned_project([("p3", 5, "accepted")])
    _check("accepted above pending's floor → no change", ci.reconcile_one(pend, proj2) is None)
    _check("accepted status preserved", proj2.schedule[0]["positions"][0]["status"] == "accepted")


def test_heal_skips_undated_shift_positions():
    print("test_heal_skips_undated_shift_positions")
    # A drifted position on a day whose date was cleared is TRIMMED (it's no
    # longer a live shift), never healed.
    req = models.CrewRequest(id=24, token="tok-" + "l" * 20, project_id=1, contact_id=5,
                             position_ids=["p1", "p2"], status="accepted")
    proj = _dated_project([
        ("2026-07-01", [("p1", 5, "open")]),
        ("", [("p2", 5, "open")]),
    ])
    ch = ci.reconcile_one(req, proj)
    _check("trim + heal in one pass", ch and ch["action"] == "trimmed" and ch.get("healed") == ["p1"], str(ch))
    _check("dated p1 healed to accepted", proj.schedule[0]["positions"][0]["status"] == "accepted")
    _check("undated p2 left alone", proj.schedule[1]["positions"][0]["status"] == "open")
    _check("position_ids trimmed to p1", req.position_ids == ["p1"])


# ── enforce_status_floor (the stale project-PUT guard) ───────────────────────

def _one_day_schedule(positions):
    """[(id, crewId, status)] → a one-day schedule JSON blob."""
    return [{"id": "day-0", "date": "2026-07-01", "title": "Day 0",
             "positions": [{"id": i, "crewId": c, "status": s} for (i, c, s) in positions]}]


def test_floor_blocks_same_crew_downgrades():
    print("test_floor_blocks_same_crew_downgrades")
    stored = _one_day_schedule([("p1", 5, "requested"), ("p2", 5, "accepted"),
                                ("p3", 5, "confirmed"), ("p4", 5, "declined")])
    incoming = _one_day_schedule([("p1", 5, "open"), ("p2", 5, "open"),
                                  ("p3", 5, "accepted"), ("p4", 5, "requested")])
    fixed = ci.enforce_status_floor(stored, incoming)
    _check("all four regressions restored", fixed == 4, f"fixed={fixed}")
    statuses = {p["id"]: p["status"] for p in incoming[0]["positions"]}
    _check("requested restored", statuses["p1"] == "requested")
    _check("accepted restored", statuses["p2"] == "accepted")
    _check("confirmed restored", statuses["p3"] == "confirmed")
    _check("declined restored", statuses["p4"] == "declined")


def test_floor_allows_deliberate_changes():
    print("test_floor_allows_deliberate_changes")
    stored = _one_day_schedule([("p1", 5, "accepted"), ("p2", 5, "requested"),
                                ("p3", 5, "requested"), ("p4", 5, "accepted")])
    incoming = _one_day_schedule([
        ("p1", None, "open"),      # Release: crew cleared → legit reopen
        ("p2", 9, "open"),         # Reassign: different crew → legit reset
        ("p3", 5, "accepted"),     # upgrade → always fine
        ("p4", 5, "confirmed"),    # confirm → always fine
    ])
    fixed = ci.enforce_status_floor(stored, incoming)
    _check("no deliberate change touched", fixed == 0, f"fixed={fixed}")
    statuses = {p["id"]: p["status"] for p in incoming[0]["positions"]}
    _check("release kept open", statuses["p1"] == "open")
    _check("reassign kept open", statuses["p2"] == "open")
    _check("upgrade kept", statuses["p3"] == "accepted")
    _check("confirm kept", statuses["p4"] == "confirmed")


def test_floor_ignores_new_unknown_and_unassigned():
    print("test_floor_ignores_new_unknown_and_unassigned")
    stored = _one_day_schedule([("p1", None, "open"), ("p2", 5, "whatever")])
    incoming = _one_day_schedule([
        ("p1", 5, "open"),         # stored crew None → fresh assignment, no floor
        ("p2", 5, "open"),         # stored status unknown → no floor to assert
        ("pNEW", 5, "open"),       # brand-new position → passes through
    ])
    fixed = ci.enforce_status_floor(stored, incoming)
    _check("nothing floored", fixed == 0, f"fixed={fixed}")
    _check("empty/None schedules are safe",
           ci.enforce_status_floor(None, incoming) == 0 and ci.enforce_status_floor(stored, None) == 0)


# ── enforce_pay_snapshot (the non-admin payout-tamper guard) ─────────────────

def _pay_schedule(positions):
    """[(id, workDict, adjList)] → a one-day schedule JSON blob carrying the
    frozen payout snapshot fields the export bills."""
    return [{"id": "day-0", "date": "2026-07-01", "title": "Day 0",
             "positions": [{"id": i, "crewId": 5, "status": "confirmed", "work": w, "adj": a}
                           for (i, w, a) in positions]}]


def test_pay_snapshot_reverts_tampered_total():
    print("test_pay_snapshot_reverts_tampered_total")
    stored = _pay_schedule([("p1", {"pay": {"total": 600.0}}, [{"label": "gear", "amount": 20.0}])])
    # A non-admin PUT inflates the billed total and rewrites an adjustment.
    incoming = _pay_schedule([("p1", {"pay": {"total": 9999.0}}, [{"label": "bonus", "amount": 5000.0}])])
    fixed = ci.enforce_pay_snapshot(stored, incoming)
    _check("both work and adj reverted", fixed == 2, f"fixed={fixed}")
    pos = incoming[0]["positions"][0]
    _check("total restored", pos["work"]["pay"]["total"] == 600.0, str(pos["work"]))
    _check("adj restored", pos["adj"] == [{"label": "gear", "amount": 20.0}], str(pos["adj"]))


def test_pay_snapshot_allows_non_pay_edits():
    print("test_pay_snapshot_allows_non_pay_edits")
    # A member's ordinary save echoes the snapshot it loaded → no-op; other
    # fields (times/status) it may have changed are left entirely alone here.
    stored = _pay_schedule([("p1", {"pay": {"total": 600.0}}, [])])
    incoming = _pay_schedule([("p1", {"pay": {"total": 600.0}}, [])])
    incoming[0]["time"] = "08:00"   # a legitimate schedule edit rides alongside
    fixed = ci.enforce_pay_snapshot(stored, incoming)
    _check("unchanged snapshot is a no-op", fixed == 0, f"fixed={fixed}")
    _check("schedule edit preserved", incoming[0]["time"] == "08:00")


def test_pay_snapshot_strips_introduced_snapshot():
    print("test_pay_snapshot_strips_introduced_snapshot")
    # A non-admin can't INTRODUCE a snapshot on a new position (empty stored side,
    # as on create, or a brand-new position id on update).
    fixed = ci.enforce_pay_snapshot([], _pay_schedule([("pNEW", {"pay": {"total": 800.0}}, [{"label": "x", "amount": 9.0}])]))
    _check("introduced snapshot stripped (create)", fixed == 2, f"fixed={fixed}")
    incoming = _pay_schedule([("pNEW", {"pay": {"total": 800.0}}, None)])
    ci.enforce_pay_snapshot(_pay_schedule([("p1", {"pay": {"total": 600.0}}, [])]), incoming)
    pos = incoming[0]["positions"][0]
    _check("work stripped from new position", "work" not in pos, str(pos))
    _check("None/empty schedules are safe",
           ci.enforce_pay_snapshot(None, None) == 0)


# ── Real-DB integration ──────────────────────────────────────────────────────

async def _reset_schema():
    async with engine.begin() as conn:
        await conn.run_sync(models.Base.metadata.drop_all)
        await conn.run_sync(models.Base.metadata.create_all)


async def _seed_project_and_request(position_ids_on_schedule, request_position_ids, *,
                                    status="accepted", pos_status="requested"):
    async with async_session() as db:
        proj = models.Project(
            name="Gala",
            schedule=[{"id": "day-0", "date": "2026-07-01", "title": "Day 0",
                       "positions": [{"id": p, "status": pos_status} for p in position_ids_on_schedule]}],
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
    # Healthy request (p1 present AND at the accepted request's floor) + an
    # orphan whose project_id is null.
    proj_id, healthy_id = await _seed_project_and_request(["p1"], ["p1"], pos_status="accepted")
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


async def test_reconcile_all_heals_drifted_positions():
    print("test_reconcile_all_heals_drifted_positions")
    await _reset_schema()
    # The reported production state, end to end at the DB layer: a request the
    # crew member ACCEPTED whose schedule positions were clobbered back to
    # "open" by a stale save. The producer-list sweep must advance them back.
    proj_id, req_id = await _seed_project_and_request(["p1", "p2"], ["p1", "p2"],
                                                      status="accepted", pos_status="open")
    async with async_session() as db:
        changed = await ci.reconcile_all(db)
        await db.commit()
    _check("sweep healed the drifted request", changed == 1, f"changed={changed}")
    async with async_session() as db:
        proj = (await db.execute(select(models.Project).where(models.Project.id == proj_id))).scalar_one()
        statuses = [p["status"] for p in proj.schedule[0]["positions"]]
        _check("both positions persisted as accepted", statuses == ["accepted", "accepted"], str(statuses))
    req = await _get_request(req_id)
    _check("request untouched (still accepted)", req.status == "accepted")
    _check("position_ids untouched", req.position_ids == ["p1", "p2"])
    # A second sweep is a no-op — healing converges.
    async with async_session() as db:
        changed = await ci.reconcile_all(db)
        await db.commit()
    _check("second sweep is a no-op", changed == 0, f"changed={changed}")


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
        test_accepted_request_heals_drifted_positions, test_pending_request_heals_open_to_requested,
        test_heal_never_downgrades_or_overrides, test_heal_skips_undated_shift_positions,
        test_floor_blocks_same_crew_downgrades, test_floor_allows_deliberate_changes,
        test_floor_ignores_new_unknown_and_unassigned,
    ]
    async_tests = [
        test_reconcile_project_trims_and_withdraws, test_reconcile_project_deleted_withdraws,
        test_reconcile_all_backfills_orphans, test_reconcile_all_heals_drifted_positions,
        test_reconcile_request_loads_project,
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
