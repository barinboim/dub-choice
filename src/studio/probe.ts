/**
 * Что за файл нам принесли: контейнер, кодеки, звуковая дорожка.
 *
 * Зачем: «не удалось прочитать видео» без этих строк — тупик. Браузер не
 * рассказывает, что именно он не понял, а игрок не знает слова «HEVC».
 * Читаем начало и конец файла сами: в mp4 `moov` лежит либо в голове (после
 * `faststart`), либо в хвосте, и в нём же — четырёхбуквенные имена кодеков.
 *
 * Имени файла здесь нет намеренно: оно бывает говорящим (кино, фамилии,
 * рабочие проекты), а для разбора хватает расширения, размера и кодека.
 */

export interface VideoProbe {
  ext: string;
  /** file.type — браузер ставит его по расширению, врёт часто. */
  mime: string;
  bytes: number;
  container: string;
  codecs: string[];
  /** Есть ли в контейнере звук. null — не разобрали. */
  hasAudio: boolean | null;
}

/** Голова и хвост: `moov` в mp4 лежит либо там, либо там. */
const EDGE_BYTES = 512 * 1024;

export async function probeVideoFile(file: File): Promise<VideoProbe> {
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? "").toLowerCase();
  const probe: VideoProbe = {
    ext,
    mime: file.type || "—",
    bytes: file.size,
    container: "?",
    codecs: [],
    hasAudio: null,
  };
  try {
    const head = new Uint8Array(await file.slice(0, Math.min(EDGE_BYTES, file.size)).arrayBuffer());
    const tail =
      file.size > EDGE_BYTES
        ? new Uint8Array(await file.slice(file.size - EDGE_BYTES).arrayBuffer())
        : new Uint8Array(0);
    probe.container = detectContainer(head);
    const found = new Set<string>();
    collectCodecs(head, found);
    collectCodecs(tail, found);
    // Видео впереди звука: в отчёте первым делом ищут глазами кодек картинки.
    probe.codecs = [...found].sort((a, b) => Number(isAudio(a)) - Number(isAudio(b)));
    if (probe.codecs.some(isAudio)) probe.hasAudio = true;
    else if (probe.codecs.length > 0) probe.hasAudio = false;
  } catch {
    // Диагностика не имеет права ломать загрузку: не прочиталось — и ладно.
  }
  return probe;
}

/** Одна строка для отчёта: «mp4 (isom), avc1.640028 + mp4a, 42.3 МБ». */
export function describeProbe(p: VideoProbe): string {
  const codecs = p.codecs.length > 0 ? p.codecs.join(" + ") : "не разобрал";
  return `${p.container}, ${codecs}, ${(p.bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function ascii(bytes: Uint8Array, from: number, len: number): string {
  let out = "";
  for (let i = from; i < from + len && i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

function detectContainer(head: Uint8Array): string {
  if (ascii(head, 4, 4) === "ftyp") {
    const brand = ascii(head, 8, 4).trim();
    // `qt  ` — это MOV с камеры/QuickTime, у него бывают дорожки, которых
    // веб-плеер не умеет (ProRes), хотя расширение обещает «видео».
    const kind = brand === "qt" ? "mov" : "mp4";
    return `${kind} (${brand || "?"})`;
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    const doc = ascii(head, 0, 64);
    return doc.includes("webm") ? "webm" : "matroska (mkv)";
  }
  if (ascii(head, 0, 4) === "RIFF") return ascii(head, 8, 4) === "AVI " ? "avi" : "riff";
  if (ascii(head, 0, 4) === "OggS") return "ogg";
  if (ascii(head, 0, 3) === "FLV") return "flv";
  return "не опознан";
}

/**
 * Имена кодеков в mp4/mov — четырёхбуквенные метки внутри `stsd`, в mkv —
 * строки `V_…`/`A_…`. Ищем их простым перебором: точный разбор боксов ради
 * строчки в отчёте не окупается, а ложное совпадение в сжатых данных стоит
 * лишнего слова в письме, не более.
 */
const MP4_VIDEO = ["avc1", "avc3", "hvc1", "hev1", "av01", "vp08", "vp09", "mp4v", "dvh1", "dvhe", "apch", "apcn", "ap4h"];
const MP4_AUDIO = ["mp4a", "ac-3", "ec-3", "Opus", "alac", "fLaC", ".mp3", "sowt", "twos", "lpcm", "in24"];
const MKV_CODECS = [
  "V_VP8",
  "V_VP9",
  "V_AV1",
  "V_MPEG4/ISO/AVC",
  "V_MPEGH/ISO/HEVC",
  "A_OPUS",
  "A_VORBIS",
  "A_AAC",
  "A_MPEG/L3",
  "A_AC3",
  "A_FLAC",
];

function isAudio(codec: string): boolean {
  return MP4_AUDIO.some((a) => codec.startsWith(a)) || MKV_CODECS.filter((c) => c.startsWith("A_")).includes(codec);
}

function collectCodecs(bytes: Uint8Array, out: Set<string>): void {
  if (bytes.length === 0) return;
  const text = ascii(bytes, 0, bytes.length);
  for (const tag of [...MP4_VIDEO, ...MP4_AUDIO]) {
    if (text.includes(tag)) out.add(tag);
  }
  for (const tag of MKV_CODECS) {
    if (text.includes(tag)) out.add(tag);
  }
  // Профиль и уровень H.264 лежат сразу за меткой avcC — по ним видно,
  // например, High 10 bit, который Safari играет, а Chrome нет.
  const avcc = text.indexOf("avcC");
  if (avcc >= 0 && avcc + 8 < bytes.length) {
    const profile = bytes[avcc + 5];
    const compat = bytes[avcc + 6];
    const level = bytes[avcc + 7];
    out.delete("avc1");
    out.add(`avc1.${hex(profile)}${hex(compat)}${hex(level)}`);
  }
  const hvcc = text.indexOf("hvcC");
  if (hvcc >= 0 && hvcc + 8 < bytes.length) {
    out.add(`hevc profile ${bytes[hvcc + 5] & 0x1f}`);
  }
}

function hex(n: number): string {
  return n.toString(16).padStart(2, "0");
}
