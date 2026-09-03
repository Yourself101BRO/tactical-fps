// "Compound" map (§6 of the design plan): a 90 x 70 m playable area split into
// north/south spawn yards and three parallel lanes — West Alley (a long
// sniper sightline dressed with sandbag nests), Central Warehouse (two
// floors joined by a 3.5 m catwalk reached by stairs at both ends, with an
// office that is Site A), and East Yard (shipping containers, jersey
// barriers and a fuel depot that is Site B) — joined by cross-connectors
// north and south of the warehouse plus the warehouse interior itself.
//
// Declarative data only: boxes, ramps, props, spawns, sites and lights. Pure
// TypeScript, no DOM/three.js/clock, so colliders.ts and the renderer can
// both consume it deterministically.

import {
  MAP_COMPOUND,
  MAT_ASPHALT,
  MAT_BRICK,
  MAT_CONCRETE,
  MAT_GRAVEL,
  MAT_METAL,
  MAT_PLASTER,
  MAT_SAND,
  MAT_WOOD,
  SND_SITE_RADIUS,
  TEAM_A,
  TEAM_B,
  TEAM_NONE,
} from '../constants.ts';
import type { Box, LightPlacement, MapLayout, PropPlacement, Ramp, Site, SpawnPoint } from './types.ts';

// ---------------------------------------------------------------------------
// Perimeter walls (6 m high, ringing the whole 90 x 70 m rectangle)
// ---------------------------------------------------------------------------
const PERIMETER_WALLS: Box[] = [
  { x: -45, y: 0, z: 34, w: 90, h: 6, d: 1, material: MAT_CONCRETE, tag: 'wall', texture: 'concrete_block_wall' },
  { x: -45, y: 0, z: -35, w: 90, h: 6, d: 1, material: MAT_CONCRETE, tag: 'wall', texture: 'concrete_block_wall' },
  { x: -45, y: 0, z: -35, w: 1, h: 6, d: 70, material: MAT_CONCRETE, tag: 'wall', texture: 'concrete_block_wall' },
  { x: 44, y: 0, z: -35, w: 1, h: 6, d: 70, material: MAT_CONCRETE, tag: 'wall', texture: 'concrete_block_wall' },
];

// ---------------------------------------------------------------------------
// Floor slabs, one per zone, so materialAt reads correctly per §6. Every slab
// top sits exactly at y = 0 so groundHeight's "ground plane is 0" fallback is
// visually and physically consistent whether or not a slab is present.
// ---------------------------------------------------------------------------
const FLOORS: Box[] = [
  { x: -45, y: -0.2, z: -35, w: 90, h: 0.2, d: 10, material: MAT_ASPHALT, tag: 'floor', texture: 'asphalt_02' }, // south spawn yard
  { x: -45, y: -0.2, z: 25, w: 90, h: 0.2, d: 10, material: MAT_ASPHALT, tag: 'floor', texture: 'asphalt_02' }, // north spawn yard
  { x: -45, y: -0.2, z: -25, w: 25, h: 0.2, d: 50, material: MAT_GRAVEL, tag: 'floor', texture: 'sandy_gravel_02' }, // West Alley
  { x: -12, y: -0.2, z: -20, w: 24, h: 0.2, d: 40, material: MAT_CONCRETE, tag: 'floor', texture: 'concrete_floor_01' }, // Central Warehouse
  { x: 18, y: -0.2, z: -25, w: 27, h: 0.2, d: 50, material: MAT_ASPHALT, tag: 'floor', texture: 'asphalt_02' }, // East Yard
  { x: -20, y: -0.2, z: -25, w: 38, h: 0.2, d: 5, material: MAT_CONCRETE, tag: 'floor', texture: 'concrete_floor_01' }, // south cross-connector
  { x: -20, y: -0.2, z: 20, w: 38, h: 0.2, d: 5, material: MAT_CONCRETE, tag: 'floor', texture: 'concrete_floor_01' }, // north cross-connector
];

// ---------------------------------------------------------------------------
// West Alley: sandbag nests off the centreline so a ~55 m sightline down the
// alley's spine stays open, each gap >= 1 m from walls and neighbours so a
// 0.7 m capsule always fits through.
// ---------------------------------------------------------------------------
const ALLEY_SANDBAGS: Box[] = [
  { x: -42, y: 0, z: -18, w: 2.4, h: 1.2, d: 1.2, material: MAT_SAND, tag: 'sandbag', texture: 'sandbag' },
  { x: -25.5, y: 0, z: -10, w: 1.2, h: 1.2, d: 2.4, material: MAT_SAND, tag: 'sandbag', texture: 'sandbag' },
  { x: -42, y: 0, z: -2, w: 2.4, h: 1.2, d: 1.2, material: MAT_SAND, tag: 'sandbag', texture: 'sandbag' },
  { x: -25.5, y: 0, z: 6, w: 1.2, h: 1.2, d: 2.4, material: MAT_SAND, tag: 'sandbag', texture: 'sandbag' },
  { x: -42, y: 0, z: 14, w: 2.4, h: 1.2, d: 1.2, material: MAT_SAND, tag: 'sandbag', texture: 'sandbag' },
  { x: -25.5, y: 0, z: 18, w: 1.2, h: 1.2, d: 2.4, material: MAT_SAND, tag: 'sandbag', texture: 'sandbag' },
];

// ---------------------------------------------------------------------------
// Central Warehouse: corrugated-metal shell x[-12,12] z[-20,20], 7.5 m tall.
// North and south walls each carry a 3 m stairwell gap (x[-1.5,1.5]) that
// lines up with the stair ramps; east and west walls each carry a 6 m door
// gap (z[-3,3]) into the alley / east yard.
// ---------------------------------------------------------------------------
const WAREHOUSE_SHELL: Box[] = [
  // south wall, split around the stairwell
  { x: -12, y: 0, z: -20, w: 10.5, h: 7.5, d: 1, material: MAT_METAL, tag: 'wall', texture: 'corrugated_iron_02' },
  { x: 1.5, y: 0, z: -20, w: 10.5, h: 7.5, d: 1, material: MAT_METAL, tag: 'wall', texture: 'corrugated_iron_02' },
  // north wall, split around the stairwell
  { x: -12, y: 0, z: 19, w: 10.5, h: 7.5, d: 1, material: MAT_METAL, tag: 'wall', texture: 'corrugated_iron_02' },
  { x: 1.5, y: 0, z: 19, w: 10.5, h: 7.5, d: 1, material: MAT_METAL, tag: 'wall', texture: 'corrugated_iron_02' },
  // west wall, split around the alley door
  { x: -13, y: 0, z: -20, w: 1, h: 7.5, d: 17, material: MAT_METAL, tag: 'wall', texture: 'corrugated_iron_02' },
  { x: -13, y: 0, z: 3, w: 1, h: 7.5, d: 17, material: MAT_METAL, tag: 'wall', texture: 'corrugated_iron_02' },
  // east wall, split around the yard door
  { x: 12, y: 0, z: -20, w: 1, h: 7.5, d: 17, material: MAT_METAL, tag: 'wall', texture: 'corrugated_iron_02' },
  { x: 12, y: 0, z: 3, w: 1, h: 7.5, d: 17, material: MAT_METAL, tag: 'wall', texture: 'corrugated_iron_02' },
  // roof (also caps the office below it)
  { x: -12, y: 7.5, z: -20, w: 24, h: 0.3, d: 40, material: MAT_METAL, tag: 'roof', texture: 'corrugated_iron_02' },
];

// Catwalk deck (top exactly y = 3.5, matching the stair ramps' high edge) and
// its two rails, which double as mount-height barriers (1.1-1.3 m).
const CATWALK: Box[] = [
  { x: -1.5, y: 3.3, z: -13, w: 3, h: 0.2, d: 26, material: MAT_METAL, tag: 'catwalk', texture: 'metal_plate' },
  { x: -1.6, y: 3.5, z: -13, w: 0.1, h: 1.2, d: 26, material: MAT_METAL, tag: 'barrier', texture: 'metal_plate' },
  { x: 1.5, y: 3.5, z: -13, w: 0.1, h: 1.2, d: 26, material: MAT_METAL, tag: 'barrier', texture: 'metal_plate' },
];

// Stairs at both ends of the warehouse, each a 6 m run rising the full 3.5 m
// through the wall's stairwell gap onto the catwalk.
const WAREHOUSE_STAIRS: Ramp[] = [
  { x: -1.5, y: 0, z: -19, w: 3, h: 3.5, d: 6, dir: 1, material: MAT_METAL, tag: 'stairs' }, // south: rises +Z
  { x: -1.5, y: 0, z: 13, w: 3, h: 3.5, d: 6, dir: 3, material: MAT_METAL, tag: 'stairs' }, // north: rises -Z
];

// Office (Site A) in the warehouse's north-east corner: brick outer wall,
// plastered inner partition, a 2.4 m door gap facing the warehouse floor.
const OFFICE_WALLS: Box[] = [
  { x: 4, y: 0, z: 11.8, w: 2.6, h: 3, d: 0.4, material: MAT_BRICK, tag: 'wall', texture: 'brick_wall_02' },
  { x: 9, y: 0, z: 11.8, w: 3, h: 3, d: 0.4, material: MAT_BRICK, tag: 'wall', texture: 'brick_wall_02' },
  { x: 3.8, y: 0, z: 12, w: 0.4, h: 3, d: 7, material: MAT_PLASTER, tag: 'wall', texture: 'plastered_wall_02' },
];

// ---------------------------------------------------------------------------
// East Yard: containers and jersey barriers for cover, a light fuel-depot
// structure around Site B.
// ---------------------------------------------------------------------------
const YARD_STRUCTURES: Box[] = [
  { x: 22, y: 0, z: -16, w: 6, h: 2.6, d: 2.5, material: MAT_METAL, tag: 'container', texture: 'rusty_metal_02' },
  { x: 30, y: 0, z: -6, w: 2.5, h: 2.6, d: 6, material: MAT_METAL, tag: 'container', texture: 'rusty_metal_02' },
  { x: 22, y: 0, z: 7, w: 6, h: 2.6, d: 2.5, material: MAT_METAL, tag: 'container', texture: 'rusty_metal_02' },
  { x: 36, y: 0, z: 14, w: 2.5, h: 2.6, d: 6, material: MAT_METAL, tag: 'container', texture: 'rusty_metal_02' },
  { x: 26, y: 0, z: -21, w: 3, h: 1.2, d: 0.5, material: MAT_CONCRETE, tag: 'barrier', texture: 'concrete_wall_007' },
  { x: 34, y: 0, z: 2, w: 0.5, h: 1.2, d: 3, material: MAT_CONCRETE, tag: 'barrier', texture: 'concrete_wall_007' },
  { x: 24, y: 0, z: 19, w: 3, h: 1.2, d: 0.5, material: MAT_CONCRETE, tag: 'barrier', texture: 'concrete_wall_007' },
  { x: 41, y: 0, z: -9, w: 0.5, h: 1.2, d: 3, material: MAT_CONCRETE, tag: 'barrier', texture: 'concrete_wall_007' },
  // fuel depot pump-house (Site B), an L-shaped wall for cover, not a full room
  { x: 37.8, y: 0, z: -3, w: 0.4, h: 2.4, d: 6, material: MAT_METAL, tag: 'wall', texture: 'painted_metal_shutter' },
  { x: 38, y: 0, z: -3.2, w: 5, h: 2.4, d: 0.4, material: MAT_METAL, tag: 'wall', texture: 'painted_metal_shutter' },
];

// ---------------------------------------------------------------------------
// Props (from the asset manifest) for dressing and low cover.
// ---------------------------------------------------------------------------
const PROPS: PropPlacement[] = [
  { prop: 'Barrel_01', x: -38, y: 0, z: -8, yaw: 0, collider: { w: 0.6, h: 0.9, d: 0.6, material: MAT_METAL } },
  { prop: 'Barrel_02', x: -38, y: 0, z: 10, yaw: 0.5, collider: { w: 0.6, h: 0.9, d: 0.6, material: MAT_METAL } },
  { prop: 'Barrel_01', x: 8, y: 0, z: -3, yaw: 1.1, collider: { w: 0.6, h: 0.9, d: 0.6, material: MAT_METAL } },
  { prop: 'Barrel_02', x: -8, y: 0, z: 8, yaw: 0.2, collider: { w: 0.6, h: 0.9, d: 0.6, material: MAT_METAL } },
  { prop: 'Barrel_01', x: 28, y: 0, z: -2, yaw: 0.7, collider: { w: 0.6, h: 0.9, d: 0.6, material: MAT_METAL } },
  { prop: 'Barrel_02', x: 36, y: 0, z: -14.5, yaw: 0, collider: { w: 0.6, h: 0.9, d: 0.6, material: MAT_METAL } },
  { prop: 'cardboard_box_01', x: -30, y: 0, z: -5, yaw: 0, collider: { w: 0.8, h: 1.0, d: 0.8, material: MAT_WOOD } },
  { prop: 'cardboard_box_01', x: 10, y: 0, z: -15, yaw: 0.3, collider: { w: 0.8, h: 1.0, d: 0.8, material: MAT_WOOD } },
  { prop: 'cement_bag', x: 30, y: 0, z: 18, yaw: 0, collider: { w: 1.0, h: 1.2, d: 0.6, material: MAT_CONCRETE } },
  { prop: 'cement_bag', x: -28, y: 0, z: 15, yaw: 0.4, collider: { w: 1.0, h: 1.2, d: 0.6, material: MAT_CONCRETE } },
  { prop: 'ammo_box', x: 8.8, y: 0, z: 15.5, yaw: 0, collider: { w: 0.5, h: 0.5, d: 0.4, material: MAT_METAL } },
  { prop: 'ammo_box', x: 40.8, y: 0, z: -0.5, yaw: 0.6, collider: { w: 0.5, h: 0.5, d: 0.4, material: MAT_METAL } },
];

// ---------------------------------------------------------------------------
// Interior/exterior lights (caged_hanging_light fixtures inside the warehouse
// and office, plain fixtures for the alley and yard).
// ---------------------------------------------------------------------------
const LIGHTS: LightPlacement[] = [
  { x: -6, y: 7, z: -10, color: 0xfff2cc, intensity: 1.2, range: 12, fixture: 'caged_hanging_light' },
  { x: 6, y: 7, z: 10, color: 0xfff2cc, intensity: 1.2, range: 12, fixture: 'caged_hanging_light' },
  { x: 8, y: 3, z: 15.5, color: 0xfff2cc, intensity: 1.0, range: 8, fixture: 'caged_hanging_light' },
  { x: -32, y: 4, z: 0, color: 0xffe9c2, intensity: 0.9, range: 10 },
  { x: 30, y: 4, z: 0, color: 0xffe9c2, intensity: 0.9, range: 10 },
];

// ---------------------------------------------------------------------------
// Spawns: 6 per team in the south (A) / north (B) yards, plus 12 FFA spawns
// spread across every lane and both warehouse levels.
// ---------------------------------------------------------------------------
const TEAM_SPAWN_XS = [-35, -21, -7, 7, 21, 35];

const SPAWNS: SpawnPoint[] = [
  ...TEAM_SPAWN_XS.map((x): SpawnPoint => ({ team: TEAM_A, x, y: 0, z: -30, yaw: Math.PI })), // faces +Z, into the map
  ...TEAM_SPAWN_XS.map((x): SpawnPoint => ({ team: TEAM_B, x, y: 0, z: 30, yaw: 0 })), // faces -Z, into the map
  // West Alley
  { team: TEAM_NONE, x: -32, y: 0, z: -22, yaw: 1.57 },
  { team: TEAM_NONE, x: -32, y: 0, z: 0, yaw: 4.71 },
  { team: TEAM_NONE, x: -32, y: 0, z: 22, yaw: 1.57 },
  // Central Warehouse ground floor
  { team: TEAM_NONE, x: 6, y: 0, z: -10, yaw: 0.8 },
  { team: TEAM_NONE, x: -6, y: 0, z: 0, yaw: 2.4 },
  { team: TEAM_NONE, x: 6, y: 0, z: 5, yaw: 3.9 },
  { team: TEAM_NONE, x: -6, y: 0, z: -16, yaw: 5.5 },
  // Catwalk
  { team: TEAM_NONE, x: 0, y: 3.5, z: -5, yaw: 0 },
  // East Yard
  { team: TEAM_NONE, x: 24, y: 0, z: -2, yaw: 3.14 },
  { team: TEAM_NONE, x: 33, y: 0, z: 10, yaw: 2.0 },
  { team: TEAM_NONE, x: 24, y: 0, z: 22, yaw: 4.5 },
  { team: TEAM_NONE, x: 41, y: 0, z: 5, yaw: 3.5 },
];

const SITES: Site[] = [
  { id: 0, name: 'Warehouse Office', x: 8, y: 0, z: 15.5, radius: SND_SITE_RADIUS },
  { id: 1, name: 'Fuel Depot', x: 40, y: 0, z: 0, radius: SND_SITE_RADIUS },
];

export const MAP_COMPOUND_LAYOUT: MapLayout = {
  id: MAP_COMPOUND,
  name: 'Compound',
  width: 90,
  depth: 70,
  boxes: [
    ...PERIMETER_WALLS,
    ...FLOORS,
    ...ALLEY_SANDBAGS,
    ...WAREHOUSE_SHELL,
    ...CATWALK,
    ...OFFICE_WALLS,
    ...YARD_STRUCTURES,
  ],
  ramps: WAREHOUSE_STAIRS,
  props: PROPS,
  spawns: SPAWNS,
  sites: SITES,
  lights: LIGHTS,
  navCellSize: 1,
  groundMaterial: MAT_ASPHALT,
  killY: -20,
};

const LAYOUTS_BY_ID = new Map<number, MapLayout>([[MAP_COMPOUND_LAYOUT.id, MAP_COMPOUND_LAYOUT]]);

/** Looks up a map layout by id; falls back to Compound for unknown ids. */
export function getMapLayout(id: number): MapLayout {
  return LAYOUTS_BY_ID.get(id) ?? MAP_COMPOUND_LAYOUT;
}
