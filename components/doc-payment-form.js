// Record-a-payment modal for the invoice builder.
//
// Extracted from modules/invoices.js, where it was 35 lines of render plus five
// useState pairs plus an eight-line opener that seeded them — all of it used by
// nothing else in that 1,823-line component. It now owns that state itself, so
// the builder keeps a single `showPaymentForm` boolean and the form's fields
// exist only while it is on screen.
//
// Seeding is unchanged in effect: the old openPaymentForm() set the fields
// immediately before flipping the flag; mounting this component runs the same
// initializers. Closing unmounts it, so reopening starts fresh — which is what
// the old code did explicitly.
//
// Validation stays here because it is about THIS form (is the amount a positive
// number, is there a date, is it more than the balance). What happens to a valid
// payment — appending it, restamping the invoice's status, the QuickBooks
// consequences — stays in the builder, behind onSubmit.
(function() {
  var h = React.createElement, useState = React.useState;
  var B = window.LTP_THEME;

  var METHODS = [
    { value: "check", label: "Check" },
    { value: "ach", label: "ACH / Bank Transfer" },
    { value: "credit_card", label: "Credit Card" },
    { value: "cash", label: "Cash" },
    { value: "wire", label: "Wire Transfer" },
    { value: "other", label: "Other" },
  ];

  // The three figures across the top of the form. `align` is null for the
  // first so the row's space-between does the work, matching what this looked
  // like inline.
  function Stat(label, value, color, align) {
    return h("div", align ? { style: { textAlign: align } } : null,
      h("div", { style: { fontSize: "10px", color: B.textMut } }, label),
      h("div", { style: { fontSize: "14px", fontWeight: 700, color: color } }, "$" + window.LTP_money(value)));
  }

  /**
   * props:
   *   totals    { total, paid, balance } — LTP_INVOICE_TOTALS of the invoice
   *   onSubmit  ({date, amount, method, reference, notes}) -> void
   *   onClose   () -> void
   *   onAlert   (title, message) -> void   — the builder's toast
   */
  window.LTPPaymentForm = function LTPPaymentForm({ totals, onSubmit, onClose, onAlert }) {
    var t = totals || { total: 0, paid: 0, balance: 0 };
    var [date, setDate] = useState(window.LTP_todayISO());
    // Pre-fill with the outstanding balance: the overwhelmingly common case is
    // "they paid it off".
    var [amount, setAmount] = useState(String(Math.round((t.balance > 0 ? t.balance : 0) * 100) / 100));
    var [method, setMethod] = useState("check");
    var [reference, setReference] = useState("");
    var [notes, setNotes] = useState("");

    function submit() {
      var amt = Number(amount);
      if (!amount || amt <= 0) { onAlert("Invalid Amount", "Enter a valid payment amount."); return; }
      if (!date) { onAlert("Missing Date", "Enter a payment date."); return; }
      if (amt > t.balance && t.balance > 0) {
        if (!window.confirm("This payment ($" + window.LTP_money(amt) + ") exceeds the balance due ($"
          + window.LTP_money(t.balance) + "). Record anyway?")) return;
      }
      onSubmit({ date: date, amount: amt, method: method, reference: reference, notes: notes });
    }

    return h(window.LTPModal, { title: "Record Payment", onClose: onClose },
      h("div", { style: { marginBottom: 12 } },
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: B.raised, borderRadius: "6px", border: "1px solid " + B.border } },
          Stat("Invoice Total", t.total, B.accent, null),
          Stat("Already Paid", t.paid, t.paid > 0 ? B.success : B.textMut, "center"),
          Stat("Balance Due", t.balance, t.balance > 0 ? B.warn : B.success, "right"))
      ),
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
        h(window.LTPInput, { label: "Payment Date", value: date, onChange: setDate, type: "date" }),
        h(window.LTPInput, { label: "Amount *", value: amount, onChange: setAmount, type: "number", placeholder: "0.00" })),
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 } },
        h(window.LTPSelect, { label: "Payment Method", value: method, onChange: setMethod, options: METHODS }),
        h(window.LTPInput, { label: "Reference / Check #", value: reference, onChange: setReference, placeholder: "e.g. CHK-4412" })),
      h("div", { style: { marginTop: 12 } },
        h(window.LTPInput, { label: "Notes (optional)", value: notes, onChange: setNotes, placeholder: "Payment notes…" })),
      h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 } },
        h(window.Btn, { variant: "ghost", onClick: onClose }, "Cancel"),
        h(window.Btn, { onClick: submit }, "Record Payment"))
    );
  };
})();
