"""Smoke-тест бэкенда: комнаты, пак, тайки, режимы, WS."""
import asyncio
import json
import os
import sys
import time

os.environ.setdefault("DATA_DIR", "/tmp/dubtest")
os.environ.setdefault("DIST_DIR", "/tmp/dubtest-dist")
os.environ["PORT"] = "8091"

import aiohttp
import server  # noqa: E402  (запускает main только под __main__)


async def main() -> int:
    os.makedirs("/tmp/dubtest-dist", exist_ok=True)
    with open("/tmp/dubtest-dist/index.html", "w") as f:
        f.write("<h1>dub test</h1>")
    t = asyncio.create_task(server.main())
    await asyncio.sleep(0.6)
    base = "http://127.0.0.1:8091"
    fails = 0

    def check(name, cond, extra=""):
        nonlocal fails
        print(("✅ " if cond else "❌ ") + name + ("" if cond else f"  {extra}"))
        if not cond:
            fails += 1

    async with aiohttp.ClientSession() as s:
        # --- создание комнаты ---
        r = await s.post(f"{base}/api/rooms", json={"name": "Антон"})
        j = await r.json()
        check("создание комнаты", r.status == 200 and j["code"], j)
        code, pid1 = j["code"], j["pid"]

        # --- присоединение второго ---
        r = await s.post(f"{base}/api/rooms/{code}/join", json={"name": "Маша"})
        j2 = await r.json()
        pid2 = j2["pid"]
        check("join второго", r.status == 200 and len(j2["room"]["participants"]) == 2, j2)

        # --- WS: оба подключаются ---
        ws1 = await s.ws_connect(f"{base}/ws?code={code}&pid={pid1}")
        msg1 = json.loads((await ws1.receive()).data)
        check("ws state host", msg1["type"] == "state" and msg1["room"]["code"] == code)
        ws2 = await s.ws_connect(f"{base}/ws?code={code}&pid={pid2}")
        msg2 = json.loads((await ws2.receive()).data)
        check("ws state join", msg2["type"] == "state")

        # --- загрузка пака хостом ---
        meta = json.dumps({"title": "Тест", "clips": [{"characters": ["Герой"]}, {"characters": ["Герой"]}, {"characters": ["Злодей"]}]})
        r = await s.post(
            f"{base}/api/rooms/{code}/pack",
            data=b"PK\x03\x04fakezip" + b"\x00" * 2000,
            headers={"X-Pid": pid1, "X-Pack-Meta": meta},
        )
        check("пак загружен", r.status == 200, await r.text())
        r = await s.post(f"{base}/api/rooms/{code}/pack", data=b"x", headers={"X-Pid": pid2})
        check("не-хост не может залить пак", r.status == 403)

        # --- свободный режим: клеймы ---
        r = await s.post(f"{base}/api/rooms/{code}/mode", json={"pid": pid1, "mode": "free"})
        check("режим free", r.status == 200)
        r = await s.post(f"{base}/api/rooms/{code}/claim", json={"pid": pid1, "index": 0})
        check("клейм 0 первым", r.status == 200 and (await r.json())["ok"])
        r = await s.post(f"{base}/api/rooms/{code}/claim", json={"pid": pid2, "index": 0})
        check("второй не может забрать 0", (await r.json())["ok"] is False)
        r = await s.post(f"{base}/api/rooms/{code}/claim", json={"pid": pid2, "action": "release", "index": 0})
        r = await s.post(f"{base}/api/rooms/{code}/claim", json={"pid": pid1, "action": "release", "index": 0})
        check("релиз", (await r.json())["ok"])

        # --- тайк ---
        wav = bytes([0x52, 0x49, 0x46, 0x46]) + b"\x00" * 2048
        r = await s.post(
            f"{base}/api/rooms/{code}/takes/1",
            data=wav,
            headers={"X-Pid": pid1, "X-Lead-Sec": "0.35"},
        )
        check("тайк загружен", r.status == 200)
        r = await s.get(f"{base}/api/rooms/{code}/takes")
        takes = await r.json()
        check("мета тайков", "1" in takes and takes["1"]["leadSec"] == 0.35, takes)
        r = await s.get(f"{base}/api/rooms/{code}/takes/1/wav")
        check("скачивание тайка", r.status == 200 and (await r.read()) == wav)

        # --- ws: событие тайка долетело до второго ---
        evt = None
        for _ in range(10):
            evt = json.loads((await ws2.receive()).data)
            if evt["type"] == "take":
                break
        check("ws событие take", evt and evt["type"] == "take" and evt["index"] == 1, evt)

        # --- режим по персонажам ---
        r = await s.post(f"{base}/api/rooms/{code}/mode", json={"pid": pid1, "mode": "chars"})
        check("режим chars", r.status == 200)
        r = await s.post(f"{base}/api/rooms/{code}/chars", json={"pid": pid1, "characters": ["Герой"]})
        r = await s.post(f"{base}/api/rooms/{code}/chars", json={"pid": pid2, "characters": ["Злодей"]})
        r = await s.post(f"{base}/api/rooms/{code}/claim", json={"pid": pid1, "index": 2})
        check("Злодей не доступен Герою", (await r.json())["ok"] is False, await r.text())
        r = await s.post(f"{base}/api/rooms/{code}/claim", json={"pid": pid2, "index": 2})
        check("Злодей доступен Злодею", (await r.json())["ok"])

        # --- эстафета ---
        r = await s.post(f"{base}/api/rooms/{code}/mode", json={"pid": pid1, "mode": "relay"})
        st = (await r.json())["room"]
        check("эстафета: ход у первого", st["relay"]["turn"] == pid1 and st["relay"]["line"] == 0, st["relay"])
        r = await s.post(f"{base}/api/rooms/{code}/pass", json={"pid": pid2})
        check("не-ходовой не передаёт", r.status == 409)
        # тайк строки 0 делает Маша? нет — ход у первого, но тайки кладёт кто угодно; зальём 0 как Антон
        await s.post(f"{base}/api/rooms/{code}/takes/0", data=wav, headers={"X-Pid": pid1})
        r = await s.post(f"{base}/api/rooms/{code}/pass", json={"pid": pid1})
        st = (await s.get(f"{base}/api/rooms/{code}")).json() if False else None
        r = await s.get(f"{base}/api/rooms/{code}")
        st = await r.json()
        check("эстафета: ход перешёл Маше, строка 2", st["relay"]["turn"] == pid2 and st["relay"]["line"] == 2, st["relay"])

        # --- leave ---
        r = await s.post(f"{base}/api/rooms/{code}/leave", json={"pid": pid2})
        check("leave", r.status == 200)
        await ws1.close()
        await ws2.close()

    # --- очистка ---
    server.ROOMS.clear()
    t.cancel()
    try:
        await t
    except (asyncio.CancelledError, Exception):
        pass
    return fails


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
