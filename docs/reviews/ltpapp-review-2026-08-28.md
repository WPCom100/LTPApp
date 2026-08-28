# LTPApp — Comprehensive Codebase Review

**Date:** 2026-08-28
**Scope:** Full read-only audit. No code was modified. This report is the only file written.
**Commit reviewed:** `b2f3d9a` (branch `claude/ltpapp-codebase-audit-intqsc`)
**Method:** 20 category finders over the full tree, then adversarial refutation of every Critical/High/Medium
finding, then three completeness critics (unread-files, cross-cutting, attacker-path). 145 review passes total.
Three findings were refuted and dropped; ~70 were narrowed or severity-corrected by the refutation pass.
Findings marked **Critical** or **High** were additionally re-verified by hand against source, and the Critical
was reproduced by executing the real code.

---

## Stack correction

The brief described a TypeScript app with a Railway Functions prod→dev DB copy, mid-conversion to a PWA.
Two of those three are wrong:

| Briefed | Actual |
|---|---|
| TypeScript | **No TypeScript at all** — zero `.ts`/`.tsx`. Python 3.11 / FastAPI backend (14.1k lines) plus hand-written ES5-style vanilla JS (30.4k lines). No `package.json`, no bundler, no transpiler, no JSX; every component is `React.createElement`, and every file publishes onto `window`. |
| Railway Postgres + prod→dev copy function | Railway + Postgres **confirmed**. The copy function **does not exist** and per the owner is retired (dev is shut down). Exactly one DB URL env var, read in two places (`backend/database.py:26`, `alembic/env.py:47`); one engine (`backend/database.py:38`); `railway.json` defines no Functions or cron. |
| Being converted to a PWA | **Already a mature PWA.** `sw.js` at `ltp-shell-v57`, manifest, VAPID web push, update-banner flow, and a dedicated CI guard. The gaps are in offline *writes*, not conversion. |

Because dev is down, the shared-`DATABASE_URL` risk is dormant. Noted for whenever dev returns: a second
container running the same three background pollers against prod's database would double-send QuickBooks
payment receipts and payout notifications to real clients (`backend/main.py:166-168`).

---

## 1. Executive summary

The codebase is in better shape than its size suggests. There is no SQL injection anywhere (no raw SQL in
`backend/` at all), no IDOR on the public token surface, thorough indexing, consistent HTTP timeouts on every
`httpx` call, a clean single-head Alembic graph, and an unusually high standard of explanatory comments. The
prior `docs/SECURITY_REVIEW.md` work largely holds up. **What follows is what actually needs attention.**

1. **An overnight shift with a post-midnight break bills 3.5× the correct amount, and the app generates the bad
   input itself.** Reproduced: an 18:00–02:00 call on a $1,000 day rate returns **$3,500**. `theme.js:296-316`.
2. **Internal `notes` are shipped to unauthenticated share-link holders.** The strip list removes
   `internalNotes`/`internal_notes`; the column is `notes`. `backend/routes/view.py:143-144`.
3. **966 assertions across 14 test modules cannot fail under pytest.** Proven by execution, not inference.
   Every test of QuickBooks invoice sync, the receipt poller, and crew integrity is in that dead set —
   `tests/test_quickbooks_sync.py:59-63`.
4. **The receipt poller silently stops sending receipts forever** after one bad invoice, because a stale ORM
   object survives a rollback. `backend/qbo_receipts.py:512-516`.
5. **Recording a payment then clicking Discard destroys the payment**, and Recall-to-Draft bypasses the guard
   built to prevent exactly that. `modules/invoices.js:1737-1746`.
6. **A missing `DATABASE_URL` boots silently on ephemeral container-local SQLite** rather than refusing to
   start — with auto-migration and first-user-becomes-admin behind it. `backend/database.py:26-38`.
7. **`POST /api/sync` still exists with no caller**, wipes 12 tables, and cascade-deletes `client_rates`
   without restoring them. `backend/routes/api.py:634-680`.
8. **New quotes and invoices get dead Share/Preview links** — the frontend still mints `share_token` client-side
   on a comment that the H3 security fix made false. `modules/quotes-builder.js:1628-1633`.
9. **`theme.js` is 96% not-theme**: 2,529 of 2,626 lines are the shared business layer, including the whole
   payroll engine — which every unauthenticated share-link viewer downloads.
10. **Starlette 0.46.2 carries CVE-2026-48710 (BadHost).** I verified the app is **not exploitable** — every
    path-based security decision reads raw ASGI `scope["path"]`, not `request.url` — but the pin should move.

---

## 2. Corrections I made to the automated pass

Reported so you can calibrate trust in the rest:

- **DOMPurify CVE-2026-0540 is real but not exploitable here.** DOMPurify 3.2.7 is in the affected range
  (3.1.3–3.3.1, fixed 3.3.2) and the CVE is genuine. But it requires sanitized output rendered inside a rawtext
  element. The app's only such element is a `src`-only Google Maps embed with no children
  (`modules/crew-view.js:580`). Downgraded to a keep-current hygiene item.
- **Starlette: the pass flagged the wrong CVE.** It cited CVE-2025-62727; the more serious one is
  CVE-2026-48710 (BadHost, host-header auth bypass, affects 0.8.3–1.0.0). I then checked the app's own usage and
  cleared it: `rate_limit.py:194` and `main.py:442` both use `scope.get("path")`, `csrf.py` reads raw scope
  headers, and the single `request.url` use (`auth.py:60`) reads *scheme* only and fails toward Secure.
- **Three "missing timeout" style findings dropped.** Every `httpx` call carries an explicit timeout
  (`gmail.py:157,355`, `quickbooks.py:254,442,670`, `auth.py:319`, `scan.py:97`). The one real gap is
  `pywebpush`, which takes none (`webpush.py:57-63`).
- **"Multiple Alembic heads" dropped.** I built the revision graph: 34 revisions, one root, one head, no
  branches, no merges, no missing parents.
- **"Missing indexes" mostly dropped.** Nearly every FK and token column is indexed; the one real gap is
  `payout_bill_lines.date`.
- **`notes` leak raised Medium → High.** The verifier called it Medium on bounded impact. I disagree: it is an
  unauthenticated disclosure of a field whose own model comment says "never rendered client-side"
  (`backend/models.py:221`), it reaches an external party, and share links get forwarded.

---

## Phase 1 — Findings by category

Full format for Critical / High / Medium. Low and Nit are collapsed into per-category tables
to keep the document navigable; every one still carries its `file:line`.

### 1. Security

```
[High] Internal `notes` column still shipped in the public client-view payload
  File: backend/routes/view.py:143-144
  What: _sanitized_payload strips only the keys "internalNotes" and "internal_notes" — neither of which quote_dict/invoice_dict ever produce. The key that actually exists is "notes" (backend/routes/_shared.py:114 for quotes, :153 for invoices), and it is never removed, so Quote.notes / Invoice.notes are returned verbatim by GET /api/view/{token}.
  Why it matters: models.py:221 and :306 both annotate this column as "internal free-form text; never rendered client-side", and backend/pdf_generator.py never renders it — it is the field staff use for margin notes, supplier problems, and candid remarks about the client. Any holder of the share URL (the client, plus everyone the quote email was forwarded to, plus anyone who later finds the link in a mailbox or history) can read it with a single `curl /api/view/<token>`. The client-view UI does not display it, so the leak is …
  Fix sketch: Pop "notes" alongside "shareToken"/"payments" in _sanitized_payload, or better, finish the M1 conversion: build the public entity dict from an explicit allow-list of client-safe keys (id, clientType, status, dates, customName, globalDiscount, sections, terms, activity, qbTaxTotal, createdDate, projectNames) instead of mutating the full row dict. Extend test_public_payload_omits_share_token_and_payments to assert `notes` is absent for both quotes and …
  Confidence: High
```
> **Prior review `M1` — fix incomplete.**  
> *Adversarial verify:* CONFIRMED

```
[Medium] Pay-snapshot guard protects the amount but not who/when it is paid
  File: backend/crew_integrity.py:292-343
  What: enforce_pay_snapshot restores/strips only `work` and `adj`, keyed by position id (stored map built at :314-322, applied at :327-342). It does not pin the position's `crewId`, its `status`, or the shift `date` the position lives on, and it does not detect a position id appearing more than once in the incoming schedule. Callers: backend/routes/api.py:322 (non-admin PUT /api/projects/{id}) and :259 (create).
  Why it matters: backend/payouts.py:210-250 derives every payout by bucketing (project, date) and taking, per crewId, the first position with status=='confirmed' and a `work.pay`, then bills work.pay.total verbatim (POST /api/qbo/payouts/push, backend/routes/qbo.py:701). Two member-level PUTs defeat the guard's own stated threat model: (a) change a signed-off position's `crewId` to another crew contact while keeping status 'confirmed' — enforce_status_floor explicitly skips positions whose crewId changed …
  Fix sketch: Key the guard on the identity of the pay, not just the id: for a non-admin write, restore `work`/`adj` only when the incoming position also matches the stored position's `crewId` AND sits on a shift with the same `date`; strip the snapshot otherwise (a reassignment or a move is, by the module's own logic, a release). Additionally reject or de-duplicate repeated position ids in an incoming schedule before applying either guard, and log a strip as loudly as …
  Confidence: High
```
> *Assumes:* Assumes an attacker with a valid member session issuing a hand-crafted PUT (the Labor UI's reassign path at modules/labor.js:1282-1286 drops status to 'open', so this is not reachable through the …  
> *Verifier narrowed this:* enforce_pay_snapshot (backend/crew_integrity.py:292-343) keys the frozen payout snapshot solely by position id, so while it does prevent a non-admin from changing `work`/`adj`, it does not bind that snapshot to a crewId, a status, a shift date, or a single occurrence. Two hand-crafted member PUTs therefore move admin-signed money without tripping any guard or log: (a) changing a confirmed position's `crewId` to an attacker-created `is_crew` contact while leaving status at "confirmed" — enforce_status_floor never fires because the status is not downgraded (the finding's citation of …

```
[Medium] _stamp_activity rewrites the actor on every historical activity entry
  File: backend/routes/api.py:182-189
  What: _stamp_activity iterates the ENTIRE incoming `activity` / `scheduleActivity` array and unconditionally sets entry['user'] = user.name and entry['userId'] = user.id on every entry, not just newly appended ones. It has no notion of which entries the client actually added.
  Why it matters: The frontend PUTs its whole in-memory row (components/data-state.js:171-173 sends the full item), so once a quote has been refetched after a client action, a routine staff save rewrites the attribution of every prior entry. The `client_accepted` / `client_declined` entries written by backend/routes/view.py:447-455 carry user=<the client's typed name> and userId=None — exactly the non-repudiation record H12's hardening added alongside the signature and IP/UA capture — and they become 'signed by <staff member>'. The …
  Fix sketch: Stamp only entries that are new relative to the stored row: diff incoming entry ids against row.activity (the stored ids are already loaded for _merge_activity) and stamp user/userId only on ids not present in stored. For existing ids, keep the stored entry's user/userId rather than trusting either the client's copy or the current actor.
  Confidence: High
```
> **Prior review `H12` — fix incomplete.**  
> *Adversarial verify:* CONFIRMED

```
[Medium] enforce_pay_snapshot injects a stored pay snapshot onto any cloned position id
  File: backend/crew_integrity.py:322-343
  What: `enforce_pay_snapshot` builds `stored` as a flat {position_id: (work, adj)} map across ALL shifts (:322), then for every incoming position does `prev_work, prev_adj = stored.get(pos.get("id"), (None, None))` (:330) and, when the incoming value differs and prev is not None, WRITES the stored snapshot onto it (`pos["work"] = prev_work`, :335). Nothing requires the incoming position to be on the same shift/date as the stored one, and nothing enforces position-id uniqueness across the schedule.
  Why it matters: The guard's stated threat model (its own docstring, :295-303) is that a non-admin must not create or alter a frozen payout snapshot because "the QuickBooks payout export bills work.pay.total verbatim". But a non-admin can PUT a project schedule containing a NEW shift on a NEW date whose position carries the SAME `id` as an already-signed-off position, with `crewId` = themselves and `status` = "confirmed" (enforce_status_floor only reverses downgrades, so an upgrade to confirmed passes). The guard then copies the …
  Fix sketch: Key `stored` by (shift id or date, position id) rather than position id alone, and restore only when the incoming position is on the same shift. Additionally, for a non-admin write, strip `work`/`adj` from any position whose id is not present on the SAME stored shift, and reject/log a schedule that reuses a position id across shifts.
  Confidence: Medium
```
> *Assumes:* Assumes a non-admin can craft a raw PUT /api/projects/{id} body (the normal UI would mint fresh position ids when duplicating a shift). Also assumes the payout export is run against schedules a …  
> *Adversarial verify:* CONFIRMED

```
[Medium] validate() and _stamp_activity are bypassed by sending snake_case keys
  File: backend/routes/api.py:38-40, 128-136
  What: `_camel_to_snake` (:38-40) is idempotent on already-snake_case input, and `_dict_to_row` (:128-136) accepts any key whose converted form matches a column. But `validators.py::_RULES` keys every rule on the frontend's camelCase spelling (`clientType`, `sentDate`, `customName`, `dayRate`, ...), and `validate()` only checks `if field in data` (validators.py:263). `_stamp_activity` likewise keys on `"scheduleActivity"` (api.py:186). Sending `{"client_type": ...}` / `{"schedule_activity": [...]}` writes the column …
  Why it matters: Every rule in validators.py whose name is not identical in both spellings is optional for any authenticated member: forged enum values for `client_type` and `crew_status`, non-ISO garbage in `sent_date`/`invoice_date`/`due_date` (which `_invoice_ref` slices verbatim into the QuickBooks DocNumber, qbo_sync.py:762-765), negative `day_rate`/`day_cost`/`unit_price`, and unbounded `custom_name`. Worse, `schedule_activity` bypasses the attribution stamp entirely, so a member can write forged `user`/`userId` entries into …
  Fix sketch: Normalize the payload once at the boundary: build `mapped` first, then run `validate()` and `_stamp_activity` against the normalized snake_case dict (re-keying `_RULES` to column names), or reject any request body key that is not already in the expected camelCase form.
  Confidence: High
```
> *Adversarial verify:* CONFIRMED

```
[Medium] Share/PDF/crew/photo bearer tokens are written to platform logs
  File: railway.json:7
  What: The production start command is bare `uvicorn backend.main:app` with no `--no-access-log`, so uvicorn's default access logger emits the full request line (uvicorn/protocols/http/httptools_impl.py:480 -> get_path_with_query_string) to stdout for every request. Four public surfaces put their sole credential in the URL path: backend/routes/view.py:334/385/457/498, backend/routes/pdf.py:153, backend/routes/crew.py:558/689/694, and backend/routes/api.py:608 (`/api/users/photo/{photo_token}`). nixpacks.toml:12 has the …
  Why it matters: On Railway, stdout is the platform log stream: searchable in the dashboard, retained, and forwarded verbatim to any log drain or observability integration. Every share link, PDF link, crew accept/decline link, and avatar URL ever visited is therefore sitting in plaintext in a second system as a working credential. Anyone with read access to logs (a contractor, a support seat, a compromised drain endpoint, a screenshot in a ticket) can replay a token to read a client's quote or invoice with full pricing, download …
  Fix sketch: Either add `--no-access-log` to the start command in both railway.json and nixpacks.toml, or (better, if request visibility is wanted) pass a custom `--log-config` whose access formatter redacts the token segment — e.g. a logging.Filter that regex-replaces `/(api/view|pdf|api/crew|api/users/photo)/[A-Za-z0-9_-]{16,}` with `.../<redacted>`. Rotating existing share tokens afterwards is the completion step, since already-logged ones stay valid.
  Confidence: High
```
> *Assumes:* Railway forwards container stdout to its log stream and retains it (standard platform behavior).  
> *Verifier narrowed this:* The production start command (railway.json:7, duplicated at nixpacks.toml:12) runs uvicorn without `--no-access-log`, and nothing in the repo overrides uvicorn 0.34.2's default `access_log=True` (config.py:196; the emitter at httptools_impl.py:475-482 logs the full path via get_path_with_query_string). Public routes that carry their sole credential in the URL path — `/api/view/{token}` and its `/accept`, `/decline`, `/pdf` children (view.py:334/385/457/498), `/pdf/{token}` (pdf.py:153), and `/api/crew/{token}` plus `/accept`/`/decline` (crew.py:558/689/694) — therefore have those …

```
[Medium] bleach 6.1.0: server-authoritative email sanitizer is on a permanently unmaintained project
  File: requirements.txt:17
  What: `bleach[css]==6.1.0` (released 2023-10-06) is the engine behind backend/sanitize.py:46-49 and :137-141 — the `Cleaner` + `CSSSanitizer` that the frontend comment at components/sanitize.js:58-61 explicitly calls the authoritative layer for email HTML at save and send time. Upstream PyPI now states: "NOTE: 2026-06-05: Bleach is no longer maintained. There will be no future releases including for security issues." The pin is also three releases behind the final 6.4.0, and the [css] extra pulls tinycss2 1.2.1.
  Why it matters: This is the last server-side barrier between a pasted Mailchimp/Stripo template and HTML that goes out over the company's Gmail account and is re-rendered in the in-app preview. Any sanitizer-bypass discovered from here on will never be patched upstream — there is no version to bump to. The prior review's L10 dependency sweep predates the end-of-life announcement, so bleach was left at 6.1.0 as 'fine'.
  Fix sketch: Two steps, in order: (1) bump to the terminal 6.4.0 now to pick up the 6.2/6.3/6.4 fixes at zero API cost; (2) plan a migration to a maintained sanitizer — `nh3` (Rust ammonia bindings) is the closest allowlist-shaped drop-in and keeps the per-tag attribute map that backend/sanitize.py already expresses. Whichever is chosen, the frontend EMAIL_ALLOWED_TAGS/ATTR in components/sanitize.js:70-93 must be re-mirrored so the preview still matches what is sent.
  Confidence: High
```
> **Prior review `L10` — fix incomplete.**  
> *Verifier narrowed this:* `bleach[css]==6.1.0` (requirements.txt:17) is the engine behind the server-authoritative email sanitizer (backend/sanitize.py:46-49, :137-143). Bleach reached permanent end-of-life on 2026-06-05 ("no longer maintained… no future releases including for security issues"), and the pin is three releases behind the final 6.4.0. Contrary to the original finding, there IS a version to bump to, and it matters now rather than hypothetically: bleach 6.1.0 is listed as affected by two advisories fixed only in 6.4.0 — GHSA-8rfp-98v4-mmr6 (URI sanitization accepts disallowed schemes carrying invisible …

```
[Medium] Blind SSRF: any signed-in member can make the server POST to an arbitrary URL via …
  File: backend/routes/push.py:27, 39-73
  What: `SubscribeBody.endpoint` is a bare `str` (push.py:27). `subscribe()` checks only that it is non-empty (push.py:47) and stores it verbatim (push.py:69 / :60 for the update branch). No scheme check, no host allow-list, no check that it looks like a push-service origin. Later, `backend/webpush.py:87` builds `info = {"endpoint": s.endpoint, ...}` and `_send_one` (webpush.py:52-64) hands it straight to `pywebpush.webpush(subscription_info=info, ...)`. In pywebpush 2.0.0 (requirements.txt:22) that resolves to …
  Why it matters: This converts a member-level account into server-side network access: reachability probing of the internal/VPC network and cloud metadata endpoints from the app's own egress identity, and an inbound-request-blocking DoS (a black-holed endpoint holds an `asyncio.to_thread` worker for up to 10000s inside a live request handler, and `_deliver` iterates subscriptions sequentially). The audit already flagged the missing timeout as a reliability issue, but the underlying problem is that `endpoint` is an unvalidated, …
  Fix sketch: Validate `endpoint` at subscribe time in routes/push.py: require `https://` scheme, reject IP-literal hosts and non-public addresses (resolve and check against private/link-local/loopback ranges), and ideally allow-list the known push-service hosts (`*.push.services.mozilla.com`, `fcm.googleapis.com`, `*.notify.windows.com`, `*.push.apple.com`). Reject anything else with 400 rather than storing it. Additionally pass an explicit short `timeout=` (e.g. 10s) …
  Confidence: High
```
> *Verifier narrowed this:* Blind SSRF: any signed-in member (no admin role needed) can make the server issue an unbounded server-side HTTP POST to an arbitrary URL. `SubscribeBody.endpoint` is a bare `str` (backend/routes/push.py:27); `subscribe()` checks only non-emptiness (push.py:47) and stores it verbatim (push.py:69) with no scheme, host, or allow-list check. At send time backend/webpush.py:87 builds `info = {"endpoint": s.endpoint, ...}` and `_send_one` (webpush.py:52-64) passes it to `pywebpush.webpush`, which in 2.0.0 performs no endpoint validation (only urlparse for the VAPID `aud`, __init__.py:533) and calls …

```
[Medium] No session-revocation path — an offboarded user keeps full access for up to 30 days
  File: backend/auth_deps.py:38-72
  What: `_load_session_user` authenticates purely on (a) the session row existing, (b) `expires_at > now`, and (c) `last_used_at` inside `_IDLE_TIMEOUT` — which is set equal to the 30-day absolute lifetime (auth_deps.py:20-27), so it never bites. Nothing else is consulted: not the allow-list, not any per-user disable flag. The allow-list (`LTP_ALLOWED_DOMAIN` / `LTP_ALLOWED_EMAILS`) is enforced ONLY inside `/auth/callback` (routes/auth.py:160-175), i.e. only for new sign-ins. And there is no way to kill an existing …
  Why it matters: This is the blast radius for a leaked or stolen `ltp_session` cookie, and for every offboarding. Removing someone from `LTP_ALLOWED_EMAILS` (the documented access control) blocks their next sign-in but does nothing to the cookie already in their browser: for up to 30 more days they retain full member CRUD over every company, contact, project, quote and invoice, can send mail through `/api/email/send` as themselves via their still-stored Gmail refresh token, can book crew, and can read all payout amounts. The only …
  Fix sketch: Two cheap options, ideally both: (1) re-check the allow-list (and a new `users.disabled` flag) inside `_load_session_user` so a removed/disabled user's existing sessions stop authenticating on the next request; (2) add an admin action that deletes all `Session` rows for a target `user_id` (plus clearing that user's `gmail_refresh_token`), surfaced from the Settings → Team Members panel. Independently, set `_IDLE_TIMEOUT` to something strictly shorter than …
  Confidence: High
```
> *Verifier narrowed this:* There is no in-app session-revocation path, so an offboarded user keeps member-level access for up to the 30-day session lifetime. `_load_session_user` (backend/auth_deps.py:38-72) authenticates on row-existence plus `expires_at > now` alone (the 30-day idle timeout is deliberately set equal to the 30-day absolute lifetime for PWA usability, per the comment at auth_deps.py:20-26, so it adds nothing here). The `LTP_ALLOWED_DOMAIN`/`LTP_ALLOWED_EMAILS` allow-list is consulted only in `/auth/callback` (routes/auth.py:162-176), so removing an address blocks the next sign-in but does not …

<details>
<summary><strong>23 Low / Nit in this category</strong></summary>

| Sev | Finding | Location |
|---|---|---|
| Low | Client's handwritten signature image is re-servable to any share-token holder | `backend/routes/_shared.py:306-309` |
| Low | Quote expiry is printed on the document but never enforced at accept | `backend/routes/view.py:431-436` |
| Low | Public activity feed leaks the first recipient's email and the sender's identity | `backend/routes/_shared.py:292-305` |
| Low | Internal QuickBooks tax fingerprint echoed to unauthenticated viewers | `backend/routes/_shared.py:126` |
| Low | Public client-view JSON sets no Cache-Control, unlike its PDF sibling | `backend/routes/view.py:356-358` |
| Low | First-user-becomes-admin bootstrap is still ungated (M4 item 3 not shipped) | `backend/routes/auth.py:184-203` |
| Low | Session idle timeout is inert — equal to the absolute lifetime | `backend/auth_deps.py:20-27` |
| Low | M5 FK validation shipped for create/update but not for bulk_sync | `backend/routes/api.py:658-680` |
| Low | escape_query_value docstring states the opposite rule from the code | `backend/quickbooks.py:473-477` |
| Low | Settings save sanitizes only the signature, not email template bodies | `backend/routes/api.py:430-433` |
| Low | LTP_textToHtml parses untrusted HTML into the DOM before sanitizing | `theme.js:1755-1770` |
| Low | crm-notes stripHtml parses raw note HTML; its safety comment is wrong | `modules/crm-notes.js:11-14` |
| Low | LTP_IMG_SRC_EXTRA is spliced into the CSP unvalidated at import time | `backend/main.py:316-324, 367` |
| Low | Crew and QBO-receipt mail paths bypass backend/email_validate entirely | `backend/routes/crew.py:373-374, 391, 509, 543` |
| Low | Key-rotation script cannot detect a reversed keyring and exits 0 | `backend/rotate_encryption_key.py:38-44, 78-80` |
| Low | No TLS configured on the Postgres engine; asyncpg silently defaults to 'prefer' | `backend/database.py:38` |
| Low | Unauthenticated ReportLab render reachable at double the rate the /pdf rule allows | `backend/rate_limit.py:44-58` |
| Low | DOMPurify 3.2.7 is affected by unpatched CVE-2026-0540 | `index.html:317-318` |
| Low | starlette 0.46.2 pinned below its CVE fix by fastapi's own upper bound | `requirements.txt:1` |
| Low | ANTHROPIC_BASE_URL breaks the pinned-outbound-host invariant with no validation | `backend/routes/scan.py:79, 93, 98` |
| Low | Crew contacts linked to a project are pre-populated as Cc on the client-facing quote/invoice email | `components/recipient-editor.js:21-24` |
| Nit | Frontend signature render omits the escaping its backend twin documents | `theme.js:1536-1544` |
| Nit | Email preview allowlist mirrors tags/attrs but not the CSS property allowlist | `components/sanitize.js:87-104` |

</details>


### 2. Bugs & correctness

```
[Critical] Break after midnight on an overnight shift explodes paid hours
  File: theme.js:296-316
  What: LTP_calcLaborDay normalizes an overnight span into a >24h frame (`if (end <= start) end += 24`, line 265) but normalizes each break only against ITSELF (`if (be <= bs) be += 24`, line 301). A break wholly after midnight (e.g. 00:30–01:00) therefore lands at 0.5–1.0 while the cursor is at 18.0, so `if (bs > cursor)` never fires, `cursor = be` rewinds the cursor to 1.0, and the trailing `if (cursor < span.end)` emits one enormous segment.
  Why it matters: Reproduced under node: an 18:00–02:00 shift (8h, 7.5h paid) with a 00:30–01:00 unpaid break returns paidHours 25, mealPenaltyHours 20, rate $3,500 on a $1,000 day rate. This single function is the canonical engine for BOTH sides of the money: LTP_scheduleLaborSections prices the quote/invoice lines from it, and LTP_crewDayPay / LTP_crewDayActuals freeze work.pay from it at sign-off, which backend/payouts.py re-derives verbatim into the QuickBooks vendor bill. An overnight call is over-billed to the client and …
  Fix sketch: Normalize breaks into the SPAN's frame, not their own: after computing bs/be, while (bs < span.start) { bs += 24; be += 24; } (and keep the existing be<=bs wrap first). Add regression cases to tests/test_labor_rates.js alongside A9 (line 57), which today covers overnight only with no breaks.
  Confidence: High
```
> *Assumes:* Overnight shifts are used in production. The code handles `end <= start` as overnight in three separate places and test A9 pins it, so this is a supported case, not dead input.  
> *Adversarial verify:* CONFIRMED

```
[High] Auto meal-break generator emits midnight-wrapped times that feed the bug above
  File: theme.js:1313-1318
  What: LTP_mealFixBreaks computes break boundaries in the span's >24h decimal frame (bStart = bad.start + 5) and then serializes them with _decimalToTime (theme.js:236-241), which does `Math.floor(d) % 24` — silently wrapping 29.0 to "05:00". It also mis-frames pre-existing breaks the same way as the engine (line 1301). The generated break is then stored on the schedule and read back by LTP_calcDayLabor in the wrong frame.
  Why it matters: The app manufactures its own poison input. Reproduced: LTP_mealFixBreaks on an 18:00–06:00 shift emits [23:00→00:00, 05:00→06:00]; feeding those straight back into LTP_calcLaborDay yields mealPenaltyHours 13, paidHours 23, rate $2,950 — versus the correct $1,300. The equivalent daytime case (08:00–22:00) correctly returns mealPenaltyHours 0. That is the invariant tests/test_labor_rates.js:165 ("F5 long shift fully cleared") asserts, and it is silently false for every overnight shift. A producer clicking "fix meal …
  Fix sketch: Keep an absolute day-offset on each generated break (or store breaks as decimal offsets from the shift start rather than wall-clock HH:MM), and fix the engine-side framing per the previous finding so the two agree. Extend the F5 assertion to an overnight span.
  Confidence: High
```
> *Verifier narrowed this:* LTP_mealFixBreaks (theme.js:1273-1322) computes break boundaries in the span's >24h decimal frame and serializes them with _decimalToTime (theme.js:236-241) as bare wall-clock HH:MM. Those strings are correct wall clock, but LTP_calcLaborDay (theme.js:296-299) reads them back with _timeToDecimal and never re-frames them against the span start, so a post-midnight break sorts before the span and fragments the day. LTP_mealFixBreaks repeats the same omission on pre-existing breaks at theme.js:1301, so it also ignores an existing post-midnight break and re-adds a duplicate. The "MEAL PENALTY — …

```
[Medium] Invoice.payments is server-written but client-writable and never merged
  File: backend/routes/api.py:60-72, 328-329
  What: `_merge_activity` is applied only to the `activity` column (`if has_activity and "activity" in mapped`, :328-329), but `payments` is neither in `_READONLY_COLS` (:60-72) nor merged. backend/qbo_receipts.py::_reconcile_paid (:259-273) writes a synthetic `{"id": "pay-qb-...", "method": "quickbooks", ...}` entry into `invoice.payments` and sets `status`/`paid_date`, all three of which are freely client-writable.
  Why it matters: This is exactly the failure `_merge_activity`'s own comment (api.py:78-95) describes — "the frontend PUTs its whole in-memory row, and its array is a snapshot taken before any SERVER-side stamp landed" — and components/data-state.js::syncEntity:172-174 confirms the whole row is PUT on any field change. So after the receipt poller marks an invoice paid, the next edit from a tab loaded before that poll reverts `payments`, `status` and `paid_date`. It never self-heals: `_candidate_invoices` (qbo_receipts.py:472-486) …
  Fix sketch: Give `payments` the same treatment as `activity`: a `_merge_payments(stored, incoming)` union keyed on payment `id` (the poller already mints a stable `pay-qb-<token>` id), applied in `update` alongside the activity merge. Consider also refusing a client write that moves `status` off 'paid' while `qb_balance` is 0.
  Confidence: Medium
```
> *Assumes:* Assumes the frontend does not refetch invoices after page load — the same assumption api.py:78-95 already makes explicitly for the activity column.  
> *Verifier narrowed this:* `_merge_activity` is applied only to the `activity` column (api.py:328-329). `payments`, `status` and `paid_date` are absent from `_READONLY_COLS` (api.py:60-73) and are neither merged nor otherwise protected, yet qbo_receipts.py::_reconcile_paid (:246-273) writes all three server-side — appending a synthetic `{"id": "pay-qb-...", "method": "quickbooks"}` payment and setting status='paid' / paid_date. Because the frontend hydrates once (data-state.js:249-305, `useEffect(..., [])`, no refetch) and PUTs the whole row on any diff (:171-173), a tab loaded before the poll holds a pre-payment …

```
[Medium] QuickBooks invoice total can differ by cents from the PDF and client view
  File: backend/qbo_sync.py:877-878
  What: _build_sales_lines rounds each line to cents before summing (`amount = round(eff_price * qty, 2); subtotal += amount`) and sends those rounded Amounts to QuickBooks. All three display surfaces sum UNROUNDED: theme.js:2053-2054 (LTP_INVOICE_TOTALS), backend/pdf_generator.py:303-308 (_calc_totals), modules/client-view.js:110-114 (calcTotals). Nothing compares invoice.qb_total_amt back against the app total, even though it is stored (qbo_sync.py:1143-1146) and shipped to the frontend as qbTotalAmt.
  Why it matters: Overtime lines routinely carry sub-cent amounts (qty is OT hours to 2dp, unitPrice is dayRate*0.15). Verified: two OT lines at $112.50 for 0.25h and 1.25h give $168.75 in the app/PDF/share link and $168.74 in QuickBooks. The customer's PDF and the invoice they are actually billed for disagree. Downstream, backend/qbo_receipts.py:262 sizes its synthetic 'Paid via QuickBooks' payment from QB's TotalAmt, so an invoice marked paid can show a permanent 1c balance in the app (LTP_INVOICE_TOTALS balance = max(0, total - …
  Fix sketch: Either round each line consistently in all four readers (a shared 2dp line-amount rule), or add the AP-side reconciliation to _apply_qb_result: when abs(qb_total_amt - app_total) > 0.005, stamp a mismatch on the invoice and surface it in the Error Log the way _collect_payout_faults does.
  Confidence: High
```
> *Assumes:* QuickBooks derives Invoice.TotalAmt from the supplied line Amounts (it does, and the code already trusts that in qbo_payouts.py:596).  
> *Verifier narrowed this:* QuickBooks invoice totals can drift by cents from the PDF and client view because line Amounts are cent-granular in QB while the app's readers sum unrounded. backend/qbo_sync.py:877-878 rounds each line to cents before summing and sends those Amounts to QuickBooks (which it must — QB line Amounts are 2-decimal currency), while theme.js:2053-2054 (LTP_INVOICE_TOTALS), backend/pdf_generator.py:303-308 (_calc_totals) and modules/client-view.js:110-114 (calcTotals) all sum unrounded and round only for display. OT lines routinely produce half-cent amounts (qty = OT hours to 2dp per theme.js:733, …

```
[Medium] 'target' discount clamps differently in LTP_INVOICE_TOTALS than in the other three readers
  File: theme.js:2072-2076
  What: LTP_INVOICE_TOTALS models a target as `discount = Math.max(0, adjusted - value)` then clamps the discount, so a target ABOVE the adjusted subtotal collapses to no discount (total = adjusted). LTP_QUOTE_TOTALS (theme.js:2328), pdf_generator.py:317-319 and client-view.js:122 all set `after = value` directly and clamp only at zero, so they report the target itself.
  Why it matters: Reproduced: sections totalling $200 with globalDiscount {type:'target', value:500} gives total 200 from LTP_INVOICE_TOTALS and 500 from the quote/PDF/client-view path. This is reachable without malice — set a target, then delete or re-price lines so the subtotal falls below it (the Target field is a free numeric input, modules/invoices.js:2277 and modules/quotes-builder.js:1006). The invoice editor and the QuickBooks push (qbo_sync.py:924-931, which clamps to `min(amount, subtotal)`) then say one number while the …
  Fix sketch: Make the three non-invoice readers clamp the same way — `after = min(value, adjusted)` — or make LTP_INVOICE_TOTALS honour an above-subtotal target. Either way pin the target > adjusted case in tests/test_money_totals.js for both QT and IT.
  Confidence: High
```
> *Adversarial verify:* CONFIRMED

```
[Medium] Stale client PUT silently reverts the poller's paid/payment reconciliation
  File: backend/routes/api.py:61-72
  What: _READONLY_COLS protects qb_balance, receipt_email_status and receipt_email_sent_at, but NOT the three columns the receipt poller also writes in _reconcile_paid (qbo_receipts.py:246-275): Invoice.status, Invoice.paid_date and Invoice.payments (the synthetic "Paid via QuickBooks" entry). components/data-state.js fetches each entity list exactly once on mount (:257-306) and has no refetch path, so a browser open since before the poll cycle holds a pre-payment snapshot.
  Why it matters: An admin who had the app open before the 2-hour poll marks an invoice paid, then edits anything on that invoice, causes the debounced diff-sync (data-state.js:313-331) to PUT the whole stale row: status flips back off "paid", paid_date clears, and the recorded QuickBooks payment disappears. The loss is permanent, not eventually-consistent — _candidate_invoices (qbo_receipts.py:476-486) only re-checks invoices whose receipt_email_status is null/pending/failed, and this one is now 'sent', so it never gets reconciled …
  Fix sketch: Either add status/paid_date/payments to a per-model server-authoritative set, or (better, and what H3 option A asked for) apply the pattern already used for activity (_merge_activity, api.py:86-108) and project schedules (crew_integrity.enforce_status_floor): on update, refuse a client write that downgrades status from 'paid' or drops a payment id the stored row already has.
  Confidence: High
```
> **Prior review `H3` — fix incomplete.**  
> *Verifier narrowed this:* A stale full-row client PUT can permanently revert the receipt poller's payment reconciliation. `_reconcile_paid` (backend/qbo_receipts.py:246-275) sets Invoice.status="paid", Invoice.paid_date and appends a synthetic "Paid via QuickBooks" payment, but none of those three columns is protected on the write path: `_dict_to_row` (backend/routes/api.py:129-136) only strips `_HIDDEN_COLS`/`_READONLY_COLS`, and the CRUD update (api.py:275-350) applies the rest verbatim, with merge/floor guards existing only for `activity` and Project.schedule. Because components/data-state.js fetches each entity …

```
[Medium] email_failed activity stamp is rolled back by the HTTPException that follows it
  File: backend/routes/email.py:351-358
  What: On GmailSendError the handler deletes the recipient rows, calls _stamp_email_failed(entity, ...) and flushes — then raises HTTPException(502) at :358. Raising propagates into get_db's generator, which takes the `except Exception: await session.rollback()` branch (backend/database.py:51-53), so the activity entry is never committed. The same applies to the 409 path at :350, which discards gmail.py's invalid_grant token clearing.
  Why it matters: The module docstring at :57-58 promises "On GmailSendError: roll back recipient rows, stamp email_failed activity, return 502", and the frontend has a whole Error Log surface built on gathering email_failed entries (tests/test_utils.js:285, modules/invoices.js activity feed). Neither ever shows a failed manual send — the user only gets a transient toast, and the document's own history claims the email was never attempted. routes/qbo.py:339-357 solves this exact problem correctly, returning JSONResponse with the …
  Fix sketch: Replace both `raise HTTPException(...)` calls with `return JSONResponse(status_code=..., content={...})`, matching routes/qbo.py. The response body shape the frontend reads is unchanged; only the transaction outcome differs.
  Confidence: High
```
> *Adversarial verify:* CONFIRMED

```
[Medium] LTP_quoteExpiry drifts one day from the Python twin across spring DST
  File: theme.js:2117-2126
  What: `LTP_quoteExpiry` parses the ISO sentDate with `new Date(from)` (UTC midnight), then advances it with `d.setDate(d.getDate() + N)` (LOCAL calendar days), then re-serializes with `toISOString()` (UTC). When the validity window crosses a spring-forward transition the local wall clock keeps its time-of-day but the UTC offset gains an hour, so the resulting instant lands at 23:00Z on the previous day and the returned string is one day EARLY. backend/pdf_generator.py::_quote_expiry (lines 177-186) uses …
  Why it matters: The code and both test files explicitly promise these two implementations name the same day (theme.js:2160 comment, tests/test_utils.js:459-463, tests/test_quote_expiry.py:16-19). Verified with node under TZ=America/Los_Angeles: sentDate 2026-02-25 + 30 days yields "2026-03-26" in JS but "2026-03-27" in Python; 2026-03-01 + 15 yields 2026-03-15 vs 2026-03-16. So the producer's app screen and the client's emailed PDF / share-link terms line state different deadlines for any quote sent in the ~30 days before a DST …
  Fix sketch: Do the arithmetic entirely in UTC: `var d = new Date(from + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + N);` (or reuse the existing `_ppEpochDays`/`_ppISO` epoch-day helpers at theme.js:1195-1204, which already do exactly this correctly). Add a DST-crossing case to the QE table in tests/test_utils.js and the mirrored table in tests/test_quote_expiry.py, and run the JS suite under a non-UTC TZ.
  Confidence: High
```
> *Verifier narrowed this:* LTP_quoteExpiry (theme.js:2117-2126) mixes UTC parsing (`new Date(isoDate)`, `toISOString()`) with local-calendar arithmetic (`setDate(getDate()+N)`), so whenever the validity window crosses a local clocks-forward transition the result lands at 23:00Z of the prior day and the returned ISO date is one day EARLY. Verified: in America/Los_Angeles "2026-02-25"+30 → 2026-03-26 (Python `_quote_expiry` in backend/pdf_generator.py:177-186 gives 2026-03-27); Europe/Berlin "2026-03-10"+30 → 2026-04-08 vs 2026-04-09; Australia/Sydney "2026-10-01"+30 → 2026-10-30 vs 2026-10-31. No drift in UTC or across …

```
[Medium] LTP_todayISO() returns the UTC date, not the user's local date
  File: theme.js:142
  What: `window.LTP_todayISO = function() { return new Date().toISOString().substring(0, 10); };` takes the UTC calendar date. For any user west of UTC this rolls over to "tomorrow" in the late afternoon/evening (17:00 PDT onward), and for users east of UTC it can still read "yesterday" just after local midnight.
  Why it matters: This is the app's single definition of "today" and it feeds decisions, not just labels. modules/labor.js:1947 computes the payout date window as `new Date(todayISO() + "T12:00:00")` — on a Sunday evening in Los Angeles that resolves to Monday, so the Labor tab's "This Week" preset jumps to the following (empty) week while it is still Sunday; the same input drives `LTP_payPeriodBounds` at modules/labor.js:1939, flipping the current pay period a day early at every period boundary. modules/labor.js:443 defaults a …
  Fix sketch: Return the LOCAL calendar date: `var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");` — this is exactly the `iso()` helper already defined at modules/labor.js:1930. Everything downstream compares ISO strings, so no call site changes.
  Confidence: High
```
> *Assumes:* Users are in a non-UTC timezone (the app is US-facing; Railway/UTC is the server, not the browser).  
> *Adversarial verify:* CONFIRMED

```
[Medium] PDF success handler reverts edits made while the PDF was generating
  File: modules/quotes-builder.js:1368-1373
  What: generatePdf's .then rebuilds the whole draft from `draft` captured in the render closure at click time (`Object.assign({}, draft, {activity: ...})`), then writes it back with setDraftRaw, cleanRef.current AND setQuotes. Any field the user edited during the in-flight POST /api/quotes/{id}/pdf is silently discarded. modules/invoices.js:790-793 is the identical code; modules/quotes-builder.js:1588-1597 (calcQuoteTax) has the same stale-closure shape.
  Why it matters: Server-side PDF generation is a multi-second round trip and the builder stays fully editable during it, so continuing to type is the normal thing to do. Because cleanRef and the shared quotes/invoices array are overwritten with the stale snapshot too, the reverted text is also pushed to the server by the next debounced sync — the user's edit is gone locally and remotely, with no error and no visible cue.
  Fix sketch: Apply the activity entry through the functional updater form (setDraftRaw(function(cur){ return Object.assign({}, cur, {activity:(cur.activity||[]).concat([actEntry])}); })) and derive the list/cleanRef updates from that same `cur`, never from the closed-over `draft`.
  Confidence: High
```
> *Adversarial verify:* CONFIRMED

```
[Medium] Payment auto-save leaves a stale clean baseline; Discard erases the payment
  File: modules/invoices.js:1737-1746
  What: autoSavePayment (called 50 ms after addPayment at :858 and removePayment at :997) pushes the draft into the invoices list and calls setIsDirty(false), but never advances cleanRef.current — unlike every other save path (:1842, :1850). cleanRef therefore still holds the pre-payment snapshot.
  Why it matters: Discard (:1855-1857, shown whenever isDirty) resets the draft to cleanRef.current. So: record a payment, change any other field, click Discard — the payment row, the paid/partial status and paidDate all vanish from the editor. The list still has them until the next Save (:1850), which PUTs the pre-payment draft over the row and destroys the payment record permanently. That is financial data with no undo.
  Fix sketch: Set cleanRef.current = cur inside the same setDraftRaw updater in autoSavePayment, so the auto-saved state becomes the new discard baseline (it already is the state that was persisted).
  Confidence: High
```
> *Verifier narrowed this:* autoSavePayment (modules/invoices.js:1737-1746) writes the payment into the invoices list and clears isDirty but never advances cleanRef.current, unlike every other write-back path. Payments only exist on non-draft (locked) invoices, where the draft can still be dirtied via the ungated Notes textarea (:2355) or send/receipt recipient edits (:878). Clicking Discard (:1855-1857, rendered on isDirty alone) then resets the draft to the pre-payment snapshot: the payment row, paid/partial status and paidDate disappear from the editor even though the list and server still have them. save() is NOT …

```
[Medium] Unsaved-changes nav guard is disarmed by its own effect cleanup
  File: theme.js:197-205
  What: LTP_useUnsavedGuard mirrors isDirty into window.__LTP_UNSAVED during render (:187) and in the setter (:193), but the beforeunload effect has dep [isDirty] and its cleanup sets window.__LTP_UNSAVED = false (:203). On the render where isDirty flips false→true, React runs render (global := true), then the cleanup (global := false), then the new effect — which never restores it. The global stays false until some later render re-runs the :187 mirror.
  Why it matters: router.navigate() (router.js:118-121) reads exactly this global to raise the "You have unsaved changes" confirm. After the FIRST dirty-making action in a builder (delete a line item, toggle a checkbox, pick from a dropdown) and before any further re-render, clicking "← Back" or any nav item leaves without a prompt and the draft is destroyed. The browser-close guard still works, which makes the gap easy to miss in testing.
  Fix sketch: Don't clear the global in the effect cleanup on a dep change — either give the effect an empty dep array and read isDirty from a ref, or clear the global only in an unmount-only cleanup (a separate useEffect(..., []) whose cleanup sets it false).
  Confidence: High
```
> *Assumes:* React 18 batches the draft update and setIsDirty(true) into a single render, so no second render intervenes before the cleanup.  
> *Verifier narrowed this:* In theme.js:180-208, the beforeunload effect's cleanup (:203) sets `window.__LTP_UNSAVED = false` and its dep array is `[isDirty]` (:205). On the one render where `isDirty` flips false -> true, React runs the render-time mirror (:187, global := true), then the cleanup (global := false), then the new effect, which never restores it — so the commit ends with the global false while state is true. router.js:118 reads exactly this global, so a click on "← Back" (quotes-builder.js:2294) or any nav item immediately after the FIRST dirty-making action leaves without the "You have unsaved changes" …

```
[Medium] Builders report "Saved" and clear the dirty flag before any server round-trip
  File: modules/quotes-builder.js:1608-1652
  What: save() only mutates local state (setQuotes / setDraftRaw / cleanRef), sets isDirty=false and shows a "✓ Saved" badge. The actual PUT/POST happens 400 ms later from usePersistentState's debounced effect (components/data-state.js:313-331); on a 4xx/5xx the local value is kept, prevSyncedRef is not advanced, and the only user-visible signal is a 20 s toast. invoices.js:1832-1852 is the same.
  Why it matters: A validation 422 or a 500 leaves the user looking at a green check on data the server refused. The nav guard has already been cleared, so navigating away or reloading loses the work. The retry only happens on the NEXT user edit — if there is no next edit, the change is dropped permanently.
  Fix sketch: Have the sync layer publish a per-key sync state (pending/failed) and let the builders gate the "Saved" badge and the dirty flag on it — or at minimum keep isDirty true until the slice reports a clean sync, so the navigate() confirm still fires.
  Confidence: High
```
> *Adversarial verify:* CONFIRMED

```
[Medium] find_or_create_vendor never got the stale/inactive fixes find_or_create_customer did
  File: backend/qbo_payouts.py:181-211
  What: qbo_payouts.find_or_create_vendor and qbo_sync.find_or_create_customer (qbo_sync.py:314-411) are the same flow — cached id, GET, sparse update, query by DisplayName, create, recover from fault 6240 — but the customer copy received two bug fixes the vendor copy never did. When the cached-id GET fails, the customer path drops the cache and re-resolves by name (qbo_sync.py:337-344); the vendor path swallows the QboApiError at :206-207 and falls through to an unconditional `return contact.qb_vendor_id` at :208. The …
  Why it matters: The comment at qbo_sync.py:322-330 describes exactly the failure this leaves open on the payables side: a stale or cross-realm cached id (or a vendor deactivated in QuickBooks) is returned anyway, the Bill create then fails with "Object Not Found ... has been made inactive" naming nothing, and every subsequent payout push for that crew member fails permanently with no way to clear it from the app. A third copy of the same flow, _find_or_create_named_item (qbo_sync.py:429-488), has yet another distinct 6240 …
  Fix sketch: Extract one `find_or_create_name_entity(conn, db, kind, display_name, fields, row, cache_attr, *, on_conflict)` covering the shared cached-id/GET/revive/query/create/6240 path, with the three genuinely entity-specific bits (item revive-deleted, vendor disambiguation suffix, customer InvoiceNotSyncable message) passed in as hooks. As an interim, port the two missing fixes into find_or_create_vendor. LOAD-BEARING (money path, QuickBooks writes) — the …
  Confidence: High
```
> *Adversarial verify:* CONFIRMED

```
[Medium] Equipment "Retired" status is offered in the UI but rejected by the server enum, permanently …
  File: backend/validators.py:50
  What: `ENUMS["equipment_status"] = {"available", "rented", "under-maintenance"}` — it has no `"retired"`. But the Equipment form's parent-level Status <select> offers exactly three options: Available / Under Maintenance / **Retired** (modules/rentals-equipment.js:133), and `save()` at :101 puts `f.status` straight into the record. `saveEquipment` (modules/rentals-shell.js:64-65) writes it into the equipment array, which the persistence hook diff-PUTs. `validate(model_cls, data)` runs on both create …
  Why it matters: Two compounding effects. (1) The retire never persists: the local React state shows Retired and availability drops, but on reload the item is back to Available and rentable — availability math silently disagrees with what the user set. (2) Worse, `prevSyncedRef` only advances when EVERY request in the batch succeeded (components/data-state.js:328-330). A permanently-400ing row means the equipment slice's baseline never advances again, so every subsequent edit to *any* equipment row re-diffs from the stale …
  Fix sketch: Add `"retired"` to `ENUMS["equipment_status"]` in backend/validators.py:50 (the model column is a plain `String(50)`, so nothing else changes). While there: the same review should sweep the other enum sets against their UI option lists — the docstring's stated sync procedure points at a file that no longer exists (see the separate finding), which is how this drifted in the first place.
  Confidence: High
```
> *Verifier narrowed this:* The Equipment form's parent-level Status select (modules/rentals-equipment.js:132-133) offers "Retired", but the server enum at backend/validators.py:50 only allows {available, rented, under-maintenance}, so `validate()` rejects the write with 400 on both POST (backend/routes/api.py:250) and PUT (:292). "Retired" is a genuinely wired-up parent-level state — modules/rentals-utils.js:76 zeroes rentable qty on it and tests/test_quote_availability.py:130-135 asserts that behavior — so this is real enum drift between the frontend and the server (backend/models.py:381's column comment lags the same …

```
[Medium] `createdDate` is a phantom field: the frontend writes and reads it on every quote, but no …
  File: backend/routes/api.py:45, 115-127
  What: `_row_to_dict` (backend/routes/api.py:115-127) skips `_HIDDEN_COLS = {"created_at", "updated_at"}` (:45) and `_dict_to_row` (:134) only keeps keys that map to real columns. Quote and Invoice have no `created_date` column (verified: `sorted(c.name for c in models.Quote.__table__.columns)` yields `created_at`, never `created_date`). So `createdDate` — which the quote builder stamps on create (modules/quotes-builder.js:77) and re-stamps on every open (:102) — is silently dropped on write and never returned by GET …
  Why it matters: The quote reference number is the document's identity, and it now has two values. The app UI, the Send modal's `{{refNumber}}` token and the email body all render `Q-<current year>-NNN`, while the share link the client actually opens and the PDF they download render `Q-<creation year>-NNN` (backend/pdf_generator.py:280-291 via `createdDate`). Any quote created in one calendar year and touched in the next is emailed to a customer under a reference the customer's own copy does not carry — and every quote in the list …
  Fix sketch: Add `createdDate` to `_row_to_dict` for Quote/Invoice by projecting `created_at` (e.g. special-case it the way `_shared.quote_dict` already does), so the one server-side truth reaches all readers; keep it out of `_dict_to_row` so the client can never set it. Then delete `createdDate` and `rentalStartDate`/`rentalEndDate` from the builder's draft constructors so nothing pretends to write them. A cheap regression guard: assert that every camelCase key the …
  Confidence: High
```
> *Adversarial verify:* CONFIRMED

```
[Medium] `defaultPaymentTerms` is absent from the public settings allow-list, so the share link …
  File: backend/routes/_shared.py:321-334
  What: `public_settings` (backend/routes/_shared.py:321-334) is a hand-maintained allow-list. It deliberately includes `defaultQuoteValidity` (:329) and `defaultQuoteTerms`/`defaultInvoiceTerms` (:333) — but not `defaultPaymentTerms`. modules/client-view.js:496 binds `settings = data.settings || {}` and passes it to `window.LTP_docTerms(entity, kind, settings)` at :807; the invoice branch of `_termsVars` resolves `paymentTerms: String(s.defaultPaymentTerms || 30)` (theme.js:2209), so on the public page the token always …
  Why it matters: backend/pdf_generator.py:190-195 states the invariant explicitly: "the app, this PDF and the client's browser all print the same block, and a client comparing their emailed PDF to the link in it must not find two different sets of terms." With Net 45 configured, the emailed PDF says 45 days and the share link in that same email says 30 — a contradiction on the payment terms of a document the client may act on. This is the same half-fix shape as M1: the allow-list was extended for the quote path …
  Fix sketch: Add `"defaultPaymentTerms"` to the `keys` list in `public_settings`, with the same rationale comment `defaultQuoteValidity` carries. Then extend tests/test_doc_terms.py to run its invoice cases through `public_settings(SETTINGS)` on the client-view side so any future token the terms text uses must survive the allow-list. Separately worth deciding: `_payment_terms_days` maps the UI's "Due on Receipt" (0) to 30, so that selection also prints "within 30 …
  Confidence: High
```
> *Adversarial verify:* CONFIRMED

```
[Medium] H3 half-fix: frontend still client-mints share_token, so a newly created quote/invoice's Share …
  File: modules/quotes-builder.js:1628-1633
  What: H3 made `share_token` server-authoritative: it is in `_READONLY_COLS` (backend/routes/api.py:70), stripped by `_dict_to_row` (api.py:135), and minted server-side on create (api.py:268-270). The frontend was never updated. Four creation sites still mint their own and store it in React state as if it were real: quotes-builder.js:1632-1633 (new quote), quotes-builder.js:2126 (quote→invoice conversion), invoices.js:1839-1840 (new invoice), schedule-builder.js:458-460 (schedule→invoice). Worse, three comments assert …
  Why it matters: Until the next full page reload, `draft.shareToken` is a 256-bit value that exists nowhere in the database. `shareQuote` copies `origin + "/#/view/quote/" + draft.shareToken` to the clipboard (quotes-builder.js:1393-1394; invoices.js:812-813 for invoices) and the Preview links point at the same token (quotes-builder.js:2321, 2341; invoices.js:2002, 2021). `_find_entity_by_token` (backend/routes/view.py:70-82) returns (None, None) for it, so `GET /api/view/{token}` 404s. A user who saves a new quote and immediately …
  Fix sketch: Have `syncEntity`'s POST branch resolve the parsed response body and merge the server-returned row (at minimum `shareToken`) back into the entity list, keyed by id. Then drop `window.LTP_genShareToken` and the four client-mint sites, gate the Preview/Share affordances on the server-returned token instead, and delete/correct the three comments that claim the backend honors a client-supplied token.
  Confidence: High
```
> *Adversarial verify:* CONFIRMED

<details>
<summary><strong>18 Low / Nit in this category</strong></summary>

| Sev | Finding | Location |
|---|---|---|
| Low | Server-side payout re-derivation silently drops a crew member the Payouts tab still totals | `backend/payouts.py:286-291` |
| Low | Quote-to-invoice converts a $ or target discount to a 2-decimal percent | `modules/quotes-builder.js:2049-2058` |
| Low | A typed $0 client contract tier silently derives from the day rate instead of being free | `theme.js:585-588` |
| Low | POST /api/sync cascade-deletes client_rates and never restores them | `backend/routes/api.py:639-660` |
| Low | Same UTC-parse/local-setDate pattern on every Net-N invoice due date | `modules/invoices.js:14-18` |
| Low | Activity entries pair a UTC date with a LOCAL clock time | `modules/schedule-builder.js:259` |
| Low | gmail.py compares a DB datetime to an aware now without normalizing | `backend/gmail.py:132-138` |
| Low | Weekly schedule grid shifts a day for users east of UTC | `modules/labor.js:1661-1668` |
| Low | Public accept/decline endpoints do not enforce quote expiry | `backend/routes/view.py:385-451` |
| Low | Two activity-stamp sites use naive datetime.now() while all others use UTC | `backend/routes/view.py:439` |
| Low | After a failed initial fetch, the next user edit of that slice is never synced | `components/data-state.js:285-294` |
| Low | Save of an existing record silently no-ops when the row left the list | `modules/quotes-builder.js:1644-1650` |
| Low | Signed-in user is shown the sign-in screen after a share link in the same tab | `components/auth.js:34-42` |
| Low | Unguarded eq.name/eq.category deref in the global-search effect | `app.js:357-358` |
| Low | gmail.py skips the tz normalization every other module applies; breaks on SQLite | `backend/gmail.py:132-139` |
| Low | Deleting equipment leaves dangling kit line items — kits silently shrink and their auto-rate drops | `modules/rentals-shell.js:74-81` |
| Low | Invoice reference number has three implementations and two different fallback chains | `backend/pdf_generator.py:280-291` |
| Low | The half-up money rounding rule payouts.py declares mandatory is ignored by the module that consumes its own … | `backend/qbo_payouts.py:260, 303, 308-310, 375` |

</details>


### 3. Dead & unused code

```
[Medium] Orphaned destructive endpoint POST /api/sync wipes 12 tables, no caller
  File: backend/routes/api.py:634-658
  What: `bulk_sync` is a one-shot localStorage-to-server migration (docstring: "Used once per client to seed the server from their browser state"). Nothing in the frontend calls it. Grepping `/api/sync` across the whole repo yields only README.md:639/653 (the manual console-paste instructions), tests/test_security_hardening.py:93, backend/rate_limit.py:62 and docs/SECURITY_REVIEW.md. The migration it exists for is complete — components/data-state.js:1-11 states the app is "pure API-backed. No localStorage. No offline …
  Why it matters: It is a live admin-only endpoint that runs `await db.execute(delete(model_cls))` (line 658) against up to 12 tables with no confirmation, no backup, and no audit-log line (unlike the per-row DELETE path at api.py:369, which prints an audit record for SECURITY_REVIEW L3). Worse, it carries latent data loss: `model_map` (lines 636-649) does NOT include `client-rates`, but models.ClientRate FKs companies/contacts/services with ON DELETE CASCADE (models.py:555-557). Running the exact snippet documented at …
  Fix sketch: Delete the route, its rate_limit rule (rate_limit.py:62), the README "Migrating Data from localStorage" section, and the test at test_security_hardening.py:93. If it must be kept as an ops escape hatch, move it behind an env flag off by default and add `client-rates` to `model_map`.
  Confidence: High
```
> *Verifier narrowed this:* `POST /api/sync` (backend/routes/api.py:634-687) is a stale one-shot localStorage→server migration tool that no code calls, and following the README snippet today would cause unrecoverable data loss. Accurate parts: line citations are exact (634 route, 636-638 docstring, 639-651 model_map, 658 `await db.execute(delete(model_cls))`, models.py:555-557 CASCADE FKs, api.py:369 the audit print that bulk_sync lacks); the only repo references are README.md:639/653, backend/rate_limit.py:62, tests/test_security_hardening.py:93 and docs/SECURITY_REVIEW.md; components/data-state.js:1-11 does state the …

<details>
<summary><strong>15 Low / Nit in this category</strong></summary>

| Sev | Finding | Location |
|---|---|---|
| Low | fastapi[standard] extra is unused, ships sentry-sdk/typer/rich/jinja2 to prod | `requirements.txt:1` |
| Low | crew_integrity.reconcile_request() is dead in prod; its docstring is false | `backend/crew_integrity.py:234-245` |
| Low | _TERMINAL constant in routes/crew.py is never referenced | `backend/routes/crew.py:66` |
| Low | PdfArchive.bytes_size and created_by_user_id are write-only columns | `backend/models.py:877-879` |
| Low | 'html templates/' holds stale email templates that re-introduce a fixed bug | `html templates/signiture.html:1-60` |
| Low | 14 orphaned woff2 files (337 KB) are byte-identical copies of the 400 face | `assets/fonts.css:28-90` |
| Low | Three orphaned logo PNGs, 513 KB, publicly fetchable | `assets/logos/secondary.png:1` |
| Low | data/labor.js is fully dead — LTP_DATA_ASSIGNMENTS is never read | `data/labor.js:1` |
| Low | Two icon generators write the same six paths from different source art | `assets/icons/generate_icons.py:59-74` |
| Low | Two unused Saira TTF weights (168 KB) never registered by the PDF generator | `assets/fonts/SairaExtraCondensed-Thin.ttf:1` |
| Nit | Three unused imports in backend/ | `backend/database.py:10` |
| Nit | 'html templates/' directory is unreferenced by any code, build, or doc | `html templates/signiture.html:1` |
| Nit | window.LTP_entityIdOf defined and never called | `components/entity-quick-form.js:78` |
| Nit | ALLOC_STATES exported on window.LTP_RENTALS but never read | `modules/rentals-utils.js:279` |
| Nit | index.html comment points at a deleted vendor file | `index.html:363-365` |

</details>


### 4. Refactoring opportunities

```
[Medium] Line-item money math is implemented three times and has already drifted
  File: backend/qbo_sync.py:872-937
  What: The "effective unit price = adjustedPrice ?? unitPrice" rule and the global-discount semantics (percent / amount / flat / target) exist in three independent server copies plus the frontend: pdf_generator.py:294-319 (_calc_totals, the PDF's authoritative totals), pdf_generator.py:695 and :752 (recomputed twice more inside _draw_section), and qbo_sync.py:685-687 and :873-876 + :919-937 (what actually posts to QuickBooks). Both server copies carry a comment claiming to mirror the same theme.js function.
  Why it matters: This duplication has already produced a production money bug, documented in the comment at qbo_sync.py:920-930: the discount branch matched only "flat", so a "$" discount rendered on the client's PDF but posted no discount line to QuickBooks — the client paid the PDF figure, QB kept a phantom balance, and the receipt poller never marked the invoice paid. The copies still differ: qbo_sync.py:934 clamps the discount with min(amount, subtotal) and pdf_generator.py:319 only clamps with max(after, 0); qbo_sync …
  Fix sketch: Extract a `backend/money.py` with `effective_unit_price(line)`, `line_amount(line)` and `apply_global_discount(subtotal, global_discount)` as pure functions, and have _calc_totals, _draw_section and _build_sales_lines all call them. Pin the shared semantics with a table-driven test that asserts the PDF total and the QuickBooks Line[] sum agree to the cent for percent/amount/flat/target and for adjustedPrice lines. LOAD-BEARING (money + the customer-facing …
  Confidence: High
```
> *Assumes:* The cent-level PDF-vs-QuickBooks divergence from the rounding difference is inferred from reading both accumulators, not reproduced.  
> *Verifier narrowed this:* The line-item money math (effective price = adjustedPrice ?? unitPrice, and the percent/amount/flat/target discount rules) is implemented independently in two server copies — backend/pdf_generator.py::_calc_totals (294-329) and backend/qbo_sync.py::_build_sales_lines (872-939) — and three frontend copies (theme.js::LTP_INVOICE_TOTALS, theme.js::LTP_QUOTE_TOTALS, modules/client-view.js::calcTotals), with a fourth mirror in tests/test_line_item_price_stickiness.py. (The cited pdf_generator.py:695 and :752 are display-only per-line echoes inside _draw_section and carry no discount logic.) This …

```
[Medium] Twenty-plus cross-module reaches into underscore-private helpers
  File: backend/routes/qbo.py:168-246
  What: Modules routinely import or call other modules' private helpers. routes/qbo.py calls quickbooks._aware six times (:168, :211, :219, :227, :246, :602) and qbo_sync._settings_get three times (:498, :501, :502, :616); qbo_payouts.py:30 imports `_bill_addr, _safe_name, _settings_get` from qbo_sync; qbo_bill_poll.py:22 imports `_stamp` from qbo_payouts; qbo_receipts.py calls qbo_sync._invoice_ref and qbo_sync._stamp (:381, :384, :424); routes/api.py:16 imports `_fetch_and_cache_photo` from routes/auth.py; …
  Why it matters: The underscore prefix is the codebase's own signal for "internal, safe to change", and it is false everywhere above — a refactor of qbo_sync's settings accessor or quickbooks' tz helper silently breaks three other modules with no import-level warning. More concretely, the app's generic settings key-value reader (_settings_get, qbo_sync.py:92) and the generic tz normalizer (_aware, quickbooks.py:176) live inside QuickBooks-specific modules, so every consumer of a workspace setting now depends on the QuickBooks …
  Fix sketch: Promote the genuinely shared helpers out of their host modules: `backend/settings_store.py` for _settings_row/_settings_get/_settings_set, `backend/timeutil.py` for _aware, `backend/activity.py` (already exists, 42 lines) for the two _stamp variants. Then rename them without the underscore and leave thin re-export shims at the old names for one commit. LOW-RISK: pure moves, no behavior change, and the call sites are enumerable with one grep.
  Confidence: High
```
> *Adversarial verify:* CONFIRMED

```
[Medium] Two 1,700-2,000 line single functions: InvoiceBuilder and QuotesBuilder
  File: modules/invoices.js:636-2643
  What: InvoiceBuilder is one 2,008-line function (invoices.js:636-2643) and QuotesBuilder is one 1,704-line function (quotes-builder.js:1237-2940). Each declares ~45 nested inner functions and 21 destructured props (invoices.js:636-638, quotes-builder.js:1237), and each closes with a single React.createElement return spanning ~1,200 lines. The next largest offenders are labor.js AssignmentsTab at 931 lines (612-1542), settings.js SettingsView at 899 (150-1048), rentals-scan.js RentalsScanSession at 880 (157-1036), …
  Why it matters: Nothing inside these can be unit-tested, and every handler closes over the full 21-prop scope, so the compiler-free environment gives no signal when a rename or a prop drop leaves a stale reference. It is also the direct cause of the duplication in the next finding: because the send flow, the reorder logic and the totals panel live inside the closure, the only way to reuse them in the sibling builder was to copy them.
  Fix sketch: Extract the closure-independent halves first, in this order (each is a pure move): (a) the send-modal render tree — quotes-builder.js:2869-2905 / invoices.js:2506-2560 — into a components/doc-send-modal.js taking {entity, refDisplay, recipients, subject, body, onSend}; (b) the reorder cluster (sortMove/moveItem/moveSection/moveItemAnimated/moveSectionAnimated) into a components/doc-sections.js hook; (c) the totals panel (quotes-builder.js:963-1050). The …
  Confidence: High
```
> *Verifier narrowed this:* InvoiceBuilder is a single 2,008-line function (modules/invoices.js:636-2643) and QuotesBuilder a single 1,704-line function (modules/quotes-builder.js:1237-2940). InvoiceBuilder declares 41 nested inner functions over 20 destructured props; QuotesBuilder declares 34 over 21. Each ends in one React.createElement return of roughly 650-670 lines (invoices.js:1976-2643, quotes-builder.js:2290-2940). The next largest offenders are labor.js AssignmentsTab (612-1542, 931 lines), settings.js SettingsView (150-1048, 899), rentals-scan.js RentalsScanSession (157-1036, 880), …

<details>
<summary><strong>19 Low / Nit in this category</strong></summary>

| Sev | Finding | Location |
|---|---|---|
| Low | qbAccountOptions copy-pasted into three modules, plus a fourth variant | `modules/quotes-products.js:13-28` |
| Low | Mobile-breakpoint matchMedia effect hand-rolled twice despite a shared hook | `modules/client-view.js:462-470` |
| Low | Two ~95-line poll-cycle drivers are copies, and one already has a fix the other lacks | `backend/qbo_receipts.py:489-595` |
| Low | Crew payout money travels an untyped, undocumented dict pipeline | `backend/payouts.py:188-301` |
| Low | Public token-authenticated endpoints parse raw dicts with hand-rolled validation | `backend/routes/view.py:386-452` |
| Low | Gmail send pipeline duplicated between a route and a poller, with a route->service back-import | `backend/qbo_receipts.py:280-355` |
| Low | payout_preview_route is a 123-line handler mixing four concerns | `backend/routes/qbo.py:576-698` |
| Low | _shared.py mixes DB access, serialization and public-view authorization | `backend/routes/_shared.py:92-334` |
| Low | routes/qbo.py answers errors with JSONResponse while every other router raises | `backend/routes/qbo.py:590-593` |
| Low | main.py mixes six concerns in 837 lines; proposed decomposition | `backend/main.py:28-837` |
| Low | theme.js is 96% not-theme: 2,529 of 2,626 lines are business logic | `theme.js:1-2626` |
| Low | quotes-builder/invoices duplication measured: 466 lines at >=70% similarity | `modules/quotes-builder.js:1237-2940` |
| Low | data-state.js is not actually a chokepoint — its API helpers are IIFE-private | `components/data-state.js:336-338` |
| Low | Business math stranded in view modules — rental pricing engine is unreachable from invoices | `modules/quotes-builder.js:150-217` |
| Low | Modal/confirm pattern is three patterns; a money guard still uses native confirm() | `modules/invoices.js:2499` |
| Low | 21-prop builder signatures; React context is available with no build step | `modules/quotes-builder.js:1237` |
| Low | DOM escape hatch inside a React tree: getElementById on a hardcoded id | `modules/settings.js:532-546` |
| Nit | Byte-identical public-page CSS duplicated in client-view and crew-view | `modules/client-view.js:133-149` |
| Nit | rentals-* and crm-* families are NOT meaningfully duplicated — do not merge them | `modules/rentals-containers.js:1-546` |

</details>


### 5. PWA conversion readiness

```
[Medium] Every deploy serves one launch of new HTML against the previous shell's JS
  File: sw.js:229-245
  What: Navigations are network-first (sw.js:229-245) so index.html is always the freshly deployed copy, while every script it references is cache-first stale-while-revalidate (sw.js:264-277) served out of the OLD worker's cache. The newly installed worker sits in `waiting` and does not control the page, so its fresh cache is not used until the user taps Refresh.
  Why it matters: On the first launch after any deploy, a returning device runs the new index.html — new inline CSS, new/reordered <script> tags, new class names — against the previous generation of app.js/theme.js/modules. In an architecture whose only linkage is window globals and a hand-maintained load order (index.html:225-259), that is a mixed shell by construction, and it is not fixed by bumping CACHE_VERSION: the bump only queues a banner. Symptoms are the class the sw.js comments already describe (a shipped fix invisible …
  Fix sketch: Either make the shell self-consistent per generation — serve index.html cache-first from the active cache so HTML and JS always come from the same version — or make the new worker take over eagerly for a shell change. Whichever is chosen, HTML and its subresources must share one freshness policy.
  Confidence: High
```
> *Verifier narrowed this:* Because navigations are network-first (sw.js:229-245) while same-origin scripts are stale-while-revalidate out of the ACTIVE worker's cache (sw.js:264-277), and install deliberately does not skipWaiting (sw.js:118-132), the first launch after any deploy on a returning device runs the newly deployed index.html against the PREVIOUSLY cached copies of app.js/theme.js/router.js and any already-cached /components, /modules, /data file. Scripts newly added by that deploy are cache misses and load fresh, so a brand-new component can execute against stale globals in an architecture whose only linkage …

```
[Medium] Offline writes fail completely silently — edits look saved, then vanish
  File: components/data-state.js:178-192
  What: recordError() is only reached from checkResponse() (line 73, HTTP-level failures) and fetchInitial()'s catch (line 120). The sync path swallows rejections with bare `p.then(function(){return true;}, function(){return false;})` at lines 180 and 191 — no recordError, no console, no LTP_API_ERRORS push, no `ltp-api-error` event. A network-level fetch rejection (TypeError, i.e. exactly the offline case) therefore produces zero user-visible signal. The comment on line 178 asserts "the errors were already logged via …
  Why it matters: The service worker precaches the shell (sw.js SAME_ORIGIN_PRECACHE) specifically so the installed app opens offline. A user on a job site with no signal launches the app, edits a quote's line items, sees the change render, gets no error and no offline indicator. The 400ms debounce fires, every PUT/POST rejects at the network layer, prevSyncedRef stays put, and nothing is shown. Closing the app (the normal thing to do) discards the React state and the edit is gone permanently. This is the worst possible failure …
  Fix sketch: Route network rejections through recordError the same way HTTP failures are: in jsonReq (line 83) add a `.catch` that calls recordError(label, {error: String(e)}) before rethrowing, so the existing toast surface fires. Separately, gate the UI: add an `online`/`offline` listener (there is currently no navigator.onLine reference anywhere in the tree) that shows a persistent "offline — changes are not being saved" banner, and consider mirroring dirty slices …
  Confidence: High
```
> *Verifier narrowed this:* Network-layer fetch rejections in the sync path are swallowed with no error surfacing. jsonReq (data-state.js:84-91) routes responses through checkResponse only on fulfillment, so an offline TypeError never reaches recordError(); the collectors at lines 179-180 (entities) and 190-191 (settings) turn the rejection into `false` with no console.error, no LTP_API_ERRORS entry, and no ltp-api-error toast, and because the rejection is handled the global unhandledrejection listener (error-boundary.js:89) does not fire either. The comment at lines 177-178 ("the errors were already logged via …

<details>
<summary><strong>17 Low / Nit in this category</strong></summary>

| Sev | Finding | Location |
|---|---|---|
| Low | SWR revalidation is not held open by event.waitUntil | `sw.js:264-277` |
| Low | Update banner can be missed for a whole session (updatefound listener attached too late) | `components/register-sw.js:149-165` |
| Low | Nothing ever calls registration.update(); a long-lived PWA session never checks | `components/register-sw.js:143-169` |
| Low | controllerchange reload ignores the app's own unsaved-changes guard | `components/register-sw.js:64-68` |
| Low | Version guard cannot catch two branches choosing the same new version string | `tests/check_shell_version.py:154-168` |
| Low | CACHE_VERSION guard is skipped entirely on a direct push to the default branch | `.github/workflows/tests.yml:26-45` |
| Low | A stale precache path cannot fail install — the SPA fallback returns 200 HTML | `sw.js:118-132` |
| Low | First-ever service-worker install triggers an unexpected full page reload | `components/register-sw.js:61-68` |
| Low | Offline launch of the installed app shows the sign-in wall and dead-ends | `components/auth.js:58-66` |
| Low | First-visit service worker claim triggers an unguarded auto-reload | `components/register-sw.js:61-68` |
| Low | Activity-feed PDF links lack the standalone workaround the same file already implements | `modules/quotes-builder.js:2733-2738` |
| Low | Push "on" state is read from the browser only and never reconciled with the server | `components/push.js:96-101` |
| Low | Crew-removal outbox lives only in this browser's localStorage | `components/crew-outbox.js:20-41` |
| Low | Print flows call window.open with no null check — throws when popups are unavailable | `modules/crm-notes.js:76-88` |
| Low | Payout CSV export uses a detached anchor and revokes the blob URL synchronously | `modules/labor.js:2180-2185` |
| Low | Manifest hard-locks portrait and omits install-UX fields | `manifest.webmanifest:1-9` |
| Nit | Refresh fallback timer can produce a second reload | `components/register-sw.js:114-121` |

</details>


### 6. Performance

```
[Medium] Receipt poller candidate set never retires; id-ordered cap starves new invoices
  File: backend/qbo_receipts.py:472-486
  What: _candidate_invoices selects every QB-linked, non-draft invoice whose receipt_email_status is NULL/pending/failed, ordered by `models.Invoice.id` ASC with a 200-row cap. An invoice that is simply unpaid stays status-NULL forever (_process_invoice returns "open" at :377 without writing a status), and a permanently-unsendable one parks on "failed" (:420) and is retried forever. Nothing ages out of the candidate set except a successfully sent receipt.
  Why it matters: Per-cycle cost is one QuickBooks HTTP round-trip plus a `load_connection` SELECT per candidate (:536-539), so it grows linearly with the count of historical unpaid/failed invoices — forever, every 2 hours. Worse, once that set exceeds 200, the `order_by(id)` cap means the oldest 200 stale invoices consume the entire cycle and every newer invoice is never polled again: customer payment receipts silently stop being sent, with no error anywhere. The sibling poller has exactly this structure and explicitly fixes it — …
  Fix sketch: Mirror the bill poller: add a `qb_last_checked_at` column to invoices, stamp it in _process_invoice, and order the candidate query by it (nullsfirst) instead of by id. Optionally also bound the set by age (skip invoices older than N months with no QB activity) and add a partial index on invoices (receipt_email_status) WHERE qb_invoice_id IS NOT NULL so the scan does not walk the whole invoices table.
  Confidence: High
```
> *Assumes:* Starvation requires the candidate set to exceed _MAX_INVOICES_PER_CYCLE = 200 (qbo_receipts.py:81); the linear per-cycle growth is already happening at any size.  
> *Verifier narrowed this:* The receipt poller's candidate set never retires stale rows and is polled in a fixed id order, so it can permanently starve newer invoices. `_candidate_invoices` (backend/qbo_receipts.py:472-486) selects every QB-linked, non-draft invoice whose `receipt_email_status` is NULL/pending/failed, ordered by `Invoice.id` ASC and capped at 200. An unpaid invoice keeps a NULL status forever (`_process_invoice` returns "open" at :378 without writing one), an unaddressable one parks on 'failed' (:420) and is retried every cycle, and an invoice deleted in QuickBooks is skipped on 404 (:566-574) but …

```
[Medium] Every CRUD list endpoint SELECTs the whole table with no LIMIT
  File: backend/routes/api.py:212-214
  What: The generated `get_all` is `select(model_cls).order_by(model_cls.id)` with no LIMIT, offset, or filter, registered for all 13 entities at api.py:373-390. components/data-state.js:22-26 fires one GET per entity on mount, so a cold load pulls companies, contacts, projects, quotes, invoices, equipment, products, services, fees, client-rates, allocations, containers and kits in full.
  Why it matters: Six of those tables grow without bound with the business: projects (each row carrying `schedule`, `schedule_activity`, `notes`, `meetings`, `budget` JSON — models.py:145-158), quotes and invoices (each carrying `sections`, `activity`, `payments` JSON that grows on every save, email, PDF generation and client view), allocations, contacts, companies. `schedule_activity` and `activity` are append-only logs that never shrink. There is no pagination, no archiving, and no server-side filtering anywhere, so cold-load …
  Fix sketch: Add server-side filtering/pagination to the growth entities (quotes, invoices, projects, allocations) — at minimum a date/status filter and a LIMIT with a cursor — and have data-state.js request only the working set. As a cheaper interim step, add `defer()` on the heaviest JSON columns (`activity`, `schedule_activity`, `meetings`, `notes`) for the list route and load them only in `get_one`.
  Confidence: High
```
> *Adversarial verify:* CONFIRMED

```
[Medium] Every route's code loads eagerly; ~900 KB is route-specific
  File: index.html:348-397
  What: All feature modules load for every user on every page regardless of route. The route-specific bulk: labor.js 206 KB, quotes-builder.js 199 KB, invoices.js 195 KB, settings.js 82 KB (admin-only — non-admins are refused the module at app.js:456 yet still download it), rentals-scan.js 60 KB, schedule-editor.js 57 KB, client-view.js 52 KB, schedule-builder.js 49 KB, rentals-containers.js 42 KB, crm-projects.js 42 KB. That is roughly 900 KB — half the payload — for screens most sessions never open.
  Why it matters: This is the second-largest first-load lever after compression, and unlike compression it also removes parse and execute time, not just bytes. Even gzipped, ~215 KB of the 433 KB transferred is code for routes the session will not visit.
  Fix sketch: Feasible without a build step, and I checked the constraint that would block it: every heavy module is an IIFE that captures only boot-tier globals at entry (labor.js:6-11, quotes-builder.js:21-25, invoices.js:6-11, schedule-builder.js:6-11, schedule-editor.js:5-8 all read window.LTP_THEME / LTPRouter / LTP_* helpers, which come from theme.js, router.js and ui.js), and app.js references the modules only through `window.X` at render time …
  Confidence: Medium
```
> *Assumes:* That the per-shell groupings in index.html (6a/6c/6d) are the natural lazy-load units. A module with an undocumented load-time dependency on a sibling would need to travel with it.  
> *Verifier narrowed this:* Every feature module is loaded eagerly with plain synchronous <script> tags (index.html:348-397, plus components/schedule-editor.js at line 341), so all route code executes on every cold load regardless of route. The route-specific set totals ~984 KB uncompressed of the ~1.81 MB of local JS (~54%): labor.js 206 KB, quotes-builder.js 199 KB, invoices.js 195 KB, settings.js 82 KB (admin-only — app.js:455 refuses non-admins the view yet the module still loads), rentals-scan.js 60 KB, components/schedule-editor.js 57 KB, client-view.js 52 KB, schedule-builder.js 49 KB, rentals-containers.js 42 …

```
[Medium] Company logos stored as un-resized data: URLs, shipped in every list fetch
  File: components/ui.js:648-657
  What: `ImageUpload.handleFile` does `reader.readAsDataURL(file)` and hands the raw result straight to onChange with no size check and no downscaling. crm-companies.js:106 stores it in `logo`, which is a plain `Text` column documented as 'URL or data:image base64' (backend/models.py:44). It is not deferred (unlike User.photo_data, which the model comments at :696-704 correctly mark deferred for exactly this reason), so `_row_to_dict` returns it in full for every company on every GET /api/companies. The payload ceiling is …
  Why it matters: One person picking a photo from their phone camera roll — a 3 MB JPEG becomes ~4 MB of base64 — permanently adds 4 MB to the companies list that every user downloads on every cold start, and 8 MB of JSON.stringify work to every companies sync via finding #6. Nothing in the path warns or resists; the upload simply succeeds and the app gets slower for everyone, forever.
  Fix sketch: Downscale in handleFile before storing: draw the decoded image to a canvas capped at ~256px on the long edge and `toDataURL('image/webp', 0.85)`, which puts a logo in the low tens of KB. Reject files over a sane threshold with a toast. For existing rows, either mark `logo` deferred and serve it from a dedicated per-company endpoint (mirroring the User.photo_token pattern already built at models.py:703-706) or strip it from the list projection.
  Confidence: High
```
> *Adversarial verify:* CONFIRMED

```
[Medium] Public share-link viewers download the entire internal application
  File: app.js:44-53
  What: `#/view/<token>` and `#/crew/<token>` are served by the same index.html as the signed-in app (backend/main.py:836 falls through to _index_response), so the outer LTPApp renders LTPClientView or LTPCrewView only after the browser has already downloaded, parsed and executed all 73 scripts. A client reviewing a quote needs client-view.js (52 KB), theme.js, ui.js, React and signature_pad — roughly 250 KB of the 1.81 MB. The other ~1.55 MB is the internal app: labor payouts, the QuickBooks integration, settings, …
  Why it matters: The share link is the app's most latency-sensitive surface — an external client on cellular, often on the first impression, with no service-worker cache and no incentive to wait. They pay the full 1.81 MB (433 KB gzipped) to see one document. Worth noting for the security reviewer separately: this also delivers the complete internal frontend source — cost fields, margin math, payout logic — to an unauthenticated third party holding only a share token, which is a wider exposure than the API payload trimming in …
  Fix sketch: Serve the public routes from a separate, minimal HTML entry (main.py already has dedicated routes for /sw.js and /manifest.webmanifest at :718 and :744, so adding /view and /crew entries is the same pattern) loading only React, theme.js, ui.js, sanitize.js, signature_pad and the one view module. Alternatively, land the lazy-loading of finding #4 first — the public path then naturally pulls only its own module.
  Confidence: High
```
> *Verifier narrowed this:* Public share-link viewers download the entire internal application. `#/view/<token>` and `#/crew/<token>` are hash routes, so the request reaching the backend is just `GET /`, which serve_frontend answers with the same index.html as the signed-in app (backend/main.py:837). index.html loads 73 local scripts as plain, non-deferred, render-blocking tags — 1,806,374 bytes (433 KB gzipped) — and app.js only picks LTPClientView / LTPCrewView at app.js:45-53, after all of them have executed. A client reviewing a quote needs roughly 250 KB of that (client-view.js 52 KB, theme.js for …

<details>
<summary><strong>18 Low / Nit in this category</strong></summary>

| Sev | Finding | Location |
|---|---|---|
| Low | Whole-table JSON responses are encoded on the single event loop | `backend/routes/api.py:212-214` |
| Low | QuickBooks sync issues 3-4 queries per line item (settings singleton re-read per line) | `backend/qbo_sync.py:860-886` |
| Low | Payout engine loads every project row to derive one two-week period | `backend/payouts.py:312-318` |
| Low | Payout preview loads the entire payout_bill_lines ledger unfiltered | `backend/routes/qbo.py:626` |
| Low | No index on payout_bill_lines.date, which the day-status route range-scans | `backend/models.py:1038-1047` |
| Low | GET /api/crew-requests returns every request ever, and writes on every read | `backend/routes/crew.py:702-712` |
| Low | Web push fans out sequentially inside the public client-view request | `backend/webpush.py:86-96` |
| Low | Receipt poller scans the whole contacts table and filters a JSON array in Python | `backend/qbo_receipts.py:234-235` |
| Low | FK validation issues one SELECT per foreign-key column on every write | `backend/routes/api.py:145-152` |
| Low | 1.81 MB of uncompressed JS, 73 render-blocking scripts, no defer | `index.html:264-414` |
| Low | Global search rescans every entity with nested O(n*m) lookups per keystroke | `app.js:300-412` |
| Low | Line-item editors re-render the entire builder tree on every keystroke | `modules/quotes-builder.js:2577-2595` |
| Low | Service worker discards the entire runtime cache on every version bump | `sw.js:134-145` |
| Low | Sync diff JSON.stringifies every row of an entity list on every save | `components/data-state.js:172` |
| Low | All 13 collections fetched unbounded on mount; first render hard-gated on all of them | `app.js:186-189` |
| Low | FLIP reorder animation forces two synchronous layouts per element in a loop | `components/sortable.js:148-164` |
| Low | Open dropdown re-measures and re-renders on every capture-phase scroll event | `components/search-dropdown.js:166-181` |
| Low | Unthrottled resize handler does a DOM probe and forces a full relayout | `components/viewport-height.js:42-60` |

</details>


### 7. Reliability & operability

```
[High] Receipt poller keeps a stale `sender` ORM object across per-invoice rollbacks
  File: backend/qbo_receipts.py:512-516
  What: `sender` (a models.User) is loaded once before the loop at 512-516 and reused for every invoice. Inside the loop the code deliberately re-loads `conn` (531-538) and `invoice` (539) after a rollback, with a comment explaining that "a per-invoice rollback expires EVERY ORM object in the session" and that touching an expired attribute raises MissingGreenlet — but `sender` was never added to that list.
  Why it matters: After any rollback in the loop (the object-level 400/404 continue at 567-575, or the generic handler at 585-587), `sender` is expired. The next paid invoice reaches _render_signature/gmail.send, which read sender.name / sender.email / sender.gmail_refresh_token — an implicit lazy load in async context → MissingGreenlet → caught by the generic `except Exception` at 585 and logged as "invoice N failed (continuing)". Because candidates are ordered by id, one invoice that was deleted in QuickBooks but still carries a …
  Fix sketch: Re-load the sender inside the loop the same way conn is (`sender = await db.get(models.User, sender_id)` guarded for None), or capture the two or three plain values needed (id, name, email) plus keep a fresh User handle only where gmail.send needs to write tokens back. A regression test that raises a generic exception on the first invoice and asserts the second still sends would lock it in.
  Confidence: High
```
> *Assumes:* Relies on SQLAlchemy expiring all session-resident instances on rollback — the behaviour the file's own comments at :523-525 and :531-534 already assert.  
> *Adversarial verify:* CONFIRMED

```
[High] 409 fallback blind-PUTs, overwriting another user's record with the same id
  File: components/data-state.js:156-171
  What: New rows are created with a client-minted id (app.js:245-259 takes max(local id)+1). If the server already has that id, POST returns 409 (backend/routes/api.py:237-246) and syncEntity's catch re-routes the payload to PUT /api/{key}/{id}, a whole-object overwrite.
  Why it matters: Two clients that mint the same next id — a second user, a second tab, or one browser whose snapshot predates the other's create — produce a 409 whose "recovery" silently replaces the other party's quote/invoice/company with unrelated content. The victim's record is not merged or renumbered, it is destroyed, and the only trace is a success path (no toast at all).
  Fix sketch: On 409, don't PUT blind: re-mint the id (fetch the current max from the server or ask for a server-assigned id via POST without an id) and re-POST, keeping the local row's identity in sync. Only fall back to PUT when the local baseline can prove the row is ours (e.g. the server's row carries the same shareToken).
  Confidence: Medium
```
> *Assumes:* More than one client (second user or second tab/device) can be creating entities of the same kind concurrently.  
> *Verifier narrowed this:* syncEntity's 409 recovery (components/data-state.js:156-171, catch at 163-171) re-routes a failed create to PUT /api/{key}/{id}, which api.py:275-352 applies as a whole-object overwrite of whatever row already holds that id. Because ids are client-minted as max(local id)+1 (app.js:242-269 for quotes/invoices; crm-shell.js:245/270, projects.js:308, quotes-fees.js:161 for the rest) and the frontend never refetches after the initial load, any second writer working from a stale snapshot — a second user or simply a second tab — mints a colliding id and silently replaces the existing record's …

```
[High] Web push sends have no HTTP timeout — unbounded block on a user-settable URL
  File: backend/webpush.py:57-63
  What: `_send_one` calls `pywebpush.webpush(...)` without a `timeout` argument. In the pinned pywebpush==2.0.0 the parameter defaults to `None` and is passed through verbatim to `requests.post(endpoint, timeout=timeout, ...)`, so the underlying request has NO timeout at all. (`WebPusher.send` only applies its own 10000s fallback when the key is absent from kwargs, which it never is here.) The `endpoint` it posts to comes straight off the `PushSubscription` row, and backend/routes/push.py:47-74 stores whatever string the …
  Why it matters: `_deliver` (webpush.py:86-98) awaits each send sequentially, so one unresponsive endpoint blocks the caller forever — and the callers include unauthenticated public routes: backend/routes/view.py:262 (`_notify_doc_viewed`, fired from the share-link view gate) and view.py:377 (quote accept/decline). The request never completes, its DB connection is never returned to the 15-connection pool, and the pywebpush worker thread is leaked from the shared asyncio default executor permanently. There is no recovery short of a …
  Fix sketch: Pass an explicit `timeout=(5, 10)` (connect, read) to `webpush(...)` in `_send_one`. Separately, validate the endpoint at subscribe time in routes/push.py — require https and an allowlist of known push-service hosts (fcm.googleapis.com, web.push.apple.com, *.notify.windows.com, updates.push.services.mozilla.com) — and consider wrapping each `asyncio.to_thread(_send_one, ...)` in `asyncio.wait_for` so a hung thread can't hold the awaiting coroutine.
  Confidence: High
```
> *Verifier narrowed this:* `_send_one` (backend/webpush.py:52-63) calls `pywebpush.webpush(...)` without `timeout`. In the installed pywebpush 2.0.0 the parameter defaults to `None` (L468) and is forwarded verbatim (L576) into `WebPusher.send`, whose `kwargs.pop("timeout", 10000)` (L410) returns that explicit `None` rather than the 10000 fallback, producing `requests.post(endpoint, timeout=None)` (L421-424) — no socket timeout at all. The endpoint is taken verbatim from the `PushSubscription` row, which `/api/push/subscribe` (backend/routes/push.py:38-74) stores with no scheme or host validation. Because `_deliver` …

```
[Medium] Rotated Gmail refresh token is flushed, not committed — lost on rollback
  File: backend/gmail.py:200-212
  What: refresh_if_needed writes the rotated refresh_token/access_token onto the User row and ends with `await db.flush()` (line 211) — no commit. Google has already invalidated the old refresh token by the time that response arrives, so if the enclosing request transaction later rolls back, the only usable refresh token is destroyed.
  Why it matters: Concrete path: POST /api/email/send → gmail.send → refresh_if_needed rotates the token (flush only) → Gmail rejects the message (bad address, quota) → GmailSendError → routes/email.py:358 raises HTTPException(502) → get_db (backend/database.py:51-53) rolls back → the new refresh token is gone and the old one is dead. That user's Gmail is permanently disconnected until they re-consent, and every subsequent send by them fails with invalid_grant. The identical QuickBooks code path got this exactly right — …
  Fix sketch: Mirror quickbooks._persist_refresh: `await db.commit()` (not flush) after writing the rotated tokens, and after the invalid_grant clear at :174. The poller path already commits per invoice so it is unaffected; committing here makes the behaviour uniform across all callers.
  Confidence: High
```
> *Verifier narrowed this:* gmail.refresh_if_needed persists token state with `await db.flush()` only (gmail.py:174 and 211), never a commit, so any state it writes is discarded if the enclosing request later rolls back. On the /api/email/send path this is concretely reachable: gmail.send → refresh_if_needed → Gmail rejects the message → GmailSendError → routes/email.py:358 HTTPException(502) → get_db (database.py:51-53) rollback. Two consequences, of different weight: (a) the routine one — an invalid_grant token-clear at gmail.py:171-174 is undone by the 409 at routes/email.py:350, so gmailConnected keeps reporting …

```
[Medium] Auto-receipt has no exactly-once guard between Gmail send and commit
  File: backend/qbo_receipts.py:318-355
  What: _send_receipt calls gmail.send at :319 and only afterwards sets receipt_email_sent_at (:353) and returns 'sent'; the durable record is written by `await db.commit()` back in run_receipt_poll at :555. The EmailRecipient rows flushed at :312-313 are in the same uncommitted transaction, so they vanish with it. Nothing outside the transaction records that the message left the building.
  Why it matters: Any interruption in that window re-sends a real client a duplicate payment receipt on the next cycle: a Railway redeploy SIGTERM lands as CancelledError (a BaseException, so it bypasses the generic handler at :585) and tears down the session with the send already delivered; a transient DB failure on the commit is caught at :585, logged "invoice N failed (continuing)", and re-queues the same invoice because its receipt_email_status is still null. The candidate query (:476-486) has no send-attempt marker to key off. …
  Fix sketch: Write an intent marker in its own committed transaction before the external call — e.g. set receipt_email_status='sending' + commit, then send, then commit the terminal state — and exclude 'sending' rows older than N minutes from the candidate set pending manual review. A Postgres advisory lock around run_receipt_poll would additionally make the loop safe against a second process.
  Confidence: High
```
> *Assumes:* Single uvicorn worker / single replica today; the multi-process half of the exposure depends on that assumption holding.  
> *Adversarial verify:* CONFIRMED

```
[Medium] No error boundary at the React root — shell and public views fail to a blank page
  File: mount.js:7-8
  What: The root renders window.LTPApp bare. LTPErrorBoundary is only applied inside renderModule (app.js:416-456), so the outer gate, LTPSignedInApp's shell (topbar, global-search effect, sidebar, toasts) and both token-only public views — LTPClientView (app.js:45-47) and LTPCrewView (app.js:51-52) — have no boundary above them.
  Why it matters: React unmounts the entire tree on an uncaught render/effect error. A throw in the shell blanks the whole app with no Retry card and no error text; a throw in the client view shows a paying customer a white page on the quote they were invited to sign, with nothing logged for them to report.
  Fix sketch: Wrap the root element in mount.js with LTPErrorBoundary (name "App"), and wrap the two public-view returns in app.js with their own boundary carrying customer-appropriate copy.
  Confidence: High
```
> *Verifier narrowed this:* mount.js:7-8 renders `window.LTPApp` with no error boundary above it. `LTPErrorBoundary` (components/error-boundary.js:82) is applied only at the nine call sites inside `renderModule` (app.js:416-456), so the outer auth gate, LTPSignedInApp's shell (topbar, global-search effect, sidebar, toasts) and both token-only public views — LTPClientView (app.js:45-47) and LTPCrewView (app.js:51-53) — are unprotected. An uncaught render or effect throw in any of those unmounts the entire React tree and leaves a blank #root with no Retry card and no on-screen error text; a customer opening a share link …

```
[Medium] 401 anywhere hard-redirects to /auth/login, discarding unsynced state
  File: components/data-state.js:61-71
  What: checkResponse sets window.location.href = "/auth/login" on any 401 from any sync request (and fetchInitial does the same at :105-111). This fires from a background debounced sync the user did not initiate.
  Why it matters: Everything not yet accepted by the server — every module that writes straight into persistent state — is in memory only and is thrown away by the navigation; the explaining toast is destroyed with the page, so after re-login the user has no idea what was lost. Only the two builders raise a beforeunload prompt (theme.js:198), and finding #3 above disarms even that in the common case. On a captive portal that answers /api/* with a 401/302, this bounces the user out of the app on a timer with no way to see why.
  Fix sketch: On 401, stop the sync loop and surface a blocking "Session expired — sign in again" panel with a Sign-in button, instead of navigating away from unsynced state. Confirm the response really came from the app (e.g. a JSON body / custom header) before treating it as a session loss.
  Confidence: High
```
> *Verifier narrowed this:* checkResponse (components/data-state.js:66-71) and fetchInitial (:105-111) set window.location.href = "/auth/login" on any 401, and the 401 branch returns before recordError(), so no toast, console entry, or LTP_API_ERRORS record is ever produced. Because the sync is debounced 400ms after a user edit and the app keeps no localStorage cache, a session that expires mid-use can hard-navigate the page immediately after a "successful"-looking save — e.g. quotes-builder.js:1634-1638 does setQuotes(...) then setIsDirty(false), disarming the theme.js beforeunload guard, so the just-saved quote is …

```
[Medium] Missing DATABASE_URL silently boots on ephemeral SQLite in prod
  File: backend/database.py:26-38
  What: `DATABASE_URL = os.environ.get("DATABASE_URL", "")` at :26 followed by `if not DATABASE_URL: DATABASE_URL = "sqlite+aiosqlite:///./ltp_dev.db"` at :35-36. There is no environment gate on that fallback — no check of LTP_FORCE_HTTPS / LTP_OAUTH_REDIRECT_URI, both of which main.py:301-302 already computes as a production signal. alembic/env.py:52-53 mirrors the same unguarded fallback, so the migration run follows the app onto the same phantom file.
  Why it matters: If the Railway DATABASE_URL reference ever resolves empty (Postgres service unlinked or deleted, variable renamed, image redeployed into an environment where the DB isn't attached), the app does not fail — it creates ./ltp_dev.db inside the container, runs all 34 migrations against it, boots green, and serves a completely empty business suite. Every user sees zero quotes, invoices, projects and contacts. Worse, writes are accepted: anything created goes into container-local storage and is destroyed on the next …
  Fix sketch: Refuse the SQLite fallback when a production signal is present. Reuse the existing _IS_HTTPS logic (LTP_FORCE_HTTPS set, or LTP_OAUTH_REDIRECT_URI starting with https://): if either is true and DATABASE_URL is blank, raise RuntimeError at import time the way LTP_SESSION_SECRET already does at main.py:509-515. Mirror the same guard in alembic/env.py::_resolve_database_url so a CLI run can't quietly point at the wrong DB either.
  Confidence: High
```
> *Assumes:* Assumes DATABASE_URL can realistically become unset/blank on the Railway deployment. If the platform guarantees it, the severity drops to Low (defense-in-depth only) — the code behavior itself is …  
> *Verifier narrowed this:* backend/database.py:35-36 falls back to `sqlite+aiosqlite:///./ltp_dev.db` whenever DATABASE_URL is empty, with no environment gate, and alembic/env.py:52-53 mirrors it. The codebase already has the idiom this needs: main.py:301-302 computes `_IS_HTTPS` from LTP_FORCE_HTTPS or an https LTP_OAUTH_REDIRECT_URI, and main.py:503-510 uses it to hard-fail the boot when LTP_SESSION_SECRET is missing in production (SECURITY_REVIEW.md H6). That gate was never applied to the database URL. If DATABASE_URL ever resolves empty on the Railway deploy — Postgres service unlinked or deleted, variable renamed, …

<details>
<summary><strong>24 Low / Nit in this category</strong></summary>

| Sev | Finding | Location |
|---|---|---|
| Low | POST /api/sync destroys client_rates and orphans crew_requests/payout_bills | `backend/routes/api.py:639-680` |
| Low | Bare int() on LTP_TRUST_PROXY_HOPS crash-loops the container at import | `backend/rate_limit.py:142` |
| Low | Rotation script's read-then-commit window can clobber a concurrently rotated QBO refresh token | `backend/rotate_encryption_key.py:50, 63-78` |
| Low | crypto.py docstring claims import-time fail-fast; the implementation is lazy | `backend/crypto.py:24-25, 61-73` |
| Low | Swallowed tracking error can leave the session unusable and 500 the share-link render | `backend/routes/view.py:310-329` |
| Low | LTP_TOKEN_ENCRYPTION_KEY has no startup check; docstring claims it does | `backend/crypto.py:23-25` |
| Low | Bare int() on LTP_TRUST_PROXY_HOPS crash-loops the container at import | `backend/rate_limit.py:142` |
| Low | No healthcheckPath and no health endpoint anywhere in the app | `railway.json:6-10` |
| Low | Alembic stamp heuristic uses any() over four probe tables | `backend/database.py:121-124` |
| Low | Boot-time stack dumper fires every second during normal migrations | `backend/database.py:125-139` |
| Low | Documented middleware order does not match the actual stack | `backend/main.py:460-474` |
| Low | _env_int validates type but not range; interval 0 spins a hot loop | `backend/main.py:28-38` |
| Low | QBO_ENVIRONMENT silently defaults to sandbox and is frozen per connection | `backend/routes/qbo.py:51-53` |
| Low | DB session and open transaction held across every external HTTP call, untuned pool | `backend/database.py:38` |
| Low | Receipt poller can re-send a client's payment receipt after an interrupted cycle | `backend/qbo_receipts.py:319-352` |
| Low | No stack trace is ever captured outside database.py — swallowed poller errors are undebuggable | `backend/main.py:109` |
| Low | Main email route has no handler for Gmail transport errors, unlike the crew routes | `backend/routes/email.py:334-357` |
| Low | gmail.send does not handle 429 / rate limits or honor Retry-After | `backend/gmail.py:361-381` |
| Low | A Gmail send rejection produces no server-side log line at all | `backend/gmail.py:379-381` |
| Low | Pollers roll back the connection drop, so a dead QBO grant still reports connected | `backend/qbo_receipts.py:557-563` |
| Low | Poll cycles have no wall-clock budget and can exceed their own interval | `backend/qbo_receipts.py:81` |
| Low | Service worker caches the SPA HTML fallback under .js URLs (no content-type check) | `sw.js:266-270` |
| Low | httpx is a direct prod dependency but unpinned and absent from requirements.txt | `backend/gmail.py:46` |
| Low | pdf_archives grows without bound; no pruning path exists | `backend/routes/pdf.py:100-108` |

</details>


### 8. Tests & documentation

```
[High] 966 assertions across 14 test modules cannot fail under pytest
  File: tests/test_quickbooks_sync.py:59-63
  What: 14 modules define `def _check(label, cond, detail="")` that only appends to a module-global `_results` list and prints `[PASS]`/`[FAIL]`. The body contains no `assert` and no `raise` (AST-verified). The real gate lives in `main()` under `if __name__ == "__main__"` (e.g. tests/test_quickbooks_sync.py:1305-1306), which pytest never executes, so a failing check prints [FAIL] and pytest still reports the test as passed.
  Why it matters: Empirically proven, not inferred: `LTP_TRUST_PROXY_HOPS=9 python -m pytest tests/test_commit1_oauth_gmail.py -q -s` prints `[FAIL] single-hop XFF -> returns client IP` and `[FAIL] spoofed XFF -> returns rightmost (real proxy view) (got '127.0.0.1')`, then reports `11 passed in 0.61s`. Blast radius: 966 dead assertions inside 259 pytest-collected test functions — test_quickbooks_sync 201, test_qbo_receipts 102, test_commit2_send_pipeline 88, test_crew_integrity 84, test_header_block 74, test_commit3_view_tracking …
  Fix sketch: Append `assert cond, f"{label} {detail}"` as the last line of `_check` in the 14 affected modules, matching tests/test_activity_preservation.py:70. Standalone `python tests/test_x.py` runs keep working because `main()` catches nothing today and would just surface the first failure earlier — or wrap each call site in main() if the full-report-then-exit behavior is worth keeping. Then run the suite once and triage whatever real failures fall out.
  Confidence: High
```
> *Adversarial verify:* CONFIRMED

```
[High] Security mitigations from SECURITY_REVIEW have only fail-open tests
  File: tests/test_commit1_oauth_gmail.py:178-192
  What: The tests for several tracked security fixes exist only as dead `_check` calls. `_client_ip` XFF/proxy-hop parsing — the LTP_TRUST_PROXY_HOPS spoofing guard — is tested only at tests/test_commit1_oauth_gmail.py:178-192. `auth_deps.get_optional_user` (the non-raising session probe used by public routes) is tested only at tests/test_commit3_view_tracking.py:435-490. The public share-token route `/api/view/{token}` is exercised end-to-end only at tests/test_commit3_view_tracking.py:535-600. The admin user-list …
  Why it matters: These are exactly the code paths the prior audit hardened, and a regression in any of them stays green. My LTP_TRUST_PROXY_HOPS=9 experiment is a live demonstration: the rate-limit key derivation silently returned the loopback address instead of the real client IP and CI would have shipped it. If `_client_ip` regresses to trusting the leftmost (client-supplied) XFF entry, per-IP rate limiting on every public token route becomes trivially bypassable with no CI signal. Separately, nothing in the suite asserts that …
  Fix sketch: After making `_check` raise (finding 1), add explicit negative-path cases for `/api/view/{token}`: unknown token -> 404, and a draft/unsent document -> not publicly readable, mirroring tests/test_crew_requests.py:482-483.
  Confidence: High
```
> **Prior review `H2` — fix incomplete.**  
> *Adversarial verify:* CONFIRMED

```
[Medium] QuickBooks sync, receipt poller and PDF money math have no enforced coverage
  File: tests/test_qbo_receipts.py:56-60
  What: Every test for the QuickBooks invoice-sync engine (backend/qbo_sync.py, backend/quickbooks.py) lives in tests/test_quickbooks_sync.py (201 dead checks: token refresh/rotation, invalid_grant handling, 401 retry, invoice payload + tax + discount construction, item/income-account resolution and repointing, customer reactivation, delete-in-QB). Every test for the auto-receipt poller (backend/qbo_receipts.py) lives in tests/test_qbo_receipts.py (102 dead checks: mark-paid idempotency, synthetic-payment reconciliation, …
  Why it matters: These are the money-moving paths. The whole reason tests/test_sales_tax_plumbing.py exists (per its own docstring at lines 1-40) is a shipped bug where the quote's serialized shape returned `None` tax, so the emailed total and the linked quote/PDF disagreed permanently. That exact regression would now re-ship green. Same for a QBO line-item mapping error pushing wrong amounts into a customer's books, or the receipt poller double-sending or losing a paid reconciliation. The modules with real asserts …
  Fix sketch: Prioritize the `_check` fix (finding 1) on test_quickbooks_sync.py, test_qbo_receipts.py, test_crew_integrity.py and test_sales_tax_plumbing.py first — that is 423 of the 966 dead assertions and it restores signal on every money path in one change.
  Confidence: High
```
> *Verifier narrowed this:* Four backend test files use a non-raising `_check(label, cond)` helper (tests/test_qbo_receipts.py:56-60; also test_quickbooks_sync.py, test_crew_integrity.py, test_sales_tax_plumbing.py:57) that records results into a module list instead of asserting. The pass/fail verdict is computed only in each file's `main()`, which is gated behind `if __name__ == "__main__"` and therefore runs only in standalone script mode (`python tests/test_x.py`). CI runs the suite exclusively through pytest (.github/workflows/tests.yml: `python -m pytest tests -q`), and no conftest hook, plugin, or addopts inspects …

<details>
<summary><strong>12 Low / Nit in this category</strong></summary>

| Sev | Finding | Location |
|---|---|---|
| Low | Public /pdf/{token} surface and web push have zero tests of any kind | `backend/routes/pdf.py:47-48` |
| Low | Rate-limit enforcement, session sweeper and all three pollers untested | `backend/rate_limit.py:182` |
| Low | README's local-dev instructions require a build.sh that was deliberately deleted | `README.md:54` |
| Low | README documents no way to run the tests at all | `README.md:1-720` |
| Low | Seven env vars read by the backend are undocumented, four security-relevant | `README.md:122-147` |
| Low | 34 migrations: downgrade() never executed, upgrade chain never run on Postgres | `alembic/versions:1-34` |
| Low | README API endpoint list omits every public token surface and 6 QBO routes | `README.md:623-646` |
| Low | SECURITY_REVIEW's test-verification claim and code citations are stale | `docs/SECURITY_REVIEW.md:673-685` |
| Low | No guard that index.html's 77 script tags match what is on disk | `tests/test_frontend_load.js:20-35` |
| Low | validators.py's maintenance instructions point at a file that does not exist and describe FK checking that … | `backend/validators.py:19-26` |
| Low | `components/status-enums.js` was deleted but six files still name it as the single source of truth for status … | `backend/validators.py:23-32` |
| Nit | pytest/pytest-asyncio unpinned; 99 async tests would silently skip, not fail | `.github/workflows/tests.yml:58` |

</details>

---

## 3. Findings table

All 195 surviving findings, severity then category. Full detail for Critical/High/Medium is in the
category sections above; Low/Nit detail is in the collapsed tables there.

| # | Sev | Category | Finding | Location | Conf |
|---|---|---|---|---|---|
| 1 | Critical | Bugs | Break after midnight on an overnight shift explodes paid hours | `theme.js:296-316` | H |
| 2 | High | Bugs | Auto meal-break generator emits midnight-wrapped times that feed the bug above | `theme.js:1313-1318` | H |
| 3 | High | Reliability | Receipt poller keeps a stale `sender` ORM object across per-invoice rollbacks | `backend/qbo_receipts.py:512-516` | H |
| 4 | High | Reliability | Web push sends have no HTTP timeout — unbounded block on a user-settable URL | `backend/webpush.py:57-63` | H |
| 5 | High | Reliability | 409 fallback blind-PUTs, overwriting another user's record with the same id | `components/data-state.js:156-171` | M |
| 6 | High | Security | Internal `notes` column still shipped in the public client-view payload | `backend/routes/view.py:143-144` | H |
| 7 | High | Tests/Docs | Security mitigations from SECURITY_REVIEW have only fail-open tests | `tests/test_commit1_oauth_gmail.py:178-192` | H |
| 8 | High | Tests/Docs | 966 assertions across 14 test modules cannot fail under pytest | `tests/test_quickbooks_sync.py:59-63` | H |
| 9 | Medium | Bugs | find_or_create_vendor never got the stale/inactive fixes find_or_create_customer did | `backend/qbo_payouts.py:181-211` | H |
| 10 | Medium | Bugs | QuickBooks invoice total can differ by cents from the PDF and client view | `backend/qbo_sync.py:877-878` | H |
| 11 | Medium | Bugs | `defaultPaymentTerms` is absent from the public settings allow-list, so the share link promises Net 30… | `backend/routes/_shared.py:321-334` | H |
| 12 | Medium | Bugs | Invoice.payments is server-written but client-writable and never merged | `backend/routes/api.py:60-72, 328-329` | M |
| 13 | Medium | Bugs | Stale client PUT silently reverts the poller's paid/payment reconciliation | `backend/routes/api.py:61-72` | H |
| 14 | Medium | Bugs | `createdDate` is a phantom field: the frontend writes and reads it on every quote, but no column backs it | `backend/routes/api.py:45, 115-127` | H |
| 15 | Medium | Bugs | email_failed activity stamp is rolled back by the HTTPException that follows it | `backend/routes/email.py:351-358` | H |
| 16 | Medium | Bugs | Equipment "Retired" status is offered in the UI but rejected by the server enum, permanently wedging the… | `backend/validators.py:50` | H |
| 17 | Medium | Bugs | Payment auto-save leaves a stale clean baseline; Discard erases the payment | `modules/invoices.js:1737-1746` | H |
| 18 | Medium | Bugs | PDF success handler reverts edits made while the PDF was generating | `modules/quotes-builder.js:1368-1373` | H |
| 19 | Medium | Bugs | Builders report "Saved" and clear the dirty flag before any server round-trip | `modules/quotes-builder.js:1608-1652` | H |
| 20 | Medium | Bugs | H3 half-fix: frontend still client-mints share_token, so a newly created quote/invoice's Share and… | `modules/quotes-builder.js:1628-1633` | H |
| 21 | Medium | Bugs | 'target' discount clamps differently in LTP_INVOICE_TOTALS than in the other three readers | `theme.js:2072-2076` | H |
| 22 | Medium | Bugs | LTP_quoteExpiry drifts one day from the Python twin across spring DST | `theme.js:2117-2126` | H |
| 23 | Medium | Bugs | LTP_todayISO() returns the UTC date, not the user's local date | `theme.js:142` | H |
| 24 | Medium | Bugs | Unsaved-changes nav guard is disarmed by its own effect cleanup | `theme.js:197-205` | H |
| 25 | Medium | Dead code | Orphaned destructive endpoint POST /api/sync wipes 12 tables, no caller | `backend/routes/api.py:634-658` | H |
| 26 | Medium | PWA | Offline writes fail completely silently — edits look saved, then vanish | `components/data-state.js:178-192` | H |
| 27 | Medium | PWA | Every deploy serves one launch of new HTML against the previous shell's JS | `sw.js:229-245` | H |
| 28 | Medium | Perf | Public share-link viewers download the entire internal application | `app.js:44-53` | H |
| 29 | Medium | Perf | Receipt poller candidate set never retires; id-ordered cap starves new invoices | `backend/qbo_receipts.py:472-486` | H |
| 30 | Medium | Perf | Every CRUD list endpoint SELECTs the whole table with no LIMIT | `backend/routes/api.py:212-214` | H |
| 31 | Medium | Perf | Company logos stored as un-resized data: URLs, shipped in every list fetch | `components/ui.js:648-657` | H |
| 32 | Medium | Perf | Every route's code loads eagerly; ~900 KB is route-specific | `index.html:348-397` | M |
| 33 | Medium | Refactor | Line-item money math is implemented three times and has already drifted | `backend/qbo_sync.py:872-937` | H |
| 34 | Medium | Refactor | Twenty-plus cross-module reaches into underscore-private helpers | `backend/routes/qbo.py:168-246` | H |
| 35 | Medium | Refactor | Two 1,700-2,000 line single functions: InvoiceBuilder and QuotesBuilder | `modules/invoices.js:636-2643` | H |
| 36 | Medium | Reliability | Missing DATABASE_URL silently boots on ephemeral SQLite in prod | `backend/database.py:26-38` | H |
| 37 | Medium | Reliability | Rotated Gmail refresh token is flushed, not committed — lost on rollback | `backend/gmail.py:200-212` | H |
| 38 | Medium | Reliability | Auto-receipt has no exactly-once guard between Gmail send and commit | `backend/qbo_receipts.py:318-355` | H |
| 39 | Medium | Reliability | 401 anywhere hard-redirects to /auth/login, discarding unsynced state | `components/data-state.js:61-71` | H |
| 40 | Medium | Reliability | No error boundary at the React root — shell and public views fail to a blank page | `mount.js:7-8` | H |
| 41 | Medium | Security | No session-revocation path — an offboarded user keeps full access for up to 30 days | `backend/auth_deps.py:38-72` | H |
| 42 | Medium | Security | Pay-snapshot guard protects the amount but not who/when it is paid | `backend/crew_integrity.py:292-343` | H |
| 43 | Medium | Security | enforce_pay_snapshot injects a stored pay snapshot onto any cloned position id | `backend/crew_integrity.py:322-343` | M |
| 44 | Medium | Security | _stamp_activity rewrites the actor on every historical activity entry | `backend/routes/api.py:182-189` | H |
| 45 | Medium | Security | validate() and _stamp_activity are bypassed by sending snake_case keys | `backend/routes/api.py:38-40, 128-136` | H |
| 46 | Medium | Security | Blind SSRF: any signed-in member can make the server POST to an arbitrary URL via /api/push/subscribe | `backend/routes/push.py:27, 39-73` | H |
| 47 | Medium | Security | Share/PDF/crew/photo bearer tokens are written to platform logs | `railway.json:7` | H |
| 48 | Medium | Security | bleach 6.1.0: server-authoritative email sanitizer is on a permanently unmaintained project | `requirements.txt:17` | H |
| 49 | Medium | Tests/Docs | QuickBooks sync, receipt poller and PDF money math have no enforced coverage | `tests/test_qbo_receipts.py:56-60` | H |
| 50 | Low | Bugs | Unguarded eq.name/eq.category deref in the global-search effect | `app.js:357-358` | M |
| 51 | Low | Bugs | gmail.py compares a DB datetime to an aware now without normalizing | `backend/gmail.py:132-138` | H |
| 52 | Low | Bugs | gmail.py skips the tz normalization every other module applies; breaks on SQLite | `backend/gmail.py:132-139` | H |
| 53 | Low | Bugs | Server-side payout re-derivation silently drops a crew member the Payouts tab still totals | `backend/payouts.py:286-291` | M |
| 54 | Low | Bugs | Invoice reference number has three implementations and two different fallback chains | `backend/pdf_generator.py:280-291` | M |
| 55 | Low | Bugs | The half-up money rounding rule payouts.py declares mandatory is ignored by the module that consumes its… | `backend/qbo_payouts.py:260, 303, 308-310, 375` | M |
| 56 | Low | Bugs | POST /api/sync cascade-deletes client_rates and never restores them | `backend/routes/api.py:639-660` | H |
| 57 | Low | Bugs | Public accept/decline endpoints do not enforce quote expiry | `backend/routes/view.py:385-451` | H |
| 58 | Low | Bugs | Two activity-stamp sites use naive datetime.now() while all others use UTC | `backend/routes/view.py:439` | M |
| 59 | Low | Bugs | Signed-in user is shown the sign-in screen after a share link in the same tab | `components/auth.js:34-42` | H |
| 60 | Low | Bugs | After a failed initial fetch, the next user edit of that slice is never synced | `components/data-state.js:285-294` | M |
| 61 | Low | Bugs | Same UTC-parse/local-setDate pattern on every Net-N invoice due date | `modules/invoices.js:14-18` | H |
| 62 | Low | Bugs | Weekly schedule grid shifts a day for users east of UTC | `modules/labor.js:1661-1668` | H |
| 63 | Low | Bugs | Quote-to-invoice converts a $ or target discount to a 2-decimal percent | `modules/quotes-builder.js:2049-2058` | H |
| 64 | Low | Bugs | Save of an existing record silently no-ops when the row left the list | `modules/quotes-builder.js:1644-1650` | H |
| 65 | Low | Bugs | Deleting equipment leaves dangling kit line items — kits silently shrink and their auto-rate drops | `modules/rentals-shell.js:74-81` | H |
| 66 | Low | Bugs | Activity entries pair a UTC date with a LOCAL clock time | `modules/schedule-builder.js:259` | H |
| 67 | Low | Bugs | A typed $0 client contract tier silently derives from the day rate instead of being free | `theme.js:585-588` | M |
| 68 | Low | Dead code | 14 orphaned woff2 files (337 KB) are byte-identical copies of the 400 face | `assets/fonts.css:28-90` | H |
| 69 | Low | Dead code | Two unused Saira TTF weights (168 KB) never registered by the PDF generator | `assets/fonts/SairaExtraCondensed-Thin.ttf:1` | H |
| 70 | Low | Dead code | Two icon generators write the same six paths from different source art | `assets/icons/generate_icons.py:59-74` | H |
| 71 | Low | Dead code | Three orphaned logo PNGs, 513 KB, publicly fetchable | `assets/logos/secondary.png:1` | H |
| 72 | Low | Dead code | crew_integrity.reconcile_request() is dead in prod; its docstring is false | `backend/crew_integrity.py:234-245` | H |
| 73 | Low | Dead code | PdfArchive.bytes_size and created_by_user_id are write-only columns | `backend/models.py:877-879` | H |
| 74 | Low | Dead code | _TERMINAL constant in routes/crew.py is never referenced | `backend/routes/crew.py:66` | H |
| 75 | Low | Dead code | data/labor.js is fully dead — LTP_DATA_ASSIGNMENTS is never read | `data/labor.js:1` | H |
| 76 | Low | Dead code | 'html templates/' holds stale email templates that re-introduce a fixed bug | `html templates/signiture.html:1-60` | H |
| 77 | Low | Dead code | fastapi[standard] extra is unused, ships sentry-sdk/typer/rich/jinja2 to prod | `requirements.txt:1` | H |
| 78 | Low | PWA | CACHE_VERSION guard is skipped entirely on a direct push to the default branch | `.github/workflows/tests.yml:26-45` | H |
| 79 | Low | PWA | Offline launch of the installed app shows the sign-in wall and dead-ends | `components/auth.js:58-66` | H |
| 80 | Low | PWA | Crew-removal outbox lives only in this browser's localStorage | `components/crew-outbox.js:20-41` | M |
| 81 | Low | PWA | Push "on" state is read from the browser only and never reconciled with the server | `components/push.js:96-101` | H |
| 82 | Low | PWA | Update banner can be missed for a whole session (updatefound listener attached too late) | `components/register-sw.js:149-165` | H |
| 83 | Low | PWA | Nothing ever calls registration.update(); a long-lived PWA session never checks | `components/register-sw.js:143-169` | H |
| 84 | Low | PWA | controllerchange reload ignores the app's own unsaved-changes guard | `components/register-sw.js:64-68` | H |
| 85 | Low | PWA | First-ever service-worker install triggers an unexpected full page reload | `components/register-sw.js:61-68` | H |
| 86 | Low | PWA | First-visit service worker claim triggers an unguarded auto-reload | `components/register-sw.js:61-68` | H |
| 87 | Low | PWA | Manifest hard-locks portrait and omits install-UX fields | `manifest.webmanifest:1-9` | H |
| 88 | Low | PWA | Print flows call window.open with no null check — throws when popups are unavailable | `modules/crm-notes.js:76-88` | H |
| 89 | Low | PWA | Payout CSV export uses a detached anchor and revokes the blob URL synchronously | `modules/labor.js:2180-2185` | M |
| 90 | Low | PWA | Activity-feed PDF links lack the standalone workaround the same file already implements | `modules/quotes-builder.js:2733-2738` | M |
| 91 | Low | PWA | SWR revalidation is not held open by event.waitUntil | `sw.js:264-277` | H |
| 92 | Low | PWA | A stale precache path cannot fail install — the SPA fallback returns 200 HTML | `sw.js:118-132` | H |
| 93 | Low | PWA | Version guard cannot catch two branches choosing the same new version string | `tests/check_shell_version.py:154-168` | H |
| 94 | Low | Perf | Global search rescans every entity with nested O(n*m) lookups per keystroke | `app.js:300-412` | H |
| 95 | Low | Perf | All 13 collections fetched unbounded on mount; first render hard-gated on all of them | `app.js:186-189` | H |
| 96 | Low | Perf | No index on payout_bill_lines.date, which the day-status route range-scans | `backend/models.py:1038-1047` | H |
| 97 | Low | Perf | Payout engine loads every project row to derive one two-week period | `backend/payouts.py:312-318` | H |
| 98 | Low | Perf | Receipt poller scans the whole contacts table and filters a JSON array in Python | `backend/qbo_receipts.py:234-235` | H |
| 99 | Low | Perf | QuickBooks sync issues 3-4 queries per line item (settings singleton re-read per line) | `backend/qbo_sync.py:860-886` | H |
| 100 | Low | Perf | Whole-table JSON responses are encoded on the single event loop | `backend/routes/api.py:212-214` | M |
| 101 | Low | Perf | FK validation issues one SELECT per foreign-key column on every write | `backend/routes/api.py:145-152` | H |
| 102 | Low | Perf | GET /api/crew-requests returns every request ever, and writes on every read | `backend/routes/crew.py:702-712` | H |
| 103 | Low | Perf | Payout preview loads the entire payout_bill_lines ledger unfiltered | `backend/routes/qbo.py:626` | H |
| 104 | Low | Perf | Web push fans out sequentially inside the public client-view request | `backend/webpush.py:86-96` | H |
| 105 | Low | Perf | Sync diff JSON.stringifies every row of an entity list on every save | `components/data-state.js:172` | H |
| 106 | Low | Perf | Open dropdown re-measures and re-renders on every capture-phase scroll event | `components/search-dropdown.js:166-181` | M |
| 107 | Low | Perf | FLIP reorder animation forces two synchronous layouts per element in a loop | `components/sortable.js:148-164` | H |
| 108 | Low | Perf | Unthrottled resize handler does a DOM probe and forces a full relayout | `components/viewport-height.js:42-60` | M |
| 109 | Low | Perf | 1.81 MB of uncompressed JS, 73 render-blocking scripts, no defer | `index.html:264-414` | H |
| 110 | Low | Perf | Line-item editors re-render the entire builder tree on every keystroke | `modules/quotes-builder.js:2577-2595` | H |
| 111 | Low | Perf | Service worker discards the entire runtime cache on every version bump | `sw.js:134-145` | H |
| 112 | Low | Refactor | main.py mixes six concerns in 837 lines; proposed decomposition | `backend/main.py:28-837` | H |
| 113 | Low | Refactor | Crew payout money travels an untyped, undocumented dict pipeline | `backend/payouts.py:188-301` | H |
| 114 | Low | Refactor | Two ~95-line poll-cycle drivers are copies, and one already has a fix the other lacks | `backend/qbo_receipts.py:489-595` | H |
| 115 | Low | Refactor | Gmail send pipeline duplicated between a route and a poller, with a route->service back-import | `backend/qbo_receipts.py:280-355` | H |
| 116 | Low | Refactor | _shared.py mixes DB access, serialization and public-view authorization | `backend/routes/_shared.py:92-334` | M |
| 117 | Low | Refactor | payout_preview_route is a 123-line handler mixing four concerns | `backend/routes/qbo.py:576-698` | H |
| 118 | Low | Refactor | routes/qbo.py answers errors with JSONResponse while every other router raises | `backend/routes/qbo.py:590-593` | H |
| 119 | Low | Refactor | Public token-authenticated endpoints parse raw dicts with hand-rolled validation | `backend/routes/view.py:386-452` | H |
| 120 | Low | Refactor | data-state.js is not actually a chokepoint — its API helpers are IIFE-private | `components/data-state.js:336-338` | H |
| 121 | Low | Refactor | Mobile-breakpoint matchMedia effect hand-rolled twice despite a shared hook | `modules/client-view.js:462-470` | H |
| 122 | Low | Refactor | Modal/confirm pattern is three patterns; a money guard still uses native confirm() | `modules/invoices.js:2499` | H |
| 123 | Low | Refactor | quotes-builder/invoices duplication measured: 466 lines at >=70% similarity | `modules/quotes-builder.js:1237-2940` | H |
| 124 | Low | Refactor | Business math stranded in view modules — rental pricing engine is unreachable from invoices | `modules/quotes-builder.js:150-217` | H |
| 125 | Low | Refactor | 21-prop builder signatures; React context is available with no build step | `modules/quotes-builder.js:1237` | H |
| 126 | Low | Refactor | qbAccountOptions copy-pasted into three modules, plus a fourth variant | `modules/quotes-products.js:13-28` | H |
| 127 | Low | Refactor | DOM escape hatch inside a React tree: getElementById on a hardcoded id | `modules/settings.js:532-546` | H |
| 128 | Low | Refactor | theme.js is 96% not-theme: 2,529 of 2,626 lines are business logic | `theme.js:1-2626` | H |
| 129 | Low | Reliability | crypto.py docstring claims import-time fail-fast; the implementation is lazy | `backend/crypto.py:24-25, 61-73` | H |
| 130 | Low | Reliability | LTP_TOKEN_ENCRYPTION_KEY has no startup check; docstring claims it does | `backend/crypto.py:23-25` | H |
| 131 | Low | Reliability | Alembic stamp heuristic uses any() over four probe tables | `backend/database.py:121-124` | M |
| 132 | Low | Reliability | Boot-time stack dumper fires every second during normal migrations | `backend/database.py:125-139` | H |
| 133 | Low | Reliability | DB session and open transaction held across every external HTTP call, untuned pool | `backend/database.py:38` | H |
| 134 | Low | Reliability | gmail.send does not handle 429 / rate limits or honor Retry-After | `backend/gmail.py:361-381` | H |
| 135 | Low | Reliability | A Gmail send rejection produces no server-side log line at all | `backend/gmail.py:379-381` | H |
| 136 | Low | Reliability | httpx is a direct prod dependency but unpinned and absent from requirements.txt | `backend/gmail.py:46` | H |
| 137 | Low | Reliability | Documented middleware order does not match the actual stack | `backend/main.py:460-474` | H |
| 138 | Low | Reliability | _env_int validates type but not range; interval 0 spins a hot loop | `backend/main.py:28-38` | H |
| 139 | Low | Reliability | No stack trace is ever captured outside database.py — swallowed poller errors are undebuggable | `backend/main.py:109` | H |
| 140 | Low | Reliability | Receipt poller can re-send a client's payment receipt after an interrupted cycle | `backend/qbo_receipts.py:319-352` | H |
| 141 | Low | Reliability | Pollers roll back the connection drop, so a dead QBO grant still reports connected | `backend/qbo_receipts.py:557-563` | H |
| 142 | Low | Reliability | Poll cycles have no wall-clock budget and can exceed their own interval | `backend/qbo_receipts.py:81` | M |
| 143 | Low | Reliability | Bare int() on LTP_TRUST_PROXY_HOPS crash-loops the container at import | `backend/rate_limit.py:142` | H |
| 144 | Low | Reliability | Bare int() on LTP_TRUST_PROXY_HOPS crash-loops the container at import | `backend/rate_limit.py:142` | H |
| 145 | Low | Reliability | Rotation script's read-then-commit window can clobber a concurrently rotated QBO refresh token | `backend/rotate_encryption_key.py:50, 63-78` | M |
| 146 | Low | Reliability | POST /api/sync destroys client_rates and orphans crew_requests/payout_bills | `backend/routes/api.py:639-680` | H |
| 147 | Low | Reliability | Main email route has no handler for Gmail transport errors, unlike the crew routes | `backend/routes/email.py:334-357` | H |
| 148 | Low | Reliability | pdf_archives grows without bound; no pruning path exists | `backend/routes/pdf.py:100-108` | H |
| 149 | Low | Reliability | QBO_ENVIRONMENT silently defaults to sandbox and is frozen per connection | `backend/routes/qbo.py:51-53` | H |
| 150 | Low | Reliability | Swallowed tracking error can leave the session unusable and 500 the share-link render | `backend/routes/view.py:310-329` | M |
| 151 | Low | Reliability | No healthcheckPath and no health endpoint anywhere in the app | `railway.json:6-10` | H |
| 152 | Low | Reliability | Service worker caches the SPA HTML fallback under .js URLs (no content-type check) | `sw.js:266-270` | M |
| 153 | Low | Security | Session idle timeout is inert — equal to the absolute lifetime | `backend/auth_deps.py:20-27` | H |
| 154 | Low | Security | No TLS configured on the Postgres engine; asyncpg silently defaults to 'prefer' | `backend/database.py:38` | M |
| 155 | Low | Security | LTP_IMG_SRC_EXTRA is spliced into the CSP unvalidated at import time | `backend/main.py:316-324, 367` | H |
| 156 | Low | Security | escape_query_value docstring states the opposite rule from the code | `backend/quickbooks.py:473-477` | M |
| 157 | Low | Security | Unauthenticated ReportLab render reachable at double the rate the /pdf rule allows | `backend/rate_limit.py:44-58` | H |
| 158 | Low | Security | Key-rotation script cannot detect a reversed keyring and exits 0 | `backend/rotate_encryption_key.py:38-44, 78-80` | H |
| 159 | Low | Security | Client's handwritten signature image is re-servable to any share-token holder | `backend/routes/_shared.py:306-309` | H |
| 160 | Low | Security | Public activity feed leaks the first recipient's email and the sender's identity | `backend/routes/_shared.py:292-305` | H |
| 161 | Low | Security | Internal QuickBooks tax fingerprint echoed to unauthenticated viewers | `backend/routes/_shared.py:126` | H |
| 162 | Low | Security | M5 FK validation shipped for create/update but not for bulk_sync | `backend/routes/api.py:658-680` | H |
| 163 | Low | Security | Settings save sanitizes only the signature, not email template bodies | `backend/routes/api.py:430-433` | H |
| 164 | Low | Security | First-user-becomes-admin bootstrap is still ungated (M4 item 3 not shipped) | `backend/routes/auth.py:184-203` | H |
| 165 | Low | Security | Crew and QBO-receipt mail paths bypass backend/email_validate entirely | `backend/routes/crew.py:373-374, 391, 509, 543` | H |
| 166 | Low | Security | ANTHROPIC_BASE_URL breaks the pinned-outbound-host invariant with no validation | `backend/routes/scan.py:79, 93, 98` | H |
| 167 | Low | Security | Quote expiry is printed on the document but never enforced at accept | `backend/routes/view.py:431-436` | H |
| 168 | Low | Security | Public client-view JSON sets no Cache-Control, unlike its PDF sibling | `backend/routes/view.py:356-358` | M |
| 169 | Low | Security | Crew contacts linked to a project are pre-populated as Cc on the client-facing quote/invoice email | `components/recipient-editor.js:21-24` | H |
| 170 | Low | Security | DOMPurify 3.2.7 is affected by unpatched CVE-2026-0540 | `index.html:317-318` | H |
| 171 | Low | Security | crm-notes stripHtml parses raw note HTML; its safety comment is wrong | `modules/crm-notes.js:11-14` | H |
| 172 | Low | Security | starlette 0.46.2 pinned below its CVE fix by fastapi's own upper bound | `requirements.txt:1` | H |
| 173 | Low | Security | LTP_textToHtml parses untrusted HTML into the DOM before sanitizing | `theme.js:1755-1770` | H |
| 174 | Low | Tests/Docs | README's local-dev instructions require a build.sh that was deliberately deleted | `README.md:54` | H |
| 175 | Low | Tests/Docs | README documents no way to run the tests at all | `README.md:1-720` | H |
| 176 | Low | Tests/Docs | Seven env vars read by the backend are undocumented, four security-relevant | `README.md:122-147` | H |
| 177 | Low | Tests/Docs | README API endpoint list omits every public token surface and 6 QBO routes | `README.md:623-646` | H |
| 178 | Low | Tests/Docs | 34 migrations: downgrade() never executed, upgrade chain never run on Postgres | `alembic/versions:1-34` | H |
| 179 | Low | Tests/Docs | Rate-limit enforcement, session sweeper and all three pollers untested | `backend/rate_limit.py:182` | H |
| 180 | Low | Tests/Docs | Public /pdf/{token} surface and web push have zero tests of any kind | `backend/routes/pdf.py:47-48` | H |
| 181 | Low | Tests/Docs | validators.py's maintenance instructions point at a file that does not exist and describe FK checking… | `backend/validators.py:19-26` | H |
| 182 | Low | Tests/Docs | `components/status-enums.js` was deleted but six files still name it as the single source of truth for… | `backend/validators.py:23-32` | H |
| 183 | Low | Tests/Docs | SECURITY_REVIEW's test-verification claim and code citations are stale | `docs/SECURITY_REVIEW.md:673-685` | H |
| 184 | Low | Tests/Docs | No guard that index.html's 77 script tags match what is on disk | `tests/test_frontend_load.js:20-35` | H |
| 185 | Nit | Dead code | Three unused imports in backend/ | `backend/database.py:10` | H |
| 186 | Nit | Dead code | window.LTP_entityIdOf defined and never called | `components/entity-quick-form.js:78` | H |
| 187 | Nit | Dead code | 'html templates/' directory is unreferenced by any code, build, or doc | `html templates/signiture.html:1` | M |
| 188 | Nit | Dead code | index.html comment points at a deleted vendor file | `index.html:363-365` | H |
| 189 | Nit | Dead code | ALLOC_STATES exported on window.LTP_RENTALS but never read | `modules/rentals-utils.js:279` | H |
| 190 | Nit | PWA | Refresh fallback timer can produce a second reload | `components/register-sw.js:114-121` | H |
| 191 | Nit | Refactor | Byte-identical public-page CSS duplicated in client-view and crew-view | `modules/client-view.js:133-149` | H |
| 192 | Nit | Refactor | rentals-* and crm-* families are NOT meaningfully duplicated — do not merge them | `modules/rentals-containers.js:1-546` | H |
| 193 | Nit | Security | Email preview allowlist mirrors tags/attrs but not the CSS property allowlist | `components/sanitize.js:87-104` | H |
| 194 | Nit | Security | Frontend signature render omits the escaping its backend twin documents | `theme.js:1536-1544` | H |
| 195 | Nit | Tests/Docs | pytest/pytest-asyncio unpinned; 99 async tests would silently skip, not fail | `.github/workflows/tests.yml:58` | M |
---

## 4. Suggested remediation sequence

Batches are ordered so nothing depends on an un-done prior step. Effort is S (<½ day), M (½–2 days),
L (>2 days). **Batch 0 is not optional if you intend to act on any of the rest** — right now CI cannot tell you
whether a change broke the money paths.

### Batch 0 — Restore test signal — Effort S · Blast radius: CI only
Add `assert cond, f"{label} {detail}"` as the last line of `_check` in the 14 affected modules. Six sibling
modules already do exactly this (`tests/test_activity_preservation.py:70`), so the pattern is in-repo. Then run
the suite and triage what falls out. Do `test_quickbooks_sync.py`, `test_qbo_receipts.py`,
`test_crew_integrity.py` and `test_sales_tax_plumbing.py` first — that is 423 of the 966 dead assertions and it
covers every money path in one change.
> Expect real failures. That is the point. Budget time to triage them, not just to make them green.

### Batch 1 — The overnight money bug — Effort S · Blast radius: labor pricing + crew payouts
Two changes in one commit, because fixing either alone leaves the other producing bad numbers:
- `theme.js:296-316` — normalize breaks into the **span's** frame, not their own.
- `theme.js:1313-1318` — stop `LTP_mealFixBreaks` emitting midnight-wrapped times via `_decimalToTime`'s
  `% 24`.
Add regression cases to `tests/test_labor_rates.js` beside the existing overnight case A9 (line 57), which
today covers overnight only *without* breaks.
> **Then audit history.** Any signed-off overnight day already has a wrong `work.pay` frozen on it, and
> `backend/payouts.py` will keep re-deriving that frozen value into QuickBooks vendor bills. Fixing the function
> does not repair existing records. Query for signed-off days whose shift crosses midnight and carries a break.

### Batch 2 — Public-surface leaks — Effort S · Blast radius: public share view only
- `backend/routes/view.py:143-144` — the strip list names the wrong keys; the column is `notes`.
- `backend/routes/_shared.py:242,260` — convert `_PUBLIC_ITEM_DROP_KEYS` from a drop-list to an allow-list, and
  do the same for the remaining drop-list passes. This is the unfinished half of prior finding M1, and a
  drop-list will leak again the next time a column is added.
- `backend/routes/_shared.py:321-334` — `defaultPaymentTerms` missing from the public settings allow-list, so
  the share link shows Net 30 while the PDF prints the real terms.
All three are single-function changes to serialization with no schema impact.

### Batch 3 — Data-loss bugs — Effort M · Blast radius: invoice editor, receipt delivery
- `modules/invoices.js:1737-1746` — advance `cleanRef.current` in `autoSavePayment`. Also close the
  Recall-to-Draft path (`:1237-1240`), which reads the stale draft and so passes a guard designed to stop it.
- `backend/qbo_receipts.py:512-516` — reload `sender` inside the loop the way `conn` already is. Without this
  one bad invoice permanently stops all receipts, visible only as a log line.
- `backend/gmail.py:200-212` — the rotated refresh token is flushed but not committed; a later rollback loses it.

### Batch 4 — Operational fail-safes — Effort S · Blast radius: startup only
- `backend/database.py:26-38` — refuse to boot on a missing `DATABASE_URL` when not obviously local dev,
  instead of silently using container-local SQLite.
- `backend/rate_limit.py:142` — bare `int()` at import time crash-loops the container on a typo. `main.py:28-38`
  already has `_env_int` written for exactly this; use it.
- `backend/webpush.py:57-63` — pass a timeout to `pywebpush`. It currently blocks a thread and holds the
  caller's DB session open indefinitely against a user-supplied endpoint URL.
- Add a health endpoint and `healthcheckPath` — there is none, and a failed boot migration currently produces
  ten silent restarts with zero availability.

### Batch 5 — Retire `/api/sync` — Effort S · Blast radius: potentially total, which is the point
`backend/routes/api.py:634-680`. Its one-shot localStorage migration purpose is served and no frontend code
calls it. It wipes 12 tables, cascade-deletes `client_rates` without repopulating them (`client-rates` is
absent from `model_map`), and orphans `crew_requests`/`payout_bills`. Delete it, or gate it behind an env flag
that is unset in production.

### Batch 6 — Dependency pins — Effort S · Blast radius: full redeploy, needs a smoke test
- Add `httpx` to `requirements.txt`. Four backend modules import it directly; it is only present transitively
  via `fastapi[standard]` (`backend/gmail.py:46`, `quickbooks.py:39`, `routes/auth.py:21`, `routes/scan.py:31`).
- Move Starlette past CVE-2026-48710 — constrained by FastAPI's own upper bound, so this is a FastAPI bump.
  Not urgent: I verified the app does not use the vulnerable pattern.
- DOMPurify 3.2.7 → 3.3.2+ when convenient. Not exploitable in this app today.
> Every one of these needs a `CACHE_VERSION` bump if it touches a cached file, or every device serves a stale
> shell for one more launch.

### Batch 7 — Structural refactors — Effort L · Blast radius: load-bearing
Do not start these until Batch 0 has given you working tests.
- Split `theme.js` along its own commented section boundaries into `components/domain-*.js`. The target
  directory is already in the static allowlist and already runtime-cached, so no backend change is needed.
  **Do not** create new root-level `.js` files — `_ALLOWED_TOP_LEVEL_FILES` (`backend/main.py:632`) is a fixed
  five-name set and an unlisted root script silently falls through to the SPA fallback as `text/html`, which
  `nosniff` then refuses to execute.
- Collapse the measured 466 lines of quotes/invoices duplication in tiers, mechanical helpers first. Reconcile
  the `sectionTotals` return-shape divergence (`{subtotal, margin}` vs `{subtotal, cost}` from byte-identical
  bodies) as part of tier 1, not after.

---

## 5. Open questions

Answers change specific findings; none blocked the review.

1. **Are `LTP_ALLOWED_DOMAIN` / `LTP_ALLOWED_EMAILS` set in production?** If neither is, any Google account can
   sign in, and on an empty users table the first sign-in becomes admin (`backend/routes/auth.py:184-203`). The
   boot warning at `main.py:533-537` is the only trace. I assumed they are set.
2. **Is `WEB_CONCURRENCY` set, or does Railway run more than one replica?** The rate limiter, the view-debounce
   dict, and all three pollers are per-process with no leader election. N processes = N× the poll cadence
   (duplicate client receipt emails) and 1/N the effective rate limits.
3. **Are the four CI jobs required status checks?** No CODEOWNERS, no branch-protection-as-code. If `backend` is
   advisory *and* fail-open, 14 test files are decorative twice over.
4. **Were the prior review's C2 operator follow-ups completed** — Gmail grant revoked, `LTP_TOKEN_ENCRYPTION_KEY`
   rotated, `.db` files purged from remote history? The clone here is shallow (269 commits, earliest 2026-06-25)
   so history cannot be checked locally. Relatedly: **is that key backed up anywhere outside Railway?** Losing it
   makes every stored Gmail and QuickBooks token permanently undecryptable.
5. **Are overnight shifts actually used in production, and how often?** This sets the urgency of Batch 1 and the
   size of the historical-repair job. The code supports them in three places and test A9 pins them, so I treated
   them as a live case.
6. **Is the fail-open `_check` harness a known trade-off or an unnoticed regression?** Several newer files note
   they were "written pytest-native so the combined run actually verifies it", which reads like a migration in
   progress that stalled.
7. **Where is the "Playwright E2E against a stub server"** referenced by `tests/test_scan_ocr.py:8-9`? No such
   suite exists in this repo. Whether it exists elsewhere determines if the zero-coverage verdict on
   `routes/pdf.py`, `routes/push.py` and `webpush.py` is real.
8. **Is the default/PR-target branch `master` or `dev`?** `tests/check_shell_version.py` defaults to
   `origin/master`; recent commits merge from `dev`. This decides what the shell-version guard diffs against.
9. **Is `ANTHROPIC_API_KEY` set in production, and what spend controls exist** beyond the 30-req/min per-IP rule?
   Also whether `ANTHROPIC_BASE_URL` is set anywhere — `routes/scan.py` warns it must never be, but nothing
   enforces it.

---

## 6. Method notes and limits

- **Not executed:** the app was never run against a real database; no migration was applied; no test suite was
  run except the one targeted `pytest` invocation that proved the fail-open harness, and two `node` evaluations
  of `theme.js` that reproduced the labor bug. Nothing was written outside this file.
- **Shallow clone.** `.git/shallow` names 5 graft points; 269 commits reachable, earliest 2026-06-25. Claims
  about pre-June-2026 history are unverifiable here.
- **Railway-side config is invisible.** Env var values, replica count, health checks, branch protection and
  build settings are all outside the repo.
- **Static analysis on a `window`-globals frontend produces false positives.** Every dead-code finding carries an
  explicit confidence, and "Low" there generally means "grep says unused, but a string-keyed or dynamic
  reference could exist."
- **`docs/SECURITY_REVIEW.md` (33 prior findings) was treated as prior art.** Items tracked there and genuinely
  fixed are not re-reported. Items whose fix is *incomplete* are reported and tagged with the original id — those
  are marked "Prior review `Xn` — fix incomplete" in the findings above.
- **Severity discipline.** 3 findings were refuted outright and dropped; roughly 70 were narrowed or
  severity-corrected by the adversarial pass. The surviving distribution is 1 Critical / 7 High / 41 Medium /
  135 Low / 11 Nit.
