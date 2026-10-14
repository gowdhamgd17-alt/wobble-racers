// Input manager tests (spec items 15-17): simultaneous touches, keyboard
// independence, and resets on focus loss / pause / cancel.
import { beforeEach, describe, expect, it } from 'vitest';
import { NEUTRAL_INPUT, type InputState } from '@wobble/shared';
import { input } from '../src/input/Input';
import { settingsStore, DEFAULT_GAME_SETTINGS } from '../src/state/store';

const out = (): InputState => ({ ...NEUTRAL_INPUT });
const key = (type: 'keydown' | 'keyup', code: string) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
const settle = () => { const o = out(); for (let i = 0; i < 30; i++) input.sample(1 / 30, o); return o; };

beforeEach(() => {
  settingsStore.set({ ...DEFAULT_GAME_SETTINGS });
  input.enabled = true;
  input.resetAll();
});

describe('touch controls', () => {
  it('supports simultaneous multi-touch (steer + gas + nitro + fire)', () => {
    input.pointerDown(1, 'left');
    input.pointerDown(2, 'accelerate');
    input.pointerDown(3, 'nitro');
    input.pointerDown(4, 'fire');
    const o = settle();
    expect(o.steer).toBe(-1);
    expect(o.throttle).toBe(1);
    expect(o.nitro).toBe(true);
    expect(o.fire).toBe(true);
  });
  it('releasing one finger only releases that action', () => {
    input.pointerDown(1, 'right');
    input.pointerDown(2, 'accelerate');
    input.pointerUp(2);
    const o = settle();
    expect(o.steer).toBe(1);
    expect(o.throttle).toBe(0);
  });
  it('a finger can slide from left to right', () => {
    input.pointerDown(7, 'left');
    input.pointerMove(7, 'right');
    expect(settle().steer).toBe(1);
  });
});

describe('keyboard', () => {
  it('works independently of touch and merges with it', () => {
    key('keydown', 'KeyW');
    key('keydown', 'KeyD');
    let o = settle();
    expect(o.throttle).toBe(1);
    expect(o.steer).toBe(1);
    input.pointerDown(9, 'nitro');
    key('keyup', 'KeyW');
    o = settle();
    expect(o.throttle).toBe(0);
    expect(o.nitro).toBe(true);
    expect(o.steer).toBe(1);
  });
  it('respects remapped bindings', () => {
    settingsStore.set({ bindings: { ...DEFAULT_GAME_SETTINGS.bindings, fire: ['KeyK'] } });
    key('keydown', 'KeyK');
    expect(settle().fire).toBe(true);
    key('keyup', 'KeyK');
    key('keydown', 'KeyF');
    expect(settle().fire).toBe(false);
  });
  it('steering ramps smoothly rather than snapping', () => {
    key('keydown', 'KeyA');
    const o = out();
    input.sample(1 / 30, o);
    expect(o.steer).toBeLessThan(0);
    expect(o.steer).toBeGreaterThan(-1);
  });
});

describe('stuck-input prevention', () => {
  it('window blur releases everything', () => {
    key('keydown', 'KeyW');
    input.pointerDown(1, 'left');
    window.dispatchEvent(new Event('blur'));
    const o = settle();
    expect(o.throttle).toBe(0);
    expect(o.steer).toBe(0);
  });
  it('orientation change and page hide release everything', () => {
    input.pointerDown(1, 'accelerate');
    window.dispatchEvent(new Event('orientationchange'));
    expect(settle().throttle).toBe(0);
    key('keydown', 'KeyS');
    window.dispatchEvent(new Event('pagehide'));
    expect(settle().brake).toBe(0);
  });
  it('disabled input (paused/menus) yields neutral input', () => {
    key('keydown', 'KeyW');
    input.enabled = false;
    expect(settle()).toMatchObject({ throttle: 0, steer: 0, nitro: false });
  });
  it('a cancelled pointer releases its action', () => {
    input.pointerDown(3, 'brake');
    input.pointerUp(3); // pointercancel / lostpointercapture call the same path
    expect(settle().brake).toBe(0);
  });
  it('typing in a text field does not drive the car', () => {
    const el = document.createElement('input');
    document.body.appendChild(el);
    el.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    expect(settle().throttle).toBe(0);
  });
});
