// Network message names and compact encodings.

import type { InputState } from './physics';

export const MSG = {
  // client -> server
  INPUT: 'i',
  READY: 'ready',
  APPEARANCE: 'appearance',
  SETTINGS: 'settings',
  START: 'start',
  REMATCH: 'rematch',
  TO_LOBBY: 'toLobby',
  EMOTE: 'emote',
  // server -> client
  FX: 'fx',
  ERROR: 'err',
  WELCOME: 'welcome',
  KILL: 'kill', // KillEvent[]
  // voice chat (WebRTC signalling relayed by the server; audio itself is peer to peer)
  RTC: 'rtc', // client -> server: { to, kind, data }   server -> client: { from, kind, data }
  VOICE: 'voice', // client -> server: { on: boolean }
} as const;

export type RtcKind = 'offer' | 'answer' | 'ice' | 'bye';
export interface RtcSignal { to?: string; from?: string; kind: RtcKind; data?: unknown }

/** Validates a client's signalling message; returns null when it's malformed or too big. */
export function sanitizeRtc(raw: unknown): { to: string; kind: RtcKind; data: unknown } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.to !== 'string' || r.to.length > 64) return null;
  if (r.kind !== 'offer' && r.kind !== 'answer' && r.kind !== 'ice' && r.kind !== 'bye') return null;
  let size = 0;
  try { size = JSON.stringify(r.data ?? null).length; } catch { return null; }
  if (size > 16000) return null;
  return { to: r.to, kind: r.kind, data: r.data ?? null };
}

export type FxType =
  | 'hit' // projectile hit
  | 'crash' // car-car impact
  | 'wall'
  | 'land'
  | 'explode'
  | 'respawn'
  | 'pad'
  | 'shoot'
  | 'lap'
  | 'finish'
  | 'overtake'
  | 'wave'
  | 'tracer' // bullet: muzzle x,y,z; amount = weapon index; extras = end x,y,z
  | 'blast' // rocket / grenade explosion; amount = radius
  | 'reload' // amount = weapon index
  | 'reloaded' // amount = weapon index
  | 'empty' // dry fire click
  | 'pickup' // weapon crate taken; amount = weapon index
  | 'repair' // repair kit taken; amount = health restored
  | 'bounce' // grenade bounce
  | 'impact'; // bullet hit the world (sparks / dust)

/** [type, playerId, x, y, z, amount, ...extras] */
export type FxMessage = [FxType, string, number, number, number, number, ...number[]];

/** Somebody destroyed somebody. killer is '' for self-inflicted / world deaths. */
export interface KillEvent {
  killer: string;
  victim: string;
  weapon: string; // weapon id, or 'ram' / 'crash' / 'wall' / 'fall'
}

const F_HANDBRAKE = 1, F_NITRO = 2, F_FIRE = 4, F_RECOVER = 8, F_RELOAD = 16;

/** Compact wire format: [seq, steer*100, throttle*100, brake*100, flags]
 *  flags bits 0-4 are buttons; bits 5+ carry (selected weapon index + 1), 0 = no selection. */
export type WireInput = [number, number, number, number, number];

export function encodeInput(seq: number, i: InputState): WireInput {
  return [
    seq,
    Math.round(i.steer * 100),
    Math.round(i.throttle * 100),
    Math.round(i.brake * 100),
    (i.handbrake ? F_HANDBRAKE : 0) | (i.nitro ? F_NITRO : 0) | (i.fire ? F_FIRE : 0) | (i.recover ? F_RECOVER : 0) | (i.reload ? F_RELOAD : 0) |
      ((i.weapon !== undefined && i.weapon >= 0 && i.weapon < 10 ? i.weapon + 1 : 0) << 5),
  ];
}

/** Validates and decodes; returns null for malformed messages. */
export function decodeInput(raw: unknown): { seq: number; input: InputState } | null {
  if (!Array.isArray(raw) || raw.length !== 5) return null;
  for (const v of raw) if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const [seq, st, th, br, fl] = raw as number[];
  if (!Number.isInteger(seq) || seq < 0 || seq > 2 ** 31) return null;
  if (!Number.isInteger(fl) || fl < 0 || fl > 31 + (10 << 5)) return null;
  const c = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v / 100));
  return {
    seq,
    input: {
      steer: c(st, -1, 1),
      throttle: c(th, 0, 1),
      brake: c(br, 0, 1),
      handbrake: (fl & F_HANDBRAKE) !== 0,
      nitro: (fl & F_NITRO) !== 0,
      fire: (fl & F_FIRE) !== 0,
      recover: (fl & F_RECOVER) !== 0,
      reload: (fl & F_RELOAD) !== 0,
      weapon: (fl >> 5) - 1,
    },
  };
}
