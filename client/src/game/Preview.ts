// Turntable car preview (garage / name entry / lobby) and a cached
// thumbnail renderer that uses one shared WebGL context for player cards.

import * as THREE from 'three';
import type { Appearance } from '@wobble/shared';
import { buildCar, CharacterAnimator, disposeCar, type CarParts } from './models';

function makeStage() {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#eef7ff', '#6a5a8a', 1.6));
  const sun = new THREE.DirectionalLight('#fff1d6', 2);
  sun.position.set(5, 9, 6);
  scene.add(sun);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.4, 0.3, 32), new THREE.MeshLambertMaterial({ color: '#2c2f5c' }));
  disc.position.y = -0.15;
  scene.add(disc);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(4.3, 0.08, 6, 48), new THREE.MeshBasicMaterial({ color: '#ffd23f' }));
  ring.rotation.x = Math.PI / 2;
  scene.add(ring);
  return { scene, disc, ring };
}

export class CarPreview {
  private renderer: THREE.WebGLRenderer;
  private stage = makeStage();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  private car: CarParts | null = null;
  private anim: CharacterAnimator | null = null;
  private raf = 0;
  private t = 0;
  private last = performance.now();
  private ro: ResizeObserver;
  private dragging = false;
  private dragX = 0;
  private spin = 0;
  private spinVel = 0.5;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = 'preview-canvas';
    container.appendChild(this.renderer.domElement);
    this.camera.position.set(6.2, 3.6, 7.8);
    this.camera.lookAt(0, 0.9, 0);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => { this.dragging = true; this.dragX = e.clientX; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.spin += (e.clientX - this.dragX) * 0.012;
      this.spinVel = (e.clientX - this.dragX) * 0.4;
      this.dragX = e.clientX;
    });
    const up = () => { this.dragging = false; };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.t += dt;
      if (!this.dragging) {
        this.spinVel += (0.5 - this.spinVel) * Math.min(1, dt * 2);
        this.spin += this.spinVel * dt;
      }
      if (this.car) {
        this.car.root.rotation.y = this.spin;
        this.car.tilt.position.y = Math.abs(Math.sin(this.t * 2.2)) * 0.06; // wobble!
        this.car.tilt.rotation.z = Math.sin(this.t * 2.2) * 0.03;
        this.anim?.update(dt, { t: this.t, steer: Math.sin(this.t * 0.7) * 0.4, speed: 0, drifting: false, boosting: false, airborne: false, countdown: false, finished: false, won: false, idle: true });
      }
      this.renderer.render(this.stage.scene, this.camera);
    };
    loop();
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Fit the car regardless of aspect
    this.camera.fov = w / h < 1 ? 46 : 32;
    this.camera.updateProjectionMatrix();
  }

  setAppearance(app: Appearance) {
    if (this.car) {
      this.stage.scene.remove(this.car.root);
      disposeCar(this.car);
    }
    this.car = buildCar(app);
    this.anim = new CharacterAnimator(this.car.rig);
    this.anim.react('wave', 1.2);
    this.stage.scene.add(this.car.root);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    if (this.car) disposeCar(this.car);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

// ------------------------------------------------------------------ thumbnails

let thumbRenderer: THREE.WebGLRenderer | null = null;
let thumbStage: ReturnType<typeof makeStage> | null = null;
const thumbCam = new THREE.PerspectiveCamera(30, 4 / 3, 0.1, 100);
const thumbCache = new Map<string, string>();

export function carThumbnail(app: Appearance): string {
  const key = [app.carClass, app.character, app.colorMain, app.colorSecondary, app.colorWheel, app.wheelStyle].join('|');
  const hit = thumbCache.get(key);
  if (hit) return hit;
  try {
    if (!thumbRenderer) {
      thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      thumbRenderer.setPixelRatio(1);
      thumbRenderer.setSize(200, 150, false);
      thumbRenderer.outputColorSpace = THREE.SRGBColorSpace;
      thumbStage = makeStage();
      thumbStage.ring.visible = false;
      thumbCam.position.set(4.6, 3.4, 6.2);
      thumbCam.lookAt(0, 0.9, 0.3);
    }
    const car = buildCar(app);
    car.root.rotation.y = 0.5;
    const anim = new CharacterAnimator(car.rig);
    anim.update(1, { t: 0, steer: 0, speed: 0, drifting: false, boosting: false, airborne: false, countdown: false, finished: false, won: false, idle: true });
    thumbStage!.scene.add(car.root);
    thumbRenderer.render(thumbStage!.scene, thumbCam);
    const url = thumbRenderer.domElement.toDataURL('image/png');
    thumbStage!.scene.remove(car.root);
    disposeCar(car);
    thumbCache.set(key, url);
    return url;
  } catch {
    return '';
  }
}
