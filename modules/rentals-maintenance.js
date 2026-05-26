// Rentals — Maintenance Form Modal
// Depends on: rentals-utils.js
(function() {
  var h = React.createElement, useState = React.useState;
  var B = window.LTP_THEME;

  window.RentalsMaintenanceForm = function({ onClose, onSave, serialized, selectedUnit }) {
    var R = window.LTP_RENTALS;
    var [issue,          setIssue]          = useState("");
    var [date,           setDate]           = useState(R.today());
    var [setUnderMaint,  setSetUnderMaint]  = useState(false);
    var [showConfirm,    setShowConfirm]    = useState(false);

    function attemptSave() {
      if (!issue.trim()) return;
      // Non-serialized + decommission: need confirmation first
      if (!serialized && setUnderMaint) {
        setShowConfirm(true);
      } else {
        onSave({ id: Date.now(), date: date, issue: issue.trim(), status: "open", resolvedDate: null }, setUnderMaint);
      }
    }

    // Confirmation dialog for non-serialized full-qty decommission
    if (showConfirm) {
      return h(window.LTPModal, { title: "Confirm: Set All Units to Under Maintenance", onClose: function() { setShowConfirm(false); }, disableBackdrop: true },
        h("div", { style: { display: "flex", flexDirection: "column", gap: 16 } },
          h("div", { style: { background: B.warnBg, border: "1px solid " + B.warnBd, borderRadius: 8, padding: "14px", fontSize: "13px", color: B.warn, lineHeight: 1.6 } },
            "This will move ", h("strong", null, "all units"), " of this equipment to ", h("strong", null, "Under Maintenance"), " status. They will not appear as available for new allocations until their status is restored."
          ),
          h("div", { style: { fontSize: "12px", color: B.textSec } }, "Issue being logged: \"" + issue + "\""),
          h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
            h(window.Btn, { variant: "ghost", onClick: function() { setShowConfirm(false); } }, "Cancel"),
            h(window.Btn, { onClick: function() {
              onSave({ id: Date.now(), date: date, issue: issue.trim(), status: "open", resolvedDate: null }, true);
            }}, "Confirm — Set Under Maintenance")
          )
        )
      );
    }

    var unitLabel = selectedUnit ? (selectedUnit.barcode || selectedUnit.serial || null) : null;

    return h(window.LTPModal, { title: "Log Issue" + (unitLabel ? " \u2014 " + unitLabel : ""), onClose: onClose, disableBackdrop: true },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },
        R.Field("Date", h("input", { type: "date", value: date, onChange: function(e) { setDate(e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
        R.Field("Issue Description", h("textarea", { value: issue, onChange: function(e) { setIssue(e.target.value); }, rows: 3, placeholder: "Describe the issue...", style: Object.assign({}, R.INP, { width: "100%", resize: "vertical" }) })),

        // Decommission toggle
        h("div", { style: { background: B.dangerBg, border: "1px solid " + B.dangerBd, borderRadius: 8, padding: "12px 14px" } },
          h("label", { style: { display: "flex", alignItems: "center", gap: 10, cursor: "pointer" } },
            h("input", { type: "checkbox", checked: setUnderMaint, onChange: function(e) { setSetUnderMaint(e.target.checked); }, style: { accentColor: B.danger, width: 15, height: 15 } }),
            h("div", null,
              h("div", { style: { fontSize: "13px", fontWeight: 600, color: B.danger } },
                serialized ? "Set this unit to Under Maintenance" : "Set all units to Under Maintenance"
              ),
              h("div", { style: { fontSize: "11px", color: B.textMut, marginTop: 2 } },
                serialized
                  ? "Unit " + (unitLabel || "") + " will be marked unavailable until restored."
                  : "All qty will be marked unavailable. A confirmation is required."
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
