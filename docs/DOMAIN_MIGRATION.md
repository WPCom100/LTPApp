# Domain migration — `ltpapp.up.railway.app` → `app.luminarytechnology.productions`

Checklist for moving the LTP app to its own subdomain.

**The headline:** almost none of this is a code change. The app hardcodes its host
*nowhere* — `up.railway.app` returns zero hits across the repo. The entire public
origin is derived at runtime from a single environment variable,
**`LTP_OAUTH_REDIRECT_URI`**. This migration is essentially "register the new
callback URL in two consoles, then flip one variable."

---

## Status as of 2026-08-02 (verified live)

DNS, the Railway custom domain, and TLS are **already done**:

| Check | Result |
| --- | --- |
| `app.luminarytechnology.productions` DNS | ✅ `CNAME → j6b8xlhb.up.railway.app` |
| TLS certificate | ✅ Valid (`ssl_verify_result=0`), HTTP 200 |
| Serves the app | ✅ Same Railway service — identical CSP + HSTS on both hosts |
| PWA identity | ✅ `name=LTP`, `id=/`, `start_url=/#/dashboard` (not the "LTP Dev" variant) |
| `LTP_OAUTH_REDIRECT_URI` | ❌ **Still `https://ltpapp.up.railway.app/auth/callback`** |

So the app is reachable at the new domain, but **the migration is not done**. Today,
signing in at the new host sends you to Google and Google sends the code back to
*`ltpapp.up.railway.app`* — you land, and get your session cookie, on the old host.
Emails still ship old-host links too. Everything below is about closing that gap.

---

## Phase 1 — Before cutover (external consoles; nothing breaks)

Each step is additive and safe to do now — old and new URIs coexist.

- [ ] **Google Cloud Console** → APIs & Services → Credentials → the OAuth 2.0 client
      matching `GOOGLE_CLIENT_ID` → **Authorized redirect URIs** → *add*
      `https://app.luminarytechnology.productions/auth/callback`.
      **Keep the old URI registered** through the transition.
  - *Authorized JavaScript origins needs no entry* — the app uses the server-side
    authorization-code flow (`oauth.google.authorize_redirect`, `backend/routes/auth.py:110`),
    not the JS/implicit flow. Expect that list to be empty; leave it that way.
- [ ] **Google OAuth consent screen** → confirm `luminarytechnology.productions` is under
      **Authorized domains** (a registered parent covers all subdomains). Repoint any
      App homepage / Privacy / ToS URL that points at `ltpapp.up.railway.app`.
- [ ] **Intuit Developer** → My Apps → Keys & credentials → *add* redirect URI
      `https://app.luminarytechnology.productions/api/qbo/callback`.
      Do this on **both** the Development and Production keysets so a later
      `QBO_ENVIRONMENT` switch doesn't re-break it. Keep the old URI.
- [ ] **Intuit app profile** → repoint Host domain / Launch URL / Disconnect URL if any
      names the old host (suggested: `https://app.luminarytechnology.productions/#/settings`).
      Leave EULA/Privacy pointing at the marketing site.
- [ ] **Confirm `LTP_FORCE_HTTPS=1`** in Railway Variables. Accepted values are exactly
      `1`/`true`/`yes`/`on` (`backend/main.py:301`). Without it, HTTPS posture — HSTS,
      `Secure` cookies, `SessionMiddleware(https_only=…)` — depends on string-prefix luck
      against the redirect URI.
- [ ] **Drain the crew-notification outbox.** It lives in origin-scoped `localStorage`
      (`components/crew-outbox.js:21`, key `ltp_crew_outbox`) and **does not transfer**.
      Have every producer open the app *on the old host* and clear the "Crew to notify"
      tray via **Notify all** or **Dismiss all** until the card disappears.
- [ ] **Audit two DB values** for pasted absolute old-host URLs:
      `Settings.website`, and the admin-edited `emailTemplates` / `emailSignatureTemplate`
      blobs. Replace any hardcoded app link with `{{viewUrl}}`.
- [ ] Confirm `LTP_APP_VARIANT` is **unset** on the production service (else the PWA
      installs as "LTP Dev"). Verified unset today.

---

## Phase 2 — Cutover (two variables, one save)

- [ ] In **Railway → service → Variables**, change both in a **single edit / single redeploy**
      so they can never disagree:

  ```
  LTP_OAUTH_REDIRECT_URI = https://app.luminarytechnology.productions/auth/callback
  QBO_REDIRECT_URI       = https://app.luminarytechnology.productions/api/qbo/callback
  ```

  Exact literals — `https://`, no trailing slash, no stray whitespace. Never leave
  `LTP_OAUTH_REDIRECT_URI` blank: `/auth/login` 500s without it (`backend/routes/auth.py:105`).

- [ ] **Confirm the service actually restarted.** These are read at *module import*
      (`backend/main.py:302`), not per request. Look for `[LTP] payload size limit: …`
      in the boot log.

- [ ] *(Optional, during the dual-host window)* `LTP_EXTRA_ORIGINS=https://ltpapp.up.railway.app`
      — a CSRF safety net (`backend/csrf.py:35`). Not strictly required: `csrf.py:39` always
      adds the request's own Host, so same-origin calls pass on either host regardless.

### Why one variable does so much

`LTP_OAUTH_REDIRECT_URI` is read in five places. Flipping it moves all of them at once:

| Consumer | Effect |
| --- | --- |
| `backend/routes/auth.py:104` | The Google OAuth callback URL |
| `backend/csrf.py:32` | The CSRF Origin/Referer allow-list |
| `backend/main.py:302` | `_IS_HTTPS` → HSTS, `Secure` cookies, session `https_only` |
| `backend/email_compose.py:173` | `_app_origin()` — **every absolute URL in outbound email** |
| `backend/routes/auth.py:415`, `routes/crew.py:367,524` | Avatar URLs, crew call-sheet links |

---

## Phase 3 — Verify (before telling anyone)

- [ ] Sign in at `https://app.luminarytechnology.productions/`. Confirm you land back in
      the app and the `ltp_session` cookie is set **on the new host**, with `HttpOnly`,
      `Secure`, `SameSite=Lax`, `Path=/`, and **no `Domain=`**.
- [ ] Settings → QuickBooks → **Connect** end-to-end.
- [ ] Send one real quote to a [mail-tester.com](https://www.mail-tester.com) address.
      **Read the received email's HTML source** — not the Send-modal preview. The preview
      and the sent mail derive image origins differently, so a good-looking preview is not
      proof. Confirm the masthead resolves at
      `https://app.luminarytechnology.productions/assets/logos/luminary-masthead.png` and
      that the `#/view/…` link opens.
- [ ] Install the PWA on a real phone: confirm the manifest shows the new origin, the
      service worker activates, the `ltp-shell-v50` cache fills, airplane-mode launch still
      renders the shell, then Settings → Notifications → **Turn On** and confirm a new
      `push_subscriptions` row lands with a new endpoint.
- [ ] `curl -sI https://app.luminarytechnology.productions/manifest.webmanifest` →
      `content-type: application/manifest+json`.

---

## Phase 4 — After cutover

- [ ] **Keep `ltpapp.up.railway.app` attached to the Railway service.** Do not click Remove.
      Every quote, invoice, and crew-request email already delivered contains a baked-in
      absolute `https://ltpapp.up.railway.app/#/view/…` link and a hotlinked masthead image.
      Detaching it 404s all of them. Keep it at minimum past the collection window of the
      oldest outstanding invoice — 90 days is a reasonable floor.
- [ ] **Tell users** (see the user script below).
- [ ] Repoint any external uptime monitor / bookmark. Note the app exposes no health
      endpoint, so a monitor pinned to the old host will go quiet rather than alarm.
- [ ] Once the new host is proven, remove the old redirect URIs from Google and Intuit.
      ⚠️ If a dev deployment exists, make sure you're not deleting *its* URI.
- [ ] *(Optional hygiene, only after the old host is retired)* Prune stale
      `push_subscriptions` rows predating the cutover. **Never** run an unscoped
      `DELETE FROM push_subscriptions;` — during the overlap, duplicate rows per user are
      expected and correct.

### What users must do (origin-bound state does not transfer)

Send this as a short script:

1. Delete the old LTP home-screen icon.
2. Open `https://app.luminarytechnology.productions` in Safari/Chrome.
3. Share → **Add to Home Screen**.
4. Sign in with Google again *(everyone is signed out — the session cookie is host-only)*.
5. Settings → Notifications → **Turn On** *(push subscriptions are origin-bound)*.
6. The first Rentals barcode scan will re-prompt for **camera** permission.

Ideally have each user hit Settings → Notifications → **Turn Off** on the *old* host first,
so they don't get duplicate pushes during the overlap — taps on old-origin notifications
land on a host where they're now signed out.

---

## Explicitly do NOT change

This is the part most likely to cause damage. `luminarytechnology.productions` appears
throughout the repo, and **almost every occurrence is the marketing site or the mail
domain, not the app.** Do not global-replace it.

- **The CSP needs no edit.** `backend/main.py:321`'s
  `https://www.luminarytechnology.productions https://luminarytechnology.productions`
  in `img-src` is the *marketing* site (it hosts `Settings.logoUrl` images). The app's own
  origin is covered by `'self'`, which follows the domain automatically. Every other
  directive — `default-src`, `script-src`, `worker-src`, `manifest-src`, `connect-src`,
  `base-uri`, `form-action` — is already `'self'` plus third parties.
- **SPF / DKIM / DMARC / MX: no change.** Mail sends from the Workspace apex via the Gmail
  API; the app subdomain is not a mail domain. Do not add an SPF record under `app.`.
  Do not touch the apex or `www` records.
- **`LTP_ALLOWED_DOMAIN` stays `luminarytechnology.productions`.** It's the Workspace
  *account* domain (`backend/routes/auth.py:162`). Setting it to the app host locks everyone out.
- **`LTP_VAPID_*`: no change.** `LTP_VAPID_SUBJECT` is a `mailto:` contact, not an origin.
  **Do not regenerate the keypair.**
- **Do not add `domain=".luminarytechnology.productions"` to the session cookie**
  (`backend/routes/auth.py:69`) to dodge the re-login. It would widen the cookie to the
  marketing site and every future subdomain. Accept the one-time sign-out.
- **Do not edit `manifest.webmanifest`** (`id`, `start_url`, `scope`) and **do not bump
  `sw.js:49 CACHE_VERSION`** — a new origin gets an entirely separate CacheStorage, so the
  version string is irrelevant to the move.
- **No test changes.** All 20+ fixtures use placeholder hosts (`ltp.example.com`,
  `localhost:8000`) injected through the same env var. ⚠️ Don't `export`
  `LTP_OAUTH_REDIRECT_URI` in a shell that runs pytest — modules use `os.environ.setdefault`,
  so an exported value would win and break assertions.
- **No frontend changes.** Share links use `window.location.origin`
  (`modules/invoices.js:762`, `modules/quotes-builder.js:1297`); `index.html` has no
  canonical/`og:url`. **No CI changes.** **No calendar events or printed barcodes to reissue.**

---

## Optional: redirecting the old host

Currently both hosts serve the app normally, which is the zero-risk option and is fine to
leave indefinitely. If you later want old→new redirects, the constraints are sharp:

- Insert a pure-ASGI middleware **between `backend/main.py:438` and `:439`** (after
  `CsrfOriginMiddleware`, before `SecurityHeadersMiddleware`, so redirects still get
  security headers). Gate it on an env var so unsetting it is an instant kill switch.
- **Scope it to top-level navigations only** (`sec-fetch-dest: document`). A blanket
  redirect breaks the old host's SPA outright — it would redirect `/api/`, `/assets/`,
  `/modules/`, `/theme.js`, `/sw.js` too.
- **Use 302/307, not 301/308**, while baking in. A 301 is cached indefinitely by browsers
  and would silently void your rollback.
- The `Location` value **must not carry its own `#` fragment** — browsers reattach the
  original fragment, and `#/view/…` links depend on it surviving.
- A redirect **does not** migrate an installed PWA. Users still must reinstall.

## Rollback

No DNS change and no code redeploy needed: revert `LTP_OAUTH_REDIRECT_URI` and
`QBO_REDIRECT_URI` to their `ltpapp.up.railway.app` values and save. Leave the DNS record,
the Railway custom domain, and both console registrations in place — they're harmless.

⚠️ Only if the cutover ever involves creating a **new Railway service or environment**:
copy `LTP_TOKEN_ENCRYPTION_KEY`, `LTP_SESSION_SECRET`, `DATABASE_URL`, and `LTP_VAPID_*`
byte-for-byte before first boot. A regenerated `LTP_TOKEN_ENCRYPTION_KEY` makes every
stored Google and QuickBooks token permanently undecryptable (`backend/crypto.py:40`).
Attaching a domain to the *existing* service — the current situation — avoids this entirely.
