import { audioContext } from "../audio/context";
import { recordingToBuffer, playbackEndSec, TAIL_SEC } from "../audio/recorder";
import { audioBufferToWav } from "../audio/wav";
import { DubVideoPlayer } from "../video/player";
import { DubSession } from "./session";

/**
 * Что делать с оригинальными голосами:
 * dub — их нет вовсе (звучит только фон и запись игрока),
 * voiceover — они остаются приглушёнными под дублем, как закадровый перевод.
 */
export type MixMode = "dub" | "voiceover";

/** Громкость оригинального звука в закадре по умолчанию (игрок её крутит). */
export const DEFAULT_VOICEOVER_GAIN = 0.3;
/**
 * Положение слайдера озвучки, которое означает «как записано». Правее —
 * усиление (лимитер на мастере не даст перегрузить), левее — тише.
 */
export const TAKE_VOLUME_UNITY = 75;

interface ScheduledCue {
  buffer: AudioBuffer;
  /** Множитель громкости; у оригинала в закадре он ниже единицы. */
  gain?: number;
  /**
   * Докуда играть буфер (сек от его начала). У записей игрока это конец
   * речи: дальше идёт только молчаливый запас, тянуть его незачем.
   */
  until?: number;
  /**
   * Момент в видео, куда ложится начало записи. Уже с поправкой на запас-
   * вступление: если игрок заговорил до персонажа, запись начинается раньше
   * таймстампа реплики. Может быть отрицательным — тогда обрезаем по нулю.
   */
  at: number;
}

/**
 * Мягкий лимитер на мастере. Реплики в паках часто идут внахлёст, каждый
 * дубль нормализован почти под 0 dBFS, и сумма двух голосов уходила в
 * клиппинг — на слух это провал и хрип ровно на стыках фраз.
 */
function createLimiter(ctx: BaseAudioContext): DynamicsCompressorNode {
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  return limiter;
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
  /** Целая оригинальная дорожка для закадра; заменяет собой фон. */
  private voiceoverTrack: { buffer: AudioBuffer; gain: number } | null = null;
  /** Громкость фоновой дорожки: в закадре она приглушается вместе с голосами. */
  private backingGain = 1;
  private activeSources: AudioBufferSourceNode[] = [];
  private readonly masterGain: GainNode;
  /** Мастер-лимитер: между masterGain и выходом (он же уходит в запись MP4). */
  private readonly limiter: DynamicsCompressorNode;
  /** Момент по часам AudioContext, когда доиграет последний источник. */
  private audioEndsAt = 0;
  private overhangTimer = 0;

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
    const ctx = audioContext();
    this.masterGain = ctx.createGain();
    this.limiter = createLimiter(ctx);
    this.masterGain.connect(this.limiter);
    this.limiter.connect(ctx.destination);
    this.video.onEnded(() => this.handleEnded());
  }

  async prepare(
    session: DubSession,
    mode: MixMode = "dub",
    voiceoverGain = DEFAULT_VOICEOVER_GAIN,
    takeGain = 1
  ): Promise<void> {
    this.backing = await session.backingBuffer();
    this.capturedBlob = null; // записи могли измениться — старый файл невалиден
    this.cues = [];
    for (let i = 0; i < session.pack.clips.length; i++) {
      const clip = session.pack.clips[i];
      // Персонаж выключен фильтром — игрока не просили озвучивать эту
      // реплику. В «Дубляже» вместо тишины оставляем голос персонажа на
      // выбранной дорожке (нет дорожки — берём оригинал); в «Закадре» вся
      // оригинальная дорожка и так звучит под записью.
      if (!session.isClipActive(i)) {
        if (mode === "dub") {
          const voice = await session.clipBuffer(i);
          for (const t of clip.timestamps) {
            this.cues.push({ buffer: voice, at: t, gain: 1 });
          }
        }
        continue;
      }
      const rec = session.recordings.get(i);
      if (!rec || rec.samples.length === 0) continue;
      const buffer = recordingToBuffer(rec);
      // Играем до конца речи, а не до конца буфера: молчаливый запас в
      // хвосте задерживал бы финал фризом последнего кадра на ровном месте
      const original = await session.originalBuffer(i);
      const until = playbackEndSec(rec, original.duration);
      // Запись длиннее реплики с обеих сторон — ставим её так, чтобы начало
      // самой реплики совпало с таймстампом, а запас лёг вокруг
      for (const t of clip.timestamps) {
        this.cues.push({ buffer, at: t - rec.leadSec, gain: takeGain, until });
      }
    }
    // Закадр: оригинальный звук сцены возвращается в микс, но тише дубля.
    // Целая дорожка — если пак её несёт: тогда фон играет ровно один раз.
    // Иначе собираем оригинал из кусков-реплик поверх фона, и под ними фон
    // получается чуть плотнее — с чужими паками иначе никак.
    // В закадре тише становится вся оригинальная звуковая картина, включая
    // фон: слайдер называется «громкость оригинала», а не «громкость голосов»
    this.backingGain = mode === "voiceover" ? voiceoverGain : 1;
    this.voiceoverTrack = null;
    if (mode === "voiceover") {
      // Под голосом игрока звучит та дорожка, которую он выбрал. У дубляжа
      // в паке лежит только голос, поэтому фон к нему добавляет бэкинг —
      // он общий для всех языков, музыка-то одна и та же.
      const dub = session.audioLang
        ? await session.voicesBuffer(session.audioLang)
        : null;
      const track = dub ?? (await session.originalTrackBuffer());
      if (track) {
        this.voiceoverTrack = { buffer: track, gain: voiceoverGain };
      } else {
        for (let i = 0; i < session.total; i++) {
          const original = await session.clipBuffer(i);
          for (const t of session.pack.clips[i].timestamps) {
            this.cues.push({ buffer: original, at: t, gain: voiceoverGain });
          }
        }
      }
    }

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
    // Звук привязываем к моменту, когда плеер реально показал кадр: иначе на
    // медленном устройстве весь дубляж уезжает вперёд картинки и реплики
    // звучат на чужих сценах
    const playing = this.video.whenPlaying();
    await this.video.play().catch(() => {});
    await playing;
    this.scheduleFrom(this.video.currentTime);
  }

  /** Планирует backing и записи от текущей позиции видео. */
  private scheduleFrom(videoTime: number): void {
    const ctx = audioContext();
    const t0 = ctx.currentTime + 0.05;

    this.audioEndsAt = 0;
    const startSource = (buffer: AudioBuffer, at: number, gain?: number, until?: number) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      if (gain === undefined) {
        src.connect(this.masterGain);
      } else {
        const node = ctx.createGain();
        node.gain.value = gain;
        src.connect(node).connect(this.masterGain);
      }
      const delay = at - videoTime;
      // Запас-вступление первой реплики может уходить левее нуля видео
      if (delay >= 0) {
        src.start(t0 + delay);
      } else if (-delay < buffer.duration) {
        src.start(t0, -delay); // начинаем с середины
      } else {
        return;
      }
      // Конец этого источника по часам контекста — по нему потом решаем,
      // сколько держать последний кадр, чтобы не срезать договорённое
      const playFor = Math.min(until ?? buffer.duration, buffer.duration) - Math.max(-delay, 0);
      if (playFor > 0) {
        const endsAt = t0 + Math.max(delay, 0) + playFor;
        src.stop(endsAt);
        this.audioEndsAt = Math.max(this.audioEndsAt, endsAt);
      }
      this.activeSources.push(src);
    };

    if (this.voiceoverTrack) {
      startSource(this.voiceoverTrack.buffer, 0, this.voiceoverTrack.gain);
    } else if (this.backing) {
      startSource(this.backing, 0, this.backingGain);
    }
    for (const cue of this.cues) startSource(cue.buffer, cue.at, cue.gain, cue.until);
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
    this.limiter.connect(this.audioDest); // после лимитера: в файл идёт то же, что слышно

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

  /**
   * Видео дошло до конца. Если последняя реплика ещё звучит (игрок договаривал
   * после персонажа), даём ей доиграть — и только потом глушим звук и
   * закрываем запись, иначе в файл попадёт обрубленная фраза.
   */
  private handleEnded(): void {
    const left = this.audioEndsAt - audioContext().currentTime;
    const wait = Math.min(Math.max(left, 0), TAIL_SEC);
    if (wait <= 0.01) {
      this.finishPlayback();
      return;
    }
    clearTimeout(this.overhangTimer);
    this.overhangTimer = window.setTimeout(() => this.finishPlayback(), wait * 1000);
  }

  private finishPlayback(): void {
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
      this.limiter.disconnect(this.audioDest);
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
    return this.renderCuesToWav(this.cues, this.backing, this.backingGain, this.voiceoverTrack);
  }

  /**
   * WAV без фона/музыки: только голоса. `includeCharacterVoices` добавляет
   * оригинальные реплики персонажей, выключенных фильтром, — иначе это
   * ровно то, что игрок сам записал, и ничего больше.
   */
  async renderVoiceWav(session: DubSession, includeCharacterVoices: boolean): Promise<Blob> {
    const cues: ScheduledCue[] = [];
    for (let i = 0; i < session.pack.clips.length; i++) {
      const clip = session.pack.clips[i];
      if (!session.isClipActive(i)) {
        if (includeCharacterVoices) {
          const voice = await session.clipBuffer(i);
          for (const t of clip.timestamps) cues.push({ buffer: voice, at: t, gain: 1 });
        }
        continue;
      }
      const rec = session.recordings.get(i);
      if (!rec || rec.samples.length === 0) continue;
      const buffer = recordingToBuffer(rec);
      const original = await session.originalBuffer(i);
      const until = playbackEndSec(rec, original.duration);
      for (const t of clip.timestamps) {
        cues.push({ buffer, at: t - rec.leadSec, gain: 1, until });
      }
    }
    cues.sort((a, b) => a.at - b.at);
    return this.renderCuesToWav(cues, null, 1, null);
  }

  private async renderCuesToWav(
    cues: ScheduledCue[],
    backing: AudioBuffer | null,
    backingGain: number,
    voiceoverTrack: { buffer: AudioBuffer; gain: number } | null
  ): Promise<Blob> {
    const sampleRate = audioContext().sampleRate;
    let durationSec = this.video.duration || 0;
    if (backing) durationSec = Math.max(durationSec, backing.duration);
    if (voiceoverTrack) durationSec = Math.max(durationSec, voiceoverTrack.buffer.duration);
    for (const cue of cues) {
      // Хвост WAV-а — по концу речи, иначе файл тянет молчаливый запас
      durationSec = Math.max(durationSec, cue.at + Math.min(cue.until ?? Infinity, cue.buffer.duration));
    }
    if (durationSec <= 0) throw new Error("Нечего рендерить");

    const offline = new OfflineAudioContext(2, Math.ceil(durationSec * sampleRate), sampleRate);
    const limiter = createLimiter(offline);
    limiter.connect(offline.destination);
    const startSource = (buffer: AudioBuffer, at: number, gain?: number, until?: number) => {
      const src = offline.createBufferSource();
      src.buffer = buffer;
      if (gain === undefined) {
        src.connect(limiter);
      } else {
        const node = offline.createGain();
        node.gain.value = gain;
        src.connect(node).connect(limiter);
      }
      // Отрицательный at — реплика начинается раньше нуля видео: играем её
      // с середины, иначе start() бросит исключение
      if (at >= 0) src.start(at);
      else if (-at < buffer.duration) src.start(0, -at);
      else return;
      if (until !== undefined && until < buffer.duration) src.stop(Math.max(at, 0) + until);
    };
    if (voiceoverTrack) {
      startSource(voiceoverTrack.buffer, 0, voiceoverTrack.gain);
    } else if (backing) {
      startSource(backing, 0, backingGain);
    }
    for (const cue of cues) startSource(cue.buffer, cue.at, cue.gain, cue.until);

    return audioBufferToWav(await offline.startRendering());
  }

  /** Останавливает просмотр; недописанная фоновая запись выбрасывается. */
  stop(): void {
    clearTimeout(this.overhangTimer);
    if (this.capturing) this.finishCapture(true);
    this.stopAudio();
    this.video.pause();
  }

  dispose(): void {
    this.onCaptureFinished = null;
    this.stop();
    this.masterGain.disconnect();
    this.limiter.disconnect();
  }
}
