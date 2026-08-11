import { parseIni, iniString, iniStringArray, iniNumberArray } from "./ini";
import { DubClip, DubPack, PackError, PackFileMap } from "./types";

/** Приоритет форматов, как в оригинальной игре (README разработчика). */
const AUDIO_EXTS = ["wav", "mp3", "ogg"];
const IMAGE_EXTS = ["png", "jpg", "webp", "jpeg"];
const VIDEO_NAME = "dub_video.ogv";

/**
 * Собирает DubPack из плоской карты файлов (имя → Blob).
 * Бросает PackError с понятным для игрока сообщением, если пак
 * не подходит для Dub Mode.
 */
export async function parsePack(files: PackFileMap): Promise<DubPack> {
  const warnings: string[] = [];
  // Регистронезависимый доступ: ключ — имя в нижнем регистре
  const byLower = new Map<string, { name: string; blob: Blob }>();
  for (const [name, blob] of files) {
    byLower.set(name.toLowerCase(), { name, blob });
  }
  const find = (name: string): Blob | null => byLower.get(name.toLowerCase())?.blob ?? null;

  const video = find(VIDEO_NAME);
  if (!video) {
    throw new PackError(
      "В паке нет dub_video.ogv — это обычный Voice Pack, а не Dub Pack. " +
        "Для Dub Mode нужен пак с видео и таймингами реплик."
    );
  }

  // _pack_info.ini
  let title = "Без названия";
  let subtitle = "";
  let authors: string[] = [];
  let iconName: string | null = null;
  const packInfoBlob = find("_pack_info.ini");
  if (packInfoBlob) {
    const ini = parseIni(await packInfoBlob.text());
    const data = ini["data"] ?? ini[""];
    title = iniString(data, "title", title);
    subtitle = iniString(data, "subtitle");
    authors = iniStringArray(data, "authors");
    const icon = iniString(data, "icon");
    if (icon) iconName = icon;
  } else {
    warnings.push("Не найден _pack_info.ini — у пака не будет названия и авторов.");
  }

  const fillerImage = findByBase(byLower, "_pack_filler_image", IMAGE_EXTS);

  // Клипы: каждый NN_name.ini (или .txt — так делают некоторые моды,
  // например «Shrek the Third Pinocchio tries to lie») с dub_timestamps.
  // Прочие txt (README, _subtitle) отсеиваются сами: в них нет dub_timestamps.
  const clips: DubClip[] = [];
  const seenBases = new Set<string>();
  for (const ext of [".ini", ".txt"]) {
    for (const { name, blob } of byLower.values()) {
      if (!name.toLowerCase().endsWith(ext)) continue;
      const base = name.slice(0, -ext.length);
      const baseLower = base.toLowerCase();
      if (baseLower === "_pack_info" || seenBases.has(baseLower)) continue;

      const ini = parseIni(await blob.text());
      const data = ini["data"] ?? ini[""];
      const timestamps = iniNumberArray(data, "dub_timestamps");
      if (timestamps.length === 0) continue; // не клип для Dub Mode

      const audio = findByBase(byLower, base, AUDIO_EXTS);
      if (!audio) {
        warnings.push(`У клипа «${base}» есть метаданные, но нет аудиофайла — клип пропущен.`);
        continue;
      }
      seenBases.add(baseLower);
      // Явное поле image= в метаданных важнее совпадения по имени файла
      const explicitImage = iniString(data, "image");
      clips.push({
        baseName: base,
        caption: iniString(data, "caption"),
        timestamps: [...timestamps].sort((a, b) => a - b),
        characters: iniStringArray(data, "dub_characters"),
        audio,
        image:
          (explicitImage ? find(explicitImage) : null) ??
          findByBase(byLower, base, IMAGE_EXTS) ??
          fillerImage,
      });
    }
  }

  if (clips.length === 0) {
    throw new PackError(
      "В паке есть видео, но нет ни одного клипа с dub_timestamps — дублировать нечего."
    );
  }

  // Порядок реплик — по положению в видео
  clips.sort((a, b) => a.timestamps[0] - b.timestamps[0]);

  const icon =
    (iconName ? find(iconName) : null) ?? findByBase(byLower, "icon", IMAGE_EXTS) ?? clips[0].image;

  return {
    title,
    subtitle,
    authors,
    icon,
    video,
    backingTrack: findByBase(byLower, "_backing_track", AUDIO_EXTS),
    clips,
    warnings,
  };
}

/** Ищет файл base.ext по списку расширений в порядке приоритета. */
function findByBase(
  byLower: Map<string, { name: string; blob: Blob }>,
  base: string,
  exts: string[]
): Blob | null {
  for (const ext of exts) {
    const hit = byLower.get(`${base.toLowerCase()}.${ext}`);
    if (hit) return hit.blob;
  }
  return null;
}
