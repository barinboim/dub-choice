import { parsePack } from "./parser";
import { DubPack, PackError, PackFileMap } from "./types";
import { MEDIA_RE } from "./media";

/**
 * Исходная плоская карта файлов пака (имя → Blob), из которой он был собран.
 * Нужна коопу: чтобы раздать пак участникам комнаты, мы пересобираем из неё
 * ZIP — у распарсенного DubPack расширения файлов уже потеряны.
 */
const sourceMaps = new WeakMap<DubPack, PackFileMap>();
/** Оригинальный ZIP-файл, если пак загружен архивом — его можно отдать без переупаковки. */
const sourceZips = new WeakMap<DubPack, Blob>();

/** Исходные файлы пака, если он был загружен через загрузчик. */
export function packFileMap(pack: DubPack): PackFileMap | null {
  return sourceMaps.get(pack) ?? null;
}

/**
 * ZIP-архив пака для кооп-комнаты. Если пак грузили архивом — отдаём оригинал
 * как есть (ноль работы); иначе упаковываем исходные файлы в воркере, чтобы
 * не морозить вкладку хоста на больших паках.
 */
export async function packToZip(pack: DubPack): Promise<Blob> {
  const original = sourceZips.get(pack);
  if (original) return original;
  const files = sourceMaps.get(pack);
  if (!files) throw new PackError("Нет исходных файлов пака.");
  const entries: Record<string, ArrayBuffer> = {};
  const transfer: ArrayBuffer[] = [];
  for (const [name, blob] of files) {
    const ab = (await blob.arrayBuffer()) as ArrayBuffer;
    entries[name] = ab;
    transfer.push(ab);
  }
  const zipped = await zipInWorker(entries, transfer);
  return new Blob([new Uint8Array(zipped)], { type: "application/zip" });
}

// ---------------------------------------------------------------------------
// fflate-воркер: распаковка/упаковка вне главного потока
// ---------------------------------------------------------------------------

interface WorkerJob {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

let fflateWorker: Worker | null = null;
const fflateJobs = new Map<number, WorkerJob>();
let fflateSeq = 0;

function fflateRequest(
  op: "unzip" | "zip",
  payload: Record<string, unknown>,
  transfer: Transferable[]
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!fflateWorker) {
      fflateWorker = new Worker(new URL("./unzip.worker.ts", import.meta.url), { type: "module" });
      fflateWorker.onmessage = (e) => {
        const { id, ok, error } = e.data as { id: number; ok: boolean; error?: string };
        const job = fflateJobs.get(id);
        if (!job) return;
        fflateJobs.delete(id);
        if (ok) job.resolve(e.data);
        else job.reject(new Error(error ?? "fflate error"));
      };
      fflateWorker.onerror = (e) => {
        for (const job of fflateJobs.values()) job.reject(new Error(e.message));
        fflateJobs.clear();
        fflateWorker?.terminate();
        fflateWorker = null;
      };
    }
    const id = fflateSeq++;
    fflateJobs.set(id, { resolve, reject });
    fflateWorker.postMessage({ op, id, ...payload }, transfer);
  });
}

function unzipInWorker(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return fflateRequest("unzip", { bytes: ab }, [ab]).then((data) => {
    const files = (data as { files: Record<string, ArrayBuffer> }).files;
    const out: Record<string, Uint8Array> = {};
    for (const [name, buf] of Object.entries(files)) out[name] = new Uint8Array(buf);
    return out;
  });
}

function zipInWorker(entries: Record<string, ArrayBuffer>, transfer: ArrayBuffer[]): Promise<Uint8Array> {
  return fflateRequest("zip", { files: entries }, transfer).then((data) => {
    return new Uint8Array((data as { bytes: ArrayBuffer }).bytes);
  });
}

/** Загружает пак из ZIP-архива. Файлы могут лежать в корне или в одной подпапке. */
export async function loadPackFromZip(file: File): Promise<DubPack> {
  const data = new Uint8Array(await file.arrayBuffer());
  const entries = await unzipInWorker(data);

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
  const pack = await parsePack(files);
  sourceMaps.set(pack, files);
  sourceZips.set(pack, file);
  return pack;
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
  const pack = await parsePack(files);
  sourceMaps.set(pack, files);
  return pack;
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
