#!/usr/bin/env python3
"""
Сейф-зона: раздвигает границы клипов вокруг уже выверенного голоса, чтобы
у игрока было время среагировать и договорить свой дубль.

Без этого шага build_pack.py режет клип впритык к границам речи (после
align.py + refine_onsets.py), а окно записи в игре равно ровно длине этого
файла (`recorder.start(buf.duration, ...)` в main.ts) — на «А?» длиной
0.3 секунды игрок физически не успевает ничего сказать.

Раздвигаем на PRE_ROLL/POST_ROLL и подтягиваем короткие клипы до
MIN_DURATION. Заходить в реплику соседа — нормально: игрок дублирует
только то, что нужно ему, а движок и так проигрывает перекрывающиеся
записи независимо друг от друга (см. composer.ts) — так же вели себя и
оригинальные дав-паки на плотной речи.

Но мера нужна и здесь: щедрая сейф-зона — только в свободном пространстве.
Как только граница пересекает СОБСТВЕННУЮ речь соседа, вход в неё режется
до NEIGHBOR_BITE — небольшого фиксированного кусочка (по умолчанию 0.2 с,
это примерно «си-» от «сиди»), а не полного PRE_ROLL/POST_ROLL или тем
более добивки до MIN_DURATION. Из-за этого короткие клипы между двумя
тесными соседями могут остаться короче MIN_DURATION — это ожидаемо и
лучше, чем проглотить всю реплику соседа целиком.

Единственная жёсткая граница — СОБСТВЕННОЕ содержимое клипа: раздвигать
можно только наружу от content_start/content_end, никогда не обрезая
свою же речь.

Использование:
    safe_zone.py <aligned.json> <out.json>
        [--pre=0.35] [--post=0.55] [--min-duration=2.2] [--front-share=0.35]
        [--neighbor-bite=0.2] [--duration=СЕК]
"""

import json
import sys

PRE_ROLL_DEFAULT = 0.35
POST_ROLL_DEFAULT = 0.55
MIN_DURATION_DEFAULT = 2.2
# Доля дефицита до MIN_DURATION, уходящая вперёд клипа; остальное — в хвост
# (хвост нужнее: игроки чаще запаздывают, чем опережают оригинал).
FRONT_SHARE_DEFAULT = 0.35
# Максимум, на который можно зайти в СОБСТВЕННУЮ речь соседа — независимо
# от того, откуда взялось желание раздвинуться шире (базовый ROLL или
# добивка до MIN_DURATION).
NEIGHBOR_BITE_DEFAULT = 0.2


def opt(name: str, default: float) -> float:
    for a in sys.argv[1:]:
        if a.startswith(f"--{name}="):
            return float(a.split("=", 1)[1])
    return default


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 2:
        print(__doc__)
        return 1
    in_path, out_path = args
    pre_roll = opt("pre", PRE_ROLL_DEFAULT)
    post_roll = opt("post", POST_ROLL_DEFAULT)
    min_duration = opt("min-duration", MIN_DURATION_DEFAULT)
    front_share = opt("front-share", FRONT_SHARE_DEFAULT)
    neighbor_bite = opt("neighbor-bite", NEIGHBOR_BITE_DEFAULT)
    video_duration = next(
        (float(a.split("=", 1)[1]) for a in sys.argv[1:] if a.startswith("--duration=")),
        None,
    )

    spec = json.load(open(in_path, encoding="utf-8"))
    clips = spec["clips"]
    n = len(clips)

    content_start = [c["start"] for c in clips]
    content_end = [c["end"] for c in clips]

    padded_start = list(content_start)
    padded_end = list(content_end)

    for i, c in enumerate(clips):
        desired_start = content_start[i] - pre_roll
        desired_end = content_end[i] + post_roll
        span = desired_end - desired_start
        if span < min_duration:
            deficit = min_duration - span
            desired_start -= deficit * front_share
            desired_end += deficit * (1 - front_share)

        # Никогда не резать собственную речь.
        desired_start = min(desired_start, content_start[i])
        desired_end = max(desired_end, content_end[i])

        # В реплику соседа заходить можно, но только на небольшой
        # фиксированный кусочек — щедрый ROLL/MIN_DURATION работает лишь
        # в свободном пространстве до начала чужой речи.
        if i > 0 and desired_start < content_end[i - 1]:
            desired_start = max(desired_start, content_end[i - 1] - neighbor_bite)
        if i + 1 < n and desired_end > content_start[i + 1]:
            desired_end = min(desired_end, content_start[i + 1] + neighbor_bite)

        padded_start[i] = max(desired_start, 0.0)
        padded_end[i] = desired_end
        if video_duration is not None:
            padded_end[i] = min(padded_end[i], video_duration)

    hdr = f"{'#':>3} {'персонаж':<11} {'было':>13} {'стало':>13} {'длит':>6}  подсказка"
    print(hdr)
    print("-" * len(hdr))
    short = 0
    for i, c in enumerate(clips):
        new_dur = padded_end[i] - padded_start[i]
        flag = ""
        if new_dur < min_duration - 0.01:
            short += 1
            flag = f"  ← короче цели ({min_duration:.1f}с) — тесные соседи"
        overlaps = []
        if i > 0 and padded_start[i] < content_end[i - 1]:
            overlaps.append(f"заходит в {clips[i - 1]['n']} на {content_end[i - 1] - padded_start[i]:.2f}с")
        if i + 1 < n and padded_end[i] > content_start[i + 1]:
            overlaps.append(f"заходит в {clips[i + 1]['n']} на {padded_end[i] - content_start[i + 1]:.2f}с")
        if overlaps:
            flag += ("  " if flag else "  ") + "; ".join(overlaps)
        print(
            f"{c['n']:>3} {c['character']:<11} "
            f"{content_start[i]:>6.2f}-{content_end[i]:<6.2f} "
            f"{padded_start[i]:>6.2f}-{padded_end[i]:<6.2f} "
            f"{new_dur:>5.2f}с{flag}"
        )
        c["content_start"] = round(content_start[i], 3)
        c["content_end"] = round(content_end[i], 3)
        c["start"] = round(padded_start[i], 3)
        c["end"] = round(padded_end[i], 3)

    print(f"\nклипов короче цели {min_duration:.1f}с (тесные соседи): {short} из {n}")

    json.dump(spec, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"записано: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
