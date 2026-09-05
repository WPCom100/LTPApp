---
name: verify
description: Launch the LTP app locally and drive it with Playwright to verify frontend/backend changes end-to-end.
---

# Verifying LTPApp changes at runtime

No build step — the frontend is plain JS served by FastAPI straight from the
repo root, so uncommitted edits are live on reload.

## Launch

```bash
SCRATCH=<scratch dir>
DATABASE_URL="sqlite+aiosqlite:///$SCRATCH/ltp_dev.db" \
  .venv/bin/uvicorn backend.main:app --port 8000 --app-dir /home/user/LTPApp \
  > $SCRATCH/server.log 2>&1 &
```

Boot runs `alembic upgrade head` automatically (takes a few seconds — wait
until `init_db complete` appears in the log before hitting it).

## Auth (Google OAuth only — forge a session instead)

Sessions are rows in `sessions` keyed by sha256(cookie token). Insert a user
and session directly into the SQLite DB, then send the raw token as the
`ltp_session` cookie:

```python
import sqlite3, hashlib, datetime
db = sqlite3.connect(DB_PATH); now = datetime.datetime.now(datetime.timezone.utc)
db.execute("INSERT INTO users (google_sub, email, name, role, created_at, last_login) VALUES ('v-sub','v@example.com','Verify Admin','admin',?,?)", (now.isoformat(), now.isoformat()))
token = "verifytoken..." # any string >= 32 chars
db.execute("INSERT INTO sessions (id, user_id, created_at, expires_at, last_used_at) VALUES (?,1,?,?,?)",
           (hashlib.sha256(token.encode()).hexdigest(), now.isoformat(), (now+datetime.timedelta(days=29)).isoformat(), now.isoformat()))
db.commit()
```

## Seeding data

Generic CRUD at `/api/<entity>` (contacts, projects, services, quotes, …),
camelCase JSON in/out, auth via the cookie. Field values are validated
(e.g. project `status` ∈ cancelled/completed/in-progress/upcoming).

## Driving with Playwright

- Chromium: `chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  headless: false, args: ['--headless=new'] })` — the installed Chromium has
  dropped the old headless mode that `headless: true` selects, so the launch
  dies with "Old Headless mode has been removed" without those two options.
  (Install the `playwright` npm package in scratch; browsers are pre-installed.)
- After `page.goto`, wait for a real selector on the target screen (e.g.
  `text=Schedule Summary` for the builder) rather than a fixed sleep — the
  first render can take a few seconds and the body reads empty until then.
- index.html pulls React/ReactDOM/DOMPurify/signature_pad from
  cdnjs.cloudflare.com — no direct egress from the browser, so `curl` them to
  disk first (proxy env works for curl) and `page.route()` cdnjs URLs to
  fulfill from the local files.
- Set the cookie with `ctx.addCookies([{ name: 'ltp_session', value: TOKEN, url: 'http://127.0.0.1:8000' }])`.
- Routing is hash-based: `#/labor/roster`, `#/quotes/services`,
  `#/projects/<id>/schedule` (full-screen Schedule Builder), `#/labor/assignments`.
- Saves are debounced PUTs — wait ~1s after clicking Save before asserting
  persistence via the API.
- First page load can be slow; wait for `networkidle` plus a beat, and listen
  to `pageerror`/`console.error` to catch frontend crashes.

## Gotchas

- LTPInput renders `<div><label>TEXT</label><input/></div>` — locate inputs by
  `div:has(> label:text-is("Day Rate ($)")) input`.
- Literal `…` in UI strings (option labels like "Crew…") — match the ellipsis
  character, not three dots.
