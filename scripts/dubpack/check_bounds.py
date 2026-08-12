#!/usr/bin/env python3
"""
Проверка, что ни одна реплика не обрезана по краю.

Смотрим на стем vocals прямо снаружи каждого клипа: если там речь, значит
границу поставили посреди слова. Соседние реплики впритык дают ложные
срабатывания (конец одной = начало следующей), поэтому флаг засчитывается
только когда до соседа больше NEIGHBOUR_GAP.

Именно эта проверка ловит случаи, где whisper разбил слово на два и
выравнивание взяло только первое (например «Парвати» → «порвать» + «ей»).

Использование:
    check_bounds.py <vocals.wav> <aligned.json>

Код возврата 1, если что-то обрезано, — годится для CI.
"""

import json
import sys

from vad import FRAME, envelope, threshold

PROBE = 0.12           # сколько слушаем снаружи границы, с
NEIGHBOUR_GAP = 0.15   # ближе этого сосед считается стоящим впритык



def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    env = envelope(sys.argv[1])
    thr = threshold(env)

    def loudest(t0: float, t1: float) -> float:
        a, b = max(int(t0 / FRAME), 0), min(int(t1 / FRAME), len(env))
        return float(env[a:b].max()) if b > a else 0.0

    clips = json.load(open(sys.argv[2], encoding="utf-8"))["clips"]
    bad = 0
    for i, c in enumerate(clips):
        prev_end = clips[i - 1]["end"] if i else -1e9
        next_start = clips[i + 1]["start"] if i + 1 < len(clips) else 1e9
        problems = []
        if c["start"] - prev_end > NEIGHBOUR_GAP:
            lvl = loudest(c["start"] - PROBE, c["start"] - 0.01)
            if lvl > thr:
                problems.append(f"речь до начала ({lvl / thr:.1f}× порога)")
        if next_start - c["end"] > NEIGHBOUR_GAP:
            lvl = loudest(c["end"] + 0.01, c["end"] + PROBE)
            if lvl > thr:
                problems.append(f"речь после конца ({lvl / thr:.1f}× порога)")
        if problems:
            bad += 1
            print(f"  {c['n']:>2} {c['character']:<9} {c['start']:>6.2f}–{c['end']:<6.2f} "
                  f"{', '.join(problems)}")

    print(f"обрезанных клипов: {bad} из {len(clips)}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
