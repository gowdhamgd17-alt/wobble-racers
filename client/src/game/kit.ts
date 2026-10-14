// Modelling kit shared by cars and characters: detail level, cached smooth
// geometry, PBR materials and an environment map for reflections.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export type Detail = 'high' | 'medium' | 'low';
let detail: Detail = 'high';
/** Segment multiplier for the current detail level. */
export let SEG = 1;

export function setModelDetail(d: Detail) {
  detail = d;
  SEG = d === 'high' ? 1 : d === 'medium' ? 0.7 : 0.45;
}
export function getModelDetail() {
  return detail;
}
export const seg = (n: number, min = 6) => Math.max(min, Math.round(n * SEG));

const cache = new Map<string, THREE.BufferGeometry>();
export function geo<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  const k = `${detail}|${key}`;
  let g = cache.get(k);
  if (!g) {
    g = make();
    g.computeBoundingSphere();
    cache.set(k, g);
  }
  return g as T;
}

export const sphere = (r: number) => geo(`sph${r}`, () => new THREE.SphereGeometry(r, seg(32), seg(22)));
export const halfSphere = (r: number) => geo(`hsph${r}`, () => new THREE.SphereGeometry(r, seg(32), seg(12), 0, Math.PI * 2, 0, Math.PI / 2));
export const cyl = (rt: number, rb: number, h: number, radial = 24) =>
  geo(`cyl${rt},${rb},${h},${radial}`, () => new THREE.CylinderGeometry(rt, rb, h, seg(radial)));
export const capsule = (r: number, len: number) => geo(`cap${r},${len}`, () => new THREE.CapsuleGeometry(r, len, seg(8, 4), seg(20)));
export const cone = (r: number, h: number) => geo(`cone${r},${h}`, () => new THREE.ConeGeometry(r, h, seg(20)));
export const torus = (r: number, t: number, arc = Math.PI * 2) =>
  geo(`tor${r},${t},${arc}`, () => new THREE.TorusGeometry(r, t, seg(12), seg(36), arc));
export const rbox = (w: number, h: number, d: number, r = 0.06) =>
  geo(`rbox${w},${h},${d},${r}`, () => new RoundedBoxGeometry(w, h, d, Math.max(2, Math.round(4 * SEG)), Math.min(r, w / 2, h / 2, d / 2)));

/** Tube along a smooth curve through points. */
export function tube(key: string, pts: [number, number, number][], r: number, closed = false) {
  return geo(`tube${key}${r}`, () => {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)), closed, 'catmullrom', 0.4);
    return new THREE.TubeGeometry(curve, seg(48), r, seg(10), closed);
  });
}

/** Revolve a 2D profile [radius, y] around the Y axis. */
export function lathe(key: string, pts: [number, number][], segments = 32) {
  return geo(`lathe${key}`, () => new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), seg(segments)));
}

// ------------------------------------------------------------------ materials

export function paint(color: string | number) {
  if (detail === 'low') return new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.25 });
  return new THREE.MeshPhysicalMaterial({ color, roughness: 0.32, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08 });
}
export const std = (color: string | number, roughness = 0.6, metalness = 0, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
export const chrome = () => std('#e8eef4', 0.12, 1);
export const rubber = () => std('#1c1c21', 0.85, 0);
export const darkTrim = () => std('#2a2b33', 0.5, 0.3);
export const glass = () =>
  new THREE.MeshPhysicalMaterial({ color: '#2a4a6e', roughness: 0.04, metalness: 0.2, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide, clearcoat: 1 });
export const glow = (color: string, intensity = 1.2) => std(color, 0.3, 0, { emissive: color, emissiveIntensity: intensity });

export function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, cast = true) {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.castShadow = cast;
  return o;
}

// ------------------------------------------------------------------ environment

const envs = new WeakMap<THREE.WebGLRenderer, THREE.Texture>();
/** A soft studio reflection map so paint, chrome and glass read as real materials. */
export function environmentFor(renderer: THREE.WebGLRenderer) {
  let t = envs.get(renderer);
  if (!t) {
    const pm = new THREE.PMREMGenerator(renderer);
    t = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();
    envs.set(renderer, t);
  }
  return t;
}
