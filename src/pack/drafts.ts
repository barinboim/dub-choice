/**
 * Черновики студии: пак, над которым игрок работает, переживает закрытие
 * вкладки — сохраняется в IndexedDB на этом устройстве и предлагается
 * заново на экране приёма видео (`studio.html`). Тот же приём, что в
 * pack/handoff.ts: пак целиком, а если структурный клон не проходит
 * (Safari спотыкается на глубоком объекте с десятками Blob) — байты ZIP.
 *
 * Метаданные для списка (заголовок, число реплик, иконка) держим в
 * отдельном сторе: иначе, чтобы просто отрисовать список черновиков,
 * пришлось бы каждый раз доставать из IndexedDB и — для упавших в ZIP —
 * распаковывать тяжёлый пак целиком.
 */
import { loadPackFromZip } from "./loader";
import { packCharacters } from "./types";
import { packToZipBlob } from "./zip";
import type { DubPack } from "./types";

const DB_NAME = "dubchoice-drafts";
const META_STORE = "meta";
const PACK_STORE = "pack";

export interface DraftMeta {
  id: string;
  title: string;
  clipsCount: number;
  charactersCount: number;
  updatedAt: number;
  icon: Blob | null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore(META_STORE, { keyPath: "id" });
      db.createObjectStore(PACK_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function runTx(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    run(tx);
  });
}

async function putBoth(meta: DraftMeta, packValue: DubPack | { zip: ArrayBuffer }): Promise<void> {
  const db = await openDb();
  try {
    await runTx(db, [META_STORE, PACK_STORE], "readwrite", (tx) => {
      tx.objectStore(META_STORE).put(meta);
      tx.objectStore(PACK_STORE).put(packValue, meta.id);
    });
  } finally {
    db.close();
  }
}

/** Сохраняет пак под черновиком `id`: тем же id — перезаписывает прежний снимок. */
export async function saveDraft(id: string, pack: DubPack): Promise<void> {
  const meta: DraftMeta = {
    id,
    title: pack.title,
    clipsCount: pack.clips.length,
    charactersCount: packCharacters(pack).length,
    updatedAt: Date.now(),
    icon: pack.icon,
  };
  try {
    await putBoth(meta, pack);
    return;
  } catch (err) {
    console.warn("черновик не сохранился объектом, пробуем zip", err);
  }
  const bytes = await (await packToZipBlob(pack)).arrayBuffer();
  await putBoth(meta, { zip: bytes });
}

/** Список черновиков, новые сверху. */
export async function listDrafts(): Promise<DraftMeta[]> {
  const db = await openDb();
  try {
    const items: DraftMeta[] = await new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, "readonly");
      const req = tx.objectStore(META_STORE).getAll();
      req.onsuccess = () => resolve(req.result as DraftMeta[]);
      req.onerror = () => reject(req.error);
    });
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  } finally {
    db.close();
  }
}

export async function loadDraftPack(id: string): Promise<DubPack | null> {
  const db = await openDb();
  let value: DubPack | { zip: ArrayBuffer } | undefined;
  try {
    value = await new Promise((resolve, reject) => {
      const tx = db.transaction(PACK_STORE, "readonly");
      const req = tx.objectStore(PACK_STORE).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
  if (!value) return null;
  if ("zip" in value && value.zip) {
    return loadPackFromZip(new File([value.zip], "draft.zip", { type: "application/zip" }));
  }
  return value as DubPack;
}

export async function deleteDraft(id: string): Promise<void> {
  const db = await openDb();
  try {
    await runTx(db, [META_STORE, PACK_STORE], "readwrite", (tx) => {
      tx.objectStore(META_STORE).delete(id);
      tx.objectStore(PACK_STORE).delete(id);
    });
  } finally {
    db.close();
  }
}
