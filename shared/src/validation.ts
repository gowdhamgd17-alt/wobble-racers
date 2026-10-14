import { DEFAULT_LAPS, GAME_MODES, KILL_TARGETS, LAP_OPTIONS, TIME_LIMITS, MAX_PLAYERS, MIN_PLAYERS_TO_START, NAME_MAX_LENGTH, ROOM_NAME_MAX_LENGTH } from './constants';
import { CHARACTER_IDS, COLOR_IDS, WHEEL_STYLE_IDS } from './cosmetics';
import { DEFAULT_KM, KM_OPTIONS, normalizeSpec } from './track';
import { CAR_CLASS_IDS } from './vehicles';
import { WEAPON_IDS } from './weapons';
import { ARENA_IDS } from './arena';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// Letters (any script), numbers, space and a small safe punctuation set.
const NAME_ALLOWED = /^[\p{L}\p{N} _\-.!?'#]+$/u;
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[' + [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]].map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');

function cleanText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFC').replace(CONTROL, '').replace(/\s+/g, ' ').trim();
}

export function validateDisplayName(raw: unknown): Result<string> {
  const name = cleanText(raw);
  if (!name) return { ok: false, error: 'Please enter a display name.' };
  if ([...name].length > NAME_MAX_LENGTH)
    return { ok: false, error: `Names can be at most ${NAME_MAX_LENGTH} characters.` };
  if (!NAME_ALLOWED.test(name))
    return { ok: false, error: "Use letters, numbers, spaces and _ - . ! ? ' # only." };
  return { ok: true, value: name };
}

export function validateRoomName(raw: unknown, fallback: string): string {
  const name = cleanText(raw);
  if (!name || !NAME_ALLOWED.test(name)) return fallback;
  return [...name].slice(0, ROOM_NAME_MAX_LENGTH).join('');
}

export interface RaceSettings {
  mode: string; // 'race' | 'battle'
  arenaId: string;
  killTarget: number;
  timeLimit: number; // minutes, 0 = none
  layout: string; // 'loop' | 'straight'
  trackId: string;
  distanceKm: number; // lap length (loop) or sprint length (straight)
  laps: number;
  collisions: boolean;
  damage: boolean;
  weapons: boolean;
  nitro: boolean;
  drift: boolean;
}

export const DEFAULT_SETTINGS: RaceSettings = {
  mode: 'race',
  arenaId: 'town',
  killTarget: 10,
  timeLimit: 5,
  layout: 'loop',
  trackId: 'valley',
  distanceKm: DEFAULT_KM,
  laps: DEFAULT_LAPS,
  collisions: true,
  damage: true,
  weapons: true,
  nitro: true,
  drift: true,
};

/** Merge an untrusted partial settings object into valid settings. */
export function sanitizeSettings(raw: unknown, base: RaceSettings = DEFAULT_SETTINGS): RaceSettings {
  const out = { ...base };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  // Layout, track and distance are validated together (a track belongs to one layout).
  const spec = normalizeSpec({
    layout: typeof r.layout === 'string' ? r.layout : out.layout,
    trackId: typeof r.trackId === 'string' ? r.trackId : out.trackId,
    // An invalid distance keeps the current one rather than resetting it.
    distanceKm: (KM_OPTIONS as readonly number[]).includes(r.distanceKm as number) ? (r.distanceKm as number) : out.distanceKm,
  });
  out.layout = spec.layout;
  out.trackId = spec.trackId;
  out.distanceKm = spec.distanceKm;
  if (typeof r.mode === 'string' && (GAME_MODES as string[]).includes(r.mode)) out.mode = r.mode;
  if (typeof r.arenaId === 'string' && ARENA_IDS.includes(r.arenaId)) out.arenaId = r.arenaId;
  if (typeof r.killTarget === 'number' && (KILL_TARGETS as readonly number[]).includes(r.killTarget)) out.killTarget = r.killTarget;
  if (typeof r.timeLimit === 'number' && (TIME_LIMITS as readonly number[]).includes(r.timeLimit)) out.timeLimit = r.timeLimit;
  if (typeof r.laps === 'number' && (LAP_OPTIONS as readonly number[]).includes(r.laps)) out.laps = r.laps;
  for (const k of ['collisions', 'damage', 'weapons', 'nitro', 'drift'] as const) {
    if (typeof r[k] === 'boolean') out[k] = r[k] as boolean;
  }
  return out;
}

export function sanitizeMaxPlayers(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : MAX_PLAYERS;
  return Math.max(MIN_PLAYERS_TO_START, Math.min(MAX_PLAYERS, n));
}

export interface Appearance {
  carClass: string;
  character: string;
  colorMain: string;
  colorSecondary: string;
  colorWheel: string;
  wheelStyle: string;
  weapon: string;
}

export const DEFAULT_APPEARANCE: Appearance = {
  carClass: 'drifter',
  character: 'bonk',
  colorMain: 'red',
  colorSecondary: 'white',
  colorWheel: 'black',
  wheelStyle: 'classic',
  weapon: 'm4',
};

export function sanitizeAppearance(raw: unknown, base: Appearance = DEFAULT_APPEARANCE): Appearance {
  const out = { ...base };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  const pick = (k: keyof Appearance, allowed: string[]) => {
    if (typeof r[k] === 'string' && allowed.includes(r[k] as string)) out[k] = r[k] as string;
  };
  pick('carClass', CAR_CLASS_IDS);
  pick('character', CHARACTER_IDS);
  pick('colorMain', COLOR_IDS);
  pick('colorSecondary', COLOR_IDS);
  pick('colorWheel', COLOR_IDS);
  pick('wheelStyle', WHEEL_STYLE_IDS);
  pick('weapon', WEAPON_IDS);
  return out;
}
