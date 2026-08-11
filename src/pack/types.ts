/** Один клип (реплика) dub-пака. */
export interface DubClip {
  /** Базовое имя файла без расширения, например "01_anakin1". */
  baseName: string;
  /** Субтитр реплики (caption из ini). */
  caption: string;
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
  /** Видео сцены (dub_video.ogv). */
  video: Blob;
  /** Фоновая дорожка без голосов (опционально). */
  backingTrack: Blob | null;
  /** Клипы, отсортированные по первому таймстампу. */
  clips: DubClip[];
  /** Предупреждения, найденные при загрузке (не фатальные). */
  warnings: string[];
}

/** Плоская карта файлов пака: имя файла (без пути) → содержимое. */
export type PackFileMap = Map<string, Blob>;

export class PackError extends Error {}
