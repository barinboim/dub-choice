import "./style.css";
import { loadPackFromZip, loadPackFromFiles, collectDroppedFiles } from "./pack/loader";
import { DubPack, PackError } from "./pack/types";
import { PRELOADED_PACKS, packUrls, fetchWithProgress, formatSize } from "./pack/preloaded";
import { audioContext } from "./audio/context";
import { MicRecorder, recordingToBuffer } from "./audio/recorder";
import { WaveformView } from "./audio/waveform";
import { DubSession } from "./game/session";
import { Composer } from "./game/composer";
import { createVideoPlayer, DubVideoPlayer } from "./video/player";
import { t, lang, setLang, Lang } from "./i18n";

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

const waveColors = {
  background: "transparent",
  original: "#8a8a8a",
  user: "#7fe0d2",
  playhead: "#ffffff",
  midline: "rgba(255,255,255,0.18)",
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
    updateDubButtons();
  }
  if (composer) {
    $("btn-export").textContent = t("downloadVideo", { fmt: composer.videoExt.toUpperCase() });
  }
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
      const title = document.createElement("div");
      title.className = "pi-title";
      title.textContent = pp.title;
      const size = document.createElement("div");
      size.className = "pi-size";
      size.textContent = formatSize(pp.sizeBytes);
      meta.append(title, size);

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
  if (btnEl) btnEl.disabled = true;
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
    if (btnEl) btnEl.disabled = false;
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
  $("pack-stats").textContent =
    `${pack.clips.length} ${t("clipsCount")} · ${pack.backingTrack ? t("withBacking") : t("withoutBacking")}`;
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
  session = new DubSession(selectedPack, $<HTMLInputElement>("toggle-rehearsal").checked);
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
const btnOrig = $<HTMLButtonElement>("btn-orig");
const btnPlayTake = $<HTMLButtonElement>("btn-play-take");
const recordBadge = $("record-badge");
const toggleMonitor = $<HTMLInputElement>("toggle-monitor");
const monitorVolume = $<HTMLInputElement>("monitor-volume");
const monitorVolumeValue = $("monitor-volume-value");

let clipImageUrl: string | null = null;
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
  session.clipIndex = index;
  session.prefetchAround();
  const clip = session.clip;

  $("dub-counter").textContent = t("clipCounter", { i: index + 1, n: session.total });
  $("dub-progress-fill").style.width = `${(index / session.total) * 100}%`;
  $("dub-caption").textContent = clip.caption || t("noCaption");
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
    waveform.setUserRecording(existing.samples, Math.floor(buf.duration * existing.sampleRate));
  }
  updateDubButtons();

  // Реплику сразу показываем целиком: видео + звук + бегущий по волне курсор
  void playOriginalVideo();
}

function updateDubButtons(): void {
  if (!session) return;
  const hasTake = session.recordings.has(session.clipIndex);
  btnNext.disabled = !hasTake;
  btnNext.textContent = session.isLastClip ? t("nextFinal") : t("next");
  btnRecord.textContent = recorder.isRecording
    ? t("stopRec")
    : hasTake
      ? t("reRecord")
      : t("record");
  btnRecord.classList.toggle("recording", recorder.isRecording);
  recordBadge.hidden = !recorder.isRecording;
  btnPlayTake.hidden = !(session.rehearsal && hasTake) || recorder.isRecording;
  btnPlayTake.textContent = t("myTake");
  btnOrig.disabled = recorder.isRecording;
  $("waveform-hint").textContent = recorder.isRecording
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
async function startClipVideo(): Promise<void> {
  if (!session || !videoPlayer) return;
  showWatchVideo();
  fitFrameWhenReady(document.querySelector(".dub-screen-frame"));
  videoPlayer.muted = true;
  videoPlayer.currentTime = session.clip.timestamps[0];
  await videoPlayer.play().catch(() => {});
}

/** Видео + аудиобуфер вместе: оригинал реплики или свой дубль. */
async function playClipWithAudio(buffer: AudioBuffer): Promise<void> {
  if (!session || !videoPlayer) return;
  stopPreview();
  const dur = buffer.duration;
  const token = ++watchToken;

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
    const ratio = (ctx.currentTime - t0) / dur;
    if (ratio >= 1) {
      hideWatchVideo();
      return;
    }
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

function hideWatchVideo(): void {
  watchToken++;
  clearTimeout(watchTimer);
  stopPreview(); // глушим и звук фрагмента, если он ещё шёл
  videoPlayer?.pause();
  dubVideoSlot.hidden = true;
  dubImage.hidden = !clipImageUrl;
  dubNoImage.hidden = !!clipImageUrl;
}

btnOrig.addEventListener("click", () => void playOriginalVideo());

btnPlayTake.addEventListener("click", () => {
  if (!session) return;
  const rec = session.recordings.get(session.clipIndex);
  if (rec) void playClipWithAudio(recordingToBuffer(rec)); // дубль тоже с видео
});

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
  if (recorder.isRecording) {
    finishRecording();
    return;
  }
  stopPreview();
  hideWatchVideo();
  const buf = await session.originalBuffer();
  const totalSamples = Math.floor(buf.duration * audioContext().sampleRate);
  waveform.beginUserRecording(totalSamples);

  // Опциональный мониторинг: оригинал в ухо (лучше в наушниках)
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

  await recorder.start(
    buf.duration,
    (chunk) => waveform?.appendUserChunk(chunk),
    () => finishRecording(true)
  );
  // Во время записи сцена играет без звука — дублируешь прямо под видео
  void startClipVideo();
  updateDubButtons();
});

function finishRecording(auto = false): void {
  if (!session) return;
  stopMonitor();
  hideWatchVideo();
  const rec = auto ? recorder.snapshot() : recorder.stop();
  if (rec.samples.length > 0) session.recordings.set(session.clipIndex, rec);
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

$("btn-dub-quit").addEventListener("click", () => {
  if (!confirm(t("quitConfirm"))) return;
  abandonSession();
  showScreen("home");
});

function abandonSession(): void {
  stopPreview();
  stopMonitor();
  hideWatchVideo();
  if (recorder.isRecording) recorder.stop();
  stopExportUi();
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

async function enterFinal(): Promise<void> {
  if (!session || !composer || !videoPlayer) return;
  $("dub-progress-fill").style.width = "100%";
  await composer.prepare(session);
  hideWatchVideo();
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
