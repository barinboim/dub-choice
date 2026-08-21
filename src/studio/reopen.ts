/**
 * Готовый DubPack → состояние редактора: пак, собранный раньше (или чужой
 * ZIP), открывается на таймлайне и пересобирается заново.
 *
 * Обратное преобразование неточно по одной причине: пак хранит начало
 * реплики (`dub_timestamps`), но не её конец — концом служит длина
 * аудиофайла реплики. Поэтому конец восстанавливается замером самого
 * аудио (`blobDuration`), а не выдумывается.
 */
import { audioContext, blobDuration } from "../audio/context";
import type { DubPack } from "../pack/types";
import { newClipId, type StudioState } from "./state";

export async function packToState(pack: DubPack, state: StudioState): Promise<void> {
  state.packTitle = pack.title;
  state.packAuthor = pack.authors[0] ?? "";
  state.videoFile = new File([pack.video], "dub_video.mp4", { type: pack.video.type || "video/mp4" });
  state.videoUrl = URL.createObjectURL(state.videoFile);
  state.backingTrack = pack.backingTrack;
  state.originalTrack = pack.originalTrack;
  state.vocalsBuffer = null;
  state.mode = pack.forcedMix === "voiceover" ? "voiceover" : "dub";

  const clips = [];
  for (const clip of pack.clips) {
    const start = clip.timestamps[0] ?? 0;
    const length = await blobDuration(clip.audio).catch(() => 0);
    clips.push({
      id: newClipId(),
      start,
      end: start + (length > 0 ? length : 1),
      text: clip.caption,
      character: clip.characters[0] ?? "",
      thumb: clip.image,
    });
  }
  state.clips = clips.sort((a, b) => a.start - b.start);

  // Персонажи — в порядке появления, как в packCharacters() у игры.
  const seen: string[] = [];
  for (const clip of state.clips) {
    if (clip.character && !seen.includes(clip.character)) seen.push(clip.character);
  }
  state.characters = seen;
}

/**
 * Звук для редактора берётся из дорожек пака, а не из видео: наш пайплайн
 * собирает `dub_video.mp4` **без аудиодорожки** (docs/DUBPACK_BUILD.md), и
 * `decodeAudioData` на нём падает. Раньше это выглядело как «не удалось
 * прочитать видео» — хотя видео исправно, в нём просто нет звука.
 */
export async function decodePackAudio(pack: DubPack): Promise<AudioBuffer> {
  const sources: Blob[] = [];
  if (pack.originalTrack) sources.push(pack.originalTrack);
  if (pack.backingTrack) sources.push(pack.backingTrack);
  sources.push(pack.video);
  let lastError: unknown = null;
  for (const blob of sources) {
    try {
      return await audioContext().decodeAudioData(await blob.arrayBuffer());
    } catch (err) {
      lastError = err;
    }
  }
  console.error(lastError);
  throw new Error("studioBadVideo");
}
