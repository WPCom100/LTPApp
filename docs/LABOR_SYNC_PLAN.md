# Schedule ↔ Quote/Invoice Labor Sync & Cancelled Labor — Design & Build Plan

**Branch:** `claude/cool-cori-92cdjb` (off `master`)
**Status:** decisions confirmed with the owner on 2026-09-23 except the two in
*Open questions* below. Nothing is built yet.
**Goal:** Let a producer **bring a quote's or invoice's labor lines back in step
with the project schedule on demand** — never automatically — reviewing each
difference and applying only the ones they want, without touching hand-added
lines, per-line price adjustments, other sections, or the discount. The same
review works on a **draft invoice at generation time and afterwards**. And give
the schedule a real **cancelled** state for labor, so a last-minute cancellation
can still **bill the client a chosen share** and **pay the crew member a chosen
share**, both at the producer's discretion, and both flowing through the
existing sync, payout and QuickBooks paths instead of around them.

---

## Decisions (confirmed with owner, 2026-09-23)

1. **Sync is explicit, per line, and reversible.** A "Labor out of sync"
   notice appears on the document; a review modal lists every difference with
   a checkbox; **Apply** changes only the ticked lines, **Keep** acknowledges
   the rest so the notice goes quiet until the schedule moves again. Nothing
   changes on save without a click. This mirrors the existing rental-period
   "Update / Keep" pattern exactly.
2. **Which documents can be synced: draft and sent quotes** (a sent quote
   shows the existing "Editing Sent Quote" warning) **and draft invoices.**
   Accepted/converted quotes stay locked (they are the contract the client
   accepted). Sent invoices: see *Open question A*.
3. **Lines stay pooled per role and rate type** (qty = person-days, hours, or
   1 per flat/cancelled position), exactly as today. Sync does not switch the
   document to one line per person. The pooled key `(project, service, rate
   type)` is stable across regenerations, which is what makes a line-level
   diff possible without changing what the client sees.
4. **Sync updates `qty`, `unitPrice`, `cost` and the date note; never
   `adjustedPrice`, never `taxable`, never the discount, never a line without
   a schedule marker.** A hand-edited quantity or price on a schedule line is
   detected (billed value ≠ last-synced value) and that row defaults to
   *unticked* with an "edited by hand" flag, so a deliberate under-charge is
   not silently overwritten.
5. **"Send to Quote/Invoice" onto a document that already carries this
   project's labor opens the sync review instead of appending a duplicate
   section.** An "Append as a new section anyway" escape stays for the odd
   case. (Owner: yes.)
6. **Cancelled is a real position status** (`cancelled`), kept on the schedule
   with its crew member, its locked pay, and a `cancel` record holding the
   chosen bill share and pay share. It is *not* modelled as a deleted position
   plus a fee line plus a no-show adjustment (which is the only workaround
   today, and it shows the crew member "no show").
7. **Cancellation money comes from one engine, at the moment of cancelling.**
   The reference amounts are that shift's own full bill rate and pay cost from
   `LTP_calcDayLabor` when the cancel dialog opens (client-negotiated rate,
   crew minimums, full-margin all honoured) — not the `pay` snapshot locked at
   confirm. The producer picks a percentage or types an amount for each side
   independently; both stay editable until billed/paid. (Owner: rate at
   cancel.)
8. **Defaults are 50% billed / 50% paid**, held in Settings as
   `cancellationDefaultBillPct` / `cancellationDefaultPayPct` and overridable
   per cancellation. (Owner: 50/50.)
9. **A cancelled position bills as its own "Cancellation" line** on the
   document (`rateType: "cancel"`, qty 1, unit price = the chosen bill amount),
   surfaced through the same sync review as any other schedule change. The
   day/half/OT pools exclude cancelled positions. **The client-visible note
   carries the date and the percentage charged**, e.g. "Cancelled Jun 5 · 50%
   of day rate". (Owner: note with percentage.)
10. **Cancellation pay is frozen the way a sign-off is.** Cancelling writes the
    position's `work` snapshot with `state: "cancelled"` and the chosen total,
    so payouts, vendor bills, the paid-day guard and the crew portal pick it up
    through the paths they already have. `adj` still works on top.
11. **Cancellation is not admin-gated.** Any producer can cancel with bill and
    pay shares, edit the shares later, or restore. The paid-day check (a day
    whose vendor bill is already paid) still applies to everyone. Because the
    server today reverts any non-admin change to `work`, this needs a narrow
    server-side allowance — see B2 and *Risks*. (Owner: do not gate.)
12. **Crew email: a new template for cancellation with pay; the existing
    "Request Withdrawn" template when there is no pay.** The new template
    `crewCancelledWithPay` carries `{{shifts}}` and `{{cancellationPay}}`.
    (Owner's choice. Note: an existing `crewCancelled` template — "your
    confirmed position on … has been cancelled" — also exists and is the one
    the tray uses today for a confirmed booking; the plan follows the owner's
    instruction and uses `crewWithdrawn` for the no-pay case. Say so if
    `crewCancelled` was meant.)
13. **Legacy documents get a one-click "Link labor lines to the schedule"
    step; it never appears on documents created after this ships.** No data
    migration. The step is offered only when a document has *no* marked lines
    for the project and *does* have unmarked service lines in a section tagged
    with that project. A hand-added service line on a new-style document is a
    manual line and is never offered for linking. (Owner: yes, legacy only.)
14. **Bulk cancellation stops at the shift.** "Cancel this shift…" applies one
    share pair to every position on a day; there is no project-wide action.
    (Owner: no extra needed.)

## Open questions (two, with the detail the owner asked for)

### A. Sent invoices — recall first, or sync in place?

**How it works today.** The invoice builder locks every edit once an invoice
leaves draft: each mutator returns early unless `status === "draft"`
(`modules/invoices.js:1540-1541`). The way back is **Recall to Draft**
(`invoices.js:1333-1375`): it refuses if any payment is recorded, warns that the
client may already have viewed or printed the sent copy, flips the status to
draft with an activity entry, and — if the invoice was already pushed to
QuickBooks — immediately re-pushes so QuickBooks sees the recalled state. After
editing, **Resend** re-pushes QuickBooks and re-emails the client. The client's
public link always shows the live document.

**Option 1 — recall, sync, resend (recommended).** On a sent invoice the labor
banner reads "Labor changed on the schedule — recall this invoice to sync", with
the Recall button right there. Sync then behaves exactly as on any draft. Pros:
zero new gating logic; the client never sees a sent document change under them
without a fresh send and a fresh activity trail; QuickBooks is updated by the
existing resend path. Cons: two extra clicks; **an invoice with a recorded
payment cannot be recalled**, so it cannot be synced either — the fix for a
partially paid invoice is a separate invoice for the difference (today that is
a manual "Send to Invoice" of the remaining lines, or a hand-built invoice).

**Option 2 — sync directly on a sent invoice.** The review modal is allowed on
sent/partial invoices and Apply edits the document in place, then pushes
QuickBooks on save. Pros: one click. Cons: it breaks the app's standing rule
that a document the client has received never changes underneath them (the
public link would show new totals with no new send); it needs a new exception
inside every invoice mutator; a partially paid invoice would change its balance
silently; and the activity trail would not show a resend.

**Recommendation:** Option 1 now. If partially paid invoices turn out to need
syncing often, a Phase 3 "Invoice the difference" action (a new draft invoice
holding only the delta lines from the review) is the clean answer, and it
builds on the same drift engine.

### B. Line notes in the QuickBooks "in sync" check

**How it works today.** The green "synced" / "Update QuickBooks" state on an
invoice is a comparison of two fingerprints: one computed live from the invoice
(`qbSignature`, `invoices.js:43-75`) and one stored at the last successful push.
The live fingerprint covers dates, notes, discount, project name, the customer's
address, and per line: type, name, qty, effective price and taxable. **It does
not include a line's `notes`** (the "Jun 4, Jun 5, Jun 6" day list on labor
lines). But the push itself sends `name — notes` as the QuickBooks line
description (`backend/qbo_sync.py:1140-1142`).

**Why sync makes it matter.** A schedule change that moves a day without
changing the count — Jun 5 becomes Jun 6, qty stays 1 — changes only the note.
After Apply, the invoice would still read "synced with QuickBooks" while the
QuickBooks line still says Jun 5. Today this can only happen by hand-editing a
note, which is rare; with sync it will be routine.

**The fix and its one side effect.** Adding `notes` to the fingerprint is a
one-line change plus a test. The side effect: every invoice already synced was
fingerprinted *without* notes, so after deploy each would show "Update
QuickBooks" once until re-pushed, even though nothing changed. The plan avoids
that with a small compatibility shim: compute both the new and the old
fingerprint, treat the invoice as in sync if the stored value matches *either*,
and store the new one on the next push. Cost: about ten lines and two test
cases.

**Recommendation:** do it, with the shim, in step A4.

---

## What already exists (reused, not reinvented)

- **One generator for schedule → lines**: `LTP_scheduleLaborSections`
  (`components/domain-crew.js:72-241`) pools each day's per-person units
  (`LTP_calcDayLabor`) into lines keyed `serviceId|tier` (day/half),
  `serviceId` (hourly, OT), and one line per flat-rate position. Re-running it
  on the current schedule is the "expected" side of every diff. Entry points
  are the two Send buttons in `modules/schedule-builder.js:622-788`.
- **Rental-period drift** (`components/domain-docs.js:1105-1221`,
  `modules/quotes-builder.js:2012-2117`): a per-section stamp of what was
  priced, a pure `LTP_staleRentalSections`, a quote-level banner plus
  per-section rows with **Update / Keep**, a list chip
  (`LTPRentalDriftChip`), a toast after the project's dates move
  (`LTP_toastRentalDrift`), stamping on save that deliberately leaves stale
  sections alone, and activity rows via `LTP_quoteChanges`. The labor sync is
  built on the same shape; where this plan says "like rental drift", it means
  copy that code path.
- **Payout drift** (`modules/labor.js:2646-2651, 3126-3145, 3317-3318`): a
  locked `pay` snapshot, a live recompute purely to flag "Changed since lock",
  resolved by an explicit Re-lock. Same principle: never move money on its own.
- **Frozen per-position snapshots** `pay` / `work` / `adj`
  (`components/domain-crew.js:347-551`), read verbatim by
  `backend/payouts.py::derive_payout_drafts` and `LTP_payoutRows`
  (`components/domain-payouts.js:48-161`), exported as vendor bills by
  `backend/qbo_payouts.py`, guarded by the paid-day signature
  (`backend/payouts.py:444-560`, 409 `paid_day_conflict` + override header).
  `adj` already supports labelled, signed amounts that reach the QuickBooks
  bill line and the crew portal.
- **Flat-rate positions** (`fixed_positions`, migration `a6b7c8d9e0f1`) set the
  precedent for a per-position `bill` amount and for a new `rateType`
  (`"flat"`) threaded through `backend/doc_units.py`, both builders'
  `RATE_TYPES`, the PDF and the public view. `"cancel"` follows the same trail.
- **Invoice line provenance** `sourceItemId / sourceQuoteId / linkedQty` and
  the `invoicedQty` rollback in `modules/invoices.js::updateItem / deleteItem /
  save` (1591-1844). Sync on an invoice line that came from a quote must go
  through exactly these rules.
- **Activity**: `{id, date, time, type, user, message, changes:[{cat, detail}]}`
  rendered by `LTPActivityDetail`; `"updated"` is not shown to clients
  (`backend/routes/_shared.py::public_activity`).
- **Crew notices**: the tray + `crewCancelled` / `crewScheduleChanged` email
  templates (`data/settings.js:182-243`, `backend/routes/crew.py:621-628`).
- **Public scrub**: items are cut to `_PUBLIC_ITEM_KEYS` and sections to
  `{id,label,items,customDates,startDate,endDate}`
  (`backend/routes/_shared.py:262-322`), so every marker below stays internal
  with no extra work.

## What is missing today (the gap)

- **No provenance on labor lines.** A generated line is a plain `service` item
  (`{id,type,serviceId,name,rateType,qty,unitPrice,adjustedPrice:null,cost,
  notes,deliveredQty,invoicedQty}`) with no position id, day id, project id or
  "from schedule" marker; only the section carries `projectId`, and appended
  quote→invoice sections carry that too. Code cannot tell a schedule line from
  a hand-added one except by heuristics on `notes` text.
- **Re-sending appends a duplicate section** (`LTP_appendDocSections` is
  deliberately not a merge; test Z6/Z7 in `tests/test_doc_projects.js`).
- **The schedule builder's save never notifies documents**, unlike a project
  date change.
- **No cancelled state.** "Cancel" in Labor → Assignments is a destructive
  reset to `open` with the crew removed (`modules/labor.js:1472-1575`).
  Deleting a shift or position is a hard delete. `pay`/`work`/`adj` are left
  on the reopened position, so **the next person confirmed into that slot
  inherits the previous person's sign-off and adjustments** (`labor.js:2012`,
  `components/schedule-editor.js:181-191`; the server restores them for
  non-admins via `enforce_pay_snapshot`). Fixed in Part B.
- **Every position is billed regardless of status** — `LTP_calcDayLabor` does
  not look at `status`, so a position left on the schedule bills in full.
- **Payouts only count `confirmed`** (`payouts.py:298`, `domain-payouts.js:63`),
  so there is no way to pay someone for work that did not happen, other than
  the no-show + "Kill fee" adjustment that the test fixtures use — which the
  crew portal labels "no show" and which bills the client nothing.
- **Orphan bills**: when every day a crew member had in an exported period is
  unassigned, they vanish from the payout preview and the QuickBooks bill is
  left standing (`backend/routes/qbo.py:825-828`). A cancelled day with a frozen
  `work` keeps them in the preview, so this closes as a side effect.

---

## Part A — Labor sync

### A1. Provenance: the `laborSync` marker

**On every generated line** (item level — survives `cloneDraft`,
`cloneInvoice`, `LTP_quoteToInvoiceDraft` and `LTP_appendDocSections`, all of
which spread items):

```
laborSync: {
  projectId: 12,
  key:  "svc:7|day",        // svc:<serviceId>|<rateType>   pooled day/half/hourly/ot lines
                            // flat:<fixedPositionId>       one flat-rate position
                            // cancel:<positionId>          one cancelled position (Part B)
  at:   "2026-09-22T14:03:00Z",
  snap: { qty: 3, unitPrice: 600, cost: 350, notes: "Jun 4, Jun 5, Jun 6" }
        // what the schedule produced the last time this line was applied or
        // kept. null = the schedule no longer produces this line and the
        // producer chose to keep it anyway.
}
```

The generator writes it (`LTP_scheduleLaborSections` gains the `projectId`
argument; `snap` = the values it just produced). Three things fall out:

- **Manual lines are never touched**: no `laborSync`, not a candidate.
- **Hand edits are visible**: billed `{qty, unitPrice, cost}` ≠ `snap` means
  someone changed the line after the last sync.
- **Schedule drift is visible**: what the generator produces now ≠ `snap`.

**On every section the generator creates** (section level — must be added to
the three section whitelists: `quotes-builder.js:135-143`,
`invoices.js:809-813`, `domain-docs.js:390-391`, exactly as
`pricedStartDate` was):

```
laborSync: {
  projectId: 12,
  grouping: "one" | "dept",   // how the producer chose to split at send time
  dept: "Lighting",            // only when grouping is "dept"
  ignored: { "svc:9|ot": { qty: 4, unitPrice: 90, cost: 45, notes: "Jun 5" } }
           // expected lines the producer chose NOT to add, with the values
           // they declined; a later change to those values re-surfaces them
}
```

`grouping`/`dept` decide where a *new* line lands; `ignored` is the "Keep" memory
for lines that do not exist yet. No new database column, no migration: both
markers live inside the `sections` JSON, like the priced-window stamp. The public
view scrubs both automatically.

*Alternative considered:* a `labor_sync` JSON column on quotes and invoices
keyed by project. Cleaner in theory, but it needs an Alembic migration, a
`_PUBLIC_ENTITY_KEYS` audit and `_rev` care for no functional gain. Rejected.

### A2. The drift engine (pure, `components/domain-labor-sync.js`, new file)

All logic lives in pure `window.LTP_*` helpers so it is Node-testable and shared
by both builders, the list chips, the toast and the send dialog.

- `LTP_laborExpected(project, svcs, crewMins, fmtDate)` → `{ key: line }` —
  runs `LTP_scheduleLaborSections(project.schedule, svcs, crewMins, "one", fmt,
  genId, project.fixedPositions, project.id)` and flattens by key. `svcs` must
  be the **document's** client-resolved rate card (both builders already hold
  it), so a negotiated rate is what gets compared.
- `LTP_laborDrift(doc, project, svcs, crewMins, fmtDate)` →

  ```
  { projectId, count, deltaTotal, changes: [
      { kind: "changed", key, sectionId, itemId, current:{qty,unitPrice,cost,notes},
        expected:{...}, fields:["qty","notes"], delta: +600,
        handEdited: bool, hasAdjustedPrice: bool, linked: bool },
      { kind: "added",   key, sectionId: <home section>, expected:{...}, delta },
      { kind: "removed", key, sectionId, itemId, current:{...}, delta,
        handEdited, hasAdjustedPrice, linked }
  ] }
  ```

  Rules: compare money to the cent and qty to 1e-5 (the app's own rounding);
  a line whose `snap` already equals `expected` is in sync whatever it bills
  (that is what "Keep" means); a key in `ignored` with the same values is
  silent; `removed` is reported for a line whose `snap` is not already `null`.
- `LTP_laborDriftAll(doc, projects, svcs, crewMins, fmt)` — one entry per
  project that has marked lines on the document (multi-project documents).
- `LTP_applyLaborSync(doc, drift, selectedKeys)` → `{ sections, removedLinked }`
  — returns the **same array reference** when nothing is selected (so the
  builder's dirty tracking is not tripped). For each selected change:
  - *changed*: set `qty`, `unitPrice`, `cost`, `notes`; leave `adjustedPrice`,
    `taxable`, `name`, `deliveredQty`; `snap = expected`, `at = now`. On an
    invoice line with `sourceItemId`: `linkedQty = min(newQty, linkedQty)` —
    the rule `updateItem` already applies to a manual edit — so the quote's
    `invoicedQty` is credited back on save, and any qty above `linkedQty`
    counts as a direct bill.
  - *added*: build the line from `expected` with a fresh id, insert into the
    home section at its `LTP_compareLaborLines` position among sibling marked
    lines; create a "Labor — <Project>" section only when no section for the
    project remains. Drop the key from `ignored`.
  - *removed*: delete the line; if it is linked to a quote, return it in
    `removedLinked` so the invoice builder can queue the existing
    `pendingRollbacks` credit.
- `LTP_keepLaborSync(doc, drift, keys)` → `sections` — acknowledges without
  changing what is billed: *changed* → `snap = expected`; *removed* →
  `snap = null`; *added* → `ignored[key] = expected` on the home section.
- `LTP_laborSyncChanges(drift, appliedKeys, keptKeys)` → `[{cat, detail}]` for
  the activity entry, e.g. `{cat: "Labor — L1 Day", detail: "Qty 3 → 4 ·
  Jun 4, Jun 5, Jun 6 → Jun 4 – Jun 7"}`, `{cat: "Labor — L2 OT", detail:
  "Kept (schedule now 0 h)"}`.
- `LTP_laborDriftNotice(project, quotes, invoices, svcs, crewMins, fmt)` →
  `{count, refs, title, message}` for the toast and the project card, counting
  draft/sent quotes and draft invoices with `count > 0`. Like
  `LTP_rentalDriftNotice`.
- `LTP_adoptLaborLines(doc, project, svcs, crewMins, fmt)` → `sections` — for
  legacy documents only: in sections whose `projectId` is the project's, match
  unmarked `service` lines to expected keys by `(serviceId, rateType)`; stamp
  `laborSync` with `snap = the line's current values`, so the very next drift
  pass shows the genuine differences for review. Flat lines match by
  `(serviceId, "flat", unitPrice)`; anything ambiguous stays unmarked and is
  listed as "could not link".
- `LTP_laborLinkable(doc, projectId)` → bool — the visibility rule for the
  Link step (decision 13): true only when the document has **no** line marked
  for the project **and** at least one unmarked `service` line in a section
  tagged with that project. A document created after this ships always has
  marked lines, so it never qualifies; a hand-added service line on such a
  document stays manual.

### A3. Apply / Keep semantics in one table

| Situation | Notice? | Row default | Apply does | Keep does |
|---|---|---|---|---|
| Schedule changed, line untouched by hand | yes | ticked | line ← expected; snap ← expected | snap ← expected (line unchanged) |
| Schedule changed, line **hand-edited** since last sync | yes | **unticked** + flag | same as above (overwrites the hand edit — flagged so it is deliberate) | snap ← expected |
| Schedule changed, line has `adjustedPrice` | yes | ticked, "adjusted price kept" note | qty/unitPrice/cost/notes update; `adjustedPrice` stays | snap ← expected |
| Role no longer on schedule | yes | ticked | line removed (linked lines credit the quote) | snap ← null, line stays |
| New role on schedule | yes | ticked | line inserted in home section | key → `ignored` |
| Schedule unchanged since last Keep | no | — | — | — |
| Line without `laborSync` | never | — | never touched | — |

### A4. Where sync is offered (status gating)

| Document | Draft | Sent | Accepted / converted / partial / paid |
|---|---|---|---|
| Quote | review + apply | review + apply, "Editing Sent Quote" warning | notice hidden (locked, like rental drift `quotes-builder.js:2012-2013`) |
| Invoice | review + apply | hidden; recall first (existing flow) | hidden |

Backend enforces nothing here today (any PUT is accepted); the gate is the
builders' `isLocked` / `isDraft`, same as every other edit.

### A5. UI surfaces

1. **Builder banner** (quote details / invoice header, next to the rental
   notice): `⚠ Labor is out of sync with the Summit Keynote schedule — 3
   changes (+$650)  [Review…] [Keep all]`. One banner per project on
   multi-project documents.
2. **Review modal** (`LTPModal`, wide; modelled on `PayoutExportModal`'s
   per-row preview, `modules/labor.js:2654-2821`): one row per change —
   checkbox · line (`L1 — Lighting Tech · Day`) · what changes (`Qty 3 → 4`,
   `Price $600 → $650`, `Days Jun 4–6 → Jun 4–7`, `New line`, `No longer on
   schedule`) · effect on total · flags (*edited by hand*, *adjusted price
   kept*, *linked to Q-12*). Footer: `Apply 2 selected` / `Keep the rest` /
   `Cancel`. Apply and Keep both go through `setDraft` (a user edit; nothing
   persists until Save, exactly like rental Update/Keep). When
   `LTP_laborLinkable` is true (legacy document, decision 13) the modal opens
   on a **Link labor lines to the schedule** step showing the proposed matches
   and any "could not link" lines; new-style documents never see it.
3. **List chip** `LTPLaborDriftChip` ("Labor changed") on quote and invoice
   rows and the project's document list, like `LTPRentalDriftChip`. Drift for
   a list is computed once per project and memoised (schedules are small; the
   generator is cheap).
4. **Toast after a schedule save** in `modules/schedule-builder.js::doSave`:
   `Labor on Q-12 and INV-7 is now out of sync (4 changes)`, via
   `LTP_laborDriftNotice` — the schedule-side twin of `LTP_toastRentalDrift`.
5. **Send dialog** (`schedule-builder.js:648-654`): target documents that
   already carry this project's marked lines are labelled "already linked —
   opens sync review"; choosing one navigates to the document with the modal
   open. A small "Append as a new section anyway" link keeps today's path.
6. **Invoice generation**: `executeSendToInvoice` (`quotes-builder.js:
   1849-1958`) copies quote lines (marker included). When the new/updated
   invoice opens, the banner shows immediately if the schedule moved after
   acceptance. The quote's send picker also shows a one-line heads-up ("the
   schedule changed since this quote was accepted — you can sync on the
   invoice") so it is not a surprise.

### A6. Invoice specifics

- A line converted from a quote keeps its marker **and** its
  `sourceItemId/sourceQuoteId/linkedQty`; qty changes use the `linkedQty`
  clamp and removals queue the rollback (A2). The activity entry on save
  already reports the credited quote (`invoices.js:1770-1844`).
- Changing `qty`/`unitPrice` flips the QuickBooks signature, so "↻ Update
  QuickBooks" appears by itself. A notes-only change does not — *Open
  question B* covers adding `notes` to `qbSignature` (`invoices.js:43-75`)
  with the compatibility shim so already-synced invoices do not all flip to
  "Update QuickBooks" on deploy.
- A section edit clears `qb_tax_total` on PUT (`api.py:588-596`); the invoice
  shows tax pending until the next push, as with any line edit.

### A7. Activity logging

Apply/Keep appends one `{type: "updated", message: "Labor synced from Summit
Keynote schedule (2 applied, 1 kept)", changes: [...]}` entry at save time,
from `LTP_laborSyncChanges`. `LTP_quoteChanges` / `LTP_invoiceChanges` still
produce their usual per-line Qty/Price rows on the same save, so the trail shows
both the intent and the numbers.

### A8. Data model

No schema change. `backend/models.py` comments for `Quote.sections`,
`Invoice.sections` and the `QuoteLineItem` shape gain the two `laborSync`
shapes above; the `rateType` comment is corrected to
`"day"|"half"|"hourly"|"ot"|"flat"|"cancel"` (the model comment currently says
`halfDay`, which nothing writes).

---

## Part B — Cancelled labor

### B1. The position record

New status value **`cancelled`** on `schedule[].positions[]` and on
`fixed_positions[]`, terminal, keeps `crewId` and `pay`. Added alongside:

```
cancel: {
  at: "2026-09-21T18:40:00Z", by: "Jamie", byId: 4, reason: "",
  ref:  { bill: 600, pay: 350 },                    // this shift's full rate / cost at cancel time
  bill: { mode: "percent" | "amount" | "none", value: 50, total: 300 },
  pay:  { mode: "percent" | "amount" | "none", value: 50, total: 175 }
}
work: { state: "cancelled", signedAt, signedBy,
        pay: { total: 175, tier: "cancel", paidHours: 0, otHours: 0, mealPenaltyHours: 0,
               units: [{ serviceId, tier: "cancel", total: 175, fullMargin, dayCost: 0, otCost: 0 }] } }
```

- `ref` is computed by `LTP_cancelReference(shift, position, svcs, crewMins)`:
  `LTP_calcDayLabor` over that one shift with only that position → the unit's
  `rateTotal` (bill side) and `costTotal` (pay side). One engine, so the
  client-negotiated rate, contract minimums, hourly roles, crew floors and
  full-margin are all already right. A full-margin position has `ref.pay = 0`
  and the pay side is disabled.
- `work` is the payout truth, written by `LTP_cancelPosition(...)` the same way
  `LTP_signOffDay` writes a sign-off; `cancel.pay.total === work.pay.total`
  always. Editing the share later (`LTP_setCancellationPay`) rewrites both.
  `adj` remains available on top ("plus $50 travel already booked").
- A flat-rate position uses the same record with `ref = {bill: p.bill, pay:
  p.fee}` and `work.pay.tier = "flat"` (its "Mark complete" path already
  freezes a producer-chosen amount — `LTP_completeFixedPosition`).
- Positions cancel from any status; `pay`/`work` are only written when a crew
  member is attached. `cancelled` is reachable only through the cancel dialog,
  never through the status dropdown.
- **Restore** (any producer, only while the day is neither on a pushed vendor
  bill nor on a sent document): back to `confirmed`, `cancel` and `work`
  removed, `pay` re-stamped. **Refill role**: adds a new `open` position with
  the same role/service on the shift (a new slot, so OT tracking stays per
  person).

### B2. Payout side

| Where | Change |
|---|---|
| `backend/payouts.py::derive_payout_drafts` (298, 368) and `LTP_payoutRows` (`domain-payouts.js:63, 102`) | include `status == "cancelled"` positions with a crew member; they always carry `work`, so they are "signed" with `payable = work.pay.total + adj`. `_rollup_state` / the JS mirror learn `"cancelled"`. Fixture regenerated (`tests/_gen_payout_fixture.js`) and both parity suites extended. |
| `backend/qbo_payouts.py::build_bill_lines` (302-361) | tier label `cancel → "Cancellation"`; a $0 cancellation goes through the existing zero-settled path. |
| `backend/payouts.py::paid_day_signature` | already covers `status`, `work`, `adj`; cancelling a paid day trips the 409 and the existing override dialog. No change beyond a test. |
| `backend/crew_integrity.py` | `_STATUS_RANK["cancelled"] = 3`; a cancelled position still counts in `_assigned_position_ids` so the crew request keeps its history instead of reading "withdrawn"; `enforce_pay_snapshot` gains two narrow allowances for non-admin writes (decision 11): **(a)** a `work` write is accepted when `work.state === "cancelled"`, the position's incoming status is `cancelled`, a `cancel` record is present, and `work.pay.total` equals `cancel.pay.total` and does not exceed `cancel.ref.pay`; **(b)** `work`/`adj`/`cancel` may be dropped when the position's `crewId` changes, its status returns to `open`, or a cancellation is restored (the stale-snapshot fix, B5). Every other non-admin `work`/`adj` change is still reverted, so sign-off, lock and adjust remain admin-only. The same two allowances apply to `enforce_pay_snapshot_fixed`. |
| `backend/routes/crew_portal.py` | `_UPCOMING_STATUSES` unchanged (a cancelled call is not upcoming); a new "Cancelled" group on the schedule page shows date, role and "Cancellation pay $175" when > 0; earnings already read `work.pay.total`. `modules/crew-portal.js:1073` gains the `"cancelled"` label. |
| Payouts tab (`modules/labor.js:3028-3145`) | row state pill "Cancelled · 50% · $175", an **Edit share…** action opening the same dialog, Restore. These go through a `guardPaidDay` variant of `guardPaid` that keeps the paid-day and "QuickBooks unverified" checks but skips the admin check (decision 11). |

### B3. Bill side

- `LTP_scheduleLaborSections` excludes `status === "cancelled"` positions from
  the per-day `LTP_calcDayLabor` input, and emits one line per cancelled
  position with `cancel.bill.total > 0`:

  ```
  { type: "service", serviceId, name: "L1 — Lighting Tech", rateType: "cancel",
    qty: 1, unitPrice: cancel.bill.total, adjustedPrice: null,
    cost: cancel.pay.total (0 if fullMargin),
    notes: "Cancelled Jun 5 · 50% of day rate",
    laborSync: { projectId, key: "cancel:<positionId>", snap: {...} } }
  ```

  Sorted after OT within the role (`_RATE_TYPE_ORDER.cancel = 5`). A cancelled
  flat-rate position keeps its `flat:<id>` key with the new unit price, so the
  sync review reads "Flat — LD: $2,000 → $1,000 (cancelled)".
- The `"cancel"` rate type follows the `"flat"` trail end to end:
  `backend/doc_units.py` (`"cancellation" / "cancellations"`, shared by the
  PDF and the public `qtyLabel`), `RATE_TYPES` and the locked `<option>` in
  both builders, the `clientRateNote` skip, `LTP_compareLaborLines`,
  `qbo_sync._build_sales_lines` (description already = name — notes). A
  cancellation stays a *service* line so it posts to the role's QuickBooks item
  and labor income account, not to a fee item.
- Schedule-builder totals and head-counts (`schedule-builder.js:416-448`)
  exclude cancelled positions and add cancellation bill/cost as their own row.
- Because the line is produced by the generator, **it reaches the quote or
  invoice only through the Part A review** — the producer sees "L1 Day: qty
  3 → 2" and "+ L1 cancellation $300" side by side and ticks what they want.
  If the client is to be charged in full despite the cancellation, they simply
  keep the day line at 3 and leave the cancellation line unticked (or set
  bill share 100% and let the pool drop).

### B4. UI

- **Cancel dialog** (`LTPModal`, from the Assignments row menu, the schedule
  editor's position row, and the Payouts row): shows the shift, the person,
  `ref` on both sides; two share controls (percent slider/field with an
  amount override, plus "none"); live totals ("Client is charged $300 · Crew
  is paid $175 · Margin $125"); optional reason; the existing "notify crew"
  tray choice, which parks a `crewCancelledWithPay` notice when the pay total
  is above zero and a `crewWithdrawn` notice otherwise (decision 12). Confirm
  writes the record and the schedule-activity entry `{cat: "<Day> — L1
  Cancelled", detail: "Jane Doe · bill 50% $300 · pay 50% $175"}`. Open to
  every producer (decision 11).
- **Schedule builder / calendar / weekly schedule**: cancelled positions render
  struck-through with a "Cancelled" badge, collapsed by default per day; the
  position-count badges exclude them; `LTP_detectCrewConflicts` ignores them
  (`domain-crew.js:837` currently excludes only `declined`).
- **Assignments tab**: a "Cancelled" group at the bottom, with Restore / Edit
  share / Refill role. The existing "cancel" link on a confirmed row becomes
  "Cancel…" → the dialog; "Release quietly" keeps today's reset-to-open path
  for the no-money case.
- **Crew landing page** (`modules/crew-view.js`) badges a cancelled position
  instead of hiding it.

### B5. Fixes taken along the way

- Reassigning or reopening a position strips `pay`, `work`, `adj` and `cancel`
  (`labor.js:1551-1553, 2012`; `schedule-editor.js:181-191`), with the
  server-side allowance in `enforce_pay_snapshot` so a non-admin's reassignment
  is not silently restored. Today the next person inherits the last person's
  sign-off.
- The stale `tests/test_schedule_billing.js` reference in `domain-crew.js:34`
  is corrected to `tests/test_doc_projects.js`.

### B6. Position state machine (additions in bold)

```
open ──send──▶ requested ──accept──▶ accepted ──confirm──▶ confirmed
  ▲               │ decline              │                       │
  │               ▼                      │                       │
  │           declined                   │                       │
  │                                      ▼                       ▼
  └──── release / reopen ◀── (strips pay/work/adj/cancel) ◀──────┤
                                                                 │
                                        **cancel… (dialog)**  ◀──┘  from any status;
                                                 │                  keeps crewId + pay,
                                                 ▼                  writes cancel + work
                                            **cancelled** ── **restore** (any producer, unbilled & unpaid) ──▶ confirmed
                                                 └── **refill role** ──▶ new open position on the same shift
```

---

## Build order and who builds what

Two capability tiers are used on purpose: **Fable** for anything where a subtle
mistake moves money silently or corrupts a frozen snapshot, and **Opus 5** for
surfaces that copy an existing pattern under a written spec and a test that
already fails. Every Opus step names the file it copies from. Fable reviews each
Opus PR against this document before merge.

| # | Step | Who | Size | Depends on |
|---|---|---|---|---|
| 0 | Owner confirms decisions 1–14 (done 2026-09-23) and answers open questions A and B. | owner | — | — |
| A1 | `laborSync` markers: generator gains `projectId`, writes item + section markers; section whitelists ×3; model comments; `tests/test_doc_projects.js` extended (existing scenarios must still pass byte-for-byte on the item fields they assert). | **Fable** | S | 0 |
| A2 | `components/domain-labor-sync.js`: `LTP_laborExpected`, `LTP_laborDrift(All)`, `LTP_applyLaborSync`, `LTP_keepLaborSync`, `LTP_laborSyncChanges`, `LTP_laborDriftNotice`, `LTP_adoptLaborLines`; wired into `index.html`, `sw.js` precache, `CACHE_VERSION` bump; **`tests/test_labor_sync.js`** (no-mutation, same-reference-when-idle, hand-edit detection, adjustedPrice preserved, linked-line clamp, removed-linked rollback list, ignored keys, multi-project, adopt matching, cent/1e-5 rounding). | **Fable** | L | A1 |
| A3 | Quote builder: drift memo, banner, review modal, Apply/Keep through `setDraft`, activity entry on save, legacy "Link" step; golden snapshot scenarios added (`tests/test_builder_render.js --update`). Copy from the rental notice at `quotes-builder.js:966-982, 2487-2500` and `PayoutExportModal`. | **Opus 5** | M | A2 |
| A4 | Invoice builder: same surfaces; removals feed `pendingRollbacks`; sent-invoice banner offers Recall (open question A, option 1); `qbSignature` gains `notes` with the either-fingerprint compatibility shim (open question B) + tests. | **Opus 5** | M | A2, A3 (reuse the modal component) |
| A5 | List chip on quote/invoice rows and the project card; schedule-save toast; send-dialog "already linked → sync review" + "Append anyway". Copy `LTPRentalDriftChip`, `LTP_toastRentalDrift`, `sendDlg`. | **Opus 5** | S | A2 |
| A6 | Invoice-generation heads-up in the quote's send picker. | **Opus 5** | XS | A4 |
| B1 | Cancellation record + engine: `LTP_cancelReference`, `LTP_cancelPosition`, `LTP_setCancellationPay`, `LTP_restorePosition`, flat-rate variants; strip-on-reassign fix; the two non-admin allowances in `enforce_pay_snapshot` / `_fixed` (decision 11) with tests that a non-admin cannot inflate `work.pay.total` past `cancel.ref.pay` or write any other `work`; `crew_integrity` rank/assigned rules; **`tests/test_cancelled_labor.js`** + `tests/test_crew_integrity.py` cases. | **Fable** | M | 0 |
| B2 | Payout integration: `derive_payout_drafts`, `LTP_payoutRows`, `_rollup_state`, `qbo_payouts` tier label, fixture regeneration, parity suites, paid-day-guard test for a cancelled paid day, `crew_portal.py` earnings. | **Fable** | M | B1 |
| B3 | Generator: exclude cancelled from pools, emit `cancel:` lines, `_RATE_TYPE_ORDER`; the `"cancel"` rate-type trail (`doc_units.py`, both builders' `RATE_TYPES`/option/`clientRateNote`, PDF, public view, `qbo_sync`); `test_doc_projects.js`, `test_pdf_qty_label.py`, `test_public_qty_label.py`. Copy the `"flat"` trail from migration `a6b7c8d9e0f1`'s commit. | **Opus 5** | M | B1, A1 |
| B4 | Cancel dialog (open to every producer; `guardPaidDay` keeps the paid-day check) + Assignments "Cancelled" group + Payouts row actions + schedule-builder/calendar rendering and totals + crew landing badge + `LTP_detectCrewConflicts`. Copy the sign-off/adjust dialogs at `labor.js:3365-3424`. | **Opus 5** | L | B1 |
| B5 | Crew portal "Cancelled" group + label; new `crewCancelledWithPay` template in `data/settings.js` with `{{shifts}}` + `{{cancellationPay}}` and its byte-identical `_NOTIFY_FALLBACKS` entry in `backend/routes/crew.py`; tray routing (pay > 0 → new template, else `crewWithdrawn`); Settings `cancellationDefaultBillPct` / `cancellationDefaultPayPct` = 50 in `data/settings.js` + `modules/settings.js`; `tests/test_crew_portal.py` + template round-trip test. | **Opus 5** | S | B1 |
| B6 | "Cancel this shift…" on a schedule day: one share pair applied to every non-cancelled position, each still individually editable. No project-wide action (decision 14). | **Opus 5** | S | B4 |
| C | End-to-end pass with the `verify` skill (Playwright): schedule → quote → change schedule → review → apply/keep → accept → invoice → cancel a shift → sync invoice → payout preview shows the cancellation; docs updated; `docs/LABOR_SYNC_PLAN.md` build-order ticks. | **Fable** | M | all |

Suggested sequencing: A1 → A2 and B1 in parallel (Fable), then A3/A4/A5 and
B3/B4/B5 in parallel (Opus, two branches), B2 (Fable) alongside, then C.

## Verification

- **Node suites** (run by the session-start hook and CI): new
  `tests/test_labor_sync.js`, `tests/test_cancelled_labor.js`; extended
  `test_doc_projects.js`, `test_fixed_positions.js`, `test_payout_parity.js`,
  `test_doc_changes.js`, `test_money_totals.js` (a `cancel` line totals like
  any service line), `test_quote_to_invoice.js` (marker survives conversion).
- **Golden render**: `tests/test_builder_render.js` gains "labor out of sync",
  "labor synced and kept", "cancelled position on document" scenarios.
- **pytest**: `test_payout_bills.py` / `test_qbo_payout_bills.py` (cancelled
  day → "Cancellation" bill line; $0 cancellation → zero-settled),
  `test_paid_day_guard.py` (cancel on a paid day → 409, override passes),
  `test_crew_integrity.py` (cancelled keeps the request; reassignment strips
  snapshots), `test_crew_portal.py` (cancelled group, earnings),
  `test_pdf_qty_label.py` / `test_public_qty_label.py` (`cancellation`).
- **Shell guard**: `tests/check_shell_version.py` — every served-file change
  bumps `CACHE_VERSION`.
- **Manual**: the `verify` skill flow in step C, on a copy of a real project.

## Risks and how the plan handles them

- **Overwriting a deliberate under-charge.** Hand-edited rows default to
  unticked and are flagged; Keep records the decision so the notice stops
  nagging.
- **Double-billing labor on re-send.** The send dialog routes an
  already-linked target to the review; "Append anyway" is explicit.
- **Rounding drift between JS and Python.** Nothing new is computed on the
  server for Part A; Part B's payout numbers are frozen client-side into
  `work.pay.total` exactly as sign-offs are, and the parity suites cover the
  new state.
- **A cancelled position's pay reaching a paid bill.** Same protection as any
  other change to a paid day: the signature includes `status`/`work`, so the
  409 + override fires.
- **Silent marker loss.** The three section whitelists are the only places a
  section key can vanish; A1 adds `laborSync` to all three and the test suite
  asserts round-trips through `cloneDraft`, `cloneInvoice` and
  `LTP_quoteToInvoiceDraft`.
- **Performance of list chips.** One generator run per project per render,
  memoised on `(project.updatedAt, services, clientRates)`; schedules are tens
  of rows.
- **Un-gated cancellation pay (decision 11).** Today the server reverts any
  non-admin change to a position's frozen `work`, because that number is
  billed verbatim on a vendor bill. Opening cancellation to every producer
  means a non-admin can put a payable amount on a day without an admin's
  hand. Three things keep that bounded: the server accepts a non-admin `work`
  only for a cancellation and only up to the shift's full cost (`cancel.ref.
  pay`), never for a sign-off, lock or adjustment; the vendor-bill export and
  its per-person preview remain admin-only, so an admin sees every cancelled
  day and its amount before any bill is pushed; and the schedule activity
  entry names who cancelled and the shares chosen. The reference itself is
  client-computed (the labor engine has no Python port), so the cap is a
  ceiling on the share, not a server recomputation of the rate.

## Assumptions (flag if wrong)

- The client-negotiated rate card resolved by the **document's** client is the
  right "expected" price; a document billed to a contact rather than the
  project's company is not a sync target (schedule sends already refuse those).
- Sync never renames a line (`name`) even if the rate-card description changed.
- A cancelled position never returns to the day/half pool unless restored.
- Cancellation shares are per position; the whole-shift action just applies one
  pair to each position and each stays individually editable.
- `deliveredQty` on a quote line is left alone by sync; the producer marks
  delivery as today.
- Every producer may cancel with bill/pay shares (decision 11); the vendor-bill
  export itself stays admin-only, as today.
- The no-pay cancellation email really is meant to be the existing "Request
  Withdrawn" template rather than the existing "Position Cancellation" one
  (decision 12 note).
