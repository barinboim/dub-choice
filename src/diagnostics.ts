/**
 * Технический отчёт, который едет вместе с письмом игрока.
 *
 * Зачем отдельно от аналитики: GoatCounter у нас анонимен и без
 * дедупликации (осознанный отказ от cookie-трекинга, см.
 * docs/ANALYTICS.md), поэтому сличить письмо игрока с его строкой в
 * статистике невозможно в принципе. Аналитика отвечает на вопрос
 * «сколько», отчёт — на вопрос «почему у этого человека»; связать их
 * может только сам отчёт, неся контекст внутри себя.
 *
 * Спрашивать эти данные у человека нельзя: браузер, кодек и версию он
 * назовёт неточно или бросит анкету. Поэтому собираем сами — и показываем
 * ему целиком, до отправки, своими глазами.
 *
 * Имени файла здесь нет намеренно (см. probe.ts).
 */
import { journeyLines, sessionSeconds } from "./journey";
import { lang } from "./i18n";
import type { VideoProbe } from "./studio/probe";

export interface DiagnosticContext {
  /** Режим студии; в игре не заполняется. */
  mode?: "voiceover" | "dub" | null;
  /** Подпись этапа, на котором всё встало. */
  stage?: string;
  error?: string;
  /** Разбор самого файла — контейнер, кодеки (см. studio/probe.ts). */
  video?: VideoProbe | null;
  videoSeconds?: number;
  videoWidth?: number;
  videoHeight?: number;
  audioRate?: number;
  audioChannels?: number;
  clips?: number;
  characters?: number;
  /** Времена этапов пайплайна (studio/timing.ts). */
  timings?: { name: string; sec: number }[];
  /** Свободные пометки страницы игры: выбранный пак, режим микса. */
  extra?: Record<string, string | number | boolean | null | undefined>;
}

export async function buildReport(ctx: DiagnosticContext): Promise<string> {
  const out: string[] = [`--- dub choice · отчёт ---`];
  out.push(
    `страница: ${location.pathname}${location.search}`,
    `время: ${new Date().toISOString()} (${timezone()})`,
    `язык интерфейса: ${lang()}`,
    `в сеансе: ${Math.round(sessionSeconds())} с`
  );

  const what = section("что случилось", [
    ctx.error ? `ошибка: ${ctx.error}` : "",
    ctx.stage ? `шаг: ${ctx.stage}` : "",
    ctx.mode ? `режим: ${ctx.mode === "dub" ? "Дубляж" : "Закадр"}` : "",
  ]);
  if (what) out.push(what);

  out.push(section("видео", videoLines(ctx)) ?? "");

  const pack = section("пак", [
    ctx.clips === undefined ? "" : `реплик: ${ctx.clips}`,
    ctx.characters === undefined ? "" : `персонажей: ${ctx.characters}`,
    ...Object.entries(ctx.extra ?? {}).map(([k, v]) => (v === undefined || v === null ? "" : `${k}: ${v}`)),
  ]);
  if (pack) out.push(pack);

  if (ctx.timings?.length) {
    out.push(section("этапы", ctx.timings.map((t) => `${t.name}: ${t.sec.toFixed(1)} с`)) ?? "");
  }

  out.push((await section2("устройство", environmentLines())) ?? "");
  out.push(section("кодеки браузера", codecLines()) ?? "");

  const steps = journeyLines();
  if (steps.length > 0) out.push(section("шаги игрока", steps) ?? "");

  return out.filter(Boolean).join("\n");
}

function section(title: string, lines: (string | undefined)[]): string | null {
  const body = lines.filter((l): l is string => Boolean(l));
  if (body.length === 0) return null;
  return `\n[${title}]\n${body.join("\n")}`;
}

async function section2(title: string, lines: Promise<(string | undefined)[]>): Promise<string | null> {
  return section(title, await lines);
}

function videoLines(ctx: DiagnosticContext): (string | undefined)[] {
  const p = ctx.video;
  const lines: (string | undefined)[] = [];
  if (p) {
    lines.push(
      `контейнер: ${p.container}`,
      `расширение: .${p.ext || "?"}, mime: ${p.mime}`,
      `кодеки: ${p.codecs.length > 0 ? p.codecs.join(", ") : "не разобрал"}`,
      `звук в контейнере: ${p.hasAudio === null ? "?" : p.hasAudio ? "есть" : "нет"}`,
      `размер: ${(p.bytes / 1024 / 1024).toFixed(1)} МБ`
    );
  }
  if (ctx.videoSeconds) lines.push(`длительность: ${ctx.videoSeconds.toFixed(1)} с`);
  if (ctx.videoWidth && ctx.videoHeight) lines.push(`кадр: ${ctx.videoWidth}×${ctx.videoHeight}`);
  if (p?.bytes && ctx.videoSeconds) {
    lines.push(`битрейт (прибл.): ${((p.bytes * 8) / ctx.videoSeconds / 1e6).toFixed(1)} Мбит/с`);
  }
  if (ctx.audioRate) lines.push(`звук: ${ctx.audioRate} Гц, каналов ${ctx.audioChannels ?? "?"}`);
  return lines;
}

type NavigatorWithUaCh = Navigator & {
  userAgentData?: {
    getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>>;
    brands?: { brand: string; version: string }[];
    mobile?: boolean;
  };
};

/**
 * «Android 13.0.0» / «Windows 10.0.0» — UA-CH точнее строки user-agent,
 * которая в Chrome давно заморожена и врёт о версии ОС. Пусто там, где
 * UA-CH нет вовсе (Safari, Firefox) — там платформа видна из самого
 * user-agent. Вынесено отдельно от полного отчёта — эта же строка едет
 * в письмо о публикации пака (`pack/publish.ts`), без остального отчёта.
 */
export async function systemLabel(): Promise<string> {
  const nav = navigator as NavigatorWithUaCh;
  try {
    const hints = await nav.userAgentData?.getHighEntropyValues(["platform", "platformVersion"]);
    if (!hints) return "";
    return `${hints.platform ?? ""} ${hints.platformVersion ?? ""}`.trim();
  } catch {
    return "";
  }
}

async function environmentLines(): Promise<(string | undefined)[]> {
  const nav = navigator as NavigatorWithUaCh & {
    deviceMemory?: number;
    connection?: { effectiveType?: string; downlink?: number; saveData?: boolean };
  };

  const lines: (string | undefined)[] = [`user-agent: ${navigator.userAgent}`];

  // UA-CH точнее строки user-agent: в Chrome она давно заморожена и врёт о
  // версии ОС, а по версии ОС видно, есть ли на устройстве аппаратный HEVC.
  try {
    const hints = await nav.userAgentData?.getHighEntropyValues([
      "platform",
      "platformVersion",
      "architecture",
      "bitness",
      "model",
      "uaFullVersion",
    ]);
    if (hints) {
      const brands = nav.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`).join(", ");
      lines.push(
        `браузер: ${brands ?? "?"} (${hints.uaFullVersion ?? "?"})`,
        `система: ${hints.platform ?? "?"} ${hints.platformVersion ?? ""}`.trim(),
        `архитектура: ${hints.architecture ?? "?"}${hints.bitness ? `, ${hints.bitness} бит` : ""}`,
        hints.model ? `устройство: ${hints.model}` : "",
        `мобильный: ${nav.userAgentData?.mobile ? "да" : "нет"}`
      );
    }
  } catch {
    // UA-CH есть не везде (Safari, Firefox) — не беда, user-agent выше остаётся.
  }

  lines.push(
    `ядра: ${navigator.hardwareConcurrency ?? "?"}, память (прибл.): ${nav.deviceMemory ?? "?"} ГБ`,
    `экран: ${screen.width}×${screen.height} @${window.devicePixelRatio || 1}x, окно ${window.innerWidth}×${window.innerHeight}`,
    `язык системы: ${navigator.language} (${navigator.languages?.slice(0, 3).join(", ")})`
  );

  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  if (heap) {
    lines.push(
      `куча JS: ${(heap.usedJSHeapSize / 1024 / 1024).toFixed(0)} из ${(heap.jsHeapSizeLimit / 1024 / 1024).toFixed(0)} МБ`
    );
  }

  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) {
      lines.push(`хранилище: ${fmtMB(est.usage ?? 0)} из ${fmtMB(est.quota)}`);
    }
  } catch {
    // Приватный режим Safari отказывает — не повод падать.
  }

  if (nav.connection) {
    lines.push(
      `сеть: ${nav.connection.effectiveType ?? "?"}, ~${nav.connection.downlink ?? "?"} Мбит/с${nav.connection.saveData ? ", экономия трафика" : ""}`
    );
  }

  // Разделение голоса идёт в wasm: без SIMD оно ползёт, а без
  // SharedArrayBuffer не запускается в несколько потоков вовсе.
  lines.push(
    `wasm: simd ${yesNo(hasSimd())}, threads ${yesNo(typeof SharedArrayBuffer !== "undefined")}, isolated ${yesNo(crossOriginIsolated)}`
  );
  return lines;
}

function fmtMB(bytes: number): string {
  return bytes > 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} ГБ` : `${Math.round(bytes / 1024 / 1024)} МБ`;
}

function yesNo(v: boolean): string {
  return v ? "да" : "нет";
}

/** Минимальный модуль с инструкцией v128 — валидируется только с SIMD. */
function hasSimd(): boolean {
  try {
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
      ])
    );
  } catch {
    return false;
  }
}

/**
 * Что этот браузер вообще берётся играть. Главный вопрос беты — HEVC:
 * Safari его открывает, Chrome и Firefox нет, и со стороны это выглядит
 * как «студия не работает».
 */
function codecLines(): string[] {
  const v = document.createElement("video");
  const probes: [string, string][] = [
    ["H.264", 'video/mp4; codecs="avc1.42E01E"'],
    ["H.264 High", 'video/mp4; codecs="avc1.640028"'],
    ["HEVC", 'video/mp4; codecs="hvc1.1.6.L93.B0"'],
    ["VP9", 'video/webm; codecs="vp9"'],
    ["AV1", 'video/mp4; codecs="av01.0.05M.08"'],
    ["AAC", 'audio/mp4; codecs="mp4a.40.2"'],
    ["Opus", 'audio/webm; codecs="opus"'],
  ];
  return probes.map(([name, mime]) => `${name}: ${v.canPlayType(mime) || "нет"}`);
}

function timezone(): string {
  const offset = -new Date().getTimezoneOffset() / 60;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "?";
  return `${zone}, UTC${offset >= 0 ? "+" : ""}${offset}`;
}
