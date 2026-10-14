import { Client, Room, ServerError } from '@colyseus/core';
import {
  GameSim, INPUT_LIMITS, MIN_PLAYERS_TO_START, MSG, NEUTRAL_INPUT, Phase,
  RECONNECT_GRACE_SECONDS, RESPAWN, RacerStatus, SIM_HZ, SIM_DT, PATCH_RATE_MS,
  createSimRacer, decodeInput, sanitizeAppearance, sanitizeMaxPlayers, sanitizeSettings, validateDisplayName, validateRoomName,
  worldName, type FxType, type RaceSettings, type SimPlayer, type SimRacer,
} from '@wobble/shared';
import { PickupState, PlayerState, ProjectileState, RaceState } from './schema';
import { allocateCode, releaseCode } from './codes';

type Racer = SimRacer & {
  sessionId: string;
  state: PlayerState;
  inputTokens: number;
  actionTokens: number;
  rejectedInputs: number;
};

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
  sim!: GameSim<Racer>;
  joinCounter = 0;

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
    this.sim = new GameSim<Racer>(state.settings as unknown as RaceSettings);
    this.sim.racers = this.racers;
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
      if (r) this.sim.fx('wave', r.sessionId, r.veh.x, r.veh.y, r.veh.z, 0);
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
    const base = createSimRacer(id, state as unknown as SimPlayer, false, state.joinOrder);
    return Object.assign(base, {
      sessionId: id, state, inputTokens: INPUT_LIMITS.maxPerSecond, actionTokens: 10, rejectedInputs: 0,
    });
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
    void this.setMetadata({
      name: this.state.roomName,
      code: this.state.code,
      phase: this.state.phase,
      track: worldName(this.state.settings),
      mode: this.state.settings.mode,
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
    this.sim.fx(type, id, x, y, z, amount);
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
      colorSecondary: p.colorSecondary, colorWheel: p.colorWheel, wheelStyle: p.wheelStyle, weapon: p.weapon,
    }));
    p.curWeapon = p.weapon;
  }

  handleSettings(client: Client, raw: unknown) {
    if (client.sessionId !== this.state.hostId) return this.sendError(client, 'not_host', 'Only the host can change race settings.');
    if (!LOBBY_PHASES.includes(this.state.phase)) return this.sendError(client, 'locked', 'Settings are locked during a race.');
    const s = this.state.settings;
    Object.assign(s, sanitizeSettings(raw, {
      mode: s.mode, arenaId: s.arenaId, killTarget: s.killTarget, timeLimit: s.timeLimit,
      layout: s.layout, trackId: s.trackId, distanceKm: s.distanceKm, laps: s.laps, collisions: s.collisions, damage: s.damage,
      weapons: s.weapons, nitro: s.nitro, drift: s.drift,
    }));
    if (raw && typeof raw === 'object' && 'roomName' in raw) {
      this.state.roomName = validateRoomName((raw as { roomName: unknown }).roomName, this.state.roomName);
    }
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
    this.state.raceId += 1;
    this.state.finishOrder.clear();
    this.state.projectiles.clear();
    this.state.pickups.clear();
    const order = [...this.racers.values()].sort((a, b) => a.state.joinOrder - b.state.joinOrder);
    for (const r of order) r.state.ready = false;
    this.sim.settings = this.state.settings as unknown as RaceSettings;
    this.sim.begin(order);
    for (const pk of this.sim.pickups) {
      const ps = new PickupState();
      ps.kind = pk.kind; ps.x = pk.x; ps.y = pk.y; ps.z = pk.z; ps.active = pk.active;
      this.state.pickups.set(pk.id, ps);
    }
    this.state.countdown = this.sim.countdown;
    this.state.timeLeft = this.sim.timeLeft;
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
    this.state.projectiles.clear();
    this.sim.projectiles = [];
    this.sim.phase = Phase.LOBBY;
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
    const before = this.state.phase;
    if (this.state.phase === Phase.COUNTDOWN || this.state.phase === Phase.RACING) {
      this.sim.settings = this.state.settings as unknown as RaceSettings;
      this.sim.tick(SIM_DT);
      this.publishSim();
    }
    if (this.state.phase !== before) this.updateMetadata();
    if (this.sim.fxOut.length) {
      this.broadcast(MSG.FX, this.sim.fxOut);
      this.sim.fxOut = [];
    }
    if (this.sim.killsOut.length) {
      this.broadcast(MSG.KILL, this.sim.killsOut);
      this.sim.killsOut = [];
    }
  }

  /** Mirror the simulation's shared objects into the synced schema. */
  private publishSim() {
    const st = this.state, sim = this.sim;
    st.countdown = sim.countdown;
    st.timeLeft = sim.timeLeft;
    st.phase = sim.phase;
    for (let i = st.finishOrder.length; i < sim.finishOrder.length; i++) st.finishOrder.push(sim.finishOrder[i]);
    if (sim.phase === Phase.RESULTS && sim.battle) {
      st.finishOrder.clear();
      sim.finishOrder.forEach((id) => st.finishOrder.push(id));
    }
    const live = new Set<string>();
    for (const pr of sim.projectiles) {
      live.add(pr.id);
      let ps = st.projectiles.get(pr.id);
      if (!ps) {
        ps = new ProjectileState();
        ps.owner = pr.owner;
        ps.kind = pr.kind;
        st.projectiles.set(pr.id, ps);
      }
      ps.x = pr.x; ps.y = pr.y; ps.z = pr.z; ps.vx = pr.vx; ps.vy = pr.vy; ps.vz = pr.vz;
    }
    for (const id of [...st.projectiles.keys()]) if (!live.has(id)) st.projectiles.delete(id);
    for (const pk of sim.pickups) {
      const ps = st.pickups.get(pk.id);
      if (ps && ps.active !== pk.active) ps.active = pk.active;
    }
  }

  /** The only path by which health changes (delegates to the shared simulation). */
  damage(r: Racer, amount: number, cause: string, by?: string) {
    this.sim.settings = this.state.settings as unknown as RaceSettings;
    this.sim.damage(r, amount, cause, by);
    this.publishSim();
  }

  respawn(r: Racer) {
    this.sim.respawn(r);
    this.sim.sync(r);
  }

  checkRaceComplete() {
    if (this.state.phase !== Phase.RACING) return;
    this.sim.checkComplete();
    this.publishSim();
    if (this.state.phase !== Phase.RACING) this.updateMetadata();
  }

  // Test / debugging hooks (server-side only; never reachable from clients)
  _racer(id: string) { return this.racers.get(id); }
}
