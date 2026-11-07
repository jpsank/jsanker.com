"""Aggregator endpoints with a fake `requests`: shapes, validation, caching, failure mapping."""
from __future__ import annotations

import json
import time
from unittest import mock
from urllib.parse import urlsplit

import requests

from protop.upstream import HOSTS
from tests.helpers import PDB_TEXT, Base, FakeResp

GRAPHQL = {"data": {"entries": [{
    "rcsb_id": "1R42", "struct": {"title": "Angiotensin converting enzyme 2"}, "struct_keywords": {"pdbx_keywords": "HYDROLASE"},
    "exptl": [{"method": "X-RAY DIFFRACTION"}], "rcsb_primary_citation": {"pdbx_database_id_DOI": "10.1/x"},
    "pdbx_database_PDB_obs_spr": [{"replace_pdb_id": "1ABC"}],
    "rcsb_accession_info": {"deposit_date": "2003-10-03", "initial_release_date": "2003-11-04"},
    "citation": [{"rcsb_authors": ["Towler, P."]}],
    "refine": [{"pdbx_refine_id": "X-RAY DIFFRACTION", "ls_d_res_high": 2.2, "ls_R_factor_R_work": 0.2}],
    "polymer_entities": [{
        "rcsb_polymer_entity_container_identifiers": {"asym_ids": ["A"], "auth_asym_ids": ["A"], "uniprot_ids": ["Q9BYF1"]},
        "rcsb_polymer_entity": {"pdbx_description": "ACE2"}, "entity_poly": {"rcsb_sample_sequence_length": 597, "rcsb_mutation_count": 2},
        "rcsb_entity_source_organism": [{"scientific_name": "Homo sapiens", "rcsb_gene_name": [
            {"value": "ACE2", "provenance_source": "Primary Data"}, {"value": "ACE2", "provenance_source": "Uniprot"}]}]}]}]}}

UNIPROT = {"comments": [{"commentType": "DISEASE", "disease": {"diseaseId": "Test disease", "diseaseCrossReference": {"database": "MIM", "id": "123"}}},
                        {"commentType": "FUNCTION"}],
           "proteinDescription": {"recommendedName": {"fullName": {"value": "A protein"}}}, "genes": [{"geneName": {"value": "GENE1"}}],
           "keywords": [{"category": "Molecular function", "name": "Hydrolase"}, {"category": "Ligand", "name": "Zinc"}],
           "organism": {"scientificName": "Homo sapiens"}, "sequence": {"value": "MKL", "length": 3}}

VARIANTS = [{"features": [
    {"begin": "5", "end": "5", "wildType": "R", "mutatedType": "W", "clinicalSignificances": [{"type": "Pathogenic"}],
     "descriptions": [{"sources": ["UniProt"]}], "association": [{"dbReferences": [{"name": "MIM", "id": "123"}]}]},
    {"begin": "6", "end": "6", "wildType": "A", "mutatedType": "T", "clinicalSignificances": [{"type": "Benign"}],
     "descriptions": [{"sources": ["UniProt"]}], "association": [{"dbReferences": [{"name": "MIM", "id": "123"}]}]}]}]

ALPHAKNOT_TSV = ("#Uniprot\tKnot_type\tCategory\tKnot_probability\tpLDDT_knotcore\tKnotcore_range\tKnotcore_length\tpLDDT_chain\t#FILTER: Uniprot=O00534;\n"
                 "O00534-F1\t6_3\tAF1-Knot\t0.76\t88.6\t132-614\t482\t83.7\n"
                 "O00534-F1\t6_3\tAF1-Knot\t0.76\t88.6\t30-610\t580\t83.7\n")

KNOTPROT = ("# PDB code;Chain;Chain Length;{Y,A,T}={Published,Artifact,Not published};{K,S}={Knot,Slipknot};Main knot type (e.g. 31=3.1);N_cut;C_cut;Knots range\n"
            "1uak;A;252;Y;K;31;88;120;89-132\n1uak;B;252;Y;K;31;88;120;89-132\n4abc;A;100;T;K;None;None;None;None\n6xyz;A;300;Y;S;820;5;6;10-60\n")


def js(obj, status=200):
    return FakeResp(status, json.dumps(obj))


class Aggregator(Base):
    def setUp(self):
        super().setUp()
        orig = self.up.__call__

        def checked(method, url, **kw):
            parts = urlsplit(url)
            assert parts.scheme == "https" and parts.hostname in HOSTS, url
            assert kw["timeout"] == (5, 20) and kw["stream"] is True and kw["allow_redirects"] is False
            return orig(method, url, **kw)

        self.up.__call__ = checked
        self.addCleanup(lambda: None)
        patcher = mock.patch("protop.upstream.requests.request", checked)
        patcher.start()
        self.addCleanup(patcher.stop)

    def age_cache(self, seconds=90000):
        from protop.db import open_db
        c = open_db(self.app)
        c.execute("UPDATE cache SET fetched = fetched - ?", (seconds,))
        c.close()

    # ---- shapes
    def test_pdb_shape(self):
        self.up.add("data.rcsb.org/graphql", js(GRAPHQL))
        r = self.c.get("/pdb/1r42")
        self.assertEqual(r.status_code, 200)
        e = r.get_json()["1r42"]
        self.assertEqual((e["id"], e["desc"], e["keywords"], e["method"], e["resolution"], e["rvalue"]),
                         ("1R42", "Angiotensin converting enzyme 2", "HYDROLASE", "X-RAY DIFFRACTION", 2.2, 0.2))
        self.assertEqual((e["prim_doi"], e["supersedes"], e["organisms"], e["mutations"], e["deposited"], e["released"], e["authors"]),
                         ("10.1/x", ["1ABC"], ["Homo sapiens"], 2, "2003-10-03", "2003-11-04", ["Towler, P."]))
        self.assertEqual(e["uniprot_ids"], ["Q9BYF1"])
        self.assertEqual(e["entities"], [{"molecule": "ACE2", "chains": ["A"], "auth_chains": ["A"], "length": 597,
                                          "organism": ["Homo sapiens"], "mutations": 2, "primary_data_genes": ["ACE2"],
                                          "uniprot_genes": ["ACE2"], "uniprot_ids": ["Q9BYF1"]}])
        self.assertEqual(self.up.calls[0][2]["json"]["variables"], {"entry_ids": ["1R42"]})
        self.assertIn("max-age", r.headers["Cache-Control"])

    def test_pdb_tolerates_sparse_entries_and_unknown_ids(self):
        self.up.add("graphql", js({"data": {"entries": [{"rcsb_id": "1R42"}]}}))
        e = self.c.get("/pdb/1R42,9ZZZ").get_json()
        self.assertEqual(list(e), ["1R42"])
        self.assertEqual((e["1R42"]["entities"], e["1R42"]["method"], e["1R42"]["authors"]), ([], None, None))
        self.up.routes.clear()
        self.up.add("graphql", js({"data": {"entries": []}}))
        self.assertEqual(self.c.get("/pdb/9ZZZ").status_code, 404)

    def test_uniprot_shape_and_variants(self):
        self.up.add("rest.uniprot.org/uniprotkb/Q9BYF1.json", js(UNIPROT))
        j = self.c.get("/uniprot/Q9BYF1").get_json()
        self.assertEqual(j, {"id": "Q9BYF1", "protein": "A protein", "gene": "GENE1", "molecular_functions": ["Hydrolase"],
                             "organism": "Homo sapiens", "sequence": "MKL", "length": 3,
                             "diseases": [{"diseaseId": "Test disease", "xRef": {"database": "MIM", "id": "123"}}]})
        self.up.add("ebi.ac.uk/proteins/api/variation", js(VARIANTS))
        j = self.c.get("/uniprot/Q9BYF1?variants=true").get_json()
        self.assertEqual(j["variants"], {"Test disease": [{"begin": "5", "end": "5", "wildType": "R", "mutatedType": "W"}]})
        self.assertNotIn("variants", self.c.get("/uniprot/Q9BYF1?variants=false").get_json())

    def test_variants_request_includes_mixed_source_type(self):
        # Variants UniProt curates and ClinVar also lists are tagged "mixed"; sourcetype=uniprot alone drops them
        # (all of insulin's pathogenic ones), so the request must ask for both.
        self.up.add("rest.uniprot.org", js(UNIPROT))
        self.up.add("ebi.ac.uk/proteins/api/variation", js(VARIANTS))
        self.c.get("/uniprot/Q9BYF1?variants=true")
        call = [c for c in self.up.calls if "variation" in c[1]][0]
        params = call[2].get("params") or {}
        self.assertEqual(params.get("sourcetype") or call[1].split("sourcetype=")[-1].split("&")[0].replace("%2C", ","), "uniprot,mixed")

    def test_variants_are_reduced_before_caching(self):
        big = [{"features": VARIANTS[0]["features"] + [{"begin": str(i), "description": "x" * 200} for i in range(500)]}]
        self.up.add("rest.uniprot.org", js(UNIPROT))
        self.up.add("ebi.ac.uk/proteins/api/variation", js(big))
        self.assertIn("variants", self.c.get("/uniprot/Q9BYF1?variants=true").get_json())
        from protop.db import open_db
        c = open_db(self.app)
        size = c.execute("SELECT size FROM cache WHERE key LIKE '%variation%'").fetchone()[0]
        c.close()
        self.assertLess(size, 2000)

    def test_variants_failure_degrades(self):
        self.up.add("rest.uniprot.org", js(UNIPROT))
        self.up.add("ebi.ac.uk", FakeResp(503))
        j = self.c.get("/uniprot/Q9BYF1?variants=1").get_json()
        self.assertIn("variants_error", j)
        self.assertEqual(j["gene"], "GENE1")

    def test_alphaknot_is_columns_of_lists(self):
        self.up.add("alphaknot.cent.uw.edu.pl", FakeResp(200, ALPHAKNOT_TSV, {"Content-Type": "text/plain"}))
        j = self.c.get("/alphaknot/O00534").get_json()
        self.assertEqual(j["uniprotId"], ["O00534", "O00534"])
        self.assertEqual(j["knotType"], ["6_3", "6_3"])
        self.assertEqual(j["knotCoreLength"], [482, 580])
        self.assertEqual(j["knotProbability"], [0.76, 0.76])
        self.assertEqual((j["knotCoreStart"], j["knotCoreEnd"]), ([132, 30], [614, 610]))
        self.assertEqual(j["pLDDT_knotCore"], [88.6, 88.6])
        self.assertFalse([k for k in j if k.startswith("FILTER") or k.startswith("#")])
        url = self.up.calls[0][1]
        self.assertIn("val=O00534", url)

    def test_alphaknot_no_results_and_html_response(self):
        self.up.add("alphaknot.cent.uw.edu.pl", FakeResp(200, "#Uniprot\tKnot_type\tCategory\n"))
        j = self.c.get("/alphaknot/P12345").get_json()
        self.assertEqual(j, {"uniprotId": [], "knotType": [], "category": []})
        self.up.routes.clear()
        self.up.add("alphaknot.cent.uw.edu.pl", FakeResp(200, "<html>oops secret-upstream-body</html>"))
        r = self.c.get("/alphaknot/P99999")
        self.assertEqual(r.status_code, 502)
        self.assertNotIn("secret-upstream-body", r.get_data(as_text=True))

    def test_knotprot_all_and_some(self):
        self.up.add("knotprot.cent.uw.edu.pl", FakeResp(200, KNOTPROT, {"Content-Type": "text/plain"}))
        allj = self.c.get("/knotprot").get_json()
        self.assertEqual(sorted(allj), ["1uak", "4abc", "6xyz"])
        self.assertIsNone(allj["4abc"]["knotType"])             # unknown values are null, never "None" or NaN
        self.assertEqual(len(self.up.calls), 1)
        j = self.c.get("/knotprot/1UAK,6xyz,2xxx").get_json()
        self.assertEqual(list(j), ["1UAK", "6xyz", "2xxx"])
        self.assertIsNone(j["2xxx"])
        e = j["1UAK"]
        self.assertEqual((e["chain"], e["chainLength"], e["category"], e["knotCategory"], e["knotType"], e["nCut"], e["cCut"],
                          e["knotRange"], e["knotRangeStart"], e["knotRangeEnd"], e["knotCoreLength"], e["knotTypeName"]),
                         ("A", 252, "Y", "K", "31", 88, 120, "89-132", 89, 132, 44, "3_1"))
        self.assertEqual([c["chain"] for c in e["chains"]], ["A", "B"])
        self.assertEqual(j["6xyz"]["knotTypeName"], "8_20")
        self.assertEqual(len(self.up.calls), 1)                 # served from the cache

    def test_structure_endpoint(self):
        self.up.add("files.rcsb.org/download/1R42.pdb", FakeResp(200, PDB_TEXT, {"Content-Type": "application/octet-stream"}))
        r = self.c.get("/structure/1r42.pdb")
        self.assertEqual((r.status_code, r.mimetype), (200, "text/plain"))
        self.assertEqual(r.get_data(as_text=True), PDB_TEXT)
        self.up.add("files.rcsb.org/download/9ZZZ.cif", FakeResp(404))
        self.assertEqual(self.c.get("/structure/9ZZZ.cif").status_code, 404)
        self.assertEqual(self.c.get("/structure/1R42.exe").status_code, 400)

    # ---- validation
    def test_ids_are_validated_before_any_request(self):
        bad = ["../../etc/passwd", "..%2F..%2Fetc%2Fpasswd", "12345", "abc", "1R4!", "1R42%00", "a" * 5000, "1R42,..", "%0d%0aX",
               "1R42,,", ",", "1r4_", "R142"]
        for i in bad:
            for path in ("/pdb/", "/knotprot/", "/structure/"):
                suffix = ".pdb" if path == "/structure/" else ""
                r = self.c.get(path + i + suffix)
                self.assertIn(r.status_code, (400, 404), (path, i))
                self.assertIn("error", r.get_json())
        for i in ["../x", "a b", "abc", "x" * 21, "A" * 5000, "P12345;rm", "P1234/../x", "%2e%2e"]:
            for path in ("/uniprot/", "/alphaknot/"):
                self.assertIn(self.c.get(path + i).status_code, (400, 404), (path, i))
        self.assertEqual(self.c.get("/pdb/1R42,1R43,1R44,1R45,1R46,1R47").status_code, 400)
        self.assertEqual(self.c.get("/knotprot/" + ",".join(["1R42"] * 51)).status_code, 400)
        self.assertEqual(self.up.calls, [])

    # ---- failure mapping
    def test_failure_mapping(self):
        cases = [(requests.Timeout("secret"), 504), (requests.ConnectionError("secret host"), 502), (FakeResp(500, "secret body"), 502),
                 (FakeResp(429, "secret"), 502), (FakeResp(403, "secret"), 502), (FakeResp(404, "secret"), 404),
                 (FakeResp(200, "not json secret"), 502), (FakeResp(200, "[1,2" * 2), 502)]
        for result, status in cases:
            self.up.routes.clear()
            self.up.add("rest.uniprot.org", result)
            r = self.c.get("/uniprot/P12345")
            self.assertEqual(r.status_code, status, repr(result))
            self.assertNotIn("secret", r.get_data(as_text=True))
            self.assertIn("error", r.get_json())

    def test_oversize_and_decoy_redirects(self):
        self.up.add("rest.uniprot.org", FakeResp(200, b"x" * (9 * 1024 * 1024)))
        self.assertEqual(self.c.get("/uniprot/P12345").status_code, 502)
        self.up.routes.clear()
        self.up.add("rest.uniprot.org", FakeResp(200, b"{}", {"Content-Length": str(99 * 1024 * 1024)}))
        self.assertEqual(self.c.get("/uniprot/P22222").status_code, 502)
        self.up.routes.clear()
        self.up.add("rest.uniprot.org", FakeResp(302, b"", {"Location": "https://evil.example/x"}))
        r = self.c.get("/uniprot/P33333")
        self.assertEqual(r.status_code, 502)
        self.assertEqual(len(self.up.calls), 3)      # never followed to the other host
        self.up.routes.clear()
        self.up.add("rest.uniprot.org/uniprot/P44444", FakeResp(303, b"", {"Location": "https://rest.uniprot.org/uniprotkb/P44444.json"}))
        self.up.add("rest.uniprot.org/uniprotkb/P44444", js(UNIPROT))
        self.assertEqual(self.c.get("/uniprot/P44444").status_code, 200)

    # ---- cache
    def test_cache_and_serve_stale(self):
        self.up.add("rest.uniprot.org", js(UNIPROT))
        self.assertEqual(self.c.get("/uniprot/Q9BYF1").status_code, 200)
        self.assertEqual(self.c.get("/uniprot/Q9BYF1").status_code, 200)
        self.assertEqual(len(self.up.calls), 1)
        self.age_cache()
        self.up.routes.clear()
        self.up.add("rest.uniprot.org", requests.Timeout())
        r = self.c.get("/uniprot/Q9BYF1")                      # stale copy beats an error
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["gene"], "GENE1")
        self.up.routes.clear()
        self.up.add("rest.uniprot.org", js(dict(UNIPROT, genes=[{"geneName": {"value": "NEW"}}])))
        self.assertEqual(self.c.get("/uniprot/Q9BYF1").get_json()["gene"], "NEW")   # refreshed when upstream is back

    def test_bad_upstream_body_is_not_cached(self):
        self.up.add("rest.uniprot.org", FakeResp(200, "<html>"))
        self.assertEqual(self.c.get("/uniprot/Q9BYF1").status_code, 502)
        self.up.routes.clear()
        self.up.add("rest.uniprot.org", js(UNIPROT))
        self.assertEqual(self.c.get("/uniprot/Q9BYF1").status_code, 200)

    def test_cache_trim_keeps_size_bounded(self):
        from protop.db import open_db
        from protop.upstream import trim_cache
        c = open_db(self.app)
        now = time.time()
        for i in range(10):
            c.execute("INSERT INTO cache VALUES (?, ?, 'x', ?, 100)", (f"k{i}", b"x" * 100, now - i))
        c.execute("INSERT INTO cache VALUES ('ancient', x'00', 'x', ?, 1)", (now - 30 * 86400,))
        trim_cache(c, 500)
        keys = {r[0] for r in c.execute("SELECT key FROM cache")}
        self.assertNotIn("ancient", keys)
        self.assertIn("k0", keys)
        self.assertLessEqual(c.execute("SELECT SUM(size) FROM cache").fetchone()[0], 500)
        c.close()

    def test_upstream_miss_rate_limit(self):
        self.up.add("rest.uniprot.org", js(UNIPROT))
        with mock.patch("protop.upstream.MISSES_PER_MINUTE", 2):
            self.assertEqual(self.c.get("/uniprot/AAAA1").status_code, 200)
            self.assertEqual(self.c.get("/uniprot/AAAA2").status_code, 200)
            r = self.c.get("/uniprot/AAAA3")
            self.assertEqual(r.status_code, 429)
            self.assertIn("Retry-After", r.headers)
            self.assertEqual(self.c.get("/uniprot/AAAA1").status_code, 200)   # cached answers are never limited

    def test_headers_on_every_kind_of_response(self):
        self.up.add("rest.uniprot.org", js(UNIPROT))
        for path in ("/uniprot/Q9BYF1", "/uniprot/!!", "/nope", "/catalog.csv", "/rooms/" + "a" * 22):
            r = self.c.get(path)
            self.assertEqual(r.headers["X-Content-Type-Options"], "nosniff", path)
            self.assertIn("default-src 'none'", r.headers["Content-Security-Policy"], path)
            self.assertTrue(r.headers.get("Cache-Control"), path)
        self.assertEqual(self.c.get("/nope").get_json(), {"error": "Not found."})
        self.assertEqual(self.c.post("/pdb/1R42").status_code, 405)
        self.assertEqual(self.c.post("/pdb/1R42").mimetype, "application/json")

    def test_script_name_mount(self):
        self.up.add("rest.uniprot.org", js(UNIPROT))
        r = self.c.get("/uniprot/Q9BYF1", environ_overrides={"SCRIPT_NAME": "/projects/protop/api"})
        self.assertEqual(r.status_code, 200)
