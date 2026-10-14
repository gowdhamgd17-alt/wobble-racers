import { Client, Room, ServerError } from '@colyseus/core';
import {
  COUNTDOWN_SECONDS, INPUT_LIMITS, MAX_HEALTH, MIN_PLAYERS_TO_START, MSG, NEUTRAL_INPUT, NITRO, PHYS, Phase,
  RECONNECT_GRACE_SECONDS, RESPAWN, RacerStatus, SIM_DT, SIM_HZ, PATCH_RATE_MS, WEAPON,
  createVehicleState, decodeInput, findSafeSpot, getTrack, getVehicle, initialProgress, placeOnTrack,
  progressScore, queryTrack, resolveCarCollision, sanitizeAppearance, sanitizeMaxPlayers, sanitizeSettings,
  stepVehicle, updateProgress, validateDisplayName, validateRoomName,
  type FxMessage, type FxType, type InputState, type ProgressState, type Track, type VehicleState,
} from '@wobble/shared';
import { PlayerState, ProjectileState, RaceState } from './schema';
import { allocateCode, releaseCode } from './codes';

interface Racer {
  sessionId: string;
  state: PlayerState;
  veh: VehicleState;
  prog: ProgressState;
  input: InputState;
  queue: { seq: number; input: InputState }[];
  inputTokens: number;
  actionTokens: number;
  rejectedInputs: number;
  destroyedT: number;
  deathF: number;
  deathLat: number;
  deathYaw: number;
  lastRank: number;
  overtakeCd: number;
  prevFire: boolean;
}

interface Projectile {
  id: string;
  owner: string;
  x: number; y: number; z: number;
  vx: number; vz: number;
  life: number;
  state: ProjectileState;
}

export interface CreateOptions {
  roomName?: string;
  private?: boolean;
  maxPlayers?: number;
  settings?: unknown;
  name?: string;
}

const LOBBY_PHASES: string[] = [Phase.WAITING_FOR_PLAYERS, Phase.LOBBY];

export class RaceRoom extends Room<RaceState> {
  racers = new Map<string, Racer>();
  projectiles: Projectile[] = [];
  track!: Track;
  pairCooldown = new Map<string, number>();
  fxQueue: FxMessage[] = [];
  joinCounter = 0;
  projCounter = 0;

  async onCreate(options: CreateOptions) {
    this.roomId = allocateCode();
    const state = new RaceState();
    state.code = this.roomId;
    state.isPrivate = options.private === true;
    state.maxPlayers = sanitizeMaxPlayers(options.maxPlayers);
    const hostName = validateDisplayName(options.name);
    state.roomName = validateRoomName(options.roomName, hostName.ok ? `${hostName.value}'s Room` : 'Wobble Room');
    Object.assign(state.settings, sanitizeSettings(options.settings));
    this.setState(state);
    this.maxClients = state.maxPlayers;
    this.track = getTrack(state.settings.trackId);
    if (state.isPrivate) await this.setPrivate(true);
    this.setPatchRate(PATCH_RATE_MS);
    this.updateMetadata();

    this.onMessage(MSG.INPUT, (client, raw) => this.handleInput(client, raw));
    this.onMessage(MSG.READY, (client, raw) => this.action(client, () => this.handleReady(client, raw)));
    this.onMessage(MSG.APPEARANCE, (client, raw) => this.action(client, () => this.handleAppearance(client, raw)));
    this.onMessage(MSG.SETTINGS, (client, raw) => this.action(client, () => this.handleSettings(client, raw)));
    this.onMessage(MSG.START, (client) => this.action(client, () => this.handleStart(client)));
    this.onMessage(MSG.REMATCH, (client) => this.action(client, () => this.handleBackToLobby(client, true)));
    this.onMessage(MSG.TO_LOBBY, (client) => this.action(client, () => this.handleBackToLobby(client, false)));
    this.onMessage(MSG.EMOTE, (client) => this.action(client, () => {
      const r = this.racers.get(client.sessionId);
      if (r) this.fx('wave', r.sessionId, r.veh.x, r.veh.y, r.veh.z, 0);
    }));
    this.onMessage('*', (client) => this.sendError(client, 'bad_message', 'Unknown message.'));

    this.setSimulationInterval((dtMs) => this.tick(dtMs), 1000 / SIM_HZ);
    // Token-bucket refill for rate limiting
    this.clock.setInterval(() => {
      for (const r of this.racers.values()) {
        r.inputTokens = Math.min(INPUT_LIMITS.maxPerSecond, r.inputTokens + INPUT_LIMITS.maxPerSecond / 10);
        r.actionTokens = Math.min(10, r.actionTokens + 1);
      }
    }, 100);
  }

  // ---------------------------------------------------------------- joining

  onAuth(_client: Client, options: { name?: unknown }) {
    const name = validateDisplayName(options?.name);
    if (!name.ok) throw new ServerError(4001, name.error);
    if (!LOBBY_PHASES.includes(this.state.phase)) throw new ServerError(4003, 'A race is already in progress in this room.');
    if (this.connectedCount() >= this.state.maxPlayers) throw new ServerError(4002, 'This room is full.');
    return { name: name.value };
  }

  onJoin(client: Client, options: { appearance?: unknown }, auth?: { name: string }) {
    const p = new PlayerState();
    p.id = client.sessionId;
    p.name = auth?.name ?? 'Racer';
    p.tag = '#' + client.sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase();
    Object.assign(p, sanitizeAppearance(options?.appearance));
    p.joinOrder = this.joinCounter++;
    p.connected = true;
    p.status = RacerStatus.LOBBY;
    this.state.players.set(client.sessionId, p);
    this.racers.set(client.sessionId, this.makeRacer(client.sessionId, p));
    if (!this.state.hostId || !this.state.players.get(this.state.hostId)?.connected) this.setHost(client.sessionId);
    this.refreshLobbyPhase();
    client.send(MSG.WELCOME, { id: client.sessionId });
  }

  async onLeave(client: Client, consented: boolean) {
    const r = this.racers.get(client.sessionId);
    if (!r) return;
    r.state.connected = false;
    r.state.ready = false;
    r.queue.length = 0;
    r.input = { ...NEUTRAL_INPUT };
    const racing = this.inRace();
    const statusBefore = r.state.status;
    if (racing && statusBefore !== RacerStatus.FINISHED) r.state.status = RacerStatus.DISCONNECTED;
    if (this.state.hostId === client.sessionId) this.reassignHost();
    this.refreshLobbyPhase();

    if (!consented) {
      try {
        await this.allowReconnection(client, RECONNECT_GRACE_SECONDS);
        // Reconnected: restore the same player record.
        r.state.connected = true;
        r.inputTokens = INPUT_LIMITS.maxPerSecond;
        if (this.inRace()) {
          if (r.state.status === RacerStatus.DISCONNECTED) {
            r.state.status = RacerStatus.RACING;
            r.state.protectT = RESPAWN.protectionSeconds;
          }
        } else {
          r.state.status = RacerStatus.LOBBY;
        }
        if (!this.state.hostId || !this.state.players.get(this.state.hostId)?.connected) this.setHost(client.sessionId);
        this.refreshLobbyPhase();
        return;
      } catch {
        // grace expired
      }
    }
    this.removeRacer(client.sessionId);
  }

  onDispose() {
    this.state.phase = Phase.CLOSED;
    releaseCode(this.roomId);
  }

  private removeRacer(id: string) {
    const r = this.racers.get(id);
    if (!r) return;
    if (this.inRace()) {
      // Keep the record so results can show them as "left".
      if (r.state.status !== RacerStatus.FINISHED) r.state.status = RacerStatus.LEFT;
      r.state.connected = false;
    } else {
      this.racers.delete(id);
      this.state.players.delete(id);
    }
    if (this.state.hostId === id) this.reassignHost();
    this.refreshLobbyPhase();
    this.checkRaceComplete();
  }

  private makeRacer(id: string, state: PlayerState): Racer {
    return {
      sessionId: id, state, veh: createVehicleState(0, 0, 0), prog: initialProgress(),
      input: { ...NEUTRAL_INPUT }, queue: [], inputTokens: INPUT_LIMITS.maxPerSecond, actionTokens: 10,
      rejectedInputs: 0, destroyedT: 0, deathF: 0, deathLat: 0, deathYaw: 0, lastRank: 0, overtakeCd: 0,
      prevFire: false,
    };
  }

  // ---------------------------------------------------------------- helpers

  inRace() {
    return this.state.phase === Phase.COUNTDOWN || this.state.phase === Phase.RACING;
  }

  connectedCount() {
    let n = 0;
    this.state.players.forEach((p) => { if (p.connected) n++; });
    return n;
  }

  private setHost(id: string) {
    this.state.players.forEach((p) => { p.isHost = p.id === id; });
    this.state.hostId = id;
  }

  private reassignHost() {
    const candidates = [...this.state.players.values()]
      .filter((p) => p.connected && p.status !== RacerStatus.LEFT)
      .sort((a, b) => a.joinOrder - b.joinOrder);
    if (candidates.length) this.setHost(candidates[0].id);
    else {
      this.state.hostId = '';
      this.state.players.forEach((p) => { p.isHost = false; });
    }
  }

  private refreshLobbyPhase() {
    if (LOBBY_PHASES.includes(this.state.phase)) {
      this.state.phase = this.connectedCount() >= MIN_PLAYERS_TO_START ? Phase.LOBBY : Phase.WAITING_FOR_PLAYERS;
    }
    this.updateMetadata();
  }

  private updateMetadata() {
    const t = getTrack(this.state.settings.trackId);
    void this.setMetadata({
      name: this.state.roomName,
      code: this.state.code,
      phase: this.state.phase,
      track: t.def.name,
      laps: this.state.settings.laps,
      isPrivate: this.state.isPrivate,
      players: this.connectedCount(),
      maxPlayers: this.state.maxPlayers,
    });
  }

  private sendError(client: Client, code: string, message: string) {
    client.send(MSG.ERROR, { code, message });
  }

  private action(client: Client, fn: () => void) {
    const r = this.racers.get(client.sessionId);
    if (!r || !r.state.connected) return;
    if (r.actionTokens < 1) return this.sendError(client, 'rate_limited', 'Slow down!');
    r.actionTokens -= 1;
    fn();
  }

  private fx(type: FxType, id: string, x: number, y: number, z: number, amount: number) {
    this.fxQueue.push([type, id, +x.toFixed(2), +y.toFixed(2), +z.toFixed(2), +amount.toFixed(2)]);
  }

  // ---------------------------------------------------------------- lobby messages

  handleReady(client: Client, raw: unknown) {
    if (!LOBBY_PHASES.includes(this.state.phase)) return;
    const p = this.state.players.get(client.sessionId);
    if (!p) return;
    p.ready = typeof raw === 'object' && raw !== null && 'ready' in raw ? (raw as { ready: unknown }).ready === true : !p.ready;
  }

  handleAppearance(client: Client, raw: unknown) {
    if (!LOBBY_PHASES.includes(this.state.phase)) return this.sendError(client, 'locked', 'You can only change cars in the lobby.');
    const p = this.state.players.get(client.sessionId);
    if (!p) return;
    Object.assign(p, sanitizeAppearance(raw, {
      carClass: p.carClass, character: p.character, colorMain: p.colorMain,
      colorSecondary: p.colorSecondary, colorWheel: p.colorWheel, wheelStyle: p.wheelStyle,
    }));
  }

  handleSettings(client: Client, raw: unknown) {
    if (client.sessionId !== this.state.hostId) return this.sendError(client, 'not_host', 'Only the host can change race settings.');
    if (!LOBBY_PHASES.includes(this.state.phase)) return this.sendError(client, 'locked', 'Settings are locked during a race.');
    const s = this.state.settings;
    Object.assign(s, sanitizeSettings(raw, {
      trackId: s.trackId, laps: s.laps, collisions: s.collisions, damage: s.damage,
      weapons: s.weapons, nitro: s.nitro, drift: s.drift,
    }));
    if (raw && typeof raw === 'object' && 'roomName' in raw) {
      this.state.roomName = validateRoomName((raw as { roomName: unknown }).roomName, this.state.roomName);
    }
    this.track = getTrack(s.trackId);
    // Changing the rules un-readies everyone so nobody is surprised.
    this.state.players.forEach((p) => { if (p.id !== this.state.hostId) p.ready = false; });
    this.updateMetadata();
  }

  /** Returns null if the race may start, otherwise a reason. Server-side check. */
  startBlocker(requesterId: string): string | null {
    if (requesterId !== this.state.hostId) return 'Only the host can start the race.';
    const connected = [...this.state.players.values()].filter((p) => p.connected);
    if (connected.length < MIN_PLAYERS_TO_START) return `At least ${MIN_PLAYERS_TO_START} players are needed.`;
    if (this.state.phase !== Phase.LOBBY) return 'The room is not in the lobby.';
    const notReady = connected.filter((p) => p.id !== this.state.hostId && !p.ready);
    if (notReady.length) return `Waiting for ${notReady.map((p) => p.name).join(', ')} to be ready.`;
    return null;
  }

  handleStart(client: Client) {
    const reason = this.startBlocker(client.sessionId);
    if (reason) return this.sendError(client, 'cannot_start', reason);
    this.beginCountdown();
  }

  beginCountdown() {
    void this.lock();
    // Anyone still in their reconnection grace period at start is dropped from the roster.
    for (const [id, r] of [...this.racers]) {
      if (!r.state.connected) { this.racers.delete(id); this.state.players.delete(id); }
    }
    this.track = getTrack(this.state.settings.trackId);
    this.state.raceId += 1;
    this.state.finishOrder.clear();
    this.projectiles.forEach((p) => this.state.projectiles.delete(p.id));
    this.projectiles = [];
    this.pairCooldown.clear();
    const order = [...this.racers.values()].sort((a, b) => a.state.joinOrder - b.state.joinOrder);
    order.forEach((r, i) => {
      const g = this.track.grid[i % this.track.grid.length];
      r.veh = createVehicleState(g.x, g.z, g.yaw);
      r.veh.nitro = this.state.settings.nitro ? NITRO.start : 0;
      r.prog = initialProgress();
      r.queue.length = 0;
      r.input = { ...NEUTRAL_INPUT };
      r.destroyedT = 0;
      r.lastRank = i + 1;
      const s = r.state;
      s.status = RacerStatus.RACING;
      s.health = MAX_HEALTH;
      s.fireCd = 0;
      s.protectT = 0;
      s.respawnT = 0;
      s.laps = 0;
      s.nextCp = 1;
      s.finishPlace = 0;
      s.rank = i + 1;
      s.ready = false;
      this.syncVehicle(r);
    });
    this.state.countdown = COUNTDOWN_SECONDS;
    this.state.phase = Phase.COUNTDOWN;
    this.updateMetadata();
  }

  handleBackToLobby(client: Client, rematch: boolean) {
    if (this.state.phase !== Phase.RESULTS) {
      if (LOBBY_PHASES.includes(this.state.phase) && rematch) {
        const p = this.state.players.get(client.sessionId);
        if (p) p.ready = true;
      }
      return;
    }
    // Purge players that left during the race.
    for (const [id, r] of [...this.racers]) {
      if (r.state.status === RacerStatus.LEFT || !r.state.connected) {
        this.racers.delete(id);
        this.state.players.delete(id);
      }
    }
    this.state.players.forEach((p) => {
      p.status = RacerStatus.LOBBY;
      p.ready = false;
    });
    const me = this.state.players.get(client.sessionId);
    if (me && rematch) me.ready = true;
    this.projectiles.forEach((p) => this.state.projectiles.delete(p.id));
    this.projectiles = [];
    this.state.phase = Phase.WAITING_FOR_PLAYERS;
    if (!this.state.players.get(this.state.hostId)) this.reassignHost();
    this.refreshLobbyPhase();
    if (this.connectedCount() < this.state.maxPlayers) void this.unlock();
  }

  // ---------------------------------------------------------------- input

  handleInput(client: Client, raw: unknown) {
    const r = this.racers.get(client.sessionId);
    if (!r || !r.state.connected) return;
    if (r.inputTokens < 1) { r.rejectedInputs++; return; }
    r.inputTokens -= 1;
    const d = decodeInput(raw);
    if (!d) { r.rejectedInputs++; return; }
    if (d.seq <= r.state.ackSeq && r.state.ackSeq !== 0) return; // stale / replayed
    const last = r.queue[r.queue.length - 1];
    if (last && d.seq <= last.seq) return;
    r.queue.push(d);
    if (r.queue.length > INPUT_LIMITS.maxQueue) r.queue.splice(0, r.queue.length - 2);
  }

  // ---------------------------------------------------------------- simulation

  tick(dtMs: number) {
    void dtMs; // fixed timestep for determinism
    const dt = SIM_DT;
    if (this.state.phase === Phase.COUNTDOWN) {
      this.state.countdown = Math.max(0, this.state.countdown - dt);
      // Consume inputs (ack them) but keep cars on the grid.
      for (const r of this.racers.values()) {
        const next = r.queue.shift();
        if (next) r.state.ackSeq = next.seq;
        r.queue.length = 0;
      }
      if (this.state.countdown <= 0) {
        this.state.phase = Phase.RACING;
        this.updateMetadata();
      }
    } else if (this.state.phase === Phase.RACING) {
      this.simulate(dt);
    }
    if (this.fxQueue.length) {
      this.broadcast(MSG.FX, this.fxQueue);
      this.fxQueue = [];
    }
  }

  private simulate(dt: number) {
    const settings = this.state.settings;
    const rules = { nitro: settings.nitro, drift: settings.drift };
    for (const [k, v] of this.pairCooldown) {
      if (v - dt <= 0) this.pairCooldown.delete(k);
      else this.pairCooldown.set(k, v - dt);
    }

    for (const r of this.racers.values()) {
      const s = r.state;
      // Pull exactly one queued input per tick (client sends one per tick).
      const next = r.queue.shift();
      if (next) { r.input = next.input; s.ackSeq = next.seq; }
      if (!s.connected || s.status === RacerStatus.LEFT || s.status === RacerStatus.DISCONNECTED) {
        r.input = { ...NEUTRAL_INPUT };
      }
      s.fireCd = Math.max(0, s.fireCd - dt);
      s.protectT = Math.max(0, s.protectT - dt);
      r.overtakeCd = Math.max(0, r.overtakeCd - dt);

      if (s.status === RacerStatus.DESTROYED) {
        r.destroyedT -= dt;
        s.respawnT = Math.max(0, r.destroyedT);
        if (r.destroyedT <= 0) this.respawn(r);
        continue;
      }
      if (s.status === RacerStatus.LEFT) continue;

      const cfg = getVehicle(s.carClass);
      const input = s.status === RacerStatus.DISCONNECTED ? NEUTRAL_INPUT : r.input;
      const ev = stepVehicle(r.veh, input, cfg, this.track, rules, dt);
      const v = r.veh;

      if (ev.boostPad) this.fx('pad', r.sessionId, v.x, v.y, v.z, 0);
      if (ev.landingSpeed > PHYS.landingDamageSpeed) {
        this.damage(r, (ev.landingSpeed - PHYS.landingDamageSpeed) * 2.5 / cfg.damageResistance, 'land');
      } else if (ev.landingSpeed > 6) {
        this.fx('land', r.sessionId, v.x, v.y, v.z, ev.landingSpeed);
      }
      if (ev.wallImpact > PHYS.wallDamageSpeed) {
        this.damage(r, (ev.wallImpact - PHYS.wallDamageSpeed) * 0.8 / cfg.damageResistance, 'wall');
      }
      if (ev.recover) this.recover(r);

      // Firing (edge or held: limited by cooldown)
      if (input.fire && settings.weapons && s.status === RacerStatus.RACING && s.fireCd <= 0) this.fire(r);

      // Lap progress (authoritative)
      if (s.status === RacerStatus.RACING) {
        const q = queryTrack(this.track, v.x, v.z, v.trackIdx);
        const pe = updateProgress(this.track, r.prog, q.f, q.lateral, settings.laps);
        if (pe === 'lap') this.fx('lap', r.sessionId, v.x, v.y, v.z, r.prog.laps);
        if (pe === 'finish') this.finish(r);
        s.progress = progressScore(this.track, r.prog, q.f);
      }
      s.laps = r.prog.laps;
      s.nextCp = r.prog.nextCp;
    }

    if (settings.collisions) this.collideCars();
    this.stepProjectiles(dt);
    this.updateRanks();
    for (const r of this.racers.values()) this.syncVehicle(r);
    this.checkRaceComplete();
  }

  private canCollide(r: Racer) {
    return r.state.status === RacerStatus.RACING && r.state.protectT <= 0;
  }

  private collideCars() {
    const list = [...this.racers.values()].filter((r) => this.canCollide(r));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const res = resolveCarCollision(a.veh, b.veh, getVehicle(a.state.carClass), getVehicle(b.state.carClass));
        if (!res.hit) continue;
        const key = a.sessionId < b.sessionId ? a.sessionId + '|' + b.sessionId : b.sessionId + '|' + a.sessionId;
        if (this.pairCooldown.has(key)) continue; // physical push still applied, no repeat damage
        this.pairCooldown.set(key, PHYS.collisionPairCooldown);
        if (res.closingSpeed > 4) {
          this.fx('crash', a.sessionId, (a.veh.x + b.veh.x) / 2, (a.veh.y + b.veh.y) / 2 + 0.6, (a.veh.z + b.veh.z) / 2, res.closingSpeed);
        }
        if (res.damageA > 0) this.damage(a, res.damageA, 'crash');
        if (res.damageB > 0) this.damage(b, res.damageB, 'crash');
      }
    }
  }

  private fire(r: Racer) {
    const mine = this.projectiles.filter((p) => p.owner === r.sessionId).length;
    if (mine >= WEAPON.maxProjectilesPerPlayer) return;
    r.state.fireCd = WEAPON.cooldown;
    const v = r.veh;
    const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
    const fwdSpeed = Math.max(0, v.vx * fx + v.vz * fz);
    const id = 'p' + this.projCounter++;
    const proj: Projectile = {
      id, owner: r.sessionId,
      x: v.x + fx * 2.6, y: v.y + 0.8, z: v.z + fz * 2.6,
      vx: fx * (WEAPON.projectileSpeed + fwdSpeed), vz: fz * (WEAPON.projectileSpeed + fwdSpeed),
      life: WEAPON.lifetime, state: new ProjectileState(),
    };
    proj.state.owner = r.sessionId;
    this.projectiles.push(proj);
    this.writeProjectile(proj);
    this.state.projectiles.set(id, proj.state);
    this.fx('shoot', r.sessionId, proj.x, proj.y, proj.z, 0);
  }

  private writeProjectile(p: Projectile) {
    p.state.x = p.x; p.state.y = p.y; p.state.z = p.z; p.state.vx = p.vx; p.state.vz = p.vz;
  }

  private stepProjectiles(dt: number) {
    const keep: Projectile[] = [];
    for (const p of this.projectiles) {
      const x0 = p.x, z0 = p.z;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      p.life -= dt;
      let hit: Racer | null = null;
      let bestT = 2;
      // Swept segment vs sphere around each eligible car
      const sx = p.x - x0, sz = p.z - z0;
      const len2 = sx * sx + sz * sz || 1;
      for (const r of this.racers.values()) {
        if (r.sessionId === p.owner || r.state.status !== RacerStatus.RACING || r.state.protectT > 0) continue;
        const v = r.veh;
        if (Math.abs(v.y + 0.6 - p.y) > 2.2) continue;
        const t = Math.max(0, Math.min(1, ((v.x - x0) * sx + (v.z - z0) * sz) / len2));
        const cx = x0 + sx * t, cz = z0 + sz * t;
        if ((v.x - cx) ** 2 + (v.z - cz) ** 2 < PHYS.carHitRadius ** 2 && t < bestT) { bestT = t; hit = r; }
      }
      // Projectiles stop at barriers
      const q = queryTrack(this.track, p.x, p.z);
      const hitWall = Math.abs(q.lateral) > this.track.halfWidth + PHYS.barrierInset && p.y < PHYS.barrierHeight + 1.2;
      if (hit) {
        const v = hit.veh;
        const l = Math.hypot(p.vx, p.vz) || 1;
        v.vx += (p.vx / l) * WEAPON.knockback;
        v.vz += (p.vz / l) * WEAPON.knockback;
        if (v.grounded && v.overturnT <= 0) { v.grounded = false; v.vy = WEAPON.knockUp; v.rollRate = 1.5; }
        this.fx('hit', hit.sessionId, v.x, v.y + 0.8, v.z, WEAPON.damage);
        this.damage(hit, WEAPON.damage / getVehicle(hit.state.carClass).damageResistance, 'shot', p.owner);
        this.state.projectiles.delete(p.id);
      } else if (p.life <= 0 || hitWall) {
        this.state.projectiles.delete(p.id);
      } else {
        this.writeProjectile(p);
        keep.push(p);
      }
    }
    this.projectiles = keep;
  }

  /** The only path by which health changes. */
  damage(r: Racer, amount: number, _cause: string, _by?: string) {
    const s = r.state;
    if (!this.state.settings.damage) return;
    if (s.status !== RacerStatus.RACING || s.protectT > 0 || s.health <= 0) return;
    if (!(amount > 0)) return;
    s.health = Math.max(0, s.health - amount);
    if (s.health <= 0) this.destroy(r);
  }

  private destroy(r: Racer) {
    const s = r.state;
    const v = r.veh;
    const q = queryTrack(this.track, v.x, v.z, v.trackIdx);
    r.deathF = q.f;
    r.deathLat = q.lateral;
    r.deathYaw = v.yaw;
    r.destroyedT = RESPAWN.destroyedSeconds;
    s.respawnT = RESPAWN.destroyedSeconds;
    s.status = RacerStatus.DESTROYED;
    s.health = 0;
    this.fx('explode', r.sessionId, v.x, v.y + 0.5, v.z, 0);
    v.vx = v.vy = v.vz = 0;
    v.boosting = false;
    v.drifting = false;
  }

  private occupiedExcept(r: Racer) {
    const out: { x: number; z: number }[] = [];
    for (const o of this.racers.values()) {
      if (o === r) continue;
      if (o.state.status === RacerStatus.RACING || o.state.status === RacerStatus.DISCONNECTED) out.push({ x: o.veh.x, z: o.veh.z });
    }
    return out;
  }

  respawn(r: Racer) {
    const spot = findSafeSpot(this.track, r.deathF, r.deathLat, this.occupiedExcept(r), RESPAWN.safeClearance);
    const nitro = r.veh.nitro;
    placeOnTrack(r.veh, this.track, spot.f, spot.lateral, r.deathYaw);
    r.veh.nitro = nitro;
    r.veh.recoverCooldown = 0;
    const s = r.state;
    s.health = MAX_HEALTH;
    s.protectT = RESPAWN.protectionSeconds;
    s.respawnT = 0;
    s.status = r.prog.finished ? RacerStatus.FINISHED : RacerStatus.RACING;
    this.fx('respawn', r.sessionId, r.veh.x, r.veh.y, r.veh.z, 0);
  }

  private recover(r: Racer) {
    const q = queryTrack(this.track, r.veh.x, r.veh.z);
    const spot = findSafeSpot(this.track, q.f, q.lateral, this.occupiedExcept(r), RESPAWN.safeClearance);
    const nitro = r.veh.nitro;
    placeOnTrack(r.veh, this.track, spot.f, spot.lateral, r.veh.yaw);
    r.veh.nitro = nitro;
    r.state.protectT = Math.max(r.state.protectT, 1);
    this.fx('respawn', r.sessionId, r.veh.x, r.veh.y, r.veh.z, 1);
  }

  private finish(r: Racer) {
    if (this.state.finishOrder.includes(r.sessionId)) return; // never twice
    this.state.finishOrder.push(r.sessionId);
    r.state.finishPlace = this.state.finishOrder.length;
    r.state.status = RacerStatus.FINISHED;
    r.state.protectT = 0;
    this.fx('finish', r.sessionId, r.veh.x, r.veh.y, r.veh.z, r.state.finishPlace);
  }

  private updateRanks() {
    const list = [...this.racers.values()].filter((r) => r.state.status !== RacerStatus.LEFT);
    list.sort((a, b) => {
      const fa = a.state.finishPlace || 999, fb = b.state.finishPlace || 999;
      if (fa !== fb) return fa - fb;
      return b.state.progress - a.state.progress;
    });
    list.forEach((r, i) => {
      const rank = i + 1;
      if (rank < r.lastRank && r.state.status === RacerStatus.RACING && r.overtakeCd <= 0 && this.state.phase === Phase.RACING) {
        this.fx('overtake', r.sessionId, r.veh.x, r.veh.y, r.veh.z, rank);
        r.overtakeCd = 3;
      }
      r.lastRank = rank;
      r.state.rank = rank;
    });
    // Left players rank after everyone else
    let n = list.length;
    for (const r of this.racers.values()) if (r.state.status === RacerStatus.LEFT) r.state.rank = ++n;
  }

  checkRaceComplete() {
    if (this.state.phase !== Phase.RACING) return;
    let active = 0;
    let connected = 0;
    for (const r of this.racers.values()) {
      const st = r.state.status;
      if (st === RacerStatus.RACING || st === RacerStatus.DESTROYED || st === RacerStatus.DISCONNECTED) active++;
      if (r.state.connected) connected++;
    }
    if (active === 0 || connected === 0) {
      this.state.phase = Phase.RESULTS;
      this.projectiles.forEach((p) => this.state.projectiles.delete(p.id));
      this.projectiles = [];
      this.updateMetadata();
    }
  }

  private syncVehicle(r: Racer) {
    const s = r.state, v = r.veh;
    s.x = v.x; s.y = v.y; s.z = v.z;
    s.vx = v.vx; s.vy = v.vy; s.vz = v.vz;
    s.yaw = v.yaw; s.yawRate = v.yawRate;
    s.pitch = v.pitch; s.roll = v.roll; s.pitchRate = v.pitchRate; s.rollRate = v.rollRate;
    s.grounded = v.grounded;
    s.overturnT = v.overturnT;
    s.rampVy = v.rampVy;
    s.padCooldown = v.padCooldown;
    s.boosting = v.boosting;
    s.drifting = v.drifting;
    s.nitro = v.nitro;
  }

  // Test / debugging hooks (server-side only; never reachable from clients)
  _racer(id: string) { return this.racers.get(id); }
}
