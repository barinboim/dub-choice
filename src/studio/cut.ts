/**
 * VAD-интервалы → черновой список реплик. Порт идеи cut.py (README студии):
 * потолок длины реплики. Текста здесь нет: распознавание речи из студии
 * убрано, субтитры игрок пишет руками в редакторе.
 */
import type { VadInterval } from "./vad";

export interface CutClip {
  start: number;
  end: number;
}

/** Реплика длиннее этого делится пополам (и дальше, пока не влезет). */
const MAX_CLIP_SEC = 7;

export function cutClips(intervals: VadInterval[]): CutClip[] {
  return splitByCeiling(intervals, MAX_CLIP_SEC);
}

function splitByCeiling(intervals: VadInterval[], ceiling: number): VadInterval[] {
  const out: VadInterval[] = [];
  for (const iv of intervals) {
    const len = iv.end - iv.start;
    if (len <= ceiling) {
      out.push(iv);
      continue;
    }
    const parts = Math.ceil(len / ceiling);
    const step = len / parts;
    for (let i = 0; i < parts; i++) {
      out.push({ start: iv.start + i * step, end: iv.start + (i + 1) * step });
    }
  }
  return out;
}
