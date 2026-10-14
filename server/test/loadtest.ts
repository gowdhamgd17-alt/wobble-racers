// Load test: N real colyseus.js clients join one room, ready up, race a full
// race with an autopilot driving each car from authoritative server state,
// fire and boost occasionally, and report what happened.
//
// Usage: npm run loadtest -w server -- [ws://host:port] [clients=15] [laps=1]

import { Client, Room } from 'colyseus.js';
import { MSG, Phase, autopilot, createVehicleState, encodeInput, getTrack, type VehicleState } from '@wobble/shared';

const url = process.argv[2] ?? 'ws://127.0.0.1:2567';
const N = Number(process.argv[3] ?? 15);
const LAPS = Number(process.argv[4] ?? 1);
const TIMEOUT_S = 60 + LAPS * 90;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const t0 = Date.now();
  const rooms: Room<any>[] = [];
  const classes = ['speedster', 'bruiser', 'drifter', 'muscle', 'buggy', 'formula', 'monster'];
  const host = await new Client(url).create<any>('race', {
    name: 'Bot 1', private: true, maxPlayers: 15, settings: { laps: LAPS, layout: process.env.LAYOUT ?? 'loop', distanceKm: Number(process.env.KM ?? 1.5) },
    appearance: { carClass: classes[0] },
  });
  rooms.push(host);
  for (let i = 1; i < N; i++) {
    rooms.push(await new Client(url).joinById<any>(host.roomId, { name: `Bot ${i + 1}`, appearance: { carClass: classes[i % classes.length], colorMain: ['red', 'blue', 'green', 'pink', 'cyan'][i % 5] } }));
  }
  console.log(`[load] ${rooms.length} clients joined room ${host.roomId} in ${Date.now() - t0}ms`);

  const patchGaps: number[] = [];
  const lastPatch = new Map<Room<any>, number>();
  let fxCount = 0;
  for (const r of rooms) {
    r.onStateChange(() => {
      const now = performance.now();
      const prev = lastPatch.get(r);
      if (prev && r.state.phase === Phase.RACING) patchGaps.push(now - prev);
      lastPatch.set(r, now);
    });
    r.onMessage(MSG.FX, (list: unknown[]) => { fxCount += list.length; });
    r.onMessage(MSG.ERROR, (e: { message: string }) => console.log('[load] server error:', e.message));
    r.onMessage(MSG.WELCOME, () => {});
  }
  for (const r of rooms.slice(1)) r.send(MSG.READY, { ready: true });
  await sleep(500);
  host.send(MSG.START);
  while (host.state.phase !== Phase.RACING) await sleep(50);
  console.log(`[load] race started with ${host.state.players.size} players`);

  const track = getTrack(host.state.settings);
  const seq = new Map<Room<any>, number>();
  const veh: VehicleState = createVehicleState(0, 0, 0);
  const lanes = rooms.map((_, i) => ((i % 5) - 2) * 2.5);
  const loop = setInterval(() => {
    rooms.forEach((r, i) => {
      const p = r.state.players.get(r.sessionId);
      if (!p) return;
      Object.assign(veh, { x: p.x, z: p.z, yaw: p.yaw, vx: p.vx, vz: p.vz, trackIdx: -1 });
      const input = autopilot(veh, track, 9, lanes[i]);
      input.fire = Math.random() < 0.05;
      input.nitro = Math.random() < 0.15;
      input.recover = Math.hypot(p.vx, p.vz) < 1;
      const s = (seq.get(r) ?? 0) + 1;
      seq.set(r, s);
      r.send(MSG.INPUT, encodeInput(s, input));
    });
  }, 1000 / 30);

  const raceStart = Date.now();
  let lastLog = 0;
  while (host.state.phase === Phase.RACING && Date.now() - raceStart < TIMEOUT_S * 1000) {
    await sleep(250);
    if (Date.now() - lastLog > 10000) {
      lastLog = Date.now();
      const ps = [...host.state.players.values()] as any[];
      const fin = ps.filter((p) => p.status === 'finished').length;
      const destroyed = ps.filter((p) => p.status === 'destroyed').length;
      console.log(`[load] t=${((Date.now() - raceStart) / 1000).toFixed(0)}s finished=${fin}/${ps.length} destroyedNow=${destroyed} leaderLaps=${Math.max(...ps.map((p) => p.laps))}`);
    }
  }
  clearInterval(loop);
  const ps = [...host.state.players.values()] as any[];
  const sorted = [...patchGaps].sort((a, b) => a - b);
  const pct = (q: number) => sorted[Math.floor(sorted.length * q)]?.toFixed(1);
  const summary = {
    clients: rooms.length,
    phase: host.state.phase,
    raceSeconds: ((Date.now() - raceStart) / 1000).toFixed(1),
    finished: ps.filter((p) => p.status === 'finished').length,
    finishOrder: [...host.state.finishOrder].map((id) => host.state.players.get(id)?.name),
    patchIntervalMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) },
    fxEventsReceivedTotal: fxCount,
  };
  console.log('[load] summary', JSON.stringify(summary, null, 2));
  await Promise.all(rooms.map((r) => r.leave(true).catch(() => {})));
  const ok = summary.phase === Phase.RESULTS && summary.finished === N;
  console.log(ok ? '[load] PASS' : '[load] FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('[load] error', e);
  process.exit(1);
});
