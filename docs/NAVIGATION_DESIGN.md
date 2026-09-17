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

## Remaining work (for the next session)

1. **List state via `LTP_useNavState`** (decision 4): `projects.js:33-37`,
   `quotes-list.js:22-27`, `invoices.js:82-88`, `crm-shell.js:31-38`,
   `rentals-containers.js:486-489`, the Labor tab lists. Mechanical swap.
2. **Deleted / missing entity on a seeded or stale route**: when a module
   finds no record for `route.id` (e.g. `rentals-shell.js` `openEq === null`,
   `projects.js` "This project was deleted"), call
   `window.LTPRouter.replace(parentOf(route))` from an effect so the URL does
   not sit on a dead id. Not yet done.
3. **`quotes-builder.js` convert → invoice** still pushes inside a 100 ms
   `setTimeout`; drop the timeout.
4. **`sw.js` `notificationclick`**: prefer a *controlled* client whose URL is
   a staff route before falling back to the first window (audit repro 11).
5. **`rentals-shell.js` `goList()`** and `calendar.js:16` still call
   `nav(list)`; check their callers and switch to `goBack` if they close.
6. **Runtime verification** with the repo's `verify` skill (Playwright): the
   acceptance matrix below. Unit tests cover the history mechanics only.

## Acceptance matrix

| # | Case | Automated | Manual |
|---|---|---|---|
| 1 | Cold load of each deep route walks up to area root, then home | unit: seeding chains | Android PWA gesture-back |
| 2 | A → B → C, Back returns C → B → A | unit: stamping | — |
| 3 | Cross-area link, Back returns to origin | unit: push + goBack | invoice → linked quote → Back |
| 4 | Create / edit-save / delete never return to form or dead item | unit: replace / goBack | each builder and modal |
| 5 | Tab change does not add entries | unit: goTab peers | sidebar, More sheet, portal tabs |
| 6 | Modal: Back closes it only | — | Playwright: open detail, `page.goBack()`, modal gone, list scroll kept |
| 7 | Deep link while signed out: after login, no sign-in entry | unit: return-to | Playwright with forged session |
| 8 | Reload mid-session preserves Back | unit: reload keeps stamp | — |
| 9 | Installed PWA Android (gesture) and iOS (in-app control) | — | device |
| 10 | No double render / fetch / flash while seeding | — | Playwright: count `/api/` requests on cold load of a deep route |

## Known limitations

- Gesture/browser Back out of a dirty builder does not prompt (decision 5).
- A notification tapped while the app is open navigates that window without a
  stamp; from there `goBack()` uses the declared parent, not the previous
  screen.
- Entries created before this deploy in an already-open tab are foreign until
  the next cold load.
