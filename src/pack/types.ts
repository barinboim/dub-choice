/** Один клип (реплика) dub-пака. */
export interface DubClip {
  /** Базовое имя файла без расширения, например "01_anakin1". */
  baseName: string;
  /** Субтитр реплики на языке оригинала (caption из ini). */
  caption: string;
  /**
   * Переводы субтитра по коду языка: ключ caption_ru в ini → { ru: "…" }.
   * Наше расширение формата, оригинальная игра лишние ключи игнорирует.
   */
  captions: Record<string, string>;
  /** Моменты в секундах, куда синхронизируется запись в видео. */
  timestamps: number[];
  /** Имена персонажей реплики. */
  characters: string[];
  /** Аудиофайл оригинальной реплики. */
  audio: Blob;
  /** Изображение-превью (может отсутствовать). */
  image: Blob | null;
}

export interface DubPack {
  title: string;
  subtitle: string;
  authors: string[];
  /** Иконка пака. */
  icon: Blob | null;
  /** Видео сцены (dub_video.mp4 / .webm / .ogv). */
  video: Blob;
  /** Как играть видео: нативным <video> (mp4/webm) или через ogv.js (theora). */
  videoKind: "native" | "ogv";
  /** Фоновая дорожка без голосов (опционально). */
  backingTrack: Blob | null;
  /** Клипы, отсортированные по первому таймстампу. */
  clips: DubClip[];
  /** Код языка оригинальных субтитров (lang из _pack_info.ini), "" — неизвестен. */
  lang: string;
  /**
   * Языки переводов, реально встреченные в репликах. Непустой список
   * включает режим переводчика: над текстом появляются пиллы языков.
   */
  translations: string[];
  /** Предупреждения, найденные при загрузке (не фатальные). */
  warnings: string[];
}

/** Плоская карта файлов пака: имя файла (без пути) → содержимое. */
export type PackFileMap = Map<string, Blob>;

export class PackError extends Error {}
