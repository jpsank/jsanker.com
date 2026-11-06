"""Smoke and security tests:  python -m unittest discover -s tests   (from openchat-app/)"""
from __future__ import annotations

import codecs
import io
import os
import re
import struct
import tempfile
import unittest
import zlib
from datetime import timedelta

from PIL import Image

_tmp = tempfile.mkdtemp(prefix="openchat-test-")
os.environ["APP_DATA_DIR"] = _tmp

from openchat import create_app  # noqa: E402
from openchat.extensions import db  # noqa: E402
from openchat.models import Comment, Post, User, utcnow  # noqa: E402
from openchat.security import limiter  # noqa: E402
from openchat.text import ago  # noqa: E402


def png_bytes(w=20, h=20, extra=b"") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (10, 120, 200)).save(buf, "PNG")
    return buf.getvalue() + extra


def token(html: str) -> str:
    m = re.search(r'name="csrf_token"[^>]*value="([^"]+)"', html) or re.search(r'value="([^"]+)"[^>]*name="csrf_token"', html)
    assert m, "no csrf token in page"
    return m.group(1)


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = create_app({"TESTING": False})  # TESTING=True would propagate exceptions; we test the real handlers

    def setUp(self):
        limiter.reset()
        with self.app.app_context():
            db.drop_all()
            db.create_all()
        self.c = self.app.test_client()

    def csrf(self, path=None) -> str:
        # signed out: the login form carries a token; signed in: the logout button in the navbar does
        for p in ([path] if path else ["/auth/login", "/"]):
            m = re.search(r'name="csrf_token"[^>]*value="([^"]+)"', self.c.get(p).get_data(as_text=True))
            if m:
                return m.group(1)
        raise AssertionError("no csrf token found")

    def post(self, path, data=None, **kw):
        data = dict(data or {})
        data.setdefault("csrf_token", self.csrf())
        return self.c.post(path, data=data, **kw)

    def register(self, name="alice", pw="correct horse"):
        r = self.post("/auth/register", {"username": name, "password": pw, "password2": pw})
        self.assertEqual(r.status_code, 302, r.get_data(as_text=True)[:500])

    def login(self, name="alice", pw="correct horse"):
        r = self.post("/auth/login", {"username": name, "password": pw})
        self.assertEqual(r.status_code, 302)

    def signup(self, name="alice"):
        self.register(name)
        self.login(name)

    def make_chat(self, name="general"):
        r = self.post("/create_chat", {"name": name, "about": "a place to chat"})
        self.assertEqual(r.status_code, 302, r.get_data(as_text=True)[:500])

    def make_post(self, chat="general", title="Hello", body="world", **extra):
        tok = token(self.c.get(f"/chat/{chat}/post").get_data(as_text=True))
        return self.c.post(f"/chat/{chat}/post", data={"csrf_token": tok, "title": title, "body": body, **extra},
                           content_type="multipart/form-data")


class PagesAndHeaders(Base):
    def test_home_and_headers(self):
        r = self.c.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("default-src 'none'", r.headers["Content-Security-Policy"])
        self.assertEqual(r.headers["X-Content-Type-Options"], "nosniff")
        html = r.get_data(as_text=True)
        self.assertNotRegex(html, r'(?:src|href)="https?://')  # nothing third-party
        self.assertNotIn("style=", html)
        self.assertNotIn("<script>", html)

    def test_all_public_pages_render(self):
        for path in ("/", "/popular", "/chats", "/leaderboard", "/auth/login", "/auth/register"):
            self.assertEqual(self.c.get(path).status_code, 200, path)
        self.assertEqual(self.c.get("/nope").status_code, 404)

    def test_mounted_under_script_name(self):
        r = self.c.get("/", environ_overrides={"SCRIPT_NAME": "/openchat"})
        html = r.get_data(as_text=True)
        self.assertIn('href="/openchat/popular"', html)
        self.assertIn('/openchat/static/css/style.css', html)

    def test_static_bootstrap_served(self):
        self.assertEqual(self.c.get("/static/vendor/bootstrap/css/bootstrap.min.css").status_code, 200)


class Accounts(Base):
    def test_register_login_logout(self):
        self.signup()
        self.assertIn("alice", self.c.get("/").get_data(as_text=True))
        # logout must be a POST with a token
        self.assertEqual(self.c.get("/auth/logout").status_code, 405)
        self.assertEqual(self.c.post("/auth/logout").status_code, 400)
        r = self.post("/auth/logout")
        self.assertEqual(r.status_code, 302)
        self.assertEqual(self.c.get("/feed").status_code, 302)

    def test_validation(self):
        bad = [("a", "correct horse"), ("has space", "correct horse"), ("alice", "short"), ("al/ice", "correct horse")]
        for name, pw in bad:
            r = self.post("/auth/register", {"username": name, "password": pw, "password2": pw})
            self.assertEqual(r.status_code, 200, name)
        self.register("alice")
        r = self.post("/auth/register", {"username": "ALICE", "password": "correct horse", "password2": "correct horse"})
        self.assertEqual(r.status_code, 200)
        self.assertIn("taken", r.get_data(as_text=True))

    def test_slur_username_rejected(self):
        slur = codecs.decode("avttre", "rot13") + "123"
        r = self.post("/auth/register", {"username": slur, "password": "correct horse", "password2": "correct horse"})
        self.assertEqual(r.status_code, 200)
        with self.app.app_context():
            self.assertEqual(User.query.count(), 0)

    def test_huge_username_is_rejected_quickly(self):
        import time
        big = "a" * 200_000
        t0 = time.monotonic()
        r = self.post("/auth/register", {"username": big, "password": "correct horse", "password2": "correct horse"})
        self.assertEqual(r.status_code, 200)
        self.assertLess(time.monotonic() - t0, 2.0)
        with self.app.app_context():
            self.assertEqual(User.query.count(), 0)

    def test_wrong_password_and_lockout(self):
        self.register()
        for _ in range(10):
            r = self.post("/auth/login", {"username": "alice", "password": "wrong password"})
            self.assertEqual(r.status_code, 302)
        r = self.post("/auth/login", {"username": "alice", "password": "correct horse"})
        self.assertEqual(r.status_code, 429)

    def test_no_open_redirect(self):
        self.register()
        for evil in ("//evil.example/x", "https://evil.example", "/\\evil.example", "javascript:alert(1)"):
            self.c.get("/auth/logout")  # no-op
            r = self.post(f"/auth/login?next={evil}", {"username": "alice", "password": "correct horse"})
            self.assertEqual(r.status_code, 302)
            self.assertEqual(r.headers["Location"], "/", evil)
            self.post("/auth/logout")
        r = self.post("/auth/login?next=/popular", {"username": "alice", "password": "correct horse"})
        self.assertEqual(r.headers["Location"], "/popular")

    def test_csrf_required_everywhere(self):
        self.signup()
        self.make_chat()
        for path in ("/create_chat", "/chat/general/subscribe", "/vote/post/1", "/post/1/comment", "/post/1/delete",
                     "/auth/logout", "/edit_profile"):
            self.assertEqual(self.c.post(path, data={}).status_code, 400, path)
        for path in ("/vote/post/1", "/chat/general/subscribe", "/post/1/delete", "/auth/logout"):
            self.assertEqual(self.c.get(path).status_code, 405, path)


class Content(Base):
    def setUp(self):
        super().setUp()
        self.signup("alice")
        self.make_chat()

    def test_post_comment_reply_vote(self):
        r = self.make_post(title="First", body="line1\nline2")
        self.assertEqual(r.status_code, 302)
        pid = int(r.headers["Location"].rsplit("/", 1)[1])
        page = self.c.get(f"/post/{pid}").get_data(as_text=True)
        self.assertIn("First", page)

        r = self.post(f"/post/{pid}/comment", {"body": "top level"})
        self.assertEqual(r.status_code, 302)
        with self.app.app_context():
            cid = Comment.query.one().id
        r = self.post(f"/post/{pid}/comment", {"body": "a reply", "parent_id": str(cid)})
        self.assertEqual(r.status_code, 302)
        page = self.c.get(f"/post/{pid}").get_data(as_text=True)
        self.assertIn("top level", page)
        self.assertIn("a reply", page)
        # a parent from another post is refused
        self.make_post(title="Second")
        self.assertEqual(self.post("/post/2/comment", {"body": "x", "parent_id": str(cid)}).status_code, 400)

        self.assertEqual(self.post(f"/vote/post/{pid}", {"dir": "up"}).status_code, 302)
        with self.app.app_context():
            self.assertEqual(db.session.get(Post, pid).score, 1)
        self.post(f"/vote/post/{pid}", {"dir": "down"})  # change vote
        with self.app.app_context():
            self.assertEqual(db.session.get(Post, pid).score, -1)
        self.post(f"/vote/post/{pid}", {"dir": "clear"})
        with self.app.app_context():
            self.assertEqual(db.session.get(Post, pid).score, 0)
        self.assertEqual(self.post(f"/vote/post/{pid}", {"dir": "sideways"}).status_code, 400)
        self.assertEqual(self.post("/vote/thing/1", {"dir": "up"}).status_code, 404)
        self.post(f"/vote/comment/{cid}", {"dir": "up"})
        with self.app.app_context():
            self.assertEqual(db.session.get(Comment, cid).score, 1)

    def test_html_is_escaped(self):
        evil = '<script>alert(1)</script><img src=x onerror=alert(1)>'
        r = self.make_post(title=evil, body=evil)
        pid = int(r.headers["Location"].rsplit("/", 1)[1])
        self.post(f"/post/{pid}/comment", {"body": evil})
        for path in (f"/post/{pid}", "/popular", "/chat/general", "/user/alice"):
            html = self.c.get(path).get_data(as_text=True)
            self.assertNotIn("<script>alert(1)", html, path)
            self.assertNotIn("<img src=x", html, path)
        self.assertIn("&lt;script&gt;", self.c.get(f"/post/{pid}").get_data(as_text=True))

    def test_word_filter_masks_on_write(self):
        slur = codecs.decode("avttre", "rot13")
        r = self.make_post(title=f"hey {slur}", body=f"you {slur}")
        pid = int(r.headers["Location"].rsplit("/", 1)[1])
        with self.app.app_context():
            p = db.session.get(Post, pid)
            self.assertNotIn(slur, p.title.lower())
            self.assertNotIn(slur, p.body.lower())
            self.assertIn("*", p.title)

    def test_search_is_literal(self):
        self.make_post(title="100% sure")
        self.make_post(title="other")
        html = self.c.get("/popular?q=%25").get_data(as_text=True)
        self.assertIn("100% sure", html)
        self.assertNotIn("other", html)

    def test_only_author_can_delete_or_edit(self):
        r = self.make_post(title="mine")
        pid = int(r.headers["Location"].rsplit("/", 1)[1])
        self.post(f"/post/{pid}/comment", {"body": "c"})
        self.post("/auth/logout")
        self.signup("bob")
        self.assertEqual(self.post(f"/post/{pid}/delete").status_code, 403)
        self.assertEqual(self.c.get("/chat/general/edit").status_code, 403)
        self.post("/auth/logout")
        self.login("alice")
        self.assertEqual(self.post(f"/post/{pid}/delete").status_code, 302)
        with self.app.app_context():
            self.assertEqual(Post.query.count(), 0)
            self.assertEqual(Comment.query.count(), 0)  # cascaded

    def test_subscribe_and_feed(self):
        self.post("/auth/logout")
        self.signup("bob")
        self.assertNotIn("first-post", self.c.get("/feed").get_data(as_text=True))
        self.post("/auth/logout")
        self.login("alice")
        self.make_post(title="first-post")
        self.post("/auth/logout")
        self.login("bob")
        self.post("/chat/general/subscribe", {"action": "sub"})
        self.assertIn("first-post", self.c.get("/feed").get_data(as_text=True))
        self.post("/chat/general/subscribe", {"action": "unsub"})
        self.assertNotIn("first-post", self.c.get("/feed").get_data(as_text=True))

    def test_duplicate_chat_name_case_insensitive(self):
        r = self.post("/create_chat", {"name": "GENERAL", "about": "dup"})
        self.assertEqual(r.status_code, 200)
        self.assertIn("already taken", r.get_data(as_text=True))

    def test_pagination_does_not_break(self):
        with self.app.app_context():
            alice = User.get_by_username("alice")
            from openchat.models import Chat
            chat = Chat.get_by_name("general")
            for i in range(60):
                db.session.add(Post(title=f"p{i}", body="", chat_id=chat.id, author_id=alice.id))
            db.session.commit()
        self.assertEqual(self.c.get("/popular?page=2").status_code, 200)
        self.assertEqual(self.c.get("/popular?page=99999").status_code, 200)
        self.assertEqual(self.c.get("/popular?page=-3").status_code, 200)
        self.assertEqual(self.c.get("/popular?page=abc").status_code, 200)


class Uploads(Base):
    def setUp(self):
        super().setUp()
        self.signup("alice")
        self.make_chat()

    def upload(self, data: bytes, name="x.png"):
        return self.make_post(title="pic", image=(io.BytesIO(data), name))

    def stored(self):
        with self.app.app_context():
            return Post.query.one().image

    def test_valid_image_is_reencoded_and_served(self):
        payload = b"<?php system($_GET[0]); ?><script>alert(1)</script>"
        r = self.upload(png_bytes(extra=payload))
        self.assertEqual(r.status_code, 302)
        name = self.stored()
        self.assertRegex(name, r"^[0-9a-f]{32}\.(png|jpg)$")
        raw = (self.app.config["UPLOAD_DIR"] / name).read_bytes()
        self.assertNotIn(b"<?php", raw)
        self.assertNotIn(b"<script", raw)
        got = self.c.get(f"/uploads/{name}")
        self.assertEqual(got.status_code, 200)
        self.assertEqual(got.mimetype, "image/png")
        self.assertEqual(got.headers["X-Content-Type-Options"], "nosniff")

    def test_oversized_dimensions_scaled_down(self):
        self.assertEqual(self.upload(png_bytes(3000, 2000)).status_code, 302)
        img = Image.open(self.app.config["UPLOAD_DIR"] / self.stored())
        self.assertLessEqual(max(img.size), 1000)

    def test_rejects_non_images(self):
        svg = b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>'
        for name, data in (("a.svg", svg), ("a.html", b"<script>alert(1)</script>"), ("a.php", b"<?php phpinfo();"),
                           ("a.png", b""), ("a.png", b"\x89PNG\r\n\x1a\njunk"), ("a.gif", b"GIF89a<script>")):
            r = self.upload(data, name)
            self.assertEqual(r.status_code, 422, name)
        with self.app.app_context():
            self.assertEqual(Post.query.count(), 0)

    def test_pixel_bomb_rejected(self):
        def chunk(t, d):
            return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
        bomb = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 65000, 65000, 8, 2, 0, 0, 0)) + chunk(b"IEND", b"")
        self.assertEqual(self.upload(bomb).status_code, 422)

    def test_too_big_file(self):
        self.assertIn(self.upload(b"\x89PNG" + b"A" * (7 * 1024 * 1024)).status_code, (413, 422))

    def test_upload_route_is_not_traversable(self):
        for bad in ("../secret.key", "..%2fsecret.key", "x.png", "a" * 32 + ".svg", "a" * 32 + ".php"):
            self.assertEqual(self.c.get(f"/uploads/{bad}").status_code, 404, bad)

    def test_deleting_post_removes_file(self):
        self.upload(png_bytes())
        name = self.stored()
        pid = 1
        self.post(f"/post/{pid}/delete")
        self.assertFalse((self.app.config["UPLOAD_DIR"] / name).exists())

    def test_avatar(self):
        r = self.c.get("/avatar/alice.svg")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.mimetype, "image/svg+xml")
        self.assertNotIn(b"<script", r.data)
        self.assertEqual(self.c.get("/avatar/%3Cscript%3E.svg").status_code, 404)


class RateLimits(Base):
    def test_registration_limit_per_ip(self):
        for i in range(5):
            self.register(f"user{i:02d}")
        r = self.post("/auth/register", {"username": "user99", "password": "correct horse", "password2": "correct horse"})
        self.assertEqual(r.status_code, 429)

    def test_post_limit(self):
        self.signup()
        self.make_chat()
        codes = [self.make_post(title=f"t{i}").status_code for i in range(11)]
        self.assertEqual(codes[:10], [302] * 10)
        self.assertEqual(codes[10], 429)


class TimeFormat(unittest.TestCase):
    def test_ago(self):
        now = utcnow()
        self.assertEqual(ago(now - timedelta(seconds=1)), "1 second ago")
        self.assertEqual(ago(now - timedelta(minutes=5)), "5 minutes ago")
        self.assertEqual(ago(now - timedelta(hours=3)), "3 hours ago")
        self.assertEqual(ago(now - timedelta(days=12)), "12 days ago")
        self.assertEqual(ago(now - timedelta(days=2722)), "7 years 167 days ago")
        self.assertEqual(ago(now - timedelta(days=365 * 3 + 6)), "3 years 6 days ago")
        self.assertEqual(ago(now - timedelta(days=365)), "1 year ago")


if __name__ == "__main__":
    unittest.main()
