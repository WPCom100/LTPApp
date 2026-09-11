# Cross Rentals — Design & Build Plan

**Branch:** `claude/vigilant-hawking-wq2ylo`
**Goal:** Let the Rentals module track gear rented **from a vendor** (a
"cross rental") to cover what we don't stock or don't have free on the dates —
with **per-vendor pricing remembered** so the next time we can see who to call
and what they charged — and have that gear **count as inventory for the rental
period**, without having to tie it to one project.

Status: **draft for review — nothing built yet.** Open questions are at the
end; each carries a recommended default so "go with the defaults" is a
complete answer.

## What already exists (reused, not reinvented)

- **Vendors are companies.** `Company.is_vendor` is an independent flag, the
  CRM list filters by it, and the rentals module already derives
  `vendors = companies.filter(isVendor)` and hands it to a shared typeahead
  (`LTP_RENTALS.VendorSearch`, with inline "create this vendor" via
  `LTPEntityQuickAction`). The cross-rental form picks a vendor with exactly
  that control.
- **Equipment rates** are `{threeDay, week, month}` and one engine prices a
  date range against them: `calcRentalPrice` in `modules/quotes-builder.js`
  (months, then cheapest of weeks vs 3-day blocks). Vendor pricing uses the
  same shape so the same engine costs a cross rental.
- **Availability** is one pair of helpers in `modules/rentals-utils.js`:
  `eqQty(eq)` (rentable stock, net of maintenance) and
  `allocatedQty(allocations, id, start, end)` (units booked on overlapping
  dates). Three surfaces consume them — the Availability Checker, the quote
  picker, and the equipment detail popup — and `tests/test_quote_availability.py`
  guards that nobody re-implements them inline. Cross rentals add a **supply**
  term beside `eqQty`; every consumer picks it up through the same seam.
- **Per-company rate memory** already has a precedent: `client_rates` is one
  row per (client, service) with an editor on the company screen
  (`components/client-rates.js`). Vendor rental rates mirror it on the cost
  side: one row per (vendor, equipment item).
- **Entity plumbing** is generic: a model + `_crud_routes` registration + a
  validator rule set + a live-sync collection + an `ENTITY_KEYS` entry + a
  `data/*.js` fallback + a `usePersistentState` hook in `app.js`. Two new
  collections follow that checklist verbatim (`kits` is the template).

**Worth knowing before we start:** nothing in the UI creates `allocations`
today — the model, the validator and the availability math exist, the seed file
is empty, and no form writes one. "Availability because of rentals" is
therefore only as good as whatever puts allocations in the table. This plan
adds supply from cross rentals; it does not change how demand (allocations)
gets recorded. See open question 8.

## 1. Data model (`backend/models.py` + one Alembic revision)

### `vendor_rates` — what a vendor charges us for an item (the price memory)

One row per (vendor company × equipment item). Adding a cross rental writes or
refreshes this row; the CRM vendor screen edits it directly.

| column | type | notes |
|---|---|---|
| `id` | Integer PK | client-assigned like every other entity |
| `vendor_company_id` | FK companies, **CASCADE**, indexed | the vendor |
| `equipment_id` | FK equipment, **CASCADE**, indexed | our catalog item this price is for |
| `rates` | JSON `{threeDay, week, month}` | per unit, what the vendor charges **us**; same shape as `Equipment.rates` so `calcRentalPrice` applies unchanged |
| `vendor_item` | String(255) | what the vendor calls it / their SKU, so the PO reads right |
| `quoted_date` | String(10) ISO | when this price was last confirmed — surfaces as "quoted Mar 2026" so a stale price is visibly stale |
| `preferred` | Boolean | pins this vendor first in the options list for the item |
| `active` | Boolean, default True | park a price without losing it (same idea as `ClientRate.active`) |
| `notes` | Text | "min 3-day charge", "they deliver", … |
| `created_at` / `updated_at` | DateTime | |

Both FKs CASCADE (the `ClientRate` rule): a price for a vendor that no longer
exists, or an item we no longer catalog, matches nobody forever.

### `cross_rentals` — one item rented from one vendor for one date range

| column | type | notes |
|---|---|---|
| `id` | Integer PK | |
| `vendor_company_id` | FK companies, **SET NULL**, indexed | who we rented from — SET NULL so deleting the vendor keeps the cost record |
| `equipment_id` | FK equipment, **CASCADE**, indexed | which catalog item the units count as |
| `qty` | Integer | units rented |
| `start_date` / `end_date` | String(10) ISO | the period the units count as ours |
| `status` | String(20) | `hold` → `confirmed` → `picked-up` → `returned`, or `cancelled` (see §4) |
| `rates` | JSON `{threeDay, week, month}` | the price **snapshot** for this rental — seeded from the vendor's rate row, editable; a later price change never rewrites history |
| `cost_override` | Float, nullable | a negotiated flat total for the line; null = compute from `rates` × dates × qty |
| `project_id` | FK projects, **SET NULL**, nullable, indexed | **optional** — a rental spanning several jobs simply leaves it empty |
| `reference` | String(100) | vendor PO / quote / confirmation number; the same reference on several rows groups them into one order in the list |
| `notes` | Text | |
| `created_at` / `updated_at` | DateTime | |

### `equipment.cross_rental_only` — gear we never stock

A new Boolean (default `False`). A catalog row is the anchor for quoting
(quote lines carry `equipmentId` and our client-facing `rates`) and for
availability, so an item we only ever cross-rent still needs a row — with
`qty = 0`, non-serialized, and this flag set so the inventory list labels it
**Cross-rental** instead of showing a 0-unit item as "available", and the stock
totals skip it.

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
- Validators: new enum `cross_rental_status`; rules — `qty` non-negative,
  `startDate` / `endDate` ISO, `status` enum, string caps, `costOverride`
  non-negative; the JSON container checks derive from the models automatically.
- Live sync: both collections join `_COLLECTION_MODELS` so every open window
  refreshes when a cross rental is added (availability changes under a quote
  someone else is building — that is exactly the case the feed exists for).
- Deletes: equipment delete cascades both tables in the DB; the frontend
  `deleteEquipment` also drops the local rows the way it already drops
  allocations. Company delete cascades `vendor_rates` and nulls the vendor on
  `cross_rentals`; the CRM delete wizard gets a line item for "N vendor prices
  · M cross rentals" so the teardown review stays complete.

No new endpoints beyond the generic CRUD; all pricing and availability math is
frontend, same as today.

## 3. Shared helpers (`modules/rentals-utils.js`)

- **`calcRentalPrice` moves here** from `quotes-builder.js` (exported as
  `R.calcRentalPrice`; the builder calls it). Load order already has
  `rentals-utils.js` before the quote builder. Same function, same tests, one
  home for pricing a date range — now used for revenue *and* cost.
- **`crossRentedQty(crossRentals, equipmentId, startDate, endDate)`** — units
  supplied by cross rentals for the range. Counts rows whose status is
  `hold`, `confirmed` or `picked-up` **and whose dates cover the whole
  range** (`start_date <= startDate && end_date >= endDate`). Covering-only is
  deliberately conservative and matches the existing overlap heuristic on the
  demand side: `allocatedQty` counts any overlapping booking against the whole
  range, so supply should only count when it is good for the whole range. A
  per-day engine (min over days) is a later refinement if the heuristic bites.
- **`totalQty(eq, crossRentals, start, end)`** = `eqQty(eq)` +
  `crossRentedQty(...)`. Every availability consumer switches from `eqQty` to
  this for ranged checks; `eqQty` stays the "owned, rentable" figure.
- **`vendorOptions(vendorRates, companies, equipmentId, start, end)`** — the
  item's active vendor prices, costed for the range with `calcRentalPrice`,
  preferred first then cheapest. Feeds the "who can we get this from" hints.
- **`crossRentalCost(cr)`** = `costOverride ?? calcRentalPrice(start, end, rates).totalPrice × qty`.

## 4. Status model

```
hold        vendor is holding it for us (verbal / quote stage)   counts as inventory
confirmed   PO placed / confirmed                                 counts as inventory
picked-up   physically with us                                    counts as inventory
returned    back at the vendor                                    does not count
cancelled   never happened                                        does not count
```

Transitions are free-form (a select), like allocation states. Status never
changes on its own — no date-driven auto-flip; a rental past its end date that
is still `picked-up` shows as **overdue** in the list instead.

## 5. Frontend

### 5a. Rentals → **Cross Rentals** tab (new `modules/rentals-cross.js`)

Routes, in the shell's existing pattern:

```
#/rentals/cross-rentals             list
#/rentals/cross-rentals/new         add form (accepts ?equipmentId=&start=&end=&vendorId= prefill)
#/rentals/cross-rentals/:id         detail popup
#/rentals/cross-rentals/:id/edit    edit form
```

Sub-nav entry in both `app.js` lists (sidebar + phone), title in the shell's
`titleMap`, FAB on the phone.

**List.** Desktop `LTPTable` / phone `LTPList` like the inventory list. Columns:
Item · Vendor · Qty · Dates · Status · Cost · Project/Ref. Sorted by start date;
filters for status (default hides returned/cancelled), vendor, and a date range
that defaults to "next 30 days + anything currently out". Rows past their end
date and not returned get an **overdue** chip. Rows sharing a `reference` show
it as a group label.

**Form** (create/edit; `LTP_useRecordWatch` guarded like the other forms):

| field | control | behaviour |
|---|---|---|
| Vendor | `R.VendorSearch` (+ inline create) | changing it re-seeds the rates from that vendor's price row for the item, if one exists |
| Item | `LTPSearchSelect` over the catalog | shows owned qty + `cross_rental_only` items; a "not in the catalog yet" link opens the equipment form |
| Qty | number | |
| Dates | two `LTPDateField`s + the 3-day / week / month presets | |
| Status | select | default `hold` |
| Vendor rates | 3-Day / Week / Month inputs | prefilled from the price row, editable; a `RATE ON FILE` chip when unchanged, `quoted <date>` under it |
| Cost | computed read-out + "override total" field | `calcRentalPrice` breakdown label ("2× Wk + 1× 3-Day"), × qty; override replaces it |
| Remember this price | checkbox, default **on** | on save, upserts the vendor's `vendor_rates` row for this item with these rates and today's `quoted_date` |
| Project | project search (optional, clearable) | hides internal + completed projects, like the doc pickers |
| Reference / PO, Notes | text | |

**Detail popup.** Header (item · vendor · qty · dates · status badge), cost
breakdown, the vendor's other prices for this item (so you can see you didn't
overpay), link to the item and the project, Edit / Delete.

### 5b. Vendor price list on the company (CRM → company → **Rental Rates**)

Shown when `company.isVendor`, beside the existing Service Rates block. An
editor in the `ClientRatesEditor` style: rows of item · 3-day / week / month ·
vendor item · quoted date · preferred · active · notes, add / edit / pause /
remove. Below it, **Cross rentals from this vendor** — the vendor's rows from
`cross_rentals`, newest first, with totals for the year (what we've spent with
them; useful when negotiating).

### 5c. Equipment surfaces

- **Detail popup → Overview:** a fifth stat tile **Cross-rented** (units on
  cross rental today), a **Vendor pricing** list (every vendor's rate for the
  item, preferred first, with "quoted <date>", and an **Add price** row), and a
  **Cross rentals** list (current + upcoming) under the existing "Currently
  Out" block. Each list row opens the cross rental.
- **Form:** a **Cross-rental only** toggle ("we don't stock this — always rented
  in"). When on, the qty / serialized / location / purchase-vendor fields hide
  and qty saves as 0.
- **Inventory list:** `cross_rental_only` items show a **cross-rental** chip in
  the Status column instead of available/partial and are left out of the
  "total units" figure; the Units column reads "—".

### 5d. Availability everywhere

- **Availability Checker:** total for the range becomes `totalQty(...)`; the
  row reads `avail / total` as now, with a small "incl. N cross-rented ·
  Vendor" chip when cross rentals contribute. When `avail <= 0` and the item
  has vendor prices, a **Cross-rent** line lists the options ("PRG $420/wk ·
  4Wall $450/wk") with a **+ Cross rental** button that opens the form prefilled
  with the item, the checker's dates and the chosen vendor.
- **Quote builder picker:** `getAvailability` switches to `totalQty` (the
  structural guard in `test_quote_availability.py` is updated to require it).
  The same shortage hint appears under an item with 0 available, opening the
  cross-rental form in a stacked modal so the draft is not abandoned. A line
  added for a `cross_rental_only` item still prices at **our** `eq.rates` — the
  vendor's price is cost, never what the client sees.
- **Invoice builder picker:** already shows the 3-day rate only, no
  availability; unchanged apart from listing `cross_rental_only` items.
- **Equipment detail "Remaining" tile** adds today's cross-rented units.

### 5e. Plumbing checklist (the `kits` template)

`data/vendor-rates.js` + `data/cross-rentals.js` (empty arrays) · two
`<script>` tags in `index.html` (data + the new module, after
`rentals-equipment.js` and before `rentals-shell.js`) · `ENTITY_KEYS` in
`components/data-state.js` · two `usePersistentState` hooks in `app.js`, in
`allReady`, passed to `RentalsView`, `CRMView` and `QuotesView` · global search
entries for cross rentals (vendor + item) · `sw.js` `CACHE_VERSION` bump
(`ltp-shell-v90`; the shell-version CI guard requires it).

## 6. What is deliberately **not** in this pass

- **QuickBooks vendor bills.** A cross rental is a cost we will pay; the app
  already exports crew payouts as QB Bills. Wiring cross rentals into that is a
  contained follow-up (Company would need a `qb_vendor_id` like Contact has).
  This pass records the cost; it does not post it. (Open question 6.)
- **Cost on the quote line.** Equipment lines already carry a `cost` field
  (always 0 today). Feeding the vendor price into it for margin would be a
  small follow-up once pricing memory exists.
- **Per-day availability.** Covering-only counting (§3) first; refine if it
  under-reports in practice.
- **Recording demand.** No new way to create allocations (see the note in
  "What already exists").

## 7. Tests & verification

- **JS (new `tests/test_rentals_cross.js`, pure Node like `test_rentals_scan.js`):**
  `crossRentedQty` (status filter, covering-vs-overlapping ranges, qty sums,
  excludes other items), `totalQty` composition, `vendorOptions` ordering
  (preferred → cheapest, inactive skipped), `crossRentalCost` (override wins,
  qty multiplies), and `calcRentalPrice` regression cases after the move.
  Structural guards: the checker, the quote picker and the equipment detail
  call the canonical helpers; `quotes-builder.js` no longer defines its own
  `calcRentalPrice`.
- **Python:** extend `tests/test_quote_availability.py` with a port of
  `crossRentedQty` + the updated structural guard. New
  `tests/test_cross_rentals.py`: migration applies on a fresh DB; CRUD round
  trips for both entities; 400s for a bad status, negative qty, malformed
  date, and a vendor/equipment id that doesn't exist; equipment delete
  cascades both tables; company delete cascades prices and nulls the vendor on
  a cross rental; `/api/versions` carries both collections.
- **Shell guard:** `python tests/check_shell_version.py origin/master` passes.
- **Runtime:** the `verify` skill (Playwright): create a vendor, price an item,
  add a cross rental, and confirm the Availability Checker and the quote picker
  both show the added units for the covered range and not outside it.
- Full existing suites stay green (`node tests/test_*.js`, `python -m pytest tests -q`).

## 8. Build order

1. **Model + migration + backend** — both tables, the equipment flag, validators,
   CRUD registration, live sync, backend tests.
2. **Plumbing + helpers** — state hooks, data fallbacks, index.html, app.js
   props, `calcRentalPrice` move, the new helpers with their JS tests, cache bump.
3. **Cross Rentals tab** — list, form (with rate memory on save), detail, routes,
   sub-nav.
4. **Vendor pricing surfaces** — CRM company Rental Rates editor + history,
   equipment detail vendor pricing + cross-rental lists, the cross-rental-only
   toggle and inventory chip.
5. **Availability integration** — checker, quote picker, detail tiles, shortage
   hints with the prefilled "+ Cross rental" shortcut.
6. **Docs + verification** — README section ("Cross rentals & vendor pricing",
   in the style of "Client service rates"), runtime pass, shell guard.

Each step lands as its own commit on the branch so a step can be reviewed or
reverted alone.

## Open questions (each with the default I'd build)

1. **One row per item, or an order with lines?** Default: **one row per item ×
   date range**, with the vendor's PO / reference number grouping rows in the
   list. It matches the flat entity pattern everywhere else and keeps
   availability math per item. An order header can be added later if you want
   one PO document per vendor.
2. **Do holds count as inventory?** Default: **yes** — `hold`, `confirmed` and
   `picked-up` all count; the checker chip says which. If you'd rather only
   confirmed gear counts, that is a one-line change in `crossRentedQty`.
3. **Gear you never stock as a catalog row with 0 owned + a "cross-rental only"
   flag.** Default: **yes**. It is what lets the item be quoted at your rate and
   checked for availability like everything else.
4. **Vendor pricing tiers.** Default: **the same 3-day / week / month** as your
   own rates, plus a per-rental flat total override for negotiated deals. If
   vendors routinely quote a daily rate, say so and I'll add a `day` tier to the
   vendor side only.
5. **Counting rule for partial coverage.** Default: a cross rental counts
   toward a date range only when it **covers the whole range** (conservative,
   consistent with how bookings are counted). Fine?
6. **QuickBooks.** Default: **not in this pass** — cost is recorded in the app
   only. Tell me if you want vendor Bills pushed for cross rentals and I'll
   plan it as step 7.
7. **Who edits.** Default: **any member**, like equipment and allocations
   (Settings-style admin gating would be unusual for a rentals record).
8. **Allocations.** Nothing creates them today, so the "not available because
   of rentals" half of availability only works if bookings are entered through
   the API. Out of scope here unless you want it — but worth a separate task if
   you expected the app to already be recording bookings.
