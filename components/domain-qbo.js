// LTP domain — the QuickBooks Online export decisions.
//
// Split out of the invoice builder, where three functions (sendToQuickBooks,
// persistAndPushQbo, unwindQboPush) mixed fetch orchestration with the rules
// that decide whether a push may happen, what a response means, and what it
// writes back onto the invoice. The orchestration stays in the builder; the
// decisions live here, where they can be tested.
//
// Why that matters more than usual: a QuickBooks invoice is a record a customer
// may already be holding. Misreading a response can write the wrong sales tax
// onto our copy, or lose the sync token that lets the next push update rather
// than duplicate.
//
// LOAD ORDER CONTRACT — read before moving this <script> tag.
//   Loads in index.html's THEME slot with the other domain-*.js files, before
//   every components/ and modules/ file, and belongs in sw.js's
//   SAME_ORIGIN_PRECACHE boot chain. Nothing here reads another LTP_ symbol at
//   load time, so the order among the domain files is free.

// May this invoice be pushed at all? Returns null when it may, or the toast to
// show when it may not.
//
// Four preconditions, each for a different reason:
//   unsaved      the push endpoint takes an id; there isn't one yet
//   never sent   invoices export once they've gone to the customer, so a draft
//                push would create a QuickBooks record for something the
//                customer has not seen. An already-pushed invoice is exempt —
//                it is being UPDATED, not created.
//   not admin    the QuickBooks connection is workspace-level
//   disconnected there is nothing to push to
window.LTP_qboPushBlocker = function(invoice, isAdmin, qbo) {
  var inv = invoice || {};
  if (inv.id == null) {
    return { title: "Save first", variant: "warn",
             message: "Save the invoice before sending it to QuickBooks." };
  }
  if (!inv.sentDate && !inv.qbInvoiceId) {
    return { title: "Send the invoice first", variant: "warn",
             message: "Invoices export to QuickBooks once they've been sent." };
  }
  if (!isAdmin) {
    return { title: "Admin only", variant: "warn",
             message: "Only an admin can push invoices to QuickBooks." };
  }
  if (!qbo || !qbo.connected) {
    return { title: "QuickBooks not connected", variant: "warn",
             message: "An admin must connect QuickBooks in Settings before pushing invoices." };
  }
  return null;
};

// Fold a successful push response onto the invoice.
//
// qbSyncToken is what lets the NEXT push update the same QuickBooks invoice
// instead of creating a second one, and qbTaxTotal is the sales tax QuickBooks
// itself calculated — losing either is a money-visible bug, so this is one
// function rather than two hand-copied object literals.
//
// qbSyncedSignature falls back to the signature we sent: the server echoes it,
// but an older server may not, and without it every subsequent render would
// report the invoice as out of sync.
window.LTP_applyQboPush = function(invoice, body, sentSignature) {
  var b = body || {};
  return Object.assign({}, invoice, {
    qbInvoiceId: b.qbInvoiceId,
    qbSyncToken: b.qbSyncToken,
    qbSyncStatus: "synced",
    qbSyncedAt: b.qbSyncedAt,
    qbTaxTotal: b.qbTaxTotal,
    qbTotalAmt: b.qbTotalAmt,
    qbLastError: null,
    qbSyncedSignature: b.qbSyncedSignature != null ? b.qbSyncedSignature : sentSignature,
  });
};

// What a push response means, and what to tell the user.
//
// `action` is carried through on success because it decides whether a later
// failed send may unwind this push: only a "created" is ours to delete. An
// "updated" means the QuickBooks invoice existed before this push — a resend,
// or an earlier export — and deleting it would destroy a record the customer
// may already hold.
window.LTP_qboPushOutcome = function(resp, money) {
  var fmt = money || function(n) { return String(n); };
  var status = resp && resp.status;
  var b = (resp && resp.body) || {};

  if (status === 200) {
    var created = b.action === "created";
    return {
      ok: true,
      action: b.action,
      qbInvoiceId: b.qbInvoiceId,
      title: created ? "Sent to QuickBooks" : "Updated in QuickBooks",
      variant: "success",
      message: "Invoice " + (created ? "created in" : "updated in") + " QuickBooks"
             + (b.qbTaxTotal ? " — sales tax " + fmt(b.qbTaxTotal) + " calculated by QuickBooks." : "."),
    };
  }
  if (status === 409 && b.reason === "reconnect") {
    return { ok: false, reason: "reconnect", title: "Reconnect QuickBooks", variant: "error",
             message: b.error
               || "The QuickBooks connection expired. An admin should reconnect it in Settings." };
  }
  if (status === 409 && b.reason === "not_connected") {
    return { ok: false, reason: "not_connected", title: "QuickBooks not connected", variant: "warn",
             message: b.error || "An admin must connect QuickBooks in Settings first." };
  }
  return { ok: false, reason: b.reason || "error", title: "QuickBooks sync failed", variant: "error",
           message: b.error || ("HTTP " + status + ".") };
};
