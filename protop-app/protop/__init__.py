"""ProTop backend: a read-only aggregator (RCSB, UniProt, AlphaKnot, KnotProt), a knotted-protein catalog snapshot, and
collaborative workspace rooms. Revived from the 2023 Yale CPSC 439 team project; see API.md for the contract.
"""
from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from pathlib import Path

from flask import Flask, jsonify
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix

from .db import close_db, init_db, open_db
from .errors import ApiError
from .security import install_headers

log = logging.getLogger("protop")
PACKAGE_DIR = Path(__file__).resolve().parent


def _data_dir() -> Path:
    base = Path(os.environ.get("APP_DATA_DIR") or PACKAGE_DIR.parent / "var") / "protop"
    base.mkdir(parents=True, exist_ok=True)
    return base


def create_app(test_config: dict | None = None) -> Flask:
    app = Flask(__name__, static_folder=None)
    app.json.sort_keys = False
    data_dir = Path((test_config or {}).get("DATA_DIR") or _data_dir())
    data_dir.mkdir(parents=True, exist_ok=True)
    app.config.update(
        DATA_DIR=data_dir,
        DB_PATH=data_dir / "protop.sqlite3",
        CATALOG_PATH=os.environ.get("PROTOP_CATALOG") or PACKAGE_DIR / "data" / "catalog.sqlite",
        CACHE_MAX_BYTES=256 * 1024 * 1024,
        MAX_CONTENT_LENGTH=6 * 1024 * 1024,
    )
    if test_config:
        app.config.update(test_config)
    # Trust X-Forwarded-Proto only; the client address comes from security.client_ip (CF-Connecting-IP rules).
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=0, x_proto=1, x_host=0, x_prefix=0)  # type: ignore[method-assign]

    init_db(app.config["DB_PATH"])
    from .rooms import Presence, cleanup_expired
    from .upstream import trim_cache

    app.extensions["protop"] = {"presence": Presence(), "lock": threading.Lock(), "last_cleanup": time.time()}
    conn = open_db(app)
    try:
        removed = cleanup_expired(conn)
        trim_cache(conn, app.config["CACHE_MAX_BYTES"])
        if removed:
            log.info("startup cleanup removed %d expired rooms", removed)
    finally:
        conn.close()

    install_headers(app)
    app.teardown_appcontext(close_db)

    from . import aggregator, catalog, rooms
    app.register_blueprint(aggregator.bp)
    app.register_blueprint(catalog.bp)
    app.register_blueprint(rooms.bp)

    def error(status: int, message: str, retry_after: int | None = None):
        resp = jsonify({"error": message})
        resp.status_code = status
        if retry_after is not None:
            resp.headers["Retry-After"] = str(retry_after)
        return resp

    @app.errorhandler(ApiError)
    def _api(e: ApiError):
        if e.status == 429 and e.retry_after is None:
            e.retry_after = 30
        return error(e.status, e.message, e.retry_after)

    @app.errorhandler(HTTPException)
    def _http(e: HTTPException):
        messages = {
            400: "That request was not valid.", 404: "Not found.", 405: "That method is not allowed here.",
            413: "That request is too large.", 414: "That address is too long.", 429: "Slow down a little.",
        }
        code = e.code or 500
        return error(code, messages.get(code, "Something went wrong."))

    @app.errorhandler(sqlite3.OperationalError)
    def _busy(e: sqlite3.OperationalError):
        app.logger.warning("sqlite busy/error: %s", e)
        return error(503, "ProTop is busy. Try again in a moment.", 5)

    @app.errorhandler(Exception)
    def _boom(e: Exception):
        app.logger.exception("unhandled error: %s", e)
        return error(500, "Something went wrong on my end.")

    return app
