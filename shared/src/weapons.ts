// The ten car-mounted weapons. One table drives the server simulation, the
// offline simulation, the HUD and the client's effects and sounds.
//
//  hitscan    - bullets resolve instantly along a ray (tracers are cosmetic)
//  projectile - rockets / grenades / homing missiles are simulated objects
//  flame      - short-range cone that burns everything in front of the car

export type WeaponId =
  | 'pistol' | 'smg' | 'm4' | 'shotgun' | 'minigun' | 'sniper' | 'rocket' | 'grenade' | 'flamer' | 'homing';

export type WeaponKind = 'hitscan' | 'projectile' | 'flame';

export interface WeaponDef {
  id: WeaponId;
  index: number;
  label: string;
  blurb: string;
  kind: WeaponKind;
  damage: number; // per bullet / pellet / direct hit / flame tick
  pellets: number;
  spread: number; // radians (random cone half-angle)
  interval: number; // seconds between shots
  magazine: number;
  reload: number; // seconds
  range: number; // metres (hitscan / flame) or max flight distance
  speed: number; // projectile speed
  gravity: number; // projectile gravity (grenade arcs)
  lift: number; // initial upward speed (grenade)
  splash: number; // explosion damage at the centre
  splashRadius: number;
  fuse: number; // seconds before a projectile explodes on its own
  turnRate: number; // homing: radians per second
  knock: number; // knockback per hit
  aimAssist: number; // radians: snaps to a target inside this cone
  color: string; // tracer / glow colour
  stats: { damage: number; rate: number; range: number };
}

type Def = Omit<WeaponDef, 'index' | 'pellets' | 'spread' | 'speed' | 'gravity' | 'lift' | 'splash' | 'splashRadius' | 'fuse' | 'turnRate'> &
  Partial<Pick<WeaponDef, 'pellets' | 'spread' | 'speed' | 'gravity' | 'lift' | 'splash' | 'splashRadius' | 'fuse' | 'turnRate'>>;

const DEFS: Def[] = [
  {
    id: 'pistol', label: 'Pistol', blurb: 'Accurate semi-auto. Reliable at any range.', kind: 'hitscan',
    damage: 22, interval: 0.35, magazine: 12, reload: 1.2, range: 140, spread: 0.012, knock: 1.2, aimAssist: 0.16,
    color: '#ffe8a0', stats: { damage: 0.35, rate: 0.45, range: 0.55 },
  },
  {
    id: 'smg', label: 'SMG', blurb: 'Bullet hose. Huge fire rate, short range.', kind: 'hitscan',
    damage: 11, interval: 0.08, magazine: 32, reload: 1.6, range: 110, spread: 0.05, knock: 0.6, aimAssist: 0.18,
    color: '#ffd27a', stats: { damage: 0.2, rate: 0.9, range: 0.4 },
  },
  {
    id: 'm4', label: 'M4 Rifle', blurb: 'Assault rifle. Fast, accurate, hard-hitting all-rounder.', kind: 'hitscan',
    damage: 17, interval: 0.11, magazine: 30, reload: 2.0, range: 180, spread: 0.022, knock: 0.9, aimAssist: 0.15,
    color: '#ffcf6a', stats: { damage: 0.35, rate: 0.75, range: 0.7 },
  },
  {
    id: 'shotgun', label: 'Shotgun', blurb: 'Eight pellets per blast. Devastating up close.', kind: 'hitscan',
    damage: 12, pellets: 8, spread: 0.12, interval: 0.8, magazine: 6, reload: 2.2, range: 55, knock: 1.4, aimAssist: 0.22,
    color: '#ffb35c', stats: { damage: 0.9, rate: 0.3, range: 0.2 },
  },
  {
    id: 'minigun', label: 'Minigun', blurb: 'Six spinning barrels. Shreds anything that stays in front.', kind: 'hitscan',
    damage: 9, interval: 0.045, magazine: 120, reload: 3.5, range: 140, spread: 0.06, knock: 0.45, aimAssist: 0.17,
    color: '#ffa860', stats: { damage: 0.25, rate: 1, range: 0.55 },
  },
  {
    id: 'sniper', label: 'Sniper', blurb: 'One big shot at very long range.', kind: 'hitscan',
    damage: 95, interval: 1.3, magazine: 5, reload: 2.6, range: 320, spread: 0.002, knock: 5, aimAssist: 0.08,
    color: '#9fe8ff', stats: { damage: 0.85, rate: 0.12, range: 1 },
  },
  {
    id: 'rocket', label: 'Rocket Launcher', blurb: 'Fast rockets with a big blast radius.', kind: 'projectile',
    damage: 70, interval: 1.1, magazine: 4, reload: 2.8, range: 230, speed: 70, splash: 60, splashRadius: 7, fuse: 3.3,
    knock: 9, aimAssist: 0.1, color: '#ff7a3a', stats: { damage: 1, rate: 0.2, range: 0.8 },
  },
  {
    id: 'grenade', label: 'Grenade Launcher', blurb: 'Bouncing grenades lobbed in an arc. Explode after 2 s.', kind: 'projectile',
    damage: 30, interval: 0.7, magazine: 6, reload: 2.4, range: 90, speed: 38, gravity: 20, lift: 9, splash: 75, splashRadius: 8,
    fuse: 2, knock: 9, aimAssist: 0.12, color: '#9bd85a', stats: { damage: 0.9, rate: 0.35, range: 0.35 },
  },
  {
    id: 'flamer', label: 'Flamethrower', blurb: 'Short-range fire cone that burns everything in front.', kind: 'flame',
    damage: 5, interval: 0.05, magazine: 100, reload: 3, range: 18, spread: 0.35, knock: 0.25, aimAssist: 0,
    color: '#ff8a2a', stats: { damage: 0.6, rate: 1, range: 0.1 },
  },
  {
    id: 'homing', label: 'Homing Missiles', blurb: 'Locks on and follows its target.', kind: 'projectile',
    damage: 55, interval: 1.4, magazine: 3, reload: 3.2, range: 200, speed: 55, splash: 40, splashRadius: 5, fuse: 4,
    turnRate: 2.2, knock: 7, aimAssist: 0.5, color: '#ff4f7a', stats: { damage: 0.8, rate: 0.18, range: 0.75 },
  },
];

export const WEAPONS: WeaponDef[] = DEFS.map((d, index) => ({
  pellets: 1, spread: 0, speed: 0, gravity: 0, lift: 0, splash: 0, splashRadius: 0, fuse: 0, turnRate: 0, ...d, index,
}));

export const WEAPON_IDS = WEAPONS.map((w) => w.id);
const BY_ID = new Map(WEAPONS.map((w) => [w.id as string, w]));

export function getWeapon(id: string): WeaponDef {
  return BY_ID.get(id) ?? BY_ID.get('m4')!;
}
export function weaponByIndex(i: number): WeaponDef {
  return WEAPONS[Math.round(i)] ?? WEAPONS[2];
}

/** Weapons a crate can hand out (the heavy hitters). */
export const CRATE_WEAPONS: WeaponId[] = ['rocket', 'minigun', 'sniper', 'homing', 'grenade', 'shotgun', 'flamer'];

/** Height of the roof-mounted gun's muzzle above the car's ground point. */
export const MUZZLE_HEIGHT = 1.3;
