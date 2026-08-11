/**
 * Воспроизведение dub_video.ogv (Theora).
 * Современные браузеры Theora уже не играют нативно — основной путь ogv.js (wasm);
 * нативный <video> остаётся для браузеров, где Theora ещё жива.
 * Обе реализации приводятся к общему интерфейсу DubVideoPlayer.
 */
import { audioContext } from "../audio/context";

export interface DubVideoPlayer {
  /** DOM-элемент для вставки на страницу (video или canvas-плеер ogv.js). */
  readonly element: HTMLElement;
  readonly duration: number;
  currentTime: number;
  muted: boolean;
  play(): Promise<void>;
  pause(): void;
  readonly paused: boolean;
  readonly videoWidth: number;
  readonly videoHeight: number;
  /** Источник кадров для отрисовки на canvas при экспорте. */
  frameSource(): CanvasImageSource;
  onEnded(cb: () => void): void;
  onTimeUpdate(cb: () => void): void;
  dispose(): void;
}

let theoraSupported: boolean | null = null;

export function nativeTheoraSupported(): boolean {
  if (theoraSupported === null) {
    const v = document.createElement("video");
    theoraSupported = v.canPlayType('video/ogg; codecs="theora,vorbis"') !== "";
  }
  return theoraSupported;
}

/**
 * kind "native" — mp4/webm, играем нативным <video> (аппаратный декодер).
 * kind "ogv" — Theora: нативно, если браузер ещё умеет, иначе ogv.js (wasm).
 */
export async function createVideoPlayer(
  videoBlob: Blob,
  kind: "native" | "ogv" = "ogv"
): Promise<DubVideoPlayer> {
  if (kind === "native" || nativeTheoraSupported()) return createNativePlayer(videoBlob);
  return createOgvPlayer(videoBlob);
}

function createNativePlayer(blob: Blob): Promise<DubVideoPlayer> {
  const video = document.createElement("video");
  video.playsInline = true;
  video.preload = "auto";
  const url = URL.createObjectURL(blob);
  video.src = url;

  const player: DubVideoPlayer = {
    element: video,
    get duration() { return video.duration || 0; },
    get currentTime() { return video.currentTime; },
    set currentTime(t: number) { video.currentTime = t; },
    get muted() { return video.muted; },
    set muted(m: boolean) { video.muted = m; },
    play: () => video.play(),
    pause: () => video.pause(),
    get paused() { return video.paused; },
    get videoWidth() { return video.videoWidth; },
    get videoHeight() { return video.videoHeight; },
    frameSource: () => video,
    onEnded: (cb) => video.addEventListener("ended", cb),
    onTimeUpdate: (cb) => video.addEventListener("timeupdate", cb),
    dispose: () => {
      video.pause();
      video.remove(); // иначе старый плеер останется в слоте и перекроет новый
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    },
  };

  return new Promise((resolve, reject) => {
    video.addEventListener("loadedmetadata", () => resolve(player), { once: true });
    video.addEventListener("error", () => reject(new Error("Не удалось открыть dub_video.ogv")), {
      once: true,
    });
  });
}

async function createOgvPlayer(blob: Blob): Promise<DubVideoPlayer> {
  const ogv = (await import("ogv")) as any;
  // Wasm-файлы ogv.js копируются в public/ogv скриптом postinstall
  ogv.OGVLoader.base = `${import.meta.env.BASE_URL}ogv`;
  const OGVPlayer = ogv.OGVPlayer;
  // Свой AudioContext обязателен: внутренний контекст ogv.js создаётся вне
  // пользовательского жеста и навсегда виснет в suspended — видео тогда
  // застревает на первом кадре (ogv.js ведёт видео по аудиочасам).
  const video = new OGVPlayer({ audioContext: audioContext() }) as any;
  const url = URL.createObjectURL(blob);
  video.src = url;

  const player: DubVideoPlayer = {
    element: video,
    get duration() { return video.duration || 0; },
    get currentTime() { return video.currentTime; },
    set currentTime(t: number) { video.currentTime = t; },
    get muted() { return video.muted; },
    set muted(m: boolean) { video.muted = m; },
    play: () => {
      audioContext(); // resume, если контекст задремал
      return Promise.resolve(video.play());
    },
    pause: () => video.pause(),
    get paused() { return video.paused; },
    get videoWidth() { return video.videoWidth || 640; },
    get videoHeight() { return video.videoHeight || 360; },
    // OGVPlayer рендерит в canvas внутри элемента <ogvjs>
    frameSource: () =>
      (video._canvas ?? video.querySelector?.("canvas") ?? video) as CanvasImageSource,
    onEnded: (cb) => video.addEventListener("ended", cb),
    onTimeUpdate: (cb) => video.addEventListener("timeupdate", cb),
    dispose: () => {
      try { video.pause(); } catch { /* ogv.js бывает капризен при закрытии */ }
      video.remove?.(); // убираем из слота, чтобы не перекрывал следующий пак
      URL.revokeObjectURL(url);
    },
  };

  return new Promise((resolve) => {
    video.addEventListener("loadedmetadata", () => resolve(player), { once: true });
    // ogv.js не всегда стреляет loadedmetadata до play — подстраховка
    setTimeout(() => resolve(player), 4000);
  });
}
