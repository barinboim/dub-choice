import { audioContext } from "../audio/context";
import { recordingToBuffer } from "../audio/recorder";
import { audioBufferToWav } from "../audio/wav";
import { DubVideoPlayer } from "../video/player";
import { DubSession } from "./session";

interface ScheduledCue {
  buffer: AudioBuffer;
  /** Момент в видео, куда синхронизирована запись. */
  at: number;
}

/**
 * Финальный монтаж: видео играет без звука, а вместо оригинальной дорожки —
 * backing track + записи игрока, синхронизированные по dub_timestamps.
 *
 * Хитрость с экспортом: во время обычного просмотра запись WebM уже тихо идёт
 * под капотом (canvas.captureStream + MediaRecorder). Если зритель досмотрел
 * до конца, готовый файл лежит в `captured` и скачивается мгновенно.
 */
export class Composer {
  private cues: ScheduledCue[] = [];
  private backing: AudioBuffer | null = null;
  private activeSources: AudioBufferSourceNode[] = [];
  private readonly masterGain: GainNode;

  private capturedBlob: Blob | null = null;
  private capturing = false;
  private recorder: MediaRecorder | null = null;
  private recorderParts: Blob[] = [];
  /** Формат записи: MP4 (H.264+AAC, Chrome/Safari) или WebM (фолбэк для Firefox). */
  readonly recorderMime =
    [
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
  private audioDest: MediaStreamAudioDestinationNode | null = null;
  private drawRaf = 0;
  private discardCurrentCapture = false;

  /** Вызывается, когда фоновая запись завершилась (null — просмотр прервали). */
  onCaptureFinished: ((blob: Blob | null) => void) | null = null;

  constructor(private readonly video: DubVideoPlayer) {
    this.masterGain = audioContext().createGain();
    this.masterGain.connect(audioContext().destination);
    this.video.onEnded(() => this.handleEnded());
  }

  async prepare(session: DubSession): Promise<void> {
    this.backing = await session.backingBuffer();
    this.capturedBlob = null; // записи могли измениться — старый файл невалиден
    this.cues = [];
    session.pack.clips.forEach((clip, i) => {
      const rec = session.recordings.get(i);
      if (!rec || rec.samples.length === 0) return;
      const buffer = recordingToBuffer(rec);
      for (const t of clip.timestamps) this.cues.push({ buffer, at: t });
    });
    this.cues.sort((a, b) => a.at - b.at);
  }

  /** Готовый экспортированный ролик, если просмотр дошёл до конца. */
  get captured(): Blob | null {
    return this.capturedBlob;
  }

  get isCapturing(): boolean {
    return this.capturing;
  }

  /** Расширение файла для текущего формата записи. */
  get videoExt(): "mp4" | "webm" {
    return this.recorderMime.includes("mp4") ? "mp4" : "webm";
  }

  /** Прогресс просмотра/записи 0..1. */
  get progress(): number {
    const d = this.video.duration;
    return d ? Math.min(this.video.currentTime / d, 1) : 0;
  }

  /**
   * Запускает просмотр с начала. Если передан canvas и готового файла ещё нет,
   * параллельно идёт фоновая запись WebM.
   */
  async play(captureCanvas?: HTMLCanvasElement): Promise<void> {
    this.stop();
    this.video.muted = true;
    this.video.currentTime = 0;
    if (captureCanvas && !this.capturedBlob) this.startCapture(captureCanvas);
    await this.video.play().catch(() => {});
    this.scheduleFrom(this.video.currentTime);
  }

  /** Планирует backing и записи от текущей позиции видео. */
  private scheduleFrom(videoTime: number): void {
    const ctx = audioContext();
    const t0 = ctx.currentTime + 0.05;

    const startSource = (buffer: AudioBuffer, at: number) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.masterGain);
      const delay = at - videoTime;
      if (delay >= 0) {
        src.start(t0 + delay);
      } else if (-delay < buffer.duration) {
        src.start(t0, -delay); // начинаем с середины
      } else {
        return;
      }
      this.activeSources.push(src);
    };

    if (this.backing) startSource(this.backing, 0);
    for (const cue of this.cues) startSource(cue.buffer, cue.at);
  }

  private startCapture(canvas: HTMLCanvasElement): void {
    const ctx = audioContext();
    const src = this.video.frameSource();
    const isCanvas = src instanceof HTMLCanvasElement;
    const w = (isCanvas ? src.width : 0) || this.video.videoWidth || 640;
    const h = (isCanvas ? src.height : 0) || this.video.videoHeight || 360;
    canvas.width = w;
    canvas.height = h;
    const c2d = canvas.getContext("2d")!;

    this.audioDest = ctx.createMediaStreamDestination();
    this.masterGain.connect(this.audioDest);

    const stream = new MediaStream([
      ...canvas.captureStream(30).getVideoTracks(),
      ...this.audioDest.stream.getAudioTracks(),
    ]);

    this.recorder = new MediaRecorder(stream, {
      mimeType: this.recorderMime || undefined,
      videoBitsPerSecond: 5_000_000,
    });
    this.recorderParts = [];
    this.recorder.ondataavailable = (e) => e.data.size && this.recorderParts.push(e.data);
    this.recorder.onstop = () => {
      const discard = this.discardCurrentCapture;
      const blob = discard ? null : new Blob(this.recorderParts, { type: this.recorderMime || "video/webm" });
      this.recorderParts = [];
      if (blob) this.capturedBlob = blob;
      this.onCaptureFinished?.(blob);
    };
    this.discardCurrentCapture = false;
    this.recorder.start(250);
    this.capturing = true;

    const draw = () => {
      c2d.drawImage(this.video.frameSource(), 0, 0, w, h);
      this.drawRaf = requestAnimationFrame(draw);
    };
    draw();
  }

  /** Видео дошло до конца: звук глушим, фоновую запись финализируем как успешную. */
  private handleEnded(): void {
    this.stopAudio();
    if (this.capturing) this.finishCapture(false);
  }

  private finishCapture(discard: boolean): void {
    if (!this.capturing) return;
    this.capturing = false;
    cancelAnimationFrame(this.drawRaf);
    this.discardCurrentCapture = discard;
    this.recorder?.stop();
    this.recorder = null;
    if (this.audioDest) {
      this.masterGain.disconnect(this.audioDest);
      this.audioDest = null;
    }
  }

  private stopAudio(): void {
    for (const src of this.activeSources) {
      try { src.stop(); } catch { /* уже остановлен */ }
      src.disconnect();
    }
    this.activeSources = [];
  }

  /**
   * Рендерит готовую аудиодорожку дубляжа (backing + записи) офлайн —
   * мгновенно, без реального времени. Возвращает WAV.
   */
  async renderAudioWav(): Promise<Blob> {
    const sampleRate = audioContext().sampleRate;
    let durationSec = this.video.duration || 0;
    if (this.backing) durationSec = Math.max(durationSec, this.backing.duration);
    for (const cue of this.cues) durationSec = Math.max(durationSec, cue.at + cue.buffer.duration);
    if (durationSec <= 0) throw new Error("Нечего рендерить");

    const offline = new OfflineAudioContext(2, Math.ceil(durationSec * sampleRate), sampleRate);
    const startSource = (buffer: AudioBuffer, at: number) => {
      const src = offline.createBufferSource();
      src.buffer = buffer;
      src.connect(offline.destination);
      src.start(at);
    };
    if (this.backing) startSource(this.backing, 0);
    for (const cue of this.cues) startSource(cue.buffer, cue.at);

    return audioBufferToWav(await offline.startRendering());
  }

  /** Останавливает просмотр; недописанная фоновая запись выбрасывается. */
  stop(): void {
    if (this.capturing) this.finishCapture(true);
    this.stopAudio();
    this.video.pause();
  }

  dispose(): void {
    this.onCaptureFinished = null;
    this.stop();
    this.masterGain.disconnect();
  }
}
