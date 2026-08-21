import "../style.css";
import "./studio.css";
import { t, lang, setLang, type Lang, type MsgKey } from "../i18n";
import { formatSize } from "../pack/preloaded";
import { $ } from "./dom";
import { createState, type StudioMode } from "./state";
import {
  BIG_FILE_WARN_BYTES,
  downloaderUrl,
  extractYoutubeId,
  fetchOEmbed,
  downloadersFor,
  loadDownloaders,
  looksLikeVideo,
  looksLikeVideoLink,
} from "./source";
import { attachSyncedAudio, attachVideoSource, loadVideoFile } from "./media";
import { runDubPipeline, runVoiceoverPipeline, type ProgressFn } from "./pipeline";
import { renderTimeline } from "./timeline";
import { resetTimings, timed, timings } from "./timing";
import { buildPack, downloadZip, playInGame } from "./build";
import { takePackForStudio, takePendingVideo } from "../pack/handoff";
import { loadPackFromZip } from "../pack/loader";
import { decodePackAudio, packToState } from "./reopen";
import { buildReport } from "../diagnostics";
import { note } from "../journey";
import { describeProbe, probeVideoFile } from "./probe";
import { initFeedback, openFeedbackForm, setFeedbackContext } from "../feedback";
import {
  trackBuild,
  trackDuration,
  trackMode,
  trackReady,
  trackSource,
  trackStudioError,
  trackStudioOpen,
  trackUncaught,
  type StudioErrorSlug,
} from "./track";
import type { DubPack } from "../pack/types";
import type { DiagnosticContext } from "../diagnostics";

const screens = {
  warn: $("studio-screen-warn"),
  mode: $("studio-screen-mode"),
  processing: $("studio-screen-processing"),
  timeline: $("studio-screen-timeline"),
  done: $("studio-screen-done"),
} as const;
type ScreenName = keyof typeof screens;

function showScreen(name: ScreenName): void {
  for (const key of Object.keys(screens) as ScreenName[]) screens[key].hidden = key !== name;
  // Таймлайн правится мышью — ему нужна ширина, остальным экранам она вредит.
  $("studio-app").classList.toggle("studio-wide", name === "timeline");
  window.scrollTo({ top: 0 });
}

const state = createState();
const video = $<HTMLVideoElement>("studio-video");

/**
 * Всё, что мы знаем о происходящем, в одном месте: и кнопка «Сообщить о
 * проблеме» в подвале, и отчёт после падения берут отсюда, иначе они
 * рассказывали бы о сеансе разное.
 */
function diagContext(patch: Partial<DiagnosticContext> = {}): DiagnosticContext {
  return {
    mode: state.mode,
    stage: stageLabel.textContent || undefined,
    video: state.videoProbe,
    videoSeconds: state.durationSec || undefined,
    videoWidth: video.videoWidth || undefined,
    videoHeight: video.videoHeight || undefined,
    audioRate: state.audioBuffer?.sampleRate,
    audioChannels: state.audioBuffer?.numberOfChannels,
    clips: state.clips.length || undefined,
    characters: state.characters.length || undefined,
    timings: timings(),
    ...patch,
  };
}

// ---------- Язык ----------
function syncLangButtons(): void {
  $("lang-ru").classList.toggle("active", lang() === "ru");
  $("lang-en").classList.toggle("active", lang() === "en");
}
function switchLang(l: Lang): void {
  setLang(l);
  syncLangButtons();
}
$("lang-ru").addEventListener("click", () => switchLang("ru"));
$("lang-en").addEventListener("click", () => switchLang("en"));
setLang(lang());
syncLangButtons();

// ---------- Экран 1: приём видео ----------
const dropZone = $("studio-drop-zone");
const fileInput = $<HTMLInputElement>("studio-input-file");
const errorBox = $("studio-error");
// Своя строка ошибки на таймлайне: `studio-error` живёт на экране приёма
// видео, и сообщение о сорвавшейся сборке уходило в невидимый элемент.
const buildErrorBox = $("studio-build-error");

function showErrorIn(box: HTMLElement, key: MsgKey, vars?: Record<string, string | number>): void {
  box.textContent = t(key, vars);
  box.hidden = false;
}
function showError(key: MsgKey, vars?: Record<string, string | number>): void {
  showErrorIn(errorBox, key, vars);
}
function clearError(): void {
  errorBox.hidden = true;
}

/** Одно поле на всё: ZIP — это готовый пак, остальное — видео. */
function acceptDroppedFile(file: File): void {
  if (/\.zip$/i.test(file.name) || file.type === "application/zip") {
    note("принёс готовый пак (ZIP)");
    trackSource("zip");
    void openExistingPack(loadPackFromZip(file));
    return;
  }
  trackSource("file");
  acceptVideoFile(file);
}

function acceptVideoFile(file: File): void {
  clearError();
  if (!looksLikeVideo(file)) {
    showError("studioBadVideo");
    return;
  }
  if (file.size > BIG_FILE_WARN_BYTES) showError("studioBigFileWarn", { size: formatSize(file.size) });
  state.videoFile = file;
  state.videoUrl = URL.createObjectURL(file);
  // Разбор контейнера — до всякой обработки: если дальше всё рухнет, в
  // отчёте уже будет написано, что именно за файл нам принесли.
  void probeVideoFile(file).then((probe) => {
    state.videoProbe = probe;
    note(`принёс видео: ${describeProbe(probe)}`);
    setFeedbackContext(diagContext());
  });
  // Плеер на экране выбора режима — подтверждение, что файл прочитался.
  $<HTMLVideoElement>("studio-mode-preview").src = state.videoUrl;
  showScreen("mode");
}

$("studio-pick-file").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) acceptDroppedFile(file);
  fileInput.value = "";
});

for (const evt of ["dragover", "dragenter"] as const) {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
}
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));

/**
 * Видео принимается всем экраном, а не только рамкой: после возврата от
 * стороннего загрузчика игрок целится в блок с YouTube-ссылкой — там же он
 * и читал инструкцию, и бросать файл мимо рамки было обидно.
 */
for (const evt of ["dragover", "dragenter"] as const) {
  screens.warn.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
}
screens.warn.addEventListener("dragleave", (e) => {
  if (e.target === screens.warn) dropZone.classList.remove("dragover");
});
screens.warn.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  const file = (e as DragEvent).dataTransfer?.files?.[0];
  if (file) acceptDroppedFile(file);
});

// ---------- YouTube: oEmbed + лазейка с редиректом ----------
const youtubeInput = $<HTMLInputElement>("studio-youtube-url");
const youtubeInfo = $("studio-youtube-info");
const youtubeThumb = $<HTMLImageElement>("studio-youtube-thumb");
const youtubeTitle = $("studio-youtube-title");
const youtubeAuthor = $("studio-youtube-author");
const downloadersBox = $("studio-downloaders");
const dropBackHint = $("studio-drop-back-hint");

let currentVideoId: string | null = null;
let debounceHandle = 0;

youtubeInput.addEventListener("input", () => {
  window.clearTimeout(debounceHandle);
  debounceHandle = window.setTimeout(() => void handleYoutubeInput(), 400);
});

async function handleYoutubeInput(): Promise<void> {
  const raw = youtubeInput.value.trim();
  const id = extractYoutubeId(raw);
  currentVideoId = id;

  // Ссылка годится любая из тех, что берёт cobalt (vk, rutube, tiktok…),
  // не только ютубовская.
  if (!looksLikeVideoLink(raw)) {
    youtubeInfo.hidden = true;
    downloadersBox.hidden = true;
    dropBackHint.hidden = true;
    return;
  }
  downloadersBox.hidden = false;
  dropBackHint.hidden = false;
  const downloaders = await loadDownloaders();
  // Первый — основная кнопка, остальные рядом как запасные: сервисы мрут.
  downloadersBox.replaceChildren(
    ...downloadersFor(raw, downloaders).map((d, i) => {
      const link = document.createElement("a");
      link.className = i === 0 ? "btn btn-pill" : "btn btn-text btn-sm";
      link.target = "_blank";
      link.rel = "noopener";
      link.href = downloaderUrl(d, raw, id);
      link.textContent = i === 0 ? `${t("studioOpenDownloader")} — ${d.name}` : d.name;
      return link;
    })
  );

  // Название и превью подтягиваются только у YouTube — у него есть oEmbed.
  if (!id) {
    youtubeInfo.hidden = true;
    return;
  }
  const info = await fetchOEmbed(id);
  if (currentVideoId !== id || !info) return; // ссылку успели сменить, или видео не нашлось
  youtubeInfo.hidden = false;
  youtubeThumb.src = info.thumbnailUrl;
  youtubeTitle.textContent = info.title;
  youtubeAuthor.textContent = info.author;
  state.packTitle = info.title;
  state.packAuthor = info.author;
}

// ---------- Открыть готовый пак в редакторе ----------

/** Пак (из ZIP или из игры) раскладывается обратно на таймлайн. */
async function openExistingPack(load: Promise<DubPack>): Promise<void> {
  clearError();
  showScreen("processing");
  setProgress("studioStageMedia", 0.2);
  try {
    const pack = await load;
    await packToState(pack, state);
    setProgress("studioStageMedia", 0.6);

    // Сперва пробуем звук самого видео: если он там есть, отдельная дорожка
    // только задвоила бы его. Наши паки собираются без аудио в видео —
    // тогда звук берётся из дорожек пака и играет синхронно с картинкой.
    const syncAudio = $<HTMLAudioElement>("studio-sync-audio");
    let ownAudio: AudioBuffer | null = null;
    try {
      ownAudio = (await loadVideoFile(state.videoFile as File)).audioBuffer;
    } catch {
      ownAudio = null;
    }
    if (ownAudio) {
      state.audioBuffer = ownAudio;
      attachSyncedAudio(video, syncAudio, null);
    } else {
      state.audioBuffer = await decodePackAudio(pack);
      const track = pack.originalTrack ?? pack.backingTrack;
      attachSyncedAudio(video, syncAudio, track ? URL.createObjectURL(track) : null);
    }

    await attachVideoSource(video, state.videoUrl);
    state.durationSec = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : state.audioBuffer.duration;
    renderTimeline(state, video);
    showScreen("timeline");
    note(`пак открылся в редакторе: реплик ${state.clips.length}`);
    setFeedbackContext(diagContext({ stage: undefined }));
    trackReady(state.mode ?? "dub");
  } catch (err) {
    console.error(err);
    showScreen("warn");
    showFailure(err);
  }
}

// ---------- Экран 2: выбор режима ----------
$("studio-mode-back").addEventListener("click", () => showScreen("warn"));
$("studio-mode-voiceover").addEventListener("click", () => void startPipeline("voiceover"));
$("studio-mode-dub").addEventListener("click", () => void startPipeline("dub"));

const stageLabel = $("studio-stage-label");
const progressFill = $("studio-progress-fill");
const processingPreview = $<HTMLVideoElement>("studio-processing-preview");

/**
 * Прогресс ведёт не только полоску, но и кадр: видео перематывается на то
 * место, до которого дошёл разбор. Ждать несколько минут перед пустой
 * полоской тяжело, а так видно, что работа идёт по ролику.
 */
const stagePercent = $("studio-stage-percent");
const stageNote = $("studio-stage-note");

/** Подсказки под полоской: ожидание долгое, пустой экран его удлиняет. */
const STAGE_NOTES: Partial<Record<MsgKey, MsgKey>> = {
  studioStageSeparate: "studioStageSeparateLong",
  studioStageCut: "studioStageAlmost",
};

const setProgress: ProgressFn = (labelKey, ratio, vars) => {
  const clamped = Math.max(0, Math.min(1, ratio));
  stageLabel.textContent = t(labelKey, vars);
  stagePercent.textContent = `${Math.round(clamped * 100)}%`;
  const note = STAGE_NOTES[labelKey];
  stageNote.textContent = note ? t(note) : "";
  progressFill.style.width = `${Math.round(clamped * 100)}%`;
  const duration = processingPreview.duration;
  if (Number.isFinite(duration) && duration > 0 && processingPreview.readyState >= 1) {
    processingPreview.currentTime = Math.min(duration - 0.05, clamped * duration);
  }
};

async function startPipeline(mode: StudioMode): Promise<void> {
  if (!state.videoFile) return;
  state.mode = mode;
  note(`выбрал режим: ${mode === "dub" ? "Дубляж" : "Закадр"}`);
  trackMode(mode);
  const startedAt = performance.now();
  showScreen("processing");
  processingPreview.src = state.videoUrl;
  resetTimings();
  try {
    setProgress("studioStageMedia", 0.05);
    const media = await timed("чтение видео", () => loadVideoFile(state.videoFile as File));
    state.audioBuffer = media.audioBuffer;
    state.durationSec = media.durationSec;
    await timed("подключение <video>", () => attachVideoSource(video, state.videoUrl));

    if (mode === "voiceover") await runVoiceoverPipeline(state, video, setProgress);
    else await runDubPipeline(state, video, setProgress);

    renderTimeline(state, video);
    showScreen("timeline");
    note(`редактор открылся: реплик ${state.clips.length}`);
    setFeedbackContext(diagContext({ stage: undefined }));
    trackReady(mode);
    trackDuration(mode, (performance.now() - startedAt) / 1000);
  } catch (err) {
    console.error(err);
    showScreen("warn");
    showFailure(err);
  }
}

function isMsgKey(s: string): s is MsgKey {
  return s === "studioBadVideo" || s === "studioNoClips" || s === "studioNoCodec";
}

/**
 * Свои ошибки пайплайна — своим текстом, чужие (упавший ort, нехватка памяти,
 * недокачанная модель) — как есть. Раньше сюда сваливалось всё подряд под
 * видом «не удалось прочитать видео», и по сообщению нельзя было понять, что
 * сломалось на самом деле.
 */
function showFailure(err: unknown, box: HTMLElement = errorBox): void {
  const detail = err instanceof Error ? err.message : String(err);
  note(`ошибка: ${detail}`);
  trackStudioError(errorSlug(err));
  const ctx = diagContext({ error: detail });
  setFeedbackContext(ctx);
  if (err instanceof Error && isMsgKey(err.message)) showErrorIn(box, err.message);
  else showErrorIn(box, "studioFailed", { error: detail });
  offerFeedback(box, ctx);
}

/**
 * Слаг для аналитики. Набор закрытый: сам текст ошибки может содержать имя
 * файла, и отправлять его наружу нельзя.
 */
function errorSlug(err: unknown): StudioErrorSlug {
  const message = err instanceof Error ? err.message : String(err);
  if (message === "studioNoCodec") return "bad-codec";
  if (message === "studioNoClips") return "no-clips";
  if (message === "studioBadVideo") return "pack-read-failed";
  if (message.includes("звук видео не декодировался")) return "decode-failed";
  if (message.includes("не удалось прочитать файл")) return "decode-failed";
  return "build-failed";
}

/**
 * Момент ошибки — лучший для сбора фидбека: человек уже столкнулся с
 * проблемой, и заставлять его искать контакты в подвале главной жестоко.
 * Текст ошибки кладём в буфер обмена одной кнопкой — пересказывать его
 * своими словами никто не станет.
 */
function offerFeedback(box: HTMLElement, ctx: DiagnosticContext): void {
  const row = document.createElement("span");
  row.className = "studio-feedback";

  const hint = document.createElement("small");
  hint.className = "studio-report-hint";
  hint.textContent = t("studioReportHint");

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "btn btn-text btn-sm";
  copy.textContent = t("studioCopyReport");
  copy.addEventListener("click", () => {
    void buildReport(ctx).then((report) =>
      navigator.clipboard?.writeText(report).then(() => {
        copy.textContent = t("studioCopied");
      })
    );
  });

  // Открывает ту же форму, что кнопка в подвале: отчёт к письму приложится
  // сам. Раньше здесь была ссылка в Telegram, и от игрока требовалось три
  // действия (скопировать, открыть, вставить) — на последнем шаге отчёт
  // терялся вместе с половиной смысла обращения.
  const link = document.createElement("button");
  link.type = "button";
  link.className = "btn btn-pill btn-sm";
  link.textContent = t("studioTellUs");
  link.addEventListener("click", () => openFeedbackForm());

  row.append(link, copy);
  box.append(document.createElement("br"), row, hint);
}

// ---------- Экран 4: таймлайн ----------
$("studio-timeline-back").addEventListener("click", () => showScreen("mode"));
const buildButton = $<HTMLButtonElement>("studio-build");
buildButton.addEventListener("click", () => void buildAndPlay());

/**
 * Раньше здесь стояло `void playInGame(pack)` — и любая ошибка передачи пака
 * в игру пропадала вместе с промисом: кнопка «Собрать пак» просто ничего не
 * делала (наступали в Safari). Теперь ждём результат и показываем провал.
 */
async function buildAndPlay(): Promise<void> {
  buildErrorBox.hidden = true;
  const label = buildButton.textContent;
  buildButton.disabled = true;
  buildButton.textContent = t("studioBuilding");
  try {
    const pack = buildPack(state);
    builtPack = pack;
    note(`собрал пак: реплик ${state.clips.length}, персонажей ${state.characters.length}`);
    trackBuild(state.mode ?? "dub");
    // Отдельный экран «готово» не нужен: собрал — играй. Скачать пак и
    // вернуться в редактор можно уже с карточки пака в игре.
    await playInGame(pack);
  } catch (err) {
    console.error(err);
    showFailure(err, buildErrorBox);
    buildButton.disabled = false;
    buildButton.textContent = label;
  }
}

// ---------- Экран 5: готово ----------
let builtPack: DubPack | null = null;

$("studio-play-now").addEventListener("click", () => {
  if (builtPack) void playInGame(builtPack);
});
$("studio-download-zip").addEventListener("click", () => {
  if (builtPack) void downloadZip(builtPack);
});
$("studio-start-over").addEventListener("click", () => location.reload());

showScreen("warn");
note("открыл студию");
trackStudioOpen();
trackUncaught();
initFeedback();

// Видео могли бросить на главный экран игры — тогда экран предупреждения
// уже не нужен: игрок своё решение принял, сразу к выбору режима.
void takePendingVideo().then((file) => {
  if (file) acceptVideoFile(file);
});

// Пак, отправленный из игры кнопкой «Редактировать пак».
void takePackForStudio().then((pack) => {
  if (pack) {
    trackSource("handoff");
    void openExistingPack(Promise.resolve(pack));
  }
});
