/**
 * Публикация своего пака: игрок отдаёт пак на модерацию галереи.
 *
 * Три шага, и средний из них идёт мимо нашего сервера:
 *
 *   браузер → VPS  /publish/sign  — проверки, лимиты, подписанная ссылка
 *   браузер → R2   PUT            — сам архив, десятки мегабайт
 *   браузер → VPS  /publish/done  — письмо владельцу в Telegram
 *
 * Почему архив не идёт через VPS: он одноядерный, с 700 МБ памяти, и на
 * нём же живут GoatCounter, дашборд-воронка и приёмник обратной связи
 * (CLAUDE.md, «Аналитика»). Прогонять через него сотни мегабайт чужих
 * паков значило бы ронять всё разом на каждой публикации.
 *
 * **Ключей R2 здесь нет и быть не может** — по той же причине, по какой
 * во фронтенде нет токена бота (`feedback.ts`): бандл статического сайта
 * читает любой посетитель, а ключ от бакета — это право переписать
 * манифест галереи. Ссылку подписывает VPS, живёт она час.
 */
import { packToZipBlob, packFolderName } from "./zip";
import { formatSize } from "./preloaded";
import { systemLabel } from "../diagnostics";
import type { DubPack } from "./types";

/** Служба публикации на своём VPS — соседка приёмника обратной связи. */
const PUBLISH_BASE = "https://stats.barinbo.im:8447";

/**
 * Столько же принимает служба на той стороне. Держим цифру и здесь, чтобы
 * не гонять сборку архива впустую: пережать 300 МБ в ZIP — это минуты.
 */
export const MAX_PACK_BYTES = 400 * 1024 * 1024;

/**
 * Метка «пак не влез»: форма показывает по ней свой текст с размерами, а не
 * заворачивает сообщение во второе «не удалось отправить». Сам текст здесь
 * не собираем — модуль транспортный, про интерфейс знать не обязан.
 */
export const TOO_BIG = "publishTooBig:";

export interface PublishMeta {
  author: string;
  /** Откуда игрок взял видео, если он приносил ссылку. Может быть пустым. */
  source: string;
}

export type PublishStage =
  | { kind: "packing" }
  | { kind: "uploading"; percent: number };

/**
 * Иконка уезжает в Telegram картинкой — по ней видно, что за сцена, не
 * скачивая архива. Ограничение самого Telegram для фото — 10 МБ, но нам
 * хватает и куда меньшего: это превью реплики, а не постер.
 */
const MAX_ICON_BYTES = 1024 * 1024;

async function iconDataUrl(pack: DubPack): Promise<string> {
  const icon = pack.icon ?? pack.clips[0]?.image ?? null;
  if (!icon || icon.size > MAX_ICON_BYTES) return "";
  const buf = new Uint8Array(await icon.arrayBuffer());
  let binary = "";
  for (const byte of buf) binary += String.fromCharCode(byte);
  return `data:${icon.type || "image/jpeg"};base64,${btoa(binary)}`;
}

/** PUT с полоской: fetch() о ходе отправки не рассказывает, XHR — да. */
function putWithProgress(url: string, blob: Blob, onPercent: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onPercent(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener("load", () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`R2 ${xhr.status}`))
    );
    xhr.addEventListener("error", () => reject(new Error("сеть")));
    xhr.addEventListener("abort", () => reject(new Error("отменено")));
    xhr.send(blob);
  });
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${PUBLISH_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.error ?? `HTTP ${res.status}`));
  return data;
}

/**
 * Собирает архив, кладёт его в R2 и просит VPS написать владельцу.
 * Бросает `Error` с человеческим текстом — его показывает форма.
 */
export async function publishPack(
  pack: DubPack,
  meta: PublishMeta,
  onStage: (stage: PublishStage) => void
): Promise<void> {
  onStage({ kind: "packing" });
  const zipBlob = await packToZipBlob(pack);
  if (zipBlob.size > MAX_PACK_BYTES) {
    throw new Error(`${TOO_BIG}${formatSize(zipBlob.size)}|${formatSize(MAX_PACK_BYTES)}`);
  }

  const characters = new Set<string>();
  for (const clip of pack.clips) for (const name of clip.characters) characters.add(name);

  // Модератору важно увидеть заранее, что автор не заполнил текст реплик —
  // такой пак не пройдёт озвучку без правок, но об этом не узнать по одной
  // иконке и названию. Пусто — буквально пустая строка, без догадок про
  // «одну букву» и т.п.
  const emptyCaptions = pack.clips.filter((clip) => clip.caption.trim() === "").length;

  const signed = await post("/publish/sign", {
    title: pack.title,
    author: meta.author,
    source: meta.source || pack.sourceUrl,
    // Транслитом, а не как есть: ключ в R2 — часть URL, который уедет в
    // Telegram и потом в чужие руки, а кириллический заголовок сервер
    // вычищает до пустоты (в бакете оказывалось «zip.zip»).
    fileName: `${packFolderName(pack)}.zip`,
    size: zipBlob.size,
    clips: pack.clips.length,
    emptyCaptions,
    characters: [...characters],
    lang: pack.lang,
    mix: pack.forcedMix ?? "dub",
    // То же, что попадает в блок <pre> отчёта обратной связи
    // (diagnostics.ts) — модератору полезно видеть, с какого устройства
    // прислали пак, даже когда автор не оставил ссылки на источник.
    // «система» — из UA-CH («Android 13.0.0»), точнее замороженной строки
    // user-agent; пусто там, где UA-CH нет (Safari, Firefox).
    userAgent: navigator.userAgent,
    system: await systemLabel(),
  });

  onStage({ kind: "uploading", percent: 0 });
  await putWithProgress(String(signed.uploadUrl), zipBlob, (percent) =>
    onStage({ kind: "uploading", percent })
  );

  // Письмо шлётся только после того, как архив реально лёг в бакет:
  // ссылка на пустоту в Telegram хуже, чем отсутствие письма.
  await post("/publish/done", { token: String(signed.token), icon: await iconDataUrl(pack) });
}
