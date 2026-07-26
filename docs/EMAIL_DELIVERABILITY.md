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

## Verified status (mail-tester, July 2026)

A mail-tester.com run on a real send scored **clean** and, importantly, ruled
out the usual suspects:

- ✅ **SPF pass** — `v=spf1 include:_spf.google.com ~all` present and matched.
- ✅ **DKIM valid AND aligned** to `luminarytechnology.productions`
  (`DKIM_VALID_AU`) — this is the strong one; it means DKIM is properly enabled
  in Workspace, not signing as `gappssmtp.com`.
- ✅ **DMARC pass**, valid rDNS, correct MX.
- ✅ **Not on any of 23 blocklists**; SpamAssassin content score **0.2** (clean).

**So authentication is already done right** — don't go chasing DKIM/SPF/DMARC;
they pass. Re-verify with *Show original* only if something changes. The
remaining levers are the two below.

## What the report flagged (and what we did)

1. **Broken image in the signature (fixed in code).** The signature's fallback
   avatar pointed at `www.luminarytechnology.productions/wp-content/uploads/
   2024/07/LTP-Logo-Stacked.png`, which now **404s**. Every email from a sender
   without a Google profile photo carried a broken image — unprofessional, and
   a scored deliverability penalty (mail-tester: `1 broken link`). It's now a
   **self-hosted** asset served by the app (`/assets/logos/ltp-avatar.png`,
   returns 200) so it can't break when the marketing site reorganizes.

2. **Low text-to-HTML ratio (~16% text) — soft signal.** mail-tester notes it
   but SpamAssassin didn't penalize it. Keep body copy substantive (the
   templates already do); avoid turning emails into one big image. See
   *Content best practices* below.

3. **No `List-Unsubscribe` header.** Only matters for *mass* mail; these are 1:1
   transactional sends, so it's optional. See the note below if you add
   newsletters.

## So why does it still hit *some* spam folders?

With authentication clean and content clean, the most likely remaining factor is
**sender / domain reputation** — the domain is relatively young and low-volume,
and reputation is built over time and *per receiver*. Microsoft/Outlook in
particular runs its own reputation system (SmartScreen) that's independent of
SPF/DKIM and of Gmail's. See *Sender reputation & sending habits* below — that's
where to focus next.

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

## Reference: domain authentication (Google Workspace)

> **Your domain already passes all of this** (see *Verified status* above). Keep
> this section as a re-check if you migrate DNS, change providers, or add a new
> sending domain — misconfiguring it here is the classic way to *start* landing
> in spam.

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

## Sender reputation & sending habits (focus here)

With authentication and content clean, **this is the lever that's left.** A young
domain with low volume hasn't earned trust yet, and reputation is tracked
*per receiver* — which is exactly why the same email inboxes for your Gmail
contacts but spams for someone on Outlook.

- **Register with the receivers' postmaster programs.** These show you how each
  provider sees you and let you build/repair standing:
  - **Google Postmaster Tools** (`postmaster.google.com`) — verify the domain;
    watch reputation, spam rate, and auth pass rates.
  - **Microsoft SNDS + JMRP** (`sendersupport.olc.protection.outlook.com`) —
    Outlook/Hotmail/Office 365 use their own SmartScreen reputation, *separate*
    from your DKIM/SPF/DMARC. If "some people" are on Outlook, this is likely
    your gap. Enroll and, if needed, submit a sender-support/mitigation request.
- **Ask early recipients to help train the filter.** For the clients whose spam
  folder you're landing in: have them click **"Not spam"**, move the message to
  the inbox, and **add the sender to their contacts**. A few positive
  engagement signals per recipient domain move the needle fast on a young domain.
- **Warm up gradually.** Don't jump from zero to 25-recipient blasts. Ramp
  volume over days/weeks so receivers see a steady, human pattern.
- **Keep complaint rate low.** Google wants spam complaints **below 0.1%** and
  effectively requires **under 0.3%**. One "Report spam" per few hundred sends
  hurts — only send to people expecting it.
- **Send to valid addresses.** High bounce rates (typos, dead mailboxes) tank
  reputation. The app validates recipient *syntax*
  (`backend/email_validate.py`), but that can't catch a well-formed address that
  doesn't exist — double-check client addresses.
- **Encourage replies / threading.** Real back-and-forth with a recipient is one
  of the strongest positive signals; a client who has ever replied to you rarely
  sees your later mail in spam.
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
- **Third-party images = broken-image risk.** The signature avatar fallback is
  now self-hosted (fixed), but the default signature still loads social icons
  from `storage.googleapis.com/signaturesatori/…`. Those currently return 200,
  but any third-party asset that 404s later puts a broken image back in every
  signature. When convenient, host the signature icons on your own domain too.
- **Test after template edits.** Run an edited template through mail-tester
  before sending it to real clients — and watch the "broken links" section, which
  is what caught the 404 avatar.

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

Your authentication (SPF/DKIM/DMARC) is already correct and your content is
clean, so **inbox placement is now a reputation problem, not a config or code
problem.** We fixed the one concrete defect (a 404 signature image); the path
from here is enrolling in Google Postmaster Tools + Microsoft SNDS/JMRP, warming
up volume, and getting a few recipients to click "Not spam" / add you to
contacts so your young domain earns trust per receiver.
