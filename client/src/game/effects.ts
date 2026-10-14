// Pooled visual effects: particles (one draw call per system), skid marks,
// debris and projectiles. Nothing here allocates during the frame loop.

import * as THREE from 'three';

const vert = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  uniform float uScale;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const frag = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float a = vAlpha * smoothstep(0.5, 0.2, d);
    gl_FragColor = vec4(vColor, a);
  }
`;

export class ParticleSystem {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private grow: Float32Array;
  private drag: Float32Array;
  private gravity: Float32Array;
  private next = 0;
  private geom: THREE.BufferGeometry;
  budget = 1; // 0..1 multiplier from quality settings

  constructor(readonly capacity: number, additive: boolean) {
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { uScale: { value: 300 } },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geom, material);
    this.points.frustumCulled = false;
  }

  setScale(viewportHeight: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = viewportHeight * 0.9;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, color: THREE.Color, size: number, life: number, opts: { grow?: number; drag?: number; gravity?: number } = {}) {
    if (this.budget < 1 && Math.random() > this.budget) return;
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col[i3] = color.r; this.col[i3 + 1] = color.g; this.col[i3 + 2] = color.b;
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.grow[i] = opts.grow ?? 0;
    this.drag[i] = opts.drag ?? 1;
    this.gravity[i] = opts.gravity ?? 0;
    this.alpha[i] = 1;
  }

  update(dt: number) {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const i3 = i * 3;
      const dr = Math.exp(-this.drag[i] * dt);
      this.vel[i3] *= dr; this.vel[i3 + 1] = this.vel[i3 + 1] * dr - this.gravity[i] * dt; this.vel[i3 + 2] *= dr;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      this.alpha[i] = k < 0.7 ? k / 0.7 : 1;
    }
    for (const n of ['position', 'aColor', 'aSize', 'aAlpha']) (this.geom.getAttribute(n) as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose() {
    this.geom.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

/** Ring buffer of flat dark quads for drift skid marks. */
export class SkidMarks {
  readonly mesh: THREE.InstancedMesh;
  private next = 0;
  private dummy = new THREE.Object3D();
  constructor(readonly capacity = 700) {
    const g = new THREE.PlaneGeometry(0.42, 0.9);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.MeshBasicMaterial({ color: '#1a1a1a', transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    this.mesh = new THREE.InstancedMesh(g, m, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.dummy.scale.set(0, 0, 0);
    this.dummy.updateMatrix();
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
  }
  add(x: number, y: number, z: number, yaw: number) {
    this.dummy.position.set(x, y + 0.04, z);
    this.dummy.rotation.set(0, yaw, 0);
    this.dummy.scale.set(1, 1, 1);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(this.next, this.dummy.matrix);
    this.next = (this.next + 1) % this.capacity;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Tumbling debris chunks for explosions. */
export class Debris {
  readonly mesh: THREE.InstancedMesh;
  private p: Float32Array;
  private v: Float32Array;
  private r: Float32Array;
  private life: Float32Array;
  private next = 0;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  constructor(readonly capacity = 90) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.35, 0.25, 0.45), new THREE.MeshLambertMaterial({ flatShading: true }), capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.p = new Float32Array(capacity * 3);
    this.v = new Float32Array(capacity * 3);
    this.r = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.mesh.setColorAt(i, this.color.set('#888'));
      this.hide(i);
    }
  }
  private hide(i: number) {
    this.dummy.scale.set(0, 0, 0);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(i, this.dummy.matrix);
  }
  burst(x: number, y: number, z: number, colors: string[], count: number) {
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.capacity;
      const a = Math.random() * Math.PI * 2;
      const s = 4 + Math.random() * 8;
      this.p.set([x, y + 0.5, z], i * 3);
      this.v.set([Math.cos(a) * s, 6 + Math.random() * 9, Math.sin(a) * s], i * 3);
      this.r.set([Math.random() * 10, Math.random() * 10, Math.random() * 10], i * 3);
      this.life[i] = 2 + Math.random();
      this.mesh.setColorAt(i, this.color.set(colors[k % colors.length]));
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  update(dt: number, groundY = 0) {
    let any = false;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt;
      const i3 = i * 3;
      this.v[i3 + 1] -= 22 * dt;
      this.p[i3] += this.v[i3] * dt;
      this.p[i3 + 1] += this.v[i3 + 1] * dt;
      this.p[i3 + 2] += this.v[i3 + 2] * dt;
      if (this.p[i3 + 1] < groundY + 0.12) {
        this.p[i3 + 1] = groundY + 0.12;
        this.v[i3 + 1] *= -0.35;
        this.v[i3] *= 0.6;
        this.v[i3 + 2] *= 0.6;
      }
      if (this.life[i] <= 0) { this.hide(i); continue; }
      const s = Math.min(1, this.life[i] * 2);
      this.dummy.position.set(this.p[i3], this.p[i3 + 1], this.p[i3 + 2]);
      this.dummy.rotation.set(this.r[i3] * this.life[i], this.r[i3 + 1] * this.life[i], this.r[i3 + 2] * this.life[i]);
      this.dummy.scale.set(s, s, s);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }
  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Bullet tracers: short-lived glowing streaks from muzzle to impact. */
export class Tracers {
  readonly mesh: THREE.InstancedMesh;
  private life: Float32Array;
  private from: Float32Array;
  private to: Float32Array;
  private width: Float32Array;
  private next = 0;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  constructor(readonly capacity = 240) {
    const g = new THREE.BoxGeometry(1, 1, 1);
    g.translate(0, 0, 0.5);
    const m = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(g, m, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.life = new Float32Array(capacity);
    this.from = new Float32Array(capacity * 3);
    this.to = new Float32Array(capacity * 3);
    this.width = new Float32Array(capacity);
    this.dummy.scale.set(0, 0, 0);
    this.dummy.updateMatrix();
    for (let i = 0; i < capacity; i++) { this.mesh.setMatrixAt(i, this.dummy.matrix); this.mesh.setColorAt(i, this.color.set('#fff')); }
  }
  add(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: string, width = 0.07, life = 0.09) {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.from.set([x0, y0, z0], i * 3);
    this.to.set([x1, y1, z1], i * 3);
    this.life[i] = life;
    this.width[i] = width;
    this.mesh.setColorAt(i, this.color.set(color));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  update(dt: number) {
    let any = false;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt;
      const i3 = i * 3;
      if (this.life[i] <= 0) {
        this.dummy.scale.set(0, 0, 0);
      } else {
        // the streak travels: tail catches up with the head as it fades
        const k = Math.max(0, Math.min(1, 1 - this.life[i] / 0.09));
        const fx = this.from[i3], fy = this.from[i3 + 1], fz = this.from[i3 + 2];
        const dx = this.to[i3] - fx, dy = this.to[i3 + 1] - fy, dz = this.to[i3 + 2] - fz;
        const len = Math.hypot(dx, dy, dz);
        const t0 = Math.min(0.85, k * 0.9);
        this.dummy.position.set(fx + dx * t0, fy + dy * t0, fz + dz * t0);
        this.dummy.lookAt(this.to[i3], this.to[i3 + 1], this.to[i3 + 2]);
        const w = this.width[i];
        this.dummy.scale.set(w, w, Math.max(0.1, len * (1 - t0)));
      }
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }
  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Expanding shockwave rings for explosions. */
export class Shockwaves {
  readonly group = new THREE.Group();
  private items: { mesh: THREE.Mesh; t: number; max: number }[] = [];
  constructor(capacity = 12) {
    const g = new THREE.RingGeometry(0.8, 1, 40);
    g.rotateX(-Math.PI / 2);
    for (let i = 0; i < capacity; i++) {
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#ffd9a0', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      m.visible = false;
      this.group.add(m);
      this.items.push({ mesh: m, t: 1, max: 1 });
    }
  }
  add(x: number, y: number, z: number, radius: number) {
    const it = this.items.find((i) => i.t >= 1) ?? this.items[0];
    it.t = 0;
    it.max = radius;
    it.mesh.position.set(x, y + 0.15, z);
    it.mesh.visible = true;
  }
  update(dt: number) {
    for (const it of this.items) {
      if (it.t >= 1) continue;
      it.t = Math.min(1, it.t + dt * 2.6);
      const s = 0.5 + it.max * 1.4 * Math.sqrt(it.t);
      it.mesh.scale.set(s, 1, s);
      (it.mesh.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - it.t);
      if (it.t >= 1) it.mesh.visible = false;
    }
  }
  dispose() {
    for (const it of this.items) (it.mesh.material as THREE.Material).dispose();
    this.items[0]?.mesh.geometry.dispose();
  }
}

/** Rockets, grenades and homing missiles in flight. */
export class ProjectilePool {
  readonly group = new THREE.Group();
  private pools = new Map<string, THREE.Object3D[]>();
  private used = new Map<string, number>();
  constructor() {
    const rocket = () => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.9, 12).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#6b7046', roughness: 0.5, metalness: 0.3 }));
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.3, 12).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#d62828', roughness: 0.4 }));
      tip.position.z = 0.6;
      g.add(body, tip);
      for (let i = 0; i < 4; i++) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.24, 0.22), body.material);
        fin.position.z = -0.38;
        fin.rotation.z = (i * Math.PI) / 2;
        fin.position.x = Math.cos((i * Math.PI) / 2) * 0.12;
        fin.position.y = Math.sin((i * Math.PI) / 2) * 0.12;
        g.add(fin);
      }
      const flame = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshBasicMaterial({ color: '#ffb347', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
      flame.scale.set(0.8, 0.8, 2.2);
      flame.position.z = -0.75;
      g.add(flame);
      return g;
    };
    const grenade = () => {
      const g = new THREE.Group();
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 10), new THREE.MeshStandardMaterial({ color: '#4f5a2b', roughness: 0.6, metalness: 0.2 }));
      b.scale.set(1, 1, 1.3);
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.025, 6, 18), new THREE.MeshStandardMaterial({ color: '#c9a03a', metalness: 0.8, roughness: 0.3 }));
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshBasicMaterial({ color: '#ff3b3b' }));
      led.position.set(0, 0.15, 0.1);
      g.add(b, band, led);
      return g;
    };
    const homing = () => {
      const g = rocket();
      g.scale.setScalar(0.85);
      ((g.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).color.set('#e8e8ee');
      ((g.children[1] as THREE.Mesh).material as THREE.MeshStandardMaterial).color.set('#ff4f7a');
      return g;
    };
    for (const [kind, make, n] of [['rocket', rocket, 40], ['grenade', grenade, 50], ['homing', homing, 30]] as const) {
      const list: THREE.Object3D[] = [];
      for (let i = 0; i < n; i++) {
        const o = make();
        o.visible = false;
        list.push(o);
        this.group.add(o);
      }
      this.pools.set(kind, list);
    }
  }
  begin() { for (const k of this.pools.keys()) this.used.set(k, 0); }
  place(kind: string, x: number, y: number, z: number, vx: number, vy: number, vz: number, t: number) {
    const list = this.pools.get(kind);
    if (!list) return;
    const n = this.used.get(kind) ?? 0;
    if (n >= list.length) return;
    this.used.set(kind, n + 1);
    const o = list[n];
    o.visible = true;
    o.position.set(x, y, z);
    if (kind === 'grenade') o.rotation.set(t * 9, t * 5, 0);
    else o.lookAt(x + vx, y + vy, z + vz);
  }
  end() {
    for (const [k, list] of this.pools) for (let i = this.used.get(k) ?? 0; i < list.length; i++) list[i].visible = false;
  }
}

function iconTexture(draw: (ctx: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Floating repair kits and weapon crates. */
export class PickupViews {
  readonly group = new THREE.Group();
  private items = new Map<string, { root: THREE.Group; spin: THREE.Group; ring: THREE.Mesh; kind: string }>();
  private repairMat: THREE.Material[];
  private crateMat: THREE.Material[];
  private ringGeo = new THREE.RingGeometry(1.5, 1.9, 36).rotateX(-Math.PI / 2);
  private boxGeo = new THREE.BoxGeometry(1.3, 1.3, 1.3);
  constructor() {
    const repairTex = iconTexture((ctx) => {
      ctx.fillStyle = '#18b45b';
      ctx.fillRect(0, 0, 128, 128);
      ctx.strokeStyle = '#0d7a3c';
      ctx.lineWidth = 10;
      ctx.strokeRect(5, 5, 118, 118);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(50, 22, 28, 84);
      ctx.fillRect(22, 50, 84, 28);
    });
    const crateTex = iconTexture((ctx) => {
      ctx.fillStyle = '#a8702f';
      ctx.fillRect(0, 0, 128, 128);
      ctx.fillStyle = '#8a5a24';
      for (let y = 0; y < 128; y += 32) ctx.fillRect(0, y + 28, 128, 4);
      ctx.strokeStyle = '#5e3c17';
      ctx.lineWidth = 12;
      ctx.strokeRect(6, 6, 116, 116);
      ctx.beginPath();
      ctx.moveTo(10, 10); ctx.lineTo(118, 118);
      ctx.stroke();
      ctx.fillStyle = '#ffd23f';
      ctx.beginPath();
      ctx.arc(64, 64, 30, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2b1d0e';
      ctx.font = '900 46px Nunito, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', 64, 67);
    });
    this.repairMat = [new THREE.MeshStandardMaterial({ map: repairTex, roughness: 0.4, emissive: '#0c5a2c', emissiveIntensity: 0.4 }), new THREE.MeshBasicMaterial({ color: '#4dff9a', transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })];
    this.crateMat = [new THREE.MeshStandardMaterial({ map: crateTex, roughness: 0.7 }), new THREE.MeshBasicMaterial({ color: '#ffd23f', transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false })];
  }
  sync(pickups: Map<string, { kind: string; x: number; y: number; z: number; active: boolean }> | { forEach: (cb: (p: any, id: string) => void) => void } | undefined, t: number) {
    const seen = new Set<string>();
    pickups?.forEach((p: any, id: string) => {
      seen.add(id);
      let it = this.items.get(id);
      if (!it || it.kind !== p.kind) {
        if (it) this.group.remove(it.root);
        const mats = p.kind === 'repair' ? this.repairMat : this.crateMat;
        const root = new THREE.Group();
        const spin = new THREE.Group();
        const box = new THREE.Mesh(this.boxGeo, mats[0]);
        box.castShadow = true;
        spin.add(box);
        const ring = new THREE.Mesh(this.ringGeo, mats[1]);
        root.add(spin, ring);
        root.position.set(p.x, p.y, p.z);
        this.group.add(root);
        it = { root, spin, ring, kind: p.kind };
        this.items.set(id, it);
      }
      it.root.visible = p.active;
      if (p.active) {
        const ph = (p.x + p.z) * 0.1;
        it.spin.position.y = 1.3 + Math.sin(t * 2.4 + ph) * 0.25;
        it.spin.rotation.y = t * 1.6 + ph;
        it.spin.rotation.x = p.kind === 'repair' ? 0 : 0.15;
        const s = 1 + Math.sin(t * 4 + ph) * 0.08;
        it.ring.scale.set(s, 1, s);
      }
    });
    for (const [id, it] of this.items) if (!seen.has(id)) { this.group.remove(it.root); this.items.delete(id); }
  }
  dispose() {
    this.ringGeo.dispose();
    this.boxGeo.dispose();
    for (const m of [...this.repairMat, ...this.crateMat]) { (m as THREE.MeshStandardMaterial).map?.dispose(); m.dispose(); }
  }
}
