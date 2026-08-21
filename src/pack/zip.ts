/**
 * Упаковка DubPack в ZIP и скачивание. Живёт в `pack/`, а не в студии,
 * потому что нужен обоим документам: студия отдаёт собранный пак, игра —
 * тот же пак с экрана карточки и с экрана экспорта.
 */
import { zip } from "fflate";
import { serializePackToFiles } from "./serializer";
import type { DubPack } from "./types";

export async function packToZipBlob(pack: DubPack): Promise<Blob> {
  const files = serializePackToFiles(pack);
  const entries: Record<string, Uint8Array> = {};
  for (const [name, blob] of files) entries[name] = new Uint8Array(await blob.arrayBuffer());
  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    zip(entries, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)));
  });
  return new Blob([zipped.slice().buffer], { type: "application/zip" });
}

export async function downloadPackZip(pack: DubPack): Promise<void> {
  const url = URL.createObjectURL(await packToZipBlob(pack));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(pack.title || "dub-pack").replace(/[^a-zа-яё0-9]+/gi, "-")}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}
