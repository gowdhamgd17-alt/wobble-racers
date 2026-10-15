// The one game simulation, shared by the authoritative server room and the
// offline in-browser room. It owns vehicles, weapons, projectiles, pickups,
// damage, kills, respawns, race progress, battle scoring and bot drivers.
// Hosts feed it inputs, call tick() at SIM_HZ and mirror its results into
// whatever state container they use (Colyseus schema or plain objects).

import {
  COUNTDOWN_SECONDS, IMPACT_DAMAGE_SCALE, KILL_CREDIT_SECONDS, NITRO, PHYS, PICKUP, Phase, RESPAWN, RacerStatus,
} from './constants';
import type { FxMessage, FxType, KillEvent } from './protocol';
import {
  NEUTRAL_INPUT, constrainToWorld, createVehicleState, findArenaSpot, findSafeSpot, isArena, placeInArena, placeOnTrack,
  resolveCarCollision, segmentHitsCar, stepVehicle, worldRay,
  type InputState, type VehicleState, type World,
} from './physics';
import { initialProgress, progressScore, totalLapsFor, updateProgress, type ProgressState } from './progress';
import { getTrack, pointAt, queryTrack, trackName, type Track } from './track';
import { getArena, type Arena } from './arena';
import { getVehicle } from './vehicles';
import { MUZZLE_HEIGHT, WEAPONS, getWeapon, type WeaponDef } from './weapons';
import { autopilot } from './autopilot';
import type { RaceSettings } from './validation';

// ------------------------------------------------------------------ world selection

export function getWorld(s: Partial<RaceSettings>): World {
  return s.mode === 'battle' ? getArena(s.arenaId) : getTrack(s as RaceSettings);
}

export function worldName(s: Partial<RaceSettings>) {
  if (s.mode === 'battle') return `${getArena(s.arenaId).def.name} · battle`;
  return trackName(s as RaceSettings);
}

// ------------------------------------------------------------------ types

/** The player record a host exposes (schema object on the server, plain object offline). */
export interface SimPlayer {
  id: string;
  name: string;
  status: string;
  connected: boolean;
  carClass: string;
  weapon: string;
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  yaw: number; yawRate: number; pitch: number; roll: number; pitchRate: number; rollRate: number;
  grounded: boolean; overturnT: number; rampVy: number; padCooldown: number; boosting: boolean; drifting: boolean;
  health: number; maxHealth: number; nitro: number; fireCd: number; protectT: number; respawnT: number;
  curWeapon: string; ammo: number; reloadT: number; kills: number; deaths: number; powerT: number;
  laps: number; nextCp: number; progress: number; rank: number; finishPlace: number; ackSeq: number; joinOrder: number;
}

export interface BotBrain {
  lane: number;
  skill: number; // 0.8 .. 1
  reaction: number; // seconds of aim before pulling the trigger
  aimT: number;
  targetId: string;
  retargetT: number;
  heading: number;
  thinkT: number;
  stuckT: number;
  reverseT: number;
  revSteer: number;
  wanderX: number;
  wanderZ: number;
  gunT: number; // time until the bot reconsiders which gun to hold
  gun: number;
}

export interface SimRacer {
  id: string;
  p: SimPlayer;
  veh: VehicleState;
  prog: ProgressState;
  input: InputState;
  queue: { seq: number; input: InputState }[];
  bot: BotBrain | null;
  destroyedT: number;
  deathF: number; deathLat: number; deathYaw: number; deathX: number; deathZ: number;
  lastRank: number;
  overtakeCd: number;
  lastHitBy: string;
  lastHitT: number;
  lastHitWeapon: string;
  mags: number[]; // rounds left in each gun's magazine (index = weapon index)
}

export interface SimProjectile {
  id: string;
  owner: string;
  kind: string; // weapon id
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  idx: number;
  target: string;
}

export interface SimPickup {
  id: string;
  kind: 'repair' | 'crate';
  x: number; y: number; z: number;
  active: boolean;
  timer: number;
}

export function createSimRacer(id: string, p: SimPlayer, bot = false, order = 0): SimRacer {
  return {
    id, p, veh: createVehicleState(0, 0, 0), prog: initialProgress(), input: { ...NEUTRAL_INPUT }, queue: [],
    bot: bot ? makeBrain(order) : null,
    destroyedT: 0, deathF: 0, deathLat: 0, deathYaw: 0, deathX: 0, deathZ: 0, lastRank: order + 1, overtakeCd: 0,
    lastHitBy: '', lastHitT: -99, lastHitWeapon: '', mags: WEAPONS.map((w) => w.magazine),
  };
}

export function makeBrain(order: number): BotBrain {
  return {
    lane: ((order % 5) - 2) * 2.6, skill: 0.82 + ((order * 37) % 17) / 100, reaction: 0.25 + ((order * 13) % 7) / 18,
    aimT: 0, targetId: '', retargetT: 0, heading: 0, thinkT: order % 3, stuckT: 0, reverseT: 0, revSteer: 1,
    wanderX: 0, wanderZ: 0, gunT: 0, gun: -1,
  };
}

const powerMul = (r: SimRacer) => ((r.p.powerT ?? 0) > 0 ? PICKUP.powerDamage : 1);
/** Seconds to swap guns. */
export const WEAPON_SWITCH_TIME = 0.4;

/** Seconds after the green light before anyone can shoot in a race. */
export const RACE_WEAPON_HOLD = 5;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const wrap = (a: number) => {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
};
const r2 = (v: number) => Math.round(v * 100) / 100;

// ------------------------------------------------------------------ simulation

export class GameSim<R extends SimRacer = SimRacer> {
  settings!: RaceSettings;
  world!: World;
  racers = new Map<string, R>();
  projectiles: SimProjectile[] = [];
  pickups: SimPickup[] = [];
  fxOut: FxMessage[] = [];
  killsOut: KillEvent[] = [];
  phase: string = Phase.LOBBY;
  countdown = 0;
  timeLeft = 0;
  time = 0;
  finishOrder: string[] = [];
  pairCooldown = new Map<string, number>();
  private projCounter = 0;
  rand: () => number = Math.random;

  constructor(settings: RaceSettings) {
    this.setSettings(settings);
  }

  setSettings(s: RaceSettings) {
    this.settings = { ...s };
    this.world = getWorld(this.settings);
  }

  get battle() {
    return this.settings.mode === 'battle';
  }
  get track(): Track | null {
    return isArena(this.world) ? null : this.world;
  }
  get arena(): Arena | null {
    return isArena(this.world) ? this.world : null;
  }

  add(r: R) {
    this.racers.set(r.id, r);
  }
  remove(id: string) {
    this.racers.delete(id);
  }

  fx(type: FxType, id: string, x: number, y: number, z: number, amount: number, ...extra: number[]) {
    this.fxOut.push([type, id, r2(x), r2(y), r2(z), r2(amount), ...extra.map(r2)]);
  }

  /** Put the given racers on the grid / spawn points and start the countdown. */
  begin(order: R[]) {
    this.world = getWorld(this.settings);
    this.time = 0;
    this.finishOrder = [];
    this.projectiles = [];
    this.pairCooldown.clear();
    this.timeLeft = this.battle && this.settings.timeLimit > 0 ? this.settings.timeLimit * 60 : 0;
    const arena = this.arena;
    const used: { x: number; z: number }[] = [];
    order.forEach((r, i) => {
      if (arena) {
        // Spread players across the town.
        const step = Math.max(1, Math.floor(arena.spawns.length / Math.max(1, order.length)));
        const sp = arena.spawns[(i * step + (i % 2) * 3) % arena.spawns.length];
        const spot = findArenaSpot(arena, sp.x, sp.z, sp.yaw, used, RESPAWN.safeClearance);
        r.veh = createVehicleState(spot.x, spot.z, spot.yaw);
        used.push(spot);
      } else {
        const t = this.track!;
        const g = t.grid[i % t.grid.length];
        r.veh = createVehicleState(g.x, g.z, g.yaw);
      }
      r.veh.nitro = this.settings.nitro ? NITRO.start : 0;
      r.prog = initialProgress(this.track ?? undefined);
      r.queue.length = 0;
      r.input = { ...NEUTRAL_INPUT };
      r.destroyedT = 0;
      r.lastRank = i + 1;
      r.lastHitBy = '';
      r.lastHitT = -99;
      const p = r.p;
      const cfg = getVehicle(p.carClass);
      p.status = RacerStatus.RACING;
      p.maxHealth = cfg.maxHealth;
      p.health = cfg.maxHealth;
      p.protectT = 0;
      p.respawnT = 0;
      p.laps = 0;
      p.nextCp = r.prog.nextCp;
      p.finishPlace = 0;
      p.progress = 0;
      p.rank = i + 1;
      p.kills = 0;
      p.deaths = 0;
      p.powerT = 0;
      this.resetWeapons(r);
      this.sync(r);
    });
    this.buildPickups();
    this.countdown = COUNTDOWN_SECONDS;
    this.phase = Phase.COUNTDOWN;
  }

  tick(dt: number) {
    if (this.phase === Phase.COUNTDOWN) {
      this.countdown = Math.max(0, this.countdown - dt);
      for (const r of this.racers.values()) {
        const next = r.queue.shift();
        if (next) r.p.ackSeq = next.seq;
        r.queue.length = 0;
      }
      if (this.countdown <= 0) this.phase = Phase.RACING;
    } else if (this.phase === Phase.RACING) {
      this.simulate(dt);
    }
  }

  // ---------------------------------------------------------------- main step

  private simulate(dt: number) {
    const st = this.settings;
    const rules = { nitro: st.nitro, drift: st.drift };
    this.time += dt;
    if (this.battle && st.timeLimit > 0) this.timeLeft = Math.max(0, this.timeLeft - dt);
    for (const [k, v] of this.pairCooldown) {
      if (v - dt <= 0) this.pairCooldown.delete(k);
      else this.pairCooldown.set(k, v - dt);
    }

    for (const r of this.racers.values()) {
      const p = r.p;
      let steps = 1;
      if (r.bot) {
        if (p.status === RacerStatus.RACING) r.input = this.battle ? this.battleBot(r, dt) : this.raceBot(r, dt);
        else if (p.status === RacerStatus.FINISHED && this.track) r.input = autopilot(r.veh, this.track, 9, r.bot.lane);
        else r.input = { ...NEUTRAL_INPUT };
      } else {
        const next = r.queue.shift();
        if (next) { r.input = next.input; p.ackSeq = next.seq; }
        // A client whose clock runs a little fast builds a backlog: catch up with an
        // extra step instead of later dropping inputs (dropped inputs = rubber-banding).
        if (r.queue.length > 2) steps = 2;
      }
      const offline = !p.connected || p.status === RacerStatus.LEFT || p.status === RacerStatus.DISCONNECTED;
      if (offline) r.input = { ...NEUTRAL_INPUT };
      p.protectT = Math.max(0, p.protectT - dt);
      p.powerT = Math.max(0, (p.powerT ?? 0) - dt);
      r.overtakeCd = Math.max(0, r.overtakeCd - dt);

      if (p.status === RacerStatus.DESTROYED) {
        r.destroyedT -= dt;
        p.respawnT = Math.max(0, r.destroyedT);
        if (r.destroyedT <= 0) this.respawn(r);
        continue;
      }
      if (p.status === RacerStatus.LEFT) continue;
      for (let k = 0; k < steps; k++) {
        if (k > 0) {
          const next = r.queue.shift();
          if (next && !offline) { r.input = next.input; p.ackSeq = next.seq; }
        }
        this.stepRacer(r, dt, rules);
        if (p.status === RacerStatus.DESTROYED) break;
      }
    }

    if (st.collisions) {
      // Two passes so piles of cars fully separate; then walls win over car pushes.
      this.collideCars();
      this.collideCars();
      for (const r of this.racers.values()) {
        if (r.p.status === RacerStatus.RACING) constrainToWorld(r.veh, getVehicle(r.p.carClass), this.world);
      }
    }
    this.stepProjectiles(dt);
    for (const pk of this.pickups) {
      if (!pk.active) {
        pk.timer -= dt;
        if (pk.timer <= 0) pk.active = true;
      }
    }
    this.updateRanks();
    for (const r of this.racers.values()) this.sync(r);
    this.checkComplete();
  }

  /** One fixed step of one car: driving, damage from landings / walls, weapons, pickups, race progress. */
  private stepRacer(r: SimRacer, dt: number, rules: { nitro: boolean; drift: boolean }) {
    const p = r.p;
    const st = this.settings;
    const cfg = getVehicle(p.carClass);
    const input = r.input;
    const ev = stepVehicle(r.veh, input, cfg, this.world, rules, dt);
    const v = r.veh;
    if (ev.boostPad) this.fx('pad', p.id, v.x, v.y, v.z, 0);
    if (ev.landingSpeed > PHYS.landingDamageSpeed) {
      this.damage(r, ((ev.landingSpeed - PHYS.landingDamageSpeed) * 2.5 * IMPACT_DAMAGE_SCALE) / cfg.damageResistance, 'fall');
    } else if (ev.landingSpeed > 6) {
      this.fx('land', p.id, v.x, v.y, v.z, ev.landingSpeed);
    }
    if (ev.wallImpact > PHYS.wallDamageSpeed) {
      this.damage(r, ((ev.wallImpact - PHYS.wallDamageSpeed) * 0.8 * IMPACT_DAMAGE_SCALE) / cfg.damageResistance, 'wall');
      this.fx('wall', p.id, v.x, v.y + 0.5, v.z, ev.wallImpact);
    }
    if (ev.recover) this.recover(r);

    if (p.status === RacerStatus.RACING) {
      if (input.weapon !== undefined && input.weapon >= 0) this.selectWeapon(r, input.weapon);
      this.weapons(r, input, dt);
      this.collectPickups(r);
    } else {
      p.reloadT = 0;
    }

    if (!this.battle && p.status === RacerStatus.RACING) {
      const t = this.track!;
      const q = queryTrack(t, v.x, v.z, v.trackIdx);
      const pe = updateProgress(t, r.prog, q.f, q.lateral, totalLapsFor(t, st.laps));
      if (pe === 'lap') this.fx('lap', p.id, v.x, v.y, v.z, r.prog.laps);
      if (pe === 'finish') this.finish(r);
      p.progress = progressScore(t, r.prog, q.f);
    }
    p.laps = r.prog.laps;
    p.nextCp = r.prog.nextCp;
  }

  private collideCars() {
    const list = [...this.racers.values()].filter((r) => r.p.status === RacerStatus.RACING);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const res = resolveCarCollision(a.veh, b.veh, getVehicle(a.p.carClass), getVehicle(b.p.carClass));
        if (!res.hit) continue;
        const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
        if (this.pairCooldown.has(key)) continue; // push still applied, no repeat damage
        this.pairCooldown.set(key, PHYS.collisionPairCooldown);
        if (res.closingSpeed > 4) {
          this.fx('crash', a.id, (a.veh.x + b.veh.x) / 2, (a.veh.y + b.veh.y) / 2 + 0.6, (a.veh.z + b.veh.z) / 2, res.closingSpeed);
        }
        if (res.damageA > 0) this.damage(a, res.damageA * IMPACT_DAMAGE_SCALE, 'ram', b.id);
        if (res.damageB > 0) this.damage(b, res.damageB * IMPACT_DAMAGE_SCALE, 'ram', a.id);
      }
    }
  }

  // ---------------------------------------------------------------- weapons

  /** Fresh car: every gun fully loaded, holding the gun you last chose. */
  resetWeapons(r: SimRacer) {
    const p = r.p;
    p.curWeapon = getWeapon(p.weapon).id;
    p.weapon = p.curWeapon;
    r.mags = WEAPONS.map((w) => w.magazine);
    p.ammo = getWeapon(p.curWeapon).magazine;
    p.reloadT = 0;
    p.fireCd = 0;
  }

  /** Every vehicle carries all ten guns; switching takes a moment and cancels a reload. */
  selectWeapon(r: SimRacer, index: number) {
    const p = r.p;
    const w = WEAPONS[Math.round(index)];
    if (!w || w.id === p.curWeapon) return;
    if (!r.mags || r.mags.length !== WEAPONS.length) r.mags = WEAPONS.map((x) => x.magazine);
    r.mags[getWeapon(p.curWeapon).index] = p.reloadT > 0 ? 0 : p.ammo;
    p.curWeapon = w.id;
    p.weapon = w.id;
    p.ammo = r.mags[w.index];
    p.reloadT = 0;
    p.fireCd = WEAPON_SWITCH_TIME;
    this.fx('reloaded', p.id, r.veh.x, r.veh.y + 1, r.veh.z, w.index);
    if (p.ammo <= 0) this.startReload(r);
  }

  private weapons(r: SimRacer, input: InputState, dt: number) {
    const p = r.p;
    const w = getWeapon(p.curWeapon);
    if (p.reloadT > 0) {
      p.reloadT -= dt;
      p.fireCd = Math.max(0, p.fireCd - dt);
      if (p.reloadT <= 0) {
        p.reloadT = 0;
        p.ammo = w.magazine;
        if (r.mags) r.mags[w.index] = p.ammo;
        this.fx('reloaded', p.id, r.veh.x, r.veh.y + 1, r.veh.z, w.index);
      }
      return;
    }
    if (input.reload && p.ammo < w.magazine) return this.startReload(r);
    p.fireCd -= dt;
    // Races: guns stay cold for the first seconds so the grid isn't a firing squad.
    const cold = !this.battle && this.time < RACE_WEAPON_HOLD;
    if (!input.fire || !this.settings.weapons || cold) {
      if (p.fireCd < 0) p.fireCd = 0;
      return;
    }
    let shots = 0;
    while (p.fireCd <= 0 && shots < 3) {
      if (p.ammo <= 0) return this.startReload(r);
      this.shoot(r, w);
      p.ammo -= 1;
      if (r.mags) r.mags[w.index] = p.ammo;
      p.fireCd += w.interval;
      shots++;
    }
    if (p.ammo <= 0) this.startReload(r);
  }

  private startReload(r: SimRacer) {
    const p = r.p;
    const w = getWeapon(p.curWeapon);
    p.reloadT = w.reload;
    this.fx('reload', p.id, r.veh.x, r.veh.y + 1, r.veh.z, w.index);
  }

  /** Aim along the car's nose, nudged onto a target inside the weapon's assist cone. */
  private aim(r: SimRacer, w: WeaponDef): { yaw: number; target: string } {
    const v = r.veh;
    let yaw = v.yaw, target = '', best = Infinity;
    const cone = Math.max(w.aimAssist, w.kind === 'flame' ? w.spread : 0);
    if (cone <= 0) return { yaw, target };
    const range = w.kind === 'projectile' ? w.range * 0.8 : w.range;
    for (const o of this.racers.values()) {
      if (o === r || o.p.status !== RacerStatus.RACING) continue;
      const dx = o.veh.x - v.x, dz = o.veh.z - v.z;
      const d = Math.hypot(dx, dz);
      if (d > range || d < 0.5) continue;
      if (Math.abs(o.veh.y - v.y) > 4) continue;
      const diff = Math.abs(wrap(Math.atan2(dx, dz) - v.yaw));
      if (diff > cone) continue;
      const score = diff * 40 + d;
      if (score < best) {
        best = score;
        target = o.id;
        let tx = o.veh.x, tz = o.veh.z;
        if (w.kind === 'projectile' && w.speed > 0) {
          const t = d / w.speed;
          tx += o.veh.vx * t * 0.8;
          tz += o.veh.vz * t * 0.8;
        }
        yaw = Math.atan2(tx - v.x, tz - v.z);
      }
    }
    if (w.kind === 'flame') yaw = v.yaw;
    return { yaw, target };
  }

  private shoot(r: SimRacer, w: WeaponDef) {
    const v = r.veh;
    const cfg = getVehicle(r.p.carClass);
    const { yaw, target } = this.aim(r, w);
    const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
    const mx = v.x + fx * (cfg.halfLength * 0.25 + 1.2), mz = v.z + fz * (cfg.halfLength * 0.25 + 1.2);
    const my = v.y + MUZZLE_HEIGHT;
    this.fx('shoot', r.id, mx, my, mz, w.index);
    if (w.kind === 'hitscan') {
      for (let k = 0; k < w.pellets; k++) {
        const a = yaw + (this.rand() * 2 - 1) * w.spread;
        const dx = Math.sin(a), dz = Math.cos(a);
        const ex = mx + dx * w.range, ez = mz + dz * w.range;
        let t = worldRay(this.world, mx, mz, ex, ez, my, v.trackIdx);
        let hit: SimRacer | null = null;
        for (const o of this.racers.values()) {
          if (o === r || o.p.status !== RacerStatus.RACING) continue;
          if (Math.abs(o.veh.y + 0.7 - my) > 2.4) continue;
          const oc = getVehicle(o.p.carClass);
          const th = segmentHitsCar(mx, mz, ex, ez, 0.15, o.veh.x, o.veh.z, o.veh.yaw, oc.halfLength, oc.halfWidth);
          if (th >= 0 && th < t) { t = th; hit = o; }
        }
        const hx = mx + dx * w.range * t, hz = mz + dz * w.range * t;
        this.fx('tracer', r.id, mx, my, mz, w.index, hx, my, hz);
        if (hit) this.applyHit(hit, w.damage, w, r, dx, dz);
        else if (t < 1) this.fx('impact', r.id, hx, my, hz, w.index);
      }
    } else if (w.kind === 'flame') {
      for (const o of this.racers.values()) {
        if (o === r || o.p.status !== RacerStatus.RACING) continue;
        const dx = o.veh.x - v.x, dz = o.veh.z - v.z;
        const d = Math.hypot(dx, dz);
        const reach = w.range + getVehicle(o.p.carClass).halfLength;
        if (d > reach || Math.abs(o.veh.y - v.y) > 3) continue;
        if (Math.abs(wrap(Math.atan2(dx, dz) - v.yaw)) > w.spread + 0.25 / Math.max(1, d / 6)) continue;
        if (worldRay(this.world, mx, mz, o.veh.x, o.veh.z, my, v.trackIdx) < 0.95) continue;
        this.applyHit(o, w.damage, w, r, dx / (d || 1), dz / (d || 1), true);
      }
    } else {
      const fwd = Math.max(0, v.vx * fx + v.vz * fz);
      const sp = w.speed + fwd * 0.6;
      this.projectiles.push({
        id: 'p' + this.projCounter++, owner: r.id, kind: w.id, x: mx, y: my, z: mz,
        vx: Math.sin(yaw) * sp, vy: w.lift, vz: Math.cos(yaw) * sp, life: w.fuse, idx: v.trackIdx, target,
      });
    }
  }

  private applyHit(o: SimRacer, dmg: number, w: WeaponDef, by: SimRacer, dx: number, dz: number, quiet = false) {
    const v = o.veh;
    const cfg = getVehicle(o.p.carClass);
    const massK = 1300 / cfg.mass;
    v.vx += dx * w.knock * massK;
    v.vz += dz * w.knock * massK;
    if (w.knock >= 5 && v.grounded && v.overturnT <= 0) {
      v.grounded = false;
      v.vy = 3;
      v.rollRate = (this.rand() - 0.5) * 3;
    }
    if (!quiet || this.rand() < 0.25) this.fx('hit', o.id, v.x, v.y + 0.9, v.z, dmg, w.index);
    this.damage(o, (dmg * powerMul(by)) / Math.sqrt(cfg.damageResistance), w.id, by.id);
  }

  private groundAt(x: number, z: number, idx: number) {
    if (!this.track) return 0;
    return queryTrack(this.track, x, z, idx).height;
  }

  private stepProjectiles(dt: number) {
    const keep: SimProjectile[] = [];
    for (const pr of this.projectiles) {
      const w = getWeapon(pr.kind);
      pr.life -= dt;
      if (w.turnRate > 0 && pr.target) {
        const t = this.racers.get(pr.target);
        if (t && t.p.status === RacerStatus.RACING) {
          const sp = Math.hypot(pr.vx, pr.vz);
          const cur = Math.atan2(pr.vx, pr.vz);
          const want = Math.atan2(t.veh.x - pr.x, t.veh.z - pr.z);
          const nyaw = cur + clamp(wrap(want - cur), -w.turnRate * dt, w.turnRate * dt);
          pr.vx = Math.sin(nyaw) * sp;
          pr.vz = Math.cos(nyaw) * sp;
          pr.vy += clamp((t.veh.y + 0.8 - pr.y) * 2 - pr.vy, -10 * dt, 10 * dt);
        }
      }
      if (w.gravity > 0) pr.vy -= w.gravity * dt;
      const x0 = pr.x, z0 = pr.z, y0 = pr.y;
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      pr.z += pr.vz * dt;

      // Direct hit on a car
      let hit: SimRacer | null = null, bestT = 2;
      for (const o of this.racers.values()) {
        if (o.id === pr.owner || o.p.status !== RacerStatus.RACING) continue;
        if (Math.abs(o.veh.y + 0.7 - (y0 + pr.y) / 2) > 1.8) continue;
        const oc = getVehicle(o.p.carClass);
        const t = segmentHitsCar(x0, z0, pr.x, pr.z, 0.35, o.veh.x, o.veh.z, o.veh.yaw, oc.halfLength, oc.halfWidth);
        if (t >= 0 && t < bestT) { bestT = t; hit = o; }
      }
      const tw = worldRay(this.world, x0, z0, pr.x, pr.z, pr.y, pr.idx);
      if (this.track) pr.idx = queryTrack(this.track, pr.x, pr.z, pr.idx).index;
      const ground = this.groundAt(pr.x, pr.z, pr.idx);

      if (hit && bestT <= tw) {
        this.explode(x0 + (pr.x - x0) * bestT, y0 + (pr.y - y0) * bestT, z0 + (pr.z - z0) * bestT, w, pr.owner, hit.id);
        continue;
      }
      if (tw < 1) {
        if (w.gravity > 0) {
          // Grenades bounce off walls and houses.
          pr.x = x0; pr.z = z0; pr.y = Math.max(y0, ground + 0.3);
          pr.vx *= -0.45;
          pr.vz *= -0.45;
          this.fx('bounce', pr.owner, pr.x, pr.y, pr.z, 0);
        } else {
          this.explode(x0 + (pr.x - x0) * tw, pr.y, z0 + (pr.z - z0) * tw, w, pr.owner, '');
          continue;
        }
      }
      if (pr.y <= ground + 0.25) {
        if (w.gravity > 0) {
          pr.y = ground + 0.25;
          if (pr.vy < -2) this.fx('bounce', pr.owner, pr.x, pr.y, pr.z, 0);
          pr.vy = Math.abs(pr.vy) * 0.4;
          pr.vx *= 0.75;
          pr.vz *= 0.75;
        } else {
          this.explode(pr.x, ground + 0.3, pr.z, w, pr.owner, '');
          continue;
        }
      }
      if (pr.life <= 0) {
        this.explode(pr.x, pr.y, pr.z, w, pr.owner, '');
        continue;
      }
      keep.push(pr);
    }
    this.projectiles = keep;
  }

  private explode(x: number, y: number, z: number, w: WeaponDef, owner: string, directId: string) {
    this.fx('blast', owner, x, y, z, w.splashRadius);
    const by = this.racers.get(owner);
    for (const o of this.racers.values()) {
      if (o.p.status !== RacerStatus.RACING) continue;
      const v = o.veh;
      const dx = v.x - x, dz = v.z - z, dy = v.y + 0.7 - y;
      const d = Math.max(0, Math.hypot(dx, dz, dy) - 1.2);
      const direct = o.id === directId;
      if (d > w.splashRadius && !direct) continue;
      const k = direct ? 1 : 1 - 0.7 * clamp(d / w.splashRadius, 0, 1);
      const cfg = getVehicle(o.p.carClass);
      const massK = 1300 / cfg.mass;
      const l = Math.hypot(dx, dz) || 1;
      const self = o.id === owner;
      const push = w.knock * 1.6 * k * massK * (self ? 0.5 : 1);
      v.vx += (dx / l) * push;
      v.vz += (dz / l) * push;
      if (v.overturnT <= 0) {
        v.grounded = false;
        v.vy = Math.max(v.vy, (4 + 6 * k) * Math.min(1.3, massK) * (self ? 0.5 : 1));
        v.rollRate = (this.rand() - 0.5) * 6 * k;
        v.pitchRate = (this.rand() - 0.5) * 3 * k;
      }
      if (self) continue; // no self damage, just a shove
      const dmg = w.splash * k + (direct ? w.damage : 0);
      this.fx('hit', o.id, v.x, v.y + 0.9, v.z, dmg, w.index);
      if (by) this.damage(o, (dmg * powerMul(by)) / Math.sqrt(cfg.damageResistance), w.id, by.id);
      else this.damage(o, dmg / Math.sqrt(cfg.damageResistance), w.id);
    }
  }

  // ---------------------------------------------------------------- pickups

  private buildPickups() {
    this.pickups = [];
    let n = 0;
    const add = (kind: 'repair' | 'crate', x: number, y: number, z: number) => {
      this.pickups.push({ id: 'k' + n++, kind, x, y, z, active: true, timer: 0 });
    };
    const arena = this.arena;
    if (arena) {
      for (const s of arena.repairSpots) add('repair', s.x, 0, s.z);
      if (this.settings.weapons) for (const s of arena.crateSpots) add('crate', s.x, 0, s.z);
      return;
    }
    const t = this.track!;
    const raceLen = t.raceLength;
    let i = 0;
    for (let d = 120; d < raceLen - 40; d += PICKUP.raceSpacing, i++) {
      let f = t.startIdx + d / t.ds;
      if (t.closed) f = ((f % t.n) + t.n) % t.n;
      const idx = Math.floor(f);
      let onRamp = false;
      for (let k = -3; k <= 6; k++) {
        const j = t.closed ? (((idx + k) % t.n) + t.n) % t.n : clamp(idx + k, 0, t.n - 1);
        if (t.heights[j] > 0.01) onRamp = true;
      }
      if (onRamp) continue;
      const side = i % 2 === 0 ? 1 : -1;
      const pr = pointAt(t, f, side * t.halfWidth * 0.45);
      add('repair', pr.x, 0, pr.z);
      if (this.settings.weapons) {
        const pc = pointAt(t, f, -side * t.halfWidth * 0.45);
        add('crate', pc.x, 0, pc.z);
      }
    }
  }

  private collectPickups(r: SimRacer) {
    const v = r.veh;
    if (v.y > 3) return;
    const cfg = getVehicle(r.p.carClass);
    const reach = cfg.halfWidth + PICKUP.radius;
    for (const pk of this.pickups) {
      if (!pk.active) continue;
      if ((pk.x - v.x) ** 2 + (pk.z - v.z) ** 2 > reach * reach) continue;
      const p = r.p;
      if (pk.kind === 'repair') {
        if (p.health >= p.maxHealth - 0.5) continue;
        const before = p.health;
        p.health = Math.min(p.maxHealth, p.health + p.maxHealth * PICKUP.repairFraction);
        pk.active = false;
        pk.timer = PICKUP.repairRespawn;
        this.fx('repair', p.id, pk.x, v.y + 1, pk.z, p.health - before);
      } else {
        if (!this.settings.weapons) continue;
        // Power crate: every gun reloaded instantly and a damage boost for a while.
        const w = getWeapon(p.curWeapon);
        r.mags = WEAPONS.map((x) => x.magazine);
        p.ammo = w.magazine;
        p.reloadT = 0;
        p.powerT = PICKUP.powerSeconds;
        pk.active = false;
        pk.timer = PICKUP.crateRespawn;
        this.fx('pickup', p.id, pk.x, v.y + 1, pk.z, w.index);
      }
    }
  }

  // ---------------------------------------------------------------- damage & life

  /** The only path by which health goes down. */
  damage(r: SimRacer, amount: number, cause: string, by?: string) {
    const p = r.p;
    if (!this.settings.damage) return;
    if (p.status !== RacerStatus.RACING || p.protectT > 0 || p.health <= 0) return;
    if (!(amount > 0)) return;
    if (by && by !== r.id) {
      r.lastHitBy = by;
      r.lastHitT = this.time;
      r.lastHitWeapon = cause;
    }
    p.health = Math.max(0, p.health - amount);
    if (p.health <= 0) this.destroy(r, cause);
  }

  private destroy(r: SimRacer, cause: string) {
    const p = r.p;
    const v = r.veh;
    if (this.track) {
      const q = queryTrack(this.track, v.x, v.z, v.trackIdx);
      r.deathF = q.f;
      r.deathLat = q.lateral;
    }
    r.deathX = v.x;
    r.deathZ = v.z;
    r.deathYaw = v.yaw;
    r.destroyedT = this.battle ? RESPAWN.battleDestroyedSeconds : RESPAWN.destroyedSeconds;
    p.respawnT = r.destroyedT;
    p.status = RacerStatus.DESTROYED;
    p.health = 0;
    p.reloadT = 0;
    p.deaths += 1;
    this.fx('explode', p.id, v.x, v.y + 0.5, v.z, 0);
    const killer = r.lastHitBy && this.time - r.lastHitT <= KILL_CREDIT_SECONDS ? this.racers.get(r.lastHitBy) : undefined;
    if (killer && killer !== r) {
      killer.p.kills += 1;
      this.killsOut.push({ killer: killer.id, victim: r.id, weapon: r.lastHitWeapon || cause });
    } else {
      this.killsOut.push({ killer: '', victim: r.id, weapon: cause });
    }
    r.lastHitBy = '';
    v.vx = v.vy = v.vz = 0;
    v.boosting = false;
    v.drifting = false;
  }

  private occupiedExcept(r: SimRacer) {
    const out: { x: number; z: number }[] = [];
    for (const o of this.racers.values()) {
      if (o === r) continue;
      if (o.p.status === RacerStatus.RACING || o.p.status === RacerStatus.DISCONNECTED) out.push({ x: o.veh.x, z: o.veh.z });
    }
    return out;
  }

  respawn(r: SimRacer) {
    const nitro = r.veh.nitro;
    const arena = this.arena;
    if (arena) {
      // Fresh car at the spawn point furthest from the action.
      const enemies = this.occupiedExcept(r);
      let best = arena.spawns[0], bestScore = -Infinity;
      for (const sp of arena.spawns) {
        let near = Infinity;
        for (const e of enemies) near = Math.min(near, Math.hypot(e.x - sp.x, e.z - sp.z));
        const score = Math.min(near, 160) + this.rand() * 40;
        if (score > bestScore) { bestScore = score; best = sp; }
      }
      const spot = findArenaSpot(arena, best.x, best.z, best.yaw, enemies, RESPAWN.safeClearance);
      placeInArena(r.veh, spot.x, spot.z, spot.yaw);
    } else {
      const t = this.track!;
      const spot = findSafeSpot(t, r.deathF, r.deathLat, this.occupiedExcept(r), RESPAWN.safeClearance);
      placeOnTrack(r.veh, t, spot.f, spot.lateral, r.deathYaw);
    }
    r.veh.nitro = nitro;
    r.veh.recoverCooldown = 0;
    const p = r.p;
    p.maxHealth = getVehicle(p.carClass).maxHealth;
    p.health = p.maxHealth;
    p.protectT = RESPAWN.protectionSeconds;
    p.respawnT = 0;
    p.status = r.prog.finished ? RacerStatus.FINISHED : RacerStatus.RACING;
    this.resetWeapons(r);
    this.fx('respawn', p.id, r.veh.x, r.veh.y, r.veh.z, 0);
  }

  private recover(r: SimRacer) {
    const nitro = r.veh.nitro;
    const arena = this.arena;
    if (arena) {
      const spot = findArenaSpot(arena, r.veh.x, r.veh.z, r.veh.yaw, this.occupiedExcept(r), RESPAWN.safeClearance);
      placeInArena(r.veh, spot.x, spot.z, spot.yaw);
    } else {
      const t = this.track!;
      const q = queryTrack(t, r.veh.x, r.veh.z);
      const spot = findSafeSpot(t, q.f, q.lateral, this.occupiedExcept(r), RESPAWN.safeClearance);
      placeOnTrack(r.veh, t, spot.f, spot.lateral, r.veh.yaw);
    }
    r.veh.nitro = nitro;
    r.p.protectT = Math.max(r.p.protectT, 1);
    this.fx('respawn', r.id, r.veh.x, r.veh.y, r.veh.z, 1);
  }

  private finish(r: SimRacer) {
    if (this.finishOrder.includes(r.id)) return; // never twice
    this.finishOrder.push(r.id);
    r.p.finishPlace = this.finishOrder.length;
    r.p.status = RacerStatus.FINISHED;
    r.p.protectT = 0;
    r.p.reloadT = 0;
    this.fx('finish', r.id, r.veh.x, r.veh.y, r.veh.z, r.p.finishPlace);
  }

  private battleOrder() {
    return [...this.racers.values()].sort((a, b) => {
      const la = a.p.status === RacerStatus.LEFT ? 1 : 0, lb = b.p.status === RacerStatus.LEFT ? 1 : 0;
      if (la !== lb) return la - lb;
      return b.p.kills - a.p.kills || a.p.deaths - b.p.deaths || a.p.joinOrder - b.p.joinOrder;
    });
  }

  private updateRanks() {
    if (this.battle) {
      this.battleOrder().forEach((r, i) => { r.lastRank = r.p.rank = i + 1; });
      return;
    }
    const list = [...this.racers.values()].filter((r) => r.p.status !== RacerStatus.LEFT);
    list.sort((a, b) => (a.p.finishPlace || 999) - (b.p.finishPlace || 999) || b.p.progress - a.p.progress);
    list.forEach((r, i) => {
      const rank = i + 1;
      if (rank < r.lastRank && r.p.status === RacerStatus.RACING && r.overtakeCd <= 0) {
        this.fx('overtake', r.id, r.veh.x, r.veh.y, r.veh.z, rank);
        r.overtakeCd = 3;
      }
      r.lastRank = rank;
      r.p.rank = rank;
    });
    let n = list.length;
    for (const r of this.racers.values()) if (r.p.status === RacerStatus.LEFT) r.p.rank = ++n;
  }

  /** Ends the round when its goal is met. Hosts may call it after removing players. */
  checkComplete() {
    if (this.phase !== Phase.RACING) return;
    let active = 0, connected = 0, topKills = 0;
    for (const r of this.racers.values()) {
      const st = r.p.status;
      if (st === RacerStatus.RACING || st === RacerStatus.DESTROYED || st === RacerStatus.DISCONNECTED) active++;
      if (r.p.connected) connected++;
      topKills = Math.max(topKills, r.p.kills);
    }
    let done = active === 0 || connected === 0;
    if (this.battle) {
      done = done || topKills >= this.settings.killTarget || (this.settings.timeLimit > 0 && this.timeLeft <= 0);
    }
    if (done) this.end();
  }

  end() {
    if (this.battle) {
      const order = this.battleOrder();
      this.finishOrder = order.map((r) => r.id);
      order.forEach((r, i) => {
        r.p.finishPlace = i + 1;
        r.p.rank = i + 1;
        if (r.p.status === RacerStatus.RACING || r.p.status === RacerStatus.DESTROYED) r.p.status = RacerStatus.FINISHED;
      });
    }
    this.projectiles = [];
    this.phase = Phase.RESULTS;
  }

  sync(r: SimRacer) {
    const p = r.p, v = r.veh;
    p.x = v.x; p.y = v.y; p.z = v.z;
    p.vx = v.vx; p.vy = v.vy; p.vz = v.vz;
    p.yaw = v.yaw; p.yawRate = v.yawRate;
    p.pitch = v.pitch; p.roll = v.roll; p.pitchRate = v.pitchRate; p.rollRate = v.rollRate;
    p.grounded = v.grounded;
    p.overturnT = v.overturnT;
    p.rampVy = v.rampVy;
    p.padCooldown = v.padCooldown;
    p.boosting = v.boosting;
    p.drifting = v.drifting;
    p.nitro = v.nitro;
  }

  // ---------------------------------------------------------------- bots

  private canSee(r: SimRacer, o: SimRacer) {
    return worldRay(this.world, r.veh.x, r.veh.z, o.veh.x, o.veh.z, r.veh.y + MUZZLE_HEIGHT, r.veh.trackIdx) > 0.97;
  }

  /** Trigger discipline shared by both bot types: aim for a moment, then fire. */
  private botTrigger(r: SimRacer, dt: number, maxRange: number) {
    const b = r.bot!;
    const w = getWeapon(r.p.curWeapon);
    if (!this.settings.weapons) return false;
    const v = r.veh;
    const cone = (w.kind === 'flame' ? w.spread : w.aimAssist) + 0.05;
    const range = Math.min(maxRange, w.kind === 'flame' ? w.range : w.kind === 'projectile' ? w.range * 0.7 : w.range * 0.9);
    let seen = false;
    for (const o of this.racers.values()) {
      if (o === r || o.p.status !== RacerStatus.RACING || o.p.protectT > 0) continue;
      const dx = o.veh.x - v.x, dz = o.veh.z - v.z;
      const d = Math.hypot(dx, dz);
      if (d > range || d < 3) continue;
      if (Math.abs(wrap(Math.atan2(dx, dz) - v.yaw)) > cone) continue;
      if (!this.canSee(r, o)) continue;
      seen = true;
      break;
    }
    if (seen) b.aimT += dt;
    else b.aimT = Math.max(0, b.aimT - dt * 2);
    return seen && b.aimT > b.reaction;
  }

  /** Bots pick a gun that suits the range: close, medium or long. */
  private botGun(r: SimRacer, dt: number, dist: number) {
    const b = r.bot!;
    b.gunT -= dt;
    if (b.gunT > 0 && b.gun >= 0) return b.gun;
    b.gunT = 3 + this.rand() * 3;
    const style = r.p.joinOrder % 3;
    const close = [['shotgun', 'flamer', 'smg'], ['flamer', 'smg', 'shotgun'], ['smg', 'shotgun', 'flamer']][style];
    const mid = [['m4', 'minigun', 'grenade'], ['minigun', 'm4', 'pistol'], ['grenade', 'm4', 'minigun']][style];
    const far = [['rocket', 'sniper', 'homing'], ['sniper', 'homing', 'rocket'], ['homing', 'rocket', 'sniper']][style];
    const set = dist < 22 ? close : dist < 90 ? mid : far;
    b.gun = getWeapon(set[Math.floor(this.rand() * set.length) % set.length]).index;
    return b.gun;
  }

  private raceBot(r: SimRacer, dt: number): InputState {
    const b = r.bot!;
    const t = this.track!;
    const v = r.veh;
    const inp = autopilot(v, t, 9, b.lane);
    const speed = Math.hypot(v.vx, v.vz);
    if (speed > getVehicle(r.p.carClass).maxSpeed * b.skill) inp.throttle = 0;
    inp.nitro = this.settings.nitro && v.nitro > 60 && Math.abs(inp.steer) < 0.15;
    inp.recover = speed < 1;
    // Racing bots are pickier: medium range only, and they mostly keep their eyes on the road.
    inp.fire = this.botTrigger(r, dt, 90) && Math.sin(this.time * 0.9 + b.lane) > -0.2;
    inp.weapon = this.botGun(r, dt, 50);
    const w = getWeapon(r.p.curWeapon);
    inp.reload = !inp.fire && r.p.ammo < w.magazine * 0.25 && b.aimT === 0;
    return inp;
  }

  private battleBot(r: SimRacer, dt: number): InputState {
    const b = r.bot!;
    const a = this.arena!;
    const v = r.veh;
    const p = r.p;
    const speed = Math.hypot(v.vx, v.vz);
    const w = getWeapon(p.curWeapon);

    // Pick a target now and then.
    b.retargetT -= dt;
    let target = this.racers.get(b.targetId);
    if (!target || target.p.status !== RacerStatus.RACING || b.retargetT <= 0) {
      let best = Infinity;
      target = undefined;
      for (const o of this.racers.values()) {
        if (o === r || o.p.status !== RacerStatus.RACING) continue;
        const d = Math.hypot(o.veh.x - v.x, o.veh.z - v.z) * (o.p.protectT > 0 ? 3 : 1) * (o.bot ? 1.15 : 1);
        if (d < best) { best = d; target = o; }
      }
      b.targetId = target?.id ?? '';
      b.retargetT = 2 + this.rand();
    }

    // Goal: repair when hurt, otherwise hunt (or wander).
    let gx: number, gz: number;
    let goal: 'repair' | 'crate' | 'hunt' | 'wander' = 'wander';
    let tdist = Infinity;
    if (target) tdist = Math.hypot(target.veh.x - v.x, target.veh.z - v.z);
    const nearest = (kind: 'repair' | 'crate', max: number) => {
      let best: SimPickup | null = null, bd = max;
      for (const pk of this.pickups) {
        if (!pk.active || pk.kind !== kind) continue;
        const d = Math.hypot(pk.x - v.x, pk.z - v.z);
        if (d < bd) { bd = d; best = pk; }
      }
      return best;
    };
    const repair = p.health < p.maxHealth * 0.4 ? nearest('repair', 260) : null;
    const crate = p.curWeapon === p.weapon && tdist > 90 ? nearest('crate', 70) : null;
    if (repair) { goal = 'repair'; gx = repair.x; gz = repair.z; }
    else if (crate) { goal = 'crate'; gx = crate.x; gz = crate.z; }
    else if (target) {
      goal = 'hunt';
      gx = target.veh.x + target.veh.vx * 0.4;
      gz = target.veh.z + target.veh.vz * 0.4;
    } else {
      if (Math.hypot(b.wanderX - v.x, b.wanderZ - v.z) < 15 || (b.wanderX === 0 && b.wanderZ === 0)) {
        const sp = a.spawns[Math.floor(this.rand() * a.spawns.length)];
        b.wanderX = sp.x; b.wanderZ = sp.z;
      }
      gx = b.wanderX; gz = b.wanderZ;
    }
    const desired = Math.atan2(gx - v.x, gz - v.z);

    // Steer around houses / trees / rocks: score a fan of headings by clearance.
    b.thinkT -= 1;
    if (b.thinkT <= 0) {
      b.thinkT = 3;
      const probe = 10 + speed * 0.9;
      const goalDist = Math.hypot(gx - v.x, gz - v.z);
      let bestH = desired, bestS = -Infinity;
      for (const off of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.5, -1.5, 2.1, -2.1]) {
        const h = desired + off;
        const len = Math.min(probe, goalDist + 2);
        const c = worldRay(a, v.x, v.z, v.x + Math.sin(h) * len, v.z + Math.cos(h) * len, 0.8);
        const turn = Math.abs(wrap(h - v.yaw));
        const s = c * 3 - Math.abs(off) * 0.9 - turn * 0.15 + (c >= 1 ? 1 : 0);
        if (s > bestS) { bestS = s; bestH = h; }
      }
      b.heading = bestH;
    }
    const diff = wrap(b.heading - v.yaw);
    const inp: InputState = { ...NEUTRAL_INPUT };
    inp.steer = clamp(-diff * 2.4, -1, 1);
    inp.throttle = Math.abs(diff) > 1.3 ? 0.7 : 1;
    if (goal === 'hunt' && tdist < 16 && Math.abs(diff) < 0.4) inp.throttle = 0.65;
    inp.handbrake = this.settings.drift && Math.abs(diff) > 1.0 && speed > 18;
    if (speed > getVehicle(p.carClass).maxSpeed * b.skill) inp.throttle = 0;

    // Unstick: back up with opposite lock.
    if (b.reverseT > 0) {
      b.reverseT -= dt;
      inp.throttle = 0;
      inp.brake = 1;
      inp.steer = b.revSteer;
      inp.handbrake = false;
    } else if (speed < 2.5) {
      b.stuckT += dt;
      if (b.stuckT > 1.1) {
        b.stuckT = 0;
        b.reverseT = 1.1;
        b.revSteer = diff > 0 ? 1 : -1;
      }
    } else b.stuckT = 0;
    inp.recover = v.overturnT > 0 || (speed < 1 && b.stuckT > 0.9);

    inp.weapon = this.botGun(r, dt, tdist);
    inp.fire = this.botTrigger(r, dt, 250);
    inp.nitro = this.settings.nitro && v.nitro > 30 && Math.abs(diff) < 0.15 && (goal !== 'hunt' || tdist > 60);
    inp.reload = !inp.fire && p.ammo < w.magazine * 0.35 && (goal !== 'hunt' || tdist > w.range);
    return inp;
  }
}
