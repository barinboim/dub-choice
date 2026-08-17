/**
 * Минимальный i18n: русский и английский.
 * Язык по умолчанию — из системного (ru → ru, всё остальное → en).
 */

export type Lang = "ru" | "en";

const STORAGE_KEY = "dubchoice.lang";

const dict = {
  // Главная
  tagline: {
    ru: "🎙️ Твоя студия дубляжа",
    en: "🎙️ Your dubbing studio",
  },
  dropTitle: { ru: "Перетащи сюда dub-пак", en: "Drop a dub pack here" },
  dropHint: { ru: "ZIP-архив или папка с файлами пака", en: "A ZIP archive or a pack folder" },
  dropMorePacks: {
    ru: "Готовые dub-паки можно найти на",
    en: "Find ready-made dub packs on",
  },
  pickZip: { ru: "Выбрать ZIP", en: "Choose ZIP" },
  pickFolder: { ru: "Выбрать папку", en: "Choose folder" },
  galleryTitle: { ru: "Встроенные паки", en: "Built-in packs" },
  loadedTitle: { ru: "Загруженные", en: "Loaded" },
  shelfNew: { ru: "Новинки", en: "New arrivals" },
  shelfNewSub: { ru: "добавлены недавно", en: "recently added" },
  shelfPopular: { ru: "Популярные озвучки", en: "Popular dubs" },
  shelfPopularSub: { ru: "на этой неделе", en: "this week" },
  suggestBox: { ru: "Предложка:", en: "Suggest a scene:" },
  searchPacks: {
    ru: "Найти пак — название, персонаж, тег…",
    en: "Find a pack — title, character, tag…",
  },
  searchClear: { ru: "Очистить поиск", en: "Clear search" },
  sortLabel: { ru: "Сортировка", en: "Sort" },
  sortNew: { ru: "Новые", en: "Newest" },
  sortPopular: { ru: "Популярные", en: "Popular" },
  tagsLabel: { ru: "Теги", en: "Tags" },
  galleryShown: { ru: "Показано {i} из {n}", en: "Showing {i} of {n}" },
  galleryReset: { ru: "сбросить", en: "reset" },
  galleryEmpty: { ru: "Ничего не нашлось.", en: "Nothing matched." },
  galleryEmptyReset: { ru: "Сбросить поиск и теги", en: "Clear search and tags" },
  packLoading: { ru: "Загружаю…", en: "Loading…" },
  packUnpacking: { ru: "Распаковываю…", en: "Unpacking…" },
  packDownload: { ru: "Скачать", en: "Download" },
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
  manifestLoadError: {
    ru: "Не удалось загрузить список встроенных паков. Проверь соединение и обнови страницу.",
    en: "Couldn't load the built-in pack list. Check your connection and reload the page.",
  },
  clipsCount: { ru: "реплик", en: "lines" },
  tagAdultTooltip: { ru: "Ненормативная лексика, тема 18+", en: "Explicit language, 18+ content" },

  // Карточка пака
  back: { ru: "← Назад", en: "← Back" },
  author: { ru: "Автор", en: "By" },
  withBacking: { ru: "с фоновой дорожкой", en: "with backing track" },
  withoutBacking: { ru: "без фоновой дорожки", en: "no backing track" },
  start: { ru: "Озвучить!", en: "Voice it!" },
  micRequest: { ru: "Запрашиваю доступ к микрофону…", en: "Requesting microphone access…" },
  micError: {
    ru: "Микрофон недоступен. Разреши доступ к микрофону в браузере и попробуй ещё раз.",
    en: "Microphone unavailable. Allow mic access in your browser and try again.",
  },
  micInsecure: {
    ru: "Браузер даёт доступ к микрофону только по HTTPS. Открой сайт по https:// и попробуй снова.",
    en: "Browsers allow microphone access over HTTPS only. Open the site via https:// and try again.",
  },
  videoPreparing: { ru: "Готовлю видео…", en: "Preparing video…" },
  videoError: { ru: "Не удалось открыть dub_video.ogv из пака.", en: "Couldn't open dub_video.ogv from the pack." },
  clipLength: { ru: "Суммарная длина реплик: {len}", en: "Collective length of selected clips: {len}" },
  filterCharacters: { ru: "Фильтр персонажей:", en: "Filter characters:" },
  filterEmpty: {
    ru: "Выбери хотя бы одного персонажа",
    en: "Select at least one character",
  },

  // Экран дубляжа
  clipCounter: { ru: "Реплика {i} из {n}", en: "Line {i} of {n}" },
  noCaption: { ru: "(без субтитра)", en: "(no caption)" },
  langOriginal: { ru: "Оригинал", en: "Original" },
  audioTrackLabel: { ru: "Звук", en: "Audio" },
  scoreTrackQuestion: {
    ru: "По какой дорожке считаем ваши баллы?",
    en: "Which track should we score you against?",
  },
  // Названия языков для пиллов над репликой; коды без имени показываются как есть
  langName_en: { ru: "Английский", en: "English" },
  langName_ru: { ru: "Русский", en: "Russian" },
  langName_de: { ru: "Немецкий", en: "German" },
  langName_fr: { ru: "Французский", en: "French" },
  langName_es: { ru: "Испанский", en: "Spanish" },
  langName_it: { ru: "Итальянский", en: "Italian" },
  langName_pt: { ru: "Португальский", en: "Portuguese" },
  langName_pl: { ru: "Польский", en: "Polish" },
  langName_uk: { ru: "Украинский", en: "Ukrainian" },
  langName_ja: { ru: "Японский", en: "Japanese" },
  langName_zh: { ru: "Китайский", en: "Chinese" },
  captionEditHint: {
    ru: "нажми на текст, если хочешь отредактировать",
    en: "tap the text if you want to edit it",
  },
  captionDone: { ru: "Готово", en: "Done" },
  captionsLabel: { ru: "Субтитры", en: "Captions" },
  original: { ru: "▶ Оригинал", en: "▶ Original" },
  record: { ru: "● Записать", en: "● Record" },
  reRecord: { ru: "● Переписать", en: "● Redo take" },
  stopRec: { ru: "■ Стоп", en: "■ Stop" },
  myTake: { ru: "▶ Мой дубль", en: "▶ My take" },
  toPremiere: { ru: "🎬 К премьере", en: "🎬 To the premiere" },
  next: { ru: "Готово →", en: "Done →" },
  nextFinal: { ru: "Готово — смотреть! 🎬", en: "Done — watch! 🎬" },
  nextFinalShort: { ru: "Готово 🎬", en: "Done 🎬" },
  monitorLabel: { ru: "Слышать дорожку", en: "Hear the track" },
  countdownLabel: { ru: "Отсчёт 3–2–1 перед записью", en: "3–2–1 countdown" },
  cancelCountdown: { ru: "✕ Отмена", en: "✕ Cancel" },
  savingTake: { ru: "Сохраняю…", en: "Saving…" },
  recBadge: { ru: "● ЗАПИСЬ", en: "● REC" },
  hintIdle: {
    ru: "Нажми «Записать» и озвучь реплику",
    en: "Hit “Record” and voice the line",
  },
  hintCountdown: {
    ru: "Приготовься — запись начнётся сразу после отсчёта",
    en: "Get ready — recording starts right after the countdown",
  },
  hintRecording: {
    ru: "Говори! Запись остановится сама в конце реплики",
    en: "Speak! Recording stops by itself at the end of the line",
  },
  hintSaving: {
    ru: "Сохраняю дубль…",
    en: "Saving your take…",
  },
  hintHasTake: {
    ru: "Можно переписать дубль или нажать «Готово»",
    en: "Redo the take or hit “Done”",
  },
  quitConfirm: {
    ru: "Выйти из дубляжа? Записи этой сессии пропадут.",
    en: "Quit dubbing? This session's takes will be lost.",
  },

  mixChangeLater: {
    ru: "Выбор можно будет поменять перед сохранением ролика",
    en: "You can change this before saving the video",
  },
  voiceoverVolume: { ru: "Громкость оригинала", en: "Original volume" },
  takeVolume: { ru: "Громкость озвучки", en: "Your voice volume" },

  // Финал
  mixDub: { ru: "Дубляж", en: "Dubbing" },
  mixDubHint: {
    ru: "твоя озвучка полностью заменит голоса персонажей",
    en: "your voice fully replaces the characters' voices",
  },
  mixVoiceover: { ru: "Закадр", en: "Voice-over" },
  mixVoiceoverHint: {
    ru: "твоя озвучка ляжет поверх приглушённых оригинальных голосов",
    en: "your voice goes over the original voices, turned down",
  },
  backToClips: { ru: "← К репликам", en: "← Back to lines" },
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
  audioFileSuffixVoice: { ru: "мой голос", en: "my voice" },
  audioFileSuffixVoiceChars: { ru: "мой голос и персонажи", en: "my voice and characters" },
  modalCancel: { ru: "Отмена", en: "Cancel" },
  wavModalTitle: { ru: "Что скачать?", en: "What to download?" },
  wavOptVoice: { ru: "Только мой голос", en: "Only my voice" },
  wavOptVoiceHint: {
    ru: "реплики, которые ты озвучил — без фона",
    en: "the lines you voiced — no background",
  },
  wavOptVoiceChars: { ru: "Мой голос и голоса персонажей", en: "My voice and character voices" },
  wavOptVoiceCharsHint: {
    ru: "плюс оригинальные реплики персонажей, которых ты не озвучивал — без фона",
    en: "plus the original lines of characters you didn't voice — no background",
  },
  wavOptFull: { ru: "Вся дорожка с фоном", en: "Full track with background" },
  wavOptFullHint: {
    ru: "тот же микс, что и в экспортируемом видео",
    en: "the same mix as in the exported video",
  },

  // Результаты
  resultsTitle: { ru: "Результаты", en: "Results" },
  resultsHint: {
    ru: "Балл — насколько твой дубль попал в ритм оригинала: вовремя начал, вовремя замолчал, там же сделал акценты. Нажми на реплику, чтобы переписать её.",
    en: "The score is how well your take matched the original's rhythm: starts, pauses and accents in the same places. Tap a line to redo it.",
  },
  resultRedub: { ru: "Переписать эту реплику", en: "Redo this line" },
  resultsJump: { ru: "Результаты и баллы", en: "Results and scores" },
  retryConfirm: {
    ru: "Переозвучить заново сотрёт все записанные реплики.\n\nЕсли нужно переписать только одну фразу — закрой это окно и выбери нужную сцену в результатах ниже.",
    en: "Redubbing from scratch erases every take you recorded.\n\nTo redo just one line, close this and pick the scene in the results below.",
  },
  scoreLabel: { ru: "Балл: {v}", en: "Score: {v}" },
  verdictAce: { ru: "Тебя берут на дубляж!", en: "You're hired for the dub!" },
  verdictGreat: { ru: "Отличная работа!", en: "Great work!" },
  verdictGood: { ru: "Крепкий дубляж", en: "Solid dubbing" },
  verdictMeh: { ru: "Не бросай основную работу!", en: "Don't quit your day job!" },
  verdictPoor: { ru: "Зато с душой", en: "But full of soul" },
  verdictAvant: { ru: "Это был авангард", en: "That was avant-garde" },
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
/**
 * Название языка на языке интерфейса: "en" → «Английский» / "English".
 * Незнакомый код показываем как есть — пак может нести любой язык.
 */
export function langName(code: string): string {
  const key = `langName_${code.toLowerCase()}` as MsgKey;
  return key in dict ? t(key) : code.toUpperCase();
}

/**
 * Подпись тега галереи. В манифесте теги лежат по-русски (их проставляет
 * автор пака), поэтому для английского интерфейса держим словарь известных;
 * незнакомый тег показываем как есть — манифест может принести любой.
 */
const TAG_EN: Record<string, string> = {
  "фильм": "movie",
  "мультфильм": "animation",
  "мем": "meme",
  "гарри поттер": "Harry Potter",
  "шрек": "Shrek",
  "монолог": "monologue",
  "русская озвучка": "Russian dub",
  "короткий ролик": "short",
};

export function tagLabel(tag: string): string {
  return current === "en" ? TAG_EN[tag] ?? tag : tag;
}

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
