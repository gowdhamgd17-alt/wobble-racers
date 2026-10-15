// Integration tests: a real Colyseus server on a random port, driven by real
// colyseus.js WebSocket clients (the same client library the browser uses).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Room } from 'colyseus.js';
import { matchMaker } from '@colyseus/core';
import { MSG, Phase, RacerStatus, encodeInput, NEUTRAL_INPUT, getTrack, placeOnTrack } from '@wobble/shared';
import { createGameServer } from '../src/app';
import type { RaceRoom } from '../src/RaceRoom';

let port = 0;
let server: Awaited<ReturnType<typeof createGameServer>>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  port = 23000 + Math.floor(Math.random() * 2000);
  server = await createGameServer({ port });
});
afterAll(async () => {
  await server.gameServer.gracefullyShutdown(false).catch(() => {});
});

const url = () => `ws://127.0.0.1:${port}`;
const open: Room<any>[] = [];

async function createRoom(name = 'Host', opts: Record<string, unknown> = {}) {
  const c = new Client(url());
  const room = await c.create<any>('race', { name, private: true, ...opts });
  open.push(room);
  return { client: c, room };
}
async function joinRoom(code: string, name: string) {
  const c = new Client(url());
  const room = await c.joinById<any>(code, { name });
  open.push(room);
  return { client: c, room };
}
async function until(fn: () => boolean, timeout = 4000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeout) throw new Error('timeout waiting for condition');
    await sleep(20);
  }
}
const serverRoom = (code: string) => matchMaker.getRoomById(code) as unknown as RaceRoom;
function nextError(room: Room<any>) {
  return new Promise<{ code: string; message: string }>((resolve) => room.onMessage(MSG.ERROR, resolve));
}
async function leaveAll() {
  await Promise.all(open.splice(0).map((r) => r.leave(true).catch(() => {})));
}

/** Room with `count` players; everyone except host marked ready. */
async function lobby(count: number) {
  const host = await createRoom('Host');
  const code = host.room.roomId;
  const guests = [];
  for (let i = 1; i < count; i++) guests.push(await joinRoom(code, `P${i}`));
  for (const g of guests) g.room.send(MSG.READY, { ready: true });
  await until(() => host.room.state.players.size === count && [...host.room.state.players.values()].filter((p: any) => p.ready).length === count - 1);
  return { host, guests, code };
}

describe('names & capacity', () => {
  it('rejects an empty name at join time', async () => {
    const c = new Client(url());
    await expect(c.create<any>('race', { name: '   ' })).rejects.toThrow(/display name/i);
  });

  it('accepts two players with server-assigned ids and live names', async () => {
    const { host, guests } = await lobby(2);
    const ids = [...host.room.state.players.keys()];
    expect(ids).toContain(host.room.sessionId);
    expect(ids).toContain(guests[0].room.sessionId);
    expect([...host.room.state.players.values()].map((p: any) => p.name).sort()).toEqual(['Host', 'P1']);
    expect(host.room.state.phase).toBe(Phase.LOBBY);
    await leaveAll();
  });

  it('accepts 15 players and rejects the 16th', async () => {
    const { host, code } = await lobby(15);
    expect(host.room.state.players.size).toBe(15);
    const c = new Client(url());
    await expect(c.joinById<any>(code, { name: 'Sixteen' })).rejects.toThrow();
    await leaveAll();
  });

  it('a single player waits for more players', async () => {
    const { room } = await createRoom('Lonely');
    await until(() => room.state.phase === Phase.WAITING_FOR_PLAYERS);
    room.send(MSG.START);
    const err = await nextError(room);
    expect(err.code).toBe('cannot_start');
    expect(room.state.phase).toBe(Phase.WAITING_FOR_PLAYERS);
    await leaveAll();
  });
});

describe('starting a race', () => {
  it('cannot start with one player', async () => {
    const { room } = await createRoom('Solo');
    const sr = serverRoom(room.roomId);
    expect(sr.startBlocker(room.sessionId)).toMatch(/2 players/);
    await leaveAll();
  });

  it('starts with exactly two ready players (13 empty slots)', async () => {
    const { host } = await lobby(2);
    host.room.send(MSG.START);
    await until(() => host.room.state.phase === Phase.COUNTDOWN);
    await until(() => host.room.state.phase === Phase.RACING, 5000);
    expect([...host.room.state.players.values()].every((p: any) => p.status === RacerStatus.RACING)).toBe(true);
    await leaveAll();
  });

  it('starts with 15 ready players', async () => {
    const { host } = await lobby(15);
    host.room.send(MSG.START);
    await until(() => host.room.state.phase === Phase.COUNTDOWN);
    expect(host.room.state.players.size).toBe(15);
    await leaveAll();
  });

  it('non-host cannot start; not-ready guests block start', async () => {
    const host = await createRoom('Host');
    const g = await joinRoom(host.room.roomId, 'Guest');
    await until(() => host.room.state.players.size === 2);
    g.room.send(MSG.START);
    expect((await nextError(g.room)).code).toBe('cannot_start');
    host.room.send(MSG.START);
    expect((await nextError(host.room)).message).toMatch(/Guest/);
    expect(host.room.state.phase).toBe(Phase.LOBBY);
    await leaveAll();
  });

  it('host can change laps; guests cannot; settings lock during race', async () => {
    const { host, guests } = await lobby(2);
    host.room.send(MSG.SETTINGS, { laps: 7, weapons: false });
    await until(() => host.room.state.settings.laps === 7);
    expect(host.room.state.settings.weapons).toBe(false);
    guests[0].room.send(MSG.SETTINGS, { laps: 1 });
    expect((await nextError(guests[0].room)).code).toBe('not_host');
    expect(host.room.state.settings.laps).toBe(7);
    // invalid lap count ignored
    host.room.send(MSG.SETTINGS, { laps: 42 });
    await sleep(150);
    expect(host.room.state.settings.laps).toBe(7);
    // layout + distance
    host.room.send(MSG.SETTINGS, { layout: 'straight', distanceKm: 5 });
    await until(() => host.room.state.settings.layout === 'straight');
    expect(host.room.state.settings.trackId).toBe('canyon');
    expect(host.room.state.settings.distanceKm).toBe(5);
    host.room.send(MSG.SETTINGS, { distanceKm: 4 }); // not an option
    await sleep(150);
    expect(host.room.state.settings.distanceKm).toBe(5);
    await leaveAll();
  });

  it('host migrates when the host leaves', async () => {
    const { host, guests } = await lobby(3);
    await host.room.leave(true);
    open.splice(open.indexOf(host.room), 1);
    await until(() => guests[0].room.state.hostId === guests[0].room.sessionId);
    await leaveAll();
  });
});

async function racing(count = 2) {
  const l = await lobby(count);
  l.host.room.send(MSG.START);
  await until(() => l.host.room.state.phase === Phase.RACING, 6000);
  return { ...l, sr: serverRoom(l.code) };
}

describe('authoritative race rules', () => {
  it('clients cannot set health or laps via messages', async () => {
    const { host, sr } = await racing(2);
    host.room.send(MSG.APPEARANCE, { health: 999, laps: 9, carClass: 'bruiser' });
    host.room.send('laps', 10);
    host.room.send('health', 100);
    host.room.send(MSG.INPUT, { laps: 5, health: 500 });
    host.room.send(MSG.INPUT, [1, 0, 0, 0, 999]);
    await sleep(200);
    const r = sr._racer(host.room.sessionId)!;
    expect(r.state.laps).toBe(0);
    expect(r.state.health).toBe(r.state.maxHealth);
    expect(r.state.maxHealth).toBe(380);
    expect(r.state.carClass).toBe('drifter'); // appearance locked during race
    expect(r.rejectedInputs).toBeGreaterThanOrEqual(2);
    await leaveAll();
  });

  it('input rate limiting drops floods', async () => {
    const { host, sr } = await racing(2);
    for (let i = 1; i <= 400; i++) host.room.send(MSG.INPUT, encodeInput(i, { ...NEUTRAL_INPUT, throttle: 1 }));
    await sleep(300);
    const r = sr._racer(host.room.sessionId)!;
    expect(r.rejectedInputs).toBeGreaterThan(300);
    expect(r.queue.length).toBeLessThanOrEqual(8);
    await leaveAll();
  });

  it('destroyed cars respawn near where they died, keep lap progress, and get spawn protection', async () => {
    const { host, sr } = await racing(2);
    const r = sr._racer(host.room.sessionId)!;
    const track = getTrack(sr.state.settings);
    placeOnTrack(r.veh, track, 200, 3);
    r.prog.laps = 1;
    r.prog.nextCp = 4;
    const deathX = r.veh.x, deathZ = r.veh.z;
    sr.damage(r, 100000, 'test');
    expect(r.state.status).toBe(RacerStatus.DESTROYED);
    // Repeated damage in the same frame does nothing (no double destroy)
    sr.damage(r, 100000, 'test');
    await until(() => r.state.status === RacerStatus.RACING, 4000);
    expect(r.state.health).toBe(r.state.maxHealth);
    expect(r.prog.laps).toBe(1);
    expect(r.prog.nextCp).toBe(4);
    expect(Math.hypot(r.veh.x - deathX, r.veh.z - deathZ)).toBeLessThan(25);
    expect(r.state.protectT).toBeGreaterThan(0);
    // Spawn protection blocks immediate re-destruction
    sr.damage(r, 100000, 'test');
    expect(r.state.health).toBe(r.state.maxHealth);
    expect(r.state.status).toBe(RacerStatus.RACING);
    await leaveAll();
  });

  it('respawn avoids spawning inside another car', async () => {
    const { host, guests, sr } = await racing(2);
    const a = sr._racer(host.room.sessionId)!;
    const b = sr._racer(guests[0].room.sessionId)!;
    const track = getTrack(sr.state.settings);
    placeOnTrack(a.veh, track, 300, 0);
    sr.damage(a, 100000, 'test');
    placeOnTrack(b.veh, track, 300, 0); // park B on the death spot
    await until(() => a.state.status === RacerStatus.RACING, 4000);
    expect(Math.hypot(a.veh.x - b.veh.x, a.veh.z - b.veh.z)).toBeGreaterThan(4);
    await leaveAll();
  });

  it('projectiles hit only when they physically reach the target', async () => {
    const { host, guests, sr } = await racing(2);
    const a = sr._racer(host.room.sessionId)!;
    const b = sr._racer(guests[0].room.sessionId)!;
    const track = getTrack(sr.state.settings);
    placeOnTrack(a.veh, track, 300, 0);
    placeOnTrack(b.veh, track, 308, 0); // ~18m ahead
    a.state.protectT = 0; b.state.protectT = 0;
    sr.sim.time = 10; // past the race's weapon hold at the start
    let seq = 1000;
    const firing = setInterval(() => host.room.send(MSG.INPUT, encodeInput(seq++, { ...NEUTRAL_INPUT, fire: true })), 33);
    await until(() => b.state.health < b.state.maxHealth, 3000);
    clearInterval(firing);
    expect(b.state.health).toBeLessThanOrEqual(b.state.maxHealth - 15);
    expect(a.state.health).toBe(a.state.maxHealth);
    expect(a.state.ammo).toBeLessThan(30);
    await leaveAll();
  });

  it('finishing is validated by checkpoints and cannot happen twice', async () => {
    const { host, guests, sr } = await racing(2);
    sr.state.settings.laps = 1;
    const a = sr._racer(host.room.sessionId)!;
    const track = getTrack(sr.state.settings);
    // Teleporting next to the finish without checkpoints does not finish.
    placeOnTrack(a.veh, track, track.n - 3, 0);
    a.veh.vx = Math.sin(a.veh.yaw) * 20; a.veh.vz = Math.cos(a.veh.yaw) * 20;
    await sleep(400);
    expect(a.state.status).toBe(RacerStatus.RACING);
    expect(a.prog.laps).toBe(0);
    // With all checkpoints legitimately passed, crossing the line finishes.
    a.prog.nextCp = 0;
    placeOnTrack(a.veh, track, track.n - 3, 0);
    a.veh.vx = Math.sin(a.veh.yaw) * 20; a.veh.vz = Math.cos(a.veh.yaw) * 20;
    await until(() => a.state.status === RacerStatus.FINISHED, 2000);
    expect([...sr.state.finishOrder]).toEqual([host.room.sessionId]);
    // Attempt a second finish
    a.prog.finished = false; a.prog.nextCp = 0; a.state.status = RacerStatus.RACING;
    placeOnTrack(a.veh, track, track.n - 3, 0);
    a.veh.vx = Math.sin(a.veh.yaw) * 20; a.veh.vz = Math.cos(a.veh.yaw) * 20;
    await sleep(500);
    expect([...sr.state.finishOrder]).toEqual([host.room.sessionId]);
    expect(sr.state.phase).toBe(Phase.RACING); // race continues for others: no time limit
    void guests;
    await leaveAll();
  });

  it('a straight sprint is finished by crossing every checkpoint, once', async () => {
    const l = await lobby(2);
    l.host.room.send(MSG.SETTINGS, { layout: 'straight', trackId: 'coast', distanceKm: 1 });
    await until(() => l.host.room.state.settings.layout === 'straight');
    l.guests[0].room.send(MSG.READY, { ready: true });
    await until(() => [...l.host.room.state.players.values()].filter((p: any) => p.ready).length === 1);
    l.host.room.send(MSG.START);
    await until(() => l.host.room.state.phase === Phase.RACING, 6000);
    const sr = serverRoom(l.code);
    const track = getTrack(sr.state.settings);
    expect(track.closed).toBe(false);
    const a = sr._racer(l.host.room.sessionId)!;
    // Teleporting next to the finish line does not count.
    placeOnTrack(a.veh, track, track.finishIdx - 3, 0);
    a.veh.vx = Math.sin(a.veh.yaw) * 20; a.veh.vz = Math.cos(a.veh.yaw) * 20;
    await sleep(400);
    expect(a.state.status).toBe(RacerStatus.RACING);
    a.prog.nextCp = track.checkpoints.length - 1;
    placeOnTrack(a.veh, track, track.finishIdx - 3, 0);
    a.veh.vx = Math.sin(a.veh.yaw) * 20; a.veh.vz = Math.cos(a.veh.yaw) * 20;
    await until(() => a.state.status === RacerStatus.FINISHED, 2000);
    expect([...sr.state.finishOrder]).toEqual([l.host.room.sessionId]);
    await leaveAll();
  });

  it('a disconnecting player does not freeze the room; race completes for the rest', async () => {
    const { host, guests, sr } = await racing(3);
    sr.state.settings.laps = 1;
    await guests[1].room.leave(true);
    open.splice(open.indexOf(guests[1].room), 1);
    await until(() => sr.state.players.get(guests[1].room.sessionId)?.status === RacerStatus.LEFT);
    expect(sr.state.phase).toBe(Phase.RACING);
    // Remaining two finish.
    const track = getTrack(sr.state.settings);
    for (const id of [host.room.sessionId, guests[0].room.sessionId]) {
      const r = sr._racer(id)!;
      r.prog.nextCp = 0;
      placeOnTrack(r.veh, track, track.n - 3, id === host.room.sessionId ? -4 : 4);
      r.veh.vx = Math.sin(r.veh.yaw) * 20; r.veh.vz = Math.cos(r.veh.yaw) * 20;
    }
    await until(() => host.room.state.phase === Phase.RESULTS, 3000);
    expect(host.room.state.players.get(guests[1].room.sessionId).status).toBe(RacerStatus.LEFT);
    // Back to the lobby: left player purged, rematch requester is ready.
    host.room.send(MSG.REMATCH);
    await until(() => host.room.state.phase === Phase.LOBBY);
    expect(host.room.state.players.size).toBe(2);
    await leaveAll();
  });

  it('unexpected disconnect keeps the slot; reconnect restores identity', async () => {
    const { guests, sr, host } = await racing(2);
    const g = guests[0];
    const id = g.room.sessionId;
    const token = g.room.reconnectionToken;
    g.room.connection.close();
    open.splice(open.indexOf(g.room), 1);
    await until(() => sr.state.players.get(id)?.status === RacerStatus.DISCONNECTED);
    expect(sr.state.phase).toBe(Phase.RACING);
    const back = await new Client(url()).reconnect<any>(token);
    open.push(back);
    expect(back.sessionId).toBe(id);
    await until(() => sr.state.players.get(id)?.status === RacerStatus.RACING);
    expect(sr.state.players.size).toBe(2);
    void host;
    await leaveAll();
  });
});

describe('battleground mode', () => {
  it('runs a battle: arena spawns, pickups, kill credit and SAAVU kill events, ends at the kill target', async () => {
    const l = await lobby(2);
    l.host.room.send(MSG.SETTINGS, { mode: 'battle', killTarget: 5, timeLimit: 3 });
    await until(() => l.host.room.state.settings.mode === 'battle');
    l.guests[0].room.send(MSG.READY, { ready: true });
    await sleep(150);
    const kills: { killer: string; victim: string; weapon: string }[] = [];
    l.guests[0].room.onMessage(MSG.KILL, (list: typeof kills) => kills.push(...list));
    l.host.room.send(MSG.START);
    await until(() => l.host.room.state.phase === Phase.RACING, 6000);
    const sr = serverRoom(l.code);
    expect(sr.state.pickups.size).toBeGreaterThan(5);
    expect(sr.state.timeLeft).toBeGreaterThan(170);
    const a = sr._racer(l.host.room.sessionId)!;
    const b = sr._racer(l.guests[0].room.sessionId)!;
    // B is shot to pieces by A five times
    for (let i = 0; i < 5; i++) {
      await until(() => b.state.status === RacerStatus.RACING, 5000);
      b.state.protectT = 0;
      sr.damage(b, 100000, 'rocket', a.sessionId);
    }
    await until(() => l.host.room.state.phase === Phase.RESULTS, 3000);
    expect(a.state.kills).toBe(5);
    expect(b.state.deaths).toBe(5);
    expect([...sr.state.finishOrder][0]).toBe(a.sessionId);
    await until(() => kills.length >= 5, 2000);
    expect(kills[0]).toEqual({ killer: a.sessionId, victim: b.sessionId, weapon: 'rocket' });
    await leaveAll();
  });
});
