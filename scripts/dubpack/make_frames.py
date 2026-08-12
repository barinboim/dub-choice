#!/usr/bin/env python3
"""
Кадры-превью реплик (`NN_<name>.jpg`) для готового или собираемого пака.

Их показывает экран реплики и — главное — экран результатов, где кадр стоит
рядом с баллом и волной. Вытаскивать кадры из видео в браузере дорого
(перемотка + декодирование на каждую реплику), а у Theora-паков кадр после
перемотки ещё и ненадёжен, поэтому режем заранее.

Использование:
    make_frames.py <pack_dir> [--video=ФАЙЛ] [--spec=safezoned.json]
                              [--height=480] [--quality=4] [--at=0.5]

  pack_dir  — папка собранного пака (в ней dub_video.mp4 и NN_*.ini)
  --spec    — файл после safe_zone.py: тогда кадр берётся из середины
              РЕЧИ (content_start/content_end), а не из середины клипа
  --at      — доля интервала, на которой берётся кадр (0.5 — середина)

Скрипт также дописывает `image=` в ini клипа, если его там ещё нет.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

FRAME_HEIGHT = 480
FRAME_QUALITY = 4  # -q:v для mjpeg: 2 — лучшее, 31 — худшее
FRAME_AT = 0.5
VIDEO_NAMES = ("dub_video.mp4", "dub_video.webm", "dub_video.ogv")


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-y", "-v", "error", *args], check=True)


def audio_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        check=True, capture_output=True, text=True,
    )
    return float(out.stdout.strip())


def grab(video: Path, at: float, dest: Path, height: int, quality: int) -> None:
    """Кадр на секунде `at`; -ss до -i — быстрый seek по ключевым кадрам."""
    ffmpeg("-ss", f"{max(at, 0):.3f}", "-i", str(video), "-frames:v", "1",
           "-vf", f"scale=-2:{height}", "-q:v", str(quality), str(dest))


def find_audio(pack_dir: Path, base: str) -> Path | None:
    for ext in (".wav", ".mp3", ".ogg"):
        p = pack_dir / f"{base}{ext}"
        if p.exists():
            return p
    return None


def clip_start(ini_text: str) -> float | None:
    m = re.search(r"dub_timestamps\s*=\s*\[([^\]]*)\]", ini_text)
    if not m or not m.group(1).strip():
        return None
    return float(m.group(1).split(",")[0])


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = {a.split("=", 1)[0]: a.split("=", 1)[1] for a in sys.argv[1:] if "=" in a}
    if len(args) != 1:
        print(__doc__)
        return 1

    pack_dir = Path(args[0])
    height = int(opts.get("--height", FRAME_HEIGHT))
    quality = int(opts.get("--quality", FRAME_QUALITY))
    at_ratio = float(opts.get("--at", FRAME_AT))

    video = Path(opts["--video"]) if "--video" in opts else next(
        (pack_dir / n for n in VIDEO_NAMES if (pack_dir / n).exists()), None
    )
    if not video or not video.exists():
        print(f"не нашёл видео пака в {pack_dir}")
        return 1

    # Границы речи из safe_zone.py: кадр из середины реплики, а не из паузы
    content: dict[str, tuple[float, float]] = {}
    if "--spec" in opts:
        spec = json.load(open(opts["--spec"], encoding="utf-8"))
        for clip in spec["clips"]:
            base = f"{clip['n']:02d}_{clip['name']}"
            content[base] = (
                clip.get("content_start", clip["start"]),
                clip.get("content_end", clip["end"]),
            )

    total = 0
    for ini_path in sorted(pack_dir.glob("[0-9]*.ini")) + sorted(pack_dir.glob("[0-9]*.txt")):
        base = ini_path.stem
        text = ini_path.read_text(encoding="utf-8")
        start = clip_start(text)
        if start is None:
            continue  # не реплика
        if base in content:
            begin, end = content[base]
        else:
            audio = find_audio(pack_dir, base)
            if not audio:
                continue
            begin, end = start, start + audio_duration(audio)

        dest = pack_dir / f"{base}.jpg"
        grab(video, begin + (end - begin) * at_ratio, dest, height, quality)
        if "image=" not in text:
            ini_path.write_text(text.rstrip("\n") + f'\nimage="{dest.name}"\n', encoding="utf-8")
        total += dest.stat().st_size
        print(f"{dest.name}  {begin + (end - begin) * at_ratio:6.2f} с  {dest.stat().st_size / 1024:5.1f} КБ")

    print(f"\nкадры: {total / 1048576:.2f} МБ в {pack_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
