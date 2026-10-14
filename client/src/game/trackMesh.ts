// Builds the 3D course from the shared track: road ribbon with ramps, curbs,
// barriers, start/finish gates, grid, boost pads, arrows and scenery.
// Works for closed loops and open point-to-point sprints of any length.

import * as THREE from 'three';
import { PHYS, heightAt as trackHeightAt, pointAt, type Track } from '@wobble/shared';

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, repeat = false) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// Deterministic pseudo-random so every client sees the same scenery.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface TrackView {
  group: THREE.Group;
  padTextures: THREE.Texture[];
  dispose(): void;
}

/** Fast approximate distance from a point to the road centreline (spatial hash of samples). */
function makeRoadDistance(track: Track) {
  const CELL = 50;
  const map = new Map<string, number[]>();
  for (let i = 0; i < track.n; i++) {
    const k = `${Math.floor(track.px[i] / CELL)},${Math.floor(track.pz[i] / CELL)}`;
    let a = map.get(k);
    if (!a) map.set(k, (a = []));
    a.push(i);
  }
  return (x: number, z: number) => {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const a = map.get(`${cx + dx},${cz + dz}`);
      if (!a) continue;
      for (const i of a) best = Math.min(best, (track.px[i] - x) ** 2 + (track.pz[i] - z) ** 2);
    }
    return Math.sqrt(best);
  };
}

export function buildTrackView(track: Track, quality: 'low' | 'medium' | 'high'): TrackView {
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const n = track.n;
  const hw = track.halfWidth;
  const closed = track.closed;
  const segs = closed ? n : n - 1; // number of road segments
  const lastPt = closed ? n : n - 1; // last ribbon vertex index
  const heightAt = (i: number) => trackHeightAt(track, closed ? i : Math.max(0, Math.min(n - 1, i)));
  const roadDist = makeRoadDistance(track);

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, track.px[i]); maxX = Math.max(maxX, track.px[i]);
    minZ = Math.min(minZ, track.pz[i]); maxZ = Math.max(maxZ, track.pz[i]);
  }
  const margin = 380;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const sizeX = maxX - minX + margin * 2, sizeZ = maxZ - minZ + margin * 2;

  const hillHeight = (x: number, z: number) => {
    const far = Math.max(0, roadDist(x, z) - 70);
    return -0.05 + Math.min(22, far * 0.07) * (0.6 + 0.4 * Math.sin(x * 0.02) * Math.cos(z * 0.017));
  };

  // --- Ground
  const gsx = Math.min(140, Math.max(40, Math.round(sizeX / 30))), gsz = Math.min(140, Math.max(40, Math.round(sizeZ / 30)));
  const groundGeo = new THREE.PlaneGeometry(sizeX, sizeZ, gsx, gsz);
  groundGeo.rotateX(-Math.PI / 2);
  groundGeo.translate(cx, 0, cz);
  const gcol: number[] = [];
  const r = rng(7);
  const ga = new THREE.Color('#6cc04a'), gb = new THREE.Color('#58a83c'), gc = new THREE.Color('#8fcf5a'), tmp = new THREE.Color();
  const gpos = groundGeo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < gpos.count; i++) {
    const x = gpos.getX(i), z = gpos.getZ(i);
    const h = hillHeight(x, z);
    gpos.setY(i, h);
    tmp.copy(ga).lerp(gb, r()).lerp(gc, Math.min(1, h / 22) * 0.6);
    gcol.push(tmp.r, tmp.g, tmp.b);
  }
  groundGeo.setAttribute('color', new THREE.Float32BufferAttribute(gcol, 3));
  groundGeo.computeVertexNormals();
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  ground.receiveShadow = true;
  group.add(ground);
  disposables.push(groundGeo, ground.material as THREE.Material);

  // --- Road ribbon with asphalt texture
  const asphaltTex = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#4b4e5d';
    ctx.fillRect(0, 0, 256, 256);
    const rr = rng(3);
    for (let i = 0; i < 3500; i++) {
      const v = 60 + rr() * 50;
      ctx.fillStyle = `rgba(${v},${v},${v + 8},${0.25 + rr() * 0.3})`;
      ctx.fillRect(rr() * 256, rr() * 256, 1 + rr() * 2, 1 + rr() * 2);
    }
  }, true);
  const roadPos: number[] = [], roadCol: number[] = [], roadUv: number[] = [], roadIdx: number[] = [];
  const white = new THREE.Color('#ffffff'), rampA = new THREE.Color('#ffb703'), rampB = new THREE.Color('#e85d04');
  for (let i = 0; i <= lastPt; i++) {
    const L = pointAt(track, i, -hw), R = pointAt(track, i, hw);
    const y = heightAt(i) + 0.02;
    roadPos.push(L.x, y, L.z, R.x, y, R.z);
    const onRamp = heightAt(i) > 0 || heightAt(i - 1) > 0;
    const c = onRamp ? (i % 2 ? rampA : rampB) : white;
    roadCol.push(c.r, c.g, c.b, c.r, c.g, c.b);
    const v = (i * track.ds) / 12;
    roadUv.push(0, v, hw / 6, v);
    if (i < lastPt) {
      const a = i * 2;
      roadIdx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const roadGeo = new THREE.BufferGeometry();
  roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(roadPos, 3));
  roadGeo.setAttribute('color', new THREE.Float32BufferAttribute(roadCol, 3));
  roadGeo.setAttribute('uv', new THREE.Float32BufferAttribute(roadUv, 2));
  roadGeo.setIndex(roadIdx);
  roadGeo.computeVertexNormals();
  const road = new THREE.Mesh(roadGeo, new THREE.MeshStandardMaterial({ vertexColors: true, map: asphaltTex, roughness: 0.88, side: THREE.DoubleSide }));
  road.receiveShadow = true;
  group.add(road);
  disposables.push(roadGeo, road.material as THREE.Material, asphaltTex);

  // --- Ramp side walls and lip faces
  const rampPos: number[] = [];
  for (const rp of track.ramps) {
    for (let k = rp.start; k !== rp.peak; k = (k + 1) % n) {
      const k2 = (k + 1) % n;
      for (const side of [-1, 1]) {
        const a = pointAt(track, k, side * hw), b = pointAt(track, k2, side * hw);
        const ya = heightAt(k), yb = heightAt(k2);
        rampPos.push(a.x, 0, a.z, b.x, 0, b.z, b.x, yb, b.z, a.x, 0, a.z, b.x, yb, b.z, a.x, ya, a.z);
      }
    }
    const Lp = pointAt(track, rp.peak + 0.02, -hw), Rp = pointAt(track, rp.peak + 0.02, hw);
    const h = heightAt(rp.peak);
    rampPos.push(Lp.x, 0, Lp.z, Rp.x, 0, Rp.z, Rp.x, h, Rp.z, Lp.x, 0, Lp.z, Rp.x, h, Rp.z, Lp.x, h, Lp.z);
  }
  if (rampPos.length) {
    const rampGeo = new THREE.BufferGeometry();
    rampGeo.setAttribute('position', new THREE.Float32BufferAttribute(rampPos, 3));
    rampGeo.computeVertexNormals();
    const rampMesh = new THREE.Mesh(rampGeo, new THREE.MeshStandardMaterial({ color: '#d98c00', roughness: 0.6, side: THREE.DoubleSide }));
    group.add(rampMesh);
    disposables.push(rampGeo, rampMesh.material as THREE.Material);
  }

  // --- Curbs (red/white)
  const curbPos: number[] = [], curbCol: number[] = [];
  const red = new THREE.Color('#e63946'), cw = new THREE.Color('#f8f9fa');
  for (const side of [-1, 1]) {
    for (let i = 0; i <= lastPt; i++) {
      const a = pointAt(track, i, side * (hw - 0.9)), b = pointAt(track, i, side * (hw + 0.2));
      const y = heightAt(i) + 0.045;
      curbPos.push(a.x, y, a.z, b.x, y, b.z);
      const c = Math.floor(i / 2) % 2 ? red : cw;
      curbCol.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
  }
  const curbGeo = new THREE.BufferGeometry();
  curbGeo.setAttribute('position', new THREE.Float32BufferAttribute(curbPos, 3));
  curbGeo.setAttribute('color', new THREE.Float32BufferAttribute(curbCol, 3));
  const curbIdx: number[] = [];
  const perSide = (lastPt + 1) * 2;
  for (let sd = 0; sd < 2; sd++) for (let i = 0; i < lastPt; i++) {
    const a = sd * perSide + i * 2;
    curbIdx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  curbGeo.setIndex(curbIdx);
  curbGeo.computeVertexNormals();
  const curbs = new THREE.Mesh(curbGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide }));
  curbs.receiveShadow = true;
  group.add(curbs);
  disposables.push(curbGeo, curbs.material as THREE.Material);

  // --- Centre dashes + direction arrows
  const dashPos: number[] = [];
  const lo = closed ? 0 : track.startIdx, hi = closed ? n : track.finishIdx;
  for (let i = lo; i < hi; i += 4) {
    if (heightAt(i) > 0 || heightAt(i + 2) > 0) continue;
    const a = pointAt(track, i, -0.18), b = pointAt(track, i, 0.18), c = pointAt(track, i + 1.8, 0.18), d = pointAt(track, i + 1.8, -0.18);
    const y = 0.04;
    dashPos.push(a.x, y, a.z, c.x, y, c.z, b.x, y, b.z, a.x, y, a.z, d.x, y, d.z, c.x, y, c.z);
  }
  for (let i = lo + 25; i < hi; i += 40) {
    if (heightAt(i) > 0 || heightAt(i + 3) > 0) continue;
    for (const lat of [-hw * 0.55, hw * 0.55]) {
      const tip = pointAt(track, i + 1.6, lat), l = pointAt(track, i, lat - 1.6), rr = pointAt(track, i, lat + 1.6), m = pointAt(track, i + 0.7, lat);
      const y = 0.045;
      dashPos.push(l.x, y, l.z, tip.x, y, tip.z, m.x, y, m.z, m.x, y, m.z, tip.x, y, tip.z, rr.x, y, rr.z);
    }
  }
  const dashGeo = new THREE.BufferGeometry();
  dashGeo.setAttribute('position', new THREE.Float32BufferAttribute(dashPos, 3));
  dashGeo.computeVertexNormals();
  const dashes = new THREE.Mesh(dashGeo, new THREE.MeshBasicMaterial({ color: '#f1f1e6', side: THREE.DoubleSide, transparent: true, opacity: 0.85 }));
  group.add(dashes);
  disposables.push(dashGeo, dashes.material as THREE.Material);

  // --- Barriers: continuous walls with a rounded top rail
  const bPos: number[] = [], bCol: number[] = [];
  const bLat = hw + PHYS.barrierInset;
  const bh = PHYS.barrierHeight, bt = 0.5;
  const ba = new THREE.Color('#e63946'), bb = new THREE.Color('#f4f1de');
  const quad = (a: { x: number; z: number }, b: { x: number; z: number }, y0: number, y1: number, c: THREE.Color, b2?: { x: number; z: number }, a2?: { x: number; z: number }) => {
    const A2 = a2 ?? a, B2 = b2 ?? b;
    bPos.push(a.x, y0, a.z, b.x, y0, b.z, B2.x, y1, B2.z, a.x, y0, a.z, B2.x, y1, B2.z, A2.x, y1, A2.z);
    for (let k = 0; k < 6; k++) bCol.push(c.r, c.g, c.b);
  };
  for (const side of [-1, 1]) {
    for (let i = 0; i < segs; i++) {
      const c = Math.floor(i / 3) % 2 ? ba : bb;
      const i0 = pointAt(track, i, side * bLat), i1 = pointAt(track, i + 1, side * bLat);
      const o0 = pointAt(track, i, side * (bLat + bt)), o1 = pointAt(track, i + 1, side * (bLat + bt));
      const m0 = pointAt(track, i, side * (bLat + bt / 2)), m1 = pointAt(track, i + 1, side * (bLat + bt / 2));
      quad(i0, i1, 0, bh, c);
      quad(o0, o1, 0, bh, c);
      quad(i0, i1, bh, bh + 0.12, c, m1, m0);
      quad(o0, o1, bh, bh + 0.12, c, m1, m0);
    }
  }
  if (!closed) {
    // End walls across both ends of a sprint track
    for (const f of [0, n - 1]) {
      for (let k = 0; k < 8; k++) {
        const la = -bLat - bt + ((bLat + bt) * 2 * k) / 8, lb = -bLat - bt + ((bLat + bt) * 2 * (k + 1)) / 8;
        const a = pointAt(track, f, la), b = pointAt(track, f, lb);
        quad(a, b, 0, bh + 0.6, k % 2 ? ba : bb);
      }
    }
  }
  const bGeo = new THREE.BufferGeometry();
  bGeo.setAttribute('position', new THREE.Float32BufferAttribute(bPos, 3));
  bGeo.setAttribute('color', new THREE.Float32BufferAttribute(bCol, 3));
  bGeo.computeVertexNormals();
  const barriers = new THREE.Mesh(bGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, side: THREE.DoubleSide }));
  barriers.castShadow = quality !== 'low';
  barriers.receiveShadow = true;
  group.add(barriers);
  disposables.push(bGeo, barriers.material as THREE.Material);

  // --- Start / finish lines and gates
  const checker = canvasTexture(256, 64, (ctx) => {
    for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#111' : '#fafafa';
      ctx.fillRect(x * 32, y * 32, 32, 32);
    }
  });
  checker.wrapS = THREE.RepeatWrapping;
  checker.repeat.set(hw / 4, 1);
  disposables.push(checker);
  const pillarMat = new THREE.MeshStandardMaterial({ color: '#ff5a4e', roughness: 0.45, metalness: 0.2 });
  disposables.push(pillarMat);
  const line = (f: number, mat: THREE.Material) => {
    const p = pointAt(track, f, 0);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2, 2.4), mat);
    m.rotation.order = 'YXZ';
    m.rotation.set(-Math.PI / 2, p.yaw, 0);
    m.position.set(p.x, 0.05, p.z);
    group.add(m);
    disposables.push(m.geometry);
  };
  const gate = (f: number, label: string, bannerColor: string) => {
    const tex = canvasTexture(512, 96, (ctx) => {
      ctx.fillStyle = bannerColor;
      ctx.fillRect(0, 0, 512, 96);
      ctx.fillStyle = '#ffd23f';
      ctx.font = '64px "Lilita One", Impact, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 256, 52);
    });
    const p = pointAt(track, f, 0);
    const arch = new THREE.Group();
    for (const s of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 7.6, 24), pillarMat);
      pillar.position.set(s * (hw + 2.4), 3.8, 0);
      pillar.castShadow = true;
      arch.add(pillar);
      disposables.push(pillar.geometry);
    }
    const bannerMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 });
    const banner = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 5.8, 1.8, 0.5), [pillarMat, pillarMat, pillarMat, pillarMat, bannerMat, bannerMat]);
    banner.position.y = 7.4;
    arch.add(banner);
    arch.position.set(p.x, 0, p.z);
    arch.rotation.y = p.yaw;
    group.add(arch);
    disposables.push(banner.geometry, bannerMat, tex);
  };
  const checkerMat = new THREE.MeshBasicMaterial({ map: checker });
  disposables.push(checkerMat);
  if (closed) {
    line(0, checkerMat);
    gate(0, 'WOBBLE RACERS', '#1d1f3f');
  } else {
    const startMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    disposables.push(startMat);
    line(track.startIdx, startMat);
    gate(track.startIdx, 'START', '#1d1f3f');
    line(track.finishIdx, checkerMat);
    gate(track.finishIdx, 'FINISH', '#c73a30');
    // Distance boards every kilometre
    for (let km = 1; km * 1000 < track.raceLength - 50; km++) {
      const f = track.startIdx + (km * 1000) / track.ds;
      const p = pointAt(track, f, -(hw + 4.5));
      const tex = canvasTexture(128, 64, (ctx) => {
        ctx.fillStyle = '#1d1f3f';
        ctx.fillRect(0, 0, 128, 64);
        ctx.fillStyle = '#ffd23f';
        ctx.font = '900 40px Nunito, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${km} km`, 64, 34);
      });
      const board = new THREE.Mesh(new THREE.PlaneGeometry(3, 1.5), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
      board.position.set(p.x, 2.6, p.z);
      board.rotation.y = p.yaw + Math.PI;
      group.add(board);
      disposables.push(board.geometry, board.material as THREE.Material, tex);
    }
  }

  // --- Grid slots
  const gridMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.7 });
  const slotGeo = new THREE.PlaneGeometry(2.8, 0.25);
  slotGeo.rotateX(-Math.PI / 2);
  for (const g of track.grid) {
    const m = new THREE.Mesh(slotGeo, gridMat);
    m.position.set(g.x + Math.sin(g.yaw) * 2.9, 0.045, g.z + Math.cos(g.yaw) * 2.9);
    m.rotation.y = g.yaw;
    group.add(m);
  }
  disposables.push(slotGeo, gridMat);

  // --- Boost pads (animated chevrons)
  const padTex = canvasTexture(64, 128, (ctx) => {
    ctx.fillStyle = '#0b8fd6';
    ctx.fillRect(0, 0, 64, 128);
    ctx.strokeStyle = '#a8f3ff';
    ctx.lineWidth = 10;
    for (let y = -16; y < 160; y += 42) {
      ctx.beginPath();
      ctx.moveTo(6, y + 26);
      ctx.lineTo(32, y);
      ctx.lineTo(58, y + 26);
      ctx.stroke();
    }
  }, true);
  const padMat = new THREE.MeshBasicMaterial({ map: padTex, transparent: true, opacity: 0.95 });
  for (const p of track.pads) {
    const c = pointAt(track, p.index, p.lateral);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(p.halfWidth * 2, p.halfLen * 2 * track.ds), padMat);
    m.rotation.order = 'YXZ';
    m.rotation.set(-Math.PI / 2, c.yaw, 0);
    m.position.set(c.x, 0.06, c.z);
    group.add(m);
    disposables.push(m.geometry);
  }
  disposables.push(padMat, padTex);

  // --- Scenery along the course: trees, rocks, clouds (instanced)
  const rand = rng(1234 + track.key.length * 31);
  const qf = quality === 'low' ? 0.4 : quality === 'medium' ? 0.7 : 1;
  const treeCount = Math.round(Math.min(1600, Math.max(220, track.length / 2.6)) * qf);
  const trunkGeo = new THREE.CylinderGeometry(0.3, 0.45, 2.2, quality === 'low' ? 6 : 12);
  trunkGeo.translate(0, 1.1, 0);
  const leafGeo = new THREE.ConeGeometry(2.2, 5.2, quality === 'low' ? 7 : 14, 2);
  leafGeo.translate(0, 4.6, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: '#8d5a3b', roughness: 0.9 }), treeCount);
  const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshStandardMaterial({ roughness: 0.8 }), treeCount);
  const dummy = new THREE.Object3D();
  const leafColors = ['#2d8a4e', '#3fa65c', '#1f7a45', '#56b870'].map((c) => new THREE.Color(c));
  let placed = 0, guard = 0;
  while (placed < treeCount && guard++ < treeCount * 8) {
    const i = Math.floor(rand() * n);
    const side = rand() < 0.5 ? -1 : 1;
    const off = hw + 12 + Math.pow(rand(), 1.6) * 230;
    const p = pointAt(track, i, side * off);
    if (roadDist(p.x, p.z) < hw + 9) continue;
    const s = 0.7 + rand() * 0.9;
    dummy.position.set(p.x, hillHeight(p.x, p.z) - 0.3, p.z);
    dummy.rotation.set(0, rand() * Math.PI, 0);
    dummy.scale.set(s, s * (0.8 + rand() * 0.5), s);
    dummy.updateMatrix();
    trunks.setMatrixAt(placed, dummy.matrix);
    leaves.setMatrixAt(placed, dummy.matrix);
    leaves.setColorAt(placed, leafColors[Math.floor(rand() * leafColors.length)]);
    placed++;
  }
  trunks.count = leaves.count = placed;
  leaves.castShadow = quality === 'high';
  group.add(trunks, leaves);
  disposables.push(trunkGeo, leafGeo, trunks.material as THREE.Material, leaves.material as THREE.Material);

  const rockGeo = new THREE.DodecahedronGeometry(1.2, 1);
  const rockN = Math.round(Math.min(200, track.length / 20) * qf);
  const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshStandardMaterial({ color: '#9a9aa6', roughness: 0.95, flatShading: true }), rockN);
  let rc = 0;
  for (let k = 0; k < rockN * 4 && rc < rockN; k++) {
    const i = Math.floor(rand() * n);
    const p = pointAt(track, i, (rand() < 0.5 ? -1 : 1) * (hw + 6 + rand() * 120));
    if (roadDist(p.x, p.z) < hw + 6) continue;
    const s = 0.5 + rand() * 1.4;
    dummy.position.set(p.x, hillHeight(p.x, p.z) + 0.2, p.z);
    dummy.rotation.set(rand(), rand(), rand());
    dummy.scale.set(s, s * 0.7, s);
    dummy.updateMatrix();
    rocks.setMatrixAt(rc++, dummy.matrix);
  }
  rocks.count = rc;
  group.add(rocks);
  disposables.push(rockGeo, rocks.material as THREE.Material);

  const cloudGeo = new THREE.IcosahedronGeometry(8, 2);
  const cloudMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, emissive: '#ffffff', emissiveIntensity: 0.35 });
  const cloudN = Math.min(90, Math.max(36, Math.round(track.length / 60)));
  const clouds = new THREE.InstancedMesh(cloudGeo, cloudMat, cloudN);
  let cc = 0;
  while (cc + 3 <= cloudN) {
    const ccx = cx + (rand() - 0.5) * sizeX, ccz = cz + (rand() - 0.5) * sizeZ, cy = 75 + rand() * 45;
    for (let j = 0; j < 3; j++) {
      dummy.position.set(ccx + j * 9 - 9, cy + rand() * 3, ccz + rand() * 6);
      dummy.rotation.set(rand(), rand(), rand());
      const s = 0.8 + rand() * 0.6;
      dummy.scale.set(s * 1.4, s * 0.7, s);
      dummy.updateMatrix();
      clouds.setMatrixAt(cc++, dummy.matrix);
    }
  }
  clouds.count = cc;
  group.add(clouds);
  disposables.push(cloudGeo, cloudMat);

  return {
    group,
    padTextures: [padTex],
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
