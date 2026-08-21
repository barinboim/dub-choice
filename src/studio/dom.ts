/** Тот же приём, что в src/main.ts: `$()` молча вернёт null, если id не найден в разметке. */
export function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
