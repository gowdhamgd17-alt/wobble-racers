import { Client, Room } from 'colyseus.js';
import { useSyncExternalStore } from 'react';
import { DEFAULT_SETTINGS, MSG, ROOM_NAME, sanitizeSettings, type Appearance, type FxMessage, type KillEvent, type RaceSettings } from '@wobble/shared';
import { LocalRoom } from './LocalRoom';

export function serverUrls() {
  const env = (import.meta.env.VITE_SERVER_URL as string | undefined)?.trim();
  let ws: string;
  if (env) ws = env.replace(/\/$/, '');
  else if (import.meta.env.DEV) ws = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:2567`;
  else ws = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  const http = ws.replace(/^ws/, 'http');
  return { ws, http };
}

export interface PlayerSnap {
  id: string;
  name: string;
  tag: string;
  carClass: string;
  character: string;
  colorMain: string;
  colorSecondary: string;
  colorWheel: string;
  wheelStyle: string;
  weapon: string;
  kills: number;
  deaths: number;
  ready: boolean;
  isHost: boolean;
  connected: boolean;
  status: string;
  health: number;
  laps: number;
  rank: number;
  finishPlace: number;
  joinOrder: number;
}

export interface RoomSnap {
  phase: string;
  roomName: string;
  code: string;
  isPrivate: boolean;
  maxPlayers: number;
  hostId: string;
  countdown: number;
  raceId: number;
  settings: RaceSettings;
  players: PlayerSnap[];
  finishOrder: string[];
}

export interface RoomListing {
  code: string;
  clients: number;
  maxClients: number;
  locked: boolean;
  metadata: { name?: string; phase?: string; track?: string; laps?: number; players?: number; maxPlayers?: number };
}

export type ConnStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';

const RECONNECT_KEY = 'wobble.reconnect';

export const SERVER_MISSING_MSG = () =>
  `The WOBBLE RACERS game server isn't reachable at ${serverUrls().http}. The website is up, but the multiplayer server (the server/ folder) must also be running there, or the site must be built with VITE_SERVER_URL pointing to it.`;

/** True when the game server answers its health check (not just any web host). */
export async function checkServer(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${serverUrls().http}/health`, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return body?.ok === true;
  } catch {
    return false;
  }
}

function friendlyError(e: unknown): string {
  const err = e as { code?: number; message?: string } | undefined;
  const msg = err?.message ?? '';
  // Plain HTTP errors (404/405/5xx) mean we reached a web host that isn't the game server.
  if (typeof err?.code === 'number' && err.code >= 400 && err.code < 600) return SERVER_MISSING_MSG();
  if (err?.code === 4001) return msg || 'Please enter a valid display name.';
  if (err?.code === 4002 || /full/i.test(msg)) return 'That room is full (15/15).';
  if (err?.code === 4003 || /locked|in progress/i.test(msg)) return 'That room is mid-race. Try again when it returns to the lobby.';
  if (/not found|invalid room/i.test(msg) || err?.code === 4212) return 'Room not found. Check the code and try again.';
  if (/ECONNREFUSED|Failed to fetch|NetworkError|network|connect/i.test(msg) || err?.code === undefined)
    return "Can't reach the game server. Check your connection or try again shortly.";
  return msg || 'Something went wrong talking to the server.';
}

class NetSession {
  client: Client;
  room: Room<any> | null = null;
  status: ConnStatus = 'idle';
  myId = '';
  lastError = '';
  private snap: RoomSnap | null = null;
  private listeners = new Set<() => void>();
  private fxListeners = new Set<(fx: FxMessage[]) => void>();
  private errorListeners = new Set<(e: { code: string; message: string }) => void>();
  private patchListeners = new Set<() => void>();
  private notifyQueued = false;
  private version = 0;

  constructor() {
    this.client = new Client(serverUrls().ws);
  }

  // ------------------------------------------------- subscriptions
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  };
  getVersion = () => this.version;
  onFx(l: (fx: FxMessage[]) => void) { this.fxListeners.add(l); return () => { this.fxListeners.delete(l); }; }
  private killListeners = new Set<(k: KillEvent[]) => void>();
  onKill(l: (k: KillEvent[]) => void) { this.killListeners.add(l); return () => { this.killListeners.delete(l); }; }
  onServerError(l: (e: { code: string; message: string }) => void) { this.errorListeners.add(l); return () => { this.errorListeners.delete(l); }; }
  /** Fires on every state patch (used by the game loop, not React). */
  onPatch(l: () => void) { this.patchListeners.add(l); return () => { this.patchListeners.delete(l); }; }

  private emit() {
    this.version++;
    this.listeners.forEach((l) => l());
  }
  private queueNotify() {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    setTimeout(() => {
      this.notifyQueued = false;
      this.snap = this.room ? buildSnap(this.room.state) : null;
      this.emit();
    }, 80);
  }

  get snapshot() { return this.snap; }

  // ------------------------------------------------- room lifecycle
  private bind(room: Room<any>) {
    this.room = room;
    this.myId = room.sessionId;
    this.status = 'connected';
    this.lastError = '';
    if (!this.offline) try { sessionStorage.setItem(RECONNECT_KEY, JSON.stringify({ token: room.reconnectionToken, at: Date.now() })); } catch { /* ignore */ }
    room.onStateChange(() => {
      this.patchListeners.forEach((l) => l());
      this.queueNotify();
    });
    room.onMessage(MSG.FX, (list: FxMessage[]) => this.fxListeners.forEach((l) => l(list)));
    room.onMessage(MSG.KILL, (list: KillEvent[]) => this.killListeners.forEach((l) => l(list)));
    room.onMessage(MSG.ERROR, (e: { code: string; message: string }) => this.errorListeners.forEach((l) => l(e)));
    room.onMessage(MSG.WELCOME, () => {});
    room.onLeave((code) => this.handleLeave(room, code));
    room.onError((code, message) => console.warn('room error', code, message));
    this.snap = room.state ? buildSnap(room.state) : null;
    this.emit();
  }

  private async handleLeave(room: Room<any>, code: number) {
    // Deliberate leaves clear this.room first, so they never reach the reconnect path.
    if (room !== this.room) return;
    // Unexpected: try to reconnect within the server's grace period.
    const token = room.reconnectionToken;
    this.status = 'reconnecting';
    this.emit();
    const deadline = Date.now() + 19000;
    while (Date.now() < deadline) {
      try {
        const r = await this.client.reconnect<any>(token);
        this.bind(r);
        return;
      } catch (e) {
        const msg = (e as Error)?.message ?? '';
        if (/not found|expired|invalid/i.test(msg)) break;
        await new Promise((res) => setTimeout(res, 1500));
      }
    }
    this.clearRoom(code === 4000 ? 'The room was closed.' : 'Connection lost. The race continued without you.');
  }

  private clearRoom(error = '') {
    this.room = null;
    this.snap = null;
    this.status = 'idle';
    this.lastError = error;
    try { sessionStorage.removeItem(RECONNECT_KEY); } catch { /* ignore */ }
    this.emit();
  }

  async tryResume(): Promise<boolean> {
    let saved: { token: string; at: number } | null = null;
    try { saved = JSON.parse(sessionStorage.getItem(RECONNECT_KEY) ?? 'null'); } catch { /* ignore */ }
    if (!saved || Date.now() - saved.at > 60 * 60 * 1000) return false;
    this.status = 'reconnecting';
    this.emit();
    try {
      this.bind(await this.client.reconnect<any>(saved.token));
      return true;
    } catch {
      this.clearRoom('');
      return false;
    }
  }

  private async connect(fn: () => Promise<Room<any>>) {
    if (this.room) await this.leave();
    this.offline = false;
    this.status = 'connecting';
    this.lastError = '';
    this.emit();
    try {
      if (!(await checkServer())) throw Object.assign(new Error(SERVER_MISSING_MSG()), { code: 0, known: true });
      this.bind(await fn());
    } catch (e) {
      this.status = 'idle';
      this.lastError = (e as { known?: boolean }).known ? (e as Error).message : friendlyError(e);
      this.emit();
      throw new Error(this.lastError);
    }
  }

  /** Offline practice against in-browser bots (no server needed). */
  offline = false;
  lastPractice: { settings: Partial<RaceSettings>; bots: number } = { settings: {}, bots: 7 };
  async practice(name: string, appearance: Appearance, settings: Partial<RaceSettings> = {}, bots = 7) {
    if (this.room) await this.leave();
    this.offline = true;
    this.lastPractice = { settings, bots };
    this.bind(new LocalRoom(name || 'You', appearance, sanitizeSettings(settings, { ...DEFAULT_SETTINGS, laps: 2 }), bots) as unknown as Room<any>);
  }

  quickPlay(name: string, appearance: Appearance) {
    return this.connect(() => this.client.joinOrCreate<any>(ROOM_NAME, { name, appearance }));
  }

  createRoom(name: string, appearance: Appearance, opts: { roomName: string; private: boolean; maxPlayers: number; settings: Partial<RaceSettings> }) {
    return this.connect(() => this.client.create<any>(ROOM_NAME, { name, appearance, ...opts }));
  }

  async joinByCode(code: string, name: string, appearance: Appearance) {
    const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean) throw new Error('Enter a room code.');
    return this.connect(() => this.client.joinById<any>(clean, { name, appearance }));
  }

  async listRooms(): Promise<RoomListing[]> {
    const res = await fetch(`${serverUrls().http}/api/rooms`).catch(() => null);
    const data = res && res.ok ? await res.json().catch(() => null) : null;
    if (!Array.isArray(data)) throw new Error(SERVER_MISSING_MSG());
    return data;
  }

  async leave() {
    const room = this.room;
    if (!room) return;
    this.clearRoom('');
    try { await room.leave(true); } catch { /* already gone */ }
  }

  send(type: string, payload?: unknown) {
    if (this.room && this.status === 'connected') this.room.send(type, payload);
  }

  dismissError() {
    this.lastError = '';
    this.emit();
  }
}

function buildSnap(s: any): RoomSnap {
  const players: PlayerSnap[] = [];
  s.players?.forEach((p: any) => {
    players.push({
      id: p.id, name: p.name, tag: p.tag, carClass: p.carClass, character: p.character,
      colorMain: p.colorMain, colorSecondary: p.colorSecondary, colorWheel: p.colorWheel, wheelStyle: p.wheelStyle,
      weapon: p.weapon, kills: p.kills ?? 0, deaths: p.deaths ?? 0,
      ready: p.ready, isHost: p.isHost, connected: p.connected, status: p.status, health: p.health,
      laps: p.laps, rank: p.rank, finishPlace: p.finishPlace, joinOrder: p.joinOrder,
    });
  });
  players.sort((a, b) => a.joinOrder - b.joinOrder);
  const st = s.settings ?? {};
  return {
    phase: s.phase, roomName: s.roomName, code: s.code, isPrivate: s.isPrivate, maxPlayers: s.maxPlayers,
    hostId: s.hostId, countdown: s.countdown, raceId: s.raceId,
    settings: { mode: st.mode ?? 'race', arenaId: st.arenaId ?? 'town', killTarget: st.killTarget ?? 10, timeLimit: st.timeLimit ?? 5, layout: st.layout, trackId: st.trackId, distanceKm: st.distanceKm, laps: st.laps, collisions: st.collisions, damage: st.damage, weapons: st.weapons, nitro: st.nitro, drift: st.drift },
    players,
    finishOrder: s.finishOrder ? [...s.finishOrder] : [],
  };
}

export const net = new NetSession();

/** React hook: re-renders on room/connection changes (throttled). */
export function useNet() {
  useSyncExternalStore(net.subscribe, net.getVersion, net.getVersion);
  return { snap: net.snapshot, status: net.status, myId: net.myId, error: net.lastError };
}
