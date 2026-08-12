#!/usr/bin/env python3
"""
Гибридный бэкинг-трек: вне речи — оригинальная дорожка, внутри речевых
интервалов — стем no_vocals от Demucs, стык кроссфейдом.

Смысл: Demucs неизбежно съедает немного верхов и стереоширины, но платить эту
цену есть смысл только там, где реально надо убрать голос. Музыка и эмбиенс
между репликами остаются нетронутыми.

Оба входа должны быть WAV 16 бит с одинаковой частотой и числом каналов
(приводится заранее через ffmpeg).

Где именно «внутри речи» — решает VAD по стему `vocals`, а НЕ слова whisper.
Разница принципиальная: whisper не транскрибирует вздохи и мычание, и если
опираться на его слова, такой голос останется в фоне. Речевые интервалы из
`aligned.json` подмешиваем сверху как страховку.

Использование:
    build_backing.py <original.wav> <no_vocals.wav> <vocals.wav> <aligned.json> <out.wav>
                     [--pure]   собрать чистый no_vocals, без гибрида (для A/B)
"""

import json
import sys
import wave

import numpy as np

from vad import voiced_regions, envelope, threshold

CROSSFADE = 0.150  # с
SPEECH_PAD = 0.10  # запас вокруг найденной речи, с
SPEECH_GAP = 0.30  # паузы короче — не выныриваем в оригинал ради полусекунды


def read_wav(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise SystemExit(f"{path}: ожидается 16 бит, а там {w.getsampwidth() * 8}")
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
        return data.reshape(-1, w.getnchannels()).astype(np.float32) / 32768.0, w.getframerate()


def write_wav(path: str, data: np.ndarray, rate: int) -> None:
    clipped = np.clip(data, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(data.shape[1])
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    pure = "--pure" in sys.argv
    if len(args) != 5:
        print(__doc__)
        return 1
    orig_path, stem_path, vocals_path, aligned_path, out_path = args

    orig, rate = read_wav(orig_path)
    stem, rate2 = read_wav(stem_path)
    if rate != rate2:
        raise SystemExit(f"частоты не совпадают: {rate} и {rate2}")

    # Demucs может вернуть дорожку на пару сэмплов длиннее/короче — ровняем
    n = min(len(orig), len(stem))
    orig, stem = orig[:n], stem[:n]

    if pure:
        write_wav(out_path, stem, rate)
        print(f"чистый no_vocals → {out_path} ({n / rate:.2f} с)")
        return 0

    # Речь ищем в самом стеме голоса — так находятся и вздохи с мычанием,
    # которых нет ни в субтитрах, ни в выводе whisper.
    env = envelope(vocals_path)
    found = voiced_regions(env, threshold(env))
    from_whisper = json.load(open(aligned_path, encoding="utf-8"))["speech"]

    merged: list[list[float]] = []
    for a, b in sorted([[x - SPEECH_PAD, y + SPEECH_PAD] for x, y in found] +
                       [list(s) for s in from_whisper]):
        if merged and a - merged[-1][1] < SPEECH_GAP:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([max(a, 0.0), b])
    speech = merged
    print(f"речь по стему: {len(found)} кусков, из whisper: {len(from_whisper)}, "
          f"после объединения: {len(speech)}")

    # mask=1 → берём стем (речь), mask=0 → оригинал
    mask = np.zeros(n, dtype=np.float32)
    fade = max(int(CROSSFADE * rate), 1)
    ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)

    for start, end in speech:
        a, b = int(start * rate), int(end * rate)
        a, b = max(a, 0), min(b, n)
        if b <= a:
            continue
        mask[a:b] = 1.0
        # Кроссфейды по краям — иначе на стыке слышен щелчок смены тембра
        head_from = max(a - fade, 0)
        mask[head_from:a] = np.maximum(mask[head_from:a], ramp[fade - (a - head_from):])
        tail_to = min(b + fade, n)
        mask[b:tail_to] = np.maximum(mask[b:tail_to], ramp[::-1][: tail_to - b])

    mixed = orig * (1.0 - mask)[:, None] + stem * mask[:, None]
    write_wav(out_path, mixed, rate)

    covered = float(mask.sum()) / n
    print(f"гибрид → {out_path}: {len(speech)} речевых интервалов, "
          f"стем занимает {covered * 100:.1f}% длительности, кроссфейд {CROSSFADE * 1000:.0f} мс")
    return 0


if __name__ == "__main__":
    sys.exit(main())
