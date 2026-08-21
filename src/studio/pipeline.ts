/** Оркестрация двух режимов студии: от аудиобуфера до готового списка клипов в state. */
import { audioBufferToWav } from "../audio/wav";
import { detectSpeech } from "./vad";
import { setSpeechRanges } from "./lanes";
import { cutClips } from "./cut";
import { captureThumbnails, channelsToBuffer, resampleTo44100 } from "./media";
import { separateVoiceBackground } from "./separate";
import { newClipId, type StudioState } from "./state";
import { logTimingSummary, timed } from "./timing";
import type { MsgKey } from "../i18n";

export type ProgressFn = (labelKey: MsgKey, ratio: number, vars?: Record<string, string | number>) => void;

export async function runVoiceoverPipeline(state: StudioState, video: HTMLVideoElement, progress: ProgressFn): Promise<void> {
  const buffer = state.audioBuffer;
  if (!buffer) throw new Error("studioBadVideo");

  progress("studioStageCut", 0.3);
  const intervals = detectSpeech(buffer);
  setSpeechRanges(intervals);
  const cut = await timed("нарезка (VAD)", () => cutClips(intervals));
  if (cut.length === 0) throw new Error("studioNoClips");

  await timed("запись дорожек", () => {
    state.originalTrack = audioBufferToWav(buffer);
    state.backingTrack = null;
  });

  progress("studioStageCut", 0.7);
  const thumbs = await timed("кадры-превью", () =>
    captureThumbnails(video, cut, (r) => progress("studioStageFrames", 0.7 + 0.3 * r))
  );

  state.clips = cut.map((c, i) => ({
    id: newClipId(),
    start: c.start,
    end: c.end,
    text: "",
    character: "",
    thumb: thumbs[i],
  }));
  state.characters = [];
  progress("studioStageCut", 1);
  logTimingSummary("Закадр", buffer.duration);
}

export async function runDubPipeline(state: StudioState, video: HTMLVideoElement, progress: ProgressFn): Promise<void> {
  const buffer = state.audioBuffer;
  if (!buffer) throw new Error("studioBadVideo");

  progress("studioStageSeparate", 0.05);
  const resampled = await timed("ресемплинг 44100", () => resampleTo44100(buffer));
  const channels = Array.from({ length: resampled.numberOfChannels }, (_, c) => resampled.getChannelData(c));
  const { vocals, backing } = await timed("разделение (spleeter)", () =>
    separateVoiceBackground(channels, 44100, (_stage, ratio) => {
      progress("studioStageSeparate", 0.05 + 0.35 * ratio);
    })
  );

  const vocalsBuffer = channelsToBuffer(vocals, 44100);
  state.vocalsBuffer = vocalsBuffer;
  progress("studioStageTracks", 0.42);
  await timed("запись дорожек", () => {
    state.backingTrack = audioBufferToWav(channelsToBuffer(backing, 44100));
    state.originalTrack = audioBufferToWav(buffer);
  });

  progress("studioStageCut", 0.5);
  // Границы реплик — по паузам в звуке. На изолированном голосе VAD работает
  // точнее, чем на полном миксе в «Закадре»: музыка больше не выдаёт себя за
  // речь. Текст реплик игрок пишет сам в редакторе — распознавание речи из
  // студии убрано целиком (docs/STUDIO_WEB_PLAN.md, «Фаза 3»).
  const intervals = detectSpeech(vocalsBuffer);
  setSpeechRanges(intervals);
  const cut = await timed("нарезка (VAD)", () => cutClips(intervals));
  if (cut.length === 0) throw new Error("studioNoClips");
  const thumbs = await timed("кадры-превью", () =>
    captureThumbnails(video, cut, (r) => progress("studioStageFrames", 0.55 + 0.45 * r))
  );

  state.clips = cut.map((c, i) => ({
    id: newClipId(),
    start: c.start,
    end: c.end,
    text: "",
    character: "",
    thumb: thumbs[i],
  }));
  state.characters = [];
  progress("studioStageCut", 1);
  logTimingSummary("Дубляж", buffer.duration);
}
