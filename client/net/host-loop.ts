// Drives a Room's fixed-tick simulation on a wall-clock interval, for the two
// browser-hosted paths (PeerJS host, local practice). Room.update(nowMs) owns
// its own accumulator and pacing (running at most 4 due ticks per call per
// its contract), so this class only has to call it often enough that the
// accumulator never falls meaningfully behind the 60 Hz (≈16.667 ms) tick
// rate — an 8 ms interval comfortably beats that with margin for jitter in
// the browser's timer scheduling.

import type { Room } from '../../shared/net/room.ts';

const HOST_LOOP_INTERVAL_MS = 8;

export class HostLoop {
  private readonly room: Room;
  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(room: Room) {
    this.room = room;
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = setInterval(() => {
      this.room.update(performance.now());
    }, HOST_LOOP_INTERVAL_MS);
  }

  stop(): void {
    if (this.handle === null) return;
    clearInterval(this.handle);
    this.handle = null;
  }
}
