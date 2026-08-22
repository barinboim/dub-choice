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
  rerender();
  // Экран показывается после этого вызова, поэтому ширину меряем на следующем
  // кадре — до показа она нулевая, и зум «по ширине» посчитался бы мимо.
  requestAnimationFrame(() => resetView(state, video, lanesOpts));

  $("studio-add-character").onclick = () => {
    const name = `${t("studioClipCharacter")} ${state.characters.length + 1}`;
    note("добавил персонажа");
    state.characters.push(name);
    // Только что созданный персонаж сразу активен — иначе первый клик всегда
    // уходит на то, чтобы выбрать дорожку, в которую и так собирались класть.
    setActiveCharacter(name);
    rerender();
    // Имя по умолчанию никому не нужно — сразу даём его переписать.
    beginRename(name);
  };
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
  list.replaceChildren(
    ...state.characters.map((name, i) => {
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
        rerender();
      });

      chip.append(swatch, input, remove);
      return chip;
    })
  );
}

// ---------- Инспектор выбранной реплики ----------

function currentClip(state: StudioState): StudioClip | null {
  const id = selectedClipId();
  return state.clips.find((c) => c.id === id) ?? null;
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
  characterSelect.onchange = () => {
    const clip = currentClip(state);
    if (!clip) return;
    note("сменил персонажа реплики");
    clip.character = characterSelect.value;
    rerender();
  };

  $("studio-clip-play").onclick = () => {
    const clip = currentClip(state);
    note("слушал реплику");
    if (clip) void playClipRange(video, clip.start, clip.end);
  };
  $("studio-clip-delete").onclick = () => {
    const clip = currentClip(state);
    if (!clip) return;
    note("удалил реплику");
    state.clips = state.clips.filter((c) => c.id !== clip.id);
    selectClip(null);
    rerender();
  };

  $("studio-add-clip-side")?.addEventListener("click", () => {
    const last = state.clips[state.clips.length - 1];
    const start = last ? last.end : 0;
    const end = state.durationSec > 0 ? Math.min(state.durationSec, start + 2) : start + 2;
    state.clips.push({ id: newClipId(), start, end, text: "", character: "", thumb: null });
    state.clips.sort((a, b) => a.start - b.start);
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
  void video;
  void rerender;
}
