/**
 * Обратная операция к parser.ts: DubPack → плоский набор файлов пака.
 * Игра сама этим не пользуется — нужна веб-студии для «Скачать ZIP».
 */
import { serializeIni, type IniSection } from "./ini";
import type { DubPack } from "./types";

export function serializePackToFiles(pack: DubPack): Map<string, Blob> {
  const files = new Map<string, Blob>();

  const info: IniSection = {
    title: pack.title,
    subtitle: pack.subtitle,
    authors: pack.authors,
    lang: pack.lang,
  };
  if (pack.icon) info.icon = "icon.jpg";
  if (pack.scoringOff) info.scoring = "off";
  if (pack.forcedMix) info.mix = pack.forcedMix;
  files.set("_pack_info.ini", new Blob([serializeIni({ data: info })], { type: "text/plain" }));

  if (pack.icon) files.set("icon.jpg", pack.icon);

  const videoExt = pack.videoKind === "ogv" ? "ogv" : pack.video.type.includes("webm") ? "webm" : "mp4";
  files.set(`dub_video.${videoExt}`, pack.video);

  if (pack.backingTrack) files.set("_backing_track.wav", pack.backingTrack);
  if (pack.originalTrack) files.set("_original_track.wav", pack.originalTrack);

  for (const clip of pack.clips) {
    const data: IniSection = {
      caption: clip.caption,
      dub_timestamps: clip.timestamps,
      dub_characters: clip.characters,
    };
    for (const [code, text] of Object.entries(clip.captions)) data[`caption_${code}`] = text;
    files.set(`${clip.baseName}.ini`, new Blob([serializeIni({ data })], { type: "text/plain" }));
    files.set(`${clip.baseName}.wav`, clip.audio);
    if (clip.image) files.set(`${clip.baseName}.jpg`, clip.image);
  }

  return files;
}
