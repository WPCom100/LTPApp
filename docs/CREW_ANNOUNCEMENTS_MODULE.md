# Crew Announcements — design notes for a future module

**Status:** not built. These are architecture notes so today's static
announcement doesn't paint the module into a corner.

**Goal:** compose, preview, send and archive broadcast emails to crew — the
"here's how the new system works" announcement, policy notes, season kickoffs,
rate changes — from inside the app, instead of hand-built HTML and a paste into
Gmail.

## What exists today, and what it's standing in for

The current announcement is a **static build**, deliberately: one template
(`docs/crew-briefing/template.html`) rendered by `docs/crew-briefing/build.py`
into a committed page plus a paste-ready email. It was the right size for one
announcement. It does not scale to "manage and send these to all crew", and two
parts of it are explicitly stopgaps to retire:

| Stopgap today | What the module replaces it with |
|---|---|
| `assets/crew-email/*.html` + `*.js` in `_ALLOWED_TREES` (`backend/main.py`) | A DB-backed public route + SPA view, like `#/crew/{token}` — no static-file exceptions at all |
| Announcement body committed as generated HTML | A row in `crew_announcements`, edited in the app |
| Screenshots committed under `assets/crew-email/` | An uploads table, or keep curated assets — but referenced by the row, not hard-coded in markup |
| `build.py` keeping page and artifact in sync by hand | One server-side renderer feeding both the email and the web view |

**Retiring the allow-list entries is the clearest signal the module has landed.**
They are a widening of a deny-by-default policy (`test_deny_by_default_preserved`
pins how far), justified only while the content is static files.

## What to reuse, not reinvent

The crew-request system (`docs/CREW_REQUEST_PLAN.md`) already solved most of
the hard parts. The module should look like a sibling of it:

- **`backend/email_compose.py`** — `email_shell` (canvas, card, masthead,
  footer) and `render_masthead`. Every outbound email already goes through
  these; announcements must too, or they will drift visually. `_render_signature`
  renders the sender's block per-user.
- **`backend/gmail.py::send`** — the send pipeline, with `GmailReconnectRequired`
  / `GmailSendError` already modelled. Reuse the reconnect-aware error shape
  from `routes/crew.py::_send_crew_email` rather than inventing another.
- **`backend/sanitize.py::email_html`** — every composed body passes through it.
- **`backend/view_tracking.py`** + per-recipient `tracking_token` — this is how
  open-tracking already works for quotes/invoices. Announcements get it free.
- **`modules/crew-view.js`** — the pattern for a public, token-addressed,
  unauthenticated page. An announcement view is the same shape with different
  content.
- **`data/settings.js` `emailTemplates`** + `LTP_TEMPLATE_VARIABLES` — if
  announcements are template-driven, they belong in this structure, with their
  variables declared so the Settings editor can show them.
- **Contacts as the audience** — `contacts.is_crew`, `crew_roles`,
  `crew_departments`, `crew_status`. No new roster.

## Data model sketch

**`crew_announcements`** — one row per announcement:

| column | notes |
|---|---|
| `id` | client-assigned, like other entities |
| `token` | public credential for the web view; server-minted `token_urlsafe(32)`, in `_READONLY_COLS` |
| `title` / `subject` | the subject line is not the title; both are edited |
| `body` | the authored content (see "Authoring" below) |
| `status` | `draft` \| `sending` \| `sent` \| `archived` |
| `audience` | JSON filter — roles, departments, active-only, or explicit contact ids |
| `sent_at` / `sent_by_user_id` | |
| `created_at` / `updated_at` | |

**`crew_announcement_recipients`** — one row per person per announcement, which
is what makes a broadcast auditable:

| column | notes |
|---|---|
| `announcement_id` / `contact_id` | FKs |
| `tracking_token` | per-recipient, drives open tracking and a personal view URL |
| `email` | snapshot at send time — addresses change |
| `status` | `pending` \| `sent` \| `failed` \| `skipped_no_email` |
| `error` | the Gmail failure, kept for the retry UI |
| `sent_at` / `first_viewed_at` / `view_count` | |

Per-recipient rows matter more here than in crew requests: a broadcast to 40
people **will** partially fail, and "which 6 didn't get it, and why" has to be
answerable without reading logs.

## Authoring — the decision that shapes everything

Three options, in increasing order of effort:

1. **Rich-text body.** Reuse `components/rich-text-editor.js` /
   `email-body-editor.js`. Fastest to build. Cannot express the numbered-step,
   figure-with-caption layout the current announcement uses.
2. **Block composer.** A small set of typed blocks — paragraph, callout,
   numbered step, image + caption, button — rendered server-side into both the
   email and the web view. This is what the current announcement actually *is*,
   and it round-trips: the existing content maps onto these blocks cleanly.
3. **Markdown + a renderer.** Compact to store, but the styling vocabulary ends
   up encoded in conventions, and images/captions get awkward.

**Recommend (2).** The renderer is the single source both surfaces read, which
is the property `build.py` is currently faking. It also keeps the email inside
the inline-style constraints automatically — the class of bug that produced the
padding failure (an inline `padding:0` beating a stylesheet rule) becomes
impossible when one renderer owns both outputs.

## Sending

- **Preview before send, always.** Render the exact HTML into the composer, and
  offer a **test send to me** — the single highest-value safety feature for a
  broadcast, and cheap.
- **Audience preview.** "This goes to 38 crew; 3 have no email on file." Name
  them. Crew with no email are `skipped_no_email`, not a silent drop.
- **Send is a background job, not a request.** 40 Gmail calls will exceed a
  sensible request timeout. Follow the pollers in `backend/main.py`
  (`_qbo_receipt_poll_loop`) — enqueue, process, update per-recipient rows,
  surface progress. Partial failure must be resumable: **retry failed only**,
  never re-send to everyone.
- **Respect the recipient cap and rate limits** already applied on the crew
  paths; add an `/api/announcements` prefix bucket to `backend/rate_limit.py`.
- **Sender is the authenticated user's Gmail**, as elsewhere. The `From` must
  stay a real person.

## Web view

`#/announcement/{token}` — public, unauthenticated, token is the credential;
same posture as `#/crew/{token}`, with the same allow-listed payload discipline
(no other recipients' data, no internal notes). Per-recipient tokens let the
view attribute opens; a shared announcement token is the fallback for "just
give me a link I can post".

This is what removes the static-file allow-list entries: the page is rendered
by the SPA from an API payload, so `assets/crew-email/` stops needing to serve
`.html`/`.js` at all.

## Things worth deciding early

- **Announcements are not crew requests.** No accept/decline, no position state
  machine. Resist reusing `crew_requests` for this — the lifecycles differ and
  the join would be regretted.
- **Archive is a feature, not a side effect.** Crew asking "what was that email
  about the new system?" should have a link that still works a year on. That
  argues for tokens that never expire and rows that are never hard-deleted.
- **One renderer, two outputs, no exceptions.** The moment the web view and the
  email are produced by different code, they drift — that is exactly what
  happened here, and it took three rounds to notice and fix.
- **Screenshots age.** The current announcement's images are pinned captures of
  `modules/crew-view.js`. When that UI changes they become wrong, silently.
  Whatever the module does about images, "these are stale" needs to be
  discoverable.

## Open questions

- Do announcements need scheduling (send at 6am Tuesday), or is send-now enough?
- Should crew be able to reply *in* the app, or is reply-to-email sufficient?
  (Reply-to-email is, almost certainly, and it is free.)
- Is there an unsubscribe obligation? These are operational messages to
  contractors, not marketing — but worth a deliberate answer rather than an
  assumption.
