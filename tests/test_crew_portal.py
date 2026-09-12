"""Crew portal — the crew member's own sign-in and dashboard.

Covers backend/routes/crew_portal.py + backend/crew_auth.py end to end:

  - invitation → signup → sign-in, with the link spent on use
  - the two credential systems stay apart: a crew cookie reaches no staff
    route, a staff cookie reaches no crew route
  - password policy, per-account lockout, generic wrong-credential answers
  - the dashboard is scoped to the signed-in crew member — never another
    member's calls, requests, tokens or pay
  - responding from the dashboard drives the same state machine as the call
    sheet, and only for the member's own request
  - forgot / reset / request-access: generic responses, session revocation,
    the per-contact cool-down
  - the staff off-switch revokes sessions and blocks sign-in
  - the invitation / reset emails render from the workspace templates and the
    server fallbacks match data/settings.js byte-for-byte
  - expired sessions and links are swept

Each test owns its own contacts/projects so the tests are order-independent.
Under pytest the module shares the session-wide DB from tests/conftest.py; run
as a plain script it uses its own DATABASE_URL (the setdefault below).
"""
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

import pytest
from cryptography.fernet import Fernet

os.environ.setdefault("LTP_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
os.environ.setdefault("LTP_OAUTH_REDIRECT_URI", "https://ltp.example.com/auth/callback")
os.environ.setdefault("LTP_SESSION_SECRET", "test-session-secret-" + "x" * 40)
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./_test_crew_portal.db")

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
if _root not in sys.path:
    sys.path.insert(0, _root)

_db_path = os.path.join(_root, "_test_crew_portal.db")
if os.path.exists(_db_path) and "_test_crew_portal" in os.environ.get("DATABASE_URL", ""):
    os.remove(_db_path)

from backend import crew_auth, models  # noqa: E402
from backend.auth_deps import hash_session_token  # noqa: E402


# ── Seeded fixture IDs (unique to this module) ───────────────────────────────
C_A = 9101      # crew, has email — the main subject
C_B = 9102      # crew, has email — the OTHER crew member (scoping)
C_NOMAIL = 9103 # crew, no email
C_CLIENT = 9104 # not crew
C_INACT = 9105  # crew but inactive
C_LOCK = 9106   # crew — lockout test
C_FORGOT = 9107 # crew — forgot/reset flow
C_ACCESS = 9108 # crew — request-access flow
C_OFF = 9109    # crew — disable/enable
C_PW = 9110     # crew — change password / phone
C_GUARD = 9111  # crew — invite guards (already active)
S1 = 8101       # service L1

P_DASH = 7101   # A and B share this project
P_PAY = 7102    # A's signed-off day in the past
P_RESP = 7103   # respond-from-dashboard
P_FLAT = 7104   # a flat-rate position for A
P_LINK = 7105   # crew-domain links: a request for B

_ADMIN_TOK = "crew-portal-admin"
_MEMBER_TOK = "crew-portal-member"
_client = None
_seeded = False
SENT = []       # every mocked gmail.send call, newest last


def _setup():
    global _client, _seeded
    if _client is None:
        from fastapi.testclient import TestClient
        from backend.main import app
        _client = TestClient(app)
        _client.__enter__()

    if not _seeded:
        from backend.database import async_session

        def _pos(pid, crew, status="open", **extra):
            d = {"id": pid, "role": "L1", "serviceId": S1, "crewId": crew, "status": status}
            d.update(extra)
            return d

        def _shift(sid, title, date, positions, time="08:00", end="18:00"):
            return {"id": sid, "title": title, "date": date, "time": time, "endTime": end, "positions": positions}

        async def seed():
            now = datetime.now(timezone.utc)
            async with async_session() as db:
                admin = models.User(google_sub="cp-admin-sub", email="cp-admin@biz.com", name="Portal Admin",
                                    role="admin", gmail_refresh_token="enc-refresh", last_login=now)
                member = models.User(google_sub="cp-member-sub", email="cp-member@biz.com", name="Portal Member",
                                     role="member", gmail_refresh_token="enc-refresh", last_login=now)
                db.add_all([admin, member])
                await db.flush()
                db.add(models.Session(id=hash_session_token(_ADMIN_TOK), user_id=admin.id, expires_at=now + timedelta(days=7)))
                db.add(models.Session(id=hash_session_token(_MEMBER_TOK), user_id=member.id, expires_at=now + timedelta(days=7)))

                db.add(models.Contact(id=C_A, first_name="Avery", last_name="Alpha", email="Avery@Crew.com", is_crew=True, crew_status="active", crew_roles=["L1"], crew_departments=["Lighting"]))
                db.add(models.Contact(id=C_B, first_name="Blake", last_name="Bravo", email="blake@crew.com", is_crew=True, crew_status="active"))
                db.add(models.Contact(id=C_NOMAIL, first_name="No", last_name="Mail", email="", is_crew=True, crew_status="active"))
                db.add(models.Contact(id=C_CLIENT, first_name="Client", last_name="Person", email="client@co.com", is_crew=False))
                db.add(models.Contact(id=C_INACT, first_name="Ina", last_name="Ctive", email="ina@crew.com", is_crew=True, crew_status="inactive"))
                db.add(models.Contact(id=C_LOCK, first_name="Lock", last_name="Out", email="lock@crew.com", is_crew=True, crew_status="active"))
                db.add(models.Contact(id=C_FORGOT, first_name="Fay", last_name="Forgot", email="fay@crew.com", is_crew=True, crew_status="active"))
                db.add(models.Contact(id=C_ACCESS, first_name="Ace", last_name="Access", email="ace@crew.com", is_crew=True, crew_status="active"))
                db.add(models.Contact(id=C_OFF, first_name="Ollie", last_name="Off", email="ollie@crew.com", is_crew=True, crew_status="active"))
                db.add(models.Contact(id=C_PW, first_name="Pat", last_name="Password", email="pat@crew.com", is_crew=True, crew_status="active"))
                db.add(models.Contact(id=C_GUARD, first_name="Gus", last_name="Guard", email="gus@crew.com", is_crew=True, crew_status="active"))
                db.add(models.Service(id=S1, role="L1", description="Lead Lighting Tech", department="Lighting"))

                db.add(models.Project(id=P_DASH, name="Portal Gala", venue="Grand Hall",
                                      site_address="1 Main St, Dallas, TX", start_date="2027-03-10", end_date="2027-03-11", schedule=[
                    _shift("cpd1", "Load In", "2027-03-10", [_pos("cpd_a1", C_A, status="confirmed", pay={"total": 400, "lockedAt": "x"}),
                                                            _pos("cpd_b1", C_B, status="confirmed")]),
                    _shift("cpd2", "Show", "2027-03-11", [_pos("cpd_a2", C_A, status="open")]),
                ]))
                db.add(models.Project(id=P_PAY, name="Portal Past", start_date="2026-09-01", end_date="2026-09-01", schedule=[
                    _shift("cpp1", "Show", "2026-09-01", [
                        _pos("cpp_a", C_A, status="confirmed", pay={"total": 400, "lockedAt": "x"},
                             work={"state": "worked", "signedAt": "2026-09-01T20:00:00", "signedBy": "Portal Admin",
                                   "pay": {"total": 420, "tier": "day", "paidHours": 10, "otHours": 0,
                                           "units": [{"serviceId": S1, "total": 420}]}},
                             adj=[{"label": "Parking", "amount": 12.5}]),
                        _pos("cpp_b", C_B, status="confirmed",
                             work={"state": "worked", "pay": {"total": 999, "tier": "day", "units": [{"serviceId": S1, "total": 999}]}}),
                    ]),
                ]))
                db.add(models.Project(id=P_RESP, name="Portal Respond", schedule=[
                    _shift("cpr1", "Show", "2027-04-01", [_pos("cpr_a", C_A), _pos("cpr_b", C_B)]),
                ]))
                db.add(models.Project(id=P_LINK, name="Portal Link", schedule=[
                    _shift("cpl1", "Show", "2027-06-01", [_pos("cpl_b", C_B)]),
                ]))
                db.add(models.Project(id=P_FLAT, name="Portal Flat", start_date="2027-05-01", end_date="2027-05-03",
                                      fixed_positions=[{"id": "cpf_a", "serviceId": S1, "role": "L1", "crewId": C_A,
                                                        "status": "confirmed", "fee": 1500, "bill": 2000, "note": "Design the rig"}],
                                      schedule=[_shift("cpf1", "Focus", "2027-05-02", [])]))
                await db.commit()

        asyncio.run(seed())
        _seeded = True
    return _client, _ADMIN_TOK


# ── Helpers ─────────────────────────────────────────────────────────────────

async def _fake_send(**kwargs):
    SENT.append(kwargs)
    return {"id": "msg-" + str(len(SENT))}


@pytest.fixture(autouse=True)
def _mock_gmail():
    """Capture every outbound email instead of calling Gmail. Scoped per test
    and restored afterwards — a module-level swap would leak into
    test_crew_requests.py, whose reconnect test needs the real sender."""
    import backend.gmail as gmailmod
    orig = gmailmod.send
    gmailmod.send = _fake_send
    yield
    gmailmod.send = orig


@pytest.fixture(autouse=True)
def _fresh_rate_limit_window():
    """This module signs in, guesses wrong and asks for links dozens of times
    from one client IP — far past the per-IP bucket on the sign-in surface
    (backend/rate_limit.py), which is a production property, not what these
    tests measure. Start every test with empty counters."""
    from backend.rate_limit import _state
    _state._counts.clear()
    yield
    _state._counts.clear()


def _staff(tok=None):
    return {"ltp_session": tok or _ADMIN_TOK}


def _invite(client, contact_id, tok=None):
    return client.post(f"/api/crew-portal/accounts/{contact_id}/invite", cookies=_staff(tok))


def _link_token(kind, html=None):
    """The one-time token out of the last mocked email (or a given body)."""
    body = html if html is not None else SENT[-1]["html_body"]
    m = re.search(r"crew-portal/" + kind + r"/([A-Za-z0-9_\-]+)", body)
    assert m, "no " + kind + " link in the email"
    return m.group(1)


def _signup(client, contact_id, password, tok=None):
    """Invite + accept for a contact; returns (crew cookie, me payload)."""
    r = _invite(client, contact_id, tok)
    assert r.status_code == 200, r.text
    token = _link_token("signup")
    r = client.post("/api/crew-portal/auth/signup", json={"token": token, "password": password})
    assert r.status_code == 200, r.text
    cookie = r.cookies.get("ltp_crew_session")
    assert cookie
    return cookie, r.json()


def _login(client, email, password):
    return client.post("/api/crew-portal/auth/login", json={"email": email, "password": password})


def _crew(cookie):
    return {"ltp_crew_session": cookie}


def _a_cookie(client):
    """A signed-in session for Avery (C_A), signing them up first if the
    invitation test hasn't run yet — so every test that reads as Avery works
    on its own."""
    r = _login(client, "avery@crew.com", "correct horse battery")
    if r.status_code == 200:
        return r.cookies["ltp_crew_session"]
    cookie, _me = _signup(client, C_A, "correct horse battery")
    return cookie


def _dash(client, cookie, today="2027-03-01"):
    r = client.get("/api/crew-portal/dashboard?today=" + today, cookies=_crew(cookie))
    assert r.status_code == 200, r.text
    return r.json()


# ── Credentials ─────────────────────────────────────────────────────────────

def test_password_hashing_roundtrip_and_policy():
    stored = crew_auth.hash_password("correct horse battery")
    assert stored.startswith("scrypt$") and stored.count("$") == 5
    assert crew_auth.verify_password("correct horse battery", stored)
    assert not crew_auth.verify_password("Correct horse battery", stored)
    assert not crew_auth.verify_password("", stored)
    assert not crew_auth.verify_password("x", "")               # never-set password never verifies
    assert not crew_auth.verify_password("x", "garbage$$")
    assert crew_auth.hash_password("same") != crew_auth.hash_password("same")   # fresh salt each time
    assert not crew_auth.needs_rehash(stored)
    assert crew_auth.needs_rehash("scrypt$1024$8$1$c2FsdA$aGFzaA")     # weaker cost → re-hash on next login
    assert crew_auth.password_problem("short") is not None
    assert crew_auth.password_problem("        ") is not None
    assert crew_auth.password_problem("x" * 129) is not None
    assert crew_auth.password_problem("me@crew.com", "ME@crew.com") is not None
    assert crew_auth.password_problem("a fine passphrase") is None
    raw, digest = crew_auth.mint_token()
    assert len(raw) >= 32 and digest == crew_auth.hash_token(raw) and len(digest) == 64


def test_rate_limit_rules_cover_the_portal():
    from backend.rate_limit import _match_rule
    assert _match_rule("/api/crew-portal/auth/login") == ("/api/crew-portal/auth", 30)
    assert _match_rule("/api/crew-portal/auth/forgot") == ("/api/crew-portal/auth", 30)
    assert _match_rule("/api/crew-portal/auth/signup") == ("/api/crew-portal/auth", 30)
    # The cookie probe every page load makes is not a credential guess.
    assert _match_rule("/api/crew-portal/auth/me") == ("/api/crew-portal/auth/me", 120)
    assert _match_rule("/api/crew-portal/auth/logout")[1] == 120
    assert _match_rule("/api/crew-portal/dashboard")[0] == "/api/crew-portal"
    assert _match_rule("/api/crew-portal/accounts/5/invite")[0] == "/api/crew-portal"
    # The neighbours keep their own buckets.
    assert _match_rule("/api/crew/sometoken")[0] == "/api/crew"
    assert _match_rule("/api/crew-requests") is None


# ── Invitation → signup → sign-in ───────────────────────────────────────────

def test_invite_signup_login_and_cookie_separation():
    client, tok = _setup()
    before = len(SENT)
    r = client.get("/api/crew-portal/accounts", cookies=_staff())
    assert r.status_code == 200
    assert not any(a["contactId"] == C_A for a in r.json())

    r = _invite(client, C_A)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "invited" and body["email"] == "avery@crew.com"
    assert body["emailStatus"]["emailed"] is True and body["emailStatus"]["to"] == "avery@crew.com"
    assert "inviteUrl" not in body                    # the link is only handed over when mail failed
    assert len(SENT) == before + 1
    mail = SENT[-1]
    assert mail["to"] == ["avery@crew.com"]
    assert "crew portal" in mail["subject"].lower()
    assert "Set Up My Account" in mail["html_body"]
    token = _link_token("signup")
    assert "ltp.example.com/#/crew-portal/signup/" + token in mail["html_body"]
    assert len(token) >= 32

    # The roster now says invited.
    r = client.get("/api/crew-portal/accounts", cookies=_staff())
    row = next(a for a in r.json() if a["contactId"] == C_A)
    assert row["status"] == "invited" and row["inviteExpiresAt"]

    # The link describes who it is for, without a session.
    r = client.get("/api/crew-portal/auth/token/" + token)
    assert r.status_code == 200
    d = r.json()
    assert d["kind"] == "invite" and d["valid"] is True and d["email"] == "avery@crew.com" and d["firstName"] == "Avery"
    assert client.get("/api/crew-portal/auth/token/not-a-real-token-at-all").status_code == 404

    # Policy is enforced at signup.
    r = client.post("/api/crew-portal/auth/signup", json={"token": token, "password": "short"})
    assert r.status_code == 400 and r.json()["detail"]["field"] == "password"
    r = client.post("/api/crew-portal/auth/signup", json={"token": token, "password": "avery@crew.com"})
    assert r.status_code == 400

    r = client.post("/api/crew-portal/auth/signup", json={"token": token, "password": "correct horse battery"})
    assert r.status_code == 200, r.text
    me = r.json()
    assert me["contactId"] == C_A and me["email"] == "avery@crew.com" and me["name"] == "Avery Alpha"
    assert me["roles"] == ["L1"] and me["departments"] == ["Lighting"]
    cookie = r.cookies.get("ltp_crew_session")
    assert cookie and len(cookie) >= 48
    # Set-Cookie is HttpOnly + SameSite (Secure follows the https redirect URI).
    set_cookie = r.headers.get("set-cookie", "")
    assert "HttpOnly" in set_cookie and "SameSite=lax" in set_cookie.lower().replace("samesite=lax", "SameSite=lax")

    # The link is spent.
    r = client.post("/api/crew-portal/auth/signup", json={"token": token, "password": "another fine password"})
    assert r.status_code == 410 and r.json()["detail"]["reason"] == "used"
    r = client.get("/api/crew-portal/auth/token/" + token)
    assert r.status_code == 200 and r.json()["valid"] is False and r.json()["reason"] == "used"

    # The crew cookie authenticates the portal and NOTHING else.
    assert client.get("/api/crew-portal/auth/me", cookies=_crew(cookie)).status_code == 200
    assert client.get("/api/crew-portal/me", cookies=_crew(cookie)).status_code == 200
    assert client.get("/api/contacts", cookies=_crew(cookie)).status_code == 401
    assert client.get("/api/projects", cookies=_crew(cookie)).status_code == 401
    assert client.get("/api/crew-requests", cookies=_crew(cookie)).status_code == 401
    assert client.get("/auth/me", cookies=_crew(cookie)).status_code == 401
    # …and the staff cookie is not a crew session.
    assert client.get("/api/crew-portal/me", cookies=_staff()).status_code == 401
    assert client.get("/api/crew-portal/dashboard", cookies=_staff()).status_code == 401
    # No cookie at all → 401, never a redirect or 500.
    assert client.get("/api/crew-portal/dashboard").status_code == 401

    # Sign in with the password (email is case-insensitive).
    r = _login(client, "AVERY@crew.com", "correct horse battery")
    assert r.status_code == 200 and r.json()["contactId"] == C_A
    assert r.cookies.get("ltp_crew_session")

    # The roster now says active, and a second invite is refused.
    r = client.get("/api/crew-portal/accounts", cookies=_staff())
    row = next(a for a in r.json() if a["contactId"] == C_A)
    assert row["status"] == "active" and row["lastLoginAt"]
    r = _invite(client, C_A)
    assert r.status_code == 409 and r.json()["detail"]["reason"] == "already_active"

    # Logout kills the session.
    r = client.post("/api/crew-portal/auth/logout", cookies=_crew(cookie))
    assert r.status_code == 200
    assert client.get("/api/crew-portal/me", cookies=_crew(cookie)).status_code == 401


def test_invite_guards():
    client, tok = _setup()
    r = _invite(client, C_NOMAIL)
    assert r.status_code == 400 and r.json()["detail"]["reason"] == "no_email"
    r = _invite(client, C_CLIENT)
    assert r.status_code == 400 and r.json()["detail"]["reason"] == "not_crew"
    r = _invite(client, C_INACT)
    assert r.status_code == 400 and r.json()["detail"]["reason"] == "inactive"
    assert _invite(client, 424242).status_code == 404
    # A staff session is required (any member can invite; no session cannot).
    assert client.post(f"/api/crew-portal/accounts/{C_B}/invite").status_code == 401
    # A resend retires the earlier link: only the newest one works.
    r1 = _invite(client, C_GUARD)
    assert r1.status_code == 200
    first = _link_token("signup")
    r2 = _invite(client, C_GUARD, _MEMBER_TOK)
    assert r2.status_code == 200
    second = _link_token("signup")
    assert first != second
    r = client.get("/api/crew-portal/auth/token/" + first)
    assert r.status_code == 200 and r.json()["valid"] is False
    r = client.post("/api/crew-portal/auth/signup", json={"token": first, "password": "a fine passphrase"})
    assert r.status_code == 410
    r = client.post("/api/crew-portal/auth/signup", json={"token": second, "password": "a fine passphrase"})
    assert r.status_code == 200
    # Staff reset on an active account emails a reset link, never returns it.
    r = client.post(f"/api/crew-portal/accounts/{C_GUARD}/reset", cookies=_staff())
    assert r.status_code == 200 and r.json()["emailStatus"]["emailed"] is True
    assert "resetUrl" not in r.json() and "inviteUrl" not in r.json()
    assert "Choose a New Password" in SENT[-1]["html_body"]
    # …and a reset for someone with no account points back to inviting.
    r = client.post(f"/api/crew-portal/accounts/{C_B}/reset", cookies=_staff())
    assert r.status_code == 409 and r.json()["detail"]["reason"] == "no_account"


def test_wrong_credentials_are_generic_and_lock_out():
    client, tok = _setup()
    cookie, _me = _signup(client, C_LOCK, "a fine passphrase")
    unknown = _login(client, "nobody@nowhere.com", "whatever pw")
    wrong = _login(client, "lock@crew.com", "wrong password")
    assert unknown.status_code == 401 and wrong.status_code == 401
    assert unknown.json() == wrong.json()          # same body — no account enumeration
    for _ in range(crew_auth.LOCKOUT_ATTEMPTS - 1):
        assert _login(client, "lock@crew.com", "wrong password").status_code == 401
    r = _login(client, "lock@crew.com", "a fine passphrase")   # right password, but locked now
    assert r.status_code == 403 and r.json()["detail"]["reason"] == "locked"
    r = client.get("/api/crew-portal/accounts", cookies=_staff())
    assert next(a for a in r.json() if a["contactId"] == C_LOCK)["lockedUntil"]
    # Missing fields are a 400, not a 500.
    assert client.post("/api/crew-portal/auth/login", json={"email": "", "password": ""}).status_code == 400
    assert client.post("/api/crew-portal/auth/login", json=[1, 2]).status_code in (400, 422)


def test_inactive_crew_cannot_sign_in():
    client, tok = _setup()
    cookie, _me = _signup(client, C_OFF, "a fine passphrase")   # C_OFF is reused by the disable test below
    from backend.database import async_session

    from sqlalchemy import select

    async def flip(status):
        async with async_session() as db:
            c = (await db.execute(select(models.Contact).where(models.Contact.id == C_OFF))).scalar_one()
            c.crew_status = status
            await db.commit()
    asyncio.run(flip("inactive"))
    try:
        assert client.get("/api/crew-portal/me", cookies=_crew(cookie)).status_code == 401
        r = _login(client, "ollie@crew.com", "a fine passphrase")
        assert r.status_code == 403 and r.json()["detail"]["reason"] == "inactive"
    finally:
        asyncio.run(flip("active"))
    assert client.get("/api/crew-portal/me", cookies=_crew(cookie)).status_code == 200


# ── The dashboard ───────────────────────────────────────────────────────────

def test_dashboard_is_scoped_to_the_signed_in_crew_member():
    client, tok = _setup()
    # A crew request for A on the shared project (A's open position), and one
    # for B, so both members have something pending.
    r = client.post("/api/crew-requests/send", json={"projectId": P_DASH, "contactId": C_A, "positionIds": ["cpd_a2"]}, cookies=_staff())
    assert r.status_code == 200, r.text
    a_req = r.json()
    b_req = next((x for x in client.get("/api/crew-requests?projectId=" + str(P_RESP), cookies=_staff()).json()
                  if x["contactId"] == C_B and x["status"] == "pending"), None)
    if b_req is None:
        r = client.post("/api/crew-requests/send", json={"projectId": P_RESP, "contactId": C_B, "positionIds": ["cpr_b"]}, cookies=_staff())
        assert r.status_code == 200, r.text
        b_req = r.json()

    cookie = _a_cookie(client)
    d = _dash(client, cookie, today="2027-03-01")

    assert d["today"] == "2027-03-01"
    assert d["crew"]["contactId"] == C_A
    # Requests: A's pending one only, with its call sheet token; never B's.
    assert [x["id"] for x in d["requests"]] == [a_req["id"]]
    assert d["requests"][0]["token"] == a_req["token"]
    assert d["requests"][0]["projectName"] == "Portal Gala"
    assert d["requests"][0]["askLabel"] == "1 shift"
    assert d["requests"][0]["siteAddress"] == "1 Main St, Dallas, TX"
    blob = json.dumps(d)
    assert b_req["token"] not in blob
    assert "Blake" not in blob and "blake@crew.com" not in blob
    assert "999" not in blob                      # B's pay never appears

    # Upcoming: A's confirmed Load In, A's requested Show, and the flat-rate
    # position — never B's slot on the same shift.
    ups = {(u["positionId"]): u for u in d["upcoming"]}
    assert set(ups) == {"cpd_a1", "cpd_a2", "cpf_a"}, sorted(ups)
    assert ups["cpd_a1"]["status"] == "confirmed" and ups["cpd_a1"]["roleLabel"] == "L1 — Lead Lighting Tech"
    assert ups["cpd_a1"]["startTime"] == "08:00" and ups["cpd_a1"]["venue"] == "Grand Hall"
    assert ups["cpd_a2"]["status"] == "requested" and ups["cpd_a2"]["requestToken"] == a_req["token"]
    assert ups["cpf_a"]["flat"] is True and ups["cpf_a"]["fee"] == 1500 and ups["cpf_a"]["projectDates"]
    assert [u["positionId"] for u in d["upcoming"]][:2] == ["cpd_a1", "cpd_a2"]   # date order
    # Internal fields never leak.
    for u in d["upcoming"]:
        assert "crewId" not in u and "serviceId" not in u and "bill" not in u and "pay" not in u

    # Past: the signed-off day, flagged.
    assert [(p["date"], p["signedOff"]) for p in d["past"]] == []   # 2026-09-01 is outside 45 days of 2027-03-01
    d2 = _dash(client, cookie, today="2026-09-12")
    assert [(p["date"], p["status"], p["signedOff"]) for p in d2["past"]] == [("2026-09-01", "confirmed", True)]

    # Stats.
    assert d["stats"]["pendingRequests"] == 1
    assert d["stats"]["confirmedUpcoming"] == 2 and d["stats"]["requestedUpcoming"] == 1
    assert d["stats"]["nextCall"]["positionId"] == "cpd_a1"

    # Payouts: the signed day (420 + 12.50 adjustment) in its period, A's only;
    # the confirmed-but-unsigned Load In as a pending estimate from its
    # confirm-time snapshot; the flat fee pending on the project's end date.
    pay = d2["payouts"]
    assert pay["configured"] is True
    per = next(p for p in pay["periods"] if p["start"] <= "2026-09-01" <= p["end"])
    assert per["days"] == [{
        "date": "2026-09-01", "projectId": P_PAY, "projectName": "Portal Past", "tier": "day", "state": "worked",
        "payable": 432.5, "adjTotal": 12.5, "adjustments": [{"label": "Parking", "amount": 12.5}],
        "paidHours": 10, "otHours": 0, "flat": False,
    }]
    assert per["signedTotal"] == 432.5 and per["bill"] is None
    assert per["current"] is True and per["payDay"] == "2026-09-18"
    assert [p["current"] for p in pay["periods"]].count(True) == 1
    assert pay["periods"][0]["upcoming"] is True                    # newest first
    pay27 = _dash(client, cookie, today="2027-03-09")["payouts"]
    cur = next(p for p in pay27["periods"] if p["current"])
    assert cur["pending"] == [{"date": "2027-03-10", "projectId": P_DASH, "projectName": "Portal Gala", "estimate": 400.0, "flat": False}]
    assert cur["pendingEstimate"] == 400.0
    flat_period = next(p for p in _dash(client, cookie, today="2027-05-04")["payouts"]["periods"] if p["start"] <= "2027-05-03" <= p["end"])
    assert any(x["flat"] and x["estimate"] == 1500.0 for x in flat_period["pending"])

    # The version endpoint hashes the very same payload.
    r = client.get("/api/crew-portal/dashboard/version?today=2027-03-01", cookies=_crew(cookie))
    assert r.status_code == 200 and r.json()["doc"] == d["_v"] and r.json()["app"]

    # Settings are the public subset only.
    assert "emailTemplates" not in d["settings"] and "companyName" in d["settings"]


def test_respond_from_dashboard_only_for_own_request():
    client, tok = _setup()
    r = client.post("/api/crew-requests/send", json={"projectId": P_RESP, "contactId": C_A, "positionIds": ["cpr_a"]}, cookies=_staff())
    assert r.status_code == 200, r.text
    a_req = r.json()
    # B's pending request on the same project (sent by the dashboard test when
    # it ran first; sent here otherwise, so the tests stay order-independent).
    b_req = next((x for x in client.get("/api/crew-requests?projectId=" + str(P_RESP), cookies=_staff()).json()
                  if x["contactId"] == C_B and x["status"] == "pending"), None)
    if b_req is None:
        r = client.post("/api/crew-requests/send", json={"projectId": P_RESP, "contactId": C_B, "positionIds": ["cpr_b"]}, cookies=_staff())
        assert r.status_code == 200, r.text
        b_req = r.json()

    cookie = _a_cookie(client)
    # Someone else's request: not found, untouched.
    r = client.post(f"/api/crew-portal/requests/{b_req['id']}/respond", json={"decision": "accept"}, cookies=_crew(cookie))
    assert r.status_code == 404
    assert client.post(f"/api/crew-portal/requests/{a_req['id']}/respond", json={"decision": "maybe"}, cookies=_crew(cookie)).status_code == 400
    r = client.post(f"/api/crew-portal/requests/{a_req['id']}/respond", json={"decision": "accept", "comment": "see you there"}, cookies=_crew(cookie))
    assert r.status_code == 200 and r.json() == {"status": "accepted"}
    proj = client.get(f"/api/projects/{P_RESP}", cookies=_staff()).json()
    statuses = {p["id"]: p["status"] for s in proj["schedule"] for p in s["positions"]}
    assert statuses["cpr_a"] == "accepted" and statuses["cpr_b"] == "requested"
    req = next(x for x in client.get("/api/crew-requests?projectId=" + str(P_RESP), cookies=_staff()).json() if x["id"] == a_req["id"])
    assert req["status"] == "accepted" and req["comment"] == "see you there"
    # Locked once answered — same as the call sheet.
    r = client.post(f"/api/crew-portal/requests/{a_req['id']}/respond", json={"decision": "decline"}, cookies=_crew(cookie))
    assert r.status_code == 409
    d = _dash(client, cookie, today="2027-03-01")
    rec = next(x for x in d["recent"] if x["id"] == a_req["id"])
    assert rec["status"] == "accepted" and rec["confirmed"] is False and rec["comment"] == "see you there"
    assert d["stats"]["awaitingConfirmation"] >= 1


# ── Forgot / reset / request access ─────────────────────────────────────────

def test_forgot_and_reset_revoke_sessions_and_throttle():
    client, tok = _setup()
    cookie, _me = _signup(client, C_FORGOT, "a fine passphrase")
    other = _login(client, "fay@crew.com", "a fine passphrase").cookies["ltp_crew_session"]
    before = len(SENT)
    # Unknown address: same answer, no email.
    r = client.post("/api/crew-portal/auth/forgot", json={"email": "nobody@nowhere.com"})
    assert r.status_code == 200 and r.json() == {"ok": True} and len(SENT) == before
    # Known address: a reset email from the system sender.
    r = client.post("/api/crew-portal/auth/forgot", json={"email": "FAY@crew.com"})
    assert r.status_code == 200 and r.json() == {"ok": True} and len(SENT) == before + 1
    assert SENT[-1]["to"] == ["fay@crew.com"] and SENT[-1]["user"].email == "cp-admin@biz.com"
    assert "Choose a New Password" in SENT[-1]["html_body"]
    token = _link_token("reset")
    # Cool-down: asking again straight away sends nothing.
    r = client.post("/api/crew-portal/auth/forgot", json={"email": "fay@crew.com"})
    assert r.status_code == 200 and len(SENT) == before + 1
    r = client.get("/api/crew-portal/auth/token/" + token)
    assert r.json()["kind"] == "reset" and r.json()["valid"] is True
    # A reset token can't be used as an invitation, and vice versa.
    assert client.post("/api/crew-portal/auth/signup", json={"token": token, "password": "brand new passphrase"}).status_code == 404
    r = client.post("/api/crew-portal/auth/reset", json={"token": token, "password": "brand new passphrase"})
    assert r.status_code == 200, r.text
    new_cookie = r.cookies["ltp_crew_session"]
    # Every earlier session is gone; the reset signed them in fresh.
    assert client.get("/api/crew-portal/me", cookies=_crew(cookie)).status_code == 401
    assert client.get("/api/crew-portal/me", cookies=_crew(other)).status_code == 401
    assert client.get("/api/crew-portal/me", cookies=_crew(new_cookie)).status_code == 200
    assert _login(client, "fay@crew.com", "a fine passphrase").status_code == 401
    assert _login(client, "fay@crew.com", "brand new passphrase").status_code == 200
    # The link is spent.
    assert client.post("/api/crew-portal/auth/reset", json={"token": token, "password": "yet another passphrase"}).status_code == 410


def test_request_access_invites_a_roster_email_without_an_account():
    client, tok = _setup()
    before = len(SENT)
    # Not on the roster → nothing, same answer.
    r = client.post("/api/crew-portal/auth/request-access", json={"email": "client@co.com"})
    assert r.status_code == 200 and r.json() == {"ok": True} and len(SENT) == before
    r = client.post("/api/crew-portal/auth/request-access", json={"email": "ina@crew.com"})   # inactive crew
    assert r.status_code == 200 and len(SENT) == before
    # On the roster, no account yet → an invitation.
    r = client.post("/api/crew-portal/auth/request-access", json={"email": "Ace@Crew.com"})
    assert r.status_code == 200 and len(SENT) == before + 1
    assert SENT[-1]["to"] == ["ace@crew.com"] and "Set Up My Account" in SENT[-1]["html_body"]
    token = _link_token("signup")
    r = client.post("/api/crew-portal/auth/signup", json={"token": token, "password": "a fine passphrase"})
    assert r.status_code == 200 and r.json()["contactId"] == C_ACCESS
    row = next(a for a in client.get("/api/crew-portal/accounts", cookies=_staff()).json() if a["contactId"] == C_ACCESS)
    assert row["status"] == "active"


# ── The staff off-switch ────────────────────────────────────────────────────

def test_disable_revokes_sessions_and_enable_restores():
    client, tok = _setup()
    cookie = _login(client, "ollie@crew.com", "a fine passphrase").cookies["ltp_crew_session"]
    assert client.get("/api/crew-portal/me", cookies=_crew(cookie)).status_code == 200
    # Members can't flip the switch; admins can.
    assert client.post(f"/api/crew-portal/accounts/{C_OFF}/disable", cookies=_staff(_MEMBER_TOK)).status_code == 403
    r = client.post(f"/api/crew-portal/accounts/{C_OFF}/disable", cookies=_staff())
    assert r.status_code == 200 and r.json()["status"] == "disabled"
    assert client.get("/api/crew-portal/me", cookies=_crew(cookie)).status_code == 401
    r = _login(client, "ollie@crew.com", "a fine passphrase")
    assert r.status_code == 403 and r.json()["detail"]["reason"] == "disabled"
    # Forgot-password sends nothing for a disabled account.
    n = len(SENT)
    client.post("/api/crew-portal/auth/forgot", json={"email": "ollie@crew.com"})
    assert len(SENT) == n
    r = client.post(f"/api/crew-portal/accounts/{C_OFF}/enable", cookies=_staff())
    assert r.status_code == 200 and r.json()["status"] == "active"
    assert _login(client, "ollie@crew.com", "a fine passphrase").status_code == 200


def test_change_password_and_phone():
    client, tok = _setup()
    cookie, me = _signup(client, C_PW, "a fine passphrase")
    other = _login(client, "pat@crew.com", "a fine passphrase").cookies["ltp_crew_session"]
    r = client.post("/api/crew-portal/auth/change-password", json={"currentPassword": "nope nope", "newPassword": "a different passphrase"}, cookies=_crew(cookie))
    assert r.status_code == 403
    r = client.post("/api/crew-portal/auth/change-password", json={"currentPassword": "a fine passphrase", "newPassword": "short"}, cookies=_crew(cookie))
    assert r.status_code == 400
    r = client.post("/api/crew-portal/auth/change-password", json={"currentPassword": "a fine passphrase", "newPassword": "a different passphrase"}, cookies=_crew(cookie))
    assert r.status_code == 200 and r.json() == {"ok": True}
    # This device stays signed in; the other is signed out.
    assert client.get("/api/crew-portal/me", cookies=_crew(cookie)).status_code == 200
    assert client.get("/api/crew-portal/me", cookies=_crew(other)).status_code == 401
    assert _login(client, "pat@crew.com", "a different passphrase").status_code == 200
    # Phone is the one profile field crew keep themselves — it lands on the contact.
    r = client.put("/api/crew-portal/me", json={"phone": " 972-555-0100 "}, cookies=_crew(cookie))
    assert r.status_code == 200 and r.json()["phone"] == "972-555-0100"
    assert client.get(f"/api/contacts/{C_PW}", cookies=_staff()).json()["phone"] == "972-555-0100"
    assert client.put("/api/crew-portal/me", json={"phone": "x" * 51}, cookies=_crew(cookie)).status_code == 400
    # Names and the roster email are not theirs to change.
    r = client.put("/api/crew-portal/me", json={"firstName": "Hacker", "email": "x@y.com"}, cookies=_crew(cookie))
    assert r.status_code == 200 and r.json()["firstName"] == "Pat" and r.json()["email"] == "pat@crew.com"


# ── Emails ──────────────────────────────────────────────────────────────────

def test_portal_email_fallbacks_match_the_frontend_defaults():
    """The server fallbacks and data/settings.js defaults must be byte-identical,
    so a fresh deploy sends exactly what the Settings editor shows."""
    from backend.routes.crew_portal import _PORTAL_FALLBACKS
    src = open(os.path.join(_root, "data", "settings.js"), encoding="utf-8").read()
    for key in ("crewInvite", "crewPasswordReset"):
        block = src.split(key + ": {")[1].split("\n    },")[0]
        subject = re.search(r'subject: "([^"]*)"', block).group(1)
        body = json.loads('"' + re.search(r'body: "((?:[^"\\]|\\.)*)"', block).group(1) + '"')
        assert subject == _PORTAL_FALLBACKS[key]["subject"], key
        assert body == _PORTAL_FALLBACKS[key]["body"], key
    tv = src.split("window.LTP_TEMPLATE_VARIABLES")[1]
    for key in ("crewInvite", "crewPasswordReset"):
        assert re.search(key + r":\s*\[", tv), key + " needs a variable list"


def test_portal_email_renders_template_and_workspace_overrides():
    from backend.routes.crew_portal import render_portal_email
    sender = models.User(email="sender@biz.com", name="Sam Sender", title="Producer", phone="555")
    subject, html = render_portal_email("invite", crew_name="Casey", url="https://x.test/#/crew-portal/signup/abc",
                                        sender=sender, settings_data={"companyName": "Acme Shows"})
    assert subject == "You're invited to the Acme Shows crew portal"
    assert "Hi Casey," in html and "Set Up My Account" in html and "https://x.test/#/crew-portal/signup/abc" in html
    assert "7 days" in html and "Sam Sender" in html and "Acme Shows" in html
    # A workspace override wins, with its own tokens resolved.
    subject, html = render_portal_email("reset", crew_name="Casey", url="https://x.test/#/crew-portal/reset/abc",
                                        sender=sender, settings_data={"companyName": "Acme", "emailTemplates": {
                                            "crewPasswordReset": {"subject": "Reset for {{crewName}}", "body": "Go: {{portalUrl}} ({{expiresIn}})\n\n{{header}}"}}})
    assert subject == "Reset for Casey"
    assert "Go: https://x.test/#/crew-portal/reset/abc (1 hour)" in html and "Choose a New Password" in html


def test_invite_hands_over_the_link_only_when_mail_fails(monkeypatch):
    client, tok = _setup()
    import backend.gmail as gmailmod

    async def broken(**kwargs):
        raise gmailmod.GmailReconnectRequired("token gone")
    monkeypatch.setattr(gmailmod, "send", broken)
    r = _invite(client, C_B)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["emailStatus"]["emailed"] is False and body["emailStatus"]["needsReconnect"] is True
    assert body["inviteUrl"].startswith("https://ltp.example.com/#/crew-portal/signup/")
    assert body["status"] == "invited"
    # The handed-over link is live.
    token = body["inviteUrl"].rsplit("/", 1)[1]
    assert client.get("/api/crew-portal/auth/token/" + token).json()["valid"] is True


# ── The crew portal's own domain (docs/CREW_DOMAIN.md) ──────────────────────

def test_crew_origin_falls_back_to_the_app_origin(monkeypatch):
    from backend.email_compose import crew_origin, crew_host
    monkeypatch.delenv("LTP_CREW_PORTAL_ORIGIN", raising=False)
    assert crew_origin() == "https://ltp.example.com" and crew_host() == ""
    monkeypatch.setenv("LTP_CREW_PORTAL_ORIGIN", "crew.example.com")          # no scheme → ignored
    assert crew_origin() == "https://ltp.example.com" and crew_host() == ""
    monkeypatch.setenv("LTP_CREW_PORTAL_ORIGIN", "https://Crew.Example.com/")
    assert crew_origin() == "https://Crew.Example.com" and crew_host() == "crew.example.com"


def test_crew_origin_drives_every_crew_facing_link(monkeypatch):
    """With the crew domain configured, the invitation / reset links AND the
    call-sheet link in a crew request point at it; the masthead and avatar
    stay on the app origin (assets are never served from a host that could
    be detached)."""
    client, tok = _setup()
    monkeypatch.setenv("LTP_CREW_PORTAL_ORIGIN", "https://crew.example.com")
    r = _invite(client, C_B)                       # B holds a live invite, never signed up
    assert r.status_code == 200, r.text
    html = SENT[-1]["html_body"]
    assert "https://crew.example.com/#/crew-portal/signup/" in html
    assert "https://ltp.example.com/#/crew-portal" not in html
    assert "https://ltp.example.com/assets/logos/luminary-masthead.png" in html
    r = client.post("/api/crew-requests/send", json={"projectId": P_LINK, "contactId": C_B}, cookies=_staff())
    assert r.status_code == 200, r.text
    html = SENT[-1]["html_body"]
    assert "https://crew.example.com/#/crew/" + r.json()["token"] in html
    assert "https://ltp.example.com/#/crew/" not in html
    # Unset again, links go back to the app origin.
    monkeypatch.delenv("LTP_CREW_PORTAL_ORIGIN")
    r = client.post(f"/api/crew-requests/{r.json()['id']}/resend", cookies=_staff())
    assert r.status_code == 200 and "https://ltp.example.com/#/crew/" in SENT[-1]["html_body"]


def test_crew_host_serves_the_portal_identity(monkeypatch):
    """Keyed on the request's Host: the crew host gets the LTP Crew title,
    home-screen name, default-route hint and a manifest that opens on the
    portal; the app host is served byte-for-byte from disk."""
    client, tok = _setup()
    monkeypatch.setenv("LTP_CREW_PORTAL_ORIGIN", "https://crew.example.com")
    on_disk = open(os.path.join(_root, "index.html"), "rb").read()

    r = client.get("/", headers={"host": "crew.example.com"})
    assert r.status_code == 200 and "text/html" in r.headers["content-type"]
    assert "<title>LTP Crew Portal</title>" in r.text
    assert '<meta name="apple-mobile-web-app-title" content="LTP Crew" />' in r.text
    assert '<meta name="ltp-default-route" content="crew-portal" />' in r.text
    assert "<title>LTP Business Suite</title>" not in r.text
    assert r.headers["cache-control"] == "no-cache"
    # A port in Host, upper case, and a deep path (SPA fallback) all count.
    assert "ltp-default-route" in client.get("/", headers={"host": "CREW.example.com:443"}).text
    assert "ltp-default-route" in client.get("/anything/deep", headers={"host": "crew.example.com"}).text
    assert "ltp-default-route" in client.get("/index.html", headers={"host": "crew.example.com"}).text
    # The app host — and any other host — is untouched.
    for host in ("ltp.example.com", "ltpapp.up.railway.app"):
        r2 = client.get("/", headers={"host": host})
        assert r2.content == on_disk, host
        assert "ltp-default-route" not in r2.text

    m = client.get("/manifest.webmanifest", headers={"host": "crew.example.com"})
    assert m.status_code == 200 and "application/manifest+json" in m.headers["content-type"]
    m = m.json()
    assert m["name"] == "LTP Crew" and m["short_name"] == "LTP Crew" and m["start_url"] == "/#/crew-portal"
    assert m["icons"] and m["scope"] == "/"
    m2 = client.get("/manifest.webmanifest", headers={"host": "ltp.example.com"}).json()
    assert m2["name"] == "LTP" and m2["start_url"] == "/#/dashboard"

    # Static files and the API answer the same on the crew host.
    assert client.get("/router.js", headers={"host": "crew.example.com"}).status_code == 200
    assert client.get("/api/crew-portal/auth/me", headers={"host": "crew.example.com"}).status_code == 401

    # Without the variable, the crew host is just another host.
    monkeypatch.delenv("LTP_CREW_PORTAL_ORIGIN")
    assert client.get("/", headers={"host": "crew.example.com"}).content == on_disk


def test_crew_origin_is_an_allowed_csrf_source(monkeypatch):
    """A state-changing request whose Origin is the crew domain passes the CSRF
    check even when it reaches the app under another Host (a proxy alias)."""
    client, tok = _setup()
    monkeypatch.setenv("LTP_CREW_PORTAL_ORIGIN", "https://crew.example.com")
    r = client.post("/api/crew-portal/auth/login", json={"email": "nobody@x.com", "password": "whatever pw"},
                    headers={"origin": "https://crew.example.com", "host": "ltp.example.com"})
    assert r.status_code == 401                    # past CSRF (403), refused as credentials
    r = client.post("/api/crew-portal/auth/login", json={"email": "nobody@x.com", "password": "whatever pw"},
                    headers={"origin": "https://evil.example.com", "host": "ltp.example.com"})
    assert r.status_code == 403


# ── Housekeeping ────────────────────────────────────────────────────────────

def test_sweeper_clears_expired_crew_sessions_and_stale_links():
    client, tok = _setup()
    _a_cookie(client)                       # Avery's account must exist
    from backend.database import async_session
    from backend.main import _sweep_expired_sessions_once
    from sqlalchemy import select

    async def plant():
        async with async_session() as db:
            acct = (await db.execute(select(models.CrewAccount).where(models.CrewAccount.contact_id == C_A))).scalar_one()
            now = datetime.now(timezone.utc)
            db.add(models.CrewSession(id="a" * 64, account_id=acct.id, expires_at=now - timedelta(days=1)))
            db.add(models.CrewSession(id="b" * 64, account_id=acct.id, expires_at=now + timedelta(days=1)))
            db.add(models.CrewAuthToken(contact_id=C_A, kind="reset", token_hash="c" * 64, email="x", expires_at=now - timedelta(days=3)))
            db.add(models.CrewAuthToken(contact_id=C_A, kind="reset", token_hash="d" * 64, email="x", expires_at=now - timedelta(hours=2)))
            await db.commit()

    async def remaining():
        async with async_session() as db:
            s = (await db.execute(select(models.CrewSession.id).where(models.CrewSession.id.in_(["a" * 64, "b" * 64])))).scalars().all()
            t = (await db.execute(select(models.CrewAuthToken.token_hash).where(models.CrewAuthToken.token_hash.in_(["c" * 64, "d" * 64])))).scalars().all()
            return set(s), set(t)

    asyncio.run(plant())
    deleted = asyncio.run(_sweep_expired_sessions_once())
    assert deleted >= 2
    sessions, tokens = asyncio.run(remaining())
    assert sessions == {"b" * 64}
    # A link expired only two hours ago is kept for its grace day, so a late
    # click still reads "expired" rather than "unknown".
    assert tokens == {"d" * 64}


def test_expired_link_is_reported_as_expired():
    client, tok = _setup()
    from backend.database import async_session
    raw, digest = crew_auth.mint_token()

    async def plant():
        async with async_session() as db:
            db.add(models.CrewAuthToken(contact_id=C_B, kind="invite", token_hash=digest, email="blake@crew.com",
                                        expires_at=datetime.now(timezone.utc) - timedelta(minutes=1)))
            await db.commit()
    asyncio.run(plant())
    r = client.get("/api/crew-portal/auth/token/" + raw)
    assert r.status_code == 200 and r.json()["valid"] is False and r.json()["reason"] == "expired"
    r = client.post("/api/crew-portal/auth/signup", json={"token": raw, "password": "a fine passphrase"})
    assert r.status_code == 410 and r.json()["detail"]["reason"] == "expired"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
