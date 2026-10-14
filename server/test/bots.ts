// Join an existing room with N autopilot bots (real WebSocket clients) to
// test a browser session against other players.
// Usage: npm run bots -w server -- <ROOMCODE> [count=1] [ws://host:port]

import { Client, Room } from 'colyseus.js';
import { MSG, Phase, autopilot, createVehicleState, encodeInput, getTrack } from '@wobble/shared';

const code = process.argv[2];
const count = Number(process.argv[3] ?? 1);
const url = process.argv[4] ?? 'ws://127.0.0.1:2567';
if (!code) { console.error('usage: bots <ROOMCODE> [count] [url]'); process.exit(1); }

const rooms: Room<any>[] = [];
for (let i = 0; i < count; i++) {
  const r = await new Client(url).joinById<any>(code, { name: `Bot ${i + 1}`, appearance: { carClass: ['bruiser', 'speedster', 'drifter'][i % 3], colorMain: ['green', 'blue', 'pink'][i % 3], character: ['moo', 'zip', 'pepper'][i % 3] } });
  r.onMessage('*', () => {});
  rooms.push(r);
  r.send(MSG.READY, { ready: true });
}
console.log(`${count} bot(s) joined ${code}`);
const veh = createVehicleState(0, 0, 0);
let seq = 0;
setInterval(() => {
  for (const [i, r] of rooms.entries()) {
    const st = r.state;
    if (st.phase === Phase.RESULTS) r.send(MSG.REMATCH);
    if (st.phase !== Phase.RACING && st.phase !== Phase.COUNTDOWN) continue;
    const p = st.players.get(r.sessionId);
    if (!p) continue;
    Object.assign(veh, { x: p.x, z: p.z, yaw: p.yaw, vx: p.vx, vz: p.vz, trackIdx: -1 });
    const inp = autopilot(veh, getTrack(st.settings.trackId), 9, (i - 1) * 3);
    inp.recover = Math.hypot(p.vx, p.vz) < 1;
    r.send(MSG.INPUT, encodeInput(++seq, inp));
  }
}, 1000 / 30);
