// Server-side lag compensation: a ring buffer of per-player hit volumes for the
// last LAGCOMP_HISTORY_TICKS ticks, so a shot fired "now" can be resolved
// against where an enemy actually was at the shooter's rewound view of the
// world. Pure TypeScript, allocation-free per raycast (all scratch state is
// preallocated in the constructor and reused).
//
// Design note on `filter: (p: PlayerState) => boolean`: eligibility (team,
// alive-at-that-instant) must be evaluated exactly as it stood at the
// *historical* tick being queried, not the player's live state right now,
// since a player can die and respawn between the rewind tick and the
// present. Each history slot therefore keeps a small reusable PlayerState
// "proxy" object (a full, valid PlayerState so it type-checks) whose id/
// team/alive/pos/yaw/height/stance fields are overwritten from the recorded
// snapshot on every `record()` call. `raycast()` passes that proxy to
// `filter`. `raycastNow()` has no such problem — it is handed live
// PlayerState objects directly, so `filter` runs against them as-is.

import { createPlayerState } from '../types.ts';
import type { PlayerState, Vec3 } from '../types.ts';
import {
  EYE_CROUCH,
  EYE_STAND,
  HEAD_RADIUS,
  HEIGHT_STAND,
  STANCE_CROUCH,
  STANCE_PRONE,
  STANCE_STAND,
  ZONE_CHEST,
  ZONE_HEAD,
  ZONE_LIMB,
  LAGCOMP_HISTORY_TICKS,
  MAX_PLAYERS,
} from '../constants.ts';
import { raySphere, rayCapsule, yawPitchToDir } from '../math.ts';

export interface PlayerHit {
  id: number;
  zone: number;
  dist: number;
  point: Vec3;
}

// ---------------------------------------------------------------------------
// Hit-volume dimensions from plan §3. These are geometry constants specific
// to lag-comp's simplified capsule/sphere model, not general gameplay
// tunables, so they live here rather than shared/constants.ts (which does not
// define them) — flagged in the assignment report as a small local-constant gap.
// ---------------------------------------------------------------------------
const CHEST_RADIUS = 0.22;
const LEG_RADIUS = 0.2;
const CHEST_LO_FRAC = 0.45;
const CHEST_HI_FRAC = 0.85;
const LEG_HI_FRAC = 0.45;
const HEAD_STAND_OFFSET = 0.05;
const PRONE_HEAD_FORWARD = 0.35;
const PRONE_HEAD_HEIGHT = 0.35;
const PRONE_BODY_RADIUS = 0.3;
/** Approximate lying-down body length; no dedicated constant exists, so a standing height is used as the capsule span. */
const PRONE_BODY_LENGTH = HEIGHT_STAND;
const PRONE_BODY_HEIGHT = PRONE_BODY_RADIUS; // capsule centreline sits one radius above the ground

interface HistoryEntry {
  id: number;
  team: number;
  alive: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  height: number;
  /** STANCE_* */
  stance: number;
  /** Kept in sync with the fields above; passed to `filter` by raycast(). */
  proxy: PlayerState;
}

function createEntry(): HistoryEntry {
  return {
    id: 0,
    team: 0,
    alive: false,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    height: HEIGHT_STAND,
    stance: STANCE_STAND,
    proxy: createPlayerState(0, '', 0, false),
  };
}

function syncProxy(e: HistoryEntry): void {
  e.proxy.id = e.id;
  e.proxy.team = e.team;
  e.proxy.alive = e.alive;
  e.proxy.pos.x = e.x;
  e.proxy.pos.y = e.y;
  e.proxy.pos.z = e.z;
  e.proxy.yaw = e.yaw;
  e.proxy.height = e.height;
  e.proxy.stance = e.stance;
}

interface Frame {
  /** World tick this frame holds, or -1 if this ring slot has never been written. */
  tick: number;
  count: number;
  entries: HistoryEntry[];
}

function createFrame(): Frame {
  const entries: HistoryEntry[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) entries.push(createEntry());
  return { tick: -1, count: 0, entries };
}

// Module-scope scratch reused by every geometry test (single-threaded, never re-entrant).
const _fwd: Vec3 = { x: 0, y: 0, z: 1 };
const _volHit: PlayerHit = { id: 0, zone: -1, dist: 0, point: { x: 0, y: 0, z: 0 } };

/**
 * Tests one entry's hit volumes against the ray; writes the nearest hit (if
 * any, and if closer than `maxDist`) into `_volHit`. Returns true on hit.
 */
function testVolumes(
  e: HistoryEntry,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
): boolean {
  let bestDist = maxDist;
  let bestZone = -1;

  yawPitchToDir(e.yaw, 0, _fwd);

  if (e.stance === STANCE_PRONE) {
    // Head: a small sphere out in front of the prone body.
    const hx = e.x + _fwd.x * PRONE_HEAD_FORWARD;
    const hy = e.y + PRONE_HEAD_HEIGHT;
    const hz = e.z + _fwd.z * PRONE_HEAD_FORWARD;
    const t = raySphere(ox, oy, oz, dx, dy, dz, hx, hy, hz, HEAD_RADIUS, bestDist);
    if (t >= 0 && t < bestDist) {
      bestDist = t;
      bestZone = ZONE_HEAD;
    }
    // Body: one horizontal capsule along the facing direction.
    const half = PRONE_BODY_LENGTH / 2;
    const ax = e.x - _fwd.x * half, ay = e.y + PRONE_BODY_HEIGHT, az = e.z - _fwd.z * half;
    const bx = e.x + _fwd.x * half, by = e.y + PRONE_BODY_HEIGHT, bz = e.z + _fwd.z * half;
    const t2 = rayCapsule(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, PRONE_BODY_RADIUS, bestDist);
    if (t2 >= 0 && t2 < bestDist) {
      bestDist = t2;
      bestZone = ZONE_CHEST;
    }
  } else {
    const eyeH = e.stance === STANCE_CROUCH ? EYE_CROUCH : EYE_STAND;
    const hx = e.x, hy = e.y + eyeH + HEAD_STAND_OFFSET, hz = e.z;
    const t = raySphere(ox, oy, oz, dx, dy, dz, hx, hy, hz, HEAD_RADIUS, bestDist);
    if (t >= 0 && t < bestDist) {
      bestDist = t;
      bestZone = ZONE_HEAD;
    }

    const chestLo = e.y + CHEST_LO_FRAC * e.height;
    const chestHi = e.y + CHEST_HI_FRAC * e.height;
    const t2 = rayCapsule(ox, oy, oz, dx, dy, dz, e.x, chestLo, e.z, e.x, chestHi, e.z, CHEST_RADIUS, bestDist);
    if (t2 >= 0 && t2 < bestDist) {
      bestDist = t2;
      bestZone = ZONE_CHEST;
    }

    const legLo = e.y;
    const legHi = e.y + LEG_HI_FRAC * e.height;
    const t3 = rayCapsule(ox, oy, oz, dx, dy, dz, e.x, legLo, e.z, e.x, legHi, e.z, LEG_RADIUS, bestDist);
    if (t3 >= 0 && t3 < bestDist) {
      bestDist = t3;
      bestZone = ZONE_LIMB;
    }
  }

  if (bestZone < 0) return false;
  _volHit.dist = bestDist;
  _volHit.zone = bestZone;
  _volHit.point.x = ox + dx * bestDist;
  _volHit.point.y = oy + dy * bestDist;
  _volHit.point.z = oz + dz * bestDist;
  return true;
}

export class HitHistory {
  private readonly frames: Frame[];
  /** Scratch entries reused by raycastNow so it never allocates per call. */
  private readonly nowScratch: HistoryEntry[];

  constructor() {
    this.frames = [];
    for (let i = 0; i < LAGCOMP_HISTORY_TICKS; i++) this.frames.push(createFrame());
    this.nowScratch = [];
    for (let i = 0; i < MAX_PLAYERS; i++) this.nowScratch.push(createEntry());
  }

  /** Snapshot every player's hit-relevant state for `tick` into the ring buffer. */
  record(tick: number, players: Iterable<PlayerState>): void {
    const frame = this.frames[((tick % LAGCOMP_HISTORY_TICKS) + LAGCOMP_HISTORY_TICKS) % LAGCOMP_HISTORY_TICKS]!;
    frame.tick = tick;
    let i = 0;
    for (const p of players) {
      if (i >= MAX_PLAYERS) break;
      const e = frame.entries[i]!;
      e.id = p.id;
      e.team = p.team;
      e.alive = p.alive;
      e.x = p.pos.x;
      e.y = p.pos.y;
      e.z = p.pos.z;
      e.yaw = p.yaw;
      e.height = p.height;
      e.stance = p.stance;
      syncProxy(e);
      i++;
    }
    frame.count = i;
  }

  private findFrame(tick: number): Frame | null {
    const idx = ((tick % LAGCOMP_HISTORY_TICKS) + LAGCOMP_HISTORY_TICKS) % LAGCOMP_HISTORY_TICKS;
    const f = this.frames[idx]!;
    return f.tick === tick ? f : null;
  }

  /** Raycast against hit volumes as recorded at `tick` (rewound lag compensation). */
  raycast(
    tick: number,
    origin: Vec3,
    dir: Vec3,
    maxDist: number,
    excludeId: number,
    filter: (p: PlayerState) => boolean,
    out: PlayerHit,
  ): boolean {
    const frame = this.findFrame(tick);
    if (!frame) return false;
    let bestDist = maxDist;
    let bestId = -1;
    let bestZone = -1;
    let bestX = 0, bestY = 0, bestZ = 0;
    for (let i = 0; i < frame.count; i++) {
      const e = frame.entries[i]!;
      if (e.id === excludeId) continue;
      if (!filter(e.proxy)) continue;
      if (testVolumes(e, origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, bestDist)) {
        bestDist = _volHit.dist;
        bestZone = _volHit.zone;
        bestId = e.id;
        bestX = _volHit.point.x; bestY = _volHit.point.y; bestZ = _volHit.point.z;
      }
    }
    if (bestId < 0) return false;
    out.id = bestId;
    out.zone = bestZone;
    out.dist = bestDist;
    out.point.x = bestX; out.point.y = bestY; out.point.z = bestZ;
    return true;
  }

  /** Raycast against live player state (used for bots, whose cmd.tick already collapses the rewind formula to "now"). */
  raycastNow(
    players: Iterable<PlayerState>,
    origin: Vec3,
    dir: Vec3,
    maxDist: number,
    excludeId: number,
    filter: (p: PlayerState) => boolean,
    out: PlayerHit,
  ): boolean {
    let bestDist = maxDist;
    let bestId = -1;
    let bestZone = -1;
    let bestX = 0, bestY = 0, bestZ = 0;
    let i = 0;
    for (const p of players) {
      if (p.id === excludeId) continue;
      if (!filter(p)) continue;
      if (i >= this.nowScratch.length) break;
      const e = this.nowScratch[i]!;
      e.id = p.id; e.team = p.team; e.alive = p.alive;
      e.x = p.pos.x; e.y = p.pos.y; e.z = p.pos.z;
      e.yaw = p.yaw; e.height = p.height; e.stance = p.stance;
      i++;
      if (testVolumes(e, origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, bestDist)) {
        bestDist = _volHit.dist;
        bestZone = _volHit.zone;
        bestId = e.id;
        bestX = _volHit.point.x; bestY = _volHit.point.y; bestZ = _volHit.point.z;
      }
    }
    if (bestId < 0) return false;
    out.id = bestId;
    out.zone = bestZone;
    out.dist = bestDist;
    out.point.x = bestX; out.point.y = bestY; out.point.z = bestZ;
    return true;
  }
}
