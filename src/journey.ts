/**
 * Дневник сеанса: что человек делал до того, как всё сломалось.
 *
 * Аналитика (GoatCounter) отвечает «сколько людей дошло до шага N», но она
 * анонимна и без дедупликации (docs/ANALYTICS.md) — сличить письмо игрока с
 * его строками в статистике нельзя в принципе. А чинить приходится не
 * «шаг N вообще», а конкретный путь: принёс mkv → выбрал «Дубляж» →
 * подвинул пять реплик → нажал «Собрать пак». Дневник едет вместе с
 * отчётом, и только если игрок сам нажал «Отправить».
 *
 * Что сюда НЕ пишем: имена файлов, ссылки, текст реплик и имена персонажей —
 * это данные игрока, а для разбора хватает самих действий.
 */

interface Step {
  atMs: number;
  what: string;
  /** Повторы схлопываются: «двигал реплику ×14» вместо четырнадцати строк. */
  times: number;
}

/** Хвост в сто шагов: длиннее не читается, а в Telegram уходит вложением. */
const MAX_STEPS = 100;

const startedAt = performance.now();
const steps: Step[] = [];

export function note(what: string): void {
  const last = steps[steps.length - 1];
  if (last && last.what === what) {
    last.times += 1;
    return;
  }
  steps.push({ atMs: performance.now() - startedAt, what, times: 1 });
  if (steps.length > MAX_STEPS) steps.splice(0, steps.length - MAX_STEPS);
}

export function journeyLines(): string[] {
  return steps.map((s) => {
    const at = `+${(s.atMs / 1000).toFixed(1)} с`;
    return `${at.padStart(9)} ${s.what}${s.times > 1 ? ` ×${s.times}` : ""}`;
  });
}

/** Сколько человек уже сидит на странице — само по себе говорящая цифра. */
export function sessionSeconds(): number {
  return (performance.now() - startedAt) / 1000;
}
