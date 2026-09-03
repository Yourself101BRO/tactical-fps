// Grenade/projectile physics and explosion resolution. Pure TypeScript: no
// clocks, no RNG (grenade flight is fully deterministic given inputs), no
// allocation in the hot per-tick path (module-scope scratch is reused).
//
// Division of responsibility with World (shared/sim/world.ts, same author):
// `stepProjectile` only integrates motion and bounces off geometry — it does
// NOT touch `fuse`. World decrements `fuse` itself each tick and calls
// `explode` exactly once when it crosses zero, so the fuse countdown has a
// single owner regardless of how stepProjectile is implemented.

import type { ProjectileState, Vec3 } from '../types.ts';
import type { PlayerState } from '../types.ts';
import type { WorldView } from './types.ts';
import type { RayHit } from '../map/types.ts';
import {
  FLASH_BLIND_TIME,
  FLASH_FADE_TIME,
  FLASH_RADIUS,
  FRAG_DAMAGE_MAX,
  FRAG_DAMAGE_MIN,
  FRAG_FRICTION,
  FRAG_RADIUS,
  FRAG_RADIUS_FULL,
  FRAG_RESTITUTION,
  GRAVITY,
  GRENADE_RADIUS,
  EV_EXPLODE,
  EV_FLASHED,
  KILL_FRAG,
  PROJ_FLASH,
  PROJ_FRAG,
  ZONE_CHEST,
} from '../constants.ts';
import { clamp, lerp, yawPitchToDir } from '../math.ts';
import { explosiveDamageMult } from '../perks.ts';

/** Below this speed (m/s) and resting on a surface, a grenade stops simulating. */
const RESTING_SPEED_EPS = 0.05;
/** Tolerance (m) for "touching the ground" when settling. */
const GROUND_EPS = 0.02;

// Module-scope scratch, reused every call (single-threaded, non-reentrant).
const _rayHit: RayHit = { dist: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, material: 0 };
const _eye: Vec3 = { x: 0, y: 0, z: 0 };
const _forward: Vec3 = { x: 0, y: 0, z: 1 };

/**
 * Integrates one tick of grenade flight: gravity, straight-line motion,
 * single sphere-vs-static-geometry bounce per tick (restitution + a simple
 * velocity-damping friction), and rest detection. `p.fuse` is untouched.
 */
export function stepProjectile(world: WorldView, p: ProjectileState, dt: number): void {
  if (p.resting) return;

  p.vel.y -= GRAVITY * dt;

  const startX = p.pos.x, startY = p.pos.y, startZ = p.pos.z;
  const dx = p.vel.x * dt, dy = p.vel.y * dt, dz = p.vel.z * dt;
  const travelDist = Math.hypot(dx, dy, dz);

  if (travelDist > 1e-8) {
    const dirX = dx / travelDist, dirY = dy / travelDist, dirZ = dz / travelDist;
    const hit = world.colliders.raycast(startX, startY, startZ, dirX, dirY, dirZ, travelDist + GRENADE_RADIUS, _rayHit);
    if (hit && _rayHit.dist <= travelDist + GRENADE_RADIUS) {
      const travel = Math.max(0, _rayHit.dist - GRENADE_RADIUS);
      p.pos.x = startX + dirX * travel;
      p.pos.y = startY + dirY * travel;
      p.pos.z = startZ + dirZ * travel;

      const nx = _rayHit.normal.x, ny = _rayHit.normal.y, nz = _rayHit.normal.z;
      const vn = p.vel.x * nx + p.vel.y * ny + p.vel.z * nz;
      // Reflect the normal component (restitution), damp the whole velocity (friction).
      const rx = p.vel.x - (1 + FRAG_RESTITUTION) * vn * nx;
      const ry = p.vel.y - (1 + FRAG_RESTITUTION) * vn * ny;
      const rz = p.vel.z - (1 + FRAG_RESTITUTION) * vn * nz;
      const frictionMult = Math.max(0, 1 - FRAG_FRICTION * dt);
      p.vel.x = rx * frictionMult;
      p.vel.y = ry * frictionMult;
      p.vel.z = rz * frictionMult;
    } else {
      p.pos.x = startX + dx;
      p.pos.y = startY + dy;
      p.pos.z = startZ + dz;
    }
  }

  const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
  const groundY = world.colliders.groundHeight(p.pos.x, p.pos.z, p.pos.y + GRENADE_RADIUS);
  if (speed < RESTING_SPEED_EPS && p.pos.y - groundY <= GRENADE_RADIUS + GROUND_EPS) {
    p.pos.y = groundY + GRENADE_RADIUS;
    p.vel.x = 0; p.vel.y = 0; p.vel.z = 0;
    p.resting = true;
  }
}

/**
 * How strongly this flash would blind `viewer` right now, given the
 * projectile's current position — 0 when out of range, blocked by geometry,
 * or the viewer is dead. Pure query, no mutation; used by both `explode`
 * (frag/flash resolution) and anything else (bots, client prediction) that
 * wants to reason about flash exposure without waiting for the fuse.
 */
export function flashStrength(world: WorldView, p: ProjectileState, viewer: PlayerState): number {
  if (!viewer.alive) return 0;
  world.eyePos(viewer, _eye);
  const dx = p.pos.x - _eye.x, dy = p.pos.y - _eye.y, dz = p.pos.z - _eye.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist > FLASH_RADIUS) return 0;
  if (!world.hasLineOfSight(p.pos, _eye)) return 0;

  yawPitchToDir(viewer.yaw, viewer.pitch, _forward);
  let viewDot = 0;
  if (dist > 1e-6) viewDot = (_forward.x * dx + _forward.y * dy + _forward.z * dz) / dist;

  return (1 - dist / FLASH_RADIUS) * (0.3 + 0.7 * Math.max(0, viewDot));
}

/** Resolves a frag or flash detonation: damage/blind every player in range with LOS, emits events. */
export function explode(world: WorldView, p: ProjectileState): void {
  if (p.kind === PROJ_FRAG) {
    for (const target of world.players.values()) {
      if (!target.alive) continue;
      world.eyePos(target, _eye);
      const dist = Math.hypot(_eye.x - p.pos.x, _eye.y - p.pos.y, _eye.z - p.pos.z);
      if (dist > FRAG_RADIUS) continue;
      if (!world.hasLineOfSight(p.pos, _eye)) continue;
      const t = clamp((dist - FRAG_RADIUS_FULL) / Math.max(1e-6, FRAG_RADIUS - FRAG_RADIUS_FULL), 0, 1);
      const base = lerp(FRAG_DAMAGE_MAX, FRAG_DAMAGE_MIN, t);
      const dmg = base * explosiveDamageMult(target);
      if (dmg > 0) world.damage(target.id, dmg, p.owner, ZONE_CHEST, KILL_FRAG);
    }
    world.events.push({ type: EV_EXPLODE, pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z }, kind: PROJ_FRAG });
  } else if (p.kind === PROJ_FLASH) {
    for (const target of world.players.values()) {
      if (!target.alive) continue;
      const strength = flashStrength(world, p, target);
      if (strength <= 0) continue;
      target.flashT = (FLASH_BLIND_TIME + FLASH_FADE_TIME) * strength;
      target.flashStrength = strength;
      world.events.push({ type: EV_FLASHED, victim: target.id, strength });
    }
    world.events.push({ type: EV_EXPLODE, pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z }, kind: PROJ_FLASH });
  }
}
