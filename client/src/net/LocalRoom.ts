// Offline "Practice vs bots" mode. Runs the same shared race rules as the
// server (physics, collisions, blasters, damage, respawn, checkpoints) inside
// the browser and exposes a Room-like interface, so the normal game client
// plays against it unchanged. Used when no multiplayer server is reachable.

import {
  CHARACTER_IDS, COLOR_IDS, COUNTDOWN_SECONDS, MAX_HEALTH, MSG, NEUTRAL_INPUT, NITRO, PHYS, Phase, RESPAWN, RacerStatus,
  SIM_DT, WEAPON, autopilot, constrainToTrack, createVehicleState, decodeInput, findSafeSpot, getTrack, getVehicle, initialProgress,
  segmentHitsCar, totalLapsFor,
  placeOnTrack, progressScore, queryTrack, resolveCarCollision, stepVehicle, updateProgress,
  type Appearance, type FxMessage, type FxType, type InputState, type ProgressState, type RaceSettings, type Track, type VehicleState,
} from '@wobble/shared';

const BOT_NAMES = ['Turbo Tina', 'Captain Crash', 'Wheely Willy', 'Drift Queen', 'Bumper Bob', 'Nitro Nell', 'Skiddy', 'Zoom Zoe', 'Rusty', 'Max Mayhem', 'Spinout Sam', 'Lady Lugnut', 'Honky', 'Gravel Gus'];

interface P {
  id: string; name: string; tag: string;
  carClass: string; character: string; colorMain: string; colorSecondary: string; colorWheel: string; wheelStyle: string;
  ready: boolean; isHost: boolean; connected: boolean; status: string;
  x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number; yawRate: number;
  pitch: number; roll: number; pitchRate: number; rollRate: number; grounded: boolean; overturnT: number;
  rampVy: number; padCooldown: number; boosting: boolean; drifting: boolean;
  health: number; nitro: number; fireCd: number; protectT: number; respawnT: number;
  laps: number; nextCp: number; progress: number; rank: number; finishPlace: number; ackSeq: number; joinOrder: number;
}

interface Racer {
  p: P; veh: VehicleState; prog: ProgressState; input: InputState; queue: { seq: number; input: InputState }[];
  bot: boolean; lane: number; skill: number; destroyedT: number; deathF: number; deathLat: number; deathYaw: number;
  lastRank: number; overtakeCd: number; botFireCd: number;
}
interface Proj { id: string; owner: string; x: number; y: number; z: number; vx: number; vz: number; life: number; idx: number }

export class LocalRoom {
  readonly sessionId = 'you';
  readonly roomId = 'SOLO';
  readonly reconnectionToken = '';
  state: {
    phase: string; roomName: string; code: string; isPrivate: boolean; maxPlayers: number; hostId: string;
    countdown: number; raceId: number; settings: RaceSettings; players: Map<string, P>;
    projectiles: Map<string, { x: number; y: number; z: number; vx: number; vz: number; owner: string }>; finishOrder: string[];
  };
  private racers = new Map<string, Racer>();
  private projs: Proj[] = [];
  private track: Track;
  private timer: number;
  private stateCbs: (() => void)[] = [];
  private msgCbs = new Map<string, ((m: unknown) => void)[]>();
  private leaveCbs: ((code: number) => void)[] = [];
  private fxQueue: FxMessage[] = [];
  private pairCd = new Map<string, number>();
  private projN = 0;

  constructor(name: string, app: Appearance, settings: RaceSettings, private bots: number) {
    this.track = getTrack(settings);
    this.state = {
      phase: Phase.LOBBY, roomName: 'Practice vs bots', code: 'SOLO', isPrivate: true, maxPlayers: bots + 1,
      hostId: this.sessionId, countdown: 0, raceId: 0, settings: { ...settings }, players: new Map(), projectiles: new Map(), finishOrder: [],
    };
    this.add(this.sessionId, name, '#YOU', app, false, 0);
    const classes = ['speedster', 'bruiser', 'drifter', 'muscle', 'buggy', 'formula', 'monster'];
    for (let i = 0; i < bots; i++) {
      this.add(`bot${i}`, BOT_NAMES[i % BOT_NAMES.length], '#BOT', {
        carClass: classes[(i + 1) % classes.length], character: CHARACTER_IDS[(i + 1) % CHARACTER_IDS.length],
        colorMain: COLOR_IDS[(i * 5 + 3) % COLOR_IDS.length], colorSecondary: COLOR_IDS[(i * 3 + 9) % COLOR_IDS.length],
        colorWheel: 'black', wheelStyle: ['classic', 'chunky', 'spoke'][i % 3],
      }, true, i + 1);
    }
    this.timer = window.setInterval(() => this.tick(), 1000 / 30);
    setTimeout(() => this.start(), 50);
  }

  private add(id: string, name: string, tag: string, a: Appearance, bot: boolean, order: number) {
    const p: P = {
      id, name, tag, ...a, ready: true, isHost: id === this.sessionId, connected: true, status: RacerStatus.LOBBY,
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, yawRate: 0, pitch: 0, roll: 0, pitchRate: 0, rollRate: 0,
      grounded: true, overturnT: 0, rampVy: 0, padCooldown: 0, boosting: false, drifting: false,
      health: MAX_HEALTH, nitro: NITRO.start, fireCd: 0, protectT: 0, respawnT: 0,
      laps: 0, nextCp: 1, progress: 0, rank: order + 1, finishPlace: 0, ackSeq: 0, joinOrder: order,
    };
    this.state.players.set(id, p);
    this.racers.set(id, {
      p, veh: createVehicleState(0, 0, 0), prog: initialProgress(this.track), input: { ...NEUTRAL_INPUT }, queue: [], bot,
      lane: ((order % 5) - 2) * 2.6, skill: 0.82 + ((order * 37) % 17) / 100, destroyedT: 0, deathF: 0, deathLat: 0, deathYaw: 0,
      lastRank: order + 1, overtakeCd: 0, botFireCd: 1 + order * 0.3,
    });
  }

  // ------------------------------------------------ Room-like API
  onStateChange(cb: () => void) { this.stateCbs.push(cb); }
  onMessage(type: string, cb: (m: never) => void) {
    const l = this.msgCbs.get(type) ?? [];
    l.push(cb as (m: unknown) => void);
    this.msgCbs.set(type, l);
  }
  onLeave(cb: (code: number) => void) { this.leaveCbs.push(cb); }
  onError() { /* never errors */ }
  async leave() {
    clearInterval(this.timer);
    this.leaveCbs.forEach((c) => c(4000));
  }
  send(type: string, payload?: unknown) {
    if (type === MSG.INPUT) {
      const d = decodeInput(payload);
      const me = this.racers.get(this.sessionId)!;
      if (d) { me.queue.push(d); if (me.queue.length > 8) me.queue.splice(0, me.queue.length - 2); }
    } else if (type === MSG.REMATCH || type === MSG.TO_LOBBY || type === MSG.START) {
      if (this.state.phase === Phase.RESULTS || this.state.phase === Phase.LOBBY) this.start();
    } else if (type === MSG.EMOTE) {
      const r = this.racers.get(this.sessionId)!;
      this.fx('wave', r.p.id, r.veh.x, r.veh.y, r.veh.z, 0);
    }
  }
  private emit(type: string, m: unknown) { this.msgCbs.get(type)?.forEach((c) => c(m)); }

  // ------------------------------------------------ race
  private start() {
    this.track = getTrack(this.state.settings);
    this.state.raceId++;
    this.state.finishOrder = [];
    this.projs = [];
    this.state.projectiles.clear();
    // Player starts mid-grid so there is action around them.
    const order = [...this.racers.values()].sort((a, b) => a.p.joinOrder - b.p.joinOrder);
    const slots = order.map((_, i) => i);
    const mid = Math.min(order.length - 1, Math.floor(order.length / 2));
    [slots[0], slots[mid]] = [slots[mid], slots[0]];
    order.forEach((r, i) => {
      const g = this.track.grid[slots[i] % this.track.grid.length];
      r.veh = createVehicleState(g.x, g.z, g.yaw);
      r.veh.nitro = this.state.settings.nitro ? NITRO.start : 0;
      r.prog = initialProgress(this.track);
      r.queue.length = 0;
      r.input = { ...NEUTRAL_INPUT };
      Object.assign(r.p, { status: RacerStatus.RACING, health: MAX_HEALTH, fireCd: 0, protectT: 0, respawnT: 0, laps: 0, nextCp: 1, finishPlace: 0, rank: slots[i] + 1 });
      this.sync(r);
    });
    this.state.countdown = COUNTDOWN_SECONDS;
    this.state.phase = Phase.COUNTDOWN;
    this.publish();
  }

  private tick() {
    const dt = SIM_DT;
    if (this.state.phase === Phase.COUNTDOWN) {
      this.state.countdown = Math.max(0, this.state.countdown - dt);
      const me = this.racers.get(this.sessionId)!;
      const n = me.queue.pop();
      if (n) me.p.ackSeq = n.seq;
      me.queue.length = 0;
      if (this.state.countdown <= 0) this.state.phase = Phase.RACING;
    } else if (this.state.phase === Phase.RACING) {
      this.simulate(dt);
    }
    if (this.fxQueue.length) { this.emit(MSG.FX, this.fxQueue); this.fxQueue = []; }
    this.publish();
  }

  private publish() { this.stateCbs.forEach((c) => c()); }

  private fx(t: FxType, id: string, x: number, y: number, z: number, a: number) { this.fxQueue.push([t, id, x, y, z, a]); }

  private botInput(r: Racer): InputState {
    const inp = autopilot(r.veh, this.track, 9, r.lane);
    const speed = Math.hypot(r.veh.vx, r.veh.vz);
    // Slightly slower than perfect so a good human can win
    if (speed > getVehicle(r.p.carClass).maxSpeed * r.skill) inp.throttle = 0;
    const s = this.state.settings;
    inp.nitro = s.nitro && r.veh.nitro > 60 && Math.abs(inp.steer) < 0.15;
    inp.recover = speed < 1 && r.p.status === RacerStatus.RACING;
    // Shoot at someone roughly ahead
    r.botFireCd -= SIM_DT;
    if (s.weapons && r.botFireCd <= 0) {
      const fx = Math.sin(r.veh.yaw), fz = Math.cos(r.veh.yaw);
      for (const o of this.racers.values()) {
        if (o === r || o.p.status !== RacerStatus.RACING) continue;
        const dx = o.veh.x - r.veh.x, dz = o.veh.z - r.veh.z;
        const d = Math.hypot(dx, dz);
        if (d < 45 && d > 4 && (dx * fx + dz * fz) / d > 0.97) { inp.fire = true; r.botFireCd = 1.2 + Math.random() * 1.5; break; }
      }
    }
    return inp;
  }

  private simulate(dt: number) {
    const st = this.state.settings;
    const rules = { nitro: st.nitro, drift: st.drift };
    for (const [k, v] of this.pairCd) { if (v - dt <= 0) this.pairCd.delete(k); else this.pairCd.set(k, v - dt); }
    for (const r of this.racers.values()) {
      const p = r.p;
      if (r.bot) r.input = p.status === RacerStatus.FINISHED ? autopilot(r.veh, this.track, 9, r.lane) : this.botInput(r);
      else {
        const n = r.queue.shift();
        if (n) { r.input = n.input; p.ackSeq = n.seq; }
      }
      p.fireCd = Math.max(0, p.fireCd - dt);
      p.protectT = Math.max(0, p.protectT - dt);
      r.overtakeCd = Math.max(0, r.overtakeCd - dt);
      if (p.status === RacerStatus.DESTROYED) {
        r.destroyedT -= dt;
        p.respawnT = Math.max(0, r.destroyedT);
        if (r.destroyedT <= 0) this.respawn(r);
        continue;
      }
      const cfg = getVehicle(p.carClass);
      const ev = stepVehicle(r.veh, r.input, cfg, this.track, rules, dt);
      const v = r.veh;
      if (ev.boostPad) this.fx('pad', p.id, v.x, v.y, v.z, 0);
      if (ev.landingSpeed > PHYS.landingDamageSpeed) this.damage(r, ((ev.landingSpeed - PHYS.landingDamageSpeed) * 2.5) / cfg.damageResistance);
      else if (ev.landingSpeed > 6) this.fx('land', p.id, v.x, v.y, v.z, ev.landingSpeed);
      if (ev.wallImpact > PHYS.wallDamageSpeed) this.damage(r, ((ev.wallImpact - PHYS.wallDamageSpeed) * 0.8) / cfg.damageResistance);
      if (ev.recover) this.recover(r);
      if (r.input.fire && st.weapons && p.status === RacerStatus.RACING && p.fireCd <= 0) this.fire(r);
      if (p.status === RacerStatus.RACING) {
        const q = queryTrack(this.track, v.x, v.z, v.trackIdx);
        const pe = updateProgress(this.track, r.prog, q.f, q.lateral, totalLapsFor(this.track, st.laps));
        if (pe === 'lap') this.fx('lap', p.id, v.x, v.y, v.z, r.prog.laps);
        if (pe === 'finish') this.finish(r);
        p.progress = progressScore(this.track, r.prog, q.f);
      }
      p.laps = r.prog.laps;
      p.nextCp = r.prog.nextCp;
    }
    if (st.collisions) {
      this.collide();
      this.collide();
      for (const r of this.racers.values()) if (r.p.status === RacerStatus.RACING) constrainToTrack(r.veh, getVehicle(r.p.carClass), this.track);
    }
    this.stepProjectiles(dt);
    this.ranks();
    for (const r of this.racers.values()) this.sync(r);
    // Race ends when you and every bot have finished.
    if ([...this.racers.values()].every((r) => r.p.status === RacerStatus.FINISHED)) {
      this.state.phase = Phase.RESULTS;
      this.state.projectiles.clear();
      this.projs = [];
    }
  }

  private collide() {
    const list = [...this.racers.values()].filter((r) => r.p.status === RacerStatus.RACING);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const res = resolveCarCollision(a.veh, b.veh, getVehicle(a.p.carClass), getVehicle(b.p.carClass));
      if (!res.hit) continue;
      const key = a.p.id + '|' + b.p.id;
      if (this.pairCd.has(key)) continue;
      this.pairCd.set(key, PHYS.collisionPairCooldown);
      if (res.closingSpeed > 4) this.fx('crash', a.p.id, (a.veh.x + b.veh.x) / 2, (a.veh.y + b.veh.y) / 2 + 0.6, (a.veh.z + b.veh.z) / 2, res.closingSpeed);
      if (res.damageA > 0) this.damage(a, res.damageA);
      if (res.damageB > 0) this.damage(b, res.damageB);
    }
  }

  private fire(r: Racer) {
    if (this.projs.filter((p) => p.owner === r.p.id).length >= WEAPON.maxProjectilesPerPlayer) return;
    r.p.fireCd = WEAPON.cooldown;
    const v = r.veh, fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
    const sp = WEAPON.projectileSpeed + Math.max(0, v.vx * fx + v.vz * fz);
    const hl = getVehicle(r.p.carClass).halfLength + 0.6;
    const pr: Proj = { id: 'p' + this.projN++, owner: r.p.id, x: v.x + fx * hl, y: v.y + 0.8, z: v.z + fz * hl, vx: fx * sp, vz: fz * sp, life: WEAPON.lifetime, idx: v.trackIdx };
    this.projs.push(pr);
    this.fx('shoot', r.p.id, pr.x, pr.y, pr.z, 0);
  }

  private stepProjectiles(dt: number) {
    const keep: Proj[] = [];
    for (const pr of this.projs) {
      const x0 = pr.x, z0 = pr.z;
      pr.x += pr.vx * dt; pr.z += pr.vz * dt; pr.life -= dt;
            let hit: Racer | null = null;
      for (const r of this.racers.values()) {
        if (r.p.id === pr.owner || r.p.status !== RacerStatus.RACING || r.p.protectT > 0) continue;
        const v = r.veh;
        if (Math.abs(v.y + 0.6 - pr.y) > 2.2) continue;
        const c = getVehicle(r.p.carClass);
        if (segmentHitsCar(x0, z0, pr.x, pr.z, PHYS.projectileRadius, v.x, v.z, v.yaw, c.halfLength, c.halfWidth) >= 0) { hit = r; break; }
      }
      const q = queryTrack(this.track, pr.x, pr.z, pr.idx);
      pr.idx = q.index;
      const wall = Math.abs(q.lateral) > this.track.halfWidth + PHYS.barrierInset && pr.y < PHYS.barrierHeight + 1.2;
      if (hit) {
        const v = hit.veh, l = Math.hypot(pr.vx, pr.vz) || 1;
        v.vx += (pr.vx / l) * WEAPON.knockback; v.vz += (pr.vz / l) * WEAPON.knockback;
        if (v.grounded && v.overturnT <= 0) { v.grounded = false; v.vy = WEAPON.knockUp; v.rollRate = 1.5; }
        this.fx('hit', hit.p.id, v.x, v.y + 0.8, v.z, WEAPON.damage);
        this.damage(hit, WEAPON.damage / getVehicle(hit.p.carClass).damageResistance);
      } else if (pr.life > 0 && !wall) keep.push(pr);
    }
    this.projs = keep;
    this.state.projectiles = new Map(keep.map((p) => [p.id, { x: p.x, y: p.y, z: p.z, vx: p.vx, vz: p.vz, owner: p.owner }]));
  }

  private damage(r: Racer, amount: number) {
    const p = r.p;
    if (!this.state.settings.damage || p.status !== RacerStatus.RACING || p.protectT > 0 || p.health <= 0 || !(amount > 0)) return;
    p.health = Math.max(0, p.health - amount);
    if (p.health > 0) return;
    const v = r.veh, q = queryTrack(this.track, v.x, v.z, v.trackIdx);
    r.deathF = q.f; r.deathLat = q.lateral; r.deathYaw = v.yaw;
    r.destroyedT = RESPAWN.destroyedSeconds;
    p.status = RacerStatus.DESTROYED;
    p.respawnT = RESPAWN.destroyedSeconds;
    this.fx('explode', p.id, v.x, v.y + 0.5, v.z, 0);
    v.vx = v.vy = v.vz = 0; v.boosting = false; v.drifting = false;
  }

  private occupied(r: Racer) {
    return [...this.racers.values()].filter((o) => o !== r && o.p.status === RacerStatus.RACING).map((o) => ({ x: o.veh.x, z: o.veh.z }));
  }

  private respawn(r: Racer) {
    const spot = findSafeSpot(this.track, r.deathF, r.deathLat, this.occupied(r), RESPAWN.safeClearance);
    const n = r.veh.nitro;
    placeOnTrack(r.veh, this.track, spot.f, spot.lateral, r.deathYaw);
    r.veh.nitro = n; r.veh.recoverCooldown = 0;
    Object.assign(r.p, { health: MAX_HEALTH, protectT: RESPAWN.protectionSeconds, respawnT: 0, status: r.prog.finished ? RacerStatus.FINISHED : RacerStatus.RACING });
    this.fx('respawn', r.p.id, r.veh.x, r.veh.y, r.veh.z, 0);
  }

  private recover(r: Racer) {
    const q = queryTrack(this.track, r.veh.x, r.veh.z);
    const spot = findSafeSpot(this.track, q.f, q.lateral, this.occupied(r), RESPAWN.safeClearance);
    const n = r.veh.nitro;
    placeOnTrack(r.veh, this.track, spot.f, spot.lateral, r.veh.yaw);
    r.veh.nitro = n;
    r.p.protectT = Math.max(r.p.protectT, 1);
    this.fx('respawn', r.p.id, r.veh.x, r.veh.y, r.veh.z, 1);
  }

  private finish(r: Racer) {
    if (this.state.finishOrder.includes(r.p.id)) return;
    this.state.finishOrder.push(r.p.id);
    r.p.finishPlace = this.state.finishOrder.length;
    r.p.status = RacerStatus.FINISHED;
    r.p.protectT = 0;
    this.fx('finish', r.p.id, r.veh.x, r.veh.y, r.veh.z, r.p.finishPlace);
  }

  private ranks() {
    const list = [...this.racers.values()].sort((a, b) => ((a.p.finishPlace || 999) - (b.p.finishPlace || 999)) || b.p.progress - a.p.progress);
    list.forEach((r, i) => {
      if (i + 1 < r.lastRank && r.p.status === RacerStatus.RACING && r.overtakeCd <= 0) { this.fx('overtake', r.p.id, r.veh.x, r.veh.y, r.veh.z, i + 1); r.overtakeCd = 3; }
      r.lastRank = r.p.rank = i + 1;
    });
  }

  private sync(r: Racer) {
    const p = r.p, v = r.veh;
    Object.assign(p, {
      x: v.x, y: v.y, z: v.z, vx: v.vx, vy: v.vy, vz: v.vz, yaw: v.yaw, yawRate: v.yawRate, pitch: v.pitch, roll: v.roll,
      pitchRate: v.pitchRate, rollRate: v.rollRate, grounded: v.grounded, overturnT: v.overturnT, rampVy: v.rampVy,
      padCooldown: v.padCooldown, boosting: v.boosting, drifting: v.drifting, nitro: v.nitro,
    });
  }
}
