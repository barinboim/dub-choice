/**
 * Экран редактора: слева видео и таймлайн (lanes.ts), справа — пак,
 * персонажи и инспектор выбранной реплики.
 *
 * Длинного списка всех реплик здесь нет намеренно: на сотне реплик он
 * превращался в простыню, а правится всегда одна — та, что выбрана на
 * таймлайне. Раскладка по мотивам Choicer Voicer Dub Pack Editor
 * (Loganrithm) — только раскладка: исходников у того инструмента нет,
 * он раздаётся собранным .exe под PolyForm Strict.
 */
import { $ } from "./dom";
import { newClipId, type StudioClip, type StudioState } from "./state";
import {
  beginRename,
  characterColor as colorFor,
  initLanes,
  renderLanes,
  resetView,
  selectClip,
  selectedClipId,
  setActiveCharacter,
} from "./lanes";
import { pushHistory } from "./history";
import { captureFrame, imageFileToThumb, playClipRange } from "./media";
import { t } from "../i18n";
import { note } from "../journey";

export function renderTimeline(state: StudioState, video: HTMLVideoElement): void {
  const titleInput = $<HTMLInputElement>("studio-pack-title");
  const authorInput = $<HTMLInputElement>("studio-pack-author");
  titleInput.value = state.packTitle;
  authorInput.value = state.packAuthor;
  titleInput.oninput = () => {
    state.packTitle = titleInput.value;
  };
  authorInput.oninput = () => {
    state.packAuthor = authorInput.value;
  };
  initPackIcon(state, video, () => renderIcon(state));

  const lanesOpts = {
    onClipsChanged: () => {
      // Список персонажей тоже: переименование с дорожки меняет его имя, и
      // без этого правая панель показывала старое.
      renderCharacters(state, rerender);
      $("studio-no-clips").hidden = state.clips.length > 0;
      renderInspector(state, video, rerender);
      // Пока иконку не выбрали руками, она следует за кадром первой реплики
      // (buildPack), а он мог только что перерисоваться (перетащили край,
      // удалили реплику) — превью не должно показывать устаревший кадр.
      renderIcon(state);
    },
    onSelect: () => renderInspector(state, video, rerender),
  };

  const rerender = () => {
    renderCharacters(state, rerender);
    $("studio-no-clips").hidden = state.clips.length > 0;
    renderInspector(state, video, rerender);
    renderLanes(state, video, lanesOpts);
    renderIcon(state);
  };

  initLanes(state, video, lanesOpts);
  initInspector(state, video, rerender);
  initVideoCaption(state, video, rerender);
  rerender();
  // Экран показывается после этого вызова, поэтому ширину меряем на следующем
  // кадре — до показа она нулевая, и зум «по ширине» посчитался бы мимо.
  requestAnimationFrame(() => resetView(state, video, lanesOpts));

  $("studio-add-character").onclick = () => addCharacter(state, rerender);
}

/** Общая точка входа: кнопка над таймлайном и «+» в списке персонажей справа. */
function addCharacter(state: StudioState, rerender: () => void): void {
  const name = `${t("studioClipCharacter")} ${state.characters.length + 1}`;
  note("добавил персонажа");
  state.characters.push(name);
  pushHistory(state);
  // Только что созданный персонаж сразу активен — иначе первый клик всегда
  // уходит на то, чтобы выбрать дорожку, в которую и так собирались класть.
  setActiveCharacter(name);
  rerender();
  // Имя по умолчанию никому не нужно — сразу даём его переписать.
  beginRename(name);
}

// ---------- Иконка пака ----------

/** Предыдущий превью-URL — отзываем перед тем, как завести новый. */
let iconPreviewUrl: string | null = null;

/**
 * Пока иконку не выбрали руками (state.packIcon), превью показывает то же,
 * что возьмёт buildPack() по умолчанию — кадр первой реплики. Так что там,
 * и что покажет игра, не расходятся.
 */
function renderIcon(state: StudioState): void {
  const img = $<HTMLImageElement>("studio-icon-preview");
  const blob = state.packIcon ?? state.clips[0]?.thumb ?? null;
  if (iconPreviewUrl) URL.revokeObjectURL(iconPreviewUrl);
  iconPreviewUrl = blob ? URL.createObjectURL(blob) : null;
  img.src = iconPreviewUrl ?? "";
}

/** Обработчики вешаются один раз — значения обновляет только renderIcon. */
function initPackIcon(state: StudioState, video: HTMLVideoElement, rerenderIcon: () => void): void {
  $<HTMLButtonElement>("studio-icon-frame").onclick = () => {
    note("иконка пака: взял кадр видео");
    // Кадр берётся там, где сейчас стоит плеер, — так что «выбор секунды»
    // это просто перемотка видео перед нажатием кнопки, повторное нажатие
    // на новом месте меняет иконку на новый кадр.
    void captureFrame(video, video.currentTime).then((blob) => {
      if (!blob) return;
      state.packIcon = blob;
      rerenderIcon();
    });
  };

  const fileInput = $<HTMLInputElement>("studio-icon-file");
  $<HTMLButtonElement>("studio-icon-upload").onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    note("иконка пака: загрузил свою картинку");
    void imageFileToThumb(file).then((blob) => {
      if (!blob) return;
      state.packIcon = blob;
      rerenderIcon();
    });
  };
}

function renderCharacters(state: StudioState, rerender: () => void): void {
  const list = $("studio-character-list");
  const chips = state.characters.map((name, i) => {
    const chip = document.createElement("div");
    chip.className = "studio-character-chip";

    const swatch = document.createElement("span");
    swatch.className = "studio-character-swatch";
    swatch.style.background = colorFor(i);

    const input = document.createElement("input");
    input.type = "text";
    input.value = name;
    input.addEventListener("change", () => {
      const old = state.characters[i];
      const next = input.value.trim() || old;
      state.characters[i] = next;
      for (const clip of state.clips) if (clip.character === old) clip.character = next;
      setActiveCharacter(next);
      pushHistory(state);
      rerender();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "studio-character-remove";
    remove.textContent = "✕";
    remove.addEventListener("click", () => {
      const removed = state.characters[i];
      note("удалил персонажа");
      state.characters.splice(i, 1);
      // Реплики удалённого персонажа не пропадают — уезжают в дорожку «Без персонажа».
      for (const clip of state.clips) if (clip.character === removed) clip.character = "";
      setActiveCharacter("");
      pushHistory(state);
      rerender();
    });

    chip.append(swatch, input, remove);
    return chip;
  });

  // Тот же путь, что кнопка «+ Персонаж» над таймлайном — она далеко от этой
  // панели, и добавлять персонажа удобнее прямо там, где виден их список.
  const add = document.createElement("button");
  add.type = "button";
  add.className = "studio-character-add";
  add.textContent = t("studioAddCharacter");
  add.addEventListener("click", () => addCharacter(state, rerender));

  list.replaceChildren(...chips, add);
}

// ---------- Инспектор выбранной реплики ----------

function currentClip(state: StudioState): StudioClip | null {
  const id = selectedClipId();
  return state.clips.find((c) => c.id === id) ?? null;
}

function clipAtTime(state: StudioState, time: number): StudioClip | null {
  return state.clips.find((c) => time >= c.start && time < c.end) ?? null;
}

/** Хронологический порядок — персонаж роли не играет: «след. реплика» листает сцену, а не роль. */
function clipsByStart(state: StudioState): StudioClip[] {
  return [...state.clips].sort((a, b) => a.start - b.start);
}

/** Общий путь удаления — кнопка «Удалить», Backspace на пустом тексте в любом из трёх полей. */
function deleteClip(state: StudioState, clip: StudioClip): void {
  note("удалил реплику");
  state.clips = state.clips.filter((c) => c.id !== clip.id);
  pushHistory(state);
  selectClip(null);
}

// ---------- Субтитр поверх видео ----------

/**
 * Показывает текст реплики, идущей под плейхедом, поверх видео — и даёт
 * править его прямо там. Пишет в тот же clip.text, что и поле в
 * инспекторе справа: два поля одного значения, как заголовок/подзаголовок
 * нигде не дублируются в паке. Правка коммитится целиком при закрытии
 * (Enter/blur), как в экране игры (`openCaptionEditor` в main.ts) — не на
 * каждую клавишу, чтобы не гонять rerender() по нажатию.
 */
function initVideoCaption(state: StudioState, video: HTMLVideoElement, rerender: () => void): void {
  const caption = $("studio-video-caption");
  const editor = $<HTMLTextAreaElement>("studio-video-caption-edit");
  let editingClip: StudioClip | null = null;

  const update = () => {
    if (editingClip) return; // не перебиваем то, что человек сейчас печатает
    const clip = clipAtTime(state, video.currentTime);
    caption.hidden = !clip;
    const text = clip?.text ?? "";
    // Пустой субтитр всё равно кликабелен — иначе первую реплику текстом
    // просто нечем было бы открыть с оверлея.
    caption.textContent = text || t("noCaption");
    caption.classList.toggle("empty", !text);
  };

  const openEditor = () => {
    const clip = clipAtTime(state, video.currentTime);
    if (!clip) return;
    editingClip = clip;
    editor.value = clip.text;
    caption.hidden = true;
    editor.hidden = false;
    editor.focus();
    editor.select();
    // Правка идёт по времени под плейхедом — таймлайн и инспектор должны
    // показывать ту же реплику, а не ту, что была выбрана до этого.
    selectClip(clip.id);
    rerender();
  };

  const closeEditor = (save: boolean) => {
    if (!editingClip) return;
    const clip = editingClip;
    editingClip = null;
    editor.hidden = true;
    if (save) {
      clip.text = editor.value;
      pushHistory(state);
      rerender();
    }
    update();
  };

  caption.addEventListener("click", openEditor);
  editor.addEventListener("blur", () => closeEditor(true));
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      closeEditor(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeEditor(false);
    } else if ((e.key === "Backspace" || e.key === "Delete") && editor.value === "") {
      // Пусто и ещё раз Backspace/Delete — значит реплика тут не нужна вовсе.
      e.preventDefault();
      const clip = editingClip;
      if (!clip) return;
      editingClip = null;
      editor.hidden = true;
      deleteClip(state, clip);
      rerender();
      update();
    }
  });

  video.addEventListener("timeupdate", update);
  video.addEventListener("seeked", update);
  update();
}

/** Обработчики вешаются один раз, значения обновляются в renderInspector. */
function initInspector(state: StudioState, video: HTMLVideoElement, rerender: () => void): void {
  const textInput = $<HTMLTextAreaElement>("studio-clip-text");
  const characterSelect = $<HTMLSelectElement>("studio-clip-character");

  textInput.oninput = () => {
    const clip = currentClip(state);
    if (!clip) return;
    clip.text = textInput.value;
    renderLanes(state, video, {
      onClipsChanged: () => renderInspector(state, video, rerender),
      onSelect: () => renderInspector(state, video, rerender),
    });
  };
  // История пишется на потерю фокуса, а не на каждую клавишу — иначе Ctrl+Z
  // откатывал бы правку по одной букве вместо всей правки разом.
  textInput.addEventListener("blur", () => pushHistory(state));
  textInput.addEventListener("keydown", (e) => {
    if ((e.key !== "Backspace" && e.key !== "Delete") || textInput.value !== "") return;
    // Пусто и ещё раз Backspace/Delete — значит реплика тут не нужна вовсе.
    const clip = currentClip(state);
    if (!clip) return;
    e.preventDefault();
    deleteClip(state, clip);
    rerender();
  });
  characterSelect.onchange = () => {
    const clip = currentClip(state);
    if (!clip) return;
    note("сменил персонажа реплики");
    clip.character = characterSelect.value;
    pushHistory(state);
    rerender();
  };

  $("studio-clip-play").onclick = () => {
    const clip = currentClip(state);
    note("слушал реплику");
    if (clip) void playClipRange(video, clip.start, clip.end);
  };

  // Пред./след. реплика — по хронологии всей сцены, а не по одному персонажу:
  // так проверяют стыки реплик друг с другом, а не переслушивают одну роль.
  const prevBtn = $<HTMLButtonElement>("studio-clip-prev");
  const nextBtn = $<HTMLButtonElement>("studio-clip-next");
  prevBtn.title = t("studioClipPrev");
  prevBtn.setAttribute("aria-label", t("studioClipPrev"));
  nextBtn.title = t("studioClipNext");
  nextBtn.setAttribute("aria-label", t("studioClipNext"));
  const goToClip = (direction: -1 | 1) => {
    const ordered = clipsByStart(state);
    if (ordered.length === 0) return;
    const current = currentClip(state);
    const index = current ? ordered.findIndex((c) => c.id === current.id) : -1;
    const target = ordered[index < 0 ? 0 : index + direction];
    if (!target) return;
    selectClip(target.id);
    video.currentTime = target.start;
    rerender();
  };
  prevBtn.onclick = () => goToClip(-1);
  nextBtn.onclick = () => goToClip(1);
  $("studio-clip-delete").onclick = () => {
    const clip = currentClip(state);
    if (!clip) return;
    deleteClip(state, clip);
    rerender();
  };

  $("studio-add-clip-side")?.addEventListener("click", () => {
    const last = state.clips[state.clips.length - 1];
    const start = last ? last.end : 0;
    const end = state.durationSec > 0 ? Math.min(state.durationSec, start + 2) : start + 2;
    state.clips.push({ id: newClipId(), start, end, text: "", character: "", thumb: null });
    state.clips.sort((a, b) => a.start - b.start);
    pushHistory(state);
    rerender();
  });
}

function renderInspector(state: StudioState, video: HTMLVideoElement, rerender: () => void): void {
  const clip = currentClip(state);
  const editor = $("studio-clip-editor");
  const empty = $("studio-clip-empty");
  editor.hidden = !clip;
  empty.hidden = !!clip;
  if (!clip) return;

  const textInput = $<HTMLTextAreaElement>("studio-clip-text");
  // Поле текста не трогаем, пока в нём печатают, — иначе съедет курсор.
  if (document.activeElement !== textInput) textInput.value = clip.text;

  const select = $<HTMLSelectElement>("studio-clip-character");
  const options: HTMLOptionElement[] = [];
  const none = document.createElement("option");
  none.value = "";
  none.textContent = t("studioNoCharacter");
  options.push(none);
  for (const name of state.characters) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    options.push(opt);
  }
  select.replaceChildren(...options);
  select.value = clip.character;

  const ordered = clipsByStart(state);
  const index = ordered.findIndex((c) => c.id === clip.id);
  $<HTMLButtonElement>("studio-clip-prev").disabled = index <= 0;
  $<HTMLButtonElement>("studio-clip-next").disabled = index < 0 || index >= ordered.length - 1;
  $("studio-clip-nav-pos").textContent = index >= 0 ? `${index + 1} / ${ordered.length}` : "";

  void video;
  void rerender;
}
