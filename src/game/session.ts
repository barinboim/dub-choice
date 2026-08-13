import { decodeAudio } from "../audio/context";
import { Recording } from "../audio/recorder";
import { DubPack } from "../pack/types";

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
  /** Правки текста игроком: `индекс:язык` → текст. Живут только в сессии. */
  private readonly captionEdits = new Map<string, string>();
  /** Декодированные оригинальные реплики (для waveform и прослушивания). */
  private readonly originals = new Map<number, AudioBuffer>();
  private backing: AudioBuffer | null | undefined;
  private originalTrack: AudioBuffer | null | undefined;

  /**
   * uiLang — язык интерфейса: если пак несёт субтитры на нём, с них и
   * начинаем. Русскому игроку логично сразу видеть русский текст, а не
   * переключать язык на каждой сессии.
   */
  constructor(
    readonly pack: DubPack,
    uiLang: string = ORIGINAL_LANG
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

  get isLastClip() {
    return this.clipIndex >= this.total - 1;
  }

  get allRecorded() {
    return this.pack.clips.every((_, i) => this.recordings.has(i));
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

  async originalBuffer(index = this.clipIndex): Promise<AudioBuffer> {
    let buf = this.originals.get(index);
    if (!buf) {
      buf = await decodeAudio(this.pack.clips[index].audio);
      this.originals.set(index, buf);
    }
    return buf;
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
    for (const i of [this.clipIndex, this.clipIndex + 1]) {
      if (i < this.total) void this.originalBuffer(i).catch(() => {});
    }
  }
}
