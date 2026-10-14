// Simple line-following driver. Used by automated tests and the load-test
// client to drive real networked cars. Not used for fake players in rooms.

import type { InputState, VehicleState } from './physics';
import type { Track } from './track';
import { pointAt, queryTrack } from './track';

export function autopilot(s: VehicleState, track: Track, lookahead = 9, lane = 0): InputState {
  const q = queryTrack(track, s.x, s.z, s.trackIdx);
  const target = pointAt(track, q.f + lookahead, lane);
  const dx = target.x - s.x, dz = target.z - s.z;
  const desired = Math.atan2(dx, dz);
  let diff = desired - s.yaw;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  // yaw increases to the left, steer +1 = right
  const steer = Math.max(-1, Math.min(1, -diff * 2.2));
  const speed = Math.hypot(s.vx, s.vz);
  // Look further ahead for corners and slow down for them
  const far = pointAt(track, q.f + lookahead * 3, 0);
  let bend = Math.atan2(far.x - s.x, far.z - s.z) - s.yaw;
  while (bend > Math.PI) bend -= Math.PI * 2;
  while (bend < -Math.PI) bend += Math.PI * 2;
  const wantSpeed = Math.abs(bend) > 0.6 ? 18 : Math.abs(bend) > 0.35 ? 26 : 50;
  return {
    steer,
    throttle: speed < wantSpeed ? 1 : 0,
    brake: speed > wantSpeed + 6 ? 1 : 0,
    handbrake: false,
    nitro: false,
    fire: false,
    recover: false,
  };
}
