// Battleground arena: a walled town with a grid of roads, houses, big houses,
// trees, rocks and giant boulders. Generated deterministically from a seed so
// the server and every client build exactly the same map. The whole surface
// is drivable (roads are a little faster than grass); obstacles are solid.

export type ObstacleKind = 'house' | 'bighouse' | 'tree' | 'rock' | 'bigrock';

export interface Obstacle {
  kind: ObstacleKind;
  shape: 'box' | 'circle';
  x: number;
  z: number;
  yaw: number;
  hl: number; // box: half extent along yaw (forward)
  hw: number; // box: half extent sideways
  r: number; // circle radius (collision)
  h: number; // height; cars / shots above it pass over
  br: number; // bounding radius for quick rejects
  v: number; // 0..1 variant for visuals
}

export interface RoadRect { x0: number; z0: number; x1: number; z1: number }
export interface Spot { x: number; z: number; yaw: number }

export interface ArenaDef { id: string; name: string; description: string; seed: number; half: number }

export const ARENA_DEFS: ArenaDef[] = [
  { id: 'town', name: 'Battle Town', description: 'Grid of streets, houses and parks walled in by boulders.', seed: 7, half: 250 },
];
export const ARENA_IDS = ARENA_DEFS.map((a) => a.id);

export interface Arena {
  kind: 'arena';
  key: string;
  def: ArenaDef;
  half: number; // inner face of the boundary wall
  roadWidth: number;
  roadLines: number[]; // road centre coordinates (same on both axes)
  roads: RoadRect[];
  obstacles: Obstacle[];
  spawns: Spot[];
  repairSpots: { x: number; z: number }[];
  crateSpots: { x: number; z: number }[];
  wallHeight: number;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cache = new Map<string, Arena>();

export function getArena(id = 'town'): Arena {
  const def = ARENA_DEFS.find((d) => d.id === id) ?? ARENA_DEFS[0];
  let a = cache.get(def.id);
  if (!a) {
    a = buildArena(def);
    cache.set(def.id, a);
  }
  return a;
}

export function buildArena(def: ArenaDef): Arena {
  const R = rng(def.seed);
  const half = def.half;
  const roadWidth = 14;
  const rw = roadWidth / 2;
  const roadLines = [-180, -60, 60, 180];
  const roads: RoadRect[] = [];
  for (const c of roadLines) {
    roads.push({ x0: c - rw, z0: -half, x1: c + rw, z1: half });
    roads.push({ x0: -half, z0: c - rw, x1: half, z1: c + rw });
  }
  const obstacles: Obstacle[] = [];
  const spawns: Spot[] = [];
  const along = [-215, -120, 0, 120, 215];
  for (const c of roadLines) {
    for (const m of along) {
      const dir = m < 0 || (m === 0 && c < 0) ? 0 : Math.PI;
      spawns.push({ x: c + 3.5 * (dir === 0 ? -1 : 1), z: m, yaw: dir }); // vertical road
      const hdir = m < 0 || (m === 0 && c < 0) ? Math.PI / 2 : -Math.PI / 2;
      spawns.push({ x: m, z: c + 3.5 * (hdir > 0 ? 1 : -1), yaw: hdir }); // horizontal road
    }
  }
  const repairSpots: { x: number; z: number }[] = [];
  const crateSpots: { x: number; z: number }[] = [];
  roadLines.forEach((cx, i) => roadLines.forEach((cz, j) => { if ((i + j) % 2 === 0) repairSpots.push({ x: cx, z: cz }); }));
  for (const [x, z] of [[-22, -22], [22, 22], [-22, 22], [22, -22]]) crateSpots.push({ x, z });
  for (const [x, z] of [[-120, -60], [120, 60], [-60, 120], [60, -120], [-180, 0], [180, 0]]) crateSpots.push({ x, z });

  const onRoad = (x: number, z: number, pad: number) => roads.some((r) => x > r.x0 - pad && x < r.x1 + pad && z > r.z0 - pad && z < r.z1 + pad);
  const clearOf = (x: number, z: number, br: number, gap: number) => {
    if (Math.abs(x) + br > half - 3 || Math.abs(z) + br > half - 3) return false;
    for (const o of obstacles) if ((o.x - x) ** 2 + (o.z - z) ** 2 < (o.br + br + gap) ** 2) return false;
    for (const s of [...spawns, ...repairSpots, ...crateSpots]) if ((s.x - x) ** 2 + (s.z - z) ** 2 < (br + 9) ** 2) return false;
    return true;
  };
  const addBox = (kind: ObstacleKind, x: number, z: number, yaw: number, hl: number, hw: number, h: number, gap = 7) => {
    const br = Math.hypot(hl, hw);
    if (onRoad(x, z, Math.max(hl, hw) * 0.75 + 2) || !clearOf(x, z, br, gap)) return false;
    obstacles.push({ kind, shape: 'box', x, z, yaw, hl, hw, r: 0, h, br, v: R() });
    return true;
  };
  const addCircle = (kind: ObstacleKind, x: number, z: number, r: number, h: number, gap = 6) => {
    if (onRoad(x, z, r + 2) || !clearOf(x, z, r, gap)) return false;
    obstacles.push({ kind, shape: 'circle', x, z, yaw: R() * Math.PI * 2, hl: 0, hw: 0, r, h, br: r, v: R() });
    return true;
  };

  // Blocks between roads (and the outer band between the last road and the wall).
  const edges = [-half, ...roadLines, half];
  for (let i = 0; i < edges.length - 1; i++) {
    for (let j = 0; j < edges.length - 1; j++) {
      const outer = i === 0 || j === 0 || i === edges.length - 2 || j === edges.length - 2;
      const x0 = edges[i] + (i === 0 ? 0 : rw + 3), x1 = edges[i + 1] - (i === edges.length - 2 ? 0 : rw + 3);
      const z0 = edges[j] + (j === 0 ? 0 : rw + 3), z1 = edges[j + 1] - (j === edges.length - 2 ? 0 : rw + 3);
      const plaza = i === 2 && j === 2;
      const rand = (a: number, b: number) => a + (b - a) * R();
      if (plaza) {
        addCircle('bigrock', 0, 0, 7, 9, 10);
        for (let k = 0; k < 6; k++) addCircle('tree', rand(x0 + 6, x1 - 6), rand(z0 + 6, z1 - 6), 1.1, 9, 14);
        continue;
      }
      if (outer) {
        // Wild band: giant boulders, rocks and woods.
        const area = (x1 - x0) * (z1 - z0);
        const n = Math.round(area / 900);
        for (let k = 0; k < n; k++) {
          const t = R();
          const x = rand(x0 + 4, x1 - 4), z = rand(z0 + 4, z1 - 4);
          if (t < 0.18) addCircle('bigrock', x, z, rand(6, 10), rand(7, 12), 9);
          else if (t < 0.38) addCircle('rock', x, z, rand(1.6, 3.2), rand(1.4, 2.6), 6);
          else addCircle('tree', x, z, rand(0.9, 1.4), rand(8, 13), 5);
        }
        continue;
      }
      // Town block: houses facing the streets, a big house in the middle, a small park.
      const W = x1 - x0, D = z1 - z0;
      const sides: [number, number, number, number, number][] = [
        // [startX, startZ, dirX, dirZ, yaw of house front]
        [x0, z0, 1, 0, Math.PI], [x0, z1, 1, 0, 0], [x0, z0, 0, 1, -Math.PI / 2], [x1, z0, 0, 1, Math.PI / 2],
      ];
      for (const [sx, sz, dx, dz, yaw] of sides) {
        const len = dx ? W : D;
        let t = 9;
        while (t < len - 9) {
          const hw = rand(4.5, 7), hl = rand(4, 5.5);
          const inward = 5 + hl;
          const nx = dz ? (sx === x0 ? 1 : -1) * inward : 0;
          const nz = dx ? (sz === z0 ? 1 : -1) * inward : 0;
          if (R() < 0.72) addBox('house', sx + dx * (t + hw) + nx, sz + dz * (t + hw) + nz, yaw, hl, hw, rand(5, 7.5), 6);
          t += hw * 2 + rand(9, 16);
        }
      }
      if (R() < 0.75) addBox('bighouse', (x0 + x1) / 2 + rand(-6, 6), (z0 + z1) / 2 + rand(-6, 6), R() < 0.5 ? 0 : Math.PI / 2, rand(9, 12), rand(11, 15), rand(11, 16), 8);
      for (let k = 0; k < 9; k++) addCircle('tree', rand(x0 + 4, x1 - 4), rand(z0 + 4, z1 - 4), rand(0.9, 1.3), rand(7, 11), 6);
      for (let k = 0; k < 3; k++) addCircle('rock', rand(x0 + 4, x1 - 4), rand(z0 + 4, z1 - 4), rand(1.5, 2.8), rand(1.2, 2.4), 7);
      if (R() < 0.35) addCircle('bigrock', rand(x0 + 12, x1 - 12), rand(z0 + 12, z1 - 12), rand(5, 8), rand(6, 9), 9);
    }
  }
  return {
    kind: 'arena', key: `arena|${def.id}`, def, half, roadWidth, roadLines, roads, obstacles, spawns, repairSpots, crateSpots, wallHeight: 3,
  };
}

export function arenaOnRoad(a: Arena, x: number, z: number) {
  for (const r of a.roads) if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) return true;
  return false;
}

/**
 * First blocking hit along segment (x0,z0)->(x1,z1) at height y against
 * obstacles and the boundary wall. Returns the hit fraction in [0,1] or 1.
 */
export function arenaRay(a: Arena, x0: number, z0: number, x1: number, z1: number, y: number, radius = 0): number {
  let best = 1;
  const dx = x1 - x0, dz = z1 - z0;
  // Boundary wall
  if (y < a.wallHeight + 0.5) {
    for (const [p, d] of [[x0, dx], [z0, dz]] as const) {
      if (d > 0 && p + d > a.half) best = Math.min(best, (a.half - p) / d);
      if (d < 0 && p + d < -a.half) best = Math.min(best, (-a.half - p) / d);
    }
  }
  const len = Math.hypot(dx, dz) || 1;
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  for (const o of a.obstacles) {
    if (y > o.h + 0.3) continue;
    if ((o.x - mx) ** 2 + (o.z - mz) ** 2 > (len / 2 + o.br + radius) ** 2) continue;
    const t = o.shape === 'circle' ? segCircle(x0, z0, dx, dz, o.x, o.z, o.r + radius) : segBox(x0, z0, dx, dz, o.x, o.z, o.yaw, o.hl + radius, o.hw + radius);
    if (t >= 0 && t < best) best = t;
  }
  return Math.max(0, best);
}

function segCircle(x0: number, z0: number, dx: number, dz: number, cx: number, cz: number, r: number) {
  const fx = x0 - cx, fz = z0 - cz;
  const a = dx * dx + dz * dz;
  const b = 2 * (fx * dx + fz * dz);
  const c = fx * fx + fz * fz - r * r;
  if (c <= 0) return 0;
  const disc = b * b - 4 * a * c;
  if (disc < 0 || a === 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : -1;
}

function segBox(x0: number, z0: number, dx: number, dz: number, cx: number, cz: number, yaw: number, hl: number, hw: number) {
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const ax = (x0 - cx) * -fz + (z0 - cz) * fx, ay = (x0 - cx) * fx + (z0 - cz) * fz;
  const ddx = dx * -fz + dz * fx, ddy = dx * fx + dz * fz;
  let t0 = 0, t1 = 1;
  for (const [p, d, e] of [[ax, ddx, hw], [ay, ddy, hl]] as const) {
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

/** True when a car-sized circle at (x,z) is clear of every obstacle and the wall. */
export function arenaSpotClear(a: Arena, x: number, z: number, r: number) {
  if (Math.abs(x) + r > a.half || Math.abs(z) + r > a.half) return false;
  for (const o of a.obstacles) {
    const d2 = (o.x - x) ** 2 + (o.z - z) ** 2;
    if (d2 < (o.br + r) ** 2) {
      if (o.shape === 'circle') return false;
      const fx = Math.sin(o.yaw), fz = Math.cos(o.yaw);
      const lx = (x - o.x) * -fz + (z - o.z) * fx, ly = (x - o.x) * fx + (z - o.z) * fz;
      if (Math.abs(lx) < o.hw + r && Math.abs(ly) < o.hl + r) return false;
    }
  }
  return true;
}
