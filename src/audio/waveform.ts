/**
 * Отрисовка waveform: оригинальная реплика рисуется целиком,
 * запись игрока «переписывает» её слева направо поверх.
 */

export interface WaveformColors {
  background: string;
  original: string;
  user: string;
  playhead: string;
  midline: string;
}

/** Пики (min/max) по колонкам пикселей. */
export function computePeaks(samples: Float32Array, columns: number): Float32Array {
  // Возвращает массив длиной columns*2: [min0, max0, min1, max1, ...]
  const peaks = new Float32Array(columns * 2);
  if (samples.length === 0) return peaks;
  const perColumn = samples.length / columns;
  for (let c = 0; c < columns; c++) {
    const start = Math.floor(c * perColumn);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((c + 1) * perColumn)));
    let min = 1, max = -1;
    for (let i = start; i < end; i++) {
      const v = samples[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks[c * 2] = min;
    peaks[c * 2 + 1] = max;
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
  private pendingMin = 1;
  private pendingMax = -1;

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
    this.userPeaks = new Float32Array(this.userColumns * 2);
    this.userPeaks.fill(0);
    this.userSamplesSeen = 0;
    this.userTotalSamples = Math.max(totalSamples, 1);
    this.pendingMin = 1;
    this.pendingMax = -1;
    this.draw();
  }

  /** Живое добавление сэмплов записи. */
  appendUserChunk(chunk: Float32Array): void {
    if (!this.userPeaks) return;
    const perColumn = this.userTotalSamples / this.userColumns;
    for (let i = 0; i < chunk.length; i++) {
      const v = chunk[i];
      if (v < this.pendingMin) this.pendingMin = v;
      if (v > this.pendingMax) this.pendingMax = v;
      this.userSamplesSeen++;
      const col = Math.min(this.userColumns - 1, Math.floor(this.userSamplesSeen / perColumn));
      this.userPeaks[col * 2] = Math.min(this.userPeaks[col * 2], this.pendingMin);
      this.userPeaks[col * 2 + 1] = Math.max(this.userPeaks[col * 2 + 1], this.pendingMax);
      if (this.userSamplesSeen % Math.max(1, Math.floor(perColumn)) === 0) {
        this.pendingMin = 1;
        this.pendingMax = -1;
      }
    }
    // Курсор записи движется вместе с прогрессом
    this.playheadRatio = Math.min(this.userSamplesSeen / this.userTotalSamples, 1);
    this.draw();
  }

  /** Показывает готовую запись целиком (например, при возврате к клипу). */
  setUserRecording(samples: Float32Array, totalSamples: number): void {
    this.userColumns = Math.max(this.width, 1);
    this.userTotalSamples = Math.max(totalSamples, 1);
    this.userPeaks = new Float32Array(this.userColumns * 2);
    const filledColumns = Math.min(
      this.userColumns,
      Math.round((samples.length / this.userTotalSamples) * this.userColumns)
    );
    if (filledColumns > 0) {
      const peaks = computePeaks(samples, filledColumns);
      this.userPeaks.set(peaks.subarray(0, filledColumns * 2));
    }
    this.userSamplesSeen = samples.length;
    this.draw();
  }

  clearUserRecording(): void {
    this.userPeaks = null;
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
    // Средняя линия
    ctx.strokeStyle = this.colors.midline;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();

    if (this.originalPeaks) {
      this.drawPeaks(this.originalPeaks, this.colors.original, 1);
    }
    if (this.userPeaks) {
      const progressCols = Math.min(
        this.userColumns,
        Math.ceil((this.userSamplesSeen / this.userTotalSamples) * this.userColumns)
      );
      this.drawPeaks(this.userPeaks, this.colors.user, 1, progressCols);
    }

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
    color: string,
    alpha: number,
    limitColumns?: number
  ): void {
    const { ctx, height } = this;
    const mid = height / 2;
    const amp = height * 0.46;
    const columns = limitColumns ?? peaks.length / 2;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    const colWidth = this.width / (peaks.length / 2);
    for (let c = 0; c < columns; c++) {
      const min = peaks[c * 2];
      const max = peaks[c * 2 + 1];
      if (max < min) continue;
      const y1 = mid - Math.max(max, 0.008) * amp;
      const y2 = mid - Math.min(min, -0.008) * amp;
      ctx.fillRect(c * colWidth, y1, Math.max(colWidth, 1), y2 - y1);
    }
    ctx.globalAlpha = 1;
  }
}
