/**
 * Приём видео на входе студии: файл (выбор/drag-drop) или ссылка на
 * YouTube. Скачивание с YouTube в браузере невозможно (docs/
 * STUDIO_WEB_PLAN.md, «YouTube») — вместо этого oEmbed достаёт метаданные
 * бесплатно, а дальше игрок сам скачивает видео на стороннем сайте и
 * перетаскивает файл сюда же.
 */
import { PACKS_BASE } from "../pack/preloaded";

export interface OEmbedInfo {
  title: string;
  author: string;
  thumbnailUrl: string;
}

const YOUTUBE_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,})/i;

/** Ссылка похожа на адрес видео с любого сервиса, не только с YouTube. */
const VIDEO_LINK_RE = /^https?:\/\/[^\s]+$/i;

export function looksLikeVideoLink(url: string): boolean {
  return VIDEO_LINK_RE.test(url.trim());
}

/** Достаёт id видео из ссылки на YouTube — любой формы. null, если это не YouTube. */
export function extractYoutubeId(url: string): string | null {
  const m = YOUTUBE_RE.exec(url.trim());
  return m ? m[1] : null;
}

/**
 * Название, автора и превью видео — без скачивания самого видео.
 * `oembed` отдаёт CORS под наш origin при наличии заголовка Origin
 * (проверено вручную), так что запрос идёт прямо из браузера.
 */
export async function fetchOEmbed(videoId: string): Promise<OEmbedInfo | null> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`);
    if (!res.ok) return null;
    const data = (await res.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
    return {
      title: data.title ?? "",
      author: data.author_name ?? "",
      thumbnailUrl: data.thumbnail_url ?? "",
    };
  } catch {
    return null;
  }
}

export interface YoutubeDownloader {
  name: string;
  host: string;
  /**
   * Шаблон ссылки: `{url}` — полный адрес видео, `{id}` — его идентификатор.
   * Без шаблона работает старый приём с подменой домена youtube.com.
   */
  template?: string;
}

/**
 * Встроенный вариант — cobalt (imputnet/cobalt): открытый исходник под
 * AGPL-3.0, ~39 тысяч звёзд на GitHub, без рекламы. Выбран вместо savefrom
 * именно за репутацию: игрока мы уводим на сторонний сайт и отвечаем за то,
 * куда именно. Ссылку он принимает в хеше — `cobalt.tools/#<адрес>`.
 *
 * Список расширяется без пересборки сайта: файл studio-downloaders.json в том
 * же бакете R2, что и manifest.json паков — если сервис ляжет или появится
 * лучше, адрес меняется без передеплоя.
 */
const FALLBACK_DOWNLOADERS: YoutubeDownloader[] = [
  { name: "cobalt", host: "cobalt.tools", template: "https://cobalt.tools/#{url}" },
];

/**
 * Для YouTube даём НЕСКОЛЬКО загрузчиков, а не один.
 *
 * Причина простая: надёжного одного не существует. Официальный cobalt.tools
 * YouTube больше не отдаёт (площадка режет его адреса), публичные инстансы
 * Piped регулярно лежат (проверено: фронт отвечает, а API — 502), а
 * community-инстансы cobalt закрывают API токеном, так что проверить их
 * работоспособность снаружи невозможно — можно лишь убедиться, что сайт жив.
 * Поэтому игроку показывается список: не сработал первый — есть второй.
 *
 * Порядок — по тому, чему больше доверия: cobalt (открытый исходник, без
 * рекламы) → Piped (открытый исходник) → SaveFrom (с рекламой, но работает
 * дольше всех).
 */
const YOUTUBE_DOWNLOADERS: YoutubeDownloader[] = [
  { name: "cobalt", host: "cobalt.meowing.de", template: "https://cobalt.meowing.de/#{url}" },
  { name: "Piped", host: "piped.video", template: "https://piped.video/watch?v={id}" },
  { name: "SaveFrom", host: "ssyoutube.com" },
];

/** Для YouTube — свой список, для всего прочего хватает cobalt.tools. */
export function downloadersFor(url: string, list: YoutubeDownloader[]): YoutubeDownloader[] {
  return extractYoutubeId(url) ? YOUTUBE_DOWNLOADERS : list.slice(0, 1);
}

/**
 * Список из R2. Массив — это загрузчики «для всего остального»; объект
 * `{ youtube: [...], other: [...] }` позволяет заменить и ютубовский список,
 * не пересобирая сайт: сервисы мрут чаще, чем мы деплоим.
 */
export async function loadDownloaders(): Promise<YoutubeDownloader[]> {
  try {
    const res = await fetch(`${PACKS_BASE}studio-downloaders.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as YoutubeDownloader[] | { youtube?: YoutubeDownloader[]; other?: YoutubeDownloader[] };
    if (Array.isArray(data)) {
      if (data.length > 0) return data;
    } else {
      if (Array.isArray(data.youtube) && data.youtube.length > 0) {
        YOUTUBE_DOWNLOADERS.splice(0, YOUTUBE_DOWNLOADERS.length, ...data.youtube);
      }
      if (Array.isArray(data.other) && data.other.length > 0) return data.other;
    }
  } catch {
    // Поле в R2 ещё не заведено (или недоступно) — работаем со встроенным списком.
  }
  return FALLBACK_DOWNLOADERS;
}

/** `url` — то, что ввёл игрок; `videoId` есть только для YouTube. */
export function downloaderUrl(d: YoutubeDownloader, url: string, videoId: string | null): string {
  if (d.template) {
    return d.template.replace("{url}", encodeURI(url)).replace("{id}", videoId ?? "");
  }
  return videoId ? `https://${d.host}/watch?v=${videoId}` : `https://${d.host}/`;
}

/** Видео крупнее этого предупреждает: такой пак не откроется на телефоне. */
export const BIG_FILE_WARN_BYTES = 300 * 1024 * 1024;

const VIDEO_TYPE_RE = /^video\//;

/**
 * H.265/HEVC не отвергаем: Safari (в том числе на телефоне) играет такие
 * файлы штатно, и запрещать их из-за Chrome неправильно. Если браузер не
 * потянет — об этом скажет отдельное сообщение (studioNoCodec).
 */
export function canPlayHevc(): boolean {
  const probe = document.createElement("video");
  return probe.canPlayType('video/mp4; codecs="hvc1"') !== "" ||
    probe.canPlayType('video/mp4; codecs="hev1"') !== "";
}

export function looksLikeVideo(file: File): boolean {
  return VIDEO_TYPE_RE.test(file.type) || /\.(mp4|webm|mov|m4v|hevc|h265)$/i.test(file.name);
}
