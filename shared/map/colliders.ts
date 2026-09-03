// Turns a declarative MapLayout into the runtime collision (MapColliders) and
// bot navigation (NavGrid) structures. Pure TypeScript, allocation-free hot
// paths (query/raycast/groundHeight/materialAt/findPath reuse scratch state
// captured in each factory's closure instead of allocating per call).

import { HEIGHT_STAND, PLAYER_RADIUS, STEP_HEIGHT } from '../constants.ts';
import { vec3 } from '../types.ts';
import type { Vec3 } from '../types.ts';
import { rayAabb } from '../math.ts';
import type { Aabb, Box, MapColliders, MapLayout, NavGrid, Ramp, RayHit, SpawnPoint } from './types.ts';

const GRID_CELL = 5; // metres; broadphase bucket size for the collider query grid
const GROUND_TOLERANCE = 0.5; // matches the MapColliders.groundHeight contract

// ---------------------------------------------------------------------------
// Shared geometry helpers (used by both buildColliders and buildNavGrid)
// ---------------------------------------------------------------------------

function boxToAabb(b: Box): Aabb {
  return { minX: b.x, minY: b.y, minZ: b.z, maxX: b.x + b.w, maxY: b.y + b.h, maxZ: b.z + b.d, material: b.material };
}

/** Height of a ramp's sloped top at (x,z), or null when (x,z) is outside its footprint. */
function rampTopHeight(r: Ramp, x: number, z: number): number | null {
  if (x < r.x || x > r.x + r.w || z < r.z || z > r.z + r.d) return null;
  switch (r.dir) {
    case 0: return r.y + (r.h * (x - r.x)) / r.w; // rises +X
    case 1: return r.y + (r.h * (z - r.z)) / r.d; // rises +Z
    case 2: return r.y + (r.h * (r.x + r.w - x)) / r.w; // rises -X
    default: return r.y + (r.h * (r.z + r.d - z)) / r.d; // rises -Z
  }
}

/** The ramp's constant top-surface normal (used as an approximation for every hit on it). */
function rampTopNormal(r: Ramp, out: Vec3): Vec3 {
  let nx = 0, nz = 0;
  switch (r.dir) {
    case 0: nx = -r.h / r.w; break;
    case 1: nz = -r.h / r.d; break;
    case 2: nx = r.h / r.w; break;
    default: nz = r.h / r.d; break;
  }
  const len = Math.sqrt(nx * nx + 1 + nz * nz);
  out.x = nx / len; out.y = 1 / len; out.z = nz / len;
  return out;
}

/**
 * Ray vs. a ramp treated as a wedge solid: the XZ footprint intersected with
 * the two half-planes "above the flat base" and "below the sloped top".
 * Returns the entry distance, or -1 when there is no hit within maxDist.
 */
function rayRamp(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: Ramp, maxDist: number): number {
  let t0 = 0, t1 = maxDist;
  if (Math.abs(dx) < 1e-9) {
    if (ox < r.x || ox > r.x + r.w) return -1;
  } else {
    const inv = 1 / dx;
    let a = (r.x - ox) * inv, b = (r.x + r.w - ox) * inv;
    if (a > b) { const t = a; a = b; b = t; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return -1;
  }
  if (Math.abs(dz) < 1e-9) {
    if (oz < r.z || oz > r.z + r.d) return -1;
  } else {
    const inv = 1 / dz;
    let a = (r.z - oz) * inv, b = (r.z + r.d - oz) * inv;
    if (a > b) { const t = a; a = b; b = t; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return -1;
  }
  if (t1 < 0) return -1;

  // Base half-plane: y(t) >= r.y  ⇔  (oy - r.y) + dy*t >= 0
  {
    const a = oy - r.y, b = dy;
    if (b > 1e-9) { const bound = -a / b; if (bound > t0) t0 = bound; }
    else if (b < -1e-9) { const bound = -a / b; if (bound < t1) t1 = bound; }
    else if (a < 0) return -1;
  }
  if (t0 > t1) return -1;

  // Top half-plane: y(t) <= P + Q*t  ⇔  (P - oy) + (Q - dy)*t >= 0
  let P: number, Q: number;
  switch (r.dir) {
    case 0: P = r.y + (r.h * (ox - r.x)) / r.w; Q = (r.h * dx) / r.w; break;
    case 1: P = r.y + (r.h * (oz - r.z)) / r.d; Q = (r.h * dz) / r.d; break;
    case 2: P = r.y + (r.h * (r.x + r.w - ox)) / r.w; Q = -(r.h * dx) / r.w; break;
    default: P = r.y + (r.h * (r.z + r.d - oz)) / r.d; Q = -(r.h * dz) / r.d; break;
  }
  {
    const a = P - oy, b = Q - dy;
    if (b > 1e-9) { const bound = -a / b; if (bound > t0) t0 = bound; }
    else if (b < -1e-9) { const bound = -a / b; if (bound < t1) t1 = bound; }
    else if (a < 0) return -1;
  }
  if (t0 > t1 || t1 < 0) return -1;

  const tHit = t0 >= 0 ? t0 : t1;
  return tHit >= 0 && tHit <= maxDist ? tHit : -1;
}

function boxFaceNormal(box: Aabb, px: number, py: number, pz: number, out: Vec3): Vec3 {
  const eps = 1e-3;
  if (Math.abs(px - box.minX) < eps) { out.x = -1; out.y = 0; out.z = 0; return out; }
  if (Math.abs(px - box.maxX) < eps) { out.x = 1; out.y = 0; out.z = 0; return out; }
  if (Math.abs(py - box.minY) < eps) { out.x = 0; out.y = -1; out.z = 0; return out; }
  if (Math.abs(py - box.maxY) < eps) { out.x = 0; out.y = 1; out.z = 0; return out; }
  if (Math.abs(pz - box.minZ) < eps) { out.x = 0; out.y = 0; out.z = -1; return out; }
  out.x = 0; out.y = 0; out.z = 1; return out;
}

/** Highest surface at (x,z) at-or-below fromY (+tolerance); ground plane (0) is always a candidate. */
function computeSurface(
  aabbs: readonly Aabb[],
  ramps: readonly Ramp[],
  groundMaterial: number,
  x: number,
  z: number,
  fromY: number,
): { height: number; material: number; onRamp: boolean } {
  // -Infinity (not 0) so an actual surface sitting exactly at the implicit
  // ground plane's height (every floor slab in this map does) still wins
  // against the bare fallback and reports its own material.
  let bestHeight = -Infinity;
  let bestMaterial = groundMaterial;
  let onRamp = false;
  for (let i = 0; i < aabbs.length; i++) {
    const a = aabbs[i];
    if (x < a.minX || x > a.maxX || z < a.minZ || z > a.maxZ) continue;
    if (a.maxY > fromY + GROUND_TOLERANCE) continue;
    if (a.maxY >= bestHeight) { bestHeight = a.maxY; bestMaterial = a.material; onRamp = false; }
  }
  for (let i = 0; i < ramps.length; i++) {
    const r = ramps[i];
    const top = rampTopHeight(r, x, z);
    if (top === null || top > fromY + GROUND_TOLERANCE) continue;
    if (top >= bestHeight) { bestHeight = top; bestMaterial = r.material; onRamp = true; }
  }
  if (bestHeight === -Infinity) { bestHeight = 0; bestMaterial = groundMaterial; }
  return { height: bestHeight, material: bestMaterial, onRamp };
}

/** True if a 0.7 m wide, HEIGHT_STAND tall capsule standing on y0 has clear headroom at (x,z). */
function capsuleFits(aabbs: readonly Aabb[], x: number, z: number, y0: number): boolean {
  const r = PLAYER_RADIUS;
  const yLo = y0 + 0.05; // skip the supporting floor/ramp surface itself
  const yHi = y0 + HEIGHT_STAND;
  const minX = x - r, maxX = x + r, minZ = z - r, maxZ = z + r;
  for (let i = 0; i < aabbs.length; i++) {
    const a = aabbs[i];
    if (a.maxY <= yLo || a.minY >= yHi) continue;
    if (a.maxX <= minX || a.minX >= maxX) continue;
    if (a.maxZ <= minZ || a.minZ >= maxZ) continue;
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// buildColliders
// ---------------------------------------------------------------------------
export function buildColliders(layout: MapLayout): MapColliders {
  const aabbs: Aabb[] = layout.boxes.map(boxToAabb);
  // Prop colliders (crates, barrels, ...) block movement and shots too.
  for (const p of layout.props) {
    if (!p.collider) continue;
    const hw = p.collider.w / 2, hd = p.collider.d / 2;
    aabbs.push({
      minX: p.x - hw, maxX: p.x + hw,
      minY: p.y, maxY: p.y + p.collider.h,
      minZ: p.z - hd, maxZ: p.z + hd,
      material: p.collider.material,
    });
  }
  const ramps = layout.ramps;
  const sites = layout.sites;

  // Uniform-grid broadphase over X,Z (map geometry is shallow; a single Y
  // band is plenty since candidate lists stay small even unfiltered by Y).
  const gMinX = -layout.width / 2 - 2, gMaxX = layout.width / 2 + 2;
  const gMinZ = -layout.depth / 2 - 2, gMaxZ = layout.depth / 2 + 2;
  const cols = Math.max(1, Math.ceil((gMaxX - gMinX) / GRID_CELL));
  const rows = Math.max(1, Math.ceil((gMaxZ - gMinZ) / GRID_CELL));
  const buckets: number[][] = new Array(cols * rows);
  for (let i = 0; i < buckets.length; i++) buckets[i] = [];
  const cellXOf = (x: number): number => Math.min(cols - 1, Math.max(0, Math.floor((x - gMinX) / GRID_CELL)));
  const cellZOf = (z: number): number => Math.min(rows - 1, Math.max(0, Math.floor((z - gMinZ) / GRID_CELL)));
  for (let i = 0; i < aabbs.length; i++) {
    const a = aabbs[i];
    const cx0 = cellXOf(a.minX), cx1 = cellXOf(a.maxX);
    const cz0 = cellZOf(a.minZ), cz1 = cellZOf(a.maxZ);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) buckets[cz * cols + cx].push(i);
    }
  }

  // Dedupe candidates across cells without allocating a Set: a monotonic
  // stamp per query marks each aabb index visited at most once.
  const visitedStamp = new Int32Array(aabbs.length);
  let queryStamp = 0;

  function query(qMinX: number, qMinY: number, qMinZ: number, qMaxX: number, qMaxY: number, qMaxZ: number, out: Aabb[]): number {
    queryStamp++;
    let count = 0;
    const cx0 = cellXOf(qMinX), cx1 = cellXOf(qMaxX);
    const cz0 = cellZOf(qMinZ), cz1 = cellZOf(qMaxZ);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const bucket = buckets[cz * cols + cx];
        for (let k = 0; k < bucket.length; k++) {
          const i = bucket[k];
          if (visitedStamp[i] === queryStamp) continue;
          visitedStamp[i] = queryStamp;
          const a = aabbs[i];
          if (a.maxX < qMinX || a.minX > qMaxX) continue;
          if (a.maxY < qMinY || a.minY > qMaxY) continue;
          if (a.maxZ < qMinZ || a.minZ > qMaxZ) continue;
          out.push(a);
          count++;
        }
      }
    }
    return count;
  }

  // Scratch state reused by raycast/lineOfSight so they never allocate.
  const rayCandidates: Aabb[] = [];
  const hitPoint = vec3();
  const hitNormal = vec3();

  function raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, out: RayHit): boolean {
    rayCandidates.length = 0;
    const ex = ox + dx * maxDist, ey = oy + dy * maxDist, ez = oz + dz * maxDist;
    query(
      Math.min(ox, ex) - 0.01, Math.min(oy, ey) - 0.01, Math.min(oz, ez) - 0.01,
      Math.max(ox, ex) + 0.01, Math.max(oy, ey) + 0.01, Math.max(oz, ez) + 0.01,
      rayCandidates,
    );

    let bestT = maxDist;
    let bestBox: Aabb | null = null;
    let bestRamp: Ramp | null = null;
    let hit = false;

    for (let i = 0; i < rayCandidates.length; i++) {
      const box = rayCandidates[i];
      const t = rayAabb(ox, oy, oz, dx, dy, dz, box, bestT);
      if (t >= 0 && t <= bestT) { bestT = t; bestBox = box; bestRamp = null; hit = true; }
    }
    for (let i = 0; i < ramps.length; i++) {
      const r = ramps[i];
      const t = rayRamp(ox, oy, oz, dx, dy, dz, r, bestT);
      if (t >= 0 && t <= bestT) { bestT = t; bestRamp = r; bestBox = null; hit = true; }
    }
    if (!hit) return false;

    hitPoint.x = ox + dx * bestT; hitPoint.y = oy + dy * bestT; hitPoint.z = oz + dz * bestT;
    if (bestRamp) {
      rampTopNormal(bestRamp, hitNormal);
      out.material = bestRamp.material;
    } else if (bestBox) {
      boxFaceNormal(bestBox, hitPoint.x, hitPoint.y, hitPoint.z, hitNormal);
      out.material = bestBox.material;
    }
    out.dist = bestT;
    out.point.x = hitPoint.x; out.point.y = hitPoint.y; out.point.z = hitPoint.z;
    out.normal.x = hitNormal.x; out.normal.y = hitNormal.y; out.normal.z = hitNormal.z;
    return true;
  }

  function groundHeight(x: number, z: number, fromY: number): number {
    return computeSurface(aabbs, ramps, layout.groundMaterial, x, z, fromY).height;
  }

  function materialAt(x: number, y: number, z: number): number {
    return computeSurface(aabbs, ramps, layout.groundMaterial, x, z, y).material;
  }

  function spawnsFor(team: number): readonly SpawnPoint[] {
    return layout.spawns.filter((s) => s.team === team);
  }

  const losHit: RayHit = { dist: 0, point: vec3(), normal: vec3(), material: 0 };
  function lineOfSight(a: Vec3, b: Vec3): boolean {
    let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-6) return true;
    dx /= dist; dy /= dist; dz /= dist;
    // Pull the far end in slightly so grazing the target's own surface doesn't self-block.
    return !raycast(a.x, a.y, a.z, dx, dy, dz, dist - 0.05, losHit);
  }

  return { layout, aabbs, ramps, sites, query, raycast, groundHeight, materialAt, spawnsFor, lineOfSight };
}

// ---------------------------------------------------------------------------
// buildNavGrid
// ---------------------------------------------------------------------------
const NEIGHBOURS: readonly [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

export function buildNavGrid(layout: MapLayout, colliders: MapColliders): NavGrid {
  const cellSize = layout.navCellSize;
  const cols = Math.max(1, Math.round(layout.width / cellSize));
  const rows = Math.max(1, Math.round(layout.depth / cellSize));
  const originX = -layout.width / 2;
  const originZ = -layout.depth / 2;
  const { aabbs, ramps } = colliders;
  const groundMaterial = layout.groundMaterial;

  const cellCenterX = (i: number): number => originX + (i + 0.5) * cellSize;
  const cellCenterZ = (j: number): number => originZ + (j + 0.5) * cellSize;
  const idx = (i: number, j: number): number => j * cols + i;

  const heights = new Float32Array(cols * rows);
  const walkableFlags = new Uint8Array(cols * rows);
  const onRampFlags = new Uint8Array(cols * rows);

  // -------------------------------------------------------------------------
  // Flood fill (BFS) outward from known-good seeds (spawns and sites),
  // propagating each cell's walking height from the neighbour that reached
  // it. This lets one 2D grid double as the ground floor AND the elevated
  // catwalk: a column under the catwalk resolves to ground height (reached
  // in one hop from the open warehouse floor), while the catwalk's own
  // height is only reachable by climbing the stair ramps, whose continuous
  // slope is exempted from the per-step height check.
  // -------------------------------------------------------------------------
  const queueI = new Int32Array(cols * rows);
  const queueJ = new Int32Array(cols * rows);
  let qTail = 0;
  const visited = new Uint8Array(cols * rows);

  function trySeed(x: number, z: number, y: number): void {
    const i = Math.floor((x - originX) / cellSize);
    const j = Math.floor((z - originZ) / cellSize);
    if (i < 0 || i >= cols || j < 0 || j >= rows) return;
    const id = idx(i, j);
    if (visited[id]) return;
    const cx = cellCenterX(i), cz = cellCenterZ(j);
    if (!capsuleFits(aabbs, cx, cz, y)) return;
    const surf = computeSurface(aabbs, ramps, groundMaterial, cx, cz, y + 0.5);
    visited[id] = 1;
    walkableFlags[id] = 1;
    heights[id] = surf.height;
    onRampFlags[id] = surf.onRamp ? 1 : 0;
    queueI[qTail] = i; queueJ[qTail] = j; qTail++;
  }

  for (const s of layout.spawns) trySeed(s.x, s.z, s.y);
  for (const site of layout.sites) trySeed(site.x, site.z, site.y);

  let qHead = 0;
  while (qHead < qTail) {
    const i = queueI[qHead], j = queueJ[qHead]; qHead++;
    const id = idx(i, j);
    const h = heights[id];
    const ramp = onRampFlags[id] === 1;
    for (const [di, dj] of NEIGHBOURS) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
      const nid = idx(ni, nj);
      if (visited[nid]) continue;
      visited[nid] = 1;
      const cx = cellCenterX(ni), cz = cellCenterZ(nj);
      if (!capsuleFits(aabbs, cx, cz, h)) continue;
      const surf = computeSurface(aabbs, ramps, groundMaterial, cx, cz, h + 0.5);
      const delta = Math.abs(surf.height - h);
      // A continuous ramp slope isn't a "step" even when its per-cell rise
      // exceeds STEP_HEIGHT; a genuine discontinuity (a curb, a ledge) is.
      if (delta > STEP_HEIGHT && !ramp && !surf.onRamp) continue;
      walkableFlags[nid] = 1;
      heights[nid] = surf.height;
      onRampFlags[nid] = surf.onRamp ? 1 : 0;
      queueI[qTail] = ni; queueJ[qTail] = nj; qTail++;
    }
  }

  const walkableList: number[] = [];
  for (let id = 0; id < cols * rows; id++) if (walkableFlags[id]) walkableList.push(id);

  function cellIndexAt(x: number, z: number): number {
    const i = Math.floor((x - originX) / cellSize);
    const j = Math.floor((z - originZ) / cellSize);
    if (i < 0 || i >= cols || j < 0 || j >= rows) return -1;
    return idx(i, j);
  }

  function nearestWalkable(x: number, z: number): number {
    const direct = cellIndexAt(x, z);
    if (direct >= 0 && walkableFlags[direct]) return direct;
    const ci = Math.floor((x - originX) / cellSize);
    const cj = Math.floor((z - originZ) / cellSize);
    for (let radius = 1; radius <= 6; radius++) {
      for (let dj = -radius; dj <= radius; dj++) {
        for (let di = -radius; di <= radius; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== radius) continue;
          const ni = ci + di, nj = cj + dj;
          if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
          const nid = idx(ni, nj);
          if (walkableFlags[nid]) return nid;
        }
      }
    }
    return -1;
  }

  // -------------------------------------------------------------------------
  // A*: typed-array scratch state is allocated once here and reused by every
  // findPath call; only the small backtracked waypoint list allocates.
  // -------------------------------------------------------------------------
  const gScore = new Float32Array(cols * rows);
  const fScore = new Float32Array(cols * rows);
  const cameFrom = new Int32Array(cols * rows);
  const openFlag = new Uint8Array(cols * rows);
  const closedFlag = new Uint8Array(cols * rows);
  const touchedStamp = new Int32Array(cols * rows);
  let searchStamp = 0;
  const heap = new Int32Array(cols * rows);
  let heapSize = 0;

  function heapPush(id: number): void {
    let i = heapSize++;
    heap[i] = id;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (fScore[heap[parent]] <= fScore[heap[i]]) break;
      const tmp = heap[parent]; heap[parent] = heap[i]; heap[i] = tmp;
      i = parent;
    }
  }
  function heapPop(): number {
    const top = heap[0];
    heapSize--;
    heap[0] = heap[heapSize];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = i * 2 + 2;
      let smallest = i;
      if (l < heapSize && fScore[heap[l]] < fScore[heap[smallest]]) smallest = l;
      if (r < heapSize && fScore[heap[r]] < fScore[heap[smallest]]) smallest = r;
      if (smallest === i) break;
      const tmp = heap[smallest]; heap[smallest] = heap[i]; heap[i] = tmp;
      i = smallest;
    }
    return top;
  }
  function heuristic(id: number, goalI: number, goalJ: number): number {
    const i = id % cols, j = (id / cols) | 0;
    const di = Math.abs(i - goalI), dj = Math.abs(j - goalJ);
    return (Math.min(di, dj) * Math.SQRT2 + Math.abs(di - dj)) * cellSize;
  }

  function findPath(fromX: number, fromZ: number, toX: number, toZ: number, out: number[]): boolean {
    const startId = nearestWalkable(fromX, fromZ);
    const goalId = nearestWalkable(toX, toZ);
    if (startId < 0 || goalId < 0) return false;
    if (startId === goalId) {
      out.push(cellCenterX(startId % cols), cellCenterZ((startId / cols) | 0));
      return true;
    }

    searchStamp++;
    heapSize = 0;
    const goalI = goalId % cols, goalJ = (goalId / cols) | 0;
    touchedStamp[startId] = searchStamp;
    gScore[startId] = 0;
    fScore[startId] = heuristic(startId, goalI, goalJ);
    openFlag[startId] = 1;
    closedFlag[startId] = 0;
    heapPush(startId);

    let found = false;
    while (heapSize > 0) {
      const current = heapPop();
      if (!openFlag[current]) continue; // stale duplicate heap entry
      openFlag[current] = 0;
      if (current === goalId) { found = true; break; }
      closedFlag[current] = 1;

      const ci = current % cols, cj = (current / cols) | 0;
      for (const [di, dj] of NEIGHBOURS) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
        const nid = idx(ni, nj);
        if (!walkableFlags[nid]) continue;
        if (di !== 0 && dj !== 0) {
          // Corner cutting forbidden: both orthogonal neighbours must be walkable too.
          if (!walkableFlags[idx(ci + di, cj)] || !walkableFlags[idx(ci, cj + dj)]) continue;
        }
        if (touchedStamp[nid] !== searchStamp) {
          touchedStamp[nid] = searchStamp;
          gScore[nid] = Infinity;
          openFlag[nid] = 0;
          closedFlag[nid] = 0;
        }
        if (closedFlag[nid]) continue;
        const stepCost = (di !== 0 && dj !== 0) ? Math.SQRT2 : 1;
        const heightPenalty = Math.abs(heights[nid] - heights[current]) * 0.5;
        const tentativeG = gScore[current] + stepCost * cellSize + heightPenalty;
        if (tentativeG < gScore[nid]) {
          gScore[nid] = tentativeG;
          cameFrom[nid] = current;
          fScore[nid] = tentativeG + heuristic(nid, goalI, goalJ);
          openFlag[nid] = 1;
          heapPush(nid);
        }
      }
    }

    if (!found) return false;
    const path: number[] = [];
    let node = goalId;
    while (node !== startId) {
      path.push(node);
      node = cameFrom[node];
    }
    path.push(startId);
    for (let k = path.length - 1; k >= 0; k--) {
      const id = path[k];
      out.push(cellCenterX(id % cols), cellCenterZ((id / cols) | 0));
    }
    return true;
  }

  function walkable(x: number, z: number): boolean {
    const id = cellIndexAt(x, z);
    return id >= 0 && walkableFlags[id] === 1;
  }

  function randomPoint(rng: () => number, out: Vec3): Vec3 {
    if (walkableList.length === 0) { out.x = 0; out.y = 0; out.z = 0; return out; }
    const id = walkableList[Math.floor(rng() * walkableList.length) % walkableList.length];
    out.x = cellCenterX(id % cols);
    out.z = cellCenterZ((id / cols) | 0);
    out.y = heights[id];
    return out;
  }

  function heightAt(x: number, z: number): number {
    const id = cellIndexAt(x, z);
    if (id >= 0 && walkableFlags[id]) return heights[id];
    return colliders.groundHeight(x, z, 0);
  }

  return { cellSize, cols, rows, walkable, findPath, randomPoint, heightAt };
}
