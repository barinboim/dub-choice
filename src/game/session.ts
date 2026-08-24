import { audioContext, decodeAudio } from "../audio/context";
import { Recording } from "../audio/recorder";
import { DubPack, clipIsActive } from "../pack/types";

/** Состояние одной игровой сессии дубляжа. */
/** Язык оригинальных субтитров в переключателе; "" — пак не указал свой lang. */
export const ORIGINAL_LANG = "";

export class DubSession {
  clipIndex = 0;
  /** Записи игрока по индексу клипа. */
  readonly recordings = new Map<number, Recording>();
  /**
   * Выбранный язык субтитров: ORIGINAL_LANG или код из pack.translations.
   * Держится на всю сессию — переключать на каждой реплике заново незачем.
   */
  captionLang = ORIGINAL_LANG;
  /**
   * Выбранная звуковая дорожка: ORIGINAL_LANG или код дубляжа. Ось
   * независима от субтитров намеренно — игрок может слушать английский,
   * а озвучивать по русскому тексту, ровно как на настоящем дубляже.
   */
  audioLang = ORIGINAL_LANG;
  /** Правки текста игроком: `индекс:язык` → текст. Живут только в сессии. */
  private readonly captionEdits = new Map<string, string>();
  /** Декодированные оригинальные реплики (для waveform и прослушивания). */
  private readonly originals = new Map<number, AudioBuffer>();
  private backing: AudioBuffer | null | undefined;
  private originalTrack: AudioBuffer | null | undefined;
  /** Дорожки дубляжа целиком и нарезанные из них реплики. */
  private readonly voices = new Map<string, AudioBuffer | null>();
  private readonly dubbed = new Map<string, AudioBuffer>();

  /**
   * uiLang — язык интерфейса: если пак несёт субтитры на нём, с них и
   * начинаем. Русскому игроку логично сразу видеть русский текст, а не
   * переключать язык на каждой сессии.
   */
  constructor(
    readonly pack: DubPack,
    uiLang: string = ORIGINAL_LANG,
    /** Персонажи, выключенные фильтром на карточке пака — их реплики пропускаются. */
    private readonly disabledCharacters: ReadonlySet<string> = new Set()
  ) {
    if (uiLang && uiLang !== pack.lang && pack.translations.includes(uiLang)) {
      this.captionLang = uiLang;
    }
  }

  get clip() {
    return this.pack.clips[this.clipIndex];
  }

  get total() {
    return this.pack.clips.length;
  }

  /** Фильтр персонажей выключил хоть кого-то — есть что скачать отдельно от голоса игрока. */
  get hasDisabledCharacters(): boolean {
    return this.disabledCharacters.size > 0;
  }

  /** Реплику нужно озвучить: хотя бы один её персонаж не выключен фильтром. */
  isClipActive(index: number): boolean {
    const clip = this.pack.clips[index];
    return !!clip && clipIsActive(clip, this.disabledCharacters);
  }

  /** Индексы реплик, которые предстоит озвучить игроку, по порядку. */
  get activeIndices(): number[] {
    const result: number[] = [];
    for (let i = 0; i < this.pack.clips.length; i++) {
      if (this.isClipActive(i)) result.push(i);
    }
    return result;
  }

  get activeTotal(): number {
    return this.activeIndices.length;
  }

  /** 1-based позиция текущей реплики среди активных — для счётчика «N из M». */
  get activePosition(): number {
    return this.activeIndices.indexOf(this.clipIndex) + 1;
  }

  get firstActiveIndex(): number {
    return this.activeIndices[0] ?? 0;
  }

  get lastActiveIndex(): number {
    const indices = this.activeIndices;
    return indices[indices.length - 1] ?? 0;
  }

  /** Следующая активная реплика после `from`, либо null, если это была последняя. */
  nextActiveIndex(from: number): number | null {
    return this.activeIndices.find((i) => i > from) ?? null;
  }

  /** Предыдущая активная реплика перед `from`, либо null, если это была первая. */
  prevActiveIndex(from: number): number | null {
    const indices = this.activeIndices;
    for (let i = indices.length - 1; i >= 0; i--) {
      if (indices[i] < from) return indices[i];
    }
    return null;
  }

  get isLastClip() {
    return this.nextActiveIndex(this.clipIndex) === null;
  }

  get allRecorded() {
    return this.activeIndices.every((i) => this.recordings.has(i));
  }

  /** Дорожки в переключателе: оригинал первым. Пусто — выбирать нечего. */
  get audioLangs(): string[] {
    return this.pack.voiceTracks.length > 0
      ? [ORIGINAL_LANG, ...this.pack.voiceTracks.map((t) => t.lang)]
      : [];
  }

  /** Языки в переключателе: оригинал первым, дальше переводы пака. */
  get captionLangs(): string[] {
    return this.pack.translations.length > 0
      ? [ORIGINAL_LANG, ...this.pack.translations]
      : [];
  }

  /** Текст реплики на выбранном языке — с учётом правки игрока. */
  captionFor(index = this.clipIndex, lang = this.captionLang): string {
    const edited = this.captionEdits.get(`${index}:${lang}`);
    if (edited !== undefined) return edited;
    const clip = this.pack.clips[index];
    if (!clip) return "";
    return lang === ORIGINAL_LANG ? clip.caption : (clip.captions[lang] ?? clip.caption);
  }

  /** Сохраняет свою версию текста; пустая строка стирает правку. */
  editCaption(text: string, index = this.clipIndex, lang = this.captionLang): void {
    const key = `${index}:${lang}`;
    if (text.trim() === "") this.captionEdits.delete(key);
    else this.captionEdits.set(key, text);
  }

  isCaptionEdited(index = this.clipIndex, lang = this.captionLang): boolean {
    return this.captionEdits.has(`${index}:${lang}`);
  }

  /** Снимок правок текста — для сохранения прохождения в историю (`pack/history.ts`). */
  captionEditsSnapshot(): [string, string][] {
    return [...this.captionEdits];
  }

  /** Восстанавливает правки текста при открытии прохождения из истории. */
  restoreCaptionEdits(edits: Iterable<[string, string]>): void {
    this.captionEdits.clear();
    for (const [key, text] of edits) this.captionEdits.set(key, text);
  }

  async originalBuffer(index = this.clipIndex): Promise<AudioBuffer> {
    let buf = this.originals.get(index);
    if (!buf) {
      buf = await decodeAudio(this.pack.clips[index].audio);
      this.originals.set(index, buf);
    }
    return buf;
  }

  /** Дорожка дубляжа целиком; декодируется один раз, по требованию. */
  async voicesBuffer(lang: string): Promise<AudioBuffer | null> {
    if (!this.voices.has(lang)) {
      const track = this.pack.voiceTracks.find((t) => t.lang === lang);
      this.voices.set(lang, track ? await decodeAudio(track.blob) : null);
    }
    return this.voices.get(lang) ?? null;
  }

  /**
   * Реплика на выбранной дорожке. Куски дубляжа не возятся отдельными
   * файлами — режем их из дорожки по таймкоду и длине оригинальной
   * реплики: окно записи одно и то же для всех языков.
   */
  async clipBuffer(index = this.clipIndex,
                   lang = this.audioLang): Promise<AudioBuffer> {
    const orig = await this.originalBuffer(index);
    if (lang === ORIGINAL_LANG) return orig;
    const key = `${lang}:${index}`;
    const done = this.dubbed.get(key);
    if (done) return done;
    const track = await this.voicesBuffer(lang);
    if (!track) return orig;

    const at = this.pack.clips[index].timestamps[0] ?? 0;
    const from = Math.max(0, Math.round(at * track.sampleRate));
    const len = Math.min(Math.round(orig.duration * track.sampleRate),
                         Math.max(0, track.length - from));
    const ctx = audioContext();
    const cut = ctx.createBuffer(track.numberOfChannels,
                                 Math.max(1, len), track.sampleRate);
    for (let ch = 0; ch < track.numberOfChannels; ch++) {
      cut.getChannelData(ch).set(
        track.getChannelData(ch).subarray(from, from + len));
    }
    this.dubbed.set(key, cut);
    return cut;
  }

  async backingBuffer(): Promise<AudioBuffer | null> {
    if (this.backing === undefined) {
      this.backing = this.pack.backingTrack ? await decodeAudio(this.pack.backingTrack) : null;
    }
    return this.backing;
  }

  /** Полная оригинальная дорожка сцены, если пак её несёт. */
  async originalTrackBuffer(): Promise<AudioBuffer | null> {
    if (this.originalTrack === undefined) {
      this.originalTrack = this.pack.originalTrack
        ? await decodeAudio(this.pack.originalTrack)
        : null;
    }
    return this.originalTrack;
  }

  /** Подгружает следующую реплику заранее, чтобы переходы были мгновенными. */
  prefetchAround(): void {
    const next = this.nextActiveIndex(this.clipIndex);
    for (const i of [this.clipIndex, next].filter((i): i is number => i !== null)) {
      void this.originalBuffer(i).catch(() => {});
    }
  }
}
