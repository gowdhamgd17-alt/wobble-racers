// Procedural closed-loop track built from a Catmull-Rom spline, resampled
// at uniform arc length. Used identically on server (authority) and client
// (rendering + prediction).

export type Vec2 = [number, number];

export interface RampDef {
  at: number; // fraction of lap where the ramp starts rising
  samples: number; // rise length in samples
  height: number;
}

export interface PadDef {
  at: number; // fraction of lap
  lateral: number; // offset from centerline (m), + = right
}

export interface TrackDef {
  id: string;
  name: string;
  description: string;
  controlPoints: Vec2[];
  reverse: boolean;
  halfWidth: number;
  ramps: RampDef[];
  pads: PadDef[];
}

export interface Track {
  def: TrackDef;
  n: number;
  length: number;
  ds: number;
  halfWidth: number;
  px: Float64Array;
  pz: Float64Array;
  tx: Float64Array; // unit tangent
  tz: Float64Array;
  heights: Float64Array; // road surface height per sample
  checkpoints: number[]; // sample indices; [0] is the finish line
  pads: { index: number; lateral: number; halfLen: number; halfWidth: number }[];
  ramps: { start: number; peak: number }[];
  grid: { x: number; z: number; yaw: number }[];
}

export interface TrackQuery {
  index: number; // nearest sample
  f: number; // fractional sample position along the loop [0, n)
  lateral: number; // signed distance from centerline, + = right of driving direction
  height: number; // ground height at the point
  onRoad: boolean;
}

const BASE_POINTS: Vec2[] = [
  [0, -160], [110, -165], [195, -135], [228, -60], [200, 5], [135, 25],
  [100, 80], [140, 145], [80, 200], [-40, 205], [-135, 170], [-205, 90],
  [-215, -20], [-160, -110], [-85, -150],
];

export const TRACK_DEFS: TrackDef[] = [
  {
    id: 'valley',
    name: 'Wobble Valley',
    description: 'Big sweepers, a tight hairpin, two jumps and plenty of room to cause trouble.',
    controlPoints: BASE_POINTS,
    reverse: false,
    halfWidth: 10,
    ramps: [
      { at: 0.115, samples: 6, height: 2.3 },
      { at: 0.785, samples: 6, height: 2.6 },
    ],
    pads: [
      { at: 0.07, lateral: -4 },
      { at: 0.45, lateral: 4 },
      { at: 0.6, lateral: 0 },
      { at: 0.94, lateral: 3 },
    ],
  },
  {
    id: 'valley-reverse',
    name: 'Wobble Valley (Reverse)',
    description: 'The same valley, driven backwards. The hairpin comes sooner than you think.',
    controlPoints: BASE_POINTS,
    reverse: true,
    halfWidth: 10,
    ramps: [
      { at: 0.17, samples: 6, height: 2.3 },
      { at: 0.86, samples: 6, height: 2.4 },
    ],
    pads: [
      { at: 0.06, lateral: 3 },
      { at: 0.38, lateral: -4 },
      { at: 0.68, lateral: 0 },
    ],
  },
];

export const TRACK_IDS = TRACK_DEFS.map((t) => t.id);
export const NUM_SAMPLES = 600;
export const NUM_CHECKPOINTS = 10;

function catmull(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

const cache = new Map<string, Track>();

export function getTrack(id: string): Track {
  const key = TRACK_IDS.includes(id) ? id : TRACK_IDS[0];
  let t = cache.get(key);
  if (!t) {
    t = buildTrack(TRACK_DEFS.find((d) => d.id === key)!);
    cache.set(key, t);
  }
  return t;
}

export function buildTrack(def: TrackDef): Track {
  const pts = def.reverse ? [...def.controlPoints].reverse() : def.controlPoints;
  const m = pts.length;
  // Dense sampling
  const dense: Vec2[] = [];
  const SUB = 60;
  for (let i = 0; i < m; i++) {
    const p0 = pts[(i - 1 + m) % m], p1 = pts[i], p2 = pts[(i + 1) % m], p3 = pts[(i + 2) % m];
    for (let s = 0; s < SUB; s++) {
      const t = s / SUB;
      dense.push([catmull(p0[0], p1[0], p2[0], p3[0], t), catmull(p0[1], p1[1], p2[1], p3[1], t)]);
    }
  }
  // Rotate so sample 0 is at the middle of the first long straight (between pts 0 and 1)
  const cum: number[] = [0];
  for (let i = 1; i <= dense.length; i++) {
    const a = dense[i - 1], b = dense[i % dense.length];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const length = cum[dense.length];
  const n = NUM_SAMPLES;
  const ds = length / n;
  const px = new Float64Array(n), pz = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const target = i * ds;
    while (cum[j + 1] < target) j++;
    const a = dense[j], b = dense[(j + 1) % dense.length];
    const seg = cum[j + 1] - cum[j];
    const u = seg > 0 ? (target - cum[j]) / seg : 0;
    px[i] = a[0] + (b[0] - a[0]) * u;
    pz[i] = a[1] + (b[1] - a[1]) * u;
  }
  const tx = new Float64Array(n), tz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n, b = (i + 1) % n;
    const dx = px[b] - px[a], dz = pz[b] - pz[a];
    const l = Math.hypot(dx, dz) || 1;
    tx[i] = dx / l;
    tz[i] = dz / l;
  }
  const heights = new Float64Array(n);
  const ramps: Track['ramps'] = [];
  for (const r of def.ramps) {
    const start = Math.round(r.at * n);
    for (let k = 0; k <= r.samples; k++) {
      heights[(start + k) % n] = r.height * (k / r.samples);
    }
    ramps.push({ start, peak: (start + r.samples) % n });
  }
  const checkpoints: number[] = [];
  for (let k = 0; k < NUM_CHECKPOINTS; k++) checkpoints.push(Math.round((k * n) / NUM_CHECKPOINTS));

  const pads = def.pads.map((p) => ({
    index: Math.round(p.at * n) % n,
    lateral: p.lateral,
    halfLen: 2.5, // samples
    halfWidth: 3,
  }));

  const track: Track = {
    def, n, length, ds, halfWidth: def.halfWidth, px, pz, tx, tz, heights,
    checkpoints, pads, ramps, grid: [],
  };
  // Starting grid: 15 slots in 5 rows of 3, ahead of the finish line.
  for (let k = 0; k < 15; k++) {
    const row = Math.floor(k / 3);
    const col = k % 3;
    const along = 8 + (4 - row) * 8 + (col === 1 ? 0 : 2);
    const lat = (col - 1) * 6;
    const p = pointAt(track, along / ds, lat);
    track.grid.push({ x: p.x, z: p.z, yaw: p.yaw });
  }
  return track;
}

/** World point at fractional sample f with lateral offset (+ = right). */
export function pointAt(track: Track, f: number, lateral = 0) {
  const n = track.n;
  const ff = ((f % n) + n) % n;
  const i = Math.floor(ff);
  const u = ff - i;
  const i2 = (i + 1) % n;
  const cx = track.px[i] + (track.px[i2] - track.px[i]) * u;
  const cz = track.pz[i] + (track.pz[i2] - track.pz[i]) * u;
  let tx = track.tx[i] + (track.tx[i2] - track.tx[i]) * u;
  let tz = track.tz[i] + (track.tz[i2] - track.tz[i]) * u;
  const l = Math.hypot(tx, tz) || 1;
  tx /= l;
  tz /= l;
  // right normal for forward (tx,tz) is (-tz, tx)
  return { x: cx - tz * lateral, z: cz + tx * lateral, yaw: Math.atan2(tx, tz), tx, tz };
}

/** Nearest-point query. Global search keeps it robust after any teleport/respawn. */
export function queryTrack(track: Track, x: number, z: number, hint = -1): TrackQuery {
  const n = track.n;
  let best = 0;
  let bestD = Infinity;
  if (hint >= 0) {
    // Local search first; fall back to global if the result is suspicious.
    for (let k = -12; k <= 12; k++) {
      const i = (hint + k + n) % n;
      const dx = x - track.px[i], dz = z - track.pz[i];
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (bestD > (track.halfWidth + 30) ** 2) bestD = Infinity;
  }
  if (bestD === Infinity) {
    for (let i = 0; i < n; i++) {
      const dx = x - track.px[i], dz = z - track.pz[i];
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
  }
  // Refine against the two adjacent segments.
  let f = best;
  let lateral = 0;
  let bestSeg = Infinity;
  for (const a of [(best - 1 + n) % n, best]) {
    const b = (a + 1) % n;
    const sx = track.px[b] - track.px[a], sz = track.pz[b] - track.pz[a];
    const len2 = sx * sx + sz * sz || 1;
    let u = ((x - track.px[a]) * sx + (z - track.pz[a]) * sz) / len2;
    u = Math.max(0, Math.min(1, u));
    const cx = track.px[a] + sx * u, cz = track.pz[a] + sz * u;
    const d = (x - cx) ** 2 + (z - cz) ** 2;
    if (d < bestSeg) {
      bestSeg = d;
      f = a + u;
      const l = Math.sqrt(len2);
      const tx = sx / l, tz = sz / l;
      lateral = (x - cx) * -tz + (z - cz) * tx;
    }
  }
  f = ((f % n) + n) % n;
  const i = Math.floor(f);
  const u = f - i;
  const onRoad = Math.abs(lateral) <= track.halfWidth;
  const height = onRoad ? track.heights[i] + (track.heights[(i + 1) % n] - track.heights[i]) * u : 0;
  return { index: Math.round(f) % n, f, lateral, height, onRoad };
}

/** Forward distance (in samples) from a to b along the loop, in [0, n). */
export function forwardSamples(track: Track, a: number, b: number) {
  return (((b - a) % track.n) + track.n) % track.n;
}
