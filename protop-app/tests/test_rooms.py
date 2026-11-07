"""Room lifecycle, ops, sync, presence, export, limits, expiry."""
from __future__ import annotations

import time
import zlib
from unittest import mock

from tests.helpers import CIF_TEXT, PDB_TEXT, Base, FakeResp
from protop.rooms import MAX_LIVE, MAX_OPS, clean_text
from protop.security import limiter


class Lifecycle(Base):
    def test_create_from_upload_and_read_back(self):
        room = self.new_room()
        self.assertRegex(room["id"], r"^[A-Za-z0-9_-]{22}$")
        self.assertEqual(room["seq"], 0)
        self.assertEqual(room["structure"], {"format": "pdb", "title": "TEST PROTEIN", "source": "upload:t.pdb"})
        self.assertEqual(room["chains"][0]["residues"][0], {"num": 1, "icode": "", "aa": "M"})
        self.assertRegex(room["created"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        got = self.c.get(f"/rooms/{room['id']}")
        self.assertEqual(got.status_code, 200)
        self.assertEqual(got.get_json(), room)
        text = self.c.get(f"/rooms/{room['id']}/structure")
        self.assertEqual(text.mimetype, "text/plain")
        self.assertEqual(text.get_data(as_text=True), PDB_TEXT)

    def test_create_from_pdb_id_uses_rcsb_and_falls_back_to_cif(self):
        self.up.add("1R42.pdb", FakeResp(404))
        self.up.add("1R42.cif", FakeResp(200, CIF_TEXT, {"Content-Type": "text/plain"}))
        r = self.c.post("/rooms", json={"pdb": "1r42"})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.get_json()["structure"], {"format": "cif", "title": "A TINY MMCIF", "source": "pdb:1R42"})

    def test_huge_pdb_entry_is_422_not_502(self):
        self.up.add("files.rcsb.org", FakeResp(200, b"x" * (9 * 1024 * 1024)))
        self.assertEqual(self.c.post("/rooms", json={"pdb": "4V6X"}).status_code, 422)

    def test_unknown_pdb_id_is_404(self):
        self.up.add("files.rcsb.org", FakeResp(404))
        self.assertEqual(self.c.post("/rooms", json={"pdb": "9ZZZ"}).status_code, 404)

    def test_bad_room_requests(self):
        for body in ({}, {"pdb": "1R42", "upload": {"text": "x"}}, {"pdb": "../etc/passwd"}, {"pdb": 5}, {"upload": "x"},
                     {"upload": {"text": 5}}, {"upload": {"name": 3, "text": "x"}}, []):
            self.assertEqual(self.c.post("/rooms", json=body).status_code, 400, body)
        self.assertEqual(self.c.post("/rooms", data="not json", content_type="application/json").status_code, 400)
        self.assertEqual(self.c.post("/rooms", data="[" * 50000, content_type="application/json").status_code, 400)

    def test_upload_validation(self):
        bad = {"empty": "", "prose": "hello world " * 50, "binary": "\x00\x01\x02\x89PNG" * 40,
               "no polymer": "HETATM" + "    1  O   HOH A   1       1.000   2.000   3.000  1.00  0.00           O\n",
               "cif without atoms": "data_X\n_cell.length_a 1\n"}
        for label, text in bad.items():
            r = self.c.post("/rooms", json={"upload": {"name": "x", "text": text}})
            self.assertEqual(r.status_code, 422, label)
            self.assertIn("error", r.get_json())

    def test_oversized_upload(self):
        r = self.c.post("/rooms", json={"upload": {"name": "big.pdb", "text": "A" * (5 * 1024 * 1024 + 10)}})
        self.assertEqual(r.status_code, 422)
        r = self.c.post("/rooms", data=b"{" + b" " * (7 * 1024 * 1024) + b"}", content_type="application/json")
        self.assertEqual(r.status_code, 413)

    def test_unknown_and_malformed_ids_are_404(self):
        for rid in ("x" * 22, "short", "../../etc/passwd", "a" * 500):
            for path in ("", "/structure", "/sync", "/export"):
                self.assertEqual(self.c.get(f"/rooms/{rid}{path}").status_code, 404, (rid, path))
        self.assertEqual(self.op("x" * 22, type="annotation").status_code, 404)

    def test_room_creation_rate_limit(self):
        for _ in range(10):
            self.new_room()
        r = self.c.post("/rooms", json={"upload": {"name": "t", "text": PDB_TEXT}})
        self.assertEqual(r.status_code, 429)
        self.assertIn("Retry-After", r.headers)

    def test_failed_uploads_do_not_use_up_room_quota_but_are_limited(self):
        for _ in range(12):
            self.c.post("/rooms", json={"upload": {"name": "t", "text": "junk"}})
        self.new_room()

    def test_room_cap_gives_503(self):
        with mock.patch("protop.rooms.MAX_ROOMS", 2):
            self.new_room()
            self.new_room()
            r = self.c.post("/rooms", json={"upload": {"name": "t", "text": PDB_TEXT}})
        self.assertEqual(r.status_code, 503)


class Expiry(Base):
    def _expire(self, rid, when):
        conn = self.app.extensions  # noqa: F841
        from protop.db import open_db
        c = open_db(self.app)
        c.execute("UPDATE rooms SET expires = ? WHERE id = ?", (when, rid))
        c.close()

    def test_expired_room_is_gone_and_deleted(self):
        rid = self.new_room()["id"]
        self.assertEqual(self.op(rid, type="annotation", chain="A", start=1, end=2, text="hi").status_code, 201)
        self._expire(rid, time.time() - 1)
        self.assertEqual(self.c.get(f"/rooms/{rid}").status_code, 404)
        from protop.db import open_db
        c = open_db(self.app)
        self.assertEqual(c.execute("SELECT COUNT(*) FROM rooms").fetchone()[0], 0)
        self.assertEqual(c.execute("SELECT COUNT(*) FROM ops").fetchone()[0], 0)
        c.close()

    def test_startup_cleanup(self):
        keep, drop = self.new_room()["id"], self.new_room()["id"]
        self._expire(drop, time.time() - 5)
        from protop import create_app
        create_app({"DATA_DIR": self.dir, "CATALOG_PATH": self.catalog_path})
        self.assertEqual(self.c.get(f"/rooms/{keep}").status_code, 200)
        from protop.db import open_db
        c = open_db(self.app)
        self.assertEqual([r[0] for r in c.execute("SELECT id FROM rooms")], [keep])
        c.close()

    def test_writes_extend_expiry_and_sync_extends_it_throttled(self):
        room = self.new_room()
        rid = room["id"]
        from protop.db import open_db
        c = open_db(self.app)
        c.execute("UPDATE rooms SET touched = touched - 100000, expires = ? WHERE id = ?", (time.time() + 1000, rid))
        c.close()
        self.c.get(f"/rooms/{rid}/sync")
        c = open_db(self.app)
        exp = c.execute("SELECT expires FROM rooms WHERE id = ?", (rid,)).fetchone()[0]
        c.close()
        self.assertGreater(exp, time.time() + 13 * 86400)

    def test_opportunistic_cleanup_on_create(self):
        old = self.new_room()["id"]
        self._expire(old, time.time() - 5)
        self.app.extensions["protop"]["last_cleanup"] = 0
        self.new_room()
        from protop.db import open_db
        c = open_db(self.app)
        self.assertEqual(c.execute("SELECT COUNT(*) FROM rooms WHERE id = ?", (old,)).fetchone()[0], 0)
        c.close()


class Ops(Base):
    def setUp(self):
        super().setUp()
        self.rid = self.new_room()["id"]

    def ann(self, **kw):
        body = dict(type="annotation", chain="A", start=1, end=3, text="active site")
        body.update(kw)
        return self.op(self.rid, **body)

    def mut(self, **kw):
        body = dict(type="mutation", chain="A", num=1, to="V")
        body.update(kw)
        return self.op(self.rid, **body)

    def test_annotation_roundtrip(self):
        r = self.ann(author="  Ada ")
        self.assertEqual(r.status_code, 201)
        j = r.get_json()
        self.assertEqual(j["seq"], 1)
        op = j["op"]
        self.assertEqual((op["seq"], op["type"], op["chain"], op["start"], op["end"], op["text"], op["client"]),
                         (1, "annotation", "A", 1, 3, "active site", "client-aaaa1111"))
        self.assertRegex(op["ts"], r"^\d{4}-\d\d-\d\dT")
        self.assertEqual(self.c.get(f"/rooms/{self.rid}").get_json()["seq"], 1)

    def test_annotation_validation(self):
        bad = [
            (400, dict(chain=5)), (400, dict(start="1")), (400, dict(start=True)), (400, dict(text=7)), (400, dict(start=None)),
            (422, dict(chain="Z")), (422, dict(start=4, end=3)), (422, dict(start=1, end=99)), (422, dict(start=0, end=3)),
            (422, dict(text="")), (422, dict(text="   ")), (422, dict(text="x" * 501)), (422, dict(author="y" * 33)),
            (400, dict(client="short")), (400, dict(client="bad client id!")), (400, dict(type="nope")), (400, dict(type=3)),
        ]
        for status, kw in bad:
            self.assertEqual(self.ann(**kw).status_code, status, kw)
        self.assertEqual(self.c.get(f"/rooms/{self.rid}").get_json()["seq"], 0)   # nothing stored

    def test_text_is_stored_verbatim_but_control_characters_are_stripped(self):
        nasty = "<img src=x onerror=alert(1)>\n<b>bold</b> & \"quotes\" \x00\x07\x1b[31m tab\there \u202e rtl"
        r = self.ann(text=nasty, author="<script>x</script>")
        self.assertEqual(r.status_code, 201)
        op = r.get_json()["op"]
        self.assertEqual(op["text"], "<img src=x onerror=alert(1)>\n<b>bold</b> & \"quotes\" [31m tabhere  rtl")
        self.assertEqual(op["author"], "<script>x</script>")
        self.assertEqual(clean_text("a\r\nb\u2028c", True), "a\nbc")
        r = self.c.get(f"/rooms/{self.rid}/sync")
        self.assertEqual(r.mimetype, "application/json")

    def test_empty_author_becomes_anonymous(self):
        self.assertEqual(self.ann(author=" \x00 ").get_json()["op"]["author"], "Anonymous")

    def test_edit_and_delete_fold_targets(self):
        a1 = self.ann().get_json()["seq"]
        m1 = self.mut().get_json()["seq"]
        # targets must exist and be of the right kind
        self.assertEqual(self.op(self.rid, type="annotation_edit", target=99, text="x").status_code, 422)
        self.assertEqual(self.op(self.rid, type="annotation_edit", target=m1, text="x").status_code, 422)
        self.assertEqual(self.op(self.rid, type="annotation_delete", target=m1).status_code, 422)
        self.assertEqual(self.op(self.rid, type="mutation_status", target=a1, status="accepted").status_code, 422)
        self.assertEqual(self.op(self.rid, type="mutation_delete", target=a1).status_code, 422)
        self.assertEqual(self.op(self.rid, type="annotation_edit", target="1", text="x").status_code, 400)
        self.assertEqual(self.op(self.rid, type="annotation_edit", target=0, text="x").status_code, 422)
        e = self.op(self.rid, type="annotation_edit", target=a1, text="better text")
        self.assertEqual(e.status_code, 201)
        self.assertEqual(self.op(self.rid, type="annotation_edit", target=a1, text="").status_code, 422)
        self.assertEqual(self.op(self.rid, type="annotation_delete", target=a1).status_code, 201)
        # cannot edit or delete twice
        self.assertEqual(self.op(self.rid, type="annotation_edit", target=a1, text="again").status_code, 422)
        self.assertEqual(self.op(self.rid, type="annotation_delete", target=a1).status_code, 422)
        export = self.c.get(f"/rooms/{self.rid}/export?format=json").get_json()
        self.assertEqual(export["annotations"], [])
        self.assertEqual(len(export["mutations"]), 1)

    def test_edited_annotation_folds_in_export(self):
        a1 = self.ann().get_json()["seq"]
        self.op(self.rid, type="annotation_edit", target=a1, text="v2")
        self.op(self.rid, type="annotation_edit", target=a1, text="v3")
        ann = self.c.get(f"/rooms/{self.rid}/export?format=json").get_json()["annotations"]
        self.assertEqual([(a["seq"], a["text"]) for a in ann], [(1, "v3")])

    def test_mutation_rules(self):
        ok = self.mut()
        self.assertEqual(ok.status_code, 201)
        op = ok.get_json()["op"]
        self.assertEqual((op["from"], op["to"], op["num"], op["icode"], op["note"]), ("M", "V", 1, "", ""))
        self.assertEqual(self.mut(num=2, icode="A", to="R", note="hmm").get_json()["op"]["from"], "K")
        bad = [(422, dict(to="M")), (422, dict(to="B")), (422, dict(to="v")), (422, dict(to="VV")), (400, dict(to=5)),
               (422, dict(num=999)), (422, dict(chain="Q")), (422, dict(num=2, icode="Z")), (400, dict(num="1")),
               (400, dict(icode=1)), (422, dict(note="n" * 501)), (400, dict(chain=None))]
        for status, kw in bad:
            self.assertEqual(self.mut(**kw).status_code, status, kw)

    def test_mutation_status_and_delete(self):
        m = self.mut().get_json()["seq"]
        for status in ("accepted", "rejected", "proposed"):
            self.assertEqual(self.op(self.rid, type="mutation_status", target=m, status=status).status_code, 201)
        self.assertEqual(self.op(self.rid, type="mutation_status", target=m, status="maybe").status_code, 422)
        self.assertEqual(self.op(self.rid, type="mutation_status", target=m, status=1).status_code, 400)
        muts = self.c.get(f"/rooms/{self.rid}/export?format=json").get_json()["mutations"]
        self.assertEqual(muts[0]["status"], "proposed")
        self.assertEqual(self.op(self.rid, type="mutation_delete", target=m).status_code, 201)
        self.assertEqual(self.op(self.rid, type="mutation_status", target=m, status="accepted").status_code, 422)

    def test_ops_cap_gives_409_room_full(self):
        with mock.patch("protop.rooms.MAX_OPS", 3):
            for _ in range(3):
                self.assertEqual(self.ann().status_code, 201)
            r = self.ann()
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.get_json()["error"], "This room is full.")

    def test_live_annotation_and_mutation_caps(self):
        with mock.patch("protop.rooms.MAX_LIVE", 2):
            a = [self.ann().get_json()["seq"] for _ in range(2)]
            self.assertEqual(self.ann().status_code, 409)
            self.op(self.rid, type="annotation_delete", target=a[0])
            self.assertEqual(self.ann().status_code, 201)       # deleting frees a slot
            self.mut(), self.mut(num=3, to="A")
            self.assertEqual(self.mut(num=4, to="A").status_code, 409)
        self.assertEqual(MAX_LIVE, 200)
        self.assertEqual(MAX_OPS, 2000)

    def test_op_rate_limit_429(self):
        for _ in range(120):
            self.assertIn(self.ann().status_code, (201,))
        r = self.ann()
        self.assertEqual(r.status_code, 429)
        self.assertIn("Retry-After", r.headers)

    def test_body_limit(self):
        r = self.c.post(f"/rooms/{self.rid}/ops", data=b'{"type":"annotation","text":"' + b"a" * 41000 + b'"}',
                        content_type="application/json")
        self.assertEqual(r.status_code, 413)

    def test_seq_is_gapless_under_threads(self):
        import threading
        results = []

        def work(i):
            c = self.app.test_client()
            r = c.post(f"/rooms/{self.rid}/ops", json=dict(type="annotation", chain="A", start=1, end=2, text=f"t{i}",
                                                             client="client-aaaa1111", author="Ada"))
            results.append(r.status_code)

        ts = [threading.Thread(target=work, args=(i,)) for i in range(12)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(results.count(201), 12)
        ops = self.c.get(f"/rooms/{self.rid}/sync").get_json()["ops"]
        self.assertEqual([o["seq"] for o in ops], list(range(1, 13)))


class SyncPresence(Base):
    def setUp(self):
        super().setUp()
        self.rid = self.new_room()["id"]

    def test_sync_since_and_heartbeat(self):
        for i in range(3):
            self.op(self.rid, type="annotation", chain="A", start=1, end=2, text=f"n{i}")
        j = self.c.get(f"/rooms/{self.rid}/sync?since=1&client=viewer-0001").get_json()
        self.assertEqual(j["seq"], 3)
        self.assertEqual([o["seq"] for o in j["ops"]], [2, 3])
        self.assertEqual([p["client"] for p in j["presence"]], ["viewer-0001"])   # the caller is included
        self.assertEqual(self.c.get(f"/rooms/{self.rid}/sync?since=3").get_json()["ops"], [])
        self.assertEqual(self.c.get(f"/rooms/{self.rid}/sync?since=99").get_json()["ops"], [])

    def test_sync_argument_validation(self):
        for q in ("since=-1", "since=abc", "since=1.5", "since=99999999999", "client=short", "client=" + "a" * 40):
            self.assertEqual(self.c.get(f"/rooms/{self.rid}/sync?{q}").status_code, 400, q)

    def test_presence_post_and_expiry(self):
        body = dict(client="viewer-0001", name="Ada", color="#3366CC", chain="A", start=1, end=3)
        self.assertEqual(self.c.post(f"/rooms/{self.rid}/presence", json=body).status_code, 204)
        self.assertEqual(self.c.post(f"/rooms/{self.rid}/presence", json=dict(body, client="viewer-0002", name="Bo", chain=None, start=None, end=None)).status_code, 204)
        pres = self.c.get(f"/rooms/{self.rid}/sync?client=viewer-0002").get_json()["presence"]
        self.assertEqual(pres, [
            {"client": "viewer-0001", "name": "Ada", "color": "#3366cc", "chain": "A", "start": 1, "end": 3},
            {"client": "viewer-0002", "name": "Bo", "color": "#3366cc", "chain": None, "start": None, "end": None}])
        real = time.monotonic
        with mock.patch("protop.rooms.time.monotonic", lambda: real() + 21):
            self.assertEqual(self.c.get(f"/rooms/{self.rid}/sync").get_json()["presence"], [])

    def test_presence_validation(self):
        good = dict(client="viewer-0001", name="Ada", color="#3366cc", chain="A", start=1, end=3)
        bad = [(400, dict(client="x")), (422, dict(name="n" * 33)), (400, dict(name=5)), (400, dict(color=5)),
               (422, dict(color="red")), (422, dict(color="#12345")), (422, dict(chain="Q")), (422, dict(start=3, end=1)),
               (422, dict(end=999)), (400, dict(chain=None)), (400, dict(start="1"))]
        for status, kw in bad:
            self.assertEqual(self.c.post(f"/rooms/{self.rid}/presence", json=dict(good, **kw)).status_code, status, kw)
        self.assertEqual(self.c.post(f"/rooms/{self.rid}/presence", json=good).status_code, 204)


class Export(Base):
    def test_fasta_applies_accepted_mutations_only(self):
        rid = self.new_room()["id"]
        m1 = self.op(rid, type="mutation", chain="A", num=1, to="V").get_json()["seq"]
        m2 = self.op(rid, type="mutation", chain="A", num=2, to="R").get_json()["seq"]
        m3 = self.op(rid, type="mutation", chain="A", num=3, to="A").get_json()["seq"]
        m4 = self.op(rid, type="mutation", chain="B", num=11, to="S").get_json()["seq"]
        m5 = self.op(rid, type="mutation", chain="A", num=2, icode="A", to="E").get_json()["seq"]
        for m in (m1, m2, m4):
            self.op(rid, type="mutation_status", target=m, status="accepted")
        self.op(rid, type="mutation_status", target=m3, status="rejected")
        self.op(rid, type="mutation_status", target=m4, status="accepted")
        self.op(rid, type="mutation_delete", target=m4)           # accepted, then deleted: not applied
        self.op(rid, type="mutation_status", target=m5, status="accepted")
        r = self.c.get(f"/rooms/{rid}/export?format=fasta")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.mimetype, "text/plain")
        self.assertEqual(r.get_data(as_text=True), ">t_A mutated: M1V,K2R,K2AE\nVRLGEX\n>t_B\nAC\n")

    def test_fasta_for_pdb_room_is_labelled_with_the_id(self):
        self.up.add("1R42.pdb", FakeResp(200, PDB_TEXT, {"Content-Type": "text/plain"}))
        rid = self.c.post("/rooms", json={"pdb": "1R42"}).get_json()["id"]
        self.assertTrue(self.c.get(f"/rooms/{rid}/export").get_data(as_text=True).startswith(">1R42_A\nMKLGKX\n>1R42_B\nAC\n"))

    def test_json_export(self):
        rid = self.new_room()["id"]
        self.op(rid, type="annotation", chain="A", start=1, end=2, text="note")
        m = self.op(rid, type="mutation", chain="A", num=1, to="V").get_json()["seq"]
        self.op(rid, type="mutation_status", target=m, status="accepted")
        r = self.c.get(f"/rooms/{rid}/export?format=json")
        self.assertEqual(r.mimetype, "application/json")
        self.assertIn("attachment", r.headers["Content-Disposition"])
        j = r.get_json()
        self.assertEqual(j["room"], rid)
        self.assertEqual(j["structure"]["source"], "upload:t.pdb")
        self.assertEqual(len(j["chains"]), 2)
        self.assertEqual(j["annotations"][0]["text"], "note")
        self.assertEqual((j["mutations"][0]["status"], j["mutations"][0]["from"]), ("accepted", "M"))
        self.assertRegex(j["exported"], r"^\d{4}-")
        self.assertEqual(self.c.get(f"/rooms/{rid}/export?format=docx").status_code, 400)
