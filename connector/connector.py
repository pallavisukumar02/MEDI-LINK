#!/usr/bin/env python3
"""
MediLink read-only connector for hospitals with an in-house pharmacy database ("database path").

Runs on the hospital's own server. Every CONNECTOR_SYNC_INTERVAL_SEC it:
  1. reads two views from the local PostgreSQL DB via SQLAlchemy (read-only, SELECT only):
       medilink_stock_v     lot_ref, generic, strength, form, brand, mfr, batch, qty_on_hand, exp_date, storage, seal_ok
       medilink_schedule_v  appt_id, mrn, generic, strength, form, units, appt_date, intent
  2. replaces every MRN with SHA-256("<PATIENT_REF_HASH_SALT>:<mrn>") on this server, so no raw patient
     identifier (and never a name) leaves the hospital,
  3. pushes the snapshot to MediLink POST /ingest with its long-lived connector token.

First run: exchange the one-time pairing code the pharmacist received at onboarding:
    python connector.py --pair ABCDE12345
Then:  python connector.py          (loop)
       python connector.py --once   (single sync, e.g. from cron / Task Scheduler)
       python connector.py --dry-run (print the payload summary, push nothing)

Config (env or backend/.env): CONNECTOR_PG_URL, CONNECTOR_INGEST_URL, CONNECTOR_SYNC_INTERVAL_SEC,
PATIENT_REF_HASH_SALT, CONNECTOR_TOKEN_FILE (default ./.connector-token). Secrets are never printed.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import logging
import os
import stat
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

LOG = logging.getLogger("medilink-connector")
HERE = Path(__file__).resolve().parent
STOCK_VIEW = "medilink_stock_v"
SCHEDULE_VIEW = "medilink_schedule_v"


# ---------------------------------------------------------------- config
def load_dotenv(path: Path) -> None:
    """Minimal .env reader (KEY=VALUE, # comments). Existing env vars win."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        val = val.split(" #", 1)[0].strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), val)


class Config:
    def __init__(self, env: Optional[Dict[str, str]] = None):
        e = os.environ if env is None else env
        self.pg_url = e.get("CONNECTOR_PG_URL", "postgresql://pharmacy:pharmacy@localhost:5432/hospital_c")
        self.ingest_url = e.get("CONNECTOR_INGEST_URL", "http://localhost:4004/ingest")
        self.interval = int(e.get("CONNECTOR_SYNC_INTERVAL_SEC", "900") or 900)
        self.salt = e.get("PATIENT_REF_HASH_SALT", "")
        self.token_file = Path(e.get("CONNECTOR_TOKEN_FILE", str(HERE / ".connector-token")))
        self.timeout = int(e.get("CONNECTOR_HTTP_TIMEOUT_SEC", "30") or 30)

    @property
    def base_url(self) -> str:
        u = self.ingest_url.rstrip("/")
        return u[: -len("/ingest")] if u.endswith("/ingest") else u


def engine_url(url: str) -> str:
    """postgresql:// -> an installed driver. SQLAlchemy 2.1 defaults to psycopg (v3); we ship psycopg2-binary."""
    for prefix in ("postgresql://", "postgres://"):
        if url.startswith(prefix):
            rest = url[len(prefix):]
            for mod, dialect in (("psycopg2", "postgresql+psycopg2://"), ("psycopg", "postgresql+psycopg://")):
                try:
                    __import__(mod)
                    return dialect + rest
                except ImportError:
                    continue
    return url


# ---------------------------------------------------------------- privacy
def hash_ref(salt: str, mrn: Any) -> str:
    """SHA-256(salt:mrn), lowercase hex. Same scheme as mock MediSoft so refs are comparable."""
    if not salt:
        raise ValueError("PATIENT_REF_HASH_SALT is required: refusing to send patient refs without a salt")
    return hashlib.sha256(f"{salt}:{str(mrn).strip()}".encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- read
def _iso(v: Any) -> Optional[str]:
    if v is None:
        return None
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()[:10]
    return str(v)[:10]


def read_snapshot(engine: Engine) -> Dict[str, List[Dict[str, Any]]]:
    """SELECT-only read of the two views. Columns are listed explicitly so nothing else (e.g. names) is read."""
    with engine.connect() as c:
        stock = c.execute(text(
            f"SELECT lot_ref, generic, strength, form, brand, mfr, batch, qty_on_hand, exp_date, storage, seal_ok FROM {STOCK_VIEW}"
        )).mappings().all()
        sched = c.execute(text(
            f"SELECT appt_id, mrn, generic, strength, form, units, appt_date, intent FROM {SCHEDULE_VIEW}"
        )).mappings().all()
    return {"stock": [dict(r) for r in stock], "schedule": [dict(r) for r in sched]}


def build_payload(snapshot: Dict[str, List[Dict[str, Any]]], salt: str) -> Dict[str, Any]:
    lots = [{
        "lotRef": r["lot_ref"], "generic": r["generic"], "strength": r["strength"], "form": r["form"],
        "brand": r["brand"], "mfr": r["mfr"], "batch": r["batch"], "qty": int(r["qty_on_hand"] or 0),
        "expiry": _iso(r["exp_date"]), "storage": r["storage"], "sealed": bool(r["seal_ok"]),
    } for r in snapshot["stock"]]
    bookings = [{
        "bookingId": str(r["appt_id"]), "patientRef": hash_ref(salt, r["mrn"]),
        "generic": r["generic"], "strength": r["strength"], "form": r["form"],
        "units": int(r["units"] or 0), "scheduledDate": _iso(r["appt_date"]), "intent": (r["intent"] or "CURATIVE").upper(),
    } for r in snapshot["schedule"]]
    return {"lots": lots, "bookings": bookings, "connector": {"version": "1.0.0", "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat()}}


# ---------------------------------------------------------------- http
class HttpError(Exception):
    def __init__(self, status: int, body: Any):
        super().__init__(f"HTTP {status}")
        self.status, self.body = status, body


def post_json(url: str, body: Dict[str, Any], token: Optional[str] = None, timeout: int = 30) -> Dict[str, Any]:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/json"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read() or b"{}")
        except ValueError:
            payload = {}
        raise HttpError(e.code, payload) from None


# ---------------------------------------------------------------- token
def save_token(path: Path, token: str, hospital_id: str) -> None:
    path.write_text(json.dumps({"token": token, "hospitalId": hospital_id}), encoding="utf-8")
    try:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)  # 0600 (no-op on Windows)
    except OSError:
        pass


def load_token(path: Path) -> Optional[Dict[str, str]]:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return None


def pair(cfg: Config, code: str) -> str:
    out = post_json(f"{cfg.base_url}/connector/pair", {"pairingCode": code.strip()}, timeout=cfg.timeout)
    save_token(cfg.token_file, out["token"], out["hospitalId"])
    LOG.info("paired with MediLink for hospital %s; token saved to %s", out["hospitalId"], cfg.token_file)
    return out["hospitalId"]


# ---------------------------------------------------------------- sync
def sync_once(cfg: Config, engine: Engine, token: Optional[str], dry_run: bool = False) -> Dict[str, Any]:
    payload = build_payload(read_snapshot(engine), cfg.salt)
    summary = {"lots": len(payload["lots"]), "bookings": len(payload["bookings"])}
    if dry_run:
        LOG.info("dry run: would push %s", summary)
        return {"dryRun": True, **summary}
    if not token:
        raise SystemExit("Not paired yet: run `python connector.py --pair <CODE>` with the code from MediLink onboarding")
    res = post_json(cfg.ingest_url, payload, token=token, timeout=cfg.timeout)
    LOG.info("pushed %s lots, %s bookings (skipped %s)", res.get("lots"), res.get("bookings"), res.get("skipped"))
    return res


def main(argv: Optional[List[str]] = None) -> int:
    load_dotenv(HERE.parent / "backend" / ".env")
    load_dotenv(HERE / ".env")
    ap = argparse.ArgumentParser(description="MediLink read-only pharmacy DB connector")
    ap.add_argument("--pair", metavar="CODE", help="exchange a one-time pairing code for a connector token")
    ap.add_argument("--once", action="store_true", help="sync once and exit")
    ap.add_argument("--dry-run", action="store_true", help="read and hash, but push nothing")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO, format="%(asctime)s [connector] %(message)s")
    cfg = Config()
    if not cfg.salt:
        LOG.error("PATIENT_REF_HASH_SALT is not set; refusing to run")
        return 2
    if a.pair:
        try:
            pair(cfg, a.pair)
        except HttpError as e:
            LOG.error("pairing failed (%s): %s", e.status, (e.body.get("error") or {}).get("code", "unknown"))
            return 1
        if not a.once:
            return 0
    engine = create_engine(engine_url(cfg.pg_url), pool_pre_ping=True)
    tok = (load_token(cfg.token_file) or {}).get("token")
    while True:
        try:
            sync_once(cfg, engine, tok, dry_run=a.dry_run)
        except HttpError as e:
            code = (e.body.get("error") or {}).get("code", "unknown")
            LOG.error("push refused (%s %s)", e.status, code)
            if e.status == 401:
                LOG.error("connector token revoked or invalid: ask the pharmacist for a new pairing code")
                return 1
        except Exception as e:  # keep looping on transient DB / network errors
            LOG.error("sync failed: %s", e.__class__.__name__ + ": " + str(e).split("\n")[0])
            if a.once:
                return 1
        if a.once or a.dry_run:
            return 0
        time.sleep(cfg.interval)


if __name__ == "__main__":
    sys.exit(main())
