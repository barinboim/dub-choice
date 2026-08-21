/**
 * Речевые интервалы по энергии сигнала — независимо от режима: границы
 * реплик берутся из звука. Порт идеи vad.py, не кода — тот недоступен вне
 * localhost. Это единственный источник границ реплик в обоих режимах.
 */

export interface VadInterval {
  start: number;
  end: number;
}

const FRAME_MS = 20;
const HOP_MS = 10;
const MIN_SPEECH_SEC = 0.25;
/** Пауза короче этой склеивается — тот же порядок величины, что merge-правило cut.py. */
const MAX_GAP_SEC = 0.7;
/** Небольшой запас по краям речи, чтобы не резать первый/последний слог. */
const HANGOVER_SEC = 0.15;
/** Насколько порог выше шумового пола (10-й перцентиль энергии). */
const THRESHOLD_MARGIN_DB = 12;

export function detectSpeech(buffer: AudioBuffer): VadInterval[] {
  const rate = buffer.sampleRate;
  const frameLen = Math.max(1, Math.round((FRAME_MS / 1000) * rate));
  const hopLen = Math.max(1, Math.round((HOP_MS / 1000) * rate));
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;

  const nFrames = Math.max(0, Math.floor((ch0.length - frameLen) / hopLen) + 1);
  if (nFrames === 0) return [];

  const energyDb = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    const off = i * hopLen;
    let sum = 0;
    for (let j = 0; j < frameLen; j++) {
      const s0 = ch0[off + j] ?? 0;
      const s1 = ch1 ? (ch1[off + j] ?? 0) : s0;
      const v = ch1 ? (s0 + s1) / 2 : s0;
      sum += v * v;
    }
    energyDb[i] = 20 * Math.log10(Math.sqrt(sum / frameLen) + 1e-9);
  }

  const sorted = Float32Array.from(energyDb).sort();
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? -60;
  const threshold = floor + THRESHOLD_MARGIN_DB;

  const raw: VadInterval[] = [];
  let start = -1;
  for (let i = 0; i < nFrames; i++) {
    const above = energyDb[i] > threshold;
    if (above && start === -1) start = i;
    if (!above && start !== -1) {
      raw.push({ start: frameToSec(start, hopLen, rate), end: frameToSec(i, hopLen, rate) });
      start = -1;
    }
  }
  if (start !== -1) raw.push({ start: frameToSec(start, hopLen, rate), end: frameToSec(nFrames, hopLen, rate) });

  const withHangover = raw.map((iv) => ({
    start: Math.max(0, iv.start - HANGOVER_SEC),
    end: iv.end + HANGOVER_SEC,
  }));

  const merged: VadInterval[] = [];
  for (const iv of withHangover) {
    const last = merged[merged.length - 1];
    if (last && iv.start - last.end < MAX_GAP_SEC) last.end = iv.end;
    else merged.push({ ...iv });
  }

  return merged.filter((iv) => iv.end - iv.start >= MIN_SPEECH_SEC);
}

function frameToSec(frameIdx: number, hopLen: number, rate: number): number {
  return (frameIdx * hopLen) / rate;
}
