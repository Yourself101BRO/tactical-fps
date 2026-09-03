// The entire §4 movement state machine: stance, walk/sprint/tac-sprint,
// slide + slide-cancel, mantle, mount, jump/gravity/fall damage, step-up and
// capsule-vs-world collision. Pure and allocation-free: every scratch object
// is module-level and reused; stepPlayer never calls Date.now()/Math.random().

import {
  BACK_MULT,
  BTN_ADS,
  BTN_CROUCH,
  BTN_JUMP,
  BTN_MOUNT,
  BTN_PRONE,
  BTN_SPRINT,
  BTN_TACSPRINT,
  EYE_CROUCH,
  EYE_PRONE,
  EYE_STAND,
  FALL_DAMAGE_MIN_HEIGHT,
  FALL_DAMAGE_PER_M,
  GRAVITY,
  GROUND_ACCEL,
  GROUND_DECEL,
  AIR_ACCEL,
  HEIGHT_CROUCH,
  HEIGHT_PRONE,
  HEIGHT_STAND,
  JUMP_VELOCITY,
  LANDING_SLOW_MULT,
  LANDING_SLOW_TIME,
  MANTLE_DURATION,
  MANTLE_DURATION_LOW,
  MANTLE_LOW_THRESHOLD,
  MANTLE_MAX_HEIGHT,
  MANTLE_MIN_HEIGHT,
  MANTLE_RAY_DIST,
  MOUNT_EDGE_TOLERANCE,
  MOUNT_LEAN,
  MOVE_AIR,
  MOVE_CROUCH_MOVE,
  MOVE_DEAD,
  MOVE_IDLE,
  MOVE_MANTLE,
  MOVE_MOUNTED,
  MOVE_PRONE_MOVE,
  MOVE_SLIDE,
  MOVE_SPRINT,
  MOVE_TACSPRINT,
  MOVE_WALK,
  PLAYER_RADIUS,
  SLIDE_ADS_LOCK,
  SLIDE_CANCEL_KEEP,
  SLIDE_CAMERA_HEIGHT,
  SLIDE_DURATION,
  SLIDE_SPEED_END,
  SLIDE_SPEED_START,
  SPEED_CROUCH,
  SPEED_PRONE,
  SPEED_SPRINT,
  SPEED_TACSPRINT,
  SPEED_WALK,
  SPRINT_CONE_DEG,
  SPRINT_START_DELAY,
  STANCE_CROUCH,
  STANCE_PRONE,
  STANCE_STAND,
  STANCE_TIME_CROUCH,
  STANCE_TIME_FROM_PRONE,
  STANCE_TIME_TO_PRONE,
  STEP_HEIGHT,
  STRAFE_MULT,
  TACSPRINT_COOLDOWN,
  TACSPRINT_DURATION,
  TERMINAL_VELOCITY,
  WEAPON_AR,
} from './constants.ts';
import { capsuleAabbResolve, clamp, clamp01, degToRad, lerp } from './math.ts';
import { crouchSpeedMult, tacSprintDurationMult } from './perks.ts';
import { WEAPONS } from './weapons.ts';
import type { WeaponDef } from './weapons.ts';
import type { InputCmd, PlayerState } from './types.ts';
import type { Aabb, MapColliders, RayHit } from './map/types.ts';
import type { MovementEvents } from './sim/types.ts';

const HALF_PI = Math.PI / 2;

// Footstep cadence isn't a balance number — it's an animation/audio pacing
// constant with no home in shared/constants.ts (which only lists gameplay
// tunables). Kept local and flagged in the integration report.
const FOOTSTEP_STRIDE = 0.9;

// ---------------------------------------------------------------------------
// Module-level scratch (never touched by more than one call frame — stepPlayer
// is synchronous and never reentrant).
// ---------------------------------------------------------------------------
const scratchWish = { x: 0, y: 0, z: 0 };
const scratchPush = { x: 0, y: 0, z: 0 };
const scratchAabbs: Aabb[] = [];
const scratchHeadroom: Aabb[] = [];
const scratchRayHit: RayHit = { dist: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, material: 0 };

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------
export function heightForStance(stance: number): number {
  if (stance === STANCE_CROUCH) return HEIGHT_CROUCH;
  if (stance === STANCE_PRONE) return HEIGHT_PRONE;
  return HEIGHT_STAND;
}

/** Camera eye height above the feet, derived from the current (possibly mid-transition) capsule height. */
export function eyeHeight(state: PlayerState): number {
  if (state.moveState === MOVE_SLIDE) return SLIDE_CAMERA_HEIGHT;
  if (state.height >= HEIGHT_CROUCH) {
    const t = clamp01((state.height - HEIGHT_CROUCH) / (HEIGHT_STAND - HEIGHT_CROUCH));
    return lerp(EYE_CROUCH, EYE_STAND, t);
  }
  const t = clamp01((state.height - HEIGHT_PRONE) / (HEIGHT_CROUCH - HEIGHT_PRONE));
  return lerp(EYE_PRONE, EYE_CROUCH, t);
}

/** Base movement speed for the player's current tier (no ADS/landing modifiers) — for camera bob etc. */
export function currentMaxSpeed(state: PlayerState): number {
  if (state.mounted || state.moveState === MOVE_MANTLE) return 0;
  if (state.moveState === MOVE_SLIDE) {
    return lerp(SLIDE_SPEED_START, SLIDE_SPEED_END, clamp01(state.stateT / SLIDE_DURATION));
  }
  if (state.tacT > 0) return SPEED_TACSPRINT;
  if (state.sprintT >= SPRINT_START_DELAY) return SPEED_SPRINT;
  if (state.stance === STANCE_PRONE) return SPEED_PRONE;
  if (state.stance === STANCE_CROUCH) return SPEED_CROUCH * crouchSpeedMult(state);
  return SPEED_WALK;
}

function activeDefFor(state: PlayerState): WeaponDef {
  const slot = state.slots[state.activeSlot];
  const def = slot ? WEAPONS[slot.weapon] : undefined;
  return def ?? WEAPONS[WEAPON_AR]!;
}

function moveToward(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (diff > -maxDelta && diff < maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/** Rotates local (strafe, forward) input into a world-space XZ vector, magnitude preserved. */
function buildWorldFromLocal(yaw: number, lx: number, ly: number, out: { x: number; y: number; z: number }): void {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  out.x = rx * lx + fx * ly;
  out.y = 0;
  out.z = rz * lx + fz * ly;
}

// ---------------------------------------------------------------------------
// Headroom / geometry queries
// ---------------------------------------------------------------------------
/** True if a capsule of `targetHeight` at the player's current XZ would not overlap any collider. */
function hasHeadroom(px: number, feetY: number, pz: number, radius: number, targetHeight: number, colliders: MapColliders): boolean {
  scratchHeadroom.length = 0;
  const n = colliders.query(px - radius, feetY, pz - radius, px + radius, feetY + targetHeight, pz + radius, scratchHeadroom);
  for (let i = 0; i < n; i++) {
    const a = scratchHeadroom[i]!;
    if (px + radius > a.minX && px - radius < a.maxX &&
        pz + radius > a.minZ && pz - radius < a.maxZ &&
        feetY < a.maxY && feetY + targetHeight > a.minY) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Stance (stand/crouch/prone) transitions, blocked when standing up lacks headroom.
// ---------------------------------------------------------------------------
function updateStance(state: PlayerState, cmd: InputCmd, colliders: MapColliders, out: MovementEvents): void {
  // Slide/mantle/mount own the stance while active.
  if (state.moveState === MOVE_SLIDE || state.moveState === MOVE_MANTLE || state.mounted) return;

  let desired = STANCE_STAND;
  if (cmd.buttons & BTN_PRONE) desired = STANCE_PRONE;
  else if (cmd.buttons & BTN_CROUCH) desired = STANCE_CROUCH;

  if (desired !== state.stance) {
    const standingUpMore = desired < state.stance;
    if (!standingUpMore) {
      state.stance = desired;
      out.stanceChanged = true;
    } else {
      const targetH = heightForStance(desired);
      if (hasHeadroom(state.pos.x, state.pos.y, state.pos.z, PLAYER_RADIUS, targetH, colliders)) {
        state.stance = desired;
        out.stanceChanged = true;
      }
      // else: blocked by low ceiling — stay crouched/prone.
    }
  }
}

/** Smoothly moves the capsule height (and derived stanceT) toward heightForStance(state.stance). */
function stepHeight(state: PlayerState, dt: number): void {
  const target = heightForStance(state.stance);
  const leavingProne = state.height < (HEIGHT_PRONE + HEIGHT_CROUCH) * 0.5 && state.stance !== STANCE_PRONE;
  const duration = state.stance === STANCE_PRONE ? STANCE_TIME_TO_PRONE : leavingProne ? STANCE_TIME_FROM_PRONE : STANCE_TIME_CROUCH;
  const range = state.stance === STANCE_PRONE || leavingProne ? (HEIGHT_CROUCH - HEIGHT_PRONE) : (HEIGHT_STAND - HEIGHT_CROUCH);
  const speed = range / Math.max(duration, 1e-4);
  const maxStep = speed * dt;
  if (state.height < target) state.height = Math.min(target, state.height + maxStep);
  else if (state.height > target) state.height = Math.max(target, state.height - maxStep);
  state.stanceT = clamp01(1 - Math.abs(target - state.height) / Math.max(range, 1e-4));
}

// ---------------------------------------------------------------------------
// Sprint / tactical sprint bookkeeping (timers only; moveState classification
// happens later in classifyMoveState).
// ---------------------------------------------------------------------------
function updateSprintState(state: PlayerState, cmd: InputCmd, dt: number): void {
  const wasTac = state.moveState === MOVE_TACSPRINT;
  const wasSprinting = state.moveState === MOVE_SPRINT || wasTac;

  if (state.sprintOutT > 0) state.sprintOutT = Math.max(0, state.sprintOutT - dt);
  if (state.tacT <= 0 && state.tacCooldown > 0) state.tacCooldown = Math.max(0, state.tacCooldown - dt);

  const lx = clamp(cmd.moveX, -1, 1);
  const ly = clamp(cmd.moveY, -1, 1);
  const forwardish = ly > 0.1 && Math.abs(Math.atan2(Math.abs(lx), ly)) <= degToRad(SPRINT_CONE_DEG);
  const wantsSprint = (cmd.buttons & BTN_SPRINT) !== 0;
  const wantsTac = (cmd.buttons & BTN_TACSPRINT) !== 0;
  const eligible = forwardish && state.onGround && state.stance === STANCE_STAND && !state.ads && state.moveState !== MOVE_SLIDE;

  if (state.tacT > 0) {
    if (eligible && wantsTac) {
      state.tacT = Math.max(0, state.tacT - dt);
      if (state.tacT === 0) state.tacCooldown = TACSPRINT_COOLDOWN;
    } else {
      state.tacT = 0;
      state.tacCooldown = TACSPRINT_COOLDOWN;
    }
  } else if (eligible && wantsTac && state.tacCooldown <= 0) {
    state.tacT = TACSPRINT_DURATION * tacSprintDurationMult(state);
  } else if (eligible && wantsSprint) {
    state.sprintT += dt;
  }

  if (!eligible || !(wantsSprint || wantsTac)) {
    state.sprintT = 0;
  }

  const isSprintingNow = state.tacT > 0 || state.sprintT >= SPRINT_START_DELAY;
  if (wasSprinting && !isSprintingNow) {
    const def = activeDefFor(state);
    state.sprintOutT = wasTac ? def.sprintOut * 1.4 : def.sprintOut;
  }
}

// ---------------------------------------------------------------------------
// Slide + slide-cancel
// ---------------------------------------------------------------------------
/** Returns true if this tick's jump input was consumed by a slide-cancel jump. */
function handleSlide(state: PlayerState, cmd: InputCmd, dt: number, out: MovementEvents): boolean {
  if (state.moveState === MOVE_SLIDE) {
    state.stateT += dt;
    const t = clamp01(state.stateT / SLIDE_DURATION);
    const speed = lerp(SLIDE_SPEED_START, SLIDE_SPEED_END, t);
    state.vel.x = state.slideDirX * speed;
    state.vel.z = state.slideDirZ * speed;

    if (cmd.buttons & BTN_PRONE) state.stance = STANCE_PRONE;

    if (cmd.buttons & BTN_JUMP) {
      finishSlide(state, out, true, true);
      return true;
    }
    if (!(cmd.buttons & BTN_CROUCH) && !(cmd.buttons & BTN_PRONE)) {
      finishSlide(state, out, true, false);
      return false;
    }
    if (state.stateT >= SLIDE_DURATION) {
      finishSlide(state, out, false, false);
    }
    return false;
  }

  // Start condition: crouch pressed while already sprinting/tac-sprinting on the ground.
  if ((cmd.buttons & BTN_CROUCH) && state.onGround &&
      (state.moveState === MOVE_SPRINT || state.moveState === MOVE_TACSPRINT)) {
    const speed = Math.hypot(state.vel.x, state.vel.z);
    if (speed > 0.01) {
      state.slideDirX = state.vel.x / speed;
      state.slideDirZ = state.vel.z / speed;
    } else {
      state.slideDirX = -Math.sin(state.yaw);
      state.slideDirZ = -Math.cos(state.yaw);
    }
    state.vel.x = state.slideDirX * SLIDE_SPEED_START;
    state.vel.z = state.slideDirZ * SLIDE_SPEED_START;
    state.stance = STANCE_CROUCH;
    state.moveState = MOVE_SLIDE;
    state.stateT = 0;
    // Slide-cancel makes tac sprint available again immediately.
    state.tacT = 0;
    state.tacCooldown = 0;
    out.slideStarted = true;
  }
  return false;
}

function finishSlide(state: PlayerState, out: MovementEvents, early: boolean, viaJump: boolean): void {
  const len = Math.hypot(state.vel.x, state.vel.z);
  if (len > 1e-6) {
    const keep = len * SLIDE_CANCEL_KEEP;
    state.vel.x = (state.vel.x / len) * keep;
    state.vel.z = (state.vel.z / len) * keep;
  }
  if (state.stance !== STANCE_PRONE) state.stance = STANCE_STAND;
  state.moveState = MOVE_IDLE; // reclassified by classifyMoveState() later this tick
  state.stateT = 0;
  out.slideCancelled = early;
  if (viaJump) {
    // Slide-hop: jump-cancelling a slide launches the player, COD-style.
    state.vel.y = JUMP_VELOCITY;
    state.onGround = false;
    state.fallStartY = state.pos.y;
    out.jumped = true;
  }
}

// ---------------------------------------------------------------------------
// Mantle
// ---------------------------------------------------------------------------
function tryStartMantle(state: PlayerState, colliders: MapColliders, out: MovementEvents): boolean {
  const fx = -Math.sin(state.yaw), fz = -Math.cos(state.yaw);
  // Probe at the lowest mantleable height (not chest height): a ledge at the
  // MANTLE_MIN_HEIGHT..MANTLE_MAX_HEIGHT low end can sit entirely below chest
  // level, so a chest-height ray would sail over it and miss the detection.
  const probeY = state.pos.y + MANTLE_MIN_HEIGHT;
  const hit = colliders.raycast(state.pos.x, probeY, state.pos.z, fx, 0, fz, MANTLE_RAY_DIST, scratchRayHit);
  if (!hit) return false;

  const probeDist = scratchRayHit.dist + PLAYER_RADIUS + 0.1;
  const probeX = state.pos.x + fx * probeDist;
  const probeZ = state.pos.z + fz * probeDist;
  const topY = colliders.groundHeight(probeX, probeZ, state.pos.y + MANTLE_MAX_HEIGHT + 0.5);
  const rise = topY - state.pos.y;
  if (rise < MANTLE_MIN_HEIGHT || rise > MANTLE_MAX_HEIGHT) return false;
  if (!hasHeadroom(probeX, topY, probeZ, PLAYER_RADIUS, HEIGHT_STAND, colliders)) return false;

  state.mantleFrom.x = state.pos.x; state.mantleFrom.y = state.pos.y; state.mantleFrom.z = state.pos.z;
  state.mantleTo.x = probeX; state.mantleTo.y = topY; state.mantleTo.z = probeZ;
  state.mantleDuration = rise <= MANTLE_LOW_THRESHOLD ? MANTLE_DURATION_LOW : MANTLE_DURATION;
  state.mantleT = 0;
  state.moveState = MOVE_MANTLE;
  state.stateT = 0;
  state.vel.x = 0; state.vel.y = 0; state.vel.z = 0;
  out.mantleStarted = true;
  return true;
}

function stepMantle(state: PlayerState, dt: number): void {
  state.mantleT += dt;
  const t = clamp01(state.mantleT / Math.max(state.mantleDuration, 1e-4));
  const e = t * t * (3 - 2 * t); // cubic (smoothstep) ease, as specified ("locked cubic path")
  state.pos.x = lerp(state.mantleFrom.x, state.mantleTo.x, e);
  state.pos.y = lerp(state.mantleFrom.y, state.mantleTo.y, e);
  state.pos.z = lerp(state.mantleFrom.z, state.mantleTo.z, e);
  state.stateT += dt;
  if (t >= 1) {
    state.pos.x = state.mantleTo.x; state.pos.y = state.mantleTo.y; state.pos.z = state.mantleTo.z;
    state.onGround = true;
    state.vel.x = 0; state.vel.y = 0; state.vel.z = 0;
    state.moveState = MOVE_IDLE;
    state.stateT = 0;
    state.mantleT = 0;
  }
}

// ---------------------------------------------------------------------------
// Mount: ADS near a chest-height edge locks position and turns strafe input
// into a lean along the edge. Approximate edge detection (see report: real
// geometry validation needs the built compound map + colliders.ts).
// ---------------------------------------------------------------------------
function tryEnterMount(state: PlayerState, colliders: MapColliders): boolean {
  if (!state.onGround || state.stance !== STANCE_STAND) return false;
  const fx = -Math.sin(state.yaw), fz = -Math.cos(state.yaw);
  const chestY = state.pos.y + state.height * 0.55;
  const hit = colliders.raycast(state.pos.x, chestY, state.pos.z, fx, 0, fz, 0.6 /* MOUNT_RANGE */, scratchRayHit);
  if (!hit) return false;

  const beyond = scratchRayHit.dist + 0.15;
  const beyondX = state.pos.x + fx * beyond;
  const beyondZ = state.pos.z + fz * beyond;
  const topY = colliders.groundHeight(beyondX, beyondZ, chestY + MOUNT_EDGE_TOLERANCE + 0.3);
  // Must be roughly chest-height (a low barrier/sill), not open ground continuing
  // at feet level (a step) or a wall far taller than the player.
  if (Math.abs(topY - chestY) > MOUNT_EDGE_TOLERANCE + 0.35) return false;
  if (topY <= state.pos.y + 0.3) return false;

  state.mounted = true;
  state.mountNX = fx;
  state.mountNZ = fz;
  state.mountLean = 0;
  state.moveState = MOVE_MOUNTED;
  state.stateT = 0;
  state.vel.x = 0; state.vel.y = 0; state.vel.z = 0;
  return true;
}

function stepMounted(state: PlayerState, cmd: InputCmd, dt: number, out: MovementEvents): void {
  const targetLean = clamp(cmd.moveX, -1, 1) * MOUNT_LEAN;
  // Critically damped-ish approach (10 /s) rather than an instant snap.
  const rate = Math.min(1, 10 * dt);
  state.mountLean += (targetLean - state.mountLean) * rate;
  state.vel.x = 0; state.vel.y = 0; state.vel.z = 0;
  state.stateT += dt;

  if (!(cmd.buttons & BTN_ADS) && !(cmd.buttons & BTN_MOUNT)) {
    state.mounted = false;
    state.moveState = MOVE_IDLE;
    state.stateT = 0;
    out.mountedChanged = true;
  }
}

// ---------------------------------------------------------------------------
// Grounded / airborne accelerated movement
// ---------------------------------------------------------------------------
function applyGroundOrAirMovement(state: PlayerState, cmd: InputCmd, dt: number): void {
  let lx = clamp(cmd.moveX, -1, 1);
  let ly = clamp(cmd.moveY, -1, 1);
  const rawMag = Math.hypot(lx, ly);
  if (rawMag > 1) { lx /= rawMag; ly /= rawMag; }

  const forwardish = ly > 0.1 && Math.abs(Math.atan2(Math.abs(lx), ly)) <= degToRad(SPRINT_CONE_DEG);
  const sprinting = state.moveState === MOVE_SPRINT || state.moveState === MOVE_TACSPRINT;

  let wishX: number, wishY: number, targetSpeed: number;
  if (sprinting && forwardish) {
    wishX = lx; wishY = ly;
    targetSpeed = state.moveState === MOVE_TACSPRINT ? SPEED_TACSPRINT : SPEED_SPRINT;
  } else {
    wishX = lx * STRAFE_MULT;
    wishY = ly * (ly >= 0 ? 1 : BACK_MULT);
    if (state.stance === STANCE_PRONE) {
      targetSpeed = SPEED_PRONE;
    } else if (state.stance === STANCE_CROUCH) {
      targetSpeed = SPEED_CROUCH * crouchSpeedMult(state);
    } else {
      targetSpeed = SPEED_WALK;
      if (state.adsT > 0) {
        const def = activeDefFor(state);
        targetSpeed = lerp(SPEED_WALK, Math.min(SPEED_WALK, def.adsMoveSpeed), state.adsT);
      }
    }
  }
  if (state.landingT > 0) targetSpeed *= LANDING_SLOW_MULT;

  buildWorldFromLocal(state.yaw, wishX, wishY, scratchWish);
  const wantVelX = scratchWish.x * targetSpeed;
  const wantVelZ = scratchWish.z * targetSpeed;

  const hasInput = wishX !== 0 || wishY !== 0;
  const accel = !state.onGround ? AIR_ACCEL : (hasInput ? GROUND_ACCEL : GROUND_DECEL);

  state.vel.x = moveToward(state.vel.x, wantVelX, accel * dt);
  state.vel.z = moveToward(state.vel.z, wantVelZ, accel * dt);
}

// ---------------------------------------------------------------------------
// Integration: horizontal wall resolve, vertical ground/step/fall, kill plane.
// ---------------------------------------------------------------------------
function resolveWalls(state: PlayerState, colliders: MapColliders): void {
  const r = PLAYER_RADIUS;
  for (let iter = 0; iter < 4; iter++) {
    scratchAabbs.length = 0;
    colliders.query(
      state.pos.x - r - 0.1, state.pos.y, state.pos.z - r - 0.1,
      state.pos.x + r + 0.1, state.pos.y + state.height, state.pos.z + r + 0.1,
      scratchAabbs,
    );
    let moved = false;
    for (let i = 0; i < scratchAabbs.length; i++) {
      const a = scratchAabbs[i]!;
      // Obstacles no taller than STEP_HEIGHT above the current feet are
      // steppable, not walls — leave them to the ground/step-up pass below.
      if (a.maxY <= state.pos.y + STEP_HEIGHT + 1e-3) continue;
      if (capsuleAabbResolve(state.pos.x, state.pos.y, state.pos.z, r, state.height, a, scratchPush)) {
        state.pos.x += scratchPush.x;
        state.pos.z += scratchPush.z;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

function integrateAndCollide(state: PlayerState, colliders: MapColliders, dt: number, out: MovementEvents): void {
  state.pos.x += state.vel.x * dt;
  state.pos.z += state.vel.z * dt;
  resolveWalls(state, colliders);

  if (state.onGround) {
    const probeFrom = state.pos.y + STEP_HEIGHT;
    const groundY = colliders.groundHeight(state.pos.x, state.pos.z, probeFrom);
    if (groundY >= state.pos.y - STEP_HEIGHT - 1e-4 && groundY <= probeFrom + 1e-4) {
      state.pos.y = groundY;
      state.groundMaterial = colliders.materialAt(state.pos.x, groundY, state.pos.z);
      state.onGround = true;
    } else {
      // Walked off a ledge.
      state.onGround = false;
      state.fallStartY = state.pos.y;
      state.vel.y = 0;
    }
  } else {
    const ny = state.pos.y + state.vel.y * dt;
    const groundY = colliders.groundHeight(state.pos.x, state.pos.z, Math.max(state.pos.y, ny) + 0.05);
    if (ny <= groundY) {
      out.landedSpeed = Math.max(0, -state.vel.y);
      const fallDist = state.fallStartY - groundY;
      if (fallDist > FALL_DAMAGE_MIN_HEIGHT) out.fallDamage = (fallDist - FALL_DAMAGE_MIN_HEIGHT) * FALL_DAMAGE_PER_M;
      state.pos.y = groundY;
      state.vel.y = 0;
      state.onGround = true;
      state.landingT = LANDING_SLOW_TIME;
      state.groundMaterial = colliders.materialAt(state.pos.x, groundY, state.pos.z);
    } else {
      state.pos.y = ny;
    }
  }

  if (state.pos.y < colliders.layout.killY) out.fellOut = true;
}

// ---------------------------------------------------------------------------
// Footsteps
// ---------------------------------------------------------------------------
function updateFootsteps(state: PlayerState, dt: number, out: MovementEvents): void {
  if (!state.onGround || state.mounted) { state.footstepDist = 0; return; }
  const speed = Math.hypot(state.vel.x, state.vel.z);
  if (speed < 0.3) return;
  state.footstepDist += speed * dt;
  if (state.footstepDist >= FOOTSTEP_STRIDE) {
    state.footstepDist -= FOOTSTEP_STRIDE;
    out.footstepMaterial = state.groundMaterial;
  }
}

// ---------------------------------------------------------------------------
// ADS blend
// ---------------------------------------------------------------------------
function stepAds(state: PlayerState, cmd: InputCmd, dt: number): void {
  const def = activeDefFor(state);
  const blocked =
    state.moveState === MOVE_SPRINT ||
    state.moveState === MOVE_TACSPRINT ||
    state.moveState === MOVE_MANTLE ||
    (state.moveState === MOVE_SLIDE && state.stateT < SLIDE_ADS_LOCK);
  const wantAds = (cmd.buttons & BTN_ADS) !== 0;
  state.ads = wantAds && !blocked;
  const rate = dt / Math.max(def.adsTime, 1e-4);
  state.adsT = state.ads ? Math.min(1, state.adsT + rate) : Math.max(0, state.adsT - rate);
}

// ---------------------------------------------------------------------------
// Final animation/network moveState classification
// ---------------------------------------------------------------------------
function classifyMoveState(state: PlayerState, dt: number): void {
  const speed = Math.hypot(state.vel.x, state.vel.z);
  let next: number;
  if (!state.onGround) next = MOVE_AIR;
  else if (state.tacT > 0) next = MOVE_TACSPRINT;
  else if (state.sprintT >= SPRINT_START_DELAY) next = MOVE_SPRINT;
  else if (state.stance === STANCE_PRONE) next = speed > 0.2 ? MOVE_PRONE_MOVE : MOVE_IDLE;
  else if (state.stance === STANCE_CROUCH) next = speed > 0.2 ? MOVE_CROUCH_MOVE : MOVE_IDLE;
  else next = speed > 0.2 ? MOVE_WALK : MOVE_IDLE;

  if (next !== state.moveState) {
    state.moveState = next;
    state.stateT = 0;
  } else {
    state.stateT += dt;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export function stepPlayer(state: PlayerState, cmd: InputCmd, colliders: MapColliders, dt: number, out: MovementEvents): void {
  if (!state.alive) {
    state.moveState = MOVE_DEAD;
    return;
  }

  state.yaw = cmd.yaw;
  state.pitch = clamp(cmd.pitch, -HALF_PI, HALF_PI);

  // Mantle: locked camera/position path, nothing else moves.
  if (state.moveState === MOVE_MANTLE) {
    stepMantle(state, dt);
    stepAds(state, cmd, dt);
    return;
  }

  // Mounted: lean-only movement.
  if (state.mounted) {
    stepMounted(state, cmd, dt, out);
    stepAds(state, cmd, dt);
    stepHeight(state, dt);
    return;
  }
  if ((cmd.buttons & BTN_ADS || cmd.buttons & BTN_MOUNT) && tryEnterMount(state, colliders)) {
    out.mountedChanged = true;
    stepAds(state, cmd, dt);
    stepHeight(state, dt);
    return;
  }

  updateStance(state, cmd, colliders, out);
  stepHeight(state, dt);
  updateSprintState(state, cmd, dt);

  const slideConsumedJump = handleSlide(state, cmd, dt, out);
  const sliding = state.moveState === MOVE_SLIDE;

  if (!sliding) {
    applyGroundOrAirMovement(state, cmd, dt);
  }

  if (!slideConsumedJump && !sliding && (cmd.buttons & BTN_JUMP) && state.onGround) {
    if (!tryStartMantle(state, colliders, out)) {
      state.vel.y = JUMP_VELOCITY;
      state.onGround = false;
      state.fallStartY = state.pos.y;
      out.jumped = true;
    }
  }

  // Mantle may have just started this tick — its own branch owns position now.
  if (state.moveState === MOVE_MANTLE) {
    stepAds(state, cmd, dt);
    return;
  }

  if (!state.onGround) {
    state.vel.y = Math.max(state.vel.y - GRAVITY * dt, -TERMINAL_VELOCITY);
  }

  integrateAndCollide(state, colliders, dt, out);
  updateFootsteps(state, dt, out);
  stepAds(state, cmd, dt);

  if (state.moveState !== MOVE_SLIDE) {
    classifyMoveState(state, dt);
  }
}
