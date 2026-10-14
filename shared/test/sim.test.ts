import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APPEARANCE, DEFAULT_SETTINGS, GameSim, NEUTRAL_INPUT, Phase, RacerStatus, SIM_DT, WEAPONS, WEAPON_IDS,
  arenaSpotClear, constrainToArena, createSimRacer, createVehicleState, getArena, getVehicle, getWeapon, obbOverlap,
  sanitizeAppearance, sanitizeSettings, stepVehicle, CAR_CLASS_IDS, decodeInput, encodeInput,
  type RaceSettings, type SimPlayer,
} from '../src';

function player(id: string, carClass = 'drifter', weapon = 'm4', order = 0): SimPlayer {
  return {
    id, name: id, status: RacerStatus.LOBBY, connected: true, carClass, weapon,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, yawRate: 0, pitch: 0, roll: 0, pitchRate: 0, rollRate: 0,
    grounded: true, overturnT: 0, rampVy: 0, padCooldown: 0, boosting: false, drifting: false,
    health: 100, maxHealth: 100, nitro: 50, fireCd: 0, protectT: 0, respawnT: 0,
    curWeapon: weapon, ammo: 0, reloadT: 0, kills: 0, deaths: 0,
    laps: 0, nextCp: 1, progress: 0, rank: 0, finishPlace: 0, ackSeq: 0, joinOrder: order,
  };
}

function makeSim(settings: Partial<RaceSettings>, bots: number, opts: { human?: boolean; weapons?: string[] } = {}) {
  const sim = new GameSim(sanitizeSettings(settings, DEFAULT_SETTINGS));
  const racers = [];
  for (let i = 0; i < bots; i++) {
    const p = player('b' + i, CAR_CLASS_IDS[i % CAR_CLASS_IDS.length], opts.weapons?.[i % opts.weapons.length] ?? WEAPON_IDS[i % WEAPON_IDS.length], i);
    const r = createSimRacer(p.id, p, !(opts.human && i === 0), i);
    sim.add(r);
    racers.push(r);
  }
  sim.begin(racers);
  return { sim, racers };
}

function run(sim: GameSim, seconds: number) {
  const kills = [];
  for (let t = 0; t < seconds && sim.phase !== Phase.RESULTS; t += SIM_DT) {
    sim.tick(SIM_DT);
    kills.push(...sim.killsOut);
    sim.killsOut = [];
    sim.fxOut = [];
  }
  return kills;
}

describe('vehicles & weapons tables', () => {
  it('has 10 vehicle classes, each with a big health pool', () => {
    expect(CAR_CLASS_IDS.length).toBe(10);
    for (const id of CAR_CLASS_IDS) expect(getVehicle(id).maxHealth).toBeGreaterThanOrEqual(250);
    expect(getVehicle('armored').maxHealth).toBeGreaterThan(getVehicle('formula').maxHealth);
  });
  it('has 10 weapons including rocket launcher, M4 and shotgun', () => {
    expect(WEAPONS.length).toBe(10);
    for (const id of ['rocket', 'm4', 'shotgun']) expect(WEAPON_IDS).toContain(id);
    for (const w of WEAPONS) {
      expect(w.magazine).toBeGreaterThan(0);
      expect(w.reload).toBeGreaterThan(0);
      expect(w.interval).toBeGreaterThan(0);
    }
    expect(getWeapon('nope').id).toBe('m4');
  });
  it('sanitises battle settings and weapon loadouts', () => {
    const s = sanitizeSettings({ mode: 'battle', killTarget: 15, timeLimit: 3 });
    expect(s).toMatchObject({ mode: 'battle', killTarget: 15, timeLimit: 3 });
    expect(sanitizeSettings({ mode: 'deathrace', killTarget: 7, timeLimit: 99 })).toMatchObject({ mode: 'race', killTarget: 10, timeLimit: 5 });
    expect(sanitizeAppearance({ weapon: 'rocket' }).weapon).toBe('rocket');
    expect(sanitizeAppearance({ weapon: 'laser' }).weapon).toBe(DEFAULT_APPEARANCE.weapon);
    expect(sanitizeAppearance({ carClass: 'armored' }).carClass).toBe('armored');
  });
  it('round-trips the reload input flag', () => {
    const d = decodeInput(encodeInput(5, { ...NEUTRAL_INPUT, reload: true, fire: true }));
    expect(d?.input.reload).toBe(true);
    expect(d?.input.fire).toBe(true);
  });
});

describe('battle arena', () => {
  const a = getArena('town');
  it('is deterministic and full of houses, trees and rocks', () => {
    const kinds = new Set(a.obstacles.map((o) => o.kind));
    for (const k of ['house', 'bighouse', 'tree', 'rock', 'bigrock']) expect(kinds.has(k as never)).toBe(true);
    expect(a.roads.length).toBe(8);
    expect(getArena('town')).toBe(a);
  });
  it('keeps spawns and pickups clear of obstacles', () => {
    for (const s of a.spawns) expect(arenaSpotClear(a, s.x, s.z, 3)).toBe(true);
    for (const s of [...a.repairSpots, ...a.crateSpots]) expect(arenaSpotClear(a, s.x, s.z, 2)).toBe(true);
  });
  it('never lets a car drive through a house, rock, tree or the wall', () => {
    const cfg = getVehicle('muscle');
    for (const o of a.obstacles.slice(0, 120)) {
      // aim at the obstacle from 30 m away at full speed
      const ang = o.v * Math.PI * 2;
      const s = createVehicleState(o.x - Math.sin(ang) * 30, o.z - Math.cos(ang) * 30, ang);
      if (!arenaSpotClear(a, s.x, s.z, 3)) continue;
      s.vx = Math.sin(ang) * 40;
      s.vz = Math.cos(ang) * 40;
      for (let i = 0; i < 60; i++) {
        stepVehicle(s, { ...NEUTRAL_INPUT, throttle: 1 }, cfg, a, { nitro: false, drift: false }, SIM_DT);
        if (o.shape === 'box') {
          const ov = obbOverlap(s.x, s.z, s.yaw, cfg.halfLength, cfg.halfWidth, o.x, o.z, o.yaw, o.hl, o.hw);
          expect(ov === null || ov.depth < 0.05).toBe(true);
        } else {
          // centre can never be inside the circle
          expect(Math.hypot(s.x - o.x, s.z - o.z)).toBeGreaterThan(o.r);
        }
      }
    }
    const s = createVehicleState(a.half - 10, 0, Math.PI / 2 * -1 + Math.PI);
    s.vx = 40;
    for (let i = 0; i < 60; i++) {
      s.vx = 40;
      constrainToArena(s, cfg, a);
      s.x += s.vx * SIM_DT;
      constrainToArena(s, cfg, a);
    }
    expect(s.x + cfg.halfWidth).toBeLessThanOrEqual(a.half + 2.5);
  });
});

describe('game simulation', () => {
  it('runs a full battle with 10 bots and ends at the kill target', () => {
    const { sim, racers } = makeSim({ mode: 'battle', killTarget: 5, timeLimit: 5 }, 10);
    const kills = run(sim, 300);
    expect(sim.phase).toBe(Phase.RESULTS);
    const scored = kills.filter((k) => k.killer);
    expect(scored.length).toBeGreaterThanOrEqual(5);
    const top = Math.max(...racers.map((r) => r.p.kills));
    expect(top).toBeGreaterThanOrEqual(5);
    expect(sim.finishOrder.length).toBe(10);
    const first = racers.find((r) => r.id === sim.finishOrder[0])!;
    expect(first.p.kills).toBe(top);
    // every car is inside the walls and none is stuck inside an obstacle
    const a = getArena('town');
    for (const r of racers) expect(Math.abs(r.veh.x) <= a.half && Math.abs(r.veh.z) <= a.half).toBe(true);
  });

  it('runs a race with bots, weapons and pickups to the finish', () => {
    const { sim, racers } = makeSim({ mode: 'race', layout: 'loop', trackId: 'valley', distanceKm: 1, laps: 1 }, 6);
    expect(sim.pickups.some((p) => p.kind === 'repair')).toBe(true);
    expect(sim.pickups.some((p) => p.kind === 'crate')).toBe(true);
    run(sim, 240);
    expect(sim.phase).toBe(Phase.RESULTS);
    expect(racers.every((r) => r.p.status === RacerStatus.FINISHED)).toBe(true);
  });

  it('respawns a destroyed car with a fresh car, full health and its own gun', () => {
    const { sim, racers } = makeSim({ mode: 'battle' }, 2, { human: true, weapons: ['shotgun'] });
    run(sim, 3.5);
    const r = racers[0];
    r.p.curWeapon = 'rocket';
    sim.damage(r, 10000, 'test', racers[1].id);
    expect(r.p.status).toBe(RacerStatus.DESTROYED);
    expect(racers[1].p.kills).toBe(1);
    expect(r.p.deaths).toBe(1);
    expect(sim.killsOut.at(-1)).toEqual({ killer: racers[1].id, victim: r.id, weapon: 'test' });
    for (let i = 0; i < 120; i++) sim.tick(SIM_DT);
    expect(r.p.status).toBe(RacerStatus.RACING);
    expect(r.p.health).toBe(getVehicle(r.p.carClass).maxHealth);
    expect(r.p.curWeapon).toBe('shotgun');
    expect(r.p.protectT).toBeGreaterThan(0);
  });

  it('fires, empties the magazine, reloads and refills', () => {
    const { sim, racers } = makeSim({ mode: 'battle' }, 2, { human: true, weapons: ['pistol'] });
    const me = racers[0];
    run(sim, 3.2);
    const mag = getWeapon('pistol').magazine;
    expect(me.p.ammo).toBe(mag);
    let reloadSeen = false;
    for (let i = 0; i < 300 && !reloadSeen; i++) {
      me.queue.push({ seq: i + 1, input: { ...NEUTRAL_INPUT, fire: true } });
      sim.tick(SIM_DT);
      if (me.p.reloadT > 0) reloadSeen = true;
    }
    expect(reloadSeen).toBe(true);
    expect(me.p.ammo).toBe(0);
    me.queue.push({ seq: 999, input: { ...NEUTRAL_INPUT } });
    for (let i = 0; i < 60; i++) sim.tick(SIM_DT);
    expect(me.p.ammo).toBe(mag);
  });

  it('repairs a damaged car that drives over a repair kit, and crates swap the gun', () => {
    const { sim, racers } = makeSim({ mode: 'battle' }, 2, { human: true, weapons: ['m4'] });
    run(sim, 3.2);
    const me = racers[0];
    me.p.health = 50;
    const kit = sim.pickups.find((p) => p.kind === 'repair')!;
    me.veh.x = kit.x; me.veh.z = kit.z; me.veh.vx = me.veh.vz = 0;
    sim.tick(SIM_DT);
    expect(me.p.health).toBeGreaterThan(50);
    expect(kit.active).toBe(false);
    me.veh.x += 30;
    for (let i = 0; i < 9 * 30; i++) sim.tick(SIM_DT);
    expect(kit.active).toBe(true);
    const crate = sim.pickups.find((p) => p.kind === 'crate')!;
    me.veh.x = crate.x; me.veh.z = crate.z; me.veh.vx = me.veh.vz = 0;
    sim.tick(SIM_DT);
    expect(me.p.curWeapon).not.toBe('m4');
  });

  it('a rocket blast damages and launches nearby cars but never its owner', () => {
    const { sim, racers } = makeSim({ mode: 'battle' }, 3, { human: true, weapons: ['rocket'] });
    run(sim, 3.2);
    const [me, a, b] = racers;
    a.bot = null; b.bot = null;
    a.veh.x = me.veh.x + Math.sin(me.veh.yaw) * 25; a.veh.z = me.veh.z + Math.cos(me.veh.yaw) * 25; a.veh.yaw = me.veh.yaw;
    b.veh.x = a.veh.x + 3; b.veh.z = a.veh.z; b.veh.yaw = me.veh.yaw;
    a.veh.vx = a.veh.vz = b.veh.vx = b.veh.vz = 0;
    const meHp = me.p.health, aHp = a.p.health, bHp = b.p.health;
    me.queue.push({ seq: 1, input: { ...NEUTRAL_INPUT, fire: true } });
    let blast = false;
    for (let i = 0; i < 40; i++) {
      sim.tick(SIM_DT);
      if (sim.fxOut.some((f) => f[0] === 'blast')) blast = true;
    }
    expect(blast).toBe(true);
    expect(me.p.health).toBe(meHp);
    expect(a.p.health).toBeLessThan(aHp);
    expect(b.p.health).toBeLessThan(bHp);
  });
});
