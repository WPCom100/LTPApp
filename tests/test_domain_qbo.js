#!/usr/bin/env node
// components/domain-qbo.js — the QuickBooks Online export decisions.
//
// WHY THIS SUITE EXISTS
//   A QuickBooks invoice is a record a customer may already be holding, and
//   these three functions decide whether a push may happen, what a response
//   means, and what it writes back onto our copy. Getting the last one wrong
//   loses qbSyncToken — which is what lets the NEXT push UPDATE that invoice
//   rather than create a second one — or overwrites qbTaxTotal, the sales tax
//   QuickBooks itself calculated.
//
//   All three lived inside the invoice builder's fetch orchestration, so none
//   of them could be tested.
//
// Pure Node, zero deps.
//   Run:  node tests/test_domain_qbo.js
"use strict";
const { loadDomain } = require("./_load_domain.js");
loadDomain();

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(n, g === w, g === w ? "" : "got " + g + " want " + w);
}

const BLOCK = window.LTP_qboPushBlocker;
const APPLY = window.LTP_applyQboPush;
const OUT = window.LTP_qboPushOutcome;
["LTP_qboPushBlocker", "LTP_applyQboPush", "LTP_qboPushOutcome"].forEach(function (k) {
  ok("Q0 " + k + " is exported", typeof window[k] === "function");
});

// ── May this invoice be pushed? ─────────────────────────────────────────────
const CONNECTED = { connected: true };
const SENT = { id: 7, sentDate: "2026-08-10" };

ok("Q1 a saved, sent invoice by an admin on a connected workspace may push",
   BLOCK(SENT, true, CONNECTED) === null);

eq("Q2 an unsaved invoice is blocked", BLOCK({ id: null, sentDate: "x" }, true, CONNECTED).title, "Save first");
eq("Q3 an unsent invoice is blocked",
   BLOCK({ id: 7 }, true, CONNECTED).title, "Send the invoice first");
// ...but an already-exported invoice is exempt: it is being UPDATED, and its
// QuickBooks record already exists.
ok("Q4 an unsent invoice that was ALREADY pushed may push again (it is an update)",
   BLOCK({ id: 7, qbInvoiceId: "QB-1" }, true, CONNECTED) === null);
eq("Q5 a non-admin is blocked", BLOCK(SENT, false, CONNECTED).title, "Admin only");
eq("Q6 a disconnected workspace is blocked",
   BLOCK(SENT, true, { connected: false }).title, "QuickBooks not connected");
eq("Q7 a missing qbo object is blocked",
   BLOCK(SENT, true, null).title, "QuickBooks not connected");

// Order matters: an unsaved invoice must report "save first", not "admin only".
eq("Q8 the unsaved check runs before the admin check",
   BLOCK({ id: null }, false, null).title, "Save first");
eq("Q9 the unsent check runs before the admin check",
   BLOCK({ id: 7 }, false, null).title, "Send the invoice first");
ok("Q10 a null invoice is blocked rather than throwing",
   (function () { try { return BLOCK(null, true, CONNECTED).title === "Save first"; }
                  catch (e) { return "threw: " + e.message; } })() === true);
// Blockers are all "warn": they describe something the user can fix, not a
// failure. Asserting only that a variant EXISTS let a mutation flip one to
// "error" unnoticed.
eq("Q10b every blocker is a warning, not an error",
   [BLOCK({}, true, CONNECTED), BLOCK({ id: 1 }, true, CONNECTED),
    BLOCK(SENT, false, CONNECTED), BLOCK(SENT, true, null)].map((b) => b.variant),
   ["warn", "warn", "warn", "warn"]);
ok("Q11 every blocker carries a title, message and variant",
   [BLOCK({}, true, CONNECTED), BLOCK({ id: 1 }, true, CONNECTED),
    BLOCK(SENT, false, CONNECTED), BLOCK(SENT, true, null)]
     .every((b) => b && b.title && b.message && b.variant));

// ── Folding a successful push onto the invoice ──────────────────────────────
const INV = { id: 7, status: "sent", qbLastError: "an old failure", other: "kept" };
const BODY = { qbInvoiceId: "QB-99", qbSyncToken: "3", qbSyncedAt: "2026-08-29T10:00:00Z",
               qbTaxTotal: 82.5, qbTotalAmt: 1082.5, qbSyncedSignature: "sig-from-server",
               action: "created" };
let merged = APPLY(INV, BODY, "sig-we-sent");
eq("Q12 the QuickBooks invoice id is recorded", merged.qbInvoiceId, "QB-99");
eq("Q13 the sync TOKEN is recorded (without it the next push duplicates)",
   merged.qbSyncToken, "3");
eq("Q14 QuickBooks' calculated sales tax is recorded", merged.qbTaxTotal, 82.5);
eq("Q15 QuickBooks' total is recorded", merged.qbTotalAmt, 1082.5);
eq("Q16 the status becomes synced", merged.qbSyncStatus, "synced");
eq("Q17 a previous error is cleared", merged.qbLastError, null);
eq("Q18 unrelated invoice fields survive", [merged.id, merged.status, merged.other],
   [7, "sent", "kept"]);
ok("Q19 the input invoice is not mutated", INV.qbInvoiceId === undefined);

// The signature is what later renders compare against to decide "out of sync".
eq("Q20 the server's echoed signature is preferred", merged.qbSyncedSignature, "sig-from-server");
eq("Q21 ...falling back to the signature we sent, if the server omits it",
   APPLY(INV, Object.assign({}, BODY, { qbSyncedSignature: undefined }), "sig-we-sent").qbSyncedSignature,
   "sig-we-sent");
eq("Q22 an explicitly null echoed signature also falls back",
   APPLY(INV, Object.assign({}, BODY, { qbSyncedSignature: null }), "sig-we-sent").qbSyncedSignature,
   "sig-we-sent");
// An empty string is a real value the server chose — do NOT fall back over it.
eq("Q23 an empty echoed signature is honoured, not replaced",
   APPLY(INV, Object.assign({}, BODY, { qbSyncedSignature: "" }), "sig-we-sent").qbSyncedSignature, "");
ok("Q24 a missing body does not throw",
   (function () { try { return APPLY(INV, null, "s").qbSyncStatus === "synced"; }
                  catch (e) { return "threw: " + e.message; } })() === true);

// ── Reading the response ────────────────────────────────────────────────────
const money = (n) => "$" + Number(n).toFixed(2);
let o = OUT({ status: 200, body: { action: "created", qbTaxTotal: 82.5 } }, money);
eq("Q25 a created push is ok", o.ok, true);
eq("Q26 ...titled as a send", o.title, "Sent to QuickBooks");
ok("Q27 ...and reports the tax QuickBooks calculated", /82\.50/.test(o.message), o.message);
o = OUT({ status: 200, body: { action: "updated" } }, money);
eq("Q28 an updated push is titled as an update", o.title, "Updated in QuickBooks");
ok("Q29 ...and says nothing about tax when there is none", !/tax/.test(o.message), o.message);

// `action` is what decides whether a failed send may DELETE the QuickBooks
// invoice afterwards. Only a create is ours to delete.
eq("Q30 the action is carried through for the unwind decision",
   [OUT({ status: 200, body: { action: "created" } }).action,
    OUT({ status: 200, body: { action: "updated" } }).action], ["created", "updated"]);
eq("Q31 the QuickBooks id is carried through for the unwind",
   OUT({ status: 200, body: { qbInvoiceId: "QB-99" } }).qbInvoiceId, "QB-99");

eq("Q32 a 409 reconnect is classified", OUT({ status: 409, body: { reason: "reconnect" } }).reason, "reconnect");
eq("Q33 ...and titled so an admin knows to act", OUT({ status: 409, body: { reason: "reconnect" } }).title,
   "Reconnect QuickBooks");
eq("Q34 a 409 not_connected is classified",
   OUT({ status: 409, body: { reason: "not_connected" } }).reason, "not_connected");
eq("Q35 ...as a warning rather than an error",
   OUT({ status: 409, body: { reason: "not_connected" } }).variant, "warn");
eq("Q36 a reconnect reason on a NON-409 is not a reconnect",
   OUT({ status: 500, body: { reason: "reconnect" } }).reason, "reconnect");
ok("Q37 ...and is titled generically", OUT({ status: 500, body: { reason: "reconnect" } }).title
   === "QuickBooks sync failed", OUT({ status: 500, body: { reason: "reconnect" } }).title);
eq("Q38 a server error message is surfaced verbatim",
   OUT({ status: 500, body: { error: "Customer not found in QuickBooks" } }).message,
   "Customer not found in QuickBooks");
ok("Q39 with no message, the status is still surfaced",
   /502/.test(OUT({ status: 502, body: {} }).message), OUT({ status: 502, body: {} }).message);
eq("Q40 an unknown failure carries a generic reason", OUT({ status: 502, body: {} }).reason, "error");
ok("Q41 a null response does not throw",
   (function () { try { return OUT(null).ok === false; } catch (e) { return "threw: " + e.message; } })() === true);
ok("Q42 every outcome carries a title, message and variant",
   [OUT({ status: 200, body: {} }), OUT({ status: 409, body: { reason: "reconnect" } }),
    OUT({ status: 409, body: { reason: "not_connected" } }), OUT({ status: 500, body: {} }), OUT(null)]
     .every((x) => x && x.title && x.message && x.variant));
// The money formatter is injected; without one it must still produce a message.
ok("Q43 no money formatter still yields a message",
   typeof OUT({ status: 200, body: { qbTaxTotal: 5 } }).message === "string");

// ── Reading a route's answer without assuming JSON ──────────────────────────
// The push before an invoice send did `r.json()` on whatever came back. A route
// that failed outside its own error mapping answered FastAPI's plain-text
// "Internal Server Error", and the producer was shown the parser's complaint
// ("Unexpected token 'I' ... is not valid JSON") instead of a status.
const READ = window.LTP_readJsonResponse;
ok("R0 LTP_readJsonResponse is exported", typeof READ === "function");
function fakeResp(status, text) { return { status: status, text: () => Promise.resolve(text) }; }

const asyncChecks = Promise.resolve()
  .then(() => READ(fakeResp(200, '{"action":"created","qbTaxTotal":8.25}')))
  .then((r) => eq("R1 a JSON body parses as before", r, { status: 200, body: { action: "created", qbTaxTotal: 8.25 } }))
  .then(() => READ(fakeResp(500, "Internal Server Error")))
  .then((r) => {
    eq("R2 a plain-text 500 keeps its status", r.status, 500);
    ok("R3 and reads as an HTTP error, not a parser complaint",
       /^HTTP 500 — Internal Server Error$/.test(r.body.error), r.body.error);
    eq("R4 flagged as non-JSON so consumers can tell", r.body.reason, "non_json");
    ok("R5 and the outcome mapper turns it into a failure that names the status",
       OUT(r).ok === false && /HTTP 500/.test(OUT(r).message), OUT(r).message);
  })
  .then(() => READ(fakeResp(502, "")))
  .then((r) => ok("R6 an empty body is tolerated", r.body && typeof r.body === "object", JSON.stringify(r.body)))
  .then(() => READ(fakeResp(504, "<html>" + "x".repeat(500) + "</html>")))
  .then((r) => ok("R7 a long HTML page is truncated", r.body.error.length < 200, String(r.body.error.length)));

// ── Adopting a row a route handed back ──────────────────────────────────────
{
  const ADOPT = window.LTP_adoptServerRow;
  ok("S0 LTP_adoptServerRow is exported", typeof ADOPT === "function");
  const seen = [];
  window.LTP_STATE = { adoptRow: (key, row) => { seen.push([key, row._rev]); return true; } };
  const out = ADOPT("invoices", { id: 5, status: "draft", activity: [{ type: "email_sent" }], _rev: "r9" });
  eq("S1 the row is installed into the hook that owns the collection", seen, [["invoices", "r9"]]);
  eq("S2 and a copy without _rev comes back to build the edit on",
     out, { id: 5, status: "draft", activity: [{ type: "email_sent" }] });
  eq("S3 no row (an older server) yields null so callers fall back", ADOPT("invoices", undefined), null);
  eq("S4 a row without an id is refused", ADOPT("invoices", { status: "sent" }), null);
  delete window.LTP_STATE;
  ok("S5 without the state layer it still returns the copy", ADOPT("quotes", { id: 1, _rev: "x" }).id === 1);
}

asyncChecks.then(() => {
  console.log("domain-qbo suite — PASS: " + pass + "   FAIL: " + fail);
  if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
  console.log("All " + pass + " assertions passed.");
}, (e) => { console.error(e); process.exit(1); });
