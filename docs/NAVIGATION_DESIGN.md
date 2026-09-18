# Navigation & Back — Design, Handoff and Change Log

Approved design (Phase 1) and the state of the implementation (Phase 2).
The audit that motivated it is `docs/NAVIGATION_AUDIT.md`.

## Goal

Back always moves exactly one logical step toward where the user came from.
With no in-app history it goes to the screen's declared parent. It never lands
in an unrelated area and never exits the app from a deep screen.

## Approved decisions

1. **Sibling tabs are peers with parent `dashboard`.** Back from
   `rentals/kits` or `labor/payouts` goes home, not to another tab.
   **Exception:** the three full-screen editors go back to their list:
   `quotes/new|:id → quotes`, `invoices/new|:id → invoices`,
   `projects/:id/schedule → projects`.
2. **Save and delete step back** (`goBack()`), never a plain replace: the form
   or the deleted item becomes a forward-only entry and no duplicate list
   entry is created. **Create** is the one replace: `…/new → …/:newId`.
3. **Crew portal is in scope** (tabs, auth screens, one-time links).
4. **List filters, sort, search and scroll are remembered per history entry**
   and restored on Back, without moving them into the URL.
5. **Hardware / browser Back is never intercepted.** A dirty builder left by
   gesture-back is not prompted; documented limitation.

## Modules

| File | Owns |
|---|---|
| `router.js` | Parsing (unchanged). `navigate` (push), `replace`, `goBack`, `seed`, `hasInAppPrev`, `entryKey`, `onLeave`. Stamps every entry it writes with `history.state.ltp = { sid, idx }`. |
| `nav-registry.js` | `parentOf`, `chainFor`, `canonical`, `isPeer`/`goTab`, `stashReturnTo`/`consumeReturnTo`, `seedIfCold`, per-entry state store, `restoreScroll`, `LTP_useNavState` hook. |
| `app.js` | The navigation effect (canonicalise → seed → restore scroll), `#ltp-content` scroller id, shell nav via `goTab`, sign-in stash. |
| `tests/test_nav_history.js` | 125 assertions against a browser-faithful fake history (push truncates forward, back fires popstate then hashchange, state travels with the entry, per-tab sessionStorage). |

### In-app history detection

`sid` lives in `sessionStorage["ltp.nav.sid"]`: same across a reload, new on
a fresh tab or PWA launch. `idx` is the entry's depth within the session. An
entry with no matching stamp is *foreign* (URL, bookmark, notification,
pre-app). `hasInAppPrev()` is `stamp present && idx > 0`. `document.referrer`
is never consulted.

### Seeding

`seedIfCold()` runs from the staff shell's route effect once auth has resolved
(so a signed-out deep link seeds after login, not before) and at crew-portal
mount. It is a no-op when the entry is already stamped, and never runs on
`view/*` or `crew/<token>`. It replaces the current entry with the root of the
chain and pushes each descendant synchronously, firing one `hashchange` at the
end: React renders the target once; ancestors never mount or fetch.

### Return-to after login

The hash never reaches the server (`/auth/callback` → `/`). `stashReturnTo()`
records the current hash in `sessionStorage["ltp.nav.returnTo"]` before every
hop to `/auth/login` (sign-in button, the 401 guards in `data-state.js` and
`live-sync.js`). On the next cold boot `seedIfCold()` consumes it, replaces
`/` → the requested route and seeds. The sign-in entry never survives.

### `goBack()`

```
if (unsaved && !confirm) return
if (hasInAppPrev())  history.back()
else                 replace(parentOf(current) ?? "dashboard")
```

## Push / replace rules and how to write them

| Action | Call |
|---|---|
| Drill into a detail / builder, cross-area link | `nav(path)` (push) |
| Open a URL-bound modal (`/new`, `/:id`, `/:id/edit`, `/:id/scan`) | `nav(path)` (push) |
| Close a modal from its UI (✕, backdrop, Cancel) | `window.LTPRouter.goBack` |
| Any in-app Back control | `window.LTPRouter.goBack` |
| Tab / sub-nav / sidebar / bottom-nav / More-sheet | `window.LTP_NAV_REGISTRY.goTab(path)` (replace between peers, push when entering the area) |
| Create saved (`/new` → `/:newId`) | `window.LTPRouter.replace(path)` |
| Edit saved, delete | `window.LTPRouter.goBack()` |
| Redirect, guard, canonicalisation | `window.LTPRouter.replace(path)` |
| Convert quote → invoice, schedule → quote/invoice | `nav(path)` (push; the source still exists) |
| Close-then-open elsewhere (chip in a modal that opens another record) | just open: `nav(other)` (push). Never `goBack()` followed by `nav()` — the queued `history.back()` would race the push. |

### Registering a route

Add its parent to `nav-registry.js`: a new tab goes into `TABS[module].subs`;
a new module root into `PLAIN_ROOTS`; anything with a new shape gets a line in
`parentOf`. Add the expected parent (and chain, if deep) to
`tests/test_nav_history.js`. Ambiguous hierarchy → ask; do not derive it from
the URL string.

### Remembering list state

Replace `useState(initial)` with `window.LTP_useNavState("filter", initial)`
for filter, sort, search and show-completed state. Scroll is automatic for
anything inside `#ltp-content`.

## Route added after the original audit

`#/rentals/<id>` — an equipment item opened from the **Availability Checker**
(the bare `rentals` tab). It exists because `#/rentals/equipment/<id>` names the
Equipment List's tab: opening an item from the checker on that URL swapped the
checker out for a list the user never asked for, behind the popup, and threw
away the dates, category and search the checker was set to. The two URLs now
mean "this item, opened from the checker" and "this item, opened from the
Equipment List", and each keeps its own tab behind the popup. Back from either
returns to the tab it was opened from.

The router needed no change: a bare numeric segment already parses into `id`
with no `sub`. `parentOf` already resolved it to `rentals`, because the bare
module path is a declared tab. Edit and Scan from a checker-opened item push to
their Equipment List routes and Back returns to the checker item.

## Change log (call sites)

Every changed line and its rule. Line numbers are post-change.

**Shell / infrastructure**
- `router.js` — rewritten below `parsePath`: stamped `navigate`/`replace`, `goBack`, `seed`, `onLeave`; bare-load redirect is now a replace.
- `nav-registry.js` — new.
- `index.html` — loads `nav-registry.js` after `router.js`.
- `sw.js` — `CACHE_VERSION` v104, `/nav-registry.js` precached.
- `app.js` sign-in anchor — `stashReturnTo()` on click (return-to).
- `app.js` `LTPSignedInApp` — navigation effect (canonicalise by replace; seed; restore scroll); `default:` case no longer pushes in render.
- `app.js` content div — `id="ltp-content"`.
- `app.js` sidebar module + 4 sub-nav lists, bottom tabs, More sheet — `goTab` (tab rule).
- `components/data-state.js` ×2, `components/live-sync.js` ×1 — `stashReturnTo()` before the 401 hop.
- `tests/test_crew_portal_routes.js` — shim reflects `replaceState` into `location.hash`; bare-load expectations now `#/…`.

**CRM** — `crm-shell.js`: `setSelectedCompanyId(null)` / `setEditContactId(null)` / `setEditCompanyId(null)` → `goBack` (close); `switchTab` → `goTab`; two add-form `onClose` → `goBack`; create ×2 → `replace`; edit-save → `goBack`; delete ×4 → `goBack`. `crm-contacts.js`: edit `onClose` → `goBack`, edit-save → `goBack`, company chip no longer closes first. `crm-companies.js`: contact row, project row and vendor order link no longer close first (push only).

**Projects** — `projects.js`: `setSelectedProjectId(null)` → `goBack`; `setEditProjectId(null)` → `goBack`; add-form `onClose` → `goBack`; create → `replace`; edit-save → `goBack`; delete ×2 → `goBack`.

**Rentals** — `rentals-shell.js`: 13 `onClose` → `goBack`; create ×4 → `replace`; edit-save ×4 → `goBack`; delete ×4 → `goBack`.

**Quotes / Invoices / Schedule** — `quotes-builder.js`: Back button → `goBack`; first save → `replace`; delete → `goBack`. `invoices.js`: same three. `schedule-builder.js`: both Back buttons → `goBack`. `quotes-shell.js`: tabs → `goTab`.

**Crew portal** — `crew-portal.js`: tabs → `goTab`; `signedIn`/`signedOut` → `replace`; `seedIfCold()` at mount.

## Verification

`tests/test_nav_history.js` — 125 assertions, no deps, runs in CI. Covers the
parent table, chains, canonicalisation, peers, stamping, seeding, reload,
fresh launch, return-to, per-entry state and the unsaved guard against a
browser-faithful fake history.

`tests/test_static_allowlist.py` — every root-level script `index.html` loads
is servable by the backend and precached by the service worker. See the
white-screen note below for why this exists.

`tests/manual/verify-navigation.js` — 40 assertions in a real Chromium against
a running server, covering the matrix below. Not in the automatic suites (it
needs a server, a forged session and the `playwright` package); the recipe is
in `.claude/skills/verify/SKILL.md`. Last run: **40 passed, 0 failed**, plus a
crew-portal and share-view smoke pass with no page errors.

### What the browser caught that the unit suites could not

`/nav-registry.js` was added to `index.html` and to the service worker's
precache list, but not to `_ALLOWED_TOP_LEVEL_FILES` in `backend/main.py`.
That allowlist is deny-by-default, so the request fell through to the SPA
catch-all and the file was served **as `index.html` with `text/html`**. With
`nosniff` and a strict CSP the browser refused to execute it, leaving
`window.LTP_NAV_REGISTRY` undefined — and since `app.js` reads it on every
render, the app was a **white screen on every route**, signed in or out. Every
JS suite passed throughout, because they load files from disk and never ask
the server for them. `tests/test_static_allowlist.py` now fails on exactly
this, and was confirmed to fail against the broken tree before the fix.

Anyone adding a root-level boot file must add it in three places: the
`<script>` tag, `_ALLOWED_TOP_LEVEL_FILES`, and `sw.js`'s precache list.

## Acceptance matrix

| # | Case | Result |
|---|---|---|
| 1 | Cold load of a deep route walks up the declared hierarchy to the area root, then home | passes (CRM 3-deep, rentals, schedule editor) |
| 2 | A → B → C, Back returns C → B → A exactly | passes |
| 3 | Cross-area link, Back returns to the originating screen | passes (rentals → CRM → Back lands in rentals) |
| 4 | Create / edit-save / delete never return to the form or a dead item | passes; the create form entry is replaced, not stacked |
| 5 | Tab change adds no history entry and Back leaves the area | passes |
| 6 | Modal with URL state: Back closes it only | passes (backdrop gone, list intact) |
| 7 | Deep link while signed out: after login, no sign-in entry | unit-tested (return-to stash); not yet driven through real Google OAuth |
| 8 | Reload mid-session preserves Back | passes |
| 9 | Installed PWA on Android (gesture back) and iOS (in-app control) | **still needs a device** |
| 10 | No double render, fetch or flash while seeding | passes: zero duplicated API requests, and exactly one `hashchange`, so React is handed the route once and no ancestor renders |
| — | A dead record id never strands the user | passes for quotes, invoices, CRM and rentals; an unknown route canonicalises home |
| — | Crew portal deep tab and auth screen seed; public share view is never seeded | passes, no page errors |

## Known limitations

- Gesture/browser Back out of a dirty builder does not prompt (decision 5).
- A notification tapped while the app is open navigates that window without a
  stamp; from there `goBack()` uses the declared parent, not the previous
  screen.
- Entries created before this deploy in an already-open tab are foreign until
  the next cold load.
- Signing in to the crew portal always lands on its overview, so a crew member
  who opened an emailed link to a specific tab while signed out does not return
  to that tab. Unchanged by this work, but now visible because the portal seeds.
- Acceptance case 9 (installed PWA on a real Android and iOS device) has not
  been run. Everything it covers is exercised in desktop Chromium, but the
  gesture-back and no-browser-chrome cases are genuinely device-specific.
