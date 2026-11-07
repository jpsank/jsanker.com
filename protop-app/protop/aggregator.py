"""Read-only aggregator: RCSB, UniProt, AlphaKnot, KnotProt. JSON shapes follow the old Render backend."""
from __future__ import annotations

import json
import re

from flask import Blueprint, Response, jsonify, request

from . import knotdata
from .errors import ApiError
from .upstream import UpstreamError, UpstreamNotFound, fetch

bp = Blueprint("aggregator", __name__)

PDB_ID = re.compile(r"^[0-9][A-Za-z0-9]{3}$")
UNIPROT_ID = re.compile(r"^[A-Za-z0-9_-]{4,20}$")
MAX_PDB_IDS = 5
MAX_KNOTPROT_IDS = 50
PUBLIC = "public, max-age=600"

PDB_QUERY = """
query structure($entry_ids: [String!]!) {
  entries(entry_ids: $entry_ids) {
    rcsb_id
    struct { title }
    struct_keywords { pdbx_keywords }
    exptl { method }
    rcsb_primary_citation { pdbx_database_id_DOI }
    pdbx_database_PDB_obs_spr { replace_pdb_id }
    rcsb_accession_info { deposit_date initial_release_date }
    citation { rcsb_authors }
    refine { pdbx_refine_id ls_d_res_high ls_R_factor_R_work }
    polymer_entities {
      rcsb_polymer_entity_container_identifiers { asym_ids auth_asym_ids uniprot_ids }
      rcsb_polymer_entity { pdbx_description }
      entity_poly { rcsb_sample_sequence_length rcsb_mutation_count }
      rcsb_entity_source_organism { scientific_name rcsb_gene_name { value provenance_source } }
    }
  }
}
"""


def _json_check(body: bytes) -> None:
    try:
        json.loads(body)
    except (ValueError, RecursionError):
        raise ValueError("not json") from None


def _json(body: bytes):
    try:
        return json.loads(body)
    except (ValueError, RecursionError):
        raise UpstreamError(502, "The upstream database sent an unexpected response.") from None


def _reply(data) -> Response:
    resp = jsonify(data)
    resp.headers["Cache-Control"] = PUBLIC
    return resp


def _pdb_id(raw: str) -> str:
    if not PDB_ID.match(raw):
        raise ApiError(400, "A PDB ID is four characters: a digit then three letters or digits, like 1R42.")
    return raw


def _uniprot_id(raw: str) -> str:
    if not UNIPROT_ID.match(raw):
        raise ApiError(400, "A UniProt ID is 4 to 20 letters, digits, '-' or '_', like P0DP23.")
    return raw


def _split_ids(raw: str, limit: int) -> list[str]:
    ids = raw.split(",")
    if not 1 <= len(ids) <= limit:
        raise ApiError(400, f"Ask for between 1 and {limit} PDB IDs at a time.")
    for i in ids:
        _pdb_id(i)
    return ids


# ------------------------------------------------------------------- RCSB ---


def _as_list(value) -> list:
    return value if isinstance(value, list) else []


def _entity_info(entity: dict) -> dict:
    ids = entity.get("rcsb_polymer_entity_container_identifiers") or {}
    poly = entity.get("entity_poly") or {}
    organisms = [o for o in _as_list(entity.get("rcsb_entity_source_organism")) if o]
    genes = _as_list(organisms[0].get("rcsb_gene_name")) if organisms else []
    return {
        "molecule": (entity.get("rcsb_polymer_entity") or {}).get("pdbx_description"),
        "chains": ids.get("asym_ids"),
        "auth_chains": ids.get("auth_asym_ids"),
        "length": poly.get("rcsb_sample_sequence_length"),
        "organism": [o.get("scientific_name") for o in organisms],
        "mutations": poly.get("rcsb_mutation_count"),
        "primary_data_genes": [g.get("value") for g in genes if g.get("provenance_source") == "Primary Data"],
        "uniprot_genes": [g.get("value") for g in genes if g.get("provenance_source") == "Uniprot"],
        "uniprot_ids": ids.get("uniprot_ids"),
    }


def _entry_info(entry: dict) -> dict:
    entities = [e for e in _as_list(entry.get("polymer_entities")) if e]
    refine = _as_list(entry.get("refine"))
    citation = _as_list(entry.get("citation"))
    exptl = _as_list(entry.get("exptl"))
    accession = entry.get("rcsb_accession_info") or {}
    refine0 = refine[0] if refine and refine[0] else None
    return {
        "id": entry.get("rcsb_id"),
        "desc": (entry.get("struct") or {}).get("title"),
        "prim_doi": (entry.get("rcsb_primary_citation") or {}).get("pdbx_database_id_DOI"),
        "supersedes": [x.get("replace_pdb_id") for x in _as_list(entry.get("pdbx_database_PDB_obs_spr")) if x],
        "keywords": (entry.get("struct_keywords") or {}).get("pdbx_keywords"),
        "organisms": sorted({o.get("scientific_name") for e in entities for o in _as_list(e.get("rcsb_entity_source_organism"))
                             if o and o.get("scientific_name")}),
        "mutations": sum(((e.get("entity_poly") or {}).get("rcsb_mutation_count") or 0) for e in entities),
        "deposited": accession.get("deposit_date"),
        "released": accession.get("initial_release_date"),
        "authors": (citation[0] or {}).get("rcsb_authors") if citation else None,
        "method": refine0.get("pdbx_refine_id") if refine0 else ((exptl[0] or {}).get("method") if exptl else None),
        "resolution": refine0.get("ls_d_res_high") if refine0 else None,
        "rvalue": refine0.get("ls_R_factor_R_work") if refine0 else None,
        "entities": [_entity_info(e) for e in entities],
        "uniprot_ids": sorted({u for e in entities
                               for u in ((e.get("rcsb_polymer_entity_container_identifiers") or {}).get("uniprot_ids") or [])}),
    }


@bp.get("/pdb/<ids>")
def pdb(ids: str):
    given = _split_ids(ids, MAX_PDB_IDS)
    wanted = sorted({i.upper() for i in given})
    body, _ = fetch("https://data.rcsb.org/graphql", json_body={"query": PDB_QUERY, "variables": {"entry_ids": wanted}},
                    max_bytes=2 * 1024 * 1024, accept="application/json", check=_json_check)
    payload = _json(body)
    entries = ((payload.get("data") or {}).get("entries") if isinstance(payload, dict) else None) or []
    by_id = {e["rcsb_id"].upper(): e for e in entries if isinstance(e, dict) and isinstance(e.get("rcsb_id"), str)}
    if not by_id:
        raise ApiError(404, "RCSB has no data for that PDB ID.")
    return _reply({i: _entry_info(by_id[i.upper()]) for i in given if i.upper() in by_id})


# ---------------------------------------------------------------- UniProt ---


def _uniprot_info(uniprot_id: str, data: dict) -> dict:
    comments = _as_list(data.get("comments"))
    diseases = [c["disease"] for c in comments if isinstance(c, dict) and isinstance(c.get("disease"), dict)]
    genes = _as_list(data.get("genes"))
    name = ((data.get("proteinDescription") or {}).get("recommendedName") or {}).get("fullName") or {}
    seq = data.get("sequence") or {}
    return {
        "id": uniprot_id,
        "protein": name.get("value"),
        "gene": ((genes[0] or {}).get("geneName") or {}).get("value") if genes else None,
        "molecular_functions": [k.get("name") for k in _as_list(data.get("keywords"))
                                if isinstance(k, dict) and k.get("category") == "Molecular function"],
        "organism": (data.get("organism") or {}).get("scientificName"),
        "sequence": seq.get("value"),
        "length": seq.get("length"),
        "diseases": [{"diseaseId": d.get("diseaseId"), "xRef": d.get("diseaseCrossReference")} for d in diseases],
    }


def _variants(output: dict, features: list) -> dict:
    """Pathogenic, UniProt-sourced natural variants grouped under the disease they are associated with."""
    features = [f for f in features if isinstance(f, dict) and f.get("association")]
    result: dict[str, list] = {}
    for disease in output["diseases"]:
        xref = disease.get("xRef") or {}
        found, seen = [], set()
        for f in features:
            sig = f.get("clinicalSignificances")
            if sig is not None and not any(isinstance(s, dict) and s.get("type") == "Pathogenic" for s in _as_list(sig)):
                continue
            if not any("UniProt" in (d.get("sources") or []) for d in _as_list(f.get("descriptions")) if isinstance(d, dict)):
                continue
            for assoc in _as_list(f.get("association")):
                for ref in _as_list(assoc.get("dbReferences") if isinstance(assoc, dict) else None):
                    if xref.get("database") == ref.get("name") and xref.get("id") == ref.get("id"):
                        v = {"begin": f.get("begin"), "end": f.get("end"), "wildType": f.get("wildType"),
                             "mutatedType": f.get("mutatedType")}
                        key = tuple(v.items())
                        if key not in seen:
                            seen.add(key)
                            found.append(v)
        result[disease.get("diseaseId")] = found
    return result


def _reduce_variants(body: bytes) -> bytes:
    """EBI answers with every variant of a protein (14 MB for p53; 56 MB for BRCA1). The request asks for sourcetype uniprot,mixed: UniProt-curated variants that ClinVar also lists are tagged mixed, and uniprot alone would drop them (all of insulin's). Keep only what _variants() reads."""
    data = json.loads(body)
    if not isinstance(data, list):
        raise ValueError("not a list")
    kept = []
    for f in (data[0].get("features") if data and isinstance(data[0], dict) else None) or []:
        if not isinstance(f, dict) or not f.get("association"):
            continue
        kept.append({
            "begin": f.get("begin"), "end": f.get("end"), "wildType": f.get("wildType"), "mutatedType": f.get("mutatedType"),
            "clinicalSignificances": [{"type": s.get("type")} for s in _as_list(f.get("clinicalSignificances")) if isinstance(s, dict)]
            if f.get("clinicalSignificances") is not None else None,
            "descriptions": [{"sources": d.get("sources")} for d in _as_list(f.get("descriptions")) if isinstance(d, dict)],
            "association": [{"dbReferences": [{"name": r.get("name"), "id": r.get("id")} for r in _as_list(a.get("dbReferences"))
                                              if isinstance(r, dict)]} for a in _as_list(f.get("association")) if isinstance(a, dict)],
        })
    return json.dumps([{"features": kept}]).encode()


@bp.get("/uniprot/<uid>")
def uniprot(uid: str):
    uid = _uniprot_id(uid)
    want_variants = request.args.get("variants", "").lower() in ("1", "true", "yes")
    body, _ = fetch(f"https://rest.uniprot.org/uniprotkb/{uid}.json", max_bytes=8 * 1024 * 1024,
                    accept="application/json", check=_json_check)
    data = _json(body)
    if not isinstance(data, dict):
        raise UpstreamError(502, "UniProt sent an unexpected response.")
    output = _uniprot_info(uid, data)
    if want_variants:
        try:
            vbody, _ = fetch("https://www.ebi.ac.uk/proteins/api/variation",
                             params={"offset": 0, "size": 100, "accession": uid, "sourcetype": "uniprot,mixed"}, max_bytes=32 * 1024 * 1024,
                             accept="application/json", reduce=_reduce_variants)
            vdata = _json(vbody)
            if isinstance(vdata, list) and vdata and isinstance(vdata[0], dict) and vdata[0].get("features"):
                output["variants"] = _variants(output, vdata[0]["features"])
        except UpstreamNotFound:
            pass    # no variation record for this protein
        except UpstreamError:
            output["variants_error"] = "Variant data is unavailable right now."
    return _reply(output)


# -------------------------------------------------------------- AlphaKnot ---


def _alphaknot_check(body: bytes) -> None:
    if "Knot_type" not in body[:2000].decode("utf-8", "replace").split("\n", 1)[0]:
        raise ValueError("not the expected table")


@bp.get("/alphaknot/<uid>")
def alphaknot(uid: str):
    uid = _uniprot_id(uid)
    body, _ = fetch(
        "https://alphaknot.cent.uw.edu.pl/browse/",
        params={"field": "Uniprot", "val": uid, "raw": 1, "cats": "AF1-Knot",
                "result_cols": "Uniprot;Knot_type;Category;Knot_probability;pLDDT_knotcore;Knotcore_range;Knotcore_length;pLDDT_chain"},
        max_bytes=2 * 1024 * 1024, accept="text/tab-separated-values,text/plain", check=_alphaknot_check)
    try:
        cols, rows = knotdata.parse_alphaknot_tsv(body.decode("utf-8", "replace"))
    except ValueError:
        raise UpstreamError(502, "AlphaKnot sent an unexpected response.") from None
    # the old backend returned DataFrame.to_dict(orient='list'): {column: [values...]}
    return _reply({c: [r.get(c) for r in rows] for c in cols})


# --------------------------------------------------------------- KnotProt ---


def _knotprot_check(body: bytes) -> None:
    if not body[:200].startswith(b"# PDB code"):
        raise ValueError("not the expected table")


def _knotprot_rows() -> list[dict]:
    body, _ = fetch("https://knotprot.cent.uw.edu.pl/_all_chains_knotted_N_C", max_bytes=4 * 1024 * 1024,
                    accept="text/plain,text/csv", check=_knotprot_check)
    rows = knotdata.parse_knotprot_csv(body.decode("utf-8", "replace"))
    if not rows:
        raise UpstreamError(502, "KnotProt sent an unexpected response.")
    return rows


@bp.get("/knotprot", defaults={"ids": None})
@bp.get("/knotprot/<ids>")
def knotprot(ids: str | None):
    wanted = _split_ids(ids, MAX_KNOTPROT_IDS) if ids is not None else None
    by_pdb: dict[str, list[dict]] = {}
    for row in _knotprot_rows():
        by_pdb.setdefault(row["pdbId"], []).append(row)

    def entry(chains: list[dict]) -> dict:
        # The old backend's per-chain dict (first chain), plus every chain of the entry under "chains".
        out = dict(chains[0])
        out["chains"] = chains
        return out

    if wanted is None:
        return _reply({k: entry(v) for k, v in by_pdb.items()})
    return _reply({i: (entry(by_pdb[i.lower()]) if i.lower() in by_pdb else None) for i in wanted})


# -------------------------------------------------------------- structure ---


def fetch_structure(pdb_id: str, fmt: str) -> str:
    """Coordinates text from files.rcsb.org (cached). Raises UpstreamNotFound if RCSB has no such file."""
    body, _ = fetch(f"https://files.rcsb.org/download/{pdb_id.upper()}.{fmt}", max_bytes=8 * 1024 * 1024,
                    accept="text/plain,*/*")
    return body.decode("utf-8", "replace")


@bp.get("/structure/<pdbid>.<fmt>")
def structure(pdbid: str, fmt: str):
    _pdb_id(pdbid)
    if fmt not in ("pdb", "cif"):
        raise ApiError(400, "The format must be pdb or cif.")
    resp = Response(fetch_structure(pdbid, fmt), mimetype="text/plain")
    resp.headers["Cache-Control"] = PUBLIC
    return resp
