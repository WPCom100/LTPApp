#!/usr/bin/env node
// components/data-state.js — the entity sync diff, and specifically what a 409
// on POST is allowed to do.
//
// WHY THIS SUITE EXISTS
//   Entity ids are minted client-side as max(local ids) + 1, so two people
//   creating a record at the same moment mint the same id and the second POST
//   gets a 409. The old code answered every 409 by re-sending the row as a PUT,
//   which silently overwrote whatever record already held that id — including
//   another user's. The fallback is now licensed per id by whether THIS session
//   created it.
//
//   That branch is unreachable through usePersistentState without a real second
//   client, which is why syncEntity is exported and driven directly here.
//
// Pure Node, zero deps.
//   Run:  node tests/test_data_state_sync.js
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

// ── Host stubs ─────────────────────────────────────────────────────────────
let calls, errors, syncEntity;

// `handler` maps a recorded request to {status, body}. Anything it does not
// answer is a 200. Re-evaluating the module per test resets its private
// created-id registry, so tests cannot leak ownership into each other.
function reset(handler) {
  calls = []; errors = [];
  global.console = Object.assign({}, console, { error: function () {} });
  global.window = {
    location: { href: "" },
    dispatchEvent: function () {},
  };
  global.CustomEvent = function (type, init) { this.type = type; this.detail = (init || {}).detail; };
  global.fetch = function (url, opts) {
    opts = opts || {};
    const rec = {
      method: opts.method,
      url: url,
      body: opts.body ? JSON.parse(opts.body) : undefined,
      credentials: opts.credentials,
    };
    calls.push(rec);
    const r = handler(rec) || {};
    const status = r.status || 200;
    if (status >= 200 && status < 300) {
      return Promise.resolve({
        ok: true, status: status,
        json: function () { return Promise.resolve(r.body || {}); },
        text: function () { return Promise.resolve(""); },
      });
    }
    return Promise.resolve({
      ok: false, status: status,
      text: function () { return Promise.resolve(r.text || ""); },
    });
  };
  (0, eval)(fs.readFileSync(path.join(ROOT, "components", "data-state.js"), "utf8"));
  errors = global.window.LTP_API_ERRORS;
  syncEntity = global.window.LTP_STATE.syncEntity;
}

function reqs(method) { return calls.filter(function (c) { return c.method === method; }); }
function urls(method) { return reqs(method).map(function (c) { return c.url; }); }

// Answer every request 200 except the ones named in `bad`, keyed "METHOD url".
function router(bad) {
  return function (rec) { return bad[rec.method + " " + rec.url] || {}; };
}

const Q42 = { id: 42, title: "mine" };
const Q43 = { id: 43, title: "other" };

(async function () {
  // ── The finding: a 409 on a row we did not create must not be written ────
  reset(router({ "POST /api/quotes": { status: 409, text: "quotes 42 already exists" } }));
  let okAll = await syncEntity("quotes", [], [Q42]);
  eq("C1 the POST is attempted", urls("POST"), ["/api/quotes"]);
  eq("C2 no PUT follows a conflict on a row this session did not create", urls("PUT"), []);
  eq("C3 only the one request is made", calls.length, 1);
  ok("C4 the batch reports failure", okAll === false, String(okAll));
  const conflict = errors.filter(function (e) { return /id conflict/.test(e.label); });
  eq("C5 the conflict is reported once", conflict.length, 1);
  ok("C6 the report names the refusal, not a generic failure",
     /Refusing to overwrite/.test(conflict[0].reason || ""), JSON.stringify(conflict[0]));
  ok("C7 the report says the local record is unsaved",
     /NOT saved/.test(conflict[0].reason || ""), JSON.stringify(conflict[0]));

  // ── The legitimate retry: our own POST landed inside a failed batch ──────
  // Sync 1: 42 is created, 43 fails, so the caller does NOT advance its
  // baseline. Sync 2 re-diffs from the same empty baseline and POSTs 42 again.
  reset(router({}));
  let stage = 1;
  global.fetch = (function (inner) {
    return function (url, opts) {
      opts = opts || {};
      const rec = { method: opts.method, url: url, body: opts.body ? JSON.parse(opts.body) : undefined };
      calls.push(rec);
      let status = 200;
      if (stage === 1 && rec.method === "POST" && rec.body.id === 43) status = 500;
      if (stage === 2 && rec.method === "POST" && rec.body.id === 42) status = 409;
      if (status === 200) {
        return Promise.resolve({ ok: true, status: 200,
          json: function () { return Promise.resolve({}); },
          text: function () { return Promise.resolve(""); } });
      }
      return Promise.resolve({ ok: false, status: status, text: function () { return Promise.resolve(""); } });
    };
  })();
  okAll = await syncEntity("quotes", [], [Q42, Q43]);
  ok("R1 a partially failed batch reports failure", okAll === false, String(okAll));
  eq("R2 both rows were POSTed", urls("POST").length, 2);

  stage = 2; calls = [];
  okAll = await syncEntity("quotes", [], [Q42, Q43]);
  eq("R3 the retry re-POSTs both rows", urls("POST").length, 2);
  eq("R4 the 409 on our own row falls back to PUT", urls("PUT"), ["/api/quotes/42"]);
  eq("R5 the PUT carries our copy of the row", reqs("PUT")[0].body, Q42);
  ok("R6 the retry batch now succeeds", okAll === true, String(okAll));

  // ── The licence is per id, not blanket ──────────────────────────────────
  reset(function (rec) {
    if (rec.method === "POST" && rec.body && rec.body.id === 43) return { status: 409 };
    return {};
  });
  await syncEntity("quotes", [], [Q42]);          // creates 42 only
  calls = [];
  okAll = await syncEntity("quotes", [], [Q43]);  // 43 conflicts, never created here
  eq("I1 creating id 42 does not license a fallback for id 43", urls("PUT"), []);
  ok("I2 the id-43 conflict fails the batch", okAll === false, String(okAll));

  // ── The licence is per entity key ───────────────────────────────────────
  reset(function (rec) {
    if (rec.url === "/api/invoices" && rec.method === "POST") return { status: 409 };
    return {};
  });
  await syncEntity("quotes", [], [Q42]);           // creates quotes:42
  calls = [];
  okAll = await syncEntity("invoices", [], [Q42]); // invoices:42 is a different row
  eq("K1 creating quotes/42 does not license a fallback for invoices/42", urls("PUT"), []);
  ok("K2 the cross-key conflict fails the batch", okAll === false, String(okAll));

  // ── Deleting a row gives up the licence for its id ──────────────────────
  // A later locally-minted row can reuse the number (max+1 of a list the row
  // has left), and that new row is not the one we created.
  let deleted = false;
  reset(function (rec) {
    if (rec.method === "DELETE") { deleted = true; return {}; }
    if (rec.method === "POST" && deleted) return { status: 409 };
    return {};
  });
  await syncEntity("quotes", [], [Q42]);            // create 42
  await syncEntity("quotes", [Q42], []);            // delete 42
  ok("D0 the delete really happened", deleted === true, String(deleted));
  calls = [];
  okAll = await syncEntity("quotes", [], [{ id: 42, title: "a different record" }]);
  eq("D1 a deleted id no longer licenses the PUT fallback", urls("PUT"), []);
  ok("D2 the post-delete conflict fails the batch", okAll === false, String(okAll));

  // A DELETE that did not succeed must not revoke anything — the row is still
  // ours, and the next sync retries it.
  let tried = false;
  reset(function (rec) {
    if (rec.method === "DELETE") { tried = true; return { status: 500 }; }
    if (rec.method === "POST" && tried) return { status: 409 };
    return {};
  });
  await syncEntity("quotes", [], [Q42]);
  await syncEntity("quotes", [Q42], []);            // delete fails
  ok("D2b the delete really was attempted", tried === true, String(tried));
  calls = [];
  await syncEntity("quotes", [], [Q42]);
  eq("D3 a failed DELETE leaves the id ours, so the fallback still applies",
     urls("PUT"), ["/api/quotes/42"]);

  // ── Everything else about the diff still holds ──────────────────────────
  reset(router({}));
  okAll = await syncEntity("quotes", [Q42], [Object.assign({}, Q42, { title: "edited" })]);
  eq("S1 a changed existing row is a PUT", urls("PUT"), ["/api/quotes/42"]);
  eq("S2 no POST for a row already in the baseline", urls("POST"), []);
  ok("S3 a clean batch succeeds", okAll === true, String(okAll));

  reset(router({}));
  okAll = await syncEntity("quotes", [Q42], [Q42]);
  eq("S4 an unchanged row makes no request", calls.length, 0);
  ok("S5 an empty diff succeeds", okAll === true, String(okAll));

  reset(router({}));
  await syncEntity("quotes", [Q42, Q43], [Q43]);
  eq("S6 a removed row is a DELETE", urls("DELETE"), ["/api/quotes/42"]);

  reset(router({}));
  await syncEntity("quotes", [], [Q42]);
  eq("S7 a create POSTs to the collection, not the row", urls("POST"), ["/api/quotes"]);
  eq("S8 the create carries the row body", reqs("POST")[0].body, Q42);
  eq("S9 the session cookie is sent", reqs("POST")[0].credentials, "include");

  // A 409 answering a PUT is a different thing entirely and gets no fallback.
  reset(router({ "PUT /api/quotes/42": { status: 409 } }));
  okAll = await syncEntity("quotes", [Q42], [Object.assign({}, Q42, { title: "edited" })]);
  eq("S10 a 409 on PUT is not retried", calls.length, 1);
  ok("S11 a 409 on PUT fails the batch", okAll === false, String(okAll));

  // A non-409 POST failure is not a conflict and must not be reported as one.
  reset(router({ "POST /api/quotes": { status: 422, text: "bad field" } }));
  okAll = await syncEntity("quotes", [], [Q42]);
  eq("S12 a 422 on POST issues no PUT", urls("PUT"), []);
  eq("S13 a 422 is not reported as an id conflict",
     errors.filter(function (e) { return /id conflict/.test(e.label); }).length, 0);
  ok("S14 a 422 fails the batch", okAll === false, String(okAll));

  // A licensed id does not license every later failure on that id: only 409
  // means "the row is already there", and only 409 may become a PUT.
  let posts = 0;
  reset(function (rec) {
    if (rec.method !== "POST") return {};
    posts++;
    return posts > 1 ? { status: 422, text: "bad field" } : {};
  });
  await syncEntity("quotes", [], [Q42]);            // creates 42 — id now ours
  calls = [];
  okAll = await syncEntity("quotes", [], [Q42]);    // 422 this time, not 409
  eq("S15 a 422 on an id we DID create is still not a PUT", urls("PUT"), []);
  ok("S16 that 422 fails the batch", okAll === false, String(okAll));

  // A conflict alongside a healthy row: the healthy row still lands, the batch
  // still reports failure so the baseline does not advance past the conflict.
  reset(function (rec) {
    if (rec.method === "POST" && rec.body && rec.body.id === 42) return { status: 409 };
    return {};
  });
  okAll = await syncEntity("quotes", [], [Q42, Q43]);
  eq("B1 the non-conflicting row is still created", reqs("POST").filter(function (c) {
    return c.body.id === 43;
  }).length, 1);
  eq("B2 the conflicting row is not written", urls("PUT"), []);
  ok("B3 one conflict fails the whole batch", okAll === false, String(okAll));

  console.log("data-state sync suite — PASS: " + pass + "   FAIL: " + fail);
  if (fail) { fails.forEach(function (f) { console.log("  FAIL " + f); }); process.exit(1); }
  console.log("All " + pass + " assertions passed.");
})();
