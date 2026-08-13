import "./style.css";
import { loadPackFromZip, loadPackFromFiles, collectDroppedFiles } from "./pack/loader";
import { DubPack, PackError } from "./pack/types";
import { PRELOADED_PACKS, packUrls, fetchWithProgress, formatSize } from "./pack/preloaded";
import { audioContext } from "./audio/context";
import {
  MicRecorder,
  recordingToBuffer,
  takeWindow,
  windowedRecording,
  type Recording,
} from "./audio/recorder";
import { matchLoudness } from "./audio/normalize";
import { WaveformView, type WaveformColors } from "./audio/waveform";
import { DubSession, ORIGINAL_LANG } from "./game/session";
import { Composer, type MixMode } from "./game/composer";
import { scoreTake, totalPercent, verdictKey } from "./game/score";
import { createVideoPlayer, DubVideoPlayer } from "./video/player";
import { t, lang, langName, setLang, Lang } from "./i18n";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------- Элементы ----------
const screens = {
  home: $("screen-home"),
  pack: $("screen-pack"),
  dub: $("screen-dub"),
  final: $("screen-final"),
};

function showScreen(name: keyof typeof screens): void {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
}

// ---------- Состояние приложения ----------
const packs: DubPack[] = [];
let selectedPack: DubPack | null = null;
let session: DubSession | null = null;
let videoPlayer: DubVideoPlayer | null = null;
let composer: Composer | null = null;
const recorder = new MicRecorder();

const waveColors: WaveformColors = {
  // Оболочка по пикам приглушённая, сердцевина по RMS — светлая.
  // Пурпур оригинала против бирюзы игрока: запись кладётся плотно и доминирует
  original: { shell: "#7d2470", core: "#e055c4" },
  user: { shell: "#25b3a3", core: "#b6ffee" },
  userLayers: { shell: 0.28, halo: 0.42, core: 0.85 },
  userBlend: "screen",
  playhead: "#ffffff",
  midline: "rgba(255,255,255,0.5)",
};
let waveform: WaveformView | null = null;

// ---------- Язык ----------
function syncLangButtons(): void {
  $("lang-ru").classList.toggle("active", lang() === "ru");
  $("lang-en").classList.toggle("active", lang() === "en");
}

function switchLang(l: Lang): void {
  setLang(l);
  syncLangButtons();
  refreshDynamicTexts();
}

$("lang-ru").addEventListener("click", () => switchLang("ru"));
$("lang-en").addEventListener("click", () => switchLang("en"));

// Логотип ведёт на главную (с подтверждением, если есть активная сессия)
$("logo").addEventListener("click", () => {
  if (!screens.home.hidden) return; // уже на главной
  if (session && !confirm(t("quitConfirm"))) return;
  abandonSession();
  showScreen("home");
});

/** Обновляет тексты, которые рисуются из кода (не через data-i18n). */
function refreshDynamicTexts(): void {
  renderPreloadedList();
  renderPackList();
  if (selectedPack && !screens.pack.hidden) fillPackCard(selectedPack);
  if (session) {
    $("dub-counter").textContent = t("clipCounter", {
      i: session.clipIndex + 1,
      n: session.total,
    });
    renderCaption(); // «Ориг.» на пилле и подсказка правки тоже переводятся
    updateDubButtons();
  }
  if (composer) {
    $("btn-export").textContent = t("downloadVideo", { fmt: composer.videoExt.toUpperCase() });
  }
  if (!$("results").hidden) void renderResults(); // «Балл»/вердикт на новом языке
}

// ================= ЭКРАН 1: дом =================
const dropZone = $("drop-zone");
const homeError = $("home-error");
const packList = $("pack-list");
const preloadedList = $("preloaded-list");

function showHomeError(message: string): void {
  homeError.textContent = message;
  homeError.hidden = false;
}

async function addPack(load: Promise<DubPack>): Promise<void> {
  homeError.hidden = true;
  dropZone.classList.remove("dragover");
  try {
    const pack = await load;
    packs.push(pack);
    renderPackList();
    selectPack(pack);
  } catch (err) {
    if (err instanceof PackError) showHomeError(err.message);
    else {
      console.error(err);
      showHomeError(t("genericLoadError"));
    }
  }
}

// --- Встроенные паки ---
const preloadedBusy = new Set<string>();
/** Выбранный (подсвеченный) пак в галерее — у него видна кнопка «Скачать». */
let selectedPreloadedId: string | null = null;

function renderPreloadedList(): void {
  preloadedList.replaceChildren(
    ...PRELOADED_PACKS.map((pp) => {
      const card = document.createElement("div");
      card.className = "preloaded-item";
      card.dataset.packId = pp.id;
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.classList.toggle("selected", selectedPreloadedId === pp.id);

      const icon = document.createElement("img");
      icon.className = "pi-icon";
      icon.src = pp.icon;
      icon.alt = "";
      icon.loading = "lazy";

      const meta = document.createElement("div");
      meta.className = "pi-meta";
      const titleRow = document.createElement("div");
      titleRow.className = "pi-title-row";
      const title = document.createElement("div");
      title.className = "pi-title";
      title.textContent = pp.title;
      titleRow.append(title);
      for (const tag of pp.tags ?? []) {
        const badge = document.createElement("span");
        badge.className = "pi-tag";
        badge.textContent = tag;
        if (tag === "18+") badge.title = t("tagAdultTooltip");
        titleRow.append(badge);
      }
      const size = document.createElement("div");
      size.className = "pi-size";
      size.textContent = formatSize(pp.sizeBytes);
      meta.append(titleRow, size);

      const download = document.createElement("button");
      download.className = "btn btn-primary pi-download";
      download.textContent = `⬇ ${t("packDownload")}`;
      download.hidden = selectedPreloadedId !== pp.id;
      download.addEventListener("click", (e) => {
        e.stopPropagation();
        void loadPreloaded(pp.id);
      });

      const progress = document.createElement("span");
      progress.className = "pi-progress";

      card.append(icon, meta, download, progress);
      const select = () => {
        if (preloadedBusy.has(pp.id)) return;
        selectedPreloadedId = pp.id;
        renderPreloadedList();
      };
      card.addEventListener("click", select);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select();
        }
      });
      return card;
    })
  );
}

async function loadPreloaded(id: string): Promise<void> {
  const pp = PRELOADED_PACKS.find((p) => p.id === id);
  if (!pp || preloadedBusy.has(id)) return;
  preloadedBusy.add(id);
  homeError.hidden = true;

  const item = preloadedList.querySelector<HTMLElement>(`[data-pack-id="${id}"]`);
  const sizeEl = item?.querySelector<HTMLElement>(".pi-size");
  const barEl = item?.querySelector<HTMLElement>(".pi-progress");
  const btnEl = item?.querySelector<HTMLButtonElement>(".pi-download");
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.classList.add("downloading");
    btnEl.textContent = t("packLoading");
  }
  item?.classList.add("loading");

  try {
    const blob = await fetchWithProgress(packUrls(pp), pp.sizeBytes, (ratio) => {
      if (barEl) barEl.style.width = `${ratio * 100}%`;
      if (sizeEl) sizeEl.textContent = `${t("packLoading")} ${Math.round(ratio * 100)}%`;
    });
    if (sizeEl) sizeEl.textContent = t("packUnpacking");
    await addPack(loadPackFromZip(new File([blob], `${pp.id}.zip`)));
  } catch (err) {
    console.error(err);
    showHomeError(t("fetchError"));
  } finally {
    preloadedBusy.delete(id);
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.classList.remove("downloading");
      btnEl.textContent = `⬇ ${t("packDownload")}`;
    }
    item?.classList.remove("loading");
    if (sizeEl) sizeEl.textContent = formatSize(pp.sizeBytes);
    if (barEl) barEl.style.width = "0";
  }
}

function renderPackList(): void {
  $("loaded-label").hidden = packs.length === 0;
  packList.replaceChildren(
    ...packs.map((pack, i) => {
      const btn = document.createElement("button");
      btn.className = "pack-list-item";
      const img = document.createElement("img");
      img.alt = "";
      if (pack.icon) img.src = URL.createObjectURL(pack.icon);
      const meta = document.createElement("div");
      const title = document.createElement("div");
      title.className = "pli-title";
      title.textContent = pack.title;
      const sub = document.createElement("div");
      sub.className = "pli-sub";
      sub.textContent = `${pack.clips.length} ${t("clipsCount")}${pack.authors.length ? " · " + pack.authors.join(", ") : ""}`;
      meta.append(title, sub);
      btn.append(img, meta);
      btn.addEventListener("click", () => selectPack(packs[i]));
      return btn;
    })
  );
}

$("btn-pick-zip").addEventListener("click", () => $("input-zip").click());
$("btn-pick-folder").addEventListener("click", () => $("input-folder").click());

$<HTMLInputElement>("input-zip").addEventListener("change", (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void addPack(loadPackFromZip(file));
  (e.target as HTMLInputElement).value = "";
});

$<HTMLInputElement>("input-folder").addEventListener("change", (e) => {
  const files = (e.target as HTMLInputElement).files;
  if (files?.length) void addPack(loadPackFromFiles(files));
  (e.target as HTMLInputElement).value = "";
});

for (const evt of ["dragover", "dragenter"] as const) {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
}
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  const dt = (e as DragEvent).dataTransfer;
  if (!dt) return;
  const single = dt.files.length === 1 ? dt.files[0] : null;
  if (single && single.name.toLowerCase().endsWith(".zip")) {
    void addPack(loadPackFromZip(single));
  } else {
    void addPack(collectDroppedFiles(dt.items).then(loadPackFromFiles));
  }
});

// ================= ЭКРАН 2: карточка пака =================
const micStatus = $("mic-status");

function fillPackCard(pack: DubPack): void {
  const icon = $<HTMLImageElement>("pack-icon");
  icon.src = pack.icon ? URL.createObjectURL(pack.icon) : "";
  icon.hidden = !pack.icon;
  $("pack-title").textContent = pack.title;
  $("pack-subtitle").textContent = pack.subtitle;
  $("pack-authors").textContent = pack.authors.length
    ? `${t("author")}: ${pack.authors.join(", ")}`
    : "";
  // Языки перевода — часть характеристик пака, как и фоновая дорожка
  const stats = [
    `${pack.clips.length} ${t("clipsCount")}`,
    pack.backingTrack ? t("withBacking") : t("withoutBacking"),
  ];
  if (pack.translations.length > 0) {
    stats.push(`${t("captionsLabel")}: ${[pack.lang, ...pack.translations].filter(Boolean).map(langName).join(", ")}`);
  }
  $("pack-stats").textContent = stats.join(" · ");
  const warn = $("pack-warnings");
  warn.hidden = pack.warnings.length === 0;
  warn.textContent = pack.warnings.join(" ");
}

function selectPack(pack: DubPack): void {
  selectedPack = pack;
  fillPackCard(pack);
  micStatus.textContent = "";
  micStatus.classList.remove("error");
  showScreen("pack");
}

$("btn-pack-back").addEventListener("click", () => showScreen("home"));

$("btn-start").addEventListener("click", async () => {
  if (!selectedPack) return;
  // По HTTP браузеры вообще не показывают промпт микрофона — объясняем сразу
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    micStatus.textContent = t("micInsecure");
    micStatus.classList.add("error");
    return;
  }
  audioContext(); // создаём по жесту пользователя
  micStatus.textContent = t("micRequest");
  micStatus.classList.remove("error");
  try {
    await recorder.init();
  } catch {
    micStatus.textContent = t("micError");
    micStatus.classList.add("error");
    return;
  }
  micStatus.textContent = t("videoPreparing");
  try {
    videoPlayer?.dispose();
    videoPlayer = await createVideoPlayer(selectedPack.video, selectedPack.videoKind);
  } catch (err) {
    console.error(err);
    micStatus.textContent = t("videoError");
    micStatus.classList.add("error");
    return;
  }
  session = new DubSession(selectedPack, lang());
  composer?.dispose();
  composer = new Composer(videoPlayer);
  // Экран показываем до загрузки клипа, чтобы canvas получил размеры
  showScreen("dub");
  await enterClip(0);
});

// ================= ЭКРАН 3: дубляж =================
const dubImage = $<HTMLImageElement>("dub-image");
const dubVideoSlot = $("dub-video-slot");
const dubNoImage = $("dub-noimage");
const btnRecord = $<HTMLButtonElement>("btn-record");
const btnNext = $<HTMLButtonElement>("btn-next");
const btnBack = $<HTMLButtonElement>("btn-dub-back");
const btnOrig = $<HTMLButtonElement>("btn-orig");
const btnPlayTake = $<HTMLButtonElement>("btn-play-take");
const recordBadge = $("record-badge");
const toggleMonitor = $<HTMLInputElement>("toggle-monitor");
const toggleCountdown = $<HTMLInputElement>("toggle-countdown");
const dubCountdown = $("dub-countdown");
const dubCaption = $("dub-caption");
const captionLangsRow = $("dub-caption-langs");
const captionEdit = $("dub-caption-edit");
const captionEditHint = document.querySelector<HTMLElement>(".caption-edit-hint")!;
const captionInput = $<HTMLTextAreaElement>("dub-caption-input");
const btnCaptionDone = $<HTMLButtonElement>("btn-caption-done");
const monitorVolume = $<HTMLInputElement>("monitor-volume");
const monitorVolumeValue = $("monitor-volume-value");

let clipImageUrl: string | null = null;
/**
 * Миниатюры реплик для экрана результатов. Паки с кадрами (`image=`) отдают
 * их сами, а для паков без картинок кадр снимаем прямо во время просмотра
 * фрагмента: видео и так играет на экране, лишней работы браузеру это не даёт
 * (перематывать и декодировать все реплики отдельно — дорого, а у ogv.js
 * кадр после перемотки ещё и ненадёжен).
 */
const clipThumbs = new Map<number, string>();
const THUMB_HEIGHT = 180;

function captureThumb(index: number): void {
  if (!videoPlayer || clipThumbs.has(index) || session?.pack.clips[index].image) return;
  const src = videoPlayer.frameSource();
  // Размер canvas у ogv.js точнее, чем videoWidth (там бывает паддинг)
  const w = src instanceof HTMLCanvasElement ? src.width : videoPlayer.videoWidth;
  const h = src instanceof HTMLCanvasElement ? src.height : videoPlayer.videoHeight;
  if (!w || !h) return;
  const canvas = document.createElement("canvas");
  canvas.height = THUMB_HEIGHT;
  canvas.width = Math.max(1, Math.round((w / h) * THUMB_HEIGHT));
  try {
    canvas.getContext("2d")!.drawImage(src, 0, 0, canvas.width, canvas.height);
    clipThumbs.set(index, canvas.toDataURL("image/jpeg", 0.82));
  } catch {
    /* кадр ещё не готов — снимем на следующей реплике */
  }
}

let previewSource: AudioBufferSourceNode | null = null;
let monitorSource: AudioBufferSourceNode | null = null;
let monitorGain: GainNode | null = null;
let playheadRaf = 0;
let watchTimer = 0;
/** Токен активного воспроизведения фрагмента: инкремент отменяет старые rAF-циклы. */
let watchToken = 0;

// Громкость мониторинга: слайдер работает и во время записи
monitorVolume.addEventListener("input", () => {
  monitorVolumeValue.textContent = `${monitorVolume.value}%`;
  if (monitorGain) monitorGain.gain.value = Number(monitorVolume.value) / 100;
});

async function enterClip(index: number): Promise<void> {
  if (!session) return;
  cancelCountdown(); // отсчёт с прошлой реплики новой уже не нужен
  savingTail = false;
  closeCaptionEditor();
  session.clipIndex = index;
  session.prefetchAround();
  const clip = session.clip;

  $("dub-counter").textContent = t("clipCounter", { i: index + 1, n: session.total });
  $("dub-progress-fill").style.width = `${(index / session.total) * 100}%`;
  renderCaption();
  $("dub-character").textContent = clip.characters.join(", ");

  if (clipImageUrl) URL.revokeObjectURL(clipImageUrl);
  clipImageUrl = clip.image ? URL.createObjectURL(clip.image) : null;
  dubImage.src = clipImageUrl ?? "";
  dubImage.hidden = !clipImageUrl;
  dubNoImage.hidden = !!clipImageUrl;
  hideWatchVideo();

  if (!waveform) {
    waveform = new WaveformView($<HTMLCanvasElement>("dub-waveform"), waveColors);
    new ResizeObserver(() => waveform?.resize()).observe($("dub-waveform"));
  }
  waveform.clearUserRecording();
  waveform.setPlayhead(null);

  const existing = session.recordings.get(index);
  const buf = await session.originalBuffer(index);
  waveform.setOriginal(buf);
  if (existing) {
    const existingWindow = takeWindow(existing, buf.duration);
    waveform.setUserRecording(existingWindow, takeTimelineSamples(buf, existingWindow.length));
  }
  updateDubButtons();

  // Реплику сразу показываем целиком: видео + звук + бегущий по волне курсор
  void playOriginalVideo();
}

/**
 * Шкала, по которой рисуется волна дубля, — всегда длина оригинальной реплики.
 * Иначе досрочно остановленный дубль растягивался бы на всю ширину сразу после
 * записи и сжимался при возврате к реплике.
 */
function takeTimelineSamples(original: AudioBuffer, takeSamples: number): number {
  return Math.max(Math.floor(original.duration * audioContext().sampleRate), takeSamples);
}

function updateDubButtons(): void {
  if (!session) return;
  const hasTake = session.recordings.has(session.clipIndex);
  // Отсчёт занимает экран так же, как запись: соседние кнопки на это время
  // выключены, а «Записать» превращается в отмену
  const busy = recorder.isRecording || countdownActive;
  btnNext.disabled = !hasTake || countdownActive;
  btnNext.textContent = session.isLastClip ? t("nextFinal") : t("next");
  btnRecord.textContent = countdownActive
    ? t("cancelCountdown")
    : savingTail
      ? t("savingTake")
      : recorder.isRecording
        ? t("stopRec")
        : hasTake
          ? t("reRecord")
          : t("record");
  btnRecord.disabled = savingTail; // дозапись хвоста прервать нечем — она мгновенная
  btnRecord.classList.toggle("recording", recorder.isRecording && !savingTail);
  recordBadge.hidden = !recorder.isRecording || savingTail;
  btnPlayTake.hidden = !hasTake || busy;
  btnPlayTake.textContent = t("myTake");
  btnOrig.disabled = busy;
  btnBack.disabled = busy;
  $("waveform-hint").textContent = countdownActive
    ? t("hintCountdown")
    : savingTail
      ? t("hintSaving")
      : recorder.isRecording
      ? t("hintRecording")
      : hasTake
        ? t("hintHasTake")
        : t("hintIdle");
}

function stopPreview(): void {
  cancelAnimationFrame(playheadRaf);
  waveform?.setPlayhead(null);
  if (previewSource) {
    try { previewSource.stop(); } catch { /* уже остановлен */ }
    previewSource.disconnect();
    previewSource = null;
  }
}

/**
 * Подгоняет рамку под реальные пропорции видео, чтобы не было пустых полей
 * вокруг ролика. Высоту ограничиваем 62vh, чтобы кнопки оставались на экране.
 */
function fitFrameToVideo(frame: HTMLElement | null): boolean {
  if (!frame || !videoPlayer) return false;
  // Размер canvas у ogv.js точнее, чем videoWidth кодека (там бывает паддинг)
  const src = videoPlayer.frameSource();
  const isCanvas = src instanceof HTMLCanvasElement;
  const w = (isCanvas ? src.width : 0) || videoPlayer.videoWidth;
  const h = (isCanvas ? src.height : 0) || videoPlayer.videoHeight;
  if (!w || !h) return false;
  frame.style.aspectRatio = `${w} / ${h}`;
  // width задаём явно: содержимое рамки абсолютное, а auto-маржины
  // отключают grid-stretch — без этого рамка схлопывается
  frame.style.width = "100%";
  frame.style.maxWidth = `min(100%, calc(62vh * ${(w / h).toFixed(4)}))`;
  frame.style.marginInline = "auto";
  return true;
}

/** Размеры видео у ogv.js появляются только с первым кадром — подгоняем с повтором. */
function fitFrameWhenReady(frame: HTMLElement | null): void {
  if (!frame) return;
  let tries = 0;
  const attempt = () => {
    if (fitFrameToVideo(frame) || ++tries > 25) return;
    setTimeout(attempt, 200);
  };
  attempt();
}

/**
 * Запускает видеофрагмент реплики (всегда без звука видео — звук ведём сами
 * через Web Audio: аудиотракт ogv.js ненадёжен в Safari/Arc).
 */
async function startClipVideo(waitPlaying = false): Promise<boolean> {
  if (!session || !videoPlayer) return false;
  showWatchVideo();
  fitFrameWhenReady(document.querySelector(".dub-screen-frame"));
  videoPlayer.muted = true;
  videoPlayer.currentTime = session.clip.timestamps[0];
  // Подписка строго между перемоткой и play: перемотка сама шлёт события,
  // а после play() сигнал можно уже не застать
  const playing = waitPlaying ? videoPlayer.whenPlaying() : null;
  await videoPlayer.play().catch(() => {});
  return playing ? await playing : false;
}

/**
 * Видео + аудиобуфер вместе: оригинал реплики или свой дубль.
 * cursor задаёт, какой отрезок буфера считать самой репликой: у дубля вокруг
 * неё есть запас, и без поправки курсор ехал бы не по волне.
 */
async function playClipWithAudio(
  buffer: AudioBuffer,
  cursor?: { lead: number; span: number }
): Promise<void> {
  if (!session || !videoPlayer) return;
  stopPreview();
  const dur = buffer.duration;
  const cursorLead = cursor?.lead ?? 0;
  const cursorSpan = cursor?.span || dur;
  const token = ++watchToken;
  const clipIndex = session.clipIndex;

  await startClipVideo();
  if (token !== watchToken) return; // пока грузились, фрагмент уже отменили

  // Звук — через общий AudioContext (он разблокирован жестом и точно слышен)
  const ctx = audioContext();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  const t0 = ctx.currentTime;
  src.start();
  previewSource = src;

  // Курсор ведём по аудиочасам — они точнее, чем currentTime у ogv.js
  const animate = () => {
    if (token !== watchToken) return;
    const ratio = (ctx.currentTime - t0 - cursorLead) / cursorSpan;
    if (ratio >= 1) {
      hideWatchVideo();
      return;
    }
    // Середина фрагмента — там персонаж уже точно в кадре и говорит
    if (ratio > 0.45) captureThumb(clipIndex);
    waveform?.setPlayhead(Math.max(ratio, 0));
    playheadRaf = requestAnimationFrame(animate);
  };
  playheadRaf = requestAnimationFrame(animate);

  // Подстраховка на случай проблем с rAF в фоновой вкладке
  clearTimeout(watchTimer);
  watchTimer = window.setTimeout(() => hideWatchVideo(), (dur + 2) * 1000);
}

async function playOriginalVideo(): Promise<void> {
  if (!session) return;
  await playClipWithAudio(await session.originalBuffer());
}

function showWatchVideo(): void {
  if (!videoPlayer) return;
  if (videoPlayer.element.parentElement !== dubVideoSlot) {
    // replaceChildren: в слоте не должно остаться плеера от прошлого пака
    dubVideoSlot.replaceChildren(videoPlayer.element);
  }
  dubVideoSlot.hidden = false;
  dubImage.hidden = true;
  dubNoImage.hidden = true;
}

/**
 * Кадр-заставка вместо картинки реплики: то же видео, оставленное на паузе в
 * начале реплики. Паки, собранные без превью-картинок (наш пайплайн их не
 * делает — движок и так умеет паузить видео), иначе показывали бы пустой
 * плейсхолдер.
 *
 * Только для mp4/webm: у ogv.js отрисовка кадра после перемотки на паузе
 * ненадёжна (он ведёт видео по аудиочасам), там честнее оставить заглушку.
 */
function showStillFrame(): boolean {
  if (!session || !videoPlayer || session.pack.videoKind !== "native") return false;
  if (videoPlayer.element.parentElement !== dubVideoSlot) {
    dubVideoSlot.replaceChildren(videoPlayer.element);
  }
  dubVideoSlot.hidden = false;
  videoPlayer.currentTime = session.clip.timestamps[0];
  fitFrameWhenReady(document.querySelector(".dub-screen-frame"));
  return true;
}

/**
 * Останавливает показ фрагмента. `keepStill = false` — когда экран дубляжа
 * покидают совсем (финал, выход из сессии): там плеер либо уезжает в другой
 * слот, либо уничтожается, и трогать его незачем.
 */
/**
 * Отменяет активный просмотр фрагмента, не трогая сам плеер: перед записью
 * видео нужно не прятать, а сразу пускать — лишняя пауза со стоп-кадром
 * стоит на слабых устройствах ещё одной перемотки.
 */
function cancelWatch(): void {
  watchToken++;
  clearTimeout(watchTimer);
  stopPreview(); // глушим и звук фрагмента, если он ещё шёл
}

function hideWatchVideo(keepStill = true): void {
  cancelWatch();
  videoPlayer?.pause();
  const still = keepStill && !clipImageUrl && showStillFrame();
  if (!still) dubVideoSlot.hidden = true;
  dubImage.hidden = !clipImageUrl;
  dubNoImage.hidden = !!clipImageUrl || still;
}

btnOrig.addEventListener("click", () => void playOriginalVideo());

btnPlayTake.addEventListener("click", () => {
  if (!session) return;
  const rec = session.recordings.get(session.clipIndex);
  if (!rec) return;
  // Дубль тоже с видео; курсор ведём по окну реплики, запас он проходит молча
  void session.originalBuffer().then((original) =>
    playClipWithAudio(recordingToBuffer(rec), { lead: rec.leadSec, span: original.duration })
  );
});

/**
 * Субтитр реплики: пиллы языков (только у паков с переводами), сам текст и
 * скрытое поле правки. Свой вариант текста живёт в сессии и подставляется
 * вместо субтитра — озвучивать можно ровно то, что видишь.
 */
function renderCaption(): void {
  if (!session) return;
  const langs = session.captionLangs;
  captionLangsRow.hidden = langs.length === 0;
  captionLangsRow.replaceChildren(
    ...langs.map((lang) => {
      const pill = document.createElement("button");
      pill.className = "caption-lang";
      pill.classList.toggle("active", lang === session!.captionLang);
      pill.textContent = lang === ORIGINAL_LANG ? langLabel(session!.pack.lang) : langLabel(lang);
      pill.addEventListener("click", () => {
        if (!session) return;
        session.captionLang = lang;
        closeCaptionEditor();
        renderCaption();
      });
      return pill;
    })
  );

  const text = session.captionFor();
  dubCaption.textContent = text || t("noCaption");
  dubCaption.classList.toggle("edited", session.isCaptionEdited());
  dubCaption.title = t("captionEditHint");
}

/** Ярлык на пилле: название языка, у пака без lang — «Оригинал». */
function langLabel(lang: string): string {
  return lang === ORIGINAL_LANG ? t("langOriginal") : langName(lang);
}

function openCaptionEditor(): void {
  if (!session || recorder.isRecording || countdownActive) return;
  captionInput.value = session.captionFor();
  dubCaption.hidden = true;
  captionEditHint.hidden = true; // подсказка уже сработала
  captionEdit.hidden = false;
  captionInput.focus();
  captionInput.select();
}

function closeCaptionEditor(save = false): void {
  if (captionEdit.hidden) return;
  if (save && session) session.editCaption(captionInput.value.trim());
  captionEdit.hidden = true;
  captionEditHint.hidden = false;
  dubCaption.hidden = false;
  renderCaption();
}

dubCaption.addEventListener("click", openCaptionEditor);
btnCaptionDone.addEventListener("click", () => closeCaptionEditor(true));
captionInput.addEventListener("keydown", (e) => {
  // Enter сохраняет, Shift+Enter — перенос строки, Esc отменяет
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    closeCaptionEditor(true);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeCaptionEditor();
  }
});

/**
 * Реплика доиграла, идёт дозапись хвоста. Для игрока запись уже кончилась:
 * видео убрано, бейдж погашен, кнопка показывает «Сохраняю…». Хвост нужен,
 * только чтобы не срезать договорённое после персонажа.
 */
let savingTail = false;

/** Токен отсчёта: инкремент отменяет уже идущий. */
let countdownToken = 0;
let countdownActive = false;

function cancelCountdown(): void {
  if (!countdownActive) return;
  countdownToken++;
  countdownActive = false;
  dubCountdown.hidden = true;
  recorder.disarm(); // микрофон подключали под запись, которой не будет
  updateDubButtons();
}

/**
 * Отсчёт 3–2–1 перед записью (по галочке). Пауза нужна не только игроку:
 * за эти секунды микрофон подключается к графу и раскачивается, а плеер
 * встаёт на нужный кадр — к старту записи всё уже прогрето и первый кадр
 * приходит без задержки. false — отсчёт отменили.
 */
async function runCountdown(): Promise<boolean> {
  const token = ++countdownToken;
  countdownActive = true;
  updateDubButtons();

  // Отсчёт могли отменить, пока микрофон подключался, — тогда сразу отпускаем
  void recorder
    .arm()
    .then(() => {
      if (token !== countdownToken) recorder.disarm();
    })
    .catch(() => {}); // ошибку доступа поймает start() после отсчёта
  if (videoPlayer && session) {
    videoPlayer.pause(); // предпросмотр мог ещё идти
    videoPlayer.currentTime = session.clip.timestamps[0];
  }

  for (const n of [3, 2, 1]) {
    const digit = document.createElement("span");
    digit.textContent = String(n);
    dubCountdown.replaceChildren(digit);
    dubCountdown.hidden = false;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (token !== countdownToken) return false;
  }
  dubCountdown.hidden = true;
  countdownActive = false;
  return true;
}

function stopMonitor(): void {
  if (monitorSource) {
    try { monitorSource.stop(); } catch { /* уже остановлен */ }
    monitorSource.disconnect();
    monitorSource = null;
  }
  monitorGain = null;
}

btnRecord.addEventListener("click", async () => {
  if (!session || !waveform) return;
  if (countdownActive) {
    cancelCountdown();
    return;
  }
  if (recorder.isRecording) {
    finishRecording();
    return;
  }
  cancelWatch();
  closeCaptionEditor(); // правку не бросаем открытой поверх записи
  const buf = await session.originalBuffer();
  const totalSamples = Math.floor(buf.duration * audioContext().sampleRate);
  const clipIndex = session.clipIndex;

  if (toggleCountdown.checked && !(await runCountdown())) return;
  if (!session || session.clipIndex !== clipIndex) return;
  waveform.beginUserRecording(totalSamples);

  // Пишем шире реплики (запас с обоих концов), а рисуем ровно её окно:
  // хвост за пределами хронометража в волну не лезет, но в записи остаётся
  let drawn = 0;
  await recorder.start(
    buf.duration,
    (chunk) => {
      const room = totalSamples - drawn;
      if (room <= 0) return;
      const part = chunk.length <= room ? chunk : chunk.subarray(0, room);
      drawn += part.length;
      waveform?.appendUserChunk(part);
    },
    () => finishRecording(true),
    () => {
      // Реплика кончилась: для игрока запись завершена, хвост дописываем молча
      savingTail = true;
      hideWatchVideo();
      stopMonitor();
      waveform?.setPlayhead(null);
      updateDubButtons();
    }
  );
  updateDubButtons(); // кнопка и бейдж откликаются сразу, ещё до первого кадра

  // Во время записи сцена играет без звука — дублируешь прямо под видео.
  // Начало дубля отсчитываем не от клика, а от первого кадра на экране:
  // на медленном устройстве плеер стартует не мгновенно, и без этого запись
  // набирает пустоту, а голос игрока уезжает на то же время — и в финальном
  // ролике, и в оценке (score.ts компенсирует лишь ±0,3 с).
  const started = await startClipVideo(true);
  if (!recorder.isRecording || session?.clipIndex !== clipIndex) return;
  if (started) {
    recorder.markStart();
    drawn = 0;
    waveform.beginUserRecording(totalSamples); // волну рисуем от того же нуля
  }
  // Оригинал в ухо — вместе с видео, иначе подсказка сама себя рассинхронит
  if (toggleMonitor.checked) {
    const ctx = audioContext();
    stopMonitor();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = Number(monitorVolume.value) / 100;
    src.connect(gain).connect(ctx.destination);
    src.start();
    monitorSource = src;
    monitorGain = gain;
  }
});

async function finishRecording(auto = false): Promise<void> {
  if (!session) return;
  savingTail = false;
  stopMonitor();
  hideWatchVideo();
  const rec = auto ? recorder.snapshot() : recorder.stop();
  if (rec.samples.length > 0) {
    const original = await session.originalBuffer();
    // На волне — окно самой реплики: запас с обоих концов в кадр не влезает,
    // но в монтаж уходит запись целиком
    const window = takeWindow(rec, original.duration);
    matchLoudness(rec, original, window);
    session.recordings.set(session.clipIndex, rec);
    waveform?.setUserRecording(window, takeTimelineSamples(original, window.length));
  }
  waveform?.setPlayhead(null);
  updateDubButtons();
}

btnNext.addEventListener("click", () => {
  if (!session) return;
  stopPreview();
  hideWatchVideo();
  if (session.isLastClip) {
    void enterFinal();
  } else {
    void enterClip(session.clipIndex + 1);
  }
});

// «Назад» шагает по репликам: можно вернуться и перезаписать дубль. С первой
// реплики шаг назад выводит из сессии — там это единственный выход «вглубь».
btnBack.addEventListener("click", () => {
  if (!session || recorder.isRecording) return;
  if (session.clipIndex === 0) {
    if (session.recordings.size > 0 && !confirm(t("quitConfirm"))) return;
    abandonSession();
    showScreen(selectedPack ? "pack" : "home");
    return;
  }
  stopPreview();
  hideWatchVideo();
  void enterClip(session.clipIndex - 1);
});

function abandonSession(): void {
  cancelCountdown();
  savingTail = false;
  stopPreview();
  stopMonitor();
  hideWatchVideo(false); // плеер сейчас уничтожат — заставку показывать не на чем
  if (recorder.isRecording) recorder.stop();
  stopExportUi();
  clearResults();
  clipThumbs.clear();
  composer?.dispose();
  composer = null;
  videoPlayer?.dispose();
  videoPlayer = null;
  session = null;
}

// ================= ЭКРАН 4: финал =================
const finalSlot = $("final-video-slot");
const exportStatus = $("export-status");
const btnExport = $<HTMLButtonElement>("btn-export");
const exportCanvas = $<HTMLCanvasElement>("export-canvas");

/** Игрок нажал «Скачать», но файл ещё пишется — отдадим, как только готов. */
let downloadRequested = false;
let exportProgressTimer = 0;

const mixModeInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="mix-mode"]')];

function currentMixMode(): MixMode {
  return mixModeInputs.find((i) => i.checked)?.value === "voiceover" ? "voiceover" : "dub";
}

/**
 * Смена режима меняет саму дорожку, поэтому ролик пересобирается и стартует
 * заново: записанный до этого файл экспорта уже не соответствует выбору.
 */
async function applyMixMode(): Promise<void> {
  if (!session || !composer) return;
  composer.stop();
  stopExportUi();
  exportStatus.hidden = true;
  downloadRequested = false;
  await composer.prepare(session, currentMixMode());
  startFinalPlayback();
}

for (const input of mixModeInputs) {
  input.addEventListener("change", () => void applyMixMode());
}

async function enterFinal(): Promise<void> {
  if (!session || !composer || !videoPlayer) return;
  $("dub-progress-fill").style.width = "100%";
  await composer.prepare(session, currentMixMode());
  hideWatchVideo(false); // плеер сейчас переедет в финальный слот
  finalSlot.replaceChildren(videoPlayer.element);
  exportStatus.hidden = true;
  downloadRequested = false;
  btnExport.textContent = t("downloadVideo", { fmt: composer.videoExt.toUpperCase() });
  fitFrameWhenReady(document.querySelector(".final-screen-frame"));
  composer.onCaptureFinished = (blob) => {
    stopExportProgressTimer();
    if (blob && downloadRequested) {
      downloadRequested = false;
      downloadBlob(blob);
    } else if (!blob && downloadRequested) {
      exportStatus.hidden = false;
      exportStatus.textContent = t("exportInterrupted");
    }
  };
  showScreen("final");
  startFinalPlayback();
  // Только после showScreen: волнам нужна реальная ширина канвасов
  void renderResults();
}

// ---------- Результаты дубляжа ----------
const resultsSection = $("results");
const resultsList = $("results-list");
/** Волны строк результата: держим ссылки, чтобы перерисовать при ресайзе. */
let resultViews: WaveformView[] = [];
let resultImageUrls: string[] = [];
let resultsResizeObserver: ResizeObserver | null = null;
let resultsVisibility: IntersectionObserver | null = null;

function clearResults(): void {
  resultsSection.hidden = true;
  resultsVisibility?.disconnect();
  resultsVisibility = null;
  resultsList.replaceChildren();
  resultViews = [];
  for (const url of resultImageUrls) URL.revokeObjectURL(url);
  resultImageUrls = [];
}

/**
 * Экран результатов как в оригинале: кадр реплики, балл и наложенные волны
 * (пурпур оригинала под бирюзой дубля) — сразу видно, где промахнулся.
 */
async function renderResults(): Promise<void> {
  if (!session) return;
  clearResults();
  const sess = session;

  const rows: HTMLElement[] = [];
  const waves: Array<{ canvas: HTMLCanvasElement; original: AudioBuffer; take: Recording }> = [];
  const scores: number[] = [];

  for (let i = 0; i < sess.total; i++) {
    const take = sess.recordings.get(i);
    if (!take) continue; // реплику пропустили — оценивать нечего
    const clip = sess.pack.clips[i];
    const original = await sess.originalBuffer(i);
    if (session !== sess) return; // сессию бросили, пока декодировали
    // Оцениваем только окно реплики: запас по краям — не промах игрока
    const { score } = scoreTake(original, windowedRecording(take, original.duration));
    scores.push(score);

    const row = document.createElement("div");
    row.className = "result-row";

    const thumbSrc = clip.image ? URL.createObjectURL(clip.image) : clipThumbs.get(i);
    if (clip.image && thumbSrc) resultImageUrls.push(thumbSrc);
    if (thumbSrc) {
      const img = document.createElement("img");
      img.className = "result-thumb";
      img.src = thumbSrc;
      img.alt = "";
      img.loading = "lazy";
      row.append(img);
    } else {
      const stub = document.createElement("div");
      stub.className = "result-thumb result-thumb-empty";
      stub.textContent = "🎬";
      row.append(stub);
    }

    const info = document.createElement("div");
    info.className = "result-info";
    const scoreEl = document.createElement("div");
    scoreEl.className = "result-score";
    scoreEl.textContent = t("scoreLabel", { v: score.toFixed(2) });
    const caption = document.createElement("div");
    caption.className = "result-caption";
    // Показываем ровно то, что игрок видел, когда дублировал: язык и его правку
    caption.textContent = sess.captionFor(i);
    info.append(scoreEl, caption);

    const canvas = document.createElement("canvas");
    canvas.className = "result-wave";
    row.append(info, canvas);
    rows.push(row);
    waves.push({ canvas, original, take });
  }

  if (rows.length === 0) return;
  resultsList.replaceChildren(...rows);

  const percent = totalPercent(scores);
  $("results-percent").textContent = `${percent.toFixed(2)}%`;
  $("results-verdict").textContent = t(verdictKey(percent));
  resultsSection.hidden = false;

  // Волны рисуем лениво, по мере прокрутки: сразу после финала на этом же
  // потоке идёт запись ролика в файл, и полсотни канвасов разом её тормозят
  resultsVisibility?.disconnect();
  resultsVisibility = new IntersectionObserver(
    (entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const canvas = entry.target as HTMLCanvasElement;
        observer.unobserve(canvas);
        const wave = waves.find((w) => w.canvas === canvas);
        if (!wave) continue;
        const view = new WaveformView(canvas, waveColors);
        view.setOriginal(wave.original);
        const takeWave = takeWindow(wave.take, wave.original.duration);
        view.setUserRecording(takeWave, takeTimelineSamples(wave.original, takeWave.length));
        resultViews.push(view);
      }
    },
    { rootMargin: "200px" }
  );
  for (const { canvas } of waves) resultsVisibility.observe(canvas);

  if (!resultsResizeObserver) {
    resultsResizeObserver = new ResizeObserver(() => {
      for (const view of resultViews) view.resize();
    });
    resultsResizeObserver.observe(resultsList);
  }
}

/** Просмотр: экспорт видео при этом тихо идёт под капотом. */
function startFinalPlayback(): void {
  if (!composer) return;
  void composer.play(exportCanvas);
}

function safeFileName(): string {
  return (session?.pack.title ?? "dub").replace(/[^\p{L}\p{N} _-]/gu, "");
}

function downloadBlob(blob: Blob): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${safeFileName()} — ${t("dubFileSuffix")}.${composer?.videoExt ?? "webm"}`;
  a.click();
  exportStatus.hidden = false;
  exportStatus.textContent = t("exportDone");
}

function startExportProgressTimer(): void {
  stopExportProgressTimer();
  exportProgressTimer = window.setInterval(() => {
    if (!composer) return;
    exportStatus.textContent = t("exportWaiting", { p: Math.round(composer.progress * 100) });
  }, 400);
}

function stopExportProgressTimer(): void {
  clearInterval(exportProgressTimer);
}

function stopExportUi(): void {
  stopExportProgressTimer();
  downloadRequested = false;
  exportStatus.hidden = true;
}

$("btn-final-play").addEventListener("click", () => startFinalPlayback());

btnExport.addEventListener("click", () => {
  if (!composer) return;
  const ready = composer.captured;
  if (ready) {
    downloadBlob(ready);
    return;
  }
  downloadRequested = true;
  exportStatus.hidden = false;
  if (!composer.isCapturing) startFinalPlayback(); // просмотр (и запись) начнутся заново
  startExportProgressTimer();
});

// Аудиодорожка дубляжа рендерится офлайн — мгновенно, без просмотра
$<HTMLButtonElement>("btn-export-audio").addEventListener("click", async (e) => {
  if (!composer) return;
  const btn = e.currentTarget as HTMLButtonElement;
  btn.disabled = true;
  try {
    const blob = await composer.renderAudioWav();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${safeFileName()} — ${t("audioFileSuffix")}.wav`;
    a.click();
    exportStatus.hidden = false;
    exportStatus.textContent = t("audioDone");
  } catch (err) {
    console.error(err);
    exportStatus.hidden = false;
    exportStatus.textContent = t("audioError");
  } finally {
    btn.disabled = false;
  }
});

$("btn-retry").addEventListener("click", () => {
  if (!session) return;
  composer?.stop();
  stopExportUi();
  clearResults();
  session.recordings.clear();
  showScreen("dub");
  void enterClip(0);
});

$("btn-home").addEventListener("click", () => {
  abandonSession();
  showScreen("home");
});

// ---------- Старт ----------
setLang(lang()); // применяет переводы к статике и <html lang>
syncLangButtons();
renderPreloadedList();
showScreen("home");

// Дев-хук для автотестов: загрузка пака по URL (только в dev-сборке)
if (import.meta.env.DEV) {
  (window as any).__loadPackFromUrl = async (url: string) => {
    const blob = await (await fetch(url)).blob();
    await addPack(loadPackFromZip(new File([blob], "pack.zip")));
  };
}
