#!/usr/bin/env python3
"""
Уточнение границ реплик по энергии голосового стема.

Тайминги whisper зернистые: сегмент часто начинается там, где кончилась
предыдущая тишина, а не там, где реально началось слово. На стеме vocals
(в нём нет музыки и шумов) обычный энергетический порог даёт границу
существенно точнее.

Граница расширяется только по непрерывному куску речи и никогда не
перепрыгивает паузу: иначе она цепляет посторонний возглас или голос соседней
реплики. Дополнительно сдвиг ограничен расстоянием до соседей.

Использование:
    refine_onsets.py <vocals.wav> <aligned.json> <out.json> [--apply]

Без --apply только показывает таблицу сдвигов, ничего не записывая.
"""

import json
import sys

from vad import FRAME, envelope, threshold, voiced_regions

PAD_HEAD = 0.08
PAD_TAIL = 0.15

# Асимметрия не случайна: whisper систематически начинает сегмент раньше
# реального слова (метка ставится там, где кончилась тишина), поэтому внутрь
# двигаться разрешаем далеко.
SEARCH_IN = 0.60
# Наружу — насколько позволяет расстояние до соседа: впритык к чужой реплике
# двигаться нельзя вовсе (порог поймает чужой голос), а если вокруг секунды
# тишины, то можно и на полсекунды. Половина зазора — безопасная доля:
# встретиться посередине две соседние границы не успеют.
SEARCH_OUT_MAX = 0.60
SEARCH_OUT_SHARE = 0.5




def region_at(regions: list[list[float]], t: float, edge: str) -> list[float] | None:
    """
    Кусок речи, которому принадлежит момент t. Если t попал в тишину — берём
    соседний кусок с нужной стороны, но НЕ перепрыгиваем через паузу к
    следующему: вызывающий код ограничивает сдвиг, и прыжок туда не пролезет.
    """
    for a, b in regions:
        if a <= t <= b:
            return [a, b]
    if edge == "end":
        before = [r for r in regions if r[1] < t]
        return before[-1] if before else None
    after = [r for r in regions if r[0] > t]
    return after[0] if after else None


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    apply = "--apply" in sys.argv
    if len(args) != 3:
        print(__doc__)
        return 1
    vocals_path, aligned_path, out_path = args

    env = envelope(vocals_path)
    step = FRAME
    thr = threshold(env)
    print(f"кадров: {len(env)}, порог {thr:.5f}\n")

    regions = voiced_regions(env, thr)
    print(f"кусков речи: {len(regions)}\n")

    spec = json.load(open(aligned_path, encoding="utf-8"))
    hdr = f"{'#':>3} {'персонаж':<9} {'было':>15} {'стало':>15}   сдвиг"
    print(hdr)
    print("-" * len(hdr))

    clips = spec["clips"]
    total = len(env) * step
    # Соседей берём из исходного списка, чтобы правки не зависели от порядка обхода
    orig = [(c["start"], c["end"]) for c in clips]

    for i, clip in enumerate(clips):
        old_s, old_e = clip["start"], clip["end"]
        # Граница не имеет права заехать на территорию соседней реплики —
        # иначе порог цепляется за голос другого персонажа
        floor_t = orig[i - 1][1] if i else 0.0
        ceil_t = orig[i + 1][0] if i + 1 < len(clips) else total

        voice_s, voice_e = old_s + PAD_HEAD, old_e - PAD_TAIL
        out_s = min(SEARCH_OUT_MAX, max(voice_s - floor_t, 0.0) * SEARCH_OUT_SHARE)
        out_e = min(SEARCH_OUT_MAX, max(ceil_t - voice_e, 0.0) * SEARCH_OUT_SHARE)

        head = region_at(regions, voice_s, "start")
        tail = region_at(regions, voice_e, "end")
        on = None if head is None else min(max(head[0], voice_s - out_s), voice_s + SEARCH_IN)
        off = None if tail is None else max(min(tail[1], voice_e + out_e), voice_e - SEARCH_IN)
        new_s = old_s if on is None else round(on - PAD_HEAD, 3)
        new_e = old_e if off is None else round(off + PAD_TAIL, 3)
        ds, de = new_s - old_s, new_e - old_e
        if clip.get("lock_start") is not None:
            new_s, ds = old_s, 0.0
        if clip.get("lock_end") is not None:
            new_e, de = old_e, 0.0
        mark = "  ←" if abs(ds) > 0.15 or abs(de) > 0.15 else ""
        print(f"{clip['n']:>3} {clip['character']:<9} {old_s:>7.2f}–{old_e:<7.2f} "
              f"{new_s:>7.2f}–{new_e:<7.2f} {ds:+.2f}/{de:+.2f}{mark}")
        if apply:
            clip["start"], clip["end"] = new_s, new_e

    if not apply:
        print("\nпробный прогон, ничего не записано (нужен --apply)")
        return 0

    for prev, cur in zip(clips, clips[1:]):
        if cur["start"] < prev["end"]:
            mid = round((cur["start"] + prev["end"]) / 2, 3)
            prev["end"], cur["start"] = mid, mid

    json.dump(spec, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"\nзаписано: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
