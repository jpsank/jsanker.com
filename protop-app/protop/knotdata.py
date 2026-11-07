"""Parsers for the AlphaKnot and KnotProt tables, shared by the aggregator routes and the catalog builder.

Column names follow the old backend (functions/functions.py: postprocess_alphaknot / postprocess_knotprot), which used
pandas; this uses csv only. Missing values ('', 'None', 'NaN') become None.
"""
from __future__ import annotations

import csv
import io
import re

ALPHAKNOT_COLUMNS = {
    "Knot_type": "knotType", "Category": "category", "Uniprot": "uniprotId", "Version": "version",
    "Organism": "organism", "Knot_probability": "knotProbability", "pLDDT_knotcore": "pLDDT_knotCore",
    "Knotcore_range": "knotCoreRange", "Knotcore_length": "knotCoreLength", "pLDDT_chain": "pLDDT_chain",
    "Protein_name": "proteinName", "Chain_length": "chainLength", "EC": "EC", "Kingdom": "kingdom",
    "Family": "family", "Gene_name": "geneName", "InterPro": "InterPro", "Fingerprint": "fingerprint",
    "PDB": "PDB", "PFAM": "PFAM",
}
_FLOATS = {"knotProbability", "pLDDT_knotCore", "pLDDT_chain"}
_INTS = {"knotCoreLength", "chainLength"}
_MISSING = {"", "none", "nan", "null"}
_TYPE_COMPACT = re.compile(r"^(\d)(\d{1,2})$")


def clean(value):
    if value is None:
        return None
    value = value.strip()
    return None if value.lower() in _MISSING else value


def _num(value, kind):
    value = clean(value)
    if value is None:
        return None
    try:
        return int(float(value)) if kind is int else float(value)
    except ValueError:
        return None


def normalize_knot_type(raw):
    """KnotProt writes 31, 41, 52, 820; AlphaKnot writes 3_1, 5_2. Use the underscore form everywhere."""
    raw = clean(raw) if isinstance(raw, str) else raw
    if raw is None:
        return None
    m = _TYPE_COMPACT.match(raw)
    return f"{m.group(1)}_{m.group(2)}" if m else raw


def knot_order(knot_type) -> int:
    """Sort key so 3_1 < 4_1 < 5_2 < 8_2 < 8_20 < 10_1 (and anything odd last)."""
    m = re.match(r"^(\d+)_(\d+)", knot_type or "")
    return int(m.group(1)) * 1000 + int(m.group(2)) if m else 10**9


def parse_alphaknot_tsv(text: str) -> tuple[list[str], list[dict]]:
    """-> (column names in file order, rows as dicts). The id loses its '-F1' suffix, as in the old backend."""
    reader = csv.reader(io.StringIO(text), delimiter="\t")
    header = None
    rows: list[dict] = []
    for fields in reader:
        if not fields:
            continue
        if header is None:
            header = [ALPHAKNOT_COLUMNS.get(f.lstrip("#").strip(), f.lstrip("#").strip()) for f in fields]
            continue
        row = {}
        for name, value in zip(header, fields):
            if name.startswith("FILTER"):
                continue
            if name in _FLOATS:
                row[name] = _num(value, float)
            elif name in _INTS:
                row[name] = _num(value, int)
            elif name == "uniprotId":
                row[name] = (clean(value) or "").split("-")[0] or None
            elif name == "knotType":
                row[name] = normalize_knot_type(value)
            else:
                row[name] = clean(value)
        rng = row.get("knotCoreRange")
        if rng and re.fullmatch(r"\d+-\d+", rng):
            a, b = rng.split("-")
            row["knotCoreStart"], row["knotCoreEnd"] = int(a), int(b)
        rows.append(row)
    if header is None:
        raise ValueError("empty AlphaKnot table")
    cols = [c for c in header if not c.startswith("FILTER")]
    if any("knotCoreStart" in r for r in rows):
        cols += ["knotCoreStart", "knotCoreEnd"]
    return cols, rows


KNOTPROT_COLUMNS = ["pdbId", "chain", "chainLength", "category", "knotCategory", "knotType", "nCut", "cCut", "knotRange"]


def parse_knotprot_csv(text: str) -> list[dict]:
    """One dict per chain row. knotType is KnotProt's own code (e.g. '31'); knotTypeName is the 3_1 form."""
    rows: list[dict] = []
    for fields in csv.reader(io.StringIO(text), delimiter=";"):
        if len(fields) < 9 or fields[0].startswith("#"):
            continue
        pdb_id = clean(fields[0])
        if not pdb_id or not re.fullmatch(r"[0-9][A-Za-z0-9]{3}", pdb_id):
            continue
        rng = clean(fields[8])
        start = end = None
        if rng and re.fullmatch(r"\d+-\d+", rng):
            start, end = (int(x) for x in rng.split("-"))
        knot_type = clean(fields[5])
        rows.append({
            "pdbId": pdb_id.lower(), "chain": clean(fields[1]), "chainLength": _num(fields[2], int),
            "category": clean(fields[3]), "knotCategory": clean(fields[4]), "knotType": knot_type,
            "knotTypeName": normalize_knot_type(knot_type), "nCut": _num(fields[6], int), "cCut": _num(fields[7], int),
            "knotRange": rng, "knotRangeStart": start, "knotRangeEnd": end,
            "knotCoreLength": (end - start + 1) if start is not None else None,
        })
    return rows
