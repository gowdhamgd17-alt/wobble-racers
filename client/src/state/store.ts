import { useSyncExternalStore } from 'react';
import { DEFAULT_APPEARANCE, sanitizeAppearance, validateDisplayName, type Appearance } from '@wobble/shared';

/** Tiny observable store persisted to localStorage. */
export function createStore<T extends object>(key: string, initial: T, sanitize: (v: unknown) => T = (v) => ({ ...initial, ...(v as object) })) {
  let value: T = initial;
  try {
    const raw = localStorage.getItem(key);
    if (raw) value = sanitize(JSON.parse(raw));
  } catch {
    // storage unavailable (private mode) — fall back to defaults
  }
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(patch: Partial<T>) {
      value = { ...value, ...patch };
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export type Store<T> = ReturnType<typeof createStore<T & object>>;

export function useStore<T extends object>(store: { get: () => T; subscribe: (l: () => void) => () => boolean | void }) {
  return useSyncExternalStore(store.subscribe as (l: () => void) => () => void, store.get, store.get);
}

// ------------------------------------------------------------------ settings

export type ControlMode = 'auto' | 'touch' | 'keyboard';
export type Quality = 'auto' | 'low' | 'medium' | 'high';
export type Action = 'accelerate' | 'brake' | 'left' | 'right' | 'drift' | 'nitro' | 'fire' | 'reload' | 'prevWeapon' | 'nextWeapon' | 'recover' | 'talk' | 'pause';

export const DEFAULT_BINDINGS: Record<Action, string[]> = {
  accelerate: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  drift: ['Space'],
  nitro: ['ShiftLeft', 'ShiftRight'],
  fire: ['KeyF', 'KeyJ'],
  reload: ['KeyR'],
  prevWeapon: ['KeyQ'],
  nextWeapon: ['KeyE'],
  recover: ['KeyR'],
  talk: ['KeyV'],
  pause: ['Escape', 'KeyP'],
};

export interface Settings {
  controlMode: ControlMode;
  quality: Quality;
  sfxVolume: number;
  musicVolume: number;
  cameraSensitivity: number; // 0.5..2
  touchScale: number; // 0.8..1.3
  autoGas: boolean;
  haptics: boolean;
  voiceMode: 'ptt' | 'open'; // push-to-talk or open mic
  voiceVolume: number;
  /** Custom on-screen control positions: centre in % of the screen, size multiplier. */
  touchLayout: Record<string, TouchSpot>;
  autoFullscreen: boolean;
  showFps: boolean;
  bindings: Record<Action, string[]>;
}

export const DEFAULT_GAME_SETTINGS: Settings = {
  controlMode: 'auto',
  quality: 'auto',
  sfxVolume: 0.7,
  musicVolume: 0.35,
  cameraSensitivity: 1,
  touchScale: 1,
  autoGas: false,
  haptics: true,
  voiceMode: 'ptt',
  voiceVolume: 1,
  touchLayout: {},
  autoFullscreen: true,
  showFps: false,
  bindings: DEFAULT_BINDINGS,
};

export interface TouchSpot { x: number; y: number; s: number }
function sanitizeLayout(raw: unknown): Record<string, TouchSpot> {
  const out: Record<string, TouchSpot> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z]{2,12}$/.test(k) || !v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const n = (x: unknown, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : NaN);
    const spot = { x: n(o.x, 2, 98), y: n(o.y, 2, 98), s: n(o.s, 0.5, 2) };
    if (!Number.isNaN(spot.x) && !Number.isNaN(spot.y) && !Number.isNaN(spot.s)) out[k] = spot;
  }
  return out;
}

export const settingsStore = createStore<Settings>('wobble.settings', DEFAULT_GAME_SETTINGS, (raw) => {
  const r = (raw ?? {}) as Partial<Settings>;
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const bindings = { ...DEFAULT_BINDINGS };
  if (r.bindings && typeof r.bindings === 'object') {
    for (const k of Object.keys(DEFAULT_BINDINGS) as Action[]) {
      const b = (r.bindings as Record<string, unknown>)[k];
      if (Array.isArray(b) && b.every((x) => typeof x === 'string')) bindings[k] = b.slice(0, 3);
    }
    // Q used to double as reload; it now picks the previous gun.
    if (bindings.reload.join() === 'KeyR,KeyQ') bindings.reload = ['KeyR'];
  }
  return {
    controlMode: ['auto', 'touch', 'keyboard'].includes(r.controlMode as string) ? (r.controlMode as ControlMode) : 'auto',
    quality: ['auto', 'low', 'medium', 'high'].includes(r.quality as string) ? (r.quality as Quality) : 'auto',
    sfxVolume: num(r.sfxVolume, 0, 1, 0.7),
    musicVolume: num(r.musicVolume, 0, 1, 0.35),
    cameraSensitivity: num(r.cameraSensitivity, 0.5, 2, 1),
    touchScale: num(r.touchScale, 0.8, 1.3, 1),
    autoGas: r.autoGas === true,
    haptics: r.haptics !== false,
    voiceMode: r.voiceMode === 'open' ? 'open' : 'ptt',
    voiceVolume: num(r.voiceVolume, 0, 1.5, 1),
    touchLayout: sanitizeLayout(r.touchLayout),
    autoFullscreen: r.autoFullscreen !== false,
    showFps: r.showFps === true,
    bindings,
  };
});

// ------------------------------------------------------------------ profile

export interface Profile {
  name: string;
  appearance: Appearance;
}

export const profileStore = createStore<Profile>('wobble.profile', { name: '', appearance: DEFAULT_APPEARANCE }, (raw) => {
  const r = (raw ?? {}) as Partial<Profile>;
  const n = validateDisplayName(r.name);
  return { name: n.ok ? n.value : '', appearance: sanitizeAppearance(r.appearance) };
});
