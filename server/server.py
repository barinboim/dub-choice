"""
Dub Choice co-op server.

Aiohttp app:
  - rooms (create/join/leave, mode, claims, relay turn)
  - pack distribution (creator uploads a ZIP, joiners download it)
  - takes (recordings as WAV, one per clip, uploaded by whoever voiced it)
  - WebSocket live events on /ws
  - static frontend (dist/) with SPA fallback

Run: PORT=8080 DATA_DIR=/data/dubchoice DIST_DIR=/srv/app/dist python3 server.py
"""

import asyncio
import json
import mimetypes
import os
import re
import secrets
import urllib.parse
import time
import uuid
from pathlib import Path

from aiohttp import WSMsgType, web

ROOM_TTL_SEC = 6 * 3600          # пустая/брошенная комната живёт 6 часов
CLEANUP_EVERY_SEC = 300
MAX_PARTICIPANTS = 8
MAX_NAME_LEN = 24
MAX_PACK_BYTES = 400 * 1024 * 1024
MAX_TAKE_BYTES = 25 * 1024 * 1024
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # без похожих символов
CODE_LEN = 5

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data/dubchoice"))
DIST_DIR = Path(os.environ.get("DIST_DIR", "/srv/app/dist"))
PORT = int(os.environ.get("PORT", "8080"))
# 0.0.0.0 — чтобы dubchoice.lan (Caddy) и LAN-игроки видели сервис;
# hostish-агент всё равно ходит на 127.0.0.1
HOST = os.environ.get("HOST", "0.0.0.0")

ROOMS_FILE = DATA_DIR / "rooms.json"

COLORS = [
    "#ff6b6b", "#ffa94d", "#ffd43b", "#69db7c", "#38d9a9",
    "#4dabf7", "#748ffc", "#da77f2",
]

# ---------------------------------------------------------------------------
# Модель комнаты
# ---------------------------------------------------------------------------


class Room:
    def __init__(self, code: str, host_pid: str, host_name: str):
        self.code = code
        self.host_pid = host_pid
        self.mode = "relay"                    # relay | free | chars
        self.participants: list[dict] = []     # {pid, name, color, connected}
        self.chars: dict[str, list[str]] = {}  # pid -> выбранные персонажи
        self.claims: dict[int, str] = {}       # clipIndex -> pid
        self.takes: dict[int, dict] = {}       # clipIndex -> {pid, name, leadSec}
        self.relay: dict = {"turn": None, "line": None}
        self.pack_title: str | None = None
        self.pack_meta: dict | None = None     # {title, clips: [{characters}]}
        self.updated = time.time()
        self.channels: set = set()             # живые WebSocket-соединения
        self.ws_pid: dict = {}                 # id(ws) → pid (для точечных сообщений)
        self.lock = asyncio.Lock()
        self.add_participant(host_pid, host_name)

    # -- участники ----------------------------------------------------------
    def add_participant(self, pid: str, name: str) -> dict:
        existing = self.by_pid(pid)
        if existing:
            existing["connected"] = True
            return existing
        part = {
            "pid": pid,
            "name": sanitize_name(name),
            "color": COLORS[len(self.participants) % len(COLORS)],
            "connected": True,
        }
        self.participants.append(part)
        return part

    def by_pid(self, pid: str) -> dict | None:
        return next((p for p in self.participants if p["pid"] == pid), None)

    def remove_participant(self, pid: str) -> None:
        self.participants = [p for p in self.participants if p["pid"] != pid]
        self.chars.pop(pid, None)
        self.claims = {i: owner for i, owner in self.claims.items() if owner != pid}
        if self.host_pid == pid and self.participants:
            self.host_pid = self.participants[0]["pid"]
        if self.relay.get("turn") == pid:
            line = self.relay.get("line")
            recorded = line is not None and line in self.takes
            self._advance_relay(reassign=not recorded)

    def public(self, clip_count: int) -> dict:
        return {
            "code": self.code,
            "hostPid": self.host_pid,
            "mode": self.mode,
            "participants": [
                {"pid": p["pid"], "name": p["name"], "color": p["color"],
                 "connected": p["connected"]}
                for p in self.participants
            ],
            "packTitle": self.pack_title,
            "packReady": self.pack_meta is not None,
            "chars": {pid: list(names) for pid, names in self.chars.items()},
            "claims": {str(i): pid for i, pid in self.claims.items()},
            "takes": {str(i): dict(m) for i, m in self.takes.items()},
            "relay": dict(self.relay),
            "clipCount": clip_count,
        }

    # -- реле -----------------------------------------------------------------
    def _next_line(self, from_index: int, clip_count: int) -> int | None:
        for i in range(from_index + 1, clip_count):
            if i not in self.takes:
                return i
        for i in range(from_index):
            if i not in self.takes:
                return i
        return None

    def start_relay(self, clip_count: int) -> None:
        if not self.participants or self.relay.get("line") is not None:
            return
        self.relay = {"turn": self.participants[0]["pid"], "line": self._next_line(-1, clip_count)}

    def repair_relay(self) -> None:
        """Если строка есть, а ходящего нет (все отключились) — отдаём ход вошедшему."""
        if self.mode != "relay" or not self.pack_meta:
            return
        if self.relay.get("line") is None:
            return
        if self.relay.get("turn") is None:
            pids = [p["pid"] for p in self.participants if p["connected"]]
            if pids:
                self.relay["turn"] = pids[0]

    def _advance_relay(self, reassign: bool = False) -> None:
        """Передаёт ход следующему подключённому участнику.

        reassign=True — текущая строка ещё не записана (ходящий отключился):
        отдаём её следующему, чтобы реплика не пропала из ротации.
        reassign=False — строка озвучена, ход уходит на следующую свободную.
        """
        clip_count = len(self.pack_meta.get("clips", [])) if self.pack_meta else 0
        current = self.relay.get("line")
        if current is None:
            return
        if reassign:
            nxt = current
        else:
            nxt = self._next_line(current, clip_count) if clip_count else None
        if nxt is None:
            self.relay = {"turn": None, "line": None}
            return
        # следующий подключённый участник по кругу после текущего хода;
        # офлайн-участников пропускаем — они не смогут озвучить строку
        pids = [p["pid"] for p in self.participants if p["connected"]]
        if not pids:
            self.relay = {"turn": None, "line": nxt}
            return
        cur = self.relay.get("turn")
        idx = pids.index(cur) if cur in pids else -1
        nxt_pid = pids[(idx + 1) % len(pids)]
        self.relay = {"turn": nxt_pid, "line": nxt}

    def pass_turn(self, pid: str) -> bool:
        if self.mode != "relay" or self.relay.get("turn") != pid:
            return False
        self._advance_relay()
        return True

    # -- персонажи --------------------------------------------------------------
    def clip_characters(self, index: int) -> list[str]:
        if not self.pack_meta:
            return []
        clips = self.pack_meta.get("clips", [])
        if index < 0 or index >= len(clips):
            return []
        return list(clips[index].get("characters", []))

    def can_claim(self, pid: str, index: int) -> bool:
        if self.mode == "chars":
            chars = self.clip_characters(index)
            if chars and not set(self.chars.get(pid, [])).intersection(chars):
                return False
        return True

    def claim_owner(self, index: int) -> str | None:
        """Владелец реплики: явный клейм или (в chars-режиме) первый выбравший персонажа."""
        if index in self.claims:
            return self.claims[index]
        if self.mode == "chars":
            chars = self.clip_characters(index)
            if not chars:
                return None
            for p in self.participants:
                if set(self.chars.get(p["pid"], [])).intersection(chars):
                    return p["pid"]
        return None

    # -- персистентность --------------------------------------------------------
    def snapshot(self) -> dict:
        return {
            "code": self.code,
            "host_pid": self.host_pid,
            "mode": self.mode,
            "participants": list(self.participants),
            "chars": {pid: list(c) for pid, c in self.chars.items()},
            "claims": {str(i): pid for i, pid in self.claims.items()},
            "takes": {str(i): dict(m) for i, m in self.takes.items()},
            "relay": dict(self.relay),
            "pack_title": self.pack_title,
            "pack_meta": self.pack_meta,
            "updated": self.updated,
        }


def sanitize_name(name: str) -> str:
    name = re.sub(r"[\x00-\x1f\x7f]", "", str(name or "")).strip()
    return name[:MAX_NAME_LEN] or "Игрок"


def new_code(rooms: dict) -> str:
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LEN))
        if code not in rooms:
            return code


ROOMS: dict[str, Room] = {}
MUTATION_SERIAL = asyncio.Lock()  # сериализует дампы на диск


async def dump_rooms() -> None:
    async with MUTATION_SERIAL:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = ROOMS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps({code: r.snapshot() for code, r in ROOMS.items()}))
        tmp.replace(ROOMS_FILE)


def load_rooms() -> None:
    try:
        data = json.loads(ROOMS_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return
    for snap in data.values():
        room = Room.__new__(Room)
        room.code = snap["code"]
        room.host_pid = snap["host_pid"]
        room.mode = snap.get("mode", "relay")
        room.participants = snap.get("participants", [])
        for p in room.participants:
            p["connected"] = False
        room.chars = snap.get("chars", {})
        room.claims = {int(i): pid for i, pid in snap.get("claims", {}).items()}
        room.takes = {int(i): dict(m) for i, m in snap.get("takes", {}).items()}
        room.relay = dict(snap.get("relay", {"turn": None, "line": None}))
        room.pack_title = snap.get("pack_title")
        room.pack_meta = snap.get("pack_meta")
        room.updated = snap.get("updated", time.time())
        room.channels = set()
        room.lock = asyncio.Lock()
        ROOMS[room.code] = room


# ---------------------------------------------------------------------------
# Вещание
# ---------------------------------------------------------------------------


async def broadcast(room: Room, event: dict) -> None:
    data = json.dumps(event)
    for ws in list(room.channels):
        try:
            await ws.send_str(data)
        except Exception:
            room.channels.discard(ws)


def room_dir(room: Room) -> Path:
    d = DATA_DIR / room.code
    d.mkdir(parents=True, exist_ok=True)
    return d


def takes_dir(room: Room) -> Path:
    d = room_dir(room) / "takes"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

routes = web.RouteTableDef()


def json_response(data, status=200):
    return web.json_response(data, status=status, dumps=lambda o: json.dumps(o, ensure_ascii=False))


async def get_room(request) -> Room | None:
    code = request.match_info["code"].upper()
    return ROOMS.get(code)


async def read_body(request, max_bytes: int) -> bytes:
    data = await request.read()
    if len(data) > max_bytes:
        raise web.HTTPRequestEntityTooLarge(
            text=json.dumps({"error": "Слишком большой файл."}), content_type="application/json"
        )
    return data


@routes.post("/api/rooms")
async def create_room(request: web.Request):
    body = await request.json()
    name = sanitize_name(body.get("name"))
    code = new_code(ROOMS)
    pid = uuid.uuid4().hex
    ROOMS[code] = Room(code, pid, name)
    await dump_rooms()
    return json_response({"code": code, "pid": pid, "room": ROOMS[code].public(0)})


@routes.post("/api/rooms/{code}/join")
async def join_room(request: web.Request):
    room = await get_room(request)
    if not room:
        return json_response({"error": "Комната не найдена."}, 404)
    body = await request.json()
    name = sanitize_name(body.get("name"))
    pid = str(body.get("pid") or uuid.uuid4().hex)
    async with room.lock:
        if len(room.participants) >= MAX_PARTICIPANTS and not room.by_pid(pid):
            return json_response({"error": "Комната заполнена."}, 409)
        part = room.add_participant(pid, name)
        room.repair_relay()
        clip_count = len(room.pack_meta.get("clips", [])) if room.pack_meta else 0
        state = room.public(clip_count)
        room.updated = time.time()
    await broadcast(room, {"type": "roster", "participants": state["participants"]})
    if room.mode == "relay" and room.relay.get("turn"):
        await broadcast(room, {"type": "turn", "pid": room.relay["turn"], "line": room.relay["line"]})
    await dump_rooms()
    return json_response({"pid": pid, "room": state, "name": part["name"]})


@routes.get("/api/rooms/{code}")
async def room_state(request: web.Request):
    room = await get_room(request)
    if not room:
        return json_response({"error": "Комната не найдена."}, 404)
    clip_count = len(room.pack_meta.get("clips", [])) if room.pack_meta else 0
    return json_response(room.public(clip_count))


@routes.post("/api/rooms/{code}/leave")
async def leave_room(request: web.Request):
    room = await get_room(request)
    if not room:
        return json_response({"ok": True})
    body = await request.json()
    pid = body.get("pid")
    async with room.lock:
        room.remove_participant(pid)
        clip_count = len(room.pack_meta.get("clips", [])) if room.pack_meta else 0
        state = room.public(clip_count)
        room.updated = time.time()
    await broadcast(room, {"type": "roster", "participants": state["participants"]})
    if room.relay.get("turn"):
        await broadcast(room, {"type": "turn", "pid": room.relay["turn"], "line": room.relay["line"]})
    if not room.participants:
        ROOMS.pop(room.code, None)
    await dump_rooms()
    return json_response({"ok": True})


@routes.post("/api/rooms/{code}/pack")
async def upload_pack(request: web.Request):
    room = await get_room(request)
    if not room:
        return json_response({"error": "Комната не найдена."}, 404)
    pid = request.headers.get("X-Pid", "")
    if pid != room.host_pid:
        return json_response({"error": "Пак загружает только хост."}, 403)
    data = await read_body(request, MAX_PACK_BYTES)
    if len(data) < 256:
        return json_response({"error": "Пустой файл."}, 400)
    meta_raw = request.headers.get("X-Pack-Meta", "{}")
    try:
        meta = json.loads(urllib.parse.unquote(meta_raw))
    except (json.JSONDecodeError, UnicodeDecodeError):
        meta = {}
    meta.setdefault("title", "Пак")
    meta.setdefault("clips", [])
    async with room.lock:
        d = room_dir(room)
        (d / "pack.zip").write_bytes(data)
        (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
        room.pack_title = meta.get("title")
        room.pack_meta = meta
        room.updated = time.time()
        if room.mode == "relay":
            room.start_relay(len(meta["clips"]))
        state = room.public(len(meta["clips"]))
    await broadcast(room, {"type": "pack", "title": room.pack_title})
    if room.relay.get("turn"):
        await broadcast(room, {"type": "turn", "pid": room.relay["turn"], "line": room.relay["line"]})
    await dump_rooms()
    return json_response({"ok": True, "room": state})


@routes.get("/api/rooms/{code}/pack")
async def download_pack(request: web.Request):
    room = await get_room(request)
    if not room:
        return json_response({"error": "Комната не найдена."}, 404)
    path = room_dir(room) / "pack.zip"
    if not path.exists():
        return json_response({"error": "Пак ещё не загружен."}, 404)
    return web.FileResponse(path, headers={"Content-Type": "application/zip"})


@routes.post("/api/rooms/{code}/takes/{index}")
async def upload_take(request: web.Request):
    room = await get_room(request)
    if not room:
        return json_response({"error": "Комната не найдена."}, 404)
    index = int(request.match_info["index"])
    pid = request.headers.get("X-Pid", "")
    if not room.by_pid(pid):
        return json_response({"error": "Ты не в комнате."}, 403)
    try:
        lead_sec = float(request.headers.get("X-Lead-Sec", "0"))
    except ValueError:
        lead_sec = 0.0
    data = await read_body(request, MAX_TAKE_BYTES)
    if len(data) < 512:
        return json_response({"error": "Пустая запись."}, 400)
    async with room.lock:
        existing = room.takes.get(index)
        if existing and existing["pid"] != pid:
            return json_response({"error": "Эту реплику уже озвучил другой участник."}, 409)
        part = room.by_pid(pid)
        name = part["name"] if part else "?"
        path = takes_dir(room) / f"{index}_{pid}.wav"
        path.write_bytes(data)
        room.takes[index] = {"pid": pid, "name": name, "leadSec": lead_sec}
        room.claims[index] = pid
        room.updated = time.time()
    await broadcast(room, {"type": "take", "index": index, "pid": pid, "name": name})
    await broadcast(room, {"type": "claim", "index": index, "pid": pid})
    await dump_rooms()
    return json_response({"ok": True})


@routes.get("/api/rooms/{code}/takes")
async def takes_meta(request: web.Request):
    room = await get_room(request)
    if not room:
        return json_response({"error": "Комната не найдена."}, 404)
    return json_response(room.takes)


@routes.get("/api/rooms/{code}/takes/{index}/wav")
async def take_wav(request: web.Request):
    room = await get_room(request)
    if not room:
        return json_response({"error": "Комната не найдена."}, 404)
    index = int(request.match_info["index"])
    meta = room.takes.get(index)
    if not meta:
        return json_response({"error": "Нет записи."}, 404)
    path = takes_dir(room) / f"{index}_{meta['pid']}.wav"
    if not path.exists():
        return json_response({"error": "Файл записи пропал."}, 404)
    return web.FileResponse(path, headers={"Content-Type": "audio/wav"})


@routes.post("/api/rooms/{code}/claim")
async def claim_clip(request: web.Request):
    room = await get_room(request)
    if not room:
        return json_response({"error": "Комната не найдена."}, 404)
    body = await request.json()
    pid = body.get("pid")
    index = int(body.get("index", -1))
    action = body.get("action", "claim")
    if action == "release":
        async with room.lock:
            if room.claims.get(index) == pid:
                del room.claims[index]
            room.updated = time.time()
        await broadcast(room, {"type": "claim", "index": index, "pid": None})
        return json_response({"ok": True})
    async with room.lock:
        if index in room.takes:
            return json_response({"ok": False, "by": room.takes[index]["pid"]})
        if index in room.claims:
            return json_response({"ok": False, "by": room.claims[index]})
        owner = room.claim_owner(index)
        if owner and owner != pid:
            return json_response({"ok": False, "by": owner})
        if not room.can_claim(pid, index):
            return json_response({"ok": False, "by": None, "reason": "chars"})
        room.claims[index] = pid
        room.updated = time.time()
    await broadcast(room, {"type": "claim", "index": index, "pid": pid})
    return json_response({"ok": True})


@routes.post("/api/rooms/{code}/mode")
async def set_mode(request: web.Request):
    room = await get_room(request)
    if not room:
        return json_response({"error": "Комната не найдена."}, 404)
    body = await request.json()
    if body.get("pid") != room.host_pid:
        return json_response({"error": "Режим меняет только хост."}, 403)
    mode = body.get("mode")
    if mode not in ("relay", "free", "chars"):
        return json_response({"error": "Неизвестный режим."}, 400)
    async with room.lock:
        room.mode = mode
        room.claims = {i: p for i, p in room.claims.items() if i in room.takes}
        room.updated = time.time()
        if mode == "relay" and room.pack_meta:
            room.start_relay(len(room.pack_meta["clips"]))
        elif mode != "relay":
            room.relay = {"turn": None, "line": None}
        state = room.public(len(room.pack_meta.get("clips", [])) if room.pack_meta else 0)
    await broadcast(room, {"type": "mode", "mode": mode})
    await broadcast(room, {"type": "turn", "pid": room.relay.get("turn"), "line": room.relay.get("line")})
    await dump_rooms()
    return json_response({"ok": True, "room": state})


@routes.post("/api/rooms/{code}/chars")
async def set_chars(request: web.Request):
    room = await get_room(request)
    if not room:
        return json_response({"error": "Комната не найдена."}, 404)
    body = await request.json()
    pid = body.get("pid")
    chars = [str(c)[:40] for c in body.get("characters", [])][:10]
    async with room.lock:
        room.chars[pid] = chars
        room.updated = time.time()
    await broadcast(room, {"type": "chars", "pid": pid, "characters": chars})
    await dump_rooms()
    return json_response({"ok": True})


@routes.post("/api/rooms/{code}/kick")
async def kick_player(request: web.Request):
    room = await get_room(request)
    if not room:
        return json_response({"error": "Комната не найдена."}, 404)
    body = await request.json()
    host = body.get("pid")
    target = body.get("target")
    if host != room.host_pid:
        return json_response({"error": "Кикать может только хост."}, 403)
    if target == host:
        return json_response({"error": "Нельзя кикнуть себя."}, 400)
    async with room.lock:
        part = room.by_pid(target)
        if not part:
            return json_response({"error": "Игрок уже не в комнате."}, 404)
        kicked_name = part["name"]
        room.remove_participant(target)
        room.updated = time.time()
        clip_count = len(room.pack_meta.get("clips", [])) if room.pack_meta else 0
        state = room.public(clip_count)
    # кикнутому: персональное событие и закрытие соединения (клиент не переподключается)
    for ws in list(room.channels):
        if room.ws_pid.get(id(ws)) == target:
            try:
                await ws.send_str(json.dumps({"type": "kicked", "by": host}))
            except Exception:
                pass
            try:
                await ws.close()
            except Exception:
                pass
    await broadcast(room, {"type": "roster", "participants": state["participants"]})
    if room.mode == "relay" and room.relay.get("turn"):
        await broadcast(room, {"type": "turn", "pid": room.relay["turn"], "line": room.relay["line"]})
    if not room.participants:
        ROOMS.pop(room.code, None)
    await dump_rooms()
    return json_response({"ok": True, "kicked": kicked_name})


@routes.post("/api/rooms/{code}/pass")
async def pass_turn(request: web.Request):
    room = await get_room(request)
    if not room:
        return json_response({"error": "Комната не найдена."}, 404)
    body = await request.json()
    pid = body.get("pid")
    async with room.lock:
        ok = room.pass_turn(pid)
        room.updated = time.time()
    if not ok:
        return json_response({"error": "Не твой ход."}, 409)
    await broadcast(room, {"type": "turn", "pid": room.relay.get("turn"), "line": room.relay.get("line")})
    await dump_rooms()
    return json_response({"ok": True})


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------


async def ws_handler(request: web.Request):
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=64 * 1024)
    await ws.prepare(request)
    code = request.query.get("code", "").upper()
    pid = request.query.get("pid", "")
    room = ROOMS.get(code)
    if not room or not room.by_pid(pid):
        await ws.send_str(json.dumps({"type": "error", "error": "not-in-room"}))
        await ws.close()
        return ws

    room.channels.add(ws)
    room.ws_pid[id(ws)] = pid
    clip_count = len(room.pack_meta.get("clips", [])) if room.pack_meta else 0
    await ws.send_str(json.dumps({"type": "state", "room": room.public(clip_count)}))

    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue
                if data.get("type") == "hello":
                    async with room.lock:
                        room.by_pid(pid)["connected"] = True
                        room.repair_relay()
                        room.updated = time.time()
                        clip_count = len(room.pack_meta.get("clips", [])) if room.pack_meta else 0
                        state = room.public(clip_count)
                    broadcast(room, {"type": "roster", "participants": state["participants"]})
                    broadcast(room, {"type": "turn", "pid": room.relay.get("turn"), "line": room.relay.get("line")})
            elif msg.type == WSMsgType.ERROR:
                break
    finally:
        room.channels.discard(ws)
        room.ws_pid.pop(id(ws), None)
        async with room.lock:
            part = room.by_pid(pid)
            if part:
                part["connected"] = False
                room.updated = time.time()
                # ход за отключившимся в эстафете — передаём следующему,
                # иначе комната зависнет на недоступном участнике
                if room.mode == "relay" and room.relay.get("turn") == pid:
                    line = room.relay.get("line")
                    recorded = line is not None and line in room.takes
                    room._advance_relay(reassign=not recorded)
        participants = [
            {"pid": p["pid"], "name": p["name"], "color": p["color"], "connected": p["connected"]}
            for p in room.participants
        ]
        await broadcast(room, {"type": "roster", "participants": participants})
        await broadcast(room, {"type": "turn", "pid": room.relay.get("turn"), "line": room.relay.get("line")})
    return ws


# ---------------------------------------------------------------------------
# Статика (dist) со SPA-фолбэком
# ---------------------------------------------------------------------------


async def static_handler(request: web.Request) -> web.Response:
    path = request.path.lstrip("/")
    if path.startswith("api/") or path.startswith("ws"):
        return json_response({"error": "not found"}, 404)
    if path == "":
        path = "index.html"
    candidate = (DIST_DIR / path).resolve()
    # не выпускаем за пределы dist
    if DIST_DIR.resolve() not in candidate.parents and candidate != DIST_DIR.resolve():
        candidate = DIST_DIR / "index.html"
    if candidate.is_file():
        ctype = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
        body = candidate.read_bytes()
        cache = "no-cache" if "index.html" in str(candidate) or "." not in path else "public, max-age=31536000, immutable"
        return web.Response(body=body, content_type=ctype, headers={"Cache-Control": cache})
    index = DIST_DIR / "index.html"
    if index.is_file():
        return web.Response(body=index.read_bytes(), content_type="text/html", headers={"Cache-Control": "no-cache"})
    return json_response({"error": "frontend not built"}, 503)


# ---------------------------------------------------------------------------
# Фоновая очистка
# ---------------------------------------------------------------------------


async def cleanup_loop() -> None:
    while True:
        await asyncio.sleep(CLEANUP_EVERY_SEC)
        now = time.time()
        dead = [code for code, r in ROOMS.items() if now - r.updated > ROOM_TTL_SEC]
        for code in dead:
            room = ROOMS.pop(code, None)
            if room:
                for ws in list(room.channels):
                    try:
                        await ws.close()
                    except Exception:
                        pass
                import shutil
                shutil.rmtree(DATA_DIR / code, ignore_errors=True)
        if dead:
            await dump_rooms()


# ---------------------------------------------------------------------------
# Запуск
# ---------------------------------------------------------------------------


async def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    load_rooms()
    app = web.Application(client_max_size=500 * 1024 * 1024)
    app.add_routes(routes)
    app.router.add_route("*", "/ws", ws_handler)
    app.router.add_route("*", "/{tail:.*}", static_handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, HOST, PORT)
    await site.start()
    print(f"dub-choice server on 127.0.0.1:{PORT}, data={DATA_DIR}", flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
