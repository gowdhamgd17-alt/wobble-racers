// Procedural character animation: a driving pose plus short "reaction"
// overrides (shock, dizzy, laugh, wave, character-specific gags).

import type { CharacterRig } from './characters';

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
        } else if (this.rig.id === 'rex') {
          // tiny arms flail, can't reach anything
          armLx = -1.6 + Math.sin(t * 22) * 0.5; armRx = -1.6 + Math.cos(t * 22) * 0.5;
          if (prop) prop.rotation.z = Math.sin(t * 18) * 0.25;
        } else if (this.rig.id === 'luna') {
          armRx = -2.9; armRz = -0.2; // big thumbs-up
          if (prop) prop.rotation.x = -0.9 * Math.min(1, this.reactionT * 2); // flip the visor up
        } else if (this.rig.id === 'gramps') {
          armRx = -2.7 + Math.sin(t * 16) * 0.35; armRz = -0.4; // shakes his fist
          headY = Math.sin(t * 8) * 0.3;
        } else if (this.rig.id === 'pip') {
          armLz = 0.9 + Math.sin(t * 26) * 0.5; armRz = -0.9 - Math.sin(t * 26) * 0.5; // flap!
          armLx = -0.4; armRx = -0.4;
          bob = Math.abs(Math.sin(t * 13)) * 0.06;
        } else {
          headX = -0.35 + Math.abs(Math.sin(t * 16)) * 0.3; // moo giggle
          if (prop) prop.rotation.z = Math.sin(t * 20) * 0.5; // cowbell
        }
        break;
    }
    if (this.reaction !== 'gag' && prop) { prop.position.y *= 0.9; prop.rotation.z *= 0.9; prop.rotation.x *= 0.9; }

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
