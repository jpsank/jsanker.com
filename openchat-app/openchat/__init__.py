"""OpenChat (the Reddit-style successor to OpenChat Classic), modernised for jsanker.com.

Original: Flask 1.1 app from 2019-2020. Changes: current Flask/SQLAlchemy/Pillow, no third-party requests
(Bootstrap is vendored, avatars are local identicons, no moment.js), CSRF on every state-changing request
(votes, subscribing and logout are POSTs now), rate limits, a word filter shared with the rest of the site,
re-encoded image uploads, and no email address collected.
"""
from __future__ import annotations

import os
import secrets
from pathlib import Path

from flask import Flask, render_template, request
from flask.sessions import SecureCookieSessionInterface
from flask_wtf.csrf import CSRFError
from sqlalchemy import event
from sqlalchemy.engine import Engine
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix

from .extensions import csrf, db, login


class _Sessions(SecureCookieSessionInterface):
    """Mark the cookie Secure whenever the visitor reached us over HTTPS (Cloudflare terminates TLS upstream)."""

    def get_cookie_secure(self, app):  # noqa: ANN001
        return request.is_secure


def _data_dir() -> Path:
    base = Path(os.environ.get("APP_DATA_DIR") or Path(__file__).resolve().parent.parent / "var") / "openchat"
    (base / "uploads").mkdir(parents=True, exist_ok=True)
    return base


def _secret_key(base: Path) -> str:
    path = base / "secret.key"
    if not path.exists():
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(secrets.token_hex(32))
        except FileExistsError:
            pass
    return path.read_text().strip()


@event.listens_for(Engine, "connect")
def _sqlite_pragmas(dbapi_connection, _record):  # noqa: ANN001
    cur = dbapi_connection.cursor()
    cur.execute("PRAGMA journal_mode = WAL")
    cur.execute("PRAGMA foreign_keys = ON")
    cur.execute("PRAGMA busy_timeout = 5000")
    cur.close()


def create_app(test_config: dict | None = None) -> Flask:
    app = Flask(__name__)
    base = _data_dir()
    root = os.environ.get("SCRIPT_NAME", "") or "/"
    app.config.update(
        SECRET_KEY=_secret_key(base),
        SQLALCHEMY_DATABASE_URI=f"sqlite:///{base / 'app.db'}",
        UPLOAD_DIR=base / "uploads",
        MAX_CONTENT_LENGTH=6 * 1024 * 1024,
        SESSION_COOKIE_NAME="ocsid",
        SESSION_COOKIE_PATH=root,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 14,
        WTF_CSRF_TIME_LIMIT=None,
        PER_PAGE=25,
        TRUSTED_PROXY_HOPS=1,
    )
    if test_config:
        app.config.update(test_config)
    app.session_interface = _Sessions()
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=0, x_proto=1, x_host=0, x_prefix=0)  # type: ignore[method-assign]

    db.init_app(app)
    csrf.init_app(app)
    login.init_app(app)
    login.login_view = "auth.login"
    login.login_message = "Please sign in to do that."
    login.session_protection = "strong"

    from . import models  # noqa: F401  (registers the tables)
    from .security import install_headers
    from .text import ago, iso
    from .views import auth, main

    install_headers(app)
    app.register_blueprint(main.bp)
    app.register_blueprint(auth.bp, url_prefix="/auth")
    app.add_template_filter(ago, "ago")
    app.add_template_filter(iso, "iso")

    @app.context_processor
    def _globals():  # noqa: ANN202
        return {"app_root": request.script_root}

    @app.errorhandler(CSRFError)
    def _csrf(_e):  # noqa: ANN001, ANN202
        return render_template("errors/error.html", title="Session expired", code=400,
                               message="Your form expired. Go back, reload the page and try again."), 400

    @app.errorhandler(HTTPException)
    def _http(e):  # noqa: ANN001, ANN202
        messages = {
            400: "That request was not valid.", 403: "You are not allowed to do that.", 404: "Not found.",
            405: "That is not allowed here.", 413: "That upload is too large (5 MB max).",
            429: "Slow down a little and try again soon.",
        }
        code = e.code or 500
        return render_template("errors/error.html", title=e.name, code=code,
                               message=messages.get(code, "Something went wrong.")), code

    @app.errorhandler(Exception)
    def _boom(e):  # noqa: ANN001, ANN202
        app.logger.exception("unhandled error: %s", e)
        db.session.rollback()
        return render_template("errors/error.html", title="Error", code=500,
                               message="Something went wrong on my end."), 500

    with app.app_context():
        db.create_all()
    return app
