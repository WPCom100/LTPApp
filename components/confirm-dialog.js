// LTPConfirmDialog — generic in-app replacement for native confirm() / alert().
//
// Usage:
//   var [dlg, setDlg] = useState(null);
//
//   // Confirm with action
//   setDlg({
//     title: "Delete Section",
//     message: "Delete this section and all its items?",
//     variant: "danger",             // "danger" | "primary"
//     confirmLabel: "Delete",        // optional, defaults to "Confirm"
//     onConfirm: function() { doDelete(); setDlg(null); },
//   });
//
//   // Alert (info only — no destructive action)
//   setDlg({
//     title: "Missing Information",
//     message: "Please select a company before saving.",
//     variant: "primary",
//     confirmLabel: "OK",
//     alertOnly: true,               // hides Cancel button
//     onConfirm: function() { setDlg(null); },
//   });
//
//   // In render:
//   h(window.LTPConfirmDialog, { dlg: dlg, onCancel: function() { setDlg(null); } })
(function() {
  var B = window.LTP_THEME, h = React.createElement;

  window.LTPConfirmDialog = function({ dlg, onCancel }) {
    if (!dlg) return null;
    var variant      = dlg.variant      || "primary";
    var confirmLabel = dlg.confirmLabel || (variant === "danger" ? "Delete" : "Confirm");
    var alertOnly    = !!dlg.alertOnly;
    return h(window.LTPModal, { title: dlg.title || "Confirm", onClose: onCancel },
      h("div", { style: { marginBottom: 16, fontSize: "13px", color: B.textSec, lineHeight: 1.5 } }, dlg.message),
      h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
        !alertOnly && h(window.Btn, { variant: "ghost", onClick: onCancel }, dlg.cancelLabel || "Cancel"),
        h(window.Btn, { variant: variant === "danger" ? "danger" : undefined, onClick: dlg.onConfirm }, confirmLabel)
      )
    );
  };
})();
