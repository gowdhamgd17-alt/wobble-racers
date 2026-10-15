// Offline "vs bots" mode. Runs the exact same shared game simulation as the
// server (GameSim: physics, collisions, 10 weapons, pickups, damage, kills,
// respawn, race checkpoints, battle scoring and bot drivers) inside the
// browser, behind a Room-like interface, so the normal game client plays
// against it unchanged.

import {
  CAR_CLASS_IDS, CHARACTER_IDS, COLOR_IDS, GameSim, MAX_HEALTH, MSG, NITRO, Phase, RacerStatus, SIM_DT, WEAPON_IDS,
  createSimRacer, decodeInput, getWeapon,
  type Appearance, type RaceSettings, type SimPlayer, type SimRacer,
} from '@wobble/shared';

const BOT_NAMES = ['Turbo Tina', 'Captain Crash', 'Wheely Willy', 'Drift Queen', 'Bumper Bob', 'Nitro Nell', 'Skiddy', 'Zoom Zoe', 'Rusty', 'Max Mayhem', 'Spinout Sam', 'Lady Lugnut', 'Honky', 'Gravel Gus'];

type P = SimPlayer & {
  tag: string; character: string; colorMain: string; colorSecondary: string; colorWheel: string; wheelStyle: string;
  ready: boolean; isHost: boolean;
};
type Pickup = { kind: string; x: number; y: number; z: number; active: boolean };
type Proj = { owner: string; kind: string; x: number; y: number; z: number; vx: number; vy: number; vz: number };

export class LocalRoom {
  readonly sessionId = 'you';
  readonly roomId = 'SOLO';
  readonly reconnectionToken = '';
  state: {
    phase: string; roomName: string; code: string; isPrivate: boolean; maxPlayers: number; hostId: string;
    countdown: number; raceId: number; timeLeft: number; settings: RaceSettings; players: Map<string, P>;
    projectiles: Map<string, Proj>; pickups: Map<string, Pickup>; finishOrder: string[];
  };
  private sim: GameSim<SimRacer>;
  private timer: number;
  private stateCbs: (() => void)[] = [];
  private msgCbs = new Map<string, ((m: unknown) => void)[]>();
  private leaveCbs: ((code: number) => void)[] = [];

  constructor(name: string, app: Appearance, settings: RaceSettings, bots: number) {
    this.state = {
      phase: Phase.LOBBY, roomName: settings.mode === 'battle' ? 'Battleground vs bots' : 'Practice vs bots', code: 'SOLO',
      isPrivate: true, maxPlayers: bots + 1, hostId: this.sessionId, countdown: 0, raceId: 0, timeLeft: 0,
      settings: { ...settings }, players: new Map(), projectiles: new Map(), pickups: new Map(), finishOrder: [],
    };
    this.sim = new GameSim(this.state.settings);
    this.sim.lagCompensation = 0.06; // offline view delay (45 ms interpolation + one tick)
    this.add(this.sessionId, name, '#YOU', app, false, 0);
    for (let i = 0; i < bots; i++) {
      this.add(`bot${i}`, BOT_NAMES[i % BOT_NAMES.length], '#BOT', {
        carClass: CAR_CLASS_IDS[(i + 1) % CAR_CLASS_IDS.length], character: CHARACTER_IDS[(i + 1) % CHARACTER_IDS.length],
        colorMain: COLOR_IDS[(i * 5 + 3) % COLOR_IDS.length], colorSecondary: COLOR_IDS[(i * 3 + 9) % COLOR_IDS.length],
        colorWheel: 'black', wheelStyle: ['classic', 'chunky', 'spoke'][i % 3], weapon: WEAPON_IDS[(i * 3 + 2) % WEAPON_IDS.length],
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
      health: MAX_HEALTH, maxHealth: MAX_HEALTH, nitro: NITRO.start, fireCd: 0, protectT: 0, respawnT: 0,
      curWeapon: getWeapon(a.weapon).id, ammo: 0, reloadT: 0, kills: 0, deaths: 0, powerT: 0,
      laps: 0, nextCp: 1, progress: 0, rank: order + 1, finishPlace: 0, ackSeq: 0, joinOrder: order,
    };
    this.state.players.set(id, p);
    this.sim.add(createSimRacer(id, p, bot, order));
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
      const me = this.sim.racers.get(this.sessionId)!;
      if (d) { me.queue.push(d); if (me.queue.length > 8) me.queue.splice(0, me.queue.length - 2); }
    } else if (type === MSG.REMATCH || type === MSG.TO_LOBBY || type === MSG.START) {
      if (this.state.phase === Phase.RESULTS || this.state.phase === Phase.LOBBY) this.start();
    } else if (type === MSG.EMOTE) {
      const r = this.sim.racers.get(this.sessionId)!;
      this.sim.fx('wave', r.id, r.veh.x, r.veh.y, r.veh.z, 0);
    }
  }
  private emit(type: string, m: unknown) { this.msgCbs.get(type)?.forEach((c) => c(m)); }

  // ------------------------------------------------ game
  private start() {
    this.state.raceId++;
    this.state.finishOrder = [];
    this.state.projectiles.clear();
    // You start mid-grid (race) so there is action around you.
    const order = [...this.sim.racers.values()].sort((a, b) => a.p.joinOrder - b.p.joinOrder);
    const mid = Math.min(order.length - 1, Math.floor(order.length / 2));
    if (this.state.settings.mode !== 'battle') [order[0], order[mid]] = [order[mid], order[0]];
    this.sim.setSettings(this.state.settings);
    this.sim.begin(order);
    this.state.pickups = new Map(this.sim.pickups.map((k) => [k.id, { kind: k.kind, x: k.x, y: k.y, z: k.z, active: k.active }]));
    this.copy();
    this.publish();
  }

  private tick() {
    if (this.sim.phase === Phase.COUNTDOWN || this.sim.phase === Phase.RACING) {
      this.sim.tick(SIM_DT);
      this.copy();
    }
    if (this.sim.fxOut.length) { this.emit(MSG.FX, this.sim.fxOut); this.sim.fxOut = []; }
    if (this.sim.killsOut.length) { this.emit(MSG.KILL, this.sim.killsOut); this.sim.killsOut = []; }
    this.publish();
  }

  private copy() {
    const s = this.state, sim = this.sim;
    s.phase = sim.phase;
    s.countdown = sim.countdown;
    s.timeLeft = sim.timeLeft;
    s.finishOrder = [...sim.finishOrder];
    s.projectiles = new Map(sim.projectiles.map((p) => [p.id, { owner: p.owner, kind: p.kind, x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz }]));
    for (const k of sim.pickups) {
      const v = s.pickups.get(k.id);
      if (v) v.active = k.active;
    }
  }

  private publish() { this.stateCbs.forEach((c) => c()); }
}
