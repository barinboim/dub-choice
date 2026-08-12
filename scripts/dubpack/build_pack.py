#!/usr/bin/env python3
"""
Сборка готового dub-пака из выровненного описания клипов.

Использование:
    build_pack.py <aligned.json> <original.wav> <backing.wav> <source_video> <outdir>
                  [--icon-at=СЕК]  кадр для иконки (по умолчанию 45)
                  [--no-frames]    не резать кадры-превью реплик

На выходе, рядом с уже лежащим там dub_video.mp4:
    _pack_info.ini, _backing_track.mp3, icon.png,
    NN_<name>.mp3 + NN_<name>.ini + NN_<name>.jpg на каждый клип
"""

import json
import subprocess
import sys
from pathlib import Path

from make_frames import FRAME_AT, FRAME_HEIGHT, FRAME_QUALITY, grab

CLIP_BITRATE = "128k"
BACKING_BITRATE = "192k"
ICON_SIZE = 512


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-y", "-v", "error", *args], check=True)


def ini_str(value: str) -> str:
    """Строка в стиле Godot ConfigFile."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def ini_list(values: list[str]) -> str:
    return "[" + ", ".join(ini_str(v) for v in values) + "]"


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    icon_at = next(
        (float(a.split("=", 1)[1]) for a in sys.argv[1:] if a.startswith("--icon-at=")), 45.0
    )
    if len(args) != 5:
        print(__doc__)
        return 1
    aligned_path, orig_wav, backing_wav, video, outdir_s = args
    outdir = Path(outdir_s)
    outdir.mkdir(parents=True, exist_ok=True)

    spec = json.load(open(aligned_path, encoding="utf-8"))

    # Иконка: квадратный кроп по центру кадра
    ffmpeg("-ss", str(icon_at), "-i", video, "-frames:v", "1",
           "-vf", f"crop=ih:ih,scale={ICON_SIZE}:{ICON_SIZE}", str(outdir / "icon.png"))

    # "-" — собрать пак без фоновой дорожки (промежуточная проверка формата:
    # движок такие паки грузит, просто в финале будет тишина между репликами)
    if backing_wav == "-":
        print("бэкинг пропущен")
    else:
        ffmpeg("-i", backing_wav, "-c:a", "libmp3lame", "-b:a", BACKING_BITRATE,
               str(outdir / "_backing_track.mp3"))

    (outdir / "_pack_info.ini").write_text(
        "[data]\n\n"
        f"title={ini_str(spec['title'])}\n"
        f"subtitle={ini_str(spec.get('subtitle', ''))}\n"
        'icon="icon.png"\n'
        f"authors={ini_list(spec.get('authors', []))}\n",
        encoding="utf-8",
    )

    frames = "--no-frames" not in sys.argv[1:]

    for clip in spec["clips"]:
        base = f"{clip['n']:02d}_{clip['name']}"
        start, end = clip["start"], clip["end"]
        ffmpeg("-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-i", orig_wav,
               "-c:a", "libmp3lame", "-b:a", CLIP_BITRATE, str(outdir / f"{base}.mp3"))

        # Кадр-превью: из середины РЕЧИ, а не клипа — по краям сейф-зона,
        # там персонаж может быть ещё не в кадре
        image_line = ""
        if frames:
            speech_start = clip.get("content_start", start)
            speech_end = clip.get("content_end", end)
            grab(Path(video), speech_start + (speech_end - speech_start) * FRAME_AT,
                 outdir / f"{base}.jpg", FRAME_HEIGHT, FRAME_QUALITY)
            image_line = f'image="{base}.jpg"\n'

        (outdir / f"{base}.ini").write_text(
            "[data]\n\n"
            f"caption={ini_str(clip['text'])}\n"
            f"dub_timestamps=[{start:.3f}]\n"
            f"dub_characters={ini_list([clip['character']])}\n"
            f"{image_line}",
            encoding="utf-8",
        )
        print(f"{base}.mp3  {start:6.2f}–{end:6.2f}  ({end - start:.2f} с)  {clip['text'][:48]}")

    total = sum(f.stat().st_size for f in outdir.iterdir() if f.is_file())
    print(f"\n{len(spec['clips'])} клипов, пак целиком: {total / 1048576:.1f} МБ → {outdir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
