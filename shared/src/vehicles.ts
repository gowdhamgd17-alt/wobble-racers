// One shared vehicle configuration table. A single controller (physics.ts)
// reads these numbers; there is no per-class controller code.

export type CarClassId = 'speedster' | 'bruiser' | 'drifter';

export interface VehicleConfig {
  id: CarClassId;
  label: string;
  blurb: string;
  mass: number;
  acceleration: number; // m/s^2 at low speed
  maxSpeed: number; // m/s
  reverseSpeed: number;
  brakeDecel: number;
  steerResponse: number; // max yaw rate (rad/s) at low-mid speed
  highSpeedSteerFalloff: number; // larger = keeps steering at speed
  lateralGrip: number; // per-second lateral velocity decay
  driftGrip: number;
  driftYawBoost: number;
  nitroMultiplier: number; // top-speed multiplier while boosting
  damageResistance: number; // incoming damage is divided by this
  collisionImpulse: number; // multiplier on impulse dealt to others
  airControl: number; // yaw rad/s^2 while airborne
  recoveryHop: number; // vertical speed applied when auto-righting
  // UI-only stat bars (0..1)
  stats: { speed: number; accel: number; handling: number; armor: number; power: number };
}

export const VEHICLES: Record<CarClassId, VehicleConfig> = {
  speedster: {
    id: 'speedster',
    label: 'Speedster',
    blurb: 'Rocket on wheels. Fast, twitchy, fragile.',
    mass: 900,
    acceleration: 24,
    maxSpeed: 44,
    reverseSpeed: 12,
    brakeDecel: 30,
    steerResponse: 2.7,
    highSpeedSteerFalloff: 26,
    lateralGrip: 7.5,
    driftGrip: 1.4,
    driftYawBoost: 1.35,
    nitroMultiplier: 1.35,
    damageResistance: 0.8,
    collisionImpulse: 0.9,
    airControl: 3.2,
    recoveryHop: 4,
    stats: { speed: 1, accel: 0.95, handling: 0.6, armor: 0.35, power: 0.4 },
  },
  bruiser: {
    id: 'bruiser',
    label: 'Bruiser',
    blurb: 'Brick with an engine. Sends rivals flying.',
    mass: 1800,
    acceleration: 15,
    maxSpeed: 38,
    reverseSpeed: 10,
    brakeDecel: 26,
    steerResponse: 2.1,
    highSpeedSteerFalloff: 30,
    lateralGrip: 9,
    driftGrip: 2.2,
    driftYawBoost: 1.2,
    nitroMultiplier: 1.3,
    damageResistance: 1.5,
    collisionImpulse: 1.45,
    airControl: 1.8,
    recoveryHop: 5,
    stats: { speed: 0.7, accel: 0.45, handling: 0.45, armor: 1, power: 1 },
  },
  drifter: {
    id: 'drifter',
    label: 'Drifter',
    blurb: 'Slides sideways for fun and nitro.',
    mass: 1200,
    acceleration: 20,
    maxSpeed: 41,
    reverseSpeed: 11,
    brakeDecel: 28,
    steerResponse: 3.1,
    highSpeedSteerFalloff: 34,
    lateralGrip: 6.5,
    driftGrip: 0.9,
    driftYawBoost: 1.6,
    nitroMultiplier: 1.32,
    damageResistance: 1,
    collisionImpulse: 1,
    airControl: 2.8,
    recoveryHop: 4.5,
    stats: { speed: 0.82, accel: 0.75, handling: 1, armor: 0.65, power: 0.6 },
  },
};

export const CAR_CLASS_IDS = Object.keys(VEHICLES) as CarClassId[];

export function getVehicle(id: string): VehicleConfig {
  return VEHICLES[(id as CarClassId)] ?? VEHICLES.drifter;
}
