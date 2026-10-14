import { describe, expect, it } from 'vitest';
import {
  validateDisplayName, sanitizeSettings, DEFAULT_SETTINGS, sanitizeAppearance, sanitizeMaxPlayers,
  getTrack, createVehicleState, stepVehicle, getVehicle, SIM_DT, autopilot, NEUTRAL_INPUT,
  initialProgress, updateProgress, queryTrack, resolveCarCollision, findSafeSpot, pointAt,
  decodeInput, encodeInput, damageState, TRACK_IDS, NUM_SAMPLES,
} from '../src';

describe('display names', () => {
  it('accepts a valid name and trims whitespace', () => {
    expect(validateDisplayName('  Turbo Tom  ')).toEqual({ ok: true, value: 'Turbo Tom' });
    expect(validateDisplayName('Zoë_99!')).toEqual({ ok: true, value: 'Zoë_99!' });
  });
  it('rejects empty / whitespace names', () => {
    expect(validateDisplayName('').ok).toBe(false);
    expect(validateDisplayName('    ').ok).toBe(false);
    expect(validateDisplayName(undefined).ok).toBe(false);
  });
  it('rejects names that are too long or have unsafe characters', () => {
    expect(validateDisplayName('x'.repeat(17)).ok).toBe(false);
    expect(validateDisplayName('<script>').ok).toBe(false);
  });
  it('strips control characters', () => {
    expect(validateDisplayName('Bo' + String.fromCharCode(0) + 'b' + String.fromCharCode(0x200b))).toEqual({ ok: true, value: 'Bob' });
  });
});

describe('settings & appearance sanitising', () => {
  it('only accepts lap counts 1..10', () => {
    expect(sanitizeSettings({ laps: 7 }).laps).toBe(7);
    expect(sanitizeSettings({ laps: 0 }).laps).toBe(DEFAULT_SETTINGS.laps);
    expect(sanitizeSettings({ laps: 11 }).laps).toBe(DEFAULT_SETTINGS.laps);
    expect(sanitizeSettings({ laps: '5' }).laps).toBe(DEFAULT_SETTINGS.laps);
  });
  it('defaults match the spec', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ laps: 3, collisions: true, damage: true, weapons: true, nitro: true, drift: true });
  });
  it('rejects unknown cosmetic ids', () => {
    const a = sanitizeAppearance({ carClass: 'tank', colorMain: 'blue', character: 'zip' });
    expect(a.carClass).toBe('drifter');
    expect(a.colorMain).toBe('blue');
    expect(a.character).toBe('zip');
  });
  it('clamps max players to 2..15', () => {
    expect(sanitizeMaxPlayers(40)).toBe(15);
    expect(sanitizeMaxPlayers(1)).toBe(2);
  });
  it('damage bands', () => {
    expect(damageState(100)).toBe('healthy');
    expect(damageState(75)).toBe('healthy');
    expect(damageState(74)).toBe('damaged');
    expect(damageState(34)).toBe('critical');
    expect(damageState(0)).toBe('destroyed');
  });
});

describe('input wire format', () => {
  it('round-trips and clamps', () => {
    const d = decodeInput(encodeInput(5, { steer: 0.5, throttle: 1, brake: 0, handbrake: true, nitro: false, fire: true, recover: false }))!;
    expect(d.seq).toBe(5);
    expect(d.input.steer).toBeCloseTo(0.5);
    expect(d.input.handbrake).toBe(true);
    expect(d.input.fire).toBe(true);
    expect(decodeInput([1, 9999, 9999, -50, 0])!.input).toMatchObject({ steer: 1, throttle: 1, brake: 0 });
  });
  it('rejects malformed input', () => {
    expect(decodeInput('hi')).toBeNull();
    expect(decodeInput([1, 2, 3])).toBeNull();
    expect(decodeInput([1, NaN, 0, 0, 0])).toBeNull();
    expect(decodeInput([1, 0, 0, 0, 99])).toBeNull();
  });
});

describe('track', () => {
  for (const id of TRACK_IDS) {
    it(`${id}: closed loop with 15 grid slots on the road and separated sections`, () => {
      const t = getTrack(id);
      expect(t.grid.length).toBeGreaterThanOrEqual(15);
      for (const g of t.grid) expect(Math.abs(queryTrack(t, g.x, g.z).lateral)).toBeLessThan(t.halfWidth - 1);
      const a = pointAt(t, 0), b = pointAt(t, NUM_SAMPLES - 1);
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(t.ds * 1.5);
      // grid slots don't overlap
      for (let i = 0; i < t.grid.length; i++)
        for (let j = i + 1; j < t.grid.length; j++)
          expect(Math.hypot(t.grid[i].x - t.grid[j].x, t.grid[i].z - t.grid[j].z)).toBeGreaterThan(4);
    });
  }
});

function driveLaps(classId: string, trackId: string, laps: number, maxSeconds: number) {
  const t = getTrack(trackId);
  const cfg = getVehicle(classId);
  const g = t.grid[0];
  const s = createVehicleState(g.x, g.z, g.yaw);
  const p = initialProgress();
  let airborne = 0;
  let steps = 0;
  const rules = { nitro: true, drift: true };
  while (!p.finished && steps < maxSeconds / SIM_DT) {
    const ev = stepVehicle(s, autopilot(s, t), cfg, t, rules, SIM_DT);
    if (!s.grounded) airborne++;
    expect(ev.recover).toBe('');
    const q = queryTrack(t, s.x, s.z);
    updateProgress(t, p, q.f, q.lateral, laps);
    steps++;
  }
  return { p, seconds: steps * SIM_DT, airborne };
}

describe('vehicle controller', () => {
  it('accelerates forward and respects top speed', () => {
    const t = getTrack('valley');
    const cfg = getVehicle('speedster');
    const g = t.grid[1];
    const s = createVehicleState(g.x, g.z, g.yaw);
    for (let i = 0; i < 60; i++) stepVehicle(s, { ...NEUTRAL_INPUT, throttle: 1 }, cfg, t, { nitro: true, drift: true }, SIM_DT);
    const v = Math.hypot(s.vx, s.vz);
    expect(v).toBeGreaterThan(15);
    expect(v).toBeLessThan(cfg.maxSpeed + 1);
  });
  for (const cls of ['speedster', 'bruiser', 'drifter'])
    for (const tr of TRACK_IDS)
      it(`${cls} completes 2 laps of ${tr} with the autopilot and catches air on ramps`, () => {
        const r = driveLaps(cls, tr, 2, 240);
        expect(r.p.finished).toBe(true);
        expect(r.airborne).toBeGreaterThan(5);
      });

  it('classes genuinely differ', () => {
    expect(getVehicle('bruiser').mass).toBeGreaterThan(getVehicle('speedster').mass);
    expect(getVehicle('speedster').maxSpeed).toBeGreaterThan(getVehicle('bruiser').maxSpeed);
    expect(getVehicle('drifter').driftGrip).toBeLessThan(getVehicle('bruiser').driftGrip);
  });

  it('drifting reduces grip and builds nitro', () => {
    const t = getTrack('valley');
    const cfg = getVehicle('drifter');
    const g = t.grid[1];
    const s = createVehicleState(g.x, g.z, g.yaw);
    s.nitro = 0;
    for (let i = 0; i < 60; i++) stepVehicle(s, { ...NEUTRAL_INPUT, throttle: 1 }, cfg, t, { nitro: true, drift: true }, SIM_DT);
    let maxSlip = 0;
    for (let i = 0; i < 25; i++) {
      stepVehicle(s, { ...NEUTRAL_INPUT, throttle: 1, steer: 1, handbrake: true }, cfg, t, { nitro: true, drift: true }, SIM_DT);
      const rx = -Math.cos(s.yaw), rz = Math.sin(s.yaw);
      maxSlip = Math.max(maxSlip, Math.abs(s.vx * rx + s.vz * rz));
    }
    expect(s.drifting || maxSlip > 2).toBe(true);
    expect(maxSlip).toBeGreaterThan(2);
    expect(s.nitro).toBeGreaterThan(0);
  });

  it('overturned cars right themselves automatically', () => {
    const t = getTrack('valley');
    const cfg = getVehicle('drifter');
    const g = t.grid[1];
    const s = createVehicleState(g.x, g.z, g.yaw);
    s.grounded = false; s.y = 3; s.roll = Math.PI; s.vy = 0;
    for (let i = 0; i < 120; i++) stepVehicle(s, NEUTRAL_INPUT, cfg, t, { nitro: true, drift: true }, SIM_DT);
    expect(s.grounded).toBe(true);
    expect(s.overturnT).toBe(0);
    expect(Math.abs(s.roll)).toBeLessThan(0.2);
  });
});

describe('lap validation', () => {
  it('cannot skip checkpoints or farm the finish line', () => {
    const t = getTrack('valley');
    const p = initialProgress();
    // Jump straight to the finish line region repeatedly: no laps credited.
    for (let k = 0; k < 10; k++) updateProgress(t, p, 1, 0, 3);
    expect(p.laps).toBe(0);
    // Teleport to checkpoint 5 without crossing 1..4: ignored.
    updateProgress(t, p, t.checkpoints[5] + 1, 0, 3);
    expect(p.nextCp).toBe(1);
    // Proper sequence completes a lap.
    for (let c = 1; c < t.checkpoints.length; c++) updateProgress(t, p, t.checkpoints[c] + 1, 0, 3);
    expect(updateProgress(t, p, 1, 0, 3)).toBe('lap');
    expect(p.laps).toBe(1);
  });
  it('finishes exactly once', () => {
    const t = getTrack('valley');
    const p = initialProgress();
    for (let c = 1; c < t.checkpoints.length; c++) updateProgress(t, p, t.checkpoints[c] + 1, 0, 1);
    expect(updateProgress(t, p, 1, 0, 1)).toBe('finish');
    for (let c = 1; c < t.checkpoints.length; c++) expect(updateProgress(t, p, t.checkpoints[c] + 1, 0, 1)).toBeNull();
    expect(updateProgress(t, p, 1, 0, 1)).toBeNull();
    expect(p.laps).toBe(1);
  });
});

describe('collisions', () => {
  it('head-on high speed hit launches cars and damages them, heavier car takes less', () => {
    const t = getTrack('valley');
    const a = createVehicleState(0, 0, 0);
    const b = createVehicleState(0, 3, Math.PI);
    a.vz = 35; b.vz = -35;
    const r = resolveCarCollision(a, b, getVehicle('bruiser'), getVehicle('speedster'));
    expect(r.hit).toBe(true);
    expect(r.launchedB).toBe(true);
    expect(b.grounded).toBe(false);
    expect(r.damageB).toBeGreaterThan(r.damageA);
    expect(Math.abs(b.rollRate)).toBeLessThanOrEqual(9);
    void t;
  });
  it('small bump is just a shove', () => {
    const a = createVehicleState(0, 0, 0);
    const b = createVehicleState(0, 3, 0);
    a.vz = 6; b.vz = 3;
    const r = resolveCarCollision(a, b, getVehicle('drifter'), getVehicle('drifter'));
    expect(r.hit).toBe(true);
    expect(r.launchedA || r.launchedB).toBe(false);
    expect(r.damageA + r.damageB).toBe(0);
    expect(b.vz).toBeGreaterThan(3);
  });
});

describe('safe respawn spot', () => {
  it('avoids occupied positions and ramps', () => {
    const t = getTrack('valley');
    const f = t.ramps[0].start + 2;
    const blocked = pointAt(t, f, 0);
    const spot = findSafeSpot(t, f, 0, [{ x: blocked.x, z: blocked.z }], 4.5);
    const p = pointAt(t, spot.f, spot.lateral);
    expect(Math.hypot(p.x - blocked.x, p.z - blocked.z)).toBeGreaterThan(4.5);
    const i = Math.floor(spot.f);
    expect(t.heights[((i % t.n) + t.n) % t.n]).toBe(0);
  });
});
