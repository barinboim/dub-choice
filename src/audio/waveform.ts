/**
 * Отрисовка waveform: оригинальная реплика рисуется целиком,
 * запись игрока «переписывает» её слева направо поверх.
 *
 * Каждая волна двухслойная, как в оригинальной игре: тёмная «оболочка»
 * по пикам (min/max) и светлая «сердцевина» по RMS внутри неё.
 * Волна игрока кладётся поверх полупрозрачно в режиме screen —
 * оригинал просвечивает сквозь неё.
 */

/** Цвета одной волны: оболочка по пикам + сердцевина по RMS. */
export interface WavePalette {
  shell: string;
  core: string;
}

/**
 * Прозрачность слоёв волны: чем дальше от сердцевины, тем сильнее
 * просвечивает то, что под волной. Сердцевина почти плотная.
 */
export interface LayerAlpha {
  shell: number;
  halo: number;
  core: number;
}

export interface WaveformColors {
  original: WavePalette;
  user: WavePalette;
  /** Слои волны игрока поверх оригинала. */
  userLayers: LayerAlpha;
  /** screen: бирюза поверх маджента даёт белый — как в оригинале игры. */
  userBlend: GlobalCompositeOperation;
  playhead: string;
  midline: string;
}

/** Оригинал рисуется по чистому фону — приглушён только ореол. */
const OPAQUE_LAYERS: LayerAlpha = { shell: 1, halo: 0.42, core: 1 };

/** Во сколько раз RMS растягивается до видимой сердцевины (речь: RMS ≈ ⅓ пика). */
const CORE_GAIN = 2.1;
/** Сердцевина никогда не съедает оболочку целиком — доля от пика колонки. */
const CORE_MAX_RATIO = 0.6;
/** Размытый ореол между оболочкой и сердцевиной. */
const HALO_GAIN = 3.4;
const HALO_MAX_RATIO = 0.82;

/** По три значения на колонку: min, max, rms. */
export const PEAK_STRIDE = 3;

/** Пики (min/max) и RMS по колонкам пикселей. */
export function computePeaks(samples: Float32Array, columns: number): Float32Array {
  // Возвращает массив длиной columns*3: [min0, max0, rms0, min1, ...]
  const peaks = new Float32Array(columns * PEAK_STRIDE);
  if (samples.length === 0) return peaks;
  const perColumn = samples.length / columns;
  for (let c = 0; c < columns; c++) {
    const start = Math.floor(c * perColumn);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((c + 1) * perColumn)));
    let min = 1, max = -1, sumSq = 0;
    for (let i = start; i < end; i++) {
      const v = samples[i];
      if (v < min) min = v;
      if (v > max) max = v;
      sumSq += v * v;
    }
    peaks[c * PEAK_STRIDE] = min;
    peaks[c * PEAK_STRIDE + 1] = max;
    peaks[c * PEAK_STRIDE + 2] = Math.sqrt(sumSq / Math.max(1, end - start));
  }
  return peaks;
}

export function peaksFromAudioBuffer(buffer: AudioBuffer, columns: number): Float32Array {
  // Смешиваем каналы в моно для пиков
  if (buffer.numberOfChannels === 1) return computePeaks(buffer.getChannelData(0), columns);
  const mono = new Float32Array(buffer.length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }
  return computePeaks(mono, columns);
}

export class WaveformView {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = Math.min(window.devicePixelRatio || 1, 2);

  private originalPeaks: Float32Array | null = null;
  private originalBuffer: AudioBuffer | null = null;
  /** Пики записи игрока, по колонкам; длина колонки прирастает во время записи. */
  private userPeaks: Float32Array | null = null;
  private userColumns = 0;
  /** Сколько сэмплов записи уже учтено. */
  private userSamplesSeen = 0;
  private userTotalSamples = 0;
  /** Накопители для RMS текущих колонок живой записи. */
  private userSumSq: Float64Array | null = null;
  private userCounts: Uint32Array | null = null;

  private playheadRatio: number | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private colors: WaveformColors
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.resize();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) return; // экран ещё скрыт — пересчитаем, когда появится
    this.width = Math.round(rect.width);
    this.height = Math.round(rect.height);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.originalBuffer) {
      this.originalPeaks = peaksFromAudioBuffer(this.originalBuffer, Math.max(this.width, 1));
    }
    this.draw();
  }

  /** Задаёт оригинальную дорожку (пики пересчитываются под ширину канваса). */
  setOriginal(buffer: AudioBuffer): void {
    this.originalBuffer = buffer;
    this.resize();
    this.originalPeaks = peaksFromAudioBuffer(buffer, Math.max(this.width, 1));
    this.draw();
  }

  /** Готовит место под запись длиной totalSamples (равной длине оригинала). */
  beginUserRecording(totalSamples: number): void {
    this.userColumns = Math.max(this.width, 1);
    this.userPeaks = new Float32Array(this.userColumns * PEAK_STRIDE);
    this.userSumSq = new Float64Array(this.userColumns);
    this.userCounts = new Uint32Array(this.userColumns);
    this.userSamplesSeen = 0;
    this.userTotalSamples = Math.max(totalSamples, 1);
    this.draw();
  }

  /** Живое добавление сэмплов записи. */
  appendUserChunk(chunk: Float32Array): void {
    const { userPeaks, userSumSq, userCounts } = this;
    if (!userPeaks || !userSumSq || !userCounts) return;
    const perColumn = this.userTotalSamples / this.userColumns;
    for (let i = 0; i < chunk.length; i++) {
      const v = chunk[i];
      const col = Math.min(this.userColumns - 1, Math.floor(this.userSamplesSeen / perColumn));
      const base = col * PEAK_STRIDE;
      if (v < userPeaks[base]) userPeaks[base] = v;
      if (v > userPeaks[base + 1]) userPeaks[base + 1] = v;
      userSumSq[col] += v * v;
      userCounts[col]++;
      userPeaks[base + 2] = Math.sqrt(userSumSq[col] / userCounts[col]);
      this.userSamplesSeen++;
    }
    // Курсор записи движется вместе с прогрессом
    this.playheadRatio = Math.min(this.userSamplesSeen / this.userTotalSamples, 1);
    this.draw();
  }

  /** Показывает готовую запись целиком (например, при возврате к клипу). */
  setUserRecording(samples: Float32Array, totalSamples: number): void {
    this.userColumns = Math.max(this.width, 1);
    this.userTotalSamples = Math.max(totalSamples, 1);
    this.userPeaks = new Float32Array(this.userColumns * PEAK_STRIDE);
    this.userSumSq = null;
    this.userCounts = null;
    const filledColumns = Math.min(
      this.userColumns,
      Math.round((samples.length / this.userTotalSamples) * this.userColumns)
    );
    if (filledColumns > 0) {
      const peaks = computePeaks(samples, filledColumns);
      this.userPeaks.set(peaks.subarray(0, filledColumns * PEAK_STRIDE));
    }
    this.userSamplesSeen = samples.length;
    this.draw();
  }

  clearUserRecording(): void {
    this.userPeaks = null;
    this.userSumSq = null;
    this.userCounts = null;
    this.userSamplesSeen = 0;
    this.draw();
  }

  /** 0..1 или null, чтобы спрятать плейхед. */
  setPlayhead(ratio: number | null): void {
    this.playheadRatio = ratio;
    this.draw();
  }

  draw(): void {
    const { ctx, width, height } = this;
    ctx.clearRect(0, 0, width, height);

    const mid = height / 2;

    if (this.originalPeaks) {
      this.drawPeaks(this.originalPeaks, this.colors.original);
    }
    if (this.userPeaks) {
      const progressCols = Math.min(
        this.userColumns,
        Math.ceil((this.userSamplesSeen / this.userTotalSamples) * this.userColumns)
      );
      this.drawPeaks(this.userPeaks, this.colors.user, {
        layers: this.colors.userLayers,
        blend: this.colors.userBlend,
        limitColumns: progressCols,
      });
    }

    // Средняя линия — поверх волн, как в оригинале
    ctx.strokeStyle = this.colors.midline;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(width, mid + 0.5);
    ctx.stroke();

    if (this.playheadRatio !== null) {
      const x = this.playheadRatio * width;
      ctx.strokeStyle = this.colors.playhead;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }

  private drawPeaks(
    peaks: Float32Array,
    palette: WavePalette,
    opts: {
      layers?: LayerAlpha;
      blend?: GlobalCompositeOperation;
      limitColumns?: number;
    } = {}
  ): void {
    const { ctx, height } = this;
    const mid = height / 2;
    const amp = height * 0.46;
    const layers = opts.layers ?? OPAQUE_LAYERS;
    const columns = opts.limitColumns ?? peaks.length / PEAK_STRIDE;
    const colWidth = this.width / (peaks.length / PEAK_STRIDE);
    const barWidth = Math.max(colWidth, 1);

    ctx.save();
    if (opts.blend) ctx.globalCompositeOperation = opts.blend;

    // Слой 1 — оболочка по пикам, самая прозрачная
    ctx.globalAlpha = layers.shell;
    ctx.fillStyle = palette.shell;
    for (let c = 0; c < columns; c++) {
      const base = c * PEAK_STRIDE;
      const min = peaks[base];
      const max = peaks[base + 1];
      if (max < min) continue;
      const y1 = mid - Math.max(max, 0.008) * amp;
      const y2 = mid - Math.min(min, -0.008) * amp;
      ctx.fillRect(c * colWidth, y1, barWidth, y2 - y1);
    }

    // Слой 2 — размытый ореол вокруг сердцевины
    ctx.globalAlpha = layers.halo;
    ctx.fillStyle = palette.core;
    this.fillCore(peaks, columns, colWidth, barWidth, amp, HALO_GAIN, HALO_MAX_RATIO);

    // Слой 3 — плотная сердцевина по RMS
    ctx.globalAlpha = layers.core;
    this.fillCore(peaks, columns, colWidth, barWidth, amp, CORE_GAIN, CORE_MAX_RATIO);

    ctx.restore();
  }

  /** Симметричная относительно центра полоса высотой rms*gain, зажатая пиками. */
  private fillCore(
    peaks: Float32Array,
    columns: number,
    colWidth: number,
    barWidth: number,
    amp: number,
    gain: number,
    maxRatio: number
  ): void {
    const { ctx, height } = this;
    const mid = height / 2;
    for (let c = 0; c < columns; c++) {
      const base = c * PEAK_STRIDE;
      const min = peaks[base];
      const max = peaks[base + 1];
      const rms = peaks[base + 2];
      if (max < min || rms <= 0) continue;
      const peak = Math.max(max, -min);
      const half = Math.min(rms * gain, peak * maxRatio) * amp;
      if (half <= 0.3) continue;
      ctx.fillRect(c * colWidth, mid - half, barWidth, half * 2);
    }
  }
}
