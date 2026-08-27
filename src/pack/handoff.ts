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

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    // Другая вкладка держит соединение — не виснем вечно, просто не чиним.
    req.onblocked = () => resolve();
  });
}

/**
 * iOS Safari иногда возвращает "старую" базу без реально созданных
 * object store (эвикция базы под нехватку места/ITP) — любая транзакция
 * валится с NotFoundError "The object can not be found here.", и то же
 * соединение это не лечит: повторный put/take падает идентично сколько ни
 * пробуй (наступали на проде 2026-08-27). Один раз пересоздаём базу целиком
 * и повторяем операцию — это чинит канал, а не конкретный объект. Другие
 * ошибки (например DataCloneError у Blob-тяжёлого пака) не трогаем: для них
 * уже есть отдельный fallback на ZIP в stashPackForGame/stashPackForStudio.
 */
async function withRecovery<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (!(err instanceof DOMException) || err.name !== "NotFoundError") throw err;
    console.warn("IndexedDB-канал сломан (NotFoundError), пересоздаю базу", err);
    await deleteDb();
    return await attempt();
  }
}

async function put(value: unknown, key: string): Promise<void> {
  await withRecovery(async () => {
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
  });
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
  return withRecovery(async () => {
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
  });
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
