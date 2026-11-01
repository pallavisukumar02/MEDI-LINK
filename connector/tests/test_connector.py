"""Connector tests: SHA-256 hashing at source, no names leave, pairing, token push, revoked token, real PostgreSQL views."""
import hashlib
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import connector as C  # noqa: E402

SALT = "test-salt"
SEED_SQL = Path(__file__).resolve().parents[1] / "seed" / "init.sql"


def sqlite_engine():
    """Same table + view shape as seed/init.sql, including a patient_name column that must never be read."""
    e = create_engine("sqlite://")
    with e.begin() as c:
        c.execute(text("CREATE TABLE inv (lot_ref TEXT, generic TEXT, strength TEXT, form TEXT, brand TEXT, mfr TEXT, batch TEXT, qty_on_hand INT, exp_date TEXT, storage TEXT, seal_ok BOOLEAN)"))
        c.execute(text("CREATE TABLE sched (appt_id TEXT, mrn TEXT, patient_name TEXT, generic TEXT, strength TEXT, form TEXT, units INT, appt_date TEXT, intent TEXT)"))
        c.execute(text("INSERT INTO inv VALUES ('H3-CARB-A','Carboplatin','450 mg/45 mL','Injection','Oncocarb','Zenvix','ZX24K07',25,'2027-04-30','AMBIENT',1)"))
        c.execute(text("INSERT INTO inv VALUES ('H3-TRAS-A','Trastuzumab','440 mg','Powder for injection','Herzuma-S','Nandi','NB24T031',1,'2027-05-20','COLD',0)"))
        c.execute(text("INSERT INTO sched VALUES ('LOC-1','MRN-0001','Ramesh Kumar','Carboplatin','450 mg/45 mL','Injection',2,'2030-01-02','curative')"))
        c.execute(text("CREATE VIEW medilink_stock_v AS SELECT * FROM inv"))
        c.execute(text("CREATE VIEW medilink_schedule_v AS SELECT appt_id, mrn, generic, strength, form, units, appt_date, intent FROM sched"))
    return e


class FakeMediLink:
    """Minimal stand-in for CAP's /connector/pair and /ingest."""
    def __init__(self):
        self.received, self.token, self.revoked = [], "f" * 64, False
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, body):
                b = json.dumps(body).encode()
                self.send_response(code); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(b)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                if self.path == "/connector/pair":
                    if body.get("pairingCode") != "GOODCODE01":
                        return self._send(401, {"error": {"code": "PAIRING_CODE_INVALID"}})
                    return self._send(200, {"token": outer.token, "hospitalId": "H3", "ingestUrl": "x"})
                if self.path == "/ingest":
                    if outer.revoked or self.headers.get("Authorization") != f"Bearer {outer.token}":
                        return self._send(401, {"error": {"code": "CONNECTOR_TOKEN_INVALID"}})
                    outer.received.append(body)
                    return self._send(200, {"hospitalId": "H3", "lots": len(body["lots"]), "bookings": len(body["bookings"]), "skipped": 0})
                self._send(404, {})

        self.srv = HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_port}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()


@pytest.fixture
def fake():
    f = FakeMediLink()
    yield f
    f.close()


def cfg_for(fake, tmp_path, **over):
    env = {"CONNECTOR_INGEST_URL": fake.url + "/ingest", "PATIENT_REF_HASH_SALT": SALT, "CONNECTOR_TOKEN_FILE": str(tmp_path / "tok")}
    env.update(over)
    return C.Config(env)


def test_hash_matches_medisoft_scheme_and_requires_salt():
    assert C.hash_ref(SALT, "MRN-0001") == hashlib.sha256(b"test-salt:MRN-0001").hexdigest()
    with pytest.raises(ValueError):
        C.hash_ref("", "MRN-0001")


def test_payload_hashes_mrn_and_never_contains_names_or_raw_ids():
    p = C.build_payload(C.read_snapshot(sqlite_engine()), SALT)
    assert len(p["lots"]) == 2 and len(p["bookings"]) == 1
    b = p["bookings"][0]
    assert b["patientRef"] == C.hash_ref(SALT, "MRN-0001")
    assert b["intent"] == "CURATIVE" and b["units"] == 2 and b["scheduledDate"] == "2030-01-02"
    blob = json.dumps(p)
    assert "MRN-0001" not in blob and "Ramesh" not in blob and "patient_name" not in blob
    tras = next(l for l in p["lots"] if l["lotRef"] == "H3-TRAS-A")
    assert tras["sealed"] is False and tras["storage"] == "COLD" and tras["expiry"] == "2027-05-20"


def test_pair_saves_token_and_push_uses_it(fake, tmp_path):
    cfg = cfg_for(fake, tmp_path)
    assert cfg.base_url == fake.url
    with pytest.raises(C.HttpError) as e:
        C.pair(cfg, "WRONG")
    assert e.value.status == 401
    assert C.pair(cfg, "GOODCODE01") == "H3"
    tok = C.load_token(cfg.token_file)
    assert tok == {"token": fake.token, "hospitalId": "H3"}
    res = C.sync_once(cfg, sqlite_engine(), tok["token"])
    assert res == {"hospitalId": "H3", "lots": 2, "bookings": 1, "skipped": 0}
    assert fake.received[0]["bookings"][0]["patientRef"] == C.hash_ref(SALT, "MRN-0001")


def test_dry_run_pushes_nothing_and_revoked_token_is_reported(fake, tmp_path):
    cfg = cfg_for(fake, tmp_path)
    assert C.sync_once(cfg, sqlite_engine(), None, dry_run=True) == {"dryRun": True, "lots": 2, "bookings": 1}
    assert fake.received == []
    fake.revoked = True
    with pytest.raises(C.HttpError) as e:
        C.sync_once(cfg, sqlite_engine(), fake.token)
    assert e.value.status == 401


def test_engine_url_picks_an_installed_driver():
    assert C.engine_url("postgresql://u:p@h/db").startswith(("postgresql+psycopg2://", "postgresql+psycopg://"))
    assert C.engine_url("sqlite://") == "sqlite://"


def test_main_refuses_without_salt(monkeypatch):
    monkeypatch.setattr(C, "load_dotenv", lambda p: None)
    monkeypatch.delenv("PATIENT_REF_HASH_SALT", raising=False)
    assert C.main(["--once"]) == 2


PG_URL = os.environ.get("CONNECTOR_TEST_PG_URL", "postgresql://pharmacy:pharmacy@localhost:5432/hospital_c")


def _pg():
    try:
        e = create_engine(C.engine_url(PG_URL))
        with e.connect() as c:
            c.execute(text("SELECT 1 FROM medilink_stock_v LIMIT 1"))
        return e
    except Exception:
        return None


@pytest.mark.skipif(_pg() is None, reason="demo PostgreSQL not running (npm run connector:db)")
def test_reads_real_postgres_views_from_seed_sql():
    p = C.build_payload(C.read_snapshot(_pg()), SALT)
    assert len(p["lots"]) >= 10 and len(p["bookings"]) >= 10
    assert any(l["batch"] == "ZX24K07" for l in p["lots"])  # flagged lot travels; CAP's rule 2 excludes it
    assert all(len(b["patientRef"]) == 64 for b in p["bookings"])
    assert "patient_name" not in json.dumps(p)
