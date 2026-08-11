import { decodeAudio } from "../audio/context";
import { Recording } from "../audio/recorder";
import { DubPack } from "../pack/types";

/** Состояние одной игровой сессии дубляжа. */
export class DubSession {
  clipIndex = 0;
  /** Записи игрока по индексу клипа. */
  readonly recordings = new Map<number, Recording>();
  /** Декодированные оригинальные реплики (для waveform и прослушивания). */
  private readonly originals = new Map<number, AudioBuffer>();
  private backing: AudioBuffer | null | undefined;

  constructor(
    readonly pack: DubPack,
    /** Режим репетиции: можно слушать свои дубли до финала. */
    readonly rehearsal: boolean
  ) {}

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

  /** Подгружает следующую реплику заранее, чтобы переходы были мгновенными. */
  prefetchAround(): void {
    for (const i of [this.clipIndex, this.clipIndex + 1]) {
      if (i < this.total) void this.originalBuffer(i).catch(() => {});
    }
  }
}
