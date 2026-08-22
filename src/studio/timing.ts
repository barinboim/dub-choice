/**
 * Замер этапов студии. Снаружи (из Playwright) времена не снять: разделение
 * и расшифровка держат главный поток, и опрос страницы зависает вместе с ним.
 * Поэтому меряем изнутри и печатаем сводку в консоль — оттуда цифры уезжают
 * в docs/STUDIO_WEB_PLAN.md, «Результаты фазы 0».
 */
import { note } from "../journey";

export interface StageTiming {
  name: string;
  sec: number;
}

const stages: StageTiming[] = [];

export function resetTimings(): void {
  stages.length = 0;
}

export async function timed<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  // Отметка «начал» — единственный способ узнать из отчёта игрока, на каком
  // этапе пайплайн завис: если fn() не вернётся никогда, ни счётчик времени,
  // ни консольный лог ниже не сработают, а эта строка в дневнике уже есть
  // (репорт от 2026-08-22 — «Закадр» на Android замолчал сразу после выбора
  // режима, и понять, где именно, было нечем).
  note(`начал: ${name}`);
  const started = performance.now();
  try {
    return await fn();
  } finally {
    const sec = (performance.now() - started) / 1000;
    stages.push({ name, sec });
    console.info(`[studio] ${name}: ${sec.toFixed(1)} с`);
  }
}

export function timings(): StageTiming[] {
  return stages.slice();
}

/** Сводка в одну строку — её и читает смоук-тест. */
export function logTimingSummary(mode: string, durationSec: number): void {
  const total = stages.reduce((sum, s) => sum + s.sec, 0);
  const parts = stages.map((s) => `${s.name} ${s.sec.toFixed(1)}с`).join(", ");
  const ratio = durationSec > 0 ? (total / durationSec).toFixed(1) : "?";
  console.info(
    `[studio] ИТОГО ${mode}: ${total.toFixed(1)} с на ${durationSec.toFixed(1)} с видео (×${ratio}) — ${parts}`
  );
}
