/**
 * Видео → аудиобуфер и кадры-превью реплик.
 *
 * decodeAudioData умеет доставать звук прямо из контейнера видео (mp4/webm
 * с H.264+AAC — да, mkv/avi — нет, см. docs/STUDIO_WEB_PLAN.md, «Грабли»):
 * отдельно демультиплексировать не нужно.
 */
import { audioContext } from "../audio/context";
import { note } from "../journey";

export interface LoadedMedia {
  audioBuffer: AudioBuffer;
  durationSec: number;
}

/**
 * decodeAudioData на слабом мобильном декодере может не резолвиться и не
 * реджектиться очень долго — тот же класс тихого зависания, что уже разбирали
 * с воркером ffmpeg.wasm (CLAUDE.md), только на уровне нативного Web Audio.
 * Репорт от 2026-08-22: «Закадр» на Android замолчал именно на этом шаге,
 * без единой ошибки в консоли. Таймаут не чинит декодер, но превращает
 * бесконечную тишину в понятную ошибку с этим фактом внутри отчёта.
 */
const DECODE_TIMEOUT_MS = 30000;

/** Подключение <video> к blob-URL — тоже событие, которое теоретически может не прийти вовсе. */
const ATTACH_TIMEOUT_MS = 15000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export async function loadVideoFile(file: File): Promise<LoadedMedia> {
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch (err) {
    // Большой файл на телефоне может просто не влезть в память.
    throw new Error(`не удалось прочитать файл (${describe(err)})`);
  }
  try {
    const audioBuffer = await withTimeout(
      audioContext().decodeAudioData(bytes.slice(0)),
      DECODE_TIMEOUT_MS,
      `таймаут ${DECODE_TIMEOUT_MS / 1000} с`
    );
    return { audioBuffer, durationSec: audioBuffer.duration };
  } catch (err) {
    // Раньше здесь терялась настоящая причина: любой сбой декодирования
    // подменялся общим «не удалось прочитать это видео», и понять, что
    // именно сломалось (кодек, память, битый файл, таймаут), было невозможно.
    throw new Error(`звук видео не декодировался: ${describe(err)}`);
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** Подключает видео к <video> и ждёт метаданных — нужны для seek-захвата кадров. */
export function attachVideoSource(video: HTMLVideoElement, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
      fn();
    };
    const onLoaded = () => finish(resolve);
    const onError = () =>
      // Формат мы приняли, а плеер его не открыл — почти всегда это HEVC
      // в браузере, который его не умеет.
      finish(() => reject(new Error("studioNoCodec")));
    const timer = window.setTimeout(
      () => finish(() => reject(new Error(`подключение видео не ответило за ${ATTACH_TIMEOUT_MS / 1000} с`))),
      ATTACH_TIMEOUT_MS
    );
    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("error", onError);
    video.src = url;
  });
}

/**
 * Кадр без перемотки не ждём дольше этого: `seeked` может не прийти вовсе
 * (битый индекс, кодек без ключевого кадра рядом). Пак без превью соберётся,
 * зависшая на минуты студия — нет.
 */
const SEEK_TIMEOUT_MS = 5000;

/**
 * Высота кадра-превью — как у наших паков (scripts/dubpack/make_frames.py).
 * Рисовать в канвас 1920×1080, чтобы потом показать картинку 64 px шириной,
 * незачем: замер на 4,5-минутном ролике дал 4,7 с на кадр, и превью выходили
 * дороже разделения голоса.
 */
const THUMB_HEIGHT = 480;

/** Кадр видео в момент atSec — как canvas.toBlob, для превью реплики. */
export function captureFrame(video: HTMLVideoElement, atSec: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    let timer = 0;
    let settled = false;
    const finish = (blob: Blob | null): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener("seeked", grab);
      resolve(blob);
    };
    function grab(): void {
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        finish(null);
        return;
      }
      const scale = Math.min(1, THUMB_HEIGHT / video.videoHeight);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const g = canvas.getContext("2d");
      if (!g) {
        finish(null);
        return;
      }
      g.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => finish(b), "image/jpeg", 0.82);
    }

    timer = window.setTimeout(() => {
      // Отличаем от штатного null (нулевые размеры/canvas): это тот самый
      // подозреваемый из репорта 2026-08-22 — seeked, который не пришёл.
      note(`захват кадра: seeked не пришёл за ${SEEK_TIMEOUT_MS / 1000} с`);
      finish(null);
    }, SEEK_TIMEOUT_MS);
    const target = Math.max(0, atSec);
    // Перемотка «на месте» события seeked не даёт — браузер считает, что делать
    // нечего. Раньше промис в этом случае не резолвился никогда, и вся сборка
    // превью вставала намертво (первая реплика часто начинается там, где плеер
    // уже стоит). Снимаем кадр сразу.
    if (Math.abs(video.currentTime - target) < 1e-3 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      grab();
      return;
    }
    video.addEventListener("seeked", grab);
    video.currentTime = target;
  });
}

/**
 * Своя картинка для иконки пака → тот же формат, что и кадр видео
 * (captureFrame): высота не больше THUMB_HEIGHT, JPEG. Игрок мог принести
 * что угодно — PNG на всю ширину экрана, скриншот телефона, — и без
 * пересжатия такой файл раздувал бы пак архивом ради одной иконки.
 */
export async function imageFileToThumb(file: File): Promise<Blob | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const scale = Math.min(1, THUMB_HEIGHT / bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const g = canvas.getContext("2d");
    if (!g) return null;
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.82));
  } finally {
    bitmap.close();
  }
}

export async function captureThumbnails(
  video: HTMLVideoElement,
  clips: { start: number }[],
  onProgress?: (ratio: number) => void
): Promise<(Blob | null)[]> {
  const out: (Blob | null)[] = [];
  for (const clip of clips) {
    out.push(await captureFrame(video, clip.start));
    onProgress?.(out.length / clips.length);
  }
  return out;
}

/** spleeter обучен на 44100 Гц: decodeAudioData отдаёт частоту устройства (44100 или 48000). */
export async function resampleTo44100(buffer: AudioBuffer): Promise<AudioBuffer> {
  if (buffer.sampleRate === 44100) return buffer;
  const offline = new OfflineAudioContext(
    buffer.numberOfChannels,
    Math.ceil(buffer.duration * 44100),
    44100
  );
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();
  return offline.startRendering();
}

/** Whisper ест 16 кГц моно — микс каналов и ресемплинг через OfflineAudioContext (со сглаживанием). */
export async function toMono16k(buffer: AudioBuffer): Promise<Float32Array> {
  const offline = new OfflineAudioContext(1, Math.ceil(buffer.duration * 16000), 16000);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

export function channelsToBuffer(channels: Float32Array[], rate: number): AudioBuffer {
  const buffer = new AudioBuffer({ length: channels[0].length, numberOfChannels: channels.length, sampleRate: rate });
  channels.forEach((data, ch) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, ch));
  return buffer;
}

/**
 * Проигрывает только одну реплику: плеер встаёт на её конце сам. Живёт здесь,
 * а не в timeline.ts, потому что нужен обоим — и панели справа, и кнопке на
 * самой пилюле (импорт из timeline.ts в lanes.ts дал бы цикл).
 */
let stopAtSec = 0;
export async function playClipRange(video: HTMLVideoElement, startSec: number, endSec: number): Promise<void> {
  stopAtSec = endSec;
  video.currentTime = startSec;
  const onTime = (): void => {
    if (video.currentTime >= stopAtSec) {
      video.pause();
      video.removeEventListener("timeupdate", onTime);
    }
  };
  video.addEventListener("timeupdate", onTime);
  await video.play().catch(() => undefined);
}

/**
 * Отдельная звуковая дорожка, идущая синхронно с видео.
 *
 * Нужна для паков, собранных нашим пайплайном: их `dub_video.mp4` идёт БЕЗ
 * аудиодорожки, и открытый на редактуру пак играл немым — притом что звук
 * в паке есть, просто отдельными файлами (`_original_track`).
 */
let syncWired = false;
export function attachSyncedAudio(video: HTMLVideoElement, audio: HTMLAudioElement, url: string | null): void {
  if (!url) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    return;
  }
  audio.src = url;

  if (syncWired) return;
  syncWired = true;
  // Слушатели вешаются через addEventListener: `video.onplay` и соседей уже
  // занимает таймлайн (lanes.ts), присваивание затёрло бы одно другим.
  const align = (): void => {
    if (!audio.src) return;
    if (Math.abs(audio.currentTime - video.currentTime) > 0.12) audio.currentTime = video.currentTime;
  };
  video.addEventListener("play", () => {
    if (!audio.src) return;
    align();
    void audio.play().catch(() => undefined);
  });
  video.addEventListener("pause", () => audio.pause());
  video.addEventListener("seeking", align);
  video.addEventListener("seeked", align);
  video.addEventListener("timeupdate", align);
  video.addEventListener("ratechange", () => {
    audio.playbackRate = video.playbackRate;
  });
}
