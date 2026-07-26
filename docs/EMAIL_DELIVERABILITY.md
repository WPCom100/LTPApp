# Email deliverability — why mail lands in spam, and how to fix it

**Symptom:** quotes / invoices / receipts / crew emails sent from the app land
in *some* recipients' spam folders (not everyone's).

The single most important thing to understand first: **the app does not run its
own mail server.** Every email is sent through the **Gmail API as the signed-in
user** (`backend/gmail.py` → `POST users/me/messages/send`). The `From:` is the
sender's own Google address (e.g. `sarah@luminarytechnology.productions`).

That means Google — not this codebase — signs and delivers the mail. So the
levers that decide inbox-vs-spam are almost all **domain configuration and
sender reputation**, not application code. This guide walks the fixes in order
of impact.

---

## TL;DR — do these first

If you send from a **Google Workspace custom domain** (you do —
`@luminarytechnology.productions`), the #1 cause of "some recipients' spam" is
**missing or unaligned domain authentication**. Fix, in order:

1. **Turn on DKIM in the Google Admin console** for your domain and publish the
   DKIM DNS record. *(This is the most common miss and the most common fix.)*
2. **Confirm SPF** includes Google (`v=spf1 include:_spf.google.com ~all`).
3. **Publish a DMARC record** (start at `p=none` to monitor, then tighten).
4. **Verify alignment** by reading **Show original** on a message you sent
   (SPF **PASS**, DKIM **PASS**, DMARC **PASS**, all for *your* domain).

Do those four and the "some people" problem almost always disappears, because
the receivers most likely to spam-file you (Microsoft 365 / Outlook, corporate
Proofpoint / Mimecast, and increasingly Gmail itself) are exactly the ones that
enforce authentication alignment.

---

## Why it's *some* people and not everyone

When SPF/DKIM/DMARC all pass **and align to your From domain**, mail generally
inboxes everywhere. When it inboxes for some and spams for others, it's almost
always one of these:

- **DKIM not enabled in Workspace.** If you never set up DKIM in the Admin
  console, Google still sends your mail — but it signs it with a generic
  `d=*.gappssmtp.com` key instead of `d=luminarytechnology.productions`. That
  signature *passes* DKIM but does **not align** to your From domain. Lenient
  receivers (Gmail→Gmail) let it through; strict receivers (Microsoft 365,
  Proofpoint, banks, government) require domain-aligned authentication and drop
  it to spam. Result: "my client on Outlook never gets it, but my Gmail
  contacts do."

- **Forwarding breaks SPF.** If a recipient auto-forwards, SPF fails at the
  final hop. Only an **aligned DKIM signature** survives forwarding — which you
  don't have until you enable Workspace DKIM (see above).

- **Consumer `@gmail.com` sender.** If any sender is signing in with a personal
  `@gmail.com` (not the Workspace domain), business mail from a free consumer
  address is heavily downranked by corporate filters. Send from the company
  domain.

- **Cold domain / cold sender reputation.** A brand-new domain, or a mailbox
  that suddenly starts sending, has no reputation. Early volume gets scrutinized
  harder by some receivers than others.

---

## The fix, step by step (Google Workspace)

### 1. Enable DKIM (highest impact)

1. Sign in to the **Google Admin console** (`admin.google.com`) as a super
   admin.
2. **Apps → Google Workspace → Gmail → Authenticate email**.
3. Select your domain (`luminarytechnology.productions`) → **Generate new
   record** (use a 2048-bit key).
4. Google shows a DNS **TXT** record: host `google._domainkey`, value
   `v=DKIM1; k=rsa; p=…`. Add it at your DNS provider.
5. Wait for DNS to propagate (minutes to ~48h), then come back and click
   **Start authentication**.

Until you click *Start authentication*, Google keeps signing as
`gappssmtp.com`. Enabling it is what makes DKIM **align** to your domain.

### 2. Confirm SPF

Publish (or confirm) a single SPF TXT record on the root domain:

```
v=spf1 include:_spf.google.com ~all
```

Rules that trip people up:
- **Exactly one** SPF record per domain. Multiple `v=spf1` records = SPF
  permerror = auth failure.
- Keep it under **10 DNS lookups** total (each `include:` counts).
- `~all` (softfail) is fine; `-all` (hardfail) is stricter — only use it once
  you're sure every legitimate sender is listed.

### 3. Publish DMARC

Add a TXT record at host `_dmarc`:

```
v=DMARC1; p=none; rua=mailto:dmarc-reports@luminarytechnology.productions; fo=1
```

- Start at **`p=none`** — this only *monitors*, it doesn't change delivery.
  Read the aggregate reports (`rua`) for a couple of weeks to confirm all your
  real mail passes.
- Then tighten to **`p=quarantine`** and eventually **`p=reject`**. A published,
  enforced DMARC policy is itself a positive trust signal to receivers.
- Don't jump straight to `p=reject` — if any legit source (a newsletter tool,
  QuickBooks emailing on your behalf, etc.) isn't aligned yet, you'd bounce your
  own mail.

### 4. Verify it worked

Send yourself (and a colleague on a *different* provider, ideally Outlook) a
real quote/invoice from the app, then in Gmail open the message → **⋮ → Show
original**. You want:

```
SPF:   PASS  with domain luminarytechnology.productions
DKIM:  'PASS' with domain luminarytechnology.productions
DMARC: 'PASS'
```

If DKIM shows `gappssmtp.com`, step 1 isn't finished. If any line says FAIL or
the domain doesn't match yours, that's your culprit.

---

## Diagnostic tools

- **Show original** (Gmail) / **View message source** (Outlook) — the fastest
  check. Read the `Authentication-Results` header. This tells you definitively
  whether the problem is auth (fixable via DNS above) or content/reputation.
- **[mail-tester.com](https://www.mail-tester.com)** — send one app email to the
  address it gives you; it returns a 0–10 score with a line-by-line breakdown
  (SPF, DKIM, DMARC, SpamAssassin content rules, blacklists). Great for a
  before/after on any change.
- **Google Postmaster Tools** (`postmaster.google.com`) — verify your domain to
  see your **domain/IP reputation**, spam-complaint rate, and authentication
  pass rates over time, as Gmail's receivers see them. Essential once you send
  any regular volume.
- **MXToolbox** — quick SPF/DKIM/DMARC record lookups and blacklist checks.

---

## Sender reputation & sending habits

Even with perfect auth, behavior matters:

- **Warm up gradually.** Don't go from 0 to a 25-recipient blast on day one from
  a fresh domain. Ramp volume over days/weeks.
- **Keep complaint rate low.** Google's guidelines want spam complaints **below
  0.1%** and effectively require staying under **0.3%**. One "Report spam" per
  few hundred sends is enough to hurt you — only send to people expecting it.
- **Send to valid addresses.** High bounce rates (typos, dead mailboxes) tank
  reputation. The app already validates recipient syntax
  (`backend/email_validate.py`), but that doesn't catch a well-formed address
  that doesn't exist — double-check client addresses.
- **The 25-recipient cap** (`_MAX_RECIPIENTS_PER_SEND` in
  `backend/routes/email.py`) keeps any single send from looking like a bulk
  blast. Leave it in place.

---

## Content best practices

What the app already does right (keep it this way):

- **Multipart/alternative** with a real `text/plain` part alongside the HTML.
  Filters penalize HTML-only mail. *(The plaintext part is generated by
  `html_to_text` in `backend/gmail.py`; it flattens the layout tables so the
  text version reads cleanly and mirrors the HTML — a garbled or empty plaintext
  part is itself a spam signal.)*
- **No open-tracking pixel.** The app tracks opens via the "View" link, not a
  1×1 beacon image — beacons are a classic spam trigger, so *don't add one.*
- **Sanitized HTML**, inline styles, and `role="presentation"` tables.
- **Real sender identity** — a proper display name and a working `Reply-To`.

Things to watch when editing templates in **Settings**:

- **Keep a healthy text-to-image ratio.** An email that is mostly one big image
  with little text scores as spam. Our templates have real body copy — keep it.
- **Avoid spam-trigger phrasing and formatting** in subjects/bodies:
  ALL-CAPS, excessive `!!!`, "FREE", "ACT NOW", walls of red bold text.
- **Match link text to destination.** Don't label a button "View invoice" if it
  points somewhere unrelated — link/anchor mismatch is scored.
- **Third-party images.** The default signature loads social icons from
  `storage.googleapis.com/signaturesatori/…` and a logo from the public site.
  If any of those URLs ever 404, recipients see broken images (looks spammy) —
  prefer hosting signature assets on your own domain.
- **Test after template edits.** Run an edited template through mail-tester
  before sending it to real clients.

---

## What is *not* the problem (so you don't chase it)

- **App code / MIME construction.** The message is well-formed: CRLF line
  endings, proper multipart structure, RFC-2047-encoded subjects, aligned From.
  This has been verified in tests (`tests/test_commit2_send_pipeline.py`).
- **`Date` / `Message-ID` headers.** Google adds these itself on send; the app
  intentionally doesn't set them (setting our own would risk duplicates).
- **Your Railway host's IP reputation.** Mail never touches the Railway box —
  it's sent via Google's outbound infrastructure using the user's OAuth token.

---

## One-line summary

You send as a Workspace user through Gmail's API, so **inbox placement is a DNS
and reputation problem, not a code problem** — enable domain-aligned DKIM,
confirm SPF, publish DMARC, and verify with *Show original*. The app's job is to
produce a clean, well-authenticated message, which it does.
