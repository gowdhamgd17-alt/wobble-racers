# WOBBLE RACERS

Chaotic 3D multiplayer party racing in the browser. 2 to 15 players race, drift, boost, ram each other into the air, shoot blasters, explode, respawn on the spot and keep their lap progress.

- **Client:** React 18 + TypeScript + Vite + Three.js (`client/`)
- **Server:** Node.js + TypeScript + Colyseus 0.15 over WebSockets (`server/`)
- **Shared rules:** track, vehicle configs, arcade physics, lap validation, input protocol (`shared/`)

---

## Quick start (local development)

Requires Node.js 20+ (tested on Node 22).

```bash
npm install          # installs all three workspaces
npm run dev          # server on :2567 and client on :5173 (with hot reload)
```

Open http://localhost:5173. On another device on the same network, open `http://<your-computer-ip>:5173`; the client connects to port 2567 on the same host automatically.

### Testing the 2-player minimum locally

1. Open http://localhost:5173 in a normal window. Choose **Create Room**, enter a name, create the room. Note the 5-letter code at the top of the lobby.
2. Open a **private/incognito window** (or another browser) at the same URL. Choose **Join Room**, enter a different name, type the code, Join.
3. In the second window press **Ready**. In the first window (the host) press **Start race**.

Both windows are now in the same server-authoritative race. You can also start with any number from 2 to 15.

No second person handy? Fill a room with real networked bot clients (they connect through WebSockets exactly like a browser and drive with an autopilot):

```bash
npm run bots -w server -- ABCDE 3      # 3 bots join room ABCDE and ready up
```

---

## What's in the game

- **Two game modes**
  - *Race*: loop circuits or straight sprints, with guns, crates and repair kits on the road.
  - *Battleground*: everyone spawns in Battle Town, a walled grid of streets with houses, big buildings, parks, trees, rocks and giant boulders, and fights it out. Most kills wins; pick a kill target (5 to 30) and an optional time limit (3, 5 or 10 minutes). Destroyed cars come back as a fresh car at a quiet spawn point.
- **10 vehicle classes**, each with its own handling, armour and health pool (280 to 650 HP) and a matching collision footprint: Speedster, Bruiser, Drifter, Muscle, Buggy, Formula, Monster, Jeep, Pickup and a six-wheel Armored Truck.
- **10 weapons on every vehicle**: switch guns any time during play (each gun keeps its own magazine; switching takes 0.4 s). The Garage sets the gun you start with. The guns: Pistol, SMG, M4 Rifle, Shotgun, Minigun, Sniper, Rocket Launcher, Grenade Launcher, Flamethrower and Homing Missiles. Each has its own damage, fire rate, magazine and reload; bullets are instant with tracers, rockets/grenades/missiles fly and explode with splash damage.
- **Pickups**: green repair kits restore half your health; wooden power crates reload every gun instantly and give ×1.5 damage for 12 s. Both come back a few seconds after they're taken.
- **"SAAVU!"**: destroy a car and a big SAAVU! card pops up with a loud, clear, deep male voice shouting "Saavu!" (an embedded 12 KB clip; the rest of the game sound ducks under it); everyone sees it in the kill feed, and the victim sees who got them.
- **8 drivers**: Professor Bonk, Moolissa, Zip-9, Pepper Pomodoro, Rexford, Luna Vega, Grandpa Gus and Pip, each with their own gag animation.
- **Detailed procedural models**: smooth extruded bodies with real wheel arches, lathed tyres with sidewalls, tinted glass, chrome, clear-coat paint and studio reflections. Graphics quality Low/Medium lowers the polygon count for phones.
- **Two course types, any distance**
  - *Loop circuit*: Wobble Valley, Valley Reverse or Lagoon Ring. Pick the lap length (1, 1.5, 2, 3, 5 or 10 km) and 1 to 10 laps.
  - *Straight sprint*: Canyon Run or Coast Road from a START gate to a FINISH gate, 1 to 10 km, with kilometre boards along the way.
  - Ramps and boost pads are placed automatically on the straightest stretches, so every length gets jumps.
- **Real-size collisions**: cars collide as oriented boxes that match each body, so noses and tails can no longer slide into each other. Every corner of the car stays inside the barriers, sprints have end walls, blaster hits use the real body shape, and respawns keep a full car length clear. Spawn-protected cars are still solid; they just can't be damaged.
- **Voice chat** in online rooms: tap *Join voice* in the lobby (or 🎤 during a race). Push-to-talk (hold **V** or the mic button) or open mic, a voice volume slider, tap a player's speaker icon to mute them, and live "who's talking" indicators. In the Battleground it's proximity voice: nearby drivers are loud, far ones quiet. Audio goes directly between browsers (WebRTC, Opus capped at 24 kbps with silence suppression); the game server only relays the connection set-up. Players on very strict networks may need a TURN relay: set `VITE_TURN_URL`, `VITE_TURN_USER`, `VITE_TURN_PASS` at build time.
- **Play vs bots offline**: race or Battleground with no server, 1 to 14 bots. Battle bots hunt the nearest enemy, steer around buildings and go for repair kits when hurt.

## Controls

On phones the game runs full screen (it switches on your first tap; on iPhone use Share → Add to Home Screen) and can be installed as an app from the home screen's *Install as app* button. On-screen controls are ◀ ▶ steer, ▲ forward, ▼ brake / reverse, FIRE and NITRO, plus smaller DRIFT, GUN and RELOAD buttons. **Pause → Customize on-screen controls** lets you drag every button anywhere and resize it; the layout is saved on the phone. Voice chat on phones is tap to talk (tap the mic again to stop).

| Action | Keyboard (rebindable in Settings) | Touch |
|---|---|---|
| Accelerate | W / ↑ | ▲ |
| Brake / reverse | S / ↓ | ▼ |
| Steer | A D / ← → | ◀ ▶ (slide your thumb between them) |
| Handbrake / drift | Space | DRIFT |
| Nitro | Shift | NITRO |
| Fire weapon | F (or J) | FIRE |
| Reload | R | RELOAD |
| Switch gun | 1–9, 0 pick a gun · Q / E previous / next · or click the gun bar | GUN ▸ (or tap the gun bar) |
| Recover stuck car | R (only acts when stuck or flipped) | ⟲ |
| Push to talk (voice chat) | V | 🎤 (tap to talk, tap again to stop) |
| Pause | Esc / P | ❚❚ |

The control scheme is chosen automatically from the input you used last, so touch laptops can switch between keyboard and touch without a reload. Settings lets you force a mode, resize touch buttons, turn on auto-gas, adjust camera follow speed, graphics quality and separate SFX / music volumes. Phones play in landscape; in portrait a rotate prompt appears and your car coasts.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server (tsx watch) + client (Vite) |
| `npm run build` | Bundles the server to `server/dist/index.js` and the client to `client/dist/` |
| `npm start` | Runs the built server |
| `npm test` | Shared rules, client input and server integration tests |
| `npm run typecheck` | `tsc --noEmit` across all workspaces |
| `npm run loadtest -w server -- ws://host:2567 15 1` | 15 real WebSocket clients race a full race |
| `npm run bots -w server -- CODE 3` | Add autopilot bots to an existing room |

---

## Configuration

**Server** (`server/.env`, see `server/.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `2567` | HTTP + WebSocket port |
| `CORS_ORIGINS` | *(any)* | Comma-separated allowed origins for the REST endpoints, e.g. `https://wobble.example.com` |
| `STATIC_DIR` | *(unset)* | If set (e.g. `../client/dist`), the server also serves the built client |

**Client** (`client/.env`, see `client/.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `VITE_SERVER_URL` | dev: `ws(s)://<page host>:2567`; prod: same origin | WebSocket URL of the game server, e.g. `wss://wobble-server.example.com` |

No secrets are needed or stored in the client.

---

## Deployment

The client is a static site; the server is a long-running Node process that needs WebSocket support.

> **Important:** WOBBLE RACERS is not a static website. Uploading only `client/dist` to Netlify, Vercel, GitHub Pages, Hostinger etc. gives you the menus but every multiplayer button fails, because there's no game server behind it. The home screen now shows a **"Game server offline"** banner in that case. Use Option A, or Option B with a separately hosted server.

### Option A: one service (simplest)

**Render (free tier, easiest):** push this folder to GitHub, then in Render choose *New → Blueprint* and pick the repo. `render.yaml` builds everything and starts the server, which also serves the website. Your game URL is the Render URL. (Free instances sleep when idle; the first visit takes ~30-60 s to wake.)

**Any Node host / VPS:**

```bash
npm ci && npm run build
cd server && PORT=8080 STATIC_DIR=../client/dist node dist/index.js
```

or with Docker:

```bash
docker build -t wobble-racers .
docker run -p 8080:8080 wobble-racers
```

Put it behind any HTTPS proxy that forwards WebSocket upgrades (Render, Fly.io, Railway, a VM with Caddy/nginx…). The client talks to the same origin, so no extra configuration is required.

### Option B: static client + separate server

1. Deploy the server (Docker image above, or `npm run build -w server && npm start`) to a host with WebSockets, e.g. `wss://wobble-server.example.com`. Set `CORS_ORIGINS` to your client's origin.
2. Build the client with the server URL baked in and upload `client/dist/` to any static host (Netlify, Vercel, S3/CloudFront, GitHub Pages):

```bash
VITE_SERVER_URL=wss://wobble-server.example.com npm run build -w client
```

Rooms live in server memory. A single Node process handles many rooms; for multiple processes, Colyseus supports a Redis presence/driver (not configured here). If the server restarts, players see "Connection lost" and return to the menu.

---

## How it works

### Architecture

```
shared/src
  constants.ts   phases, statuses, balance numbers (nitro, weapon, respawn, physics)
  vehicles.ts    one config table for Speedster / Bruiser / Drifter
  track.ts       Catmull-Rom circuit, uniform resampling, nearest-point queries, ramps, pads, 15-slot grid
  physics.ts     deterministic arcade controller, car-car collision response, safe-spot search
  progress.ts    ordered checkpoints, laps, finish, ranking score
  validation.ts  display names, settings, appearance sanitising
  protocol.ts    message names, compact input encoding/decoding
server/src
  RaceRoom.ts    room lifecycle, host/ready/start rules, 30 Hz authoritative simulation, combat, respawn, results, reconnection
  schema.ts      Colyseus state schema
  app.ts         express + Colyseus, /health and /api/rooms
client/src
  net/Net.ts     Colyseus client: quick play, create, join by code, room list, auto-reconnect
  game/Game.ts   Three.js scene, prediction + reconciliation, interpolation, camera, effects, HUD data
  game/models.ts procedural cars + characters + procedural animation
  game/trackMesh.ts, effects.ts, Preview.ts
  input/Input.ts keyboard + multi-touch merged into one InputState
  audio/Audio.ts Web Audio synthesised SFX and music
  ui/            screens (home, name, browser, create, lobby, garage, race, results, settings)
```

### Networking model

- The server runs the race at a fixed 30 Hz and patches state to clients at 20 Hz.
- Clients send only compact inputs (`[seq, steer, throttle, brake, flags]`), at most 45/s (token bucket); malformed or excessive messages are dropped.
- The server is the sole authority for positions, collisions, damage, health, destruction, respawn, projectiles and hits, checkpoints, laps, finish order, player count, host permissions and start conditions. There is no client message that can set health, laps or position.
- The local car is predicted with the same shared physics code; on each patch the client rewinds to the server state, replays unacknowledged inputs and smooths any correction. Remote cars are interpolated ~110 ms in the past.

### Physics decision (documented deviation)

The brief suggests Rapier "where appropriate". We use a purpose-built deterministic 2.5D arcade controller in `shared/physics.ts` instead: ground-height field, separate forward/lateral velocity for drifting, ballistic airborne phase with bounded spin, and mass-weighted impulse collisions between simple circle colliders. The same code runs on the server (authority) and client (prediction/replay), which a WASM rigid-body world would make heavier and less deterministic, and it gives exact control over grip, launches and recovery so crashes stay fun and bounded.

### Rules worth knowing

- Rooms hold up to 15 players; races start with 2+. The host can start when every other connected player is Ready. The server re-validates every start request.
- If the host leaves, the earliest-joined connected player becomes host.
- Disconnected players keep their slot for 20 s (their car stops and becomes a non-colliding ghost). After that they are listed as "Left the race".
- Races have no time limit: a race ends when every remaining player has finished or left. Battles end at the kill target, when the time limit runs out, or when everyone has left; ties go to fewer deaths.
- Hits use lag compensation: you see other cars slightly in the past, so the server tests your bullets, flames and rockets against where the target was on your screen (about 0.16 s online). Rockets are swept against each car's own motion so fast cars can't slip between two frames.
- Kills are credited to whoever last damaged the victim within 8 s (shots, blasts or rams). Nobody takes damage from their own explosions, but they still get shoved.
- In races, guns stay cold for the first 5 s after the green light.
- All game rules live in one shared simulation (`shared/src/sim.ts`) used by both the server room and the offline bot mode, so they can never drift apart. Finished players become ghosts and can spectate others.
- In races, destroyed cars respawn after 1.6 s at the destruction spot (or the nearest clear, on-road, non-ramp spot), with full health, 2 s of shield protection and the same lap progress.
- Changing room settings un-readies guests so nobody is surprised by new rules.
- "Friendly fire" is not exposed as a setting because there are no teams yet; all weapons hit all opponents when weapons are on.

### Audio

All sounds and music are synthesised at runtime with the Web Audio API, so there are no third-party assets to license. The engine models each vehicle's cylinder count and rev range with a gearbox that shifts up as you accelerate; every gun has its own layered shot (supersonic crack, muzzle boom, low thump, reverb) plus magazine-out / magazine-in / charging-handle reload clicks; impacts include bullet pings, ricochets, metal crunches and explosions whose rumble arrives later the further away they are. Audio starts after the first tap/keypress (browser autoplay rules). To use recorded samples, replace the bodies of the `play`-style methods in `client/src/audio/Audio.ts` with `AudioBufferSourceNode` playback.

---

## Testing status

Automated (all passing):

- **shared** (94): every car class finishing every track with the autopilot, track length/grid checks for all 30 track and distance combinations, oriented-box collision and wall tests, sprint checkpoint validation, plus name validation, settings/appearance sanitising, input wire format, track geometry (15 grid slots on the road), every car class completing 2 laps on both tracks with the autopilot including ramp air time, drift grip/nitro gain, auto-righting, checkpoint skipping/finish farming prevention, finish-once, collision launch/damage scaling, safe respawn spots.
- **client** (11, jsdom): simultaneous multi-touch, finger sliding, keyboard independence and merging, key remapping, resets on blur / orientation change / page hide / pause / pointer cancel, no driving while typing.
- **server** (18, real Colyseus server + real colyseus.js WebSocket clients): empty name rejected, 2 players accepted, 15 accepted and the 16th rejected, solo start rejected, start with exactly 2, start with 15, non-host start rejected, unready guests block start, host lap settings, host migration, health/lap/appearance tampering ignored, input flood rate-limited, destroy → respawn keeps laps + spawn protection blocks re-destruction, respawn avoids other cars, projectile hits only by physical contact, checkpoint-validated single finish with race continuing, disconnect doesn't freeze the room and results/rematch work, unexpected disconnect + reconnect restores identity.

Load test: `npm run loadtest` with **15 real WebSocket clients** completed a full race (all 15 finished, results reached) with p50/p95/p99 patch intervals of ~50/53/57 ms on a single process.

Browser tests (headless Chromium with software WebGL, run during development):

- Desktop (keyboard) + emulated phone (touch, landscape) both completed: name validation, create room, join, ready, host lap change, start, countdown, racing, multi-touch GAS + NITRO held together, blur releasing keys, pause menu, portrait rotate overlay, canvas resizing on rotation, one player leaving mid-race while the other continued.
- Quick Play put two browsers into the same room.
- A browser player plus 2 bots completed a full private 1-lap race, saw the results screen and returned to the lobby via Rematch.

Not verified here (no physical devices in the build environment): real iPhone/iPad/Android hardware, actual frame rates on real GPUs (headless software rendering ran at 4–6 fps, which says nothing about real devices), haptics, fullscreen/orientation-lock behaviour on specific browsers, building the Docker image (no Docker daemon was available; the equivalent `npm run build` + `STATIC_DIR` single-service run was tested), and deployment to a public host. Please try those on your devices; the graphics quality setting (Auto lowers resolution, shadows and particles when FPS drops) is there for weaker phones.
