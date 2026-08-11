/**
 * Минимальный i18n: русский и английский.
 * Язык по умолчанию — из системного (ru → ru, всё остальное → en).
 */

export type Lang = "ru" | "en";

const STORAGE_KEY = "dubchoice.lang";

const dict = {
  // Главная
  tagline: {
    ru: "Переозвучь любимую сцену своим голосом",
    en: "Redub your favorite scene with your own voice",
  },
  dropTitle: { ru: "Перетащи сюда dub-пак", en: "Drop a dub pack here" },
  dropHint: { ru: "ZIP-архив или папка с файлами пака", en: "A ZIP archive or a pack folder" },
  pickZip: { ru: "Выбрать ZIP", en: "Choose ZIP" },
  pickFolder: { ru: "Выбрать папку", en: "Choose folder" },
  galleryTitle: { ru: "Встроенные паки", en: "Built-in packs" },
  loadedTitle: { ru: "Загруженные", en: "Loaded" },
  packLoading: { ru: "Загружаю…", en: "Loading…" },
  packUnpacking: { ru: "Распаковываю…", en: "Unpacking…" },
  creditsInspired: {
    ru: "Вдохновлено игрой The Choicer Voicer от YeahMaybe",
    en: "Inspired by The Choicer Voicer by YeahMaybe",
  },
  creditsCreated: { ru: "Создал", en: "Created by" },
  genericLoadError: {
    ru: "Не получилось прочитать пак. Проверь, что это папка или ZIP dub-пака.",
    en: "Couldn't read the pack. Make sure it's a dub pack folder or ZIP.",
  },
  fetchError: {
    ru: "Не удалось скачать пак. Проверь соединение и попробуй ещё раз.",
    en: "Couldn't download the pack. Check your connection and try again.",
  },
  clipsCount: { ru: "реплик", en: "lines" },

  // Карточка пака
  back: { ru: "← Назад", en: "← Back" },
  author: { ru: "Автор", en: "By" },
  withBacking: { ru: "с фоновой дорожкой", en: "with backing track" },
  withoutBacking: { ru: "без фоновой дорожки", en: "no backing track" },
  rehearsalTitle: {
    ru: "Режим репетиции — можно прослушивать свои дубли",
    en: "Rehearsal mode — listen to your takes anytime",
  },
  rehearsalHint: {
    ru: "По умолчанию, как в оригинале: свой голос впервые услышишь в готовом ролике 🙈",
    en: "Default is like the original: you first hear yourself in the final cut 🙈",
  },
  start: { ru: "Начать дубляж!", en: "Start dubbing!" },
  micRequest: { ru: "Запрашиваю доступ к микрофону…", en: "Requesting microphone access…" },
  micError: {
    ru: "Микрофон недоступен. Разреши доступ к микрофону в браузере и попробуй ещё раз.",
    en: "Microphone unavailable. Allow mic access in your browser and try again.",
  },
  videoPreparing: { ru: "Готовлю видео…", en: "Preparing video…" },
  videoError: { ru: "Не удалось открыть dub_video.ogv из пака.", en: "Couldn't open dub_video.ogv from the pack." },

  // Экран дубляжа
  quit: { ru: "← Выйти", en: "← Quit" },
  clipCounter: { ru: "Реплика {i} из {n}", en: "Line {i} of {n}" },
  noCaption: { ru: "(без субтитра)", en: "(no caption)" },
  original: { ru: "▶ Оригинал", en: "▶ Original" },
  record: { ru: "● Записать", en: "● Record" },
  reRecord: { ru: "● Переписать", en: "● Redo take" },
  stopRec: { ru: "■ Стоп", en: "■ Stop" },
  myTake: { ru: "▶ Мой дубль", en: "▶ My take" },
  next: { ru: "Готово →", en: "Done →" },
  nextFinal: { ru: "Готово — смотреть! 🎬", en: "Done — watch! 🎬" },
  monitorLabel: { ru: "Оригинал в ухо при записи", en: "Original in your ear while recording" },
  recBadge: { ru: "● ЗАПИСЬ", en: "● REC" },
  hintIdle: {
    ru: "Нажми «Записать» и озвучь реплику — твоя волна перепишет оригинал",
    en: "Hit “Record” and voice the line — your wave overwrites the original",
  },
  hintRecording: {
    ru: "Говори! Запись остановится сама в конце реплики",
    en: "Speak! Recording stops by itself at the end of the line",
  },
  hintHasTake: {
    ru: "Можно переписать дубль или нажать «Готово»",
    en: "Redo the take or hit “Done”",
  },
  quitConfirm: {
    ru: "Выйти из дубляжа? Записи этой сессии пропадут.",
    en: "Quit dubbing? This session's takes will be lost.",
  },

  // Финал
  premiere: { ru: "🍿 Премьера твоего дубляжа!", en: "🍿 Your dub premiere!" },
  watch: { ru: "▶ Смотреть", en: "▶ Watch" },
  downloadVideo: { ru: "⬇ Скачать видео ({fmt})", en: "⬇ Download video ({fmt})" },
  downloadAudio: { ru: "🎧 Скачать аудио (WAV)", en: "🎧 Download audio (WAV)" },
  redub: { ru: "↩ Переозвучить заново", en: "↩ Redub from scratch" },
  otherPack: { ru: "🏠 Другой пак", en: "🏠 Another pack" },
  exportWaiting: {
    ru: "Ролик допишется к концу просмотра… {p}%",
    en: "The video finishes recording as you watch… {p}%",
  },
  exportDone: { ru: "Готово! Файл скачан. 🎉", en: "Done! File downloaded. 🎉" },
  exportInterrupted: {
    ru: "Просмотр прервали — нажми «Смотреть», файл запишется заново.",
    en: "Playback was interrupted — press “Watch” to record the file again.",
  },
  audioDone: { ru: "Аудиодорожка скачана. 🎧", en: "Audio track downloaded. 🎧" },
  audioError: { ru: "Не удалось отрендерить аудио.", en: "Couldn't render the audio." },
  dubFileSuffix: { ru: "мой дубляж", en: "my dub" },
  audioFileSuffix: { ru: "дубляж (аудио)", en: "dub (audio)" },
} as const;

export type MsgKey = keyof typeof dict;

let current: Lang = detectLang();

function detectLang(): Lang {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "ru" || saved === "en") return saved;
  return (navigator.language || "").toLowerCase().startsWith("ru") ? "ru" : "en";
}

export function lang(): Lang {
  return current;
}

export function setLang(l: Lang): void {
  current = l;
  localStorage.setItem(STORAGE_KEY, l);
  document.documentElement.lang = l;
  applyStatic();
}

/** Перевод с подстановками: t("clipCounter", { i: 1, n: 17 }). */
export function t(key: MsgKey, vars?: Record<string, string | number>): string {
  let text: string = dict[key][current];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}

/** Проставляет переводы всем элементам с data-i18n="key". */
export function applyStatic(): void {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n as MsgKey;
    if (dict[key]) el.textContent = t(key);
  });
}
