// All sounds are synthesised at runtime with the Web Audio API, so there are
// no external audio assets to license. To swap in recorded samples later,
// replace the bodies of the play* methods with AudioBufferSourceNodes.

import { settingsStore } from '../state/store';

type Ctx = AudioContext;

class AudioSystem {
  ctx: Ctx | null = null;
  private sfx!: GainNode;
  private music!: GainNode;
  private noise!: AudioBuffer;
  private engine: { osc1: OscillatorNode; osc2: OscillatorNode; filter: BiquadFilterNode; gain: GainNode } | null = null;
  private squeal: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private boost: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private musicTimer: number | null = null;
  private musicStep = 0;
  private nextNoteTime = 0;
  private musicMode: 'menu' | 'race' | 'off' = 'off';

  constructor() {
    if (typeof window === 'undefined') return;
    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    settingsStore.subscribe(() => this.applyVolumes());
  }

  /** Browsers only allow audio after a user gesture. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.sfx = ctx.createGain();
    this.music = ctx.createGain();
    this.sfx.connect(ctx.destination);
    this.music.connect(ctx.destination);
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.applyVolumes();
    if (this.musicMode !== 'off') this.startMusicLoop();
  }

  private applyVolumes() {
    if (!this.ctx) return;
    const s = settingsStore.get();
    this.sfx.gain.value = s.sfxVolume;
    this.music.gain.value = s.musicVolume * 0.5;
  }

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol = 0.3, delay = 0, dest?: AudioNode) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    this.env(g, t, vol, 0.01, dur);
    o.connect(g).connect(dest ?? this.sfx);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private burst(dur: number, vol: number, filterType: BiquadFilterType, f0: number, f1: number, delay = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    this.env(g, t, vol, 0.005, dur);
    src.connect(f).connect(g).connect(this.sfx);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  private loopNoise(type: BiquadFilterType, freq: number, q: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(f).connect(gain).connect(this.sfx);
    src.start();
    return { src, gain };
  }

  // ---------------------------------------------------------- gameplay loops
  startEngine() {
    if (!this.ctx || this.engine) return;
    const ctx = this.ctx;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc2.type = 'square';
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 600;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain).connect(this.sfx);
    osc1.start();
    osc2.start();
    this.engine = { osc1, osc2, filter, gain };
    this.squeal = this.loopNoise('bandpass', 2400, 8);
    this.boost = this.loopNoise('highpass', 1800, 0.7);
  }

  updateEngine(speed01: number, throttle: number, drifting: boolean, boosting: boolean, active: boolean) {
    if (!this.ctx || !this.engine) return;
    const t = this.ctx.currentTime;
    const base = 55 + speed01 * 150 + throttle * 20;
    this.engine.osc1.frequency.setTargetAtTime(base, t, 0.05);
    this.engine.osc2.frequency.setTargetAtTime(base * 0.5 + 3, t, 0.05);
    this.engine.filter.frequency.setTargetAtTime(300 + speed01 * 1500 + throttle * 400, t, 0.08);
    this.engine.gain.gain.setTargetAtTime(active ? 0.05 + throttle * 0.04 : 0, t, 0.1);
    this.squeal!.gain.gain.setTargetAtTime(active && drifting ? 0.07 : 0, t, 0.05);
    this.boost!.gain.gain.setTargetAtTime(active && boosting ? 0.12 : 0, t, 0.08);
  }

  stopEngine() {
    if (!this.engine) return;
    const stop = (n: { stop: () => void }) => { try { n.stop(); } catch { /* ignore */ } };
    stop(this.engine.osc1);
    stop(this.engine.osc2);
    if (this.squeal) stop(this.squeal.src);
    if (this.boost) stop(this.boost.src);
    this.engine = null;
    this.squeal = null;
    this.boost = null;
  }

  // ---------------------------------------------------------- one-shots
  click() { this.tone('square', 660, 880, 0.05, 0.12); }
  shoot() { this.tone('square', 900, 180, 0.12, 0.15); }
  hit() { this.burst(0.15, 0.4, 'bandpass', 2000, 500); this.tone('triangle', 300, 90, 0.15, 0.2); }
  crash(strength: number) {
    const v = Math.min(0.6, 0.15 + strength * 0.015);
    this.burst(0.25 + Math.min(0.25, strength * 0.01), v, 'lowpass', 2500, 120);
    this.tone('sine', 120, 45, 0.2, v * 0.6);
  }
  explode() {
    this.burst(0.9, 0.7, 'lowpass', 1800, 40);
    this.tone('sawtooth', 160, 30, 0.6, 0.3);
  }
  land() { this.burst(0.12, 0.2, 'lowpass', 600, 80); }
  pad() { this.tone('sine', 400, 1200, 0.25, 0.2); this.burst(0.3, 0.15, 'highpass', 3000, 6000); }
  respawn() { [523, 659, 784, 1046].forEach((f, i) => this.tone('triangle', f, f, 0.12, 0.15, i * 0.07)); }
  countdownBeep(go: boolean) { this.tone('square', go ? 880 : 440, go ? 880 : 440, go ? 0.45 : 0.18, 0.18); }
  lap() { [660, 880].forEach((f, i) => this.tone('square', f, f, 0.1, 0.12, i * 0.09)); }
  victory() {
    [523, 659, 784, 1046, 784, 1046, 1318].forEach((f, i) => this.tone('square', f, f, 0.16, 0.14, i * 0.12));
  }
  honk() { this.tone('square', 392, 392, 0.18, 0.12); this.tone('square', 494, 494, 0.18, 0.1); }

  // ---------------------------------------------------------- tiny chiptune
  setMusic(mode: 'menu' | 'race' | 'off') {
    if (mode === this.musicMode) return;
    this.musicMode = mode;
    if (mode === 'off') this.stopMusicLoop();
    else if (this.ctx) this.startMusicLoop();
  }

  private startMusicLoop() {
    this.stopMusicLoop();
    if (!this.ctx) return;
    this.nextNoteTime = this.ctx.currentTime + 0.1;
    this.musicStep = 0;
    this.musicTimer = window.setInterval(() => this.scheduleMusic(), 50);
  }

  private stopMusicLoop() {
    if (this.musicTimer !== null) clearInterval(this.musicTimer);
    this.musicTimer = null;
  }

  private scheduleMusic() {
    const ctx = this.ctx;
    if (!ctx) return;
    const race = this.musicMode === 'race';
    const stepDur = race ? 0.13 : 0.18;
    // Original 16-step patterns (semitones from A2)
    const bass = race ? [0, 0, 12, 0, 3, 3, 15, 3, 5, 5, 17, 5, 7, 7, 19, 10] : [0, -1, 0, 7, 5, -1, 3, -1, 0, -1, 0, 7, 10, -1, 7, -1];
    const lead = race ? [24, -1, 27, 29, -1, 31, 29, 27, 24, -1, 22, 24, -1, -1, 19, -1] : [19, -1, -1, 22, -1, 24, -1, -1, 22, -1, 19, -1, 17, -1, 15, -1];
    while (this.nextNoteTime < ctx.currentTime + 0.25) {
      const i = this.musicStep % 16;
      const bar = Math.floor(this.musicStep / 16) % 4;
      const shift = [0, 0, 5, 3][bar];
      const t = this.nextNoteTime;
      const note = (semi: number, type: OscillatorType, vol: number, dur: number) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = type;
        o.frequency.value = 110 * Math.pow(2, (semi + shift) / 12);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(this.music);
        o.start(t);
        o.stop(t + dur + 0.02);
      };
      if (bass[i] >= 0) note(bass[i], 'triangle', 0.25, stepDur * 0.9);
      if (lead[i] >= 0 && bar % 2 === 1) note(lead[i], 'square', 0.06, stepDur * 1.6);
      if (race && i % 4 === 0) {
        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.12, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
        const f = ctx.createBiquadFilter();
        f.type = 'highpass';
        f.frequency.value = 7000;
        src.connect(f).connect(g).connect(this.music);
        src.start(t);
        src.stop(t + 0.06);
      }
      this.nextNoteTime += stepDur;
      this.musicStep++;
    }
  }
}

export const audio = new AudioSystem();
