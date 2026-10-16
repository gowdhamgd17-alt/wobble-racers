// The in-race engine: Three.js scene, fixed-step local prediction with
// server reconciliation, interpolation of remote cars, effects, camera,
// audio hooks and HUD data. React only hosts the canvas and draws the HUD.

import * as THREE from 'three';
import {
  MSG, NEUTRAL_INPUT, autopilot, Phase, RacerStatus, SIM_DT, cloneVehicleState, createVehicleState, damageState,
  encodeInput, constrainToWorld, resolveCarCollision, findArenaSpot, findSafeSpot, getVehicle, getWeapon, getWorld, isArena, arenaRay, obbOverlap, placeInArena,
  placeOnTrack, queryTrack, stepVehicle, colorHex, weaponByIndex, WEAPONS,
  type Arena, type FxMessage, type InputState, type KillEvent, type Track, type VehicleState, type World,
} from '@wobble/shared';
import { net } from '../net/Net';
import { input, haptic } from '../input/Input';
import { audio } from '../audio/Audio';
import { voice } from '../net/Voice';
import { settingsStore, type Quality } from '../state/store';
import { buildCar, CharacterAnimator, disposeCar, environmentFor, makeNameTag, setCarGun, setModelDetail, type CarParts } from './models';
import { buildTrackView, type TrackView } from './trackMesh';
import { buildArenaView } from './arenaMesh';
import { Debris, ParticleSystem, PickupViews, ProjectilePool, Shockwaves, SkidMarks, Tracers } from './effects';

export interface LeaderRow { id: string; name: string; tag: string; rank: number; me: boolean; status: string; laps: number; color: string; kills: number; deaths: number }
export interface KillFeedRow { id: number; killer: string; victim: string; weapon: string; meKiller: boolean; meVictim: boolean; killerColor: string; victimColor: string }

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
  // combat
  maxHealth: number;
  weaponId: string;
  weaponName: string;
  ownWeapon: boolean;
  weaponIndex: number; // selected gun (0..9)
  powerT: number; // seconds of power-crate damage boost left
  ammo: number;
  magazine: number;
  reloading: number; // 0..1 progress, 0 when not reloading
  kills: number;
  deaths: number;
  battle: boolean;
  killTarget: number;
  timeLeft: number;
  timeLimited: boolean;
  killFeed: KillFeedRow[];
  saavu: { title: string; sub: string; key: number } | null;
  killedBy: string;
}

interface Snap { t: number; x: number; y: number; z: number; yaw: number; pitch: number; roll: number; vx: number; vy: number; vz: number; yawRate: number; grounded: boolean }

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpColor = new THREE.Color();
const C_SMOKE = new THREE.Color('#dddddd');
const C_DARK_SMOKE = new THREE.Color('#3a3a3a');
const C_FIRE = new THREE.Color('#ff8a1f');
const C_SPARK = new THREE.Color('#ffe066');
const C_BOOST = new THREE.Color('#5ad1ff');
const C_DUST = new THREE.Color('#c8b48a');
const C_FLAME = new THREE.Color('#ffcf4a');
const C_BRASS = new THREE.Color('#d9a93a');
const C_GOLD = new THREE.Color('#ffd23f');
const C_REPAIR = new THREE.Color('#4dff9a');
const tmpV3 = new THREE.Vector3();
const tmpM = new THREE.Matrix4();

function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

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
  maxHealth = 400;
  weapon = '';
  muzzleFlash = 0;
  recoil = 0;
  spinRate = 0;
  hl = 2.2;
  hw = 1.1;
  vis = new THREE.Vector3(); // visual separation offset
  constructor(public id: string, app: Record<string, string>, public name: string, isMe: boolean, scene: THREE.Scene) {
    this.key = CarEntity.keyOf(app);
    const cfg = getVehicle(app.carClass);
    this.hl = cfg.halfLength;
    this.hw = cfg.halfWidth;
    this.parts = buildCar(app as never);
    this.weapon = app.weapon ?? '';
    this.flashMesh = new THREE.Mesh(FLASH_GEO, new THREE.MeshBasicMaterial({ color: '#ffd27a', transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.flashMesh.visible = false;
    this.parts.gun?.muzzle.add(this.flashMesh);
    this.anim = new CharacterAnimator(this.parts.rig);
    this.parts.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    scene.add(this.parts.root);
    if (!isMe) {
      this.tag = makeNameTag(name, colorHex(app.colorMain) === '#24252b' ? '#ffffff' : '#ffffff');
      this.tag.position.y = this.parts.topY + 1.1;
      this.parts.root.add(this.tag);
    }
  }
  flashMesh: THREE.Mesh;
  setWeapon(id: string) {
    if (id === this.weapon) return;
    this.weapon = id;
    this.flashMesh.removeFromParent();
    setCarGun(this.parts, id);
    this.parts.gun?.muzzle.add(this.flashMesh);
  }
  static keyOf(a: Record<string, string>) {
    return [a.carClass, a.character, a.colorMain, a.colorSecondary, a.colorWheel, a.wheelStyle].join('|');
  }
  dispose(scene: THREE.Scene) {
    scene.remove(this.parts.root);
    disposeCar(this.parts);
    if (this.tag) { (this.tag.material as THREE.SpriteMaterial).map?.dispose(); this.tag.material.dispose(); }
    (this.flashMesh.material as THREE.Material).dispose();
  }
}

const FLASH_GEO = (() => {
  const g = new THREE.ConeGeometry(0.22, 0.9, 7, 1, true);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, 0.42);
  return g;
})();

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(70, 1, 0.3, 1400);
  private sun: THREE.DirectionalLight;
  private trackView: TrackView | null = null;
  private world: World;
  private get track(): Track | null { return isArena(this.world) ? null : this.world; }
  private get arena(): Arena | null { return isArena(this.world) ? this.world : null; }
  private cars = new Map<string, CarEntity>();
  private smoke = new ParticleSystem(900, false);
  private glow = new ParticleSystem(900, true);
  private skids = new SkidMarks();
  private debris = new Debris();
  private bolts = new ProjectilePool();
  private tracers = new Tracers();
  private rings = new Shockwaves();
  private pickupViews = new PickupViews();
  private killFeed: KillFeedRow[] = [];
  private killFeedN = 0;
  private saavu: { title: string; sub: string; key: number } | null = null;
  private saavuT = 0;
  private killedBy = '';
  private lastAmmo = -1;
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
    this.scene.add(this.smoke.points, this.glow.points, this.skids.mesh, this.debris.mesh, this.bolts.group, this.tracers.mesh, this.rings.group, this.pickupViews.group);

    this.scene.environment = environmentFor(this.renderer);
    this.scene.environmentIntensity = 0.55;
    setModelDetail(this.qualityLevel);
    this.world = getWorld(net.room?.state?.settings ?? {});
    this.applyQuality();
    this.buildTrack();

    this.unsub.push(net.onPatch(() => this.onPatch()));
    this.unsub.push(net.onFx((fx) => this.onFx(fx)));
    this.unsub.push(net.onKill((k) => this.onKill(k)));
    this.unsub.push(settingsStore.subscribe(() => {
      const q2 = settingsStore.get().quality;
      if (q2 !== 'auto' && q2 !== this.qualityLevel) { this.qualityLevel = q2; this.applyQuality(); setModelDetail(q2); }
    }));
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    window.addEventListener('resize', this.resize);
    window.addEventListener('keydown', this.onKey);
    window.visualViewport?.addEventListener('resize', this.resize);
    document.addEventListener('fullscreenchange', this.resize);
    this.resize();
    this.onPatch();
    audio.startEngine();
    // Debug/testing hook (only with ?debug in the URL)
    if (location.search.includes('debug')) Object.assign(window, { __game: this, __audio: audio });
    input.enabled = true;
    input.resetAll();
  }

  // ------------------------------------------------------------ setup / teardown
  private buildTrack() {
    if (this.trackView) { this.scene.remove(this.trackView.group); this.trackView.dispose(); }
    const arena = this.arena;
    this.trackView = arena ? buildArenaView(arena, this.qualityLevel) : buildTrackView(this.world as Track, this.qualityLevel);
    this.scene.add(this.trackView.group);
    this.trackId = this.world.key;
    this.scene.fog = new THREE.Fog('#bfe6ff', arena ? 220 : 160, arena ? 820 : 650);
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
    window.removeEventListener('keydown', this.onKey);
    window.visualViewport?.removeEventListener('resize', this.resize);
    document.removeEventListener('fullscreenchange', this.resize);
    for (const c of this.cars.values()) c.dispose(this.scene);
    this.cars.clear();
    this.trackView?.dispose();
    this.smoke.dispose();
    this.glow.dispose();
    this.skids.dispose();
    this.debris.dispose();
    this.tracers.dispose();
    this.rings.dispose();
    this.pickupViews.dispose();
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
  private lastPatchT = 0;
  private onPatch() {
    this.lastPatchT = performance.now();
    const room = net.room;
    if (!room?.state?.players) return;
    const st = room.state;
    const world = getWorld(st.settings);
    if (world.key !== this.trackId) {
      this.world = world;
      this.buildTrack();
    }
    const now = performance.now();
    const seen = new Set<string>();
    st.players.forEach((p: any, id: string) => {
      seen.add(id);
      const app = { carClass: p.carClass, character: p.character, colorMain: p.colorMain, colorSecondary: p.colorSecondary, colorWheel: p.colorWheel, wheelStyle: p.wheelStyle, weapon: p.curWeapon || p.weapon };
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
      c.maxHealth = p.maxHealth || 400;
      if (p.curWeapon) c.setWeapon(p.curWeapon);
      if (prevStatus === RacerStatus.DESTROYED && p.status !== RacerStatus.DESTROYED) {
        c.ejectT = 0;
        c.buf.length = 0;
        c.pos.set(p.x, p.y, p.z);
        c.yaw = p.yaw;
      }
      if (id !== net.myId) {
        // A recover / respawn teleport: jump there instead of sliding across the map.
        const last = c.buf[c.buf.length - 1];
        if (last && (last.x - p.x) ** 2 + (last.z - p.z) ** 2 > 15 * 15) {
          c.buf.length = 0;
          c.pos.set(p.x, p.y, p.z);
          c.yaw = p.yaw;
        }
        c.buf.push({ t: now, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, roll: p.roll, vx: p.vx, vy: p.vy, vz: p.vz, yawRate: p.yawRate, grounded: p.grounded });
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
      this.killFeed = [];
      this.saavu = null;
      this.killedBy = '';
      const mine = st.players?.get(net.myId);
      this.desiredWeapon = mine ? getWeapon(mine.weapon).index : -1;
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
    this.pending.forEach((p, i) => this.predictStep(server, p.input, cfg, rules, (i + 1) * SIM_DT));
    if (this.predicting) {
      const dx = oldX - server.x, dy = oldY - server.y, dz = oldZ - server.z;
      const err2 = dx * dx + dy * dy + dz * dz;
      if (err2 > 0.25) this.corrections++;
      if (err2 < 36) {
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

  /**
   * One predicted step of my own car, including bumping into the other cars
   * (at their last synced positions, moved on by their velocity). Without this
   * the prediction drives straight into a rival and the server's correction
   * yanks it back every patch, which looks like jittering when cars touch.
   */
  private predictStep(s: VehicleState, inp: InputState, cfg: ReturnType<typeof getVehicle>, rules: { nitro: boolean; drift: boolean }, ahead: number) {
    const ev = stepVehicle(s, inp, cfg, this.world, rules, SIM_DT);
    const st = net.room?.state;
    if (!st?.settings?.collisions || this.myStatus !== RacerStatus.RACING) return ev;
    const since = Math.min(0.15, (performance.now() - this.lastPatchT) / 1000) + ahead;
    let hit = false;
    st.players.forEach((p: any, id: string) => {
      if (id === net.myId || p.status !== RacerStatus.RACING) return;
      const o = this.otherTmp;
      Object.assign(o, { x: p.x + p.vx * since, y: p.y, z: p.z + p.vz * since, vx: p.vx, vy: p.vy, vz: p.vz, yaw: p.yaw, yawRate: p.yawRate, grounded: p.grounded, boosting: p.boosting, overturnT: p.overturnT });
      const ocfg = getVehicle(p.carClass);
      if (Math.abs(o.x - s.x) > 8 || Math.abs(o.z - s.z) > 8) return;
      // Only my car is moved; the other is the server's business.
      const before = { y: s.y, vy: s.vy, grounded: s.grounded, rollRate: s.rollRate, pitchRate: s.pitchRate };
      const res = resolveCarCollision(s, o, cfg, ocfg);
      if (res.hit) hit = true;
      // Launches are decided by the server (it knows both cars exactly); don't guess them here.
      if (res.launchedA) Object.assign(s, before);
    });
    if (hit) constrainToWorld(s, cfg, this.world);
    return ev;
  }
  /** Debug: how often the server noticeably corrected my predicted car. */
  corrections = 0;
  private otherTmp: VehicleState = createVehicleState(0, 0, 0);

  // ------------------------------------------------------------ fixed step
  private fixedStep() {
    const st = net.room?.state;
    if (!st) return;
    const inp = this.curInput;
    if (this.paused || this.blocked) Object.assign(inp, NEUTRAL_INPUT);
    else input.sample(SIM_DT, inp);
    if (this.autodrive && this.predicting && this.track) Object.assign(inp, autopilot(this.pred, this.track));
    // Gun switching: number keys pick a gun directly, Q / E (or the touch button) cycle.
    // (keyboard presses are handled on keydown; this catches the touch button)
    const nextDown = input.isDown('nextWeapon'), prevDown = input.isDown('prevWeapon');
    if (this.keyCycled) { this.keyCycled = false; this.nextWasDown = nextDown; this.prevWasDown = prevDown; }
    if (!this.paused && !this.blocked) {
      if (nextDown && !this.nextWasDown) this.cycleWeapon(1);
      if (prevDown && !this.prevWasDown) this.cycleWeapon(-1);
    }
    this.nextWasDown = nextDown;
    this.prevWasDown = prevDown;
    inp.weapon = this.desiredWeapon;
    const me = st.players?.get(net.myId);
    const live = st.phase === Phase.RACING || st.phase === Phase.COUNTDOWN;
    if (!live || !me || net.status !== 'connected') return;
    this.seq++;
    net.send(MSG.INPUT, encodeInput(this.seq, inp));
    if (!this.predicting || st.phase !== Phase.RACING) return;
    this.pending.push({ seq: this.seq, input: { ...inp } });
    if (this.pending.length > 90) this.pending.shift();
    Object.assign(this.prevPred, this.pred);
    const ev = this.predictStep(this.pred, inp, getVehicle(me.carClass), { nitro: st.settings.nitro, drift: st.settings.drift }, this.pending.length * SIM_DT);
    if (ev.recover) {
      // Predict the recovery; the server's safe-spot choice will reconcile it.
      const nitro = this.pred.nitro;
      const t = this.track, a = this.arena;
      if (t) {
        const q = queryTrack(t, this.pred.x, this.pred.z);
        const spot = findSafeSpot(t, q.f, q.lateral, [], 0);
        placeOnTrack(this.pred, t, spot.f, spot.lateral, this.pred.yaw);
      } else if (a) {
        const spot = findArenaSpot(a, this.pred.x, this.pred.z, this.pred.yaw, [], 0);
        placeInArena(this.pred, spot.x, spot.z, spot.yaw);
      }
      this.pred.nitro = nitro;
      Object.assign(this.prevPred, this.pred);
    }
  }

  // ------------------------------------------------------------ fx
  private onFx(list: FxMessage[]) {
    const camPos = this.camera.position;
    for (const msg of list) {
      const [type, id, , , , amount] = msg;
      let [, , x, y, z] = msg;
      const c = this.cars.get(id);
      const isMe = id === net.myId;
      const dist = Math.hypot(camPos.x - x, camPos.z - z);
      const near = dist < 70;
      const vol = Math.max(0, 1 - dist / 220); // distance attenuation for loud sounds
      switch (type) {
        case 'hit': {
          const w = msg.length > 6 ? weaponByIndex(msg[6]) : null;
          // Sparks on the car as you see it (other cars are drawn slightly in the past).
          if (c && c.status === RacerStatus.RACING && !isMe) { x = c.pos.x; y = c.pos.y + 0.9; z = c.pos.z; }
          const n = w?.kind === 'flame' ? 4 : 14;
          for (let i = 0; i < n; i++) this.glow.emit(x, y, z, (Math.random() - 0.5) * 12, Math.random() * 7, (Math.random() - 0.5) * 12, w?.kind === 'flame' ? C_FIRE : C_SPARK, 0.45, 0.35, { gravity: 18, drag: 1.5 });
          if (c) { c.flash = 1; if (Math.random() < 0.3) c.anim.react('shock', 0.7); }
          if (isMe) { this.shake = Math.max(this.shake, w?.kind === 'flame' ? 0.15 : Math.min(0.7, 0.15 + amount / 120)); this.hitFlash = Math.min(1, this.hitFlash + 0.35); haptic(30); }
          if (vol > 0 && w?.kind !== 'flame') audio.metalHit(vol, amount);
          break;
        }
        case 'crash': {
          for (let i = 0; i < 20; i++) this.glow.emit(x, y, z, (Math.random() - 0.5) * 12, Math.random() * 7, (Math.random() - 0.5) * 12, C_SPARK, 0.45, 0.4, { gravity: 18 });
          for (let i = 0; i < 6; i++) this.smoke.emit(x, y, z, (Math.random() - 0.5) * 3, 1 + Math.random(), (Math.random() - 0.5) * 3, C_SMOKE, 1.4, 0.8, { grow: 2 });
          for (const other of this.cars.values()) {
            if (other.pos.distanceToSquared(tmpV.set(x, y, z)) < 25) other.anim.react(amount > 18 ? 'dizzy' : 'shock', amount > 18 ? 2 : 1);
            if (other.id === net.myId && other.pos.distanceToSquared(tmpV) < 25) { this.shake = Math.max(this.shake, Math.min(1, amount / 25)); haptic(40); }
          }
          if (vol > 0) audio.crash(amount, vol);
          break;
        }
        case 'wall':
          for (let i = 0; i < 10; i++) this.glow.emit(x, y, z, (Math.random() - 0.5) * 8, Math.random() * 5, (Math.random() - 0.5) * 8, C_SPARK, 0.4, 0.35, { gravity: 18 });
          if (vol > 0) audio.crash(amount * 0.8, vol);
          if (isMe) this.shake = Math.max(this.shake, Math.min(0.8, amount / 30));
          break;
        case 'land':
          for (let i = 0; i < 10; i++) this.smoke.emit(x + (Math.random() - 0.5) * 3, y + 0.2, z + (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 4, 1, (Math.random() - 0.5) * 4, C_DUST, 1.5, 0.7, { grow: 2.5 });
          if (c && amount > 11) c.anim.react('dizzy', 1.6);
          if (isMe) this.shake = Math.max(this.shake, Math.min(0.6, amount / 25));
          if (near) audio.land();
          break;
        case 'explode': {
          this.fireball(x, y + 0.5, z, 1.3);
          this.rings.add(x, Math.max(0, y - 0.5), z, 6);
          if (c) {
            const m = c.parts.mats;
            this.debris.burst(x, y, z, ['#' + m.main.color.getHexString(), '#' + m.sec.color.getHexString(), '#2a2a33'], 18);
            c.ejectT = 1.6;
            c.ejectY = 0;
            c.ejectVy = 13;
            c.anim.react('dizzy', 3);
          }
          if (isMe) { this.shake = 1.2; haptic(150); }
          if (vol > 0) audio.blast(vol, 1.2);
          break;
        }
        case 'blast': {
          this.fireball(x, y, z, Math.max(0.6, amount / 7));
          this.rings.add(x, y, z, amount);
          for (const car of this.cars.values()) {
            const d = car.pos.distanceTo(tmpV.set(x, y, z));
            if (d < amount + 2) car.anim.react('dizzy', 1.5);
          }
          const me = this.cars.get(net.myId);
          if (me) { const d = me.pos.distanceTo(tmpV.set(x, y, z)); if (d < 40) { this.shake = Math.max(this.shake, Math.min(1.2, (40 - d) / 25)); haptic(80); } }
          if (vol > 0) audio.blast(vol, amount / 7);
          break;
        }
        case 'respawn':
          for (let i = 0; i < 30; i++) {
            const a = (i / 30) * Math.PI * 2;
            this.glow.emit(x + Math.cos(a) * 2.5, y + 0.3, z + Math.sin(a) * 2.5, 0, 4 + Math.random() * 2, 0, C_BOOST, 0.7, 0.7, { drag: 1 });
          }
          if (isMe || near) audio.respawn();
          if (isMe && amount === 0) this.killedBy = '';
          break;
        case 'pad':
          for (let i = 0; i < 18; i++) this.glow.emit(x, y + 0.3, z, (Math.random() - 0.5) * 6, 2 + Math.random() * 4, (Math.random() - 0.5) * 6, C_BOOST, 0.6, 0.5);
          if (isMe) { audio.pad(); haptic(25); }
          break;
        case 'shoot': {
          const w = weaponByIndex(amount);
          if (c) {
            c.muzzleFlash = w.kind === 'flame' ? 0.08 : 0.05;
            c.recoil = Math.min(1, c.recoil + (w.interval > 0.5 ? 1 : 0.4));
            if (w.id === 'minigun') c.spinRate = 1;
          }
          const m = this.muzzleOf(c, tmpV.set(x, y, z));
          const yaw = c ? c.yaw : 0;
          const fx = Math.sin(yaw), fz = Math.cos(yaw);
          if (w.kind === 'flame') {
            for (let i = 0; i < 6; i++) {
              const sp = 18 + Math.random() * 8, a = yaw + (Math.random() - 0.5) * w.spread * 1.6;
              this.glow.emit(m.x, m.y, m.z, Math.sin(a) * sp + (c ? Math.sin(c.yaw) * c.speed : 0), (Math.random() - 0.2) * 3, Math.cos(a) * sp + (c ? Math.cos(c.yaw) * c.speed : 0), Math.random() < 0.5 ? C_FIRE : C_FLAME, 0.9, 0.55, { grow: 5, drag: 2.2, gravity: -2 });
            }
            if (Math.random() < 0.3) this.smoke.emit(m.x + fx * 10, m.y + 1, m.z + fz * 10, 0, 2, 0, C_DARK_SMOKE, 2, 1, { grow: 3 });
          } else {
            const n = w.kind === 'projectile' ? 10 : 5;
            for (let i = 0; i < n; i++) this.glow.emit(m.x + fx * 0.3, m.y, m.z + fz * 0.3, fx * 4 + (Math.random() - 0.5) * 3, Math.random() * 2, fz * 4 + (Math.random() - 0.5) * 3, C_SPARK, w.kind === 'projectile' ? 1 : 0.5, 0.12);
            if (w.kind === 'projectile') for (let i = 0; i < 6; i++) this.smoke.emit(m.x - fx, m.y, m.z - fz, -fx * 3 + (Math.random() - 0.5) * 2, 1, -fz * 3 + (Math.random() - 0.5) * 2, C_SMOKE, 1.4, 0.9, { grow: 2.5 });
            // ejected brass for bullet guns
            if (w.kind === 'hitscan' && c && near && Math.random() < 0.6) this.glow.emit(m.x - fx * 0.6, m.y + 0.1, m.z - fz * 0.6, -fz * 3 + (Math.random() - 0.5), 2.5, fx * 3 + (Math.random() - 0.5), C_BRASS, 0.18, 0.5, { gravity: 20 });
          }
          if (isMe) { this.shake = Math.max(this.shake, w.kind === 'flame' ? 0.05 : w.interval > 0.5 ? 0.35 : 0.08); }
          if (vol > 0 || isMe) audio.gunshot(w.id, isMe ? 1 : vol);
          break;
        }
        case 'tracer': {
          const w = weaponByIndex(amount);
          const m = this.muzzleOf(c, tmpV.set(x, y, z));
          const ex = msg[6] ?? x, ey = msg[7] ?? y, ez = msg[8] ?? z;
          const hitY = ey - (y - m.y) * 0.4; // ease toward the visual gun height
          this.tracers.add(m.x, m.y, m.z, ex, hitY, ez, w.color, w.id === 'sniper' ? 0.12 : w.id === 'shotgun' ? 0.05 : 0.07, w.id === 'sniper' ? 0.18 : 0.09);
          if (w.id === 'sniper') for (let i = 0; i < 12; i++) {
            const t = i / 12;
            this.smoke.emit(m.x + (ex - m.x) * t, m.y + (hitY - m.y) * t, m.z + (ez - m.z) * t, 0, 0.3, 0, C_SMOKE, 0.5, 0.9, { grow: 1 });
          }
          // bullet whizzing past the camera
          if (!isMe && Math.random() < 0.25) {
            const d = distToSegment(camPos.x, camPos.z, m.x, m.z, ex, ez);
            if (d < 6) audio.whiz(1 - d / 6);
          }
          break;
        }
        case 'impact': {
          const w = weaponByIndex(amount);
          for (let i = 0; i < 6; i++) this.glow.emit(x, y, z, (Math.random() - 0.5) * 6, Math.random() * 4, (Math.random() - 0.5) * 6, C_SPARK, 0.3, 0.25, { gravity: 18 });
          this.smoke.emit(x, y, z, 0, 0.8, 0, C_DUST, w.id === 'sniper' ? 1.6 : 0.8, 0.6, { grow: 2 });
          if (near && Math.random() < 0.35) audio.ricochet(vol);
          break;
        }
        case 'bounce':
          if (near) audio.bounce(vol);
          break;
        case 'reload':
          if (isMe) audio.reload(weaponByIndex(amount).id);
          else if (near) audio.reload(weaponByIndex(amount).id, vol * 0.5);
          break;
        case 'reloaded':
          if (isMe) audio.reloaded(weaponByIndex(amount).id);
          break;
        case 'pickup': {
          const w = weaponByIndex(amount);
          for (let i = 0; i < 24; i++) this.glow.emit(x, y, z, (Math.random() - 0.5) * 8, Math.random() * 7, (Math.random() - 0.5) * 8, C_GOLD, 0.6, 0.6, { gravity: 6 });
          if (isMe) { audio.pickup(); audio.reloaded(w.id); this.banner = 'POWER UP! ×1.5 DAMAGE'; this.bannerT = 1.6; haptic(40); }
          else if (near) audio.pickup(vol * 0.5);
          break;
        }
        case 'repair':
          for (let i = 0; i < 30; i++) this.glow.emit(x + (Math.random() - 0.5) * 3, y + Math.random(), z + (Math.random() - 0.5) * 3, 0, 3 + Math.random() * 3, 0, C_REPAIR, 0.7, 0.8, { drag: 1 });
          if (c) c.anim.react('laugh', 1.2);
          if (isMe) { audio.repair(); this.banner = `REPAIRED +${Math.round(amount)}`; this.bannerT = 1.5; haptic(30); }
          else if (near) audio.repair(vol * 0.5);
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
          if (isMe && !this.arena) {
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

  /** World position of a car's gun muzzle (falls back to the server's point). */
  private muzzleOf(c: CarEntity | undefined, fallback: THREE.Vector3) {
    const m = c?.parts.gun?.muzzle;
    if (!m || c!.status === RacerStatus.DESTROYED) return tmpV3.copy(fallback);
    c!.parts.root.updateMatrixWorld();
    return m.getWorldPosition(tmpV3);
  }

  private fireball(x: number, y: number, z: number, scale: number) {
    const n = Math.round(40 * scale);
    for (let i = 0; i < n; i++) this.glow.emit(x, y, z, (Math.random() - 0.5) * 16 * scale, Math.random() * 12 * scale, (Math.random() - 0.5) * 16 * scale, i % 3 === 0 ? C_SPARK : i % 3 === 1 ? C_FIRE : C_FLAME, 1.6 * scale, 0.75, { gravity: 4, drag: 2.2, grow: 2 });
    // a rising smoke column, kept thin so it never blinds the camera
    for (let i = 0; i < n * 0.25; i++) this.smoke.emit(x + (Math.random() - 0.5) * 2, y + 1.5, z + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3 * scale, 3 + Math.random() * 4, (Math.random() - 0.5) * 3 * scale, Math.random() < 0.5 ? C_DARK_SMOKE : C_SMOKE, 1.5 * scale, 1.6, { grow: 2.2, drag: 1.4 });
    this.debris.burst(x, y, z, ['#3a3a3a', '#6b5a45', '#2a2a33'], Math.round(6 * scale));
  }

  private desiredWeapon = -1;
  private nextWasDown = false;
  private keyCycled = false;
  private prevWasDown = false;
  /** Pick a gun by index (0..9). Every vehicle carries all ten. */
  selectWeapon(i: number) {
    if (i < 0 || i >= WEAPONS.length) return;
    if (i !== this.desiredWeapon) audio.click();
    this.desiredWeapon = i;
    this.emitHud();
  }
  cycleWeapon(dir: number) {
    const cur = this.desiredWeapon >= 0 ? this.desiredWeapon : getWeapon(net.room?.state?.players?.get(net.myId)?.curWeapon ?? 'm4').index;
    this.selectWeapon((cur + dir + WEAPONS.length) % WEAPONS.length);
  }
  private onKey = (e: KeyboardEvent) => {
    if (this.paused || this.blocked || e.repeat) return;
    const b = settingsStore.get().bindings;
    if (b.nextWeapon.includes(e.code)) { this.cycleWeapon(1); this.keyCycled = true; return; }
    if (b.prevWeapon.includes(e.code)) { this.cycleWeapon(-1); this.keyCycled = true; return; }
    const m = /^Digit(\d)$/.exec(e.code) ?? /^Numpad(\d)$/.exec(e.code);
    if (!m) return;
    const n = Number(m[1]);
    this.selectWeapon(n === 0 ? 9 : n - 1);
  };

  private onKill(list: KillEvent[]) {
    const st = net.room?.state;
    const nameOf = (id: string) => st?.players?.get(id)?.name ?? '???';
    const colorOf = (id: string) => colorHex(st?.players?.get(id)?.colorMain ?? 'white');
    for (const k of list) {
      const meKiller = k.killer === net.myId, meVictim = k.victim === net.myId;
      this.killFeed.push({
        id: ++this.killFeedN, killer: k.killer ? nameOf(k.killer) : '', victim: nameOf(k.victim), weapon: k.weapon,
        meKiller, meVictim, killerColor: colorOf(k.killer), victimColor: colorOf(k.victim),
      });
      if (this.killFeed.length > 5) this.killFeed.shift();
      if (meKiller) {
        this.saavu = { title: 'SAAVU!', sub: `You destroyed ${nameOf(k.victim)}`, key: this.killFeedN };
        this.saavuT = 2.6;
        audio.saavu();
        haptic(120);
        this.cars.get(net.myId)?.anim.react('laugh', 2);
      }
      if (meVictim) this.killedBy = k.killer ? nameOf(k.killer) : '';
    }
    this.emitHud();
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

    // Projectiles: extrapolate from the last synced state
    const since = Math.min(0.12, (now - this.lastPatchT) / 1000);
    this.bolts.begin();
    st?.projectiles?.forEach((p: any) => {
      const grav = p.kind === 'grenade' ? 20 : 0;
      const px = p.x + p.vx * since, py = p.y + p.vy * since - 0.5 * grav * since * since, pz = p.z + p.vz * since;
      this.bolts.place(p.kind, px, py, pz, p.vx, p.vy - grav * since, p.vz, this.time);
      if (p.kind !== 'grenade') {
        const l = Math.hypot(p.vx, p.vy, p.vz) || 1;
        const bx = px - (p.vx / l) * 0.8, by = py - (p.vy / l) * 0.8, bz = pz - (p.vz / l) * 0.8;
        this.glow.emit(bx, by, bz, (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 1.5, Math.random() < 0.5 ? C_FIRE : C_FLAME, 0.6, 0.15);
        this.smoke.emit(bx, by, bz, (Math.random() - 0.5), 0.5, (Math.random() - 0.5), C_SMOKE, 0.7, 1.1, { grow: 1.6, drag: 2 });
      }
    });
    this.bolts.end();
    this.pickupViews.sync(st?.pickups, this.time);
    this.tracers.update(dt);
    this.rings.update(dt);
    this.saavuT = Math.max(0, this.saavuT - dt);
    if (this.saavuT <= 0) this.saavu = null;

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
    if (i === 0) {
      // Not enough history yet: hold the oldest sample (never jump ahead and back).
      const s = b[0];
      c.pos.set(s.x, s.y, s.z);
      c.yaw = s.yaw; c.pitch = s.pitch; c.roll = s.roll;
      return;
    }
    if (b[i].t <= renderT) {
      // The next update is late: keep the car moving along its velocity for a moment
      // instead of freezing and then jumping.
      const s = b[b.length - 1];
      const dt = Math.min(0.12, (renderT - s.t) / 1000);
      const vy = s.grounded ? 0 : s.vy;
      c.pos.set(s.x + s.vx * dt, Math.max(0, s.y + vy * dt), s.z + s.vz * dt);
      c.yaw = s.yaw + s.yawRate * dt; c.pitch = s.pitch; c.roll = s.roll;
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
    // Tip and roll around the middle of the body, not the ground point, so a
    // car that flips or lands on its roof stays above the road instead of sinking into it.
    P.tilt.rotation.set(c.pitch, 0, c.roll, 'YXZ');
    const pivot = P.topY * 0.5;
    tmpV2.set(0, pivot, 0).applyEuler(P.tilt.rotation);
    P.tilt.position.set(-tmpV2.x, pivot - tmpV2.y, -tmpV2.z);
    // While tumbling, keep the rotated body's lowest corner out of the ground.
    if (!c.grounded || Math.abs(c.roll) > 0.6 || Math.abs(c.pitch) > 0.6) {
      tmpM.makeRotationFromEuler(P.tilt.rotation);
      const e = tmpM.elements;
      const extentY = c.hw * Math.abs(e[1]) + pivot * Math.abs(e[5]) + c.hl * Math.abs(e[9]);
      const t = this.track;
      const groundY = t ? Math.max(0, queryTrack(t, c.pos.x, c.pos.z).height) : 0;
      const lift = extentY - pivot - (P.root.position.y - groundY);
      if (lift > 0) P.tilt.position.y += lift;
    }
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

    // Gun: recoil kick, muzzle flash, minigun spin
    P.gunMount.visible = !destroyed && !gone;
    const gun = P.gun;
    if (gun) {
      c.recoil = Math.max(0, c.recoil - dt * 7);
      gun.recoil.position.z = -c.recoil * 0.2;
      gun.recoil.rotation.x = -c.recoil * 0.12;
      c.muzzleFlash -= dt;
      c.flashMesh.visible = c.muzzleFlash > 0 && !destroyed;
      if (c.flashMesh.visible) {
        const s = 0.7 + Math.random() * 0.8;
        c.flashMesh.scale.set(s, s, gun.id === 'flamer' ? 2.5 : s);
        c.flashMesh.rotation.z = Math.random() * Math.PI;
        (c.flashMesh.material as THREE.MeshBasicMaterial).color.set(gun.id === 'flamer' ? '#ff9a2a' : '#ffd27a');
      }
      if (gun.spin) {
        c.spinRate = Math.max(0, c.spinRate - dt * 1.2);
        gun.spin.rotation.z += c.spinRate * 45 * dt;
      }
    }

    // Damage look: darken, dangle loose parts, flash on hits
    const ds = damageState(c.health, c.maxHealth);
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
    const t = this.track, ar = this.arena;
    if (t) {
      // Collision-aware: keep the camera inside the barrier corridor and above ground
      const q = queryTrack(t, tmpV.x, tmpV.z);
      const maxLat = t.halfWidth + 0.4;
      if (Math.abs(q.lateral) > maxLat && Math.abs(queryTrack(t, target.pos.x, target.pos.z).lateral) <= maxLat + 2) {
        tmpV.lerp(target.pos, Math.min(0.6, (Math.abs(q.lateral) - maxLat) / dist));
        tmpV.y = Math.max(tmpV.y, target.pos.y + height + 0.6);
      }
      tmpV.y = Math.max(tmpV.y, q.height + 1.2);
    } else if (ar) {
      // Stay inside the walls and in front of houses / boulders that would block the view.
      const lim = ar.half - 1;
      tmpV.x = Math.max(-lim, Math.min(lim, tmpV.x));
      tmpV.z = Math.max(-lim, Math.min(lim, tmpV.z));
      const f = arenaRay(ar, target.pos.x, target.pos.z, tmpV.x, tmpV.z, tmpV.y - 0.6, 0.6);
      if (f < 1) {
        const k = Math.max(0.12, f - 0.06);
        tmpV.x = target.pos.x + (tmpV.x - target.pos.x) * k;
        tmpV.z = target.pos.z + (tmpV.z - target.pos.z) * k;
        tmpV.y += (1 - k) * 2.2;
      }
      tmpV.y = Math.max(tmpV.y, 1.2);
    }
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

  private engineClass = '';
  private proxTimer = 0;
  private proxGains = new Map<string, number>();
  /** Battleground proximity voice: nearby drivers loud, far ones quiet. */
  private updateVoiceProximity(dt: number) {
    this.proxTimer -= dt;
    if (this.proxTimer > 0 || !voice.joined) return;
    this.proxTimer = 0.25;
    if (!this.arena) { voice.setProximity(null); return; }
    const me = this.cars.get(net.myId);
    if (!me) return;
    this.proxGains.clear();
    for (const c of this.cars.values()) {
      if (c.id === net.myId) continue;
      const d = c.pos.distanceTo(me.pos);
      this.proxGains.set(c.id, d < 40 ? 1 : Math.max(0.15, 1 - (d - 40) / 220));
    }
    voice.setProximity(this.proxGains);
  }
  private updateAudio(phase: string) {
    this.updateVoiceProximity(1 / 30);
    const me = this.cars.get(net.myId);
    const active = !!me && (phase === Phase.RACING || phase === Phase.COUNTDOWN) && me.status !== RacerStatus.DESTROYED && !this.paused;
    const cls = net.room?.state?.players?.get(net.myId)?.carClass ?? 'drifter';
    if (cls !== this.engineClass) { this.engineClass = cls; audio.setEngineProfile(cls); }
    const top = getVehicle(cls).maxSpeed;
    audio.updateEngine(Math.min(1.1, (me?.speed ?? 0) / top), this.curInput.throttle, !!me?.drifting, !!me?.boosting, active);
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
    st.players?.forEach((p: any) => rows.push({ id: p.id, name: p.name, tag: p.tag, rank: p.rank, me: p.id === net.myId, status: p.status, laps: p.laps, color: colorHex(p.colorMain), kills: p.kills ?? 0, deaths: p.deaths ?? 0 }));
    rows.sort((a, b) => a.rank - b.rank);
    let wrongWay = false;
    const t = this.track;
    if (t && me && this.predicting && me.status === RacerStatus.RACING) {
      const q = queryTrack(t, this.pred.x, this.pred.z);
      const i = q.index;
      const fwd = Math.sin(this.pred.yaw) * t.tx[i] + Math.cos(this.pred.yaw) * t.tz[i];
      const v = this.pred.vx * t.tx[i] + this.pred.vz * t.tz[i];
      wrongWay = fwd < -0.5 && v < -5;
    }
    if (me && me.rank !== this.lastRank) this.lastRank = me.rank;
    const laps = st.settings.laps;
    const w = getWeapon(me?.curWeapon || me?.weapon || 'm4');
    const battle = st.settings.mode === 'battle';
    if (me && me.ammo !== this.lastAmmo) {
      if (me.ammo === 0 && this.lastAmmo > 0 && me.reloadT <= 0) audio.dryFire();
      this.lastAmmo = me.ammo;
    }
    this.onHud({
      phase: st.phase,
      countdown: st.countdown,
      rank: me?.rank ?? 0,
      total: rows.filter((r) => r.status !== RacerStatus.LEFT).length,
      lap: Math.min(laps, (me?.laps ?? 0) + 1),
      laps,
      sprint: !!t && !t.closed,
      coveredKm: !t || t.closed ? 0 : Math.max(0, Math.min(t.raceLength, (me?.progress ?? 0) * t.ds)) / 1000,
      raceKm: t ? t.raceLength / 1000 : 0,
      health: me?.health ?? 0,
      damage: damageState(me?.health ?? 100, me?.maxHealth ?? 100),
      nitro: this.predicting ? this.pred.nitro : me?.nitro ?? 0,
      fireReady: me?.reloadT > 0 ? 0 : 1 - Math.min(1, (me?.fireCd ?? 0) / w.interval),
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
      maxHealth: me?.maxHealth ?? 100,
      weaponId: w.id,
      weaponName: w.label,
      ownWeapon: true,
      weaponIndex: this.desiredWeapon >= 0 ? this.desiredWeapon : w.index,
      powerT: me?.powerT ?? 0,
      ammo: me?.ammo ?? 0,
      magazine: w.magazine,
      reloading: me && me.reloadT > 0 ? 1 - me.reloadT / w.reload : 0,
      kills: me?.kills ?? 0,
      deaths: me?.deaths ?? 0,
      battle,
      killTarget: st.settings.killTarget ?? 10,
      timeLeft: st.timeLeft ?? 0,
      timeLimited: battle && (st.settings.timeLimit ?? 0) > 0,
      killFeed: [...this.killFeed],
      saavu: this.saavu,
      killedBy: this.killedBy,
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
    const ar = this.arena;
    if (ar) return this.drawArenaMap(ctx, c, dpr, ar);
    const t = this.track!;
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

  private arenaMapBase: HTMLCanvasElement | null = null;
  /** Battle map: centred on you, rotated so up is where you're heading. */
  private drawArenaMap(ctx: CanvasRenderingContext2D, c: HTMLCanvasElement, dpr: number, a: Arena) {
    const R = 150; // metres shown from centre to edge
    if (!this.arenaMapBase) {
      // pre-render the whole town once at 1 px = 1 m
      const b = document.createElement('canvas');
      const S = a.half * 2;
      b.width = b.height = S;
      const g = b.getContext('2d')!;
      g.fillStyle = '#5aa83d';
      g.fillRect(0, 0, S, S);
      g.fillStyle = '#5b5e6c';
      for (const r of a.roads) g.fillRect(r.x0 + a.half, r.z0 + a.half, r.x1 - r.x0, r.z1 - r.z0);
      for (const o of a.obstacles) {
        g.save();
        g.translate(o.x + a.half, o.z + a.half);
        if (o.shape === 'box') {
          g.rotate(-o.yaw);
          g.fillStyle = o.kind === 'bighouse' ? '#a7a39c' : '#e7d9bd';
          g.fillRect(-o.hw, -o.hl, o.hw * 2, o.hl * 2);
        } else {
          g.fillStyle = o.kind === 'tree' ? '#2f6b2a' : '#9a958c';
          g.beginPath();
          g.arc(0, 0, Math.max(1.5, o.r), 0, Math.PI * 2);
          g.fill();
        }
        g.restore();
      }
      g.strokeStyle = '#d8d2c4';
      g.lineWidth = 4;
      g.strokeRect(1, 1, S - 2, S - 2);
      this.arenaMapBase = b;
    }
    const me = (this.spectateId && this.cars.get(this.spectateId)) || this.cars.get(net.myId);
    const cx = me?.pos.x ?? 0, cz = me?.pos.z ?? 0;
    const W = c.width, H = c.height;
    const s = Math.min(W, H) / 2 / R;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, Math.min(W, H) / 2 - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#3d6e2c';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(W / 2, H / 2);
    // heading up: rotate world so camera yaw points to the top of the map
    ctx.rotate(Math.PI + this.camYaw);
    ctx.scale(-s, s);
    ctx.translate(-cx, -cz);
    ctx.drawImage(this.arenaMapBase, -a.half, -a.half, a.half * 2, a.half * 2);
    // pickups
    net.room?.state?.pickups?.forEach((p: any) => {
      if (!p.active) return;
      ctx.fillStyle = p.kind === 'repair' ? '#4dff9a' : '#ffd23f';
      ctx.fillRect(p.x - 3 / s, p.z - 3 / s, 6 / s, 6 / s);
    });
    for (const car of this.cars.values()) {
      if (car.status === RacerStatus.LEFT || car.status === RacerStatus.DESTROYED) continue;
      const mine = car.id === net.myId;
      ctx.beginPath();
      ctx.arc(car.pos.x, car.pos.z, (mine ? 5.5 : 4) * dpr / s, 0, Math.PI * 2);
      ctx.fillStyle = mine ? '#ffffff' : '#ff4757';
      ctx.fill();
      ctx.lineWidth = 1.5 * dpr / s;
      ctx.strokeStyle = '#1d1f3f';
      ctx.stroke();
    }
    ctx.restore();
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
