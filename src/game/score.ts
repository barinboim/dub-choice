/**
 * Оценка попадания дубля в оригинальную реплику — как экран Results
 * в оригинальной игре: балл 0–10 на реплику и общий процент.
 *
 * Считаем по огибающим громкости, а не по смыслу: важно, попал ли игрок
 * в ритм фразы — начал и кончил вовремя, сделал паузы и акценты там же.
 * Две составляющие:
 *
 *   1. Тайминг — совпадение «речь / тишина» по кадрам (F1 пересечения масок).
 *      Это главное: молчать, когда персонаж говорит, — худшее, что можно
 *      сделать, и наоборот.
 *   2. Рисунок — корреляция огибающих в дБ: совпадают ли акценты внутри фразы.
 *
 * Общая задержка дубля ищется отдельно (взаимная корреляция в пределах
 * ±MAX_LAG) и компенсируется перед сравнением: человек физически не начинает
 * говорить строго в ту же миллисекунду, и без этого даже хороший дубль
 * получал тройку. За саму задержку берётся отдельный мягкий штраф.
 *
 * Оригинал реплики — полный микс сцены (музыка, шумы), так что метрика
 * заведомо не лабораторная. Пороги адаптивные, от динамики самой дорожки,
 * чтобы музыкальный фон не считался речью целиком.
 */

import type { Recording } from "../audio/recorder";

/** Шаг анализа: 20 мс — примерно длина фонемы. */
const FRAME_SEC = 0.02;
/** Ниже этого уровня (в долях от «громкой» части) считаем, что тишина. */
const ACTIVE_RATIO = 0.22;
/** Пол динамического диапазона при переводе в дБ. */
const FLOOR_DB = -45;
/** Меньше этой доли активных кадров у игрока — считаем, что он промолчал. */
const SILENT_TAKE = 0.02;
/** Огибающая сглаживается скользящим средним — микродрожь громкости не в счёт. */
const SMOOTH_FRAMES = 5;
/** Максимальная задержка дубля, которую ищем и компенсируем. */
const MAX_LAG_SEC = 0.3;
/** Штраф за задержку: на MAX_LAG балл падает на эту долю. */
const LAG_PENALTY = 0.35;
/** Допуск на границы фраз при сравнении масок (±кадры). */
const DILATE_FRAMES = 2;
/** Корреляция, которую даёт случайный дубль: вычитается из «рисунка». */
const CHANCE_CORR = 0.35;

const TIMING_WEIGHT = 0.55;
const SHAPE_WEIGHT = 0.45;

export interface ClipScore {
  /** 0–10, как в оригинале. */
  score: number;
  /** Совпадение речь/тишина по кадрам, 0–1 (для подсказок в интерфейсе). */
  timing: number;
  /** Совпадение рисунка громкости, 0–1. */
  shape: number;
  /** Найденная задержка дубля в секундах (>0 — игрок опоздал). */
  lag: number;
}

/** RMS по кадрам фиксированной длины; хвост добивается нулями. */
function envelope(samples: Float32Array, sampleRate: number, frames: number): Float32Array {
  const per = Math.max(1, Math.round(FRAME_SEC * sampleRate));
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const start = f * per;
    if (start >= samples.length) break;
    const end = Math.min(samples.length, start + per);
    let sumSq = 0;
    for (let i = start; i < end; i++) sumSq += samples[i] * samples[i];
    env[f] = Math.sqrt(sumSq / (end - start));
  }
  return env;
}

/** Моно-микс канала(ов) AudioBuffer. */
function monoSamples(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const mono = new Float32Array(buffer.length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }
  return mono;
}

/** Перцентиль по копии массива (p от 0 до 1). */
function percentile(values: Float32Array, p: number): number {
  const sorted = Float32Array.from(values).sort();
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

/**
 * Маска «здесь говорят»: порог берём между медианой (фон) и громкой частью,
 * чтобы дорожка с музыкой не оказалась речью от начала до конца.
 */
function speechMask(env: Float32Array): Uint8Array {
  const loud = percentile(env, 0.92);
  const floor = percentile(env, 0.4);
  const threshold = floor + (loud - floor) * ACTIVE_RATIO;
  const mask = new Uint8Array(env.length);
  if (loud <= 1e-5) return mask; // тишина целиком
  for (let i = 0; i < env.length; i++) mask[i] = env[i] > threshold ? 1 : 0;
  return mask;
}

/** Огибающая в дБ, нормированная по громкой части и зажатая полом. */
function envelopeDb(env: Float32Array): Float32Array {
  const loud = Math.max(percentile(env, 0.92), 1e-6);
  const db = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) {
    const rel = 20 * Math.log10(Math.max(env[i], 1e-6) / loud);
    db[i] = Math.max(rel, FLOOR_DB);
  }
  return db;
}

/** Скользящее среднее шириной SMOOTH_FRAMES. */
function smooth(values: Float32Array): Float32Array {
  const half = SMOOTH_FRAMES >> 1;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0, count = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(values.length - 1, i + half); k++) {
      sum += values[k]; count++;
    }
    out[i] = sum / count;
  }
  return out;
}

/** Маска, расширенная на ±DILATE_FRAMES: допуск на границы фраз. */
function dilate(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    for (let k = Math.max(0, i - DILATE_FRAMES); k <= Math.min(mask.length - 1, i + DILATE_FRAMES); k++) {
      out[k] = 1;
    }
  }
  return out;
}

/**
 * Корреляция Пирсона со сдвигом b на lag кадров вправо
 * (lag > 0 — игрок опоздал).
 */
function pearson(a: Float32Array, b: Float32Array, lag = 0): number {
  const from = Math.max(0, lag);
  const to = Math.min(a.length, b.length + lag);
  const n = to - from;
  if (n < 2) return 0;
  let sa = 0, sb = 0;
  for (let i = from; i < to; i++) { sa += a[i]; sb += b[i - lag]; }
  const ma = sa / n, mb = sb / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = from; i < to; i++) {
    const da = a[i] - ma, db = b[i - lag] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  if (va < 1e-9 || vb < 1e-9) return 0;
  return cov / Math.sqrt(va * vb);
}

function invert(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 0 : 1;
  return out;
}

/** F1 совпадения двух масок с допуском DILATE_FRAMES по границам. */
function maskF1(a: Uint8Array, b: Uint8Array): number {
  const aWide = dilate(a);
  const bWide = dilate(b);
  let aActive = 0, bActive = 0, hitA = 0, hitB = 0;
  for (let i = 0; i < a.length; i++) {
    aActive += a[i];
    bActive += b[i];
    if (a[i] && bWide[i]) hitA++;
    if (b[i] && aWide[i]) hitB++;
  }
  if (aActive === 0 && bActive === 0) return 1; // обе пусты — сравнивать нечего
  const recall = aActive > 0 ? hitA / aActive : 0;
  const precision = bActive > 0 ? hitB / bActive : 0;
  return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
}

/** Сдвиг маски вправо на lag кадров (хвост обрезается, начало — нули). */
function shiftMask(mask: Uint8Array, lag: number): Uint8Array {
  if (lag === 0) return mask;
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    const src = i - lag;
    if (src >= 0 && src < mask.length) out[i] = mask[src];
  }
  return out;
}

/** Оценивает один дубль против оригинальной реплики. */
export function scoreTake(original: AudioBuffer, take: Recording): ClipScore {
  // Общая шкала — длина оригинала: запись не длиннее её (окно записи равно
  // длине реплики), а если игрок остановил дубль раньше — хвост это тишина
  const frames = Math.max(1, Math.round(original.duration / FRAME_SEC));
  const origEnv = envelope(monoSamples(original), original.sampleRate, frames);
  const takeEnv = envelope(take.samples, take.sampleRate, frames);

  const origMask = speechMask(origEnv);
  const rawTakeMask = speechMask(takeEnv);

  let takeActive = 0;
  for (let i = 0; i < frames; i++) takeActive += rawTakeMask[i];
  if (takeActive / frames < SILENT_TAKE) return { score: 0, timing: 0, shape: 0, lag: 0 };

  // Ищем общую задержку дубля по взаимной корреляции огибающих
  const origDb = smooth(envelopeDb(origEnv));
  const takeDb = smooth(envelopeDb(takeEnv));
  const maxLag = Math.round(MAX_LAG_SEC / FRAME_SEC);
  let bestLag = 0;
  let shape = pearson(origDb, takeDb, 0);
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    if (lag === 0) continue;
    const c = pearson(origDb, takeDb, lag);
    if (c > shape) { shape = c; bestLag = lag; }
  }
  shape = Math.max(0, shape);

  // Короткая реплика — это всего пара десятков независимых точек огибающей,
  // и максимум по трём десяткам сдвигов сам по себе даёт корреляцию около
  // CHANCE_CORR даже на шуме. Вычитаем этот «уровень случайности»
  shape = Math.max(0, (shape - CHANCE_CORR) / (1 - CHANCE_CORR));

  // Тайминг сравниваем уже с компенсированной задержкой: важно, попал ли
  // игрок в рисунок фразы, а за саму задержку штраф берётся отдельно.
  // Считаем и по речи, и по тишине: болтовня поверх пауз — тоже промах
  const takeMask = shiftMask(rawTakeMask, bestLag);
  const timing = (maskF1(origMask, takeMask) + maskF1(invert(origMask), invert(takeMask))) / 2;

  const lagSec = -bestLag * FRAME_SEC;
  const syncFactor = 1 - LAG_PENALTY * Math.min(Math.abs(lagSec), MAX_LAG_SEC) / MAX_LAG_SEC;

  const score = 10 * (TIMING_WEIGHT * timing + SHAPE_WEIGHT * shape) * syncFactor;
  return {
    score: Math.round(score * 100) / 100,
    timing,
    shape,
    lag: Math.round(lagSec * 1000) / 1000,
  };
}

/** Общий процент дубляжа = средний балл по репликам. */
export function totalPercent(scores: number[]): number {
  if (scores.length === 0) return 0;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return Math.round(mean * 10 * 100) / 100;
}

/** Ключ шутливого вердикта по проценту (см. словарь i18n). */
export function verdictKey(percent: number):
  | "verdictAce"
  | "verdictGreat"
  | "verdictGood"
  | "verdictMeh"
  | "verdictPoor"
  | "verdictAvant" {
  if (percent >= 82) return "verdictAce";
  if (percent >= 68) return "verdictGreat";
  if (percent >= 54) return "verdictGood";
  if (percent >= 38) return "verdictMeh";
  if (percent >= 20) return "verdictPoor";
  return "verdictAvant";
}
