// One shared vehicle configuration table. A single controller (physics.ts)
// reads these numbers; there is no per-class controller code. halfLength /
// halfWidth are the real body footprint (wheels included) used for collisions,
// walls, projectile hits and respawn clearance, and the 3D models are built to match.

export type CarClassId = 'speedster' | 'bruiser' | 'drifter' | 'muscle' | 'buggy' | 'formula' | 'monster' | 'jeep' | 'pickup' | 'armored';

export interface VehicleConfig {
  id: CarClassId;
  label: string;
  blurb: string;
  halfLength: number;
  halfWidth: number;
  maxHealth: number;
  mass: number;
  acceleration: number;
  maxSpeed: number;
  reverseSpeed: number;
  brakeDecel: number;
  steerResponse: number;
  highSpeedSteerFalloff: number;
  lateralGrip: number;
  driftGrip: number;
  driftYawBoost: number;
  offroadSpeed: number; // top-speed multiplier on grass
  nitroMultiplier: number;
  damageResistance: number;
  collisionImpulse: number;
  airControl: number;
  recoveryHop: number;
  stats: { speed: number; accel: number; handling: number; armor: number; power: number };
}

const base = { reverseSpeed: 11, brakeDecel: 28, offroadSpeed: 0.55 };

export const VEHICLES: Record<CarClassId, VehicleConfig> = {
  speedster: {
    ...base, id: 'speedster', maxHealth: 320, label: 'Speedster', blurb: 'Low wedge with a big wing. Fast, twitchy, fragile.',
    halfLength: 2.35, halfWidth: 1.0, mass: 900, acceleration: 24, maxSpeed: 44, reverseSpeed: 12, brakeDecel: 30,
    steerResponse: 2.7, highSpeedSteerFalloff: 26, lateralGrip: 7.5, driftGrip: 1.4, driftYawBoost: 1.35,
    nitroMultiplier: 1.35, damageResistance: 0.8, collisionImpulse: 0.9, airControl: 3.2, recoveryHop: 4,
    stats: { speed: 0.9, accel: 0.9, handling: 0.6, armor: 0.35, power: 0.4 },
  },
  bruiser: {
    ...base, id: 'bruiser', maxHealth: 520, label: 'Bruiser', blurb: 'Armoured off-roader. Sends rivals flying.',
    halfLength: 2.35, halfWidth: 1.25, mass: 1800, acceleration: 15, maxSpeed: 38, reverseSpeed: 10, brakeDecel: 26,
    steerResponse: 2.1, highSpeedSteerFalloff: 30, lateralGrip: 9, driftGrip: 2.2, driftYawBoost: 1.2, offroadSpeed: 0.75,
    nitroMultiplier: 1.3, damageResistance: 1.5, collisionImpulse: 1.45, airControl: 1.8, recoveryHop: 5,
    stats: { speed: 0.65, accel: 0.45, handling: 0.45, armor: 0.9, power: 0.9 },
  },
  drifter: {
    ...base, id: 'drifter', maxHealth: 380, label: 'Drifter', blurb: 'Wide-arch coupe. Slides sideways for fun and nitro.',
    halfLength: 2.2, halfWidth: 1.1, mass: 1200, acceleration: 20, maxSpeed: 41,
    steerResponse: 3.1, highSpeedSteerFalloff: 34, lateralGrip: 6.5, driftGrip: 0.9, driftYawBoost: 1.6,
    nitroMultiplier: 1.32, damageResistance: 1, collisionImpulse: 1, airControl: 2.8, recoveryHop: 4.5,
    stats: { speed: 0.78, accel: 0.75, handling: 1, armor: 0.6, power: 0.6 },
  },
  muscle: {
    ...base, id: 'muscle', maxHealth: 420, label: 'Muscle', blurb: 'Long-nosed V8. Monster straight-line speed, lazy in corners.',
    halfLength: 2.45, halfWidth: 1.1, mass: 1500, acceleration: 22, maxSpeed: 46,
    steerResponse: 2.2, highSpeedSteerFalloff: 24, lateralGrip: 6.8, driftGrip: 1.5, driftYawBoost: 1.4,
    nitroMultiplier: 1.38, damageResistance: 1.2, collisionImpulse: 1.2, airControl: 2, recoveryHop: 4.5,
    stats: { speed: 0.95, accel: 0.8, handling: 0.45, armor: 0.7, power: 0.75 },
  },
  buggy: {
    ...base, id: 'buggy', maxHealth: 330, label: 'Buggy', blurb: 'Bouncy dune buggy. Barely slows on grass, flips back fast.',
    halfLength: 1.95, halfWidth: 1.15, mass: 800, acceleration: 23, maxSpeed: 39, offroadSpeed: 0.9,
    steerResponse: 3.0, highSpeedSteerFalloff: 30, lateralGrip: 6.5, driftGrip: 1.2, driftYawBoost: 1.45,
    nitroMultiplier: 1.3, damageResistance: 0.85, collisionImpulse: 0.85, airControl: 4.2, recoveryHop: 5.5,
    stats: { speed: 0.7, accel: 0.9, handling: 0.85, armor: 0.4, power: 0.35 },
  },
  formula: {
    ...base, id: 'formula', maxHealth: 280, label: 'Formula', blurb: 'Open-wheel racer. Fastest and grippiest, made of paper.',
    halfLength: 2.55, halfWidth: 1.05, mass: 700, acceleration: 26, maxSpeed: 50, reverseSpeed: 10, brakeDecel: 34,
    steerResponse: 2.8, highSpeedSteerFalloff: 32, lateralGrip: 10, driftGrip: 2.6, driftYawBoost: 1.2, offroadSpeed: 0.45,
    nitroMultiplier: 1.3, damageResistance: 0.65, collisionImpulse: 0.75, airControl: 2.5, recoveryHop: 4,
    stats: { speed: 1, accel: 1, handling: 0.9, armor: 0.2, power: 0.25 },
  },
  monster: {
    ...base, id: 'monster', maxHealth: 600, label: 'Monster', blurb: 'Giant tyres, giant attitude. Slow, but nothing stops it.',
    halfLength: 2.25, halfWidth: 1.45, mass: 2200, acceleration: 13, maxSpeed: 35, reverseSpeed: 9, brakeDecel: 24, offroadSpeed: 0.9,
    steerResponse: 1.9, highSpeedSteerFalloff: 30, lateralGrip: 8.5, driftGrip: 2.4, driftYawBoost: 1.15,
    nitroMultiplier: 1.3, damageResistance: 1.8, collisionImpulse: 1.7, airControl: 1.6, recoveryHop: 6,
    stats: { speed: 0.55, accel: 0.35, handling: 0.35, armor: 1, power: 1 },
  },
  jeep: {
    ...base, id: 'jeep', maxHealth: 400, label: 'Jeep', blurb: 'Open-top 4x4 with a roll cage. Great all-rounder off-road.',
    halfLength: 2.15, halfWidth: 1.15, mass: 1400, acceleration: 19, maxSpeed: 40, offroadSpeed: 0.85,
    steerResponse: 2.6, highSpeedSteerFalloff: 30, lateralGrip: 7.5, driftGrip: 1.6, driftYawBoost: 1.35,
    nitroMultiplier: 1.3, damageResistance: 1.15, collisionImpulse: 1.15, airControl: 2.6, recoveryHop: 5,
    stats: { speed: 0.72, accel: 0.7, handling: 0.75, armor: 0.65, power: 0.65 },
  },
  pickup: {
    ...base, id: 'pickup', maxHealth: 460, label: 'Pickup', blurb: 'Big pickup truck with a loaded bed. Tough and punchy.',
    halfLength: 2.6, halfWidth: 1.2, mass: 1900, acceleration: 16, maxSpeed: 40, reverseSpeed: 10, offroadSpeed: 0.8,
    steerResponse: 2.2, highSpeedSteerFalloff: 28, lateralGrip: 7.8, driftGrip: 1.8, driftYawBoost: 1.3,
    nitroMultiplier: 1.32, damageResistance: 1.35, collisionImpulse: 1.4, airControl: 2, recoveryHop: 5,
    stats: { speed: 0.72, accel: 0.5, handling: 0.5, armor: 0.8, power: 0.85 },
  },
  armored: {
    ...base, id: 'armored', maxHealth: 650, label: 'Armored Truck', blurb: 'Six-wheel armoured carrier. A rolling fortress.',
    halfLength: 2.75, halfWidth: 1.4, mass: 2600, acceleration: 12, maxSpeed: 34, reverseSpeed: 9, brakeDecel: 22, offroadSpeed: 0.85,
    steerResponse: 1.8, highSpeedSteerFalloff: 28, lateralGrip: 9, driftGrip: 2.6, driftYawBoost: 1.1,
    nitroMultiplier: 1.3, damageResistance: 2, collisionImpulse: 1.8, airControl: 1.4, recoveryHop: 6,
    stats: { speed: 0.5, accel: 0.3, handling: 0.3, armor: 1, power: 1 },
  },
};

export const CAR_CLASS_IDS = Object.keys(VEHICLES) as CarClassId[];

export function getVehicle(id: string): VehicleConfig {
  return VEHICLES[id as CarClassId] ?? VEHICLES.drifter;
}
