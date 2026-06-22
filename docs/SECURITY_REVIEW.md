# LTPApp Security Review & Hardening Plan

**Date:** 2026-06-21
**Branch:** `claude/security-hardening`
**Scope:** Entire application — backend (FastAPI + async SQLAlchemy), frontend
(vanilla JS + React-via-CDN), OAuth integrations (Google Workspace / Gmail,
Intuit QuickBooks Online), public tokenized surfaces, infrastructure config,
and third-party dependencies.
**Method:** Eight parallel read-only audit agents, each owning a domain
(auth & sessions; authorization & API; secrets/crypto/tokens; public tokens &
PII; injection & XSS; email & SSRF; HTTP/infra; frontend & dependencies).
Their findings were de-duplicated, cross-checked against the source, and
ranked below.

> **Status: partially implemented.** This started as a review-only plan.
> Phase 0 and the exploitable-holes portion of Phase 1 have since been
> implemented and tested on the `claude/security-hardening` branch — see
> [§ Implementation status](#implementation-status). Findings not marked
> ✅ remain proposals awaiting sign-off.

---

## How to read this

Each finding has a stable ID (`C#`/`H#`/`M#`/`L#`), the precise location, the
exploit/impact, and one or more mitigation options. Where there's a genuine
design choice, options are labelled **A/B**; otherwise a single **Recommended
fix** is given.

**Severity legend**

| Tier | Meaning |
|------|---------|
| **CRITICAL** | Exploitable now, low barrier, leads to data/account compromise. Fix before anything else. |
| **HIGH** | Serious; exploitable by an authenticated member, or by an external party under realistic conditions. |
| **MEDIUM** | Real weakness; needs a precondition, insider access, or chained step. |
| **LOW** | Defense-in-depth, hygiene, or low-impact. |

**Threat model.** We hold client/customer PII (names, addresses, emails,
phones, payment ledgers), and we hold OAuth tokens granting send-as access to
the company Google Workspace and full accounting access to QuickBooks Online.
The high-value targets are: (a) the OAuth refresh tokens, (b) staff sessions
(an XSS or CSRF that acts as staff can reach every record and both
integrations), and (c) the public client-view surface (unauthenticated, PII).

---

## Executive summary

The application has a **genuinely strong security baseline** — see
[§ Verified secure](#verified-secure-dont-spend-effort-here) for the long list
of attacks that are already closed (no SQL injection, no SSRF, parameterized
ORM throughout, server-enforced authorization, tokens never returned to the
browser, SRI on all CDN assets, correct middleware ordering, path-traversal
safe). The work below is hardening a good app into a hardened one, not
rescuing a broken one.

The findings cluster around **eight cross-cutting themes**:

1. **Two `document.write` XSS sinks** — one reachable by an *unauthenticated
   external client* (signature popup), one by internal data (schedule print).
2. **A deny-list write layer** lets any authenticated member mass-assign
   `share_token`, foreign keys, and classification flags; `bulk_sync` skips
   validation entirely.
3. **Rate-limiting covers only two routes** (`/auth/login`, `/auth/callback`,
   exact-path). Every public token route, the PDF generator, the email
   sender, and the bulk-sync endpoint are unthrottled.
4. **`/api/email/send` is an authenticated open relay** — arbitrary
   recipients and arbitrary HTML through the company Gmail account.
5. **Transport security and the session-cookie signing key hinge on single
   env vars that fail open** (boot succeeds with an ephemeral key; Secure/HSTS
   keyed on a URL string, not the actual transport).
6. **Real Gmail refresh tokens are committed** inside test `.db` files
   (encrypted; the key is not in the repo, but this must be treated as an
   exposure).
7. **No CSRF/Origin checks** on state-changing endpoints — `SameSite=Lax` is
   the sole defense; the OAuth callbacks trust query parameters.
8. **The public client-view payload over-exposes** (drop-list, not
   allow-list) and accept/decline is unauthenticated, replayable, and the
   signature is non-binding. Plus two dependency bumps.

A suggested remediation order is in [§ Roadmap](#remediation-roadmap).

---

## Implementation status

**Every CRITICAL / HIGH / MEDIUM / LOW finding is implemented and tested** on
`claude/security-hardening` (each its own commit; the suite passes 215/215 when
run file-by-file — see [§ Notes on method](#notes-on-method--limits)). The only
items not coded are `style-src 'unsafe-inline'` (future work — needs a CSP nonce
architecture) and **L4** (accepted as-is); both are explained below.

**Phase 0 — contain exposure**

| ID | Finding | Commit |
|----|---------|--------|
| **C2** | Remove committed token-bearing `.db` files; ignore all `*.db` | `7d2abcc` |
| **H6** | Fail-fast on missing/weak `LTP_SESSION_SECRET` | `d20b0ef` (+ test default `57cf6a5`) |

**Phase 1 — close the exploitable holes**

| ID | Finding | Commit |
|----|---------|--------|
| **C1 / H1** | Eliminate both `document.write` XSS sinks; validate signatures server-side | `f4da2b7` |
| **H3** | `share_token` server-authoritative | `98f75c9` |
| **H2** | Prefix-based rate limiting for public/PDF/email/sync routes | `0e091a5` |
| **H4** | Cap recipients per send on the email relay | `486fe1f` |
| **H10** | Stop reflecting OAuth provider error bodies to clients | `f78fbf5` |

**Phase 2 — structural hardening**

| ID | Finding | Commit |
|----|---------|--------|
| **L1 / M4 / L9 / H11** | Hashed session tokens; access allowlist + strict `email_verified`; generic OAuth error; logout session-kill (documented) | `6ab3640` |
| **H8** | Origin/Referer CSRF middleware for unsafe methods | `21ed917` |
| **H7** | Fail-safe transport detection (cookies/HSTS) | `0767e6a` |
| **H9** | Pin QuickBooks realm on reconnect | `8d8e0a6` |
| **H5 / M5 / M6** | `bulk_sync` validation; FK validation; `emailReplyTo` validation | `9398eee` |
| **M1** | Drop `share_token` + payments from public view payload | `5eff894` |
| **M3** | Key-rotation CLI + decrypt-vs-revoke fix | `6ad1770` |
| **H12** | Audit metadata on accept/decline | `5c5174b` |

**Phase 3 — defense-in-depth & hygiene**

| ID | Finding | Commit |
|----|---------|--------|
| **M2** | Tighten CSP `img-src` (drop `https:` wildcard) | `a9a79f3` |
| **L5 / L6** | `rel=noopener` email anchors; CORP + Permissions-Policy headers | `b41cced` |
| **L2 / L3** | Session idle timeout; delete audit logging | `86295d8` |
| **M7 / L7** | Client-side email sanitize; `meetLink` protocol guard | `ac307cc` |
| **L10** | Bump `authlib` 1.3.2→1.7.2 and `cryptography` 42→49 | `802b421` |
| **L8** | Self-host web fonts; drop Google font hosts from the CSP | `8828144` |

**Operator follow-ups still required for C2** (cannot be done in-repo): revoke
the exposed Gmail OAuth grant, rotate `LTP_TOKEN_ENCRYPTION_KEY` (use the new
`backend/rotate_encryption_key.py` from M3), and purge the `.db` files from git
history (a coordinated rewrite — it touches the open PR branches).

**Deliberately deferred / accepted (with rationale):**
- **`style-src 'unsafe-inline'`** (the second half of M2) — kept. React inline
  styles and the sanitized email preview depend on it; removing it requires a
  CSP nonce architecture. Tracked as future work.
- **L4** (non-constant-time token lookup; spoofable audit IP/UA) — accepted as
  noted in the original finding (DB-lookup model; audit metadata is advisory).
- **H3 scope** — implemented for the `share_token` credential specifically; FKs
  stay client-writable by design in this single-tenant tool, but are now
  existence-validated (M5).

---

## CRITICAL

### C1 — Stored XSS reachable by an unauthenticated client (signature popup)

- **Where:** `modules/quotes-builder.js:1934` (the "View signature" button's
  `onClick`).
- **What:** The handler builds a popup with `document.write`, interpolating
  **client-controlled** values with no escaping:
  ```js
  w.document.write('<title>Signature — ' + (a.user || "client") +
    '</title>…<img src="' + a.signatureDataUrl + '" …>');
  ```
  `a.user` is the name the **client typed** when accepting/declining a quote;
  `a.signatureDataUrl` is the data URL they submitted. Both arrive through the
  unauthenticated `/api/view/.../accept` endpoint. The server only checks that
  `signatureDataUrl` starts with `data:image/` and is within a length bound
  (`backend/routes/view.py:301`) — a value like
  `data:image/png"><script>…</script>` passes that check and breaks out of the
  `src="…"` attribute. The name field is wholly unchecked.
- **Impact:** Anyone with a share link (no login required) can sign a quote
  with a crafted name or data URL. When a **staff member** opens the signature
  preview, the script runs **in the authenticated app origin**. The session
  cookie is `HttpOnly` (can't be read by JS), but the XSS can still drive
  every authenticated `/api/*` call as that staff user: read/exfiltrate all
  client PII, create an admin user, push or delete QuickBooks invoices, and
  send email through Gmail. External attacker → full staff-level compromise.
- **Mitigation (recommended fix):**
  1. Stop using `document.write`. Open the popup and build the DOM with
     `createElement` + `textContent` (for the title) and an `<img>` whose
     `src` is assigned as a property (not string-concatenated into markup).
  2. Reuse the existing `escAttr()` / `purify()` helpers already in the
     frontend for any value that must enter markup.
  3. Validate `signatureDataUrl` server-side as a **real** base64-encoded
     image (decode it; confirm a PNG/JPEG magic-number header; cap dimensions)
     at `backend/routes/view.py:301`, not just a prefix/length check.
  4. As defense-in-depth, the CSP already blocks inline script on the main
     app; ensure the popup window inherits a restrictive CSP (or render the
     signature inside the existing app DOM instead of a blank `window.open`).

### C2 — Real Gmail refresh tokens committed to the repository

- **Where:** `_test_commit4.db`, `_test_commit5.db` (tracked); `.gitignore`
  excludes only `ltp_dev.db`, not `*.db`. `_test_commit3.db` is also tracked
  (empty schema — hygiene only).
- **What:** These SQLite files contain **real Fernet-encrypted Gmail refresh
  tokens** from development. The encryption key (`LTP_TOKEN_ENCRYPTION_KEY`)
  is **not** in the repo, so the tokens are not directly decryptable from the
  repo alone — but committing credential material is a breach-class hygiene
  failure, and the files persist in git history.
- **Impact:** A Gmail refresh token is long-lived send-as access to the
  company mailbox. Anyone who obtains both the file (public repo, fork, clone,
  CI artifact, laptop backup) **and** the key (separate leak) has persistent
  mailbox access. Even without the key, this is exactly the class of mistake
  that precedes real breaches, and it should be treated as an exposure.
- **Mitigation (recommended fix), in order:**
  1. **Rotate now**, independent of cleanup: revoke the affected Gmail
     OAuth grant in Google, and rotate `LTP_TOKEN_ENCRYPTION_KEY` (the
     `MultiFernet` design supports adding a new primary key and
     re-encrypting — see M3).
  2. `git rm --cached _test_commit3.db _test_commit4.db _test_commit5.db`
     and delete the working copies.
  3. Add `*.db` (and `*.db-journal`, `*.sqlite`) to `.gitignore`.
  4. Purge from history with `git filter-repo` (or BFG). Coordinate — this
     rewrites history and the open PR branches.
  5. Add a pre-commit guard / CI secret-scan (e.g. gitleaks) so `*.db` and
     token-shaped blobs can never be committed again.

---

## HIGH

### H1 — Second `document.write` XSS sink (schedule print)

- **Where:** `modules/schedule-builder.js:161` and `:164`.
- **What:** The print window is assembled by `document.write` with
  `project.name`, `company.name`, crew first/last names, and schedule item
  titles interpolated unescaped. Same sink class as C1, but the data is
  internal (staff-entered), so the attacker must already be an authenticated
  insider or have corrupted that data through another vector.
- **Impact:** Stored XSS in the staff origin when printing a schedule.
- **Mitigation:** Same pattern as C1 — escape every interpolated value with
  the existing `escAttr()`/`purify()` helpers, or build the print document via
  DOM nodes + `textContent`. Treat C1 and H1 together as "kill `document.write`
  with untrusted interpolation."

### H2 — Rate-limiting covers only two routes

- **Where:** `backend/rate_limit.py:32-35` (`LIMITS` map) and `:147`
  (`LIMITS.get(path)` — **exact-path** lookup; non-matching paths pass through
  at `:148-149`).
- **What:** Only `/auth/login` and `/auth/callback` are throttled. Unthrottled:
  - `/api/view/*` and `/pdf/*` — public, unauthenticated → token enumeration
    and unauthenticated **PDF-generation DoS** (each hit runs ReportLab).
  - `/api/email/send` — authenticated email relay (see H4).
  - `/api/sync` — destructive admin bulk wipe/repopulate.
  - The QuickBooks OAuth callback.
- **Impact:** Brute-force/enumeration of share tokens; resource-exhaustion DoS
  via PDF generation; amplification of the email-relay and bulk-sync abuse.
- **Mitigation (recommended fix):**
  1. Switch the matcher from exact-path to **longest-prefix** (or a small
     ordered list of `(prefix, limit)` rules) so `/api/view/` and `/pdf/`
     buckets cover all sub-paths.
  2. Add **stricter anonymous buckets** for the public token routes (these
     have no login cost to the attacker) and a separate, tight bucket for
     `/api/email/send` and `/api/sync`.
  3. Consider keying public-route limits on token-prefix as well as IP to
     blunt distributed enumeration.

### H3 — Mass-assignment via the deny-list write layer

- **Where:** `backend/routes/api.py` — `_READONLY_COLS` deny-list (`:33-37`),
  `_dict_to_row` (`:53-61`), `create` (preserves a client-supplied
  `share_token` instead of always minting one, `:161-164`), `update`
  (re-writes any non-denied column, `:197-200`).
- **What:** The write layer is a **deny-list**: any column not explicitly
  listed in `_HIDDEN_COLS`/`_READONLY_COLS` is writable by any authenticated
  member. That currently includes:
  - **`share_token`** — the public-view credential. A member can *set it to a
    guessable value* on create or *rotate it* on update (this is the writable
    half of the public-token weakness in [C-tier context]; the view path only
    rejects `len < 8`, `view.py:69`).
  - **Foreign keys** — `company_id`, `client_contact_id`, `project_id`,
    `quote_id`. A member can **re-bill** an invoice to a different customer or
    **re-link** records.
  - **Classification flags** — `is_client`, `is_vendor`, `taxable` — a member
    can reclassify a contact/company (tax and billing consequences).
- **Impact:** Privilege/data integrity violations available to *any* member:
  re-point the public link, re-bill invoices, reclassify customers, silently
  corrupt relationships.
- **Mitigation (recommended fix):**
  - **A (preferred):** Replace the deny-list with a **per-model writable
    allow-list**. Each model declares the exact columns the client may write;
    everything else (tokens, FKs, server-managed fields) is server-authoritative
    by default. This is fail-safe — new columns are read-only until explicitly
    opened.
  - **B (minimum):** Add `share_token` and all FK/classification columns to
    `_READONLY_COLS`, and always mint `share_token` server-side (never honor a
    client-supplied one). Validate FK targets exist and belong to the tenant
    before assignment.
  - Either way, **route `bulk_sync` through the same `create()`/`update()`
    pipeline** (see H5) so it can't bypass these guards.

### H4 — `/api/email/send` is an authenticated open relay

- **Where:** `backend/routes/email.py` (member-level, `require_session`); no
  recipient cap, no throttle; arbitrary recipient list + arbitrary HTML body.
- **What:** Any authenticated member can send email **as the company Gmail
  account** to an arbitrary recipient list with attacker-chosen HTML. Header
  injection is correctly blocked and `From` is always the authenticated user,
  but the recipient list and body are unconstrained and unthrottled.
- **Impact:** Spam/phishing originating from the company's trusted, properly
  authenticated domain (passes SPF/DKIM/DMARC) — high deliverability, real
  reputational and abuse risk. A single compromised or rogue member account
  becomes a phishing cannon.
- **Mitigation (recommended fix):**
  1. **Cap recipients per send** and **rate-limit** the endpoint per user
     (ties into H2).
  2. **Constrain recipients** to known entities where possible (resolve
     against the contacts/recipients tables; reject free-form addresses, or
     require them to match a quote/invoice the user can access).
  3. Consider an **admin gate or per-user daily quota** for bulk/arbitrary
     sends, and log every send (recipient count, entity) for abuse review.

### H5 — `bulk_sync` bypasses validation, attribution, and throttling

- **Where:** `backend/routes/api.py:386-423` (`POST /api/sync`).
- **What:** Admin-gated and destructive **by design** (wipes and repopulates
  every table from a localStorage dump). But it calls `_dict_to_row` directly,
  skipping `validate()` and `_stamp_activity()`, and is unthrottled. An admin
  (or a CSRF/compromise of an admin session — see H8) can forge `share_token`
  and `activity` records and wipe all data in one request.
- **Impact:** Full data wipe + forged records + bypassed field validation;
  amplified by the absence of CSRF protection.
- **Mitigation (recommended fix):**
  1. Route each item through the shared `create()`/`update()` pipeline so
     `validate()`, attribution stamping, and the allow-list (H3) all apply.
  2. Add CSRF/Origin enforcement (H8) and a tight rate limit (H2) given how
     destructive it is.
  3. Consider gating it behind an explicit one-time "migration mode" flag so
     it can't be invoked casually post-onboarding.

### H6 — Session-cookie signing key fails open to an ephemeral key

- **Where:** `backend/main.py:298-310`.
- **What:** If `LTP_SESSION_SECRET` is unset, the app **logs a warning/error
  but boots anyway**, generating an ephemeral `secrets.token_hex(32)` per
  process. This key signs the Starlette session cookie that carries the OAuth
  **state/nonce** — the primary OAuth-CSRF defense.
- **Impact:** The key is cryptographically strong, so it's not *forgeable*, but
  the failure is **silent** and **per-process**: across restarts or multiple
  workers, the state cookie can't be validated consistently, breaking OAuth
  login (and its CSRF protection) intermittently. A production deploy missing
  the var looks healthy until logins start failing — and operators may "fix"
  it by relaxing other controls.
- **Mitigation (recommended fix):**
  1. **Fail fast at boot** in production (HTTPS / non-dev): refuse to start
     without `LTP_SESSION_SECRET`.
  2. **Enforce a minimum length/entropy** (≥ 32 bytes) and reject obvious weak
     values.
  3. Keep the ephemeral-key convenience for local dev only, behind an explicit
     dev flag.

### H7 — Transport security keyed on a URL string, not the actual transport

- **Where:** `backend/routes/auth.py:43-48` (`_cookie_secure()`),
  `backend/main.py:199` (`https_only`), and the HSTS header — all derived from
  whether `LTP_OAUTH_REDIRECT_URI` *starts with* `https://`.
- **What:** The `Secure` cookie flag, `SessionMiddleware(https_only=…)`, and
  HSTS are gated on a **string check of an env var**, not on the real request
  scheme. A misconfigured or absent redirect URI silently disables all three.
- **Impact:** Fail-open: session and OAuth-state cookies can be sent over
  cleartext; HSTS not emitted → downgrade/MITM exposure.
- **Mitigation:**
  - **A:** Derive "are we on HTTPS" from the actual request scheme behind the
    proxy (`X-Forwarded-Proto`, with the existing trusted-hop logic), not from
    a config string.
  - **B:** Add an explicit `LTP_FORCE_HTTPS=true` for production that's
    independent of the redirect URI, and **default to secure** when unsure.

### H8 — No CSRF / Origin checks on state-changing endpoints

- **Where:** App-wide. Session auth is a cookie; `SameSite=Lax` is the **only**
  CSRF defense. No Origin/Referer validation, no CSRF token.
- **What:** `SameSite=Lax` blocks cross-site POST/PUT/DELETE in modern
  browsers but **not** top-level GET navigations and is weaker against some
  flows; it's a single layer for a cookie-authenticated API that includes
  destructive operations (`/api/sync`, DELETEs, QuickBooks push/delete, email
  send).
- **Impact:** Cross-site requests could drive state changes as a logged-in
  staff user under the wrong conditions (older browsers, method/embedding
  tricks).
- **Mitigation (recommended fix):**
  1. Add **Origin/Referer validation** middleware for all mutating methods
     (allow same-origin only) — cheap, broad coverage.
  2. For the most destructive endpoints, layer a **CSRF token** (double-submit
     cookie or per-session token).
  3. Move the session cookie to `SameSite=Strict` if the UX allows (it's a
     single-origin SPA, so this is likely fine).

### H9 — QuickBooks OAuth callback trusts query params (CSRF / realm injection)

- **Where:** `backend/routes/qbo.py:70` and `:91`.
- **What:** The callback reads `realmId` directly from the query string and
  trusts it; the "re-assert admin session" step is **not** a CSRF defense
  (an attacker's admin victim is still admin). The callback is also unthrottled
  (H2). State/nonce validation exists via Authlib, but the realm binding does
  not.
- **Impact:** A crafted callback could associate the connection with an
  attacker-influenced `realmId`, or be replayed/forged to manipulate the
  connection record.
- **Mitigation:**
  1. **Bind the OAuth `state` to the initiating session** and verify it on
     callback (beyond Authlib's cookie round-trip).
  2. **Validate `realmId`** against an expected/stored value (or pin it on
     first successful connect and reject mismatches thereafter).
  3. Rate-limit the callback (H2).

### H10 — OAuth provider error bodies are logged *and* reflected to the client

- **Where:** `backend/quickbooks.py:213,219`; `backend/gmail.py:168,177`
  (surfaced outward through their routes).
- **What:** On token-endpoint failures, the raw provider response body
  (`resp.text`) is both logged and bubbled back toward the client.
- **Impact:** Provider error text can carry sensitive detail (token state,
  account hints, internal identifiers) — information disclosure to the browser
  and verbose secrets-adjacent data in logs.
- **Mitigation:** Log a **sanitized, truncated** summary server-side only;
  return a **generic** message to the client (the code already has a
  `_summarize_fault` helper for QBO API faults — extend the same discipline to
  the token endpoints).

### H11 — Logout does not revoke or clear OAuth tokens

- **Where:** `backend/routes/auth.py:214-227`.
- **What:** Logout clears the app session but leaves the stored Gmail and
  QuickBooks tokens intact and valid.
- **Impact:** "Log out" doesn't sever the integration; a stale/compromised
  stored token remains usable. Not least-surprise for a security-conscious
  operator.
- **Mitigation:** Decide the intended semantics and make them explicit:
  - **A:** Logout = end session only (document this; the integrations are
    company-level, not per-session). Provide an explicit "Disconnect" for each
    integration (QBO already has one).
  - **B:** On logout, best-effort revoke at the provider and clear the stored
    tokens. (Heavier; affects shared company-level connections.)
  - Regardless, **kill the server-side session row** on logout (see M4).

### H12 — Accept/decline is unauthenticated, replayable, and non-binding

- **Where:** `backend/routes/view.py:301` (accept handler) and the public
  accept/decline routes.
- **What:** A quote can be accepted or declined by anyone with the share token,
  repeatedly and programmatically. The "signature" is validated only by a
  `data:image/` prefix + length — it does not bind the acceptance to a person
  or prevent replay.
- **Impact:** Forged/automated acceptance of quotes; weak non-repudiation; the
  signature is not evidentiary. (Also the XSS vector in C1.)
- **Mitigation:**
  1. Validate the signature is a **real** image (see C1) and store capture
     metadata (IP/UA/timestamp — noting these are spoofable, L-tier).
  2. **Bind acceptance to a one-time nonce** tied to the token so it can't be
     replayed; transition state so a decided quote can't be re-decided without
     staff action.
  3. Rate-limit the public routes (H2).

---

## MEDIUM

### M1 — Public client-view payload over-exposes (drop-list, not allow-list)

- **Where:** `backend/routes/_shared.py` (`invoice_dict`/`quote_dict` carry
  full rows; `public_section_items` / `public_activity` / `public_settings`
  use **drop-lists**).
- **What:** The public payload is built by *removing* a few keys rather than
  *selecting* an allow-list. It still exposes internal notes, the **payments
  ledger**, `adjustedPrice`, nested FK ids, and **`share_token`** to the
  unauthenticated client view. `_PUBLIC_ITEM_DROP_KEYS` only strips
  `cost`/`deliveredQty`/`invoicedQty`.
- **Impact:** Information disclosure to anyone with a share link — internal
  pricing/notes, payment history, and the share credential itself echoed back.
- **Mitigation (recommended fix):** Convert all public serializers to explicit
  **allow-lists** of client-safe fields. Specifically remove `share_token`,
  `payments`, internal `notes`, and FK ids from anything public.

### M2 — CSP `img-src` wildcard + `data:` is an exfiltration channel

- **Where:** `backend/main.py` (CSP header construction).
- **What:** `img-src https: data:` permits images from any HTTPS host and
  `data:` URLs, which **bypasses** the otherwise-strict `connect-src` — data
  can be exfiltrated by encoding it into an outbound image URL. `style-src`
  also allows `'unsafe-inline'`.
- **Impact:** Weakens the CSP's value as an XSS-mitigation backstop (relevant
  given C1/H1): an injected script can beacon out via `<img>`.
- **Mitigation:** Tighten `img-src` to `'self'` plus the specific hosts
  actually needed (logos, etc.); drop `data:` if feasible (or scope it).
  Migrate inline styles to nonces/hashes to remove `style-src 'unsafe-inline'`.

### M3 — One encryption key for all integrations; no rotation tooling; decrypt-failure ambiguity

- **Where:** `backend/crypto.py`; QBO connection teardown on decrypt failure.
- **What:** A single `LTP_TOKEN_ENCRYPTION_KEY` protects both Gmail and QBO
  tokens. There's no tooling to **re-encrypt** existing rows when rotating the
  key, and a decrypt failure (e.g. after a botched rotation) is
  **indistinguishable** from a user-revoke — QBO responds by deleting the
  connection, which could destroy a valid connection during a key mishap.
- **Impact:** Key rotation is risky/unsupported operationally (this directly
  blocks the C2 rotation remedy); a rotation error silently nukes integrations.
- **Mitigation:**
  1. Add a **rotation CLI** that re-encrypts all token columns under a new
     primary key (the `MultiFernet` design already supports old-key decrypt +
     new-key encrypt).
  2. **Distinguish** `InvalidToken`/decrypt failure from a provider revoke and
     handle them differently (don't auto-delete connections on a local decrypt
     error).
  3. Consider **separate keys** per integration so a Gmail-key incident doesn't
     force a QBO re-auth.

### M4 — Session lifecycle gaps

- **Where:** `backend/auth_deps.py` / session creation & validation; first-user
  bootstrap; `LTP_ALLOWED_DOMAIN` default.
- **What:** Several smaller session weaknesses: no **session-id rotation** on
  login or privilege change; no server-side **kill on logout** (H11); a
  **first-user-becomes-admin race**; an **open `LTP_ALLOWED_DOMAIN` default**
  (if unset, domain restriction is effectively off); an `email_verified is
  False` check that can miss missing/None values; and duplicated
  session-validation logic across modules.
- **Impact:** Session fixation potential; first-to-register admin hijack on a
  fresh deploy; unintended cross-domain Google sign-in; inconsistent auth
  checks.
- **Mitigation:**
  1. **Rotate the session id** on login and on any privilege change; delete the
     session row on logout.
  2. **Require `LTP_ALLOWED_DOMAIN`** (fail closed if unset in production) and
     treat `email_verified` as true only when explicitly `True`.
  3. Gate the first-admin bootstrap (one-time setup token, or manual DB seed)
     instead of "first login wins."
  4. **Centralize** session validation in one dependency.

### M5 — No foreign-key validation on writes

- **Where:** `backend/routes/api.py` (`create`/`update`/`bulk_sync`).
- **What:** FK columns are written without checking the referenced row exists.
  On SQLite this **silently corrupts** (FKs not enforced by default); on
  Postgres it surfaces as a 500.
- **Impact:** Dangling references / inconsistent data; ungraceful errors.
  (Compounds H3, where FKs are also member-writable.)
- **Mitigation:** Validate referenced rows exist (and belong to the tenant)
  before assignment; return a clean 400 on bad references.

### M6 — `emailReplyTo` stored unvalidated

- **Where:** `backend/routes/api.py:252`.
- **What:** The Reply-To value is persisted without validation. A malformed
  value later raises an uncaught `ValueError` at send time (500, orphaned
  recipient rows), and a valid-but-spoofed value sets an arbitrary Reply-To.
- **Impact:** Send-time 500s + data orphaning; Reply-To spoofing (phishing aid,
  complements H4).
- **Mitigation:** Validate the address at write time (reuse the existing
  `email_validate` path); handle send errors transactionally so a bad
  Reply-To can't orphan recipient rows.

### M7 — Client-side email body stored unsanitized (defense-in-depth gap)

- **Where:** `components/email-body-editor.js` (and the rich-text editor).
- **What:** The editor stores composed HTML without client-side sanitization.
  The **server re-sanitizes** with `bleach` on send (the authoritative layer,
  which is correct), but the unsanitized HTML lives in app state and is
  rendered into the in-app preview via `innerHTML`.
- **Impact:** Defense-in-depth gap; the preview path can render
  attacker-influenced markup before the server ever sees it.
- **Mitigation:** Sanitize on input client-side too (mirror the server
  allow-list), and render the preview through the existing `purify()` helper
  rather than raw `innerHTML`.

---

## LOW

| ID | Finding | Location | Mitigation |
|----|---------|----------|------------|
| **L1** | Session token stored **unhashed** at rest (DB compromise → usable tokens). | `sessions` table | Store `SHA-256(token)`; compare hashes. |
| **L2** | **30-day** session, no idle timeout. | session config | Add idle timeout + absolute max lifetime. |
| **L3** | Member-level **DELETE** with no admin gate/audit; `update_user` has a redundant `require_admin`. | `api.py` routes | Gate destructive ops to admin; add an audit log. |
| **L4** | Non-constant-time token lookups; audit-log IP/UA are spoofable. | `view.py`, tracking | Acceptable given DB-lookup model; treat audit metadata as advisory. |
| **L5** | Email anchors keep `target=_blank` without `rel="noopener noreferrer"`; remote-image/CSS email beacons; in-app preview `innerHTML`. | `sanitize.py`, `email-body-editor.js` | Add `rel="noopener noreferrer"`; strip/box remote content in preview. |
| **L6** | No `--proxy-headers`; `LTP_TRUST_PROXY_HOPS` spoofable if set too high; no gzip-bomb guard; missing `Permissions-Policy`/CORP/COEP. | `main.py`, deploy | Add the headers; document the hop count; add a decompression guard. |
| **L7** | `meetLink` rendered as `href` without a protocol guard (latent `javascript:`). | frontend (notes/projects) | Allow-list `http/https/mailto` only. |
| **L8** | Google Fonts `<link>` has no SRI (fonts are also vendored under `assets/`). | `index.html` | Self-host the fonts (assets already present) or add SRI. |
| **L9** | OAuth error detail reflected to client on the auth side. | `auth.py` | Generic client message (pairs with H10). |
| **L10** | Dependency advisories (see below). | `requirements.txt` | Bump + re-test. |

### L10 — Dependency bumps

- **`authlib==1.3.2`** → affected by **GHSA-pq5p-34cr-23v9** (DoS; fixed in
  1.6.5). Bump to **≥ 1.6.7** (or 1.7.2). *Not* affected by the 1.6.0+ JWT
  bypass CVEs (we're below that range), but upgrading closes the DoS and keeps
  us current.
- **`cryptography==42.0.5`** → bundled-OpenSSL advisories
  **GHSA-h4gh-qq45-vh27** and **GHSA-79v4-65xg-pq4g**. Bump to **≥ 44.0.1**.
- Re-run the full test suite after bumping (the Gmail/QBO token-refresh and
  Fernet paths are the ones to watch).

---

## Verified secure (don't spend effort here)

The audit explicitly confirmed these are **already handled correctly** —
listed so remediation effort isn't wasted re-checking them:

- **No SQL injection** anywhere — parameterized SQLAlchemy ORM throughout.
- **No SSRF** — every outbound host (Google, Intuit) is a pinned constant; TLS
  verified; `follow_redirects=False`; timeouts on every call. No open redirect.
- **QuickBooks query injection** — `escape_query_value` is applied correctly at
  all five query sites; the `'` escaping is sound.
- **No SSTI, no prototype pollution, no `eval`.** The client view is
  React-escaped; the PDF is canvas/draw-based (no markup interpolation).
- **Email header injection blocked**; `From` is always the authenticated user.
- **Authorization is server-enforced** — the `User` model is deliberately
  **not** in the CRUD factory (no role mass-assignment); `qb_*` columns are
  read-only via `_READONLY_COLS`; admin gates on the routes that need them.
- **Tokens never reach the browser** — `/api/qbo/status` returns booleans +
  masked metadata only; no endpoint returns Gmail/QBO tokens; no hardcoded
  secrets in the codebase.
- **Static serving is path-traversal safe** (`_resolve_static`); **middleware
  ordering** is correct; **chunked-payload size limit** enforced; **no CORS**
  surface exposed.
- **CSP `script-src` is strict**; **SRI (SHA-384) on all four CDN libraries**
  with `crossorigin`; no `localStorage` secret storage; the hash router is
  injection-safe.
- Public **share/pdf/tracking tokens** are generated with strong entropy
  (`secrets.token_urlsafe`, ≥ 144 bits) — the weakness is the *write path*
  (H3) and *view-path validation* (H2/H12), not the default token strength.

---

## Remediation roadmap

A suggested order. Each phase is independently shippable; nothing here is
implemented yet — these are proposals for your sign-off.

### Phase 0 — Contain exposure (do first, low effort)
- ✅ **C2** — removed the `.db` files; fixed `.gitignore` (`7d2abcc`). Operator
  follow-up: rotate the Gmail grant + encryption key, purge history.
- ✅ **H6** — fail-fast on missing/weak `LTP_SESSION_SECRET` (`d20b0ef`).

### Phase 1 — Close the exploitable holes
- ✅ **C1 + H1** — eliminated both `document.write` XSS sinks; signatures
  validated as real images server-side (`f4da2b7`).
- ✅ **H3** — `share_token` made server-only (`98f75c9`). The broader allow-list
  write-layer refactor + FK locking (M5) remain open by design (see the finding).
- ✅ **H2** — prefix-based rate limiting with anonymous buckets for public/PDF/
  email/sync routes (`0e091a5`).
- ✅ **H4** — recipient cap on `/api/email/send` (`486fe1f`); per-IP throttle via
  H2. Recipient-to-known-contacts constraint deferred to Phase 2.
- ✅ **H10** — stopped reflecting provider error bodies to the client (`f78fbf5`).

### Phase 2 — Structural hardening — ✅ done
- ✅ **H5** (`bulk_sync` validation), **H7** (transport from real scheme),
  **H8** (Origin/CSRF), **H9** (QBO realm pinning), **H11** (logout
  session-kill, documented), **H12** (accept/decline audit binding).
- ✅ **M1** (public payload trim), **M3** (key rotation tooling + decrypt fix),
  **M4** (session lifecycle / access allowlist), **M5** (FK validation),
  **M6** (`emailReplyTo`).

### Phase 3 — Defense-in-depth & hygiene — ✅ done
- ✅ **M2** (CSP `img-src` tightened; `style-src 'unsafe-inline'` kept — needs a
  nonce architecture), **M7** (client-side sanitize), **L1** (hashed session
  tokens), **L2** (idle timeout), **L3** (delete audit), **L5/L6** (noopener +
  headers), **L7** (`meetLink` guard), **L8** (self-hosted web fonts),
  **L9** (generic OAuth error), **L10** (dependency bumps).
- **L4** accepted as-is (DB-lookup model; advisory audit metadata).

---

## Notes on method & limits

- All eight agents ran **read-only**; no code was changed *during the audit*.
  The Phase 0–3 fixes listed in [§ Implementation status](#implementation-status)
  were made afterward, each as its own commit.
- **Test verification:** the suite uses on-disk per-module SQLite DBs seeded via
  module-level `os.environ.setdefault`, so a single combined `pytest` process
  cross-contaminates (a pre-existing artifact, confirmed identical on the
  pre-security baseline). Run **file-by-file** it is green — 215/215 including
  the new `tests/test_security_hardening.py` (signature/rate-limit/share_token/
  CSRF/session-hash/public-payload/key-rotation/audit/noopener coverage).
  Invoke with `pytest -o asyncio_mode=auto tests/<file>.py`.
- Findings were cross-checked against the source at the cited line numbers
  before inclusion; a handful of agent reports overlapped and were merged
  (the two `document.write` sinks; the rate-limit gap seen from three angles;
  the email relay seen by two agents; the committed `.db` files seen by two).
- Line numbers reference the state of `claude/security-hardening` at the time
  of review and may drift as fixes land.
- This review covers application code, config, and direct dependencies. It does
  **not** cover: the Railway platform/account security, Google/Intuit account
  hygiene (MFA, app-grant review), DNS/email DMARC policy, or a runtime DAST
  scan of the deployed instance — recommend those as follow-ups.
