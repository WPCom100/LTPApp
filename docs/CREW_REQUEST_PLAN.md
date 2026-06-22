# Crew Request System — Design & Build Plan

**Branch:** `claude/crew-request-system` (off `master`)
**Goal:** Let crew members **accept/decline job requests** from a tokenized public
landing page (reusing the client-view pattern used for quotes/invoices),
**auto-driving** the existing assignment status, with **crew-request emails** and
**per-project grouping** (split into specific shifts when needed). Plus a side
refactor: promote the **Labor tabs into the nav** like the other modules.

## Decisions (confirmed with owner)

1. **Accept = pending confirm.** A crew member's acceptance moves the position
   `requested → accepted`; the producer still confirms `accepted → confirmed` in
   the Assignments tab (today's two-step is preserved).
2. **Decline keeps the slot declined.** Decline moves the position
   `requested → declined`, **crew stays attached**, nothing reopens
   automatically; the producer decides what to do in Assignments.
3. **Labor = parent + sub-nav.** Keep one **Labor** nav item with sub-nav
   *Assignments / Crew Roster / Calendar / Weekly Schedule*, exactly like
   CRM / Rentals / Quotes.
4. **Whole project by default, shift-selectable splitting.** One request covers
   all of a crew member's positions in a project; the producer may instead pick
   which shifts go into each request (one person can have multiple requests for
   one project).

## What already exists (reused, not reinvented)

- **Tokenized public view**: `share_token` + `/api/view/{token}` + accept/decline
  + `modules/client-view.js` (`#/view/...`), all unauthenticated, token = the
  credential. The crew landing page mirrors this exactly.
- **Assignment model**: crew are `contacts` with `isCrew`; assignments are
  **positions** inside each project's `schedule[].positions[]` —
  `{id, role, serviceId, crewId, status}` — with the lifecycle
  `open → requested → accepted/declined → confirmed`
  (`components/status-enums.js` `POSITION`).
- **Labor → Assignments tab** (`modules/labor.js`) already lets the producer flip
  those statuses manually and has email-on-status-change scaffolding
  (`Release Quietly` / `Cancel Without Email`). The new work makes the crew
  drive `requested → accepted/declined` themselves.
- **Email**: Gmail send pipeline, per-recipient `tracking_token`, `{{viewUrl}}`
  substitution, the email-template editor + header/signature blocks
  (`backend/routes/email.py`, `backend/gmail.py`, `modules/settings.js`,
  `data/settings.js`).
- **Hardened patterns** (from PR #3): server-minted strong tokens in
  `_READONLY_COLS`, prefix rate-limiting, public-payload allow-lists, accept
  audit metadata, `email_html` sanitization. The crew surfaces adopt all of these.

## 1. Data model (`backend/models.py` + one Alembic revision)

New table **`crew_requests`** — one row per (crew member × request-group):

| column | type | notes |
|--------|------|-------|
| `id` | Integer PK | client-assigned, like other entities |
| `token` | String, indexed | the public credential; server-minted `token_urlsafe(32)`; **read-only** (in `_READONLY_COLS`) |
| `project_id` | FK projects (SET NULL), indexed | the job |
| `contact_id` | FK contacts (SET NULL), indexed | the crew member |
| `position_ids` | JSON list[str] | which schedule position ids this request covers (default = all of the crew member's positions in the project; a subset when split) |
| `status` | String | `pending` \| `accepted` \| `declined` \| `withdrawn` |
| `sent_at` / `responded_at` | DateTime | timestamps |
| `sent_by_user_id` | FK users (SET NULL) | who sent it |
| `comment` | Text | optional note the crew member leaves on response |
| `respondent_ip` / `respondent_ua` | String | internal audit (never in the public payload) |
| `created_at` / `updated_at` | DateTime | |

- **Migration**: one additive, nullable, reversible revision; `down_revision` =
  current head `c4d5e6f7a8b9`; `batch_alter_table` for SQLite; auto-applied by
  `init_db()` on boot.
- **API guard** (`backend/routes/api.py`): `token` joins `_READONLY_COLS`
  (server-authoritative, never client-set/rotated); FK columns are
  existence-validated by the M5 `_validate_fks` already in place.
- Positions stay in `project.schedule` JSON — `crew_requests` references them by
  id; the backend updates their `status` in the project row on accept/decline.

## 2. Backend routes

**Public, token-authenticated (new `backend/routes/crew.py`, prefix `/api/crew`,
NO session — mirrors `view.py`):**
- `GET /api/crew/{token}` → sanitized crew-facing payload: project name + dates +
  venue, the crew member's **own** shifts in this request (role, date, start/end
  time, notes), request status, and branding (`public_settings`). **Allow-list
  only** — no cost, no internal notes, no other crew's data. Token entropy/format
  validated (reject short/garbage) before lookup.
- `POST /api/crew/{token}/accept` → request `pending → accepted`; its positions
  `requested → accepted`; record `responded_at`, optional `comment`, IP/UA;
  stamp project activity. Idempotent: once terminal, 409 with current status.
- `POST /api/crew/{token}/decline` → request `pending → declined`; positions
  `requested → declined` (crew stays attached). Same idempotency/audit.
- Added to the **rate limiter** (`/api/crew` prefix bucket).

**Producer-side (session-gated, under `/api`):**
- `POST /api/crew-requests/send` → body `{projectId, contactId, positionIds[]}`
  (positionIds omitted = whole project). Validates the crew member has an email;
  creates the `CrewRequest` (mints token); sets those positions
  `open → requested`; sends the crew-request email via the Gmail pipeline;
  returns the request + a `needsReconnect`/error shape mirroring `email.py`.
  Splitting = call once per shift-subset.
- `POST /api/crew-requests/{id}/withdraw` → request `→ withdrawn`; its positions
  `requested → open`; optional withdrawal email (reuse the existing quiet/notify
  toggle).
- `GET /api/crew-requests` (+ `?projectId=`) → list for the Assignments UI
  (status, who, which shifts, timestamps). Read-only; no token in the camelCase
  output is fine (it's the producer's own data) — but we still never surface it
  on the **public** payload.

## 3. Crew landing page (`modules/crew-view.js`, mirrors `client-view.js`)

- Route `#/crew/{token}` (added to the hash router's public routes, alongside
  `#/view/...`). Unauthenticated; the token is the credential.
- Fetches `GET /api/crew/{token}`; renders: greeting with the crew member's name,
  the project, a clean list of **their** shifts (date · time · role · venue),
  current status, and **Accept** / **Decline** actions with an optional comment
  box. On submit → POST accept/decline → confirmation state (mirrors the quote
  accept screen). Returning after a decision shows the recorded response
  (locked). Reuses the client-view branding/layout.

## 4. Email integration

- New template type **`crew_request`** in `emailTemplates` (settings), with a
  customer-facing **header block adapted for crew**: project + shift summary +
  an **Accept / Decline section** — quick-link buttons that open the crew
  landing page (`{{viewUrl}}` → `…/#/crew/{token}`), where the actual response +
  optional comment is captured (the landing page is the source of truth, exactly
  like the quote "View & Accept or Decline" button).
- Send pipeline: reuse `backend/routes/email.py` / `backend/gmail.py`. Substitute
  `{{viewUrl}}` with the crew URL and a `{{shifts}}`/header block listing the
  shifts; sanitize with `email_html`; recipient = the contact's email.
- Editor support: add the `crew_request` template to `data/settings.js`
  (default) and the Settings template editor (`modules/settings.js`), with the
  available variables (`crewName`, `projectName`, `shifts`, `viewUrl`).

## 5. Producer UI — Labor → Assignments (extend `modules/labor.js`)

- **Send request flow**: for a crew member already assigned to positions in a
  project, a "Send request" action shows their positions grouped by project;
  default sends the whole project as one request, with checkboxes to **select a
  subset of shifts** (and "send remaining as separate request"). Replaces the
  current manual `open → requested` flip with a real tokenized send + email.
- **Track responses**: surface `crew_requests` status (pending / accepted /
  declined / withdrawn) next to the existing position statuses. When crew accept
  via the landing page, the position auto-appears in the producer's
  "to confirm" list; decline shows as declined (crew attached).
- **Withdraw / resend**: withdraw a pending request (positions → open) and
  re-send (to the same or a different crew member).

## 6. Nav restructure (side note — Phase 0)

Promote the Labor tabs to nav like CRM/Rentals/Quotes:
- Keep `{ id: "labor", label: "Labor" }` in `theme.js` `LTP_MODULES`.
- Add a **Labor sub-nav** in `app.js` (next to the CRM/Rentals/Quotes sub-nav
  blocks): `labor/assignments`, `labor/roster`, `labor/calendar`,
  `labor/schedule`.
- Drive `LaborView`'s tab from the **route** (`labor/<tab>`) instead of internal
  `useState`, so deep links + the sub-nav work (the router already supports
  `crm/companies`-style paths).
- Independent of the crew feature; doing it first gives the crew-request UI its
  home (the Assignments sub-route).

## 7. Status state machine (summary)

```
producer sends     → request: pending   ; positions: open → requested
crew accepts        → request: accepted  ; positions: requested → accepted   (producer later confirms → confirmed)
crew declines       → request: declined  ; positions: requested → declined   (crew stays attached)
producer withdraws  → request: withdrawn ; positions: requested → open
```
Responses are locked once terminal (re-POST → 409 with current status); the
producer can withdraw + re-send.

## 8. Security (reuse the hardened patterns)

- Token server-minted `token_urlsafe(32)`, in `_READONLY_COLS`; entropy/format
  validated on the view path; `/api/crew` rate-limited.
- Public payload is an **allow-list**; exposes only THIS crew member's shifts +
  branding — never cost, internal notes, other crew, or the token itself.
- Accept/decline are idempotent + capture IP/UA (internal-only audit), like the
  quote flow (H12). Same-origin POSTs pass the Origin/CSRF middleware.
- Crew email reuses the recipient cap + sanitization; `From` is the authenticated
  sender.

## 9. Build order

0. **Nav restructure** — Labor parent + sub-nav, route-driven tabs.
1. **Model + migration + backend** — `crew_requests`, public crew routes
   (GET/accept/decline) with security, producer send/withdraw routes, status
   automation on project positions.
2. **Crew landing page** — `crew-view.js`, router route, branding, accept/decline
   + comment + confirmation + audit.
3. **Email** — `crew_request` template + accept/decline section + substitution;
   default template; Settings editor support; wire the send pipeline.
4. **Producer UI** — send flow (whole project / select shifts), response
   tracking, withdraw/resend, surface accepted → confirm.
5. **Verification** — tests + end-to-end.

## 10. Verification

- **Backend**: token round-trip; accept/decline state machine (positions update,
  request status, idempotency/lock); withdraw reopens; security (token entropy,
  rate-limit, payload allow-list, no cross-crew leakage); send validates email.
- **Frontend**: crew-view renders/accepts/declines; producer send + split flow;
  nav sub-routes + deep links.
- Full existing suite stays green (run file-by-file).

## Assumptions (flag if wrong)

- A crew member needs an **email on file** to be sent a request (validated at send).
- Accept/decline is **per request** (granularity comes from splitting at send),
  not per-shift within a single request.
- A response is **locked** once submitted; changes go through producer
  withdraw + re-send.
