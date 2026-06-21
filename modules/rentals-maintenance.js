// Rentals — Maintenance Form Modal
// Depends on: rentals-utils.js
//
// Non-serialized equipment supports PARTIAL out-of-service via per-log
// qty. The user picks how many of N units the issue affects (default 1,
// clamped to currently-available); when the "take out of service" toggle
// is on, that qty subtracts from eqQty via LTP_RENTALS.outOfServiceQty.
// When qty equals total still-available we treat it as a full
// decommission and (a) show the same confirmation dialog as before and
// (b) flip eq.status to "under-maintenance" via the existing
// onSetUnderMaintenance path so the Under Maintenance badge appears.
(function() {
  var h = React.createElement, useState = React.useState;
  var B = window.LTP_THEME;

  // RentalsMaintenanceForm props:
  //   serialized      - whether the parent equipment is serialized
  //   selectedUnit    - for serialized only: the chosen unit object
  //   availableQty    - for non-serialized only: currently-available qty
  //                     (eq.qty minus already-out-of-service). When
  //                     omitted (legacy callers), the qty input is
  //                     hidden and the old all-or-nothing toggle stays.
  //   onSave(log, fullDecommission)
  //                   - log includes a `qty` field for non-serialized
  //                     (count of units this issue affects). The second
  //                     arg is true when the user chose to take qty out
  //                     of service AND it equals the full available qty
  //                     (full decommission -> flip eq.status).
  window.RentalsMaintenanceForm = function({ onClose, onSave, serialized, selectedUnit, availableQty }) {
    var R = window.LTP_RENTALS;
    var maxQty = Math.max(1, Number(availableQty) || 1);
    var hasQtyInput = !serialized && availableQty != null && availableQty > 0;

    var [issue,          setIssue]          = useState("");
    var [date,           setDate]           = useState(R.today());
    var [qty,            setQty]            = useState(1);
    var [takeOutOfSvc,   setTakeOutOfSvc]   = useState(true);  // toggle, default ON
    var [showConfirm,    setShowConfirm]    = useState(false);

    function setClampedQty(v) {
      var n = parseInt(v, 10);
      if (isNaN(n) || n < 1) n = 1;
      if (n > maxQty) n = maxQty;
      setQty(n);
    }

    function buildLog(outOfServiceQty) {
      // Non-serialized: persist the per-log qty so eqQty can subtract.
      // Serialized: legacy shape with no qty field.
      var entry = { id: Date.now(), date: date, issue: issue.trim(),
                    status: "open", resolvedDate: null };
      if (!serialized) entry.qty = outOfServiceQty;
      return entry;
    }

    function attemptSave() {
      if (!issue.trim()) return;
      if (serialized) {
        onSave(buildLog(0), takeOutOfSvc);
        return;
      }
      // Non-serialized: qty drives availability. Full decommission only
      // when user takes out the full remaining qty.
      var outQty = takeOutOfSvc ? qty : 0;
      var isFull = takeOutOfSvc && hasQtyInput && qty >= maxQty;
      // Legacy fallback (no availableQty prop): toggle still means full.
      var legacyFull = takeOutOfSvc && !hasQtyInput;
      if (isFull || legacyFull) {
        setShowConfirm(true);
      } else {
        onSave(buildLog(outQty), false);
      }
    }

    // Confirmation dialog for full-qty decommission (non-serialized)
    if (showConfirm) {
      return h(window.LTPModal, { title: "Confirm: Set All Units to Under Maintenance", onClose: function() { setShowConfirm(false); }, disableBackdrop: true },
        h("div", { style: { display: "flex", flexDirection: "column", gap: 16 } },
          h("div", { style: { background: B.warnBg, border: "1px solid " + B.warnBd, borderRadius: 8, padding: "14px", fontSize: "13px", color: B.warn, lineHeight: 1.6 } },
            "This will move ", h("strong", null, "all " + maxQty + " remaining units"), " of this equipment to ", h("strong", null, "Under Maintenance"), " status. They will not appear as available for new allocations until their status is restored."
          ),
          h("div", { style: { fontSize: "12px", color: B.textSec } }, "Issue being logged: \"" + issue + "\""),
          h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
            h(window.Btn, { variant: "ghost", onClick: function() { setShowConfirm(false); } }, "Cancel"),
            h(window.Btn, { onClick: function() {
              onSave(buildLog(hasQtyInput ? qty : 0), true);
            }}, "Confirm — Set Under Maintenance")
          )
        )
      );
    }

    var unitLabel = selectedUnit ? (selectedUnit.barcode || selectedUnit.serial || null) : null;

    return h(window.LTPModal, { title: "Log Issue" + (unitLabel ? " — " + unitLabel : ""), onClose: onClose, disableBackdrop: true },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },
        R.Field("Date", h("input", { type: "date", value: date, onChange: function(e) { setDate(e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
        R.Field("Issue Description", h("textarea", { value: issue, onChange: function(e) { setIssue(e.target.value); }, rows: 3, placeholder: "Describe the issue...", style: Object.assign({}, R.INP, { width: "100%", resize: "vertical" }) })),

        // Qty input - non-serialized only. Hidden when no availableQty
        // is provided (legacy fallback to all-or-nothing toggle).
        hasQtyInput && R.Field(
          "Quantity Affected (of " + maxQty + " still available)",
          h("input", { type: "number", min: 1, max: maxQty, value: qty,
            onChange: function(e) { setClampedQty(e.target.value); },
            style: Object.assign({}, R.INP, { width: "100%" })
          })
        ),

        // Take out of service toggle (default ON)
        h("div", { style: { background: B.dangerBg, border: "1px solid " + B.dangerBd, borderRadius: 8, padding: "12px 14px" } },
          h("label", { style: { display: "flex", alignItems: "center", gap: 10, cursor: "pointer" } },
            h("input", { type: "checkbox", checked: takeOutOfSvc, onChange: function(e) { setTakeOutOfSvc(e.target.checked); }, style: { accentColor: B.danger, width: 15, height: 15 } }),
            h("div", null,
              h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.danger } },
                serialized
                  ? "Set this unit to Under Maintenance"
                  : (hasQtyInput
                      ? "Take " + qty + " unit" + (qty !== 1 ? "s" : "") + " out of service"
                      : "Set all units to Under Maintenance")
              ),
              h("div", { style: { fontSize: "11px", color: B.textMut } },
                serialized
                  ? "Unit " + (unitLabel || "") + " will be marked unavailable until restored."
                  : (hasQtyInput
                      ? (qty >= maxQty
                          ? "All remaining qty will be marked unavailable. A confirmation is required."
                          : qty + " of " + maxQty + " will be marked unavailable. Restore by resolving this log.")
                      : "All qty will be marked unavailable. A confirmation is required.")
              )
            )
          )
        ),

        h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
          h(window.Btn, { variant: "ghost", onClick: onClose }, "Cancel"),
          h(window.Btn, { onClick: attemptSave }, "Log Issue")
        )
      )
    );
  };
})();
