// The in-race engine: Three.js scene, fixed-step local prediction with
// server reconciliation, interpolation of remote cars, effects, camera,
// audio hooks and HUD data. React only hosts the canvas and draws the HUD.

import * as THREE from 'three';
import {
  MSG, NEUTRAL_INPUT, autopilot, Phase, RacerStatus, SIM_DT, WEAPON, cloneVehicleState, createVehicleState, damageState,
  encodeInput, findSafeSpot, getTrack, getVehicle, obbOverlap, placeOnTrack, queryTrack, stepVehicle, colorHex, trackKey,
  type FxMessage, type InputState, type Track, type VehicleState,
} from '@wobble/shared';
import { net } from '../net/Net';
import { input, haptic } from '../input/Input';
import { audio } from '../audio/Audio';
import { settingsStore, type Quality } from '../state/store';
import { buildCar, CharacterAnimator, disposeCar, environmentFor, makeNameTag, setModelDetail, type CarParts } from './models';
import { buildTrackView, type TrackView } from './trackMesh';
import { Debris, ParticleSystem, ProjectilePool, SkidMarks } from './effects';

export interface LeaderRow { id: string; name: string; tag: string; rank: number; me: boolean; status: string; laps: number; color: string }

export interface HudData {
  phase: string;
  countdown: number;
  rank: number;
  total: number;
  lap: number;
  laps: number;
  sprint: boolean;
  coveredKm: number;
  raceKm: number;
  health: number;
  damage: string;
  nitro: number;
  fireReady: number; // 0..1
  boosting: boolean;
  status: string;
  respawnT: number;
  protect: boolean;
  speedKmh: number;
  finishPlace: number;
  leaderboard: LeaderRow[];
  spectating: string | null;
  weaponsOn: boolean;
  nitroOn: boolean;
  fps: number;
  wrongWay: boolean;
  banner: string;
  hitFlash: number;
  connected: boolean;
}

interface Snap { t: number; x: number; y: number; z: number; yaw: number; pitch: number; roll: number }

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpColor = new THREE.Color();
const C_SMOKE = new THREE.Color('#dddddd');
const C_DARK_SMOKE = new THREE.Color('#3a3a3a');
const C_FIRE = new THREE.Color('#ff8a1f');
const C_SPARK = new THREE.Color('#ffe066');
const C_BOOST = new THREE.Color('#5ad1ff');
const C_DUST = new THREE.Color('#c8b48a');

function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

class CarEntity {
  parts: CarParts;
  anim: CharacterAnimator;
  tag: THREE.Sprite | null = null;
  key: string;
  buf: Snap[] = [];
  pos = new THREE.Vector3();
  yaw = 0; pitch = 0; roll = 0;
  speed = 0;
  steerVis = 0;
  status = '';
  health = 100;
  boosting = false;
  drifting = false;
  grounded = true;
  protectT = 0;
  flash = 0;
  wheelSpin = 0;
  ejectT = 0;
  ejectY = 0;
  ejectVy = 0;
  skidAcc = 0;
  smokeAcc = 0;
  lastPos = new THREE.Vector3();
  finishPlace = 0;
  hl = 2.2;
  hw = 1.1;
  vis = new THREE.Vector3(); // visual separation offset
  constructor(public id: string, app: Record<string, string>, public name: string, isMe: boolean, scene: THREE.Scene) {
    this.key = CarEntity.keyOf(app);
    const cfg = getVehicle(app.carClass);
    this.hl = cfg.halfLength;
    this.hw = cfg.halfWidth;
    this.parts = buildCar(app as never);
    this.anim = new CharacterAnimator(this.parts.rig);
    this.parts.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    scene.add(this.parts.root);
    if (!isMe) {
      this.tag = makeNameTag(name, colorHex(app.colorMain) === '#24252b' ? '#ffffff' : '#ffffff');
      this.tag.position.y = app.carClass === 'monster' ? 4.4 : app.carClass === 'bruiser' ? 3.8 : 3.2;
      this.parts.root.add(this.tag);
    }
  }
  static keyOf(a: Record<string, string>) {
    return [a.carClass, a.character, a.colorMain, a.colorSecondary, a.colorWheel, a.wheelStyle].join('|');
  }
  dispose(scene: THREE.Scene) {
    scene.remove(this.parts.root);
    disposeCar(this.parts);
    if (this.tag) { (this.tag.material as THREE.SpriteMaterial).map?.dispose(); this.tag.material.dispose(); }
  }
}

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(70, 1, 0.3, 1400);
  private sun: THREE.DirectionalLight;
  private trackView: TrackView | null = null;
  private track: Track;
  private cars = new Map<string, CarEntity>();
  private smoke = new ParticleSystem(900, false);
  private glow = new ParticleSystem(900, true);
  private skids = new SkidMarks();
  private debris = new Debris();
  private bolts = new ProjectilePool();
  private raf = 0;
  private lastT = 0;
  private acc = 0;
  private disposed = false;
  private unsub: (() => void)[] = [];
  private ro: ResizeObserver | null = null;

  // prediction
  private pred: VehicleState = createVehicleState(0, 0, 0);
  private prevPred: VehicleState = createVehicleState(0, 0, 0);
  private pending: { seq: number; input: InputState }[] = [];
  private seq = 0;
  private predicting = false;
  private visOffset = new THREE.Vector3();
  private visYawOffset = 0;
  private curInput: InputState = { ...NEUTRAL_INPUT };
  private myStatus = '';

  // camera
  private camYaw = 0;
  camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private shake = 0;
  private camInit = false;
  spectateId: string | null = null;
  /** Test hook: lets automated browser tests drive with the shared autopilot. */
  autodrive = false;

  // misc
  paused = false;
  blocked = false; // e.g. portrait overlay
  private hudTimer = 0;
  private miniTimer = 0;
  private minimap: HTMLCanvasElement | null = null;
  private miniPath: Path2D | null = null;
  private miniXf = { s: 1, ox: 0, oz: 0 };
  private lastCountdownBeep = -1;
  private banner = '';
  private bannerT = 0;
  private hitFlash = 0;
  private fps = 60;
  private fpsFrames = 0;
  private fpsTime = 0;
  private qualityLevel: 'low' | 'medium' | 'high';
  private slowTime = 0;
  private fastTime = 0;
  private time = 0;
  private trackId = '';
  private raceId = -1;
  private lastRank = 0;
  private baseFov = 70;
  private fovExtra = 0;

  constructor(private container: HTMLElement, private onHud: (h: HudData) => void, private onFatal: (msg: string) => void) {
    const q = settingsStore.get().quality;
    this.qualityLevel = q === 'auto' ? (input.coarse ? 'medium' : 'high') : q;
    this.renderer = new THREE.WebGLRenderer({ antialias: this.qualityLevel !== 'low', powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.className = 'game-canvas';
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost, false);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored, false);

    this.scene.background = new THREE.Color('#8fd3ff');
    this.scene.fog = new THREE.Fog('#bfe6ff', 160, 650);
    this.scene.add(new THREE.HemisphereLight('#dff3ff', '#5a8f3a', 1.1));
    this.sun = new THREE.DirectionalLight('#fff3d6', 2.4);
    this.sun.position.set(60, 120, 40);
    this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera;
    sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 10; sc.far = 300;
    this.sun.shadow.bias = -0.0008;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(this.smoke.points, this.glow.points, this.skids.mesh, this.debris.mesh, this.bolts.group);

    this.scene.environment = environmentFor(this.renderer);
    this.scene.environmentIntensity = 0.55;
    setModelDetail(this.qualityLevel);
    this.track = getTrack(net.room?.state?.settings ?? 'valley');
    this.applyQuality();
    this.buildTrack();

    this.unsub.push(net.onPatch(() => this.onPatch()));
    this.unsub.push(net.onFx((fx) => this.onFx(fx)));
    this.unsub.push(settingsStore.subscribe(() => {
      const q2 = settingsStore.get().quality;
      if (q2 !== 'auto' && q2 !== this.qualityLevel) { this.qualityLevel = q2; this.applyQuality(); setModelDetail(q2); }
    }));
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    window.addEventListener('resize', this.resize);
    window.visualViewport?.addEventListener('resize', this.resize);
    document.addEventListener('fullscreenchange', this.resize);
    this.resize();
    this.onPatch();
    audio.startEngine();
    // Debug/testing hook (only with ?debug in the URL)
    if (location.search.includes('debug')) (window as unknown as { __game: Game }).__game = this;
    input.enabled = true;
    input.resetAll();
  }

  // ------------------------------------------------------------ setup / teardown
  private buildTrack() {
    if (this.trackView) { this.scene.remove(this.trackView.group); this.trackView.dispose(); }
    this.trackView = buildTrackView(this.track, this.qualityLevel);
    this.scene.add(this.trackView.group);
    this.trackId = this.track.key;
    this.miniPath = null;
  }

  private applyQuality() {
    const dpr = window.devicePixelRatio || 1;
    const lvl = this.qualityLevel;
    this.renderer.setPixelRatio(Math.min(dpr, lvl === 'low' ? 1 : lvl === 'medium' ? 1.5 : 2));
    const shadows = lvl !== 'low';
    this.renderer.shadowMap.enabled = shadows;
    this.sun.castShadow = shadows;
    this.sun.shadow.mapSize.set(lvl === 'high' ? 2048 : 1024, lvl === 'high' ? 2048 : 1024);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); (this.sun.shadow as { map: unknown }).map = null; }
    const budget = lvl === 'low' ? 0.35 : lvl === 'medium' ? 0.7 : 1;
    this.smoke.budget = budget;
    this.glow.budget = budget;
    this.scene.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m) m.needsUpdate = true; });
    this.resize();
  }

  start() {
    this.lastT = performance.now();
    const loop = (t: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      this.frame(t);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    input.enabled = false;
    input.resetAll();
    audio.stopEngine();
    this.unsub.forEach((u) => u());
    this.ro?.disconnect();
    window.removeEventListener('resize', this.resize);
    window.visualViewport?.removeEventListener('resize', this.resize);
    document.removeEventListener('fullscreenchange', this.resize);
    for (const c of this.cars.values()) c.dispose(this.scene);
    this.cars.clear();
    this.trackView?.dispose();
    this.smoke.dispose();
    this.glow.dispose();
    this.skids.dispose();
    this.debris.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private onContextLost = (e: Event) => {
    e.preventDefault();
    cancelAnimationFrame(this.raf);
    this.banner = 'Graphics restarting...';
    this.bannerT = 99;
  };
  private onContextRestored = () => {
    this.banner = '';
    this.bannerT = 0;
    this.applyQuality();
    this.start();
  };

  resize = () => {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.camera.aspect = aspect;
    // Keep a wide horizontal view on short/wide (phone landscape) screens,
    // and avoid an extreme vertical FOV on tall screens.
    const hFov = 98;
    const vFov = (2 * Math.atan(Math.tan((hFov * Math.PI) / 360) / aspect) * 180) / Math.PI;
    this.baseFov = Math.max(52, Math.min(78, vFov));
    this.camera.fov = this.baseFov + this.fovExtra;
    this.camera.updateProjectionMatrix();
    this.smoke.setScale(h * this.renderer.getPixelRatio());
    this.glow.setScale(h * this.renderer.getPixelRatio());
    this.miniPath = null;
  };

  setMinimap(c: HTMLCanvasElement | null) {
    this.minimap = c;
    this.miniPath = null;
  }

  setPaused(p: boolean) {
    this.paused = p;
    input.resetAll();
  }

  spectateNext() {
    const ids = [...this.cars.values()]
      .filter((c) => c.id !== net.myId && (c.status === RacerStatus.RACING || c.status === RacerStatus.DESTROYED))
      .map((c) => c.id);
    if (!ids.length) { this.spectateId = null; return; }
    const i = this.spectateId ? ids.indexOf(this.spectateId) : -1;
    this.spectateId = ids[(i + 1) % ids.length];
  }
  stopSpectating() { this.spectateId = null; }

  // ------------------------------------------------------------ network
  private onPatch() {
    const room = net.room;
    if (!room?.state?.players) return;
    const st = room.state;
    if (trackKey(st.settings) !== this.trackId) {
      this.track = getTrack(st.settings);
      this.buildTrack();
    }
    const now = performance.now();
    const seen = new Set<string>();
    st.players.forEach((p: any, id: string) => {
      seen.add(id);
      const app = { carClass: p.carClass, character: p.character, colorMain: p.colorMain, colorSecondary: p.colorSecondary, colorWheel: p.colorWheel, wheelStyle: p.wheelStyle };
      let c = this.cars.get(id);
      if (!c || c.key !== CarEntity.keyOf(app)) {
        c?.dispose(this.scene);
        c = new CarEntity(id, app, `${p.name}`, id === net.myId, this.scene);
        c.pos.set(p.x, p.y, p.z);
        c.yaw = p.yaw;
        this.cars.set(id, c);
      }
      const prevStatus = c.status;
      c.status = p.status;
      c.health = p.health;
      c.protectT = p.protectT;
      c.boosting = p.boosting;
      c.drifting = p.drifting;
      c.grounded = p.grounded;
      c.finishPlace = p.finishPlace;
      if (prevStatus === RacerStatus.DESTROYED && p.status !== RacerStatus.DESTROYED) {
        c.ejectT = 0;
        c.buf.length = 0;
        c.pos.set(p.x, p.y, p.z);
        c.yaw = p.yaw;
      }
      if (id !== net.myId) {
        c.buf.push({ t: now, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, roll: p.roll });
        if (c.buf.length > 30) c.buf.shift();
        c.speed = Math.hypot(p.vx, p.vz);
        c.steerVis = Math.max(-1, Math.min(1, -p.yawRate / 2));
      }
    });
    for (const [id, c] of this.cars) if (!seen.has(id)) { c.dispose(this.scene); this.cars.delete(id); }

    if (st.raceId !== this.raceId) {
      this.raceId = st.raceId;
      this.pending.length = 0;
      this.spectateId = null;
      this.camInit = false;
      this.lastCountdownBeep = -1;
    }
    this.reconcile();
  }

  private reconcile() {
    const st = net.room?.state;
    const me = st?.players?.get(net.myId);
    if (!me) return;
    this.myStatus = me.status;
    const canPredict = st.phase === Phase.RACING && (me.status === RacerStatus.RACING || me.status === RacerStatus.FINISHED) && net.status === 'connected';
    const oldX = this.pred.x, oldY = this.pred.y, oldZ = this.pred.z, oldYaw = this.pred.yaw;
    const server = this.pred;
    const keep = { trackIdx: server.trackIdx, offTrackT: server.offTrackT, recoverCooldown: server.recoverCooldown };
    Object.assign(server, {
      x: me.x, y: me.y, z: me.z, vx: me.vx, vy: me.vy, vz: me.vz, yaw: me.yaw, yawRate: me.yawRate,
      pitch: me.pitch, roll: me.roll, pitchRate: me.pitchRate, rollRate: me.rollRate, grounded: me.grounded,
      overturnT: me.overturnT, rampVy: me.rampVy, padCooldown: me.padCooldown, nitro: me.nitro,
      boosting: me.boosting, drifting: me.drifting, ...keep,
    });
    if (!canPredict) {
      this.pending.length = 0;
      this.predicting = false;
      Object.assign(this.prevPred, server);
      this.visOffset.set(0, 0, 0);
      this.visYawOffset = 0;
      return;
    }
    const ack = me.ackSeq;
    while (this.pending.length && this.pending[0].seq <= ack) this.pending.shift();
    const rules = { nitro: st.settings.nitro, drift: st.settings.drift };
    const cfg = getVehicle(me.carClass);
    for (const p of this.pending) stepVehicle(server, p.input, cfg, this.track, rules, SIM_DT);
    if (this.predicting) {
      const dx = oldX - server.x, dy = oldY - server.y, dz = oldZ - server.z;
      if (dx * dx + dy * dy + dz * dz < 36) {
        this.visOffset.x += dx; this.visOffset.y += dy; this.visOffset.z += dz;
        this.visYawOffset = lerpAngle(0, oldYaw - server.yaw, 1) + this.visYawOffset;
        this.prevPred.x -= dx; this.prevPred.y -= dy; this.prevPred.z -= dz;
      } else {
        Object.assign(this.prevPred, server);
        this.visOffset.set(0, 0, 0);
        this.visYawOffset = 0;
      }
    } else {
      Object.assign(this.prevPred, server);
    }
    this.predicting = true;
  }

  // ------------------------------------------------------------ fixed step
  private fixedStep() {
    const st = net.room?.state;
    if (!st) return;
    const inp = this.curInput;
    if (this.paused || this.blocked) Object.assign(inp, NEUTRAL_INPUT);
    else input.sample(SIM_DT, inp);
    if (this.autodrive && this.predicting) Object.assign(inp, autopilot(this.pred, this.track));
    const me = st.players?.get(net.myId);
    const live = st.phase === Phase.RACING || st.phase === Phase.COUNTDOWN;
    if (!live || !me || net.status !== 'connected') return;
    this.seq++;
    net.send(MSG.INPUT, encodeInput(this.seq, inp));
    if (!this.predicting || st.phase !== Phase.RACING) return;
    this.pending.push({ seq: this.seq, input: { ...inp } });
    if (this.pending.length > 90) this.pending.shift();
    Object.assign(this.prevPred, this.pred);
    const ev = stepVehicle(this.pred, inp, getVehicle(me.carClass), this.track, { nitro: st.settings.nitro, drift: st.settings.drift }, SIM_DT);
    if (ev.recover) {
      // Predict the recovery; the server's safe-spot choice will reconcile it.
      const q = queryTrack(this.track, this.pred.x, this.pred.z);
      const spot = findSafeSpot(this.track, q.f, q.lateral, [], 0);
      const nitro = this.pred.nitro;
      placeOnTrack(this.pred, this.track, spot.f, spot.lateral, this.pred.yaw);
      this.pred.nitro = nitro;
      Object.assign(this.prevPred, this.pred);
    }
  }

  // ------------------------------------------------------------ fx
  private onFx(list: FxMessage[]) {
    const camPos = this.camera.position;
    for (const [type, id, x, y, z, amount] of list) {
      const c = this.cars.get(id);
      const isMe = id === net.myId;
      const near = Math.hypot(camPos.x - x, camPos.z - z) < 70;
      switch (type) {
        case 'hit':
          for (let i = 0; i < 26; i++) this.glow.emit(x, y, z, (Math.random() - 0.5) * 14, Math.random() * 8, (Math.random() - 0.5) * 14, C_SPARK, 0.5, 0.45, { gravity: 18, drag: 1.5 });
          if (c) { c.flash = 1; c.anim.react('shock', 0.9); }
          if (isMe) { this.shake = Math.max(this.shake, 0.5); this.hitFlash = 1; haptic(60); }
          if (near) audio.hit();
          break;
        case 'crash': {
          for (let i = 0; i < 20; i++) this.glow.emit(x, y, z, (Math.random() - 0.5) * 12, Math.random() * 7, (Math.random() - 0.5) * 12, C_SPARK, 0.45, 0.4, { gravity: 18 });
          for (let i = 0; i < 6; i++) this.smoke.emit(x, y, z, (Math.random() - 0.5) * 3, 1 + Math.random(), (Math.random() - 0.5) * 3, C_SMOKE, 1.4, 0.8, { grow: 2 });
          for (const other of this.cars.values()) {
            if (other.pos.distanceToSquared(tmpV.set(x, y, z)) < 25) other.anim.react(amount > 18 ? 'dizzy' : 'shock', amount > 18 ? 2 : 1);
            if (other.id === net.myId && other.pos.distanceToSquared(tmpV) < 25) { this.shake = Math.max(this.shake, Math.min(1, amount / 25)); haptic(40); }
          }
          if (near) audio.crash(amount);
          break;
        }
        case 'land':
          for (let i = 0; i < 10; i++) this.smoke.emit(x + (Math.random() - 0.5) * 3, y + 0.2, z + (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 4, 1, (Math.random() - 0.5) * 4, C_DUST, 1.5, 0.7, { grow: 2.5 });
          if (c && amount > 11) c.anim.react('dizzy', 1.6);
          if (isMe) this.shake = Math.max(this.shake, Math.min(0.6, amount / 25));
          if (near) audio.land();
          break;
        case 'explode': {
          for (let i = 0; i < 45; i++) this.glow.emit(x, y + 0.5, z, (Math.random() - 0.5) * 18, Math.random() * 14, (Math.random() - 0.5) * 18, i % 2 ? C_FIRE : C_SPARK, 1.4, 0.7, { gravity: 6, drag: 2 });
          for (let i = 0; i < 25; i++) this.smoke.emit(x, y + 1, z, (Math.random() - 0.5) * 6, 2 + Math.random() * 5, (Math.random() - 0.5) * 6, C_DARK_SMOKE, 2.5, 1.8, { grow: 3, drag: 1.2 });
          if (c) {
            const m = c.parts.mats;
            this.debris.burst(x, y, z, ['#' + m.main.color.getHexString(), '#' + m.sec.color.getHexString(), '#2a2a33'], 14);
            c.ejectT = 1.6;
            c.ejectY = 0;
            c.ejectVy = 13;
            c.anim.react('dizzy', 3);
          }
          if (isMe) { this.shake = 1; haptic(150); this.banner = 'KABOOM!'; this.bannerT = 1.4; }
          if (near) audio.explode();
          break;
        }
        case 'respawn':
          for (let i = 0; i < 30; i++) {
            const a = (i / 30) * Math.PI * 2;
            this.glow.emit(x + Math.cos(a) * 2.5, y + 0.3, z + Math.sin(a) * 2.5, 0, 4 + Math.random() * 2, 0, C_BOOST, 0.7, 0.7, { drag: 1 });
          }
          if (isMe || near) audio.respawn();
          break;
        case 'pad':
          for (let i = 0; i < 18; i++) this.glow.emit(x, y + 0.3, z, (Math.random() - 0.5) * 6, 2 + Math.random() * 4, (Math.random() - 0.5) * 6, C_BOOST, 0.6, 0.5);
          if (isMe) { audio.pad(); haptic(25); }
          break;
        case 'shoot':
          for (let i = 0; i < 6; i++) this.glow.emit(x, y, z, (Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3, C_SPARK, 0.6, 0.15);
          if (isMe || near) audio.shoot();
          break;
        case 'lap':
          if (isMe) {
            const total = net.room?.state?.settings?.laps ?? 0;
            this.banner = amount + 1 >= total ? 'FINAL LAP!' : `LAP ${amount + 1} / ${total}`;
            this.bannerT = 2;
            audio.lap();
          }
          break;
        case 'finish':
          if (c) c.anim.react(amount === 1 ? 'laugh' : 'wave', 3);
          if (isMe) {
            this.banner = amount === 1 ? 'YOU WIN!' : `FINISHED ${ordinal(amount)}!`;
            this.bannerT = 4;
            audio.victory();
          }
          break;
        case 'overtake':
          if (c) c.anim.react('laugh', 1.4);
          break;
        case 'wave':
          if (c) c.anim.react('wave', 1.6);
          if (near) audio.honk();
          break;
      }
    }
  }

  // ------------------------------------------------------------ frame
  private frame(now: number) {
    let dt = (now - this.lastT) / 1000;
    this.lastT = now;
    if (dt > 0.25) dt = 0.25;
    this.time += dt;
    this.trackFps(dt);

    this.acc += dt;
    let steps = 0;
    while (this.acc >= SIM_DT && steps < 8) {
      this.fixedStep();
      this.acc -= SIM_DT;
      steps++;
    }
    if (steps === 8) this.acc = 0;
    const alpha = this.acc / SIM_DT;

    const st = net.room?.state;
    const phase = st?.phase ?? '';
    // Countdown beeps
    if (phase === Phase.COUNTDOWN) {
      const n = Math.ceil(st.countdown);
      if (n !== this.lastCountdownBeep && n > 0) { this.lastCountdownBeep = n; audio.countdownBeep(false); }
    } else if (phase === Phase.RACING && this.lastCountdownBeep > 0) {
      this.lastCountdownBeep = 0;
      audio.countdownBeep(true);
    }

    const decay = Math.exp(-10 * dt);
    this.visOffset.multiplyScalar(decay);
    this.visYawOffset *= decay;

    // Offline races patch every frame-ish; online ones every 50 ms.
    const renderT = now - (net.offline ? 45 : 110);
    for (const c of this.cars.values()) {
      const isMe = c.id === net.myId;
      if (isMe && this.predicting) {
        const a = this.prevPred, b = this.pred;
        c.pos.set(a.x + (b.x - a.x) * alpha, a.y + (b.y - a.y) * alpha, a.z + (b.z - a.z) * alpha).add(this.visOffset);
        c.yaw = lerpAngle(a.yaw, b.yaw, alpha) + this.visYawOffset;
        c.pitch = lerpAngle(a.pitch, b.pitch, alpha);
        c.roll = lerpAngle(a.roll, b.roll, alpha);
        c.speed = Math.hypot(b.vx, b.vz);
        c.steerVis += (this.curInput.steer - c.steerVis) * Math.min(1, dt * 12);
        c.boosting = b.boosting;
        c.drifting = b.drifting;
        c.grounded = b.grounded;
      } else if (isMe) {
        const p = this.pred;
        c.pos.lerp(tmpV.set(p.x, p.y, p.z), Math.min(1, dt * 15));
        c.yaw = lerpAngle(c.yaw, p.yaw, Math.min(1, dt * 15));
        c.pitch = p.pitch;
        c.roll = p.roll;
        c.speed = Math.hypot(p.vx, p.vz);
      } else {
        this.interpolate(c, renderT);
      }
    }
    this.separateVisuals(dt);
    for (const c of this.cars.values()) this.updateCarVisual(c, dt, phase);

    // Projectiles: extrapolate from last synced state
    this.bolts.begin();
    st?.projectiles?.forEach((p: any) => this.bolts.place(p.x, p.y, p.z, Math.atan2(p.vx, p.vz)));
    this.bolts.end();

    this.smoke.update(dt);
    this.glow.update(dt);
    this.debris.update(dt);
    if (this.trackView) for (const t of this.trackView.padTextures) t.offset.y = (t.offset.y - dt * 1.5) % 1;

    this.updateCamera(dt);
    this.updateAudio(phase);
    this.renderer.render(this.scene, this.camera);

    this.hudTimer -= dt;
    if (this.hudTimer <= 0) { this.hudTimer = 0.1; this.emitHud(); }
    this.miniTimer -= dt;
    if (this.miniTimer <= 0) { this.miniTimer = 1 / 15; this.drawMinimap(); }
    this.bannerT = Math.max(0, this.bannerT - dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt * 2.5);
  }

  /**
   * Remote cars are drawn slightly in the past and the local car slightly in
   * the future, so two cars the server keeps apart can look overlapped for a
   * frame or two. Push rendered bodies apart (visual only, eased back out).
   */
  private separateVisuals(dt: number) {
    const list = [...this.cars.values()].filter((c) => c.status === RacerStatus.RACING);
    for (const c of list) c.vis.multiplyScalar(Math.exp(-6 * dt));
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          const ax = a.pos.x + a.vis.x, az = a.pos.z + a.vis.z, bx = b.pos.x + b.vis.x, bz = b.pos.z + b.vis.z;
          if (Math.abs(a.pos.y - b.pos.y) > 1.6) continue;
          const o = obbOverlap(ax, az, a.yaw, a.hl, a.hw, bx, bz, b.yaw, b.hl, b.hw);
          if (!o) continue;
          // Prefer moving the remote car so the player's own car stays exactly where they steer it.
          const meA = a.id === net.myId, meB = b.id === net.myId;
          const wa = meA ? 0.15 : meB ? 0.85 : 0.5;
          a.vis.x -= o.nx * o.depth * wa;
          a.vis.z -= o.nz * o.depth * wa;
          b.vis.x += o.nx * o.depth * (1 - wa);
          b.vis.z += o.nz * o.depth * (1 - wa);
        }
      }
    }
    for (const c of list) { c.vis.y = 0; if (c.vis.lengthSq() > 9) c.vis.setLength(3); }
  }

  private interpolate(c: CarEntity, renderT: number) {
    const b = c.buf;
    if (!b.length) return;
    let i = b.length - 1;
    while (i > 0 && b[i - 1].t > renderT) i--;
    if (i === 0 || b[i].t <= renderT) {
      const s = b[b.length - 1];
      c.pos.set(s.x, s.y, s.z);
      c.yaw = s.yaw; c.pitch = s.pitch; c.roll = s.roll;
      return;
    }
    const a = b[i - 1], s = b[i];
    const k = Math.max(0, Math.min(1, (renderT - a.t) / (s.t - a.t || 1)));
    c.pos.set(a.x + (s.x - a.x) * k, a.y + (s.y - a.y) * k, a.z + (s.z - a.z) * k);
    c.yaw = lerpAngle(a.yaw, s.yaw, k);
    c.pitch = lerpAngle(a.pitch, s.pitch, k);
    c.roll = lerpAngle(a.roll, s.roll, k);
  }

  private updateCarVisual(c: CarEntity, dt: number, phase: string) {
    const P = c.parts;
    const destroyed = c.status === RacerStatus.DESTROYED;
    const gone = c.status === RacerStatus.LEFT;
    P.root.visible = !gone;
    P.root.position.copy(c.pos);
    if (c.status === RacerStatus.RACING) P.root.position.add(c.vis);
    P.root.rotation.set(0, c.yaw, 0);
    P.tilt.rotation.set(c.pitch, 0, c.roll, 'YXZ');
    // body + wheels hidden while destroyed; the driver gets ejected cartoon-style
    P.body.visible = !destroyed;
    for (const w of P.wheels) w.parent!.visible = !destroyed;
    if (c.ejectT > 0 || destroyed) {
      c.ejectT = Math.max(0, c.ejectT - dt);
      c.ejectVy -= 25 * dt;
      c.ejectY = Math.max(0, c.ejectY + c.ejectVy * dt);
      P.driverSeat.position.y = (c.parts.driverSeat.userData.baseY ??= P.driverSeat.position.y) + c.ejectY;
      P.driverSeat.rotation.x += dt * 9;
    } else if (P.driverSeat.userData.baseY !== undefined) {
      P.driverSeat.position.y = P.driverSeat.userData.baseY;
      P.driverSeat.rotation.x = 0;
    }
    // Ghosted look for finished / disconnected / protected racers
    const ghost = c.status === RacerStatus.FINISHED || c.status === RacerStatus.DISCONNECTED;
    P.shield.visible = c.protectT > 0 && !destroyed;
    if (P.shield.visible) (P.shield.material as THREE.MeshBasicMaterial).opacity = 0.16 + Math.sin(this.time * 12) * 0.08;
    if (c.tag) {
      const d = this.camera.position.distanceTo(c.pos);
      c.tag.visible = !destroyed && phase !== Phase.RESULTS && d < 90;
      (c.tag.material as THREE.SpriteMaterial).opacity = Math.max(0, Math.min(1, (90 - d) / 30));
      const sc = Math.min(1.6, Math.max(0.7, d / 25));
      c.tag.scale.set(4 * sc * 0.6, sc * 0.6, 1);
    }
    for (const m of [P.mats.main, P.mats.sec]) {
      m.transparent = ghost;
      m.opacity = ghost ? 0.55 : 1;
    }

    // Wheels
    c.wheelSpin += (c.speed / P.wheelRadius) * dt;
    for (const w of P.wheels) w.rotation.x = c.wheelSpin;
    for (const fw of P.frontWheels) fw.rotation.y = -c.steerVis * 0.45;

    // Damage look: darken, dangle loose parts, flash on hits
    const ds = damageState(c.health);
    const dmg = ds === 'critical' ? 1 : ds === 'damaged' ? 0.5 : 0;
    tmpColor.set(P.mats.main.userData.base ??= '#' + P.mats.main.color.getHexString());
    P.mats.main.color.copy(tmpColor).multiplyScalar(1 - dmg * 0.35);
    P.looseParts.forEach((lp, i) => {
      lp.rotation.z = dmg > 0 ? (i % 2 ? 1 : -1) * (0.08 + dmg * 0.25 + (dmg >= 1 ? Math.sin(this.time * 9 + i) * 0.08 : 0)) : 0;
    });
    c.flash = Math.max(0, c.flash - dt * 4);
    const flashOn = c.flash > 0 || (ds === 'critical' && Math.sin(this.time * 14) > 0.6);
    P.mats.main.emissive.setRGB(flashOn ? 0.6 : 0, flashOn ? 0.15 : 0, flashOn ? 0.1 : 0);

    // Effects
    P.root.updateMatrixWorld();
    const live = !destroyed && !gone;
    for (const f of P.flames) {
      f.visible = live && c.boosting;
      if (f.visible) f.scale.set(1, 0.8 + Math.random() * 0.6, 1);
    }
    if (live && c.boosting) {
      for (const e of P.exhaust) {
        P.tilt.localToWorld(tmpV.copy(e));
        this.glow.emit(tmpV.x, tmpV.y, tmpV.z, (Math.random() - 0.5) * 1.5, Math.random(), (Math.random() - 0.5) * 1.5, Math.random() < 0.5 ? C_FIRE : C_BOOST, 0.9, 0.35);
      }
    }
    if (live && (c.drifting || (c.grounded && c.speed > 30 && Math.abs(c.steerVis) > 0.85))) {
      c.skidAcc += c.speed * dt;
      for (const side of [0.95, -0.95]) {
        P.tilt.localToWorld(tmpV.set(side, 0.1, -1.4));
        if (Math.random() < 0.6) this.smoke.emit(tmpV.x, tmpV.y + 0.2, tmpV.z, (Math.random() - 0.5) * 2, 0.8 + Math.random(), (Math.random() - 0.5) * 2, C_SMOKE, 1.2, 0.9, { grow: 2.5, drag: 1.5 });
        if (c.skidAcc > 0.8) this.skids.add(tmpV.x, tmpV.y, tmpV.z, c.yaw);
      }
      if (c.skidAcc > 0.8) c.skidAcc = 0;
    }
    if (live && dmg > 0) {
      c.smokeAcc += dt * (dmg >= 1 ? 30 : 6);
      while (c.smokeAcc > 1) {
        c.smokeAcc -= 1;
        P.tilt.localToWorld(tmpV.copy(P.hood));
        this.smoke.emit(tmpV.x, tmpV.y, tmpV.z, (Math.random() - 0.5), 2 + Math.random() * 1.5, (Math.random() - 0.5), dmg >= 1 ? C_DARK_SMOKE : C_SMOKE, 1, 1.1, { grow: 2 });
        if (dmg >= 1 && Math.random() < 0.3) this.glow.emit(tmpV.x, tmpV.y, tmpV.z, (Math.random() - 0.5) * 4, 3, (Math.random() - 0.5) * 4, C_SPARK, 0.3, 0.3, { gravity: 15 });
      }
    }

    const finished = c.status === RacerStatus.FINISHED || phase === Phase.RESULTS;
    c.anim.update(dt, {
      t: this.time,
      steer: c.steerVis,
      speed: c.speed,
      drifting: c.drifting,
      boosting: c.boosting,
      airborne: (!c.grounded && c.pos.y > 0.6) || destroyed,
      countdown: phase === Phase.COUNTDOWN,
      finished,
      won: c.finishPlace === 1,
      idle: false,
    });
  }

  private updateCamera(dt: number) {
    const target = (this.spectateId && this.cars.get(this.spectateId)) || this.cars.get(net.myId);
    if (!target) return;
    const sens = settingsStore.get().cameraSensitivity;
    // Follow car yaw on the ground; hold steady while airborne/flipped for a stable horizon.
    const steady = !target.grounded || Math.abs(target.roll) > 0.6 || target.status === RacerStatus.DESTROYED;
    if (!this.camInit) {
      this.camYaw = target.yaw;
    } else if (!steady) {
      this.camYaw = lerpAngle(this.camYaw, target.yaw, 1 - Math.exp(-4 * sens * dt));
    }
    const speed = target.speed;
    const big = target.hl > 2.4 || target.parts.wheelRadius > 0.8 ? 1.25 : 1;
    const dist = (7.4 + Math.min(speed, 50) * 0.075) * big;
    const height = (3.0 + Math.min(speed, 50) * 0.02) * big + (target.parts.wheelRadius > 0.8 ? 1 : 0);
    const fx = Math.sin(this.camYaw), fz = Math.cos(this.camYaw);
    tmpV.set(target.pos.x - fx * dist, target.pos.y + height, target.pos.z - fz * dist);
    // Collision-aware: keep the camera inside the barrier corridor and above ground
    const q = queryTrack(this.track, tmpV.x, tmpV.z);
    const maxLat = this.track.halfWidth + 0.4;
    if (Math.abs(q.lateral) > maxLat && Math.abs(queryTrack(this.track, target.pos.x, target.pos.z).lateral) <= maxLat + 2) {
      tmpV.lerp(target.pos, Math.min(0.6, (Math.abs(q.lateral) - maxLat) / dist));
      tmpV.y = Math.max(tmpV.y, target.pos.y + height + 0.6);
    }
    tmpV.y = Math.max(tmpV.y, q.height + 1.2);
    tmpV2.set(target.pos.x + fx * 5, target.pos.y + (target.parts.wheelRadius > 0.8 ? 2.1 : 1.1), target.pos.z + fz * 5);
    if (!this.camInit) {
      this.camPos.copy(tmpV);
      this.camLook.copy(tmpV2);
      this.camInit = true;
    } else {
      const k = 1 - Math.exp(-8 * sens * dt);
      this.camPos.lerp(tmpV, k);
      this.camLook.lerp(tmpV2, 1 - Math.exp(-12 * dt));
    }
    this.shake = Math.max(0, this.shake - dt * 2.5);
    this.camera.position.copy(this.camPos);
    if (this.shake > 0) this.camera.position.add(tmpV.set((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.camLook);
    const wantExtra = (target.boosting ? 7 : 0) + Math.min(speed, 50) * 0.08;
    this.fovExtra += (wantExtra - this.fovExtra) * (1 - Math.exp(-3 * dt));
    this.camera.fov = this.baseFov + this.fovExtra;
    this.camera.updateProjectionMatrix();
    // Shadow camera follows the action
    this.sun.position.set(target.pos.x + 60, 120, target.pos.z + 40);
    this.sun.target.position.copy(target.pos);
  }

  private updateAudio(phase: string) {
    const me = this.cars.get(net.myId);
    const active = !!me && (phase === Phase.RACING || phase === Phase.COUNTDOWN) && me.status !== RacerStatus.DESTROYED && !this.paused;
    audio.updateEngine(Math.min(1, (me?.speed ?? 0) / 45), this.curInput.throttle, !!me?.drifting, !!me?.boosting, active);
  }

  private trackFps(dt: number) {
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 1) {
      this.fps = this.fpsFrames / this.fpsTime;
      this.fpsFrames = 0;
      this.fpsTime = 0;
      if (settingsStore.get().quality === 'auto' && !document.hidden) {
        if (this.fps < 42) { this.slowTime++; this.fastTime = 0; } else if (this.fps > 57) { this.fastTime++; this.slowTime = 0; } else { this.slowTime = 0; this.fastTime = 0; }
        if (this.slowTime >= 3 && this.qualityLevel !== 'low') {
          this.qualityLevel = this.qualityLevel === 'high' ? 'medium' : 'low';
          this.slowTime = 0;
          this.applyQuality();
        } else if (this.fastTime >= 10 && this.qualityLevel === 'low') {
          this.qualityLevel = 'medium';
          this.fastTime = 0;
          this.applyQuality();
        }
      }
    }
  }

  // ------------------------------------------------------------ HUD
  private emitHud() {
    const st = net.room?.state;
    if (!st) return;
    const me = st.players?.get(net.myId);
    const rows: LeaderRow[] = [];
    st.players?.forEach((p: any) => rows.push({ id: p.id, name: p.name, tag: p.tag, rank: p.rank, me: p.id === net.myId, status: p.status, laps: p.laps, color: colorHex(p.colorMain) }));
    rows.sort((a, b) => a.rank - b.rank);
    let wrongWay = false;
    if (me && this.predicting && me.status === RacerStatus.RACING) {
      const q = queryTrack(this.track, this.pred.x, this.pred.z);
      const t = this.track;
      const i = q.index;
      const fwd = Math.sin(this.pred.yaw) * t.tx[i] + Math.cos(this.pred.yaw) * t.tz[i];
      const v = this.pred.vx * t.tx[i] + this.pred.vz * t.tz[i];
      wrongWay = fwd < -0.5 && v < -5;
    }
    if (me && me.rank !== this.lastRank) this.lastRank = me.rank;
    const laps = st.settings.laps;
    this.onHud({
      phase: st.phase,
      countdown: st.countdown,
      rank: me?.rank ?? 0,
      total: rows.filter((r) => r.status !== RacerStatus.LEFT).length,
      lap: Math.min(laps, (me?.laps ?? 0) + 1),
      laps,
      sprint: !this.track.closed,
      coveredKm: this.track.closed ? 0 : Math.max(0, Math.min(this.track.raceLength, (me?.progress ?? 0) * this.track.ds)) / 1000,
      raceKm: this.track.raceLength / 1000,
      health: me?.health ?? 0,
      damage: damageState(me?.health ?? 100),
      nitro: this.predicting ? this.pred.nitro : me?.nitro ?? 0,
      fireReady: 1 - Math.min(1, (me?.fireCd ?? 0) / WEAPON.cooldown),
      boosting: !!me?.boosting,
      status: me?.status ?? '',
      respawnT: me?.respawnT ?? 0,
      protect: (me?.protectT ?? 0) > 0,
      speedKmh: Math.round((this.cars.get(net.myId)?.speed ?? 0) * 3.6),
      finishPlace: me?.finishPlace ?? 0,
      leaderboard: rows,
      spectating: this.spectateId ? st.players.get(this.spectateId)?.name ?? null : null,
      weaponsOn: st.settings.weapons,
      nitroOn: st.settings.nitro,
      fps: Math.round(this.fps),
      wrongWay,
      banner: this.bannerT > 0 ? this.banner : '',
      hitFlash: this.hitFlash,
      connected: net.status === 'connected',
    });
  }

  private drawMinimap() {
    const c = this.minimap;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      this.miniPath = null;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const t = this.track;
    if (!this.miniPath) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < t.n; i++) {
        minX = Math.min(minX, t.px[i]); maxX = Math.max(maxX, t.px[i]);
        minZ = Math.min(minZ, t.pz[i]); maxZ = Math.max(maxZ, t.pz[i]);
      }
      const pad = 10 * dpr;
      const s = Math.min((c.width - pad * 2) / (maxX - minX), (c.height - pad * 2) / (maxZ - minZ));
      // Top-down view: +x to the right, +z down (matches the 3D world's handedness)
      this.miniXf = { s, ox: c.width / 2 - ((maxX + minX) / 2) * s, oz: c.height / 2 - ((maxZ + minZ) / 2) * s };
      const p = new Path2D();
      for (let i = 0; i <= t.n; i++) {
        const k = i % t.n;
        const x = this.miniXf.ox + t.px[k] * s, y = this.miniXf.oz + t.pz[k] * s;
        if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
      }
      this.miniPath = p;
    }
    const { s, ox, oz } = this.miniXf;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 7 * dpr;
    ctx.stroke(this.miniPath);
    ctx.strokeStyle = '#4a4d5c';
    ctx.lineWidth = 4 * dpr;
    ctx.stroke(this.miniPath);
    // finish line
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath();
    ctx.arc(ox + t.px[0] * s, oz + t.pz[0] * s, 3.5 * dpr, 0, Math.PI * 2);
    ctx.fill();
    for (const car of this.cars.values()) {
      if (car.status === RacerStatus.LEFT) continue;
      const me = car.id === net.myId;
      const x = ox + car.pos.x * s, y = oz + car.pos.z * s;
      ctx.beginPath();
      ctx.arc(x, y, (me ? 5 : 3.5) * dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#' + (car.parts.mats.main.userData.base ?? '#ffffff').replace('#', '');
      ctx.fill();
      ctx.lineWidth = (me ? 2.5 : 1.5) * dpr;
      ctx.strokeStyle = me ? '#ffffff' : '#1d1f3f';
      ctx.stroke();
    }
  }
}

export function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export type { Quality };
export { cloneVehicleState };
