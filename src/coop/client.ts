import { CoopEvent, CoopRoom } from "./types";

/**
 * Живой клиент комнаты: WebSocket + кэш состояния.
 * Сервер — источник истины; события применяются к кэшу и переотдаются подписчику.
 */

function normalizeRoom(room: CoopRoom): CoopRoom {
  const claims: Record<string, string> = {};
  for (const [k, v] of Object.entries(room.claims)) claims[String(Number(k))] = v;
  const takes: CoopRoom["takes"] = {};
  for (const [k, v] of Object.entries(room.takes)) takes[String(Number(k))] = v;
  return { ...room, claims, takes };
}

export class CoopClient {
  room: CoopRoom | null = null;
  myPid: string;
  onEvent: ((e: CoopEvent) => void) | null = null;
  onStatus: ((connected: boolean) => void) | null = null;

  private ws: WebSocket | null = null;
  private closed = false;
  private kicked = false;
  private retryDelay = 1000;

  constructor(readonly code: string, pid: string) {
    this.myPid = pid;
  }

  /** Открывает соединение (с авто-переподключением с нарастающей задержкой). */
  connect(): void {
    this.closed = false;
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(
      `${proto}://${location.host}/ws?code=${encodeURIComponent(this.code)}&pid=${encodeURIComponent(this.myPid)}`
    );
    this.ws = ws;
    ws.onopen = () => {
      this.retryDelay = 1000;
      this.onStatus?.(true);
      // сервер помечает участника онлайн и чинит эстафету (repair_relay)
      ws.send(JSON.stringify({ type: "hello" }));
    };
    ws.onmessage = (e) => {
      let msg: CoopEvent;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = () => {
      this.onStatus?.(false);
      if (this.closed || this.kicked) return;
      setTimeout(() => this.open(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 10000);
    };
    ws.onerror = () => ws.close();
  }

  private handle(msg: CoopEvent): void {
    if (msg.type === "kicked") this.kicked = true;
    if (msg.type === "state") {
      this.room = normalizeRoom(msg.room);
    } else if (this.room) {
      applyToRoom(this.room, msg);
    }
    this.onEvent?.(msg);
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }

  get me(): { pid: string; name: string; color: string } | null {
    if (!this.room) return null;
    const p = this.room.participants.find((x) => x.pid === this.myPid);
    return p ? { pid: p.pid, name: p.name, color: p.color } : null;
  }
}

function applyToRoom(room: CoopRoom, e: CoopEvent): void {
  switch (e.type) {
    case "roster":
      room.participants = e.participants;
      break;
    case "mode":
      room.mode = e.mode;
      break;
    case "chars":
      if (e.characters.length === 0) delete room.chars[e.pid];
      else room.chars[e.pid] = e.characters;
      break;
    case "claim":
      if (e.pid === null) delete room.claims[String(e.index)];
      else room.claims[String(e.index)] = e.pid;
      break;
    case "take":
      room.takes[String(e.index)] = { pid: e.pid, name: e.name, leadSec: 0 };
      break;
    case "turn":
      room.relay = { turn: e.pid, line: e.line };
      break;
    case "pack":
      room.packTitle = e.title;
      room.packReady = e.title !== null;
      break;
    case "state":
      break;
  }
}
