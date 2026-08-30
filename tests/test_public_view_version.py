"""The public share views learning that their document moved.

A client can sit on a quote for an hour while it is re-priced underneath them,
and without this the first they would know is accepting terms they never read.
A crew member can sit on a request while the call time moves and turn up at the
wrong hour. Neither page has a session, so none of the app's live sync reaches
them; they poll GET /api/view/{token}/version and GET /api/crew/{token}/version
instead.

The load-bearing test here is test_another_viewer_opening_does_not_look_like_a_change.
The obvious implementation — compare the row's updated_at — is wrong in exactly
that case: opening the document appends a tracking entry to entity.activity, so
every other viewer's open would tell this one their document had changed when
nothing they can see did. A banner that cries wolf is worse than no banner.

Under pytest this shares the session-wide DB from tests/conftest.py.
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_viewver.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

_db_path = os.path.join(_root, "_test_viewver.db")
if os.environ["DATABASE_URL"].endswith("_test_viewver.db") and os.path.exists(_db_path):
    os.remove(_db_path)

from backend import livesync, models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402

# Ids kept clear of the other modules' ranges — they share one DB under pytest.
U_SUB = "viewver-admin-sub"
_TOK = "viewver-admin-session"
CO = 6801
QUOTE = 6802
INVOICE = 6803
CONTACT = 6804
PROJECT = 6805
CREWREQ = 6806
Q_SHARE = "viewver-quote-share-token"
I_SHARE = "viewver-invoice-share-token"
C_TOKEN = "viewver-crew-request-token"
POS = "vv-pos-1"

_client = None
_seeded = False


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _setup():
    global _client, _seeded
    if _client is None:
        from fastapi.testclient import TestClient
        from backend.main import app
        _client = TestClient(app)
        _client.__enter__()

    if not _seeded:
        from backend.database import async_session

        async def seed():
            async with async_session() as db:
                # Idempotent: conftest gives the whole pytest session one shared
                # database, and a module's fixtures are expected to survive
                # accumulation in it. Adding blind collided on the crew request's
                # unique token when the rows were already there.
                async def missing(model, pk):
                    return await db.get(model, pk) is None

                admin = models.User(google_sub=U_SUB, email="viewver-admin@biz.com",
                                    name="Viewver Admin", role="admin")
                db.add(admin)
                await db.flush()
                db.add(models.Session(id=hash_session_token(_TOK), user_id=admin.id,
                                      expires_at=datetime.now(timezone.utc) + timedelta(days=7)))
                if await missing(models.Company, CO):
                    db.add(models.Company(id=CO, name="Acme Co", status="active", is_client=True))
                if await missing(models.Quote, QUOTE):
                    db.add(models.Quote(id=QUOTE, company_id=CO, status="sent",
                                        share_token=Q_SHARE, sections=[], activity=[]))
                if await missing(models.Invoice, INVOICE):
                    db.add(models.Invoice(id=INVOICE, company_id=CO, status="sent",
                                          share_token=I_SHARE, sections=[], activity=[]))
                if await missing(models.Contact, CONTACT):
                    db.add(models.Contact(id=CONTACT, first_name="Pat", last_name="Crew",
                                          email="pat@crew.example", is_crew=True,
                                          crew_status="active"))
                if await missing(models.Project, PROJECT):
                    db.add(models.Project(id=PROJECT, name="Gala", start_date="2026-09-01",
                                          end_date="2026-09-01", schedule=[{
                                              "id": "vv-s1", "title": "Show", "date": "2026-09-01",
                                              "time": "08:00", "endTime": "17:00", "breaks": [],
                                              "positions": [{"id": POS, "role": "", "serviceId": None,
                                                             "crewId": CONTACT, "status": "requested"}],
                                          }]))
                if await missing(models.CrewRequest, CREWREQ):
                    db.add(models.CrewRequest(id=CREWREQ, token=C_TOKEN, project_id=PROJECT,
                                              contact_id=CONTACT, position_ids=[POS],
                                              status="pending"))
                await db.commit()

        _run(seed())
        _seeded = True
    return _client


def _version(client, token):
    r = client.get(f"/api/view/{token}/version")
    assert r.status_code == 200, r.text
    return r.json()


def _view(client, token):
    r = client.get(f"/api/view/{token}")
    assert r.status_code == 200, r.text
    return r.json()


def _edit_quote(client, **fields):
    """Edit the quote the way the app does — an authenticated PUT."""
    ck = {"ltp_session": _TOK}
    cur = client.get(f"/api/quotes/{QUOTE}", cookies=ck).json()
    cur.pop("_rev", None)
    cur.update(fields)
    r = client.put(f"/api/quotes/{QUOTE}", json=cur, cookies=ck)
    assert r.status_code == 200, r.text


# ── The endpoint itself ─────────────────────────────────────────────────────

def test_version_needs_a_real_token():
    client = _setup()
    r = client.get("/api/view/not-a-real-share-token/version")
    assert r.status_code == 404, f"expected 404 for an unknown token, got {r.status_code}"


def test_version_needs_no_session():
    """The token IS the credential — a client has no account to sign in to."""
    client = _setup()
    r = client.get(f"/api/view/{Q_SHARE}/version")
    assert r.status_code == 200, r.text


def test_version_reports_the_document_and_the_shell():
    client = _setup()
    body = _version(client, Q_SHARE)
    assert body["doc"], "a document version is the whole point"
    assert body["app"] == livesync.app_version(), \
        "a public tab has no feed, so this is how it hears about a deploy"


def test_version_is_opaque():
    """It must say 'same' or 'different' and nothing else — no timestamps, no
    row ids, nothing about how often the document is edited."""
    client = _setup()
    doc = _version(client, Q_SHARE)["doc"]
    assert len(doc) == 16 and all(c in "0123456789abcdef" for c in doc), \
        f"expected short hex, got {doc!r}"


def test_the_view_hands_over_its_own_version():
    """So the client has a baseline with no second round trip, and no gap
    between the two in which an edit could slip through unnoticed."""
    client = _setup()
    payload = _view(client, Q_SHARE)
    assert payload["_v"] == _version(client, Q_SHARE)["doc"], \
        "the page and the poll must agree, or the first poll always cries wolf"


def test_both_kinds_are_covered():
    client = _setup()
    assert _version(client, I_SHARE)["doc"], "invoices are shared the same way"
    assert _version(client, I_SHARE)["doc"] != _version(client, Q_SHARE)["doc"], \
        "two different documents must not hash alike"


# ── Stability: it must not move on its own ──────────────────────────────────

def test_reading_it_twice_reports_the_same_version():
    client = _setup()
    assert _version(client, Q_SHARE)["doc"] == _version(client, Q_SHARE)["doc"], \
        "a poll that moves the version would banner every single tick"


def test_another_viewer_opening_does_not_look_like_a_change():
    """THE false positive this design exists to avoid.

    Opening the document appends a tracking entry to entity.activity — so the
    row's updated_at moves on every open. Had the version been based on that,
    a second client opening the same quote would tell the first one their
    document had changed when not one thing they can see did.
    """
    client = _setup()
    before = _version(client, Q_SHARE)["doc"]
    _view(client, Q_SHARE)          # somebody else opens it — twice
    _view(client, Q_SHARE)
    assert _version(client, Q_SHARE)["doc"] == before, \
        "another viewer's open must not look like an edit"


def test_polling_does_not_stamp_a_view():
    """A poll is not a view. Stamping one would fill the activity feed with
    opens that never happened and re-notify the sender every minute a tab is
    left open."""
    client = _setup()
    ck = {"ltp_session": _TOK}
    before = len(client.get(f"/api/quotes/{QUOTE}", cookies=ck).json().get("activity") or [])
    for _ in range(5):
        _version(client, Q_SHARE)
    after = len(client.get(f"/api/quotes/{QUOTE}", cookies=ck).json().get("activity") or [])
    assert after == before, f"polling added {after - before} activity entries"


# ── Sensitivity: it must move when the client's page would ──────────────────

def test_repricing_the_quote_moves_the_version():
    """The case in the report: a client sits on a quote that gets re-priced."""
    client = _setup()
    before = _version(client, Q_SHARE)["doc"]
    _edit_quote(client, sections=[{
        "id": "s1", "label": "Lighting", "items": [
            {"id": "i1", "name": "Fixture", "qty": 2, "unitPrice": 150, "kind": "equipment"},
        ],
    }])
    assert _version(client, Q_SHARE)["doc"] != before, \
        "a client must not sit on a price that has changed"


def test_a_later_edit_moves_it_again():
    """Once per edit, not just the first — the banner has to keep working."""
    client = _setup()
    first = _version(client, Q_SHARE)["doc"]
    _edit_quote(client, terms="Second revision of the terms.")
    second = _version(client, Q_SHARE)["doc"]
    assert second != first, "a change to the terms is a change to the page"
    _edit_quote(client, terms="Third revision of the terms.")
    assert _version(client, Q_SHARE)["doc"] not in (first, second)


def test_changing_the_terms_moves_it():
    """Terms are what an Accept binds the client to."""
    client = _setup()
    before = _version(client, Q_SHARE)["doc"]
    _edit_quote(client, terms="Payment due on receipt. Deposit non-refundable.")
    assert _version(client, Q_SHARE)["doc"] != before


def test_a_change_the_client_cannot_see_does_not_move_it():
    """`notes` is an internal column — stripped by the _PUBLIC_ENTITY_KEYS
    allow-list and never sent to a share-link holder. Editing one must not send
    a client back to re-read a document that looks identical to them, or the
    banner becomes noise and stops being read."""
    client = _setup()
    before = _version(client, Q_SHARE)["doc"]
    _edit_quote(client, notes="an internal note the client never receives")
    assert _version(client, Q_SHARE)["doc"] == before, \
        "only what the client can SEE should send them back to look again"
    # And prove the premise rather than trusting it: if `notes` ever became
    # public, the assertion above would be silently vacuous.
    assert "notes" not in _view(client, Q_SHARE)["entity"], \
        "notes reached a share-link holder — this test's premise has changed"


# ── The crew request share view ─────────────────────────────────────────────
#
# Same exposure, different hazard: a crew member who does not notice a retimed
# call turns up at the wrong hour.
#
# The wrinkle here is that GET /api/crew/{token} HEALS a stale request on read —
# crew_integrity.reconcile_one writes. Leaving that out of the version path
# would be worse than the write it avoids: the poll would hash the unhealed
# request while the page held the healed one, so they would differ on the very
# first tick and never converge. Both paths run it, through one shared builder.


def _crew_version(client):
    r = client.get(f"/api/crew/{C_TOKEN}/version")
    assert r.status_code == 200, r.text
    return r.json()


def _crew_view(client):
    r = client.get(f"/api/crew/{C_TOKEN}")
    assert r.status_code == 200, r.text
    return r.json()


def _edit_project(client, schedule):
    ck = {"ltp_session": _TOK}
    cur = client.get(f"/api/projects/{PROJECT}", cookies=ck).json()
    cur.pop("_rev", None)
    cur["schedule"] = schedule
    r = client.put(f"/api/projects/{PROJECT}", json=cur, cookies=ck)
    assert r.status_code == 200, r.text


def _shift(time="08:00", end="17:00", title="Show"):
    return [{"id": "vv-s1", "title": title, "date": "2026-09-01", "time": time,
             "endTime": end, "breaks": [],
             "positions": [{"id": POS, "role": "", "serviceId": None,
                            "crewId": CONTACT, "status": "requested"}]}]


def test_crew_version_needs_a_real_token():
    client = _setup()
    r = client.get("/api/crew/not-a-real-crew-token/version")
    assert r.status_code == 404


def test_crew_version_needs_no_session():
    client = _setup()
    assert client.get(f"/api/crew/{C_TOKEN}/version").status_code == 200


def test_crew_view_and_version_agree():
    """They must be built from the same bytes, reconcile included, or the page
    disagrees with its own poll from the first tick onwards."""
    client = _setup()
    assert _crew_view(client)["_v"] == _crew_version(client)["doc"]


def test_crew_version_reports_the_shell_too():
    client = _setup()
    assert _crew_version(client)["app"] == livesync.app_version()


def test_crew_version_is_stable_when_nothing_changes():
    client = _setup()
    assert _crew_version(client)["doc"] == _crew_version(client)["doc"]
    _crew_view(client)      # the crew member re-reads their own page
    assert _crew_view(client)["_v"] == _crew_version(client)["doc"], \
        "reading the request must not look like a change to it"


def test_retiming_the_shift_moves_the_crew_version():
    """The call time moving is the whole reason this exists."""
    client = _setup()
    before = _crew_version(client)["doc"]
    _edit_project(client, _shift(time="06:00"))
    assert _crew_version(client)["doc"] != before, \
        "a crew member must not turn up for a call time that changed"


def test_renaming_the_shift_moves_it_too():
    client = _setup()
    before = _crew_version(client)["doc"]
    _edit_project(client, _shift(time="06:00", title="Load In"))
    assert _crew_version(client)["doc"] != before


def test_withdrawing_the_request_moves_it():
    client = _setup()
    before = _crew_version(client)["doc"]
    ck = {"ltp_session": _TOK}
    r = client.post(f"/api/crew-requests/{CREWREQ}/withdraw", cookies=ck)
    assert r.status_code in (200, 204), r.text
    assert _crew_version(client)["doc"] != before, \
        "being stood down is the most important thing to notice"
