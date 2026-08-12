#!/usr/bin/env python3
"""
Выравнивание авторского текста реплик по word-level таймингам whisper.

Текст берём из clips.json (там правильные роли и пунктуация), whisper даёт
только время. Выравнивание глобальное: склеиваем все слова всех клипов в одну
последовательность и сопоставляем её с последовательностью слов whisper через
difflib. Это устойчивее, чем искать каждый клип по отдельности, — whisper
может ослышаться в одном слове, но общая канва совпадёт.

Использование:
    align.py <whisper.json> <clips.json> <out.json> [--duration СЕК]
"""

import json
import re
import sys
from difflib import SequenceMatcher

# Отступы вокруг реплики, чтобы не срезать атаку первого слова и хвост последнего.
PAD_HEAD = 0.08
PAD_TAIL = 0.15
# Насколько границе от whisper позволено уйти за окно SRT, прежде чем мы
# признаем её артефактом и вернёмся к таймингу из субтитров.
HINT_SLACK = 0.50
# Паузы короче этой склеиваются в один речевой интервал (для гибридного бэкинга).
SPEECH_GAP = 0.30
SPEECH_PAD = 0.10


def norm(word: str) -> str:
    """Нормализация для сравнения: регистр, ё, пунктуация — всё долой."""
    return re.sub(r"[^0-9a-zа-я]", "", word.lower().replace("ё", "е"))


def load_whisper_words(path: str) -> list[dict]:
    """Слова с таймингами из JSON whisper.cpp (-oj -ml 1 -sow)."""
    data = json.load(open(path, encoding="utf-8"))
    words = []
    for seg in data["transcription"]:
        text = seg["text"].strip()
        n = norm(text)
        if not n:
            continue  # пунктуация отдельным сегментом, [_BEG_] и прочий служебный шум
        words.append(
            {
                "raw": text,
                "n": n,
                "start": seg["offsets"]["from"] / 1000.0,
                "end": seg["offsets"]["to"] / 1000.0,
            }
        )
    return repair_zero_width(words)


def repair_zero_width(words: list[dict]) -> list[dict]:
    """
    whisper.cpp вешает все слова начала сегмента на одну и ту же метку: у них
    start == end, а реальная длительность всего блока «спрятана» в последнем
    слове. Раздаём этот интервал словам пропорционально длине в символах —
    иначе границы клипов, попавших на такое слово, уезжают на секунду.
    """
    fixed = 0
    i = 0
    while i < len(words):
        if words[i]["start"] < words[i]["end"]:
            i += 1
            continue
        j = i
        while j < len(words) and words[j]["start"] == words[i]["start"] == words[j]["end"]:
            j += 1
        # j — первое слово с ненулевой длиной; оно и задаёт правую границу блока
        run = words[i : j + 1] if j < len(words) and words[j]["start"] == words[i]["start"] else words[i:j]
        if not run:
            i += 1
            continue
        t0 = run[0]["start"]
        t1 = run[-1]["end"] if run[-1]["end"] > t0 else (words[j]["start"] if j < len(words) else t0)
        weights = [max(len(w["n"]), 1) for w in run]
        total = sum(weights)
        cursor = t0
        for w, weight in zip(run, weights):
            w["start"] = cursor
            cursor += (t1 - t0) * weight / total
            w["end"] = cursor
            fixed += 1
        i += len(run)
    if fixed:
        print(f"починено слов с нулевой длительностью: {fixed}")
    return words


def build_expected(clips: list[dict]) -> tuple[list[str], list[tuple[int, int]]]:
    """Плоский список нормализованных слов + границы [начало, конец) каждого клипа."""
    flat: list[str] = []
    spans: list[tuple[int, int]] = []
    for clip in clips:
        start = len(flat)
        flat.extend(w for w in (norm(t) for t in clip["text"].split()) if w)
        spans.append((start, len(flat)))
    return flat, spans


def map_indices(expected: list[str], actual: list[dict]) -> dict[int, int]:
    """expected[i] → индекс в actual. Только надёжные соответствия."""
    matcher = SequenceMatcher(a=expected, b=[w["n"] for w in actual], autojunk=False)
    mapping: dict[int, int] = {}
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                mapping[i1 + k] = j1 + k
        elif tag == "replace" and (i2 - i1) == (j2 - j1):
            # Одинаковой длины — почти наверняка whisper ослышался в тех же словах
            for k in range(i2 - i1):
                mapping[i1 + k] = j1 + k
    return mapping


def interpolate(idx: int, mapping: dict[int, int], n_expected: int, n_actual: int) -> float:
    """Дробный индекс в actual для слова, которое не сматчилось напрямую."""
    before = max((i for i in mapping if i < idx), default=None)
    after = min((i for i in mapping if i > idx), default=None)
    if before is None and after is None:
        return idx * (n_actual - 1) / max(n_expected - 1, 1)
    if before is None:
        return max(mapping[after] - (after - idx), 0)
    if after is None:
        return min(mapping[before] + (idx - before), n_actual - 1)
    span_e, span_a = after - before, mapping[after] - mapping[before]
    return mapping[before] + (idx - before) * span_a / span_e


def time_at(pos: float, actual: list[dict], edge: str) -> float:
    """Время начала/конца слова по (возможно дробному) индексу."""
    lo = max(0, min(int(pos), len(actual) - 1))
    return actual[lo]["start"] if edge == "start" else actual[lo]["end"]


def speech_intervals(actual: list[dict]) -> list[list[float]]:
    """Слитые речевые интервалы — по ним гибридный бэкинг решает, где брать стем."""
    merged: list[list[float]] = []
    for w in actual:
        a, b = w["start"] - SPEECH_PAD, w["end"] + SPEECH_PAD
        if merged and a - merged[-1][1] < SPEECH_GAP:
            merged[-1][1] = b
        else:
            merged.append([max(a, 0.0), b])
    return merged


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    duration = next(
        (float(a.split("=", 1)[1]) for a in sys.argv[1:] if a.startswith("--duration=")),
        None,
    )
    if len(args) != 3:
        print(__doc__)
        return 1
    whisper_path, clips_path, out_path = args

    actual = load_whisper_words(whisper_path)
    spec = json.load(open(clips_path, encoding="utf-8"))
    clips = spec["clips"]
    expected, spans = build_expected(clips)
    mapping = map_indices(expected, actual)

    print(f"слов в whisper: {len(actual)}, слов в тексте: {len(expected)}, "
          f"сматчилось напрямую: {len(mapping)} ({100 * len(mapping) // max(len(expected), 1)}%)\n")

    out = []
    for clip, (i1, i2) in zip(clips, spans):
        exact = sum(1 for i in range(i1, i2) if i in mapping)
        first = mapping.get(i1, interpolate(i1, mapping, len(expected), len(actual)))
        last = mapping.get(i2 - 1, interpolate(i2 - 1, mapping, len(expected), len(actual)))
        start = time_at(first, actual, "start") - PAD_HEAD
        end = time_at(last, actual, "end") + PAD_TAIL

        # Подсказка из SRT — страховка от артефактов whisper (классика: первое
        # слово ролика получает start=0.00, потому что перед ним тишина).
        hint = clip.get("hint")
        note = ""
        if hint:
            if start < hint[0] - HINT_SLACK:
                start, note = hint[0] - 0.10, "нач.по SRT"
            if end > hint[1] + HINT_SLACK:
                end, note = hint[1], (note + " кон.по SRT").strip()

        # Границы, названные владельцем после прослушивания, — сильнее любых
        # эвристик: их не трогает ни выравнивание, ни уточнение по энергии.
        if clip.get("lock_start") is not None:
            start, note = clip["lock_start"], "задано вручную"
        if clip.get("lock_end") is not None:
            end, note = clip["lock_end"], "задано вручную"

        rec = dict(clip)
        rec["note"] = note
        rec.update(
            start=round(max(start, 0.0), 3),
            end=round(end if duration is None else min(end, duration), 3),
            words=i2 - i1,
            exact=exact,
        )
        out.append(rec)

    # Клипы не должны наезжать друг на друга: делим спорный зазор пополам
    for prev, cur in zip(out, out[1:]):
        if cur["start"] < prev["end"]:
            mid = (cur["start"] + prev["end"]) / 2
            prev["end"], cur["start"] = round(mid, 3), round(mid, 3)

    hdr = f"{'#':>3} {'персонаж':<9} {'начало':>7} {'конец':>7} {'длит':>6} {'совп':>7}  подсказка SRT"
    print(hdr)
    print("-" * len(hdr))
    for r in out:
        dur = r["end"] - r["start"]
        flag = "" if r["exact"] == r["words"] else "  ← сверить"
        note = f"  [{r['note']}]" if r.get("note") else ""
        print(f"{r['n']:>3} {r['character']:<9} {r['start']:>7.2f} {r['end']:>7.2f} "
              f"{dur:>6.2f} {r['exact']:>3}/{r['words']:<3}{note}{flag}")

    json.dump(
        {
            "title": spec["title"],
            "subtitle": spec.get("subtitle", ""),
            "authors": spec.get("authors", []),
            "clips": out,
            "speech": [[round(a, 3), round(b, 3)] for a, b in speech_intervals(actual)],
        },
        open(out_path, "w", encoding="utf-8"),
        ensure_ascii=False,
        indent=2,
    )
    print(f"\nзаписано: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
