"""Catalog filters, facets, sort, paging, CSV; and the snapshot builder's output."""
from __future__ import annotations

import csv
import io
import sqlite3
from pathlib import Path

from protop.build_catalog import write_snapshot
from protop.catalog import COLUMNS
from tests.helpers import Base

ROWS = [
    dict(source="alphaknot", uniprotId="P00918", knotType="3_1", category="AF1-Knot", organism="Human", proteinName="Carbonic anhydrase 2",
         knotCoreLength=232, knotProbability=0.5, diseases=["Osteopetrosis, autosomal recessive 3"]),
    dict(source="alphaknot", uniprotId="Q92560", knotType="5_2", category="AF1-Knot", organism="Human",
         proteinName="Ubiquitin carboxyl-terminal hydrolase BAP1", knotCoreLength=226, knotProbability=0.78, diseases=["Tumor predisposition syndrome 1"]),
    dict(source="alphaknot", uniprotId="O00001", knotType="6_3", category="AF1-Knot", organism="Yeast", proteinName="=cmd|' /C calc'!A0", knotCoreLength=482),
    dict(source="knotprot", pdbId="1uak", chain="A", knotType="3_1", knotCategory="K", category="Y", chainLength=252, knotCoreLength=44),
    dict(source="knotprot", pdbId="1aja", chain="A", knotType="3_1", knotCategory="S", category="Y", chainLength=449, knotCoreLength=324),
    dict(source="knotprot", pdbId="2bcd", chain="A", knotType="4_1", knotCategory="K", category="Y", chainLength=100, knotCoreLength=50),
    dict(source="knotprot", pdbId="6xyz", chain="A", knotType="8_20", knotCategory="K", category="T", chainLength=300),
    dict(source="knotprot", pdbId="7abc", chain="B", knotType="10_1", knotCategory="K", category="T", chainLength=300),
]
META = {"date": "2026-01-02", "sources": '["AlphaKnot test", "KnotProt test"]', "note": "test snapshot"}


class CatalogBase(Base):
    def setUp(self):
        super().setUp()
        write_snapshot(self.catalog_path, [dict(r, **{"knotOrder": 0}) for r in ROWS], META)

    def get(self, qs=""):
        r = self.c.get("/catalog" + qs)
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        return r.get_json()


class Catalog(CatalogBase):
    def test_default_listing_and_shape(self):
        j = self.get()
        self.assertEqual((j["total"], j["page"], j["per_page"]), (8, 1, 25))
        self.assertEqual(j["snapshot"]["date"], "2026-01-02")
        self.assertEqual(j["snapshot"]["sources"], ["AlphaKnot test", "KnotProt test"])
        self.assertEqual(set(COLUMNS) | {"id"}, set(j["rows"][0]))
        # default order: knot type by crossing number, then 8_20 and 10_1 after the single digits
        self.assertEqual([r["knotType"] for r in j["rows"]], ["3_1"] * 3 + ["4_1", "5_2", "6_3", "8_20", "10_1"])
        self.assertEqual(j["facets"]["knot_types"],
                         [{"name": "3_1", "count": 3}, {"name": "4_1", "count": 1}, {"name": "5_2", "count": 1},
                          {"name": "6_3", "count": 1}, {"name": "8_20", "count": 1}, {"name": "10_1", "count": 1}])
        self.assertEqual(j["facets"]["sources"], [{"name": "alphaknot", "count": 3}, {"name": "knotprot", "count": 5}])
        self.assertEqual(j["rows"][0]["diseases"], ["Osteopetrosis, autosomal recessive 3"])

    def test_filters(self):
        self.assertEqual({r["pdbId"] or r["uniprotId"] for r in self.get("?knot=3_1")["rows"]}, {"P00918", "1uak", "1aja"})
        self.assertEqual(self.get("?knot=31")["total"], 3)                      # KnotProt's own spelling works too
        self.assertEqual(self.get("?source=knotprot")["total"], 5)
        self.assertEqual(self.get("?source=alphaknot&knot=3_1")["total"], 1)
        self.assertEqual(self.get("?q=ubiquitin")["total"], 1)
        self.assertEqual(self.get("?q=1UAK")["total"], 1)
        self.assertEqual(self.get("?q=carbonic+human")["total"], 1)             # all terms must match
        self.assertEqual(self.get("?q=tumor")["total"], 1)                      # disease names are searched
        self.assertEqual(self.get("?q=%25")["total"], 0)                        # LIKE wildcards are literal
        self.assertEqual(self.get("?q=zzzz")["rows"], [])
        j = self.get("?q=human")
        self.assertEqual(j["facets"]["knot_types"], [{"name": "3_1", "count": 1}, {"name": "5_2", "count": 1}])
        j = self.get("?knot=3_1")                                               # facets ignore their own filter
        self.assertEqual(len(j["facets"]["knot_types"]), 6)

    def test_sort_and_paging(self):
        j = self.get("?sort=knotCoreLength&order=desc&per_page=3")
        self.assertEqual([r["knotCoreLength"] for r in j["rows"]], [482, 324, 232])
        j2 = self.get("?sort=knotCoreLength&order=desc&per_page=3&page=2")
        self.assertEqual([r["knotCoreLength"] for r in j2["rows"]], [226, 50, 44])
        j3 = self.get("?sort=knotCoreLength&order=desc&per_page=3&page=3")
        self.assertEqual([r["knotCoreLength"] for r in j3["rows"]], [None, None])    # nulls always last
        self.assertEqual(self.get("?sort=pdbId&order=asc&source=knotprot")["rows"][0]["pdbId"], "1aja")
        self.assertEqual(self.get("?page=50")["rows"], [])
        self.assertEqual(self.get("?sort=chainLength&order=desc&source=knotprot&per_page=1")["rows"][0]["chainLength"], 449)

    def test_bad_arguments(self):
        for qs in ("sort=id;drop", "sort=knotOrder", "sort=x", "order=sideways", "page=0", "page=-1", "page=x", "per_page=0",
                   "per_page=101", "per_page=1e3", "source=other", "q=" + "a" * 101, "knot=" + "a" * 21):
            self.assertEqual(self.c.get("/catalog?" + qs).status_code, 400, qs)

    def test_sql_injection_is_inert(self):
        self.assertEqual(self.get("?q=%27%3BDROP+TABLE+catalog%3B--")["total"], 0)
        self.assertEqual(self.get()["total"], 8)

    def test_missing_snapshot_is_503(self):
        self.catalog_path.unlink()
        self.assertEqual(self.c.get("/catalog").status_code, 503)

    def test_snapshot_is_opened_read_only(self):
        from protop.catalog import open_snapshot
        conn = open_snapshot(self.catalog_path)
        with self.assertRaises(sqlite3.OperationalError):
            conn.execute("DELETE FROM catalog")
        conn.close()


class CatalogCsv(CatalogBase):
    def test_csv(self):
        r = self.c.get("/catalog.csv?source=knotprot&sort=pdbId")
        self.assertEqual((r.status_code, r.mimetype), (200, "text/csv"))
        self.assertIn("attachment", r.headers["Content-Disposition"])
        rows = list(csv.reader(io.StringIO(r.get_data(as_text=True))))
        self.assertEqual(rows[0], COLUMNS)
        self.assertEqual(len(rows), 6)
        self.assertEqual(rows[1][COLUMNS.index("pdbId")], "1aja")

    def test_csv_all_and_formula_escape_and_disease_join(self):
        rows = list(csv.reader(io.StringIO(self.c.get("/catalog.csv").get_data(as_text=True))))
        self.assertEqual(len(rows), 9)
        name = [r[COLUMNS.index("proteinName")] for r in rows[1:] if "calc" in r[COLUMNS.index("proteinName")]][0]
        self.assertTrue(name.startswith("'="))
        self.assertIn("Osteopetrosis, autosomal recessive 3", [r[COLUMNS.index("diseases")] for r in rows[1:]])

    def test_csv_arguments_validated_and_row_cap(self):
        self.assertEqual(self.c.get("/catalog.csv?sort=zzz").status_code, 400)
        from unittest import mock
        with mock.patch("protop.catalog.MAX_CSV_ROWS", 2):
            self.assertEqual(len(self.c.get("/catalog.csv").get_data(as_text=True).strip().splitlines()), 3)


class ShippedSnapshot(Base):
    """The committed snapshot loads and answers (guards against shipping a broken build)."""

    def test_committed_snapshot(self):
        path = Path(__file__).resolve().parent.parent / "protop" / "data" / "catalog.sqlite"
        self.assertTrue(path.is_file())
        self.assertLess(path.stat().st_size, 5 * 1024 * 1024)
        app = __import__("protop").create_app({"DATA_DIR": self.dir, "CATALOG_PATH": path})
        j = app.test_client().get("/catalog?per_page=5").get_json()
        self.assertGreater(j["total"], 300)
        self.assertEqual({s["name"] for s in j["facets"]["sources"]}, {"alphaknot", "knotprot"})
        self.assertTrue(j["snapshot"]["date"] and j["snapshot"]["sources"])
