/**
 * Обратная операция к parser.ts: DubPack → плоский набор файлов пака.
 * Игра сама этим не пользуется — нужна веб-студии для «Скачать ZIP».
 */
import { serializeIni, type IniSection } from "./ini";
import type { DubPack } from "./types";

/**
 * Расширения медиафайлов пака. По умолчанию — наши (WAV/JPG/MP4): их
 * отдаёт студия, их же читает игра. Режим полной совместимости с The
 * Choicer Voicer (`pack/tcv.ts`) подменяет их на те, что понимает Godot 3:
 * OGG/PNG/OGV. Само содержимое к тому моменту уже пережато — сериализатор
 * только раскладывает блобы по именам и не конвертирует ничего.
 */
export interface SerializeOptions {
  audioExt?: string;
  imageExt?: string;
  iconExt?: string;
}

export function serializePackToFiles(pack: DubPack, opts: SerializeOptions = {}): Map<string, Blob> {
  const audioExt = opts.audioExt ?? "wav";
  const imageExt = opts.imageExt ?? "jpg";
  const iconExt = opts.iconExt ?? "jpg";
  const files = new Map<string, Blob>();

  const info: IniSection = {
    title: pack.title,
    subtitle: pack.subtitle,
    authors: pack.authors,
    lang: pack.lang,
  };
  if (pack.icon) info.icon = `icon.${iconExt}`;
  if (pack.scoringOff) info.scoring = "off";
  if (pack.forcedMix) info.mix = pack.forcedMix;
  // Откуда взято видео — для модерации галереи. Ключ незнаком и нашему
  // парсеру старых версий, и Godot: лишние ключи оба просто игнорируют.
  if (pack.sourceUrl) info.source = pack.sourceUrl;
  files.set("_pack_info.ini", new Blob([serializeIni({ data: info })], { type: "text/plain" }));

  if (pack.icon) files.set(`icon.${iconExt}`, pack.icon);

  const videoExt = pack.videoKind === "ogv" ? "ogv" : pack.video.type.includes("webm") ? "webm" : "mp4";
  files.set(`dub_video.${videoExt}`, pack.video);

  if (pack.backingTrack) files.set(`_backing_track.${audioExt}`, pack.backingTrack);
  if (pack.originalTrack) files.set(`_original_track.${audioExt}`, pack.originalTrack);

  for (const clip of pack.clips) {
    const data: IniSection = {
      caption: clip.caption,
      dub_timestamps: clip.timestamps,
      dub_characters: clip.characters,
    };
    for (const [code, text] of Object.entries(clip.captions)) data[`caption_${code}`] = text;
    files.set(`${clip.baseName}.ini`, new Blob([serializeIni({ data })], { type: "text/plain" }));
    files.set(`${clip.baseName}.${audioExt}`, clip.audio);
    if (clip.image) files.set(`${clip.baseName}.${imageExt}`, clip.image);
  }

  return files;
}
