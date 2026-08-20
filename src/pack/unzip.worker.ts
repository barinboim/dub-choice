/**
 * fflate-воркер: распаковка ZIP пака и упаковка в ZIP — вне главного потока.
 * Большие паки (десятки МБ видео) на главном потоке замораживали вкладку:
 * в этот момент не обрабатывались ни WS-события комнаты, ни клики.
 */
import { unzip, zipSync } from "fflate";
import { MEDIA_RE } from "./media";

const MAX_ENTRY = 512 * 1024 * 1024;

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage: (msg: unknown, transfer?: Transferable[]) => void;
};

ctx.onmessage = (e: MessageEvent) => {
  const msg = e.data as {
    op: "unzip" | "zip";
    id: number;
    bytes?: ArrayBuffer;
    files?: Record<string, ArrayBuffer>;
  };
  if (msg.op === "unzip" && msg.bytes) {
    const data = new Uint8Array(msg.bytes);
    unzip(
      data,
      {
        filter: (f) => MEDIA_RE.test(f.name) && f.originalSize < MAX_ENTRY,
      },
      (err, out) => {
        if (err) {
          ctx.postMessage({ id: msg.id, ok: false, error: String(err) });
          return;
        }
        const files: Record<string, ArrayBuffer> = {};
        const transfer: ArrayBuffer[] = [];
        for (const [path, b] of Object.entries(out)) {
          const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
          files[path] = ab;
          transfer.push(ab);
        }
        ctx.postMessage({ id: msg.id, ok: true, files }, transfer);
      }
    );
    return;
  }
  if (msg.op === "zip" && msg.files) {
    try {
      const entries: Record<string, Uint8Array> = {};
      for (const [name, ab] of Object.entries(msg.files)) entries[name] = new Uint8Array(ab);
      const zipped = zipSync(entries, { level: 6 });
      const out = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
      ctx.postMessage({ id: msg.id, ok: true, bytes: out }, [out]);
    } catch (err) {
      ctx.postMessage({ id: msg.id, ok: false, error: String(err) });
    }
    return;
  }
  ctx.postMessage({ id: msg.id, ok: false, error: "unknown op" });
};
