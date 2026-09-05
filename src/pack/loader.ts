import { unzip } from "fflate";
import { parsePack } from "./parser";
import { DubPack, PackError, PackFileMap } from "./types";

const MEDIA_RE = /\.(ini|txt|wav|mp3|ogg|ogv|mp4|webm|png|jpg|jpeg|webp)$/i;

/** Загружает пак из ZIP-архива. Файлы могут лежать в корне или в одной подпапке. */
export async function loadPackFromZip(file: File): Promise<DubPack> {
  const data = new Uint8Array(await file.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(data, { filter: (f) => MEDIA_RE.test(f.name) && f.originalSize < 512 * 1024 * 1024 },
      (err, out) => (err ? reject(err) : resolve(out)));
  });

  const files: PackFileMap = new Map();
  for (const [path, bytes] of Object.entries(entries)) {
    if (path.endsWith("/") || path.includes("__MACOSX")) continue;
    const name = path.split("/").pop()!;
    if (name.startsWith(".")) continue;
    // При коллизии имён из разных подпапок берём файл с самым коротким путём
    // (корень пака важнее вложенных папок)
    if (files.has(name)) continue;
    files.set(name, new Blob([bytes.slice().buffer]));
  }
  if (files.size === 0) throw new PackError("В архиве не нашлось файлов пака.");
  return parsePack(files);
}

/**
 * Загружает пак по прямой ссылке на ZIP (например, presubmission-архив
 * из письма модерации в Telegram, `?load=` в studio.html).
 */
export async function loadPackFromUrl(url: string): Promise<DubPack> {
  const res = await fetch(url);
  if (!res.ok) throw new PackError(`Не удалось скачать пак (${res.status}).`);
  const blob = await res.blob();
  return loadPackFromZip(new File([blob], "pack.zip", { type: "application/zip" }));
}

/** Загружает пак из списка файлов (input webkitdirectory или drag-and-drop папки). */
export async function loadPackFromFiles(fileList: Iterable<File>): Promise<DubPack> {
  const files: PackFileMap = new Map();
  for (const f of fileList) {
    if (!MEDIA_RE.test(f.name) || f.name.startsWith(".")) continue;
    if (files.has(f.name)) continue;
    files.set(f.name, f);
  }
  if (files.size === 0) throw new PackError("В папке не нашлось файлов пака.");
  return parsePack(files);
}

/** Рекурсивно собирает файлы из перетащенной папки (DataTransferItem.webkitGetAsEntry). */
export async function collectDroppedFiles(items: DataTransferItemList): Promise<File[]> {
  const out: File[] = [];
  const walkers: Promise<void>[] = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) walkers.push(walkEntry(entry, out));
    else {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  await Promise.all(walkers);
  return out;
}

async function walkEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject)
    );
    out.push(file);
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject)
    );
    if (batch.length === 0) return;
    await Promise.all(batch.map((e) => walkEntry(e, out)));
  }
}
