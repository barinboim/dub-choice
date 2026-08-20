import { CoopError, CoopPackMeta, CoopRoom, CoopTakeMeta } from "./types";

/** REST-клиент кооп-бэкенда (тот же origin — через hostish/прокси). */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new CoopError("Сервер недоступен.");
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* не-JSON ответ */
  }
  if (!res.ok || (data && typeof data === "object" && "error" in data)) {
    const err = (data as { error?: string } | null)?.error;
    throw new CoopError(err ?? `HTTP ${res.status}`);
  }
  return data as T;
}

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function createRoom(name: string): Promise<{ code: string; pid: string; room: CoopRoom }> {
  return request("/api/rooms", json("POST", { name }));
}

export function joinRoom(
  code: string,
  name: string,
  pid?: string
): Promise<{ pid: string; name: string; room: CoopRoom }> {
  return request(`/api/rooms/${encodeURIComponent(code)}/join`, json("POST", { name, pid }));
}

export function leaveRoom(code: string, pid: string): Promise<{ ok: boolean }> {
  return request(`/api/rooms/${encodeURIComponent(code)}/leave`, json("POST", { pid }));
}

export function setMode(code: string, pid: string, mode: string): Promise<{ ok: boolean }> {
  return request(`/api/rooms/${encodeURIComponent(code)}/mode`, json("POST", { pid, mode }));
}

export function setChars(
  code: string,
  pid: string,
  characters: string[]
): Promise<{ ok: boolean }> {
  return request(`/api/rooms/${encodeURIComponent(code)}/chars`, json("POST", { pid, characters }));
}

export function claimClip(
  code: string,
  pid: string,
  index: number
): Promise<{ ok: boolean; by?: string | null; reason?: string }> {
  return request(`/api/rooms/${encodeURIComponent(code)}/claim`, json("POST", { pid, index }));
}

export function releaseClip(code: string, pid: string, index: number): Promise<{ ok: boolean }> {
  return request(
    `/api/rooms/${encodeURIComponent(code)}/claim`,
    json("POST", { pid, index, action: "release" })
  );
}

export function passTurn(code: string, pid: string): Promise<{ ok: boolean }> {
  return request(`/api/rooms/${encodeURIComponent(code)}/pass`, json("POST", { pid }));
}

export function uploadPack(
  code: string,
  pid: string,
  zip: Blob,
  meta: CoopPackMeta
): Promise<{ ok: boolean }> {
  return request(`/api/rooms/${encodeURIComponent(code)}/pack`, {
    method: "POST",
    headers: {
      "X-Pid": pid,
      // заголовки обязаны быть Latin-1 — мета (с кириллицей) уходит процентно-кодированной
      "X-Pack-Meta": encodeURIComponent(JSON.stringify(meta)),
      "Content-Type": "application/zip",
    },
    body: zip,
  });
}

export async function downloadPack(
  code: string,
  onProgress?: (fraction: number) => void
): Promise<Blob> {
  const res = await fetch(`/api/rooms/${encodeURIComponent(code)}/pack`);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* noop */
    }
    throw new CoopError(msg);
  }
  const total = Number(res.headers.get("Content-Length") || 0);
  if (!onProgress || !res.body || !total) return res.blob();
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(new Uint8Array(value));
      received += value.length;
      onProgress(received / total);
    }
  }
  return new Blob(chunks, { type: "application/zip" });
}

export function uploadTake(
  code: string,
  pid: string,
  index: number,
  wav: Blob,
  leadSec: number
): Promise<{ ok: boolean }> {
  return request(`/api/rooms/${encodeURIComponent(code)}/takes/${index}`, {
    method: "POST",
    headers: {
      "X-Pid": pid,
      "X-Lead-Sec": String(leadSec),
      "Content-Type": "audio/wav",
    },
    body: wav,
  });
}

export function takesMeta(code: string): Promise<Record<string, CoopTakeMeta>> {
  return request(`/api/rooms/${encodeURIComponent(code)}/takes`);
}

/** URL скачивания записи реплики (для fetch/audio). */
export function takeWavUrl(code: string, index: number): string {
  return `/api/rooms/${encodeURIComponent(code)}/takes/${index}/wav`;
}
