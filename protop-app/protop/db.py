"""SQLite storage: one short-lived connection per request (WAL, short timeouts)."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, current_app, g

SCHEMA = """
CREATE TABLE IF NOT EXISTS rooms (
    id        TEXT PRIMARY KEY,
    created   REAL NOT NULL,
    touched   REAL NOT NULL,      -- last write or sync (throttled)
    expires   REAL NOT NULL,
    seq       INTEGER NOT NULL DEFAULT 0,
    fmt       TEXT NOT NULL,      -- 'pdb' | 'cif'
    title     TEXT NOT NULL,
    source    TEXT NOT NULL,
    structure BLOB NOT NULL,      -- zlib-compressed coordinate text
    chains    BLOB NOT NULL       -- zlib-compressed JSON [{"name", "residues": [...]}]
);
CREATE INDEX IF NOT EXISTS rooms_expires ON rooms (expires);

CREATE TABLE IF NOT EXISTS ops (   -- append-only
    room_id TEXT NOT NULL,
    seq     INTEGER NOT NULL,
    data    TEXT NOT NULL,         -- the whole op as JSON
    PRIMARY KEY (room_id, seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS cache (
    key     TEXT PRIMARY KEY,
    body    BLOB NOT NULL,
    ctype   TEXT NOT NULL,
    fetched REAL NOT NULL,
    size    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cache_fetched ON cache (fetched);
"""


def connect(path: str | Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), timeout=3.0, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 3000")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def init_db(path: str | Path) -> None:
    conn = connect(path)
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
    finally:
        conn.close()


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = connect(current_app.config["DB_PATH"])
    return g.db


def open_db(app: Flask) -> sqlite3.Connection:
    """A connection outside of a request (startup tasks, tests). The caller closes it."""
    return connect(app.config["DB_PATH"])


def close_db(_exc: BaseException | None = None) -> None:
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
