/** Собранный в студии DubPack: в память для «Сыграть сейчас», в ZIP для скачивания. */
import { audioBufferToWav } from "../audio/wav";
import { downloadPackZip } from "../pack/zip";
import { stashPackForGame } from "../pack/handoff";
import type { DubClip, DubPack } from "../pack/types";
import type { StudioState } from "./state";

function sliceAudioBuffer(buffer: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const rate = buffer.sampleRate;
  const startFrame = Math.max(0, Math.floor(startSec * rate));
  const endFrame = Math.min(buffer.length, Math.ceil(endSec * rate));
  const len = Math.max(1, endFrame - startFrame);
  const out = new AudioBuffer({ length: len, numberOfChannels: buffer.numberOfChannels, sampleRate: rate });
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    out.copyToChannel(buffer.getChannelData(ch).subarray(startFrame, startFrame + len), ch);
  }
  return out;
}

function slugChar(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "") || "line";
}

export function buildPack(state: StudioState): DubPack {
  if (!state.videoFile || !state.audioBuffer) throw new Error("studioBadVideo");
  if (state.clips.length === 0) throw new Error("studioNoClips");
  // «Дубляж» режет реплики из изолированного голоса (честная оценка,
  // game/score.ts); «Закадр» — из общего микса, там оценка и так выключена.
  const voiceSource = state.vocalsBuffer ?? state.audioBuffer;

  const clips: DubClip[] = state.clips.map((clip, i) => ({
    baseName: `${String(i + 1).padStart(2, "0")}_${slugChar(clip.character || "line")}`,
    caption: clip.text,
    captions: {},
    timestamps: [clip.start],
    characters: clip.character ? [clip.character] : [],
    audio: audioBufferToWav(sliceAudioBuffer(voiceSource, clip.start, clip.end)),
    image: clip.thumb,
  }));

  return {
    title: state.packTitle || "Мой дубляж",
    subtitle: "",
    authors: state.packAuthor ? [state.packAuthor] : [],
    icon: clips[0]?.image ?? null,
    video: state.videoFile,
    videoKind: "native",
    backingTrack: state.backingTrack,
    originalTrack: state.originalTrack,
    voiceTracks: [],
    clips,
    lang: "",
    langNames: {},
    translations: [],
    warnings: [],
    scoringOff: state.mode === "voiceover",
    forcedMix: state.mode === "voiceover" ? "voiceover" : null,
  };
}

export async function downloadZip(pack: DubPack): Promise<void> {
  await downloadPackZip(pack);
}

export async function playInGame(pack: DubPack): Promise<void> {
  await stashPackForGame(pack);
  location.href = "index.html";
}
