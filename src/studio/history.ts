/**
 * Undo/redo для реплик и персонажей студии. Снимок — неглубокая копия
 * `clips`/`characters`: клипы мутируются на месте (`clip.text = ...` и
 * так далее) в добрый десяток мест по lanes.ts/timeline.ts, и без копии
 * каждого клипа сохранённый снимок менялся бы вместе с текущим состоянием.
 * Блобы кадров-превью не клонируются — они неизменны, ссылку достаточно
 * скопировать.
 *
 * Остальное состояние (заголовок пака, автор, иконка, дорожки) сознательно
 * не входит в историю: правки этих полей редки и одиночны, откатывать их
 * вместе с чужой правкой реплики было бы неожиданно.
 */
import type { StudioClip, StudioState } from "./state";

interface Snapshot {
  clips: StudioClip[];
  characters: string[];
}

const MAX_HISTORY = 100;

let undoStack: Snapshot[] = [];
let redoStack: Snapshot[] = [];

function snapshotOf(state: StudioState): Snapshot {
  return {
    clips: state.clips.map((c) => ({ ...c })),
    characters: [...state.characters],
  };
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  if (a.characters.length !== b.characters.length || a.clips.length !== b.clips.length) return false;
  for (let i = 0; i < a.characters.length; i++) if (a.characters[i] !== b.characters[i]) return false;
  for (let i = 0; i < a.clips.length; i++) {
    const x = a.clips[i]!;
    const y = b.clips[i]!;
    if (x.id !== y.id || x.start !== y.start || x.end !== y.end || x.text !== y.text || x.character !== y.character) {
      return false;
    }
  }
  return true;
}

/** Новый прогон студии — своя история, без хвоста от предыдущего видео. */
export function resetHistory(state: StudioState): void {
  undoStack = [snapshotOf(state)];
  redoStack = [];
}

/** Звать после любой завершённой правки — не на каждое нажатие клавиши в поле текста. */
export function pushHistory(state: StudioState): void {
  const snap = snapshotOf(state);
  const top = undoStack[undoStack.length - 1];
  if (top && sameSnapshot(top, snap)) return; // ничего не изменилось — не засорять стек
  undoStack.push(snap);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
}

export function canUndo(): boolean {
  return undoStack.length > 1;
}

export function canRedo(): boolean {
  return redoStack.length > 0;
}

function applySnapshot(state: StudioState, snap: Snapshot): void {
  state.clips = snap.clips.map((c) => ({ ...c }));
  state.characters = [...snap.characters];
}

export function undo(state: StudioState): boolean {
  if (undoStack.length <= 1) return false;
  const current = undoStack.pop()!;
  redoStack.push(current);
  applySnapshot(state, undoStack[undoStack.length - 1]!);
  return true;
}

export function redo(state: StudioState): boolean {
  const snap = redoStack.pop();
  if (!snap) return false;
  undoStack.push(snap);
  applySnapshot(state, snap);
  return true;
}
