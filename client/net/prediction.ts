// Client-side movement/weapon prediction and server reconciliation. See plan
// §3: every 60 Hz input sample runs the same stepPlayer/stepWeapon the server
// runs, buffered so an authoritative correction can replay the commands the
// server hadn't applied yet. Yaw/pitch are look input the player just gave;
// they are never overwritten by a correction.

import { damp } from '../../shared/math.ts';
import { stepPlayer } from '../../shared/movement.ts';
import { stepWeapon } from '../../shared/sim/weaponstate.ts';
import {
  PREDICTION_BUFFER_SIZE,
  RECONCILE_IGNORE_DIST,
  RECONCILE_SMOOTH_HZ,
  RECONCILE_SNAP_DIST,
  TICK_DT,
} from '../../shared/constants.ts';
import { applyLocalBlock } from '../../shared/protocol.ts';
import {
  copyInputCmd,
  copyPlayerState,
  createInputCmd,
  createPlayerState,
  vec3,
} from '../../shared/types.ts';
import type { InputCmd, LocalStateBlock, PlayerState, Vec3 } from '../../shared/types.ts';
import { createMovementEvents, createWeaponEvents, resetMovementEvents, resetWeaponEvents } from '../../shared/sim/types.ts';
import type { MovementEvents, WeaponEvents } from '../../shared/sim/types.ts';
import type { MapColliders } from '../../shared/map/types.ts';

interface PredictionEntry {
  cmd: InputCmd;
  /** The predicted PlayerState immediately after this cmd was applied. Currently unused by reconciliation (which replays from the authoritative block instead) but kept for callers that want to inspect predicted history, e.g. debugging/HUD overlays. */
  stateAfter: PlayerState;
}

/** Fields that stepPlayer/stepWeapon evolve deterministically from input — everything the "keep prediction" / "snap" decision in onAuthoritative operates on, except yaw/pitch (client-authoritative look input; see file header). */
function copyKinematic(dst: PlayerState, src: PlayerState): void {
  dst.pos.x = src.pos.x; dst.pos.y = src.pos.y; dst.pos.z = src.pos.z;
  dst.vel.x = src.vel.x; dst.vel.y = src.vel.y; dst.vel.z = src.vel.z;
  dst.stance = src.stance; dst.stanceT = src.stanceT; dst.height = src.height;
  dst.moveState = src.moveState; dst.stateT = src.stateT;
  dst.onGround = src.onGround; dst.groundMaterial = src.groundMaterial; dst.fallStartY = src.fallStartY;
  dst.sprintT = src.sprintT; dst.tacT = src.tacT; dst.tacCooldown = src.tacCooldown;
  dst.sprintOutT = src.sprintOutT; dst.landingT = src.landingT;
  dst.slideDirX = src.slideDirX; dst.slideDirZ = src.slideDirZ;
  dst.mantleFrom.x = src.mantleFrom.x; dst.mantleFrom.y = src.mantleFrom.y; dst.mantleFrom.z = src.mantleFrom.z;
  dst.mantleTo.x = src.mantleTo.x; dst.mantleTo.y = src.mantleTo.y; dst.mantleTo.z = src.mantleTo.z;
  dst.mantleT = src.mantleT; dst.mantleDuration = src.mantleDuration;
  dst.mounted = src.mounted; dst.mountNX = src.mountNX; dst.mountNZ = src.mountNZ; dst.mountLean = src.mountLean;
  dst.footstepDist = src.footstepDist;
  dst.ads = src.ads; dst.adsT = src.adsT;
}

/** Non-kinematic authoritative fields (health, ammo, timers, ...) — always taken from the replayed state, regardless of which position-error tier onAuthoritative lands in (plan §3). */
function copyNonKinematic(dst: PlayerState, src: PlayerState): void {
  dst.health = src.health; dst.alive = src.alive; dst.deathTick = src.deathTick;
  dst.lastDamageTick = src.lastDamageTick; dst.respawnTick = src.respawnTick;
  for (let i = 0; i < 2; i++) {
    dst.slots[i]!.weapon = src.slots[i]!.weapon;
    dst.slots[i]!.mag = src.slots[i]!.mag;
    dst.slots[i]!.reserve = src.slots[i]!.reserve;
  }
  dst.activeSlot = src.activeSlot; dst.swapT = src.swapT; dst.swapTo = src.swapTo;
  dst.reloadT = src.reloadT; dst.reloadTotal = src.reloadTotal;
  dst.fireCooldown = src.fireCooldown; dst.shotIndex = src.shotIndex; dst.lastFireTick = src.lastFireTick;
  dst.firing = src.firing; dst.lastButtons = src.lastButtons;
  dst.lethalCount = src.lethalCount; dst.tacticalCount = src.tacticalCount; dst.cookT = src.cookT;
  dst.throwKind = src.throwKind; dst.meleeT = src.meleeT;
  dst.interactT = src.interactT; dst.interactSite = src.interactSite;
  dst.flashT = src.flashT; dst.flashStrength = src.flashStrength; dst.hitT = src.hitT;
  dst.connState = src.connState; dst.perks[0] = src.perks[0]; dst.perks[1] = src.perks[1];
  dst.lethal = src.lethal; dst.tactical = src.tactical; dst.team = src.team;
}

/**
 * Predicts the local player's movement and weapon state ahead of the server,
 * and reconciles against each authoritative LocalStateBlock the server sends
 * back. `local` is null before the recipient has an active player (e.g.
 * before spawning, or while spectating in S&D) — the match loop should
 * render a spectate view in that case (plan §3).
 */
export class Predictor {
  local: PlayerState | null = null;
  /** Accumulated visual-only position delta from a smoothed (non-snap) correction; decays to zero via update(dt). Add this to `local.pos` when rendering the camera/body, never when feeding position back into gameplay logic. */
  readonly renderOffset: Vec3 = vec3();
  corrections = 0;
  snaps = 0;
  lastErrorMetres = 0;
  /** Events produced by the most recent pushInput() call (not touched by reconciliation replay, which uses its own scratch event objects). */
  readonly movementEvents: MovementEvents = createMovementEvents();
  readonly weaponEvents: WeaponEvents = createWeaponEvents();

  private readonly colliders: MapColliders;
  private readonly ring: PredictionEntry[];
  private head = 0;
  private count = 0;

  // Scratch objects reused across calls to keep pushInput/onAuthoritative allocation-free.
  private readonly authoritativeScratch: PlayerState;
  private readonly replayScratch: PlayerState;
  private readonly replayMoveEvents: MovementEvents = createMovementEvents();
  private readonly replayWeaponEvents: WeaponEvents = createWeaponEvents();

  constructor(colliders: MapColliders) {
    this.colliders = colliders;
    this.ring = new Array(PREDICTION_BUFFER_SIZE);
    for (let i = 0; i < PREDICTION_BUFFER_SIZE; i++) {
      this.ring[i] = { cmd: createInputCmd(), stateAfter: createPlayerState(0, '', 0) };
    }
    this.authoritativeScratch = createPlayerState(0, '', 0);
    this.replayScratch = createPlayerState(0, '', 0);
  }

  /** Steps `local` forward by one tick with `cmd` and records it in the reconciliation ring. No-ops if `local` is null (nothing to predict yet). */
  pushInput(cmd: InputCmd): void {
    if (!this.local) return;
    resetMovementEvents(this.movementEvents);
    resetWeaponEvents(this.weaponEvents);
    stepPlayer(this.local, cmd, this.colliders, TICK_DT, this.movementEvents);
    stepWeapon(this.local, cmd, TICK_DT, this.weaponEvents);

    const slot = this.ring[this.head]!;
    copyInputCmd(slot.cmd, cmd);
    copyPlayerState(slot.stateAfter, this.local);
    this.head = (this.head + 1) % PREDICTION_BUFFER_SIZE;
    if (this.count < PREDICTION_BUFFER_SIZE) this.count++;
  }

  /**
   * Reconciles against the recipient's own LocalStateBlock from a SNAPSHOT.
   * Drops buffered commands with seq <= lastAckSeq and replays the rest on
   * top of the authoritative block; compares the replayed position against
   * the currently predicted one and keeps/smooths/snaps accordingly (plan
   * §3's three error tiers). If `local` is null this is the first
   * authoritative state seen (e.g. just spawned) — adopt it directly with no
   * replay needed.
   */
  onAuthoritative(block: LocalStateBlock, lastAckSeq: number): void {
    if (!this.local) {
      this.local = createPlayerState(0, '', block.team);
      applyLocalBlock(this.local, block);
      this.head = 0;
      this.count = 0;
      this.renderOffset.x = 0; this.renderOffset.y = 0; this.renderOffset.z = 0;
      return;
    }

    applyLocalBlock(this.authoritativeScratch, block);
    copyPlayerState(this.replayScratch, this.authoritativeScratch);

    const oldestIdx = (this.head - this.count + PREDICTION_BUFFER_SIZE) % PREDICTION_BUFFER_SIZE;
    for (let i = 0; i < this.count; i++) {
      const entry = this.ring[(oldestIdx + i) % PREDICTION_BUFFER_SIZE]!;
      if (entry.cmd.seq <= lastAckSeq) continue;
      resetMovementEvents(this.replayMoveEvents);
      resetWeaponEvents(this.replayWeaponEvents);
      stepPlayer(this.replayScratch, entry.cmd, this.colliders, TICK_DT, this.replayMoveEvents);
      stepWeapon(this.replayScratch, entry.cmd, TICK_DT, this.replayWeaponEvents);
    }

    const dx = this.replayScratch.pos.x - this.local.pos.x;
    const dy = this.replayScratch.pos.y - this.local.pos.y;
    const dz = this.replayScratch.pos.z - this.local.pos.z;
    const error = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.lastErrorMetres = error;

    if (error < RECONCILE_IGNORE_DIST) {
      // Prediction was accurate enough to keep as-is.
    } else if (error < RECONCILE_SNAP_DIST) {
      // Adopt the replayed (correct) kinematics, but preserve visual
      // continuity by pushing the jump into renderOffset for update() to
      // smooth out over RECONCILE_SMOOTH_HZ instead of popping the camera.
      this.renderOffset.x += this.local.pos.x - this.replayScratch.pos.x;
      this.renderOffset.y += this.local.pos.y - this.replayScratch.pos.y;
      this.renderOffset.z += this.local.pos.z - this.replayScratch.pos.z;
      copyKinematic(this.local, this.replayScratch);
      this.corrections++;
    } else {
      copyKinematic(this.local, this.replayScratch);
      this.renderOffset.x = 0; this.renderOffset.y = 0; this.renderOffset.z = 0;
      this.snaps++;
    }
    // Non-kinematic fields (health, ammo, timers, ...) always come from the
    // replay, independent of the position-error tier above.
    copyNonKinematic(this.local, this.replayScratch);
  }

  /** Decays renderOffset toward zero at RECONCILE_SMOOTH_HZ. Call once per render frame with the frame's dt in seconds. */
  update(dt: number): void {
    this.renderOffset.x = damp(this.renderOffset.x, 0, RECONCILE_SMOOTH_HZ, dt);
    this.renderOffset.y = damp(this.renderOffset.y, 0, RECONCILE_SMOOTH_HZ, dt);
    this.renderOffset.z = damp(this.renderOffset.z, 0, RECONCILE_SMOOTH_HZ, dt);
  }

  /**
   * Returns up to `n` of the most recently pushed InputCmds, newest first,
   * for the INPUT message's redundancy (plan §3: newest + previous
   * INPUT_REDUNDANCY - 1). The returned array holds direct references into
   * the ring buffer, not copies — encode/send them before the next
   * pushInput() call overwrites the oldest of those slots.
   */
  pendingCmds(n: number): InputCmd[] {
    const count = Math.min(n, this.count);
    const out: InputCmd[] = [];
    let idx = (this.head - 1 + PREDICTION_BUFFER_SIZE) % PREDICTION_BUFFER_SIZE;
    for (let i = 0; i < count; i++) {
      out.push(this.ring[idx]!.cmd);
      idx = (idx - 1 + PREDICTION_BUFFER_SIZE) % PREDICTION_BUFFER_SIZE;
    }
    return out;
  }
}
