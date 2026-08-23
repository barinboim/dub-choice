/**
 * Пак в формате оригинальной игры — The Choicer Voicer.
 *
 * TCV написана на Godot 3, а Godot 3 из видео умеет ровно один кодек —
 * Theora в контейнере .ogv; из звука — Vorbis (.ogg) и WAV. Наши паки
 * собираются в MP4 + WAV: браузеры Theora выбросили (CLAUDE.md, «Грабли»),
 * и держать её в основном формате значило бы возить ogv.js всем игрокам.
 * Поэтому совместимость с TCV — отдельная операция по требованию, а не
 * формат по умолчанию.
 *
 * Пережимаем **в браузере**, через ffmpeg.wasm. Сервер отпадает не по
 * вкусовым причинам: VPS у проекта одноядерный, с 700 МБ памяти и без
 * ffmpeg вовсе — Theora там кодировалась бы часами и роняла бы заодно
 * аналитику с приёмником обратной связи. Ядро ffmpeg (32 МБ wasm) едет из
 * R2 и ложится в Cache Storage — ровно тем же способом, что веса spleeter
 * в `studio/separate.ts`, и по той же причине: второй заход не должен
 * стоить игроку тех же мегабайт.
 *
 * Однопоточная сборка ядра выбрана намеренно: многопоточной нужны
 * COOP/COEP, а мы их не ставим нигде (docs/STUDIO_WEB_PLAN.md) — на
 * главной странице `COEP: require-corp` сломал бы галерею паков из R2.
 *
 * Референс формата — фанатский пак `star_wars_-_you_turned_her_against_me`
 * из родительской папки: видео 1080p Theora **без звуковой дорожки**
 * (проверено ffprobe), звук отдельно в `_backing_track.ogg` и в репликах
 * `NN_name.ogg`, кадры `NN_name.png`, всё внутри одной подпапки архива.
 */
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { PACKS_BASE, formatSize } from "./preloaded";
import type { MsgKey } from "../i18n";
import type { DubClip, DubPack } from "./types";

/** Куда доложить о ходе работы: ключ подписи и доля от нуля до единицы. */
export type TcvProgress = (
  stage: MsgKey,
  ratio: number,
  vars?: Record<string, string | number>
) => void;

/**
 * Ядро ffmpeg — не в git и не в бандле: 32 МБ wasm. В проде едет из R2
 * (`ffmpeg/` в том же бакете, что паки и веса студии), в деве его отдаёт
 * middleware из vite.config.ts прямо из node_modules.
 *
 * Лежит там **esm-сборка ядра**, хотя все примеры ffmpeg.wasm показывают
 * umd: воркер @ffmpeg/ffmpeg поднимается модульным, `importScripts` в
 * таком недоступен, и запасной путь с динамическим `import()` берёт
 * только настоящий ES-модуль. С umd выходило «failed to import
 * ffmpeg-core.js», а до правки `optimizeDeps` — вообще вечное молчание.
 */
const FFMPEG_BASE = import.meta.env.PROD ? `${PACKS_BASE}ffmpeg/` : "/ffmpeg/";
const FFMPEG_CACHE = "studio-ffmpeg-v1";

/**
 * Дальше этого браузеру не хватит памяти: ffmpeg.wasm держит и вход, и
 * выход в MEMFS, то есть целиком в оперативной памяти вкладки, а wasm32
 * упирается в 4 ГБ адресного пространства (на деле браузеры отдают меньше).
 * Честнее отказать сразу, чем уронить вкладку на десятой минуте.
 */
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;

/** Theora: 0–10, шестёрка — компромисс между весом и артефактами. */
const VIDEO_QUALITY = "6";
/** Vorbis: q4 ≈ 128 кбит/с. У референсного пака фон ехал на 112. */
const AUDIO_QUALITY = "4";

/**
 * Кадр не больше 1280×720. Оригинальная игра берёт и 1080p (референсный
 * пак именно такой), но кодирует его тут браузер: на 1080p ожидание
 * вырастает втрое, а разницы на экране с субтитрами почти нет.
 * `force_original_aspect_ratio=decrease` вписывает кадр в рамку, не
 * растягивая; `min(...)` не даёт растянуть то, что и так меньше.
 */
const SCALE_FILTER =
  "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";

async function cachedBlobUrl(url: string, onBytes?: (loaded: number, total: number) => void): Promise<string> {
  let bytes: ArrayBuffer;
  try {
    const cache = await caches.open(FFMPEG_CACHE);
    const hit = await cache.match(url);
    if (hit) {
      bytes = await hit.arrayBuffer();
      onBytes?.(bytes.byteLength, bytes.byteLength);
    } else {
      bytes = await download(url, onBytes);
      await cache.put(url, new Response(bytes.slice(0)));
    }
  } catch (err) {
    // Cache Storage бывает недоступен (приватный режим Safari, отказ в
    // квоте) — это повод скачать заново, а не отменять конвертацию.
    console.warn("[tcv] кэш ядра ffmpeg недоступен:", err);
    bytes = await download(url, onBytes);
  }
  const type = url.endsWith(".wasm") ? "application/wasm" : "text/javascript";
  return URL.createObjectURL(new Blob([bytes], { type }));
}

async function download(url: string, onBytes?: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ffmpeg ${res.status}`);
  const total = Number(res.headers.get("Content-Length") || 0);
  if (!res.body || !total) return res.arrayBuffer();
  // Качаем потоком только ради полоски: 32 МБ на средней линии — это
  // полминуты молчания, которое читается как «зависло».
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onBytes?.(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}

/**
 * Экземпляр переживает вызовы: ядро уже в памяти, и второй пак не должен
 * ждать ни закачки, ни инициализации.
 */
let engine: Promise<FFmpeg> | null = null;

/**
 * Доля общей полоски, отданная закачке и старту ядра. Дальше идёт Theora,
 * и она начинается ровно с этой отметки: полоска, добежавшая до конца на
 * закачке и откатившаяся назад, врёт грубее, чем полоска, которая просто
 * стоит.
 */
const ENGINE_TO = 0.15;

const MB = 1024 * 1024;

export function loadEngine(onProgress: TcvProgress): Promise<FFmpeg> {
  if (engine) return engine;
  engine = (async () => {
    const [coreURL, wasmURL] = await Promise.all([
      cachedBlobUrl(`${FFMPEG_BASE}ffmpeg-core.js`),
      // Мегабайты в подписи, а не одна полоска: 32 МБ на средней линии —
      // это полминуты, и подпись без цифр читается как «зависло». Ту же
      // ошибку уже проходили на весах разделения (studio/pipeline.ts).
      cachedBlobUrl(`${FFMPEG_BASE}ffmpeg-core.wasm`, (loaded, total) =>
        onProgress("tcvStageEngineBytes", total ? (loaded / total) * ENGINE_TO * 0.9 : 0, {
          done: (loaded / MB).toFixed(0),
          total: (total / MB).toFixed(0),
        })
      ),
    ]);
    // Ядро скачано, но ещё не поднято: инициализация wasm — это секунды,
    // и на них подпись должна смениться, иначе выглядит как застрявшая
    // закачка «32 из 32».
    onProgress("tcvStageEngineStart", ENGINE_TO * 0.9);
    const ffmpeg = new FFmpeg();
    await ffmpeg.load({ coreURL, wasmURL });
    return ffmpeg;
  })().catch((err) => {
    engine = null; // сорвавшаяся закачка не должна отравить следующую попытку
    throw err;
  });
  return engine;
}

/**
 * Резервная сборка MP4 премьеры мимо живого captureStream/MediaRecorder:
 * на части устройств скрытый экспорт-канвас не отдаёт кадры (см. CLAUDE.md,
 * баг «152 КБ без видео» — вероятно связано с `display:none` у export-canvas
 * и throttling'ом rAF/энкодера в фоне на мобильных). Здесь видео и звук не
 * зависят от живого воспроизведения: звук уже офлайн-смикширован тем же
 * путём, что и «Скачать аудио» (OfflineAudioContext), видео — исходный файл
 * пака как есть. Видео почти всегда приходится перекодировать (вход может
 * быть Theora/WebM, MP4 не унесёт), звук — в AAC. `padSec` — на сколько
 * дольше звука видео (хвост последней реплики, TAIL_SEC): без этого
 * последний кадр обрывался бы до того, как дозвучит хвост.
 */
export async function muxMixedAudioVideo(
  video: Blob,
  audioWav: Blob,
  padSec: number,
  onProgress: TcvProgress
): Promise<Blob> {
  if (video.size > MAX_VIDEO_BYTES) {
    throw new Error(`Видео весит ${formatSize(video.size)} — перекодировать такое в браузере не выйдет`);
  }
  const ffmpeg = await loadEngine(onProgress);
  onProgress("mp4FallbackStageMux", ENGINE_TO);
  const inVideoName = `in.${extOf(video, "mp4")}`;
  const inAudioName = "audio.wav";
  const outName = "out.mp4";
  await ffmpeg.writeFile(inVideoName, new Uint8Array(await video.arrayBuffer()));
  await ffmpeg.writeFile(inAudioName, new Uint8Array(await audioWav.arrayBuffer()));
  // Копия потока быстрее и без потерь, но только когда вход уже MP4 и не
  // нужно дорисовывать хвост фильтром (фильтр требует перекодирования).
  const canCopy = inVideoName.endsWith(".mp4") && padSec < 0.05;
  const args = ["-i", inVideoName, "-i", inAudioName, "-map", "0:v:0", "-map", "1:a:0"];
  if (canCopy) {
    args.push("-c:v", "copy");
  } else {
    if (padSec >= 0.05) args.push("-vf", `tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)}`);
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20");
  }
  args.push("-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outName);
  try {
    const code = await ffmpeg.exec(args);
    if (code !== 0) throw new Error(`ffmpeg завершился с кодом ${code}`);
    onProgress("mp4FallbackStageDone", 0.95);
    const data = await ffmpeg.readFile(outName);
    if (typeof data === "string") throw new Error("ffmpeg вернул текст вместо видео");
    return new Blob([data.slice().buffer], { type: "video/mp4" });
  } finally {
    await ffmpeg.deleteFile(inVideoName).catch(() => {});
    await ffmpeg.deleteFile(inAudioName).catch(() => {});
    await ffmpeg.deleteFile(outName).catch(() => {});
  }
}

function extOf(blob: Blob, fallback: string): string {
  const type = blob.type.toLowerCase();
  if (type.includes("webm")) return "webm";
  if (type.includes("ogg") || type.includes("ogv")) return "ogv";
  if (type.includes("mp4") || type.includes("quicktime")) return "mp4";
  if (type.includes("wav")) return "wav";
  if (type.includes("mpeg")) return "mp3";
  return fallback;
}

/** Один прогон ffmpeg: файл на вход, файл на выход, промежуточные стираем. */
async function run(
  ffmpeg: FFmpeg,
  input: Blob,
  inName: string,
  outName: string,
  args: string[]
): Promise<Blob> {
  await ffmpeg.writeFile(inName, new Uint8Array(await input.arrayBuffer()));
  try {
    const code = await ffmpeg.exec(["-i", inName, ...args, outName]);
    if (code !== 0) throw new Error(`ffmpeg завершился с кодом ${code} на ${outName}`);
    const data = await ffmpeg.readFile(outName);
    if (typeof data === "string") throw new Error(`ffmpeg вернул текст вместо ${outName}`);
    return new Blob([data.slice().buffer], { type: outName.endsWith(".ogv") ? "video/ogg" : "audio/ogg" });
  } finally {
    // MEMFS — это оперативная память вкладки: не подчистить за видео
    // значит унести с собой сотню мегабайт до конца сеанса.
    await ffmpeg.deleteFile(inName).catch(() => {});
    await ffmpeg.deleteFile(outName).catch(() => {});
  }
}

/**
 * Высота кадра-превью в паке для TCV. У референсного пака кадры 346×320 по
 * 110 КБ — и это не случайность: PNG для фотографии формат разорительный,
 * а показывается кадр превьюшкой. Наши 854×480 в PNG весят по полмегабайта,
 * и на паке из 17 реплик кадры перевешивали бы само видео. 360 держит их в
 * тех же габаритах, что и у настоящих паков оригинальной игры.
 */
const TCV_FRAME_HEIGHT = 360;

/**
 * JPEG → PNG средствами самого браузера: гонять ради этого ffmpeg незачем,
 * а PNG нужен, потому что кадры фанатских паков к оригинальной игре лежат
 * именно в нём (референс) — и это единственный формат, в котором они точно
 * прочитаются.
 */
async function toPng(image: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(image);
  try {
    const scale = Math.min(1, TCV_FRAME_HEIGHT / bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return png ?? image;
  } finally {
    bitmap.close();
  }
}

/**
 * Пак → пак в кодеках оригинальной игры. Возвращает новый DubPack: блобы
 * заменены, метаданные (тексты, тайминги, персонажи) остаются как есть —
 * раскладывать их по файлам будет `serializePackToFiles` с расширениями
 * `ogg`/`png`.
 */
export async function packToTcv(pack: DubPack, onProgress: TcvProgress): Promise<DubPack> {
  if (pack.video.size > MAX_VIDEO_BYTES) {
    throw new Error(`tcvTooBig:${formatSize(pack.video.size)}`);
  }

  const ffmpeg = await loadEngine(onProgress);

  // Вес долей на глаз, но по делу: Theora съедает почти всё время, звук и
  // упаковка — секунды. Полоска, стоящая на 5 % три минуты, врёт сильнее.
  const VIDEO_FROM = ENGINE_TO;
  const VIDEO_TO = 0.85;
  const AUDIO_TO = 0.97;

  const onFfmpegProgress = ({ progress }: { progress: number }): void => {
    const clamped = Math.max(0, Math.min(1, progress));
    onProgress("tcvStageVideo", VIDEO_FROM + clamped * (VIDEO_TO - VIDEO_FROM));
  };
  ffmpeg.on("progress", onFfmpegProgress);

  try {
    onProgress("tcvStageVideo", VIDEO_FROM);
    // `-an` намеренно: у референсного пака в .ogv нет звуковой дорожки
    // вовсе — оригинальная игра берёт звук из _backing_track и из реплик,
    // а дорожка внутри видео звучала бы поверх дубля вторым слоем.
    const video = await run(ffmpeg, pack.video, `in.${extOf(pack.video, "mp4")}`, "dub_video.ogv", [
      "-c:v", "libtheora",
      "-q:v", VIDEO_QUALITY,
      "-vf", SCALE_FILTER,
      "-an",
    ]);

    ffmpeg.off("progress", onFfmpegProgress);

    // Звук: фон, оригинальная дорожка и каждая реплика — в Vorbis.
    const audioJobs: { blob: Blob; put: (out: Blob) => void }[] = [];
    let backingTrack = pack.backingTrack;
    let originalTrack = pack.originalTrack;
    if (backingTrack) audioJobs.push({ blob: backingTrack, put: (out) => (backingTrack = out) });
    if (originalTrack) audioJobs.push({ blob: originalTrack, put: (out) => (originalTrack = out) });

    const clips: DubClip[] = pack.clips.map((clip) => ({ ...clip }));
    for (const clip of clips) {
      audioJobs.push({ blob: clip.audio, put: (out) => (clip.audio = out) });
    }

    for (const [i, job] of audioJobs.entries()) {
      onProgress("tcvStageAudio", VIDEO_TO + ((AUDIO_TO - VIDEO_TO) * i) / audioJobs.length);
      job.put(
        await run(ffmpeg, job.blob, `a${i}.${extOf(job.blob, "wav")}`, `a${i}.ogg`, [
          "-c:a", "libvorbis",
          "-q:a", AUDIO_QUALITY,
        ])
      );
    }

    onProgress("tcvStageZip", AUDIO_TO);
    for (const clip of clips) {
      if (clip.image) clip.image = await toPng(clip.image);
    }
    const icon = pack.icon ? await toPng(pack.icon) : null;

    return { ...pack, video, videoKind: "ogv", backingTrack, originalTrack, clips, icon };
  } finally {
    ffmpeg.off("progress", onFfmpegProgress);
  }
}

/** Расширения, под которыми пак TCV раскладывается в архиве. */
export const TCV_ZIP_OPTIONS = { audioExt: "ogg", imageExt: "png", iconExt: "png" } as const;
