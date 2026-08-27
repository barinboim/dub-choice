let ctx: AudioContext | null = null;

/** Единый AudioContext приложения (создаётся лениво, по жесту пользователя). */
export function audioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/**
 * Для баг-репортов: «suspended» контекст (например, если resume() из
 * audioContext() ещё не долетел к моменту жалобы) — частая причина тишины
 * без единой ошибки в консоли.
 */
export function audioContextStatus(): { state: AudioContextState; sampleRate: number } | null {
  return ctx ? { state: ctx.state, sampleRate: ctx.sampleRate } : null;
}

/**
 * Декодирует аудио-Blob в AudioBuffer.
 * Основной путь — decodeAudioData (Chrome/Firefox понимают wav/mp3/ogg).
 * Если браузер не осилил (например, ogg-vorbis в Safari) — wasm-фолбэк.
 */
export async function decodeAudio(blob: Blob): Promise<AudioBuffer> {
  const bytes = await blob.arrayBuffer();
  try {
    return await audioContext().decodeAudioData(bytes.slice(0));
  } catch (err) {
    const viaWasm = await decodeOggVorbis(new Uint8Array(bytes)).catch(() => null);
    if (viaWasm) return viaWasm;
    throw err;
  }
}

/**
 * Длительность аудио-Blob без полного decodeAudioData: читаем только
 * метаданные через <audio>. Нужна для суммарной длины реплик на карточке
 * пака — гонять decodeAudioData по всем клипам ради одного числа дорого и
 * задвоило бы работу, которую и так делает decodeAudio по ходу игры.
 */
export function blobDuration(blob: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", () => {
      URL.revokeObjectURL(url);
      resolve(audio.duration);
    });
    audio.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read audio metadata"));
    });
    audio.src = url;
  });
}

/** Фолбэк-декодер OGG Vorbis на WebAssembly (нужен только Safari). */
async function decodeOggVorbis(bytes: Uint8Array): Promise<AudioBuffer | null> {
  const { OggVorbisDecoder } = await import("@wasm-audio-decoders/ogg-vorbis");
  const decoder = new OggVorbisDecoder();
  try {
    await decoder.ready;
    const { channelData, samplesDecoded, sampleRate } = await decoder.decodeFile(bytes);
    if (!samplesDecoded) return null;
    const buffer = audioContext().createBuffer(channelData.length, samplesDecoded, sampleRate);
    channelData.forEach((data, ch) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, ch));
    return buffer;
  } finally {
    decoder.free();
  }
}
