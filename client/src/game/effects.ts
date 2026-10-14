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

/** Pool of glowing blaster bolts. */
export class ProjectilePool {
  readonly group = new THREE.Group();
  private items: THREE.Mesh[] = [];
  private used = 0;
  constructor(capacity = 70) {
    const g = new THREE.CapsuleGeometry(0.18, 1.1, 2, 6);
    g.rotateX(Math.PI / 2);
    const m = new THREE.MeshBasicMaterial({ color: '#fff36b' });
    const glowG = new THREE.SphereGeometry(0.55, 8, 6);
    const glowM = new THREE.MeshBasicMaterial({ color: '#ff8a1f', transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < capacity; i++) {
      const b = new THREE.Mesh(g, m);
      b.add(new THREE.Mesh(glowG, glowM));
      b.visible = false;
      this.items.push(b);
      this.group.add(b);
    }
  }
  begin() { this.used = 0; }
  place(x: number, y: number, z: number, yaw: number) {
    if (this.used >= this.items.length) return;
    const b = this.items[this.used++];
    b.visible = true;
    b.position.set(x, y, z);
    b.rotation.set(0, yaw, 0);
  }
  end() { for (let i = this.used; i < this.items.length; i++) this.items[i].visible = false; }
}
