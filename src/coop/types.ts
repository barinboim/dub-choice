/** Общие типы кооп-комнаты (зеркало server.py). */

export type CoopMode = "relay" | "free" | "chars";

export interface CoopParticipant {
  pid: string;
  name: string;
  color: string;
  connected: boolean;
}

export interface CoopTakeMeta {
  pid: string;
  name: string;
  leadSec: number;
}

export interface CoopRelay {
  turn: string | null;
  line: number | null;
}

export interface CoopRoom {
  code: string;
  hostPid: string;
  mode: CoopMode;
  participants: CoopParticipant[];
  packTitle: string | null;
  packReady: boolean;
  /** pid → выбранные персонажи (режим chars). */
  chars: Record<string, string[]>;
  /** clipIndex (строкой от сервера, числом после нормализации) → pid. */
  claims: Record<string, string>;
  takes: Record<string, CoopTakeMeta>;
  relay: CoopRelay;
  clipCount: number;
}

export type CoopEvent =
  | { type: "state"; room: CoopRoom }
  | { type: "roster"; participants: CoopParticipant[] }
  | { type: "mode"; mode: CoopMode }
  | { type: "chars"; pid: string; characters: string[] }
  | { type: "claim"; index: number; pid: string | null }
  | { type: "take"; index: number; pid: string; name: string }
  | { type: "turn"; pid: string | null; line: number | null }
  | { type: "pack"; title: string | null }
  | { type: "kicked"; by: string };

export class CoopError extends Error {}

/** Метаданные пака, которые хост шлёт вместе с ZIP (нужны арбитражу по персонажам). */
export interface CoopPackMeta {
  title: string;
  clips: { characters: string[] }[];
}
