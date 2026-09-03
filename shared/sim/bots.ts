// Bot AI. Produces an InputCmd exactly like a human client would, so it feeds
// World.applyInput without any special casing. Pure TypeScript: no DOM, no
// three.js, no Date.now()/performance.now()/Math.random() — this module's own
// mulberry32 instance is the only source of randomness, seeded by the caller,
// so a bot's behaviour is fully deterministic given (seed, world history).
//
// Plan §8 (bot FSM), §3 (bot cmd.tick collapses lag comp to "now"), §4 (weapon
// ranges/rpm used for fire pacing) and §9 (this file's owners/consumers).
//
// A handful of AI-tuning numbers (turn rate, aim error, reaction delay, burst
// length, engage/backoff ranges, stuck detection, crouch-health threshold,
// grenade throw window) are specified in the plan prose but are not present in
// shared/constants.ts, which only defines BOT_RECRUIT/REGULAR/VETERAN,
// BOT_MEMORY_SECONDS and BOT_ADS_RANGE. constants.ts is a frozen contract file
// (W0) this assignment may not edit, so those extra tunables live here as
// local consts, the same way weapons.ts/perks.ts hold their own data. See the
// "BOT AI TUNABLES" block below.

import type { InputCmd, PlayerState, Vec3 } from '../types.ts';
import { createInputCmd, vec3 } from '../types.ts';
import type { BotBrainLike, ModeRules, WorldView } from './types.ts';
import type { Site } from '../map/types.ts';
import {
  BOT_ADS_RANGE,
  BOT_MEMORY_SECONDS,
  BOT_RECRUIT,
  BOT_REGULAR,
  BOT_VETERAN,
  BOMB_PLANTED,
  BTN_ADS,
  BTN_CROUCH,
  BTN_FIRE,
  BTN_INTERACT,
  BTN_JUMP,
  BTN_LETHAL,
  BTN_MELEE,
  BTN_RELOAD,
  BTN_SPRINT,
  HEALTH_MAX,
  INTERP_TICKS,
  MELEE_RANGE,
  MODE_SND,
  SLOT_PRIMARY,
  SLOT_SECONDARY,
  SND_SITE_RADIUS,
  TICK_DT,
  TICK_RATE,
  WEAPON_AR,
  WEAPON_NONE,
  WEAPON_SHOTGUN,
  WEAPON_SMG,
} from '../constants.ts';
import { clamp, mulberry32, vdist, wrapAngle } from '../math.ts';
import { eyeHeight } from '../movement.ts';
import { WEAPONS } from '../weapons.ts';

// ---------------------------------------------------------------------------
// BOT AI TUNABLES (see file header) — plan §8 numbers not carried in constants.ts
// ---------------------------------------------------------------------------
/** Degrees per second the aim yaw/pitch may turn, by difficulty. */
const TURN_RATE_DEG: Record<number, number> = { [BOT_RECRUIT]: 180, [BOT_REGULAR]: 360, [BOT_VETERAN]: 720 };
/** Max aim error in degrees immediately after acquiring a target, decaying to 0 over AIM_ERROR_DECAY_S. */
const AIM_ERROR_DEG: Record<number, number> = { [BOT_RECRUIT]: 6, [BOT_REGULAR]: 3, [BOT_VETERAN]: 1 };
/** Reaction delay in ms before the first shot at a newly acquired target. */
const REACTION_MS: Record<number, number> = { [BOT_RECRUIT]: 600, [BOT_REGULAR]: 400, [BOT_VETERAN]: 250 };
const AIM_ERROR_DECAY_S = 1.5;

const ENGAGE_RANGE = 60; // m, max distance a bot will acknowledge/engage a visible enemy
const ROAM_TARGET_DIST_MIN = 18;
const ROAM_TARGET_DIST_MAX = 42;
const ROAM_SPRINT_DIST = 8; // m, sprint toward a waypoint farther than this with no enemy in memory
const WAYPOINT_ARRIVE_DIST = 1.0; // m, horizontal distance at which a waypoint counts as reached
const WAYPOINT_JUMP_HEIGHT = 0.5; // m, waypoint height above the bot that triggers a jump
const WAYPOINT_JUMP_TRIGGER_DIST = 2.0; // m, how close before the height check fires
const STUCK_WINDOW_S = 1.5;
const STUCK_DIST = 0.3; // m, displacement below this over STUCK_WINDOW_S = stuck
const BACKOFF_RANGE = 3; // m, back off closer than this unless shotgun/SMG
const SHOTGUN_MAX_RANGE = 22; // m
const STRAFE_FLIP_S = 0.8;
const BURST_MIN_SHOTS = 3;
const BURST_MAX_SHOTS = 6; // inclusive
const BURST_PAUSE_S = 0.3;
const CROUCH_HEALTH_FRAC = 0.4; // fraction of HEALTH_MAX below which a bot engaging crouches
const GRENADE_MIN_DIST = 8;
const GRENADE_MAX_DIST = 25;
const GRENADE_UNSEEN_S = 1;
const GRENADE_CHANCE_PER_S = 0.2;
const GRENADE_COOK_S = 1.5;
const GRENADE_LOB_PITCH = 0.35; // rad, upward aim bias while cooking so the throw arcs
const RELOAD_MAG_FRAC = 0.3;
const SND_SITE_APPROACH_JITTER = 3; // m, random offset around a site's centre so bots don't stack

// FSM states. Internal to this module; not a "gameplay number", just labels.
const FSM_ROAM = 0;
const FSM_RELOAD = 1;
const FSM_GRENADE = 2;

const BOT_NAMES = ['Ghost', 'Soap', 'Price', 'Gaz', 'Roach', 'Alex', 'Farah', 'Nikto', 'Mara', 'Kyle', 'Otter', 'Rook'];

export function botName(index: number): string {
  const i = ((index % BOT_NAMES.length) + BOT_NAMES.length) % BOT_NAMES.length;
  return BOT_NAMES[i]!;
}

/** Shortest signed angular difference target-current, wrapped to (-PI, PI]. */
function angleDiff(current: number, target: number): number {
  const twoPi = Math.PI * 2;
  let d = (target - current) % twoPi;
  if (d > Math.PI) d -= twoPi;
  else if (d < -Math.PI) d += twoPi;
  return d;
}

/** Steps `current` toward `target` by at most `maxDelta` (radians), wrapping the result to [0, 2*PI). */
function turnToward(current: number, target: number, maxDelta: number): number {
  const d = angleDiff(current, target);
  const clamped = d > maxDelta ? maxDelta : d < -maxDelta ? -maxDelta : d;
  return wrapAngle(current + clamped);
}

/** Yaw (three.js FPS convention: 0 faces -Z, increasing yaw turns left) that faces (dx,dz). */
function yawTo(dx: number, dz: number): number {
  return wrapAngle(Math.atan2(-dx, -dz));
}

export class BotBrain implements BotBrainLike {
  readonly id: number;
  readonly difficulty: number;
  private readonly rng: () => number;

  // --- per-bot persistent scratch state (no per-tick allocation of these) ---
  private seq = 0;
  private aimYaw = 0;
  private aimPitch = 0;

  // Perception memory (single-target, matching what a real client could infer).
  private targetId = -1;
  private lastSeenTick = -1;
  private lastSeenPos: Vec3 = vec3();
  private targetAcquiredTick = -1;
  private aimErrorYawRad = 0;
  private aimErrorPitchRad = 0;

  // Combat cadence.
  private strafeSign = 1;
  private strafeTimerTicks = 0;
  private burstTicksLeft = 0;
  private pauseTicksLeft = 0;

  // FSM override state (RELOAD / GRENADE); FSM_ROAM covers both roaming and
  // plain engagement, which are distinguished by whether targetId is set.
  private fsm = FSM_ROAM;
  private grenadeStartTick = -1;

  // Roaming.
  private roamTarget: Vec3 = vec3();
  private havePath = false;
  private pathBuf: number[] = [];
  private pathIndex = 0;
  private jumpedForWaypoint = false;

  // Stuck detection.
  private stuckSamplePos: Vec3 = vec3();
  private stuckSampleTick = 0;
  private stuckSampleValid = false;

  // S&D role caching (recomputed once per round via a phase/bomb-state fingerprint).
  private sndChosenSite = -1;
  private sndLastBombState = -1;

  // Reusable scratch objects (avoid per-tick Vec3 allocation in the hot path).
  private readonly scratchEyeSelf: Vec3 = vec3();
  private readonly scratchEyeOther: Vec3 = vec3();
  private readonly scratchAimPoint: Vec3 = vec3();
  private readonly scratchPathPoint: Vec3 = vec3();

  constructor(id: number, difficulty: number, seed: number) {
    this.id = id;
    this.difficulty = difficulty;
    this.rng = mulberry32(seed);
  }

  think(world: WorldView, rules: ModeRules, tick: number): InputCmd {
    const cmd = createInputCmd();
    this.seq += 1;
    cmd.seq = this.seq;
    // Bots have no network delay to compensate; stamping "now" collapses lag
    // compensation's rewind to the current tick (plan §3).
    cmd.tick = tick + INTERP_TICKS;

    const self = world.players.get(this.id);
    if (!self) return cmd; // removed mid-tick; nothing to do

    if (world.frozen || !self.alive) {
      // No movement, no buttons, hold last aim so nothing snaps oddly on unfreeze.
      cmd.yaw = this.aimYaw;
      cmd.pitch = this.aimPitch;
      return cmd;
    }

    this.updatePerception(world, rules, self, tick);

    const hasTargetNow = this.targetId !== -1 && this.lastSeenTick === tick;
    const hasMemory = this.targetId !== -1;

    // Weapon slot selection: fall back to the sidearm once the primary is dry,
    // or immediately if under fire and there is no time to reload it.
    const desiredSlot = this.pickWeaponSlot(self, hasTargetNow);
    cmd.weaponSlot = desiredSlot;
    const activeSlotState = self.slots[desiredSlot];
    const def = activeSlotState.weapon === WEAPON_NONE ? undefined : WEAPONS[activeSlotState.weapon];

    // FSM override states take priority over everything else this tick.
    if (this.fsm === FSM_RELOAD) {
      this.stepReload(self, activeSlotState, cmd);
      this.applyMovement(world, rules, self, cmd, hasMemory, hasTargetNow, tick, false);
      return cmd;
    }
    if (this.fsm === FSM_GRENADE) {
      this.stepGrenade(self, cmd, tick);
      this.applyMovement(world, rules, self, cmd, hasMemory, hasTargetNow, tick, false);
      return cmd;
    }

    // Melee: closing to point-blank range on a target we can see overrides gunplay.
    if (hasTargetNow) {
      const target = world.players.get(this.targetId);
      if (target && vdist(self.pos, target.pos) <= MELEE_RANGE) {
        cmd.buttons |= BTN_MELEE;
        this.aimAt(self, target.pos, target.height, target.vel, tick, cmd, true);
        this.applyMovement(world, rules, self, cmd, hasMemory, hasTargetNow, tick, true);
        return cmd;
      }
    }

    // Should we start reloading? (mag<30% and no target for 1s, or fully empty
    // with reserve to draw from; a totally dry weapon with no reserve instead
    // falls out via pickWeaponSlot above.)
    if (def && activeSlotState.reserve > 0 && self.reloadT === 0) {
      const magFrac = def.magSize > 0 ? activeSlotState.mag / def.magSize : 1;
      const noTargetFor1s = this.targetId === -1 || tick - this.lastSeenTick >= TICK_RATE;
      if (activeSlotState.mag === 0 || (magFrac < RELOAD_MAG_FRAC && noTargetFor1s)) {
        this.fsm = FSM_RELOAD;
        this.stepReload(self, activeSlotState, cmd);
        this.applyMovement(world, rules, self, cmd, hasMemory, hasTargetNow, tick, false);
        return cmd;
      }
    }

    // Should we throw a grenade at a lost target's last position?
    if (
      hasMemory &&
      !hasTargetNow &&
      self.lethalCount > 0 &&
      tick - this.lastSeenTick > GRENADE_UNSEEN_S * TICK_RATE
    ) {
      const d = vdist(self.pos, this.lastSeenPos);
      if (d >= GRENADE_MIN_DIST && d <= GRENADE_MAX_DIST && this.rng() < GRENADE_CHANCE_PER_S * TICK_DT) {
        this.fsm = FSM_GRENADE;
        this.grenadeStartTick = tick;
        this.stepGrenade(self, cmd, tick);
        this.applyMovement(world, rules, self, cmd, hasMemory, hasTargetNow, tick, false);
        return cmd;
      }
    }

    // Normal engage/roam aim + fire.
    if (hasMemory) {
      const aimPos = hasTargetNow ? (world.players.get(this.targetId)?.pos ?? this.lastSeenPos) : this.lastSeenPos;
      const aimHeight = hasTargetNow ? (world.players.get(this.targetId)?.height ?? 1.8) : 1.8;
      const aimVel = hasTargetNow ? (world.players.get(this.targetId)?.vel ?? null) : null;
      this.aimAt(self, aimPos, aimHeight, aimVel, tick, cmd, true);

      const dist = vdist(self.pos, aimPos);
      if (dist > BOT_ADS_RANGE) cmd.buttons |= BTN_ADS;
      if (self.health < CROUCH_HEALTH_FRAC * HEALTH_MAX) cmd.buttons |= BTN_CROUCH;

      if (hasTargetNow && def) {
        const reactionMs = REACTION_MS[this.difficulty] ?? REACTION_MS[BOT_REGULAR]!;
        const reactionTicks = Math.round((reactionMs / 1000) * TICK_RATE);
        const reactionElapsed = this.targetAcquiredTick >= 0 && tick - this.targetAcquiredTick >= reactionTicks;
        this.stepFire(def, activeSlotState.weapon, dist, cmd, reactionElapsed);
      } else {
        // Not visible right now: hold fire, still stop bursts from resuming stale.
        this.burstTicksLeft = 0;
        this.pauseTicksLeft = 0;
      }
    } else {
      // Pure roam: level aim toward the current waypoint (set inside applyMovement).
      cmd.yaw = this.aimYaw;
      cmd.pitch = this.aimPitch;
    }

    this.applyMovement(world, rules, self, cmd, hasMemory, hasTargetNow, tick, false);
    return cmd;
  }

  // -------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------
  private updatePerception(world: WorldView, rules: ModeRules, self: PlayerState, tick: number): void {
    world.eyePos(self, this.scratchEyeSelf);

    let bestId = -1;
    let bestDist = ENGAGE_RANGE;
    for (const other of world.players.values()) {
      if (other.id === self.id || !other.alive) continue;
      if (!rules.isEnemy(self, other)) continue;
      const d = vdist(self.pos, other.pos);
      if (d > bestDist) continue;
      world.eyePos(other, this.scratchEyeOther);
      if (!world.hasLineOfSight(this.scratchEyeSelf, this.scratchEyeOther)) continue;
      bestId = other.id;
      bestDist = d;
    }

    if (bestId !== -1) {
      if (this.targetId !== bestId) {
        // Newly acquired target: reset reaction/aim-error timers and combat cadence.
        this.targetAcquiredTick = tick;
        this.burstTicksLeft = 0;
        this.pauseTicksLeft = 0;
        this.rollAimError();
      }
      this.targetId = bestId;
      this.lastSeenTick = tick;
      const other = world.players.get(bestId);
      if (other) {
        this.lastSeenPos.x = other.pos.x;
        this.lastSeenPos.y = other.pos.y;
        this.lastSeenPos.z = other.pos.z;
      }
    } else if (this.targetId !== -1 && tick - this.lastSeenTick > BOT_MEMORY_SECONDS * TICK_RATE) {
      // Memory expired.
      this.targetId = -1;
      this.targetAcquiredTick = -1;
    }
  }

  private rollAimError(): void {
    const maxDeg = AIM_ERROR_DEG[this.difficulty] ?? AIM_ERROR_DEG[BOT_REGULAR]!;
    const maxRad = (maxDeg * Math.PI) / 180;
    this.aimErrorYawRad = (this.rng() * 2 - 1) * maxRad;
    this.aimErrorPitchRad = (this.rng() * 2 - 1) * maxRad * 0.5;
  }

  // -------------------------------------------------------------------------
  // Aiming
  // -------------------------------------------------------------------------
  /**
   * Turns cmd.yaw/pitch toward `targetPos` (chest height: +0.5*targetHeight),
   * applying per-difficulty turn rate, decaying aim error, and lead by
   * `targetVel` (only meaningful when the target is actually visible now).
   */
  private aimAt(
    self: PlayerState,
    targetPos: Vec3,
    targetHeight: number,
    targetVel: Vec3 | null,
    tick: number,
    cmd: InputCmd,
    updatePersisted: boolean,
  ): void {
    this.scratchAimPoint.x = targetPos.x + (targetVel ? targetVel.x * 0.05 : 0);
    this.scratchAimPoint.y = targetPos.y + 0.5 * targetHeight + (targetVel ? targetVel.y * 0.05 : 0);
    this.scratchAimPoint.z = targetPos.z + (targetVel ? targetVel.z * 0.05 : 0);

    const eyeY = self.pos.y + eyeHeight(self);
    const dx = this.scratchAimPoint.x - self.pos.x;
    const dz = this.scratchAimPoint.z - self.pos.z;
    const horiz = Math.sqrt(dx * dx + dz * dz) || 1e-6;
    const dy = this.scratchAimPoint.y - eyeY;

    // Aim error decays linearly to 0 over AIM_ERROR_DECAY_S after acquisition.
    const sinceAcquired = this.targetAcquiredTick < 0 ? AIM_ERROR_DECAY_S : (tick - this.targetAcquiredTick) * TICK_DT;
    const errorScale = clamp(1 - sinceAcquired / AIM_ERROR_DECAY_S, 0, 1);

    const perfectYaw = yawTo(dx, dz);
    const perfectPitch = clamp(Math.atan2(dy, horiz), -Math.PI / 2, Math.PI / 2);
    const desiredYaw = perfectYaw + this.aimErrorYawRad * errorScale;
    const desiredPitch = clamp(perfectPitch + this.aimErrorPitchRad * errorScale, -Math.PI / 2, Math.PI / 2);

    const turnRateDeg = TURN_RATE_DEG[this.difficulty] ?? TURN_RATE_DEG[BOT_REGULAR]!;
    const maxDelta = (turnRateDeg * Math.PI) / 180 * TICK_DT;
    const newYaw = turnToward(this.aimYaw, desiredYaw, maxDelta);
    const newPitch = clamp(this.aimPitch + clamp(desiredPitch - this.aimPitch, -maxDelta, maxDelta), -Math.PI / 2, Math.PI / 2);

    if (updatePersisted) {
      this.aimYaw = newYaw;
      this.aimPitch = newPitch;
    }
    cmd.yaw = newYaw;
    cmd.pitch = newPitch;
  }

  // -------------------------------------------------------------------------
  // Firing
  // -------------------------------------------------------------------------
  /**
   * `reactionElapsed` gates only the *start* of a fresh burst/shot (the
   * plan's reaction delay before the first shot at a newly acquired target);
   * once firing has begun, an in-progress burst or single-shot cooldown runs
   * to completion regardless, since reactionElapsed only ever flips from
   * false to true and stays true until the next re-acquisition resets it.
   */
  private stepFire(
    def: (typeof WEAPONS)[number],
    weaponId: number,
    dist: number,
    cmd: InputCmd,
    reactionElapsed: boolean,
  ): void {
    if (weaponId === WEAPON_SHOTGUN && dist > SHOTGUN_MAX_RANGE) return;

    const burstWeapon = weaponId === WEAPON_AR || weaponId === WEAPON_SMG;

    if (this.pauseTicksLeft > 0) {
      this.pauseTicksLeft -= 1;
      return;
    }

    if (this.burstTicksLeft > 0) {
      cmd.buttons |= BTN_FIRE;
      this.burstTicksLeft -= 1;
      if (this.burstTicksLeft === 0) {
        this.pauseTicksLeft = burstWeapon
          ? Math.round(BURST_PAUSE_S * TICK_RATE)
          : Math.max(1, Math.round((60 / def.rpm) * TICK_RATE)); // single-shot cadence gap
      }
      return;
    }

    if (!reactionElapsed) return;

    if (burstWeapon) {
      const shots = BURST_MIN_SHOTS + Math.floor(this.rng() * (BURST_MAX_SHOTS - BURST_MIN_SHOTS + 1));
      const secondsPerShot = 60 / def.rpm;
      this.burstTicksLeft = Math.max(1, Math.round(shots * secondsPerShot * TICK_RATE));
      cmd.buttons |= BTN_FIRE;
      this.burstTicksLeft -= 1;
    } else {
      // Single shot: one tick on, then a cooldown gap before the next press
      // (sniper, pistol and shotgun all take this branch).
      cmd.buttons |= BTN_FIRE;
      this.pauseTicksLeft = Math.max(1, Math.round((60 / def.rpm) * TICK_RATE));
    }
  }

  // -------------------------------------------------------------------------
  // Reload
  // -------------------------------------------------------------------------
  private stepReload(self: PlayerState, slot: PlayerState['slots'][number], cmd: InputCmd): void {
    if (self.reloadT === 0 && slot.mag === 0 && slot.reserve === 0) {
      // Nothing to reload (shouldn't normally get here; pickWeaponSlot avoids it).
      this.fsm = FSM_ROAM;
      return;
    }
    if (self.reloadT === 0) {
      // Not yet reloading: press the edge to start it.
      cmd.buttons |= BTN_RELOAD;
    }
    // Once World/weaponstate reports the mag topped up (reloadT back to 0 and
    // mag no longer empty), leave the RELOAD override.
    if (self.reloadT === 0 && slot.mag > 0) {
      this.fsm = FSM_ROAM;
    }
    cmd.yaw = this.aimYaw;
    cmd.pitch = this.aimPitch;
  }

  // -------------------------------------------------------------------------
  // Grenade
  // -------------------------------------------------------------------------
  private stepGrenade(self: PlayerState, cmd: InputCmd, tick: number): void {
    const holdTicks = Math.round(GRENADE_COOK_S * TICK_RATE);
    const elapsed = tick - this.grenadeStartTick;
    // Aim at the remembered position with an upward lob bias while cooking.
    this.aimAt(self, this.lastSeenPos, 1.8, null, tick, cmd, true);
    cmd.pitch = clamp(cmd.pitch + GRENADE_LOB_PITCH, -Math.PI / 2, Math.PI / 2);
    this.aimPitch = cmd.pitch;

    if (elapsed < holdTicks) {
      cmd.buttons |= BTN_LETHAL;
    } else {
      // Release this tick (throw-on-release); leave the override state.
      this.fsm = FSM_ROAM;
      this.grenadeStartTick = -1;
    }
  }

  // -------------------------------------------------------------------------
  // Weapon slot selection
  // -------------------------------------------------------------------------
  private pickWeaponSlot(self: PlayerState, hasTargetNow: boolean): number {
    const primary = self.slots[SLOT_PRIMARY];
    const secondary = self.slots[SLOT_SECONDARY];
    if (primary.weapon === WEAPON_NONE) return SLOT_SECONDARY;
    if (primary.mag === 0) {
      if (primary.reserve === 0) return SLOT_SECONDARY; // permanently dry
      if (hasTargetNow) return SLOT_SECONDARY; // no time to reload under fire
      // else: safe to stay on the primary and reload it (handled by the RELOAD FSM check).
    }
    return SLOT_PRIMARY;
  }

  // -------------------------------------------------------------------------
  // Movement (roam pathing, S&D site logic, strafing/back-off, stance, sprint,
  // jump/mantle, stuck detection). Always relative to cmd.yaw, which the sim
  // treats as the forward axis for moveY (plan §8).
  // -------------------------------------------------------------------------
  private applyMovement(
    world: WorldView,
    rules: ModeRules,
    self: PlayerState,
    cmd: InputCmd,
    hasMemory: boolean,
    hasTargetNow: boolean,
    tick: number,
    isMeleeing: boolean,
  ): void {
    this.checkStuck(self, tick);

    if (isMeleeing) {
      cmd.moveX = 0;
      cmd.moveY = 1; // close the last half-metre into the swing
      return;
    }

    if (hasMemory) {
      this.applyEngageMovement(world, self, cmd, hasTargetNow);
      return;
    }

    this.applyRoamMovement(world, rules, self, cmd, tick);
  }

  private applyEngageMovement(world: WorldView, self: PlayerState, cmd: InputCmd, hasTargetNow: boolean): void {
    const target = hasTargetNow ? world.players.get(this.targetId) : undefined;
    const targetPos = target ? target.pos : this.lastSeenPos;
    const dist = vdist(self.pos, targetPos);
    const weaponId = self.slots[cmd.weaponSlot].weapon;
    const closeRangeOk = weaponId === WEAPON_SHOTGUN || weaponId === WEAPON_SMG;

    // Strafe direction flips every STRAFE_FLIP_S.
    this.strafeTimerTicks += 1;
    if (this.strafeTimerTicks >= Math.round(STRAFE_FLIP_S * TICK_RATE)) {
      this.strafeTimerTicks = 0;
      this.strafeSign = -this.strafeSign;
    }

    let approach = 0;
    if (dist < BACKOFF_RANGE && !closeRangeOk) approach = -1;
    else if (dist > BOT_ADS_RANGE) approach = 1;

    // moveX/moveY are relative to cmd.yaw, which aimAt() just pointed at the
    // target, so these axes are already "strafe" / "toward-target" directly.
    cmd.moveX = this.strafeSign * 0.7;
    cmd.moveY = approach;
  }

  private applyRoamMovement(world: WorldView, rules: ModeRules, self: PlayerState, cmd: InputCmd, tick: number): void {
    const holdingPosition = this.applySndOverride(world, rules, self, cmd, tick);
    if (holdingPosition) {
      // Planting/defusing: stand still rather than falling through to the
      // waypoint-follow logic below, which would otherwise wander off once
      // the current path is exhausted.
      cmd.moveX = 0;
      cmd.moveY = 0;
      if (this.targetId !== -1) cmd.buttons |= BTN_CROUCH;
      return;
    }

    if (!this.havePath || this.pathIndex >= this.pathBuf.length) {
      this.pickNewRoamTarget(world, self);
    }

    if (this.pathIndex < this.pathBuf.length) {
      const wx = this.pathBuf[this.pathIndex]!;
      const wz = this.pathBuf[this.pathIndex + 1]!;
      const dx = wx - self.pos.x;
      const dz = wz - self.pos.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);

      if (horizDist < WAYPOINT_ARRIVE_DIST) {
        this.pathIndex += 2;
        this.jumpedForWaypoint = false;
      } else {
        const wy = world.nav.heightAt(wx, wz);
        const desiredYaw = yawTo(dx, dz);
        const turnRateDeg = TURN_RATE_DEG[this.difficulty] ?? TURN_RATE_DEG[BOT_REGULAR]!;
        const maxDelta = (turnRateDeg * Math.PI) / 180 * TICK_DT;
        this.aimYaw = turnToward(this.aimYaw, desiredYaw, maxDelta);
        const desiredPitch = clamp(Math.atan2(wy - (self.pos.y + eyeHeight(self)), horizDist || 1e-6), -0.3, 0.3);
        this.aimPitch = clamp(this.aimPitch + clamp(desiredPitch - this.aimPitch, -maxDelta, maxDelta), -Math.PI / 2, Math.PI / 2);
        cmd.yaw = this.aimYaw;
        cmd.pitch = this.aimPitch;
        cmd.moveX = 0;
        cmd.moveY = 1;

        if (!this.jumpedForWaypoint && horizDist < WAYPOINT_JUMP_TRIGGER_DIST && wy - self.pos.y > WAYPOINT_JUMP_HEIGHT) {
          cmd.buttons |= BTN_JUMP;
          this.jumpedForWaypoint = true;
        }

        const sprintNoEnemy = this.targetId === -1;
        if (horizDist > ROAM_SPRINT_DIST && sprintNoEnemy) {
          cmd.buttons |= BTN_SPRINT;
        }
      }
    }

    // "Crouch-walk near cover when memory has an enemy": approximated as
    // crouching while roaming with an enemy still in memory (no route to
    // real cover geometry from this module — see report gaps).
    if (this.targetId !== -1) cmd.buttons |= BTN_CROUCH;
  }

  private pickNewRoamTarget(world: WorldView, self: PlayerState): void {
    let best: Vec3 | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      world.nav.randomPoint(this.rng, this.scratchPathPoint);
      const d = vdist(self.pos, this.scratchPathPoint);
      if (d >= ROAM_TARGET_DIST_MIN && d <= ROAM_TARGET_DIST_MAX) {
        best = this.scratchPathPoint;
        break;
      }
      if (!best) {
        this.roamTarget.x = this.scratchPathPoint.x;
        this.roamTarget.y = this.scratchPathPoint.y;
        this.roamTarget.z = this.scratchPathPoint.z;
      }
    }
    if (best) {
      this.roamTarget.x = best.x;
      this.roamTarget.y = best.y;
      this.roamTarget.z = best.z;
    }
    this.pathBuf.length = 0;
    const found = world.nav.findPath(self.pos.x, self.pos.z, this.roamTarget.x, this.roamTarget.z, this.pathBuf);
    if (!found || this.pathBuf.length === 0) {
      this.pathBuf.length = 0;
      this.pathBuf.push(this.roamTarget.x, this.roamTarget.z);
    }
    this.pathIndex = 0;
    this.havePath = true;
    this.jumpedForWaypoint = false;
  }

  private checkStuck(self: PlayerState, tick: number): void {
    if (!this.stuckSampleValid) {
      this.stuckSamplePos.x = self.pos.x;
      this.stuckSamplePos.y = self.pos.y;
      this.stuckSamplePos.z = self.pos.z;
      this.stuckSampleTick = tick;
      this.stuckSampleValid = true;
      return;
    }
    const elapsedTicks = tick - this.stuckSampleTick;
    if (elapsedTicks < Math.round(STUCK_WINDOW_S * TICK_RATE)) return;

    const moved = vdist(self.pos, this.stuckSamplePos);
    if (moved < STUCK_DIST) {
      // Stuck: force a fresh roam target next movement pass and pulse a jump.
      this.havePath = false;
      this.pathBuf.length = 0;
      this.jumpedForWaypoint = false;
    }
    this.stuckSamplePos.x = self.pos.x;
    this.stuckSamplePos.y = self.pos.y;
    this.stuckSamplePos.z = self.pos.z;
    this.stuckSampleTick = tick;
  }

  // -------------------------------------------------------------------------
  // Search & Destroy roles
  // -------------------------------------------------------------------------
  /**
   * Overrides the roam target and issues BTN_INTERACT for S&D attacker/
   * defender behaviour. No-op outside MODE_SND. See report gaps: attacker vs.
   * defender is inferred from the bomb carrier's team (the only role signal
   * WorldView/ModeRules exposes); before any carrier is assigned this tick,
   * bots fall back to plain roaming.
   */
  /** Returns true when the bot is holding position to plant/defuse this tick. */
  private applySndOverride(world: WorldView, rules: ModeRules, self: PlayerState, cmd: InputCmd, tick: number): boolean {
    if (rules.mode !== MODE_SND) return false;
    const bomb = rules.bomb;
    if (bomb.state !== this.sndLastBombState) {
      this.sndLastBombState = bomb.state;
      this.sndChosenSite = -1; // re-pick when the bomb state changes (new round, plant, etc.)
    }

    const sites = world.colliders.sites;
    if (sites.length === 0) return false;

    let role: 'attacker' | 'defender' | 'unknown' = 'unknown';
    if (bomb.carrier !== 0) {
      const carrier = world.players.get(bomb.carrier);
      if (carrier) role = carrier.team === self.team ? 'attacker' : 'defender';
    }

    if (role === 'unknown') return false; // plain roam until a role is knowable

    const enemyVisible = this.targetId !== -1 && this.lastSeenTick === tick;

    if (bomb.state === BOMB_PLANTED) {
      // Both roles converge on the planted site; only the defender interacts
      // (defuses) there — a planted bomb has nothing left for an attacker to do.
      const site = sites[bomb.site] ?? sites[0]!;
      if (role === 'defender' && vdist(self.pos, site) <= SND_SITE_RADIUS && !enemyVisible) {
        cmd.buttons |= BTN_INTERACT;
        return true;
      }
      this.setRoamDestination(world, self, site.x, site.z);
      return false;
    }

    if (role === 'attacker') {
      if (this.sndChosenSite === -1) this.sndChosenSite = this.chooseAttackSite(sites);
      const site = sites[this.sndChosenSite] ?? sites[0]!;
      const isCarrier = bomb.carrier === self.id;
      if (isCarrier && vdist(self.pos, site) <= site.radius && !enemyVisible) {
        cmd.buttons |= BTN_INTERACT;
        return true;
      }
      this.setRoamDestination(world, self, site.x, site.z);
      return false;
    }

    // Defender, bomb not yet planted: spread between sites by id parity.
    const siteIndex = this.id % sites.length;
    const site = sites[siteIndex] ?? sites[0]!;
    this.setRoamDestination(world, self, site.x, site.z);
    return false;
  }

  /** Prefers the site with fewer enemies in this bot's own memory (single-target memory, so this is a coarse proxy). */
  private chooseAttackSite(sites: readonly Site[]): number {
    if (this.targetId === -1) return Math.floor(this.rng() * sites.length);
    let farthestIdx = 0;
    let farthestDist = -1;
    for (let i = 0; i < sites.length; i++) {
      const s = sites[i]!;
      const d = vdist(this.lastSeenPos, s);
      if (d > farthestDist) {
        farthestDist = d;
        farthestIdx = i;
      }
    }
    return farthestIdx;
  }

  private setRoamDestination(world: WorldView, self: PlayerState, x: number, z: number): void {
    const jitterX = (this.rng() * 2 - 1) * SND_SITE_APPROACH_JITTER;
    const jitterZ = (this.rng() * 2 - 1) * SND_SITE_APPROACH_JITTER;
    const tx = x + jitterX;
    const tz = z + jitterZ;
    this.scratchPathPoint.x = tx;
    this.scratchPathPoint.y = self.pos.y;
    this.scratchPathPoint.z = tz;
    const closeEnough = vdist(self.pos, this.scratchPathPoint) < WAYPOINT_ARRIVE_DIST * 3;
    // Already routed and not yet arrived: keep following the existing path
    // rather than re-jittering a new one every tick.
    if (this.havePath && !closeEnough) return;
    this.roamTarget.x = tx;
    this.roamTarget.y = self.pos.y;
    this.roamTarget.z = tz;
    this.pathBuf.length = 0;
    const found = world.nav.findPath(self.pos.x, self.pos.z, tx, tz, this.pathBuf);
    if (!found || this.pathBuf.length === 0) {
      this.pathBuf.length = 0;
      this.pathBuf.push(tx, tz);
    }
    this.pathIndex = 0;
    this.havePath = true;
  }
}
