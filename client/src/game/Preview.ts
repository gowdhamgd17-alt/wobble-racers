// Turntable car preview (garage / name entry / lobby) and a cached
// thumbnail renderer that uses one shared WebGL context for player cards.

import * as THREE from 'three';
import type { Appearance } from '@wobble/shared';
import { buildCar, buildCharacter, CharacterAnimator, disposeCar, environmentFor, getModelDetail, setModelDetail, type CarParts, type CharacterRig } from './models';

/** Point a camera so a whole car (any class) fills the frame from a 3/4 front view. */
function frameCar(cam: THREE.PerspectiveCamera, obj: THREE.Object3D, fill = 1) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y * 1.3, size.z) * 0.62;
  const dist = (radius / Math.tan((cam.fov * Math.PI) / 360)) * fill;
  const dir = new THREE.Vector3(0.62, 0.42, 0.78).normalize();
  cam.position.copy(center).addScaledVector(dir, dist);
  cam.lookAt(center.x, center.y * 0.85, center.z);
}

function makeStage() {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#eef7ff', '#4a3f6a', 0.9));
  const key = new THREE.DirectionalLight('#fff1d6', 2.6);
  key.position.set(5, 9, 7);
  scene.add(key);
  const rim = new THREE.DirectionalLight('#9fd8ff', 1.8);
  rim.position.set(-6, 4, -7);
  scene.add(rim);
  const fill = new THREE.DirectionalLight('#ffd6f0', 0.6);
  fill.position.set(-7, 2, 5);
  scene.add(fill);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.4, 0.3, 64), new THREE.MeshStandardMaterial({ color: '#2c2f5c', roughness: 0.35, metalness: 0.3 }));
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
  private solo: CharacterRig | null = null;
  private focus: 'car' | 'driver' = 'car';
  private app: Appearance | null = null;
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
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.stage.scene.environment = environmentFor(this.renderer);
    this.stage.scene.environmentIntensity = 0.8;
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
      if (this.solo) {
        this.solo.root.rotation.y = Math.sin(this.spin * 0.6) * 0.7;
        this.anim?.update(dt, { t: this.t, steer: Math.sin(this.t * 0.7) * 0.4, speed: 0, drifting: false, boosting: false, airborne: false, countdown: false, finished: false, won: false, idle: true });
      } else if (this.car) {
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

  /** 'driver' shows the character on its own, close up; 'car' shows the whole car. */
  setFocus(f: 'car' | 'driver') {
    if (f === this.focus) return;
    this.focus = f;
    if (this.app) this.setAppearance(this.app, true);
  }

  setAppearance(app: Appearance, force = false) {
    const prevApp = this.app;
    this.app = app;
    if (!force && prevApp && JSON.stringify(prevApp) === JSON.stringify(app)) return;
    if (this.car) {
      this.stage.scene.remove(this.car.root);
      disposeCar(this.car);
      this.car = null;
    }
    if (this.solo) {
      this.stage.scene.remove(this.solo.root);
      this.solo.root.traverse((o) => ((o as THREE.Mesh).material as THREE.Material | undefined)?.dispose?.());
      this.solo = null;
    }
    const prev = getModelDetail();
    setModelDetail('high');
    if (this.focus === 'driver') {
      this.solo = buildCharacter(app.character);
      this.solo.root.scale.setScalar(2.4);
      this.solo.root.position.y = 0.05;
      this.anim = new CharacterAnimator(this.solo);
      this.stage.scene.add(this.solo.root);
      this.camera.position.set(0, 2.6, 7.2);
      this.camera.lookAt(0, 1.75, 0);
    } else {
      this.car = buildCar(app);
      this.anim = new CharacterAnimator(this.car.rig);
      this.stage.scene.add(this.car.root);
      this.car.root.rotation.y = 0;
      frameCar(this.camera, this.car.root, this.camera.aspect < 1 ? 1.05 : 0.8);
    }
    setModelDetail(prev);
    this.anim.react('wave', 1.4);
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
      thumbRenderer.toneMapping = THREE.ACESFilmicToneMapping;
      thumbStage = makeStage();
      thumbStage.ring.visible = false;
      thumbCam.position.set(4.6, 3.4, 6.2);
      thumbCam.lookAt(0, 0.9, 0.3);
    }
    const prev = getModelDetail();
    setModelDetail('medium');
    const car = buildCar(app);
    setModelDetail(prev);
    const anim = new CharacterAnimator(car.rig);
    anim.update(1, { t: 0, steer: 0, speed: 0, drifting: false, boosting: false, airborne: false, countdown: false, finished: false, won: false, idle: true });
    thumbStage!.scene.environment = environmentFor(thumbRenderer);
    thumbStage!.scene.environmentIntensity = 0.8;
    thumbStage!.scene.add(car.root);
    frameCar(thumbCam, car.root, 0.7);
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
