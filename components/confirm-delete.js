// Confirm Delete Dialog
(function() {
  var B = window.LTP_THEME, h = React.createElement;

  window.ConfirmDeleteDialog = function({ deleteConfirm, onCancel, onConfirm }) {
    if (!deleteConfirm) return null;
    return h(window.LTPModal, { title: "Confirm Delete", onClose: onCancel },
      h("div", { style: { marginBottom: 16, fontSize: "13px", color: B.textSec } }, 'Are you sure you want to delete "' + deleteConfirm.name + '"? This cannot be undone.'),
      h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
        h(window.Btn, { variant: "ghost", onClick: onCancel }, "Cancel"),
        h(window.Btn, { variant: "danger", onClick: function() { onConfirm(deleteConfirm); } }, "Delete")
      )
    );
  };
})();
