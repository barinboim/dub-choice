/** Встроенные dub-паки, доступные сразу с главного экрана. */

export interface PreloadedPack {
  id: string;
  /** Названия паков — имена собственные, не переводятся. */
  title: string;
  /** Пути внутри public/. Файлы качаются по порядку и склеиваются:
   *  GitHub не принимает файлы >100 МБ. */
  paths: string[];
  /** Превью пака (маленькая иконка, лежит в public/pack-icons). */
  icon: string;
  sizeBytes: number;
  /** Значки на карточке в галерее, например "18+". */
  tags?: string[];
}

/**
 * В продакшене паки качаются с raw.githubusercontent.com: CDN GitHub Pages
 * отдаёт крупные файлы мучительно медленно (десятки КБ/с), а raw — быстро
 * и с CORS. В dev-режиме файлы берутся с локального dev-сервера.
 */
const PACKS_BASE = import.meta.env.PROD
  ? "https://raw.githubusercontent.com/barinboim/dub-choice/main/public/"
  : "";

export const PRELOADED_PACKS: PreloadedPack[] = [
  {
    id: "hpowl",
    title: "Гарри Поттер — Я вам не сова!",
    paths: ["packs/hpowl.zip"],
    icon: "pack-icons/hpowl.png",
    sizeBytes: 10_789_652,
  },
  {
    id: "slonik",
    title: "Зелёный слоник — Сколько истребителей?",
    paths: ["packs/slonik.zip"],
    icon: "pack-icons/slonik.png",
    sizeBytes: 26_593_370,
    tags: ["18+"],
  },
  {
    id: "starwars",
    title: "Star Wars — You Turned Her Against Me",
    paths: ["packs/starwars.zip"],
    icon: "pack-icons/starwars.png",
    sizeBytes: 10_093_767,
  },
  {
    id: "lotr",
    title: "LOTR — Bridge of Khazad-dûm",
    paths: ["packs/lotr.zip"],
    icon: "pack-icons/lotr.png",
    sizeBytes: 11_196_401,
  },
  {
    id: "breakingbad",
    title: "Breaking Bad — I Am the Danger",
    paths: ["packs/breakingbad.zip"],
    icon: "pack-icons/breakingbad.png",
    sizeBytes: 14_850_856,
  },
  {
    id: "shrek",
    title: "Shrek the Third — Pinocchio Tries to Lie",
    paths: ["packs/shrek.zip"],
    icon: "pack-icons/shrek.png",
    sizeBytes: 17_869_702,
  },
  {
    id: "harrypotter",
    title: "Harry Potter — The Duel",
    paths: ["packs/harrypotter.zip"],
    icon: "pack-icons/harrypotter.png",
    sizeBytes: 14_798_859,
  },
];

export function packUrls(pack: PreloadedPack): string[] {
  return pack.paths.map((p) => PACKS_BASE + p);
}

/** Скачивает файлы по порядку, склеивает и отдаёт общий прогресс 0..1. */
export async function fetchWithProgress(
  urls: string[],
  expectedSize: number,
  onProgress: (ratio: number) => void
): Promise<Blob> {
  const chunks: BlobPart[] = [];
  let received = 0;
  for (const url of urls) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) {
      const blob = await res.blob();
      chunks.push(blob);
      received += blob.size;
      continue;
    }
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value as BlobPart);
      received += (value as Uint8Array).length;
      if (expectedSize > 0) onProgress(Math.min(received / expectedSize, 1));
    }
  }
  onProgress(1);
  return new Blob(chunks);
}

export function formatSize(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}
