import "./style.css";
import { trackEvent } from "./analytics";
import { loadPackFromZip, loadPackFromFiles, collectDroppedFiles, packToZip } from "./pack/loader";
import { DubPack, PackError, packCharacters, clipIsActive } from "./pack/types";
import {
  loadPreloadedManifest,
  packUrl,
  packIconUrl,
  fetchWithProgress,
  formatSize,
  type PreloadedPack,
} from "./pack/preloaded";
import { audioContext, blobDuration, decodeAudio } from "./audio/context";
import { audioBufferToWav } from "./audio/wav";
import {
  MicRecorder,
  recordingToBuffer,
  takeWindow,
  playbackEndSec,
  windowedRecording,
  type Recording,
} from "./audio/recorder";
import { matchLoudness } from "./audio/normalize";
import { WaveformView, type WaveformColors } from "./audio/waveform";
import { DubSession, ORIGINAL_LANG } from "./game/session";
import {
  Composer,
  DEFAULT_VOICEOVER_GAIN,
  TAKE_VOLUME_UNITY,
  type MixMode,
} from "./game/composer";
import { scoreTake, totalPercent, verdictKey } from "./game/score";
import { createVideoPlayer, DubVideoPlayer } from "./video/player";
import { t, tagLabel, lang, langName, setLang, Lang } from "./i18n";
import { CoopClient } from "./coop/client";
import * as coopApi from "./coop/api";
import { CoopError, CoopEvent, CoopMode } from "./coop/types";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------- Элементы ----------
const screens = {
  home: $("screen-home"),
  lobby: $("screen-lobby"),
  pack: $("screen-pack"),
  dub: $("screen-dub"),
  final: $("screen-final"),
};

function showScreen(name: keyof typeof screens): void {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  // Мобильная версия: по имени активного экрана в CSS решаем, показывать ли
  // логотип и переключатель языка в шапке (см. style.css)
  document.body.dataset.screen = name;
  if (name !== "final") hideResultsJump();
}

// ---------- Состояние приложения ----------
const packs: DubPack[] = [];
let selectedPack: DubPack | null = null;
let session: DubSession | null = null;
let videoPlayer: DubVideoPlayer | null = null;
let composer: Composer | null = null;
const recorder = new MicRecorder();

// ================= Кооп: комната с друзьями =================
const COOP_NAME_KEY = "dubchoice.coop.name";
let coop: CoopClient | null = null;
/** Пак комнаты: у хоста — выбранный, у гостя — скачанный с сервера. */
let coopPack: DubPack | null = null;
/** Временное сообщение в кооп-баре («Отправлено», «Не удалось…»). */
let coopTakeMsg = "";
let coopTakeMsgTimer = 0;
/** Ошибка загрузки/скачивания пака — показывается в лобби, пока не сменилась. */
let coopPackError = "";

const coopNameInput = $<HTMLInputElement>("coop-name");
const coopCodeInput = $<HTMLInputElement>("coop-code");
coopNameInput.placeholder = t("coopYourName");
coopNameInput.value = localStorage.getItem(COOP_NAME_KEY) ?? "";
coopNameInput.addEventListener("change", () =>
  localStorage.setItem(COOP_NAME_KEY, coopNameInput.value.trim())
);

function showCoopError(message: string): void {
  const el = $("coop-error");
  el.textContent = message;
  el.hidden = false;
}

function hideCoopError(): void {
  $("coop-error").hidden = true;
}

/** Имя из поля ввода (или сохранённое), с запросом, если пусто. Пустое имя — отказ. */
function coopCurrentName(): string {
  let name = coopNameInput.value.trim() || localStorage.getItem(COOP_NAME_KEY) || "";
  if (!name) {
    const asked = prompt(t("coopNameNeeded"));
    if (!asked) return "";
    name = asked.trim();
    coopNameInput.value = name;
  }
  localStorage.setItem(COOP_NAME_KEY, name);
  return name;
}

/** Кому принадлежит реплика в режиме по персонажам (первый выбравший персонажа). */
function coopCharOwner(index: number): string | null {
  const room = coop?.room;
  if (!room || !coopPack) return null;
  const clip = coopPack.clips[index];
  if (!clip || clip.characters.length === 0) return null;
  for (const p of room.participants) {
    const picked = room.chars[p.pid] ?? [];
    if (clip.characters.some((c) => picked.includes(c))) return p.pid;
  }
  return null;
}

/** Можно ли записывать реплику index в текущем режиме комнаты. */
function coopCanRecord(index: number): boolean {
  const room = coop?.room;
  if (!room) return true;
  const me = coop!.myPid;
  switch (room.mode) {
    case "relay":
      return room.relay.turn === me && room.relay.line === index;
    case "free": {
      const owner = room.claims[index] ?? room.takes[index]?.pid;
      return !owner || owner === me;
    }
    case "chars": {
      const owner = coopCharOwner(index);
      if (owner !== null && owner !== me) return false;
      const claim = room.claims[index] ?? room.takes[index]?.pid;
      return !claim || claim === me;
    }
  }
}

/** Следующая доступная реплика: сначала незаписанные, потом любые свои. */
function coopNextNavigable(from: number): number | null {
  const room = coop?.room;
  if (!room || !session) return null;
  const total = session.total;
  const pick = (start: number, skip: boolean): number | null => {
    for (let i = start; i < total; i++) {
      if (coopCanRecord(i) && (!skip || !room.takes[i])) return i;
    }
    for (let i = 0; i < start; i++) {
      if (coopCanRecord(i) && (!skip || !room.takes[i])) return i;
    }
    return null;
  };
  return pick(from + 1, true) ?? pick(from + 1, false);
}

/** Первая строка для входа в дубляж: своя незаписанная, иначе любая своя. */
function coopFirstNavigable(): number | null {
  const room = coop?.room;
  if (!room || !session) return null;
  for (let i = 0; i < session.total; i++) {
    if (coopCanRecord(i) && !room.takes[i]) return i;
  }
  for (let i = 0; i < session.total; i++) {
    if (coopCanRecord(i)) return i;
  }
  return null;
}

/** Освобождает клейм реплики, если заявил её, но не записал. */
function leaveCoopClip(): void {
  const room = coop?.room;
  if (!room || !session) return;
  const idx = session.clipIndex;
  if (room.claims[idx] === coop!.myPid && !room.takes[idx]) {
    void coopApi.releaseClip(room.code, coop!.myPid, idx).catch(() => {});
  }
}

function flashCoopTakeMsg(msg: string): void {
  coopTakeMsg = msg;
  window.clearTimeout(coopTakeMsgTimer);
  coopTakeMsgTimer = window.setTimeout(() => {
    coopTakeMsg = "";
    updateCoopBar();
  }, 2500);
  updateCoopBar();
}

/** Отправляет запись реплики в комнату. */
async function uploadCoopTake(index: number, rec: Recording): Promise<void> {
  const room = coop?.room;
  if (!room) return;
  try {
    const wav = audioBufferToWav(recordingToBuffer(rec));
    await coopApi.uploadTake(room.code, coop!.myPid, index, wav, rec.leadSec);
    flashCoopTakeMsg(t("coopUploaded"));
  } catch (err) {
    if (err instanceof CoopError && /уже озвучил/.test(err.message)) {
      showCoopError(t("coopTakeRejected"));
    } else {
      flashCoopTakeMsg(t("coopUploadFail"));
    }
  }
}

/** Стягивает все записи комнаты и подмешивает их в сессию (для премьеры). */
async function coopSyncRemoteTakes(): Promise<void> {
  const room = coop?.room;
  if (!room || !session) return;
  try {
    const meta = await coopApi.takesMeta(room.code);
    await Promise.all(
      Object.entries(meta).map(async ([idxStr, m]) => {
        const idx = Number(idxStr);
        const local = session!.recordings.get(idx);
        if (local && local.samples.length > 0) return; // свой дубль свежее
        const res = await fetch(coopApi.takeWavUrl(room.code, idx));
        if (!res.ok) return;
        const buf = await decodeAudio(await res.blob());
        const ch = buf.getChannelData(0);
        session!.recordings.set(idx, {
          samples: new Float32Array(ch),
          sampleRate: buf.sampleRate,
          durationSec: buf.duration,
          leadSec: m.leadSec,
        });
      })
    );
  } catch {
    /* премьера покажет то, что уже есть */
  }
}

async function uploadCoopPack(): Promise<void> {
  const room = coop?.room;
  if (!room || !coopPack) return;
  coopPackError = "";
  $("lobby-pack").textContent = t("coopUploadingPack");
  try {
    const zip = await packToZip(coopPack);
    const meta = {
      title: coopPack.title,
      clips: coopPack.clips.map((c) => ({ characters: c.characters })),
    };
    await coopApi.uploadPack(room.code, coop!.myPid, zip, meta);
  } catch (err) {
    console.error("coop pack upload:", err);
    coopPackError = `${t("coopUploadFail")}: ${(err as Error).message}`;
  }
  renderLobby();
}

async function downloadCoopPack(): Promise<void> {
  const room = coop?.room;
  if (!room) return;
  coopPackError = "";
  $("lobby-pack").textContent = t("coopDownloadingPack");
  try {
    const blob = await coopApi.downloadPack(room.code, (fraction) => {
      $("lobby-pack").textContent = `${t("coopDownloadingPack")} ${Math.round(fraction * 100)}%`;
    });
    // распаковка идёт в воркере — главный поток не морозится, текст успевает обновиться
    $("lobby-pack").textContent = t("packUnpacking");
    coopPack = await loadPackFromZip(new File([blob], "pack.zip"));
  } catch (err) {
    console.error("coop pack download:", err);
    coopPackError = `${t("coopUploadFail")}: ${(err as Error).message}`;
  }
  renderLobby();
}

async function createCoop(pack: DubPack): Promise<void> {
  const name = coopCurrentName();
  if (!name) return;
  hideCoopError();
  try {
    const { code, pid, room } = await coopApi.createRoom(name);
    coop = new CoopClient(code, pid);
    coop.room = room; // состояние известно сразу — не ждём первый WS-state
    coop.onEvent = handleCoopEvent;
    coop.onStatus = () => updateCoopBar();
    coop.connect();
    coopPack = pack;
    coopTakeMsg = "";
    renderLobby();
    showScreen("lobby");
    void uploadCoopPack();
  } catch (err) {
    showCoopError((err as Error).message);
    coop = null;
  }
}

async function joinCoop(code: string): Promise<void> {
  const name = coopCurrentName();
  if (!name) return;
  hideCoopError();
  try {
    const { pid, room } = await coopApi.joinRoom(code, name);
    coop = new CoopClient(code, pid);
    coop.room = room;
    coop.onEvent = handleCoopEvent;
    coop.onStatus = () => updateCoopBar();
    coop.connect();
    coopPack = null;
    coopTakeMsg = "";
    renderLobby();
    showScreen("lobby");
    if (room.packReady) void downloadCoopPack();
  } catch (err) {
    showCoopError((err as Error).message);
    coop = null;
  }
}

/** Полный выход из комнаты (лобби, логотип, «другой пак»). */
function leaveCoopRoom(): void {
  if (!coop) return;
  void coopApi.leaveRoom(coop.code, coop.myPid).catch(() => {});
  coop.close();
  coop = null;
  coopPack = null;
  coopTakeMsg = "";
  $("btn-retry").hidden = false;
}

/** Хост кикнул: сервер уже убрал нас из комнаты и закрыл WS — просто чистимся. */
function coopKicked(): void {
  if (!coop) return;
  coop.close(); // без реконнекта: нас больше нет в комнате
  coop = null;
  coopPack = null;
  coopTakeMsg = "";
  abandonSession();
  showCoopError(t("coopKickedMsg"));
  showScreen("home");
}

const MODE_DEFS = [
  { id: "relay" as CoopMode, titleKey: "coopModeRelay", hintKey: "coopModeRelayHint" },
  { id: "free" as CoopMode, titleKey: "coopModeFree", hintKey: "coopModeFreeHint" },
  { id: "chars" as CoopMode, titleKey: "coopModeChars", hintKey: "coopModeCharsHint" },
] as const;

function renderLobby(): void {
  const room = coop?.room;
  if (!room) return;
  $("lobby-code").textContent = room.code;
  $<HTMLInputElement>("lobby-link").value = `${location.origin}${location.pathname}?join=${room.code}`;

  const packEl = $("lobby-pack");
  const roomProgress = (): string => {
    const done = Object.keys(room.takes).length;
    return ` · ${t("coopRoomProgress", { n: done, m: room.clipCount })}`;
  };
  if (coopPackError) packEl.textContent = coopPackError;
  else if (room.packReady) {
    packEl.textContent = `📦 ${coopPack?.title ?? room.packTitle ?? ""}${roomProgress()}`;
  } else packEl.textContent = t("coopWaitPack");
  // Ретрай скачивания/заливки пака при ошибке
  $("lobby-pack-retry").hidden = !coopPackError;

  const roster = $("lobby-roster");
  const isHost = room.hostPid === coop!.myPid;
  roster.replaceChildren(
    ...room.participants.map((p) => {
      const chip = document.createElement("div");
      chip.className = "roster-chip";
      const dot = document.createElement("span");
      dot.className = "roster-dot";
      dot.style.background = p.color;
      const name = document.createElement("span");
      name.className = "roster-name";
      name.textContent = p.name + (p.pid === room.hostPid ? ` (${t("coopHost")})` : "");
      chip.append(dot, name);
      if (!p.connected) {
        const off = document.createElement("span");
        off.className = "roster-off";
        off.textContent = t("coopOffline");
        chip.append(off);
      }
      if (isHost && p.pid !== room.hostPid) {
        const kick = document.createElement("button");
        kick.className = "roster-kick";
        kick.textContent = "✕";
        kick.title = t("coopKick");
        kick.setAttribute("aria-label", t("coopKick"));
        kick.addEventListener("click", () => {
          if (!confirm(t("coopKickConfirm", { name: p.name }))) return;
          void coopApi.kickPlayer(room.code, coop!.myPid, p.pid).catch(showCoopError);
        });
        chip.append(kick);
      }
      return chip;
    })
  );

  const modes = $("lobby-modes");
  modes.replaceChildren(
    ...MODE_DEFS.map((m) => {
      const label = document.createElement("label");
      label.className = "lobby-mode" + (room.mode === m.id ? " lobby-mode-active" : "");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "coop-mode";
      input.checked = room.mode === m.id;
      input.disabled = !isHost;
      input.addEventListener("change", () => {
        if (input.checked) void coopApi.setMode(room.code, coop!.myPid, m.id).catch(showCoopError);
      });
      const body = document.createElement("span");
      body.className = "lobby-mode-body";
      const title = document.createElement("span");
      title.className = "lobby-mode-title";
      title.textContent = t(m.titleKey);
      const hint = document.createElement("small");
      hint.textContent = t(m.hintKey);
      body.append(title, hint);
      label.append(input, body);
      return label;
    })
  );

  const inChars = room.mode === "chars";
  $("lobby-chars-label").hidden = !inChars;
  const charsEmpty = $("lobby-chars-empty");
  const charsWrap = $("lobby-chars");
  if (!inChars) {
    charsEmpty.hidden = true;
    charsWrap.hidden = true;
  } else if (!coopPack) {
    // Пак ещё качается/распаковывается — не оставляем пустоту, показываем статус
    charsWrap.hidden = true;
    charsEmpty.hidden = false;
    charsEmpty.textContent = coopPackError ? coopPackError : t("coopPackLoading");
  } else if (packCharacters(coopPack).length === 0) {
    charsWrap.hidden = true;
    charsEmpty.hidden = false;
    charsEmpty.textContent = t("coopNoChars");
  } else {
    charsEmpty.hidden = true;
    charsWrap.hidden = false;
    const mine = room.chars[coop!.myPid] ?? [];
    charsWrap.replaceChildren(
      ...packCharacters(coopPack).map((ch) => {
        const btn = document.createElement("button");
        btn.className = "char-chip" + (mine.includes(ch) ? " char-chip-mine" : "");
        const owner = room.participants.find((p) => (room.chars[p.pid] ?? []).includes(ch));
        if (owner) btn.style.borderColor = owner.color;
        btn.textContent = ch;
        btn.addEventListener("click", () => {
          const next = mine.includes(ch) ? mine.filter((x) => x !== ch) : [...mine, ch];
          void coopApi.setChars(room.code, coop!.myPid, next).catch(showCoopError);
        });
        return btn;
      })
    );
  }

  $<HTMLButtonElement>("lobby-start").disabled = !room.packReady || !coopPack;
}

/** Полоса статуса на экране дубляжа: чей ход, кто озвучил текущую реплику. */
function updateCoopBar(): void {
  const room = coop?.room;
  const bar = $("coop-bar");
  if (!room || !session) {
    bar.hidden = true;
    renderCoopLines();
    return;
  }
  bar.hidden = false;
  $("coop-roster").replaceChildren(
    ...room.participants.map((p) => {
      const chip = document.createElement("span");
      chip.className = "coop-roster-chip" + (p.pid === coop!.myPid ? " coop-roster-me" : "");
      chip.style.borderColor = p.color;
      chip.textContent = p.name;
      return chip;
    })
  );
  const text = $("coop-bar-text");
  if (coopTakeMsg) {
    text.textContent = coopTakeMsg;
    renderCoopLines();
    return;
  }
  if (room.mode === "relay") {
    const turn = room.participants.find((p) => p.pid === room.relay.turn);
    if (!turn) text.textContent = "";
    else if (turn.pid === coop!.myPid) {
      text.textContent = t("coopYourTurn", { n: (room.relay.line ?? 0) + 1 });
    } else {
      text.textContent = t("coopTurnOf", { name: turn.name });
    }
    renderCoopLines();
    return;
  }
  const idx = session.clipIndex;
  const take = room.takes[idx];
  if (take) text.textContent = t("coopRecordedBy", { name: take.name });
  else {
    const owner = coopCharOwner(idx) ?? room.claims[idx];
    if (!owner) text.textContent = t("coopFreeLine");
    else if (owner === coop!.myPid) text.textContent = t("coopMyLine");
    else {
      text.textContent = t("coopLocked", {
        name: room.participants.find((p) => p.pid === owner)?.name ?? "?",
      });
    }
  }
  renderCoopLines();
}

/**
 * Навигатор строк на экране дубляжа: чип на каждую реплику. Видно, какие
 * твои (незаписанные подсвечены), какие записал кто-то другой, в эстафете —
 * где сейчас ход. Клик — прыжок на строку.
 */
function renderCoopLines(): void {
  const room = coop?.room;
  const strip = $("coop-lines");
  const sess = session;
  if (!room || !sess) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  const isRelay = room.mode === "relay";
  strip.replaceChildren(
    ...Array.from({ length: sess.total }, (_, i) => {
      const btn = document.createElement("button");
      btn.className = "line-chip";
      const take = room.takes[i];
      if (take) {
        btn.classList.add("line-chip-done");
        btn.title = take.name;
      } else if (coopCanRecord(i)) {
        btn.classList.add("line-chip-mine");
      } else {
        btn.classList.add("line-chip-locked");
      }
      if (i === sess.clipIndex) btn.classList.add("line-chip-current");
      if (isRelay && room.relay.line === i) btn.classList.add("line-chip-turn");
      btn.textContent = String(i + 1);
      // в эстафете листать можно только строку текущего хода
      if (isRelay && room.relay.line !== i) btn.disabled = true;
      else btn.addEventListener("click", () => void enterClip(i));
      return btn;
    })
  );
}

function handleCoopEvent(e: CoopEvent): void {
  if (!coop) return;
  switch (e.type) {
    case "roster":
    case "state":
      renderLobby();
      updateCoopBar();
      break;
    case "mode":
      renderLobby();
      if (!screens.dub.hidden) updateDubButtons();
      break;
    case "chars":
      renderLobby();
      if (!screens.dub.hidden) updateDubButtons();
      break;
    case "claim":
      updateCoopBar();
      if (!screens.dub.hidden) updateDubButtons();
      break;
    case "take":
      updateCoopBar();
      if (!screens.dub.hidden) updateDubButtons();
      break;
    case "turn":
      renderLobby();
      updateCoopBar();
      if (!screens.dub.hidden && session) {
        if (e.pid === coop.myPid && e.line !== null && e.line !== session.clipIndex) {
          void enterClip(e.line); // пришёл твой ход — сразу к строке
        } else {
          updateDubButtons();
        }
      }
      break;
    case "pack":
      if (e.title !== null && !coopPack && !screens.lobby.hidden) void downloadCoopPack();
      else renderLobby();
      break;
    case "kicked":
      coopKicked();
      break;
  }
}

$("coop-join").addEventListener("click", () => {
  const code = coopCodeInput.value.trim().toUpperCase();
  if (!code) {
    showCoopError(t("coopJoinNeedCode"));
    return;
  }
  void joinCoop(code);
});

$("coop-create").addEventListener("click", () => {
  if (packs.length === 0) {
    showCoopError(t("coopCreateNeedPack"));
    return;
  }
  void createCoop(selectedPack ?? packs[packs.length - 1]);
});

$("lobby-back").addEventListener("click", () => {
  leaveCoopRoom();
  showScreen("home");
});

$("lobby-leave").addEventListener("click", () => {
  leaveCoopRoom();
  showScreen("home");
});

$("lobby-copy").addEventListener("click", async () => {
  const link = $<HTMLInputElement>("lobby-link").value;
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    /* не HTTPS — скопируй вручную */
  }
  $("lobby-copy").textContent = t("coopCopied");
  window.setTimeout(() => {
    $("lobby-copy").textContent = t("coopCopy");
  }, 1500);
});

$("lobby-pack-retry").addEventListener("click", () => {
  if (!coop) return;
  if (coop.room?.hostPid === coop.myPid) void uploadCoopPack();
  else void downloadCoopPack();
});

$("lobby-start").addEventListener("click", () => {
  if (coopPack) void beginDubSession(coopPack, $("lobby-pack"));
});

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

/**
 * Как сводить финал: «Дубляж» (только фон + записи) или «Закадр»
 * (оригинальные голоса остаются под дублем). Выбирается на карточке пака и
 * меняется на экране премьеры; оба набора радиокнопок держим синхронно.
 */
let mixMode: MixMode = "dub";
/** Громкость оригинала в закадре, 0..1 — слайдер на экране премьеры. */
let voiceoverGain = DEFAULT_VOICEOVER_GAIN;
/** Положение слайдера озвучки: TAKE_VOLUME_UNITY — «как записано». */
let takeVolume = TAKE_VOLUME_UNITY;
/** Множитель громкости дубля: правее середины — усиление. */
function takeGain(): number {
  return takeVolume / TAKE_VOLUME_UNITY;
}

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
  leaveCoopRoom();
  showScreen("home");
});

/** Обновляет тексты, которые рисуются из кода (не через data-i18n). */
function refreshDynamicTexts(): void {
  renderPreloadedList();
  renderPackList();
  if (selectedPack && !screens.pack.hidden) fillPackCard(selectedPack);
  if (session) {
    $("dub-counter").textContent = t("clipCounter", {
      i: session.activePosition,
      n: session.activeTotal,
    });
    renderCaption(); // «Ориг.» на пилле и подсказка правки тоже переводятся
    updateDubButtons();
  }
  if (composer) {
    $("btn-export").textContent = t("downloadVideo", { fmt: composer.videoExt.toUpperCase() });
  }
  if (session && !screens.final.hidden) renderFinalAudioPills();
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

async function addPack(load: Promise<DubPack>, sourceId: string | null = null): Promise<void> {
  homeError.hidden = true;
  dropZone.classList.remove("dragover");
  try {
    const pack = await load;
    packs.push(pack);
    renderPackList();
    selectPack(pack, sourceId ?? "custom");
  } catch (err) {
    if (err instanceof PackError) showHomeError(err.message);
    else {
      console.error(err);
      showHomeError(t("genericLoadError"));
    }
  }
}

// --- Встроенные паки ---
/** Список качается из R2-манифеста при старте, не зашит в бандл. */
let preloadedPacks: PreloadedPack[] = [];
const preloadedBusy = new Set<string>();
/**
 * Качается всегда только один пак: игрок кликнул «Скачать» у другого —
 * предыдущая закачка обрывается. Иначе медленный пак, догрузившись позже,
 * перебивал выбор и подменял пак, с которым игрок уже начал работать.
 */
let activeDownload: AbortController | null = null;

/** Обрывает текущую закачку из галереи: игрок занялся другим паком. */
function cancelDownload(): void {
  activeDownload?.abort();
  activeDownload = null;
}
// --- Витрина: полка, поиск, сортировка, теги ---
const shelfNewSection = $("shelf-new");
const shelfNewTrack = $("shelf-new-track");
const shelfSection = $("shelf-popular");
const shelfTrack = $("shelf-track");
const searchInput = $<HTMLInputElement>("pack-search");
const searchClearBtn = $("search-clear");
const sortBar = $("sort-bar");
const tagBar = $("tag-bar");
const galleryCount = $("gallery-count");

/** 18+ намеренно не фильтр, а пометка: это предупреждение о содержимом. */
const HIDDEN_TAGS = new Set(["18+"]);
const SHELF_SIZE = 8;
const SHELF_NEW_SIZE = 6;

type GallerySort = "new" | "plays";
let gallerySort: GallerySort = "new";
let galleryQuery = "";
const galleryTags = new Set<string>();

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function packMatches(pp: PreloadedPack): boolean {
  if (galleryTags.size && !(pp.tags ?? []).some((tag) => galleryTags.has(tag))) return false;
  if (!galleryQuery) return true;
  const q = galleryQuery.toLowerCase();
  return (
    pp.title.toLowerCase().includes(q) ||
    (pp.tags ?? []).some((tag) => tag.toLowerCase().includes(q)) ||
    (pp.characters ?? []).some((c) => c.toLowerCase().includes(q))
  );
}

/** Свежие сначала; внутри одной даты — популярнее сначала, а не порядок публикации. */
function byNew(a: PreloadedPack, b: PreloadedPack): number {
  return (b.addedAt ?? "").localeCompare(a.addedAt ?? "") || (b.plays30d ?? 0) - (a.plays30d ?? 0);
}

function sortPacks(list: PreloadedPack[]): PreloadedPack[] {
  const byPlays = (a: PreloadedPack, b: PreloadedPack) => (b.plays30d ?? 0) - (a.plays30d ?? 0);
  return list.slice().sort(gallerySort === "new" ? byNew : byPlays);
}

function buildCover(pp: PreloadedPack, wide: boolean): HTMLElement {
  const cover = document.createElement("div");
  cover.className = wide ? "pi-cover wide" : "pi-cover";
  const img = document.createElement("img");
  img.src = packIconUrl(pp);
  img.alt = "";
  img.loading = "lazy";
  cover.append(img);
  if (wide) {
    if ((pp.tags ?? []).includes("18+")) {
      const adult = document.createElement("span");
      adult.className = "pi-adult";
      adult.textContent = "18+";
      adult.title = t("tagAdultTooltip");
      cover.append(adult);
    }
    const dur = document.createElement("span");
    dur.className = "pi-badge";
    dur.textContent = fmtDuration(pp.durationSec ?? 0);
    cover.append(dur);
  }
  return cover;
}

/**
 * Строка под названием. Держим её короткой: три значения не помещались в
 * карточку и переносились, оставляя висящий разделитель. На полке длина уже
 * написана на обложке, поэтому там — реплики и запуски; в сетке обложка
 * маленькая и без бейджа, поэтому там — длина и вес.
 */
function buildMeta(pp: PreloadedPack, kind: "shelf" | "grid" | "new"): HTMLElement {
  const wide = kind !== "grid";
  const meta = document.createElement("div");
  meta.className = "pi-meta";
  const parts: { text: string; cls?: string }[] = wide
    ? [{ text: `${pp.clips ?? 0} ${t("clipsCount")}` }]
    : [{ text: fmtDuration(pp.durationSec ?? 0) }, { text: formatSize(pp.sizeBytes) }];
  // Просмотры — только на «Популярных»: на «Новинках» у свежего пака их
  // почти нет, а число вида «▶ 0» выглядит как неудача, а не как метрика.
  if (kind === "shelf" && pp.plays7d) parts.push({ text: `▶ ${pp.plays7d}`, cls: "pi-plays" });
  if (!wide && (pp.tags ?? []).includes("18+")) parts.push({ text: "18+", cls: "pi-adult-inline" });

  parts.forEach(({ text, cls }, i) => {
    const span = document.createElement("span");
    if (cls) span.className = cls;
    // Разделитель внутри того же span — иначе при переносе точка повисает
    span.textContent = i > 0 ? `· ${text}` : text;
    if (cls === "pi-adult-inline") span.title = t("tagAdultTooltip");
    meta.append(span);
  });
  return meta;
}

/**
 * Теги под названием — только на полке «Популярные». «Короткий ролик»
 * пропускаем (о длине говорит бейдж на обложке), «18+» — тоже, он уже
 * стоит бейджем в углу.
 */
const CARD_TAGS_MAX = 2;
const CARD_TAGS_SKIP = new Set(["короткий ролик", "18+"]);

/**
 * Свой цвет каждому тегу — так теги читаются как ярлыки, а не как серый шум.
 * Оттенки приглушённые: на чёрном фоне насыщенные цвета спорят с белыми
 * кнопками. «18+» единственный берёт --record, тёплый акцент палитры.
 */
const TAG_COLORS: Record<string, string> = {
  "фильм": "#7fb0e0",
  "мультфильм": "#e0a86b",
  "мем": "#e055c4",
  "гарри поттер": "#b08ce0",
  "шрек": "#8ed36b",
  "монолог": "#7fe0d2",
  // Синий здесь насыщеннее, чем у «фильма», иначе два тега сливаются;
  // «короткий ролик» по той же причине уведён в нейтральный серый
  "русская озвучка": "#5b8def",
  "короткий ролик": "#a5a5a5",
  "18+": "#ff5c49",
};

function tagColor(tag: string): string {
  const known = TAG_COLORS[tag];
  if (known) return known;
  // Манифест может принести любой тег — даём ему стабильный оттенок по имени
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 48% 70%)`;
}

function paintTag(el: HTMLElement, tag: string): void {
  el.style.setProperty("--tag-color", tagColor(tag));
}

function buildCardTags(pp: PreloadedPack): HTMLElement | null {
  const shown = (pp.tags ?? []).filter((tag) => !CARD_TAGS_SKIP.has(tag)).slice(0, CARD_TAGS_MAX);
  if (!shown.length) return null;
  const row = document.createElement("div");
  row.className = "pi-tags";
  for (const tag of shown) {
    const chip = document.createElement("span");
    chip.className = "pi-chip";
    chip.textContent = tagLabel(tag);
    paintTag(chip, tag);
    row.append(chip);
  }
  return row;
}

/** Карточка пака: клик сразу начинает закачку, прогресс идёт полоской внизу. */
function buildPackCard(pp: PreloadedPack, kind: "shelf" | "grid" | "new"): HTMLElement {
  const wide = kind !== "grid";
  const card = document.createElement("div");
  card.className = wide ? "shelf-card" : "preloaded-item";
  card.dataset.packId = pp.id;
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.title = pp.title;
  // Карточка могла пересобраться (renderPreloadedList) пока этот пак ещё
  // качается — например, из-за отмены закачки другого пака. Класс возвращаем
  // сразу, а прогресс/подпись подтянутся следующим тиком fetchWithProgress.
  if (preloadedBusy.has(pp.id)) card.classList.add("loading");

  const body = document.createElement("div");
  body.className = "pi-body";
  const title = document.createElement("div");
  title.className = "pi-title";
  title.textContent = pp.title;
  body.append(title, buildMeta(pp, kind));
  if (kind === "shelf") {
    const tags = buildCardTags(pp);
    if (tags) body.append(tags);
  }

  const progress = document.createElement("span");
  progress.className = "pi-progress";
  card.append(buildCover(pp, wide), body, progress);

  const start = () => {
    if (preloadedBusy.has(pp.id)) return;
    void loadPreloaded(pp.id);
  };
  card.addEventListener("click", start);
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      start();
    }
  });
  return card;
}

/** Полки не зависят от поиска и тегов — это витрина, а не результат выборки. */
function renderShelves(): void {
  const fill = (
    section: HTMLElement,
    track: HTMLElement,
    list: PreloadedPack[],
    kind: "shelf" | "new"
  ) => {
    section.hidden = list.length === 0;
    track.replaceChildren(...list.map((pp) => buildPackCard(pp, kind)));
  };

  fill(
    shelfNewSection,
    shelfNewTrack,
    preloadedPacks
      .slice()
      .sort(byNew)
      .slice(0, SHELF_NEW_SIZE),
    "new"
  );

  fill(
    shelfSection,
    shelfTrack,
    preloadedPacks
      .filter((pp) => (pp.plays7d ?? 0) > 0)
      .sort((a, b) => (b.plays7d ?? 0) - (a.plays7d ?? 0))
      .slice(0, SHELF_SIZE),
    "shelf"
  );
}

function renderSortBar(): void {
  const options: { id: GallerySort; label: string }[] = [
    { id: "new", label: t("sortNew") },
    { id: "plays", label: t("sortPopular") },
  ];
  sortBar.replaceChildren(
    ...options.map(({ id, label }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.setAttribute("aria-pressed", String(gallerySort === id));
      btn.addEventListener("click", () => {
        gallerySort = id;
        renderPreloadedList();
      });
      return btn;
    })
  );
}

function renderTagBar(): void {
  const counts = new Map<string, number>();
  for (const pp of preloadedPacks) {
    for (const tag of pp.tags ?? []) {
      if (!HIDDEN_TAGS.has(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  tagBar.replaceChildren(
    ...tags.map(([tag, n]) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tag-pill";
      btn.setAttribute("aria-pressed", String(galleryTags.has(tag)));
      paintTag(btn, tag);
      btn.append(document.createTextNode(`${tagLabel(tag)} `));
      const count = document.createElement("span");
      count.className = "tag-count";
      count.textContent = String(n);
      btn.append(count);
      btn.addEventListener("click", () => {
        if (galleryTags.has(tag)) galleryTags.delete(tag);
        else galleryTags.add(tag);
        renderPreloadedList();
      });
      return btn;
    })
  );
}

function resetGalleryFilters(): void {
  galleryQuery = "";
  galleryTags.clear();
  searchInput.value = "";
  searchClearBtn.classList.remove("on");
  renderPreloadedList();
}

function renderPreloadedList(): void {
  renderShelves();
  renderSortBar();
  renderTagBar();
  searchInput.placeholder = t("searchPacks");
  searchClearBtn.title = t("searchClear");

  const list = sortPacks(preloadedPacks.filter(packMatches));
  const filtered = !!galleryQuery || galleryTags.size > 0;

  if (!list.length) {
    galleryCount.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "gallery-empty";
    const text = document.createElement("p");
    text.textContent = t("galleryEmpty");
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "link-btn";
    reset.textContent = t("galleryEmptyReset");
    reset.addEventListener("click", resetGalleryFilters);
    empty.append(text, reset);
    preloadedList.replaceChildren(empty);
    return;
  }

  galleryCount.replaceChildren(
    document.createTextNode(t("galleryShown", { i: list.length, n: preloadedPacks.length }))
  );
  if (filtered) {
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "link-btn";
    reset.textContent = t("galleryReset");
    reset.addEventListener("click", resetGalleryFilters);
    galleryCount.append(reset);
  }
  preloadedList.replaceChildren(...list.map((pp) => buildPackCard(pp, "grid")));
}

searchInput.addEventListener("input", () => {
  galleryQuery = searchInput.value.trim();
  searchClearBtn.classList.toggle("on", galleryQuery.length > 0);
  renderPreloadedList();
});
searchClearBtn.addEventListener("click", () => {
  galleryQuery = "";
  searchInput.value = "";
  searchClearBtn.classList.remove("on");
  searchInput.focus();
  renderPreloadedList();
});

async function loadPreloaded(id: string): Promise<void> {
  const pp = preloadedPacks.find((p) => p.id === id);
  if (!pp || preloadedBusy.has(id)) return;
  cancelDownload();
  const download = new AbortController();
  activeDownload = download;
  preloadedBusy.add(id);
  homeError.hidden = true;

  // Пак может быть сразу в двух местах — на полке и в сетке, а пока качается
  // этот пак, другая закачка может обрушить renderPreloadedList() и
  // пересобрать всю витрину. Поэтому ищем карточки заново на каждый тик,
  // а не держим ссылки на узлы, которые могут оказаться уже отсоединены.
  const items = () => [
    ...document.querySelectorAll<HTMLElement>(`#screen-home [data-pack-id="${id}"]`),
  ];
  const setStatus = (text: string) => {
    for (const el of items()) {
      el.classList.add("loading");
      const meta = el.querySelector<HTMLElement>(".pi-meta");
      if (meta) meta.textContent = text;
    }
  };
  setStatus(t("packLoading"));

  try {
    const blob = await fetchWithProgress(
      packUrl(pp),
      pp.sizeBytes,
      (ratio) => {
        for (const el of items()) {
          const bar = el.querySelector<HTMLElement>(".pi-progress");
          if (bar) bar.style.width = `${ratio * 100}%`;
        }
        setStatus(`${t("packLoading")} ${Math.round(ratio * 100)}%`);
      },
      download.signal
    );
    setStatus(t("packUnpacking"));
    const pack = await loadPackFromZip(new File([blob], `${pp.id}.zip`));
    // Пока распаковывались, игрок мог запустить другую закачку — она главнее
    if (download.signal.aborted) return;
    await addPack(Promise.resolve(pack), pp.id);
  } catch (err) {
    if (download.signal.aborted) return; // закачку оборвал сам игрок
    console.error(err);
    showHomeError(t("fetchError"));
  } finally {
    if (activeDownload === download) activeDownload = null;
    preloadedBusy.delete(id);
    // Метаданные, класс loading и прогресс вернутся на место при отрисовке
    renderPreloadedList();
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
  if (file) {
    cancelDownload(); // свой пак важнее того, что качается из галереи
    void addPack(loadPackFromZip(file));
  }
  (e.target as HTMLInputElement).value = "";
});

$<HTMLInputElement>("input-folder").addEventListener("change", (e) => {
  const files = (e.target as HTMLInputElement).files;
  if (files?.length) {
    cancelDownload();
    void addPack(loadPackFromFiles(files));
  }
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
  cancelDownload();
  const single = dt.files.length === 1 ? dt.files[0] : null;
  if (single && single.name.toLowerCase().endsWith(".zip")) {
    void addPack(loadPackFromZip(single));
  } else {
    void addPack(collectDroppedFiles(dt.items).then(loadPackFromFiles));
  }
});

// ================= ЭКРАН 2: карточка пака =================
const micStatus = $("mic-status");

/**
 * Выбор системного микрофона — дев-хелпер, виден только на localhost
 * (переключение записи на другое устройство при отладке). В проде блок
 * скрыт, и recorder.init() вызывается без deviceId — как раньше.
 */
const micDeviceRow = $("mic-device-row");
const micDeviceSelect = $<HTMLSelectElement>("mic-device-select");
let micDeviceId: string | undefined;

if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
  micDeviceRow.hidden = false;
  micDeviceSelect.addEventListener("change", () => {
    micDeviceId = micDeviceSelect.value || undefined;
  });
  void refreshMicDevices();
  navigator.mediaDevices?.addEventListener?.("devicechange", () => void refreshMicDevices());
}

/** Названия устройств доступны только после разрешения — запрашиваем его молча, если нужно. */
async function refreshMicDevices(): Promise<void> {
  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    let inputs = devices.filter((d) => d.kind === "audioinput");
    if (inputs.some((d) => !d.label)) {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
      inputs = devices.filter((d) => d.kind === "audioinput");
    }
    const prev = micDeviceSelect.value;
    micDeviceSelect.replaceChildren(
      ...inputs.map((d, i) => {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label || `Microphone ${i + 1}`;
        return opt;
      })
    );
    if (inputs.some((d) => d.deviceId === prev)) micDeviceSelect.value = prev;
    micDeviceId = micDeviceSelect.value || undefined;
  } catch {
    micDeviceRow.hidden = true;
  }
}

/** Персонажи, выключенные фильтром на карточке пака. Сбрасывается при выборе нового пака. */
let disabledCharacters = new Set<string>();

/** Длительности клипов пака (сек), посчитанные лениво и один раз на пак. */
const clipDurationCache = new WeakMap<DubPack, Promise<number[]>>();

function clipDurations(pack: DubPack): Promise<number[]> {
  let cached = clipDurationCache.get(pack);
  if (!cached) {
    cached = Promise.all(pack.clips.map((c) => blobDuration(c.audio).catch(() => 0)));
    clipDurationCache.set(pack, cached);
  }
  return cached;
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Суммарная длина клипов, которые реально предстоит озвучить при текущем фильтре. */
async function updateClipLength(pack: DubPack): Promise<void> {
  const durations = await clipDurations(pack);
  if (selectedPack !== pack) return; // пак сменили, пока считали длительности
  let sum = 0;
  pack.clips.forEach((clip, i) => {
    if (clipIsActive(clip, disabledCharacters)) sum += durations[i];
  });
  $("pack-clip-length").textContent = t("clipLength", { len: formatDuration(sum) });
}

/** Есть ли хоть один включённый персонаж — иначе озвучивать нечего. */
function hasActiveCharacter(pack: DubPack): boolean {
  const chars = packCharacters(pack);
  return chars.length === 0 || chars.some((c) => !disabledCharacters.has(c));
}

function updateStartAvailability(pack: DubPack): void {
  const ok = hasActiveCharacter(pack);
  $<HTMLButtonElement>("btn-start").disabled = !ok;
  $("char-filter-empty").hidden = ok;
}

function renderCharacterFilter(pack: DubPack): void {
  const chars = packCharacters(pack);
  const panel = $("char-filter");
  panel.hidden = chars.length === 0;
  const list = $("char-filter-list");
  list.replaceChildren(
    ...chars.map((name) => {
      const label = document.createElement("label");
      label.className = "char-filter-item";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !disabledCharacters.has(name);
      input.addEventListener("change", () => {
        if (input.checked) disabledCharacters.delete(name);
        else disabledCharacters.add(name);
        updateStartAvailability(pack);
        void updateClipLength(pack);
      });
      const span = document.createElement("span");
      span.textContent = name;
      label.append(input, span);
      return label;
    })
  );
  updateStartAvailability(pack);
}

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
  renderCharacterFilter(pack);
  void updateClipLength(pack);
}

/** ID пака для аналитики: слаг встроенного, либо "custom" для своего ZIP/папки. */
let currentPackSlug = "custom";

function selectPack(pack: DubPack, sourceId = "custom"): void {
  selectedPack = pack;
  currentPackSlug = sourceId;
  disabledCharacters = new Set();
  fillPackCard(pack);
  micStatus.textContent = "";
  micStatus.classList.remove("error");
  showScreen("pack");
  trackEvent(`pack-select/${currentPackSlug}`);
}

$("btn-pack-back").addEventListener("click", () => showScreen("home"));

/** Запускает сессию дубляжа: микрофон, плеер, экран. status — куда писать прогресс. */
async function beginDubSession(
  pack: DubPack,
  status: HTMLElement = micStatus,
  filter: ReadonlySet<string> = disabledCharacters
): Promise<void> {
  // По HTTP браузеры вообще не показывают промпт микрофона — объясняем сразу
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    status.textContent = t("micInsecure");
    status.classList.add("error");
    return;
  }
  audioContext(); // создаём по жесту пользователя
  status.textContent = t("micRequest");
  status.classList.remove("error");
  try {
    await recorder.init(micDeviceId);
  } catch {
    status.textContent = t("micError");
    status.classList.add("error");
    return;
  }
  status.textContent = t("videoPreparing");
  try {
    videoPlayer?.dispose();
    videoPlayer = await createVideoPlayer(pack.video, pack.videoKind);
  } catch (err) {
    console.error(err);
    status.textContent = t("videoError");
    status.classList.add("error");
    return;
  }
  session = new DubSession(pack, lang(), new Set(filter));
  scoreLang = null;
  composer?.dispose();
  composer = new Composer(videoPlayer);
  // Экран показываем до загрузки клипа, чтобы canvas получил размеры
  showScreen("dub");
  trackEvent(`dub-start/${currentPackSlug}`);
  // В эстафете встаём на строку текущего хода, в свободных/по персонажам —
  // на первую свою (незаписанную); иначе солим вход на чужую строку с замком
  const room = coop?.room;
  let startIndex: number | null = null;
  if (room?.mode === "relay") startIndex = room.relay.line;
  else if (room) startIndex = coopFirstNavigable();
  await enterClip(startIndex ?? session.firstActiveIndex);
}

$("btn-start").addEventListener("click", () => {
  if (selectedPack) void beginDubSession(selectedPack);
});

$("btn-coop").addEventListener("click", () => {
  if (selectedPack) void createCoop(selectedPack);
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
const btnToFinal = $<HTMLButtonElement>("btn-to-final");

/**
 * Узкий экран: длинная подпись на кнопке не влезает, а настройки записи
 * (отсчёт, мониторинг) на телефоне должны лежать ниже всего — под волной,
 * чтобы не отжимать сцену и текст реплики. Переносим блок в DOM: вытащить
 * его из колонки одним CSS нельзя, он вложен в `.dub-side`.
 */
const narrowScreen = window.matchMedia("(max-width: 700px)");
const monitorBlock = document.querySelector<HTMLElement>(".monitor-block")!;
const dubSide = document.querySelector<HTMLElement>(".dub-side")!;

function applyNarrowLayout(): void {
  const host = narrowScreen.matches ? screens.dub : dubSide;
  if (monitorBlock.parentElement !== host) host.append(monitorBlock);
  if (session) updateDubButtons();
}

narrowScreen.addEventListener("change", applyNarrowLayout);
const recordBadge = $("record-badge");
const toggleMonitor = $<HTMLInputElement>("toggle-monitor");
const toggleCountdown = $<HTMLInputElement>("toggle-countdown");

/**
 * «Слышать дорожку» включена по умолчанию — но если игрок сам её выключил,
 * это запоминается так же, как язык сайта, и не сбрасывается между сессиями.
 */
const MONITOR_STORAGE_KEY = "dubchoice.hearOriginal";
toggleMonitor.checked = localStorage.getItem(MONITOR_STORAGE_KEY) !== "0";
toggleMonitor.addEventListener("change", () => {
  localStorage.setItem(MONITOR_STORAGE_KEY, toggleMonitor.checked ? "1" : "0");
});
const dubCountdown = $("dub-countdown");
const dubCaption = $("dub-caption");
const captionLangsRow = $("dub-caption-langs");
const captionPills = $("dub-caption-pills");
const audioLangsRow = $("dub-audio-langs");
const audioPills = $("dub-audio-pills");
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
/** Подложки сцены под дублем (фон и/или оригинал) — глушатся вместе с превью. */
let sceneSources: AudioBufferSourceNode[] = [];
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

  $("dub-counter").textContent = t("clipCounter", { i: session.activePosition, n: session.activeTotal });
  $("dub-progress-fill").style.width = `${((session.activePosition - 1) / session.activeTotal) * 100}%`;
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

  // Кооп: занять свободную реплику, пока озвучиваешь её
  const room = coop?.room;
  if (room && room.mode !== "relay" && coopCanRecord(index) && !room.takes[index]) {
    void coopApi.claimClip(room.code, coop!.myPid, index).catch(() => {});
  }

  await refreshOriginalWave();
  updateDubButtons();
  updateCoopBar();

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
  btnNext.disabled = !hasTake || busy;
  btnNext.textContent = session.isLastClip
    ? t(narrowScreen.matches ? "nextFinalShort" : "nextFinal")
    : t("next");
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
  // Когда весь ролик озвучен, к премьере можно уйти с любой реплики — кроме
  // последней: там в финал и так ведёт «Готово», две кнопки об одном лишние
  btnToFinal.hidden = !session.allRecorded || busy || session.isLastClip;
  btnToFinal.textContent = t("toPremiere");
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

  // Кооп: режим комнаты управляет записью и кнопками
  const room = coop?.room;
  if (room && session) {
    const canRec = coopCanRecord(session.clipIndex);
    const roomComplete = session.activeIndices.every((i) => room.takes[i] !== undefined);
    btnRecord.disabled = btnRecord.disabled || !canRec;
    if (room.mode === "relay") {
      btnNext.textContent = canRec ? t("coopPassTurn") : t("coopWaitTurn");
      btnNext.disabled = !canRec || !hasTake || busy;
    } else {
      // Чужие строки можно пропускать без записи — иначе на занятой реплике
      // (не записать, не пройти) игрок застревает навсегда
      btnNext.disabled = busy;
    }
    btnToFinal.hidden = busy || (session.recordings.size === 0 && !roomComplete);
    btnToFinal.textContent = t("coopPremiere", {
      n: session.recordings.size,
      m: session.activeTotal,
    });
    if (!canRec) {
      const owner =
        room.mode === "relay"
          ? room.relay.turn
          : (coopCharOwner(session.clipIndex) ?? room.claims[session.clipIndex]);
      const who = room.participants.find((p) => p.pid === owner)?.name;
      if (room.mode === "relay" && who) {
        $("waveform-hint").textContent = t("coopTurnOf", { name: who });
      } else if (who) {
        $("waveform-hint").textContent = t("coopLocked", { name: who });
      } else {
        $("waveform-hint").textContent = t("coopWaitTurn");
      }
    }
  }
}

function stopPreview(): void {
  cancelAnimationFrame(playheadRaf);
  waveform?.setPlayhead(null);
  for (const node of [previewSource, ...sceneSources]) {
    if (!node) continue;
    try { node.stop(); } catch { /* уже остановлен */ }
    node.disconnect();
  }
  previewSource = null;
  sceneSources = [];
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
  // play() на уже играющем <video> (клип ещё шёл в предпросмотре) не шлёт
  // "playing" в Safari — whenPlaying() тогда всегда бьётся в таймаут, и
  // мониторинг с markStart() опаздывают на весь PLAYING_TIMEOUT_MS. Пауза
  // перед seek не стоит лишней перемотки, но нужна только нативному mp4/webm:
  // ogv.js (Theora) ждём по timeupdate, там play-после-play не проблема.
  if (waitPlaying && session.pack.videoKind === "native" && !videoPlayer.paused) videoPlayer.pause();
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
  cursor?: { lead: number; span: number },
  /** Подложки под дубль: фон сцены и/или её оригинальный звук. */
  scenes: Array<{ buffer: AudioBuffer; gain: number; offset: number; delay: number }> = [],
  /** Громкость основного буфера — у дубля она задаётся слайдером в финале. */
  gain = 1,
  /** Сколько секунд показывать; по умолчанию — весь буфер. */
  playSec?: number
): Promise<void> {
  if (!session || !videoPlayer) return;
  stopPreview();
  const dur = Math.min(playSec ?? buffer.duration, buffer.duration);
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
  if (gain === 1) {
    src.connect(ctx.destination);
  } else {
    const node = ctx.createGain();
    node.gain.value = gain;
    src.connect(node).connect(ctx.destination);
  }
  const t0 = ctx.currentTime;
  src.start();
  previewSource = src;

  // Сцена стартует на lead позже дубля: у записи впереди есть запас
  for (const scene of scenes) {
    const sceneSrc = ctx.createBufferSource();
    sceneSrc.buffer = scene.buffer;
    const sceneGain = ctx.createGain();
    sceneGain.gain.value = scene.gain;
    sceneSrc.connect(sceneGain).connect(ctx.destination);
    sceneSrc.start(t0 + scene.delay, scene.offset);
    sceneSources.push(sceneSrc);
  }

  // Курсор ведём по аудиочасам — они точнее, чем currentTime у ogv.js.
  // Досматриваем до конца буфера, а не до конца окна реплики: у дубля вокруг
  // неё есть запас, и обрывать на нём и звук, и видео — значит показывать
  // игроку не то, что записалось
  const animate = () => {
    if (token !== watchToken) return;
    const elapsed = ctx.currentTime - t0;
    if (elapsed >= dur) {
      hideWatchVideo();
      return;
    }
    const ratio = (elapsed - cursorLead) / cursorSpan;
    // Середина фрагмента — там персонаж уже точно в кадре и говорит
    if (ratio > 0.45) captureThumb(clipIndex);
    waveform?.setPlayhead(Math.min(Math.max(ratio, 0), 1));
    playheadRaf = requestAnimationFrame(animate);
  };
  playheadRaf = requestAnimationFrame(animate);

  // Подстраховка на случай проблем с rAF в фоновой вкладке
  clearTimeout(watchTimer);
  watchTimer = window.setTimeout(() => hideWatchVideo(), (dur + 2) * 1000);
}

/**
 * Пурпурная волна — по выбранной звуковой дорожке. При смене языка звука
 * она перерисовывается: игрок целится в ту речь, которую слышит.
 */
async function refreshOriginalWave(): Promise<void> {
  if (!session || !waveform) return;
  const index = session.clipIndex;
  const buf = await session.clipBuffer(index);
  if (!session || session.clipIndex !== index) return; // ушли, пока декодировали
  waveform.setOriginal(buf);
  const existing = session.recordings.get(index);
  if (existing) {
    const win = takeWindow(existing, buf.duration);
    waveform.setUserRecording(win, takeTimelineSamples(buf, win.length));
  }
}

async function playOriginalVideo(): Promise<void> {
  if (!session) return;
  await playClipWithAudio(await session.clipBuffer());
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

btnPlayTake.addEventListener("click", () => void playTake());

btnToFinal.addEventListener("click", () => {
  if (!session) return;
  stopPreview();
  hideWatchVideo();
  void enterFinal();
});

/**
 * Прослушивание своего дубля — так же, как он будет звучать в финале:
 * в режиме дубляжа под голосом идёт фоновая дорожка, в закадре — оригинальный
 * звук сцены, приглушённый ровно как в миксе.
 */
async function playTake(): Promise<void> {
  if (!session) return;
  const rec = session.recordings.get(session.clipIndex);
  if (!rec) return;
  const original = await session.clipBuffer();
  const at = session.clip.timestamps[0];

  // Точно тот же набор слоёв, что уйдёт в финальный микс
  const scenes: Array<{ buffer: AudioBuffer; gain: number; offset: number; delay: number }> = [];
  // Дорожка дубляжа — только голос, поэтому фон к ней добавляет бэкинг;
  // у оригинала целая дорожка есть, и она играет вместо бэкинга
  const dubTrack = session.audioLang
    ? await session.voicesBuffer(session.audioLang)
    : null;
  const voiceoverTrack =
    mixMode === "voiceover" && !dubTrack ? await session.originalTrackBuffer() : null;
  if (mixMode === "voiceover" && dubTrack) {
    const backing = await session.backingBuffer();
    if (backing && at < backing.duration) {
      scenes.push({ buffer: backing, gain: voiceoverGain, offset: at, delay: rec.leadSec });
    }
    if (at < dubTrack.duration) {
      scenes.push({ buffer: dubTrack, gain: voiceoverGain, offset: at, delay: rec.leadSec });
    }
  } else if (voiceoverTrack) {
    // Пак несёт целую оригинальную дорожку — она и играет вместо фона
    if (at < voiceoverTrack.duration) {
      scenes.push({ buffer: voiceoverTrack, gain: voiceoverGain, offset: at, delay: rec.leadSec });
    }
  } else {
    const backing = await session.backingBuffer();
    // Фон — кусок общей дорожки, начиная с таймстампа реплики; в закадре он
    // приглушён вместе с голосами, это одна оригинальная звуковая картина
    if (backing && at < backing.duration) {
      const gain = mixMode === "voiceover" ? voiceoverGain : 1;
      scenes.push({ buffer: backing, gain, offset: at, delay: rec.leadSec });
    }
    if (mixMode === "voiceover") {
      scenes.push({ buffer: original, gain: voiceoverGain, offset: 0, delay: rec.leadSec });
    }
  }

  // Дубль тоже с видео; курсор ведём по окну реплики, запас он проходит молча
  // Досматриваем до конца реплики, а если игрок договаривал после неё —
  // до конца его речи. Молчаливый хвост показывать незачем: это выглядело бы
  // как лишняя секунда сцены
  const playSec = playbackEndSec(rec, original.duration);
  await playClipWithAudio(
    recordingToBuffer(rec),
    { lead: rec.leadSec, span: original.duration },
    scenes,
    takeGain(),
    playSec
  );
}

/**
 * Субтитр реплики: пиллы языков (только у паков с переводами), сам текст и
 * скрытое поле правки. Свой вариант текста живёт в сессии и подставляется
 * вместо субтитра — озвучивать можно ровно то, что видишь.
 */
/** Подпись варианта: у оригинала это язык самого пака, если он известен. */
function trackLabel(lang: string, short = false): string {
  const code = lang === ORIGINAL_LANG ? session?.pack.lang ?? "" : lang;
  const full = lang === ORIGINAL_LANG && !code ? t("langOriginal") : langLabel(code);
  if (!short) return full;
  // Ужимаемся до кода языка: «Английский» → «EN». Своего кода у языка может
  // и не быть (выдуманный) — тогда обрезаем название.
  return code ? code.slice(0, 3).toUpperCase() : full.slice(0, 3).toUpperCase();
}

/**
 * Звук и субтитры живут в одной строке — и на телефоне тоже. Если не
 * помещаются, подписи схлопываются до кодов языков; решаем это замером, а
 * не порогом ширины экрана: длина названий зависит от пака и языка.
 */
let langRowsObserver: ResizeObserver | null = null;
let fitting = false;

function fitLangRows(): void {
  if (fitting) return;              // перерисовка внутри замера — не повод мерить снова
  const rows = $("dub-lang-rows");
  if (!langRowsObserver) {
    // Поворот телефона меняет ширину — пересчитываем, а не гадаем один раз
    langRowsObserver = new ResizeObserver(() => {
      if (session) fitLangRows();
    });
    langRowsObserver.observe(rows);
  }
  fitting = true;
  try {
    rows.classList.remove("compact");
    if (rows.scrollWidth > rows.clientWidth) {
      rows.classList.add("compact");
      renderLangPills(true);
    }
  } finally {
    fitting = false;
  }
}

/** Больше этого числа вариантов — пиллы не влезают, нужен список. */
const PILL_LIMIT = 3;

/**
 * Ряд выбора языка: до трёх вариантов — пиллы, дальше выпадающий список.
 * Одна и та же механика обслуживает и звук, и субтитры.
 */
function renderLangRow(
  host: HTMLElement,
  langs: string[],
  current: string,
  short: boolean,
  onPick: (lang: string) => void
): void {
  if (langs.length > PILL_LIMIT) {
    const select = document.createElement("select");
    select.className = "lang-select";
    for (const lang of langs) {
      const opt = document.createElement("option");
      opt.value = lang;
      opt.textContent = trackLabel(lang, short);
      opt.selected = lang === current;
      select.append(opt);
    }
    select.addEventListener("change", () => onPick(select.value));
    host.replaceChildren(select);
    return;
  }
  host.replaceChildren(
    ...langs.map((lang) => {
      const pill = document.createElement("button");
      pill.className = "caption-lang";
      pill.classList.toggle("active", lang === current);
      pill.textContent = trackLabel(lang, short);
      pill.addEventListener("click", () => onPick(lang));
      return pill;
    })
  );
}

/** Оба ряда пилл: субтитры и звуковые дорожки. */
function renderLangPills(short = false): void {
  if (!session) return;
  const langs = session.captionLangs;
  captionLangsRow.hidden = langs.length === 0;
  renderLangRow(captionPills, langs, session.captionLang, short, (lang) => {
    if (!session) return;
    session.captionLang = lang;
    closeCaptionEditor();
    renderCaption();
  });

  // Звуковые дорожки — своя ось: игрок может слушать оригинал и озвучивать
  // по русскому тексту, как на настоящем дубляже. Связывать их не будем.
  const tracks = session.audioLangs;
  audioLangsRow.hidden = tracks.length === 0;
  renderLangRow(audioPills, tracks, session.audioLang, short, (lang) => {
    if (!session || lang === session.audioLang) return;
    session.audioLang = lang;
    renderCaption();
    void refreshOriginalWave();
  });
}

function renderCaption(): void {
  if (!session) return;
  renderLangPills();
  fitLangRows();

  const text = session.captionFor();
  dubCaption.textContent = text || t("noCaption");
  dubCaption.classList.toggle("edited", session.isCaptionEdited());
  dubCaption.title = t("captionEditHint");
}

/** Ярлык на пилле: название языка, у пака без lang — «Оригинал».
 *  Названия из самого пака важнее словаря: только автор знает, как
 *  подписать язык, которого в словаре нет (выдуманный, диалект). */
function langLabel(code: string): string {
  if (code === ORIGINAL_LANG) return t("langOriginal");
  const own = session?.pack.langNames?.[code];
  return own?.[lang()] || own?.ru || own?.en || langName(code);
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
  // Кооп: чужие реплики не записываются
  if (coop?.room && !coopCanRecord(session.clipIndex)) {
    updateDubButtons();
    return;
  }
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
  // Окно записи одно на все языки (его задаёт оригинал), а в ухо идёт
  // выбранная дорожка. Режем её заранее, до отсчёта: первая нарезка из
  // дубляжа копирует сэмплы, и делать это после первого кадра — значит
  // подсадить монитор относительно видео
  const cue = toggleMonitor.checked ? await session.clipBuffer() : buf;

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
    src.buffer = cue;
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
    const original = await session.clipBuffer();
    // На волне — окно самой реплики: запас с обоих концов в кадр не влезает,
    // но в монтаж уходит запись целиком
    const window = takeWindow(rec, original.duration);
    matchLoudness(rec, original, window);
    session.recordings.set(session.clipIndex, rec);
    waveform?.setUserRecording(window, takeTimelineSamples(original, window.length));
    // Кооп: запись уходит в комнату, чтобы другие собрали общий ролик
    if (coop?.room) void uploadCoopTake(session.clipIndex, rec);
  }
  waveform?.setPlayhead(null);
  updateDubButtons();
}

btnNext.addEventListener("click", () => {
  if (!session) return;
  stopPreview();
  hideWatchVideo();
  const room = coop?.room;
  if (room?.mode === "relay") {
    void coopApi.passTurn(room.code, coop!.myPid).catch(showCoopError);
    return;
  }
  if (room) {
    leaveCoopClip();
    const next = coopNextNavigable(session.clipIndex);
    if (next !== null) void enterClip(next);
    else void enterFinal();
    return;
  }
  if (session.isLastClip) {
    void enterFinal();
  } else {
    const next = session.nextActiveIndex(session.clipIndex);
    if (next !== null) void enterClip(next);
  }
});

// «Назад» шагает по репликам: можно вернуться и перезаписать дубль. С первой
// (активной) реплики шаг назад выводит из сессии — там это единственный выход «вглубь».
btnBack.addEventListener("click", () => {
  if (!session || recorder.isRecording) return;
  if (coop?.room) {
    // В коопе «назад» ведёт в лобби: записи уже на сервере, терять нечего
    leaveCoopClip();
    abandonSession();
    showScreen("lobby");
    renderLobby();
    return;
  }
  const prev = session.prevActiveIndex(session.clipIndex);
  if (prev === null) {
    if (session.recordings.size > 0 && !confirm(t("quitConfirm"))) return;
    abandonSession();
    showScreen(selectedPack ? "pack" : "home");
    return;
  }
  stopPreview();
  hideWatchVideo();
  void enterClip(prev);
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

const mixModeInputs = [
  ...document.querySelectorAll<HTMLInputElement>('input[name="mix-mode"], input[name="mix-mode-pack"]'),
];
const voiceoverRow = $("voiceover-volume-row");
const voiceoverSlider = $<HTMLInputElement>("voiceover-volume");
const voiceoverValue = $("voiceover-volume-value");
const takeSlider = $<HTMLInputElement>("take-volume");
const takeValue = $("take-volume-value");

/** Обе группы радиокнопок и слайдер показывают одно и то же состояние. */
function syncMixModeUi(): void {
  for (const input of mixModeInputs) input.checked = input.value === mixMode;
  voiceoverRow.hidden = mixMode !== "voiceover";
  voiceoverSlider.value = String(Math.round(voiceoverGain * 100));
  voiceoverValue.textContent = `${Math.round(voiceoverGain * 100)}%`;
  takeSlider.value = String(takeVolume);
  takeValue.textContent = `${takeVolume}%`;
}

/**
 * Смена режима или громкости меняет саму дорожку, поэтому ролик пересобирается
 * и стартует заново: записанный до этого файл экспорта выбору уже не
 * соответствует. На карточке пака пересобирать нечего — там сессии ещё нет.
 */
async function applyMixMode(): Promise<void> {
  syncMixModeUi();
  if (!session || !composer || screens.final.hidden) return;
  composer.stop();
  stopExportUi();
  exportStatus.hidden = true;
  downloadRequested = false;
  await composer.prepare(session, mixMode, voiceoverGain, takeGain());
  startFinalPlayback();
}

for (const input of mixModeInputs) {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    mixMode = input.value === "voiceover" ? "voiceover" : "dub";
    void applyMixMode();
  });
}

// Слайдер оригинала: пока тянут — только цифра, пересборка по отпусканию
voiceoverSlider.addEventListener("input", () => {
  voiceoverValue.textContent = `${voiceoverSlider.value}%`;
});
voiceoverSlider.addEventListener("change", () => {
  voiceoverGain = Number(voiceoverSlider.value) / 100;
  void applyMixMode();
});

takeSlider.addEventListener("input", () => {
  takeValue.textContent = `${takeSlider.value}%`;
});
takeSlider.addEventListener("change", () => {
  takeVolume = Number(takeSlider.value);
  void applyMixMode();
});

const finalAudioLangsRow = $("final-audio-langs");
const finalAudioPills = $("final-audio-pills");

/**
 * Переключатель звуковой дорожки на премьере — та же ось `session.audioLang`,
 * что и «Звук» на экране записи, но здесь она напрямую решает, что попадёт
 * в экспорт (закадр играет выбранную дорожку под дублем целиком). Смена
 * дорожки пересобирает микс и перезапускает просмотр — как смена режима.
 */
function renderFinalAudioPills(): void {
  if (!session) return;
  const tracks = session.audioLangs;
  finalAudioLangsRow.hidden = tracks.length === 0;
  renderLangRow(finalAudioPills, tracks, session.audioLang, false, (picked) => {
    if (!session || picked === session.audioLang) return;
    session.audioLang = picked;
    renderFinalAudioPills();
    void applyMixMode();
  });
}

async function enterFinal(): Promise<void> {
  if (!session || !composer || !videoPlayer) return;
  // Кооп: подмешиваем записи остальных участников
  if (coop?.room) await coopSyncRemoteTakes();
  $("dub-progress-fill").style.width = "100%";
  syncMixModeUi();
  renderFinalAudioPills();
  await composer.prepare(session, mixMode, voiceoverGain, takeGain());
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
  const room = coop?.room;
  $("coop-final-note").hidden = !room;
  if (room) {
    $("coop-final-note").textContent = t("coopFinalNote", {
      n: room.participants.length,
      code: room.code,
    });
    $("btn-retry").hidden = true; // «переозвучить всё» несовместимо с общим роликом
  } else {
    $("btn-retry").hidden = false;
  }
  startFinalPlayback();
  trackEvent(`dub-complete/${currentPackSlug}`);
  // Только после showScreen: волнам нужна реальная ширина канвасов
  void renderResults();
}

/**
 * Результаты уходят под сгиб экрана, и о них просто не догадываются: зовём
 * вниз плавающей кнопкой, пока сама секция не попала в кадр.
 */
const resultsJump = $<HTMLButtonElement>("results-jump");
let resultsJumpWatcher: IntersectionObserver | null = null;

function hideResultsJump(): void {
  resultsJumpWatcher?.disconnect();
  resultsJumpWatcher = null;
  resultsJump.hidden = true;
}

function watchResultsJump(section: HTMLElement): void {
  resultsJumpWatcher?.disconnect();
  resultsJumpWatcher = new IntersectionObserver(
    ([entry]) => {
      resultsJump.hidden = entry.isIntersecting || screens.final.hidden;
    },
    { threshold: 0.15 }
  );
  resultsJumpWatcher.observe(section);
}

resultsJump.addEventListener("click", () => {
  resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  resultsJump.hidden = true;
});

// ---------- Результаты дубляжа ----------
const resultsSection = $("results");
const resultsList = $("results-list");
/** Волны строк результата: держим ссылки, чтобы перерисовать при ресайзе. */
let resultViews: WaveformView[] = [];
let resultImageUrls: string[] = [];
let resultsResizeObserver: ResizeObserver | null = null;
let resultsVisibility: IntersectionObserver | null = null;

function clearResults(): void {
  hideResultsJump();
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
/**
 * По какой дорожке считать баллы. Пока не выбрано — null: угадывать нельзя.
 * Игрок мог слушать оригинал и озвучивать перевод, а мог повторять дубляж —
 * это его решение, и спросить дешевле, чем ошибиться.
 */
let scoreLang: string | null = null;

/** Вопрос о дорожке; возвращает false, если ответа ещё нет. */
function askScoreTrack(sess: DubSession): boolean {
  const tracks = sess.audioLangs;
  const box = $("results-track");
  if (tracks.length === 0) {
    box.hidden = true;
    scoreLang = ORIGINAL_LANG;
    return true;
  }
  box.hidden = false;
  renderLangRow($("results-track-pills"), tracks, scoreLang ?? "\u0000", false, (lang) => {
    scoreLang = lang;
    void renderResults();
  });
  return scoreLang !== null;
}

async function renderResults(): Promise<void> {
  if (!session) return;
  clearResults();
  const sess = session;
  const answered = askScoreTrack(sess);
  $("results-total").hidden = !answered;
  resultsSection.hidden = false;
  if (!answered) {
    watchResultsJump(resultsSection);
    return;
  }

  const rows: HTMLElement[] = [];
  const waves: Array<{ canvas: HTMLCanvasElement; original: AudioBuffer; take: Recording }> = [];
  const scores: number[] = [];

  for (let i = 0; i < sess.total; i++) {
    const take = sess.recordings.get(i);
    if (!take) continue; // реплику пропустили — оценивать нечего
    const clip = sess.pack.clips[i];
    const original = await sess.clipBuffer(i, scoreLang ?? ORIGINAL_LANG);
    if (session !== sess) return; // сессию бросили, пока декодировали
    // Оцениваем только окно реплики: запас по краям — не промах игрока
    const { score } = scoreTake(original, windowedRecording(take, original.duration));
    scores.push(score);

    const row = document.createElement("div");
    row.className = "result-row";
    // Клик по строке ведёт на эту реплику: переписать конкретную фразу
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.title = t("resultRedub");
    row.addEventListener("click", () => backToClips(i));
    row.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      backToClips(i);
    });

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
  watchResultsJump(resultsSection);

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

// Аудиодорожка рендерится офлайн — мгновенно, без просмотра. Кнопка
// открывает попап состава: только голос игрока, голос + голоса персонажей,
// выключенных фильтром (если фильтр вообще что-то выключил — иначе это было
// бы неотличимо от первого варианта), либо вся дорожка как в экспорте видео.
const wavModal = $("wav-export-modal");
const wavOptVoice = $<HTMLButtonElement>("wav-opt-voice");
const wavOptVoiceChars = $<HTMLButtonElement>("wav-opt-voice-chars");
const wavOptFull = $<HTMLButtonElement>("wav-opt-full");
const btnExportAudio = $<HTMLButtonElement>("btn-export-audio");

function closeWavModal(): void {
  wavModal.hidden = true;
}

async function runWavExport(render: () => Promise<Blob>, suffix: string): Promise<void> {
  btnExportAudio.disabled = true;
  try {
    const blob = await render();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${safeFileName()} — ${suffix}.wav`;
    a.click();
    exportStatus.hidden = false;
    exportStatus.textContent = t("audioDone");
  } catch (err) {
    console.error(err);
    exportStatus.hidden = false;
    exportStatus.textContent = t("audioError");
  } finally {
    btnExportAudio.disabled = false;
  }
}

btnExportAudio.addEventListener("click", () => {
  if (!composer || !session) return;
  wavOptVoiceChars.hidden = !session.hasDisabledCharacters;
  wavModal.hidden = false;
});

wavOptVoice.addEventListener("click", () => {
  closeWavModal();
  if (!composer || !session) return;
  const comp = composer, sess = session;
  void runWavExport(() => comp.renderVoiceWav(sess, false), t("audioFileSuffixVoice"));
});

wavOptVoiceChars.addEventListener("click", () => {
  closeWavModal();
  if (!composer || !session) return;
  const comp = composer, sess = session;
  void runWavExport(() => comp.renderVoiceWav(sess, true), t("audioFileSuffixVoiceChars"));
});

wavOptFull.addEventListener("click", () => {
  closeWavModal();
  if (!composer) return;
  const comp = composer;
  void runWavExport(() => comp.renderAudioWav(), t("audioFileSuffix"));
});

$("wav-modal-cancel").addEventListener("click", closeWavModal);
wavModal.addEventListener("click", (e) => {
  if (e.target === wavModal) closeWavModal();
});

/**
 * Возврат с премьеры к записи с сохранением дублей: переписать одну неудачную
 * реплику, не начиная всё заново. Готовый экспорт после этого невалиден —
 * `composer.prepare` соберёт дорожку заново при следующем входе в финал.
 */
function backToClips(index: number): void {
  if (!session) return;
  composer?.stop();
  stopExportUi();
  clearResults();
  showScreen("dub");
  void enterClip(Math.min(Math.max(index, 0), session.total - 1));
}

$("btn-final-back").addEventListener("click", () => {
  if (session) backToClips(session.lastActiveIndex);
});

$("btn-retry").addEventListener("click", () => {
  if (!session) return;
  if (session.recordings.size > 0 && !confirm(t("retryConfirm"))) return;
  composer?.stop();
  stopExportUi();
  clearResults();
  session.recordings.clear();
  showScreen("dub");
  void enterClip(session.firstActiveIndex);
});

$("btn-home").addEventListener("click", () => {
  abandonSession();
  leaveCoopRoom();
  showScreen("home");
});

// ---------- Старт ----------
applyNarrowLayout();
setLang(lang()); // применяет переводы к статике и <html lang>
syncLangButtons();
renderPreloadedList(); // сразу пустая галерея, манифест ещё в пути
showScreen("home");

// Приглашение по ссылке ?join=КОД
const joinParam = new URLSearchParams(location.search).get("join");
if (joinParam) {
  coopCodeInput.value = joinParam.toUpperCase();
  void joinCoop(joinParam.toUpperCase());
}

/** Список встроенных паков не зашит в бандл — качается из R2 при каждом заходе. */
async function initPreloadedPacks(): Promise<void> {
  try {
    preloadedPacks = await loadPreloadedManifest();
  } catch (err) {
    console.error(err);
    showHomeError(t("manifestLoadError"));
  }
  renderPreloadedList();
}
void initPreloadedPacks();

// Дев-хук для автотестов: загрузка пака по URL (только в dev-сборке)
if (import.meta.env.DEV) {
  (window as any).__loadPackFromUrl = async (url: string) => {
    const blob = await (await fetch(url)).blob();
    await addPack(loadPackFromZip(new File([blob], "pack.zip")));
  };
}
