"""Knotted-protein catalog, served from a read-only SQLite snapshot built by `python -m protop.build_catalog`.

Row fields (camelCase, as in the old MongoDB documents of knotcat.py / postprocess_alphaknot / postprocess_knotprot):
  source          'alphaknot' | 'knotprot'
  uniprotId       AlphaKnot entries (version suffix '-F1' removed)           pdbId, chain   KnotProt entries
  knotType        normalised knot type, '3_1' style (KnotProt's '31' is converted)
  knotCategory    KnotProt: 'K' knot / 'S' slipknot            category   AlphaKnot 'AF1-Knot'; KnotProt 'Y' published,
                  'A' artifact, 'T' not published
  organism, proteinName                                         (AlphaKnot)
  chainLength                                                   (KnotProt)
  knotCoreLength, knotCoreRange, knotCoreStart, knotCoreEnd     AlphaKnot: knot core of the best-scoring prediction;
                                                                KnotProt: from 'Knots range'
  knotProbability, pLDDT_knotCore, pLDDT_chain                  (AlphaKnot)
  nCut, cCut                                                    (KnotProt) residues that can be trimmed from each end
  diseases        list of UniProt disease names (empty when none or unmapped)
"""
from __future__ import annotations

import csv
import io
import json
import sqlite3
from pathlib import Path

from flask import Blueprint, Response, current_app, jsonify, request

from .errors import ApiError
from .knotdata import normalize_knot_type
from .security import ip_key, limiter

bp = Blueprint("catalog", __name__)

COLUMNS = [
    "source", "uniprotId", "pdbId", "chain", "knotType", "knotCategory", "category", "organism", "proteinName",
    "chainLength", "knotCoreLength", "knotCoreRange", "knotCoreStart", "knotCoreEnd", "knotProbability",
    "pLDDT_knotCore", "pLDDT_chain", "nCut", "cCut", "diseases",
]
SCHEMA = f"""
CREATE TABLE catalog (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL, uniprotId TEXT, pdbId TEXT, chain TEXT, knotType TEXT, knotCategory TEXT, category TEXT,
    organism TEXT, proteinName TEXT, chainLength INTEGER, knotCoreLength INTEGER, knotCoreRange TEXT,
    knotCoreStart INTEGER, knotCoreEnd INTEGER, knotProbability REAL, pLDDT_knotCore REAL, pLDDT_chain REAL,
    nCut INTEGER, cCut INTEGER, diseases TEXT NOT NULL DEFAULT '[]', knotOrder INTEGER NOT NULL DEFAULT 1000000000
);
CREATE INDEX catalog_knot ON catalog (knotType);
CREATE INDEX catalog_source ON catalog (source);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""
SOURCES = ("alphaknot", "knotprot")
SEARCH_COLUMNS = ["uniprotId", "pdbId", "knotType", "organism", "proteinName", "diseases", "category", "chain"]
MAX_CSV_ROWS = 50_000
MAX_TERMS = 5


def open_snapshot(path: str | Path) -> sqlite3.Connection:
    p = Path(path)
    if not p.is_file():
        raise ApiError(503, "The knot catalog snapshot is not installed on this server.")
    conn = sqlite3.connect(f"{p.resolve().as_uri()}?mode=ro&immutable=1", uri=True, timeout=2.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _like(term: str) -> str:
    return "%" + term.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _where(q: str, knot: str, source: str, skip: str = "") -> tuple[str, list]:
    clauses, args = [], []
    if skip != "q":
        for term in q.split()[:MAX_TERMS]:
            clauses.append("(" + " OR ".join(f"lower(COALESCE({c}, '')) LIKE ? ESCAPE '\\'" for c in SEARCH_COLUMNS) + ")")
            args.extend([_like(term)] * len(SEARCH_COLUMNS))
    if knot and skip != "knot":
        clauses.append("knotType = ?")
        args.append(knot)
    if source and skip != "source":
        clauses.append("source = ?")
        args.append(source)
    return (" WHERE " + " AND ".join(clauses)) if clauses else "", args


def _filters() -> tuple[str, str, str]:
    q = request.args.get("q", "").strip()
    if len(q) > 100:
        raise ApiError(400, "The search text is limited to 100 characters.")
    knot = request.args.get("knot", "").strip()
    if len(knot) > 20:
        raise ApiError(400, "That knot type is too long.")
    knot = normalize_knot_type(knot) or ""
    source = request.args.get("source", "").strip().lower()
    if source and source not in SOURCES:
        raise ApiError(400, "'source' must be alphaknot or knotprot.")
    return q, knot, source


def _order() -> str:
    sort = request.args.get("sort", "knotType")
    if sort not in COLUMNS:
        raise ApiError(400, f"'sort' must be one of: {', '.join(COLUMNS)}.")
    order = request.args.get("order", "asc").lower()
    if order not in ("asc", "desc"):
        raise ApiError(400, "'order' must be asc or desc.")
    col = "knotOrder" if sort == "knotType" else sort
    tie = "knotOrder ASC, id ASC" if sort != "knotType" else "id ASC"
    return f" ORDER BY {col} IS NULL, {col} {order.upper()}, {tie}"


def _int_arg(name: str, default: int, lo: int, hi: int) -> int:
    raw = request.args.get(name)
    if raw is None or raw == "":
        return default
    if not raw.isdigit() or len(raw) > 9 or not lo <= int(raw) <= hi:
        raise ApiError(400, f"'{name}' must be an integer from {lo} to {hi}.")
    return int(raw)


def _row(r: sqlite3.Row) -> dict:
    out = {c: r[c] for c in COLUMNS}
    out["diseases"] = json.loads(r["diseases"] or "[]")
    out["id"] = r["id"]
    return out


def _snapshot_info(conn: sqlite3.Connection) -> dict:
    meta = dict(conn.execute("SELECT key, value FROM meta").fetchall())
    return {"date": meta.get("date"), "sources": json.loads(meta.get("sources", "[]")), "note": meta.get("note", ""),
            "total": int(meta.get("total", "0"))}


def _rate_limit() -> None:
    if not limiter.allow(ip_key("catalog"), 240, 60):
        raise ApiError(429, "Too many catalog requests. Wait a moment.", retry_after=30)


@bp.get("/catalog")
def catalog():
    _rate_limit()
    q, knot, source = _filters()
    sort_clause = _order()
    page = _int_arg("page", 1, 1, 10**6)
    per_page = _int_arg("per_page", 25, 1, 100)
    conn = open_snapshot(current_app.config["CATALOG_PATH"])
    try:
        where, args = _where(q, knot, source)
        total = conn.execute(f"SELECT COUNT(*) FROM catalog{where}", args).fetchone()[0]
        rows = conn.execute(f"SELECT * FROM catalog{where}{sort_clause} LIMIT ? OFFSET ?",
                            args + [per_page, (page - 1) * per_page]).fetchall()
        w, a = _where(q, knot, source, skip="knot")
        knot_types = conn.execute(f"SELECT knotType AS name, COUNT(*) AS count FROM catalog{w} "
                                  "GROUP BY knotType ORDER BY MIN(knotOrder), knotType", a).fetchall()
        w, a = _where(q, knot, source, skip="source")
        sources = conn.execute(f"SELECT source AS name, COUNT(*) AS count FROM catalog{w} GROUP BY source ORDER BY source", a).fetchall()
        body = {
            "total": total, "page": page, "per_page": per_page, "rows": [_row(r) for r in rows],
            "facets": {"knot_types": [{"name": r["name"], "count": r["count"]} for r in knot_types if r["name"]],
                       "sources": [{"name": r["name"], "count": r["count"]} for r in sources]},
            "snapshot": _snapshot_info(conn),
        }
    finally:
        conn.close()
    resp = jsonify(body)
    resp.headers["Cache-Control"] = "public, max-age=300"
    return resp


def _csv_cell(value):
    if isinstance(value, list):
        value = "; ".join(str(v) for v in value)
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value       # stop spreadsheets from running formulas
    return "" if value is None else value


@bp.get("/catalog.csv")
def catalog_csv():
    _rate_limit()
    q, knot, source = _filters()
    sort_clause = _order()
    conn = open_snapshot(current_app.config["CATALOG_PATH"])
    try:
        where, args = _where(q, knot, source)
        rows = conn.execute(f"SELECT * FROM catalog{where}{sort_clause} LIMIT ?", args + [MAX_CSV_ROWS]).fetchall()
        snap = _snapshot_info(conn)
        out = io.StringIO()
        writer = csv.writer(out, lineterminator="\r\n")
        writer.writerow(COLUMNS)
        for r in rows:
            d = _row(r)
            writer.writerow([_csv_cell(d.get(c)) for c in COLUMNS])
    finally:
        conn.close()
    resp = Response(out.getvalue(), mimetype="text/csv")
    resp.headers["Content-Disposition"] = f'attachment; filename="protop-knot-catalog-{snap["date"] or "snapshot"}.csv"'
    resp.headers["Cache-Control"] = "public, max-age=300"
    return resp
