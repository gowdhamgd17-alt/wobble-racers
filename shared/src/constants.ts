// Central game rules & balance values shared by client and server.

export const MIN_PLAYERS_TO_START = 2;
export const MAX_PLAYERS = 15;

export const SIM_HZ = 30;
export const SIM_DT = 1 / SIM_HZ;
export const PATCH_RATE_MS = 50; // 20 Hz state patches

export const NAME_MAX_LENGTH = 16;
export const ROOM_NAME_MAX_LENGTH = 24;

export const LAP_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const DEFAULT_LAPS = 3;

export const COUNTDOWN_SECONDS = 3;
export const RECONNECT_GRACE_SECONDS = 20;

export const MAX_HEALTH = 100;

export const PHYS = {
  gravity: 20,
  projectileRadius: 0.4,
  barrierInset: 1.2, // barrier sits this far beyond road half-width
  barrierHeight: 1.2,
  maxYawRate: 7,
  maxSpinRate: 9,
  maxVerticalSpeed: 14,
  maxLaunch: 11,
  landingDamageSpeed: 13, // vertical speed above which a landing hurts
  overturnRecoverSeconds: 1.2,
  offTrackRecoverSeconds: 2,
  fallRecoverY: -12,
  manualRecoverCooldown: 3,
  collisionPairCooldown: 0.35,
  collisionLaunchSpeed: 15, // closing speed needed to launch a car
  wallDamageSpeed: 16,
} as const;

export const NITRO = {
  max: 100,
  start: 50,
  drainPerSecond: 34,
  driftGainPerSecond: 14,
  airGainPerSecond: 8,
  padGain: 35,
  padImpulse: 9,
  minToActivate: 5,
} as const;

export const WEAPON = {
  damage: 20,
  cooldown: 0.45,
  projectileSpeed: 95,
  lifetime: 1.15,
  knockback: 7,
  knockUp: 3.5,
  maxProjectilesPerPlayer: 4,
} as const;

export const RESPAWN = {
  destroyedSeconds: 1.6,
  protectionSeconds: 2,
  safeClearance: 6.5, // centre-to-centre, longer than the longest car
} as const;

export const INPUT_LIMITS = {
  maxPerSecond: 45, // client sends 30/s; allow jitter bursts
  maxQueue: 8,
} as const;

export enum Phase {
  WAITING_FOR_PLAYERS = 'WAITING_FOR_PLAYERS',
  LOBBY = 'LOBBY',
  COUNTDOWN = 'COUNTDOWN',
  RACING = 'RACING',
  RESULTS = 'RESULTS',
  CLOSED = 'CLOSED',
}

export enum RacerStatus {
  LOBBY = 'lobby',
  RACING = 'racing',
  DESTROYED = 'destroyed',
  FINISHED = 'finished',
  DISCONNECTED = 'disconnected', // inside grace period
  LEFT = 'left', // removed from active competition
}

export const ROOM_NAME = 'race';
