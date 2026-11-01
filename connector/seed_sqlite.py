#!/usr/bin/env python3
"""
Create the demo "Hospital C" pharmacy database as a SQLite file (no Docker, no database server).

Reads the generated seed SQL (connector/seed/init.sql, written by `npm run seed`, PostgreSQL dialect), adapts the
few PostgreSQL-only statements for SQLite, and writes connector/hospital_c.db (or the path given).
SYNTHETIC data only. Run:  npm run connector:seed   (or: python connector/seed_sqlite.py [path])
"""
from __future__ import annotations

import re
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SEED_SQL = HERE / "seed" / "init.sql"
DEFAULT_DB = HERE / "hospital_c.db"


def to_sqlite(sql: str) -> str:
    """PostgreSQL seed -> SQLite: SERIAL keys, no DO $$ blocks, no roles / GRANTs (SQLite has no users)."""
    out = []
    for line in sql.splitlines():
        if line.startswith(("DO $$", "GRANT ", "REVOKE ", "ALTER ROLE")):
            continue
        out.append(re.sub(r"\bSERIAL PRIMARY KEY\b", "INTEGER PRIMARY KEY AUTOINCREMENT", line))
    return "\n".join(out) + "\n"


def build(db_path: Path = DEFAULT_DB, seed_sql: Path = SEED_SQL) -> Path:
    if not seed_sql.is_file():
        raise SystemExit(f"{seed_sql} not found: run `npm run seed` first")
    db_path = Path(db_path)
    if db_path.exists():
        db_path.unlink()
    con = sqlite3.connect(db_path)
    try:
        con.executescript(to_sqlite(seed_sql.read_text(encoding="utf-8")))
        con.commit()
    finally:
        con.close()
    return db_path


if __name__ == "__main__":
    path = build(Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DB)
    con = sqlite3.connect(path)
    n_lots = con.execute("SELECT COUNT(*) FROM medilink_stock_v").fetchone()[0]
    n_appts = con.execute("SELECT COUNT(*) FROM medilink_schedule_v").fetchone()[0]
    con.close()
    print(f"[connector] synthetic Hospital C database written to {path} ({n_lots} lots, {n_appts} chemo bookings)")
