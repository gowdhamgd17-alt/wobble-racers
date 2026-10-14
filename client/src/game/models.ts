// Procedural low-poly cars and drivers. Everything is built from primitives,
// so there are no external model files.

import * as THREE from 'three';
import { characterInfo, colorHex, type Appearance } from '@wobble/shared';

const geoCache = new Map<string, THREE.BufferGeometry>();
function geo<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let g = geoCache.get(key);
  if (!g) { g = make(); geoCache.set(key, g); }
  return g as T;
}
const box = (w: number, h: number, d: number) => geo(`box${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
const cyl = (rt: number, rb: number, h: number, seg = 8) => geo(`cyl${rt},${rb},${h},${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg));
const ico = (r: number, detail = 0) => geo(`ico${r},${detail}`, () => new THREE.IcosahedronGeometry(r, detail));
const cone = (r: number, h: number, seg = 6) => geo(`cone${r},${h},${seg}`, () => new THREE.ConeGeometry(r, h, seg));
const torus = (r: number, t: number) => geo(`tor${r},${t}`, () => new THREE.TorusGeometry(r, t, 5, 10));

function mat(color: string | number, opts: THREE.MeshLambertMaterialParameters = {}) {
  return new THREE.MeshLambertMaterial({ color, flatShading: true, ...opts });
}
function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, cast = true) {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.castShadow = cast;
  return o;
}

// ------------------------------------------------------------------ characters

export interface CharacterRig {
  root: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  stars: THREE.Group;
  prop: THREE.Object3D | null; // glasses / ladle / antenna for gags
  id: string;
}

export function buildCharacter(id: string): CharacterRig {
  const info = characterInfo(id);
  const [skin, primary, accent] = info.palette;
  const root = new THREE.Group();
  const torso = new THREE.Group();
  root.add(torso);
  const head = new THREE.Group();
  head.position.y = 0.78;
  torso.add(head);

  const bodyMat = mat(primary);
  const skinMat = mat(skin);
  const accentMat = mat(accent);
  const dark = mat('#222233');

  torso.add(mesh(box(0.62, 0.62, 0.42), bodyMat, 0, 0.32, 0));
  const armL = new THREE.Group();
  const armR = new THREE.Group();
  armL.position.set(0.36, 0.55, 0);
  armR.position.set(-0.36, 0.55, 0);
  for (const a of [armL, armR]) {
    const arm = mesh(box(0.16, 0.5, 0.16), bodyMat, 0, -0.22, 0);
    const hand = mesh(ico(0.1), skinMat, 0, -0.5, 0);
    a.add(arm, hand);
    torso.add(a);
  }
  let prop: THREE.Object3D | null = null;

  if (id === 'bonk') {
    head.add(mesh(ico(0.34, 1), skinMat, 0, 0, 0));
    const hair = mat('#f1f1f1');
    for (const [x, y, z] of [[0.28, 0.12, -0.05], [-0.28, 0.12, -0.05], [0.18, 0.3, -0.12], [-0.18, 0.3, -0.12], [0, 0.32, -0.2]])
      head.add(mesh(ico(0.15), hair, x, y, z));
    const glasses = new THREE.Group();
    const rim = dark;
    const l = mesh(torus(0.13, 0.03), rim, 0.14, 0.04, 0.3);
    const r = mesh(torus(0.13, 0.03), rim, -0.14, 0.04, 0.3);
    const lens = mat('#bfe9ff', { transparent: true, opacity: 0.6 });
    glasses.add(l, r, mesh(cyl(0.11, 0.11, 0.02, 10), lens, 0.14, 0.04, 0.3).rotateX(Math.PI / 2), mesh(cyl(0.11, 0.11, 0.02, 10), lens, -0.14, 0.04, 0.3).rotateX(Math.PI / 2));
    head.add(glasses);
    head.add(mesh(ico(0.07), mat('#e7a17a'), 0, -0.06, 0.34)); // nose
    prop = glasses;
    torso.add(mesh(box(0.2, 0.3, 0.05), accentMat, 0, 0.42, 0.22)); // tie
  } else if (id === 'moo') {
    head.add(mesh(ico(0.34, 1), skinMat, 0, 0, 0));
    head.add(mesh(box(0.36, 0.2, 0.18), mat(accent), 0, -0.12, 0.3)); // snout
    head.add(mesh(ico(0.12), mat(primary), 0.18, 0.15, 0.22));
    head.add(mesh(ico(0.1), mat(primary), -0.2, -0.02, 0.2));
    const horn = mat('#f5e6c4');
    head.add(mesh(cone(0.07, 0.25), horn, 0.2, 0.33, 0).rotateZ(-0.4));
    head.add(mesh(cone(0.07, 0.25), horn, -0.2, 0.33, 0).rotateZ(0.4));
    head.add(mesh(box(0.22, 0.08, 0.12), skinMat, 0.38, 0.12, 0).rotateZ(-0.4));
    head.add(mesh(box(0.22, 0.08, 0.12), skinMat, -0.38, 0.12, 0).rotateZ(0.4));
    for (const x of [0.12, -0.12]) head.add(mesh(ico(0.05), dark, x, 0.08, 0.31));
    torso.children[0] && ((torso.children[0] as THREE.Mesh).material = skinMat);
    torso.add(mesh(ico(0.13), mat(primary), 0.15, 0.4, 0.2));
  } else if (id === 'zip') {
    head.add(mesh(box(0.56, 0.44, 0.48), mat(skin), 0, 0, 0));
    head.add(mesh(box(0.46, 0.14, 0.05), mat(accent, { emissive: accent, emissiveIntensity: 0.7 }), 0, 0.03, 0.25));
    const antenna = new THREE.Group();
    antenna.position.y = 0.22;
    antenna.add(mesh(cyl(0.02, 0.02, 0.35, 5), dark, 0, 0.17, 0));
    antenna.add(mesh(ico(0.08), mat(primary, { emissive: primary, emissiveIntensity: 0.5 }), 0, 0.37, 0));
    head.add(antenna);
    prop = antenna;
    (torso.children[0] as THREE.Mesh).material = mat(skin);
  } else {
    // pepper
    head.add(mesh(ico(0.33, 1), skinMat, 0, 0, 0));
    const hat = mat('#ffffff');
    head.add(mesh(cyl(0.27, 0.24, 0.3, 10), hat, 0, 0.35, 0));
    head.add(mesh(ico(0.3), hat, 0, 0.55, 0));
    head.add(mesh(box(0.34, 0.07, 0.07), mat('#3a2418'), 0, -0.1, 0.31)); // mustache-ish brows
    for (const x of [0.12, -0.12]) head.add(mesh(ico(0.05), dark, x, 0.06, 0.3));
    torso.add(mesh(box(0.66, 0.12, 0.46), accentMat, 0, 0.58, 0)); // scarf
    const ladle = new THREE.Group();
    ladle.add(mesh(cyl(0.025, 0.025, 0.5, 5), mat('#c0c0c0'), 0, -0.6, 0.15));
    ladle.add(mesh(ico(0.09), mat('#c0c0c0'), 0, -0.86, 0.15));
    armR.add(ladle);
    prop = ladle;
  }

  const stars = new THREE.Group();
  stars.position.y = 0.45;
  const starMat = new THREE.MeshBasicMaterial({ color: '#ffe14d' });
  for (let i = 0; i < 3; i++) {
    const s = mesh(new THREE.OctahedronGeometry(0.08), starMat, Math.cos((i / 3) * Math.PI * 2) * 0.45, 0, Math.sin((i / 3) * Math.PI * 2) * 0.45, false);
    stars.add(s);
  }
  stars.visible = false;
  head.add(stars);
  return { root, torso, head, armL, armR, stars, prop, id };
}

export interface AnimInput {
  t: number;
  steer: number;
  speed: number;
  drifting: boolean;
  boosting: boolean;
  airborne: boolean;
  countdown: boolean;
  finished: boolean;
  won: boolean;
  idle: boolean; // garage/lobby preview
}

/** Procedural animation with short "reaction" overrides triggered by game events. */
export class CharacterAnimator {
  reaction: 'none' | 'shock' | 'dizzy' | 'laugh' | 'wave' | 'gag' | 'yawn' = 'none';
  reactionT = 0;
  private gagTimer = 3 + Math.random() * 4;
  constructor(public rig: CharacterRig) {}

  react(r: CharacterAnimator['reaction'], dur: number) {
    // dizzy/shock beat laugh/wave
    const pri = { none: 0, yawn: 1, gag: 1, wave: 2, laugh: 2, shock: 3, dizzy: 4 } as const;
    if (this.reactionT > 0 && pri[r] < pri[this.reaction]) return;
    this.reaction = r;
    this.reactionT = dur;
  }

  update(dt: number, a: AnimInput) {
    const { torso, head, armL, armR, stars, prop } = this.rig;
    this.reactionT = Math.max(0, this.reactionT - dt);
    if (this.reactionT === 0) this.reaction = 'none';
    const t = a.t;

    if ((a.idle || a.countdown) && this.reaction === 'none') {
      this.gagTimer -= dt;
      if (this.gagTimer <= 0) {
        this.gagTimer = 4 + Math.random() * 5;
        this.react(Math.random() < 0.3 ? 'yawn' : Math.random() < 0.5 ? 'wave' : 'gag', 1.6);
      }
    }

    // Base driving pose
    let lean = -a.steer * 0.22 + (a.drifting ? -a.steer * 0.25 : 0);
    let pitch = a.boosting ? -0.25 : 0;
    let headX = a.boosting ? -0.2 : 0;
    let headY = a.steer * 0.25;
    let headZ = 0;
    let armLx = -1.15, armRx = -1.15, armLz = 0.15 + a.steer * 0.25, armRz = -0.15 + a.steer * 0.25;
    let bob = Math.sin(t * (a.idle ? 2 : 14)) * (a.idle ? 0.02 : 0.015 * Math.min(1, a.speed / 20));
    stars.visible = false;

    if (a.countdown) {
      // Start-line anticipation: bouncing in the seat, gripping the wheel
      bob = Math.abs(Math.sin(t * 9)) * 0.06;
      pitch = 0.12;
    }
    if (a.airborne) {
      // Airborne panic: arms up, head shaking
      armLx = -2.8 + Math.sin(t * 22) * 0.4;
      armRx = -2.8 + Math.cos(t * 22) * 0.4;
      armLz = 0.5;
      armRz = -0.5;
      headY = Math.sin(t * 25) * 0.4;
      headX = -0.3;
    }
    if (a.finished) {
      if (a.won) {
        armLx = -3 + Math.sin(t * 10) * 0.4;
        armRx = -3 + Math.sin(t * 10 + Math.PI) * 0.4;
        armLz = 0.4; armRz = -0.4;
        bob = Math.abs(Math.sin(t * 6)) * 0.12;
        headY = Math.sin(t * 3) * 0.3;
      } else {
        pitch = 0.35;
        headX = 0.45;
        armLx = -0.6; armRx = -0.6;
        bob = Math.sin(t * 1.5) * 0.02;
      }
    }
    switch (this.reaction) {
      case 'shock':
        headX = -0.45;
        armLx = -2.2; armRx = -2.2; armLz = 0.9; armRz = -0.9;
        lean += Math.sin(t * 40) * 0.08;
        break;
      case 'dizzy':
        headZ = Math.sin(t * 7) * 0.35;
        headX = Math.cos(t * 7) * 0.25;
        lean += Math.sin(t * 3.5) * 0.15;
        stars.visible = true;
        stars.rotation.y = t * 6;
        break;
      case 'laugh':
        headX = -0.35 + Math.abs(Math.sin(t * 18)) * 0.25;
        bob = Math.abs(Math.sin(t * 18)) * 0.05;
        armRx = -1.6; armRz = -0.6 + Math.sin(t * 18) * 0.2;
        break;
      case 'wave':
        armRx = -2.9; armRz = -0.3 + Math.sin(t * 14) * 0.5;
        headY = -0.4;
        break;
      case 'yawn':
        armLx = -3; armRx = -3; armLz = -0.3; armRz = 0.3;
        headX = -0.5;
        break;
      case 'gag':
        if (this.rig.id === 'bonk') {
          armRx = -2.6; armRz = 0.9; // adjust glasses
          if (prop) prop.position.y = Math.sin(t * 20) * 0.03;
        } else if (this.rig.id === 'zip') {
          if (prop) prop.rotation.z = Math.sin(t * 25) * 0.6;
        } else if (this.rig.id === 'pepper') {
          armRx = -2.8; armRz = Math.sin(t * 12) * 0.7; // wave ladle
        } else {
          headX = -0.35 + Math.abs(Math.sin(t * 16)) * 0.3; // moo giggle
        }
        break;
    }
    if (this.reaction !== 'gag' && prop) { prop.position.y *= 0.9; prop.rotation.z *= 0.9; }

    const k = Math.min(1, dt * 12);
    torso.rotation.z += (lean - torso.rotation.z) * k;
    torso.rotation.x += (pitch - torso.rotation.x) * k;
    torso.position.y = bob;
    head.rotation.x += (headX - head.rotation.x) * k;
    head.rotation.y += (headY - head.rotation.y) * k;
    head.rotation.z += (headZ - head.rotation.z) * k;
    armL.rotation.x += (armLx - armL.rotation.x) * k;
    armR.rotation.x += (armRx - armR.rotation.x) * k;
    armL.rotation.z += (armLz - armL.rotation.z) * k;
    armR.rotation.z += (armRz - armR.rotation.z) * k;
  }
}

// ------------------------------------------------------------------ cars

export interface CarParts {
  root: THREE.Group; // position + yaw
  tilt: THREE.Group; // pitch / roll
  body: THREE.Group;
  wheels: THREE.Group[];
  frontWheels: THREE.Group[];
  flames: THREE.Mesh[];
  shield: THREE.Mesh;
  driverSeat: THREE.Group;
  rig: CharacterRig;
  mats: { main: THREE.MeshLambertMaterial; sec: THREE.MeshLambertMaterial; wheel: THREE.MeshLambertMaterial; dark: THREE.MeshLambertMaterial };
  looseParts: THREE.Object3D[]; // bits that dangle when damaged
  exhaust: THREE.Vector3[]; // local exhaust points
  hood: THREE.Vector3; // local smoke point
}

function buildWheel(style: string, wheelMat: THREE.Material, tireMat: THREE.Material, r: number, w: number) {
  const g = new THREE.Group();
  const spin = new THREE.Group();
  g.add(spin);
  const tire = mesh(cyl(r, r, w, style === 'chunky' ? 8 : 10), tireMat);
  tire.rotation.z = Math.PI / 2;
  spin.add(tire);
  const hub = mesh(cyl(r * 0.55, r * 0.55, w + 0.02, 8), wheelMat);
  hub.rotation.z = Math.PI / 2;
  spin.add(hub);
  if (style === 'spoke') {
    for (let i = 0; i < 3; i++) {
      const s = mesh(box(w + 0.04, r * 1.5, 0.08), wheelMat);
      s.rotation.x = (i / 3) * Math.PI;
      spin.add(s);
    }
  } else if (style === 'chunky') {
    const ring = mesh(torus(r * 0.95, 0.07), tireMat);
    ring.rotation.y = Math.PI / 2;
    spin.add(ring);
  }
  return { g, spin };
}

export function buildCar(app: Appearance): CarParts {
  const root = new THREE.Group();
  const tilt = new THREE.Group();
  root.add(tilt);
  const body = new THREE.Group();
  tilt.add(body);
  const main = mat(colorHex(app.colorMain));
  const sec = mat(colorHex(app.colorSecondary));
  const wheel = mat(colorHex(app.colorWheel));
  const dark = mat('#2a2a33');
  const glass = mat('#9fd8ff', { transparent: true, opacity: 0.55 });
  const tire = mat('#1a1a1f');
  const loose: THREE.Object3D[] = [];
  let wheelR = 0.45, wheelW = 0.36, track = 0.98, wheelZ = 1.35;
  let seatY = 0.7, seatZ = -0.2;
  const exhaust: THREE.Vector3[] = [];
  const hood = new THREE.Vector3(0, 0.9, 1.4);

  if (app.carClass === 'speedster') {
    wheelR = 0.42; wheelW = 0.32; track = 0.95; wheelZ = 1.45;
    body.add(mesh(box(1.7, 0.42, 4.2), main, 0, 0.55, 0));
    const nose = mesh(box(1.5, 0.3, 1.2), main, 0, 0.5, 2.3);
    nose.rotation.x = 0.25;
    body.add(nose);
    body.add(mesh(box(1.9, 0.12, 0.5), sec, 0, 0.42, 2.75)); // front wing
    loose.push(body.children[body.children.length - 1]);
    body.add(mesh(box(0.2, 0.5, 0.2), dark, 0.6, 1.0, -1.85), mesh(box(0.2, 0.5, 0.2), dark, -0.6, 1.0, -1.85));
    const wing = mesh(box(2.0, 0.1, 0.6), sec, 0, 1.28, -1.9);
    body.add(wing);
    loose.push(wing);
    body.add(mesh(box(0.25, 0.08, 3.6), sec, 0, 0.78, 0.2)); // stripe
    seatY = 0.55; seatZ = -0.35;
    exhaust.push(new THREE.Vector3(0.35, 0.55, -2.2), new THREE.Vector3(-0.35, 0.55, -2.2));
    hood.set(0, 0.8, 1.6);
  } else if (app.carClass === 'bruiser') {
    wheelR = 0.6; wheelW = 0.5; track = 1.12; wheelZ = 1.4;
    body.add(mesh(box(2.2, 0.8, 4.0), main, 0, 0.95, 0));
    // Open-top cab with a roll cage so the driver is visible
    body.add(mesh(box(0.14, 0.75, 0.14), dark, 0.95, 1.72, 0.5), mesh(box(0.14, 0.75, 0.14), dark, -0.95, 1.72, 0.5));
    body.add(mesh(box(2.04, 0.14, 0.14), dark, 0, 2.1, 0.5));
    body.add(mesh(box(1.9, 0.55, 0.05), glass, 0, 1.75, 0.5));
    body.add(mesh(box(0.14, 1.1, 0.14), dark, 0.95, 1.9, -1.45), mesh(box(0.14, 1.1, 0.14), dark, -0.95, 1.9, -1.45));
    body.add(mesh(box(2.04, 0.16, 0.16), sec, 0, 2.45, -1.45));
        const bar = mesh(box(2.3, 0.35, 0.3), dark, 0, 0.75, 2.15);
    body.add(bar);
    loose.push(bar);
    body.add(mesh(box(2.2, 0.15, 4.05), sec, 0, 1.22, 0)); // stripe
    for (const x of [-0.6, -0.2, 0.2, 0.6]) body.add(mesh(box(0.22, 0.16, 0.16), mat('#ffe36b', { emissive: '#ffcc00', emissiveIntensity: 0.4 }), x, 2.62, -1.45));
    seatY = 1.2; seatZ = -0.55;
    exhaust.push(new THREE.Vector3(1.17, 2.0, -1.0), new THREE.Vector3(-1.17, 2.0, -1.0));
    body.add(mesh(cyl(0.1, 0.1, 1.2, 6), dark, 1.17, 1.5, -1.0), mesh(cyl(0.1, 0.1, 1.2, 6), dark, -1.17, 1.5, -1.0));
    hood.set(0, 1.4, 1.5);
  } else {
    // drifter
    body.add(mesh(box(1.9, 0.55, 3.9), main, 0, 0.7, 0));
    body.add(mesh(box(2.1, 0.35, 1.0), main, 0, 0.62, 1.35)); // wide fenders
    body.add(mesh(box(2.1, 0.35, 1.0), main, 0, 0.62, -1.35));
    const tail = mesh(box(1.8, 0.12, 0.5), sec, 0, 1.08, -1.9);
    tail.rotation.x = -0.3;
    body.add(tail);
    loose.push(tail);
    body.add(mesh(box(1.9, 0.08, 0.3), sec, 0, 0.99, 1.85));
    const bumper = mesh(box(1.95, 0.25, 0.25), dark, 0, 0.5, 2.0);
    body.add(bumper);
    loose.push(bumper);
    seatY = 0.75; seatZ = -0.25;
    exhaust.push(new THREE.Vector3(0.5, 0.5, -2.0));
    hood.set(0, 1.0, 1.5);
  }
  // Headlights
  const lightMat = mat('#fff7cc', { emissive: '#fff2a0', emissiveIntensity: 0.6 });
  const front = app.carClass === 'speedster' ? 2.85 : 2.0;
  body.add(mesh(box(0.35, 0.18, 0.06), lightMat, 0.6, app.carClass === 'bruiser' ? 1.05 : 0.65, front, false));
  body.add(mesh(box(0.35, 0.18, 0.06), lightMat, -0.6, app.carClass === 'bruiser' ? 1.05 : 0.65, front, false));
  // Steering wheel
  body.add(mesh(torus(0.18, 0.04), dark, 0, seatY + 0.55, seatZ + 0.6).rotateX(-0.6));

  const wheels: THREE.Group[] = [];
  const frontWheels: THREE.Group[] = [];
  for (const [x, z] of [[track, wheelZ], [-track, wheelZ], [track, -wheelZ], [-track, -wheelZ]]) {
    const w = buildWheel(app.wheelStyle, wheel, tire, wheelR, wheelW);
    w.g.position.set(x, wheelR, z);
    tilt.add(w.g);
    wheels.push(w.spin as THREE.Group);
    if (z > 0) frontWheels.push(w.g);
  }

  const driverSeat = new THREE.Group();
  driverSeat.position.set(0, seatY, seatZ);
  const rig = buildCharacter(app.character);
  driverSeat.add(rig.root);
  rig.root.scale.setScalar(app.carClass === 'bruiser' ? 1.1 : 1.0);
  tilt.add(driverSeat);

  const flameMat = new THREE.MeshBasicMaterial({ color: '#ffb02e', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  const flames: THREE.Mesh[] = exhaust.map((p) => {
    const f = new THREE.Mesh(cone(0.18, 1.0, 6), flameMat);
    f.rotation.x = -Math.PI / 2;
    f.position.copy(p).add(new THREE.Vector3(0, 0, -0.5));
    f.visible = false;
    tilt.add(f);
    return f;
  });

  const shield = new THREE.Mesh(
    geo('shield', () => new THREE.IcosahedronGeometry(2.7, 1)),
    new THREE.MeshBasicMaterial({ color: '#7fe9ff', transparent: true, opacity: 0.22, wireframe: false, depthWrite: false }),
  );
  shield.position.y = 1;
  shield.scale.set(1, 0.65, 1.15);
  shield.visible = false;
  tilt.add(shield);

  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).receiveShadow = false; });
  return { root, tilt, body, wheels, frontWheels, flames, shield, driverSeat, rig, mats: { main, sec, wheel, dark }, looseParts: loose, exhaust, hood };
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
