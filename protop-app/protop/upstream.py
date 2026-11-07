"""Guarded access to the few third-party databases ProTop reads.

Every call: fixed https host, short timeouts, a hard byte cap, no unvalidated redirects, a 24 h SQLite cache that is
served stale when the upstream is down, and friendly errors that never contain upstream bodies.
"""
from __future__ import annotations

import hashlib
import logging
import threading
import time
from contextlib import contextmanager
from typing import Callable
from urllib.parse import urlencode, urlsplit, urljoin

import requests
from flask import current_app

from .db import get_db
from .errors import ApiError
from .security import ip_key, limiter

log = logging.getLogger("protop.upstream")

HOSTS = {
    "data.rcsb.org": "RCSB",
    "files.rcsb.org": "RCSB",
    "rest.uniprot.org": "UniProt",
    "www.ebi.ac.uk": "EBI Proteins",
    "alphaknot.cent.uw.edu.pl": "AlphaKnot",
    "knotprot.cent.uw.edu.pl": "KnotProt",
}
CONNECT_TIMEOUT = 5
READ_TIMEOUT = 20
TOTAL_DEADLINE = 30          # seconds for one whole download, however slowly the bytes trickle in
MAX_REDIRECTS = 3
FRESH_SECONDS = 24 * 3600
STALE_KEEP_SECONDS = 7 * 24 * 3600
USER_AGENT = "jsanker.com-protop/1.0 (+https://jsanker.com/projects/protop/)"
MISSES_PER_MINUTE = 60       # cache-missing upstream calls per visitor

_slots = threading.BoundedSemaphore(3)   # at most 3 upstream calls in flight (the app has only 4 threads)


class UpstreamError(ApiError):
    """An ApiError (status 502/504/429) whose message is safe to show to the visitor."""


class UpstreamTooLarge(UpstreamError):
    def __init__(self, label: str) -> None:
        super().__init__(502, f"{label} sent more data than ProTop accepts.")


class UpstreamNotFound(UpstreamError):
    def __init__(self, message: str = "Not found.") -> None:
        super().__init__(404, message)


# ------------------------------------------------------------- per-key locks ---

_key_locks: dict[str, list] = {}
_key_locks_guard = threading.Lock()


@contextmanager
def _key_lock(key: str):
    with _key_locks_guard:
        entry = _key_locks.setdefault(key, [threading.Lock(), 0])
        entry[1] += 1
    try:
        with entry[0]:
            yield
    finally:
        with _key_locks_guard:
            entry[1] -= 1
            if entry[1] == 0:
                _key_locks.pop(key, None)


# -------------------------------------------------------------------- cache ---


def _cache_get(key: str):
    row = get_db().execute("SELECT body, ctype, fetched FROM cache WHERE key = ?", (key,)).fetchone()
    return (bytes(row["body"]), row["ctype"], row["fetched"]) if row else None


_writes = 0
_writes_lock = threading.Lock()


def trim_cache(conn, max_bytes: int, now: float | None = None) -> None:
    """Drop entries too old to be worth serving stale, then oldest-first until the cache fits."""
    now = now or time.time()
    conn.execute("DELETE FROM cache WHERE fetched < ?", (now - STALE_KEEP_SECONDS,))
    total = conn.execute("SELECT COALESCE(SUM(size), 0) FROM cache").fetchone()[0]
    if total <= max_bytes:
        return
    for row in conn.execute("SELECT key, size FROM cache ORDER BY fetched ASC").fetchall():
        conn.execute("DELETE FROM cache WHERE key = ?", (row["key"],))
        total -= row["size"]
        if total <= max_bytes * 0.8:
            break


def _cache_put(key: str, body: bytes, ctype: str) -> None:
    global _writes
    conn = get_db()
    conn.execute("INSERT OR REPLACE INTO cache (key, body, ctype, fetched, size) VALUES (?, ?, ?, ?, ?)",
                 (key, body, ctype, time.time(), len(body)))
    with _writes_lock:
        _writes += 1
        due = _writes % 25 == 0
    if due:
        trim_cache(conn, current_app.config["CACHE_MAX_BYTES"])


# ------------------------------------------------------------------ download ---


def _label(url: str) -> str:
    return HOSTS.get(urlsplit(url).hostname or "", "The upstream database")


def _check_url(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in HOSTS or parts.port not in (None, 443) or parts.username:
        raise UpstreamError(502, "Refusing to contact that address.")


def _download(method: str, url: str, json_body, accept: str, max_bytes: int) -> tuple[bytes, str]:
    """One guarded request. Returns (body, content type) for a 200, raises UpstreamError otherwise."""
    label = _label(url)
    deadline = time.monotonic() + TOTAL_DEADLINE
    for _hop in range(MAX_REDIRECTS + 1):
        _check_url(url)
        resp = None
        try:
            resp = requests.request(
                method, url, json=json_body, stream=True, allow_redirects=False,
                timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
                headers={"User-Agent": USER_AGENT, "Accept": accept},
            )
            status = resp.status_code
            if status in (301, 302, 303, 307, 308):
                location = resp.headers.get("Location")
                if not location:
                    raise UpstreamError(502, f"{label} sent an unexpected response.")
                url = urljoin(url, location)
                if status == 303:
                    method, json_body = "GET", None
                continue
            if status in (400, 404, 410):
                raise UpstreamNotFound(f"{label} has no such entry.")
            if status == 429 or status >= 500:
                raise UpstreamError(502, f"{label} is busy or down right now. Try again in a minute.")
            if status != 200:
                raise UpstreamError(502, f"{label} sent an unexpected response.")
            declared = resp.headers.get("Content-Length", "")
            if declared.isdigit() and int(declared) > max_bytes:
                raise UpstreamTooLarge(label)
            chunks, size = [], 0
            for chunk in resp.iter_content(chunk_size=65536):
                size += len(chunk)
                if size > max_bytes:
                    raise UpstreamTooLarge(label)
                if time.monotonic() > deadline:
                    raise UpstreamError(504, f"{label} took too long to answer.")
                chunks.append(chunk)
            ctype = (resp.headers.get("Content-Type") or "application/octet-stream").split(";")[0].strip()
            return b"".join(chunks), ctype
        except UpstreamError:
            raise
        except (requests.Timeout, requests.exceptions.ReadTimeout):
            raise UpstreamError(504, f"{label} took too long to answer.") from None
        except requests.RequestException as e:
            log.warning("upstream %s failed: %s", urlsplit(url).hostname, type(e).__name__)
            raise UpstreamError(502, f"Could not reach {label}.") from None
        finally:
            if resp is not None:
                resp.close()
    raise UpstreamError(502, f"{label} sent too many redirects.")


def fetch(url: str, *, params: dict | None = None, json_body=None, max_bytes: int = 8 * 1024 * 1024,
          accept: str = "*/*", check: Callable[[bytes], None] | None = None,
          reduce: Callable[[bytes], bytes] | None = None) -> tuple[bytes, str]:
    """Cached, guarded fetch. `check(body)` may raise ValueError to reject a malformed body before it is cached.
    `reduce(body)` may shrink the body (raising ValueError to reject it); the reduced bytes are what is cached.

    Fresh cache hit -> cached bytes. Otherwise download; if that fails and an older copy exists, serve the older copy.
    """
    if params:
        url = f"{url}?{urlencode(params)}"
    _check_url(url)
    method = "POST" if json_body is not None else "GET"
    body_hash = hashlib.sha256(repr(json_body).encode()).hexdigest()[:16] if json_body is not None else ""
    key = f"{method} {url} {body_hash}"

    hit = _cache_get(key)
    now = time.time()
    if hit and now - hit[2] < FRESH_SECONDS:
        return hit[0], hit[1]

    def stale_or(err: UpstreamError):
        if hit:
            log.warning("serving stale cache for %s after: %s", urlsplit(url).hostname, err.message)
            return hit[0], hit[1]
        raise err

    if not limiter.allow(ip_key("upstream"), MISSES_PER_MINUTE, 60):
        return stale_or(UpstreamError(429, "Too many lookups at once. Try again in a minute.", retry_after=30))

    with _key_lock(key):
        again = _cache_get(key)   # another thread may have just filled it
        if again and time.time() - again[2] < FRESH_SECONDS:
            return again[0], again[1]
        if not _slots.acquire(timeout=3):
            return stale_or(UpstreamError(429, "ProTop is busy fetching other data. Try again in a few seconds.",
                                          retry_after=5))
        try:
            body, ctype = _download(method, url, json_body, accept, max_bytes)
            if check is not None or reduce is not None:
                try:
                    if check is not None:
                        check(body)
                    if reduce is not None:
                        body = reduce(body)
                except (ValueError, RecursionError):
                    raise UpstreamError(502, f"{_label(url)} sent an unexpected response.") from None
        except UpstreamNotFound:
            raise
        except UpstreamError as e:
            return stale_or(e)
        finally:
            _slots.release()
        _cache_put(key, body, ctype)
        return body, ctype
