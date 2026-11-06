"""Request-level safety helpers: client IP, rate limiting, safe redirects, security headers."""
from __future__ import annotations

import ipaddress
import threading
import time
from collections import defaultdict, deque

from flask import Flask, request

# ---------------------------------------------------------------- client IP ---


def client_ip() -> str:
    """The visitor's IP, used only to key rate limits.

    Behind the Cloudflare Tunnel every request reaches us from a private address (cloudflared -> Caddy), and
    Cloudflare puts the real visitor in CF-Connecting-IP. That header is believed ONLY when the direct peer is a
    private/loopback address, i.e. when the request came through the tunnel (the container publishes no ports).
    """
    peer = request.remote_addr or "0.0.0.0"
    cf = request.headers.get("CF-Connecting-IP", "")
    try:
        peer_ip = ipaddress.ip_address(peer)
        if cf and (peer_ip.is_private or peer_ip.is_loopback):
            return str(ipaddress.ip_address(cf))
    except ValueError:
        pass
    return peer


def ip_bucket(ip: str) -> str:
    """IPv4: the address. IPv6: the /64, because one connection controls a whole /64."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if addr.version == 6:
        if addr.ipv4_mapped:
            return str(addr.ipv4_mapped)
        return str(ipaddress.ip_network(f"{addr}/64", strict=False))
    return str(addr)


# ------------------------------------------------------------ rate limiting ---


class RateLimiter:
    """In-process sliding-window limiter. The app runs as one gunicorn worker, so one process owns all state."""

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()
        self._last_sweep = time.monotonic()

    def _prune(self, key: str, window: float, now: float) -> deque[float]:
        q = self._hits[key]
        while q and q[0] <= now - window:
            q.popleft()
        return q

    def _sweep(self, now: float) -> None:
        if now - self._last_sweep < 600:
            return
        self._last_sweep = now
        for key in [k for k, q in self._hits.items() if not q or q[-1] <= now - 86400]:
            del self._hits[key]

    def allow(self, key: str, limit: int, window: float) -> bool:
        """Record a hit and return True if it is within the limit."""
        now = time.monotonic()
        with self._lock:
            self._sweep(now)
            q = self._prune(key, window, now)
            if len(q) >= limit:
                return False
            q.append(now)
            return True

    def blocked(self, key: str, limit: int, window: float) -> bool:
        """True if `limit` hits were already recorded in the window (does not record anything)."""
        now = time.monotonic()
        with self._lock:
            return len(self._prune(key, window, now)) >= limit

    def record(self, key: str) -> None:
        with self._lock:
            self._hits[key].append(time.monotonic())

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


limiter = RateLimiter()


def ip_key(bucket: str) -> str:
    return f"{bucket}:{ip_bucket(client_ip())}"


# ------------------------------------------------------------ safe redirects ---


def safe_local_path(target: str | None, app_root: str) -> str | None:
    """Return `target` only if it is a same-site path inside this app, else None (no open redirects)."""
    if not target or len(target) > 2000:
        return None
    if any(ord(c) < 32 or c == "\\" for c in target):
        return None
    if not target.startswith("/") or target.startswith("//"):
        return None
    if app_root and not (target == app_root or target.startswith(app_root + "/")):
        return None
    return target


# --------------------------------------------------------------- headers ---

CSP = "; ".join(
    [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "form-action 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
    ]
)


def install_headers(app: Flask) -> None:
    @app.after_request
    def _headers(resp):
        resp.headers.setdefault("Content-Security-Policy", CSP)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        if not request.path.startswith(request.script_root + "/static/") and "Cache-Control" not in resp.headers:
            resp.headers["Cache-Control"] = "private, no-cache"
        return resp
