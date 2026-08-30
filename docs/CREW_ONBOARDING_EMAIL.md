# Crew Announcement Email — the new request flow

Ready-to-send announcement for LTP crew explaining how job requests now
arrive and how to accept a shift. Crew-facing only: no producer-side or
internal detail.

## Files

| File | What it is |
|---|---|
| `assets/crew-email/announcement.html` | The email as a standalone page, inline-styled for Gmail. Served publicly (see below); also the paste source — open it, Select All, Copy, paste into Gmail's compose window. |
| `docs/CREW_ONBOARDING_EMAIL.md` | This file — the plain-text version below. |
| `assets/crew-email/*.jpg` | The three screenshots, served publicly by the app. |

## Public page

The same file is served as a standalone page, for crew whose mail client
mangles or blocks the email:

    https://app.luminarytechnology.productions/assets/crew-email/announcement.html

`.html` is allow-listed for `assets/crew-email/` **only** — see
`backend/main.py::_ALLOWED_TREES`, scoped the same way `assets/vendor/` is for
`.js`/`.wasm`. Anywhere else, a `.html` request falls through to the SPA
fallback, which returns 200 with `index.html` and reads as a hit; that is the
trap `tests/test_static_serving.py` pins by asserting the page's own content
rather than a status code.

Note the published Claude artifact carries its own copy of this markup for its
"Copy email for Gmail" button — if the email body changes, update both.

## Hosted images

The email references its screenshots by URL rather than embedding them, so
the message stays a few KB and Gmail never clips it. They live in the
`assets/` tree, which `backend/main.py::_ALLOWED_TREES` serves publicly and
unauthenticated:

- `https://app.luminarytechnology.productions/assets/crew-email/01-request-email.jpg`
- `https://app.luminarytechnology.productions/assets/crew-email/02-call-sheet-respond.jpg`
- `https://app.luminarytechnology.productions/assets/crew-email/03-confirmed.jpg`
- `https://app.luminarytechnology.productions/assets/logos/luminary-masthead.png` (existing)

**These files must stay deployed** — deleting or renaming them breaks the
images in every copy of the email already sent. HTTPS is required: mail
clients and browsers block or flag plain-http images.

Screenshots are live captures of `modules/crew-view.js` and the rendered
`crewRequest` email from `backend/routes/crew.py`, against seeded demo data
(project "Autumn Summit 2026", crew member "Jordan Reyes"). JPEG, because
WebP is unsupported in Outlook desktop. The venue map embed is omitted from
the captures — it needs outbound network the capture sandbox lacks.

---

Subject: How we'll send you crew requests from now on

Hi everyone,

A quick heads-up about a change on our end that affects how you'll hear from us about work.

From now on, every crew request from Luminary goes out through our new scheduling system instead of a scattered mix of texts, calls, and one-off emails. You get a proper call sheet for every job, you can take it or pass on it in a couple of taps, and once you're booked the details stay in your pocket.

There's nothing for you to install. No app to download, no account to create, no password to remember. It all works from a link in your email — on your phone or your computer.


1. THE REQUEST ARRIVES BY EMAIL

You'll get an email from us with a subject line like "Crew request: Autumn Summit 2026 — Luminary Technology & Productions."

It lists the project, the location, and every call we're asking you to cover — date, call time, wrap time, and your role. If a producer has left a note on a shift (parking, gate code, wardrobe, catering), that's in there too.

There's one button: View & Respond.

[SCREENSHOT 1 — the request email]


2. THE BUTTON OPENS YOUR CALL SHEET

The link takes you to a page showing only your calls for that job — the project, the venue with a map to the address, and each shift laid out in order with its times, your role, and any notes.

Read it before you answer. Everything we know about the call is on that page, and it stays there for you to come back to.


3. ANSWER WITH ONE OF TWO OPTIONS

At the bottom of the call sheet:

  • Accept These Calls — you're taking every shift on that request.
  • I Can't Make It — you're passing on it.

Either way, you can leave a short note before you submit. Please use it — that note comes straight back to us.

If you can only do part of it: a request covers all the calls listed on it as one block, so you can't accept some and decline others on the same page. Choose "I Can't Make It" and say in the note which days do work — something like "Can't do the Saturday load-in, but Friday and Sunday are fine." We'll read it and usually send a fresh request for just those days. Replying to the email works too.

[SCREENSHOT 2 — your call sheet, with the two buttons and the note]


4. ACCEPTING IS NOT THE SAME AS BEING BOOKED

This is the one worth remembering.

When you accept, you're pencilled in — the page will say "Awaiting confirmation." A producer still has to confirm you. Once they do, you'll get a separate confirmation email and your call sheet flips to "You're confirmed."

Please don't treat a job as locked until you see that confirmation. Until then, the page tells you exactly where you stand.


5. ONCE YOU'RE CONFIRMED, PUT IT IN YOUR CALENDAR

The confirmed call sheet gives you an "Add to Calendar" button for each call. One tap drops the date, times, role, location, and any notes straight into your own calendar — so you've got the details even with no signal at the loading dock.

[SCREENSHOT 3 — the confirmed call sheet with Add to Calendar]


A FEW THINGS WORTH KNOWING

  • Your link is yours. It opens your call sheet without a password, so please don't forward it — anyone holding it could answer in your place.

  • Your answer locks once you submit it. If something changes afterwards, reply to the email or call us and we'll sort it out on our end.

  • Other updates come the same way. If a call time moves, a note gets added to your shift, or a booking has to be cancelled, you'll get an email spelling out exactly which shifts changed.

  • Already sorted it by phone or text? Then we may book you directly, and you won't get a request email to answer for that one.

  • Keep your contact details current. Requests go to the email address we have on file — if yours has changed, let us know.


Questions or problems — come straight to me. If anything about the new system is unclear, or something doesn't work right — a link that won't open, an email that never showed up, a shift that looks wrong — contact me directly at (972) 849-5202 or Landry@LuminaryTechnology.Productions. I'd much rather hear about it early than have anyone miss a call over it.

Thanks, all. Looking forward to getting you out on more shows.

Landry Strickland
Owner
Luminary Technology & Productions
(972) 849-5202 · Landry@LuminaryTechnology.Productions
LuminaryTechnology.Productions
