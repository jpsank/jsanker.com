"""Shared test fixtures: a fresh app per test, fake `requests`, tiny PDB / mmCIF texts."""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_tmp = tempfile.mkdtemp(prefix="protop-test-")
os.environ["APP_DATA_DIR"] = _tmp

import logging  # noqa: E402

import requests  # noqa: E402

from protop import create_app  # noqa: E402
from protop.build_catalog import write_snapshot  # noqa: E402
from protop.security import limiter  # noqa: E402

logging.getLogger("protop").setLevel(logging.CRITICAL)


def atom(serial, name, res, chain, num, icode="", record="ATOM", x=1.0):
    return (f"{record:<6}{serial:>5} {name:<4} {res:>3} {chain}{num:>4}{icode}   "
            f"{x:8.3f}{2.0:8.3f}{3.0:8.3f}{1.0:6.2f}{0.0:6.2f}          {name[0]:>2}")


def make_pdb(title="TEST PROTEIN", models=1):
    lines = [f"HEADER    TEST                                    01-JAN-23   1ABC", f"TITLE     {title}"]
    for m in range(models):
        if models > 1:
            lines.append(f"MODEL     {m + 1:>4}")
        n = 1
        for chain, seq in (("A", [("MET", 1), ("LYS", 2), ("LEU", 3), ("GLY", 4)]), ("B", [("ALA", 10), ("CYS", 11)])):
            for res, num in seq:
                lines.append(atom(n, "CA", res, chain, num))
                n += 1
        lines.append(atom(n, "CA", "LYS", "A", 2, icode="A"))   # insertion code residue
        lines.append(atom(n + 1, "O", "HOH", "A", 100, record="HETATM"))   # water: not polymer
        lines.append(atom(n + 2, "CA", "MSE", "A", 5, record="HETATM"))    # modified residue: polymer, X
        if models > 1:
            lines.append("ENDMDL")
    lines.append("END")
    return "\n".join(lines) + "\n"


PDB_TEXT = make_pdb()
# chain A residues in file order: 1 M, 2 K, 3 L, 4 G, 2A K, 5 X ; chain B: 10 A, 11 C

CIF_TEXT = """data_TEST
_struct.title 'A TINY MMCIF'
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.label_atom_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.auth_seq_id
_atom_site.auth_comp_id
_atom_site.auth_asym_id
_atom_site.pdbx_PDB_ins_code
_atom_site.pdbx_PDB_model_num
_atom_site.Cartn_x
ATOM 1 CA MET A 1 7 MET H ? 1 1.0
ATOM 2 CA GLY A 2 8 GLY H ? 1 2.0
HETATM 3 O HOH B . 99 HOH H ? 1 3.0
ATOM 4 CA MET A 1 7 MET H ? 2 1.0
#
"""


class FakeResp:
    def __init__(self, status=200, body=b"", headers=None):
        self.status_code = status
        self.body = body if isinstance(body, bytes) else body.encode()
        self.headers = {"Content-Type": "application/json", **(headers or {})}
        self.closed = False

    def iter_content(self, chunk_size=1):
        for i in range(0, len(self.body), 4096):
            yield self.body[i:i + 4096]

    def close(self):
        self.closed = True


class Upstream:
    """Stands in for requests.request. routes: list of (substring of url, response or exception or callable)."""

    def __init__(self):
        self.routes = []
        self.calls = []

    def add(self, needle, result):
        self.routes.append((needle, result))

    def __call__(self, method, url, **kw):
        self.calls.append((method, url, kw))
        for needle, result in self.routes:
            if needle in url:
                r = result(method, url, kw) if callable(result) else result
                if isinstance(r, BaseException):
                    raise r
                return r
        raise AssertionError(f"unexpected upstream call: {method} {url}")


class Base(unittest.TestCase):
    def setUp(self):
        limiter.reset()
        self.dir = Path(tempfile.mkdtemp(prefix="case-", dir=_tmp))
        self.catalog_path = self.dir / "catalog.sqlite"
        self.up = Upstream()
        patcher = mock.patch("protop.upstream.requests.request", self.up)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.app = create_app({"DATA_DIR": self.dir, "CATALOG_PATH": self.catalog_path})
        self.c = self.app.test_client()

    # ---- rooms
    def new_room(self, text=None, name="t.pdb"):
        r = self.c.post("/rooms", json={"upload": {"name": name, "text": text or PDB_TEXT}})
        self.assertEqual(r.status_code, 201, r.get_data(as_text=True)[:300])
        return r.get_json()

    def op(self, rid, **body):
        body.setdefault("client", "client-aaaa1111")
        body.setdefault("author", "Ada")
        return self.c.post(f"/rooms/{rid}/ops", json=body)
