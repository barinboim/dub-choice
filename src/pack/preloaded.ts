/** Встроенные dub-паки, доступные сразу с главного экрана. */

export interface PreloadedPack {
  id: string;
  /** Названия паков — имена собственные, не переводятся. */
  title: string;
  /** Файлы качаются по порядку и склеиваются: GitHub Pages не принимает файлы >100 МБ. */
  urls: string[];
  sizeBytes: number;
}

export const PRELOADED_PACKS: PreloadedPack[] = [
  {
    id: "starwars",
    title: "Star Wars — You Turned Her Against Me",
    urls: ["packs/starwars.zip"],
    sizeBytes: 10_093_767,
  },
  {
    id: "lotr",
    title: "LOTR — Bridge of Khazad-dûm",
    urls: ["packs/lotr.zip"],
    sizeBytes: 11_196_401,
  },
  {
    id: "breakingbad",
    title: "Breaking Bad — I Am the Danger",
    urls: ["packs/breakingbad.zip"],
    sizeBytes: 14_850_856,
  },
  {
    id: "shrek",
    title: "Shrek the Third — Pinocchio Tries to Lie",
    urls: ["packs/shrek.zip"],
    sizeBytes: 99_923_617,
  },
  {
    // 179 МБ — больше лимита файла на GitHub Pages, поэтому в двух частях
    id: "harrypotter",
    title: "Harry Potter — The Duel",
    urls: ["packs/harrypotter.zip.part1", "packs/harrypotter.zip.part2"],
    sizeBytes: 179_428_633,
  },
];

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
