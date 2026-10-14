// Ten roof-mounted weapon models, built from the same smooth primitives as
// the cars. Each model points down +z with its muzzle marked, so effects
// (muzzle flash, tracers, flames, rockets) start from the real barrel tip.

import * as THREE from 'three';
import { getWeapon } from '@wobble/shared';
import { capsule, chrome, cone, cyl, darkTrim, glow, mesh, rbox, sphere, std, torus, tube } from './kit';

export interface GunModel {
  group: THREE.Group;
  muzzle: THREE.Object3D; // world position of the barrel tip
  spin: THREE.Object3D | null; // minigun barrels
  recoil: THREE.Group; // moves back on each shot
  id: string;
}

const gunMetal = () => std('#33363f', 0.35, 0.85);
const blued = () => std('#1f2229', 0.3, 0.9);
const olive = () => std('#59633b', 0.6, 0.25);
const wood = () => std('#8a5a32', 0.55, 0.05);

const along = (g: THREE.Mesh) => { g.rotation.x = Math.PI / 2; return g; };

export function buildGun(id: string): GunModel {
  const w = getWeapon(id);
  const group = new THREE.Group();
  const recoil = new THREE.Group();
  group.add(recoil);
  // swivel pedestal shared by every gun
  group.add(mesh(cyl(0.2, 0.26, 0.16, 20), darkTrim(), 0, 0.08, 0));
  group.add(mesh(rbox(0.22, 0.2, 0.3, 0.05), gunMetal(), 0, 0.24, 0));
  const muzzle = new THREE.Object3D();
  let spin: THREE.Object3D | null = null;
  const R = recoil;
  const y = 0.42;
  switch (w.id) {
    case 'pistol': {
      R.add(mesh(rbox(0.16, 0.18, 0.62, 0.04), blued(), 0, y, 0.12));
      R.add(mesh(rbox(0.15, 0.12, 0.5, 0.03), gunMetal(), 0, y - 0.12, 0.08));
      R.add(along(mesh(cyl(0.035, 0.035, 0.2, 14), chrome(), 0, y + 0.02, 0.5)));
      R.add(mesh(rbox(0.12, 0.32, 0.16, 0.04), std('#2a2a2a', 0.8, 0), 0, y - 0.3, -0.08).rotateX(-0.25));
      R.add(mesh(rbox(0.03, 0.05, 0.03, 0.01), glow('#ffef9a', 0.8), 0, y + 0.11, 0.38));
      muzzle.position.set(0, y + 0.02, 0.62);
      break;
    }
    case 'smg': {
      R.add(mesh(rbox(0.18, 0.22, 0.7, 0.05), blued(), 0, y, 0.1));
      R.add(along(mesh(cyl(0.06, 0.06, 0.38, 16), gunMetal(), 0, y + 0.02, 0.62)));
      for (let i = 0; i < 5; i++) R.add(along(mesh(torus(0.062, 0.01), darkTrim(), 0, y + 0.02, 0.48 + i * 0.07)));
      R.add(mesh(rbox(0.09, 0.38, 0.12, 0.03), gunMetal(), 0, y - 0.28, 0.2));
      R.add(mesh(tube('smg-stock', [[0, y, -0.25], [0, y - 0.05, -0.5], [0, y - 0.15, -0.55]], 0.025), chrome()));
      muzzle.position.set(0, y + 0.02, 0.83);
      break;
    }
    case 'm4': {
      // receiver, handguard, barrel + flash hider, carry-handle optic, curved mag, stock
      R.add(mesh(rbox(0.15, 0.22, 0.62, 0.04), blued(), 0, y, 0));
      R.add(mesh(rbox(0.16, 0.18, 0.55, 0.05), std('#3c3f36', 0.7, 0.2), 0, y + 0.01, 0.56));
      for (let i = 0; i < 6; i++) R.add(mesh(rbox(0.17, 0.03, 0.05, 0.01), darkTrim(), 0, y + 0.1, 0.36 + i * 0.08));
      R.add(along(mesh(cyl(0.026, 0.026, 0.45, 12), chrome(), 0, y + 0.02, 1.05)));
      R.add(along(mesh(cyl(0.038, 0.034, 0.1, 12), blued(), 0, y + 0.02, 1.3)));
      R.add(mesh(rbox(0.04, 0.14, 0.04, 0.01), blued(), 0, y + 0.13, 0.86));
      R.add(along(mesh(cyl(0.045, 0.045, 0.32, 16), blued(), 0, y + 0.2, 0.02)));
      R.add(along(mesh(cyl(0.04, 0.04, 0.005, 16), glow('#7fd8ff', 0.6), 0, y + 0.2, 0.18)));
      const mag = mesh(rbox(0.08, 0.34, 0.14, 0.03), blued(), 0, y - 0.24, 0.12);
      mag.rotation.x = 0.28;
      R.add(mag);
      R.add(mesh(rbox(0.12, 0.2, 0.42, 0.05), std('#2c2e33', 0.7, 0.1), 0, y - 0.04, -0.48));
      muzzle.position.set(0, y + 0.02, 1.36);
      break;
    }
    case 'shotgun': {
      for (const s of [-1, 1]) {
        R.add(along(mesh(cyl(0.05, 0.05, 1.0, 16), blued(), s * 0.055, y + 0.04, 0.55)));
        R.add(along(mesh(torus(0.05, 0.012), chrome(), s * 0.055, y + 0.04, 1.05)));
      }
      R.add(mesh(rbox(0.22, 0.2, 0.4, 0.06), gunMetal(), 0, y, 0.0));
      R.add(mesh(rbox(0.2, 0.12, 0.36, 0.05), wood(), 0, y - 0.08, 0.4));
      R.add(mesh(rbox(0.16, 0.22, 0.5, 0.07), wood(), 0, y - 0.06, -0.42).rotateX(0.12));
      for (let i = 0; i < 3; i++) R.add(mesh(cyl(0.035, 0.035, 0.12, 12), std('#c81d25', 0.5, 0.2), 0.16, y - 0.02, -0.1 + i * 0.09).rotateZ(Math.PI / 2));
      muzzle.position.set(0, y + 0.04, 1.08);
      break;
    }
    case 'minigun': {
      const barrels = new THREE.Group();
      barrels.position.set(0, y + 0.02, 0.2);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        barrels.add(along(mesh(cyl(0.03, 0.03, 1.05, 10), blued(), Math.cos(a) * 0.085, Math.sin(a) * 0.085, 0.5)));
      }
      for (const z of [0.15, 0.6, 1.0]) barrels.add(along(mesh(cyl(0.13, 0.13, 0.05, 20), gunMetal(), 0, 0, z)));
      barrels.add(along(mesh(cyl(0.03, 0.03, 1.1, 10), chrome(), 0, 0, 0.5)));
      R.add(barrels);
      spin = barrels;
      R.add(mesh(rbox(0.3, 0.3, 0.4, 0.06), gunMetal(), 0, y, -0.05));
      R.add(along(mesh(cyl(0.11, 0.11, 0.3, 18), darkTrim(), 0, y + 0.02, -0.38)));
      R.add(mesh(rbox(0.26, 0.26, 0.36, 0.04), olive(), 0.34, y - 0.08, -0.1));
      R.add(mesh(tube('mini-belt', [[0.22, y + 0.04, -0.05], [0.12, y + 0.18, 0.02], [0.02, y + 0.1, 0.05]], 0.035), std('#c9a03a', 0.35, 0.8)));
      R.add(mesh(tube('mini-handle', [[-0.15, y + 0.15, -0.25], [-0.15, y + 0.32, -0.05], [-0.15, y + 0.15, 0.12]], 0.025), darkTrim()));
      muzzle.position.set(0, y + 0.02, 1.28);
      break;
    }
    case 'sniper': {
      R.add(mesh(rbox(0.14, 0.18, 0.7, 0.04), olive(), 0, y, 0.0));
      R.add(along(mesh(cyl(0.03, 0.03, 1.5, 12), blued(), 0, y + 0.03, 1.05)));
      R.add(along(mesh(cyl(0.06, 0.045, 0.16, 14), blued(), 0, y + 0.03, 1.82)));
      for (let i = 0; i < 4; i++) R.add(mesh(rbox(0.13, 0.02, 0.02, 0.005), darkTrim(), 0, y + 0.03, 1.78 + i * 0.03));
      // scope with glinting lens
      R.add(along(mesh(cyl(0.055, 0.055, 0.55, 18), blued(), 0, y + 0.2, 0.15)));
      R.add(along(mesh(cyl(0.08, 0.06, 0.12, 18), blued(), 0, y + 0.2, 0.45)));
      R.add(along(mesh(cyl(0.07, 0.07, 0.005, 18), glow('#8ff0ff', 1.2), 0, y + 0.2, 0.515)));
      for (const z of [-0.02, 0.32]) R.add(mesh(rbox(0.04, 0.12, 0.04, 0.01), blued(), 0, y + 0.12, z));
      for (const s of [-1, 1]) R.add(mesh(cyl(0.015, 0.015, 0.4, 8), darkTrim(), s * 0.08, y - 0.12, 1.2).rotateZ(s * 0.5));
      R.add(mesh(rbox(0.12, 0.2, 0.5, 0.05), olive(), 0, y - 0.04, -0.55));
      muzzle.position.set(0, y + 0.03, 1.92);
      break;
    }
    case 'rocket': {
      R.add(along(mesh(cyl(0.17, 0.17, 1.5, 24), olive(), 0, y + 0.08, 0.3)));
      R.add(along(mesh(cyl(0.2, 0.17, 0.14, 24), darkTrim(), 0, y + 0.08, 1.06)));
      R.add(along(mesh(cyl(0.17, 0.24, 0.2, 24), darkTrim(), 0, y + 0.08, -0.5)));
      R.add(along(mesh(cone(0.12, 0.3), std('#d62828', 0.4, 0.3), 0, y + 0.08, 1.12)));
      R.add(mesh(rbox(0.12, 0.12, 0.3, 0.03), blued(), 0.22, y + 0.2, 0.4));
      R.add(mesh(rbox(0.08, 0.26, 0.12, 0.03), blued(), 0, y - 0.15, 0.25));
      for (const z of [0, 0.6]) R.add(along(mesh(torus(0.175, 0.02), std('#e6c229', 0.4, 0.4), 0, y + 0.08, z)));
      muzzle.position.set(0, y + 0.08, 1.16);
      break;
    }
    case 'grenade': {
      R.add(along(mesh(cyl(0.11, 0.11, 0.7, 20), olive(), 0, y + 0.06, 0.55)));
      R.add(along(mesh(torus(0.11, 0.025), darkTrim(), 0, y + 0.06, 0.9)));
      const drum = along(mesh(cyl(0.22, 0.22, 0.34, 6), gunMetal(), 0, y + 0.02, 0.0));
      R.add(drum);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        R.add(along(mesh(cyl(0.05, 0.05, 0.36, 10), std('#9bd85a', 0.5, 0.2), Math.cos(a) * 0.14, y + 0.02 + Math.sin(a) * 0.14, 0.0)));
      }
      R.add(mesh(rbox(0.12, 0.2, 0.42, 0.05), wood(), 0, y - 0.06, -0.38));
      R.add(mesh(rbox(0.04, 0.16, 0.04, 0.01), blued(), 0, y + 0.2, 0.75));
      muzzle.position.set(0, y + 0.06, 0.92);
      break;
    }
    case 'flamer': {
      for (const s of [-1, 1]) {
        const tank = mesh(capsule(0.14, 0.45), std('#d9381e', 0.35, 0.4), s * 0.16, y + 0.05, -0.35);
        tank.rotation.x = Math.PI / 2;
        R.add(tank);
        R.add(along(mesh(torus(0.142, 0.015), chrome(), s * 0.16, y + 0.05, -0.2)));
      }
      R.add(mesh(rbox(0.22, 0.16, 0.3, 0.04), gunMetal(), 0, y, 0.05));
      R.add(mesh(tube('flame-hose', [[0.16, y - 0.05, -0.1], [0.1, y - 0.15, 0.15], [0, y - 0.02, 0.3]], 0.03), darkTrim()));
      R.add(along(mesh(cyl(0.05, 0.07, 0.7, 16), chrome(), 0, y + 0.03, 0.55)));
      R.add(along(mesh(cyl(0.08, 0.06, 0.12, 16), blued(), 0, y + 0.03, 0.92)));
      const pilot = mesh(sphere(0.045), glow('#4fa8ff', 2), 0, y - 0.04, 0.98);
      R.add(pilot);
      muzzle.position.set(0, y + 0.03, 1.0);
      break;
    }
    case 'homing': {
      R.add(mesh(rbox(0.66, 0.48, 0.85, 0.07), olive(), 0, y + 0.12, 0.25));
      for (const [x, yy] of [[-0.15, 0.11], [0.15, 0.11], [-0.15, -0.11], [0.15, -0.11]]) {
        R.add(along(mesh(cyl(0.09, 0.09, 0.02, 18), std('#111', 0.9, 0), x, y + 0.12 + yy, 0.68)));
        R.add(along(mesh(cone(0.07, 0.16), std('#ff4f7a', 0.4, 0.3), x, y + 0.12 + yy, 0.66)));
      }
      const dish = mesh(sphere(0.16), chrome(), 0.24, y + 0.48, -0.05);
      dish.scale.set(1, 1, 0.35);
      R.add(dish);
      R.add(mesh(cyl(0.02, 0.02, 0.2, 8), darkTrim(), 0.24, y + 0.38, -0.05));
      R.add(mesh(sphere(0.035), glow('#ff3b3b', 2), -0.24, y + 0.42, 0.55));
      muzzle.position.set(0, y + 0.12, 0.75);
      break;
    }
  }
  recoil.add(muzzle);
  group.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return { group, muzzle, spin, recoil, id: w.id };
}
