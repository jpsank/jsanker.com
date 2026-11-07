"""Structure reader tests:  python -m unittest discover -s tests"""
from __future__ import annotations

import time
import unittest
from unittest import mock

from tests.helpers import CIF_TEXT, PDB_TEXT, atom, make_pdb
from protop.structure import StructureError, parse_structure


class PdbReader(unittest.TestCase):
    def test_chains_and_residues(self):
        p = parse_structure(PDB_TEXT)
        self.assertEqual((p.fmt, p.title), ("pdb", "TEST PROTEIN"))
        self.assertEqual([c["name"] for c in p.chains], ["A", "B"])
        a = p.chains[0]["residues"]
        self.assertEqual([(r["num"], r["icode"], r["aa"]) for r in a],
                         [(1, "", "M"), (2, "", "K"), (3, "", "L"), (4, "", "G"), (2, "A", "K"), (5, "", "X")])
        self.assertEqual([r["aa"] for r in p.chains[1]["residues"]], ["A", "C"])   # water and ligands are not polymer

    def test_only_first_model(self):
        p = parse_structure(make_pdb(models=3))
        self.assertEqual(len(p.chains[0]["residues"]), 6)

    def test_unknown_residue_is_x_and_blank_chain_is_named(self):
        text = atom(1, "CA", "ZZZ", " ", 1) + "\n"
        p = parse_structure(text)
        self.assertEqual(p.chains[0]["name"], "_")
        self.assertEqual(p.chains[0]["residues"][0]["aa"], "X")

    def test_rejects_garbage(self):
        for bad in ["", "   \n", "hello world\n" * 10, "ATOM      1  CA  MET A   1\n", "\x00\x01\x02" * 50,
                    "HETATM" + " " * 60 + "\n", atom(1, "CA", "MET", "A", 1).replace("   1.000", "   abcde")]:
            with self.assertRaises(StructureError, msg=repr(bad[:30])):
                parse_structure(bad)

    def test_ligand_only_has_no_polymer(self):
        with self.assertRaises(StructureError):
            parse_structure(atom(1, "O", "HOH", "A", 1, record="HETATM") + "\n")

    def test_atom_cap(self):
        line = atom(1, "CA", "GLY", "A", 1)
        with mock.patch("protop.structure.MAX_ATOMS", 10):
            parse_structure((line + "\n") * 10)
            with self.assertRaises(StructureError) as cm:
                parse_structure((line + "\n") * 11)
        self.assertIn("atoms", str(cm.exception))
        cif = CIF_TEXT.replace("ATOM 4 CA MET A 1 7 MET H ? 2 1.0\n", "") + "ATOM 9 CA GLY A 3 9 GLY H ? 1 1.0\n" * 5
        with mock.patch("protop.structure.MAX_ATOMS", 5), self.assertRaises(StructureError):
            parse_structure(cif)

    def test_size_cap_and_speed(self):
        t0 = time.monotonic()
        with self.assertRaises(StructureError):
            parse_structure("x" * (5 * 1024 * 1024 + 1))
        self.assertLess(time.monotonic() - t0, 1.0)

    def test_large_file_parses_fast(self):
        lines = [atom(i, "CA", "ALA", "A", i % 9000 + 1) for i in range(1, 50_000)]
        t0 = time.monotonic()
        p = parse_structure("\n".join(lines) + "\n")
        self.assertEqual(len(p.chains[0]["residues"]), 9000)
        self.assertLess(time.monotonic() - t0, 5.0)


class CifReader(unittest.TestCase):
    def test_uses_author_ids_and_first_model(self):
        p = parse_structure(CIF_TEXT)
        self.assertEqual((p.fmt, p.title), ("cif", "A TINY MMCIF"))
        self.assertEqual(p.chains, [{"name": "H", "residues": [{"num": 7, "icode": "", "aa": "M"}, {"num": 8, "icode": "", "aa": "G"}]}])

    def test_multiline_title_and_quotes(self):
        text = CIF_TEXT.replace("_struct.title 'A TINY MMCIF'", "_struct.title\n;A long\ntitle\n;\n_entity.note 'it''s'")
        self.assertEqual(parse_structure(text).title, "A long title")

    def test_rejects_cif_without_atoms_or_columns(self):
        with self.assertRaises(StructureError):
            parse_structure("data_X\n_cell.length_a 1.0\n")
        with self.assertRaises(StructureError):
            parse_structure("data_X\nloop_\n_atom_site.id\n_atom_site.Cartn_x\n1 1.0\n")


if __name__ == "__main__":
    unittest.main()
