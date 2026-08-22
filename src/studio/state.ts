/** Общее состояние студии — заполняется по ходу шагов, читается таймлайном и сборкой. */
import type { VideoProbe } from "./probe";

export type StudioMode = "voiceover" | "dub";

export interface StudioClip {
  id: string;
  /** Секунды от начала видео. */
  start: number;
  end: number;
  text: string;
  /** "" — без персонажа (реплика озвучивается всеми/никем не блокируется). */
  character: string;
  thumb: Blob | null;
}

export interface StudioState {
  videoFile: File | null;
  /** Разбор контейнера принесённого файла — только для отчёта (studio/probe.ts). */
  videoProbe: VideoProbe | null;
  videoUrl: string;
  /** Видео могло не декодироваться в AudioBuffer сразу (см. media.ts) — храним отдельно. */
  audioBuffer: AudioBuffer | null;
  durationSec: number;
  mode: StudioMode | null;
  clips: StudioClip[];
  characters: string[];
  packTitle: string;
  packAuthor: string;
  /**
   * Адрес, с которого игрок взял видео, если он приносил ссылку. Уезжает
   * в пак (`source=` в _pack_info.ini) и дальше в письмо модерации: по
   * готовому паку иначе не понять, откуда сцена. Пустая строка — видео
   * принесли файлом, и знать нам неоткуда.
   */
  sourceUrl: string;
  /** _backing_track — только «Дубляж» (реально даёт разделение). */
  backingTrack: Blob | null;
  /** _original_track — вся сцена с голосами, нужна обоим режимам. */
  originalTrack: Blob | null;
  /**
   * Изолированный голос («Дубляж», см. separate.ts) — из него режутся
   * NN_name.wav отдельных реплик, чтобы у пака была честная оценка
   * (game/score.ts). В «Закадре» остаётся null, и клипы режутся из
   * общего audioBuffer — там оценка всё равно выключена (scoringOff).
   */
  vocalsBuffer: AudioBuffer | null;
}

export function createState(): StudioState {
  return {
    videoFile: null,
    videoProbe: null,
    videoUrl: "",
    audioBuffer: null,
    durationSec: 0,
    mode: null,
    clips: [],
    characters: [],
    packTitle: "",
    packAuthor: "",
    sourceUrl: "",
    backingTrack: null,
    originalTrack: null,
    vocalsBuffer: null,
  };
}

let seq = 0;
export function newClipId(): string {
  seq += 1;
  return `clip-${seq}`;
}
