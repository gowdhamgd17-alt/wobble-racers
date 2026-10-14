// Eight procedural, smooth-shaded drivers. Each shares one simple rig
// (torso, head, two arm pivots, a "prop" for gags, dizzy stars) so a single
// animator drives them all. Origin = seat (hips); +z faces forward.

import * as THREE from 'three';
import { characterInfo } from '@wobble/shared';
import { capsule, cone, cyl, darkTrim, glass, glow, halfSphere, lathe, mesh, rbox, sphere, std, torus, tube, chrome } from './kit';

export interface CharacterRig {
  root: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  stars: THREE.Group;
  prop: THREE.Object3D | null;
  id: string;
}

const skinMat = (c: string) => std(c, 0.55, 0);
const cloth = (c: string) => std(c, 0.8, 0);

function eyes(head: THREE.Object3D, y: number, z: number, spread: number, r = 0.075, look = 0) {
  const white = std('#ffffff', 0.25);
  const black = std('#15161c', 0.2);
  const shine = std('#ffffff', 0.1, 0, { emissive: '#ffffff', emissiveIntensity: 0.6 });
  for (const s of [-1, 1]) {
    const e = new THREE.Group();
    e.position.set(s * spread, y, z);
    e.add(mesh(sphere(r), white));
    const p = mesh(sphere(r * 0.52), black, look * r * 0.3, 0, r * 0.62);
    e.add(p);
    e.add(mesh(sphere(r * 0.16), shine, r * 0.2, r * 0.25, r * 0.95, false));
    head.add(e);
  }
}

function smile(head: THREE.Object3D, y: number, z: number, w = 0.09, color = '#7a2b2b') {
  const m = mesh(torus(w, 0.016, Math.PI), std(color, 0.5), 0, y, z, false);
  m.rotation.z = Math.PI;
  head.add(m);
}

function arms(torso: THREE.Group, sleeve: THREE.Material, hand: THREE.Material, scale = 1, shoulderY = 0.55, shoulderX = 0.33) {
  const armL = new THREE.Group();
  const armR = new THREE.Group();
  armL.position.set(shoulderX, shoulderY, 0);
  armR.position.set(-shoulderX, shoulderY, 0);
  for (const a of [armL, armR]) {
    a.add(mesh(capsule(0.075 * scale, 0.3 * scale), sleeve, 0, -0.2 * scale, 0));
    a.add(mesh(sphere(0.09 * scale), hand, 0, -0.44 * scale, 0));
    torso.add(a);
  }
  return { armL, armR };
}

function base(id: string) {
  const root = new THREE.Group();
  const torso = new THREE.Group();
  root.add(torso);
  const head = new THREE.Group();
  head.position.y = 0.8;
  torso.add(head);
  return { root, torso, head, id };
}

function body(torso: THREE.Group, m: THREE.Material, w = 1, h = 1) {
  const b = mesh(capsule(0.26, 0.26), m, 0, 0.36, 0);
  b.scale.set(1.12 * w, 1 * h, 0.9);
  torso.add(b);
  return b;
}

function stars(head: THREE.Group) {
  const g = new THREE.Group();
  g.position.y = 0.5;
  const m = glow('#ffe14d', 0.8);
  const star = new THREE.OctahedronGeometry(0.075, 0);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    g.add(mesh(star, m, Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45, false));
  }
  g.visible = false;
  head.add(g);
  return g;
}

export function buildCharacter(id: string): CharacterRig {
  const info = characterInfo(id);
  const [c1, c2, c3] = info.palette;
  const b = base(info.id);
  const { torso, head } = b;
  let prop: THREE.Object3D | null = null;
  let armsRig: { armL: THREE.Group; armR: THREE.Group };

  switch (info.id) {
    case 'bonk': {
      const skin = skinMat(c1);
      body(torso, cloth('#f4f4f4'));
      // bow tie
      for (const s of [-1, 1]) {
        const t = mesh(cone(0.06, 0.12), cloth(c3), s * 0.06, 0.6, 0.22);
        t.rotation.z = (s * Math.PI) / 2;
        torso.add(t);
      }
      armsRig = arms(torso, cloth('#f4f4f4'), skin);
      const h = mesh(sphere(0.32), skin);
      h.scale.set(1, 1.06, 1);
      head.add(h);
      const hair = std('#f2f2f2', 0.9);
      for (const [x, y, z, r] of [[0.27, 0.06, -0.06, 0.13], [-0.27, 0.06, -0.06, 0.13], [0.2, 0.2, -0.16, 0.12], [-0.2, 0.2, -0.16, 0.12], [0, 0.18, -0.26, 0.14], [0.12, 0.27, -0.2, 0.09], [-0.12, 0.27, -0.2, 0.09]] as const)
        head.add(mesh(sphere(r), hair, x, y, z));
      eyes(head, 0.05, 0.25, 0.12, 0.07);
      const glasses = new THREE.Group();
      for (const s of [-1, 1]) {
        glasses.add(mesh(torus(0.11, 0.016), darkTrim(), s * 0.13, 0.05, 0.31));
        const lens = mesh(cyl(0.1, 0.1, 0.01, 24), glass(), s * 0.13, 0.05, 0.31, false);
        lens.rotation.x = Math.PI / 2;
        glasses.add(lens);
      }
      glasses.add(mesh(cyl(0.012, 0.012, 0.06), darkTrim(), 0, 0.07, 0.32).rotateZ(Math.PI / 2));
      head.add(glasses);
      prop = glasses;
      head.add(mesh(sphere(0.06), skinMat('#e8a37d'), 0, -0.04, 0.33));
      for (const s of [-1, 1]) {
        const m = mesh(sphere(0.07), hair, s * 0.06, -0.11, 0.29);
        m.scale.set(1.3, 0.55, 0.7);
        head.add(m);
      }
      break;
    }
    case 'moo': {
      const white = skinMat(c1), black = std(c2, 0.6), pink = skinMat(c3);
      const torsoMesh = body(torso, white);
      for (const [x, y, z] of [[0.15, 0.45, 0.2], [-0.2, 0.3, 0.16]] as const) {
        const spot = mesh(sphere(0.1), black, x, y, z);
        spot.scale.set(1, 0.8, 0.5);
        torso.add(spot);
      }
      void torsoMesh;
      armsRig = arms(torso, white, black);
      const h = mesh(sphere(0.31), white);
      h.scale.set(1.05, 0.95, 1);
      head.add(h);
      const muzzle = mesh(sphere(0.2), pink, 0, -0.1, 0.22);
      muzzle.scale.set(1.25, 0.8, 0.85);
      head.add(muzzle);
      for (const s of [-1, 1]) head.add(mesh(sphere(0.035), std('#7a3e4a', 0.6), s * 0.08, -0.08, 0.38));
      const patch = mesh(sphere(0.14), black, 0.16, 0.12, 0.16);
      patch.scale.set(1, 0.9, 0.6);
      head.add(patch);
      eyes(head, 0.08, 0.24, 0.12, 0.07);
      const horn = std('#f3e5c0', 0.4);
      for (const s of [-1, 1]) {
        head.add(mesh(tube(`horn${s}`, [[s * 0.18, 0.22, 0], [s * 0.3, 0.32, 0], [s * 0.34, 0.45, 0.02]], 0.035), horn));
        const ear = mesh(sphere(0.09), white, s * 0.36, 0.08, -0.02);
        ear.scale.set(1.5, 0.5, 0.8);
        head.add(ear);
      }
      smile(head, -0.16, 0.36, 0.07);
      // cowbell on a collar
      const bell = new THREE.Group();
      bell.position.set(0, 0.6, 0.24);
      bell.add(mesh(lathe('bell', [[0, 0], [0.07, 0], [0.065, 0.03], [0.05, 0.08], [0.03, 0.11], [0, 0.12]]), std('#e8b923', 0.25, 0.9), 0, -0.12, 0));
      torso.add(mesh(torus(0.2, 0.02), std('#b83b3b', 0.6), 0, 0.62, 0).rotateX(Math.PI / 2));
      torso.add(bell);
      prop = bell;
      break;
    }
    case 'zip': {
      const metal = std(c1, 0.3, 0.8);
      const yellow = std(c2, 0.4, 0.3);
      const torsoMesh = mesh(rbox(0.5, 0.5, 0.36, 0.08), metal, 0, 0.36, 0);
      torso.add(torsoMesh);
      torso.add(mesh(rbox(0.26, 0.16, 0.04, 0.02), glow(c3, 0.8), 0, 0.4, 0.18));
      armsRig = arms(torso, metal, yellow);
      head.add(mesh(rbox(0.56, 0.44, 0.46, 0.1), metal));
      head.add(mesh(rbox(0.46, 0.18, 0.06, 0.05), std('#10131a', 0.2, 0.2), 0, 0.03, 0.22));
      for (const s of [-1, 1]) head.add(mesh(sphere(0.045), glow(c3, 1.5), s * 0.1, 0.03, 0.26, false));
      for (const s of [-1, 1]) head.add(mesh(cyl(0.06, 0.06, 0.06), yellow, s * 0.3, 0, 0).rotateZ(Math.PI / 2));
      const antenna = new THREE.Group();
      antenna.position.y = 0.22;
      antenna.add(mesh(cyl(0.015, 0.015, 0.3), darkTrim(), 0, 0.15, 0));
      antenna.add(mesh(sphere(0.06), glow(c2, 1), 0, 0.32, 0));
      head.add(antenna);
      prop = antenna;
      break;
    }
    case 'pepper': {
      const skin = skinMat(c1);
      body(torso, cloth(c2));
      torso.add(mesh(torus(0.2, 0.06), cloth(c3), 0, 0.62, 0).rotateX(Math.PI / 2));
      for (let i = 0; i < 3; i++) torso.add(mesh(sphere(0.025), std('#333', 0.4), 0, 0.48 - i * 0.12, 0.25));
      armsRig = arms(torso, cloth(c2), skin);
      head.add(mesh(sphere(0.3), skin));
      eyes(head, 0.06, 0.23, 0.11, 0.065);
      head.add(mesh(sphere(0.05), skinMat('#d9805d'), 0, -0.03, 0.3));
      const stache = std('#3a2418', 0.7);
      for (const s of [-1, 1]) head.add(mesh(tube(`stache${s}`, [[0, -0.09, 0.3], [s * 0.1, -0.11, 0.29], [s * 0.18, -0.06, 0.24], [s * 0.2, 0.01, 0.2]], 0.025), stache));
      const hatMat = cloth('#ffffff');
      head.add(mesh(cyl(0.26, 0.24, 0.22, 28), hatMat, 0, 0.32, 0));
      for (const [x, z] of [[0, 0], [0.14, 0.08], [-0.14, 0.08], [0.12, -0.12], [-0.12, -0.12], [0, 0.16], [0, -0.16]] as const)
        head.add(mesh(sphere(0.15), hatMat, x, 0.52, z));
      const ladle = new THREE.Group();
      ladle.add(mesh(cyl(0.018, 0.018, 0.5), chrome(), 0, -0.66, 0.12));
      const bowl = mesh(halfSphere(0.09), chrome(), 0, -0.92, 0.12);
      bowl.rotation.x = Math.PI;
      ladle.add(bowl);
      armsRig.armR.add(ladle);
      prop = ladle;
      break;
    }
    case 'rex': {
      const green = skinMat(c1), belly = skinMat(c2), dark = skinMat(c3);
      body(torso, green, 1.05, 1.05);
      const b2 = mesh(sphere(0.2), belly, 0, 0.32, 0.12);
      b2.scale.set(1, 1.2, 0.6);
      torso.add(b2);
      armsRig = arms(torso, green, green, 0.5, 0.48, 0.28); // tiny arms!
      const h = mesh(sphere(0.3), green);
      h.scale.set(1, 0.9, 1.15);
      head.add(h);
      const snout = mesh(sphere(0.22), green, 0, -0.06, 0.24);
      snout.scale.set(1, 0.75, 1.1);
      head.add(snout);
      const tooth = std('#ffffff', 0.3);
      for (let i = -2; i <= 2; i++) {
        const t = mesh(cone(0.022, 0.06), tooth, i * 0.05, -0.17, 0.4 - Math.abs(i) * 0.02);
        t.rotation.x = Math.PI;
        head.add(t);
      }
      for (const s of [-1, 1]) head.add(mesh(sphere(0.025), dark, s * 0.06, 0.0, 0.46));
      eyes(head, 0.14, 0.12, 0.14, 0.075);
      const spikes = new THREE.Group();
      const spikeMat = std(c2, 0.5);
      for (let i = 0; i < 5; i++) {
        const sp = mesh(cone(0.06 - i * 0.006, 0.14), spikeMat, 0, 0.26 - i * 0.07, -0.05 - i * 0.09);
        sp.rotation.x = -0.5 - i * 0.2;
        spikes.add(sp);
      }
      head.add(spikes);
      prop = spikes;
      break;
    }
    case 'luna': {
      const suit = cloth(c1), accent = cloth(c2);
      body(torso, suit, 1.05);
      torso.add(mesh(rbox(0.42, 0.5, 0.2, 0.06), suit, 0, 0.4, -0.27));
      for (const s of [-1, 1]) torso.add(mesh(sphere(0.07), accent, s * 0.3, 0.58, 0.04));
      torso.add(mesh(rbox(0.18, 0.12, 0.04, 0.02), glow('#4cf0a0', 0.7), 0, 0.44, 0.24));
      armsRig = arms(torso, suit, cloth('#d9d9e3'), 1.05);
      head.add(mesh(sphere(0.22), skinMat('#c98e6b'), 0, -0.02, 0));
      const hair = std('#2a1d16', 0.8);
      const bun = mesh(sphere(0.12), hair, 0, 0.12, -0.12);
      head.add(bun);
      eyes(head, 0.02, 0.18, 0.08, 0.055);
      smile(head, -0.08, 0.2, 0.05);
      head.add(mesh(sphere(0.38), glass()));
      head.add(mesh(torus(0.3, 0.05), suit, 0, -0.28, 0).rotateX(Math.PI / 2));
      const visor = new THREE.Group();
      visor.position.set(0, 0.0, 0);
      const vMesh = mesh(sphere(0.385), std(c2, 0.08, 1, { transparent: true, opacity: 0.55 }));
      vMesh.scale.set(1, 0.45, 1);
      vMesh.position.y = 0.2;
      visor.add(vMesh);
      head.add(visor);
      prop = visor;
      head.add(mesh(cyl(0.012, 0.012, 0.2), darkTrim(), 0.24, 0.32, -0.05));
      head.add(mesh(sphere(0.03), glow('#ff4040', 1.5), 0.24, 0.43, -0.05, false));
      break;
    }
    case 'gramps': {
      const skin = skinMat(c1);
      body(torso, cloth(c2));
      for (let i = 0; i < 3; i++) torso.add(mesh(sphere(0.022), std('#e8d6a8', 0.4), 0, 0.5 - i * 0.12, 0.26));
      armsRig = arms(torso, cloth(c2), skin);
      head.add(mesh(sphere(0.3), skin));
      const white = std(c3, 0.9);
      for (const [x, y, z, r] of [[0, -0.2, 0.16, 0.16], [0.12, -0.14, 0.18, 0.11], [-0.12, -0.14, 0.18, 0.11], [0, -0.3, 0.12, 0.11]] as const)
        head.add(mesh(sphere(r), white, x, y, z));
      for (const s of [-1, 1]) {
        const brow = mesh(capsule(0.025, 0.08), white, s * 0.11, 0.14, 0.26);
        brow.rotation.z = Math.PI / 2 + s * 0.3;
        head.add(brow);
      }
      eyes(head, 0.06, 0.24, 0.11, 0.055);
      head.add(mesh(sphere(0.065), skinMat('#e19d84'), 0, -0.02, 0.3));
      for (const s of [-1, 1]) {
        head.add(mesh(torus(0.075, 0.01), chrome(), s * 0.11, 0.06, 0.29));
      }
      const cap = new THREE.Group();
      const capMat = cloth('#6b7a5a');
      const top = mesh(sphere(0.31), capMat, 0, 0.1, -0.02);
      top.scale.set(1.02, 0.45, 1.05);
      cap.add(top);
      const brim = mesh(cyl(0.18, 0.2, 0.03, 24), capMat, 0, 0.12, 0.26);
      brim.scale.set(1, 1, 0.6);
      cap.add(brim);
      cap.position.y = 0.06;
      head.add(cap);
      prop = cap;
      break;
    }
    default: {
      // pip the penguin
      const black = std(c1, 0.5), white = std(c2, 0.5), orange = std(c3, 0.4);
      const bod = mesh(sphere(0.32), black, 0, 0.36, 0);
      bod.scale.set(1, 1.15, 0.95);
      torso.add(bod);
      const belly = mesh(sphere(0.26), white, 0, 0.32, 0.1);
      belly.scale.set(0.95, 1.1, 0.75);
      torso.add(belly);
      armsRig = { armL: new THREE.Group(), armR: new THREE.Group() };
      armsRig.armL.position.set(0.32, 0.5, 0);
      armsRig.armR.position.set(-0.32, 0.5, 0);
      for (const a of [armsRig.armL, armsRig.armR]) {
        const w = mesh(capsule(0.07, 0.3), black, 0, -0.2, 0);
        w.scale.set(0.5, 1, 1.2);
        a.add(w);
        torso.add(a);
      }
      head.position.y = 0.78;
      head.add(mesh(sphere(0.27), black));
      const face = mesh(sphere(0.22), white, 0, -0.02, 0.1);
      face.scale.set(1, 0.9, 0.8);
      head.add(face);
      eyes(head, 0.06, 0.24, 0.09, 0.06);
      const beak = mesh(cone(0.07, 0.18), orange, 0, -0.04, 0.33);
      beak.rotation.x = Math.PI / 2;
      head.add(beak);
      for (const s of [-1, 1]) head.add(mesh(sphere(0.04), std('#ff9db0', 0.6), s * 0.15, -0.07, 0.22));
      prop = beak;
      break;
    }
  }
  return { ...b, armL: armsRig.armL, armR: armsRig.armR, stars: stars(head), prop };
}
