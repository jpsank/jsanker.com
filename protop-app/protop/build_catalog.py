"""Build the knot catalog snapshot:   python -m protop.build_catalog [--out protop/data/catalog.sqlite]

Downloads the AlphaKnot (AF1-Knot) and KnotProt bulk tables the old knotcat.py used, adds AlphaKnot knot-core details
(one small request per protein) and UniProt disease names, and writes a SQLite file the web app opens read-only.
Needs network access; the web app never runs this. Uses requests + csv only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import requests

from . import knotdata
from .catalog import COLUMNS, SCHEMA

ALPHAKNOT_BULK = "https://alphaknot.cent.uw.edu.pl/browse/?cats=AF1-Knot&raw=1"
ALPHAKNOT_ONE = "https://alphaknot.cent.uw.edu.pl/browse/"
ALPHAKNOT_COLS = "Uniprot;Knot_type;Category;Knot_probability;pLDDT_knotcore;Knotcore_range;Knotcore_length;pLDDT_chain"
KNOTPROT_BULK = "https://knotprot.cent.uw.edu.pl/_all_chains_knotted_N_C"
RCSB_GRAPHQL = "https://data.rcsb.org/graphql"
UNIPROT_SEARCH = "https://rest.uniprot.org/uniprotkb/search"
MAX_BYTES = 20 * 1024 * 1024
DETAIL_FIELDS = ("knotProbability", "pLDDT_knotCore", "pLDDT_chain", "knotCoreRange", "knotCoreStart", "knotCoreEnd", "knotCoreLength")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def http(method: str, url: str, *, params=None, json_body=None, tries: int = 3) -> bytes:
    last: Exception | None = None
    for attempt in range(tries):
        try:
            r = requests.request(method, url, params=params, json=json_body, timeout=(10, 90), stream=True,
                                 headers={"User-Agent": "jsanker.com-protop-catalog-builder/1.0"})
            if r.status_code != 200:
                raise RuntimeError(f"HTTP {r.status_code}")
            body = b"".join(r.iter_content(65536))
            if len(body) > MAX_BYTES:
                raise RuntimeError("response too large")
            return body
        except (requests.RequestException, RuntimeError) as e:
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{url} failed: {last}")


# ------------------------------------------------------------------ steps ---


def alphaknot_rows(details: bool) -> list[dict]:
    log("AlphaKnot: bulk table")
    _, rows = knotdata.parse_alphaknot_tsv(http("GET", ALPHAKNOT_BULK).decode("utf-8", "replace"))
    rows = [r for r in rows if r.get("uniprotId")]
    if details:
        log(f"AlphaKnot: knot-core details for {len(rows)} proteins")

        def one(row: dict) -> None:
            try:
                body = http("GET", ALPHAKNOT_ONE, params={"field": "Uniprot", "val": row["uniprotId"], "raw": 1,
                                                          "cats": "AF1-Knot", "result_cols": ALPHAKNOT_COLS})
                _, cand = knotdata.parse_alphaknot_tsv(body.decode("utf-8", "replace"))
            except Exception as e:  # noqa: BLE001 - a missing detail row must not sink the whole build
                log(f"  no details for {row['uniprotId']}: {e}")
                return
            same = [c for c in cand if c.get("knotType") == row.get("knotType")] or cand
            if same:
                best = max(same, key=lambda c: c.get("knotProbability") or 0)
                for f in DETAIL_FIELDS:
                    if best.get(f) is not None:
                        row[f] = best[f]

        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(one, rows))
    for r in rows:
        r.update(source="alphaknot", category=r.get("category") or "AF1-Knot")
    return rows


def knotprot_rows() -> list[dict]:
    log("KnotProt: bulk table")
    rows = knotdata.parse_knotprot_csv(http("GET", KNOTPROT_BULK).decode("utf-8", "replace"))
    out = []
    for r in rows:
        if not r["knotTypeName"]:
            continue
        r = dict(r, source="knotprot", knotType=r["knotTypeName"])
        r["knotCoreRange"] = r.get("knotRange")
        r["knotCoreStart"], r["knotCoreEnd"] = r.get("knotRangeStart"), r.get("knotRangeEnd")
        out.append(r)
    return out


def attach_diseases(ak: list[dict], kp: list[dict]) -> None:
    """UniProt disease names: AlphaKnot rows by accession, KnotProt rows via RCSB's PDB-to-UniProt mapping.
    The same RCSB query also names KnotProt chains (molecule, organism) and gives them a UniProt id."""
    pdb_ids = sorted({r["pdbId"].upper() for r in kp})
    log(f"RCSB: PDB -> UniProt mapping for {len(pdb_ids)} entries")
    chain_to_acc: dict[tuple[str, str], set[str]] = {}
    chain_info: dict[tuple[str, str], tuple[str | None, str | None]] = {}   # (pdb, chain) -> (name, organism)
    query = ("query($ids:[String!]!){entries(entry_ids:$ids){rcsb_id polymer_entities{"
             "rcsb_polymer_entity_container_identifiers{auth_asym_ids uniprot_ids} "
             "rcsb_polymer_entity{pdbx_description} rcsb_entity_source_organism{scientific_name}}}}")
    for i in range(0, len(pdb_ids), 100):
        data = json.loads(http("POST", RCSB_GRAPHQL, json_body={"query": query, "variables": {"ids": pdb_ids[i:i + 100]}}))
        for entry in (data.get("data") or {}).get("entries") or []:
            for ent in (entry or {}).get("polymer_entities") or []:
                ids = ent.get("rcsb_polymer_entity_container_identifiers") or {}
                name = (ent.get("rcsb_polymer_entity") or {}).get("pdbx_description")
                organisms = ent.get("rcsb_entity_source_organism") or []
                organism = (organisms[0] or {}).get("scientific_name") if organisms else None
                for chain in ids.get("auth_asym_ids") or []:
                    key = (entry["rcsb_id"].lower(), chain)
                    chain_to_acc.setdefault(key, set()).update(ids.get("uniprot_ids") or [])
                    chain_info[key] = (name, organism)
    accessions = sorted({r["uniprotId"] for r in ak} | {a for s in chain_to_acc.values() for a in s})
    log(f"UniProt: disease names for {len(accessions)} accessions")
    diseases: dict[str, list[str]] = {}
    for i in range(0, len(accessions), 40):
        batch = accessions[i:i + 40]
        body = http("GET", UNIPROT_SEARCH, params={
            "query": " OR ".join(f"accession:{a}" for a in batch), "fields": "accession,cc_disease",
            "format": "json", "size": 100})
        for result in json.loads(body).get("results", []):
            names = sorted({c["disease"]["diseaseId"] for c in result.get("comments", [])
                            if isinstance(c.get("disease"), dict) and c["disease"].get("diseaseId")})
            if names:
                diseases[result["primaryAccession"]] = names
    for r in ak:
        r["diseases"] = diseases.get(r["uniprotId"], [])
    for r in kp:
        key = (r["pdbId"], r["chain"])
        accs = sorted(chain_to_acc.get(key, set()))
        r["diseases"] = sorted({n for a in accs for n in diseases.get(a, [])})
        r["uniprotId"] = accs[0] if accs else None
        r["proteinName"], r["organism"] = chain_info.get(key, (None, None))


# ------------------------------------------------------------------ output ---


def write_snapshot(path: Path, rows: list[dict], meta: dict) -> None:
    """Write rows (dicts keyed like catalog.COLUMNS) and metadata to a fresh SQLite file at `path`."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix=".sqlite", dir=str(path.parent))
    os.close(fd)
    os.unlink(tmp)
    conn = sqlite3.connect(tmp)
    try:
        conn.executescript(SCHEMA)
        cols = COLUMNS + ["knotOrder"]
        conn.executemany(
            f"INSERT INTO catalog ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
            [[json.dumps(r.get("diseases") or []) if c == "diseases"
              else knotdata.knot_order(r.get("knotType")) if c == "knotOrder" else r.get(c) for c in cols] for r in rows])
        meta = dict(meta, total=str(len(rows)))
        conn.executemany("INSERT INTO meta (key, value) VALUES (?, ?)", list(meta.items()))
        conn.commit()
        conn.execute("VACUUM")
    finally:
        conn.close()
    os.replace(tmp, path)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "data" / "catalog.sqlite"))
    ap.add_argument("--no-details", action="store_true", help="skip the per-protein AlphaKnot knot-core requests")
    ap.add_argument("--no-diseases", action="store_true", help="skip the UniProt disease lookup")
    args = ap.parse_args(argv)

    ak = alphaknot_rows(details=not args.no_details)
    kp = knotprot_rows()
    for r in ak + kp:
        r.setdefault("diseases", [])
    if not args.no_diseases:
        attach_diseases(ak, kp)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    meta = {
        "date": today,
        "sources": json.dumps([
            f"AlphaKnot AF1-Knot (alphaknot.cent.uw.edu.pl): {len(ak)} knotted AlphaFold predictions",
            f"KnotProt (knotprot.cent.uw.edu.pl): {len(kp)} chains with a knot type",
            *([] if args.no_diseases else ["Disease names: UniProt (rest.uniprot.org); KnotProt chain names, organisms and UniProt ids: RCSB (data.rcsb.org)"]),
        ]),
        "note": ("Complete bulk tables as downloaded on the snapshot date: the AlphaKnot AF1-Knot category lists only "
                 "knotted predictions, and KnotProt rows without a knot type were skipped. AlphaKnot knot-core fields "
                 "are those of the highest-probability prediction per protein."),
    }
    write_snapshot(Path(args.out), ak + kp, meta)
    log(f"wrote {args.out}: {len(ak)} AlphaKnot + {len(kp)} KnotProt rows, {Path(args.out).stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
