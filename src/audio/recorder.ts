import { audioContext } from "./context";

/**
 * Запись с микрофона через AudioWorklet: получаем сырые Float32-сэмплы,
 * чтобы рисовать живой waveform и точно монтировать финальный ролик.
 */

const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      // Копия обязательна: буфер переиспользуется движком
      this.port.postMessage(input[0].slice(0));
    }
    return true;
  }
}
registerProcessor("dub-capture", CaptureProcessor);
`;

let workletReady: Promise<void> | null = null;

function ensureWorklet(ctx: AudioContext): Promise<void> {
  if (!workletReady) {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
    workletReady = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
  }
  return workletReady;
}

export interface Recording {
  /** Моно PCM запись. */
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
}

export class MicRecorder {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];
  private totalSamples = 0;
  private maxSamples = Infinity;
  private active = false;
  private onChunkCb: ((chunk: Float32Array) => void) | null = null;
  private onAutoStopCb: (() => void) | null = null;

  /** Запрашивает доступ к микрофону (можно вызвать заранее, на экране пака). */
  async init(): Promise<void> {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  }

  get ready(): boolean {
    return this.stream !== null;
  }

  /**
   * Подключает микрофон к графу заранее, не начиная запись: поток успевает
   * раскачаться, а AudioWorklet — загрузиться. Всё, что приходит до start(),
   * отбрасывается. Вызывается на отсчёте перед записью.
   */
  async arm(): Promise<void> {
    await this.init();
    const ctx = audioContext();
    await ensureWorklet(ctx);
    if (this.worklet) return;

    this.source = ctx.createMediaStreamSource(this.stream!);
    this.worklet = new AudioWorkletNode(ctx, "dub-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    this.worklet.port.onmessage = (e: MessageEvent<Float32Array>) => this.receive(e.data);
    this.source.connect(this.worklet);
  }

  /** Отпускает микрофон, если запись так и не началась (отменённый отсчёт). */
  disarm(): void {
    if (!this.active) this.teardown();
  }

  private receive(data: Float32Array): void {
    if (!this.active) return; // прогрев до start(): сэмплы никому не нужны
    let chunk = data;
    const remaining = this.maxSamples - this.totalSamples;
    if (chunk.length >= remaining) {
      chunk = chunk.subarray(0, remaining);
      this.chunks.push(chunk);
      this.totalSamples += chunk.length;
      this.onChunkCb?.(chunk);
      const autoStop = this.onAutoStopCb;
      this.teardown();
      autoStop?.();
      return;
    }
    this.chunks.push(chunk);
    this.totalSamples += chunk.length;
    this.onChunkCb?.(chunk);
  }

  /**
   * Начинает запись. maxDurationSec — автостоп (длина оригинальной реплики).
   * onChunk вызывается с каждым куском сэмплов для живой отрисовки.
   */
  async start(
    maxDurationSec: number,
    onChunk: (chunk: Float32Array) => void,
    onAutoStop: () => void
  ): Promise<void> {
    await this.arm();

    this.chunks = [];
    this.totalSamples = 0;
    this.maxSamples = Math.floor(maxDurationSec * audioContext().sampleRate);
    this.onChunkCb = onChunk;
    this.onAutoStopCb = onAutoStop;
    this.active = true;
  }

  /**
   * Переносит начало дубля в «сейчас», выбрасывая уже накопленное. Нужно
   * потому, что видео стартует не мгновенно: между кликом и первым кадром
   * микрофон пишет пустоту, а игрок начинает говорить под картинку — без
   * сброса весь дубль уезжает на время старта плеера. Автостоп по длине
   * реплики тоже отсчитывается заново, от нового нуля.
   */
  markStart(): void {
    if (!this.active) return;
    this.chunks = [];
    this.totalSamples = 0;
  }

  /** Останавливает запись и возвращает результат. */
  stop(): Recording {
    this.teardown();
    return this.snapshot();
  }

  /** Текущая запись (после автостопа). */
  snapshot(): Recording {
    const ctx = audioContext();
    const samples = new Float32Array(this.totalSamples);
    let offset = 0;
    for (const chunk of this.chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    return {
      samples,
      sampleRate: ctx.sampleRate,
      durationSec: samples.length / ctx.sampleRate,
    };
  }

  get isRecording(): boolean {
    return this.active;
  }

  private teardown(): void {
    this.active = false;
    this.worklet?.port.close();
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.worklet = null;
    this.source = null;
  }

  /** Полностью освобождает микрофон (например, при выходе из игры). */
  dispose(): void {
    this.teardown();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

/** Переводит моно-запись в AudioBuffer для воспроизведения/монтажа. */
export function recordingToBuffer(rec: Recording): AudioBuffer {
  const ctx = audioContext();
  const buffer = ctx.createBuffer(1, Math.max(rec.samples.length, 1), rec.sampleRate);
  buffer.copyToChannel(rec.samples as Float32Array<ArrayBuffer>, 0);
  return buffer;
}
