/**
 * Упаковка DubPack в ZIP и скачивание. Живёт в `pack/`, а не в студии,
 * потому что нужен обоим документам: студия отдаёт собранный пак, игра —
 * тот же пак с экрана карточки и с экрана экспорта.
 */
import { zip } from "fflate";
import { serializePackToFiles, type SerializeOptions } from "./serializer";
import type { DubPack } from "./types";

export interface ZipOptions extends SerializeOptions {
  /**
   * Класть файлы в подпапку внутри архива. Нужно только паку для The
   * Choicer Voicer: фанатские паки к оригинальной игре раздаются именно
   * так (проверено на референсном `star_wars_-_you_turned_her_against_me`),
   * и человек ждёт, что распаковка не рассыплет полсотни файлов по папке
   * загрузок. Наш загрузчик берёт и то и другое (`loader.ts`).
   */
  folder?: string;
}

/** Имя файла архива. Кириллицу браузер сохраняет как есть — она уместна. */
export function packFileName(pack: DubPack): string {
  return (pack.title || "dub-pack").replace(/[^a-zа-яё0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "dub-pack";
}

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
};

/**
 * Имя папки ВНУТРИ архива — только латиница.
 *
 * Внутри zip имена лежат в UTF-8, и флаг кодировки fflate ставит честно, но
 * старый Info-ZIP (`unzip` на macOS и в большинстве Linux) его игнорирует:
 * кириллическая папка превращается в мусор, а потом распаковка падает с
 * «Illegal byte sequence» — то есть пак к оригинальной игре просто не
 * достаётся из архива. Имя самого файла архива это не касается: его отдаёт
 * браузер, и там кириллица живёт нормально.
 */
export function packFolderName(pack: DubPack): string {
  const latin = [...(pack.title || "").toLowerCase()]
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return latin || "dub-pack";
}

export async function packToZipBlob(pack: DubPack, opts: ZipOptions = {}): Promise<Blob> {
  const files = serializePackToFiles(pack, opts);
  const prefix = opts.folder ? `${opts.folder}/` : "";
  const entries: Record<string, Uint8Array> = {};
  for (const [name, blob] of files) entries[prefix + name] = new Uint8Array(await blob.arrayBuffer());
  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    zip(entries, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)));
  });
  return new Blob([zipped.slice().buffer], { type: "application/zip" });
}

export async function downloadPackZip(pack: DubPack, opts: ZipOptions = {}): Promise<void> {
  saveZip(await packToZipBlob(pack, opts), `${packFileName(pack)}.zip`);
}

/** Отдаёт готовый архив браузеру — общий хвост для всех путей скачивания. */
export function saveZip(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
