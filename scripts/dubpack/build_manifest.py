#!/usr/bin/env python3
"""Собирает manifest.json галереи и (по флагу) заливает паки в Cloudflare R2.

Галерея сайта читает manifest.json из R2 при каждом заходе, поэтому добавить
пак = залить zip + иконку + переписать манифест. Пересобирать и пушить сайт
не нужно.

    python3 scripts/dubpack/build_manifest.py                 # только манифест
    python3 scripts/dubpack/build_manifest.py --upload        # + заливка в R2
    python3 scripts/dubpack/build_manifest.py --plays out.json  # подмешать статистику

Ключи R2 берутся из ~/.config/dub-choice-r2/credentials.env.
"""

import argparse
import base64
import glob
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from datetime import date as _date

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CREDS = os.path.expanduser("~/.config/dub-choice-r2/credentials.env")
PUBLIC_BASE = "https://pub-6cdcaa2a325441e59991d44af1e68177.r2.dev/"

# Ручные теги — то, что из файлов пака не вывести: жанр, франшиза, возрастной
# ценз. Теги «короткий ролик» и «монолог» добавляются автоматически, см.
# derive_tags(); «русская озвучка» тоже — но только если пак объявил lang="ru"
# или несёт дорожку _voices_ru. У старых фанатских паков (hpowl, slonik)
# поля lang в _pack_info.ini нет вовсе, поэтому им тег проставлен руками.
# icon — имя файла в public/pack-icons, если оно не совпадает с id пака.
PACKS = [
    # id, заголовок, путь к zip (glob для склеек), ручные теги, дата, иконка
    ("dayalyublyutebya", "Да я люблю тебя!", "public/packs/da_ya_lyublyu_tebya.zip*", ["мем"], "2026-08-15", "da_ya_lyublyu_tebya"),
    ("hpowl", "Гарри Поттер — Я вам не сова!", "public/packs/hpowl.zip*", ["фильм", "гарри поттер", "мем", "русская озвучка"], "2026-08-12", None),
    ("shrekride", "Шрек — Мы уже приехали?", "public/packs/shrekride.zip*", ["мультфильм", "шрек"], "2026-08-14", None),
    ("dontlookup", "Don't Look Up — The President is Lying", "public/packs/dontlookup.zip*", ["фильм"], "2026-08-14", None),
    ("landa", "Inglorious Basterds — Hans Landa", "public/packs/landa.zip*", ["фильм"], "2026-08-14", None),
    ("gofman", "Игорь Гофман — Репортаж из квартиры на Пейсах", "public/packs/gofman.zip*", ["мем", "18+"], "2026-08-14", None),
    ("slonik", "Зелёный слоник — Сколько истребителей?", "public/packs/slonik.zip*", ["мем", "18+", "русская озвучка"], "2026-08-12", None),
    ("theroom", "The Room — Oh Hi Mark", "public/packs/theroom.zip*", ["фильм", "мем"], "2026-08-12", None),
    ("forrestgump", "Forrest Gump — Run Forrest Run", "public/packs/forrestgump.zip*", ["фильм"], "2026-08-14", None),
    ("starwars", "Star Wars — You Turned Her Against Me", "public/packs/starwars.zip*", ["фильм"], "2026-08-11", None),
    ("chosenone", "Star Wars — You Were the Chosen One", "public/packs/chosenone.zip*", ["фильм"], "2026-08-13", None),
    ("lotr", "LOTR — Bridge of Khazad-dûm", "public/packs/lotr.zip*", ["фильм"], "2026-08-11", None),
    ("breakingbad", "Breaking Bad — I Am the Danger", "public/packs/breakingbad.zip*", ["фильм"], "2026-08-11", None),
    ("shrek", "Shrek the Third — Pinocchio Tries to Lie", "public/packs/shrek.zip*", ["мультфильм", "шрек"], "2026-08-11", None),
    ("harrypotter", "Harry Potter — The Duel", "public/packs/harrypotter.zip*", ["фильм", "гарри поттер"], "2026-08-11", None),
    ("reklamaskaipa", "Реклама Скайпа", "studio/projects/reklama_skai_pa/reklama_skai_pa.zip", ["мем"], "2026-08-17", None),
    ("shkyadozhdik", "ШКЯ — Дождик", "studio/projects/shkya_dozhdik/shkya_dozhdik.zip", ["мем"], "2026-08-17", None),
    ("shrekfiona", "Shrek — Fiona and Bird", "studio/projects/shrek_fiona_and_bird/shrek_fiona_and_bird.zip", ["мультфильм", "шрек"], "2026-08-17", None),
    ("krovibeton", "Кровь и бетон — Ублюдок, мать твою", "studio/projects/krov_i_beton_ublyudok_mat_tvoyu/krov_i_beton_ublyudok_mat_tvoyu.zip", ["фильм", "мем", "18+"], "2026-08-17", None),
    ("rytphp2", "RYTP — Гарри Повар и Тайная Комната, часть 1", "public/packs/rytphp2.zip", ["мем", "18+", "гарри поттер"], "2026-08-22", None),
    ("jjjameson", "Джей Джона Джеймсон на русском + оригинальный смех XD", "public/packs/jjjameson.zip", ["фильм", "русская озвучка"], "2026-08-22", None),
    ("krastykrabpatrick", "Это красти краб Нет это патрик!", "public/packs/krastykrabpatrick.zip", ["мультфильм", "русская озвучка"], "2026-08-22", None),
    ("itprikol", "Оно. Прикол", "public/packs/itprikol.zip", ["фильм", "мем", "18+"], "2026-08-22", None),
    ("zolotayachasha", "Золотая Чаша", "public/packs/zolotayachasha.zip", ["мем", "реклама"], "2026-08-22", None),
    ("bluelock", "Blue Lock (rus sub)", "public/packs/bluelock.zip", ["аниме"], "2026-08-22", None),
    ("klinokgyutaro", "Клинок Гютаро", "public/packs/klinokgyutaro.zip", ["аниме", "русская озвучка"], "2026-08-22", None),
    ("prideprejudice", "Pride & Prejudice (beginning)", "public/packs/prideprejudice.zip", ["фильм", "русская озвучка"], "2026-08-22", None),
]

SHORT_MAX_SEC = 60  # граница тега «короткий ролик»


def local_zip(pattern):
    """Локальный zip пака: цельный файл или склейка .zip.aa/.ab/... по порядку."""
    parts = sorted(glob.glob(os.path.join(ROOT, pattern))) if pattern else []
    if not parts:
        return None
    return b"".join(open(p, "rb").read() for p in parts)


def published_manifest():
    """Текущий манифест из R2 — данные по уже залитым пакам.

    Всё, что скрипт достаёт из архива (реплики, персонажи, длительность),
    для опубликованного пака уже посчитано и лежит здесь. Качать ради этого
    сотни мегабайт незачем: заново читаем только те паки, чей zip есть
    локально, то есть новые и пересобранные.
    """
    url = f"{PUBLIC_BASE}manifest.json"
    # Свой User-Agent обязателен: на дефолтный "Python-urllib" Cloudflare
    # отвечает 403, хотя curl и браузер тот же файл получают спокойно
    req = urllib.request.Request(url, headers={"User-Agent": "dub-choice-build/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return {e["id"]: e for e in json.load(r)}
    except Exception as e:
        print(f"манифест из R2 недоступен ({e}) — пересчитываю только локальные паки")
        return {}


def parse_ini(text):
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("[") or line.startswith(";"):
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def unquote(v):
    v = (v or "").strip()
    return v[1:-1] if v.startswith('"') and v.endswith('"') else v


def clip_duration(z, audio_name, repeats):
    """Длина реплики через ffprobe; таймстампов может быть несколько."""
    suffix = os.path.splitext(audio_name)[1]
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tf:
        tf.write(z.read(audio_name))
        tmp = tf.name
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "csv=p=0", tmp],
            capture_output=True, text=True, timeout=30).stdout.strip()
        return float(out) * repeats
    except Exception:
        return 0.0
    finally:
        os.unlink(tmp)


def probe(z):
    """Достаёт из пака всё, что нужно галерее, не скачивая его игроку."""
    names = z.namelist()
    clips = 0
    chars = []
    langs = set()
    duration = 0.0
    pack_lang = ""
    icon_name = ""
    built = ""

    for n in names:
        base = os.path.basename(n)
        if base == "_pack_info.ini":
            d = parse_ini(z.read(n).decode("utf-8", "ignore"))
            pack_lang = unquote(d.get("lang", ""))
            icon_name = unquote(d.get("icon", ""))
            built = unquote(d.get("built", ""))
            continue
        if base.startswith("_") or not (n.lower().endswith(".ini") or n.lower().endswith(".txt")):
            continue
        d = parse_ini(z.read(n).decode("utf-8", "ignore"))
        if "dub_timestamps" not in d:
            continue  # не реплика
        repeats = max(len(re.findall(r"[\d.]+", d["dub_timestamps"])), 1)
        clips += repeats
        for c in re.findall(r'"([^"]+)"', d.get("dub_characters", "")):
            if c not in chars:
                chars.append(c)
        for k in d:
            m = re.match(r"^caption_(\w+)$", k)
            if m:
                langs.add(m.group(1))
        stem = n.rsplit(".", 1)[0]
        for ext in (".wav", ".mp3", ".ogg"):
            if stem + ext in names:
                duration += clip_duration(z, stem + ext, repeats)
                break

    return {
        "clips": clips,
        "characters": chars,
        "durationSec": round(duration, 1),
        "translations": sorted(langs),
        "lang": pack_lang,
        "iconName": icon_name,
        "built": built,
        # Русский голос: пак либо изначально русский, либо несёт дорожку дубляжа
        "hasRuVoice": pack_lang == "ru" or any("_voices_ru" in n for n in names),
    }


def derive_tags(manual, info):
    """Теги, которые честнее вычислить, чем проставлять руками."""
    tags = list(manual)
    if info["hasRuVoice"] and "русская озвучка" not in tags:
        tags.append("русская озвучка")
    if 0 < info["durationSec"] <= SHORT_MAX_SEC:
        tags.append("короткий ролик")
    if len(info["characters"]) == 1 and "монолог" not in tags:
        tags.append("монолог")
    return tags


def extract_icon(z, info, pack_id, out_dir, icon_stem=None):
    """Иконка: сначала выверенная из public/pack-icons, иначе — из самого пака."""
    for ext in (".png", ".jpg", ".webp"):
        curated = os.path.join(ROOT, "public/pack-icons", (icon_stem or pack_id) + ext)
        if os.path.exists(curated):
            dst = os.path.join(out_dir, pack_id + ext)
            open(dst, "wb").write(open(curated, "rb").read())
            return os.path.basename(dst), True
    name = info["iconName"]
    match = next((n for n in z.namelist() if os.path.basename(n) == name), None)
    if not match:
        # Пак объявил иконку, которой в архиве нет (или не объявил вовсе) —
        # берём первый кадр реплики: это тот же кадр из сцены, что и обложка
        frames = sorted(
            n for n in z.namelist()
            if not os.path.basename(n).startswith("_")
            and n.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))
        )
        if not frames:
            return "", False
        match = frames[0]
    ext = os.path.splitext(match)[1] or ".png"
    dst = os.path.join(out_dir, pack_id + ext)
    open(dst, "wb").write(z.read(match))
    return os.path.basename(dst), False


def load_env(path):
    env = {}
    if not os.path.exists(path):
        return env
    for line in open(path):
        line = line.strip()
        if line and "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            env[k] = v
    return env


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--upload", action="store_true", help="залить паки, иконки и манифест в R2")
    ap.add_argument("--plays", help="json {pack_id: число} со статистикой GoatCounter")
    ap.add_argument("--out", default="build/manifest", help="куда сложить манифест и иконки")
    args = ap.parse_args()

    out_dir = os.path.join(ROOT, args.out)
    icons_dir = os.path.join(out_dir, "icons")
    os.makedirs(icons_dir, exist_ok=True)

    plays = json.load(open(args.plays, encoding="utf-8")) if args.plays else {}

    published = published_manifest()
    manifest = []
    uploads = []  # (локальный путь, ключ в бакете, content-type)

    for pack_id, title, pattern, manual_tags, added, icon_stem in PACKS:
        data = local_zip(pattern)

        if data is None:
            # Пак уже опубликован, архива под рукой нет — берём посчитанное
            # раньше. Заливать тоже нечего: в бакете лежит ровно этот файл.
            prev = published.get(pack_id)
            if prev is None:
                raise SystemExit(
                    f"{pack_id}: нет ни локального zip ({pattern}), ни записи в манифесте R2")
            entry = dict(prev)
            entry["title"] = title
            # Теги пересобираем: ручные могли поменяться в конфиге, а
            # выводимые считаются из полей, которые манифест уже несёт
            entry["tags"] = derive_tags(manual_tags, {
                "hasRuVoice": "русская озвучка" in (prev.get("tags") or []),
                "durationSec": prev.get("durationSec", 0),
                "characters": prev.get("characters", []),
            })
            mark = "="
        else:
            z = zipfile.ZipFile(io.BytesIO(data))
            info = probe(z)
            icon_file, curated = extract_icon(z, info, pack_id, icons_dir, icon_stem)
            entry = {
                "id": pack_id,
                "title": title,
                "path": f"packs/{pack_id}.zip",
                "icon": f"icons/{icon_file}",
                "sizeBytes": len(data),
                "clips": info["clips"],
                "characters": info["characters"],
                "durationSec": info["durationSec"],
                "translations": info["translations"],
                "tags": derive_tags(manual_tags, info),
                # Дату пак несёт сам (built= в _pack_info.ini, пишет
                # build_pack.py). В конфиге она указана только у паков,
                # собранных до появления поля: их даты — из git-истории.
                "addedAt": added or info["built"] or _date.today().isoformat(),
            }
            zip_path = os.path.join(out_dir, f"{pack_id}.zip")
            open(zip_path, "wb").write(data)
            uploads.append((zip_path, f"packs/{pack_id}.zip", "application/zip"))
            ctype = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}.get(
                icon_file.rsplit(".", 1)[-1], "image/png")
            uploads.append((os.path.join(icons_dir, icon_file), f"icons/{icon_file}", ctype))
            mark = "✓" if curated else "~"

        # Полка «Популярные озвучки» живёт на недельном окне, сортировка
        # «Популярные» — на месячном: за сутки у редких паков одни нули
        entry["plays7d"] = int(plays.get("7d", {}).get(pack_id, 0))
        entry["plays30d"] = int(plays.get("30d", {}).get(pack_id, 0))
        manifest.append(entry)

        print(f"{pack_id:18} {entry['clips']:3} реплик  {entry['durationSec']:6.1f}с  "
              f"{len(entry['characters'])} перс.  {mark}  {', '.join(entry['tags'])}")

    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    print(f"\nманифест: {manifest_path} ({len(manifest)} паков)")

    if not args.upload:
        print("заливка не запрошена (--upload)")
        return

    env = load_env(CREDS)
    if not env.get("AWS_ACCESS_KEY_ID"):
        raise SystemExit(f"нет ключей R2 в {CREDS}")
    bucket, endpoint = env["R2_BUCKET"], env["R2_ENDPOINT"]
    aws_env = {**os.environ, **env}

    for local, key, ctype in uploads:
        subprocess.run(
            ["aws", "s3", "cp", local, f"s3://{bucket}/{key}",
             "--endpoint-url", endpoint, "--content-type", ctype, "--only-show-errors"],
            env=aws_env, check=True)
        print(f"↑ {key}")

    # Манифест — последним: пока он не обновлён, сайт не знает о новых паках
    subprocess.run(
        ["aws", "s3", "cp", manifest_path, f"s3://{bucket}/manifest.json",
         "--endpoint-url", endpoint, "--content-type", "application/json",
         "--cache-control", "public, max-age=60", "--only-show-errors"],
        env=aws_env, check=True)
    print("↑ manifest.json — галерея обновлена")


if __name__ == "__main__":
    main()
