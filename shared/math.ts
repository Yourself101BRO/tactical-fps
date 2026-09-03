// TEMP STUB for isolated verification of assignment-C files only. Will be deleted.
import type { Vec3 } from './types.ts';
import type { Aabb } from './map/types.ts';

export function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
export function damp(a: number, b: number, lambda: number, dt: number): number { return a + (b - a) * (1 - Math.exp(-lambda * dt)); }
export function wrapAngle(a: number): number { const tp = Math.PI * 2; let x = a % tp; if (x < 0) x += tp; return x; }
export function angleLerp(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function vset(out: Vec3, x: number, y: number, z: number): Vec3 { out.x = x; out.y = y; out.z = z; return out; }
export function vcopy(out: Vec3, a: Vec3): Vec3 { out.x = a.x; out.y = a.y; out.z = a.z; return out; }
export function vadd(out: Vec3, a: Vec3, b: Vec3): Vec3 { out.x = a.x + b.x; out.y = a.y + b.y; out.z = a.z + b.z; return out; }
export function vsub(out: Vec3, a: Vec3, b: Vec3): Vec3 { out.x = a.x - b.x; out.y = a.y - b.y; out.z = a.z - b.z; return out; }
export function vscale(out: Vec3, a: Vec3, s: number): Vec3 { out.x = a.x * s; out.y = a.y * s; out.z = a.z * s; return out; }
export function vaddScaled(out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 { out.x = a.x + b.x * s; out.y = a.y + b.y * s; out.z = a.z + b.z * s; return out; }
export function vdot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
export function vcross(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
  out.x = x; out.y = y; out.z = z; return out;
}
export function vlen(a: Vec3): number { return Math.hypot(a.x, a.y, a.z); }
export function vlenSq(a: Vec3): number { return a.x * a.x + a.y * a.y + a.z * a.z; }
export function vnormalize(out: Vec3, a: Vec3): Vec3 {
  const l = vlen(a) || 1;
  out.x = a.x / l; out.y = a.y / l; out.z = a.z / l; return out;
}
export function vdist(a: Vec3, b: Vec3): number { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
export function vlerp(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  out.x = a.x + (b.x - a.x) * t; out.y = a.y + (b.y - a.y) * t; out.z = a.z + (b.z - a.z) * t; return out;
}

export function yawPitchToDir(yaw: number, pitch: number, out: Vec3): Vec3 {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

export function rayAabb(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, box: Aabb, maxDist: number): number {
  let tmin = 0, tmax = maxDist;
  const orig = [ox, oy, oz], dir = [dx, dy, dz];
  const lo = [box.minX, box.minY, box.minZ], hi = [box.maxX, box.maxY, box.maxZ];
  for (let i = 0; i < 3; i++) {
    const o = orig[i]!, d = dir[i]!;
    if (Math.abs(d) < 1e-12) {
      if (o < lo[i]! || o > hi[i]!) return -1;
    } else {
      let t1 = (lo[i]! - o) / d, t2 = (hi[i]! - o) / d;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }
  }
  return tmin >= 0 && tmin <= maxDist ? tmin : -1;
}

export function raySphere(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cy: number, cz: number, r: number, maxDist: number): number {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  const r2 = r * r;
  if (d2 > r2) return -1;
  const thc = Math.sqrt(r2 - d2);
  let t0 = tca - thc;
  const t1 = tca + thc;
  if (t0 < 0) t0 = t1;
  if (t0 < 0 || t0 > maxDist) return -1;
  return t0;
}

export function rayCapsule(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  ax: number, ay: number, az: number, bx: number, by: number, bz: number,
  r: number, maxDist: number,
): number {
  // Coarse but adequate for a smoke test: sample along the ray and find the
  // nearest point where the distance to segment AB drops below r.
  const steps = 400;
  const step = maxDist / steps;
  for (let i = 0; i <= steps; i++) {
    const t = i * step;
    const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
    // distance from p to segment ab
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const abLenSq = abx * abx + aby * aby + abz * abz || 1e-9;
    let u = (apx * abx + apy * aby + apz * abz) / abLenSq;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const cx = ax + abx * u, cy = ay + aby * u, cz = az + abz * u;
    const d = Math.hypot(px - cx, py - cy, pz - cz);
    if (d <= r) return t;
  }
  return -1;
}
