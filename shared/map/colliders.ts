// TEMP STUB for isolated verification of assignment-C files only. Will be deleted.
import type { Aabb, MapColliders, MapLayout, NavGrid, RayHit, SpawnPoint } from './types.ts';
import type { Vec3 } from '../types.ts';
import { rayAabb } from '../math.ts';

export function buildColliders(layout: MapLayout): MapColliders {
  const aabbs: Aabb[] = layout.boxes.map((b) => ({
    minX: b.x, minY: b.y, minZ: b.z,
    maxX: b.x + b.w, maxY: b.y + b.h, maxZ: b.z + b.d,
    material: b.material,
  }));

  return {
    layout,
    aabbs,
    ramps: layout.ramps,
    sites: layout.sites,
    query(minX, minY, minZ, maxX, maxY, maxZ, out) {
      let n = 0;
      for (const a of aabbs) {
        if (a.maxX < minX || a.minX > maxX || a.maxY < minY || a.minY > maxY || a.maxZ < minZ || a.minZ > maxZ) continue;
        out.push(a);
        n++;
      }
      return n;
    },
    raycast(ox, oy, oz, dx, dy, dz, maxDist, out: RayHit) {
      let best = -1;
      let bestBox: Aabb | null = null;
      for (const box of aabbs) {
        const t = rayAabb(ox, oy, oz, dx, dy, dz, box, maxDist);
        if (t >= 0 && (best < 0 || t < best)) { best = t; bestBox = box; }
      }
      if (best < 0 || !bestBox) return false;
      out.dist = best;
      out.point.x = ox + dx * best; out.point.y = oy + dy * best; out.point.z = oz + dz * best;
      // Cheap approximate normal: point away from box centre on the dominant axis.
      const cx = (bestBox.minX + bestBox.maxX) / 2, cy = (bestBox.minY + bestBox.maxY) / 2, cz = (bestBox.minZ + bestBox.maxZ) / 2;
      const ex = out.point.x - cx, ey = out.point.y - cy, ez = out.point.z - cz;
      const ax = Math.abs(ex), ay = Math.abs(ey), az = Math.abs(ez);
      out.normal.x = 0; out.normal.y = 0; out.normal.z = 0;
      if (ax >= ay && ax >= az) out.normal.x = Math.sign(ex) || 1;
      else if (ay >= ax && ay >= az) out.normal.y = Math.sign(ey) || 1;
      else out.normal.z = Math.sign(ez) || 1;
      out.material = bestBox.material;
      return true;
    },
    groundHeight(_x, _z, fromY) {
      // Flat stub ground at y=0.
      return fromY >= 0 ? 0 : fromY;
    },
    materialAt(_x, _y, _z) {
      return layout.groundMaterial;
    },
    spawnsFor(team: number): readonly SpawnPoint[] {
      return layout.spawns.filter((s) => s.team === team || s.team === 0);
    },
    lineOfSight(a: Vec3, b: Vec3) {
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const dist = Math.hypot(dx, dy, dz) || 1e-6;
      const nx = dx / dist, ny = dy / dist, nz = dz / dist;
      for (const box of aabbs) {
        const t = rayAabb(a.x, a.y, a.z, nx, ny, nz, box, dist - 0.01);
        if (t >= 0) return false;
      }
      return true;
    },
  };
}

export function buildNavGrid(layout: MapLayout, _colliders: MapColliders): NavGrid {
  return {
    cellSize: layout.navCellSize,
    cols: 1,
    rows: 1,
    walkable(_x, _z) { return true; },
    findPath(fromX, fromZ, toX, toZ, out) { out.push(fromX, fromZ, toX, toZ); return true; },
    randomPoint(_rng, out) { out.x = 0; out.y = 0; out.z = 0; return out; },
    heightAt(_x, _z) { return 0; },
  };
}
