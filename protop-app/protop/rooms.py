"""Workspace rooms: one structure plus a shared, append-only log of annotation and mutation operations."""
from __future__ import annotations

import json
import re
import secrets
import threading
import time
import zlib
from collections import OrderedDict
from contextlib import contextmanager

from flask import Blueprint, Response, current_app, jsonify, request

from .aggregator import PDB_ID, fetch_structure
from .db import get_db, iso
from .errors import ApiError
from .security import ip_key, limiter
from .structure import MAX_BYTES, StructureError, clean_title, parse_structure
from .upstream import UpstreamNotFound, UpstreamTooLarge

bp = Blueprint("rooms", __name__)

ROOM_ID = re.compile(r"^[A-Za-z0-9_-]{22}$")
CLIENT_ID = re.compile(r"^[A-Za-z0-9_-]{8,32}$")
COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
AMINO_ACIDS = "ACDEFGHIKLMNPQRSTVWY"

ROOM_TTL = 14 * 86400
TOUCH_INTERVAL = 600            # sync extends the expiry at most this often (avoids a write per poll)
MAX_ROOMS = 500
MAX_OPS = 2000
MAX_LIVE = 200
PRESENCE_TTL = 20
MAX_PRESENCE_PER_ROOM = 60
UPLOAD_BODY_LIMIT = 6 * 1024 * 1024     # a 5 MB text, JSON-escaped
OP_BODY_LIMIT = 40 * 1024
PRESENCE_BODY_LIMIT = 4 * 1024
TEXT_MAX = 500
NAME_MAX = 32

# ------------------------------------------------------------------ text ---

_STRIP = {c: None for c in list(range(0, 32)) + [127] + list(range(0x80, 0xA0))}
_STRIP.update({c: None for c in (0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x2028, 0x2029, 0xFEFF)})
_STRIP.update({c: None for c in range(0x202A, 0x202F)})
_STRIP.update({c: None for c in range(0x2066, 0x206A)})
_KEEP_NEWLINE = {k: v for k, v in _STRIP.items() if k != 10}


def clean_text(value: str, keep_newline: bool) -> str:
    """Remove control characters (and bidi/line-separator tricks); newline survives only where allowed."""
    return value.translate(_KEEP_NEWLINE if keep_newline else _STRIP)


# --------------------------------------------------------------- helpers ---


def body_json(limit: int) -> dict:
    request.max_content_length = limit      # werkzeug answers 413 before reading more than this
    raw = request.get_data(cache=False)
    try:
        data = json.loads(raw)
    except (ValueError, RecursionError):
        raise ApiError(400, "The request body must be a JSON object.") from None
    if not isinstance(data, dict):
        raise ApiError(400, "The request body must be a JSON object.")
    return data


def rate_limit(name: str, limit: int, window: int, message: str) -> None:
    if not limiter.allow(ip_key(name), limit, window):
        raise ApiError(429, message, retry_after=min(window, 3600))


def get_str(d: dict, key: str, lo: int = 0, hi: int = 1000, keep_newline: bool = False, required: bool = True) -> str | None:
    value = d.get(key)
    if value is None and not required:
        return None
    if not isinstance(value, str):
        raise ApiError(400, f"'{key}' must be a string.")
    value = clean_text(value, keep_newline)
    if len(value) > hi or len(value.strip()) < lo:
        raise ApiError(422, f"'{key}' must be {lo} to {hi} characters." if lo else f"'{key}' must be at most {hi} characters.")
    return value


def get_int(d: dict, key: str) -> int:
    v = d.get(key)
    if isinstance(v, bool) or not isinstance(v, int) or abs(v) > 10**9:
        raise ApiError(400, f"'{key}' must be an integer.")
    return v


def get_client(d: dict) -> str:
    v = d.get("client")
    if not isinstance(v, str) or not CLIENT_ID.match(v):
        raise ApiError(400, "'client' must be 8 to 32 letters, digits, '-' or '_'.")
    return v


def get_name(d: dict, key: str) -> str:
    name = get_str(d, key, 0, NAME_MAX)
    return name.strip() or "Anonymous"


@contextmanager
def immediate(conn):
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


@contextmanager
def snapshot(conn):
    """A read transaction, so several SELECTs see one consistent state."""
    conn.execute("BEGIN")
    try:
        yield
    finally:
        conn.execute("COMMIT")


# ---------------------------------------------------------- room storage ---


def cleanup_expired(conn, now: float | None = None) -> int:
    now = now or time.time()
    with immediate(conn):
        ids = [r["id"] for r in conn.execute("SELECT id FROM rooms WHERE expires <= ?", (now,)).fetchall()]
        for rid in ids:
            conn.execute("DELETE FROM ops WHERE room_id = ?", (rid,))
        conn.execute("DELETE FROM rooms WHERE expires <= ?", (now,))
    return len(ids)


def delete_room(conn, rid: str) -> None:
    with immediate(conn):
        conn.execute("DELETE FROM ops WHERE room_id = ?", (rid,))
        conn.execute("DELETE FROM rooms WHERE id = ?", (rid,))


def load_room(conn, rid: str):
    """The room row, or ApiError 404 (also for malformed ids and expired rooms, which are deleted on sight)."""
    if not ROOM_ID.match(rid):
        raise ApiError(404, "That room does not exist or has expired.")
    row = conn.execute("SELECT * FROM rooms WHERE id = ?", (rid,)).fetchone()
    if row is None:
        raise ApiError(404, "That room does not exist or has expired.")
    if row["expires"] <= time.time():
        if not conn.in_transaction:     # inside a write transaction the raise below would roll the delete back
            delete_room(conn, rid)
        raise ApiError(404, "That room does not exist or has expired.")
    return row


_chain_cache: OrderedDict[str, tuple[list, dict]] = OrderedDict()
_chain_lock = threading.Lock()


def room_chains(row) -> tuple[list, dict]:
    """(chains list, index) with index[chain] = {"aa": {(num, icode): aa}, "nums": {num, ...}}; small LRU."""
    rid = row["id"]
    with _chain_lock:
        hit = _chain_cache.get(rid)
        if hit is not None:
            _chain_cache.move_to_end(rid)
            return hit
    chains = json.loads(zlib.decompress(row["chains"]))
    index = {c["name"]: {"aa": {(r["num"], r["icode"]): r["aa"] for r in c["residues"]},
                         "nums": {r["num"] for r in c["residues"]}} for c in chains}
    with _chain_lock:
        _chain_cache[rid] = (chains, index)
        while len(_chain_cache) > 6:
            _chain_cache.popitem(last=False)
    return chains, index


def room_json(row) -> dict:
    chains, _ = room_chains(row)
    return {
        "id": row["id"], "created": iso(row["created"]), "expires": iso(row["expires"]), "seq": row["seq"],
        "structure": {"format": row["fmt"], "title": row["title"], "source": row["source"]},
        "chains": chains,
    }


def touch(conn, row, now: float) -> None:
    if now - row["touched"] > TOUCH_INTERVAL:
        conn.execute("UPDATE rooms SET touched = ?, expires = ? WHERE id = ?", (now, now + ROOM_TTL, row["id"]))


def maybe_cleanup() -> None:
    """Opportunistic expiry sweep, at most hourly."""
    state = current_app.extensions["protop"]
    now = time.time()
    with state["lock"]:
        if now - state["last_cleanup"] < 3600:
            return
        state["last_cleanup"] = now
    cleanup_expired(get_db(), now)


# -------------------------------------------------------------- presence ---


class Presence:
    """In-memory who-is-looking-at-what. One gunicorn worker owns it; a lock makes threads safe."""

    def __init__(self) -> None:
        self._rooms: dict[str, dict[str, dict]] = {}
        self._lock = threading.Lock()
        self._last_sweep = time.monotonic()

    def _sweep(self, now: float) -> None:
        if now - self._last_sweep < 60:
            return
        self._last_sweep = now
        for rid in list(self._rooms):
            room = self._rooms[rid]
            for c in [c for c, e in room.items() if now - e["seen"] > PRESENCE_TTL]:
                del room[c]
            if not room:
                del self._rooms[rid]

    def _entry(self, rid: str, client: str, now: float) -> dict:
        room = self._rooms.setdefault(rid, {})
        entry = room.get(client)
        if entry is None:
            if len(room) >= MAX_PRESENCE_PER_ROOM:
                oldest = min(room, key=lambda c: room[c]["seen"])
                del room[oldest]
            entry = room[client] = {"client": client, "name": "Anonymous", "color": "#888888",
                                    "chain": None, "start": None, "end": None, "seen": now}
        return entry

    def heartbeat(self, rid: str, client: str) -> None:
        now = time.monotonic()
        with self._lock:
            self._sweep(now)
            self._entry(rid, client, now)["seen"] = now

    def update(self, rid: str, client: str, name: str, color: str, chain, start, end) -> None:
        now = time.monotonic()
        with self._lock:
            self._sweep(now)
            e = self._entry(rid, client, now)
            e.update(name=name, color=color, chain=chain, start=start, end=end, seen=now)

    def listing(self, rid: str) -> list[dict]:
        now = time.monotonic()
        with self._lock:
            room = self._rooms.get(rid, {})
            live = [e for e in room.values() if now - e["seen"] <= PRESENCE_TTL]
            return sorted(({k: v for k, v in e.items() if k != "seen"} for e in live), key=lambda e: e["client"])

    def forget(self, rid: str) -> None:
        with self._lock:
            self._rooms.pop(rid, None)


def presence() -> Presence:
    return current_app.extensions["protop"]["presence"]


# ---------------------------------------------------------------- create ---


def _upload_from_body(body: dict):
    up = body.get("upload")
    if not isinstance(up, dict):
        raise ApiError(400, "'upload' must be an object with 'name' and 'text'.")
    text = up.get("text")
    if not isinstance(text, str):
        raise ApiError(400, "'upload.text' must be a string.")
    name = up.get("name", "upload")
    if not isinstance(name, str):
        raise ApiError(400, "'upload.name' must be a string.")
    name = clean_text(name, False).strip()[:100] or "upload"
    return name, text


@bp.post("/rooms")
def create_room():
    rate_limit("room-try", 60, 3600, "Too many attempts. Try again later.")
    if limiter.blocked(ip_key("room-create"), 10, 3600):
        raise ApiError(429, "You have created 10 rooms in the last hour. Try again later.", retry_after=3600)
    body = body_json(UPLOAD_BODY_LIMIT)
    has_pdb, has_upload = "pdb" in body, "upload" in body
    if has_pdb == has_upload:
        raise ApiError(400, "Send either 'pdb' (a PDB ID) or 'upload' ({name, text}).")
    if has_pdb:
        pdb_id = body["pdb"]
        if not isinstance(pdb_id, str) or not PDB_ID.match(pdb_id):
            raise ApiError(400, "'pdb' must be a PDB ID like 1R42.")
        pdb_id = pdb_id.upper()
        text = None
        for fmt in ("pdb", "cif"):          # large entries have no legacy .pdb file
            try:
                text = fetch_structure(pdb_id, fmt)
                break
            except UpstreamNotFound:
                continue
            except UpstreamTooLarge:
                raise ApiError(422, "That structure is too large for a workspace room (5 MB, 200,000 atoms).") from None
        if text is None:
            raise ApiError(404, f"RCSB has no coordinates for {pdb_id}.")
        source, fallback_title = f"pdb:{pdb_id}", pdb_id
    else:
        name, text = _upload_from_body(body)
        source, fallback_title = f"upload:{name}", name
    try:
        parsed = parse_structure(text)
    except StructureError as e:
        raise ApiError(422, str(e)) from None

    conn = get_db()
    maybe_cleanup()
    rid = secrets.token_urlsafe(16)
    now = time.time()
    with immediate(conn):
        conn.execute("DELETE FROM ops WHERE room_id IN (SELECT id FROM rooms WHERE expires <= ?)", (now,))
        conn.execute("DELETE FROM rooms WHERE expires <= ?", (now,))
        if conn.execute("SELECT COUNT(*) FROM rooms").fetchone()[0] >= MAX_ROOMS:
            raise ApiError(503, "ProTop has reached its limit of 500 live rooms. Try again later.", retry_after=3600)
        conn.execute(
            "INSERT INTO rooms (id, created, touched, expires, seq, fmt, title, source, structure, chains) "
            "VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)",
            (rid, now, now, now + ROOM_TTL, parsed.fmt, parsed.title or clean_title(fallback_title), source,
             zlib.compress(text.encode("utf-8"), 6),
             zlib.compress(json.dumps(parsed.chains, separators=(",", ":")).encode(), 6)))
    limiter.record(ip_key("room-create"))
    resp = jsonify(room_json(conn.execute("SELECT * FROM rooms WHERE id = ?", (rid,)).fetchone()))
    resp.status_code = 201
    return resp


@bp.get("/rooms/<rid>")
def get_room(rid: str):
    return jsonify(room_json(load_room(get_db(), rid)))


@bp.get("/rooms/<rid>/structure")
def get_structure(rid: str):
    row = load_room(get_db(), rid)
    return Response(zlib.decompress(row["structure"]), mimetype="text/plain; charset=utf-8")


# ------------------------------------------------------------------- ops ---


def _load_ops(conn, rid: str, since: int = 0) -> list[dict]:
    return [json.loads(r["data"]) for r in
            conn.execute("SELECT data FROM ops WHERE room_id = ? AND seq > ? ORDER BY seq", (rid, since)).fetchall()]


def fold(ops: list[dict]) -> tuple[dict[int, dict], dict[int, dict]]:
    """Replay the log: seq -> annotation / mutation with the newest edit, status and delete applied."""
    annotations: dict[int, dict] = {}
    mutations: dict[int, dict] = {}
    for op in ops:
        t = op["type"]
        if t == "annotation":
            annotations[op["seq"]] = {**op, "deleted": False}
        elif t == "annotation_edit" and op["target"] in annotations:
            annotations[op["target"]]["text"] = op["text"]
        elif t == "annotation_delete" and op["target"] in annotations:
            annotations[op["target"]]["deleted"] = True
        elif t == "mutation":
            mutations[op["seq"]] = {**op, "status": "proposed", "deleted": False}
        elif t == "mutation_status" and op["target"] in mutations:
            mutations[op["target"]]["status"] = op["status"]
        elif t == "mutation_delete" and op["target"] in mutations:
            mutations[op["target"]]["deleted"] = True
    return annotations, mutations


def _target(d: dict) -> int:
    t = get_int(d, "target")
    if t < 1:
        raise ApiError(422, "'target' must be the seq of an earlier operation.")
    return t


def _check_range(index: dict, chain: str, start: int, end: int) -> None:
    if chain not in index:
        raise ApiError(422, f"This structure has no chain '{chain}'.")
    if start > end:
        raise ApiError(422, "'start' must not be after 'end'.")
    nums = index[chain]["nums"]
    if start not in nums or end not in nums:
        raise ApiError(422, "That residue range does not exist in this chain.")


def build_op(d: dict, index: dict, annotations: dict, mutations: dict) -> dict:
    """Validate a posted op against the structure and the folded log; returns the op fields to store."""
    kind = d.get("type")
    if kind == "annotation":
        chain = d.get("chain")
        if not isinstance(chain, str):
            raise ApiError(400, "'chain' must be a string.")
        start, end = get_int(d, "start"), get_int(d, "end")
        text = get_str(d, "text", 1, TEXT_MAX, keep_newline=True)
        _check_range(index, chain, start, end)
        if sum(1 for a in annotations.values() if not a["deleted"]) >= MAX_LIVE:
            raise ApiError(409, f"This room already has {MAX_LIVE} annotations.")
        return {"chain": chain, "start": start, "end": end, "text": text}
    if kind in ("annotation_edit", "annotation_delete"):
        target = _target(d)
        ann = annotations.get(target)
        if ann is None:
            raise ApiError(422, "'target' is not an annotation in this room.")
        if ann["deleted"]:
            raise ApiError(422, "That annotation was already deleted.")
        out = {"target": target}
        if kind == "annotation_edit":
            out["text"] = get_str(d, "text", 1, TEXT_MAX, keep_newline=True)
        return out
    if kind == "mutation":
        chain = d.get("chain")
        if not isinstance(chain, str):
            raise ApiError(400, "'chain' must be a string.")
        num = get_int(d, "num")
        icode = d.get("icode", "")
        if icode is None:
            icode = ""
        if not isinstance(icode, str) or len(icode.strip()) > 1:
            raise ApiError(400, "'icode' must be empty or a single character.")
        icode = clean_text(icode, False).strip()
        to = d.get("to")
        if not isinstance(to, str):
            raise ApiError(400, "'to' must be a one-letter amino acid.")
        note = get_str(d, "note", 0, TEXT_MAX, keep_newline=True, required=False) or ""
        if chain not in index:
            raise ApiError(422, f"This structure has no chain '{chain}'.")
        frm = index[chain]["aa"].get((num, icode))
        if frm is None:
            raise ApiError(422, "That residue does not exist in this chain.")
        if len(to) != 1 or to not in AMINO_ACIDS:
            raise ApiError(422, f"'to' must be one of {AMINO_ACIDS}.")
        if to == frm:
            raise ApiError(422, "That residue already is that amino acid.")
        if sum(1 for m in mutations.values() if not m["deleted"]) >= MAX_LIVE:
            raise ApiError(409, f"This room already has {MAX_LIVE} mutations.")
        return {"chain": chain, "num": num, "icode": icode, "to": to, "note": note, "from": frm}
    if kind in ("mutation_status", "mutation_delete"):
        target = _target(d)
        mut = mutations.get(target)
        if mut is None:
            raise ApiError(422, "'target' is not a mutation in this room.")
        if mut["deleted"]:
            raise ApiError(422, "That mutation was already deleted.")
        out = {"target": target}
        if kind == "mutation_status":
            status = d.get("status")
            if not isinstance(status, str):
                raise ApiError(400, "'status' must be a string.")
            if status not in ("proposed", "accepted", "rejected"):
                raise ApiError(422, "'status' must be proposed, accepted or rejected.")
            out["status"] = status
        return out
    raise ApiError(400, "Unknown 'type'.")


@bp.post("/rooms/<rid>/ops")
def post_op(rid: str):
    rate_limit("ops", 120, 60, "You are sending changes too fast. Wait a moment.")
    d = body_json(OP_BODY_LIMIT)
    if not isinstance(d.get("type"), str):
        raise ApiError(400, "'type' must be a string.")
    client = get_client(d)
    author = get_name(d, "author")
    conn = get_db()
    with immediate(conn):
        row = load_room(conn, rid)
        if row["seq"] >= MAX_OPS:
            raise ApiError(409, "This room is full.")
        _, index = room_chains(row)
        annotations, mutations = fold(_load_ops(conn, rid))
        fields = build_op(d, index, annotations, mutations)
        now = time.time()
        seq = row["seq"] + 1
        op = {"seq": seq, "type": d["type"], "ts": iso(now), "author": author, "client": client, **fields}
        conn.execute("INSERT INTO ops (room_id, seq, data) VALUES (?, ?, ?)", (rid, seq, json.dumps(op)))
        conn.execute("UPDATE rooms SET seq = ?, touched = ?, expires = ? WHERE id = ?", (seq, now, now + ROOM_TTL, rid))
    resp = jsonify({"seq": seq, "op": op})
    resp.status_code = 201
    return resp


@bp.get("/rooms/<rid>/sync")
def sync(rid: str):
    rate_limit("sync", 600, 60, "You are polling too fast. Wait a moment.")
    raw = request.args.get("since", "0")
    if not raw.isdigit() or len(raw) > 9:
        raise ApiError(400, "'since' must be a non-negative integer.")
    since = int(raw)
    client = request.args.get("client")
    if client is not None and not CLIENT_ID.match(client):
        raise ApiError(400, "'client' must be 8 to 32 letters, digits, '-' or '_'.")
    conn = get_db()
    with snapshot(conn):
        row = load_room(conn, rid)
        ops = _load_ops(conn, rid, since)
    touch(conn, row, time.time())
    if client:
        presence().heartbeat(rid, client)
    return jsonify({"seq": row["seq"], "ops": ops, "presence": presence().listing(rid)})


@bp.post("/rooms/<rid>/presence")
def post_presence(rid: str):
    rate_limit("presence", 300, 60, "You are sending presence updates too fast.")
    d = body_json(PRESENCE_BODY_LIMIT)
    client = get_client(d)
    name = get_name(d, "name")
    color = d.get("color")
    if not isinstance(color, str):
        raise ApiError(400, "'color' must be a string like #3366cc.")
    if not COLOR.match(color):
        raise ApiError(422, "'color' must look like #3366cc.")
    chain, start, end = d.get("chain"), d.get("start"), d.get("end")
    row = load_room(get_db(), rid)
    if chain is None and start is None and end is None:
        pass
    else:
        if not isinstance(chain, str):
            raise ApiError(400, "'chain', 'start' and 'end' must all be set, or all null.")
        start, end = get_int(d, "start"), get_int(d, "end")
        _check_range(room_chains(row)[1], chain, start, end)
    presence().update(rid, client, name, color.lower(), chain, start, end)
    return Response(status=204)


# ---------------------------------------------------------------- export ---


def _label(row) -> str:
    source = row["source"]
    if source.startswith("pdb:"):
        return source[4:]
    stem = re.sub(r"\.[A-Za-z0-9]{1,5}$", "", source[len("upload:"):])
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", stem).strip("_.")[:32]
    return stem or row["id"][:8]


def _mutated_sequences(chains: list[dict], mutations: dict[int, dict]) -> list[tuple[str, str, list[str]]]:
    accepted = sorted((m for m in mutations.values() if not m["deleted"] and m["status"] == "accepted"),
                      key=lambda m: m["seq"])
    out = []
    for c in chains:
        seq = {(r["num"], r["icode"]): r["aa"] for r in c["residues"]}
        applied = []
        for m in accepted:
            key = (m["num"], m["icode"])
            if m["chain"] == c["name"] and key in seq:
                seq[key] = m["to"]
                applied.append(f"{m['from']}{m['num']}{m['icode']}{m['to']}")
        letters = "".join(seq[(r["num"], r["icode"])] for r in c["residues"])
        out.append((c["name"], letters, applied))
    return out


@bp.get("/rooms/<rid>/export")
def export(rid: str):
    fmt = request.args.get("format", "fasta")
    if fmt not in ("fasta", "json"):
        raise ApiError(400, "'format' must be fasta or json.")
    conn = get_db()
    with snapshot(conn):
        row = load_room(conn, rid)
        ops = _load_ops(conn, rid)
    chains, _ = room_chains(row)
    annotations, mutations = fold(ops)
    if fmt == "fasta":
        label = _label(row)
        lines = []
        for name, letters, applied in _mutated_sequences(chains, mutations):
            header = f">{label}_{name}" + (f" mutated: {','.join(applied)}" if applied else "")
            lines.append(header)
            lines.extend(letters[i:i + 60] for i in range(0, len(letters), 60))
        return Response("\n".join(lines) + "\n", mimetype="text/plain")
    payload = {
        "room": rid,
        "structure": {"format": row["fmt"], "title": row["title"], "source": row["source"]},
        "chains": chains,
        "annotations": [{k: v for k, v in a.items() if k != "deleted"} for a in annotations.values() if not a["deleted"]],
        "mutations": [{k: v for k, v in m.items() if k != "deleted"} for m in mutations.values() if not m["deleted"]],
        "exported": iso(time.time()),
    }
    resp = jsonify(payload)
    resp.headers["Content-Disposition"] = f'attachment; filename="protop-room-{rid[:6]}.json"'
    return resp
