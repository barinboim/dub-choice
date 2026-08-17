#!/usr/bin/env python3
"""Забирает с GoatCounter число запусков озвучки по каждому паку.

Считаем событие `dub-start/<slug>` — игрок дошёл до экрана записи. Это
честнее, чем открытие карточки (там больше любопытства, чем намерения),
и не так редко, как `dub-complete` (на малом трафике он шумит).

Статистика вшивается в manifest.json, а не запрашивается из браузера:
API-токен GoatCounter нельзя отдавать клиенту, у stats.barinbo.im нет CORS
для домена игры, да и главная не должна зависеть от живости VPS.

    python3 scripts/dubpack/fetch_plays.py > build/plays.json
    python3 scripts/dubpack/build_manifest.py --plays build/plays.json --upload
"""

import json
import subprocess
import sys

HOST = "root@159.255.34.7"
DB = "sqlite:///opt/goatcounter/db/goatcounter.sqlite3"
WINDOWS = (7, 30)


def query(days):
    sql = (
        "select p.path, sum(h.total) as total from hit_counts h "
        "join paths p on p.path_id = h.path_id "
        "where p.path like 'dub-start/%' "
        f"and h.hour >= datetime('now', '-{days} days') "
        "group by p.path"
    )
    cmd = [
        "ssh", "-o", "ConnectTimeout=15", "-o", "BatchMode=yes", HOST,
        f"sudo -u goatcounter /opt/goatcounter/goatcounter db query "
        f"-db '{DB}' -format csv \"{sql}\"",
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if res.returncode != 0:
        print(res.stderr, file=sys.stderr)
        raise SystemExit(f"не удалось получить статистику за {days} дней")

    out = {}
    for line in res.stdout.splitlines():
        line = line.strip()
        if not line.startswith("dub-start/"):
            continue  # заголовок csv и предупреждения goatcounter
        path, _, total = line.rpartition(",")
        slug = path.split("/", 1)[1]
        if slug == "custom":
            continue  # свой ZIP игрока — не пак галереи
        out[slug] = int(total)
    return out


def main():
    data = {f"{d}d": query(d) for d in WINDOWS}
    json.dump(data, sys.stdout, ensure_ascii=False, indent=1)
    print()
    for window, counts in data.items():
        total = sum(counts.values())
        print(f"{window}: {len(counts)} паков, {total} запусков", file=sys.stderr)


if __name__ == "__main__":
    main()
