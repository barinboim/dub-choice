#!/usr/bin/env python3
"""
Сейф-зона: раздвигает границы клипов вокруг уже выверенного голоса, чтобы
у игрока было время среагировать и договорить свой дубль.

Без этого шага build_pack.py режет клип впритык к границам речи (после
align.py + refine_onsets.py), а окно записи в игре равно ровно длине этого
файла (`recorder.start(buf.duration, ...)` в main.ts) — на «А?» длиной
0.3 секунды игрок физически не успевает ничего сказать.

Раздвигаем на PRE_ROLL/POST_ROLL и подтягиваем короткие клипы до
MIN_DURATION, но никогда не залезаем в СОБСТВЕННУЮ речь соседа — граница
не может пересечь content_start/content_end соседнего клипа. Если после
этого соседние сейф-зоны всё равно пересеклись (мало места в паузе),
делим спорный зазор пополам — как в align.py.

Использование:
    safe_zone.py <aligned.json> <out.json>
        [--pre=0.35] [--post=0.55] [--min-duration=2.2] [--front-share=0.35]
        [--duration=СЕК]  общая длина видео — не вылезать за неё
"""

import json
import sys

PRE_ROLL_DEFAULT = 0.35
POST_ROLL_DEFAULT = 0.55
MIN_DURATION_DEFAULT = 2.2
# Доля дефицита до MIN_DURATION, уходящая вперёд клипа; остальное — в хвост
# (хвост нужнее: игроки чаще запаздывают, чем опережают оригинал).
FRONT_SHARE_DEFAULT = 0.35


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
        left_limit = content_end[i - 1] if i > 0 else float("-inf")
        right_limit = content_start[i + 1] if i + 1 < n else float("inf")

        desired_start = content_start[i] - pre_roll
        desired_end = content_end[i] + post_roll
        span = desired_end - desired_start
        if span < min_duration:
            deficit = min_duration - span
            desired_start -= deficit * front_share
            desired_end += deficit * (1 - front_share)

        padded_start[i] = max(desired_start, left_limit, 0.0)
        padded_end[i] = min(desired_end, right_limit)
        if video_duration is not None:
            padded_end[i] = min(padded_end[i], video_duration)

    # Соседние сейф-зоны всё ещё могут пересечься (пауза короче pre+post) —
    # делим спорный зазор пополам, как в align.py.
    for i in range(n - 1):
        if padded_end[i] > padded_start[i + 1]:
            mid = (padded_end[i] + padded_start[i + 1]) / 2
            mid = max(content_end[i], min(mid, content_start[i + 1]))
            padded_end[i], padded_start[i + 1] = mid, mid

    hdr = f"{'#':>3} {'персонаж':<11} {'было':>13} {'стало':>13} {'длит':>6}  подсказка"
    print(hdr)
    print("-" * len(hdr))
    short = 0
    for i, c in enumerate(clips):
        old_dur = content_end[i] - content_start[i]
        new_dur = padded_end[i] - padded_start[i]
        flag = ""
        if new_dur < min_duration - 0.01:
            short += 1
            flag = f"  ← короче цели ({min_duration:.1f}с), мало места у соседа"
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

    print(f"\nклипов короче цели {min_duration:.1f}с из-за тесных соседей: {short} из {n}")

    json.dump(spec, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"записано: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
