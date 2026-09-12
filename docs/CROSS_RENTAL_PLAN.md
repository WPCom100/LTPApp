# Cross Rentals — Design & Build Plan

**Branch:** `claude/vigilant-hawking-wq2ylo`
**Goal:** Let the Rentals module track gear rented **from a vendor** (a
"cross rental") to cover what we don't stock or don't have free on the dates —
with **per-vendor pricing remembered** so the next time we can see who to call
and what they charged — and have that gear **count as inventory for the rental
period** once it is confirmed, without having to tie it to one project.

Status: **built on this branch** (steps 1–6 below, plus the bookings engine the owner asked for in question 8). The README sections "Cross rentals & vendor pricing" and "Bookings (allocations)" are the user-facing description; this document is the design record.

## Decisions (confirmed with owner)

1. **Cross rentals are orders.** One order per vendor with many lines (the
   fixtures, and the parts and accessories that come with them), because that
   is what a vendor PO looks like. An order may later carry the vendor's
   documents and a cost-vs-rented-for view (§7).
2. **Quoted is not inventory; confirmed is.** Like a quote, a cross rental the
   vendor has only quoted or is holding does not change availability. It is
   **flagged as quoted** wherever availability is shown, so nobody re-sources
   gear that is already spoken for. Confirmed and picked-up orders count.
3. **Owned and cross-rented stack.** An item we own can be cross-rented on top
   of our stock; an item we never stock can exist as a catalog row with zero
   owned. Availability is always owned + confirmed cross-rented.
4. **QuickBooks: not yet.** Cost is recorded in the app only.

Defaults taken where nothing was said: vendor pricing uses the same
3-day / week / month tiers as our own rates plus a per-line flat override;
a cross rental counts toward a date range only when it covers the whole range;
any member can edit, like the rest of Rentals.

## What already exists (reused, not reinvented)

- **Vendors are companies.** `Company.is_vendor` is an independent flag, the
  CRM list filters by it, and the rentals module already derives
  `vendors = companies.filter(isVendor)` and hands it to a shared typeahead
  (`LTP_RENTALS.VendorSearch`, with inline "create this vendor" via
  `LTPEntityQuickAction`). The order form picks a vendor with exactly that
  control.
- **Equipment rates** are `{threeDay, week, month}` and one engine prices a
  date range against them: `calcRentalPrice` in `modules/quotes-builder.js`
  (months, then cheapest of weeks vs 3-day blocks). Vendor pricing uses the
  same shape so the same engine costs an order line.
- **Availability** is one pair of helpers in `modules/rentals-utils.js`:
  `eqQty(eq)` (rentable stock, net of maintenance) and
  `allocatedQty(allocations, id, start, end)` (units booked on overlapping
  dates). Three surfaces consume them — the Availability Checker, the quote
  picker, and the equipment detail popup — and `tests/test_quote_availability.py`
  guards that nobody re-implements them inline. Cross rentals add a **supply**
  term beside `eqQty`; every consumer picks it up through the same seam.
- **Child rows live in JSON on the parent.** Quote line items are
  `Quote.sections[].items[]`, kit contents are `Kit.items`, serialized units are
  `Equipment.units`. Order lines follow that pattern (`CrossRental.lines`), so
  an order and its lines save atomically, carry one `_rev`, and need one entity.
- **Per-company rate memory** already has a precedent: `client_rates` is one
  row per (client, service) with an editor on the company screen
  (`components/client-rates.js`). Vendor rental rates mirror it on the cost
  side: one row per (vendor, equipment item).
- **Entity plumbing** is generic: a model + `_crud_routes` registration + a
  validator rule set + a live-sync collection + an `ENTITY_KEYS` entry + a
  `data/*.js` fallback + a `usePersistentState` hook in `app.js`. Two new
  collections follow that checklist verbatim (`kits` is the template).

**Worth knowing (owner asked for the explanation — see the reply on the
branch):** nothing in the UI creates `allocations` today. The model, the
validator and the availability math exist, the seed file is empty, and no
form has written one since the first commit — the rentals shell only reads
them and deletes them with their equipment. So the "booked on a project"
half of availability only moves if a booking is POSTed to `/api/allocations`
by hand. This plan adds the supply side (cross rentals) and leaves demand
alone; recording bookings from quotes is a separate decision (§7).

## 1. Data model (`backend/models.py` + one Alembic revision)

### `vendor_rates` — what a vendor charges us for an item (the price memory)

One row per (vendor company × equipment item). Saving an order writes or
refreshes these rows; the CRM vendor screen edits them directly.

| column | type | notes |
|---|---|---|
| `id` | Integer PK | client-assigned like every other entity |
| `vendor_company_id` | FK companies, **CASCADE**, indexed | the vendor |
| `equipment_id` | FK equipment, **CASCADE**, indexed | our catalog item this price is for |
| `rates` | JSON `{threeDay, week, month}` | per unit, what the vendor charges **us**; same shape as `Equipment.rates` so `calcRentalPrice` applies unchanged |
| `vendor_item` | String(255) | what the vendor calls it / their SKU, so the PO reads right |
| `quoted_date` | String(10) ISO | when this price was last confirmed — shows as "quoted Mar 2026" so a stale price looks stale |
| `preferred` | Boolean | pins this vendor first in the options list for the item |
| `active` | Boolean, default True | park a price without losing it (`ClientRate.active`) |
| `notes` | Text | "min 3-day charge", "they deliver", … |
| `created_at` / `updated_at` | DateTime | |

Both FKs CASCADE (the `ClientRate` rule): a price for a vendor that no longer
exists, or an item we no longer catalog, matches nobody forever.

### `cross_rentals` — one **order** from one vendor, with its lines

| column | type | notes |
|---|---|---|
| `id` | Integer PK | |
| `vendor_company_id` | FK companies, **SET NULL**, indexed | who we rented from — SET NULL so deleting the vendor keeps the cost record |
| `reference` | String(100) | vendor PO / quote / confirmation number |
| `status` | String(20) | `quoted` → `confirmed` → `picked-up` → `returned`, or `cancelled` (§4) |
| `start_date` / `end_date` | String(10) ISO | the order's rental period; every line uses it unless the line sets its own |
| `project_id` | FK projects, **SET NULL**, nullable, indexed | **optional** — an order spanning several jobs simply leaves it empty |
| `lines` | JSON, see below | the items and parts on the order |
| `remember_rates` | Boolean, default True | on save, upsert `vendor_rates` for every line that names a catalog item (§5a) |
| `notes` | Text | |
| `created_at` / `updated_at` | DateTime | |

```
lines: list[{
  id: str,                       // genId("crl"), stable across edits
  equipmentId: int | null,       // catalog item → counts toward availability;
                                 // null → a part/accessory (cable, clamp, lamp): cost only
  name: str,                     // auto from the equipment, or free text for a part
  qty: int,
  startDate: str, endDate: str,  // "" = inherit the order's dates
  rates: {threeDay, week, month},// price SNAPSHOT — seeded from vendor_rates, editable;
                                 // a later price change never rewrites history
  costOverride: float | null,    // negotiated flat total for the line; null = compute
  notes: str
}]
```

Per-line dates cover a PO whose parts return on different days; per-line
status is deliberately *not* modelled in this pass (an order is quoted,
confirmed, picked up and returned as a whole — partial returns go in `notes`
and can become a per-line field later without a migration, since lines are
JSON).

### `equipment.cross_rental_only` — gear we never stock

A new Boolean (default `False`). A catalog row is the anchor for quoting
(quote lines carry `equipmentId` and our client-facing `rates`) and for
availability, so an item we only ever cross-rent still needs a row — with
`qty = 0`, non-serialized, and this flag set so the inventory list labels it
**Cross-rental** instead of showing a 0-unit item as "available", and the stock
totals skip it. The flag changes labels only: an **owned** item is cross-rented
exactly the same way, and an item flagged today can be un-flagged and given a
qty the day we buy some.

### Migration

One additive, reversible revision `d9e0f1a2b3c4` (down_revision
`c8d9e0f1a2b3`, the current head): create both tables with their indexes, add
the equipment column. Idempotent create/add (the pattern the last three
revisions use) so a database already carrying the objects heals to head.
Applied by `init_db()` on boot as usual.

## 2. Backend (`backend/routes/api.py`, `validators.py`, `livesync.py`)

- `_crud_routes(router, "vendor-rates",  models.VendorRate,  has_activity=False)`
- `_crud_routes(router, "cross-rentals", models.CrossRental, has_activity=False)`
  Hyphenated paths, matching the frontend state keys (the `client-rates`
  convention). FK columns are existence-checked by `_validate_fks` already.
- Validators: new enum `cross_rental_status`; rules — `startDate` / `endDate`
  ISO, `status` enum, `reference` cap, `vendorItem` cap, `quotedDate` ISO; the
  JSON container checks (`lines` must be a list, `rates` a dict) derive from
  the models automatically. Line contents are not validated server-side, the
  same as quote items — readers guard per element.
- Live sync: both collections join `_COLLECTION_MODELS` so every open window
  refreshes when an order is confirmed (availability changes under a quote
  someone else is building — exactly the case the feed exists for).
- Deletes: equipment delete cascades `vendor_rates` in the DB; on the frontend
  `deleteEquipment` also clears `equipmentId` on any order line that named the
  item (the line stays as a cost record with its name, the way a deleted vendor
  leaves the order intact) and drops the local price rows. Company delete
  cascades `vendor_rates` and nulls the vendor on orders; the CRM delete wizard
  gets a line for "N vendor prices · M cross-rental orders" so the teardown
  review stays complete.

No new endpoints beyond the generic CRUD; pricing and availability math stay
on the frontend, same as today.

## 3. Shared helpers (`modules/rentals-utils.js`)

- **`calcRentalPrice` moves here** from `quotes-builder.js` (exported as
  `R.calcRentalPrice`; the builder calls it). Load order already has
  `rentals-utils.js` before the quote builder. Same function, same tests, one
  home for pricing a date range — now used for revenue *and* cost.
- **`lineDates(order, line)`** → the line's own dates or the order's.
- **`crossRentedQty(crossRentals, equipmentId, startDate, endDate)`** — units
  supplied for the range: lines with that `equipmentId` on orders whose status
  is `confirmed` or `picked-up` **and whose effective dates cover the whole
  range** (`start <= startDate && end >= endDate`). Covering-only is
  deliberately conservative and matches the existing overlap heuristic on the
  demand side: `allocatedQty` counts any overlapping booking against the whole
  range, so supply should only count when it is good for the whole range. A
  per-day engine (min over days) is a later refinement if the heuristic bites.
- **`crossQuotedQty(crossRentals, equipmentId, startDate, endDate)`** — the
  same sum over `quoted` orders. Never added to availability; drives the
  **quoted** flag (§5d).
- **`totalQty(eq, crossRentals, start, end)`** = `eqQty(eq)` +
  `crossRentedQty(...)`. Every availability consumer switches from `eqQty` to
  this for ranged checks; `eqQty` stays the "owned, rentable" figure.
- **`vendorOptions(vendorRates, companies, equipmentId, start, end)`** — the
  item's active vendor prices, costed for the range with `calcRentalPrice`,
  preferred first then cheapest. Feeds the "who can we get this from" hints.
- **`lineCost(order, line)`** = `costOverride ?? calcRentalPrice(dates, rates).totalPrice × qty`;
  **`orderCost(order)`** sums it.

## 4. Status model (order level)

```
quoted      vendor quoted / is holding it — the default   NOT inventory; shown as "quoted"
confirmed   PO placed / confirmed                          counts as inventory
picked-up   physically with us                             counts as inventory
returned    back at the vendor                             does not count
cancelled   never happened                                 does not count
```

Transitions are a select, like allocation states. Status never changes on its
own — no date-driven auto-flip; an order past its end date that is still
`picked-up` shows as **overdue** in the list instead.

## 5. Frontend

### 5a. Rentals → **Cross Rentals** tab (new `modules/rentals-cross.js`)

Routes, in the shell's existing pattern:

```
#/rentals/cross-rentals             orders list
#/rentals/cross-rentals/new         new order (accepts ?equipmentId=&start=&end=&vendorId= prefill)
#/rentals/cross-rentals/:id         order detail popup
#/rentals/cross-rentals/:id/edit    edit order
```

Sub-nav entry in both `app.js` lists (sidebar + phone), title in the shell's
`titleMap`, FAB on the phone.

**Orders list.** Desktop `LTPTable` / phone `LTPList` like the inventory list.
Columns: Vendor · Reference · Items (line count, first two names) · Dates ·
Status · Cost · Project. Sorted by start date; filters for status (default
hides returned and cancelled), vendor, and a date range that defaults to
"next 30 days + anything currently out". Overdue chip as above.

**Order form** (create/edit; `LTP_useRecordWatch` guarded like the other
forms):

| field | control | behaviour |
|---|---|---|
| Vendor | `R.VendorSearch` (+ inline create) | changing it re-seeds every line's rates from that vendor's price rows |
| Reference / PO | text | |
| Dates | two `LTPDateField`s + the 3-day / week / month presets | the order period |
| Status | select | default `quoted` |
| Project | project search (optional, clearable) | hides internal + completed projects, like the doc pickers |
| **Lines** | editable rows | see below |
| Remember prices | checkbox, default **on** | on save, upsert the vendor's `vendor_rates` row for every line with a catalog item — rates + today's `quoted_date` |
| Notes | text | |

Each **line**: Item (an `LTPSearchSelect` over the catalog, showing owned qty,
or **"Part / accessory"** to type a free-text name with no catalog link) ·
Qty · 3-Day / Week / Month (prefilled from the vendor's price row; a
`RATE ON FILE` chip while unchanged, "quoted <date>" under it) · Cost
(computed breakdown label such as "2× Wk + 1× 3-Day", × qty; an **override
total** field replaces it) · optional own dates · notes. Order total at the
foot. Lines reorder with the same `sortable.js` engine the quote builder uses.

**Order detail popup.** Header (vendor · reference · dates · status badge ·
project), the lines with their costs and the order total, the vendor's other
prices for each item (so you can see you didn't overpay), Edit / Delete.

### 5b. Vendor price list on the company (CRM → company → **Rental Rates**)

Shown when `company.isVendor`, beside the existing Service Rates block. An
editor in the `ClientRatesEditor` style: rows of item · 3-day / week / month ·
vendor item · quoted date · preferred · active · notes, add / edit / pause /
remove. Below it, **Cross-rental orders from this vendor** — newest first, with
the year's spend total (useful when negotiating).

### 5c. Equipment surfaces

- **Detail popup → Overview:** a fifth stat tile **Cross-rented** (confirmed
  units on cross rental today, with "+N quoted" under it when relevant), a
  **Vendor pricing** list (every vendor's rate for the item, preferred first,
  with "quoted <date>", and an **Add price** row), and a **Cross rentals** list
  (current + upcoming orders naming this item) under the existing "Currently
  Out" block. Each row opens the order.
- **Form:** a **Cross-rental only** toggle ("we don't stock this — always rented
  in"). When on, the qty / serialized / location / purchase-vendor fields hide
  and qty saves as 0. Off is the normal owned item, which can still be
  cross-rented.
- **Inventory list:** `cross_rental_only` items show a **cross-rental** chip in
  the Status column instead of available/partial and are left out of the
  "total units" figure; the Units column reads "—".

### 5d. Availability everywhere

- **Availability Checker:** total for the range becomes `totalQty(...)`; the
  row reads `avail / total` as now, with an "incl. N cross-rented · Vendor"
  chip when a confirmed order contributes, and a distinct **"N quoted · Vendor"**
  chip when a quoted order covers the range (not counted). When `avail <= 0`
  and the item has vendor prices, a **Cross-rent** line lists the options
  ("PRG $420/wk · 4Wall $450/wk") with a **+ Cross rental** button that opens
  the order form prefilled with the item, the checker's dates and the chosen
  vendor.
- **Quote builder picker:** `getAvailability` switches to `totalQty` (the
  structural guard in `test_quote_availability.py` is updated to require it),
  and the row shows the same quoted flag. The shortage hint appears under an
  item with 0 available, opening the order form in a stacked modal so the draft
  is not abandoned. A line added for a `cross_rental_only` item still prices at
  **our** `eq.rates` — the vendor's price is cost, never what the client sees.
- **Invoice builder picker:** already shows the 3-day rate only, no
  availability; unchanged apart from listing `cross_rental_only` items.
- **Equipment detail "Remaining" tile** adds today's confirmed cross-rented
  units.

### 5e. Plumbing checklist (the `kits` template)

`data/vendor-rates.js` + `data/cross-rentals.js` (empty arrays) · two
`<script>` tags in `index.html` (data + the new module, after
`rentals-equipment.js` and before `rentals-shell.js`) · `ENTITY_KEYS` in
`components/data-state.js` · two `usePersistentState` hooks in `app.js`, in
`allReady`, passed to `RentalsView`, `CRMView` and `QuotesView` · global search
entries for orders (vendor + reference + item names) · `sw.js`
`CACHE_VERSION` bump (`ltp-shell-v90`; the shell-version CI guard requires it).

## 6. Tests & verification

- **JS (new `tests/test_rentals_cross.js`, pure Node like `test_rentals_scan.js`):**
  `crossRentedQty` (status filter — quoted excluded, covering-vs-overlapping
  ranges, per-line date override, qty sums, part lines with no `equipmentId`
  ignored, other items excluded), `crossQuotedQty`, `totalQty` composition,
  `vendorOptions` ordering (preferred → cheapest, inactive skipped),
  `lineCost` / `orderCost` (override wins, qty multiplies), and
  `calcRentalPrice` regression cases after the move. Structural guards: the
  checker, the quote picker and the equipment detail call the canonical
  helpers; `quotes-builder.js` no longer defines its own `calcRentalPrice`.
- **Python:** extend `tests/test_quote_availability.py` with a port of
  `crossRentedQty` + the updated structural guard. New
  `tests/test_cross_rentals.py`: migration applies on a fresh DB; CRUD round
  trips for both entities including a `lines` list; 400s for a bad status, a
  malformed date, a non-list `lines`, and a vendor/equipment id that doesn't
  exist; equipment delete cascades prices; company delete cascades prices and
  nulls the vendor on an order; `/api/versions` carries both collections.
- **Shell guard:** `python tests/check_shell_version.py origin/master` passes.
- **Runtime:** the `verify` skill (Playwright): create a vendor, price an item,
  add a quoted order and confirm the checker shows it as quoted but not
  counted; confirm the order and see both the checker and the quote picker
  count it for the covered range and not outside it.
- Full existing suites stay green (`node tests/test_*.js`, `python -m pytest tests -q`).

## 7. Planned next, not in this pass

Each is designed so nothing built now has to change.

- **Vendor documents on an order** (the quote, the PO, the invoice). Wants a
  binary table keyed by order id, the way `pdf_archive` stores generated PDFs
  as `LargeBinary` with a size cap and a download route — not base64 inside
  the order JSON, which would bloat every list fetch. The order's `reference`
  already gives a document its name.
- **Cost vs rented-for on the order.** Cost is `orderCost` today. "Rented for"
  needs a rule for what to compare against; two candidates, either or both:
  (a) when the order is linked to a project, the equipment lines for the same
  items on that project's invoices (actual billing); (b) our list price for the
  same items and period via `calcRentalPrice(eq.rates)` (what we *would* bill).
  Margin = rented-for − cost. Owner to pick; (b) works even for unlinked
  orders, (a) is the real number.
- **QuickBooks vendor bills** for cross rentals — the app already exports crew
  payouts as QB Bills; Company would need a `qb_vendor_id` like Contact has.
- **Recording bookings (allocations).** No screen creates them today. The
  natural place is quote acceptance / invoice conversion writing one
  allocation per equipment line for the document's dates, plus a small
  Allocations tab to adjust state (reserved → checked-out → returned). Until
  something like this exists, "on rental" stays at zero everywhere.
- **Cost on the quote line.** Equipment lines already carry a `cost` field
  (always 0 today); feeding the vendor price into it for margin is small once
  pricing memory exists.
- **Per-day availability** if covering-only counting under-reports in practice.

## 8. Build order

1. **Model + migration + backend** — both tables, the equipment flag, validators,
   CRUD registration, live sync, backend tests.
2. **Plumbing + helpers** — state hooks, data fallbacks, index.html, app.js
   props, `calcRentalPrice` move, the new helpers with their JS tests, cache bump.
3. **Cross Rentals tab** — orders list, order form with lines and rate memory on
   save, detail, routes, sub-nav.
4. **Vendor pricing surfaces** — CRM company Rental Rates editor + order
   history, equipment detail vendor pricing + cross-rental lists, the
   cross-rental-only toggle and inventory chip.
5. **Availability integration** — checker, quote picker, detail tiles, the
   quoted flag, shortage hints with the prefilled "+ Cross rental" shortcut.
6. **Docs + verification** — README section ("Cross rentals & vendor pricing",
   in the style of "Client service rates"), runtime pass, shell guard.

Each step lands as its own commit on the branch so a step can be reviewed or
reverted alone.
