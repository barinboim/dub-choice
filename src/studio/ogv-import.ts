/**
 * Theora (.ogv) → нативно воспроизводимое видео для конвейера редактора.
 *
 * Конвейер студии (скраб таймлайна, захват кадров-превью в media.ts) весь
 * построен на нативном `<video>`/`decodeAudioData` — Theora браузеры не
 * понимают вовсе (CLAUDE.md, «Грабли»). Пережимаем реальным проигрыванием
 * через ogv.js (тот же декодер, что уже играет чужие TCV-паки в самой игре,
 * `video/player.ts`) + `canvas.captureStream` + `MediaRecorder` — тем же
 * приёмом, что уже пишет финальный ролик в `game/composer.ts`, только без
 * звука: у `dub_video.ogv` его и так нет (пайплайн TCV собирает видео с
 * `-an`, `pack/tcv.ts`), звук достаётся отдельно из дорожек пака
 * (`reopen.ts::decodePackAudio`).
 *
 * ffmpeg.wasm здесь намеренно не участвует: ядро в проекте собрано под
 * КОДИРОВАНИЕ в Theora/Vorbis (обратное направление, `pack/tcv.ts`), а не
 * под чтение — декодер в нём не проверен и мог не войти в сборку. ogv.js —
 * уже проверенный в проде декодер.
 *
 * Важно: перемотка (`currentTime =`) на этом декодере при быстрой/повторной
 * перемотке ломает кадр — эмпирически проверено на реальном фанатском паке
 * (1080p Theora): после seek картинка сыпется блочными артефактами и не
 * восстанавливается сама. Поэтому запись идёт строго линейным
 * проигрыванием с начала до конца — ни одного seek за весь процесс.
 */
import { audioContext } from "../audio/context";

export type OgvImportProgress = (ratio: number, elapsedSec: number) => void;

/** Тот же список форматов, что в game/composer.ts, но без аудиокодеков — звук сюда не пишем. */
const RECORDER_MIME =
  [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";

/** ogv.js не всегда стреляет loadedmetadata — тот же запасной путь, что в video/player.ts. */
const METADATA_TIMEOUT_MS = 8000;

export async function transcodeOgvToNative(
  videoBlob: Blob,
  onProgress: OgvImportProgress,
  /**
   * `player.duration` у ogv.js не готов сразу после loadedmetadata и,
   * проверено эмпирически, остаётся 0 ещё десятки секунд воспроизведения —
   * без запасной оценки полоска простаивает на стартовой отметке большую
   * часть прогона. Пак сам подсказывает грубую длину (последний таймкод
   * реплики) — этого достаточно для честного «примерно там-то».
   */
  estimatedDurationSec = 0
): Promise<Blob> {
  if (!RECORDER_MIME) throw new Error("studioOgvImportFailed");

  const ogv = (await import("ogv")) as any;
  ogv.OGVLoader.base = `${import.meta.env.BASE_URL}ogv`;
  const player = new ogv.OGVPlayer({ audioContext: audioContext() }) as any;
  const url = URL.createObjectURL(videoBlob);
  player.src = url;

  try {
    await new Promise<void>((resolve) => {
      player.addEventListener("loadedmetadata", () => resolve(), { once: true });
      setTimeout(() => resolve(), METADATA_TIMEOUT_MS);
    });

    const w = player.videoWidth || 1280;
    const h = player.videoHeight || 720;
    if (!w || !h) throw new Error("studioOgvImportFailed");

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const c2d = canvas.getContext("2d");
    if (!c2d) throw new Error("studioOgvImportFailed");

    return await new Promise<Blob>((resolve, reject) => {
      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, {
        mimeType: RECORDER_MIME,
        videoBitsPerSecond: 6_000_000,
      });
      const parts: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) parts.push(e.data);
      };

      let rafId = 0;
      let safetyTimer = 0;
      let settled = false;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        cancelAnimationFrame(rafId);
        clearTimeout(safetyTimer);
        try {
          player.pause?.();
        } catch {
          // ogv.js бывает капризен при остановке — не мешаем финалу из-за этого
        }
        if (err) reject(err);
        else resolve(new Blob(parts, { type: RECORDER_MIME }));
      };

      recorder.onstop = () => finish();
      recorder.onerror = () => finish(new Error("studioOgvImportFailed"));

      const stopSoon = () => {
        // Даём рекордеру дописать последний кусок перед остановкой.
        setTimeout(() => {
          if (recorder.state !== "inactive") recorder.stop();
        }, 100);
      };
      player.addEventListener("ended", stopSoon, { once: true });
      player.addEventListener("error", () => finish(new Error("studioOgvImportFailed")), { once: true });

      // player.duration сразу после loadedmetadata часто ещё 0 (проверено
      // эмпирически) — читать его нужно на каждый кадр, а не один раз до
      // цикла: иначе прогресс замирает на весь прогон, хотя запись идёт.
      const startedAt = performance.now();
      const draw = () => {
        c2d.drawImage(player._canvas ?? player.querySelector?.("canvas") ?? player, 0, 0, w, h);
        const dur = player.duration || estimatedDurationSec || 0;
        const elapsedSec = (performance.now() - startedAt) / 1000;
        onProgress(dur > 0 ? Math.min(0.98, player.currentTime / dur) : 0, elapsedSec);
        rafId = requestAnimationFrame(draw);
      };

      recorder.start(250);
      draw();
      // Длительность на момент старта могла быть ещё не известна — берём
      // с большим запасом (проверяется каждый кадр в draw, так что реальная
      // остановка по `ended` придёт раньше в подавляющем большинстве случаев).
      safetyTimer = window.setTimeout(stopSoon, 30 * 60 * 1000);
      void Promise.resolve(player.play()).catch(() => finish(new Error("studioOgvImportFailed")));
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
