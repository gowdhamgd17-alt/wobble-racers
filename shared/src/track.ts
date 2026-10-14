// Procedural tracks of any length. Two layouts:
//  - loop:     closed circuit, raced for N laps; the distance setting is the lap length.
//  - straight: point-to-point sprint; the distance setting is start line -> finish line.
// Tracks are resampled at ~2.3 m spacing and used identically on the server
// (authority) and the client (rendering + prediction).

export type Vec2 = [number, number];
export type Layout = 'loop' | 'straight';

export const LAYOUTS: Layout[] = ['loop', 'straight'];
export const KM_OPTIONS = [1, 1.5, 2, 3, 5, 10] as const;
export const DEFAULT_KM = 1.5;

export interface TrackDef {
  id: string;
  name: string;
  layout: Layout;
  description: string;
}

export const TRACK_DEFS: TrackDef[] = [
  { id: 'valley', name: 'Wobble Valley', layout: 'loop', description: 'Big sweepers and a tight hairpin.' },
  { id: 'valley-reverse', name: 'Valley Reverse', layout: 'loop', description: 'Wobble Valley driven backwards.' },
  { id: 'lagoon', name: 'Lagoon Ring', layout: 'loop', description: 'Fast, flowing curves around a lagoon.' },
  { id: 'canyon', name: 'Canyon Run', layout: 'straight', description: 'Point-to-point blast with long sweepers.' },
  { id: 'coast', name: 'Coast Road', layout: 'straight', description: 'Twistier sprint along the shore.' },
];
export const TRACK_IDS = TRACK_DEFS.map((t) => t.id);

export function tracksFor(layout: Layout) {
  return TRACK_DEFS.filter((t) => t.layout === layout);
}

export interface TrackSpec {
  layout: string;
  trackId: string;
  distanceKm: number;
}

export interface Track {
  key: string;
  def: TrackDef;
  closed: boolean;
  n: number;
  ds: number;
  length: number; // total centreline length (m)
  raceLength: number; // lap length (loop) or start->finish distance (straight)
  startIdx: number; // loop: 0 (= finish line). straight: start line sample
  finishIdx: number; // loop: 0. straight: finish line sample
  halfWidth: number;
  px: Float64Array;
  pz: Float64Array;
  tx: Float64Array;
  tz: Float64Array;
  heights: Float64Array;
  checkpoints: number[];
  pads: { index: number; lateral: number; halfLen: number; halfWidth: number }[];
  ramps: { start: number; peak: number }[];
  grid: { x: number; z: number; yaw: number }[];
}

export interface TrackQuery {
  index: number; // nearest sample (clamped to the track)
  f: number; // fractional sample; loop: [0,n); straight: may go <0 or >n-1 beyond the ends
  lateral: number; // signed distance from centreline, + = right of driving direction
  height: number;
  onRoad: boolean;
}

const TARGET_DS = 2.3;
const RAMP_LEN = 14; // metres of rise
const RAMP_HEIGHT = 2.4;
export const RUN_IN = 70; // straight: metres of road behind the start line
export const RUN_OUT = 160; // straight: metres of road after the finish line

const VALLEY_POINTS: Vec2[] = [
  [0, -160], [110, -165], [195, -135], [228, -60], [200, 5], [135, 25],
  [100, 80], [140, 145], [80, 200], [-40, 205], [-135, 170], [-205, 90],
  [-215, -20], [-160, -110], [-85, -150],
];

export function normalizeSpec(spec: Partial<TrackSpec>): TrackSpec {
  const layout: Layout = spec.layout === 'straight' ? 'straight' : 'loop';
  const options = tracksFor(layout);
  const trackId = options.some((t) => t.id === spec.trackId) ? spec.trackId! : options[0].id;
  const km = (KM_OPTIONS as readonly number[]).includes(spec.distanceKm as number) ? (spec.distanceKm as number) : DEFAULT_KM;
  return { layout, trackId, distanceKm: km };
}

export function trackKey(spec: Partial<TrackSpec>) {
  const s = normalizeSpec(spec);
  return `${s.layout}|${s.trackId}|${s.distanceKm}`;
}

const cache = new Map<string, Track>();

/** Accepts a TrackSpec, a key from trackKey(), or a bare track id (legacy). */
export function getTrack(spec: Partial<TrackSpec> | string): Track {
  let s: TrackSpec;
  if (typeof spec === 'string') {
    if (spec.includes('|')) {
      const [layout, trackId, km] = spec.split('|');
      s = normalizeSpec({ layout, trackId, distanceKm: Number(km) });
    } else {
      const def = TRACK_DEFS.find((d) => d.id === spec);
      s = normalizeSpec({ layout: def?.layout ?? 'loop', trackId: spec, distanceKm: DEFAULT_KM });
    }
  } else s = normalizeSpec(spec);
  const key = `${s.layout}|${s.trackId}|${s.distanceKm}`;
  let t = cache.get(key);
  if (!t) {
    t = buildTrack(s);
    cache.set(key, t);
    if (cache.size > 12) cache.delete(cache.keys().next().value as string);
  }
  return t;
}

// ------------------------------------------------------------------ geometry helpers

function catmull(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function polyLength(pts: Vec2[], closed: boolean) {
  let L = 0;
  const m = pts.length;
  for (let i = 0; i < (closed ? m : m - 1); i++) {
    const a = pts[i], b = pts[(i + 1) % m];
    L += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return L;
}

/** Dense closed Catmull-Rom polyline through control points. */
function denseClosed(pts: Vec2[]): Vec2[] {
  const m = pts.length;
  const out: Vec2[] = [];
  for (let i = 0; i < m; i++) {
    const p0 = pts[(i - 1 + m) % m], p1 = pts[i], p2 = pts[(i + 1) % m], p3 = pts[(i + 2) % m];
    const seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const sub = Math.max(40, Math.ceil(seg / 1.5));
    for (let s = 0; s < sub; s++) {
      const t = s / sub;
      out.push([catmull(p0[0], p1[0], p2[0], p3[0], t), catmull(p0[1], p1[1], p2[1], p3[1], t)]);
    }
  }
  return out;
}

/** Resample a dense polyline at uniform spacing. */
function resample(dense: Vec2[], closed: boolean, targetDs: number) {
  const m = dense.length;
  const cum: number[] = [0];
  const segs = closed ? m : m - 1;
  for (let i = 1; i <= segs; i++) {
    const a = dense[i - 1], b = dense[i % m];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const length = cum[segs];
  const n = closed ? Math.max(60, Math.round(length / targetDs)) : Math.max(60, Math.round(length / targetDs) + 1);
  const ds = closed ? length / n : length / (n - 1);
  const px = new Float64Array(n), pz = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const target = Math.min(length, i * ds);
    while (j < segs - 1 && cum[j + 1] < target) j++;
    const a = dense[j], b = dense[(j + 1) % m];
    const seg = cum[j + 1] - cum[j];
    const u = seg > 0 ? (target - cum[j]) / seg : 0;
    px[i] = a[0] + (b[0] - a[0]) * u;
    pz[i] = a[1] + (b[1] - a[1]) * u;
  }
  return { px, pz, n, ds, length };
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ shapes

function loopShape(id: string, targetLen: number): Vec2[] {
  let pts: Vec2[];
  if (id === 'lagoon') {
    pts = [];
    const N = 96;
    for (let i = 0; i < N; i++) {
      const th = (i / N) * Math.PI * 2;
      const r = 1 + 0.2 * Math.sin(2 * th + 0.6) + 0.1 * Math.sin(3 * th + 2.1) + 0.045 * Math.sin(5 * th + 1.0);
      pts.push([Math.cos(th) * r * 100, Math.sin(th) * r * 100]);
    }
  } else {
    pts = id === 'valley-reverse' ? [...VALLEY_POINTS].reverse() : VALLEY_POINTS.slice();
  }
  // Catmull-Rom is scale-invariant, so scaling control points scales the length exactly.
  const base = polyLength(denseClosed(pts), true);
  const k = targetLen / base;
  return denseClosed(pts.map(([x, z]) => [x * k, z * k] as Vec2));
}

function straightShape(id: string, raceLen: number): Vec2[] {
  const rnd = mulberry(id === 'coast' ? 11 : 3);
  const twist = id === 'coast' ? 1.35 : 1;
  // Heading = sum of slow sines, kept within ±65° of the base direction so the
  // road never doubles back on itself.
  const waves = [0, 1, 2].map((i) => ({
    a: (0.55 - i * 0.15) * twist * (0.8 + rnd() * 0.4),
    l: (900 - i * 330) / twist * (0.8 + rnd() * 0.4),
    p: rnd() * Math.PI * 2,
  }));
  const total = RUN_IN + raceLen + RUN_OUT;
  const step = 2;
  const out: Vec2[] = [[0, 0]];
  let x = 0, z = 0;
  for (let s = step; s <= total + 0.001; s += step) {
    let h = 0;
    // Fade the wiggle in so the start straight is straight.
    const fade = Math.min(1, Math.max(0, (s - RUN_IN - 60) / 200));
    for (const w of waves) h += w.a * Math.sin((2 * Math.PI * s) / w.l + w.p) - w.a * Math.sin(w.p);
    h = Math.max(-1.13, Math.min(1.13, h * fade));
    x += Math.sin(h) * step;
    z += Math.cos(h) * step;
    out.push([x, z]);
  }
  return out;
}

// ------------------------------------------------------------------ build

export function buildTrack(spec: TrackSpec): Track {
  const def = TRACK_DEFS.find((d) => d.id === spec.trackId)!;
  const closed = spec.layout === 'loop';
  const raceTarget = spec.distanceKm * 1000;
  const dense = closed ? loopShape(spec.trackId, raceTarget) : straightShape(spec.trackId, raceTarget);
  const { px, pz, n, ds, length } = resample(dense, closed, TARGET_DS);

  const tx = new Float64Array(n), tz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = closed ? (i - 1 + n) % n : Math.max(0, i - 1);
    const b = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
    const dx = px[b] - px[a], dz = pz[b] - pz[a];
    const l = Math.hypot(dx, dz) || 1;
    tx[i] = dx / l;
    tz[i] = dz / l;
  }

  // Curvature (rad/m) smoothed over a few samples; narrow the road if the tightest corner needs it.
  const curv = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = closed ? (i - 2 + n) % n : Math.max(0, i - 2);
    const b = closed ? (i + 2) % n : Math.min(n - 1, i + 2);
    const cr = tx[a] * tz[b] - tz[a] * tx[b];
    const dot = tx[a] * tx[b] + tz[a] * tz[b];
    curv[i] = Math.abs(Math.atan2(cr, dot)) / (ds * Math.max(1, (closed ? 4 : b - a)));
  }
  // Tightest corner, measured over ±1 sample, decides the road width.
  let maxCurv = 0;
  for (let i = 0; i < n; i++) {
    const a = closed ? (i - 1 + n) % n : Math.max(0, i - 1);
    const b = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
    if (a === b) continue;
    const k = Math.abs(Math.atan2(tx[a] * tz[b] - tz[a] * tx[b], tx[a] * tx[b] + tz[a] * tz[b])) / (ds * (closed ? 2 : b - a));
    maxCurv = Math.max(maxCurv, k);
  }
  const minRadius = maxCurv > 0 ? 1 / maxCurv : 1e9;
  const halfWidth = Math.max(7.5, Math.min(10, minRadius - 3.5));

  const startIdx = closed ? 0 : Math.round(RUN_IN / ds);
  const finishIdx = closed ? 0 : Math.min(n - 1, startIdx + Math.round(raceTarget / ds));
  const raceLength = closed ? length : (finishIdx - startIdx) * ds;

  const track: Track = {
    key: `${spec.layout}|${spec.trackId}|${spec.distanceKm}`,
    def, closed, n, ds, length, raceLength, startIdx, finishIdx, halfWidth,
    px, pz, tx, tz, heights: new Float64Array(n), checkpoints: [], pads: [], ramps: [], grid: [],
  };

  placeFeatures(track, curv);

  // Checkpoints
  const K = Math.max(closed ? 8 : 6, Math.round(raceLength / 150));
  if (closed) {
    for (let k = 0; k < K; k++) track.checkpoints.push(Math.round((k * n) / K) % n);
  } else {
    for (let k = 1; k <= K; k++) track.checkpoints.push(Math.round(startIdx + ((finishIdx - startIdx) * k) / K));
  }

  // Starting grid: 15 slots, 5 rows of 3.
  const colGap = Math.min(6, halfWidth - 2.8);
  for (let k = 0; k < 15; k++) {
    const row = Math.floor(k / 3), col = k % 3;
    const stagger = col === 1 ? 0 : 2;
    const along = closed ? 8 + (4 - row) * 8 + stagger : -(7 + row * 8 + stagger);
    const p = pointAt(track, startIdx + along / ds, (col - 1) * colGap);
    track.grid.push({ x: p.x, z: p.z, yaw: p.yaw });
  }
  return track;
}

/** Ramps roughly every 550 m and boost pads every 260 m, on the straightest stretches. */
function placeFeatures(t: Track, curv: Float64Array) {
  const { n, ds, closed } = t;
  const lo = closed ? Math.round(130 / ds) : t.startIdx + Math.round(90 / ds);
  const hi = closed ? n - Math.round(70 / ds) : t.finishIdx - Math.round(90 / ds);
  if (hi <= lo) return;
  const span = hi - lo;
  const straightness = (i: number, ahead: number) => {
    let m = 0;
    for (let k = -4; k < ahead; k++) {
      const j = closed ? (((i + k) % n) + n) % n : Math.min(n - 1, Math.max(0, i + k));
      m = Math.max(m, curv[j]);
    }
    return m;
  };
  const taken: number[] = [];
  const free = (i: number, gap: number) => taken.every((j) => Math.abs(j - i) > gap);

  const rampSamples = Math.max(4, Math.round(RAMP_LEN / ds));
  const rampCount = Math.max(1, Math.round((span * ds) / 550));
  for (let r = 0; r < rampCount; r++) {
    const target = lo + Math.round(((r + 0.5) * span) / rampCount);
    let best = -1, bestC = Infinity;
    const search = Math.round(150 / ds);
    for (let i = Math.max(lo, target - search); i <= Math.min(hi - rampSamples, target + search); i += 2) {
      const c = straightness(i, Math.round(90 / ds));
      if (c < bestC && free(i, Math.round(80 / ds))) { bestC = c; best = i; }
    }
    if (best < 0 || bestC > 1 / 70) continue;
    for (let k = 0; k <= rampSamples; k++) t.heights[(best + k) % n] = RAMP_HEIGHT * (k / rampSamples);
    t.ramps.push({ start: best, peak: (best + rampSamples) % n });
    taken.push(best);
  }

  const padCount = Math.max(2, Math.round((span * ds) / 260));
  const lanes = [-4, 3.5, 0, 4, -3.5];
  for (let p = 0; p < padCount; p++) {
    const target = lo + Math.round(((p + 0.25) * span) / padCount);
    let best = -1, bestC = Infinity;
    const search = Math.round(70 / ds);
    for (let i = Math.max(lo, target - search); i <= Math.min(hi, target + search); i += 2) {
      const c = straightness(i, Math.round(30 / ds));
      if (c < bestC && free(i, Math.round(45 / ds))) { bestC = c; best = i; }
    }
    if (best < 0 || bestC > 1 / 45) continue;
    const lateral = Math.max(-(t.halfWidth - 3.5), Math.min(t.halfWidth - 3.5, lanes[p % lanes.length]));
    t.pads.push({ index: best % n, lateral, halfLen: 2.5, halfWidth: 3 });
    taken.push(best);
  }
}

// ------------------------------------------------------------------ queries

export function heightAt(track: Track, f: number) {
  const n = track.n;
  if (!track.closed && (f < 0 || f > n - 1)) return 0;
  const ff = track.closed ? ((f % n) + n) % n : f;
  const i = Math.floor(ff), u = ff - i;
  const i2 = track.closed ? (i + 1) % n : Math.min(n - 1, i + 1);
  return track.heights[i] + (track.heights[i2] - track.heights[i]) * u;
}

/** World point at fractional sample f with lateral offset (+ = right). Straight tracks extrapolate past the ends. */
export function pointAt(track: Track, f: number, lateral = 0) {
  const n = track.n;
  let i: number, u: number, extra = 0;
  if (track.closed) {
    const ff = ((f % n) + n) % n;
    i = Math.floor(ff);
    u = ff - i;
  } else if (f < 0) {
    i = 0; u = 0; extra = f * track.ds;
  } else if (f >= n - 1) {
    i = n - 1; u = 0; extra = (f - (n - 1)) * track.ds;
  } else {
    i = Math.floor(f);
    u = f - i;
  }
  const i2 = track.closed ? (i + 1) % n : Math.min(n - 1, i + 1);
  let tx = track.tx[i] + (track.tx[i2] - track.tx[i]) * u;
  let tz = track.tz[i] + (track.tz[i2] - track.tz[i]) * u;
  const l = Math.hypot(tx, tz) || 1;
  tx /= l;
  tz /= l;
  const cx = track.px[i] + (track.px[i2] - track.px[i]) * u + tx * extra;
  const cz = track.pz[i] + (track.pz[i2] - track.pz[i]) * u + tz * extra;
  return { x: cx - tz * lateral, z: cz + tx * lateral, yaw: Math.atan2(tx, tz), tx, tz };
}

/** Nearest-point query; local search around `hint`, global fallback. */
export function queryTrack(track: Track, x: number, z: number, hint = -1): TrackQuery {
  const n = track.n;
  const closed = track.closed;
  let best = 0;
  let bestD = Infinity;
  if (hint >= 0 && hint < n) {
    for (let k = -14; k <= 14; k++) {
      let i = hint + k;
      if (closed) i = (i + n) % n;
      else if (i < 0 || i >= n) continue;
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
  let f = best;
  let lateral = 0;
  let bestSeg = Infinity;
  const candidates = closed ? [(best - 1 + n) % n, best] : [best - 1, best].filter((a) => a >= 0 && a < n - 1);
  for (const a of candidates) {
    const b = closed ? (a + 1) % n : a + 1;
    const sx = track.px[b] - track.px[a], sz = track.pz[b] - track.pz[a];
    const len2 = sx * sx + sz * sz || 1;
    let u = ((x - track.px[a]) * sx + (z - track.pz[a]) * sz) / len2;
    // Straight tracks: allow projection past the very ends (for end walls / run-off).
    const lo = !closed && a === 0 ? -Infinity : 0;
    const hi = !closed && a === n - 2 ? Infinity : 1;
    u = Math.max(lo, Math.min(hi, u));
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
  if (closed) f = ((f % n) + n) % n;
  const index = closed ? Math.round(f) % n : Math.max(0, Math.min(n - 1, Math.round(f)));
  const within = closed || (f >= 0 && f <= n - 1);
  const onRoad = within && Math.abs(lateral) <= track.halfWidth;
  const height = onRoad ? heightAt(track, f) : 0;
  return { index, f, lateral, height, onRoad };
}

/** Forward distance (in samples) from a to b along the loop, in [0, n). */
export function forwardSamples(track: Track, a: number, b: number) {
  return (((b - a) % track.n) + track.n) % track.n;
}

export function trackName(spec: Partial<TrackSpec>) {
  const s = normalizeSpec(spec);
  const def = TRACK_DEFS.find((d) => d.id === s.trackId)!;
  return `${def.name} · ${s.distanceKm} km ${s.layout === 'loop' ? 'loop' : 'sprint'}`;
}
