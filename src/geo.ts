/**
 * Подсказка про VPN для заходов из РФ.
 *
 * Весь контент сайта (zip-паки, иконки, веса студии, ядро ffmpeg) лежит в
 * Cloudflare R2 — из России он отдаётся с перебоями. Страну спрашиваем у
 * самого Cloudflare: `/cdn-cgi/trace` на R2-домене возвращает `loc=<ISO>`
 * и отдаётся с `Access-Control-Allow-Origin: *`, поэтому читается из
 * браузера с любого домена (в отличие от самих объектов бакета, где CORS
 * заперт на прод-домен). Нет ответа — молчим, подсказка не критична.
 */
import { PACKS_BASE } from "./pack/preloaded";

let hintEl: HTMLElement | null = null;

/** Показать подсказку безусловно — вызывается ещё и когда паки не
 *  скачались вовсе (Cloudflare может быть заблокирован целиком, и тогда
 *  сам trace-запрос ниже тоже не дойдёт). */
export function showVpnHint(): void {
  if (hintEl) hintEl.hidden = false;
}

export async function initVpnHint(el: HTMLElement): Promise<void> {
  hintEl = el;
  try {
    const res = await fetch(`${PACKS_BASE}cdn-cgi/trace`, { cache: "no-store" });
    if (!res.ok) return;
    const loc = /(?:^|\n)loc=([A-Z]{2})/.exec(await res.text())?.[1];
    if (loc === "RU") showVpnHint();
  } catch {
    /* сеть/Cloudflare недоступны — подсказку покажет фолбэк загрузки паков */
  }
}
