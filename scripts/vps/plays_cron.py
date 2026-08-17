#!/usr/bin/env python3
"""Обновляет счётчики запусков в manifest.json галереи Dub Choice.

Живёт на том же VPS, что и GoatCounter: база лежит рядом, поэтому не нужны
ни SSH, ни API-токен аналитики. Раз в сутки берёт манифест из R2, проставляет
свежие plays7d/plays30d и кладёт обратно.

Трогает ТОЛЬКО эти два поля. Состав паков, теги, даты и размеры не
пересобираются — за них отвечает scripts/dubpack/build_manifest.py на машине
владельца. Если пак есть в манифесте, но по нему нет статистики, счётчик
станет нулём; лишних паков скрипт не добавляет и существующих не удаляет.

Ключи R2 — /root/.config/dub-choice-r2.env (chmod 600).
Запуск вручную:  python3 /root/bin/plays_cron.py --dry-run
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import urllib.request

GOATCOUNTER = "/opt/goatcounter/goatcounter"
DB = "sqlite:///opt/goatcounter/db/goatcounter.sqlite3"
PUBLIC_BASE = "https://pub-6cdcaa2a325441e59991d44af1e68177.r2.dev/"
BUCKET = "dub-choice-packs"
ENV_FILE = "/root/.config/dub-choice-r2.env"
WINDOWS = (7, 30)
UA = "dub-choice-plays-cron/1.0"


# У systemd и ssh на этом сервере локаль latin-1, и любой кириллический
# лог падал бы с UnicodeEncodeError. Задаём кодировку сами.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass


def log(msg):
    print(msg, flush=True)


def load_env():
    env = {}
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if line and "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k] = v
    missing = {"R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT"} - env.keys()
    if missing:
        sys.exit(f"в {ENV_FILE} нет ключей: {', '.join(sorted(missing))}")
    return env


def plays(days):
    """Запуски озвучки по пакам за последние N дней (событие dub-start)."""
    sql = (
        "select p.path, sum(h.total) from hit_counts h "
        "join paths p on p.path_id = h.path_id "
        "where p.path like 'dub-start/%' "
        f"and h.hour >= datetime('now', '-{days} days') "
        "group by p.path"
    )
    res = subprocess.run(
        ["sudo", "-u", "goatcounter", GOATCOUNTER, "db", "query",
         "-db", DB, "-format", "csv", sql],
        capture_output=True, text=True, timeout=180)
    if res.returncode != 0:
        sys.exit(f"goatcounter db query упал: {res.stderr.strip()[:300]}")

    out = {}
    for line in res.stdout.splitlines():
        line = line.strip()
        if not line.startswith("dub-start/"):
            continue  # заголовок csv и предупреждения goatcounter
        path, _, total = line.rpartition(",")
        slug = path.split("/", 1)[1]
        if slug == "custom":
            continue  # свой ZIP игрока — не пак галереи
        try:
            out[slug] = int(total)
        except ValueError:
            continue
    return out


def fetch_manifest():
    # Свой User-Agent обязателен: на дефолтный "Python-urllib" Cloudflare
    # отвечает 403, хотя curl и браузер тот же файл получают спокойно
    req = urllib.request.Request(PUBLIC_BASE + "manifest.json",
                                 headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def upload(env, body):
    """PUT через curl --aws-sigv4: на VPS нет ни aws-cli, ни boto3."""
    raw = json.dumps(body, ensure_ascii=False, indent=1).encode("utf-8")
    with tempfile.NamedTemporaryFile("wb", suffix=".json", delete=False) as f:
        f.write(raw)
        tmp = f.name
    try:
        # x-amz-content-sha256 считаем сами: curl 7.81 (Ubuntu 22.04) его не
        # шлёт, а R2 без него отвечает 400 InvalidRequest. В curl 8.x это уже
        # исправлено, но полагаться на версию системы не хочется.
        url = f"{env['R2_ENDPOINT'].rstrip('/')}/{BUCKET}/manifest.json"
        res = subprocess.run(
            ["curl", "-sS", "--retry", "3", "--retry-all-errors",
             "-o", "/dev/null", "-w", "%{http_code}",
             "-X", "PUT", "--aws-sigv4", "aws:amz:auto:s3",
             "--user", f"{env['R2_ACCESS_KEY_ID']}:{env['R2_SECRET_ACCESS_KEY']}",
             "-H", "Content-Type: application/json",
             "-H", "Cache-Control: public, max-age=60",
             "-H", "x-amz-content-sha256: " + hashlib.sha256(raw).hexdigest(),
             "--data-binary", f"@{tmp}", url],
            capture_output=True, text=True, timeout=180)
        if res.returncode != 0 or res.stdout.strip() not in ("200", "204"):
            sys.exit(f"заливка не удалась: код {res.stdout.strip()!r} {res.stderr.strip()[:200]}")
        log(f"манифест обновлён ({res.stdout.strip()})")
    finally:
        os.unlink(tmp)


def main():
    dry = "--dry-run" in sys.argv[1:]
    counts = {d: plays(d) for d in WINDOWS}
    for d in WINDOWS:
        log(f"{d}d: {len(counts[d])} паков, {sum(counts[d].values())} запусков")

    manifest = fetch_manifest()
    changed = []
    for entry in manifest:
        pid = entry.get("id")
        for d in WINDOWS:
            key = f"plays{d}d"
            new = int(counts[d].get(pid, 0))
            if entry.get(key) != new:
                changed.append(f"{pid}.{key}: {entry.get(key)} → {new}")
                entry[key] = new

    if not changed:
        log("цифры не изменились — заливать нечего")
        return
    log(f"изменений: {len(changed)}")
    for line in changed[:20]:
        log("  " + line)

    if dry:
        log("--dry-run: манифест не заливается")
        return
    upload(load_env(), manifest)


if __name__ == "__main__":
    main()
