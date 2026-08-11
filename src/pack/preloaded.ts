/** Встроенные dub-паки, доступные сразу с главного экрана. */

export interface PreloadedPack {
  id: string;
  /** Названия паков — имена собственные, не переводятся. */
  title: string;
  url: string;
  sizeBytes: number;
}

export const PRELOADED_PACKS: PreloadedPack[] = [
  {
    id: "starwars",
    title: "Star Wars — You Turned Her Against Me",
    url: "packs/starwars.zip",
    sizeBytes: 10_093_767,
  },
  {
    id: "lotr",
    title: "LOTR — Bridge of Khazad-dûm",
    url: "packs/lotr.zip",
    sizeBytes: 11_196_401,
  },
  {
    id: "breakingbad",
    title: "Breaking Bad — I Am the Danger",
    url: "packs/breakingbad.zip",
    sizeBytes: 14_850_856,
  },
  {
    id: "shrek",
    title: "Shrek the Third — Pinocchio Tries to Lie",
    url: "packs/shrek.zip",
    sizeBytes: 99_923_617,
  },
  {
    // 179 МБ — больше лимита файла GitHub Pages, раздаётся через GitHub Release
    id: "harrypotter",
    title: "Harry Potter — The Duel",
    url: "https://github.com/barinboim/dub-choice/releases/download/packs-v1/harrypotterduel.zip",
    sizeBytes: 179_428_633,
  },
];

/** Скачивает файл с прогрессом 0..1 (по Content-Length, если сервер его отдал). */
export async function fetchWithProgress(
  url: string,
  expectedSize: number,
  onProgress: (ratio: number) => void
): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get("Content-Length")) || expectedSize || 0;
  if (!res.body) return res.blob();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total > 0) onProgress(Math.min(received / total, 1));
  }
  onProgress(1);
  return new Blob(chunks as BlobPart[]);
}

export function formatSize(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}
