// Builds the 3D circuit from the shared track definition: road ribbon with
// ramps, curbs, barriers, finish arch, grid, boost pads, arrows and scenery.

import * as THREE from 'three';
import { PHYS, pointAt, queryTrack, type Track } from '@wobble/shared';

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, repeat = false) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
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

export function buildTrackView(track: Track, quality: 'low' | 'medium' | 'high'): TrackView {
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const n = track.n;
  const hw = track.halfWidth;
  const track_ = track;

  // Gentle hills far from the track (visual only; cars never get that far)
  const hillHeight = (x: number, z: number) => {
    const far = Math.max(0, Math.abs(queryTrack(track, x, z).lateral) - 60);
    return -0.05 + Math.min(18, far * 0.06) * (0.6 + 0.4 * Math.sin(x * 0.02) * Math.cos(z * 0.017));
  };
  const heightAt = (i: number) => track_.heights[((i % n) + n) % n];

  // --- Ground
  const groundGeo = new THREE.PlaneGeometry(1400, 1400, 40, 40);
  groundGeo.rotateX(-Math.PI / 2);
  const gcol: number[] = [];
  const r = rng(7);
  const ga = new THREE.Color('#6cc04a'), gb = new THREE.Color('#5aae3e'), tmp = new THREE.Color();
  const gpos = groundGeo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < gpos.count; i++) {
    tmp.copy(ga).lerp(gb, r());
    gcol.push(tmp.r, tmp.g, tmp.b);
    const x = gpos.getX(i), z = gpos.getZ(i);
    gpos.setY(i, hillHeight(x, z));
  }
  groundGeo.setAttribute('color', new THREE.Float32BufferAttribute(gcol, 3));
  groundGeo.computeVertexNormals();
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  ground.receiveShadow = true;
  group.add(ground);
  disposables.push(groundGeo, ground.material as THREE.Material);

  // --- Road ribbon (+ ramp colouring)
  const roadPos: number[] = [], roadCol: number[] = [], roadIdx: number[] = [];
  const asphalt = new THREE.Color('#4a4d5c'), asphalt2 = new THREE.Color('#454857'), rampA = new THREE.Color('#ffb703'), rampB = new THREE.Color('#2b2d42');
  for (let i = 0; i <= n; i++) {
    const L = pointAt(track, i, -hw), R = pointAt(track, i, hw);
    const y = heightAt(i) + 0.02;
    roadPos.push(L.x, y, L.z, R.x, y, R.z);
    const onRamp = heightAt(i) > 0 || heightAt(i - 1) > 0;
    const c = onRamp ? (Math.floor(i / 1) % 2 ? rampA : rampB) : Math.floor(i / 6) % 2 ? asphalt : asphalt2;
    roadCol.push(c.r, c.g, c.b, c.r, c.g, c.b);
    if (i < n) {
      const a = i * 2;
      roadIdx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const roadGeo = new THREE.BufferGeometry();
  roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(roadPos, 3));
  roadGeo.setAttribute('color', new THREE.Float32BufferAttribute(roadCol, 3));
  roadGeo.setIndex(roadIdx);
  roadGeo.computeVertexNormals();
  const road = new THREE.Mesh(roadGeo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  road.receiveShadow = true;
  group.add(road);
  disposables.push(roadGeo, road.material as THREE.Material);

  // --- Ramp side walls and lip faces
  const rampPos: number[] = [];
  for (const rp of track.ramps) {
    for (let k = rp.start; k !== (rp.peak + 1) % n; k = (k + 1) % n) {
      const k2 = (k + 1) % n;
      for (const side of [-1, 1]) {
        const a = pointAt(track, k, side * hw), b = pointAt(track, k2, side * hw);
        const ya = heightAt(k), yb = heightAt(k2);
        rampPos.push(a.x, 0, a.z, b.x, 0, b.z, b.x, yb, b.z, a.x, 0, a.z, b.x, yb, b.z, a.x, ya, a.z);
      }
    }
    // Lip: vertical face at the peak
    const L = pointAt(track, rp.peak + 0.02, -hw), R = pointAt(track, rp.peak + 0.02, hw);
    const h = heightAt(rp.peak);
    rampPos.push(L.x, 0, L.z, R.x, 0, R.z, R.x, h, R.z, L.x, 0, L.z, R.x, h, R.z, L.x, h, L.z);
  }
  const rampGeo = new THREE.BufferGeometry();
  rampGeo.setAttribute('position', new THREE.Float32BufferAttribute(rampPos, 3));
  rampGeo.computeVertexNormals();
  const rampMesh = new THREE.Mesh(rampGeo, new THREE.MeshLambertMaterial({ color: '#d98c00', side: THREE.DoubleSide, flatShading: true }));
  group.add(rampMesh);
  disposables.push(rampGeo, rampMesh.material as THREE.Material);

  // --- Curbs (red/white)
  const curbPos: number[] = [], curbCol: number[] = [];
  const red = new THREE.Color('#e63946'), white = new THREE.Color('#f8f9fa');
  for (const side of [-1, 1]) {
    for (let i = 0; i <= n; i++) {
      const a = pointAt(track, i, side * (hw - 0.9)), b = pointAt(track, i, side * (hw + 0.2));
      const y = heightAt(i) + 0.045;
      curbPos.push(a.x, y, a.z, b.x, y, b.z);
      const c = Math.floor(i / 2) % 2 ? red : white;
      curbCol.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
  }
  const curbGeo = new THREE.BufferGeometry();
  curbGeo.setAttribute('position', new THREE.Float32BufferAttribute(curbPos, 3));
  curbGeo.setAttribute('color', new THREE.Float32BufferAttribute(curbCol, 3));
  const fixedIdx: number[] = [];
  const perSide = (n + 1) * 2;
  for (let s = 0; s < 2; s++) for (let i = 0; i < n; i++) {
    const a = s * perSide + i * 2;
    fixedIdx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  curbGeo.setIndex(fixedIdx);
  curbGeo.computeVertexNormals();
  const curbs = new THREE.Mesh(curbGeo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  curbs.receiveShadow = true;
  group.add(curbs);
  disposables.push(curbGeo, curbs.material as THREE.Material);

  // --- Centre dashes + direction arrows
  const dashPos: number[] = [];
  for (let i = 0; i < n; i += 4) {
    if (heightAt(i) > 0 || heightAt(i + 2) > 0) continue;
    const a = pointAt(track, i, -0.18), b = pointAt(track, i, 0.18), c = pointAt(track, i + 1.8, 0.18), d = pointAt(track, i + 1.8, -0.18);
    const y = 0.04;
    dashPos.push(a.x, y, a.z, c.x, y, c.z, b.x, y, b.z, a.x, y, a.z, d.x, y, d.z, c.x, y, c.z);
  }
  for (let i = 25; i < n; i += 40) {
    if (heightAt(i) > 0 || heightAt(i + 3) > 0) continue;
    for (const lat of [-5.5, 5.5]) {
      const tip = pointAt(track, i + 1.6, lat), l = pointAt(track, i, lat - 1.6), rr = pointAt(track, i, lat + 1.6);
      const m = pointAt(track, i + 0.7, lat);
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

  // --- Barriers: continuous extruded wall on both sides
  const bPos: number[] = [], bCol: number[] = [];
  const bLat = hw + PHYS.barrierInset;
  const bh = PHYS.barrierHeight, bt = 0.5;
  const ba = new THREE.Color('#e63946'), bb = new THREE.Color('#f4f1de');
  for (const side of [-1, 1]) {
    for (let i = 0; i < n; i++) {
      const c = Math.floor(i / 3) % 2 ? ba : bb;
      const i0 = pointAt(track, i, side * bLat), i1 = pointAt(track, i + 1, side * bLat);
      const o0 = pointAt(track, i, side * (bLat + bt)), o1 = pointAt(track, i + 1, side * (bLat + bt));
      const quads = [
        [i0, i1, 0, bh], // inner face
        [o0, o1, 0, bh], // outer face
      ] as const;
      for (const [a, b] of quads) {
        bPos.push(a.x, 0, a.z, b.x, 0, b.z, b.x, bh, b.z, a.x, 0, a.z, b.x, bh, b.z, a.x, bh, a.z);
        for (let k = 0; k < 6; k++) bCol.push(c.r, c.g, c.b);
      }
      // top
      bPos.push(i0.x, bh, i0.z, i1.x, bh, i1.z, o1.x, bh, o1.z, i0.x, bh, i0.z, o1.x, bh, o1.z, o0.x, bh, o0.z);
      for (let k = 0; k < 6; k++) bCol.push(c.r * 0.9, c.g * 0.9, c.b * 0.9);
    }
  }
  const bGeo = new THREE.BufferGeometry();
  bGeo.setAttribute('position', new THREE.Float32BufferAttribute(bPos, 3));
  bGeo.setAttribute('color', new THREE.Float32BufferAttribute(bCol, 3));
  bGeo.computeVertexNormals();
  const barriers = new THREE.Mesh(bGeo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, flatShading: true }));
  barriers.castShadow = quality !== 'low';
  barriers.receiveShadow = true;
  group.add(barriers);
  disposables.push(bGeo, barriers.material as THREE.Material);

  // --- Finish line (checker) and arch
  const checker = canvasTexture(256, 64, (ctx) => {
    for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#111' : '#fafafa';
      ctx.fillRect(x * 32, y * 32, 32, 32);
    }
  });
  checker.wrapS = THREE.RepeatWrapping;
  checker.repeat.set(2.5, 1);
  const start = pointAt(track, 0, 0);
  const finish = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2, 2.4), new THREE.MeshBasicMaterial({ map: checker }));
  finish.position.set(start.x, 0.05, start.z);
  finish.rotation.order = 'YXZ';
  finish.rotation.set(-Math.PI / 2, start.yaw, 0);
  group.add(finish);
  disposables.push(finish.geometry, finish.material as THREE.Material, checker);

  const banner = canvasTexture(512, 96, (ctx) => {
    ctx.fillStyle = '#1d1f3f';
    ctx.fillRect(0, 0, 512, 96);
    ctx.fillStyle = '#ffd23f';
    ctx.font = '64px "Lilita One", Impact, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('WOBBLE RACERS', 256, 52);
  });
  const arch = new THREE.Group();
  const pillarMat = new THREE.MeshLambertMaterial({ color: '#ff5a4e', flatShading: true });
  for (const s of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(1, 7, 1), pillarMat);
    p.position.set(s * (hw + 2.2), 3.5, 0);
    p.castShadow = true;
    arch.add(p);
    disposables.push(p.geometry);
  }
  const bannerMesh = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 5.4, 1.8, 0.5), [
    pillarMat, pillarMat, pillarMat, pillarMat,
    new THREE.MeshBasicMaterial({ map: banner }), new THREE.MeshBasicMaterial({ map: banner }),
  ]);
  bannerMesh.position.y = 7.2;
  arch.add(bannerMesh);
  arch.position.set(start.x, 0, start.z);
  arch.rotation.y = start.yaw;
  group.add(arch);
  disposables.push(bannerMesh.geometry, banner, pillarMat);

  // --- Grid slots
  const gridMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.7 });
  const slotGeo = new THREE.PlaneGeometry(2.6, 0.25);
  slotGeo.rotateX(-Math.PI / 2);
  for (const g of track.grid) {
    const m = new THREE.Mesh(slotGeo, gridMat);
    m.position.set(g.x + Math.sin(g.yaw) * 2.6, 0.045, g.z + Math.cos(g.yaw) * 2.6);
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

  // --- Scenery: trees, rocks, clouds (instanced)
  const rand = rng(1234 + track.def.id.length);
  const treeCount = quality === 'low' ? 120 : quality === 'medium' ? 240 : 380;
  const trunkGeo = new THREE.CylinderGeometry(0.35, 0.5, 2, 5);
  trunkGeo.translate(0, 1, 0);
  const leafGeo = new THREE.ConeGeometry(2.2, 5, 6);
  leafGeo.translate(0, 4.4, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: '#8d5a3b', flatShading: true }), treeCount);
  const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshLambertMaterial({ flatShading: true }), treeCount);
  const dummy = new THREE.Object3D();
  const leafColors = ['#2d8a4e', '#3fa65c', '#1f7a45', '#56b870'].map((c) => new THREE.Color(c));
  let placed = 0, guard = 0;
  while (placed < treeCount && guard++ < treeCount * 20) {
    const x = (rand() - 0.5) * 900, z = (rand() - 0.5) * 900;
    const q = queryTrack(track, x, z);
    if (Math.abs(q.lateral) < hw + 9) continue;
    const s = 0.7 + rand() * 0.9;
    dummy.position.set(x, hillHeight(x, z) - 0.3, z);
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

  const rockGeo = new THREE.DodecahedronGeometry(1.2, 0);
  const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshLambertMaterial({ color: '#9a9aa6', flatShading: true }), 60);
  let rc = 0;
  for (let k = 0; k < 400 && rc < 60; k++) {
    const x = (rand() - 0.5) * 700, z = (rand() - 0.5) * 700;
    if (Math.abs(queryTrack(track, x, z).lateral) < hw + 6) continue;
    const s = 0.5 + rand() * 1.4;
    dummy.position.set(x, hillHeight(x, z) + 0.2, z);
    dummy.rotation.set(rand(), rand(), rand());
    dummy.scale.set(s, s * 0.7, s);
    dummy.updateMatrix();
    rocks.setMatrixAt(rc++, dummy.matrix);
  }
  rocks.count = rc;
  group.add(rocks);
  disposables.push(rockGeo, rocks.material as THREE.Material);

  const cloudGeo = new THREE.IcosahedronGeometry(8, 0);
  const cloudMat = new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true, emissive: '#ffffff', emissiveIntensity: 0.25 });
  const clouds = new THREE.InstancedMesh(cloudGeo, cloudMat, 36);
  let cc = 0;
  for (let k = 0; k < 12; k++) {
    const cx = (rand() - 0.5) * 900, cz = (rand() - 0.5) * 900, cy = 70 + rand() * 40;
    for (let j = 0; j < 3; j++) {
      dummy.position.set(cx + j * 9 - 9, cy + rand() * 3, cz + rand() * 6);
      dummy.rotation.set(rand(), rand(), rand());
      const s = 0.8 + rand() * 0.6;
      dummy.scale.set(s * 1.4, s * 0.7, s);
      dummy.updateMatrix();
      clouds.setMatrixAt(cc++, dummy.matrix);
    }
  }
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
