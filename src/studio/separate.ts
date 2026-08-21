/**
 * Разделение вокал/фон: spleeter-2stems в ONNX (не demucs — см.
 * docs/STUDIO_WEB_PLAN.md, «Результаты фазы 0»). Порт логики
 * spike/main.ts (там же измерено: потоки не дают выигрыша, поэтому
 * прогон идёт прямо на основном потоке, без воркера и без COOP/COEP).
 */
import * as ort from "onnxruntime-web";
import { BINS, SEG, hann, istft, numFrames, stft } from "./dsp";
import { PACKS_BASE } from "../pack/preloaded";

/**
 * Ни веса модели (78 МБ), ни рантайм ort (десятки МБ wasm) не лежат ни в
 * git, ни в бандле: они едут из R2 — тем же способом, что и dub-паки, и по
 * той же причине (egress бесплатный, лимита в 100 МБ на файл нет,
 * см. CLAUDE.md, «Грабли»). В деве их отдаёт middleware из vite.config.ts:
 * ort — прямо из node_modules, веса — из папки studio-models/ (тоже не в git).
 */
ort.env.wasm.wasmPaths = import.meta.env.PROD ? `${PACKS_BASE}ort/` : "/ort/";

const EPS = 1e-10;
const MODELS_BASE = import.meta.env.PROD
  ? `${PACKS_BASE}studio-models/separate/`
  : "/studio-models/separate/";

/**
 * Веса берём сами и кладём в Cache Storage, а не полагаемся на HTTP-кэш:
 * 39 МБ на модель, две модели, и повторный заход в «Дубляж» не должен
 * стоить игроку тех же 78 МБ. Имя кэша версионированное — обновить модель
 * можно сменой `-v1`, без разговоров об инвалидации.
 */
const MODEL_CACHE = "studio-models-v1";

/** Сколько байт скачано и сколько всего — для честной полоски. */
export interface DownloadProgress {
  loadedBytes: number;
  totalBytes: number;
  /** Какая из моделей едет сейчас (1 или 2) — их две. */
  index: number;
  of: number;
}

async function modelBytes(
  url: string,
  index: number,
  of: number,
  onDownload?: (p: DownloadProgress) => void
): Promise<ArrayBuffer> {
  try {
    const cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(url);
    // Уже скачано — говорим об этом полоской, а не тишиной: иначе мгновенный
    // проход выглядит как пропущенный шаг.
    if (hit) {
      const bytes = await hit.arrayBuffer();
      onDownload?.({ loadedBytes: bytes.byteLength, totalBytes: bytes.byteLength, index, of });
      return bytes;
    }
    const bytes = await download(url, index, of, onDownload);
    await cache.put(url, new Response(bytes.slice(0)));
    return bytes;
  } catch (err) {
    // Cache Storage бывает недоступен (приватный режим Safari, отказ в
    // квоте) — это повод скачать заново, а не отменять разделение.
    console.warn("[studio] кэш моделей недоступен:", err);
    return download(url, index, of, onDownload);
  }
}

/**
 * Качаем потоком, а не одним `res.arrayBuffer()`, только ради полоски:
 * 39 МБ на средней линии — это полминуты, и всё это время экран замирал на
 * одной цифре. Молчание тут читается как «зависло», а не как «идёт работа».
 */
async function download(
  url: string,
  index: number,
  of: number,
  onDownload?: (p: DownloadProgress) => void
): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`модель не скачалась: HTTP ${res.status}`);
  const totalBytes = Number(res.headers.get("Content-Length")) || 0;
  if (!res.body) return res.arrayBuffer();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loadedBytes += value.byteLength;
    onDownload?.({ loadedBytes, totalBytes: totalBytes || loadedBytes, index, of });
  }
  const out = new Uint8Array(loadedBytes);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}

export interface SeparationResult {
  vocals: Float32Array[];
  backing: Float32Array[];
}

export type SeparationStage = "download" | "engine" | "vocals" | "accompaniment" | "mix";

/** spleeter обучен на 44100 Гц стерео — вызывающая сторона должна ресемплировать заранее. */
export async function separateVoiceBackground(
  channels: Float32Array[],
  rate: number,
  onProgress?: (stage: SeparationStage, ratio: number, download?: DownloadProgress) => void
): Promise<SeparationResult> {
  if (rate !== 44100) throw new Error(`spleeter ждёт 44100 Гц, на входе ${rate}`);
  const stereo = channels.length >= 2 ? channels.slice(0, 2) : [channels[0], channels[0]];
  const len = stereo[0].length;
  const win = hann(4096);
  const frames = numFrames(len);
  const splits = Math.max(1, Math.ceil(frames / SEG));
  const padded = splits * SEG;
  const half = 4096 / 2 + 1;

  const spec = stereo.map((x) => stft(x, win));

  const x = new Float32Array(2 * padded * BINS);
  for (let c = 0; c < 2; c++)
    for (let t = 0; t < frames; t++)
      for (let f = 0; f < BINS; f++) {
        const i = t * half + f;
        x[(c * padded + t) * BINS + f] = Math.hypot(spec[c].re[i], spec[c].im[i]);
      }

  const opts: ort.InferenceSession.SessionOptions = { executionProviders: ["wasm"] };
  const outs: Record<"vocals" | "accompaniment", Float32Array> = { vocals: new Float32Array(0), accompaniment: new Float32Array(0) };
  const stems = ["vocals", "accompaniment"] as const;
  for (let s = 0; s < stems.length; s++) {
    const stem = stems[s];
    // Первая половина доли каждой модели — её закачка, вторая — сам счёт.
    const bytes = await modelBytes(`${MODELS_BASE}${stem}.onnx`, s + 1, stems.length, (p) => {
      const own = p.totalBytes > 0 ? p.loadedBytes / p.totalBytes : 0;
      onProgress?.("download", (s + own * 0.5) / stems.length, p);
    });
    // Первый `create` тянет ещё и wasm самого ort (13 МБ) — молча, изнутри
    // библиотеки, без всякого прогресса. Подписываем хотя бы шаг, иначе
    // полоска опять замирает без объяснений.
    if (s === 0) onProgress?.("engine", (s + 0.5) / stems.length);
    const sess = await ort.InferenceSession.create(bytes, opts);
    onProgress?.(stem, (s + 0.5) / stems.length);
    const y = await sess.run({ x: new ort.Tensor("float32", x, [2, splits, SEG, BINS]) });
    outs[stem] = y.y.data as Float32Array;
    await sess.release();
  }
  onProgress?.("mix", 1);

  const result: SeparationResult = { vocals: [], backing: [] };
  for (const [name, own, other] of [
    ["vocals", outs.vocals, outs.accompaniment],
    ["backing", outs.accompaniment, outs.vocals],
  ] as const) {
    const outCh: Float32Array[] = [];
    for (let c = 0; c < 2; c++) {
      const re = new Float32Array(frames * half);
      const im = new Float32Array(frames * half);
      for (let t = 0; t < frames; t++)
        for (let f = 0; f < half; f++) {
          const i = t * half + f;
          let m = 0;
          if (f < BINS) {
            const j = (c * padded + t) * BINS + f;
            const a = own[j] * own[j];
            const b = other[j] * other[j];
            m = (a + EPS / 2) / (a + b + EPS);
          }
          re[i] = spec[c].re[i] * m;
          im[i] = spec[c].im[i] * m;
        }
      outCh.push(istft(re, im, frames, half, win, len));
    }
    result[name === "vocals" ? "vocals" : "backing"] = outCh;
  }
  return result;
}
