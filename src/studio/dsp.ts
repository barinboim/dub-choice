/**
 * STFT/iSTFT под spleeter: n_fft=4096, hop=1024, окно Ханна. Порт
 * spike/proto/dsp.mjs (проверен в node против эталонного фона demucs,
 * см. docs/STUDIO_WEB_PLAN.md, «Результаты фазы 0») — логика не меняется,
 * только типы.
 *
 * Модель ест [2, splits, 512, 1024] — только первые 1024 бина из 2049,
 * то есть всё выше ~11 кГц она не видит вовсе. Это не наша оплошность,
 * а устройство spleeter; что с этим делать — решается на уровне маски.
 */
export const N_FFT = 4096;
export const HOP = 1024;
/** Сколько бинов видит модель. */
export const BINS = 1024;
/** Фреймов в сегменте. */
export const SEG = 512;

/** Итеративный radix-2 FFT на месте. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + len / 2];
        const bi = im[i + k + len / 2];
        const tr = br * cr - bi * ci;
        const ti = br * ci + bi * cr;
        re[i + k] = ar + tr;
        im[i + k] = ai + ti;
        re[i + k + len / 2] = ar - tr;
        im[i + k + len / 2] = ai - ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export function ifft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
}

/** Периодическое окно Ханна — такое же, как в tf.signal.hann_window. */
export function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

export function numFrames(len: number): number {
  return len < N_FFT ? 0 : 1 + Math.floor((len - N_FFT) / HOP);
}

export interface Spectrum {
  re: Float32Array;
  im: Float32Array;
  frames: number;
  half: number;
}

/** STFT одного канала. Возвращает полные комплексные бины (2049 на фрейм). */
export function stft(x: Float32Array, win: Float32Array): Spectrum {
  const frames = numFrames(x.length);
  const half = N_FFT / 2 + 1;
  const re = new Float32Array(frames * half);
  const im = new Float32Array(frames * half);
  const br = new Float32Array(N_FFT);
  const bi = new Float32Array(N_FFT);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N_FFT; i++) {
      br[i] = x[off + i] * win[i];
      bi[i] = 0;
    }
    fft(br, bi);
    re.set(br.subarray(0, half), f * half);
    im.set(bi.subarray(0, half), f * half);
  }
  return { re, im, frames, half };
}

/** iSTFT с overlap-add и нормировкой по сумме квадратов окна (WOLA). */
export function istft(
  re: Float32Array,
  im: Float32Array,
  frames: number,
  half: number,
  win: Float32Array,
  outLen: number
): Float32Array {
  const out = new Float32Array(outLen);
  const norm = new Float32Array(outLen);
  const br = new Float32Array(N_FFT);
  const bi = new Float32Array(N_FFT);
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < half; k++) {
      br[k] = re[f * half + k];
      bi[k] = im[f * half + k];
    }
    for (let k = half; k < N_FFT; k++) {
      br[k] = re[f * half + (N_FFT - k)];
      bi[k] = -im[f * half + (N_FFT - k)];
    }
    ifft(br, bi);
    const off = f * HOP;
    for (let i = 0; i < N_FFT && off + i < outLen; i++) {
      out[off + i] += br[i] * win[i];
      norm[off + i] += win[i] * win[i];
    }
  }
  for (let i = 0; i < outLen; i++) if (norm[i] > 1e-8) out[i] /= norm[i];
  return out;
}
