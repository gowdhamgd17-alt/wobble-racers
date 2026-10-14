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
} as const;

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
  | 'wave';

/** [type, playerId, x, y, z, amount] */
export type FxMessage = [FxType, string, number, number, number, number];

const F_HANDBRAKE = 1, F_NITRO = 2, F_FIRE = 4, F_RECOVER = 8;

/** Compact wire format: [seq, steer*100, throttle*100, brake*100, flags] */
export type WireInput = [number, number, number, number, number];

export function encodeInput(seq: number, i: InputState): WireInput {
  return [
    seq,
    Math.round(i.steer * 100),
    Math.round(i.throttle * 100),
    Math.round(i.brake * 100),
    (i.handbrake ? F_HANDBRAKE : 0) | (i.nitro ? F_NITRO : 0) | (i.fire ? F_FIRE : 0) | (i.recover ? F_RECOVER : 0),
  ];
}

/** Validates and decodes; returns null for malformed messages. */
export function decodeInput(raw: unknown): { seq: number; input: InputState } | null {
  if (!Array.isArray(raw) || raw.length !== 5) return null;
  for (const v of raw) if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const [seq, st, th, br, fl] = raw as number[];
  if (!Number.isInteger(seq) || seq < 0 || seq > 2 ** 31) return null;
  if (!Number.isInteger(fl) || fl < 0 || fl > 15) return null;
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
    },
  };
}
