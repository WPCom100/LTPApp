# Crew portal domain — `crew.luminarytechnology.productions` on Railway

Runbook for giving the crew portal (`#/crew-portal`) its own address, so crew are
sent to **crew.luminarytechnology.productions** rather than the staff app's
`app.luminarytechnology.productions`.

**The headline:** this is a second custom domain on the **same Railway service**, not
a second deployment. Nothing is duplicated — no new service, database, variables or
keys. One DNS record, one Railway domain, one new environment variable. The app
decides per request, from the `Host` header, whether to wear the crew identity
(`backend/main.py`, `_is_crew_host`), so the same container serves both hosts and a
deploy can never leave them on different code.

The sibling guide [DOMAIN_MIGRATION.md](DOMAIN_MIGRATION.md) covers how
`app.luminarytechnology.productions` was set up; this follows the same shape.

---

## What the crew domain changes

| On `crew.luminarytechnology.productions` | Where |
| --- | --- |
| A bare visit lands on **#/crew-portal** (sign-in or dashboard), never the staff Google sign-in | `router.js` reads `<meta name="ltp-default-route">`, which `backend/main.py` injects only for the crew host |
| Tab title **LTP Crew Portal**, iOS home-screen name **LTP Crew** | `backend/main.py::_index_response` |
| **Add to Home Screen** installs "LTP Crew" opening on the portal | `backend/main.py::web_manifest` (`start_url: /#/crew-portal`) |
| Every crew-facing email link — invitation, password reset, and the **call-sheet link** in crew requests and confirmations — points at the crew host | `backend/email_compose.py::crew_origin`, used by `routes/crew_portal.py` and `routes/crew.py` |
| Same-origin requests pass the CSRF check | Already true (the request's own `Host` is trusted, `backend/csrf.py`); the crew origin is also named explicitly |

What does **not** change: the staff app, its Google sign-in, QuickBooks, the CSP,
push, email deliverability records, and `app.luminarytechnology.productions` itself.
Staff can still open the staff app on the crew host by URL (`crew…/#/dashboard`) and
crew can still open the portal on the app host (`app…/#/crew-portal`) — both hosts
serve the whole app. Only the *default* landing and the *emailed links* differ.

Cookies are host-only (no `Domain=`), so a crew session on `crew.` does not exist on
`app.`, and a staff session on `app.` does not exist on `crew.`. That is the
intended separation, not a gap.

---

## Phase 1 — Railway: attach the domain

1. Railway → the **production** service (the one serving `app.luminarytechnology.productions`) →
   **Settings** → **Networking** → **Public Networking** → **+ Custom Domain**.
2. Enter `crew.luminarytechnology.productions` and confirm. Railway shows the
   record to create — a **CNAME** to a `…up.railway.app` target. The existing app
   domain points at `j6b8xlhb.up.railway.app`; the crew domain's target is usually
   the same, but **use whatever Railway shows you** for this domain.
3. Leave the domain attached in the "waiting for DNS" state and go to Phase 2. Railway
   polls DNS and provisions the TLS certificate on its own once the record resolves.

Do this on the production service only. A dev deployment (`LTP_APP_VARIANT=dev`) can
get its own crew host later (`crew-dev.…`) the same way; see *Optional* below.

## Phase 2 — DNS: one CNAME

At the DNS provider for `luminarytechnology.productions` (the same place the `app`
record lives):

| Type | Name | Target | TTL |
| --- | --- | --- | --- |
| CNAME | `crew` | the `…up.railway.app` target from Phase 1 | Auto / 300 |

- **Do not** add an A record, and do not put anything else under `crew`.
- **Do not** add SPF/DKIM/DMARC under `crew` — it is not a mail domain. Mail keeps
  sending from the Workspace apex via the Gmail API (see
  [EMAIL_DELIVERABILITY.md](EMAIL_DELIVERABILITY.md)).
- **If the zone is on Cloudflare:** set the record to **DNS only** (grey cloud) for the
  simplest, certain setup — Railway then terminates TLS. If you insist on proxying
  (orange cloud), set SSL/TLS to **Full (strict)** *and* bump
  `LTP_TRUST_PROXY_HOPS` to `2` on the service (README, environment variables) —
  otherwise the rate limiter and lockout attribute every crew sign-in to Cloudflare's
  IP and one crew member's mistakes lock everyone out.

Propagation is minutes at most for a new record. Check from anywhere:

```bash
dig +short crew.luminarytechnology.productions CNAME
# → <target>.up.railway.app.
```

Back in Railway, the domain flips to **Active** with a certificate once it resolves.
Then:

```bash
curl -sI https://crew.luminarytechnology.productions/healthz
# HTTP/2 200, content-type: application/json — same container as the app host
```

## Phase 3 — Variables: one line

Railway → the same service → **Variables**:

```
LTP_CREW_PORTAL_ORIGIN = https://crew.luminarytechnology.productions
```

Exact literal — `https://`, no trailing slash, no path. Save, and let the service
redeploy (the value is read per request, but a redeploy is the clean way to be sure
every replica has it). The boot log prints a warning if the value is not an
`http(s)://` origin, and the app then ignores it rather than breaking links.

Optionally, in the same edit:

```
LTP_CREW_PORTAL_SENDER_EMAIL = <a staff address with Gmail connected>
```

That is who the crew's own **Forgot your password?** and **Request access** emails are
sent as (invitations and resets a producer sends from the roster go out as that
producer). Unset, the most recently signed-in admin with Gmail connected sends them.

Nothing else moves. In particular **leave `LTP_OAUTH_REDIRECT_URI` and
`QBO_REDIRECT_URI` alone** — Google and Intuit never see the crew host (the portal
has no OAuth), and the app origin they name is still where assets and staff links
are built.

## Phase 4 — Verify

- [ ] `https://crew.luminarytechnology.productions/` opens **the crew sign-in**, not
      the Google button. The tab reads *LTP Crew Portal*.
- [ ] `curl -s https://crew.luminarytechnology.productions/ | grep -c "ltp-default-route"`
      → `1`, and the same against `app.luminarytechnology.productions` → `0`.
- [ ] `curl -s https://crew.luminarytechnology.productions/manifest.webmanifest` shows
      `"name": "LTP Crew"` and `"start_url": "/#/crew-portal"`; the app host's manifest
      still says `LTP` / `/#/dashboard`.
- [ ] Labor → Crew Roster → send yourself an invitation (a crew contact with your own
      email). **Read the received email's source**: the button and the pasted link must
      start with `https://crew.luminarytechnology.productions/#/crew-portal/signup/`,
      and the masthead image must still resolve from `app.luminarytechnology.productions`.
- [ ] Accept it: the `ltp_crew_session` cookie lands on the **crew host** with `HttpOnly`,
      `Secure`, `SameSite=Lax`, `Path=/` and **no `Domain=`**.
- [ ] Send yourself a crew request: the email's **View & Respond** link opens
      `https://crew.luminarytechnology.productions/#/crew/…`.
- [ ] On a phone: Share → **Add to Home Screen** from the crew host. The icon is named
      **LTP Crew** and launches straight into the portal.
- [ ] The staff app is untouched: sign in at `app.luminarytechnology.productions` as
      before, and `#/labor/roster` shows the **Portal** column.

## Phase 5 — Tell the crew

Anyone already invited before the switch has links to `app.…/#/crew-portal/…` in their
inbox. **Those keep working** — the portal is served on both hosts — so nothing has to
be re-sent. New invitations, resets and requests use the crew host from the moment
the variable is set.

Short script for the crew:

1. The portal's address is **crew.luminarytechnology.productions**. Bookmark it, or on
   your phone: open it in Safari/Chrome → Share → **Add to Home Screen** (it installs
   as *LTP Crew*).
2. Sign in with the email and password you set up. Forgot it? *Forgot your password?*
   on the sign-in screen.
3. Never used it? *Request access* with the email the office has for you.

---

## Explicitly do NOT change

- **`LTP_OAUTH_REDIRECT_URI`** — it is the staff Google callback *and* the app origin
  every asset URL is built on. Leave it on the app host.
- **The CSP** (`backend/main.py`). `'self'` follows whichever host served the page; the
  crew host needs no entry.
- **Cookies.** Do not add `Domain=.luminarytechnology.productions` to either cookie to
  "share" sessions across hosts — it would also share them with the marketing site and
  every future subdomain, and it would undo the crew/staff separation.
- **`manifest.webmanifest` on disk** — the crew variant is produced per request; editing
  the file changes the staff app too.
- **`sw.js` `CACHE_VERSION`** for the domain itself — a new origin gets its own cache.
  (The router and auth-probe changes that made the default route host-aware did bump
  it, as any shell change must.)
- **`app.luminarytechnology.productions`** — keep it attached. Every email already sent
  links to it, and it is where the masthead image lives.

## Rollback

Remove `LTP_CREW_PORTAL_ORIGIN` (or blank it) and save. New emails link to the app host
again, and `crew.` becomes just another host serving the staff default. No DNS change,
no redeploy of code, nothing to re-send: every crew link already delivered keeps
opening, because both hosts stay attached.

## Optional

- **A dev crew host.** Add `crew-dev.luminarytechnology.productions` to the *dev*
  service the same way and set its own `LTP_CREW_PORTAL_ORIGIN`. With
  `LTP_APP_VARIANT=dev` the identity reads *LTP Crew Dev* so an installed dev portal is
  unmistakable next to the real one.
- **Redirecting `app…/#/crew-portal` to the crew host.** Not needed — the portal works on
  both — and a server-side redirect cannot see the URL fragment, so it would break the
  one-time signup/reset links. If ever wanted, do it client-side in
  `modules/crew-portal.js` on load, preserving `location.hash`, and only when a crew
  origin is known to the page.
