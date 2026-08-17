/** Встроенные dub-паки, доступные сразу с главного экрана. */

/**
 * Запись из manifest.json. Всё, кроме первых полей, галерея использует для
 * витрины (полка, поиск, сортировка, фильтры) — эти данные лежат внутри
 * zip-архива, но качать ради них 19 паков нельзя, поэтому манифест несёт их
 * готовыми. Собирает его scripts/dubpack/build_manifest.py.
 */
export interface PreloadedPack {
  id: string;
  /** Названия паков — имена собственные, не переводятся. */
  title: string;
  /** Ключ zip-файла в R2-бакете, относительно PACKS_BASE. */
  path: string;
  /** Ключ иконки пака в R2-бакете, относительно PACKS_BASE. */
  icon: string;
  sizeBytes: number;
  /** Теги галереи; "18+" среди них — пометка, а не фильтр. */
  tags?: string[];
  /** Сколько реплик предстоит озвучить. */
  clips?: number;
  /** Суммарная длина реплик, секунды. */
  durationSec?: number;
  /** Персонажи в порядке появления — по ним тоже ищет строка поиска. */
  characters?: string[];
  /** Языки переводов субтитров, кроме языка оригинала. */
  translations?: string[];
  /** Дата появления в галерее, YYYY-MM-DD — для сортировки «Новые». */
  addedAt?: string;
  /** Запусков озвучки за неделю (полка) и за месяц (сортировка). */
  plays7d?: number;
  plays30d?: number;
}

/**
 * Паки и их манифест хостятся на Cloudflare R2 (публичный бакет, egress
 * бесплатный) — раньше качались с raw.githubusercontent.com, но тот
 * мучительно медленный из РФ, а GitHub ограничивает файл 100 МБ (из-за
 * этого паки резались на части по 4 МБ, теперь это не нужно).
 *
 * Список паков не зашит в бандл: при старте страница качает manifest.json
 * из того же бакета. Чтобы добавить пак на сайт, ничего пересобирать и
 * пушить не нужно — залил zip + иконку + обновил manifest.json в R2,
 * и он тут же появляется в галерее у всех.
 */
const PACKS_BASE = "https://pub-6cdcaa2a325441e59991d44af1e68177.r2.dev/";

/** Качает актуальный список паков. ?t= — чтобы не словить закэшированный manifest.json. */
export async function loadPreloadedManifest(): Promise<PreloadedPack[]> {
  const res = await fetch(`${PACKS_BASE}manifest.json?t=${Date.now()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PreloadedPack[];
}

export function packUrl(pack: PreloadedPack): string {
  return PACKS_BASE + pack.path;
}

export function packIconUrl(pack: PreloadedPack): string {
  return PACKS_BASE + pack.icon;
}

/** Качает файл, отдаёт прогресс 0..1. */
export async function fetchWithProgress(
  url: string,
  expectedSize: number,
  onProgress: (ratio: number) => void,
  signal?: AbortSignal
): Promise<Blob> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body) {
    const blob = await res.blob();
    onProgress(1);
    return blob;
  }
  const chunks: BlobPart[] = [];
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as BlobPart);
    received += (value as Uint8Array).length;
    if (expectedSize > 0) onProgress(Math.min(received / expectedSize, 1));
  }
  onProgress(1);
  return new Blob(chunks);
}

export function formatSize(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}
