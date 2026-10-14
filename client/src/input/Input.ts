// Device-aware input. Keyboard and touch both feed one shared InputState.
// Touch pointers are tracked individually so multi-touch works (steer +
// gas + nitro at once) and every pointer is released on cancel/blur.

import type { InputState } from '@wobble/shared';
import { settingsStore, type Action } from '../state/store';

export type InputMethod = 'keyboard' | 'touch';

const TOUCH_ACTIONS: Action[] = ['accelerate', 'brake', 'left', 'right', 'drift', 'nitro', 'fire', 'recover'];

class InputManager {
  private keys = new Set<string>();
  private pointers = new Map<number, Action>();
  private steer = 0;
  private listeners = new Set<() => void>();
  private pauseListeners = new Set<() => void>();
  enabled = false;
  lastMethod: InputMethod;
  hasKeyboardEvidence = false;
  readonly coarse: boolean;

  constructor() {
    this.coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
    this.lastMethod = this.coarse ? 'touch' : 'keyboard';
    if (typeof window === 'undefined') return;
    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.resetAll());
    window.addEventListener('pagehide', () => this.resetAll());
    window.addEventListener('orientationchange', () => this.resetAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.resetAll(); });
    // Detect most recently used method (hybrid devices)
    window.addEventListener('pointerdown', (e) => {
      this.setMethod(e.pointerType === 'touch' || e.pointerType === 'pen' ? 'touch' : this.lastMethod);
    }, { capture: true, passive: true });
  }

  private setMethod(m: InputMethod) {
    if (m !== this.lastMethod) {
      this.lastMethod = m;
      this.listeners.forEach((l) => l());
    }
  }

  onMethodChange(l: () => void) {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }
  onPause(l: () => void) {
    this.pauseListeners.add(l);
    return () => { this.pauseListeners.delete(l); };
  }

  private isTyping(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  private actionFor(code: string): Action | null {
    const b = settingsStore.get().bindings;
    for (const a of Object.keys(b) as Action[]) if (b[a].includes(code)) return a;
    return null;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.isTyping(e)) return;
    const a = this.actionFor(e.code);
    if (!a) return;
    this.hasKeyboardEvidence = true;
    this.setMethod('keyboard');
    if (!this.enabled) return;
    e.preventDefault();
    if (a === 'pause') {
      if (!e.repeat) this.pauseListeners.forEach((l) => l());
      return;
    }
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private keyAction(a: Action) {
    for (const k of settingsStore.get().bindings[a]) if (this.keys.has(k)) return true;
    return false;
  }

  private touchAction(a: Action) {
    for (const v of this.pointers.values()) if (v === a) return true;
    return false;
  }

  isDown(a: Action) {
    return this.keyAction(a) || this.touchAction(a);
  }

  // --- touch API used by <TouchControls/>
  pointerDown(id: number, a: Action) {
    if (!TOUCH_ACTIONS.includes(a)) return;
    this.pointers.set(id, a);
    this.setMethod('touch');
  }
  pointerMove(id: number, a: Action | null) {
    if (!this.pointers.has(id)) return;
    if (a) this.pointers.set(id, a);
  }
  pointerUp(id: number) {
    this.pointers.delete(id);
  }

  resetAll() {
    this.keys.clear();
    this.pointers.clear();
    this.steer = 0;
  }

  /** Sample the merged input. Steering from digital sources is ramped for smoothness. */
  sample(dt: number, out: InputState): InputState {
    if (!this.enabled) {
      out.steer = 0; out.throttle = 0; out.brake = 0;
      out.handbrake = out.nitro = out.fire = out.recover = false;
      return out;
    }
    const left = this.isDown('left'), right = this.isDown('right');
    const target = (right ? 1 : 0) - (left ? 1 : 0);
    const rate = target === 0 ? 10 : Math.sign(target) !== Math.sign(this.steer) ? 12 : 7;
    const d = target - this.steer;
    this.steer += Math.sign(d) * Math.min(Math.abs(d), rate * dt);
    const s = settingsStore.get();
    const brake = this.isDown('brake');
    out.steer = Math.max(-1, Math.min(1, this.steer));
    out.throttle = this.isDown('accelerate') || (s.autoGas && this.lastMethod === 'touch' && !brake) ? 1 : 0;
    out.brake = brake ? 1 : 0;
    out.handbrake = this.isDown('drift');
    out.nitro = this.isDown('nitro');
    out.fire = this.isDown('fire');
    out.recover = this.isDown('recover');
    return out;
  }

  /** Should the on-screen touch controls be shown right now? */
  wantsTouchUI() {
    const mode = settingsStore.get().controlMode;
    if (mode === 'touch') return true;
    if (mode === 'keyboard') return false;
    return this.lastMethod === 'touch';
  }
}

export const input = new InputManager();

export function haptic(ms: number) {
  if (!settingsStore.get().haptics) return;
  try {
    if (input.lastMethod === 'touch' && 'vibrate' in navigator) navigator.vibrate(ms);
  } catch { /* unsupported */ }
}
