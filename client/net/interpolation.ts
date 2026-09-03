// Renders remote players slightly in the past (`renderTick = localEstServerTick
// - INTERP_TICKS`), smoothing over snapshot gaps and network jitter. See plan
// §3: delivery is not guaranteed in order on either transport, so `EntityBuffer
// .push` rejects any tick at or behind what it has already buffered — the same
// rule `World.applyInput` applies to input sequence numbers.

import { angleLerp, lerp } from '../../shared/math.ts';
import { EXTRAPOLATE_MAX_MS, INTERP_BUFFER_SIZE, TICK_DT } from '../../shared/constants.ts';
import { copySnapshotPlayer, createSnapshotPlayer } from '../../shared/types.ts';
import type { Snapshot, SnapshotPlayer } from '../../shared/types.ts';

/**
 * Remote entities that stop appearing in snapshots for longer than this are
 * dropped from the render set (e.g. they left the room). Not present as a
 * named constant in shared/constants.ts at the time this file was written;
 * kept local and called out in this agent's report as a gap for the
 * integrator to promote into constants.ts if a shared name is wanted.
 */
const REMOTE_STALE_MS = 3000;

interface InterpEntry {
  tick: number;
  player: SnapshotPlayer;
}

/**
 * Ring buffer of one remote player's recent snapshot states, in strictly
 * increasing tick order (push() enforces this). `sample()` interpolates
 * between the two buffered states bracketing `renderTick`, extrapolates
 * along velocity past the newest for up to EXTRAPOLATE_MAX_MS, then holds.
 */
export class EntityBuffer {
  private readonly ring: InterpEntry[];
  private head = 0;
  private count = 0;
  private newestTick = -1;

  constructor() {
    this.ring = new Array(INTERP_BUFFER_SIZE);
    for (let i = 0; i < INTERP_BUFFER_SIZE; i++) {
      this.ring[i] = { tick: -1, player: createSnapshotPlayer() };
    }
  }

  get latestTick(): number {
    return this.newestTick;
  }

  /** Copies `p` into the buffer at `tick`. No-ops (returns false) if tick <= the newest tick already buffered — a stale, reordered frame. */
  push(tick: number, p: SnapshotPlayer): boolean {
    if (tick <= this.newestTick) return false;
    const slot = this.ring[this.head]!;
    slot.tick = tick;
    copySnapshotPlayer(slot.player, p);
    this.head = (this.head + 1) % INTERP_BUFFER_SIZE;
    if (this.count < INTERP_BUFFER_SIZE) this.count++;
    this.newestTick = tick;
    return true;
  }

  /** Writes this entity's interpolated/extrapolated state at `renderTick` into `out`. Returns false (out left untouched) if nothing has been buffered yet. */
  sample(renderTick: number, out: SnapshotPlayer): boolean {
    if (this.count === 0) return false;
    const oldestIdx = (this.head - this.count + INTERP_BUFFER_SIZE) % INTERP_BUFFER_SIZE;

    // The buffer holds entries oldest-to-newest in increasing tick order
    // (guaranteed by push's rejection rule), so a single forward scan finds
    // the bracket without any wraparound-aware bisection.
    let prev: InterpEntry | null = null;
    let next: InterpEntry | null = null;
    for (let i = 0; i < this.count; i++) {
      const e = this.ring[(oldestIdx + i) % INTERP_BUFFER_SIZE]!;
      if (e.tick <= renderTick) {
        prev = e;
      } else {
        next = e;
        break;
      }
    }

    if (prev && next) {
      const span = next.tick - prev.tick;
      const t = span > 0 ? (renderTick - prev.tick) / span : 1;
      copySnapshotPlayer(out, next.player); // discrete fields (weapon, flags, ...) come from the newer state
      out.pos.x = lerp(prev.player.pos.x, next.player.pos.x, t);
      out.pos.y = lerp(prev.player.pos.y, next.player.pos.y, t);
      out.pos.z = lerp(prev.player.pos.z, next.player.pos.z, t);
      out.yaw = angleLerp(prev.player.yaw, next.player.yaw, t);
      out.pitch = lerp(prev.player.pitch, next.player.pitch, t);
      return true;
    }

    if (!prev) {
      // renderTick predates everything buffered (e.g. just joined): hold the oldest sample.
      copySnapshotPlayer(out, this.ring[oldestIdx]!.player);
      return true;
    }

    // prev && !next: renderTick is past the newest sample. Extrapolate along
    // velocity, clamped to EXTRAPOLATE_MAX_MS, then hold.
    copySnapshotPlayer(out, prev.player);
    const aheadMs = (renderTick - prev.tick) * TICK_DT * 1000;
    const dt = Math.min(Math.max(aheadMs, 0), EXTRAPOLATE_MAX_MS) / 1000;
    out.pos.x = prev.player.pos.x + prev.player.vel.x * dt;
    out.pos.y = prev.player.pos.y + prev.player.vel.y * dt;
    out.pos.z = prev.player.pos.z + prev.player.vel.z * dt;
    return true;
  }
}

/** Per-match collection of every remote player's EntityBuffer, fed by SNAPSHOTs and sampled once per render frame. */
export class RemoteEntities {
  private readonly buffers = new Map<number, EntityBuffer>();
  private readonly lastSeenMs = new Map<number, number>();
  private readonly out = new Map<number, SnapshotPlayer>();
  /** The most recently received snapshot, for HUD fields (scores, timeLeft, bomb state, events) that don't need interpolation. */
  lastSnapshot: Snapshot | null = null;

  /** Buffers every player in `snap` except `localId` (the recipient predicts their own player instead — see prediction.ts). */
  onSnapshot(snap: Snapshot, localId: number): void {
    this.lastSnapshot = snap;
    const now = nowMs();
    for (const p of snap.players) {
      if (p.id === localId) continue;
      let buf = this.buffers.get(p.id);
      if (!buf) {
        buf = new EntityBuffer();
        this.buffers.set(p.id, buf);
      }
      buf.push(snap.tick, p);
      this.lastSeenMs.set(p.id, now);
    }
  }

  /** Samples every buffered remote entity at `renderTick`, reusing the same SnapshotPlayer objects across calls (no per-frame allocation once a player has been seen once). */
  sample(renderTick: number): Map<number, SnapshotPlayer> {
    const now = nowMs();
    for (const [id, seenAt] of this.lastSeenMs) {
      if (now - seenAt > REMOTE_STALE_MS) {
        this.buffers.delete(id);
        this.lastSeenMs.delete(id);
        this.out.delete(id);
      }
    }
    for (const [id, buf] of this.buffers) {
      let entry = this.out.get(id);
      if (!entry) {
        entry = createSnapshotPlayer();
        this.out.set(id, entry);
      }
      buf.sample(renderTick, entry);
    }
    return this.out;
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
