// Ordered-checkpoint validation for both layouts. Server is authoritative;
// the client only uses these helpers for display.
//
// loop:     checkpoints[0] is the start/finish line; a lap counts when it is
//           crossed after every other checkpoint in order.
// straight: checkpoints run from just after the start to the finish line
//           (the last one); crossing them all in order finishes the race.

import type { Track } from './track';

export interface ProgressState {
  laps: number;
  nextCp: number;
  finished: boolean;
}

export type ProgressEvent = null | 'checkpoint' | 'lap' | 'finish';

export function initialProgress(track?: Track): ProgressState {
  // Loop grids sit just after the line, so checkpoint 1 is the first target.
  return { laps: 0, nextCp: track && !track.closed ? 0 : 1, finished: false };
}

/** Laps that make up a race on this track. Sprints are always one "lap". */
export function totalLapsFor(track: Track, laps: number) {
  return track.closed ? laps : 1;
}

export function checkpointWindow(track: Track) {
  const spacing = track.closed ? track.n / track.checkpoints.length : (track.finishIdx - track.startIdx) / track.checkpoints.length;
  return Math.max(4, Math.floor(spacing / 2));
}

export function updateProgress(track: Track, p: ProgressState, f: number, lateral: number, totalLaps: number): ProgressEvent {
  if (p.finished) return null;
  if (Math.abs(lateral) > track.halfWidth + 6) return null;
  const cp = track.checkpoints[p.nextCp];
  const d = track.closed ? (((f - cp) % track.n) + track.n) % track.n : f - cp;
  if (d < 0 || d >= checkpointWindow(track)) return null;

  if (!track.closed) {
    p.nextCp += 1;
    if (p.nextCp >= track.checkpoints.length) {
      p.laps = 1;
      p.finished = true;
      return 'finish';
    }
    return 'checkpoint';
  }

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
  if (!track.closed) {
    if (p.finished) return track.n * 2;
    // Never count further than one checkpoint window past the next checkpoint still owed.
    return Math.min(f, track.checkpoints[p.nextCp] + checkpointWindow(track)) - track.startIdx;
  }
  const K = track.checkpoints.length;
  const lastCp = (p.nextCp - 1 + K) % K;
  const base = lastCp === 0 ? 0 : track.checkpoints[lastCp];
  let rel = (((f - base) % track.n) + track.n) % track.n;
  if (rel > track.n * 0.6) rel -= track.n;
  return p.laps * track.n + base + rel;
}

/** Metres covered in the race so far (for the HUD). */
export function distanceCovered(track: Track, laps: number, score: number) {
  if (!track.closed) return Math.max(0, Math.min(track.raceLength, score * track.ds));
  void laps;
  return Math.max(0, score * track.ds);
}
