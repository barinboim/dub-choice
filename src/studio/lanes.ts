/**
 * Таймлайн с дорожками персонажей: волна по оси времени, реплики — пилюли,
 * которые тянутся по времени, перетаскиваются между дорожками (это и есть
 * смена персонажа) и растягиваются за края.
 *
 * Идея дорожек взята из Choicer Voicer Dub Pack Editor (Loganrithm) — только
 * идея: исходников у того инструмента нет, он раздаётся собранным .exe под
 * PolyForm Strict, запрещающей форк и переработку. Здесь всё написано с нуля
 * и по-своему; волны в референсе нет вовсе, а у нас она — главный ориентир
 * при правке границ: в «Дубляже» рисуется изолированный голос, тот самый
 * сигнал, по которому VAD расставил реплики (см. vad.ts).
 */
import { $ } from "./dom";
import { t } from "../i18n";
import { note } from "../journey";
import { buildEnvelope, drawBand, prepareCanvas, type Envelope } from "./envelope";
import { pushHistory, redo, resetHistory, undo } from "./history";
import { captureFrame, playClipRange } from "./media";
import { newClipId, type StudioClip, type StudioState } from "./state";

/** Высота дорожки и полосы волны — держим в одном месте: по ним считается попадание мышью. */
const LANE_H = 54;
const RULER_H = 22;

/** Реплика короче этого не имеет смысла — тот же минимум, что в списке снизу. */
const MIN_CLIP_SEC = 0.05;
/** Длина реплики, добавленной с курсора. */
const NEW_CLIP_SEC = 2;
/** Смещение мыши меньше этого считается кликом, а не перетаскиванием. */
const CLICK_SLOP_PX = 4;

/** Ниже этого порога тянем край, а не всю пилюлю. */
const HANDLE_PX = 10;
/**
 * Радиус прилипания в пикселях. Было 7 — рукой в такое окно почти не
 * попасть (при зуме 40 px/с это 0,17 с), и правка на семь пикселей всё
 * равно незаметна: игрок делал вывод, что прилипания нет вовсе. Двенадцать
 * пикселей ощущаются, а направляющая (`studio-tl-snap`) показывает, к чему
 * именно прилипло.
 */
const SNAP_PX = 12;

/**
 * Бирюзовый (--wave-user) закреплён за дорожкой «Без персонажа» — она идёт
 * первой, и в ней лежат все реплики сразу после разбора. Персонажам он не
 * достаётся, иначе первый же созданный сливался бы с ней по цвету.
 */
const NO_CHARACTER_COLOR = "#7fe0d2";
const CHARACTER_COLORS = ["#e055c4", "#ff5c49", "#f2c94c", "#9b8cff", "#6bcb77", "#4aa8ff"];

export function characterColor(index: number): string {
  return CHARACTER_COLORS[index % CHARACTER_COLORS.length];
}

/** Цвет дорожки по имени: пустое имя — «Без персонажа». */
function laneColor(state: StudioState, name: string): string {
  if (!name) return NO_CHARACTER_COLOR;
  const index = state.characters.indexOf(name);
  return characterColor(index < 0 ? 0 : index);
}

export interface LanesOptions {
  /** Состав реплик/персонажей изменился — списку снизу надо перерисоваться. */
  onClipsChanged: () => void;
  /** Выбрана реплика — список подсвечивает свою строку. */
  onSelect: (clipId: string | null) => void;
}

interface DragState {
  clip: StudioClip;
  pill: HTMLElement;
  mode: "move" | "start" | "end";
  grabbedAtSec: number;
  originStart: number;
  originEnd: number;
  laneIndex: number;
  /** Дорожка, над которой сейчас курсор, — персонаж меняется на отпускании. */
  targetLane: number;
  /** Экранная точка нажатия — отличить клик от перетаскивания. */
  downX: number;
  downY: number;
  moved: boolean;
}

let env: Envelope | null = null;
let pxPerSec = 40;
let activeCharacter = "";
let selectedId: string | null = null;
let drag: DragState | null = null;
let rafHandle = 0;

/**
 * Дорожки: первой — «Без персонажа», дальше персонажи по порядку. Наверху
 * она потому, что сразу после разбора все реплики лежат именно в ней, и
 * растаскивать их вниз по дорожкам удобнее, чем снизу вверх.
 */
function laneCharacters(state: StudioState): string[] {
  return ["", ...state.characters];
}

function laneLabel(name: string): string {
  return name || t("studioNoCharacter");
}

export function renderLanes(state: StudioState, video: HTMLVideoElement, opts: LanesOptions): void {
  lastState = state;
  lastVideo = video;
  lastOpts = opts;
  const source = state.vocalsBuffer ?? state.audioBuffer;
  if (source && (!env || env.durationSec !== source.duration)) env = buildEnvelope(source);

  const heads = $("studio-tl-heads");
  const tracks = $("studio-tl-tracks");
  const inner = $("studio-tl-inner");
  const scroll = $("studio-tl-scroll");

  const names = laneCharacters(state);
  const duration = state.durationSec || source?.duration || 0;
  inner.style.width = `${Math.max(1, duration * pxPerSec)}px`;
  // Колонка заголовков не прокручивается вместе с линейкой, поэтому ей нужна
  // такая же «шапка» — иначе имена персонажей съезжают относительно дорожек.
  $("studio-tl-headspacer").style.height = `${RULER_H}px`;

  // ---- Заголовки дорожек: клик делает персонажа активным ----
  heads.replaceChildren(
    ...names.map((name) => {
      const head = document.createElement("div");
      head.className = "studio-tl-head";
      head.style.height = `${LANE_H}px`;
      head.tabIndex = 0;
      head.classList.toggle("active", name === activeCharacter);

      const dot = document.createElement("span");
      dot.className = "studio-tl-dot";
      dot.style.background = laneColor(state, name);

      const label = document.createElement("span");
      label.className = "studio-tl-head-name";
      label.textContent = laneLabel(name);
      label.title = name ? t("studioRenameHint") : "";

      head.append(dot, label);
      // Клик по строке заголовка делает дорожку активной — без перерисовки:
      // она заменяла бы узел прямо под курсором.
      head.addEventListener("click", () => setActiveLane(name));
      // Клик по самому имени сразу открывает правку: персонажа опознают по
      // его репликам, а они здесь, а не в правой панели.
      if (name) {
        label.addEventListener("click", (e) => {
          e.stopPropagation();
          setActiveLane(name);
          startRename(label, state, video, opts, name);
        });
      }
      return head;
    })
  );

  // ---- Дорожки с пилюлями ----
  tracks.replaceChildren(
    ...names.map((name, i) => {
      const lane = document.createElement("div");
      lane.className = "studio-tl-lane";
      lane.style.height = `${LANE_H}px`;
      lane.dataset.lane = String(i);
      lane.classList.toggle("active", name === activeCharacter);
      // Клик по пустому месту дорожки — быстрый способ добавить реплику этому
      // персонажу без похода к кнопке «+ Реплика». Пилюли сами гасят это
      // событие (stopPropagation на pointerdown), поэтому сюда доходит
      // только настоящий клик по фону: e.target остаётся самой дорожкой.
      lane.addEventListener("click", (e) => {
        if (e.target !== lane) return;
        void createClip(state, video, opts, name, pointerSec(e));
      });
      for (const clip of state.clips) {
        if ((clip.character || "") !== name) continue;
        lane.append(makePill(clip, i, state, video, opts));
      }
      return lane;
    })
  );

  renderRuler(duration);
  layoutPills();
  redrawWave(scroll);
  updatePlayhead(video, duration);
}

/**
 * Текст реплики правится прямо на пилюле. Пилюля бывает узкой, поэтому поле
 * разворачивается шире неё — иначе в него не влезает и пары слов.
 */
function startTextEdit(
  pill: HTMLElement,
  clip: StudioClip,
  state: StudioState,
  video: HTMLVideoElement,
  opts: LanesOptions
): void {
  if (pill.querySelector("input")) return;
  const box = document.createElement("div");
  box.className = "studio-tl-pill-edit";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "studio-tl-pill-input";
  input.value = clip.text;

  // Прослушать эту самую реплику, не уходя в правую панель: правя текст,
  // её переслушивают чаще всего.
  const play = document.createElement("button");
  play.type = "button";
  play.className = "studio-tl-pill-play";
  play.textContent = "▶";
  play.title = t("studioClipPlay");
  play.addEventListener("pointerdown", (e) => e.stopPropagation());
  play.addEventListener("mousedown", (e) => e.preventDefault()); // не отнимать фокус у поля
  play.addEventListener("click", (e) => {
    e.stopPropagation();
    void playClipRange(video, clip.start, clip.end);
  });

  box.append(input, play);
  pill.replaceChildren(box);
  input.focus();
  input.select();

  let done = false;
  const commit = (save: boolean) => {
    if (done) return;
    done = true;
    if (save && clip.text !== input.value) note("правил текст реплики");
    if (save) clip.text = input.value;
    pushHistory(state);
    opts.onClipsChanged();
    renderLanes(state, video, opts);
  };
  input.addEventListener("pointerdown", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // пробел здесь — пробел, а не «играть»
    if (e.key === "Enter") commit(true);
    else if (e.key === "Escape") commit(false);
    else if ((e.key === "Backspace" || e.key === "Delete") && input.value === "") {
      // Пусто и ещё раз Backspace/Delete — значит реплика тут не нужна вовсе.
      e.preventDefault();
      if (done) return;
      done = true; // иначе blur ниже переиграет commit(true) поверх удаления
      note("удалил реплику (пусто)");
      state.clips = state.clips.filter((c) => c.id !== clip.id);
      if (selectedId === clip.id) selectedId = null;
      pushHistory(state);
      opts.onClipsChanged();
      renderLanes(state, video, opts);
    }
  });
  input.addEventListener("blur", () => commit(true));
}

/** Подсветка активной дорожки — без перерисовки таймлайна. */
function setActiveLane(name: string): void {
  activeCharacter = name;
  const heads = Array.from($("studio-tl-heads").children) as HTMLElement[];
  const lanes = Array.from($("studio-tl-tracks").children) as HTMLElement[];
  heads.forEach((head, i) => head.classList.toggle("active", i === laneIndexOf(name, heads.length)));
  lanes.forEach((lane, i) => lane.classList.toggle("active", i === laneIndexOf(name, lanes.length)));
}

function laneIndexOf(name: string, count: number): number {
  if (!lastState) return -1;
  const index = laneCharacters(lastState).indexOf(name);
  return index < count ? index : -1;
}

/** Имя дорожки превращается в поле ввода; Enter сохраняет, Escape отменяет. */
function startRename(
  label: HTMLElement,
  state: StudioState,
  video: HTMLVideoElement,
  opts: LanesOptions,
  name: string
): void {
  // Ищем персонажа по имени, а не по номеру дорожки: дорожек на одну больше
  // (первая — «Без персонажа»), и номера разъезжаются. Раньше сюда приходил
  // номер дорожки, `state.characters[index]` был undefined, а сохранение
  // дописывало в массив ещё одного персонажа вместо переименования.
  const index = state.characters.indexOf(name);
  if (index < 0) return;
  const old = state.characters[index];
  const input = document.createElement("input");
  input.type = "text";
  input.className = "studio-tl-head-input";
  input.value = old;
  label.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (save: boolean) => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    if (save && next && next !== old) {
      note("переименовал персонажа");
      state.characters[index] = next;
      for (const clip of state.clips) if (clip.character === old) clip.character = next;
      if (activeCharacter === old) activeCharacter = next;
      pushHistory(state);
      opts.onClipsChanged();
    }
    renderLanes(state, video, opts);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // пробел здесь — пробел, а не «играть»
    if (e.key === "Enter") commit(true);
    if (e.key === "Escape") commit(false);
  });
  input.addEventListener("blur", () => commit(true));
}

function makePill(
  clip: StudioClip,
  laneIndex: number,
  state: StudioState,
  video: HTMLVideoElement,
  opts: LanesOptions
): HTMLElement {
  const pill = document.createElement("div");
  pill.className = "studio-tl-pill";
  pill.dataset.clipId = clip.id;
  pillClips.set(pill, clip);
  pill.classList.toggle("selected", clip.id === selectedId);
  pill.style.setProperty("--pill-color", laneColor(state, clip.character || ""));

  const text = document.createElement("span");
  text.className = "studio-tl-pill-text";
  text.textContent = clip.text || t("studioClipText");
  pill.append(text);

  pill.addEventListener("pointerdown", (e) => onPillPointerDown(e, clip, laneIndex, pill, state, video, opts));
  return pill;
}

// ---------- Позиционирование ----------

const pillClips = new WeakMap<HTMLElement, StudioClip>();
function pillClip(pill: HTMLElement): StudioClip | undefined {
  return pillClips.get(pill);
}


function layoutPills(): void {
  const tracks = $("studio-tl-tracks");
  for (const pill of Array.from(tracks.querySelectorAll<HTMLElement>(".studio-tl-pill"))) {
    const clip = pillClip(pill);
    if (clip) placePill(pill, clip.start, clip.end);
  }
}

function placePill(pill: HTMLElement, start: number, end: number): void {
  pill.style.left = `${start * pxPerSec}px`;
  pill.style.width = `${Math.max(2, (end - start) * pxPerSec)}px`;
}

function renderRuler(duration: number): void {
  const ruler = $("studio-tl-ruler");
  ruler.style.height = `${RULER_H}px`;
  // Шаг подписей выбираем так, чтобы между ними было около 90 px.
  const targetSec = 90 / pxPerSec;
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((s) => s >= targetSec) ?? steps[steps.length - 1];
  const ticks: HTMLElement[] = [];
  for (let sec = 0; sec <= duration; sec += step) {
    const tick = document.createElement("span");
    tick.className = "studio-tl-tick";
    tick.style.left = `${sec * pxPerSec}px`;
    tick.textContent = formatTime(sec, step < 1);
    ticks.push(tick);
  }
  ruler.replaceChildren(...ticks);
}

export function formatTime(sec: number, tenths = true): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const body = tenths ? rest.toFixed(1) : String(Math.round(rest));
  return `${m}:${Number(body) < 10 ? "0" : ""}${body}`;
}

/**
 * Волна рисуется в каждой дорожке отдельно: цветом персонажа — там, где
 * место свободно, серым — там, где реплику уже занял кто-то другой. Одна
 * канва на все дорожки, прибитая к видимой области: канвас во всю длину
 * таймлайна невозможен (браузер режет на ~32 767 px).
 */
function redrawWave(scroll: HTMLElement): void {
  if (!env || !lastState) return;
  const canvas = $<HTMLCanvasElement>("studio-tl-wave");
  const names = laneCharacters(lastState);
  canvas.style.height = `${names.length * LANE_H}px`;
  const g = prepareCanvas(canvas);
  if (!g) return;

  const style = getComputedStyle(document.documentElement);
  const dim = style.getPropertyValue("--ink-dim").trim() || "#777";
  const fromSec = scroll.scrollLeft / pxPerSec;
  const width = canvas.clientWidth;

  names.forEach((name, i) => {
    // Занято — там, где говорит кто-то другой; своя реплика место не занимает.
    const ownRanges = lastState!.clips
      .filter((c) => (c.character || "") === name)
      .map((c) => ({ start: c.start, end: c.end }));
    const color = laneColor(lastState!, name);
    drawBand(g, env!, fromSec, pxPerSec, width, {
      top: i * LANE_H,
      height: LANE_H,
      free: { shell: color, core: color },
      busy: { shell: dim, core: dim },
      ownRanges,
    });
  });
}

function updatePlayhead(video: HTMLVideoElement, duration: number): void {
  const head = $("studio-tl-playhead");
  head.style.left = `${video.currentTime * pxPerSec}px`;
  $("studio-tl-time").textContent = `${formatTime(video.currentTime)} / ${formatTime(duration)}`;
}

// ---------- Драг ----------

function onPillPointerDown(
  e: PointerEvent,
  clip: StudioClip,
  laneIndex: number,
  pill: HTMLElement,
  state: StudioState,
  video: HTMLVideoElement,
  opts: LanesOptions
): void {
  e.preventDefault();
  e.stopPropagation();
  pillClips.set(pill, clip);

  const rect = pill.getBoundingClientRect();
  const offsetX = e.clientX - rect.left;
  const mode: DragState["mode"] =
    offsetX < HANDLE_PX ? "start" : offsetX > rect.width - HANDLE_PX ? "end" : "move";

  selectedId = clip.id;
  opts.onSelect(clip.id);
  for (const other of Array.from($("studio-tl-tracks").querySelectorAll(".studio-tl-pill"))) {
    other.classList.toggle("selected", other === pill);
  }

  drag = {
    clip,
    pill,
    mode,
    grabbedAtSec: pointerSec(e),
    originStart: clip.start,
    originEnd: clip.end,
    laneIndex,
    targetLane: laneIndex,
    downX: e.clientX,
    downY: e.clientY,
    moved: false,
  };
  pill.classList.add("dragging");
  pill.setPointerCapture(e.pointerId);

  const onMove = (ev: PointerEvent) => onPillPointerMove(ev, state);
  const onUp = (ev: PointerEvent) => {
    pill.removeEventListener("pointermove", onMove);
    pill.removeEventListener("pointerup", onUp);
    pill.removeEventListener("pointercancel", onUp);
    finishDrag(ev, state, video, opts);
  };
  pill.addEventListener("pointermove", onMove);
  pill.addEventListener("pointerup", onUp);
  pill.addEventListener("pointercancel", onUp);
}

/** Секунда под курсором — с поправкой на прокрутку таймлайна. */
function pointerSec(e: { clientX: number }): number {
  const inner = $("studio-tl-inner");
  const rect = inner.getBoundingClientRect();
  return (e.clientX - rect.left) / pxPerSec;
}

function onPillPointerMove(e: PointerEvent, state: StudioState): void {
  if (!drag) return;
  if (Math.abs(e.clientX - drag.downX) > CLICK_SLOP_PX || Math.abs(e.clientY - drag.downY) > CLICK_SLOP_PX) {
    drag.moved = true;
  }
  if (!drag.moved) return; // пока это клик, реплику не двигаем
  hideSnapGuide(); // покажется заново, если прилипание сработает на этом шаге
  const duration = state.durationSec || env?.durationSec || 0;
  const dt = pointerSec(e) - drag.grabbedAtSec;

  const points = snapPoints(state, drag.clip.id);

  if (drag.mode === "move") {
    const len = drag.originEnd - drag.originStart;
    let start = clamp(drag.originStart + dt, 0, Math.max(0, duration - len));
    start = snapWhole(start, len, points);
    placePill(drag.pill, start, start + len);
    // Перетаскивание на другую дорожку — это и есть смена персонажа. Раньше
    // пилюля физически переносилась в другой узел (`lane.append`), и это
    // ломало драг: перенос узла в DOM снимает pointer capture, после первого
    // же перескока события переставали доходить до пилюли. Отсюда «между
    // персонажами тащится только на одну дорожку». Теперь узел остаётся на
    // месте, а смещение показывается трансформацией.
    const lane = laneUnderPointer(e);
    if (lane) drag.targetLane = Number(lane.dataset.lane ?? drag.laneIndex);
    drag.pill.style.transform = `translateY(${(drag.targetLane - drag.laneIndex) * LANE_H}px)`;
    for (const el of Array.from($("studio-tl-tracks").querySelectorAll<HTMLElement>(".studio-tl-lane"))) {
      el.classList.toggle("drop-target", Number(el.dataset.lane) === drag.targetLane);
    }
  } else if (drag.mode === "start") {
    const start = clamp(snap(drag.originStart + dt, points), 0, drag.originEnd - MIN_CLIP_SEC);
    placePill(drag.pill, start, drag.originEnd);
  } else {
    const end = clamp(snap(drag.originEnd + dt, points), drag.originStart + MIN_CLIP_SEC, duration || Infinity);
    placePill(drag.pill, drag.originStart, end);
  }
}

function laneUnderPointer(e: PointerEvent): HTMLElement | null {
  const tracks = $("studio-tl-tracks");
  const rect = tracks.getBoundingClientRect();
  const index = Math.floor((e.clientY - rect.top) / LANE_H);
  const lanes = tracks.querySelectorAll<HTMLElement>(".studio-tl-lane");
  return lanes[index] ?? null;
}

function finishDrag(e: PointerEvent, state: StudioState, video: HTMLVideoElement, opts: LanesOptions): void {
  if (!drag) return;
  const { clip, pill, mode } = drag;
  const drag0Start = drag.originStart;

  // Мышь осталась на месте — это был клик: открываем правку текста реплики.
  if (!drag.moved) {
    pill.classList.remove("dragging");
    pill.style.transform = "";
    hideSnapGuide();
    drag = null;
    startTextEdit(pill, clip, state, video, opts);
    return;
  }
  const duration = state.durationSec || env?.durationSec || 0;
  const dt = pointerSec(e) - drag.grabbedAtSec;

  const points = snapPoints(state, clip.id);

  note(mode === "move" ? "двигал реплику" : "тянул границу реплики");
  if (mode === "move") {
    const len = drag.originEnd - drag.originStart;
    let start = clamp(drag.originStart + dt, 0, Math.max(0, duration - len));
    start = snapWhole(start, len, points);
    clip.start = start;
    clip.end = start + len;
    clip.character = laneCharacters(state)[drag.targetLane] ?? "";
  } else if (mode === "start") {
    clip.start = clamp(snap(drag.originStart + dt, points), 0, drag.originEnd - MIN_CLIP_SEC);
  } else {
    clip.end = clamp(snap(drag.originEnd + dt, points), drag.originStart + MIN_CLIP_SEC, duration || Infinity);
  }

  pill.classList.remove("dragging");
  pill.style.transform = "";
  for (const el of Array.from($("studio-tl-tracks").querySelectorAll(".studio-tl-lane"))) {
    el.classList.remove("drop-target");
  }
  hideSnapGuide();
  drag = null;

  // Реплики держим отсортированными по времени: пак так и собирается.
  state.clips.sort((a, b) => a.start - b.start);
  pushHistory(state);
  opts.onClipsChanged();
  renderLanes(state, video, opts);
  if (clip.start !== drag0Start) void refreshThumb(video, clip, () => opts.onClipsChanged());
}

/**
 * Кадр-превью снят на старом начале реплики: сдвинули границу — картинка
 * перестала соответствовать. Пересобираем и возвращаем плеер на место.
 */
export async function refreshThumb(video: HTMLVideoElement, clip: StudioClip, done?: () => void): Promise<void> {
  const wasAt = video.currentTime;
  const wasPlaying = !video.paused;
  if (wasPlaying) video.pause();
  clip.thumb = await captureFrame(video, clip.start);
  video.currentTime = wasAt;
  if (wasPlaying) void video.play().catch(() => undefined);
  done?.();
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Точки, к которым прилипают края реплики: границы соседних реплик (чтобы
 * стыковать фразы без щелей и нахлёстов) и границы речи из VAD (чтобы
 * попадать ровно в паузу, а не в середину слова). Начало и конец ролика тоже.
 */
function snapPoints(state: StudioState, exceptId: string): SnapTargets {
  const clips: number[] = [0];
  if (state.durationSec > 0) clips.push(state.durationSec);
  for (const clip of state.clips) {
    if (clip.id === exceptId) continue;
    clips.push(clip.start, clip.end);
  }
  const speech: number[] = [];
  for (const iv of speechRanges) speech.push(iv.start, iv.end);
  return { clips, speech };
}

/**
 * Прилипание в два эшелона: сперва края соседних реплик, и только если
 * рядом ни одной — границы речи из VAD.
 *
 * Одним общим списком это работало плохо: границ речи много и лежат они
 * густо, так что почти всегда находилась точка ближе, чем край соседней
 * реплики, и стыковать фразы встык не получалось — со стороны выглядело
 * как «снэп работает не со всеми репликами».
 */
function snap(sec: number, targets: SnapTargets): number {
  const radius = SNAP_PX / pxPerSec;
  const best = nearest(sec, targets.clips, radius) ?? nearest(sec, targets.speech, radius);
  if (best === null) return sec;
  showSnapGuide(best);
  return best;
}

function nearest(sec: number, points: number[], radius: number): number | null {
  let best: number | null = null;
  let bestDist = radius;
  for (const p of points) {
    const dist = Math.abs(p - sec);
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best;
}

/**
 * Прилипание реплики, которую двигают целиком: пробуем оба края и берём тот,
 * который действительно к чему-то прилип.
 *
 * Раньше здесь сравнивались расстояния «на глаз»: если начало никуда не
 * прилипло, его сдвиг равен нулю и всегда выигрывал у прилипшего конца — то
 * есть конец не прилипал НИКОГДА. Отсюда и жалоба, что снэп срабатывает
 * избирательно: подвести конец реплики к началу следующей было невозможно.
 */
interface SnapTargets {
  /** Края соседних реплик, начало и конец ролика — главный ориентир. */
  clips: number[];
  /** Границы речи из VAD — запасной, чтобы попадать в паузу. */
  speech: number[];
}

function snapWhole(start: number, len: number, points: SnapTargets): number {
  const byStart = snap(start, points);
  const byEnd = snap(start + len, points) - len;
  const startMoved = byStart !== start;
  const endMoved = byEnd !== start;
  if (startMoved && endMoved) return Math.abs(byStart - start) <= Math.abs(byEnd - start) ? byStart : byEnd;
  if (startMoved) return byStart;
  if (endMoved) return byEnd;
  return start;
}

/** Вертикальная черта в точке прилипания — иначе о нём никак не догадаться. */
function showSnapGuide(sec: number): void {
  const guide = $("studio-tl-snap");
  guide.style.left = `${sec * pxPerSec}px`;
  guide.hidden = false;
}

function hideSnapGuide(): void {
  $("studio-tl-snap").hidden = true;
}

/** Речевые интервалы исходника — считаются один раз на прогон. */
let speechRanges: { start: number; end: number }[] = [];
export function setSpeechRanges(ranges: { start: number; end: number }[]): void {
  speechRanges = ranges;
}

// ---------- Подключение экрана ----------

let wired = false;

export function initLanes(state: StudioState, video: HTMLVideoElement, opts: LanesOptions): void {
  // Новый прогон — новое видео: огибающая предыдущего больше не годится.
  env = null;
  pxPerSec = 40;
  selectedId = null;
  activeCharacter = "";
  resetHistory(state);

  const scroll = $("studio-tl-scroll");
  const zoom = $<HTMLInputElement>("studio-tl-zoom");
  const playBtn = $("studio-tl-play");

  // Зум держит на месте не левый край таймлайна, а курсор (плейхед):
  // иначе на длинном ролике каждое движение ползунка — или пинч трекпадом —
  // уносило рабочий участок за пределы экрана, и приходилось заново его
  // искать прокруткой.
  const applyZoom = (nextPxPerSec: number) => {
    const min = Number(zoom.min) || 10;
    const max = Number(zoom.max) || 200;
    const oldPxPerSec = pxPerSec;
    const anchorX = video.currentTime * oldPxPerSec - scroll.scrollLeft;
    pxPerSec = clamp(nextPxPerSec, min, max);
    zoom.value = String(Math.round(pxPerSec));
    renderLanes(state, video, opts);
    const maxScroll = Math.max(0, $("studio-tl-inner").scrollWidth - scroll.clientWidth);
    scroll.scrollLeft = clamp(video.currentTime * pxPerSec - anchorX, 0, maxScroll);
    redrawWave(scroll);
  };

  zoom.value = String(pxPerSec);
  zoom.oninput = () => applyZoom(Number(zoom.value) || 40);

  // Пинч трекпадом браузер сообщает как wheel с ctrlKey — так же, как и
  // настоящий Ctrl+колесо; отличить их нельзя, да и незачем.
  scroll.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      applyZoom(pxPerSec * Math.exp(-e.deltaY * 0.01));
    },
    { passive: false }
  );

  scroll.onscroll = () => redrawWave(scroll);

  // Клик по линейке — перемотка; зажатая кнопка тянет курсор дальше, а не
  // только ставит его в точку первого клика.
  const seekFrom = (e: PointerEvent) => {
    const inner = $("studio-tl-inner");
    const rect = inner.getBoundingClientRect();
    video.currentTime = clamp((e.clientX - rect.left) / pxPerSec, 0, state.durationSec || video.duration || 0);
    updatePlayhead(video, state.durationSec || video.duration || 0);
  };
  const ruler = $("studio-tl-ruler");
  ruler.onpointerdown = (e) => {
    seekFrom(e);
    ruler.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => seekFrom(ev);
    const onUp = () => {
      ruler.removeEventListener("pointermove", onMove);
      ruler.removeEventListener("pointerup", onUp);
      ruler.removeEventListener("pointercancel", onUp);
    };
    ruler.addEventListener("pointermove", onMove);
    ruler.addEventListener("pointerup", onUp);
    ruler.addEventListener("pointercancel", onUp);
  };

  // Присваивание, а не addEventListener: initLanes зовётся на каждый прогон,
  // а <video> в разметке один и тот же — иначе обработчики копились бы.
  playBtn.onclick = () => togglePlay(video);
  video.onplay = () => {
    playBtn.textContent = "⏸";
    startFollowing(state, video);
  };
  video.onpause = () => {
    playBtn.textContent = "▶";
    stopFollowing();
  };
  video.onseeked = () => updatePlayhead(video, state.durationSec || video.duration || 0);

  $("studio-tl-add").onclick = () => void addClipAtPlayhead(state, video, opts);

  if (wired) return;
  wired = true;
  window.addEventListener("resize", () => redrawWave($("studio-tl-scroll")));
  // Таймлайн рисуется до того, как экран показан, — у скрытой секции все
  // размеры нулевые, и волна не рисовалась вовсе (канвас оставался дефолтным
  // 300×150). Ждём, когда канвас реально получит размер.
  new ResizeObserver(() => redrawWave($("studio-tl-scroll"))).observe($("studio-tl-wave"));
  document.addEventListener("keydown", (e) => onKeyDown(e, currentState(), currentVideo(), currentOpts()));
}

// Слушатели окна и клавиатуры живут дольше одного прогона — работают с
// актуальными состоянием и плеером, а не с теми, что были при первом вызове.
let lastState: StudioState | null = null;
let lastVideo: HTMLVideoElement | null = null;
let lastOpts: LanesOptions | null = null;
function currentState(): StudioState {
  return lastState as StudioState;
}
function currentVideo(): HTMLVideoElement {
  return lastVideo as HTMLVideoElement;
}
function currentOpts(): LanesOptions {
  return lastOpts as LanesOptions;
}

function onKeyDown(e: KeyboardEvent, state: StudioState, video: HTMLVideoElement, opts: LanesOptions): void {
  const target = e.target as HTMLElement | null;
  // В полях ввода пробел — это пробел, а не «играть».
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
  if ($("studio-screen-timeline").hidden) return;

  if (e.code === "Space") {
    e.preventDefault();
    togglePlay(video);
    return;
  }

  // Undo/redo — Ctrl+Z / Ctrl+Shift+Z (и Ctrl+Y как частый альтернативный
  // вариант redo). Cmd на Mac — через metaKey.
  const withMod = e.ctrlKey || e.metaKey;
  if (withMod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    const applied = e.shiftKey ? redo(state) : undo(state);
    if (applied) {
      selectedId = null;
      opts.onSelect(null);
      opts.onClipsChanged();
      renderLanes(state, video, opts);
    }
    return;
  }
  if (withMod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    if (redo(state)) {
      selectedId = null;
      opts.onSelect(null);
      opts.onClipsChanged();
      renderLanes(state, video, opts);
    }
    return;
  }

  if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
    e.preventDefault();
    state.clips = state.clips.filter((c) => c.id !== selectedId);
    pushHistory(state);
    selectedId = null;
    opts.onSelect(null);
    opts.onClipsChanged();
    renderLanes(state, video, opts);
  }
}

function togglePlay(video: HTMLVideoElement): void {
  if (video.paused) void video.play();
  else video.pause();
}

function startFollowing(state: StudioState, video: HTMLVideoElement): void {
  stopFollowing();
  const scroll = $("studio-tl-scroll");
  const tick = () => {
    const duration = state.durationSec || video.duration || 0;
    updatePlayhead(video, duration);
    // Курсор не должен убегать за край видимой части.
    const x = video.currentTime * pxPerSec;
    if (x < scroll.scrollLeft || x > scroll.scrollLeft + scroll.clientWidth - 40) {
      scroll.scrollLeft = Math.max(0, x - scroll.clientWidth / 2);
    }
    rafHandle = requestAnimationFrame(tick);
  };
  rafHandle = requestAnimationFrame(tick);
}

function stopFollowing(): void {
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = 0;
}

async function addClipAtPlayhead(state: StudioState, video: HTMLVideoElement, opts: LanesOptions): Promise<void> {
  await createClip(state, video, opts, activeCharacter, video.currentTime);
}

/** Общий путь создания реплики — с курсора («+ Реплика») и кликом по пустой дорожке. */
async function createClip(
  state: StudioState,
  video: HTMLVideoElement,
  opts: LanesOptions,
  character: string,
  atSec: number
): Promise<void> {
  const duration = state.durationSec || video.duration || 0;
  const start = clamp(atSec, 0, Math.max(0, duration - MIN_CLIP_SEC));
  const end = duration > 0 ? Math.min(duration, start + NEW_CLIP_SEC) : start + NEW_CLIP_SEC;
  const clip: StudioClip = {
    id: newClipId(),
    start,
    end,
    text: "",
    character,
    thumb: null,
  };
  note("добавил реплику");
  state.clips.push(clip);
  state.clips.sort((a, b) => a.start - b.start);
  pushHistory(state);
  selectedId = clip.id;
  activeCharacter = character;
  opts.onSelect(clip.id);
  opts.onClipsChanged();
  renderLanes(state, video, opts);

  // Кадр снимаем после отрисовки: перемотка вернёт плеер на место сама.
  const at = video.currentTime;
  clip.thumb = await captureFrame(video, start);
  video.currentTime = at;
  opts.onClipsChanged();
}

/**
 * Приводит вид к началу работы: курсор в начало ролика, прокрутка влево,
 * зум — так, чтобы весь ролик поместился в видимую часть.
 *
 * Без этого игрок попадал на таймлайн в конец ролика: съёмка кадров-превью
 * оставляла плеер на последней реплике (на 80-секундном видео — 74-я секунда),
 * и нажатие «играть» проигрывало жалкий хвост. Выглядело как «видео не
 * проигрывается».
 */
export function resetView(state: StudioState, video: HTMLVideoElement, opts: LanesOptions): void {
  const scroll = $("studio-tl-scroll");
  const zoom = $<HTMLInputElement>("studio-tl-zoom");
  const duration = state.durationSec || env?.durationSec || video.duration || 0;
  const width = scroll.clientWidth || 900;
  if (duration > 0) {
    const min = Number(zoom.min) || 10;
    const max = Number(zoom.max) || 200;
    pxPerSec = Math.max(min, Math.min(max, width / duration));
    zoom.value = String(Math.round(pxPerSec));
  }
  video.currentTime = 0;
  scroll.scrollLeft = 0;
  renderLanes(state, video, opts);
}

export function selectedClipId(): string | null {
  return selectedId;
}

/** Инспектор справа тоже умеет выбирать реплику — подсветка общая. */
export function selectClip(id: string | null): void {
  selectedId = id;
  for (const pill of Array.from($("studio-tl-tracks").querySelectorAll<HTMLElement>(".studio-tl-pill"))) {
    pill.classList.toggle("selected", pill.dataset.clipId === id);
  }
}

/**
 * Открывает правку имени персонажа на его дорожке. Нужна снаружи: только что
 * созданный персонаж называется «Персонаж 2», и первое, что с ним делают, —
 * переименовывают.
 */
export function beginRename(name: string): void {
  if (!lastState || !lastVideo || !lastOpts) return;
  const index = laneCharacters(lastState).indexOf(name);
  if (index < 0) return;
  const head = $("studio-tl-heads").children[index] as HTMLElement | undefined;
  const label = head?.querySelector<HTMLElement>(".studio-tl-head-name");
  if (label) startRename(label, lastState, lastVideo, lastOpts, name);
}

/** Активный персонаж — чтобы вновь созданный сразу стал активным (мелочь, убирающая клик). */
export function setActiveCharacter(name: string): void {
  activeCharacter = name;
}
