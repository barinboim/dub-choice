/**
 * Готовый DubPack → состояние редактора: пак, собранный раньше (или чужой
 * ZIP), открывается на таймлайне и пересобирается заново.
 *
 * Обратное преобразование неточно по одной причине: пак хранит начало
 * реплики (`dub_timestamps`), но не её конец — концом служит длина
 * аудиофайла реплики. Поэтому конец восстанавливается замером самого
 * аудио (`blobDuration`), а не выдумывается.
 */
import { blobDuration, decodeAudio } from "../audio/context";
import type { DubPack } from "../pack/types";
import { newClipId, type StudioState } from "./state";
import { transcodeOgvToNative, type OgvImportProgress } from "./ogv-import";

export async function packToState(
  pack: DubPack,
  state: StudioState,
  onOgvProgress?: OgvImportProgress,
  ogvPreviewVideo?: HTMLVideoElement
): Promise<void> {
  state.packTitle = pack.title;
  state.packAuthor = pack.authors[0] ?? "";
  // Пак несёт готовую иконку — считаем её выбором игрока, даже если она
  // когда-то совпадала с кадром первой реплики: иначе пересборка молча
  // подменила бы её на текущий кадр первой реплики.
  state.packIcon = pack.icon;
  state.sourceUrl = pack.sourceUrl;
  // TCV-паки несут Theora (.ogv) — конвейер редактора (скраб, захват кадров
  // в media.ts) понимает только то, что играет нативный <video>. Пережимаем
  // один раз здесь, дальше редактор работает как с любым другим паком.
  const lastTimestamp = Math.max(0, ...pack.clips.flatMap((c) => c.timestamps));
  const nativeVideo =
    pack.videoKind === "ogv"
      ? await transcodeOgvToNative(pack.video, onOgvProgress ?? (() => {}), lastTimestamp, ogvPreviewVideo)
      : pack.video;
  const ext = nativeVideo.type.includes("webm") ? "webm" : "mp4";
  state.videoFile = new File([nativeVideo], `dub_video.${ext}`, { type: nativeVideo.type || `video/${ext}` });
  state.videoUrl = URL.createObjectURL(state.videoFile);
  state.backingTrack = pack.backingTrack;
  state.originalTrack = pack.originalTrack;
  // NN_name.* пака несёт только голос персонажа (формат, не зависит от
  // режима) — buildPack() режет реплики именно из этого буфера
  // (voiceSource = state.vocalsBuffer ?? state.audioBuffer, build.ts).
  // Без него нарезка при пересборке шла бы из общего микса, и в игре
  // реплика звучала бы с фоном поверх голоса.
  state.vocalsBuffer = await buildVocalsTimeline(pack).catch(() => null);
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
  try {
    return await buildSceneAudio(pack);
  } catch (err) {
    console.error(err);
    throw new Error("studioBadVideo");
  }
}

/**
 * Полная сцена одной дорожкой. Если пак несёт `_original_track` — берём его
 * как есть, это и есть полный микс. Если нет (обычное дело у чужих
 * TCV-паков — есть только `_backing_track`, чистый фон без единого слова),
 * раньше редактор откатывался прямо на фон: волны и прослушивание в
 * студии показывали и играли только музыку, ни одной реплики.
 *
 * Чиним тем же приёмом, что уже есть в `game/composer.ts` для «Закадра» без
 * `_original_track` (см. CLAUDE.md, п. 9 геймплея) — фон плюс голос каждой
 * реплики поверх него по её таймкодам, — только рендерим офлайн в один
 * буфер (`OfflineAudioContext`), а не планируем в реальном времени.
 */
async function buildSceneAudio(pack: DubPack): Promise<AudioBuffer> {
  if (pack.originalTrack) {
    try {
      return await decodeAudio(pack.originalTrack);
    } catch {
      // Дорожка есть, но не прочиталась — падаем на сборку из фона+реплик ниже.
    }
  }

  const backing = pack.backingTrack ? await decodeAudio(pack.backingTrack).catch(() => null) : null;
  const clipBuffers = await Promise.all(pack.clips.map((c) => decodeAudio(c.audio).catch(() => null)));

  if (!backing && clipBuffers.every((b) => !b)) {
    // Ни фона, ни единой реплики не прочиталось — последний шанс: звук видео.
    return decodeAudio(pack.video);
  }

  const sampleRate = backing?.sampleRate ?? clipBuffers.find((b): b is AudioBuffer => !!b)?.sampleRate ?? 44100;
  const channels = backing?.numberOfChannels ?? clipBuffers.find((b): b is AudioBuffer => !!b)?.numberOfChannels ?? 2;
  let durationSec = backing?.duration ?? 0;
  for (const [i, buf] of clipBuffers.entries()) {
    if (!buf) continue;
    for (const t of pack.clips[i].timestamps) durationSec = Math.max(durationSec, t + buf.duration);
  }
  if (durationSec <= 0) durationSec = 1;

  const offline = new OfflineAudioContext(channels, Math.ceil(durationSec * sampleRate), sampleRate);
  if (backing) {
    const src = offline.createBufferSource();
    src.buffer = backing;
    src.connect(offline.destination);
    src.start(0);
  }
  for (const [i, buf] of clipBuffers.entries()) {
    if (!buf) continue;
    for (const t of pack.clips[i].timestamps) {
      const src = offline.createBufferSource();
      src.buffer = buf;
      src.connect(offline.destination);
      src.start(Math.max(0, t));
    }
  }
  return offline.startRendering();
}

/**
 * Голоса реплик, разложенные по своим таймкодам поверх тишины — без фона.
 * Строится из `NN_name.*` каждой реплики: этот файл в любом dub-паке несёт
 * только голос персонажа, ни музыки, ни спецэффектов (формат, «Грабли» в
 * CLAUDE.md про длину клипа — тот же файл).
 */
async function buildVocalsTimeline(pack: DubPack): Promise<AudioBuffer | null> {
  const clipBuffers = await Promise.all(pack.clips.map((c) => decodeAudio(c.audio).catch(() => null)));
  const first = clipBuffers.find((b): b is AudioBuffer => !!b);
  if (!first) return null;

  const sampleRate = first.sampleRate;
  const channels = first.numberOfChannels;
  let durationSec = 0;
  for (const [i, buf] of clipBuffers.entries()) {
    if (!buf) continue;
    for (const t of pack.clips[i].timestamps) durationSec = Math.max(durationSec, t + buf.duration);
  }
  if (durationSec <= 0) return null;

  const offline = new OfflineAudioContext(channels, Math.ceil(durationSec * sampleRate), sampleRate);
  for (const [i, buf] of clipBuffers.entries()) {
    if (!buf) continue;
    for (const t of pack.clips[i].timestamps) {
      const src = offline.createBufferSource();
      src.buffer = buf;
      src.connect(offline.destination);
      src.start(Math.max(0, t));
    }
  }
  return offline.startRendering();
}
