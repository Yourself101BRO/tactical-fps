// Allocation-free math shared by the simulation, prediction and lag
// compensation. Every function either returns a primitive or writes into an
// `out` parameter supplied by the caller — nothing here allocates on a hot
// path. Deterministic: no Date.now(), no Math.random() (use mulberry32).

import type { Vec3 } from './types.ts';
import type { Aabb } from './map/types.ts';

const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI / 2;

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Exponential smoothing toward `b` at rate `lambda` (1/s), frame-rate independent. */
export function damp(a: number, b: number, lambda: number, dt: number): number {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

/** Move `current` toward `target` by at most `maxDelta`, without overshoot. */
export function moveToward(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (diff > -maxDelta && diff < maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Wrap an angle (radians) into (-PI, PI]. */
export function wrapAngle(a: number): number {
  let w = (a + Math.PI) % TWO_PI;
  if (w < 0) w += TWO_PI;
  return w - Math.PI;
}

/** Shortest-path lerp between two angles (radians), t in [0,1]. */
export function angleLerp(a: number, b: number, t: number): number {
  const diff = wrapAngle(b - a);
  return a + diff * t;
}

// ---------------------------------------------------------------------------
// RNG — deterministic, seeded. Never use Math.random() in shared/.
// ---------------------------------------------------------------------------
/** mulberry32: fast, well-distributed 32-bit PRNG. Returns a closure yielding [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function mulberry32Next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Vec3 — every function writes into `out` (which may alias `a`/`b`) and
// returns it, so call sites can chain without allocating.
// ---------------------------------------------------------------------------
export function vset(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x; out.y = y; out.z = z;
  return out;
}

export function vcopy(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x; out.y = a.y; out.z = a.z;
  return out;
}

export function vadd(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x + b.x; out.y = a.y + b.y; out.z = a.z + b.z;
  return out;
}

export function vsub(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x - b.x; out.y = a.y - b.y; out.z = a.z - b.z;
  return out;
}

export function vscale(out: Vec3, a: Vec3, s: number): Vec3 {
  out.x = a.x * s; out.y = a.y * s; out.z = a.z * s;
  return out;
}

/** out = a + b * s */
export function vaddScaled(out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  out.x = a.x + b.x * s; out.y = a.y + b.y * s; out.z = a.z + b.z * s;
  return out;
}

export function vdot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vcross(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x; out.y = y; out.z = z;
  return out;
}

export function vlen(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function vlenSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function vnormalize(out: Vec3, a: Vec3): Vec3 {
  const len = vlen(a);
  if (len < 1e-9) { out.x = 0; out.y = 0; out.z = 0; return out; }
  const inv = 1 / len;
  out.x = a.x * inv; out.y = a.y * inv; out.z = a.z * inv;
  return out;
}

export function vdist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function vlerp(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

/**
 * World-space look direction from yaw/pitch. Yaw 0 faces -Z; increasing yaw
 * turns left (three.js convention, rotation about +Y). Pitch positive is up.
 */
export function yawPitchToDir(yaw: number, pitch: number, out: Vec3): Vec3 {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

// ---------------------------------------------------------------------------
// Raycasts
// ---------------------------------------------------------------------------
/** Slab-method ray/AABB test. Returns the entry t in [0, maxDist], or -1. */
export function rayAabb(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  box: Aabb, maxDist: number,
): number {
  let tMin = 0;
  let tMax = maxDist;

  // X slab
  if (Math.abs(dx) < 1e-12) {
    if (ox < box.minX || ox > box.maxX) return -1;
  } else {
    const inv = 1 / dx;
    let t1 = (box.minX - ox) * inv;
    let t2 = (box.maxX - ox) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return -1;
  }
  // Y slab
  if (Math.abs(dy) < 1e-12) {
    if (oy < box.minY || oy > box.maxY) return -1;
  } else {
    const inv = 1 / dy;
    let t1 = (box.minY - oy) * inv;
    let t2 = (box.maxY - oy) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return -1;
  }
  // Z slab
  if (Math.abs(dz) < 1e-12) {
    if (oz < box.minZ || oz > box.maxZ) return -1;
  } else {
    const inv = 1 / dz;
    let t1 = (box.minZ - oz) * inv;
    let t2 = (box.maxZ - oz) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return -1;
  }
  if (tMin < 0) {
    // Origin is inside the box: report the exit-side clamp only if tMax within range.
    return tMax >= 0 && tMax <= maxDist ? 0 : -1;
  }
  return tMin <= maxDist ? tMin : -1;
}

/** Ray/sphere test. Returns the nearest positive hit t in [0, maxDist], or -1. */
export function raySphere(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  cx: number, cy: number, cz: number, r: number, maxDist: number,
): number {
  const lx = ox - cx, ly = oy - cy, lz = oz - cz;
  // Assumes (dx,dy,dz) is unit length, per the shared ray convention.
  const b = lx * dx + ly * dy + lz * dz;
  const c = lx * lx + ly * ly + lz * lz - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq;
  if (t < 0 || t > maxDist) return -1;
  return t;
}

/**
 * Ray/capsule test (segment a→b, radius r): the capsule is a cylinder with
 * hemispherical caps. Returns the nearest positive hit t in [0, maxDist], or -1.
 */
export function rayCapsule(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  r: number, maxDist: number,
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const abLenSq = abx * abx + aby * aby + abz * abz;
  if (abLenSq < 1e-12) return raySphere(ox, oy, oz, dx, dy, dz, ax, ay, az, r, maxDist);

  const aox = ox - ax, aoy = oy - ay, aoz = oz - az;
  // Project ray direction and origin offset onto the plane perpendicular to the segment axis.
  const abDotD = abx * dx + aby * dy + abz * dz;
  const abDotAo = abx * aox + aby * aoy + abz * aoz;
  const invAbLenSq = 1 / abLenSq;

  const pdx = dx - abx * abDotD * invAbLenSq;
  const pdy = dy - aby * abDotD * invAbLenSq;
  const pdz = dz - abz * abDotD * invAbLenSq;
  const pox = aox - abx * abDotAo * invAbLenSq;
  const poy = aoy - aby * abDotAo * invAbLenSq;
  const poz = aoz - abz * abDotAo * invAbLenSq;

  const a = pdx * pdx + pdy * pdy + pdz * pdz;
  const b = 2 * (pdx * pox + pdy * poy + pdz * poz);
  const c = pox * pox + poy * poy + poz * poz - r * r;

  let tCyl = -1;
  if (a > 1e-12) {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      let t = (-b - sq) / (2 * a);
      if (t < 0) t = (-b + sq) / (2 * a);
      if (t >= 0 && t <= maxDist) {
        // Confirm the hit lies between the two caps (on the finite cylinder).
        const hx = ox + dx * t - ax, hy = oy + dy * t - ay, hz = oz + dz * t - az;
        const proj = (hx * abx + hy * aby + hz * abz) * invAbLenSq;
        if (proj >= 0 && proj <= 1) tCyl = t;
      }
    }
  }

  const tCapA = raySphere(ox, oy, oz, dx, dy, dz, ax, ay, az, r, maxDist);
  const tCapB = raySphere(ox, oy, oz, dx, dy, dz, bx, by, bz, r, maxDist);

  let best = -1;
  for (const t of [tCyl, tCapA, tCapB]) {
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Capsule (vertical cylinder, radius-only in XZ) vs AABB resolution — used by
// shared/movement.ts to keep the player capsule from penetrating world geometry.
// ---------------------------------------------------------------------------
/**
 * If the vertical capsule at (px,pz) with feet at `feetY`, `radius` and
 * `height` overlaps `box`, writes the minimal horizontal push-out into
 * `out` (out.y is always 0) and returns true. Returns false with `out`
 * untouched when there is no overlap.
 */
export function capsuleAabbResolve(
  px: number, feetY: number, pz: number,
  radius: number, height: number,
  box: Aabb, out: Vec3,
): boolean {
  const top = feetY + height;
  // Vertical separation: no horizontal push against floors we stand on or
  // ceilings entirely above/below the capsule.
  if (top <= box.minY + 1e-4 || feetY >= box.maxY - 1e-4) return false;

  const cx = clamp(px, box.minX, box.maxX);
  const cz = clamp(pz, box.minZ, box.maxZ);
  const dx = px - cx;
  const dz = pz - cz;
  const distSq = dx * dx + dz * dz;
  if (distSq >= radius * radius) return false;

  if (distSq > 1e-10) {
    const dist = Math.sqrt(distSq);
    const pen = radius - dist;
    out.x = (dx / dist) * pen;
    out.z = (dz / dist) * pen;
  } else {
    // Center is inside the box's footprint: push out along the shallower axis.
    const penXNeg = px - box.minX, penXPos = box.maxX - px;
    const penZNeg = pz - box.minZ, penZPos = box.maxZ - pz;
    const minX = Math.min(penXNeg, penXPos);
    const minZ = Math.min(penZNeg, penZPos);
    if (minX < minZ) {
      out.x = penXNeg < penXPos ? -(penXNeg + radius) : (penXPos + radius);
      out.z = 0;
    } else {
      out.x = 0;
      out.z = penZNeg < penZPos ? -(penZNeg + radius) : (penZPos + radius);
    }
  }
  out.y = 0;
  return true;
}

// Re-exported for callers that want the raw constant without importing constants.ts.
export const PI2 = TWO_PI;
export const HALF_PI_CONST = HALF_PI;
