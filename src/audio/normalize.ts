import { Recording } from "./recorder";

/**
 * Подгон громкости записи игрока под громкость оригинальной реплики (RMS-матчинг).
 * Нужен из-за тихих микрофонов на части телефонов — hardware AGC (`autoGainControl`
 * в getUserMedia) не всегда достаточно поднимает уровень.
 */

/** Усиливаем не больше чем в это число раз — иначе шум звучит громче речи. */
const MAX_GAIN = 6;
/** Пик после усиления не должен доходить до 0 dBFS (запас от клиппинга). */
const HEADROOM = 0.98;
/** Ниже этого RMS считаем сигнал тишиной/шумом — усиливать нечего и не с чем сравнивать. */
const SILENCE_RMS = 0.0005;

function samplesRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
  return Math.sqrt(sumSq / samples.length);
}

function bufferRms(buffer: AudioBuffer): number {
  let sumSq = 0;
  let count = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) sumSq += data[i] * data[i];
    count += data.length;
  }
  return count ? Math.sqrt(sumSq / count) : 0;
}

/**
 * Поднимает громкость `rec.samples` до уровня `target` (мутирует запись на месте).
 * Никогда не тише оригинала не делает (gain < 1 игнорируется) и не усиливает тишину.
 */
export function matchLoudness(rec: Recording, target: AudioBuffer): void {
  const recRms = samplesRms(rec.samples);
  if (recRms < SILENCE_RMS) return;
  const targetRms = bufferRms(target);
  if (targetRms < SILENCE_RMS) return;

  let gain = Math.min(targetRms / recRms, MAX_GAIN);
  if (gain <= 1) return;

  let peak = 0;
  for (let i = 0; i < rec.samples.length; i++) {
    const a = Math.abs(rec.samples[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0) gain = Math.min(gain, HEADROOM / peak);
  if (gain <= 1) return;

  for (let i = 0; i < rec.samples.length; i++) rec.samples[i] *= gain;
}
