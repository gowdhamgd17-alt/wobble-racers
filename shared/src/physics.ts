// Arcade vehicle controller. Deterministic, allocation-light and shared by the
// authoritative server simulation and the client's local prediction.
//
// Design note: we use a purpose-built 2.5D arcade model (ground-height field +
// ballistic airborne phase + bounded spin) instead of a general rigid-body
// engine such as Rapier. Arcade racers need predictable grip, controlled
// drifts and bounded "fun" launches; a deterministic hand-written step also
// lets the client replay inputs exactly for prediction/reconciliation without
// shipping a WASM physics world to both sides.

import { NITRO, PHYS } from './constants';
import type { Track } from './track';
import { pointAt, queryTrack } from './track';
import type { VehicleConfig } from './vehicles';

export interface InputState {
  steer: number; // -1 (left) .. +1 (right)
  throttle: number; // 0..1
  brake: number; // 0..1
  handbrake: boolean;
  nitro: boolean;
  fire: boolean;
  recover: boolean;
}

export const NEUTRAL_INPUT: InputState = Object.freeze({
  steer: 0, throttle: 0, brake: 0, handbrake: false, nitro: false, fire: false, recover: false,
});

export interface VehicleState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  yaw: number; yawRate: number;
  pitch: number; roll: number; pitchRate: number; rollRate: number;
  grounded: boolean;
  overturnT: number; // >0 while upside-down waiting to be righted
  offTrackT: number;
  recoverCooldown: number;
  rampVy: number;
  trackIdx: number;
  nitro: number;
  boosting: boolean;
  drifting: boolean;
  padCooldown: number;
}

export interface Rules {
  nitro: boolean;
  drift: boolean;
}

export interface StepEvents {
  landingSpeed: number; // >0 when landed this step
  wallImpact: number; // outward speed into barrier
  boostPad: boolean;
  recover: '' | 'manual' | 'overturned' | 'offtrack' | 'fell';
  launched: boolean;
}

export function createVehicleState(x: number, z: number, yaw: number): VehicleState {
  return {
    x, y: 0, z, vx: 0, vy: 0, vz: 0, yaw, yawRate: 0,
    pitch: 0, roll: 0, pitchRate: 0, rollRate: 0,
    grounded: true, overturnT: 0, offTrackT: 0, recoverCooldown: 0, rampVy: 0,
    trackIdx: -1, nitro: NITRO.start, boosting: false, drifting: false, padCooldown: 0,
  };
}

export function cloneVehicleState(s: VehicleState): VehicleState {
  return { ...s };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const wrapAngle = (a: number) => {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
};

export function sanitizeInput(raw: unknown): InputState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : 0;
  return {
    steer: num(r.steer, -1, 1),
    throttle: num(r.throttle, 0, 1),
    brake: num(r.brake, 0, 1),
    handbrake: r.handbrake === true,
    nitro: r.nitro === true,
    fire: r.fire === true,
    recover: r.recover === true,
  };
}

export function speedOf(s: VehicleState) {
  return Math.hypot(s.vx, s.vz);
}

export function isOverturned(s: VehicleState) {
  return s.overturnT > 0;
}

const EVENTS: StepEvents = { landingSpeed: 0, wallImpact: 0, boostPad: false, recover: '', launched: false };

/**
 * Advance one vehicle by dt. Returns a shared events object (copy it if you
 * need to keep it past the next call).
 */
export function stepVehicle(
  s: VehicleState,
  input: InputState,
  cfg: VehicleConfig,
  track: Track,
  rules: Rules,
  dt: number,
): StepEvents {
  const ev = EVENTS;
  ev.landingSpeed = 0;
  ev.wallImpact = 0;
  ev.boostPad = false;
  ev.recover = '';
  ev.launched = false;

  s.recoverCooldown = Math.max(0, s.recoverCooldown - dt);
  s.padCooldown = Math.max(0, s.padCooldown - dt);

  const q0 = queryTrack(track, s.x, s.z, s.trackIdx);
  s.trackIdx = q0.index;
  const onRoad = q0.onRoad;

  // Nitro activation (hysteresis so it doesn't flicker at empty)
  const wantBoost = rules.nitro && input.nitro && s.overturnT <= 0;
  if (wantBoost && (s.boosting ? s.nitro > 0 : s.nitro >= NITRO.minToActivate)) {
    s.boosting = true;
    s.nitro = Math.max(0, s.nitro - NITRO.drainPerSecond * dt);
  } else {
    s.boosting = false;
  }

  let fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);

  if (s.overturnT > 0) {
    // Upside-down: slide to a halt, then auto-right with a little hop.
    s.drifting = false;
    s.vx *= Math.exp(-3 * dt);
    s.vz *= Math.exp(-3 * dt);
    s.overturnT -= dt;
    if (s.overturnT <= 0) {
      s.overturnT = 0;
      s.roll = 0;
      s.pitch = 0;
      s.rollRate = 0;
      s.pitchRate = 0;
      s.vy = cfg.recoveryHop;
      s.grounded = false;
    }
  } else if (s.grounded) {
    // --- Ground handling ---
    const speedAbs = Math.hypot(s.vx, s.vz);
    let vF = s.vx * fx + s.vz * fz;
    const driftOk = rules.drift && input.handbrake && Math.abs(input.steer) > 0.15 && vF > 9;
    s.drifting = driftOk || (s.drifting && rules.drift && input.handbrake && speedAbs > 6);

    const speedFactor = clamp(Math.abs(vF) / 5, 0, 1);
    const hsFactor = 1 / (1 + Math.max(0, Math.abs(vF) - 10) / cfg.highSpeedSteerFalloff);
    const dir = vF >= -0.5 ? 1 : -1;
    const targetYaw =
      -input.steer * cfg.steerResponse * speedFactor * hsFactor * dir * (s.drifting ? cfg.driftYawBoost : 1);
    s.yawRate += (targetYaw - s.yawRate) * Math.min(1, (s.drifting ? 5 : 10) * dt);
    s.yawRate = clamp(s.yawRate, -PHYS.maxYawRate, PHYS.maxYawRate);
    s.yaw = wrapAngle(s.yaw + s.yawRate * dt);

    fx = Math.sin(s.yaw);
    fz = Math.cos(s.yaw);
    const rx = -fz, rz = fx;
    vF = s.vx * fx + s.vz * fz;
    let vL = s.vx * rx + s.vz * rz;

    const top = cfg.maxSpeed * (s.boosting ? cfg.nitroMultiplier : 1) * (onRoad ? 1 : cfg.offroadSpeed);
    if (input.throttle > 0) {
      if (vF < -0.5) vF += cfg.brakeDecel * input.throttle * dt;
      else vF += cfg.acceleration * input.throttle * Math.max(0, 1 - vF / top) * dt;
    }
    if (s.boosting) vF += cfg.acceleration * 0.7 * dt;
    if (input.brake > 0) {
      if (vF > 0.5) vF = Math.max(0, vF - cfg.brakeDecel * input.brake * dt);
      else vF = Math.max(-cfg.reverseSpeed, vF - cfg.acceleration * 0.6 * input.brake * dt);
    }
    // Rolling resistance / coasting
    vF -= vF * (0.12 + (onRoad ? 0 : 1.1 * (1 - cfg.offroadSpeed) / 0.45)) * dt;
    if (input.throttle === 0 && input.brake === 0) vF -= Math.sign(vF) * Math.min(Math.abs(vF), 3 * dt);
    if (input.handbrake) vF -= vF * (s.drifting ? 0.35 : 1.4) * dt;
    if (vF > top) vF -= (vF - top) * 1.5 * dt;

    // Lateral grip: drifting lets the rear slide, normal grip pulls it back.
    let grip = s.drifting ? cfg.driftGrip : cfg.lateralGrip;
    if (!onRoad) grip *= 0.7;
    const lostLat = vL * (1 - Math.exp(-grip * dt));
    vL -= lostLat;
    if (s.drifting) vF += Math.abs(lostLat) * 0.45; // keep momentum through drifts

    if (s.drifting && rules.nitro && Math.abs(vL) > 2.5) {
      s.nitro = Math.min(NITRO.max, s.nitro + NITRO.driftGainPerSecond * dt);
    }

    s.vx = fx * vF + rx * vL;
    s.vz = fz * vF + rz * vL;

    // Boost pads
    if (rules.nitro && s.padCooldown <= 0) {
      for (const p of track.pads) {
        let d = q0.f - p.index;
        if (track.closed) {
          if (d > track.n / 2) d -= track.n;
          if (d < -track.n / 2) d += track.n;
        }
        if (Math.abs(d) < p.halfLen && Math.abs(q0.lateral - p.lateral) < p.halfWidth) {
          s.nitro = Math.min(NITRO.max, s.nitro + NITRO.padGain);
          s.vx += fx * NITRO.padImpulse;
          s.vz += fz * NITRO.padImpulse;
          s.padCooldown = 1;
          ev.boostPad = true;
          break;
        }
      }
    }

    s.pitch *= Math.exp(-10 * dt);
    s.roll += ((s.drifting ? -Math.sign(vL) * 0.06 : 0) - s.roll) * Math.min(1, 8 * dt);
  } else {
    // --- Airborne ---
    s.drifting = false;
    s.vy = Math.max(-30, s.vy - PHYS.gravity * dt);
    s.yawRate += -input.steer * cfg.airControl * dt;
    s.yawRate *= Math.exp(-0.6 * dt);
    s.yawRate = clamp(s.yawRate, -PHYS.maxYawRate, PHYS.maxYawRate);
    s.yaw = wrapAngle(s.yaw + s.yawRate * dt);
    s.pitchRate = clamp(s.pitchRate, -PHYS.maxSpinRate, PHYS.maxSpinRate);
    s.rollRate = clamp(s.rollRate, -PHYS.maxSpinRate, PHYS.maxSpinRate);
    s.pitch += s.pitchRate * dt;
    s.roll += s.rollRate * dt;
    // Gentle self-levelling when not spinning hard ("air control")
    if (Math.abs(s.rollRate) < 2) s.roll *= Math.exp(-1.2 * dt);
    if (Math.abs(s.pitchRate) < 2) s.pitch += (0.08 - s.pitch) * Math.min(1, 1.2 * dt);
    if (s.boosting) {
      s.vx += fx * cfg.acceleration * 0.5 * dt;
      s.vz += fz * cfg.acceleration * 0.5 * dt;
    }
    if (rules.nitro) s.nitro = Math.min(NITRO.max, s.nitro + NITRO.airGainPerSecond * dt);
    s.vx *= Math.exp(-0.05 * dt);
    s.vz *= Math.exp(-0.05 * dt);
  }

  // Integrate
  const yOld = s.y;
  s.x += s.vx * dt;
  s.z += s.vz * dt;
  if (!s.grounded) s.y += s.vy * dt;

  const wall = constrainToTrack(s, cfg, track);
  if (wall > 0) ev.wallImpact = wall;
  const q = queryTrack(track, s.x, s.z, s.trackIdx);
  s.trackIdx = q.index;

  // Ground contact
  if (s.grounded) {
    const h = q.height;
    if (h >= s.y - 0.35) {
      s.rampVy = (h - yOld) / dt;
      s.y = h;
      s.vy = 0;
    } else {
      // Drove off a ramp lip: go ballistic using the ramp's climb rate.
      s.grounded = false;
      s.vy = clamp(s.rampVy, 0, PHYS.maxVerticalSpeed);
      s.pitchRate = 0.4;
      ev.launched = true;
    }
  } else if (s.y <= q.height && s.vy <= 0) {
    const impact = -s.vy;
    s.y = q.height;
    s.vy = 0;
    s.grounded = true;
    s.rampVy = 0;
    ev.landingSpeed = impact;
    s.roll = wrapAngle(s.roll);
    s.pitch = wrapAngle(s.pitch);
    s.rollRate = 0;
    s.pitchRate = 0;
    if (Math.abs(s.roll) < 1.15 && Math.abs(s.pitch) < 1.15) {
      s.roll = 0;
      s.pitch = 0;
      if (impact > 7) {
        s.vx *= 0.9;
        s.vz *= 0.9;
      }
    } else {
      s.overturnT = PHYS.overturnRecoverSeconds;
      s.roll = Math.abs(s.roll) >= 1.15 ? Math.PI : 0;
      s.vx *= 0.5;
      s.vz *= 0.5;
    }
  }

  // Recovery triggers
  const outside = Math.abs(q.lateral) > track.halfWidth + PHYS.barrierInset + 0.5;
  if (outside && s.grounded) s.offTrackT += dt;
  else s.offTrackT = 0;

  if (s.y < PHYS.fallRecoverY) ev.recover = 'fell';
  else if (s.offTrackT > PHYS.offTrackRecoverSeconds) ev.recover = 'offtrack';
  else if (input.recover && s.recoverCooldown <= 0) {
    const stuck = Math.hypot(s.vx, s.vz) < 4 || s.overturnT > 0 || outside;
    if (stuck) ev.recover = 'manual';
  }
  return ev;
}

/** Place a vehicle on the track at fractional sample f / lateral, facing the driving direction. */
export function placeOnTrack(s: VehicleState, track: Track, f: number, lateral: number, keepYaw?: number) {
  const p = pointAt(track, f, lateral);
  const q = queryTrack(track, p.x, p.z);
  s.x = p.x;
  s.z = p.z;
  s.y = q.height;
  s.vx = s.vy = s.vz = 0;
  let yaw = p.yaw;
  if (keepYaw !== undefined && Math.abs(wrapAngle(keepYaw - p.yaw)) < Math.PI / 2) yaw = keepYaw;
  s.yaw = yaw;
  s.yawRate = s.pitch = s.roll = s.pitchRate = s.rollRate = 0;
  s.grounded = true;
  s.overturnT = 0;
  s.offTrackT = 0;
  s.rampVy = 0;
  s.drifting = false;
  s.boosting = false;
  s.trackIdx = q.index;
  s.recoverCooldown = PHYS.manualRecoverCooldown;
}

/**
 * Find a safe spot near (f, lateral): on the road, off ramps, and clear of
 * the given occupied points. Returns the chosen {f, lateral}.
 */
export function findSafeSpot(
  track: Track,
  f: number,
  lateral: number,
  occupied: { x: number; z: number }[],
  clearance: number,
): { f: number; lateral: number } {
  const maxLat = track.halfWidth - 2.5;
  const baseLat = clamp(lateral, -maxLat, maxLat);
  const lats = [baseLat, 0, -5, 5, -maxLat, maxLat];
  const offsets = [0, -2, 2, -4, 4, -6, 6, -9, 9, -13, 13, -18, 18, -24, 24];
  const n = track.n;
  const idx = (ff: number) => (track.closed ? ((Math.floor(ff) % n) + n) % n : Math.max(0, Math.min(n - 1, Math.floor(ff))));
  const onRamp = (ff: number) => track.heights[idx(ff)] > 0.01 || track.heights[idx(ff + 1)] > 0.01 || track.heights[idx(ff + 2)] > 0.01 || track.heights[idx(ff + 3)] > 0.01;
  const margin = 8 / track.ds;
  const clampF = (ff: number) => (track.closed ? ff : Math.max(margin, Math.min(n - 1 - margin, ff)));
  for (const o of offsets) {
    let ff = clampF(f + o * 1.5);
    // step backwards off ramps so we never respawn mid-jump
    let guard = 0;
    while (onRamp(ff) && guard++ < 20) ff -= 1;
    for (const lat of lats) {
      const p = pointAt(track, ff, lat);
      let free = true;
      for (const c of occupied) {
        if ((c.x - p.x) ** 2 + (c.z - p.z) ** 2 < clearance * clearance) { free = false; break; }
      }
      if (free) return { f: ff, lateral: lat };
    }
  }
  return { f: clampF(f), lateral: 0 };
}

export interface CollisionResult {
  hit: boolean;
  closingSpeed: number;
  damageA: number;
  damageB: number;
  launchedA: boolean;
  launchedB: boolean;
}

/** Corners of a car's footprint in world space (front-left, front-right, rear-right, rear-left). */
export function carCorners(x: number, z: number, yaw: number, hl: number, hw: number, out: number[] = []) {
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const rx = -fz, rz = fx;
  out.length = 0;
  for (const [a, b] of [[hl, -hw], [hl, hw], [-hl, hw], [-hl, -hw]]) out.push(x + fx * a + rx * b, z + fz * a + rz * b);
  return out;
}

export interface Overlap { depth: number; nx: number; nz: number; cx: number; cz: number }

/**
 * Separating-axis test between two oriented rectangles. Returns the minimum
 * translation (normal points from A to B) and an approximate contact point, or null.
 */
export function obbOverlap(
  ax: number, az: number, ayaw: number, ahl: number, ahw: number,
  bx: number, bz: number, byaw: number, bhl: number, bhw: number,
): Overlap | null {
  const dx = bx - ax, dz = bz - az;
  const reach = Math.hypot(ahl, ahw) + Math.hypot(bhl, bhw);
  if (dx * dx + dz * dz > reach * reach) return null;
  const afx = Math.sin(ayaw), afz = Math.cos(ayaw), bfx = Math.sin(byaw), bfz = Math.cos(byaw);
  const axes = [[afx, afz], [-afz, afx], [bfx, bfz], [-bfz, bfx]];
  let best = Infinity, nx = 0, nz = 0;
  for (const [ux, uz] of axes) {
    const ra = ahl * Math.abs(afx * ux + afz * uz) + ahw * Math.abs(-afz * ux + afx * uz);
    const rb = bhl * Math.abs(bfx * ux + bfz * uz) + bhw * Math.abs(-bfz * ux + bfx * uz);
    const dist = dx * ux + dz * uz;
    const o = ra + rb - Math.abs(dist);
    if (o <= 0) return null;
    if (o < best) {
      best = o;
      const sgn = dist >= 0 ? 1 : -1;
      nx = ux * sgn;
      nz = uz * sgn;
    }
  }
  // Contact: B's corner deepest towards A, averaged with A's corner deepest towards B.
  const cb = carCorners(bx, bz, byaw, bhl, bhw);
  const ca = carCorners(ax, az, ayaw, ahl, ahw);
  let mb = Infinity, ma = -Infinity, pbx = bx, pbz = bz, pax = ax, paz = az;
  for (let i = 0; i < 8; i += 2) {
    const pb = cb[i] * nx + cb[i + 1] * nz;
    if (pb < mb) { mb = pb; pbx = cb[i]; pbz = cb[i + 1]; }
    const pa = ca[i] * nx + ca[i + 1] * nz;
    if (pa > ma) { ma = pa; pax = ca[i]; paz = ca[i + 1]; }
  }
  return { depth: best, nx, nz, cx: (pax + pbx) / 2, cz: (paz + pbz) / 2 };
}

/**
 * Swept projectile (segment p0->p1, radius r) vs a car footprint.
 * Returns the hit fraction along the segment in [0,1], or -1.
 */
export function segmentHitsCar(
  x0: number, z0: number, x1: number, z1: number, r: number,
  cx: number, cz: number, yaw: number, hl: number, hw: number,
): number {
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const toLocal = (x: number, z: number) => {
    const dx = x - cx, dz = z - cz;
    return [dx * -fz + dz * fx, dx * fx + dz * fz]; // [right, forward]
  };
  const [ax, ay] = toLocal(x0, z0);
  const [bx, by] = toLocal(x1, z1);
  const ex = hw + r, ey = hl + r;
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  for (const [p, d, e] of [[ax, dx, ex], [ay, dy, ey]] as const) {
    if (Math.abs(d) < 1e-9) {
      if (Math.abs(p) > e) return -1;
    } else {
      let ta = (-e - p) / d, tb = (e - p) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) return -1;
    }
  }
  return t0;
}

const CORNERS: number[] = [];

/**
 * Keep the whole car footprint inside the barriers (and inside the end walls
 * of straight tracks). Returns the speed of the impact into a wall (0 if none).
 * Cars flying higher than the barrier pass over it.
 */
export function constrainToTrack(s: VehicleState, cfg: VehicleConfig, track: Track): number {
  const qc = queryTrack(track, s.x, s.z, s.trackIdx);
  s.trackIdx = qc.index;
  const ground = Math.max(0, qc.height);
  if (s.y > PHYS.barrierHeight + 0.4 + ground) return 0;
  const face = track.halfWidth + PHYS.barrierInset; // inner face of the barrier
  const outerFace = face + 0.5 + 0.05;
  const inside = Math.abs(qc.lateral) < face + 0.25;
  let impact = 0;
  for (let pass = 0; pass < 2; pass++) {
    carCorners(s.x, s.z, s.yaw, cfg.halfLength, cfg.halfWidth, CORNERS);
    let pushX = 0, pushZ = 0, nX = 0, nZ = 0, deepest = 0, tangentX = 0, tangentZ = 0;
    for (let i = 0; i < 8; i += 2) {
      const q = queryTrack(track, CORNERS[i], CORNERS[i + 1], s.trackIdx);
      const p = pointAt(track, q.f, 0);
      const side = Math.sign(q.lateral) || 1;
      let over = 0, ox = 0, oz = 0;
      if (inside) {
        over = Math.abs(q.lateral) - face;
        ox = -p.tz * side; oz = p.tx * side; // outward normal
      } else if (Math.abs(q.lateral) < outerFace && Math.sign(q.lateral) === Math.sign(qc.lateral)) {
        // Car is outside the barrier: keep it outside.
        over = outerFace - Math.abs(q.lateral);
        ox = p.tz * side; oz = -p.tx * side;
      }
      // End walls on straight tracks
      if (!track.closed) {
        if (q.f < 0.5) {
          const e = (0.5 - q.f) * track.ds;
          if (e > over) { over = e; ox = -p.tx; oz = -p.tz; }
        } else if (q.f > track.n - 1.5) {
          const e = (q.f - (track.n - 1.5)) * track.ds;
          if (e > over) { over = e; ox = p.tx; oz = p.tz; }
        }
      }
      if (over > deepest) {
        deepest = over;
        nX = ox; nZ = oz;
        pushX = -ox * over; pushZ = -oz * over;
        tangentX = p.tx; tangentZ = p.tz;
      }
    }
    if (deepest <= 0) break;
    s.x += pushX;
    s.z += pushZ;
    const vn = s.vx * nX + s.vz * nZ;
    if (vn > 0) {
      s.vx -= nX * vn * 1.3;
      s.vz -= nZ * vn * 1.3;
      s.vx *= 0.94;
      s.vz *= 0.94;
      impact = Math.max(impact, vn);
      // Turn towards the wall's direction so cars scrape along instead of sticking.
      const tangentYaw = Math.atan2(tangentX, tangentZ);
      const fwdDot = Math.sin(s.yaw) * tangentX + Math.cos(s.yaw) * tangentZ;
      const targetYaw = fwdDot >= 0 ? tangentYaw : wrapAngle(tangentYaw + Math.PI);
      s.yaw = wrapAngle(s.yaw + wrapAngle(targetYaw - s.yaw) * 0.12);
      s.yawRate *= 0.6;
    }
  }
  return impact;
}

export interface CollisionResult {
  hit: boolean;
  closingSpeed: number;
  damageA: number;
  damageB: number;
  launchedA: boolean;
  launchedB: boolean;
}

/**
 * Car-vs-car response using the real oriented footprints: push apart along the
 * minimum-overlap axis (mass weighted), then a mass-weighted impulse with
 * spin from the contact lever arm and an arcade "launch" for big hits.
 */
export function resolveCarCollision(
  a: VehicleState, b: VehicleState, ca: VehicleConfig, cb: VehicleConfig,
): CollisionResult {
  const res: CollisionResult = { hit: false, closingSpeed: 0, damageA: 0, damageB: 0, launchedA: false, launchedB: false };
  if (Math.abs(a.y - b.y) > 1.6) return res;
  const o = obbOverlap(a.x, a.z, a.yaw, ca.halfLength, ca.halfWidth, b.x, b.z, b.yaw, cb.halfLength, cb.halfWidth);
  if (!o) return res;
  const { nx, nz } = o;
  const ma = ca.mass, mb = cb.mass;
  const wa = mb / (ma + mb), wb = ma / (ma + mb);
  const sep = o.depth + 0.02;
  a.x -= nx * sep * wa;
  a.z -= nz * sep * wa;
  b.x += nx * sep * wb;
  b.z += nz * sep * wb;

  const rvx = a.vx - b.vx, rvz = a.vz - b.vz;
  const vn = rvx * nx + rvz * nz; // >0 = approaching
  if (vn <= 0) return res;
  res.hit = true;
  res.closingSpeed = vn;
  const e = 0.3;
  const j = ((1 + e) * vn) / (1 / ma + 1 / mb);
  const boostA = a.boosting ? 1.35 : 1, boostB = b.boosting ? 1.35 : 1;
  const ja = (j * cb.collisionImpulse * boostB) / ma;
  const jb = (j * ca.collisionImpulse * boostA) / mb;
  a.vx -= nx * ja;
  a.vz -= nz * ja;
  b.vx += nx * jb;
  b.vz += nz * jb;

  // Spin from the lever arm of the contact point (yaw increases to the left).
  const leverA = (o.cx - a.x) * nz - (o.cz - a.z) * nx;
  const leverB = (o.cx - b.x) * nz - (o.cz - b.z) * nx;
  const spin = (lever: number, imp: number, hl: number) => clamp((lever * imp) / (hl * 1.6), -3.5, 3.5);
  a.yawRate = clamp(a.yawRate - spin(leverA, ja, ca.halfLength), -PHYS.maxYawRate, PHYS.maxYawRate);
  b.yawRate = clamp(b.yawRate + spin(leverB, jb, cb.halfLength), -PHYS.maxYawRate, PHYS.maxYawRate);

  const launchFor = (s: VehicleState, recv: number, sideSign: number) => {
    if (recv < PHYS.collisionLaunchSpeed * 0.6 || vn < PHYS.collisionLaunchSpeed) return false;
    s.grounded = false;
    s.overturnT = 0;
    s.vy = clamp((recv - PHYS.collisionLaunchSpeed * 0.5) * 0.45, 3, PHYS.maxLaunch);
    s.rollRate = clamp(sideSign * recv * 0.35, -PHYS.maxSpinRate, PHYS.maxSpinRate);
    s.pitchRate = clamp(recv * 0.12, -4, 4);
    return true;
  };
  const sideA = Math.sign(-(Math.cos(a.yaw) * nx) + Math.sin(a.yaw) * nz) || 1;
  const sideB = -Math.sign(-(Math.cos(b.yaw) * nx) + Math.sin(b.yaw) * nz) || 1;
  res.launchedA = launchFor(a, ja, sideA);
  res.launchedB = launchFor(b, jb, sideB);

  const base = Math.max(0, vn - 5) * 1.05;
  res.damageA = (base * (mb / ma) ** 0.5 * cb.collisionImpulse * boostB) / ca.damageResistance;
  res.damageB = (base * (ma / mb) ** 0.5 * ca.collisionImpulse * boostA) / cb.damageResistance;
  return res;
}
