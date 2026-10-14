// Ten procedural, smooth-shaded cars. Bodies are extruded side profiles
// with rounded bevels and real wheel arches; tyres are lathed with sidewalls;
// glass, chrome and clear-coat paint use PBR materials. Every model is built
// to the footprint in shared/vehicles.ts so what you see is what collides.

import * as THREE from 'three';
import { colorHex, getVehicle, type Appearance } from '@wobble/shared';
import {
  capsule, chrome, cone, cyl, darkTrim, geo, glass, glow, mesh, paint, rbox, rubber, seg, sphere, std, torus, tube,
} from './kit';
import { buildCharacter, type CharacterRig } from './characters';
import { buildGun, type GunModel } from './guns';

export interface CarParts {
  root: THREE.Group;
  tilt: THREE.Group;
  body: THREE.Group;
  wheels: THREE.Group[]; // spinning parts (parent = wheel mount)
  frontWheels: THREE.Group[]; // steerable mounts
  wheelRadius: number;
  flames: THREE.Mesh[];
  shield: THREE.Mesh;
  driverSeat: THREE.Group;
  rig: CharacterRig;
  mats: { main: THREE.MeshStandardMaterial; sec: THREE.MeshStandardMaterial; wheel: THREE.MeshStandardMaterial; dark: THREE.MeshStandardMaterial };
  looseParts: THREE.Object3D[];
  exhaust: THREE.Vector3[];
  hood: THREE.Vector3;
  gunMount: THREE.Group;
  gun: GunModel | null;
  topY: number; // roughly the highest point of the model (for name tags)
}

/** Swap the roof-mounted weapon model (e.g. after picking up a crate). */
export function setCarGun(parts: CarParts, id: string) {
  if (parts.gun?.id === id) return;
  if (parts.gun) {
    parts.gunMount.remove(parts.gun.group);
    parts.gun.group.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; m?.dispose(); });
  }
  parts.gun = id ? buildGun(id) : null;
  if (parts.gun) parts.gunMount.add(parts.gun.group);
}

// ------------------------------------------------------------------ geometry builders

/** Extrude a side profile (u = forward, v = up) across the car's width with rounded edges. */
function sideExtrude(key: string, shape: () => THREE.Shape, width: number, bevel = 0.1) {
  return geo(`side${key}`, () => {
    const depth = Math.max(0.01, width - 2 * bevel);
    const g = new THREE.ExtrudeGeometry(shape(), {
      depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.9,
      bevelSegments: seg(5, 2), curveSegments: seg(28, 8), steps: 1,
    });
    g.translate(0, 0, -depth / 2);
    g.rotateY(-Math.PI / 2); // profile u -> +z (forward), extrusion -> x (width)
    return g;
  });
}

interface LowerSpec {
  z0: number; z1: number; bottom: number;
  axR: number; axF: number; archR: number; wheelY: number;
  nose: number; hood: number; cowlZ: number; cowl: number; deckZ: number; deck: number; tail: number;
  round?: number;
}

/** Lower body: bumper to bumper, with semicircular wheel arches cut into the sills. */
function lowerShape(p: LowerSpec) {
  return () => {
    const r = p.round ?? 0.18;
    const s = new THREE.Shape();
    s.moveTo(p.z0 + r, p.bottom);
    s.lineTo(p.axR - p.archR, p.bottom);
    s.lineTo(p.axR - p.archR, p.wheelY);
    s.absarc(p.axR, p.wheelY, p.archR, Math.PI, 0, true);
    s.lineTo(p.axR + p.archR, p.bottom);
    s.lineTo(p.axF - p.archR, p.bottom);
    s.lineTo(p.axF - p.archR, p.wheelY);
    s.absarc(p.axF, p.wheelY, p.archR, Math.PI, 0, true);
    s.lineTo(p.axF + p.archR, p.bottom);
    s.lineTo(p.z1 - r, p.bottom);
    s.quadraticCurveTo(p.z1, p.bottom, p.z1, p.bottom + r);
    s.lineTo(p.z1, p.nose - r * 0.5);
    s.quadraticCurveTo(p.z1, p.nose, p.z1 - r * 1.5, p.nose + (p.hood - p.nose) * 0.25);
    s.bezierCurveTo(p.z1 - 0.6, p.hood, p.cowlZ + 0.4, p.cowl, p.cowlZ, p.cowl);
    s.lineTo(p.deckZ, p.deck);
    s.quadraticCurveTo(p.z0 + 0.05, p.deck + (p.tail - p.deck) * 0.6, p.z0, p.tail - r);
    s.lineTo(p.z0, p.bottom + r);
    s.quadraticCurveTo(p.z0, p.bottom, p.z0 + r, p.bottom);
    return s;
  };
}

/** Greenhouse: windscreen, roof and rear glass as one smooth profile. */
function cabinShape(baseF: number, baseY: number, roofF: number, roofR: number, roofY: number, baseR: number, baseRY = baseY) {
  return () => {
    const s = new THREE.Shape();
    s.moveTo(baseF, baseY);
    s.quadraticCurveTo(roofF + (baseF - roofF) * 0.25, roofY, roofF, roofY);
    s.lineTo(roofR, roofY);
    s.quadraticCurveTo(baseR + (roofR - baseR) * 0.15, roofY - 0.02, baseR, baseRY);
    s.lineTo(baseF, baseY);
    return s;
  };
}

function tireGeo(R: number, W: number, chunky: boolean) {
  return geo(`tire${R},${W},${chunky}`, () => {
    const h = W / 2, k = R * (chunky ? 0.18 : 0.12), ri = R * (chunky ? 0.58 : 0.66);
    const pts: [number, number][] = [
      [ri, -h], [R - k, -h], [R - k * 0.3, -h + k * 0.3], [R, -h + k], [R, h - k], [R - k * 0.3, h - k * 0.3], [R - k, h], [ri, h],
    ];
    const g = new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), seg(36, 12));
    g.rotateZ(Math.PI / 2);
    return g;
  });
}

function wheel(style: string, R: number, W: number, side: number, rimMat: THREE.Material, tireMat: THREE.Material, discMat: THREE.Material, chunky = false) {
  const mount = new THREE.Group();
  const spin = new THREE.Group();
  mount.add(spin);
  spin.add(mesh(tireGeo(R, W, chunky || style === 'chunky'), tireMat));
  const ri = R * (chunky || style === 'chunky' ? 0.58 : 0.66);
  // tread blocks for chunky tyres
  if (chunky || style === 'chunky') {
    const block = rbox(W * 0.9, 0.08, 0.14, 0.03);
    const n = Math.max(10, seg(18));
    for (let i = 0; i < n; i++) {
      const b = mesh(block, tireMat, 0, 0, 0, false);
      const a = (i / n) * Math.PI * 2;
      b.position.set(0, Math.cos(a) * (R + 0.01), Math.sin(a) * (R + 0.01));
      b.rotation.x = -a;
      spin.add(b);
    }
  }
  const face = side * W * 0.18;
  const barrel = mesh(cyl(ri * 0.98, ri * 0.98, W * 0.7), discMat, 0, 0, 0, false);
  barrel.rotation.z = Math.PI / 2;
  spin.add(barrel);
  const dish = mesh(cyl(ri, ri * 0.92, 0.04), rimMat, face, 0, 0, false);
  dish.rotation.z = Math.PI / 2;
  spin.add(dish);
  const spokes = style === 'spoke' ? 10 : style === 'chunky' ? 6 : 5;
  const spokeGeo = style === 'spoke' ? rbox(0.05, ri * 1.75, 0.035, 0.015) : rbox(0.07, ri * 1.7, ri * 0.28, 0.03);
  for (let i = 0; i < spokes / (style === 'spoke' ? 2 : 1); i++) {
    const sp = mesh(spokeGeo, rimMat, face + side * 0.03, 0, 0, false);
    sp.rotation.x = (i / spokes) * Math.PI * (style === 'spoke' ? 2 : 2);
    spin.add(sp);
  }
  const cap = mesh(sphere(ri * 0.22), chrome(), face + side * 0.05, 0, 0, false);
  cap.scale.set(0.5, 1, 1);
  spin.add(cap);
  // brake caliper (doesn't spin)
  const caliper = mesh(rbox(0.08, ri * 0.55, ri * 0.35, 0.03), std('#d62828', 0.35, 0.3), -side * W * 0.05, ri * 0.45, -ri * 0.3, false);
  mount.add(caliper);
  return { mount, spin };
}

const numberCache = new Map<string, THREE.Texture>();
function numberDecal(num: number, bg: string, fg: string) {
  const key = `${num}|${bg}|${fg}`;
  let t = numberCache.get(key);
  if (!t) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(64, 64, 60, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 8;
    ctx.strokeStyle = fg;
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.font = '900 66px Nunito, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), 64, 68);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    numberCache.set(key, t);
  }
  return t;
}

function headlight(g: THREE.Object3D, x: number, y: number, z: number, r = 0.13) {
  const housing = mesh(sphere(r), chrome(), x, y, z - r * 0.4, false);
  housing.scale.set(1, 0.8, 0.6);
  g.add(housing);
  const lens = mesh(sphere(r * 0.85), glow('#fff6d8', 1.4), x, y, z - r * 0.25, false);
  lens.scale.set(1, 0.8, 0.6);
  g.add(lens);
}
function taillight(g: THREE.Object3D, x: number, y: number, z: number, w = 0.32) {
  g.add(mesh(rbox(w, 0.12, 0.06, 0.03), glow('#ff2a2a', 1.1), x, y, z, false));
}
function mirror(g: THREE.Object3D, x: number, y: number, z: number, m: THREE.Material) {
  g.add(mesh(cyl(0.02, 0.02, 0.16), darkTrim(), x - Math.sign(x) * 0.06, y - 0.04, z).rotateZ(Math.PI / 2));
  g.add(mesh(rbox(0.1, 0.12, 0.16, 0.04), m, x, y, z));
}

/** Dark side skirts between the wheel arches plus a lower front valance. */
function trim(body: THREE.Object3D, zR: number, zF: number, archR: number, halfX: number, y: number, noseZ: number, tailZ: number, m: THREE.Material) {
  const len = zF - zR - archR * 2 - 0.1;
  for (const s of [-1, 1]) body.add(mesh(rbox(0.1, 0.14, len, 0.04), m, s * halfX, y, (zF + zR) / 2));
  body.add(mesh(rbox(halfX * 1.7, 0.12, 0.18, 0.05), m, 0, y, noseZ - 0.06));
  body.add(mesh(rbox(halfX * 1.5, 0.14, 0.14, 0.05), m, 0, y + 0.05, tailZ + 0.06));
  // diffuser fins
  for (let i = -2; i <= 2; i++) body.add(mesh(rbox(0.03, 0.12, 0.25, 0.01), m, i * halfX * 0.25, y, tailZ + 0.12));
}

// ------------------------------------------------------------------ build

interface Layout {
  R: number; W: number; track: number; zF: number; zR: number; rearR?: number; rearW?: number;
  seat: [number, number]; driverScale: number; exhaust: THREE.Vector3[]; hood: THREE.Vector3; chunky?: boolean; lift?: number;
  zM?: number; // third (middle) axle
  gun: [number, number]; // weapon mount [y, z]
  top: number;
}

export function buildCar(app: Appearance): CarParts {
  const root = new THREE.Group();
  const tilt = new THREE.Group();
  root.add(tilt);
  const body = new THREE.Group();
  tilt.add(body);
  const cfg = getVehicle(app.carClass);
  const main = paint(colorHex(app.colorMain)) as THREE.MeshStandardMaterial;
  const sec = paint(colorHex(app.colorSecondary)) as THREE.MeshStandardMaterial;
  const wheelMat = std(colorHex(app.colorWheel), 0.3, 0.75);
  const dark = darkTrim();
  const tireMat = rubber();
  const gl = glass();
  const loose: THREE.Object3D[] = [];
  const hash = [...(app.carClass + app.character + app.colorMain + app.colorSecondary)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const decal = std('#ffffff', 0.4, 0, { map: numberDecal(1 + (hash % 98), '#ffffff', '#1d1f3f'), transparent: true });
  const addDecals = (x: number, y: number, z: number, r = 0.26) => {
    for (const s of [-1, 1]) {
      const d = mesh(geo(`decal${r}`, () => new THREE.CircleGeometry(r, seg(28))), decal, s * x, y, z, false);
      d.rotation.y = (s * Math.PI) / 2;
      body.add(d);
    }
  };
  let L: Layout;

  switch (app.carClass) {
    case 'speedster': {
      L = { R: 0.4, W: 0.32, track: 0.82, zF: 1.45, zR: -1.42, seat: [0.3, -0.25], driverScale: 0.78, gun: [1.3, -0.3], top: 1.6,
        exhaust: [new THREE.Vector3(0.28, 0.42, -2.35), new THREE.Vector3(-0.28, 0.42, -2.35)], hood: new THREE.Vector3(0, 0.75, 1.6) };
      body.add(mesh(sideExtrude('spd-low', lowerShape({ z0: -2.3, z1: 2.3, bottom: 0.16, axR: L.zR, axF: L.zF, archR: 0.47, wheelY: 0.4, nose: 0.36, hood: 0.62, cowlZ: 0.55, cowl: 0.74, deckZ: -1.3, deck: 0.82, tail: 0.86 }), 1.86, 0.14), main));
      const canopy = mesh(sideExtrude('spd-cab', cabinShape(0.75, 0.7, 0.05, -0.55, 1.3, -1.25, 0.8), 1.2, 0.22), gl);
      body.add(canopy);
      body.add(mesh(sideExtrude('spd-frame', cabinShape(0.05, 1.22, -0.05, -0.5, 1.33, -0.6, 1.22), 1.12, 0.1), sec));
      // side intakes + stripe
      for (const s of [-1, 1]) {
        body.add(mesh(rbox(0.06, 0.22, 0.7, 0.05), dark, s * 0.92, 0.48, -0.4));
        mirror(body, s * 0.72, 0.9, 0.45, main);
      }
      body.add(mesh(rbox(0.36, 0.03, 3.4, 0.015), sec, 0, 0.76, 0.3));
      // rear wing
      const wing = new THREE.Group();
      wing.add(mesh(sideExtrude('spd-wing', () => {
        const s = new THREE.Shape();
        s.moveTo(-0.3, 0); s.quadraticCurveTo(0, 0.12, 0.3, 0.03); s.lineTo(0.3, 0); s.quadraticCurveTo(0, 0.04, -0.3, -0.02); s.lineTo(-0.3, 0);
        return s;
      }, 1.9, 0.02), sec, 0, 1.25, -2.0));
      for (const s of [-1, 1]) {
        wing.add(mesh(rbox(0.04, 0.32, 0.55, 0.02), main, s * 0.95, 1.2, -2.0));
        wing.add(mesh(rbox(0.06, 0.4, 0.12, 0.03), dark, s * 0.45, 1.0, -2.0));
      }
      body.add(wing);
      loose.push(wing);
      const splitter = mesh(rbox(1.8, 0.05, 0.3, 0.02), dark, 0, 0.18, 2.2);
      body.add(splitter);
      loose.push(splitter);
      for (const s of [-1, 1]) { headlight(body, s * 0.62, 0.48, 2.27, 0.12); taillight(body, s * 0.6, 0.74, -2.3); }
      trim(body, L.zR, L.zF, 0.47, 0.93, 0.22, 2.3, -2.3, dark);
      addDecals(0.94, 0.52, 0.2, 0.22);
      break;
    }
    case 'bruiser': {
      L = { R: 0.58, W: 0.48, track: 0.98, zF: 1.42, zR: -1.42, seat: [1.0, -0.45], driverScale: 0.92, chunky: true, gun: [2.24, -0.5], top: 2.9,
        exhaust: [new THREE.Vector3(1.14, 2.1, -1.0), new THREE.Vector3(-1.14, 2.1, -1.0)], hood: new THREE.Vector3(0, 1.45, 1.5) };
      body.add(mesh(sideExtrude('bru-low', lowerShape({ z0: -2.2, z1: 2.2, bottom: 0.5, axR: L.zR, axF: L.zF, archR: 0.7, wheelY: 0.58, nose: 1.15, hood: 1.35, cowlZ: 0.5, cowl: 1.42, deckZ: -1.9, deck: 1.42, tail: 1.42, round: 0.22 }), 2.14, 0.16), main));
      body.add(mesh(rbox(2.18, 0.12, 4.3, 0.05), sec, 0, 1.0, 0));
      // windscreen + roll cage
      const ws = mesh(rbox(1.8, 0.62, 0.05, 0.03), gl, 0, 1.75, 0.45);
      ws.rotation.x = -0.25;
      body.add(ws);
      const cageMat = std('#2b2d38', 0.35, 0.8);
      for (const s of [-1, 1]) {
        body.add(mesh(tube(`bru-cage${s}`, [[s * 0.95, 1.42, 0.5], [s * 0.92, 2.15, 0.2], [s * 0.9, 2.2, -1.2], [s * 0.92, 1.42, -1.6]], 0.05), cageMat));
        mirror(body, s * 1.12, 1.75, 0.5, main);
      }
      body.add(mesh(tube('bru-cage-x1', [[-0.92, 2.18, 0.15], [0, 2.22, 0.15], [0.92, 2.18, 0.15]], 0.05), cageMat));
      body.add(mesh(tube('bru-cage-x2', [[-0.9, 2.2, -1.15], [0, 2.24, -1.15], [0.9, 2.2, -1.15]], 0.05), cageMat));
      for (const x of [-0.6, -0.2, 0.2, 0.6]) {
        body.add(mesh(cyl(0.1, 0.1, 0.12, 20), chrome(), x, 2.32, 0.15).rotateX(Math.PI / 2));
        body.add(mesh(cyl(0.085, 0.085, 0.02, 20), glow('#fff3b0', 1.3), x, 2.32, 0.22, false).rotateX(Math.PI / 2));
      }
      const bar = mesh(tube('bru-bar', [[-1.0, 0.75, 2.35], [-0.6, 1.05, 2.42], [0.6, 1.05, 2.42], [1.0, 0.75, 2.35]], 0.07), chrome());
      body.add(bar);
      loose.push(bar);
      const spare = new THREE.Group();
      spare.add(mesh(tireGeo(0.48, 0.32, true), tireMat).rotateY(Math.PI / 2));
      spare.position.set(0, 1.25, -2.3);
      body.add(spare);
      loose.push(spare);
      for (const s of [-1, 1]) {
        body.add(mesh(cyl(0.08, 0.08, 1.1), chrome(), s * 1.14, 1.55, -1.0));
        headlight(body, s * 0.7, 1.1, 2.2, 0.15);
        taillight(body, s * 0.78, 1.2, -2.21, 0.3);
      }
      trim(body, L.zR, L.zF, 0.7, 1.07, 0.58, 2.2, -2.2, dark);
      addDecals(1.08, 0.95, 0.05, 0.3);
      break;
    }
    case 'drifter': {
      L = { R: 0.42, W: 0.36, track: 0.9, zF: 1.35, zR: -1.35, seat: [0.45, -0.3], driverScale: 0.84, gun: [1.55, -0.4], top: 2.1,
        exhaust: [new THREE.Vector3(0.55, 0.38, -2.2)], hood: new THREE.Vector3(0, 0.95, 1.45) };
      body.add(mesh(sideExtrude('dri-low', lowerShape({ z0: -2.15, z1: 2.15, bottom: 0.22, axR: L.zR, axF: L.zF, archR: 0.52, wheelY: 0.42, nose: 0.55, hood: 0.86, cowlZ: 0.55, cowl: 0.95, deckZ: -1.55, deck: 0.98, tail: 0.98 }), 1.92, 0.16), main));
      // wide fender flares
      for (const s of [-1, 1]) for (const z of [L.zF, L.zR]) {
        const flare = mesh(torus(0.52, 0.09, Math.PI), main, s * 0.97, 0.42, z);
        flare.rotation.y = Math.PI / 2;
        body.add(flare);
      }
      body.add(mesh(sideExtrude('dri-cab', cabinShape(0.6, 0.9, -0.05, -0.75, 1.5, -1.45, 0.95), 1.55, 0.16), gl));
      body.add(mesh(sideExtrude('dri-roof', cabinShape(-0.02, 1.42, -0.1, -0.7, 1.55, -0.85, 1.42), 1.5, 0.08), main));
      const duck = mesh(sideExtrude('dri-duck', () => {
        const s = new THREE.Shape();
        s.moveTo(-0.4, 0); s.lineTo(0.2, 0); s.quadraticCurveTo(-0.2, 0.05, -0.45, 0.2); s.lineTo(-0.4, 0);
        return s;
      }, 1.8, 0.03), sec, 0, 0.96, -1.7);
      body.add(duck);
      loose.push(duck);
      const lip = mesh(rbox(1.9, 0.06, 0.25, 0.02), dark, 0, 0.24, 2.1);
      body.add(lip);
      loose.push(lip);
      for (const s of [-1, 1]) {
        headlight(body, s * 0.65, 0.66, 2.12, 0.13);
        taillight(body, s * 0.62, 0.84, -2.16, 0.34);
        mirror(body, s * 0.9, 1.12, 0.45, main);
      }
      body.add(mesh(rbox(0.9, 0.14, 0.05, 0.03), dark, 0, 0.52, 2.15));
      body.add(mesh(cyl(0.07, 0.07, 0.25), chrome(), 0.55, 0.36, -2.15).rotateX(Math.PI / 2));
      trim(body, L.zR, L.zF, 0.52, 0.96, 0.28, 2.15, -2.15, dark);
      addDecals(1.0, 0.62, 0.1);
      break;
    }
    case 'muscle': {
      L = { R: 0.43, W: 0.4, track: 0.86, zF: 1.55, zR: -1.4, seat: [0.42, -0.45], driverScale: 0.82, gun: [1.47, -0.6], top: 2.0,
        exhaust: [new THREE.Vector3(0.98, 0.32, -0.6), new THREE.Vector3(-0.98, 0.32, -0.6)], hood: new THREE.Vector3(0, 1.0, 1.6) };
      body.add(mesh(sideExtrude('mus-low', lowerShape({ z0: -2.4, z1: 2.4, bottom: 0.22, axR: L.zR, axF: L.zF, archR: 0.52, wheelY: 0.43, nose: 0.72, hood: 0.92, cowlZ: 0.3, cowl: 0.98, deckZ: -1.75, deck: 0.95, tail: 0.95, round: 0.12 }), 1.92, 0.12), main));
      body.add(mesh(sideExtrude('mus-cab', cabinShape(0.3, 0.95, -0.25, -0.95, 1.45, -1.85, 0.97), 1.5, 0.14), gl));
      body.add(mesh(sideExtrude('mus-roof', cabinShape(-0.22, 1.36, -0.3, -0.9, 1.47, -1.1, 1.36), 1.46, 0.07), main));
      for (const s of [-1, 1]) body.add(mesh(rbox(0.22, 0.02, 4.4, 0.01), sec, s * 0.2, 0.99, 0.1));
      // hood scoop
      body.add(mesh(rbox(0.55, 0.16, 0.8, 0.07), sec, 0, 1.0, 1.05));
      body.add(mesh(rbox(0.45, 0.1, 0.05, 0.03), dark, 0, 1.0, 1.46));
      const bumperF = mesh(rbox(1.9, 0.16, 0.16, 0.07), chrome(), 0, 0.42, 2.42);
      const bumperR = mesh(rbox(1.9, 0.16, 0.16, 0.07), chrome(), 0, 0.42, -2.42);
      body.add(bumperF, bumperR);
      loose.push(bumperF, bumperR);
      body.add(mesh(rbox(1.3, 0.24, 0.05, 0.04), dark, 0, 0.62, 2.42));
      for (const s of [-1, 1]) {
        headlight(body, s * 0.72, 0.65, 2.4, 0.14);
        taillight(body, s * 0.62, 0.78, -2.41, 0.5);
        body.add(mesh(cyl(0.07, 0.07, 1.4), chrome(), s * 0.98, 0.32, -0.4).rotateX(Math.PI / 2));
        mirror(body, s * 0.88, 1.08, 0.25, chrome());
      }
      trim(body, L.zR, L.zF, 0.52, 0.96, 0.28, 2.4, -2.4, dark);
      addDecals(0.98, 0.62, 0.35);
      break;
    }
    case 'buggy': {
      L = { R: 0.42, W: 0.36, track: 0.94, zF: 1.25, zR: -1.2, rearR: 0.5, rearW: 0.44, seat: [0.5, -0.1], driverScale: 0.88, chunky: true, gun: [1.84, -0.3], top: 2.5,
        exhaust: [new THREE.Vector3(0.3, 1.0, -1.85)], hood: new THREE.Vector3(0, 0.9, -1.2) };
      // small tub
      body.add(mesh(sideExtrude('bug-tub', lowerShape({ z0: -1.6, z1: 1.75, bottom: 0.35, axR: L.zR, axF: L.zF, archR: 0.56, wheelY: 0.48, nose: 0.6, hood: 0.72, cowlZ: 0.5, cowl: 0.82, deckZ: -1.0, deck: 0.8, tail: 0.85, round: 0.2 }), 1.35, 0.14), main));
      const frame = std('#30323d', 0.35, 0.8);
      const cage = new THREE.Group();
      for (const s of [-1, 1]) {
        cage.add(mesh(tube(`bug-rail${s}`, [[s * 0.62, 0.8, 1.2], [s * 0.66, 1.5, 0.35], [s * 0.66, 1.75, -0.3], [s * 0.66, 1.2, -1.2], [s * 0.6, 0.7, -1.65]], 0.045), frame));
        cage.add(mesh(tube(`bug-strut${s}`, [[s * 0.66, 1.75, -0.3], [s * 0.55, 0.85, -0.55]], 0.04), frame));
      }
      cage.add(mesh(tube('bug-hoop', [[-0.66, 1.75, -0.3], [0, 1.82, -0.3], [0.66, 1.75, -0.3]], 0.05), frame));
      cage.add(mesh(tube('bug-front', [[-0.62, 0.8, 1.2], [0, 0.85, 1.32], [0.62, 0.8, 1.2]], 0.05), frame));
      body.add(cage);
      // engine block + exhaust at the back
      body.add(mesh(rbox(0.8, 0.45, 0.6, 0.08), std('#5a5e6e', 0.4, 0.7), 0, 0.85, -1.4));
      for (let i = 0; i < 4; i++) body.add(mesh(rbox(0.85, 0.03, 0.62, 0.01), chrome(), 0, 0.72 + i * 0.08, -1.4));
      body.add(mesh(tube('bug-pipe', [[0.3, 0.9, -1.4], [0.35, 0.95, -1.7], [0.3, 1.0, -1.85]], 0.06), chrome()));
      const flag = new THREE.Group();
      flag.add(mesh(cyl(0.012, 0.012, 1.2), darkTrim(), 0, 0.6, 0));
      flag.add(mesh(cone(0.2, 0.32), sec, 0.12, 1.1, 0).rotateZ(-Math.PI / 2));
      flag.position.set(-0.55, 1.2, -1.2);
      body.add(flag);
      loose.push(flag);
      for (const s of [-1, 1]) headlight(body, s * 0.35, 1.72, -0.2, 0.1);
      addDecals(0.7, 0.62, 0.3, 0.2);
      break;
    }
    case 'formula': {
      L = { R: 0.38, W: 0.42, track: 0.82, zF: 1.55, zR: -1.4, rearR: 0.42, rearW: 0.46, seat: [0.18, -0.3], driverScale: 0.8, gun: [0.98, -1.1], top: 1.7,
        exhaust: [new THREE.Vector3(0, 0.62, -2.15)], hood: new THREE.Vector3(0, 0.7, -0.9) };
      // tub & nose cone
      body.add(mesh(sideExtrude('f1-tub', () => {
        const s = new THREE.Shape();
        s.moveTo(-1.9, 0.18); s.lineTo(1.0, 0.18); s.quadraticCurveTo(1.6, 0.2, 2.3, 0.3); s.lineTo(2.35, 0.38);
        s.quadraticCurveTo(1.6, 0.55, 0.7, 0.72); s.lineTo(0.35, 0.75); s.lineTo(-0.7, 0.75);
        s.quadraticCurveTo(-1.2, 0.95, -1.4, 0.98); s.lineTo(-1.95, 0.6); s.lineTo(-1.9, 0.18);
        return s;
      }, 0.72, 0.18), main));
      for (const s of [-1, 1]) {
        const pod = mesh(capsule(0.22, 1.1), main, s * 0.52, 0.42, -0.55);
        pod.rotation.x = Math.PI / 2;
        pod.scale.set(1, 1, 0.75);
        body.add(pod);
        body.add(mesh(rbox(0.05, 0.22, 0.32, 0.02), dark, s * 0.52, 0.42, 0.02));
      }
      const fw = new THREE.Group();
      fw.add(mesh(rbox(1.9, 0.04, 0.42, 0.02), sec, 0, 0.18, 2.3));
      for (const s of [-1, 1]) fw.add(mesh(rbox(0.04, 0.2, 0.46, 0.02), main, s * 0.95, 0.25, 2.3));
      body.add(fw);
      loose.push(fw);
      const rw = new THREE.Group();
      rw.add(mesh(rbox(1.6, 0.05, 0.42, 0.02), sec, 0, 1.05, -2.25));
      rw.add(mesh(rbox(1.6, 0.04, 0.3, 0.02), sec, 0, 0.88, -2.3));
      for (const s of [-1, 1]) rw.add(mesh(rbox(0.04, 0.5, 0.55, 0.02), main, s * 0.8, 0.9, -2.25));
      rw.add(mesh(rbox(0.08, 0.4, 0.1, 0.03), dark, 0, 0.75, -2.1));
      body.add(rw);
      loose.push(rw);
      // halo
      body.add(mesh(tube('f1-halo', [[-0.32, 0.75, -0.6], [-0.3, 1.02, -0.15], [0, 1.06, 0.25], [0.3, 1.02, -0.15], [0.32, 0.75, -0.6]], 0.035), dark));
      // suspension arms
      for (const s of [-1, 1]) for (const z of [L.zF, L.zR]) {
        body.add(mesh(tube(`f1-arm${s}${z}`, [[s * 0.3, 0.35, z + 0.12], [s * 0.82, 0.38, z]], 0.02), dark));
        body.add(mesh(tube(`f1-arm2${s}${z}`, [[s * 0.3, 0.3, z - 0.15], [s * 0.82, 0.38, z]], 0.02), dark));
      }
      body.add(mesh(rbox(0.12, 0.08, 0.04, 0.02), glow('#ff2a2a', 1.4), 0, 0.42, -2.18));
      addDecals(0.37, 0.48, 1.1, 0.16);
      break;
    }
    case 'jeep': {
      L = { R: 0.5, W: 0.38, track: 0.94, zF: 1.35, zR: -1.3, seat: [0.82, -0.3], driverScale: 0.9, chunky: true, gun: [2.05, -0.95], top: 2.7,
        exhaust: [new THREE.Vector3(0.62, 0.5, -2.12)], hood: new THREE.Vector3(0, 1.3, 1.4) };
      body.add(mesh(sideExtrude('jeep-low', lowerShape({ z0: -2.1, z1: 2.1, bottom: 0.48, axR: L.zR, axF: L.zF, archR: 0.62, wheelY: 0.52, nose: 1.08, hood: 1.24, cowlZ: 0.42, cowl: 1.28, deckZ: -1.95, deck: 1.3, tail: 1.3, round: 0.1 }), 2.0, 0.1), main));
      // square fender flares
      for (const s of [-1, 1]) for (const z of [L.zF, L.zR]) body.add(mesh(rbox(0.22, 0.1, 1.35, 0.04), dark, s * 1.02, 1.08, z));
      // fold-down windscreen frame
      const ws = new THREE.Group();
      ws.add(mesh(rbox(1.84, 0.62, 0.04, 0.02), gl, 0, 0.32, 0));
      ws.add(mesh(rbox(1.92, 0.08, 0.08, 0.03), sec, 0, 0.66, 0));
      for (const s of [-1, 1]) ws.add(mesh(rbox(0.08, 0.7, 0.08, 0.03), sec, s * 0.94, 0.33, 0));
      ws.position.set(0, 1.28, 0.42);
      ws.rotation.x = -0.18;
      body.add(ws);
      // roll bar
      const rb = std('#2b2d38', 0.35, 0.8);
      body.add(mesh(tube('jeep-roll', [[-0.92, 1.3, -0.95], [-0.88, 2.0, -0.95], [0, 2.05, -0.95], [0.88, 2.0, -0.95], [0.92, 1.3, -0.95]], 0.055), rb));
      for (const s of [-1, 1]) body.add(mesh(tube(`jeep-stay${s}`, [[s * 0.88, 1.98, -0.95], [s * 0.9, 1.3, -1.85]], 0.04), rb));
      // seven-slot grille + round lamps
      body.add(mesh(rbox(1.3, 0.5, 0.06, 0.04), sec, 0, 0.86, 2.1));
      for (let i = -3; i <= 3; i++) body.add(mesh(rbox(0.07, 0.36, 0.04, 0.02), dark, i * 0.13, 0.86, 2.13));
      const bumper = mesh(rbox(2.0, 0.16, 0.18, 0.04), dark, 0, 0.55, 2.15);
      body.add(bumper);
      loose.push(bumper);
      const spare = new THREE.Group();
      spare.add(mesh(tireGeo(0.46, 0.3, true), tireMat).rotateY(Math.PI / 2));
      spare.position.set(0, 1.0, -2.25);
      body.add(spare);
      loose.push(spare);
      // jerry can, bonnet straps
      body.add(mesh(rbox(0.3, 0.42, 0.18, 0.04), std('#3f6b35', 0.6, 0.2), 0.7, 1.5, -1.7));
      for (const s of [-1, 1]) {
        headlight(body, s * 0.78, 0.92, 2.12, 0.15);
        taillight(body, s * 0.85, 1.0, -2.11, 0.2);
        mirror(body, s * 1.0, 1.55, 0.55, sec);
        body.add(mesh(rbox(0.06, 0.02, 0.6, 0.01), dark, s * 0.4, 1.27, 1.2));
      }
      trim(body, L.zR, L.zF, 0.62, 1.0, 0.56, 2.1, -2.1, dark);
      addDecals(1.0, 0.95, -0.4, 0.28);
      break;
    }
    case 'pickup': {
      L = { R: 0.52, W: 0.4, track: 0.98, zF: 1.68, zR: -1.55, seat: [0.95, 0.4], driverScale: 0.88, chunky: true, gun: [1.6, -1.55], top: 2.8,
        exhaust: [new THREE.Vector3(0.72, 0.45, -2.62)], hood: new THREE.Vector3(0, 1.45, 1.9) };
      body.add(mesh(sideExtrude('pick-low', lowerShape({ z0: -2.6, z1: 2.6, bottom: 0.5, axR: L.zR, axF: L.zF, archR: 0.66, wheelY: 0.54, nose: 1.12, hood: 1.36, cowlZ: 1.0, cowl: 1.42, deckZ: -2.5, deck: 1.4, tail: 1.4, round: 0.12 }), 2.2, 0.12), main));
      body.add(mesh(sideExtrude('pick-cab', cabinShape(1.0, 1.42, 0.62, -0.45, 2.18, -0.55, 1.42), 2.0, 0.12), gl));
      body.add(mesh(sideExtrude('pick-roof', cabinShape(0.66, 2.08, 0.6, -0.42, 2.2, -0.48, 2.08), 2.02, 0.07), main));
      body.add(mesh(rbox(2.08, 0.5, 0.1, 0.03), main, 0, 1.65, -0.5));
      // bed: side walls, floor, tailgate
      for (const s of [-1, 1]) body.add(mesh(rbox(0.1, 0.42, 2.0, 0.03), main, s * 1.04, 1.62, -1.55));
      body.add(mesh(rbox(2.0, 0.06, 2.0, 0.02), dark, 0, 1.42, -1.55));
      const gate = mesh(rbox(2.08, 0.44, 0.08, 0.03), sec, 0, 1.62, -2.56);
      body.add(gate);
      loose.push(gate);
      // light bar on the roof
      body.add(mesh(rbox(1.5, 0.12, 0.16, 0.05), dark, 0, 2.3, 0.2));
      for (let i = -3; i <= 3; i++) body.add(mesh(rbox(0.16, 0.08, 0.02, 0.02), glow('#fff6c8', 1.4), i * 0.2, 2.3, 0.29, false));
      // chrome grille & bumpers
      body.add(mesh(rbox(1.7, 0.5, 0.06, 0.05), chrome(), 0, 1.0, 2.6));
      for (let i = 0; i < 4; i++) body.add(mesh(rbox(1.5, 0.04, 0.04, 0.01), dark, 0, 0.84 + i * 0.1, 2.63));
      const bF = mesh(rbox(2.15, 0.2, 0.2, 0.06), chrome(), 0, 0.6, 2.66);
      const bR = mesh(rbox(2.15, 0.2, 0.2, 0.06), chrome(), 0, 0.6, -2.66);
      body.add(bF, bR);
      loose.push(bF, bR);
      for (const s of [-1, 1]) {
        headlight(body, s * 0.85, 1.12, 2.58, 0.16);
        taillight(body, s * 0.98, 1.55, -2.6, 0.12);
        mirror(body, s * 1.15, 1.75, 0.95, chrome());
        body.add(mesh(rbox(0.08, 0.1, 1.5, 0.04), chrome(), s * 1.12, 0.62, 0.05));
      }
      trim(body, L.zR, L.zF, 0.66, 1.08, 0.58, 2.6, -2.6, dark);
      addDecals(1.11, 1.0, 1.75, 0.26);
      break;
    }
    case 'armored': {
      L = { R: 0.55, W: 0.42, track: 1.08, zF: 1.85, zR: -1.85, zM: 0, seat: [1.62, 0.95], driverScale: 0.82, chunky: true, gun: [2.32, -0.55], top: 3.2,
        exhaust: [new THREE.Vector3(1.15, 1.75, -1.9), new THREE.Vector3(-1.15, 1.75, -1.9)], hood: new THREE.Vector3(0, 2.05, 1.8) };
      body.add(mesh(sideExtrude('arm-low', lowerShape({ z0: -2.75, z1: 2.75, bottom: 0.55, axR: L.zR, axF: L.zF, archR: 0.68, wheelY: 0.56, nose: 1.25, hood: 1.85, cowlZ: 1.25, cowl: 2.1, deckZ: -2.4, deck: 2.1, tail: 1.85, round: 0.08 }), 2.3, 0.08), main));
      // sloped glacis plate and vision slits
      const glacis = mesh(rbox(2.2, 0.08, 1.2, 0.03), sec, 0, 1.62, 2.18);
      glacis.rotation.x = 0.55;
      body.add(glacis);
      for (const s of [-1, 0, 1]) body.add(mesh(rbox(0.36, 0.07, 0.05, 0.02), glow('#8fd8ff', 0.6), s * 0.55, 1.95, 1.55));
      // side armour skirts over the upper wheels, with rivets
      for (const s of [-1, 1]) {
        body.add(mesh(rbox(0.08, 0.42, 5.1, 0.03), sec, s * 1.17, 1.3, 0));
        for (let i = 0; i < 9; i++) body.add(mesh(sphere(0.03), chrome(), s * 1.22, 1.45, -2.3 + i * 0.58, false));
      }
      // roof: hatch, turret ring, antenna, stowage
      body.add(mesh(cyl(0.62, 0.66, 0.16, 28), dark, 0, 2.18, -0.55));
      body.add(mesh(cyl(0.34, 0.34, 0.08, 20), sec, 0, 2.14, 0.95));
      const ant = mesh(cyl(0.012, 0.02, 1.6, 8), darkTrim(), -0.85, 2.9, -1.6);
      body.add(ant);
      loose.push(ant);
      body.add(mesh(rbox(0.8, 0.3, 0.5, 0.06), std('#4d5a33', 0.7, 0.1), 0.55, 2.25, -1.8));
      // headlight cages, tow hooks, exhaust stacks
      for (const s of [-1, 1]) {
        headlight(body, s * 0.85, 1.38, 2.62, 0.13);
        body.add(mesh(torus(0.17, 0.02), darkTrim(), s * 0.85, 1.38, 2.72));
        taillight(body, s * 0.85, 1.6, -2.76, 0.25);
        body.add(mesh(torus(0.1, 0.03, Math.PI), chrome(), s * 0.6, 0.75, 2.78).rotateZ(Math.PI));
        body.add(mesh(cyl(0.09, 0.09, 0.5), dark, s * 1.15, 1.5, -1.9));
      }
      const plow = mesh(rbox(2.3, 0.3, 0.12, 0.04), dark, 0, 0.72, 2.85);
      body.add(plow);
      loose.push(plow);
      addDecals(1.22, 1.75, 0.6, 0.3);
      break;
    }
    default: {
      // monster truck
      L = { R: 0.92, W: 0.66, track: 1.08, zF: 1.4, zR: -1.4, seat: [1.5, -0.25], driverScale: 0.95, chunky: true, lift: 1, gun: [2.76, -0.4], top: 3.5,
        exhaust: [new THREE.Vector3(0.75, 2.85, -0.75), new THREE.Vector3(-0.75, 2.85, -0.75)], hood: new THREE.Vector3(0, 2.0, 1.35) };
      body.add(mesh(sideExtrude('mon-low', lowerShape({ z0: -2.0, z1: 2.0, bottom: 1.2, axR: L.zR, axF: L.zF, archR: 1.0, wheelY: 1.18, nose: 1.8, hood: 1.98, cowlZ: 0.5, cowl: 2.05, deckZ: -1.7, deck: 2.0, tail: 2.0, round: 0.2 }), 2.1, 0.16), main));
      body.add(mesh(sideExtrude('mon-cab', cabinShape(0.45, 2.02, 0.1, -0.85, 2.72, -1.0, 2.02), 1.7, 0.14), gl));
      body.add(mesh(sideExtrude('mon-roof', cabinShape(0.12, 2.62, 0.08, -0.82, 2.76, -0.9, 2.62), 1.72, 0.08), main));
      // flames down the side
      for (const s of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          const f = mesh(cone(0.12, 0.7 - i * 0.08), sec, s * 1.06, 1.55 + (i % 2) * 0.1, 0.9 - i * 0.45);
          f.rotation.x = -Math.PI / 2;
          f.scale.set(0.35, 1, 1);
          body.add(f);
        }
      }
      // suspension: chassis rail + shocks
      const susp = std('#c0c4cc', 0.3, 0.9);
      for (const s of [-1, 1]) for (const z of [L.zF, L.zR]) {
        body.add(mesh(cyl(0.08, 0.08, 0.9), std('#ffcf33', 0.35, 0.4), s * 0.75, 1.0, z - Math.sign(z) * 0.25).rotateZ(s * 0.35));
        body.add(mesh(cyl(0.035, 0.035, 0.6), susp, s * 0.5, 0.95, z));
      }
      body.add(mesh(rbox(1.2, 0.18, 3.4, 0.05), std('#30323d', 0.5, 0.6), 0, 1.0, 0));
      for (const x of [-0.5, -0.17, 0.17, 0.5]) body.add(mesh(cyl(0.09, 0.09, 0.1, 20), glow('#fff3b0', 1.3), x, 2.84, 0.12, false).rotateX(Math.PI / 2));
      for (const s of [-1, 1]) {
        body.add(mesh(cyl(0.07, 0.07, 0.9), chrome(), s * 0.75, 2.45, -0.75));
        headlight(body, s * 0.7, 1.75, 2.0, 0.15);
        taillight(body, s * 0.8, 1.85, -2.01, 0.3);
      }
      const grille = mesh(rbox(1.1, 0.35, 0.06, 0.04), chrome(), 0, 1.65, 2.02);
      body.add(grille);
      loose.push(grille);
      addDecals(1.06, 1.85, -0.9, 0.3);
      break;
    }
  }

  // Wheels
  const wheels: THREE.Group[] = [];
  const frontWheels: THREE.Group[] = [];
  const axles: [number, number, boolean][] = [[1, L.zF, true], [-1, L.zF, true], [1, L.zR, false], [-1, L.zR, false]];
  if (L.zM !== undefined) axles.push([1, L.zM, false], [-1, L.zM, false]);
  for (const [x, z, front] of axles) {
    const R = front ? L.R : L.rearR ?? L.R;
    const W = front ? L.W : L.rearW ?? L.W;
    const w = wheel(app.wheelStyle, R, W, x, wheelMat, tireMat, dark, L.chunky);
    w.mount.position.set(x * (L.track + (W - L.W) / 2), R, z);
    tilt.add(w.mount);
    wheels.push(w.spin);
    if (front) frontWheels.push(w.mount);
  }

  // Driver
  const driverSeat = new THREE.Group();
  driverSeat.position.set(0, L.seat[0], L.seat[1]);
  const rig = buildCharacter(app.character);
  rig.root.scale.setScalar(L.driverScale);
  driverSeat.add(rig.root);
  tilt.add(driverSeat);
  // steering wheel
  const sw = mesh(torus(0.15, 0.025), dark, 0, L.seat[0] + 0.5 * L.driverScale, L.seat[1] + 0.48 * L.driverScale, false);
  sw.rotation.x = -0.55;
  tilt.add(sw);

  // Nitro flames
  const flameMat = new THREE.MeshBasicMaterial({ color: '#ffb02e', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  const flameGeo = geo('flame', () => {
    const g = new THREE.ConeGeometry(0.17, 1.1, seg(16));
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0, -0.55);
    return g;
  });
  const flames = L.exhaust.map((p) => {
    const f = new THREE.Mesh(flameGeo, flameMat);
    f.position.copy(p);
    f.visible = false;
    tilt.add(f);
    return f;
  });

  // Shield bubble sized to the footprint
  const shield = new THREE.Mesh(
    geo('shield', () => new THREE.SphereGeometry(1, seg(28), seg(18))),
    new THREE.MeshBasicMaterial({ color: '#7fe9ff', transparent: true, opacity: 0.22, depthWrite: false }),
  );
  const height = Math.max(1.6, L.top * 0.85);
  shield.scale.set(cfg.halfWidth + 0.5, height * 0.75, cfg.halfLength + 0.5);
  shield.position.y = height * 0.5;
  shield.visible = false;
  tilt.add(shield);

  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).receiveShadow = false;
  });
  const gunMount = new THREE.Group();
  gunMount.position.set(0, L.gun[0], L.gun[1]);
  tilt.add(gunMount);
  const parts: CarParts = {
    root, tilt, body, wheels, frontWheels, wheelRadius: L.R, flames, shield, driverSeat, rig,
    mats: { main, sec, wheel: wheelMat, dark }, looseParts: loose, exhaust: L.exhaust, hood: L.hood,
    gunMount, gun: null, topY: L.top,
  };
  if (app.weapon) setCarGun(parts, app.weapon);
  return parts;
}

export function disposeCar(parts: CarParts) {
  // Geometries are shared/cached; only per-car materials need disposal.
  const seen = new Set<THREE.Material>();
  parts.root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    for (const mm of Array.isArray(m) ? m : [m]) if (!seen.has(mm)) { seen.add(mm); mm.dispose(); }
  });
}

export function makeNameTag(text: string, color = '#ffffff') {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = '900 30px Nunito, system-ui, sans-serif';
  const w = Math.min(240, ctx.measureText(text).width + 28);
  ctx.fillStyle = 'rgba(20,22,48,0.72)';
  const x = (256 - w) / 2;
  ctx.beginPath();
  ctx.roundRect(x, 10, w, 44, 22);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 33, 230);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }));
  sprite.scale.set(4, 1, 1);
  return sprite;
}

