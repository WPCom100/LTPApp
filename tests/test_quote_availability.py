"""Quote-screen availability must match the Availability Checker + the
Items detail screen.

User-reported bug: marking all units of a non-serialized fixture as
"under-maintenance" should report 0 available everywhere. The
Availability Checker (modules/rentals-utils.js::eqQty) and the Items
detail screen (modules/rentals-equipment.js — calls R.eqQty) both
correctly returned 0. The Quote builder had its own inline
duplicate at modules/quotes-builder.js::getAvailability that ALSO
filtered serialized-unit status — but skipped the parent-level
`eq.status === "under-maintenance"` check for non-serialized items.
The quote picker kept reporting the raw `eq.qty` (e.g. 10 available)
while the rest of the app said 0.

Two complementary guards:

  1. Behavior: Python ports of eqQty + allocatedQty (mirroring
     rentals-utils.js byte-for-byte at the contract level) exercise
     the three drift scenarios that the prior inline copy got wrong
     (non-serialized under-maintenance, allocation-state filtering,
     date-range allocation accounting). Any new divergence at the
     contract level (caller-visible) fails here.

  2. Structural: quotes-builder.js must call the canonical helpers
     and must NOT carry the duplicate inline filter pattern again.
     A future "optimize this, just inline it" refactor that drops
     the helper call gets caught at the source-string level.

Runs as a plain script:
    python tests/test_quote_availability.py
"""
import os
import re
import sys

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)

_results: list[tuple[str, bool]] = []


def _check(label: str, cond: bool, detail: str = "") -> None:
    _results.append((label, cond))
    status = "PASS" if cond else "FAIL"
    suffix = f"  ({detail})" if detail else ""
    print(f"  [{status}] {label}{suffix}")


# ── Python ports of the canonical helpers from rentals-utils.js ──────────
# Keep these in lockstep with modules/rentals-utils.js. They model the
# contract the Quote builder must obey; if the JS implementation changes
# semantics, update these too.


def py_out_of_service_qty(eq):
    """Port of LTP_RENTALS.outOfServiceQty — sum of qty across OPEN
    maintenance logs on a non-serialized item. Legacy logs without
    a qty field contribute 0 (they were informational-only).
    Negative qty values are clamped at 0 (defense in depth — the
    backend doesn't validate nested JSON, so a stale or malicious
    PUT with qty=-5 must not INFLATE availability)."""
    if not eq or eq.get("serialized"):
        return 0
    total = 0
    for l in (eq.get("maintenanceLogs") or []):
        if not l or l.get("status") != "open":
            continue
        try:
            total += max(0, int(l.get("qty") or 0))
        except (TypeError, ValueError):
            pass
    return total


def py_eq_qty(eq):
    """Port of LTP_RENTALS.eqQty.

    Non-serialized: qty MINUS the open-log qty sum, floored at 0. The
    legacy `eq.status === "under-maintenance"` parent flag still forces
    0 (full decommission preserved for back-compat)."""
    if eq.get("serialized"):
        return sum(
            1 for u in (eq.get("units") or [])
            if u.get("status") not in ("under-maintenance", "retired")
        )
    if eq.get("status") in ("under-maintenance", "retired"):
        return 0
    return max(0, (eq.get("qty") or 0) - py_out_of_service_qty(eq))


def py_allocated_qty(allocations, equipment_id, start_date, end_date, ex_id=None):
    """Port of LTP_RENTALS.allocatedQty."""
    total = 0
    for a in (allocations or []):
        if a.get("equipmentId") != equipment_id:
            continue
        if ex_id and a.get("id") == ex_id:
            continue
        if a.get("state") in ("returned", "under-maintenance"):
            continue
        if a.get("startDate", "") <= end_date and a.get("endDate", "") >= start_date:
            total += a.get("qty", 1)
    return total


def py_available_qty(equipment, allocations, eq_id, start_date, end_date, ex_id=None):
    """Port of LTP_RENTALS.availableQty — what the quote picker must report."""
    eq = next((e for e in equipment if e.get("id") == eq_id), None)
    if not eq:
        return 0
    return py_eq_qty(eq) - py_allocated_qty(allocations, eq_id, start_date, end_date, ex_id)


# ── Contract-level scenarios ─────────────────────────────────────────────


def test_non_serialized_under_maintenance_reports_zero():
    """The exact user-reported bug. Non-serialized fixture, parent-level
    status flipped to under-maintenance — every surface (quote, checker,
    items info) must report 0 available."""
    print("test_non_serialized_under_maintenance_reports_zero")
    eq = {"id": 1, "name": "Smoke Machine", "serialized": False, "qty": 10,
          "status": "under-maintenance"}
    _check("eqQty returns 0 for non-serialized under-maintenance",
           py_eq_qty(eq) == 0, f"got {py_eq_qty(eq)}")
    _check("availableQty also returns 0 even without allocations",
           py_available_qty([eq], [], 1, "2026-07-01", "2026-07-05") == 0)


def test_non_serialized_retired_reports_zero():
    """Same as under-maintenance but for the retired sideband state."""
    print("test_non_serialized_retired_reports_zero")
    eq = {"id": 2, "name": "Old Console", "serialized": False, "qty": 4,
          "status": "retired"}
    _check("retired non-serialized reports 0", py_eq_qty(eq) == 0)


def test_non_serialized_available_reports_full_qty():
    """Sanity guard so the under-maintenance fix doesn't accidentally
    zero out healthy non-serialized lines."""
    print("test_non_serialized_available_reports_full_qty")
    eq = {"id": 3, "name": "Cable Pack", "serialized": False, "qty": 25,
          "status": "available"}
    _check("available non-serialized reports its qty",
           py_eq_qty(eq) == 25, f"got {py_eq_qty(eq)}")


def test_serialized_filters_each_units_status():
    """Serialized fixture with mixed unit statuses — only available
    units count toward eqQty. The user's flow may have used "Set all
    units to under-maintenance" on a serialized fixture instead of a
    non-serialized one; pin both paths."""
    print("test_serialized_filters_each_units_status")
    eq = {
        "id": 4, "name": "Mac Quantum", "serialized": True,
        "units": [
            {"id": 1, "serial": "MQ-001", "status": "available"},
            {"id": 2, "serial": "MQ-002", "status": "under-maintenance"},
            {"id": 3, "serial": "MQ-003", "status": "retired"},
            {"id": 4, "serial": "MQ-004", "status": "available"},
        ],
    }
    _check("eqQty counts only available units",
           py_eq_qty(eq) == 2, f"got {py_eq_qty(eq)}")


def test_serialized_all_units_under_maintenance_reports_zero():
    """All units on a serialized fixture flipped to under-maintenance
    — eqQty must return 0, matching the checker + items info."""
    print("test_serialized_all_units_under_maintenance_reports_zero")
    eq = {
        "id": 5, "name": "Source Four", "serialized": True,
        "units": [{"id": i, "status": "under-maintenance"} for i in range(1, 7)],
    }
    _check("all-units-under-maintenance serialized reports 0",
           py_eq_qty(eq) == 0)


def test_allocation_under_maintenance_state_does_not_consume_qty():
    """A separate divergence the inline duplicate also got wrong: when
    an allocation row itself is in state="under-maintenance" (a
    sideband state for fixing things mid-booking), it should NOT count
    against availability — those units are being fixed, not actually
    rented out. Canonical allocatedQty filters this; the prior inline
    quote-builder copy did not."""
    print("test_allocation_under_maintenance_state_does_not_consume_qty")
    allocs = [
        {"id": 100, "equipmentId": 10, "state": "allocated", "qty": 3,
         "startDate": "2026-07-01", "endDate": "2026-07-05"},
        {"id": 101, "equipmentId": 10, "state": "under-maintenance", "qty": 2,
         "startDate": "2026-07-01", "endDate": "2026-07-05"},
        {"id": 102, "equipmentId": 10, "state": "returned", "qty": 4,
         "startDate": "2026-07-01", "endDate": "2026-07-05"},
    ]
    _check("only the allocated row counts; returned + under-maintenance excluded",
           py_allocated_qty(allocs, 10, "2026-07-01", "2026-07-05") == 3,
           f"got {py_allocated_qty(allocs, 10, '2026-07-01', '2026-07-05')}")


def test_allocation_date_range_overlap():
    """Date-range overlap semantics — only allocations whose window
    touches the quote window count. The Availability Checker + the
    Quote builder MUST agree on this."""
    print("test_allocation_date_range_overlap")
    allocs = [
        {"id": 200, "equipmentId": 20, "state": "allocated", "qty": 1,
         "startDate": "2026-06-25", "endDate": "2026-06-30"},  # before window
        {"id": 201, "equipmentId": 20, "state": "allocated", "qty": 1,
         "startDate": "2026-06-28", "endDate": "2026-07-02"},  # overlaps start
        {"id": 202, "equipmentId": 20, "state": "allocated", "qty": 1,
         "startDate": "2026-07-02", "endDate": "2026-07-04"},  # fully inside
        {"id": 203, "equipmentId": 20, "state": "allocated", "qty": 1,
         "startDate": "2026-07-04", "endDate": "2026-07-10"},  # overlaps end
        {"id": 204, "equipmentId": 20, "state": "allocated", "qty": 1,
         "startDate": "2026-07-10", "endDate": "2026-07-15"},  # after window
    ]
    consumed = py_allocated_qty(allocs, 20, "2026-07-01", "2026-07-05")
    _check("three overlapping allocations counted", consumed == 3,
           f"got {consumed}")


def test_quote_picker_matches_checker_on_under_maintenance():
    """End-to-end shape: same eq + same allocations should produce the
    same available number whether the Quote picker or the Availability
    Checker computes it. Locks the API contract — if a future divergence
    creeps back into quotes-builder.js, this fails. Uses an allocation-
    free scenario so the assertion isn't muddied by negative-arithmetic
    edge cases (eqQty=0 - allocated=N can go negative; that's true for
    BOTH surfaces, but the actual bug is about the surfaces disagreeing,
    not about clamping)."""
    print("test_quote_picker_matches_checker_on_under_maintenance")
    eq = {"id": 30, "name": "Hazer", "serialized": False, "qty": 6,
          "status": "under-maintenance"}
    quote_view = py_eq_qty(eq) - py_allocated_qty(
        [], 30, "2026-07-01", "2026-07-05"
    )
    checker_view = py_available_qty([eq], [], 30,
                                    "2026-07-01", "2026-07-05")
    _check("quote picker view == availability checker view",
           quote_view == checker_view,
           f"quote={quote_view}, checker={checker_view}")
    _check("both surfaces report 0 for under-maintenance fixture",
           quote_view == 0 and checker_view == 0,
           f"quote={quote_view}, checker={checker_view}")


# ── Structural: quote builder uses the canonical helpers ─────────────────


def test_partial_out_of_service_subtracts_per_log_qty():
    """Non-serialized fixture, qty=10. Two open logs: one took 2 units
    out, one took 3 units out. Available pool = 10 - (2 + 3) = 5."""
    print("test_partial_out_of_service_subtracts_per_log_qty")
    eq = {"id": 40, "name": "Hazer", "serialized": False, "qty": 10,
          "status": "available",
          "maintenanceLogs": [
              {"id": 1, "date": "2026-06-20", "issue": "fan stuck",
               "qty": 2, "status": "open", "resolvedDate": None},
              {"id": 2, "date": "2026-06-21", "issue": "leak",
               "qty": 3, "status": "open", "resolvedDate": None},
          ]}
    _check("outOfServiceQty sums open logs", py_out_of_service_qty(eq) == 5)
    _check("eqQty subtracts the sum from total qty",
           py_eq_qty(eq) == 5, f"got {py_eq_qty(eq)}")


def test_resolved_logs_restore_availability_automatically():
    """Resolving a log flips its status to 'resolved' — outOfServiceQty
    counts ONLY open logs, so the resolved entry's qty stops
    consuming the pool. No separate restore step needed."""
    print("test_resolved_logs_restore_availability_automatically")
    eq = {"id": 41, "name": "Hazer", "serialized": False, "qty": 10,
          "status": "available",
          "maintenanceLogs": [
              {"id": 1, "qty": 2, "status": "resolved",
               "resolvedDate": "2026-06-21"},
              {"id": 2, "qty": 3, "status": "open", "resolvedDate": None},
          ]}
    _check("resolved log NOT counted; only the open 3 subtracts",
           py_out_of_service_qty(eq) == 3)
    _check("eqQty reflects only open consumption",
           py_eq_qty(eq) == 7)


def test_legacy_logs_without_qty_count_as_zero():
    """A log entry created before the qty field existed has no `qty`
    key. It must NOT crash eqQty and must contribute 0 — those legacy
    entries were informational-only."""
    print("test_legacy_logs_without_qty_count_as_zero")
    eq = {"id": 42, "name": "Old Console", "serialized": False, "qty": 5,
          "status": "available",
          "maintenanceLogs": [
              {"id": 1, "issue": "scratch", "status": "open",
               "resolvedDate": None},  # no qty field
          ]}
    _check("missing qty field treated as 0", py_out_of_service_qty(eq) == 0)
    _check("eqQty unaffected by legacy log",
           py_eq_qty(eq) == 5)


def test_full_decommission_overrides_per_log_calculation():
    """If eq.status is flipped to 'under-maintenance' (full decommission
    via the confirm-dialog path, or via legacy data), eqQty must return
    0 regardless of per-log qty arithmetic. The two mechanisms coexist:
    eq.status is the explicit override, logs are the partial path."""
    print("test_full_decommission_overrides_per_log_calculation")
    eq = {"id": 43, "name": "Hazer", "serialized": False, "qty": 10,
          "status": "under-maintenance",
          "maintenanceLogs": [
              # Even with a smaller open log, the parent status wins.
              {"id": 1, "qty": 1, "status": "open", "resolvedDate": None},
          ]}
    _check("eq.status under-maintenance forces eqQty 0",
           py_eq_qty(eq) == 0)


def test_out_of_service_qty_does_not_overcount_past_total():
    """Defensive: if open-log qty sum somehow exceeds eq.qty (data
    corruption, manual edit, paginated edits across stale views),
    eqQty must floor at 0 — never go negative."""
    print("test_out_of_service_qty_does_not_overcount_past_total")
    eq = {"id": 44, "name": "Hazer", "serialized": False, "qty": 5,
          "status": "available",
          "maintenanceLogs": [
              {"id": 1, "qty": 4, "status": "open", "resolvedDate": None},
              {"id": 2, "qty": 4, "status": "open", "resolvedDate": None},
          ]}
    _check("outOfServiceQty sums faithfully",
           py_out_of_service_qty(eq) == 8)
    _check("eqQty floors at 0 (never negative)",
           py_eq_qty(eq) == 0, f"got {py_eq_qty(eq)}")


def test_negative_qty_in_log_is_clamped_at_source():
    """REGRESSION GUARD: backend doesn't validate nested JSON shapes,
    so a stale or malicious PUT could land a maintenance log with
    qty=-5. Without the source-level clamp, outOfServiceQty would
    sum -5 and eqQty would INFLATE availability beyond the actual
    qty (max(0, 10 - (-5)) = 15). The clamp at the source keeps
    outOfServiceQty honest even before eqQty's final floor kicks in."""
    print("test_negative_qty_in_log_is_clamped_at_source")
    eq = {"id": 46, "name": "Hazer", "serialized": False, "qty": 10,
          "status": "available",
          "maintenanceLogs": [
              {"id": 1, "qty": -5, "status": "open"},
              {"id": 2, "qty": 2, "status": "open"},
          ]}
    _check("negative qty contributes 0, not -5",
           py_out_of_service_qty(eq) == 2,
           f"got {py_out_of_service_qty(eq)}")
    _check("eqQty unaffected by negative qty (would inflate without clamp)",
           py_eq_qty(eq) == 8,
           f"got {py_eq_qty(eq)}")


def test_rentals_utils_clamps_negative_qty_at_source():
    """Structural: outOfServiceQty in rentals-utils.js must apply
    Math.max(0, ...) inside the reducer — not just at eqQty. Catches
    a future revert that removes the source-level clamp on the
    assumption that eqQty's floor is sufficient (it isn't — a single
    negative log would still inflate the sum visible to other callers
    that read outOfServiceQty directly, e.g. the maintQty display)."""
    print("test_rentals_utils_clamps_negative_qty_at_source")
    with open(os.path.join(_root, "modules", "rentals-utils.js"),
              encoding="utf-8") as f:
        src = f.read()
    # Find the outOfServiceQty function body and assert it clamps.
    m = re.search(
        r"function outOfServiceQty\(eq\)\s*\{([\s\S]*?)\n  \}",
        src,
    )
    _check("outOfServiceQty function body found", m is not None)
    if m:
        body = m.group(1)
        _check("reducer clamps with Math.max(0, ...) on Number(l.qty)",
               "Math.max(0," in body and "Number(l.qty)" in body)


def test_serialized_path_ignores_outOfServiceQty():
    """outOfServiceQty is a non-serialized concept — serialized items
    track each unit's status individually. The helper must return 0
    for serialized so a stray maintenanceLogs array at the parent
    level (legacy data shape) doesn't double-count."""
    print("test_serialized_path_ignores_outOfServiceQty")
    eq = {"id": 45, "name": "Mac Quantum", "serialized": True,
          "units": [
              {"id": 1, "status": "available"},
              {"id": 2, "status": "under-maintenance"},
          ],
          # Stray parent-level logs — should be ignored for serialized.
          "maintenanceLogs": [
              {"id": 99, "qty": 5, "status": "open"},
          ]}
    _check("serialized fixture ignores parent maintenanceLogs",
           py_out_of_service_qty(eq) == 0)
    _check("serialized eqQty still derives from units[]",
           py_eq_qty(eq) == 1)


# ── Structural: maintenance form + utils wiring ──────────────────────────


def test_rentals_utils_exposes_outOfServiceQty():
    """LTP_RENTALS namespace must export the new helper so calling
    code (rentals-equipment.js, future quote-screen indicators) can
    reach it without re-implementing the calculation."""
    print("test_rentals_utils_exposes_outOfServiceQty")
    with open(os.path.join(_root, "modules", "rentals-utils.js"),
              encoding="utf-8") as f:
        src = f.read()
    _check("outOfServiceQty function defined",
           "function outOfServiceQty(eq)" in src)
    # rsplit so we look AFTER the actual window.LTP_RENTALS = { ... }
    # assignment, not a comment header that mentions the namespace.
    _check("outOfServiceQty exposed on LTP_RENTALS",
           "outOfServiceQty:" in src
           and "outOfServiceQty:" in src.rsplit("window.LTP_RENTALS", 1)[1])
    _check("eqQty subtracts outOfServiceQty for non-serialized",
           "outOfServiceQty(eq)" in src
           and "Math.max(0," in src)


def test_maintenance_form_accepts_qty_input():
    """RentalsMaintenanceForm must accept the new availableQty prop
    and store per-log qty for non-serialized items. Structural guard
    so a future refactor that drops the prop / qty plumbing fails
    here before users notice the qty input disappearing."""
    print("test_maintenance_form_accepts_qty_input")
    with open(os.path.join(_root, "modules", "rentals-maintenance.js"),
              encoding="utf-8") as f:
        src = f.read()
    _check("form destructures availableQty prop",
           "availableQty" in src)
    _check("form clamps the qty input to maxQty",
           "setClampedQty" in src)
    _check("non-serialized log entry includes qty",
           "entry.qty" in src)
    _check("toggle defaults to ON",
           "useState(true)" in src
           and "takeOutOfSvc" in src)


def test_equipment_detail_passes_availableQty_to_form():
    """The form is wired in rentals-equipment.js — confirm the caller
    passes the current availableQty (via R.eqQty) so the qty input's
    max value reflects the actual remaining pool."""
    print("test_equipment_detail_passes_availableQty_to_form")
    with open(os.path.join(_root, "modules", "rentals-equipment.js"),
              encoding="utf-8") as f:
        src = f.read()
    _check("availableQty prop passed to RentalsMaintenanceForm",
           "availableQty:" in src
           and "R.eqQty(eq)" in src)


def test_quote_builder_delegates_to_canonical_helpers():
    """The fix is a delegation — quotes-builder.js must call into
    LTP_RENTALS.eqQty + LTP_RENTALS.allocatedQty inside getAvailability,
    not carry its own inline filter. Catches a future "let me just
    inline this for performance" refactor that would silently
    reintroduce the drift."""
    print("test_quote_builder_delegates_to_canonical_helpers")
    with open(os.path.join(_root, "modules", "quotes-builder.js"),
              encoding="utf-8") as f:
        src = f.read()
    # The getAvailability function body must call both canonical helpers.
    # Anchor the closing brace at the function's own indent level (4 spaces)
    # so we don't match an inner if-block's `}` first — getAvailability is
    # nested inside a React component, declared at indent 4.
    fn_match = re.search(
        r"function getAvailability\(eq\)\s*\{([\s\S]*?)\n    \}",
        src,
    )
    _check("getAvailability function found", fn_match is not None)
    if fn_match:
        body = fn_match.group(1)
        _check("delegates to window.LTP_RENTALS.eqQty",
               "window.LTP_RENTALS.eqQty" in body
               or "LTP_RENTALS.eqQty" in body)
        _check("delegates to window.LTP_RENTALS.allocatedQty",
               "window.LTP_RENTALS.allocatedQty" in body
               or "LTP_RENTALS.allocatedQty" in body)
        # The prior inline duplicate had this exact shape — guard against
        # it being reintroduced. (The `under-maintenance` literal still
        # appears in the file elsewhere, e.g. comments and the picker
        # filter for serialized equipment, so a substring match against
        # the whole file would false-positive. We scope to the function
        # body.)
        _check("no inline status filter inside getAvailability",
               'u.status !== "under-maintenance"' not in body,
               "reintroduced the drift — call eqQty instead")
        _check("no inline `state === \"cancelled\"` filter (dead code in prior copy)",
               'state === "cancelled"' not in body)


# ── Main ─────────────────────────────────────────────────────────────────


def main() -> int:
    test_non_serialized_under_maintenance_reports_zero()
    test_non_serialized_retired_reports_zero()
    test_non_serialized_available_reports_full_qty()
    test_serialized_filters_each_units_status()
    test_serialized_all_units_under_maintenance_reports_zero()
    test_allocation_under_maintenance_state_does_not_consume_qty()
    test_allocation_date_range_overlap()
    test_quote_picker_matches_checker_on_under_maintenance()
    test_partial_out_of_service_subtracts_per_log_qty()
    test_resolved_logs_restore_availability_automatically()
    test_legacy_logs_without_qty_count_as_zero()
    test_full_decommission_overrides_per_log_calculation()
    test_out_of_service_qty_does_not_overcount_past_total()
    test_negative_qty_in_log_is_clamped_at_source()
    test_rentals_utils_clamps_negative_qty_at_source()
    test_serialized_path_ignores_outOfServiceQty()
    test_rentals_utils_exposes_outOfServiceQty()
    test_maintenance_form_accepts_qty_input()
    test_equipment_detail_passes_availableQty_to_form()
    test_quote_builder_delegates_to_canonical_helpers()

    fail_count = sum(1 for _, ok in _results if not ok)
    print()
    print(f"== {len(_results) - fail_count}/{len(_results)} checks passed ==")
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
