/**
 * Огибающая звука для таймлайна студии.
 *
 * Волна в редакторе рисуется не из сырого буфера: канвас во всю длину
 * таймлайна невозможен (10 минут при 200 px/с — 120 000 px, браузер режет
 * канвас на ~32 767), да и пересчитывать миллионы сэмплов на каждый кадр
 * скролла незачем. Поэтому один раз считаем огибающую с фиксированным шагом,
 * а рисуем всегда только видимое окно, агрегируя корзины в пиксели.
 */

/** Шаг огибающей: 2,5 мс. При максимальном зуме на пиксель приходится пара корзин. */
const BUCKETS_PER_SEC = 400;

/** По три значения на корзину: min, max, rms — как в audio/waveform.ts. */
const STRIDE = 3;

export interface Envelope {
  /** [min, max, rms] на корзину. */
  data: Float32Array;
  buckets: number;
  bucketsPerSec: number;
  durationSec: number;
  /** Пик дорожки — по нему волна растягивается на всю высоту полосы. */
  peak: number;
}

/** Каналы сводятся в моно на лету — держать копию моно-дорожки целиком дорого. */
export function buildEnvelope(buffer: AudioBuffer): Envelope {
  const rate = buffer.sampleRate;
  const buckets = Math.max(1, Math.ceil(buffer.duration * BUCKETS_PER_SEC));
  const data = new Float32Array(buckets * STRIDE);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const perBucket = rate / BUCKETS_PER_SEC;

  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * perBucket);
    const to = Math.min(buffer.length, Math.max(from + 1, Math.floor((b + 1) * perBucket)));
    let min = 1;
    let max = -1;
    let sumSq = 0;
    for (let i = from; i < to; i++) {
      let v = 0;
      for (const ch of channels) v += ch[i];
      v /= channels.length;
      if (v < min) min = v;
      if (v > max) max = v;
      sumSq += v * v;
    }
    data[b * STRIDE] = min;
    data[b * STRIDE + 1] = max;
    data[b * STRIDE + 2] = Math.sqrt(sumSq / Math.max(1, to - from));
  }

  // Нормируем не по абсолютному максимуму, а по 95-му перцентилю: один
  // случайный щелчок или удар в дорожке иначе прижимает всю речь к середине
  // полосы, и волна вырождается в ниточку.
  const peaks = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    peaks[b] = Math.max(Math.abs(data[b * STRIDE]), Math.abs(data[b * STRIDE + 1]));
  }
  const sorted = Float32Array.from(peaks).sort();
  const peak = sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1] || 0;
  return { data, buckets, bucketsPerSec: BUCKETS_PER_SEC, durationSec: buffer.duration, peak };
}

export interface WaveColors {
  shell: string;
  core: string;
}

/** Во сколько раз RMS растягивается до видимой сердцевины (как в игре). */
const CORE_GAIN = 2.1;
const CORE_MAX_RATIO = 0.6;

/** Готовит канвас под CSS-размер и отдаёт контекст. */
export function prepareCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  if (cssWidth === 0 || cssHeight === 0) return null;
  if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
  }
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssWidth, cssHeight);
  return g;
}

export interface Band {
  /** Верх полосы в CSS-пикселях канваса и её высота. */
  top: number;
  height: number;
  /** Цвет речи, забранной репликой этого персонажа. */
  free: WaveColors;
  /** Цвет всего остального — речь, которая этому персонажу не принадлежит. */
  busy: WaveColors;
  /** Свои реплики: только они и красятся цветом, всё прочее — серое. */
  ownRanges: { start: number; end: number }[];
}

/**
 * Рисует одну полосу волны для дорожки персонажа: цветом — там, где место
 * свободно, серым — там, где реплику уже занял кто-то другой. Так видно, куда
 * реплику вставлять можно, а куда бессмысленно.
 */
export function drawBand(
  g: CanvasRenderingContext2D,
  env: Envelope,
  fromSec: number,
  pxPerSec: number,
  widthPx: number,
  band: Band
): void {
  const gain = 1 / Math.max(0.08, env.peak);
  const secPerPx = 1 / pxPerSec;
  const mid = band.top + band.height / 2;
  const half = band.height / 2;

  for (let x = 0; x < widthPx; x++) {
    const t0 = fromSec + x * secPerPx;
    const b0 = Math.max(0, Math.floor(t0 * env.bucketsPerSec));
    const b1 = Math.min(env.buckets, Math.max(b0 + 1, Math.ceil((t0 + secPerPx) * env.bucketsPerSec)));
    if (b0 >= env.buckets) break;

    let min = 1;
    let max = -1;
    let sumSq = 0;
    for (let b = b0; b < b1; b++) {
      const lo = env.data[b * STRIDE];
      const hi = env.data[b * STRIDE + 1];
      if (lo < min) min = lo;
      if (hi > max) max = hi;
      const rms = env.data[b * STRIDE + 2];
      sumSq += rms * rms;
    }
    if (max < min) continue;

    // Цветом отмечена только речь, которую забрала реплика этого персонажа.
    // Раньше красилось всё свободное место, и дорожки пестрели там, где
    // реплик нет вовсе, — цвет переставал что-либо значить.
    const busy = !band.ownRanges.some((r) => t0 >= r.start && t0 < r.end);
    const palette = busy ? band.busy : band.free;
    const top = mid - clamp1(max * gain) * half;
    const bottom = mid - clamp1(min * gain) * half;
    g.fillStyle = palette.shell;
    g.fillRect(x, top, 1, Math.max(1, bottom - top));

    const rms = Math.sqrt(sumSq / (b1 - b0));
    const core = Math.min(1, rms * CORE_GAIN * gain) * half;
    if (core > 0) {
      g.fillStyle = palette.core;
      g.fillRect(x, mid - core, 1, Math.max(1, core * 2));
    }
  }
}

function clamp1(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

/**
 * Рисует окно [fromSec, fromSec + widthPx / pxPerSec] в канвас размером с
 * видимую область. Вызывается на скролле, зуме и смене размера.
 */
export function drawEnvelope(
  canvas: HTMLCanvasElement,
  env: Envelope,
  fromSec: number,
  pxPerSec: number,
  colors: WaveColors
): void {
  const g = prepareCanvas(canvas);
  if (!g) return;
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;

  const mid = cssHeight / 2;
  const secPerPx = 1 / pxPerSec;
  // Дорожка диалога редко подходит к 0 dBFS, а изолированный голос и подавно:
  // без нормировки волна вырождается в ниточку по центру полосы. Порог снизу
  // не даёт раздуть тишину до полной высоты.
  const gain = 1 / Math.max(0.08, env.peak);

  g.fillStyle = colors.shell;
  for (let x = 0; x < cssWidth; x++) {
    const t0 = fromSec + x * secPerPx;
    const t1 = t0 + secPerPx;
    const b0 = Math.max(0, Math.floor(t0 * env.bucketsPerSec));
    const b1 = Math.min(env.buckets, Math.max(b0 + 1, Math.ceil(t1 * env.bucketsPerSec)));
    if (b0 >= env.buckets) break;
    let min = 1;
    let max = -1;
    for (let b = b0; b < b1; b++) {
      const lo = env.data[b * STRIDE];
      const hi = env.data[b * STRIDE + 1];
      if (lo < min) min = lo;
      if (hi > max) max = hi;
    }
    if (max < min) continue;
    const top = mid - Math.max(-1, Math.min(1, max * gain)) * mid;
    const bottom = mid - Math.max(-1, Math.min(1, min * gain)) * mid;
    g.fillRect(x, top, 1, Math.max(1, bottom - top));
  }

  g.fillStyle = colors.core;
  for (let x = 0; x < cssWidth; x++) {
    const t0 = fromSec + x * secPerPx;
    const t1 = t0 + secPerPx;
    const b0 = Math.max(0, Math.floor(t0 * env.bucketsPerSec));
    const b1 = Math.min(env.buckets, Math.max(b0 + 1, Math.ceil(t1 * env.bucketsPerSec)));
    if (b0 >= env.buckets) break;
    let sumSq = 0;
    let peak = 0;
    for (let b = b0; b < b1; b++) {
      const rms = env.data[b * STRIDE + 2];
      sumSq += rms * rms;
      peak = Math.max(peak, Math.abs(env.data[b * STRIDE]), Math.abs(env.data[b * STRIDE + 1]));
    }
    const rms = Math.sqrt(sumSq / (b1 - b0));
    const half = Math.min(1, Math.min(rms * CORE_GAIN, peak * CORE_MAX_RATIO) * gain) * mid;
    if (half <= 0) continue;
    g.fillRect(x, mid - half, 1, Math.max(1, half * 2));
  }
}
