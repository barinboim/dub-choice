/**
 * Передача собранного в веб-студии пака в игру: `studio.html → index.html`
 * — состояние не переживает смену документа (studio.html — отдельный
 * документ, docs/STUDIO_WEB_PLAN.md), поэтому пак кладётся в IndexedDB под
 * одноразовым ключом. ZIP пересобирать не нужно: уходит уже готовый
 * DubPack-объект с блобами, IndexedDB их прекрасно хранит.
 */
import { loadPackFromZip } from "./loader";
import { packToZipBlob } from "./zip";
import type { DubPack } from "./types";

const DB_NAME = "dubchoice-handoff";
const STORE = "packs";
const KEY = "pending";
/** Видео, бросенное на главную: index.html → studio.html, тем же способом. */
const VIDEO_KEY = "pending-video";
/** Готовый пак, отправленный из игры обратно в редактор. */
const EDIT_KEY = "pending-edit";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(value: unknown, key: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Пак сохраняется объектом, а если это не проходит — байтами ZIP.
 *
 * DubPack — глубокий объект с десятками Blob внутри, и Safari на таком
 * структурном клоне в IndexedDB спотыкается. Промах был незаметен: кнопка
 * «Собрать пак» просто ничего не делала. ArrayBuffer клонируется везде, так
 * что запасной путь надёжен, хоть и стоит одной упаковки.
 */
export async function stashPackForGame(pack: DubPack): Promise<void> {
  try {
    await put(pack, KEY);
    return;
  } catch (err) {
    console.warn("пак не сохранился объектом, пробуем zip", err);
  }
  const bytes = await (await packToZipBlob(pack)).arrayBuffer();
  await put({ zip: bytes }, KEY);
}

async function take<T>(key: string): Promise<T | null> {
  const db = await openDb();
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const value = (getReq.result as T | undefined) ?? null;
        if (value) store.delete(key);
        resolve(value);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  } finally {
    db.close();
  }
}

/** Забирает отложенный пак и сразу удаляет его — одноразовый ключ. */
export async function takePendingPack(): Promise<DubPack | null> {
  const value = await take<DubPack | { zip: ArrayBuffer }>(KEY);
  if (!value) return null;
  if ("zip" in value && value.zip) {
    return loadPackFromZip(new File([value.zip], "pack.zip", { type: "application/zip" }));
  }
  return value as DubPack;
}

/**
 * Видео, брошенное на главный экран игры, уезжает в студию тем же путём, что
 * и готовый пак обратно: File переживает смену документа только в IndexedDB.
 */
export async function stashVideoForStudio(file: File): Promise<void> {
  await put(file, VIDEO_KEY);
}

export async function takePendingVideo(): Promise<File | null> {
  return take<File>(VIDEO_KEY);
}

/** Пак уходит из игры в редактор: index.html → studio.html. */
export async function stashPackForStudio(pack: DubPack): Promise<void> {
  try {
    await put(pack, EDIT_KEY);
    return;
  } catch (err) {
    console.warn("пак не сохранился объектом, пробуем zip", err);
  }
  const bytes = await (await packToZipBlob(pack)).arrayBuffer();
  await put({ zip: bytes }, EDIT_KEY);
}

export async function takePackForStudio(): Promise<DubPack | null> {
  const value = await take<DubPack | { zip: ArrayBuffer }>(EDIT_KEY);
  if (!value) return null;
  if ("zip" in value && value.zip) {
    return loadPackFromZip(new File([value.zip], "pack.zip", { type: "application/zip" }));
  }
  return value as DubPack;
}
