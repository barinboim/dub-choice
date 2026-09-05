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

/**
 * Запас вокруг реплики. Игрок почти никогда не укладывается ровно в чужой
 * хронометраж: вступает раньше персонажа или договаривает после него.
 * Пишем шире окна с обеих сторон и в монтаж отдаём запись целиком — реплики
 * пака и так идут внахлёст, слоями микс их сложит.
 */
export const PRE_ROLL_SEC = 0.5;
export const TAIL_SEC = 0.75;

export interface Recording {
  /** Моно PCM запись, включая запас до и после реплики. */
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
  /**
   * Сколько секунд записано ДО начала реплики (запас-вступление). Монтаж
   * сдвигает запись на это время назад, чтобы слово легло туда, где сказано.
   */
  leadSec: number;
}

/** Последние n сэмплов из цепочки кусков — запас-вступление перед репликой. */
function tailOf(chunks: Float32Array[], n: number): Float32Array {
  const out = new Float32Array(n);
  let need = n;
  for (let i = chunks.length - 1; i >= 0 && need > 0; i--) {
    const chunk = chunks[i];
    const take = Math.min(need, chunk.length);
    out.set(chunk.subarray(chunk.length - take), need - take);
    need -= take;
  }
  return need > 0 ? out.subarray(need) : out;
}

/** Что случилось с уже открытым микрофоном: трек умер или его приглушили. */
export type MicTrouble = "ended" | "muted";

/** Состояние реально открытого устройства — для баг-репортов и проверок. */
export interface MicHealth {
  /** Имя устройства, которое отдал браузер (может не совпадать с выбранным в списке). */
  label: string;
  deviceId: string;
  /** "live" — трек жив; "ended" — устройство пропало. */
  readyState: MediaStreamTrackState;
  /** Трек жив, но браузер отдаёт тишину: mute в микшере, кнопка на гарнитуре. */
  muted: boolean;
}

export class MicRecorder {
  private stream: MediaStream | null = null;
  /** С каким устройством открыт текущий поток — чтобы заметить смену выбора. */
  private openedDeviceId: string | undefined;
  private onTroubleCb: ((what: MicTrouble) => void) | null = null;
  /** Пик входа с прошлого чтения — питает индикатор уровня (см. readPeak). */
  private peakSinceRead = 0;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];
  private totalSamples = 0;
  private maxSamples = Infinity;
  private active = false;
  private onChunkCb: ((chunk: Float32Array) => void) | null = null;
  private onAutoStopCb: (() => void) | null = null;
  /** Реплика доиграла, дальше пишется только хвост — для игрока запись «уже всё». */
  private onWindowEndCb: (() => void) | null = null;
  private windowEnded = false;
  /** Звук, пойманный до старта записи, — из него берётся запас-вступление. */
  private preRoll: Float32Array[] = [];
  private preRollSamples = 0;
  /** Длина окна реплики и запаса в сэмплах — из них считается автостоп. */
  private windowSamples = 0;
  private tailSamples = 0;
  private leadSamples = 0;

  /**
   * Запрашивает доступ к микрофону (можно вызвать заранее, на экране пака).
   * deviceId — выбор конкретного устройства (`mic-device-select` в main.ts).
   *
   * Поток кэшируется, но НЕ навсегда. Раньше здесь стояло `if (this.stream)
   * return`, а `dispose()` не вызывался ниоткуда — то есть однажды открытый
   * поток жил до перезагрузки страницы. Последствий было два, и оба пришли
   * баг-репортами с прода (2026-09-04): выбор другого микрофона в списке
   * молча игнорировался («выбрал правильный микрофон, а звука нет»), а
   * микрофон, умерший посреди сессии (устройство выдернули, Windows
   * приглушил его, другое приложение забрало эксклюзивно), не оживал уже
   * ничем — ни сменой пака, ни возвратом на главную; человек писал десять
   * дублей в тишину и уходил. Поэтому переоткрываем поток, если сменилось
   * устройство или трек больше не отдаёт звук.
   */
  async init(deviceId?: string): Promise<void> {
    if (this.stream && this.openedDeviceId === deviceId && this.healthy) return;
    // Пересобрать граф на живой записи нельзя — дубль оборвётся на полуслове
    if (this.active) return;
    this.release();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
    this.openedDeviceId = deviceId;
    const track = this.stream.getAudioTracks()[0];
    // Браузер сам сообщает и о смерти устройства, и о его приглушении —
    // это единственный способ узнать о беде, не дожидаясь пустого дубля
    track?.addEventListener("ended", () => this.onTroubleCb?.("ended"));
    track?.addEventListener("mute", () => this.onTroubleCb?.("muted"));
  }

  /** Кому сообщать, что открытый микрофон замолчал. */
  onTrouble(cb: (what: MicTrouble) => void): void {
    this.onTroubleCb = cb;
  }

  get ready(): boolean {
    return this.stream !== null;
  }

  /** Трек открыт, жив и не приглушён — то есть от него можно ждать звука. */
  get healthy(): boolean {
    const h = this.health;
    return h !== null && h.readyState === "live" && !h.muted;
  }

  /** Состояние реально открытого устройства (в отчёт и для проверок перед записью). */
  get health(): MicHealth | null {
    const track = this.stream?.getAudioTracks()[0];
    if (!track) return null;
    return {
      label: track.label,
      deviceId: track.getSettings().deviceId ?? "",
      readyState: track.readyState,
      muted: track.muted,
    };
  }

  /**
   * Пик входа с прошлого вызова, 0…1 — питает индикатор уровня. Читается
   * по кадру отрисовки, а не колбэком на каждый чанк: worklet присылает их
   * ~375 раз в секунду, и дёргать DOM с такой частотой незачем.
   */
  readPeak(): number {
    const peak = this.peakSinceRead;
    this.peakSinceRead = 0;
    return peak;
  }

  /** Микрофон подключён к графу и питает индикатор уровня. */
  get armed(): boolean {
    return this.worklet !== null;
  }

  /**
   * Подключает микрофон к графу заранее, не начиная запись: поток успевает
   * раскачаться, а AudioWorklet — загрузиться. Приходящий звук копится в
   * коротком кольце — из него потом берётся запас-вступление, если игрок
   * заговорил раньше персонажа. Вызывается на отсчёте перед записью.
   */
  async arm(): Promise<void> {
    // Именно с тем устройством, что уже открыто: init() без аргумента взял бы
    // системный микрофон по умолчанию и молча отменил выбор игрока
    await this.init(this.openedDeviceId);
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
    // Уровень копим всегда — и до записи тоже: индикатор на экране должен
    // показать молчащий микрофон раньше, чем игрок запишет в тишину дубль
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > this.peakSinceRead) this.peakSinceRead = a;
    }
    if (!this.active) {
      // Прогрев до start(): держим короткое кольцо на случай раннего вступления
      this.preRoll.push(data);
      this.preRollSamples += data.length;
      const keep = Math.ceil(PRE_ROLL_SEC * audioContext().sampleRate);
      while (this.preRollSamples - this.preRoll[0].length >= keep) {
        this.preRollSamples -= this.preRoll.shift()!.length;
      }
      return;
    }
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
    if (!this.windowEnded && this.totalSamples >= this.leadSamples + this.windowSamples) {
      this.windowEnded = true;
      this.onWindowEndCb?.();
    }
  }

  /**
   * Начинает запись. clipDurationSec — длина реплики; автостоп срабатывает
   * на TAIL_SEC позже, чтобы договорённое после персонажа не срезалось.
   * onChunk вызывается с каждым куском сэмплов для живой отрисовки.
   */
  async start(
    clipDurationSec: number,
    onChunk: (chunk: Float32Array) => void,
    onAutoStop: () => void,
    onWindowEnd?: () => void
  ): Promise<void> {
    await this.arm();
    const sr = audioContext().sampleRate;

    this.chunks = [];
    this.totalSamples = 0;
    this.leadSamples = 0;
    this.windowSamples = Math.floor(clipDurationSec * sr);
    this.tailSamples = Math.floor(TAIL_SEC * sr);
    this.maxSamples = this.windowSamples + this.tailSamples;
    this.onChunkCb = onChunk;
    this.onAutoStopCb = onAutoStop;
    this.onWindowEndCb = onWindowEnd ?? null;
    this.windowEnded = false;
    this.active = true;
  }

  /**
   * Отмечает начало реплики — момент, когда на экране пошли кадры. Всё, что
   * записано раньше, отбрасывается, кроме последних PRE_ROLL_SEC: игрок
   * нередко вступает до персонажа, и этот кусок сохраняется как lead.
   * Автостоп отсчитывается от новой нулевой точки.
   */
  markStart(): void {
    if (!this.active) return;
    const sr = audioContext().sampleRate;
    const want = Math.floor(PRE_ROLL_SEC * sr);
    // Запас берём из всего пойманного: и до start(), и за время старта плеера
    const lead = tailOf([...this.preRoll, ...this.chunks], want);
    this.chunks = lead.length > 0 ? [lead] : [];
    this.totalSamples = lead.length;
    this.leadSamples = lead.length;
    this.windowEnded = false;
    this.maxSamples = lead.length + this.windowSamples + this.tailSamples;
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
      leadSec: this.leadSamples / ctx.sampleRate,
    };
  }

  get isRecording(): boolean {
    return this.active;
  }

  private teardown(): void {
    this.active = false;
    this.preRoll = [];
    this.preRollSamples = 0;
    this.worklet?.port.close();
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.worklet = null;
    this.source = null;
  }

  /** Полностью освобождает микрофон (например, при выходе из игры). */
  dispose(): void {
    this.release();
  }

  /** Отпускает поток и граф: следующий init() откроет устройство заново. */
  private release(): void {
    this.teardown();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.openedDeviceId = undefined;
    this.peakSinceRead = 0;
  }
}

/**
 * Окно самой реплики внутри записи — без запаса с обоих концов. Волна и
 * оценка работают по нему: игрок должен видеть и получать балл за то, что
 * попало в хронометраж персонажа, а в монтаж уходит запись целиком.
 */
export function takeWindow(rec: Recording, clipDurationSec: number): Float32Array {
  const from = Math.round(rec.leadSec * rec.sampleRate);
  const to = Math.min(rec.samples.length, from + Math.round(clipDurationSec * rec.sampleRate));
  return rec.samples.subarray(Math.min(from, rec.samples.length), Math.max(from, to));
}

/**
 * Момент последнего звука в записи (сек). Нужен монтажу: за концом видео он
 * ждёт хвост реплики, и ждать две секунды тишины, если игрок замолчал вовремя,
 * незачем — иначе ролик всегда заканчивался бы фризом последнего кадра.
 */
export function voiceEndSec(rec: Recording): number {
  const win = Math.max(1, Math.round(0.02 * rec.sampleRate));
  const threshold = 0.01; // ≈ −40 dBFS: тише этого в хвосте только шум
  for (let end = rec.samples.length; end > 0; end -= win) {
    const from = Math.max(0, end - win);
    let sumSq = 0;
    for (let i = from; i < end; i++) sumSq += rec.samples[i] * rec.samples[i];
    if (Math.sqrt(sumSq / (end - from)) > threshold) return end / rec.sampleRate;
  }
  return 0;
}

/**
 * До какой секунды записи проигрывать реплику (переслушка, финальный микс,
 * WAV-рендер — везде одна и та же граница). Никогда не короче хронометража
 * оригинальной реплики: `voiceEndSec` определяет конец речи по громкости, а
 * тихую, затухающую концовку (актёр роняет последнее слово) легко спутать с
 * шумом и обрубить раньше времени. Громкость может только УДЛИНИТЬ
 * воспроизведение — если игрок договорил позже, — но не укоротить его.
 */
export function playbackEndSec(rec: Recording, clipDurationSec: number): number {
  return Math.max(rec.leadSec + clipDurationSec, voiceEndSec(rec));
}

/** Та же запись, обрезанная до окна реплики, — для оценки дубля. */
export function windowedRecording(rec: Recording, clipDurationSec: number): Recording {
  const samples = takeWindow(rec, clipDurationSec);
  return {
    samples,
    sampleRate: rec.sampleRate,
    durationSec: samples.length / rec.sampleRate,
    leadSec: 0,
  };
}

/** Переводит моно-запись в AudioBuffer для воспроизведения/монтажа. */
export function recordingToBuffer(rec: Recording): AudioBuffer {
  const ctx = audioContext();
  const buffer = ctx.createBuffer(1, Math.max(rec.samples.length, 1), rec.sampleRate);
  buffer.copyToChannel(rec.samples as Float32Array<ArrayBuffer>, 0);
  return buffer;
}
