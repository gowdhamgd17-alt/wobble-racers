// All sounds are synthesised at runtime with the Web Audio API (no audio files
// to download or license), layered to sound like the real thing:
//  - engine: per-vehicle cylinder count and rev range, a gearbox with
//    up-shifts, exhaust distortion, intake noise, turbo whistle, tyre squeal
//  - guns: supersonic crack + muzzle boom + low thump + room reverb, each of
//    the ten weapons with its own recipe, plus mechanical reload sounds
//  - impacts: bullet pings on metal, ricochets, metal crunches, explosions
//    with a delayed rumble that depends on distance
// To swap in recorded samples later, replace the bodies of the one-shots.

import { settingsStore } from '../state/store';

type Ctx = AudioContext;

interface EngineProfile { cyl: number; idle: number; max: number; gears: number; cutoff: number; drive: number; turbo: boolean; sub: number }
const PROFILES: Record<string, EngineProfile> = {
  speedster: { cyl: 6, idle: 1000, max: 8800, gears: 6, cutoff: 1.25, drive: 3.2, turbo: true, sub: 0.35 },
  formula: { cyl: 10, idle: 1800, max: 12500, gears: 7, cutoff: 1.6, drive: 2.6, turbo: false, sub: 0.2 },
  muscle: { cyl: 8, idle: 750, max: 6600, gears: 5, cutoff: 0.85, drive: 6, turbo: false, sub: 0.8 },
  drifter: { cyl: 4, idle: 950, max: 8000, gears: 6, cutoff: 1.1, drive: 3.5, turbo: true, sub: 0.4 },
  buggy: { cyl: 2, idle: 1100, max: 6500, gears: 5, cutoff: 1.0, drive: 4.5, turbo: false, sub: 0.5 },
  bruiser: { cyl: 8, idle: 700, max: 5600, gears: 5, cutoff: 0.75, drive: 5, turbo: false, sub: 0.9 },
  monster: { cyl: 8, idle: 650, max: 5200, gears: 4, cutoff: 0.65, drive: 7, turbo: false, sub: 1 },
  jeep: { cyl: 6, idle: 750, max: 5600, gears: 5, cutoff: 0.8, drive: 4, turbo: false, sub: 0.7 },
  pickup: { cyl: 8, idle: 700, max: 5400, gears: 5, cutoff: 0.75, drive: 5, turbo: true, sub: 0.85 },
  armored: { cyl: 6, idle: 600, max: 4200, gears: 5, cutoff: 0.6, drive: 6, turbo: true, sub: 1 },
};

class AudioSystem {
  ctx: Ctx | null = null;
  private sfx!: GainNode;
  private music!: GainNode;
  private reverb!: GainNode; // send bus into the convolver
  private noise!: AudioBuffer;
  private brown!: AudioBuffer;
  private engine: {
    osc1: OscillatorNode; osc2: OscillatorNode; osc3: OscillatorNode; shaper: WaveShaperNode; filter: BiquadFilterNode; gain: GainNode;
    intake: { src: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode };
    turbo: OscillatorNode; turboGain: GainNode;
  } | null = null;
  private squeal: { src: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private boost: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private road: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private flame: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private flameUntil = 0;
  private profile: EngineProfile = PROFILES.drifter;
  private gear = 1;
  private shiftT = 0;
  private rpm = 900;
  private voices: number[] = []; // recent gunshot start times (voice limiting)
  private musicTimer: number | null = null;
  private musicStep = 0;
  private nextNoteTime = 0;
  private musicMode: 'menu' | 'race' | 'off' = 'off';
  private curves = new Map<number, Float32Array>();

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
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    comp.connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(comp);
    this.music = ctx.createGain();
    this.music.connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    this.brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0), b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      d[i] = Math.random() * 2 - 1;
      last = (last + 0.02 * d[i]) / 1.02;
      b[i] = last * 3.5;
    }
    // Small outdoor-town reverb: decaying noise impulse with early reflections.
    const conv = ctx.createConvolver();
    const irLen = Math.floor(ctx.sampleRate * 1.6);
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      for (let i = 0; i < irLen; i++) {
        const t = i / ctx.sampleRate;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 3) * (t < 0.08 ? 0.5 : 0.3);
      }
      for (const e of [0.023, 0.041, 0.067, 0.11]) data[Math.floor(e * ctx.sampleRate) + ch * 37] += 0.6;
    }
    conv.buffer = ir;
    this.reverb = ctx.createGain();
    this.reverb.gain.value = 0.35;
    this.reverb.connect(conv).connect(comp);
    this.applyVolumes();
    if (this.musicMode !== 'off') this.startMusicLoop();
    // Voices load asynchronously in some browsers.
    try {
      // iOS only lets pages speak after a tap: prime the speech engine silently now.
      const prime = new SpeechSynthesisUtterance(' ');
      prime.volume = 0;
      window.speechSynthesis?.speak(prime);
      this.pickVoice();
      window.speechSynthesis?.addEventListener?.('voiceschanged', () => this.pickVoice());
    } catch { /* no speech support */ }
  }

  private applyVolumes() {
    if (!this.ctx) return;
    const s = settingsStore.get();
    this.sfx.gain.value = s.sfxVolume;
    this.music.gain.value = s.musicVolume * 0.4;
  }

  private curve(amount: number) {
    let c = this.curves.get(amount);
    if (!c) {
      c = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) {
        const x = (i / 1023) * 2 - 1;
        c[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
      }
      this.curves.set(amount, c);
    }
    return c;
  }

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private out(node: AudioNode, wet = 0) {
    node.connect(this.sfx);
    if (wet > 0) {
      const g = this.ctx!.createGain();
      g.gain.value = wet;
      node.connect(g).connect(this.reverb);
    }
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol = 0.3, delay = 0, wet = 0, dest?: AudioNode) {
    const ctx = this.ctx;
    if (!ctx || vol <= 0.001) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    this.env(g, t, vol, 0.004, dur);
    o.connect(g);
    if (dest) g.connect(dest); else this.out(g, wet);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private burst(dur: number, vol: number, filterType: BiquadFilterType, f0: number, f1: number, delay = 0, opts: { q?: number; wet?: number; brown?: boolean; attack?: number } = {}) {
    const ctx = this.ctx;
    if (!ctx || vol <= 0.001) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = opts.brown ? this.brown : this.noise;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.Q.value = opts.q ?? 0.7;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    this.env(g, t, vol, opts.attack ?? 0.002, dur);
    src.connect(f).connect(g);
    this.out(g, opts.wet ?? 0);
    src.start(t, Math.random() * 1.2);
    src.stop(t + dur + 0.05);
  }

  private loopNoise(type: BiquadFilterType, freq: number, q: number, brown = false) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = brown ? this.brown : this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.sfx);
    src.start(0, Math.random());
    return { src, gain, filter };
  }

  // ---------------------------------------------------------- engine
  setEngineProfile(carClass: string) {
    this.profile = PROFILES[carClass] ?? PROFILES.drifter;
    if (this.engine) this.engine.shaper.curve = this.curve(this.profile.drive);
  }

  startEngine() {
    if (!this.ctx || this.engine) return;
    const ctx = this.ctx;
    const osc1 = ctx.createOscillator(); // firing pulses
    const osc2 = ctx.createOscillator(); // sub-harmonic rumble
    const osc3 = ctx.createOscillator(); // second harmonic (valve / exhaust rasp)
    osc1.type = 'sawtooth';
    osc2.type = 'triangle';
    osc3.type = 'square';
    const mix1 = ctx.createGain(), mix2 = ctx.createGain(), mix3 = ctx.createGain();
    mix1.gain.value = 0.6;
    mix2.gain.value = 0.5;
    mix3.gain.value = 0.12;
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.curve(this.profile.drive);
    shaper.oversample = '2x';
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 2.2;
    filter.frequency.value = 600;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc1.connect(mix1).connect(shaper);
    osc2.connect(mix2).connect(shaper);
    osc3.connect(mix3).connect(shaper);
    shaper.connect(filter).connect(gain).connect(this.sfx);
    osc1.start();
    osc2.start();
    osc3.start();
    const intake = this.loopNoise('bandpass', 400, 1.5);
    const turbo = ctx.createOscillator();
    turbo.type = 'sine';
    turbo.frequency.value = 2000;
    const turboGain = ctx.createGain();
    turboGain.gain.value = 0;
    turbo.connect(turboGain).connect(this.sfx);
    turbo.start();
    this.engine = { osc1, osc2, osc3, shaper, filter, gain, intake, turbo, turboGain };
    this.squeal = this.loopNoise('bandpass', 1900, 14);
    this.boost = this.loopNoise('highpass', 1800, 0.7);
    this.road = this.loopNoise('lowpass', 300, 0.8, true);
    this.gear = 1;
  }

  /** speed01 = speed / max speed. */
  updateEngine(speed01: number, throttle: number, drifting: boolean, boosting: boolean, active: boolean) {
    if (!this.ctx || !this.engine) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const P = this.profile;
    // Gearbox: each gear covers a slice of the speed range; shift up near the redline.
    const tops: number[] = [];
    for (let g = 1; g <= P.gears; g++) tops.push(Math.pow(g / P.gears, 0.8) * 1.02);
    let gear = 1;
    while (gear < P.gears && speed01 > tops[gear - 1]) gear++;
    const lo = gear === 1 ? 0 : tops[gear - 2], hi = tops[gear - 1];
    const inGear = Math.max(0, Math.min(1, (speed01 - lo) / (hi - lo)));
    let target = gear === 1 ? P.idle + inGear * (P.max - P.idle) : P.max * 0.55 + inGear * P.max * 0.45;
    if (speed01 < 0.04) target = P.idle + throttle * (P.max * 0.35); // revving on the spot
    target += throttle * 250;
    if (gear !== this.gear) {
      if (gear > this.gear && throttle > 0.3) {
        this.shiftT = t + 0.09;
        // shift "blip": exhaust crackle as the throttle lifts
        this.burst(0.05, 0.08, 'bandpass', 1400, 600, 0.02, { q: 2 });
        if (P.turbo) this.burst(0.25, 0.05, 'highpass', 5000, 2500, 0.01); // blow-off valve
      }
      this.gear = gear;
    }
    const shifting = t < this.shiftT;
    this.rpm += (target - this.rpm) * (shifting ? 0.08 : 0.25);
    const fire = (this.rpm / 60) * (P.cyl / 2);
    const e = this.engine;
    e.osc1.frequency.setTargetAtTime(fire, t, 0.03);
    e.osc2.frequency.setTargetAtTime(fire / 2, t, 0.03);
    e.osc3.frequency.setTargetAtTime(fire * 2.01, t, 0.03);
    const r01 = this.rpm / P.max;
    e.filter.frequency.setTargetAtTime((250 + r01 * 1600 + throttle * 900) * P.cutoff, t, 0.05);
    const load = shifting ? 0.35 : 0.55 + throttle * 0.45;
    e.gain.gain.setTargetAtTime(active ? (0.045 + r01 * 0.05) * load * (1 + P.sub * 0.3) : 0, t, 0.05);
    e.intake.filter.frequency.setTargetAtTime(fire * 2.2, t, 0.05);
    e.intake.gain.gain.setTargetAtTime(active ? throttle * 0.035 * (0.4 + r01) : 0, t, 0.06);
    e.turbo.frequency.setTargetAtTime(1800 + r01 * 3200, t, 0.2);
    e.turboGain.gain.setTargetAtTime(active && P.turbo ? throttle * r01 * 0.012 : 0, t, 0.3);
    this.squeal!.gain.gain.setTargetAtTime(active && drifting ? 0.06 : 0, t, 0.05);
    this.squeal!.filter.frequency.setTargetAtTime(1700 + Math.sin(t * 13) * 180 + speed01 * 400, t, 0.02);
    this.boost!.gain.gain.setTargetAtTime(active && boosting ? 0.1 : 0, t, 0.08);
    this.road!.gain.gain.setTargetAtTime(active ? speed01 * 0.12 : 0, t, 0.2);
    if (this.flame) this.flame.gain.gain.setTargetAtTime(t < this.flameUntil ? 0.16 : 0, t, 0.04);
  }

  stopEngine() {
    const stop = (n: { stop: () => void } | undefined) => { try { n?.stop(); } catch { /* ignore */ } };
    if (this.engine) {
      const e = this.engine;
      [e.osc1, e.osc2, e.osc3, e.turbo, e.intake.src].forEach(stop);
    }
    stop(this.squeal?.src);
    stop(this.boost?.src);
    stop(this.road?.src);
    stop(this.flame?.src);
    this.engine = null;
    this.squeal = null;
    this.boost = null;
    this.road = null;
    this.flame = null;
  }

  // ---------------------------------------------------------- weapons
  /** One shot of the given weapon. vol 0..1 already includes distance falloff. */
  gunshot(id: string, vol = 1) {
    const ctx = this.ctx;
    if (!ctx || vol <= 0.02) return;
    const now = ctx.currentTime;
    this.voices = this.voices.filter((v) => now - v < 0.1);
    if (this.voices.length > 10 && vol < 0.9) return;
    this.voices.push(now);
    // Air absorption: distant shots lose their highs and arrive a touch later.
    const air = 1500 + vol * 12000;
    const late = (1 - vol) * 0.12;
    const wet = 0.25 + (1 - vol) * 0.5;
    const v = vol;
    const crack = (amp: number, dur = 0.012) => this.burst(dur, amp * v, 'highpass', Math.min(air, 4000), Math.min(air, 2500), late, { wet: wet * 0.6 });
    const boom = (amp: number, f0: number, f1: number, dur: number) => this.burst(dur, amp * v, 'lowpass', Math.min(air, f0), f1, late, { wet, attack: 0.001 });
    const thump = (amp: number, f0: number, f1: number, dur: number) => this.tone('sine', f0, f1, dur, amp * v, late, wet * 0.5);
    const click = (amp: number, f: number, d: number) => { this.burst(0.02, amp * v, 'bandpass', f, f * 0.8, d, { q: 6 }); this.tone('square', f * 0.6, f * 0.4, 0.02, amp * 0.4 * v, d); };
    switch (id) {
      case 'pistol':
        crack(0.55); boom(0.55, 3200, 380, 0.13); thump(0.4, 170, 55, 0.1);
        break;
      case 'smg':
        crack(0.35, 0.008); boom(0.38, 2600, 350, 0.07); thump(0.25, 180, 70, 0.06);
        break;
      case 'm4':
        crack(0.6); boom(0.55, 3800, 300, 0.15); thump(0.45, 150, 48, 0.12);
        this.burst(0.06, 0.08 * v, 'bandpass', 3200, 2800, late, { q: 9 }); // metallic ring of the action
        break;
      case 'shotgun':
        crack(0.7, 0.02); boom(0.8, 2200, 140, 0.38); thump(0.8, 115, 38, 0.3);
        click(0.25, 1800, 0.38); click(0.3, 1300, 0.5); // pump: chk-chk
        break;
      case 'minigun':
        crack(0.25, 0.006); boom(0.28, 3000, 400, 0.05); thump(0.18, 160, 80, 0.04);
        this.tone('sawtooth', 320, 300, 0.06, 0.03 * v, 0); // motor whine
        break;
      case 'sniper':
        crack(1.0, 0.025); boom(0.9, 4200, 180, 0.6); thump(1.0, 95, 28, 0.45);
        this.burst(1.2, 0.15 * v, 'lowpass', 600, 80, late + 0.05, { wet: 1, brown: true }); // rolling echo
        click(0.25, 2200, 0.55); click(0.25, 1600, 0.75); // bolt cycle
        break;
      case 'rocket':
        this.burst(0.7, 0.45 * v, 'bandpass', 500, 2600, late, { q: 1.2, wet }); // whoosh
        boom(0.5, 1500, 120, 0.25); thump(0.6, 90, 35, 0.3);
        break;
      case 'grenade':
        thump(0.7, 230, 85, 0.13); boom(0.35, 900, 150, 0.12); click(0.2, 1500, 0.08);
        break;
      case 'flamer':
        if (!this.flame) this.flame = this.loopNoise('lowpass', 900, 0.9, false);
        this.flameUntil = now + 0.14;
        this.flame.gain.gain.setTargetAtTime(0.16 * Math.max(0.3, v), now, 0.03);
        if (Math.random() < 0.3) this.burst(0.03, 0.06 * v, 'bandpass', 2500, 1500, 0, { q: 3 }); // crackle
        break;
      case 'homing':
        this.burst(0.8, 0.4 * v, 'bandpass', 700, 3000, late, { q: 1.4, wet });
        thump(0.5, 110, 40, 0.25);
        this.tone('square', 1400, 1400, 0.05, 0.06 * v, 0.05); this.tone('square', 1900, 1900, 0.05, 0.06 * v, 0.14); // lock beeps
        break;
      default:
        crack(0.5); boom(0.5, 3000, 300, 0.12);
    }
  }

  /** Magazine out (start of a reload). */
  reload(id: string, vol = 1) {
    if (!this.ctx) return;
    const click = (f: number, d: number, a = 0.22) => { this.burst(0.025, a * vol, 'bandpass', f, f * 0.85, d, { q: 5 }); this.tone('triangle', f * 0.5, f * 0.35, 0.025, a * 0.4 * vol, d); };
    if (id === 'shotgun') { for (let i = 0; i < 4; i++) click(1100 + i * 40, 0.15 + i * 0.45, 0.2); return; }
    if (id === 'rocket' || id === 'homing') { this.burst(0.18, 0.2 * vol, 'lowpass', 600, 120, 0, {}); click(700, 0.25, 0.3); return; }
    if (id === 'flamer') { this.burst(0.5, 0.12 * vol, 'highpass', 3000, 1500, 0.05); click(900, 0.6); return; }
    click(1700, 0); // release
    this.burst(0.08, 0.12 * vol, 'bandpass', 1200, 700, 0.06, { q: 2 }); // mag slides out
    this.burst(0.15, 0.05 * vol, 'lowpass', 800, 300, 0.2); // pouch rustle
  }

  /** Magazine in + charging handle (end of a reload). */
  reloaded(id: string, vol = 1) {
    if (!this.ctx) return;
    const click = (f: number, d: number, a = 0.25) => { this.burst(0.03, a * vol, 'bandpass', f, f * 0.8, d, { q: 5 }); this.tone('square', f * 0.45, f * 0.3, 0.03, a * 0.35 * vol, d); };
    if (id === 'flamer') { this.tone('sine', 300, 900, 0.3, 0.06 * vol); this.burst(0.3, 0.1 * vol, 'lowpass', 1500, 400, 0.1); return; }
    if (id === 'rocket' || id === 'homing' || id === 'grenade') { click(600, 0, 0.35); click(1200, 0.12); return; }
    click(900, 0, 0.32); // mag seated: clack
    click(1900, 0.16); // charging handle back...
    click(1500, 0.24, 0.3); // ...and forward
  }

  dryFire() { this.burst(0.02, 0.18, 'bandpass', 2400, 2000, 0, { q: 8 }); }

  /** Bullet striking a car body. */
  metalHit(vol = 1, dmg = 10) {
    if (!this.ctx) return;
    const f = 1800 + Math.random() * 2400;
    this.burst(0.04, 0.3 * vol, 'bandpass', 4500, 2500, 0, { q: 3 });
    this.tone('sine', f, f * 0.96, 0.12 + Math.random() * 0.08, 0.06 * vol);
    if (dmg > 30) this.tone('sine', 140, 50, 0.15, 0.3 * vol);
  }
  hit() { this.metalHit(1, 20); }

  ricochet(vol = 1) {
    const f = 2400 + Math.random() * 1500;
    this.tone('sine', f, f * 0.45, 0.28, 0.06 * vol, 0, 0.4);
    this.burst(0.03, 0.1 * vol, 'highpass', 3500, 2500);
  }

  /** A bullet passing close by. */
  whiz(vol = 1) {
    this.burst(0.12, 0.12 * vol, 'bandpass', 5000, 1800, 0, { q: 4, attack: 0.03 });
  }

  bounce(vol = 1) { this.tone('triangle', 900 + Math.random() * 300, 600, 0.06, 0.08 * vol); this.burst(0.03, 0.06 * vol, 'bandpass', 1500, 800); }

  crash(strength: number, vol = 1) {
    if (!this.ctx) return;
    const v = Math.min(0.7, 0.15 + strength * 0.018) * vol;
    // metal crunch: a cluster of short filtered bursts + body thud
    for (let i = 0; i < 4; i++) this.burst(0.06 + Math.random() * 0.08, v * (1 - i * 0.18), 'bandpass', 900 + Math.random() * 1500, 300, i * 0.025 + Math.random() * 0.02, { q: 1.5, wet: 0.3 });
    this.burst(0.3 + Math.min(0.3, strength * 0.01), v * 0.7, 'lowpass', 1600, 90, 0, { brown: true });
    this.tone('sine', 120, 40, 0.22, v * 0.7);
    if (strength > 18) for (let i = 0; i < 5; i++) this.tone('sine', 3000 + Math.random() * 3000, 2500, 0.05, 0.03 * vol, 0.05 + Math.random() * 0.25); // glass / debris tinkle
  }

  /** Explosion: initial bang, then a rumble that arrives later the further away it is. */
  blast(vol = 1, size = 1) {
    if (!this.ctx || vol <= 0.02) return;
    const late = (1 - vol) * 0.35;
    const s = Math.min(1.6, size);
    this.burst(0.03, 0.9 * vol, 'highpass', 2000 + vol * 6000, 1000, late);
    this.burst(1.4 * s, 0.9 * vol, 'lowpass', 600 + vol * 1800, 40, late, { brown: true, wet: 0.6 });
    this.tone('sine', 85, 24, 0.9 * s, 0.9 * vol, late, 0.3);
    this.tone('sine', 55, 20, 1.2 * s, 0.6 * vol, late + 0.02);
    // crackle and falling debris
    for (let i = 0; i < 8; i++) this.burst(0.02 + Math.random() * 0.04, 0.12 * vol, 'bandpass', 1500 + Math.random() * 2500, 800, late + 0.1 + Math.random() * 0.8, { q: 2 });
  }
  explode() { this.blast(1, 1.2); }

  pickup(vol = 1) {
    this.reloaded('m4', vol);
    [660, 990, 1320].forEach((f, i) => this.tone('triangle', f, f, 0.1, 0.1 * vol, 0.15 + i * 0.06));
  }

  repair(vol = 1) {
    for (let i = 0; i < 5; i++) this.burst(0.02, 0.15 * vol, 'bandpass', 2600, 2200, i * 0.07, { q: 6 }); // ratchet
    [523, 659, 784, 1046].forEach((f, i) => this.tone('sine', f, f, 0.14, 0.12 * vol, 0.35 + i * 0.07));
    this.burst(0.4, 0.06 * vol, 'highpass', 3000, 6000, 0.3);
  }

  // ---------------------------------------------------------- voice-over
  private voice: SpeechSynthesisVoice | null = null;
  private voiceLang = '';
  private pickVoice() {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!synth) return;
    const voices = synth.getVoices();
    if (!voices.length) return;
    const by = (pre: string) => voices.find((v) => v.lang?.toLowerCase().startsWith(pre));
    // Tamil voice says சாவு natively; Hindi reads सावू the same way; otherwise English.
    const v = by('ta') ?? by('hi') ?? by('en-in') ?? voices.find((x) => /male|david|daniel|alex|fred/i.test(x.name) && x.lang?.startsWith('en')) ?? by('en') ?? voices[0];
    this.voice = v ?? null;
    this.voiceLang = v?.lang?.toLowerCase() ?? '';
  }

  /** Announcer voice: "Saavu!" (Web Speech API, with a synthesised fallback). */
  sayDeath() {
    const vol = settingsStore.get().sfxVolume;
    if (vol <= 0) return;
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!this.voice) this.pickVoice();
    if (synth && this.voice) {
      try {
        synth.cancel();
        const text = this.voiceLang.startsWith('ta') ? 'சாவு!' : this.voiceLang.startsWith('hi') ? 'सावू!' : 'Saavu!';
        const u = new SpeechSynthesisUtterance(text);
        u.voice = this.voice;
        u.lang = this.voice.lang;
        u.rate = 0.8;
        u.pitch = 0.55; // deep announcer
        u.volume = Math.min(1, vol * 1.4);
        synth.speak(u);
        return;
      } catch {
        /* fall through to the synthesised voice */
      }
    }
    this.formantSaavu();
  }

  /** Tiny formant synthesiser: "s" + "aa" + "v" + "oo", for browsers without speech. */
  private formantSaavu() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.02;
    this.burst(0.16, 0.25, 'highpass', 5500, 4500, 0.02); // "s"
    const glottal = ctx.createOscillator();
    glottal.type = 'sawtooth';
    glottal.frequency.setValueAtTime(115, t0 + 0.14);
    glottal.frequency.linearRampToValueAtTime(95, t0 + 0.75);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t0);
    out.gain.setValueAtTime(0.0001, t0 + 0.14);
    out.gain.exponentialRampToValueAtTime(0.9, t0 + 0.2);
    out.gain.setValueAtTime(0.9, t0 + 0.42);
    out.gain.exponentialRampToValueAtTime(0.35, t0 + 0.47); // "v" dip
    out.gain.exponentialRampToValueAtTime(0.8, t0 + 0.52);
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.85);
    // formant bank: "aa" (800 / 1200 Hz) gliding to "oo" (320 / 800 Hz)
    const formants: [number, number, number][] = [[800, 320, 1], [1200, 800, 0.6], [2600, 2300, 0.25]];
    for (const [fa, fu, g] of formants) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 8;
      bp.frequency.setValueAtTime(fa, t0 + 0.14);
      bp.frequency.setValueAtTime(fa, t0 + 0.42);
      bp.frequency.exponentialRampToValueAtTime(fu, t0 + 0.55);
      const gg = ctx.createGain();
      gg.gain.value = g * 1.6;
      glottal.connect(bp).connect(gg).connect(out);
    }
    this.out(out, 0.4);
    glottal.start(t0 + 0.14);
    glottal.stop(t0 + 0.9);
  }

  /** The killer's "Saavu!" sting. */
  saavu() {
    this.sayDeath();
    this.tone('sine', 70, 30, 0.7, 0.6);
    this.burst(0.5, 0.25, 'lowpass', 2000, 100, 0, { brown: true, wet: 0.5 });
    [392, 523, 659, 784].forEach((f) => this.tone('sawtooth', f, f, 0.6, 0.05, 0.1, 0.6));
    this.tone('square', 1568, 1568, 0.08, 0.08, 0.1);
    this.tone('square', 2093, 2093, 0.18, 0.08, 0.2);
  }

  // ---------------------------------------------------------- ui / race one-shots
  click() { this.tone('square', 660, 880, 0.05, 0.12); }
  shoot() { this.gunshot('m4'); }
  land() { this.burst(0.14, 0.25, 'lowpass', 700, 80, 0, { brown: true }); this.tone('sine', 90, 40, 0.12, 0.2); }
  pad() { this.tone('sine', 400, 1200, 0.25, 0.2); this.burst(0.3, 0.15, 'highpass', 3000, 6000); }
  respawn() { [523, 659, 784, 1046].forEach((f, i) => this.tone('triangle', f, f, 0.12, 0.15, i * 0.07)); }
  countdownBeep(go: boolean) { this.tone('square', go ? 880 : 440, go ? 880 : 440, go ? 0.45 : 0.18, 0.18); }
  lap() { [660, 880].forEach((f, i) => this.tone('square', f, f, 0.1, 0.12, i * 0.09)); }
  victory() {
    [523, 659, 784, 1046, 784, 1046, 1318].forEach((f, i) => this.tone('square', f, f, 0.16, 0.14, i * 0.12));
  }
  honk() { this.tone('square', 392, 392, 0.22, 0.12); this.tone('square', 494, 494, 0.22, 0.1); }

  // ---------------------------------------------------------- background music
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
      if (lead[i] >= 0 && bar % 2 === 1) note(lead[i], 'square', 0.05, stepDur * 1.6);
      if (race && i % 4 === 0) {
        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.1, t);
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
