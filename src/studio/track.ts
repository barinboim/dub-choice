/**
 * События студии — та же воронка, что у игры (`pack-select` → `dub-start`
 * → `dub-complete`), только про редактор паков.
 *
 * Зачем: студия гоняет тяжёлый счёт на чужом железе, и три вопроса, от
 * которых зависит судьба фичи, отвечаются без единого опроса — где
 * отваливаются, на чём упало, сколько ждали. Мнения на бете приходят
 * редко и от самых терпеливых, то есть от нерепрезентативных.
 *
 * Что НЕ отправляем: имена файлов, ссылки, текст ошибок. Только заранее
 * известные слаги — иначе в статистику утекут чужие данные.
 */
import { trackEvent } from "../analytics";

export type StudioSource = "file" | "link" | "zip" | "handoff";
export type StudioMode = "voiceover" | "dub";

/** Слаги ошибок: набор закрытый, свободного текста здесь быть не должно. */
export type StudioErrorSlug =
  | "bad-codec"
  | "decode-failed"
  | "no-clips"
  | "handoff-failed"
  | "build-failed"
  | "pack-read-failed"
  | "js";

export function trackStudioOpen(): void {
  trackEvent("studio-open");
}

export function trackSource(source: StudioSource): void {
  trackEvent(`studio-source/${source}`);
}

export function trackMode(mode: StudioMode): void {
  trackEvent(`studio-mode/${mode}`);
}

/** Редактор открылся — значит разбор дошёл до конца. */
export function trackReady(mode: StudioMode): void {
  trackEvent(`studio-ready/${mode}`);
}

export function trackBuild(mode: StudioMode): void {
  trackEvent(`studio-build/${mode}`);
}

export function trackStudioError(slug: StudioErrorSlug): void {
  trackEvent(`studio-error/${slug}`);
}

/**
 * Время обработки бакетами, а не числом: точная секунда в аналитике не
 * нужна, а вопрос «сколько людей реально дожидаются» — очень.
 */
export function trackDuration(mode: StudioMode, seconds: number): void {
  const bucket =
    seconds < 60 ? "0-1m" : seconds < 180 ? "1-3m" : seconds < 600 ? "3-10m" : "10m+";
  trackEvent(`studio-time/${mode}/${bucket}`);
}

/** Падения, которых мы не предусмотрели, — иначе о них никто не узнает. */
export function trackUncaught(): void {
  window.addEventListener("error", () => trackStudioError("js"));
  window.addEventListener("unhandledrejection", () => trackStudioError("js"));
}
