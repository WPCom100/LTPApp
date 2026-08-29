#!/usr/bin/env node
// window.LTP_generateDocPdf — PDF generation for both document builders.
//
// WHY THIS SUITE EXISTS
//   This was 64 lines in the quote builder and 57 in the invoice builder,
//   functionally identical, and untestable in both. It carries the iOS
//   standalone workaround — a home-screen PWA blocks programmatic downloads AND
//   window.open() called after an await, so on mobile a blank tab must be opened
//   SYNCHRONOUSLY inside the click gesture and redirected once the PDF is ready.
//   Get that wrong and the PDF button silently does nothing on a phone, which is
//   exactly the kind of bug nobody notices from a desktop.
//
//   window.fetch is called explicitly by the helper rather than bare, so these
//   tests can stub it — the same reason backend/gmail.py takes an injectable
//   httpx_client.
//
// Pure Node, zero deps.
//   Run:  node tests/test_doc_pdf.js
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0; const fails = [];
function ok(n, c, d) { if (c) pass++; else { fail++; fails.push(n + (d ? "  [" + d + "]" : "")); } }
function eq(n, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(n, g === w, g === w ? "" : "got " + g + " want " + w);
}

// ── Host stubs, recording what the helper does to the page ─────────────────
let opened, anchors, appended, clicked, removed, events, errorsRing;
function resetHost(overrides) {
  opened = []; anchors = []; appended = []; clicked = []; removed = []; events = [];
  errorsRing = [];
  const doc = {
    createElement: function () {
      const a = { href: "", download: "", click: function () { clicked.push(a); } };
      anchors.push(a);
      return a;
    },
    body: { appendChild: function (n) { appended.push(n); }, removeChild: function (n) { removed.push(n); } },
  };
  global.document = doc;
  global.window = Object.assign({
    document: doc,
    open: function () { const w = { location: null, closed: false, close: function () { w.closed = true; } };
                        opened.push(w); return w; },
    dispatchEvent: function (e) { events.push(e); },
    LTP_API_ERRORS: errorsRing,
    LTP_CURRENT_USER: "Dana", LTP_CURRENT_USER_ID: "u7",
    LTP_todayISO: function () { return "2026-08-29"; },
  }, overrides || {});
  global.CustomEvent = function (type, init) { this.type = type; this.detail = (init || {}).detail; };
  (0, eval)(fs.readFileSync(path.join(ROOT, "components", "doc-pdf.js"), "utf8"));
}

function okResponse(body) {
  return { ok: true, status: 200, json: function () { return Promise.resolve(body); } };
}
function errResponse(status, text) {
  return { ok: false, status: status, text: function () { return Promise.resolve(text); } };
}

const RESP = { downloadUrl: "/pdf/abc123", filename: "Quote-Q-2026-001.pdf", token: "tok9" };

(async function () {
  // ── Endpoint and payload ────────────────────────────────────────────────
  let seen = null;
  resetHost({ fetch: function (url, init) { seen = { url: url, init: init }; return Promise.resolve(okResponse(RESP)); } });
  await window.LTP_generateDocPdf({ kind: "quote", id: 12, isMobile: false });
  eq("P1 a quote posts to the quotes PDF endpoint", seen.url, "/api/quotes/12/pdf");
  eq("P2 it is a POST", seen.init.method, "POST");
  eq("P3 it sends the session cookie", seen.init.credentials, "include");

  resetHost({ fetch: function (url) { seen = { url: url }; return Promise.resolve(okResponse(RESP)); } });
  await window.LTP_generateDocPdf({ kind: "invoice", id: 7, isMobile: false });
  eq("P4 an invoice posts to the invoices PDF endpoint", seen.url, "/api/invoices/7/pdf");

  resetHost({ fetch: function (url) { seen = { url: url }; return Promise.resolve(okResponse(RESP)); } });
  await window.LTP_generateDocPdf({ kind: "nonsense", id: 3, isMobile: false });
  eq("P5 an unknown kind falls back to quote rather than building a bad URL",
     seen.url, "/api/quotes/3/pdf");

  // ── Desktop: direct download ────────────────────────────────────────────
  resetHost({ fetch: function () { return Promise.resolve(okResponse(RESP)); } });
  await window.LTP_generateDocPdf({ kind: "quote", id: 12, isMobile: false });
  eq("P6 desktop opens no tab", opened.length, 0);
  eq("P7 desktop creates one download anchor", anchors.length, 1);
  eq("P8 the anchor points at the returned URL", anchors[0].href, "/pdf/abc123");
  eq("P9 the anchor uses the server filename", anchors[0].download, "Quote-Q-2026-001.pdf");
  eq("P10 the anchor is clicked", clicked.length, 1);
  ok("P11 the anchor is added to and removed from the document",
     appended.length === 1 && removed.length === 1, `appended=${appended.length} removed=${removed.length}`);

  // Fallback filename per kind, when the server does not supply one.
  resetHost({ fetch: function () { return Promise.resolve(okResponse({ downloadUrl: "/pdf/x" })); } });
  await window.LTP_generateDocPdf({ kind: "quote", id: 12, isMobile: false });
  eq("P12 a quote falls back to a Q- filename", anchors[0].download, "Q-12.pdf");
  resetHost({ fetch: function () { return Promise.resolve(okResponse({ downloadUrl: "/pdf/x" })); } });
  await window.LTP_generateDocPdf({ kind: "invoice", id: 7, isMobile: false });
  eq("P13 an invoice falls back to an INV- filename", anchors[0].download, "INV-7.pdf");

  // ── Mobile: the iOS standalone workaround ───────────────────────────────
  // The tab MUST be opened before the fetch — after an await, iOS blocks it.
  let openedBeforeFetch = null;
  resetHost({ fetch: function () { openedBeforeFetch = opened.length; return Promise.resolve(okResponse(RESP)); } });
  await window.LTP_generateDocPdf({ kind: "quote", id: 12, isMobile: true });
  eq("P14 mobile opens a tab BEFORE the fetch is issued", openedBeforeFetch, 1);
  eq("P15 mobile redirects that tab to the PDF", opened[0].location, "/pdf/abc123");
  eq("P16 mobile creates no download anchor", anchors.length, 0);

  // ── Failure paths ───────────────────────────────────────────────────────
  resetHost({ fetch: function () { return Promise.resolve(errResponse(500, "boom on the server")); } });
  let threw = null;
  try { await window.LTP_generateDocPdf({ kind: "quote", id: 12, isMobile: false }); }
  catch (e) { threw = e; }
  ok("P17 a non-ok response rejects", threw instanceof Error, String(threw));
  ok("P18 the rejection names the status and body", /500/.test(threw.message) && /boom/.test(threw.message), threw.message);
  eq("P19 no download is attempted on failure", clicked.length, 0);
  eq("P20 the failure is pushed to the API error ring", errorsRing.length, 1);
  ok("P21 the ring entry names the endpoint", /quotes\/12\/pdf/.test(errorsRing[0].label), errorsRing[0].label);
  eq("P22 an ltp-api-error event is dispatched", events.length, 1);
  eq("P23 the event names the operation", events[0].detail.label, "PDF generation");

  // A tab already opened on mobile must be closed, or the user is left staring
  // at a blank page with no explanation.
  resetHost({ fetch: function () { return Promise.resolve(errResponse(500, "x")); } });
  try { await window.LTP_generateDocPdf({ kind: "quote", id: 12, isMobile: true }); } catch (e) {}
  eq("P24 a mobile failure closes the blank tab", opened[0].closed, true);

  // A network-level rejection is reported the same way.
  resetHost({ fetch: function () { return Promise.reject(new Error("offline")); } });
  threw = null;
  try { await window.LTP_generateDocPdf({ kind: "invoice", id: 7, isMobile: false }); }
  catch (e) { threw = e; }
  ok("P25 a network rejection propagates", threw && /offline/.test(threw.message), String(threw));
  eq("P26 ...and is reported to the ring", errorsRing.length, 1);
  ok("P27 the ring entry names the invoice endpoint", /invoices\/7\/pdf/.test(errorsRing[0].label), errorsRing[0].label);

  // ── The activity entry the caller records ───────────────────────────────
  resetHost({ fetch: function () { return Promise.resolve(okResponse(RESP)); } });
  const entry = await window.LTP_generateDocPdf({ kind: "quote", id: 12, isMobile: false });
  eq("P28 the entry is typed pdf_generated", entry.type, "pdf_generated");
  eq("P29 it carries the signed-in user", [entry.user, entry.userId], ["Dana", "u7"]);
  eq("P30 it dates from LTP_todayISO, not a raw clock read", entry.date, "2026-08-29");
  eq("P31 it carries the server's token", entry.pdfToken, "tok9");
  eq("P32 it carries the server's filename", entry.pdfFilename, "Quote-Q-2026-001.pdf");
  ok("P33 it has a message", typeof entry.message === "string" && entry.message.length > 0);
  ok("P34 it has an id", typeof entry.id === "string" && entry.id.indexOf("pdf-") === 0, entry.id);
  ok("P35 it has an HH:MM time", /^\d{2}:\d{2}$/.test(entry.time), entry.time);

  // A missing LTP_API_ERRORS ring must not turn a PDF failure into a crash.
  resetHost({ fetch: function () { return Promise.reject(new Error("x")); }, LTP_API_ERRORS: null });
  threw = null;
  try { await window.LTP_generateDocPdf({ kind: "quote", id: 1, isMobile: false }); } catch (e) { threw = e; }
  ok("P36 a missing error ring does not mask the original failure", threw && /x/.test(threw.message), String(threw));

  console.log("doc-pdf suite — PASS: " + pass + "   FAIL: " + fail);
  if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  x " + f)); process.exit(1); }
  console.log("All " + pass + " assertions passed.");
})();
