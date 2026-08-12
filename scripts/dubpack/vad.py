#!/usr/bin/env python3
"""
Поиск речи по энергии голосового стема — общий для скриптов пайплайна.

Работаем именно по стему `vocals`: в нём нет музыки и шумов сцены, поэтому
обычного энергетического порога хватает. И, в отличие от слов whisper, стем
знает про невербальные звуки — вздохи, смешки, «э-э-э». Ровно на этом
обжёгся первый вариант бэкинга: whisper не транскрибировал мычание Гермионы
на 49-й секунде, оно не попало в речевые интервалы, и её голос остался в
фоновой дорожке.
"""

import wave

import numpy as np

FRAME = 0.010          # шаг анализа, с
MIN_VOICED = 0.060     # короче — это щелчок или придыхание, а не речь
GAP_BRIDGE = 0.120     # пауза короче — смычка внутри слова, речь не прерывалась


def envelope(path: str) -> np.ndarray:
    """RMS по кадрам FRAME, моно."""
    with wave.open(path, "rb") as w:
        rate, ch = w.getframerate(), w.getnchannels()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
    mono = data.reshape(-1, ch).astype(np.float32).mean(axis=1) / 32768.0
    step = int(FRAME * rate)
    n = len(mono) // step
    return np.sqrt((mono[: n * step].reshape(n, step) ** 2).mean(axis=1))


def threshold(env: np.ndarray) -> float:
    """Порог между шумовым полом стема и уровнем речи."""
    floor = float(np.percentile(env, 20))
    peak = float(np.percentile(env, 95))
    return floor + 0.10 * (peak - floor)


def voiced_regions(env: np.ndarray, thr: float,
                   min_voiced: float = MIN_VOICED,
                   gap_bridge: float = GAP_BRIDGE) -> list[list[float]]:
    """
    Непрерывные куски речи. Паузы короче gap_bridge склеиваются (это смычки
    внутри слова), обрывки короче min_voiced отбрасываются как щелчки.
    """
    voiced = env > thr
    runs: list[list[float]] = []
    i, n = 0, len(voiced)
    while i < n:
        if not voiced[i]:
            i += 1
            continue
        j = i
        while j < n and voiced[j]:
            j += 1
        if (j - i) * FRAME >= min_voiced:
            runs.append([i * FRAME, j * FRAME])
        i = j
    merged: list[list[float]] = []
    for a, b in runs:
        if merged and a - merged[-1][1] <= gap_bridge:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    return merged
