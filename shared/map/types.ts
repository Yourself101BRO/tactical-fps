// Map data and collision contracts. `layout.ts` declares a MapLayout;
// `colliders.ts` turns it into MapColliders and a NavGrid. Movement, lag
// compensation, bots and the renderer all consume these shapes. Pure data.

import type { Vec3 } from '../types.ts';

/** Axis-aligned box: min corner + size. */
export interface Box {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  /** MAT_* */
  material: number;
  /** Optional label for the renderer (e.g. 'wall', 'floor', 'crate', 'catwalk', 'container'). */
  tag?: string;
  /** Renderer hint: a texture set name (e.g. 'concrete_wall_007'); defaults by material. */
  texture?: string;
}

/**
 * Ramp occupying the box (x,y,z,w,h,d). Its top surface rises from height y at
 * the low edge to y+h at the high edge along `dir`: 0 = +X, 1 = +Z, 2 = -X, 3 = -Z.
 */
export interface Ramp {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  dir: number;
  material: number;
  tag?: string;
}

export interface PropPlacement {
  /** Asset id from the manifest ('Barrel_01', 'ammo_box', ...). */
  prop: string;
  x: number;
  y: number;
  z: number;
  /** Radians. */
  yaw: number;
  scale?: number;
  /** Optional collision box size (centered on x,z, resting on y). Props without one are decoration. */
  collider?: { w: number; h: number; d: number; material: number };
}

export interface SpawnPoint {
  /** TEAM_A, TEAM_B, or TEAM_NONE for FFA-only spawns. */
  team: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface Site {
  /** 0 = A, 1 = B */
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
  radius: number;
}

export interface LightPlacement {
  x: number;
  y: number;
  z: number;
  /** 0xRRGGBB */
  color: number;
  intensity: number;
  range: number;
  /** Optional prop to draw at the light (e.g. 'caged_hanging_light'). */
  fixture?: string;
}

export interface MapLayout {
  id: number;
  name: string;
  /** Playable extents in metres, centred on the origin: x in [-width/2, width/2], z in [-depth/2, depth/2]. */
  width: number;
  depth: number;
  /** Everything the player collides with. Floors are boxes too. */
  boxes: Box[];
  ramps: Ramp[];
  props: PropPlacement[];
  spawns: SpawnPoint[];
  sites: Site[];
  lights: LightPlacement[];
  navCellSize: number;
  /** MAT_* of the ground plane outside any box. */
  groundMaterial: number;
  /** Kill plane: players below this Y die (falling out of the map). */
  killY: number;
}

/** Axis-aligned collision volume used by movement, raycasts and bots. */
export interface Aabb {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  material: number;
}

export interface RayHit {
  dist: number;
  point: Vec3;
  normal: Vec3;
  material: number;
}

export interface MapColliders {
  readonly layout: MapLayout;
  /** All static volumes (boxes, ramp bounding boxes are NOT here — ramps are separate). */
  readonly aabbs: readonly Aabb[];
  readonly ramps: readonly Ramp[];
  readonly sites: readonly Site[];
  /** Broadphase: append every aabb overlapping the query box to `out`, returns the count appended. */
  query(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, out: Aabb[]): number;
  /** Nearest hit along the ray within maxDist, against boxes and ramps. Writes `out`, returns true on hit. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, out: RayHit): boolean;
  /** Height of the highest walkable surface at (x,z) that is at or below `fromY` (+ a small tolerance); ground plane is 0. */
  groundHeight(x: number, z: number, fromY: number): number;
  /** MAT_* of the surface directly under (x, y, z). */
  materialAt(x: number, y: number, z: number): number;
  spawnsFor(team: number): readonly SpawnPoint[];
  /** True if the segment a→b is unobstructed by static geometry. */
  lineOfSight(a: Vec3, b: Vec3): boolean;
}

export interface NavGrid {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  walkable(x: number, z: number): boolean;
  /** World-space A*. Appends waypoints (x, z pairs, flat) to `out`; returns false if unreachable. */
  findPath(fromX: number, fromZ: number, toX: number, toZ: number, out: number[]): boolean;
  /** A random walkable cell centre; `rng` returns [0,1). */
  randomPoint(rng: () => number, out: Vec3): Vec3;
  /** Surface height for a walkable cell (so bots know the Y). */
  heightAt(x: number, z: number): number;
}
