import { describe, expect, it } from 'vitest';
import {
  validateDisplayName, sanitizeSettings, DEFAULT_SETTINGS, sanitizeAppearance, sanitizeMaxPlayers,
  getTrack, createVehicleState, stepVehicle, getVehicle, SIM_DT, autopilot, NEUTRAL_INPUT,
  initialProgress, updateProgress, queryTrack, resolveCarCollision, findSafeSpot, pointAt,
  decodeInput, encodeInput, damageState, TRACK_DEFS, KM_OPTIONS, CAR_CLASS_IDS, constrainToTrack, carCorners,
  obbOverlap, segmentHitsCar, totalLapsFor, PHYS, sanitizeSettings as sanitize, type Track,
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
    expect(decodeInput([1, 0, 0, 0, 999])).toBeNull();
    expect(decodeInput([1, 0, 0, 0, 11 << 5])).toBeNull(); // weapon slot out of range
  });
});

describe('tracks', () => {
  for (const d of TRACK_DEFS)
    for (const km of KM_OPTIONS) {
      it(`${d.id} ${km} km: right length, 15 grid slots on the road, no overlapping slots`, () => {
        const t = getTrack({ layout: d.layout, trackId: d.id, distanceKm: km });
        expect(t.raceLength / 1000).toBeCloseTo(km, 1);
        expect(t.closed).toBe(d.layout === 'loop');
        expect(t.grid.length).toBeGreaterThanOrEqual(15);
        for (const g of t.grid) expect(Math.abs(queryTrack(t, g.x, g.z).lateral)).toBeLessThan(t.halfWidth - 1.3);
        for (let i = 0; i < t.grid.length; i++)
          for (let j = i + 1; j < t.grid.length; j++)
            expect(obbOverlap(t.grid[i].x, t.grid[i].z, t.grid[i].yaw, 2.6, 1.5, t.grid[j].x, t.grid[j].z, t.grid[j].yaw, 2.6, 1.5)).toBeNull();
        if (t.closed) {
          const a = pointAt(t, 0), b = pointAt(t, t.n - 1);
          expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(t.ds * 1.5);
        } else {
          // Grid is behind the start line, finish line is before the end of the road.
          for (const g of t.grid) expect(queryTrack(t, g.x, g.z).f).toBeLessThan(t.startIdx);
          expect(t.finishIdx).toBeLessThan(t.n - 40);
        }
        expect(t.ramps.length).toBeGreaterThanOrEqual(1);
        expect(t.pads.length).toBeGreaterThanOrEqual(2);
      });
    }
  it('sanitises layout, track and distance together', () => {
    expect(sanitize({ layout: 'straight' })).toMatchObject({ layout: 'straight', trackId: 'canyon' });
    expect(sanitize({ layout: 'loop', trackId: 'canyon' }).trackId).toBe('valley');
    expect(sanitize({ distanceKm: 7 }).distanceKm).toBe(1.5);
    expect(sanitize({ distanceKm: 7 }, { ...sanitize({}), distanceKm: 5 }).distanceKm).toBe(5);
    expect(sanitize({ distanceKm: 10 }).distanceKm).toBe(10);
    expect(totalLapsFor(getTrack({ layout: 'straight', trackId: 'coast', distanceKm: 2 }), 5)).toBe(1);
  });
});

function driveLaps(classId: string, track: Track, laps: number, maxSeconds: number) {
  const t = track;
  const cfg = getVehicle(classId);
  const g = t.grid[0];
  const s = createVehicleState(g.x, g.z, g.yaw);
  const p = initialProgress(t);
  let airborne = 0;
  let steps = 0;
  const rules = { nitro: true, drift: true };
  while (!p.finished && steps < maxSeconds / SIM_DT) {
    const ev = stepVehicle(s, autopilot(s, t), cfg, t, rules, SIM_DT);
    if (!s.grounded) airborne++;
    expect(ev.recover).toBe('');
    const q = queryTrack(t, s.x, s.z);
    updateProgress(t, p, q.f, q.lateral, totalLapsFor(t, laps));
    steps++;
  }
  return { p, seconds: steps * SIM_DT, airborne };
}

describe('vehicle controller', () => {
  it('accelerates forward and respects top speed', () => {
    const t = getTrack({ layout: 'loop', trackId: 'valley', distanceKm: 1.5 });
    const cfg = getVehicle('speedster');
    const g = t.grid[1];
    const s = createVehicleState(g.x, g.z, g.yaw);
    for (let i = 0; i < 60; i++) stepVehicle(s, { ...NEUTRAL_INPUT, throttle: 1 }, cfg, t, { nitro: true, drift: true }, SIM_DT);
    const v = Math.hypot(s.vx, s.vz);
    expect(v).toBeGreaterThan(15);
    expect(v).toBeLessThan(cfg.maxSpeed + 1);
  });
  for (const cls of CAR_CLASS_IDS)
    for (const d of TRACK_DEFS)
      it(`${cls} finishes a 1 km ${d.layout} on ${d.id} with the autopilot and catches air`, () => {
        const r = driveLaps(cls, getTrack({ layout: d.layout, trackId: d.id, distanceKm: 1 }), 1, 150);
        expect(r.p.finished).toBe(true);
        expect(r.airborne).toBeGreaterThan(5);
      });
  it('formula finishes a 3 km sprint and a 2-lap 2 km loop', () => {
    expect(driveLaps('formula', getTrack({ layout: 'straight', trackId: 'canyon', distanceKm: 3 }), 1, 300).p.finished).toBe(true);
    expect(driveLaps('formula', getTrack({ layout: 'loop', trackId: 'lagoon', distanceKm: 2 }), 2, 400).p.finished).toBe(true);
  });

  it('classes genuinely differ', () => {
    expect(getVehicle('bruiser').mass).toBeGreaterThan(getVehicle('speedster').mass);
    expect(getVehicle('speedster').maxSpeed).toBeGreaterThan(getVehicle('bruiser').maxSpeed);
    expect(getVehicle('drifter').driftGrip).toBeLessThan(getVehicle('bruiser').driftGrip);
    expect(getVehicle('buggy').offroadSpeed).toBeGreaterThan(getVehicle('formula').offroadSpeed);
    expect(CAR_CLASS_IDS.length).toBe(10);
  });

  it('drifting reduces grip and builds nitro', () => {
    const t = getTrack({ layout: 'loop', trackId: 'valley', distanceKm: 1.5 });
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
    const t = getTrack({ layout: 'loop', trackId: 'valley', distanceKm: 1.5 });
    const cfg = getVehicle('drifter');
    const g = t.grid[1];
    const s = createVehicleState(g.x, g.z, g.yaw);
    s.grounded = false; s.y = 3; s.roll = Math.PI; s.vy = 0;
    for (let i = 0; i < 120; i++) stepVehicle(s, NEUTRAL_INPUT, cfg, t, { nitro: true, drift: true }, SIM_DT);
    expect(s.grounded).toBe(true);
    expect(s.overturnT).toBe(0);
    expect(Math.abs(s.roll)).toBeLessThan(0.2);
  });
  it('every class rolls back onto its wheels in one hop (no repeated flipping)', () => {
    const t = getTrack({ layout: 'loop', trackId: 'valley', distanceKm: 1.5 });
    for (const id of CAR_CLASS_IDS) {
      const cfg = getVehicle(id);
      const g = t.grid[1];
      const s = createVehicleState(g.x, g.z, g.yaw);
      s.grounded = false; s.y = 2; s.roll = Math.PI; s.vy = 0;
      let flips = 0, wasOver = false;
      for (let i = 0; i < 150; i++) {
        stepVehicle(s, NEUTRAL_INPUT, cfg, t, { nitro: true, drift: true }, SIM_DT);
        if (s.overturnT > 0 && !wasOver) flips++;
        wasOver = s.overturnT > 0;
      }
      expect(flips, id).toBe(1);
      expect(s.grounded, id).toBe(true);
      expect(Math.abs(s.roll), id).toBeLessThan(0.01);
    }
  });
});

describe('sprint validation', () => {
  const t = getTrack({ layout: 'straight', trackId: 'canyon', distanceKm: 2 });
  it('cannot skip to the finish', () => {
    const p = initialProgress(t);
    expect(updateProgress(t, p, t.finishIdx + 1, 0, 1)).toBeNull();
    expect(p.finished).toBe(false);
  });
  it('finishes once after every checkpoint in order', () => {
    const p = initialProgress(t);
    let last = null;
    for (const c of t.checkpoints) last = updateProgress(t, p, c + 1, 0, 1);
    expect(last).toBe('finish');
    expect(p.finished).toBe(true);
    expect(updateProgress(t, p, t.finishIdx + 1, 0, 1)).toBeNull();
  });
});

describe('lap validation', () => {
  it('cannot skip checkpoints or farm the finish line', () => {
    const t = getTrack({ layout: 'loop', trackId: 'valley', distanceKm: 1.5 });
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
    const t = getTrack({ layout: 'loop', trackId: 'valley', distanceKm: 1.5 });
    const p = initialProgress();
    for (let c = 1; c < t.checkpoints.length; c++) updateProgress(t, p, t.checkpoints[c] + 1, 0, 1);
    expect(updateProgress(t, p, 1, 0, 1)).toBe('finish');
    for (let c = 1; c < t.checkpoints.length; c++) expect(updateProgress(t, p, t.checkpoints[c] + 1, 0, 1)).toBeNull();
    expect(updateProgress(t, p, 1, 0, 1)).toBeNull();
    expect(p.laps).toBe(1);
  });
});

describe('collisions use the real car size', () => {
  const t = getTrack({ layout: 'loop', trackId: 'valley', distanceKm: 1.5 });
  it('nose-to-tail: cars 4 m apart (centre) overlap and get pushed apart fully', () => {
    const cfg = getVehicle('muscle');
    const a = createVehicleState(0, 0, 0);
    const b = createVehicleState(0, 4, 0);
    a.vz = 20; b.vz = 10;
    const r = resolveCarCollision(a, b, cfg, cfg);
    expect(r.hit).toBe(true);
    expect(obbOverlap(a.x, a.z, a.yaw, cfg.halfLength, cfg.halfWidth, b.x, b.z, b.yaw, cfg.halfLength, cfg.halfWidth)).toBeNull();
    expect(b.vz).toBeGreaterThan(10);
  });
  it('side by side but not touching: no collision', () => {
    const cfg = getVehicle('drifter');
    const a = createVehicleState(0, 0, 0);
    const b = createVehicleState(cfg.halfWidth * 2 + 0.1, 0, 0);
    expect(resolveCarCollision(a, b, cfg, cfg).hit).toBe(false);
  });
  it('head-on high speed hit launches the light car and hurts it more', () => {
    const a = createVehicleState(0, 0, 0);
    const b = createVehicleState(0, 4.5, Math.PI);
    a.vz = 35; b.vz = -35;
    const r = resolveCarCollision(a, b, getVehicle('monster'), getVehicle('speedster'));
    expect(r.hit).toBe(true);
    expect(r.launchedB).toBe(true);
    expect(r.damageB).toBeGreaterThan(r.damageA);
    expect(Math.abs(b.rollRate)).toBeLessThanOrEqual(PHYS.maxSpinRate);
  });
  it('small bump is just a shove', () => {
    const a = createVehicleState(0, 0, 0);
    const b = createVehicleState(0, 4.3, 0);
    a.vz = 6; b.vz = 3;
    const r = resolveCarCollision(a, b, getVehicle('drifter'), getVehicle('drifter'));
    expect(r.hit).toBe(true);
    expect(r.launchedA || r.launchedB).toBe(false);
    expect(r.damageA + r.damageB).toBe(0);
  });
  it('a car turned sideways against the barrier keeps every corner inside it', () => {
    for (const cls of CAR_CLASS_IDS) {
      const cfg = getVehicle(cls);
      const p = pointAt(t, 40, t.halfWidth + 0.5); // centre right next to the barrier
      const s = createVehicleState(p.x, p.z, p.yaw + Math.PI / 2); // perpendicular to the wall
      s.trackIdx = 40;
      s.vx = -p.tz * 15; s.vz = p.tx * 15; // driving into the wall
      constrainToTrack(s, cfg, t);
      const c = carCorners(s.x, s.z, s.yaw, cfg.halfLength, cfg.halfWidth);
      for (let i = 0; i < 8; i += 2) expect(Math.abs(queryTrack(t, c[i], c[i + 1], 40).lateral)).toBeLessThanOrEqual(t.halfWidth + PHYS.barrierInset + 0.01);
    }
  });
  it('end walls stop cars leaving a sprint track', () => {
    const st = getTrack({ layout: 'straight', trackId: 'canyon', distanceKm: 1 });
    const cfg = getVehicle('formula');
    const p = pointAt(st, st.n - 1, 0);
    const s = createVehicleState(p.x, p.z, p.yaw);
    s.trackIdx = st.n - 1;
    s.vx = p.tx * 30; s.vz = p.tz * 30;
    for (let i = 0; i < 60; i++) stepVehicle(s, { ...NEUTRAL_INPUT, throttle: 1 }, cfg, st, { nitro: true, drift: true }, SIM_DT);
    expect(queryTrack(st, s.x, s.z).f).toBeLessThan(st.n - 1);
  });
  it('blaster shots hit the long body, not just the centre', () => {
    const cfg = getVehicle('formula');
    // Shot crossing the car 2.2 m in front of its centre (still on the nose)
    expect(segmentHitsCar(-10, 2.2, 10, 2.2, 0.4, 0, 0, 0, cfg.halfLength, cfg.halfWidth)).toBeGreaterThanOrEqual(0);
    // Shot passing 0.6 m beside the car misses
    expect(segmentHitsCar(cfg.halfWidth + 1, -10, cfg.halfWidth + 1, 10, 0.4, 0, 0, 0, cfg.halfLength, cfg.halfWidth)).toBe(-1);
  });
});

describe('safe respawn spot', () => {
  it('avoids occupied positions and ramps', () => {
    const t = getTrack({ layout: 'loop', trackId: 'valley', distanceKm: 1.5 });
    const f = t.ramps[0].start + 2;
    const blocked = pointAt(t, f, 0);
    const spot = findSafeSpot(t, f, 0, [{ x: blocked.x, z: blocked.z }], 6.5);
    const p = pointAt(t, spot.f, spot.lateral);
    expect(Math.hypot(p.x - blocked.x, p.z - blocked.z)).toBeGreaterThan(6.5);
    const i = Math.floor(spot.f);
    expect(t.heights[((i % t.n) + t.n) % t.n]).toBe(0);
  });
});
