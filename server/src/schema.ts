import { ArraySchema, MapSchema, Schema, defineTypes } from '@colyseus/schema';
import { DEFAULT_APPEARANCE, DEFAULT_SETTINGS, MAX_HEALTH, NITRO, Phase, RacerStatus } from '@wobble/shared';

// Fields are declared with `declare` and initialised in constructors so the
// Schema accessors installed by defineTypes are never shadowed.

export class SettingsState extends Schema {
  declare trackId: string;
  declare laps: number;
  declare collisions: boolean;
  declare damage: boolean;
  declare weapons: boolean;
  declare nitro: boolean;
  declare drift: boolean;
  constructor() {
    super();
    Object.assign(this, DEFAULT_SETTINGS);
  }
}
defineTypes(SettingsState, {
  trackId: 'string', laps: 'uint8', collisions: 'boolean', damage: 'boolean',
  weapons: 'boolean', nitro: 'boolean', drift: 'boolean',
});

export class PlayerState extends Schema {
  declare id: string;
  declare name: string;
  declare tag: string;
  declare carClass: string;
  declare character: string;
  declare colorMain: string;
  declare colorSecondary: string;
  declare colorWheel: string;
  declare wheelStyle: string;
  declare ready: boolean;
  declare isHost: boolean;
  declare connected: boolean;
  declare status: string;
  // physics
  declare x: number; declare y: number; declare z: number;
  declare vx: number; declare vy: number; declare vz: number;
  declare yaw: number; declare yawRate: number;
  declare pitch: number; declare roll: number; declare pitchRate: number; declare rollRate: number;
  declare grounded: boolean;
  declare overturnT: number;
  declare rampVy: number;
  declare padCooldown: number;
  declare boosting: boolean;
  declare drifting: boolean;
  // combat
  declare health: number;
  declare nitro: number;
  declare fireCd: number;
  declare protectT: number;
  declare respawnT: number;
  // race
  declare laps: number;
  declare nextCp: number;
  declare progress: number;
  declare rank: number;
  declare finishPlace: number;
  declare ackSeq: number;
  declare joinOrder: number;

  constructor() {
    super();
    this.id = '';
    this.name = '';
    this.tag = '';
    Object.assign(this, DEFAULT_APPEARANCE);
    this.ready = false;
    this.isHost = false;
    this.connected = true;
    this.status = RacerStatus.LOBBY;
    this.x = this.y = this.z = this.vx = this.vy = this.vz = 0;
    this.yaw = this.yawRate = this.pitch = this.roll = this.pitchRate = this.rollRate = 0;
    this.grounded = true;
    this.overturnT = 0;
    this.rampVy = 0;
    this.padCooldown = 0;
    this.boosting = false;
    this.drifting = false;
    this.health = MAX_HEALTH;
    this.nitro = NITRO.start;
    this.fireCd = 0;
    this.protectT = 0;
    this.respawnT = 0;
    this.laps = 0;
    this.nextCp = 1;
    this.progress = 0;
    this.rank = 0;
    this.finishPlace = 0;
    this.ackSeq = 0;
    this.joinOrder = 0;
  }
}
defineTypes(PlayerState, {
  id: 'string', name: 'string', tag: 'string',
  carClass: 'string', character: 'string', colorMain: 'string', colorSecondary: 'string',
  colorWheel: 'string', wheelStyle: 'string',
  ready: 'boolean', isHost: 'boolean', connected: 'boolean', status: 'string',
  x: 'float32', y: 'float32', z: 'float32', vx: 'float32', vy: 'float32', vz: 'float32',
  yaw: 'float32', yawRate: 'float32', pitch: 'float32', roll: 'float32', pitchRate: 'float32', rollRate: 'float32',
  grounded: 'boolean', overturnT: 'float32', rampVy: 'float32', padCooldown: 'float32',
  boosting: 'boolean', drifting: 'boolean',
  health: 'float32', nitro: 'float32', fireCd: 'float32', protectT: 'float32', respawnT: 'float32',
  laps: 'uint8', nextCp: 'uint8', progress: 'float32', rank: 'uint8', finishPlace: 'uint8',
  ackSeq: 'uint32', joinOrder: 'uint16',
});

export class ProjectileState extends Schema {
  declare owner: string;
  declare x: number; declare y: number; declare z: number;
  declare vx: number; declare vz: number;
  constructor() {
    super();
    this.owner = '';
    this.x = this.y = this.z = this.vx = this.vz = 0;
  }
}
defineTypes(ProjectileState, {
  owner: 'string', x: 'float32', y: 'float32', z: 'float32', vx: 'float32', vz: 'float32',
});

export class RaceState extends Schema {
  declare phase: string;
  declare roomName: string;
  declare code: string;
  declare isPrivate: boolean;
  declare maxPlayers: number;
  declare hostId: string;
  declare countdown: number;
  declare raceId: number;
  declare settings: SettingsState;
  declare players: MapSchema<PlayerState>;
  declare projectiles: MapSchema<ProjectileState>;
  declare finishOrder: ArraySchema<string>;
  constructor() {
    super();
    this.phase = Phase.WAITING_FOR_PLAYERS;
    this.roomName = '';
    this.code = '';
    this.isPrivate = false;
    this.maxPlayers = 15;
    this.hostId = '';
    this.countdown = 0;
    this.raceId = 0;
    this.settings = new SettingsState();
    this.players = new MapSchema<PlayerState>();
    this.projectiles = new MapSchema<ProjectileState>();
    this.finishOrder = new ArraySchema<string>();
  }
}
defineTypes(RaceState, {
  phase: 'string', roomName: 'string', code: 'string', isPrivate: 'boolean', maxPlayers: 'uint8',
  hostId: 'string', countdown: 'float32', raceId: 'uint16',
  settings: SettingsState,
  players: { map: PlayerState },
  projectiles: { map: ProjectileState },
  finishOrder: ['string'],
});
