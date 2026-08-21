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
  /**
   * Полная оригинальная дорожка сцены — с голосами (наше расширение,
   * `_original_track`). Нужна закадровому режиму: иначе оригинал приходится
   * собирать из фона и кусков реплик, и фон под ними удваивается.
   */
  originalTrack: Blob | null;
  /**
   * Дорожки дубляжа: только ГОЛОС, одним файлом на язык
   * (`_voices_<code>.mp3`, наше расширение). Реплики из них режутся на
   * лету по таймкодам — возить их ещё и отдельными файлами значило бы
   * удвоить вес пака на тех же секундах.
   */
  voiceTracks: { lang: string; blob: Blob }[];
  /** Клипы, отсортированные по первому таймстампу. */
  clips: DubClip[];
  /** Код языка оригинальных субтитров (lang из _pack_info.ini), "" — неизвестен. */
  lang: string;
  /**
   * Названия языков, которых нет в словаре игры: langname_<code>_ru/_en в
   * _pack_info.ini. Пак может говорить на выдуманном языке, и подписать его
   * умеет только автор пака.
   */
  langNames: Record<string, { ru: string; en: string }>;
  /**
   * Языки переводов, реально встреченные в репликах. Непустой список
   * включает режим переводчика: над текстом появляются пиллы языков.
   */
  translations: string[];
  /** Предупреждения, найденные при загрузке (не фатальные). */
  warnings: string[];
  /**
   * `scoring="off"` в _pack_info.ini (наше расширение, из веб-студии,
   * режим «Закадр»): клип содержит музыку вместе с голосом, метрика
   * game/score.ts дала бы мусор — экран результатов её не считает и не
   * показывает, но строки реплик (кадр + волны) остаются.
   */
  scoringOff: boolean;
  /**
   * `mix="voiceover"` в _pack_info.ini (наше расширение): у пака нет
   * _backing_track (веб-студия, режим «Закадр»), поэтому «Дубляж» дал бы
   * тишину под дублем. Игроку не предлагается выбор — группа радиокнопок
   * микса скрыта, а composer.ts принудительно работает в этом режиме.
   */
  forcedMix: "voiceover" | null;
}

/** Уникальные персонажи пака в порядке первого появления реплики. */
export function packCharacters(pack: DubPack): string[] {
  const seen = new Set<string>();
  for (const clip of pack.clips) {
    for (const name of clip.characters) seen.add(name);
  }
  return [...seen];
}

/**
 * Активна ли реплика при данном наборе выключенных персонажей: реплика без
 * персонажей или хотя бы с одним включённым — активна. Общая логика для
 * карточки пака (фильтр ещё до сессии) и `DubSession` (во время игры).
 */
export function clipIsActive(clip: DubClip, disabledCharacters: ReadonlySet<string>): boolean {
  return clip.characters.length === 0 || clip.characters.some((c) => !disabledCharacters.has(c));
}

/** Плоская карта файлов пака: имя файла (без пути) → содержимое. */
export type PackFileMap = Map<string, Blob>;

export class PackError extends Error {}
