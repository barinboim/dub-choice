/**
 * История прошлых игр: прохождение, дошедшее до премьеры, переживает
 * закрытие вкладки и краш браузера — сохраняется в IndexedDB на этом
 * устройстве и показывается на главном экране («Прошлые игры»). Тот же
 * приём, что в `pack/drafts.ts`: лёгкие метаданные для списка — в отдельном
 * сторе, чтобы отрисовать список не значило тащить из базы тяжёлые Blob'ы.
 *
 * Встроенные паки галереи хранят только `packSourceId` (slug) — сам пак
 * перекачивается заново при открытии, это быстро и не тратит место на
 * диске. Свои паки (`custom`/`studio` — дропнутый ZIP/видео или собранный
 * в веб-студии) хранить негде, кроме как здесь: сервера с этим паком не
 * существует, поэтому весь `DubPack` целиком уходит в `payload.pack` —
 * структурным клоном, а если он не прошёл (Safari спотыкается на глубоком
 * объекте с десятками Blob, тот же случай, что в `pack/handoff.ts`) —
 * байтами ZIP.
 */
import { loadPackFromZip } from "./loader";
import { packToZipBlob } from "./zip";
import type { DubPack } from "./types";
import type { Recording } from "../audio/recorder";
import type { MixMode } from "../game/composer";

const DB_NAME = "dubchoice-history";
const META_STORE = "meta";
const PAYLOAD_STORE = "payload";
/** Сколько последних прохождений хранить — старые вытесняются автоматически. */
const HISTORY_LIMIT = 10;

export interface HistoryMeta {
  id: string;
  packTitle: string;
  packIcon: Blob | null;
  clipsCount: number;
  /** `currentPackSlug` на момент сохранения: id пака галереи, либо "custom"/"studio". */
  packSourceId: string;
  savedAt: number;
}

export interface HistoryPayload {
  recordings: [number, Recording][];
  mixMode: MixMode;
  disabledCharacters: string[];
  audioLang: string;
  captionLang: string;
  captionEdits: [string, string][];
  voiceoverGain: number;
  takeVolume: number;
  /**
   * Пак целиком — только для своих паков (галерейный пак перекачивается
   * заново по `packSourceId`, тут `null`).
   */
  pack: DubPack | { zip: ArrayBuffer } | null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore(META_STORE, { keyPath: "id" });
      db.createObjectStore(PAYLOAD_STORE);
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

async function putBoth(meta: HistoryMeta, payload: HistoryPayload): Promise<void> {
  const db = await openDb();
  try {
    await runTx(db, [META_STORE, PAYLOAD_STORE], "readwrite", (tx) => {
      tx.objectStore(META_STORE).put(meta);
      tx.objectStore(PAYLOAD_STORE).put(payload, meta.id);
    });
  } finally {
    db.close();
  }
}

export interface SaveCompletedPlayInput {
  pack: DubPack;
  packSourceId: string;
  /** Своих паков (custom/studio) больше нигде нет — сохраняем целиком. */
  storePackFully: boolean;
  recordings: Map<number, Recording>;
  mixMode: MixMode;
  disabledCharacters: ReadonlySet<string>;
  audioLang: string;
  captionLang: string;
  captionEdits: Iterable<[string, string]>;
  voiceoverGain: number;
  takeVolume: number;
}

/** Сохраняет прохождение под `id`: тем же id — перезаписывает прежний снимок. */
export async function saveCompletedPlay(id: string, input: SaveCompletedPlayInput): Promise<void> {
  const meta: HistoryMeta = {
    id,
    packTitle: input.pack.title,
    packIcon: input.pack.icon,
    clipsCount: input.pack.clips.length,
    packSourceId: input.packSourceId,
    savedAt: Date.now(),
  };
  const payload: HistoryPayload = {
    recordings: [...input.recordings],
    mixMode: input.mixMode,
    disabledCharacters: [...input.disabledCharacters],
    audioLang: input.audioLang,
    captionLang: input.captionLang,
    captionEdits: [...input.captionEdits],
    voiceoverGain: input.voiceoverGain,
    takeVolume: input.takeVolume,
    pack: input.storePackFully ? input.pack : null,
  };
  try {
    await putBoth(meta, payload);
  } catch (err) {
    if (!input.storePackFully) throw err;
    console.warn("прохождение не сохранилось объектом, пробуем zip", err);
    const bytes = await (await packToZipBlob(input.pack)).arrayBuffer();
    payload.pack = { zip: bytes };
    await putBoth(meta, payload);
  }
  await trimHistory();
}

/** Список прохождений, новые сверху. */
export async function listCompletedPlays(): Promise<HistoryMeta[]> {
  const db = await openDb();
  try {
    const items: HistoryMeta[] = await new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, "readonly");
      const req = tx.objectStore(META_STORE).getAll();
      req.onsuccess = () => resolve(req.result as HistoryMeta[]);
      req.onerror = () => reject(req.error);
    });
    return items.sort((a, b) => b.savedAt - a.savedAt);
  } finally {
    db.close();
  }
}

export async function loadCompletedPlay(id: string): Promise<HistoryPayload | null> {
  const db = await openDb();
  try {
    const value = await new Promise<HistoryPayload | undefined>((resolve, reject) => {
      const tx = db.transaction(PAYLOAD_STORE, "readonly");
      const req = tx.objectStore(PAYLOAD_STORE).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return value ?? null;
  } finally {
    db.close();
  }
}

/** Собирает `DubPack` из сохранённого прохождения (уже без обращения к галерее). */
export async function packFromHistoryPayload(payload: HistoryPayload): Promise<DubPack | null> {
  if (!payload.pack) return null;
  if ("zip" in payload.pack) {
    return loadPackFromZip(new File([payload.pack.zip], "history.zip", { type: "application/zip" }));
  }
  return payload.pack;
}

export async function deleteCompletedPlay(id: string): Promise<void> {
  const db = await openDb();
  try {
    await runTx(db, [META_STORE, PAYLOAD_STORE], "readwrite", (tx) => {
      tx.objectStore(META_STORE).delete(id);
      tx.objectStore(PAYLOAD_STORE).delete(id);
    });
  } finally {
    db.close();
  }
}

async function trimHistory(): Promise<void> {
  const items = await listCompletedPlays();
  for (const stale of items.slice(HISTORY_LIMIT)) {
    await deleteCompletedPlay(stale.id);
  }
}
