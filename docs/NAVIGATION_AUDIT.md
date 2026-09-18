# Navigation & Back-Button Audit (Phase 0)

Discovery only. No code changed. Every claim below is anchored to a
`file:line` in the tree as of commit `0b3a8cc` (merge of PR #89).

## 1. Router

| Item | Finding |
|---|---|
| Library | **None.** A hand-written hash router, `router.js` (≈180 lines), exposed as `window.LTPRouter`. No React Router, no history package. React 18.2 UMD from cdnjs, no build step. |
| URL scheme | `#/module[/sub][/id][/action][?query]`. Parsed by `parsePath` (`router.js:67`). Three special modules (`view`, `crew`, `crew-portal`) get their own parse branches because their third segment is an opaque token. |
| API | `getRoute()`, `navigate(path)` (`router.js:152`: unsaved-changes confirm, then `window.location.hash = "/" + path` → **always a push**), `replace(path)` (`router.js:160`: `history.replaceState` + synthetic `hashchange`), `useRoute()` hook (`router.js:166`: subscribes to `hashchange`). |
| Bare-load redirect | `router.js:180`: if the hash is empty, `window.location.hash = "/dashboard"` (or `/crew-portal` on the crew host, via `<meta name="ltp-default-route">`). **This is a push**, so `/` stays under `#/dashboard` in history. |
| Nesting / layouts | No nested route tree. `app.js:17` (`LTPApp`) branches on `route.module`: public modules bypass auth; otherwise `LTPSignedInApp` (`app.js:148`) renders a shell and `renderModule()` (`app.js:434`) switches on `route.module` to one module component per area, passing `route` as a prop. Each module derives its own sub-screen (list / detail modal / form modal / full-screen builder) from `route.sub`, `route.id`, `route.action` — e.g. `crm-shell.js:16-25`, `rentals-shell.js:34-58`, `quotes-shell.js:24-39`, `projects.js:17-25`, `invoices.js:2584`, `labor.js:3913`. |
| Unknown module | `app.js:482`: `default: nav("dashboard")` — a **push, executed during render**. |
| `history.state` | Never written or read anywhere. No `popstate` listener anywhere. No `history.scrollRestoration` setting. |
| Other `hashchange` listeners | `components/error-toasts.js:265` (retires route-scoped toasts). Harmless. |

## 2. Route inventory

"Parent" = what the current code and sidebar nesting imply, not a declaration.
"Direct URL" = the screen renders correctly on a cold load of that hash.
All staff routes sit behind the auth gate (`app.js:66-71`).

### Staff app (authenticated)

| Path pattern | Screen / component | Current implied parent | Direct URL |
|---|---|---|---|
| `#/` (bare) | redirected → `#/dashboard` (push, `router.js:180`) | — | yes |
| `#/dashboard` | `DashboardView` (`modules/dashboard.js`) | none (home) | yes |
| `#/crm` | `CRMView` companies list (`sub` defaults to `companies`, `crm-shell.js:16`) | dashboard | yes |
| `#/crm/companies` | `CRMView` companies list | dashboard | yes |
| `#/crm/companies/new` | `CRMCompanyForm` modal over list (`crm-shell.js:353`) | crm/companies | yes |
| `#/crm/companies/:id` | `CRMCompanyDetail` modal over list (`crm-shell.js:351`) | crm/companies | yes |
| `#/crm/companies/:id/edit` | `CRMCompanyForm` modal (`crm-shell.js:361`) | crm/companies/:id | yes |
| `#/crm/contacts` | `CRMView` contacts list (sibling tab) | dashboard | yes |
| `#/crm/contacts/new` | `CRMContactForm` modal (`crm-shell.js:368`) | crm/contacts | yes |
| `#/crm/contacts/:id` | `CRMContactDetail` modal (`crm-contacts.js:6`) | crm/contacts | yes |
| `#/crm/contacts/:id/edit` | `CRMContactForm` rendered by `CRMContactDetail` (`crm-contacts.js:14`) | crm/contacts/:id | yes |
| `#/projects` | `ProjectsView` list (`modules/projects.js`) | dashboard | yes |
| `#/projects/new` | `CRMProjectForm` modal (`projects.js:389`) | projects | yes |
| `#/projects/:id` | `CRMProjectDetail` modal, Overview tab (`projects.js:387`, `crm-projects.js:103`) | projects | yes |
| `#/projects/:id/(overview\|notes\|meetings\|budget\|quotes)` | same modal opened on that tab (`projects.js:20-21`); in-modal tab clicks do **not** change the URL (`crm-projects.js:60-64`) | projects/:id | yes |
| `#/projects/:id/edit` | `CRMProjectForm` modal (`projects.js:397`) | projects/:id | yes |
| `#/projects/:id/schedule` | `ScheduleBuilder` **full screen** (`projects.js:68-95`); hides topbar + bottom nav (`app.js:489-491`) | projects/:id | yes |
| `#/calendar` | `CalendarView` (`modules/calendar.js`) | dashboard | yes |
| `#/rentals` | `RentalsView` Availability Checker tab (`rentals-shell.js:38`) | dashboard | yes |
| `#/rentals/equipment` | equipment list tab | rentals (sibling tab) | yes |
| `#/rentals/equipment/new` | `RentalsEquipmentForm` modal (`rentals-shell.js:334`) | rentals/equipment | yes |
| `#/rentals/equipment/:id` | `RentalsEquipmentDetail` modal (`rentals-shell.js:295`) | rentals/equipment | yes |
| `#/rentals/equipment/:id/edit` | `RentalsEquipmentForm` modal (`rentals-shell.js:341`) | rentals/equipment/:id | yes |
| `#/rentals/equipment/:id/scan` | `RentalsScanSession` modal (`rentals-shell.js:313`) | rentals/equipment/:id | yes |
| `#/rentals/containers` | containers list tab | rentals (sibling tab) | yes |
| `#/rentals/containers/new` | `RentalsContainerForm` modal (`rentals-shell.js:348`) | rentals/containers | yes |
| `#/rentals/containers/:id` | `RentalsContainerDetail` modal (`rentals-shell.js:321`) | rentals/containers | yes |
| `#/rentals/containers/:id/edit` | `RentalsContainerForm` modal (`rentals-shell.js:353`) | rentals/containers/:id | yes |
| `#/rentals/kits` | kits list tab | rentals (sibling tab) | yes |
| `#/rentals/kits/new` | `RentalsKitForm` modal (`rentals-shell.js:368`) | rentals/kits | yes |
| `#/rentals/kits/:id` | `RentalsKitDetail` modal (`rentals-shell.js:360`) | rentals/kits | yes |
| `#/rentals/kits/:id/edit` | `RentalsKitForm` modal (`rentals-shell.js:375`) | rentals/kits/:id | yes |
| `#/rentals/cross-rentals` | cross-rentals list tab | rentals (sibling tab) | yes |
| `#/rentals/cross-rentals/new[?equipmentId&start&end&vendorId&qty]` | `RentalsCrossForm` modal, prefilled from query (`rentals-shell.js:63-69`, `:392`) | rentals/cross-rentals | yes |
| `#/rentals/cross-rentals/:id` | `RentalsCrossDetail` modal (`rentals-shell.js:382`) | rentals/cross-rentals | yes |
| `#/rentals/cross-rentals/:id/edit` | `RentalsCrossForm` modal (`rentals-shell.js:399`) | rentals/cross-rentals/:id | yes |
| `#/quotes` | `QuotesList` (`quotes-shell.js:95`) | dashboard | yes |
| `#/quotes/new` | `QuotesBuilder` **full screen** (`quotes-shell.js:65`) | quotes | yes |
| `#/quotes/:id` | `QuotesBuilder` full screen | quotes | yes |
| `#/quotes/products` | `QuotesProducts` tab | quotes (sibling tab) | yes |
| `#/quotes/services` | `QuotesServices` tab | quotes (sibling tab) | yes |
| `#/quotes/fees` | `QuotesFees` tab | quotes (sibling tab) | yes |
| `#/quotes/client-rates` | `QuotesClientRates` tab | quotes (sibling tab) | yes |
| `#/invoices` | invoice list (`invoices.js:2582`) | dashboard | yes |
| `#/invoices/new` | `InvoiceBuilder` **full screen** (`invoices.js:2587`) | invoices | yes |
| `#/invoices/:id` | `InvoiceBuilder` full screen | invoices | yes |
| `#/labor` | `LaborView` Assignments tab (`labor.js:3913`) | dashboard | yes |
| `#/labor/(assignments\|requests\|roster\|calendar\|schedule\|payouts)` | `LaborView` tab; everything inside a tab (crew detail, payout detail, request detail) is **local state, not URL** (`labor.js:536`, `:1244`, `:2658`; 16 `LTPModal` uses) | labor (sibling tab) | yes |
| `#/settings[?qbo=connected\|error\|realm_mismatch]` | `SettingsView`, admin only (`app.js:479-481`); the `qbo` query is written by `backend/routes/qbo.py:94-137` and **never read** (SettingsView receives no `route`) | dashboard | yes (admins) |
| anything else | `nav("dashboard")` push during render (`app.js:482`) | — | — |

### Public surfaces (outside the auth gate, `app.js:48-64`)

| Path pattern | Screen / component | Current implied parent | Direct URL |
|---|---|---|---|
| `#/view/quote/:token[?preview=1][&r=]` | `LTPClientView` (`modules/client-view.js`) | none (standalone) | yes (only way in) |
| `#/view/invoice/:token[...]` | `LTPClientView` | none | yes |
| `#/crew/:token` | `LTPCrewView` call sheet (`modules/crew-view.js`) | none | yes |
| `#/crew-portal` | portal root → login or overview (`crew-portal.js:1229-1287`) | none | yes |
| `#/crew-portal/login` | `LoginScreen` | crew-portal | yes |
| `#/crew-portal/forgot`, `/request-access` | `EmailScreen` | crew-portal/login | yes |
| `#/crew-portal/signup/:token`, `/reset/:token` | `TokenScreen` (one-time) | crew-portal/login | yes |
| `#/crew-portal/confirm-email/:token` | `EmailConfirmScreen` | crew-portal/account | yes |
| `#/crew-portal/(overview\|schedule\|payouts\|account)` | `Portal` tabs (`crew-portal.js:540`) | crew-portal/overview (sibling tabs) | yes (signed in) |
| `#/crew-portal/login?next=…` | parsed (`tests/test_crew_portal_routes.js:38`) but `next` is **never consumed** | — | — |

## 3. Programmatic navigation call sites

Every in-app navigation goes through `window.LTPRouter.navigate` (aliased
`nav` at the top of each module) and is therefore a **push**. The only
`replace` in the codebase is `crew-portal.js:1254`. Hard navigations
(`window.location.href`) leave the SPA entirely.

Trigger key: **click** = user clicked a row/button/link · **tab** = tab/filter/sub-nav change · **open-modal** = opens a URL-bound modal/form · **close-modal** = UI close of a URL-bound modal · **post-save** · **post-delete** · **redirect** (automatic) · **guard** · **hard** (full page navigation).

### Shell (`app.js`)

| file:line | push/replace | Trigger | Target |
|---|---|---|---|
| `app.js:334,346,355,372,380,418` | push | click (global search result) | company / contact / project / quote / equipment / invoice detail |
| `app.js:388,397,406,427` | push | click (global search result) | `quotes/products`, `quotes/services`, `quotes/fees`, `labor/roster` |
| `app.js:482` | push | **redirect during render** (unknown module) | `dashboard` |
| `app.js:551` | push | click (sidebar module) | module root |
| `app.js:566,579,601,621` | push | **tab** (sidebar sub-nav: CRM, Rentals, Quotes, Labor) | sub-route |
| `app.js:770` | push | click (mobile bottom tab) | module root |
| `app.js:812` | push | click / **tab** (More sheet, module + every sub-nav) | module or sub-route |
| `app.js:854` | push | click (Create sheet) | `*/new` |

### Router / auth / infrastructure

| file:line | push/replace | Trigger | Target |
|---|---|---|---|
| `router.js:180` | push | **redirect** (bare load) | `#/dashboard` or `#/crew-portal` |
| `app.js:131` | hard (`<a href="/auth/login">`) | click (sign-in) | Google OAuth → `backend/routes/auth.py:253` 302 → `/` → `router.js:180` push. **The originally requested hash is never captured or restored.** |
| `components/auth.js:92` | hard | logout | `/` |
| `components/data-state.js:98`, `:227` | hard | **guard** (401 on any API call) | `/auth/login` (deep URL lost) |
| `components/live-sync.js:185` | hard | **guard** (401 on version poll) | `/auth/login` |
| `components/register-sw.js:77`, `:130` | reload | SW update | same URL |
| `modules/settings.js:307` | hard | click (Connect QuickBooks) | `/api/qbo/connect` → Intuit → `qbo.py:94-137` 302 → `/#/settings?qbo=…` |
| `sw.js:531` (`WindowClient.navigate`) / `:535` (`openWindow`) | push into an open window, or cold load | notification click | `data.url` from backend: `/#/projects/:id`, `/#/dashboard`, `/#/labor/payouts`, `/#/invoices/:id`, `/#/quotes/:id` (`crew.py:940`, `qbo.py:988`, `view.py:276,283,451`) |
| `modules/client-view.js:683` | hard | click (PDF) | `/api/view/:token/pdf` |
| `modules/invoices.js:900`, `quotes-builder.js:1253` | hard (`mailto:`) | click | mail client |

### CRM (`modules/crm-shell.js`, `crm-companies.js`, `crm-contacts.js`)

| file:line | push/replace | Trigger | Target |
|---|---|---|---|
| `crm-shell.js:27` | push | open-modal / close-modal (`setSelectedCompanyId`) | `crm/companies/:id` or `crm/companies` |
| `crm-shell.js:28` | push | open-modal / close-modal (`setEditContactId`) | `crm/contacts/:id` or `crm/contacts` |
| `crm-shell.js:80` | push | open-modal / close-modal (edit company) | `…/:id/edit` or `…/:id` |
| `crm-shell.js:85` | push | click (cross-area, company detail → project) | `projects/:id` |
| `crm-shell.js:110,135` | push | **post-delete** | list |
| `crm-shell.js:144,147` | push | **post-delete** (wizard) | list |
| `crm-shell.js:155` | push | **tab** (Companies ↔ Contacts) | `crm/:tab` |
| `crm-shell.js:247,248,313,314` | push | open-modal (+ Add) | `*/new` |
| `crm-shell.js:354,369` | push | close-modal (add form) | list |
| `crm-shell.js:358,383` | push | **post-save** (create) | new `:id` |
| `crm-shell.js:365` | push | **post-save** (edit) | `:id` |
| `crm-companies.js:49` (`onClose`), `:60`, `:77`, `:100` | push (via ctx) | close-modal / open-modal / cross-link | list, edit, contact, project |
| `crm-companies.js:97` | push | click (cross-area, vendor → cross-rental order) | `rentals/cross-rentals/:id` |
| `crm-contacts.js:17` | push | close-modal (edit form) | `crm/contacts/:id` |
| `crm-contacts.js:20` | push | **post-save** (edit) | `crm/contacts/:id` |
| `crm-contacts.js:37` | push | open-modal (Edit) | `crm/contacts/:id/edit` |
| `crm-projects.js:22`, `:418` | push | click (Open Schedule Builder) | `projects/:id/schedule` |

### Projects (`modules/projects.js`, `crm-projects.js`, `calendar.js`, `calendar-grid.js`)

| file:line | push/replace | Trigger | Target |
|---|---|---|---|
| `projects.js:29-30` | push | open-modal / close-modal (`setSelectedProjectId`, optional tab) | `projects/:id[/:tab]` or `projects` |
| `projects.js:82` | push | click ("Back to projects" after remote delete) | `projects` |
| `projects.js:116` | push | open-modal / close-modal (edit) | `…/edit` or `projects/:id` |
| `projects.js:123,124` | push | click (cross-area → company / contact) | `crm/...` |
| `projects.js:184,256` | push | **post-delete** | `projects` |
| `projects.js:330` | push | open-modal (+ Create) | `projects/new` |
| `projects.js:390` | push | close-modal | `projects` |
| `projects.js:394` | push | **post-save** (create) | `projects/:newId` |
| `projects.js:405` | push | **post-save** (edit) | `projects/:id` |
| `projects.js:426` | push | click (blocked-delete → other doc) | `quotes/:id` / `invoices/:id` |
| `crm-projects.js:103` (`onClose`) | push (via ctx) | close-modal | `projects` |
| `calendar.js:16-17` | push | click (calendar → project, optional tab) | `projects[/:id[/:tab]]` |
| `calendar-grid.js:95` | push | click (mobile day tap) — also stashes `window.LTP_weeklyFocusDate` as a side channel consumed at `labor.js:2508` | `labor/schedule` |

### Rentals (`modules/rentals-shell.js`)

| file:line | push/replace | Trigger | Target |
|---|---|---|---|
| `rentals-shell.js:72` (`goList`) | push | close-modal | list tab |
| `rentals-shell.js:75` | push | open-modal (cross-rent with query prefill) | `rentals/cross-rentals/new?…` |
| `rentals-shell.js:77-80` | push | open-modal (detail / edit) | `…/:id`, `…/:id/edit` |
| `rentals-shell.js:110,156,175,202` | push | **post-delete** | list tab |
| `rentals-shell.js:278-286` | push | open-modal (+ Add / FAB) | `*/new` |
| `rentals-shell.js:291,292,298,299` | push | click (kit / cross detail; cross-links from equipment detail) | detail routes |
| `rentals-shell.js:301,317,323,336,343,350,355,362,370,377,384,394,401` | push | close-modal | parent-ish route |
| `rentals-shell.js:304` | push | open-modal (Scan) | `…/:id/scan` |
| `rentals-shell.js:337,351,371,395` | push | **post-save** (create) | new `:id` |
| `rentals-shell.js:344,356,378,402` | push | **post-save** (edit) | `:id` |
| `rentals-shell.js:363,385` | push | open-modal (Edit) | `…/:id/edit` |

### Quotes (`modules/quotes-shell.js`, `quotes-list.js`, `quotes-builder.js`)

| file:line | push/replace | Trigger | Target |
|---|---|---|---|
| `quotes-shell.js:53` | push | **tab** (Quotes / Products / Services / Fees / Client Rates) | `quotes[/tab]` |
| `quotes-list.js:133` | push | click (+ New) | `quotes/new` |
| `quotes-list.js:171,205` | push | click (row) | `quotes/:id` |
| `quotes-builder.js:1462` | push | **post-save** (first save of a new quote) | `quotes/:newId` |
| `quotes-builder.js:1790` | push | **post-delete** | `quotes` |
| `quotes-builder.js:1943` | push (100 ms `setTimeout`) | post-action (convert → invoice) | `invoices/:id` |
| `quotes-builder.js:2169` | push | **back button** ("← Back", hardcoded) | `quotes` |
| `quotes-builder.js:2190,2249` | new tab (`href="#/view/quote/…?preview=1"`) | click (Preview) | public view |
| `quotes-builder.js:2606` | push | click (linked invoice) | `invoices/:id` |

### Invoices (`modules/invoices.js`)

| file:line | push/replace | Trigger | Target |
|---|---|---|---|
| `invoices.js:200` | push | click (+ New) | `invoices/new` |
| `invoices.js:247,268` | push | click (row) | `invoices/:id` |
| `invoices.js:1843` | push | **post-save** (first save of a new invoice) | `invoices/:newId` |
| `invoices.js:1964` | push | **post-delete** | `invoices` |
| `invoices.js:1982` | push | **back button** ("← Back", hardcoded) | `invoices` |
| `invoices.js:2001,2022` | new tab | click (Preview) | public view |
| `invoices.js:2217,2397` | push | click (linked quote, cross-area) | `quotes/:id` |

### Labor & Schedule (`modules/labor.js`, `schedule-builder.js`)

| file:line | push/replace | Trigger | Target |
|---|---|---|---|
| `labor.js:2196,3309,3863` | push | click (cross-area → schedule builder) | `projects/:id/schedule` |
| `schedule-builder.js:737` | push | post-action (append to existing quote/invoice) | `quotes/:id` / `invoices/:id` |
| `schedule-builder.js:787` | push | **post-save** (create quote/invoice from schedule) | `quotes/:newId` / `invoices/:newId` |
| `schedule-builder.js:798,817` | push | **back button** ("←" / "← Back to Project", hardcoded) | `projects/:id` |

### Dashboard (`modules/dashboard.js`)

| file:line | push/replace | Trigger | Target |
|---|---|---|---|
| `dashboard.js:107,132,154,196` | push | click (area shortcuts) | `calendar`, `labor`, `invoices`, module roots |
| `dashboard.js:111,157,178` | push | click (rows; `a.navTo`) | `projects/:id/schedule`, `invoices/:id`, activity targets |

### Crew portal (`modules/crew-portal.js`)

| file:line | push/replace | Trigger | Target |
|---|---|---|---|
| `crew-portal.js:151` (`go`) | push | all portal navigation | `crew-portal/<screen>` |
| `crew-portal.js:352,359,386,433,444,448,469,498,505` | push | click (auth-flow links, "Back to sign in") | login / forgot / request-access / account |
| `crew-portal.js:589,598` | push | **tab** (portal tabs, desktop + mobile) | overview / schedule / payouts / account |
| `crew-portal.js:785` | push | click | `payouts` |
| `crew-portal.js:1254` | **replace** | **guard** (signed in on a public screen) | `crew-portal/overview` |
| `crew-portal.js:1259` (`signedIn`) | push | post-login | `overview` |
| `crew-portal.js:1260` (`signedOut`) | push | post-logout | `login` |

## 4. Existing "back" controls

| Control | file:line | What it calls |
|---|---|---|
| Quote builder "← Back" | `quotes-builder.js:2169` | `nav("quotes")` — hardcoded push |
| Invoice builder "← Back" | `invoices.js:1982` | `nav("invoices")` — hardcoded push |
| Schedule builder "←" (phone) / "← Back to Project" (desktop) | `schedule-builder.js:798`, `:817` | `nav("projects/" + id)` — hardcoded push |
| "Back to projects" (project deleted remotely) | `projects.js:82` | `nav("projects")` push |
| Every `LTPModal` close (✕ / backdrop) | `components/ui.js:952-957` → each caller's `onClose` | For URL-bound modals: `nav(parentRoute)` push (all rows marked *close-modal* above). For local-state modals: `setState(null)`, no history effect. |
| Crew portal "← Back to sign in", "Back to my account" | `crew-portal.js:386,448,498,505` | `go(...)` push |
| Client view / crew view "Back" | `client-view.js:823`, `crew-view.js:604` | local state only |
| Send-dialog "← Back" | `schedule-builder.js:1116` | local wizard step |

No control calls `history.back()` or `navigate(-1)`. There is no shared back utility.

## 5. PWA specifics

| Item | Finding |
|---|---|
| `start_url` | `/#/dashboard` (`manifest.webmanifest:6`); rewritten to `/#/crew-portal` on the crew host (`backend/main.py:835`). `id: "/"`, `scope: "/"`. |
| `display` | `standalone`, `orientation: portrait`. iOS: `apple-mobile-web-app-capable` (`index.html:25`), so installed iOS has **no browser chrome and no back button**. |
| SW navigation handling | `sw.js:553-568`: `mode === 'navigate'` is network-first with cached `/` fallback. Passthrough for `/api/`, `/auth/`, `/pdf/`, `/sw.js` (`sw.js:423`). **No redirects, no URL rewriting** — the SW never alters history. |
| SW update | `register-sw.js:77,130`: `location.reload()` on `controllerchange` — same URL, history unaffected. |
| Push notifications | `sw.js:523-537`: focuses the first window client (even an uncontrolled one, e.g. a public share-view tab) and calls `WindowClient.navigate(url)` → fragment navigation = **push**; otherwise `openWindow(url)` → **cold entry**, no in-app history. |
| Standalone detection | `register-sw.js:33`, `viewport-height.js:26` already use `matchMedia("(display-mode: standalone)") || navigator.standalone`. Reusable. |
| Mobile breakpoint | `window.LTP_useIsMobile` (`ui.js:40`), 600 px, drives the bottom tab bar / More sheet. |

## 6. State stored in the URL

| State | Where | Push or replace on change |
|---|---|---|
| Area tab: `crm/companies` ↔ `crm/contacts` | `crm-shell.js:155`, sidebar `app.js:566`, More sheet `app.js:812` | push |
| Area tabs: `rentals`, `rentals/equipment`, `containers`, `kits`, `cross-rentals` | sidebar `app.js:579`, More sheet | push |
| Area tabs: `quotes`, `quotes/products`, `services`, `fees`, `client-rates` | `quotes-shell.js:53`, sidebar `app.js:601`, More sheet | push |
| Area tabs: `labor/*` | sidebar `app.js:621`, More sheet | push |
| Project detail initial tab: `projects/:id/:tab` | `calendar.js:17`, `projects.js:30` | push on open; in-modal tab clicks don't touch the URL (`crm-projects.js:62`) |
| Modals/drawers: every `/new`, `/:id`, `/:id/edit`, `/:id/scan` (CRM, Projects, Rentals) | see §2 | push to open, **push to close** |
| Cross-rental prefill: `?equipmentId&start&end&vendorId&qty` | `rentals-shell.js:63-69` | push (one-shot) |
| Public view flags: `?preview=1`, `?r=<tracking>` | `client-view.js:478,484` | n/a (entry only) |
| `?qbo=connected\|error\|realm_mismatch` on `#/settings` | written by backend, never read | n/a |
| `?next=` on `crew-portal/login` | parsed, never consumed | n/a |
| Crew portal tabs | `crew-portal.js:589,598` | push |

**Not** in the URL (so Back can never step through them, and they are lost on Back): list search / status filter / sort / show-completed (`projects.js:33-37`, `invoices.js:82-88`, `quotes-list.js:22-27`, `crm-shell.js:31-38`, `rentals-containers.js:486-489`), per-user saved views (server-side `User.preferences`, `table-views.js:13-14`), detail-modal inner tabs (`rentals-equipment.js:267`, `rentals-containers.js:250`, `crm-projects.js:63`), every Labor drawer/modal, Settings sections, the More/Create sheets, the global search dropdown.

**Scroll:** the content area is an inner `overflow:auto` div (`app.js:678`), so browser scroll restoration never applies; the module unmounts on every route change and list scroll position is always lost on Back. No component saves or restores scroll (only `scrollIntoView` for "today" markers: `calendar-grid.js:15`, `labor.js:2411,2516`).

## 7. Reproductions identified from code

Each is deterministic given the call sites above.

1. **Bare load leaves a dead entry under home.** Load `/` → `router.js:180` pushes `#/dashboard`. History: `[/, /#/dashboard]`. Back → URL becomes `/`, `useRoute` parses empty hash as dashboard, so the screen doesn't change; a second Back exits. Same on the crew host with `#/crew-portal`.
2. **Unknown route is a Back trap.** Load `#/foo` (or a route removed in a deploy) → `app.js:482` pushes `#/dashboard` during render. History `[#/foo, #/dashboard]`. Back → `#/foo` → re-renders → pushes `#/dashboard` again. The user can never Back past it.
3. **Login screen stays in history and the deep link is lost.** Cold-open `#/invoices/901` signed out → sign-in screen at that URL → `/auth/login` → Google → callback 302 `/` (`auth.py:253`) → push `#/dashboard`. Result: the user lands on the dashboard, not the invoice, and Back walks `/` → Google → the sign-in screen at `#/invoices/901`. Same via the 401 guards (`data-state.js:98,227`, `live-sync.js:185`) mid-session: current deep URL dropped.
4. **Closing a URL-bound modal pushes, so Back reopens it.** `#/crm/companies` → click row (push `…/42`) → ✕ (push `…/companies`). History `[companies, 42, companies]`. Back reopens company 42. Applies to every *close-modal* row in §3 (CRM, Projects, all four Rentals tabs, Scan).
5. **Back after saving a new record opens a blank form.** `quotes/new` → Save → push `quotes/:newId` (`quotes-builder.js:1462`). Back → `quotes/new` → a fresh empty builder (`quotes-shell.js:37-39`, `isNewQuote`). Identical for `invoices.js:1843`, `projects.js:394`, `crm-shell.js:358,383`, `rentals-shell.js:337,351,371,395`, and `schedule-builder.js:787` (Back returns to the schedule, acceptable, but then Forward re-lands on the new doc).
6. **Back after delete returns to the deleted item's URL.** `quotes-builder.js:1790` pushes `quotes`; Back → `quotes/:deletedId` → builder with no quote. `rentals-shell.js:110` etc. → detail route with `openEq === null` (renders the list silently under a stale URL). `projects.js:184,256` → `projects/:id` → nothing opens.
7. **Tab and sub-nav changes are pushes.** Companies → Contacts → Companies leaves three entries; Rentals sub-nav, Quotes catalog tabs, Labor tabs and crew-portal tabs all cycle on Back instead of leaving the area.
8. **Edit → Save is two pushes deep.** `…/:id` → Edit (push `…/:id/edit`) → Save (push `…/:id`). History `[list, id, edit, id]`. Back reopens the edit form with the pre-save values, then the detail again, then the list.
9. **Crew portal: Back from overview lands on a consumed one-time link.** `signup/<token>` → sign in → push `overview` (`crew-portal.js:1259`). Back → `signup/<token>` → token already used → error screen. Login → overview leaves `login` underneath; Back hits `crew-portal.js:1254` which replaces to overview again (one wasted Back press).
10. **QuickBooks connect leaves Intuit in history.** `settings.js:307` hard-navigates to `/api/qbo/connect`; callback 302s to `/#/settings?qbo=…` (`qbo.py:137`). Back from Settings returns to Intuit's authorize page. The query flag is never consumed so the URL keeps it.
11. **Push notification into an open window can hijack an unrelated tab.** `sw.js:527-533` picks the first window client including uncontrolled ones — a client share-view tab or the crew portal can be navigated to `/#/invoices/:id` (which then shows the staff sign-in or app).
12. **Full-screen builders on installed iOS rely on their hardcoded Back.** `quotes-builder.js:2169` / `invoices.js:1982` always go to the list, so a quote opened from a project's Quotes tab, from an invoice's "Linked to" link (`invoices.js:2217`), or from the dashboard returns to the quotes list, not to where the user came from. Schedule builder's Back always goes to `projects/:id` even when opened from Labor (`labor.js:2196,3309,3863`) or the dashboard.
13. **Convert quote → invoice uses a delayed push.** `quotes-builder.js:1943` navigates inside a 100 ms `setTimeout`; a Back pressed in that window races the push.

## 8. Facts that shape the design

- Only one navigation primitive exists (`navigate` → push). Introducing `replace`-by-default for the right classes touches ≈130 call sites, but they are already centralised behind ~15 helper closures (`setSelectedCompanyId`, `goList`, `ctx.setEditProjectId`, `go`, …), so most sites change by changing the helper.
- `history.state` is untouched today, so it is free for a session marker (`{ ltp: { idx } }`) without conflicting with anything.
- The router already dispatches a synthetic `hashchange` after `replaceState` (`router.js:163`); the same pattern can drive seeding without re-rendering ancestors, because React only sees the final `getRoute()`.
- The auth flow has no "return to" mechanism at all; the hash never reaches the server (`/auth/callback` → `/`). The fix is purely client-side: stash the requested hash in `sessionStorage` before leaving for `/auth/login`, and on boot at `/` with a stash present, `replace` to it before the dashboard push.
- iOS standalone has no back UI; the bottom tab bar is hidden in the three full-screen builders (`app.js:489-491`), so those screens' own Back buttons are the only way out and must use the unified `goBack()`.
- No existing tests cover history semantics. `tests/test_crew_portal_routes.js:23-26` shows the shim pattern for loading `router.js` under Node with a fake `window`/`history`, which the Phase 2 unit tests can extend with a fake history stack.
