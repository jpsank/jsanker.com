#!/usr/bin/env python3
"""
GitHub push-webhook listener: redeploys the site when `main` changes. Standard library only (~10 MB of RAM).

  GitHub --POST /hook--> Cloudflare Tunnel --> this listener --> scripts/deploy.sh

Safety rules, all enforced before anything runs:
  * the body's HMAC-SHA256 (X-Hub-Signature-256) must match the shared secret, compared in constant time
  * only `push` events for refs/heads/main of GITHUB_REPO trigger a deploy ("ping" is acknowledged)
  * the request carries no data that reaches the shell: deploy.sh is run with no arguments from this process
  * deploys run one at a time; pushes that arrive during a deploy collapse into a single follow-up run

Environment: SECRET_FILE (required), LISTEN_HOST (default 172.17.0.1, the docker0 address the tunnel
container reaches as host.docker.internal), LISTEN_PORT (9000), GITHUB_REPO (jpsank/jsanker.com),
DEPLOY_CMD (default: deploy.sh next to this file; tests override it).
"""
import hashlib
import hmac
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("LISTEN_HOST", "172.17.0.1")
PORT = int(os.environ.get("LISTEN_PORT", "9000"))
REPO = os.environ.get("GITHUB_REPO", "jpsank/jsanker.com")
DEPLOY_CMD = os.environ.get("DEPLOY_CMD") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "deploy.sh")
MAX_BODY = 1_000_000

with open(os.environ["SECRET_FILE"], "rb") as f:
    SECRET = f.read().strip()
if len(SECRET) < 16:
    sys.exit("secret is too short")

wake = threading.Event()


def log(msg: str) -> None:
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}", flush=True)


def worker() -> None:
    while True:
        wake.wait()
        wake.clear()  # pushes during the run set it again -> exactly one follow-up run
        log("deploy: start")
        try:
            r = subprocess.run([DEPLOY_CMD], stdin=subprocess.DEVNULL, timeout=1800)
            log(f"deploy: finished, exit {r.returncode}")
        except Exception as e:  # noqa: BLE001 - keep the worker alive whatever happens
            log(f"deploy: failed to run: {e!r}")


class Handler(BaseHTTPRequestHandler):
    timeout = 10  # drop slow or stalled clients
    server_version = "deploy"
    sys_version = ""

    def reply(self, code: int, text: str = "") -> None:
        body = (text + "\n").encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/hook":
            return self.reply(404, "not found")
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self.reply(411, "length required")
        if length < 0 or length > MAX_BODY:
            return self.reply(413, "too large")
        body = self.rfile.read(length)

        want = "sha256=" + hmac.new(SECRET, body, hashlib.sha256).hexdigest()
        got = self.headers.get("X-Hub-Signature-256", "")
        if not hmac.compare_digest(want.encode(), got.encode()):
            log(f"rejected: bad signature from {self.client_address[0]}")
            return self.reply(401, "bad signature")

        event = self.headers.get("X-GitHub-Event", "")
        if event == "ping":
            return self.reply(200, "pong")
        if event != "push":
            return self.reply(204)
        try:
            payload = json.loads(body)
            ref = payload.get("ref")
            repo = (payload.get("repository") or {}).get("full_name")
        except (ValueError, AttributeError):
            return self.reply(400, "bad json")
        if repo != REPO or ref != "refs/heads/main":
            return self.reply(200, "ignored")

        log(f"push to main by {(payload.get('pusher') or {}).get('name', '?')}: queued")
        wake.set()
        self.reply(202, "deploying")

    def do_GET(self) -> None:  # noqa: N802
        self.reply(404, "not found")

    def log_message(self, fmt: str, *args) -> None:
        pass  # we log what matters ourselves


if __name__ == "__main__":
    threading.Thread(target=worker, daemon=True).start()
    log(f"listening on {HOST}:{PORT} for {REPO}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
