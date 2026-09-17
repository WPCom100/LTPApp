"""Backfill of `pricedStartDate` / `pricedEndDate` on quote sections
(alembic/versions/2026_09_17_1200-b2d4f6a8c0e2_quote_section_priced_window.py).

The migration stamps every existing quote section with the rental window its
equipment is assumed to be priced for, so the quote builder can notice a later
move of the project's dates (components/domain-docs.js::LTP_staleRentalSections)
on quotes written before the stamp existed. Getting the backfill wrong is quiet
either way: stamp the wrong window and every such quote nags on open; skip a
section and the old bug survives on it.

Covers:
  - stamp_sections: the doc window for a following section, the section's own
    dates for a custom one, an existing stamp left alone, no window → untouched,
    odd shapes passed through, the input never mutated.
  - strip_sections: the downgrade's inverse.
  - backfill / strip against a real SQLite database through the same
    SQLAlchemy core statements upgrade() and downgrade() run: linked quotes take
    their project's dates, unlinked ones their custom dates, a second run is a
    no-op, and the round trip restores the original JSON.

Pure Python + SQLAlchemy, no app boot. Runs both as pytest and as a script:
    python tests/test_quote_priced_window_migration.py
"""
import importlib.util
import json
import os
import sys
import tempfile

import sqlalchemy as sa

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
_MIG = os.path.join(_root, "alembic", "versions",
                    "2026_09_17_1200-b2d4f6a8c0e2_quote_section_priced_window.py")


def _load_migration():
    # Alembic version files aren't importable by name (they start with digits
    # and live outside any package), so load by path. `op` is imported at module
    # level but only used inside upgrade()/downgrade(), which we don't call.
    spec = importlib.util.spec_from_file_location("quote_section_priced_window", _MIG)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


MIG = _load_migration()

EQ = {"id": "e1", "type": "equipment", "equipmentId": 1, "name": "Mac Aura", "qty": 4, "unitPrice": 120}


def _sec(sid, **over):
    base = {"id": sid, "label": sid, "customDates": False, "startDate": "", "endDate": "", "items": [EQ]}
    base.update(over)
    return base


# ── stamp_sections / strip_sections (pure) ───────────────────────────────────

def test_following_section_takes_the_doc_window():
    out, changed = MIG.stamp_sections([_sec("a")], ("2026-08-10", "2026-08-13"))
    assert changed
    assert (out[0]["pricedStartDate"], out[0]["pricedEndDate"]) == ("2026-08-10", "2026-08-13")
    assert out[0]["items"] == [EQ] and out[0]["label"] == "a"


def test_custom_section_takes_its_own_dates():
    out, changed = MIG.stamp_sections(
        [_sec("a", customDates=True, startDate="2026-09-01", endDate="2026-09-02")], ("2026-08-10", "2026-08-13"))
    assert changed
    assert (out[0]["pricedStartDate"], out[0]["pricedEndDate"]) == ("2026-09-01", "2026-09-02")


def test_half_filled_custom_dates_fall_back_to_the_doc_window():
    out, _ = MIG.stamp_sections([_sec("a", customDates=True, startDate="2026-09-01")], ("2026-08-10", "2026-08-13"))
    assert (out[0]["pricedStartDate"], out[0]["pricedEndDate"]) == ("2026-08-10", "2026-08-13")


def test_an_existing_stamp_is_never_overwritten():
    stamped = _sec("a", pricedStartDate="2026-01-01", pricedEndDate="2026-01-02")
    out, changed = MIG.stamp_sections([stamped], ("2026-08-10", "2026-08-13"))
    assert not changed
    assert out[0] is stamped


def test_no_window_leaves_the_section_untouched():
    for window in (("", ""), None, ("2026-08-10", "")):
        out, changed = MIG.stamp_sections([_sec("a")], window)
        assert not changed
        assert "pricedStartDate" not in out[0]


def test_equipment_free_sections_are_stamped_too():
    # The stamp is bookkeeping for every section; only the BUILDER narrows the
    # notice to sections with equipment. Stamping all of them means a section
    # that gains an equipment line later is already watched.
    out, changed = MIG.stamp_sections([_sec("labor", items=[])], ("2026-08-10", "2026-08-13"))
    assert changed and out[0]["pricedEndDate"] == "2026-08-13"


def test_odd_shapes_pass_through():
    assert MIG.stamp_sections(None, ("2026-08-10", "2026-08-13")) == (None, False)
    assert MIG.stamp_sections({"not": "a list"}, ("2026-08-10", "2026-08-13")) == ({"not": "a list"}, False)
    out, changed = MIG.stamp_sections(["junk", None, _sec("a")], ("2026-08-10", "2026-08-13"))
    assert changed and out[0] == "junk" and out[1] is None and out[2]["pricedStartDate"] == "2026-08-10"


def test_the_input_is_not_mutated():
    src = [_sec("a")]
    snapshot = json.dumps(src, sort_keys=True)
    MIG.stamp_sections(src, ("2026-08-10", "2026-08-13"))
    assert json.dumps(src, sort_keys=True) == snapshot


def test_strip_removes_both_keys_and_reports_it():
    out, changed = MIG.strip_sections([_sec("a", pricedStartDate="2026-08-10", pricedEndDate="2026-08-13"), _sec("b")])
    assert changed
    assert "pricedStartDate" not in out[0] and "pricedEndDate" not in out[0]
    assert out[0]["items"] == [EQ]
    assert MIG.strip_sections([_sec("b")]) == ([_sec("b")], False)
    assert MIG.strip_sections(None) == (None, False)


# ── backfill / strip against a real database ─────────────────────────────────

def _fresh_db():
    fd, path = tempfile.mkstemp(prefix="ltp_priced_window_", suffix=".db")
    os.close(fd)
    engine = sa.create_engine("sqlite:///" + path)
    meta = sa.MetaData()
    sa.Table("projects", meta,
             sa.Column("id", sa.Integer, primary_key=True),
             sa.Column("start_date", sa.String(10)),
             sa.Column("end_date", sa.String(10)))
    sa.Table("quotes", meta,
             sa.Column("id", sa.Integer, primary_key=True),
             sa.Column("project_id", sa.Integer),
             sa.Column("custom_start_date", sa.String(10)),
             sa.Column("custom_end_date", sa.String(10)),
             sa.Column("sections", sa.JSON))
    meta.create_all(engine)
    with engine.begin() as conn:
        conn.execute(meta.tables["projects"].insert(), [
            {"id": 7, "start_date": "2026-08-10", "end_date": "2026-08-13"},
            {"id": 8, "start_date": "", "end_date": ""},
        ])
        conn.execute(meta.tables["quotes"].insert(), [
            # Linked: one following section, one custom, one already stamped.
            {"id": 1, "project_id": 7, "custom_start_date": "", "custom_end_date": "", "sections": [
                _sec("Lighting"),
                _sec("Other job", customDates=True, startDate="2026-09-01", endDate="2026-09-02"),
                _sec("Done", pricedStartDate="2026-01-01", pricedEndDate="2026-01-02"),
            ]},
            # Unlinked: the custom dates are the window.
            {"id": 2, "project_id": None, "custom_start_date": "2026-10-01", "custom_end_date": "2026-10-03",
             "sections": [_sec("Gear")]},
            # Linked to a project with no dates: nothing to stamp.
            {"id": 3, "project_id": 8, "custom_start_date": "", "custom_end_date": "", "sections": [_sec("Gear")]},
            # Linked to a project that no longer exists (FK is SET NULL, but be safe).
            {"id": 4, "project_id": 404, "custom_start_date": "", "custom_end_date": "", "sections": [_sec("Gear")]},
            # Nothing to do.
            {"id": 5, "project_id": 7, "custom_start_date": "", "custom_end_date": "", "sections": []},
            {"id": 6, "project_id": 7, "custom_start_date": "", "custom_end_date": "", "sections": None},
        ])
    return engine, meta, path


def _sections(engine, meta, qid):
    with engine.connect() as conn:
        return conn.execute(sa.select(meta.tables["quotes"].c.sections)
                            .where(meta.tables["quotes"].c.id == qid)).scalar_one()


def test_backfill_stamps_every_quote_it_can():
    engine, meta, path = _fresh_db()
    try:
        original = {qid: _sections(engine, meta, qid) for qid in range(1, 7)}
        with engine.begin() as conn:
            touched = MIG.backfill(conn)
        assert touched == 2, touched   # quotes 1 and 2

        q1 = _sections(engine, meta, 1)
        assert (q1[0]["pricedStartDate"], q1[0]["pricedEndDate"]) == ("2026-08-10", "2026-08-13"), "following → project"
        assert (q1[1]["pricedStartDate"], q1[1]["pricedEndDate"]) == ("2026-09-01", "2026-09-02"), "custom → its own"
        assert (q1[2]["pricedStartDate"], q1[2]["pricedEndDate"]) == ("2026-01-01", "2026-01-02"), "already stamped → kept"
        assert q1[0]["items"] == [EQ]

        q2 = _sections(engine, meta, 2)
        assert (q2[0]["pricedStartDate"], q2[0]["pricedEndDate"]) == ("2026-10-01", "2026-10-03"), "unlinked → custom dates"

        for qid in (3, 4, 5, 6):
            assert _sections(engine, meta, qid) == original[qid], "quote %d must be untouched" % qid

        # Idempotent: a second run finds nothing to do.
        with engine.begin() as conn:
            assert MIG.backfill(conn) == 0

        # Downgrade restores the original JSON byte for byte (key order aside).
        with engine.begin() as conn:
            stripped = MIG.strip(conn)
        assert stripped == 2, stripped   # quotes 1 and 2 (rows, not sections)
        for qid in range(1, 7):
            got = _sections(engine, meta, qid)
            want = original[qid]
            if qid == 1:
                # Quote 1's third section carried a stamp BEFORE the migration;
                # the downgrade strips that too, which is the documented cost.
                want = [dict((k, v) for k, v in s.items() if not k.startswith("priced")) for s in want]
            assert json.dumps(got, sort_keys=True) == json.dumps(want, sort_keys=True), qid
    finally:
        engine.dispose()
        os.unlink(path)


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("PASS", name)
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print("FAIL", name, "-", exc)
    sys.exit(1 if failures else 0)
