// Ordered-checkpoint lap validation. Server is authoritative; the client only
// uses these helpers for display.

import type { Track } from './track';

export interface ProgressState {
  laps: number; // completed laps
  nextCp: number; // index into track.checkpoints that must be crossed next
  finished: boolean;
}

export type ProgressEvent = null | 'checkpoint' | 'lap' | 'finish';

export function initialProgress(): ProgressState {
  // Grid sits just after the finish line, so checkpoint 1 is the first target.
  return { laps: 0, nextCp: 1, finished: false };
}

/** Window (in samples) after a checkpoint in which it counts as crossed. */
export function checkpointWindow(track: Track) {
  return Math.floor(track.n / track.checkpoints.length / 2);
}

export function updateProgress(
  track: Track,
  p: ProgressState,
  f: number,
  lateral: number,
  totalLaps: number,
): ProgressEvent {
  if (p.finished) return null;
  if (Math.abs(lateral) > track.halfWidth + 6) return null;
  const cp = track.checkpoints[p.nextCp];
  const d = (((f - cp) % track.n) + track.n) % track.n;
  if (d >= checkpointWindow(track)) return null;
  const wasFinishLine = p.nextCp === 0;
  p.nextCp = (p.nextCp + 1) % track.checkpoints.length;
  if (!wasFinishLine) return 'checkpoint';
  p.laps += 1;
  if (p.laps >= totalLaps) {
    p.finished = true;
    return 'finish';
  }
  return 'lap';
}

/** Continuous progress measure in samples, used to rank racers. */
export function progressScore(track: Track, p: ProgressState, f: number): number {
  const K = track.checkpoints.length;
  const lastCp = (p.nextCp - 1 + K) % K;
  const base = lastCp === 0 ? 0 : track.checkpoints[lastCp];
  let rel = (((f - base) % track.n) + track.n) % track.n;
  if (rel > track.n * 0.6) rel -= track.n;
  return p.laps * track.n + base + rel;
}
