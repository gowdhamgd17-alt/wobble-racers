// Builds the 3D battleground from the shared arena: grass, a street grid,
// houses with windows, doors and gable roofs, big flat-roofed buildings,
// trees, rocks, giant boulders and a stone boundary wall with hills beyond.
// Collision shapes come from the same data, so what you see is what you hit.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Arena, Obstacle } from '@wobble/shared';
import type { TrackView } from './trackMesh';

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const HOUSE_COLORS = ['#f4e3c1', '#f2c6a0', '#cfe3f0', '#f7d6d0', '#e5f0cf', '#fff3d6', '#d9d2f0', '#f0dcb2'];
const ROOF_COLORS = ['#b5442e', '#8c3b2a', '#5d6d7e', '#7a4b2a', '#3f5d7a', '#a0522d'];
const BIG_COLORS = ['#c9c4bb', '#b7c3cc', '#d8cfc0', '#bfb6aa', '#a9b8b0'];

/** Box with UVs measured in metres / tile so window textures don't stretch. */
function wallBox(w: number, h: number, d: number, tileW: number, tileH: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  // face order: px, nx, py, ny, pz, nz (4 verts each)
  const spans = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, uv.getX(i) * spans[f][0] / tileW, uv.getY(i) * spans[f][1] / tileH);
    }
  }
  return g;
}

function paintGeo(g: THREE.BufferGeometry, color: THREE.Color) {
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}

/** Gable roof: ridge runs along local x, slopes fall to ±z. */
function gableRoof(halfX: number, halfZ: number, rise: number) {
  const x0 = -halfX, x1 = halfX, z0 = -halfZ, z1 = halfZ;
  const p = [
    // slopes
    x0, 0, z1, x1, 0, z1, x1, rise, 0, x0, 0, z1, x1, rise, 0, x0, rise, 0,
    x1, 0, z0, x0, 0, z0, x0, rise, 0, x1, 0, z0, x0, rise, 0, x1, rise, 0,
    // gables
    x1, 0, z1, x1, 0, z0, x1, rise, 0,
    x0, 0, z0, x0, 0, z1, x0, rise, 0,
    // underside
    x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z0, x1, 0, z1, x0, 0, z1,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}

function place(g: THREE.BufferGeometry, x: number, y: number, z: number, yaw: number) {
  g.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z));
  return g;
}

export function buildArenaView(arena: Arena, quality: 'low' | 'medium' | 'high'): TrackView {
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(d: T) => { disposables.push(d); return d; };
  const half = arena.half;
  const R = rng(11);
  const tmp = new THREE.Color();

  // --- Ground: flat inside the wall, rolling hills outside
  const size = half * 2 + 700;
  const gs = quality === 'low' ? 60 : 110;
  const groundGeo = keep(new THREE.PlaneGeometry(size, size, gs, gs));
  groundGeo.rotateX(-Math.PI / 2);
  const gpos = groundGeo.getAttribute('position') as THREE.BufferAttribute;
  const gcol: number[] = [];
  const ga = new THREE.Color('#6cbf4a'), gb = new THREE.Color('#5aa83d'), gc = new THREE.Color('#8fcf5a');
  for (let i = 0; i < gpos.count; i++) {
    const x = gpos.getX(i), z = gpos.getZ(i);
    const out = Math.max(Math.abs(x), Math.abs(z)) - (half + 8);
    const h = out > 0 ? Math.min(40, out * 0.16) * (0.6 + 0.4 * Math.sin(x * 0.015) * Math.cos(z * 0.012)) : -0.02;
    gpos.setY(i, h);
    tmp.copy(ga).lerp(gb, R()).lerp(gc, Math.min(1, Math.max(0, h) / 30) * 0.7);
    gcol.push(tmp.r, tmp.g, tmp.b);
  }
  groundGeo.setAttribute('color', new THREE.Float32BufferAttribute(gcol, 3));
  groundGeo.computeVertexNormals();
  const ground = new THREE.Mesh(groundGeo, keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })));
  ground.receiveShadow = true;
  group.add(ground);

  // --- Streets: asphalt with edge lines and a dashed centre line
  const roadTex = keep(canvasTexture(128, 256, (ctx) => {
    ctx.fillStyle = '#4b4e5d';
    ctx.fillRect(0, 0, 128, 256);
    const rr = rng(5);
    for (let i = 0; i < 1600; i++) {
      const v = 60 + rr() * 50;
      ctx.fillStyle = `rgba(${v},${v},${v + 8},${0.25 + rr() * 0.3})`;
      ctx.fillRect(rr() * 128, rr() * 256, 1 + rr() * 2, 1 + rr() * 2);
    }
    ctx.fillStyle = '#f2f2f2';
    ctx.fillRect(5, 0, 4, 256);
    ctx.fillRect(119, 0, 4, 256);
    ctx.fillStyle = '#ffd23f';
    ctx.fillRect(61, 0, 6, 120);
  }));
  const roadMat = keep(new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.88, polygonOffset: true, polygonOffsetFactor: -1 }));
  const crossTex = keep(canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = '#4b4e5d';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (let i = 0; i < 6; i++) { ctx.fillRect(4 + i * 21, 2, 10, 14); ctx.fillRect(4 + i * 21, 112, 10, 14); ctx.fillRect(2, 4 + i * 21, 14, 10); ctx.fillRect(112, 4 + i * 21, 14, 10); }
  }));
  const crossMat = keep(new THREE.MeshStandardMaterial({ map: crossTex, roughness: 0.88, polygonOffset: true, polygonOffsetFactor: -2 }));
  const rw = arena.roadWidth;
  const lines = arena.roadLines;
  // Road segments between intersections (so dashes never cross), plus intersection squares.
  const stops = [-half, ...lines, half];
  const segGeos: THREE.BufferGeometry[] = [];
  for (const c of lines) {
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i] + (i === 0 ? 0 : rw / 2), b = stops[i + 1] - (i === stops.length - 2 ? 0 : rw / 2);
      const len = b - a;
      if (len <= 0) continue;
      for (const vertical of [true, false]) {
        const g = new THREE.PlaneGeometry(rw, len);
        g.rotateX(-Math.PI / 2);
        const uv = g.getAttribute('uv') as THREE.BufferAttribute;
        for (let k = 0; k < uv.count; k++) uv.setY(k, uv.getY(k) * len / 24);
        if (!vertical) g.rotateY(Math.PI / 2);
        g.translate(vertical ? c : (a + b) / 2, 0.02, vertical ? (a + b) / 2 : c);
        segGeos.push(g);
      }
    }
  }
  const roads = new THREE.Mesh(keep(mergeGeometries(segGeos)), roadMat);
  roads.receiveShadow = true;
  group.add(roads);
  segGeos.forEach((g) => g.dispose());
  const crossGeos: THREE.BufferGeometry[] = [];
  for (const cx of lines) for (const cz of lines) {
    const g = new THREE.PlaneGeometry(rw, rw);
    g.rotateX(-Math.PI / 2);
    g.translate(cx, 0.025, cz);
    crossGeos.push(g);
  }
  const cross = new THREE.Mesh(keep(mergeGeometries(crossGeos)), crossMat);
  cross.receiveShadow = true;
  group.add(cross);
  crossGeos.forEach((g) => g.dispose());
  // Kerbs / pavement edges (flat strips, purely visual)
  const kerbGeos: THREE.BufferGeometry[] = [];
  for (const c of lines) for (const s of [-1, 1]) for (const vertical of [true, false]) {
    const g = new THREE.PlaneGeometry(1.4, half * 2);
    g.rotateX(-Math.PI / 2);
    if (!vertical) g.rotateY(Math.PI / 2);
    g.translate(vertical ? c + s * (rw / 2 + 0.7) : 0, 0.015, vertical ? 0 : c + s * (rw / 2 + 0.7));
    kerbGeos.push(g);
  }
  const kerbs = new THREE.Mesh(keep(mergeGeometries(kerbGeos)), keep(new THREE.MeshStandardMaterial({ color: '#c9c6bd', roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1 })));
  kerbs.receiveShadow = true;
  group.add(kerbs);
  kerbGeos.forEach((g) => g.dispose());

  // --- Buildings (merged into a few draw calls)
  const winTex = keep(canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#e8e2d6';
    for (let y = 0; y < 128; y += 16) ctx.fillRect(0, y, 128, 1);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(30, 34, 68, 62);
    ctx.fillStyle = '#3d5a78';
    ctx.fillRect(36, 40, 56, 50);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(36, 40, 22, 50);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(62, 40, 4, 50);
    ctx.fillRect(36, 63, 56, 4);
    ctx.fillStyle = '#7a5236';
    ctx.fillRect(28, 96, 72, 6);
  }));
  const bigTex = keep(canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#24384d';
    ctx.fillRect(14, 22, 100, 70);
    ctx.fillStyle = 'rgba(160,210,255,0.35)';
    ctx.fillRect(14, 22, 40, 70);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(62, 22, 4, 70);
    ctx.fillStyle = '#d5d0c6';
    ctx.fillRect(0, 110, 128, 18);
  }));
  const wallGeos: THREE.BufferGeometry[] = [], roofGeos: THREE.BufferGeometry[] = [], doorGeos: THREE.BufferGeometry[] = [];
  const bigGeos: THREE.BufferGeometry[] = [], bigRoofGeos: THREE.BufferGeometry[] = [];
  const houses = arena.obstacles.filter((o) => o.kind === 'house' || o.kind === 'bighouse');
  for (const o of houses) {
    const w = o.hw * 2, d = o.hl * 2;
    if (o.kind === 'house') {
      const col = tmp.set(HOUSE_COLORS[Math.floor(o.v * HOUSE_COLORS.length)]).clone();
      wallGeos.push(paintGeo(place(wallBox(w, o.h, d, 3.2, o.h / Math.max(1, Math.round(o.h / 3))), o.x, o.h / 2, o.z, o.yaw), col));
      const roofCol = tmp.set(ROOF_COLORS[Math.floor(((o.v * 7.3) % 1) * ROOF_COLORS.length)]).clone();
      // ridge parallel to the street (local x)
      roofGeos.push(paintGeo(place(gableRoof(o.hw + 0.5, o.hl + 0.6, 2.2 + o.hl * 0.25), o.x, o.h, o.z, o.yaw), roofCol));
      // front door + step + chimney
      const fx = Math.sin(o.yaw), fz = Math.cos(o.yaw);
      doorGeos.push(paintGeo(place(new THREE.BoxGeometry(1.2, 2.2, 0.12), o.x + fx * (o.hl + 0.05), 1.1, o.z + fz * (o.hl + 0.05), o.yaw), tmp.set('#6b3f24').clone()));
      doorGeos.push(paintGeo(place(new THREE.BoxGeometry(1.8, 0.2, 0.6), o.x + fx * (o.hl + 0.3), 0.1, o.z + fz * (o.hl + 0.3), o.yaw), tmp.set('#b9b4aa').clone()));
      const rx = -fz, rz = fx;
      doorGeos.push(paintGeo(place(new THREE.BoxGeometry(0.7, 2.4, 0.7), o.x + rx * o.hw * 0.55 - fx * o.hl * 0.3, o.h + 1.4, o.z + rz * o.hw * 0.55 - fz * o.hl * 0.3, o.yaw), tmp.set('#8d4b3a').clone()));
    } else {
      const col = tmp.set(BIG_COLORS[Math.floor(o.v * BIG_COLORS.length)]).clone();
      bigGeos.push(paintGeo(place(wallBox(w, o.h, d, 4, 3.6), o.x, o.h / 2, o.z, o.yaw), col));
      const dark = tmp.set('#6e6a64').clone();
      bigRoofGeos.push(paintGeo(place(new THREE.BoxGeometry(w + 0.4, 0.5, d + 0.4), o.x, o.h + 0.25, o.z, o.yaw), dark));
      // parapet lip, rooftop AC units and a water tank
      bigRoofGeos.push(paintGeo(place(new THREE.BoxGeometry(w * 0.25, 1.2, d * 0.2), o.x, o.h + 1.1, o.z, o.yaw), tmp.set('#9aa0a6').clone()));
      const fx = Math.sin(o.yaw), fz = Math.cos(o.yaw);
      bigRoofGeos.push(paintGeo(place(new THREE.CylinderGeometry(1.4, 1.4, 2.2, 14), o.x - fx * o.hl * 0.5 - fz * o.hw * 0.5, o.h + 1.6, o.z - fz * o.hl * 0.5 + fx * o.hw * 0.5, 0), tmp.set('#8a6b4a').clone()));
      // entrance canopy
      bigRoofGeos.push(paintGeo(place(new THREE.BoxGeometry(5, 0.3, 2), o.x + fx * (o.hl + 1), 3.4, o.z + fz * (o.hl + 1), o.yaw), tmp.set('#c0392b').clone()));
      doorGeos.push(paintGeo(place(new THREE.BoxGeometry(3.2, 3, 0.15), o.x + fx * (o.hl + 0.05), 1.5, o.z + fz * (o.hl + 0.05), o.yaw), tmp.set('#2d3e50').clone()));
    }
  }
  const addMerged = (geos: THREE.BufferGeometry[], mat: THREE.Material, cast = true) => {
    if (!geos.length) return;
    const g = keep(mergeGeometries(geos.map((x) => x.index ? x.toNonIndexed() : x)));
    geos.forEach((x) => x.dispose());
    const m = new THREE.Mesh(g, keep(mat));
    m.castShadow = cast && quality !== 'low';
    m.receiveShadow = true;
    group.add(m);
  };
  addMerged(wallGeos, new THREE.MeshStandardMaterial({ vertexColors: true, map: winTex, roughness: 0.85 }));
  addMerged(roofGeos, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, flatShading: true, side: THREE.DoubleSide }));
  addMerged(doorGeos, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
  addMerged(bigGeos, new THREE.MeshStandardMaterial({ vertexColors: true, map: bigTex, roughness: 0.6, metalness: 0.1 }));
  addMerged(bigRoofGeos, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));

  // --- Trees (instanced): round leafy trees and pines, plus decorative ones outside the wall
  const trees: Obstacle[] = arena.obstacles.filter((o) => o.kind === 'tree');
  const deco: { x: number; z: number; h: number; v: number }[] = [];
  const decoN = quality === 'low' ? 120 : 320;
  for (let i = 0; i < decoN; i++) {
    const a = R() * Math.PI * 2, d = half + 25 + R() * 260;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (Math.max(Math.abs(x), Math.abs(z)) < half + 15) continue;
    deco.push({ x, z, h: 8 + R() * 8, v: R() });
  }
  const all = [...trees.map((t) => ({ x: t.x, z: t.z, h: t.h, v: t.v })), ...deco];
  const trunkGeo = keep(new THREE.CylinderGeometry(0.28, 0.42, 1, 8));
  trunkGeo.translate(0, 0.5, 0);
  const roundGeo = keep(new THREE.IcosahedronGeometry(1, quality === 'low' ? 0 : 1));
  const pineGeo = keep(new THREE.ConeGeometry(1, 1, 9));
  pineGeo.translate(0, 0.5, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, keep(new THREE.MeshStandardMaterial({ color: '#7d5136', roughness: 0.9 })), all.length);
  const rounds = new THREE.InstancedMesh(roundGeo, keep(new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true })), all.length);
  const pines = new THREE.InstancedMesh(pineGeo, keep(new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true })), all.length * 2);
  const dummy = new THREE.Object3D();
  let nr = 0, np = 0;
  const groundY = (x: number, z: number) => {
    const out = Math.max(Math.abs(x), Math.abs(z)) - (half + 8);
    return out > 0 ? Math.min(40, out * 0.16) * (0.6 + 0.4 * Math.sin(x * 0.015) * Math.cos(z * 0.012)) - 0.3 : 0;
  };
  all.forEach((t, i) => {
    const gy = groundY(t.x, t.z);
    const pine = t.v > 0.55;
    const trunkH = t.h * (pine ? 0.25 : 0.42);
    dummy.position.set(t.x, gy, t.z);
    dummy.rotation.set(0, t.v * 6, 0);
    dummy.scale.set(1, trunkH, 1);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    if (pine) {
      for (let k = 0; k < 2; k++) {
        const r = (2.4 - k * 0.7) * (t.h / 11);
        dummy.position.set(t.x, gy + trunkH + k * t.h * 0.28, t.z);
        dummy.scale.set(r, t.h * 0.5, r);
        dummy.updateMatrix();
        pines.setMatrixAt(np, dummy.matrix);
        pines.setColorAt(np++, tmp.setHSL(0.33 + t.v * 0.04, 0.45, 0.24 + k * 0.05));
      }
    } else {
      const r = t.h * 0.3;
      dummy.position.set(t.x, gy + trunkH + r * 0.7, t.z);
      dummy.scale.set(r, r * 0.9, r);
      dummy.updateMatrix();
      rounds.setMatrixAt(nr, dummy.matrix);
      rounds.setColorAt(nr++, tmp.setHSL(0.27 + t.v * 0.08, 0.55, 0.33 + t.v * 0.08));
    }
  });
  rounds.count = nr;
  pines.count = np;
  for (const m of [trunks, rounds, pines]) {
    m.castShadow = quality !== 'low';
    m.receiveShadow = true;
    group.add(m);
  }

  // --- Rocks and giant boulders (jagged, flat-shaded)
  const rockGeo = keep(new THREE.IcosahedronGeometry(1, 1));
  {
    const p = rockGeo.getAttribute('position') as THREE.BufferAttribute;
    const rr = rng(21);
    const seen = new Map<string, number>();
    for (let i = 0; i < p.count; i++) {
      const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
      let f = seen.get(k);
      if (f === undefined) { f = 0.82 + rr() * 0.3; seen.set(k, f); }
      p.setXYZ(i, p.getX(i) * f, p.getY(i) * f, p.getZ(i) * f);
    }
    rockGeo.computeVertexNormals();
  }
  const rockObs = arena.obstacles.filter((o) => o.kind === 'rock' || o.kind === 'bigrock');
  const rocks = new THREE.InstancedMesh(rockGeo, keep(new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true })), rockObs.length + 60);
  let rc = 0;
  for (const o of rockObs) {
    dummy.position.set(o.x, o.kind === 'bigrock' ? o.h * 0.35 : o.h * 0.3, o.z);
    dummy.rotation.set(o.v, o.yaw, o.v * 0.5);
    // visual radius slightly over the collision radius so cars stop at the surface
    dummy.scale.set(o.r * 1.05, o.kind === 'bigrock' ? o.h * 0.75 : o.h * 0.85, o.r * 1.05);
    dummy.updateMatrix();
    rocks.setMatrixAt(rc, dummy.matrix);
    rocks.setColorAt(rc++, tmp.setHSL(0.08 + o.v * 0.05, 0.08 + o.v * 0.08, o.kind === 'bigrock' ? 0.5 + o.v * 0.1 : 0.55 + o.v * 0.12));
  }
  // decorative boulders on the hills
  for (let i = 0; i < 60; i++) {
    const a = R() * Math.PI * 2, d = half + 20 + R() * 200;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (Math.max(Math.abs(x), Math.abs(z)) < half + 12) continue;
    const s = 3 + R() * 9;
    dummy.position.set(x, groundY(x, z) + s * 0.2, z);
    dummy.rotation.set(R(), R() * 6, R());
    dummy.scale.set(s, s * 0.7, s);
    dummy.updateMatrix();
    rocks.setMatrixAt(rc, dummy.matrix);
    rocks.setColorAt(rc++, tmp.setHSL(0.09, 0.1, 0.5 + R() * 0.12));
  }
  rocks.count = rc;
  rocks.castShadow = quality !== 'low';
  rocks.receiveShadow = true;
  group.add(rocks);

  // --- Boundary wall: stone blocks with a cap
  const stoneTex = keep(canvasTexture(256, 64, (ctx) => {
    ctx.fillStyle = '#8f8a80';
    ctx.fillRect(0, 0, 256, 64);
    const rr = rng(9);
    for (let row = 0; row < 4; row++) {
      for (let x = (row % 2) * -24; x < 256; x += 48) {
        const v = 120 + rr() * 50;
        ctx.fillStyle = `rgb(${v},${v - 6},${v - 14})`;
        ctx.fillRect(x + 2, row * 16 + 2, 44, 12);
      }
    }
  }));
  const wallH = arena.wallHeight;
  const wallGeo2: THREE.BufferGeometry[] = [];
  for (const [x, z, w, d] of [[0, half + 1, half * 2 + 4, 2], [0, -half - 1, half * 2 + 4, 2], [half + 1, 0, 2, half * 2], [-half - 1, 0, 2, half * 2]]) {
    const g = wallBox(w, wallH, d, 12, wallH);
    g.translate(x, wallH / 2, z);
    wallGeo2.push(g);
  }
  const walls = new THREE.Mesh(keep(mergeGeometries(wallGeo2)), keep(new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 0.95 })));
  wallGeo2.forEach((g) => g.dispose());
  walls.receiveShadow = true;
  walls.castShadow = quality !== 'low';
  group.add(walls);
  const capGeos: THREE.BufferGeometry[] = [];
  for (const [x, z, w, d] of [[0, half + 1, half * 2 + 5, 2.6], [0, -half - 1, half * 2 + 5, 2.6], [half + 1, 0, 2.6, half * 2], [-half - 1, 0, 2.6, half * 2]]) {
    const g = new THREE.BoxGeometry(w, 0.35, d);
    g.translate(x, wallH + 0.17, z);
    capGeos.push(g);
  }
  const caps = new THREE.Mesh(keep(mergeGeometries(capGeos)), keep(new THREE.MeshStandardMaterial({ color: '#d8d2c4', roughness: 0.8 })));
  capGeos.forEach((g) => g.dispose());
  group.add(caps);

  // --- Clouds
  const cloudGeo = keep(new THREE.IcosahedronGeometry(1, 1));
  const cloudN = quality === 'low' ? 12 : 26;
  const clouds = new THREE.InstancedMesh(cloudGeo, keep(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, flatShading: true, emissive: '#ffffff', emissiveIntensity: 0.35 })), cloudN * 3);
  let cn = 0;
  for (let i = 0; i < cloudN; i++) {
    const x = (R() - 0.5) * 1100, z = (R() - 0.5) * 1100, y = 110 + R() * 60, s = 12 + R() * 14;
    for (let k = 0; k < 3; k++) {
      dummy.position.set(x + (k - 1) * s * 0.9, y + (k === 1 ? s * 0.3 : 0), z + (R() - 0.5) * s);
      dummy.rotation.set(0, R() * 3, 0);
      dummy.scale.set(s * (k === 1 ? 1.2 : 0.85), s * 0.55, s * 0.8);
      dummy.updateMatrix();
      clouds.setMatrixAt(cn++, dummy.matrix);
    }
  }
  clouds.count = cn;
  group.add(clouds);

  return {
    group,
    padTextures: [],
    dispose() {
      disposables.forEach((d) => d.dispose());
      for (const m of [trunks, rounds, pines, rocks, clouds]) m.dispose();
    },
  };
}
