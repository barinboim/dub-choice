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
    sizeBytes: 12_666_304,
  },
  {
    id: "slonik",
    title: "Зелёный слоник — Сколько истребителей?",
    paths: ["packs/slonik.zip"],
    icon: "pack-icons/slonik.png",
    sizeBytes: 32_784_254,
    tags: ["18+"],
  },
  {
    id: "theroom",
    title: "The Room — Oh Hi Mark",
    paths: ["packs/theroom.zip"],
    icon: "pack-icons/theroom.png",
    sizeBytes: 5_342_073,
  },
  {
    id: "starwars",
    title: "Star Wars — You Turned Her Against Me",
    paths: ["packs/starwars.zip"],
    icon: "pack-icons/starwars.png",
    sizeBytes: 10_056_062,
  },
  {
    id: "chosenone",
    title: "Star Wars — You Were the Chosen One",
    paths: ["packs/chosenone.zip"],
    icon: "pack-icons/chosenone.png",
    sizeBytes: 12_628_399,
  },
  {
    id: "lotr",
    title: "LOTR — Bridge of Khazad-dûm",
    paths: ["packs/lotr.zip"],
    icon: "pack-icons/lotr.png",
    sizeBytes: 11_180_551,
  },
  {
    id: "breakingbad",
    title: "Breaking Bad — I Am the Danger",
    paths: ["packs/breakingbad.zip"],
    icon: "pack-icons/breakingbad.png",
    sizeBytes: 13_420_362,
  },
  {
    id: "shrek",
    title: "Shrek the Third — Pinocchio Tries to Lie",
    paths: ["packs/shrek.zip"],
    icon: "pack-icons/shrek.png",
    sizeBytes: 17_865_680,
  },
  {
    id: "harrypotter",
    title: "Harry Potter — The Duel",
    paths: ["packs/harrypotter.zip"],
    icon: "pack-icons/harrypotter.png",
    sizeBytes: 14_794_986,
  },
];

export function packUrls(pack: PreloadedPack): string[] {
  return pack.paths.map((p) => PACKS_BASE + p);
}

/** Скачивает файлы по порядку, склеивает и отдаёт общий прогресс 0..1. */
export async function fetchWithProgress(
  urls: string[],
  expectedSize: number,
  onProgress: (ratio: number) => void,
  signal?: AbortSignal
): Promise<Blob> {
  const chunks: BlobPart[] = [];
  let received = 0;
  for (const url of urls) {
    const res = await fetch(url, { signal });
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
