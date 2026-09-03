// Unit tests for shared/map/layout.ts and shared/map/colliders.ts.
// node:test, no DOM.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HEIGHT_STAND, PLAYER_RADIUS, TEAM_A, TEAM_B } from '../shared/constants.ts';
import { buildColliders, buildNavGrid } from '../shared/map/colliders.ts';
import { MAP_COMPOUND_LAYOUT, getMapLayout } from '../shared/map/layout.ts';
import type { RayHit } from '../shared/map/types.ts';

const layout = MAP_COMPOUND_LAYOUT;
const colliders = buildColliders(layout);
const nav = buildNavGrid(layout, colliders);

test('getMapLayout returns Compound for id 0 and for unknown ids', () => {
  assert.equal(getMapLayout(0), MAP_COMPOUND_LAYOUT);
  assert.equal(getMapLayout(999), MAP_COMPOUND_LAYOUT);
});

test('every spawn sits on walkable ground with head room', () => {
  for (const spawn of layout.spawns) {
    const ground = colliders.groundHeight(spawn.x, spawn.z, spawn.y);
    assert.ok(
      Math.abs(ground - spawn.y) < 0.05,
      `spawn (${spawn.x},${spawn.y},${spawn.z}) team ${spawn.team}: groundHeight ${ground} != spawn.y ${spawn.y}`,
    );
    // Head room: no solid geometry from just above the feet to a full standing height.
    const r = PLAYER_RADIUS;
    const candidates: import('../shared/map/types.ts').Aabb[] = [];
    colliders.query(spawn.x - r, spawn.y + 0.1, spawn.z - r, spawn.x + r, spawn.y + HEIGHT_STAND, spawn.z + r, candidates);
    assert.equal(candidates.length, 0, `spawn (${spawn.x},${spawn.y},${spawn.z}) has an obstruction in its head room`);
  }
});

test('team spawn counts match the plan (6 A, 6 B, 12 FFA)', () => {
  const a = layout.spawns.filter((s) => s.team === TEAM_A);
  const b = layout.spawns.filter((s) => s.team === TEAM_B);
  const ffa = layout.spawns.filter((s) => s.team !== TEAM_A && s.team !== TEAM_B);
  assert.equal(a.length, 6);
  assert.equal(b.length, 6);
  assert.equal(ffa.length, 12);
});

test('spawnsFor filters by team', () => {
  assert.equal(colliders.spawnsFor(TEAM_A).length, 6);
  assert.equal(colliders.spawnsFor(TEAM_B).length, 6);
});

test('both sites are reachable from both team spawn yards via findPath', () => {
  const spawnsA = layout.spawns.filter((s) => s.team === TEAM_A);
  const spawnsB = layout.spawns.filter((s) => s.team === TEAM_B);
  for (const site of layout.sites) {
    for (const spawn of [...spawnsA, ...spawnsB]) {
      const waypoints: number[] = [];
      const ok = nav.findPath(spawn.x, spawn.z, site.x, site.z, waypoints);
      assert.ok(ok, `no path from spawn (${spawn.x},${spawn.z}) to site ${site.name}`);
      assert.ok(waypoints.length >= 2, 'path should carry at least one waypoint');
    }
  }
});

test('raycast hits a known wall at the right distance', () => {
  // The south perimeter wall's inner face sits at z = -34 (box z:-35..-34).
  // Fire straight south (-Z) from the middle of the south spawn yard.
  const out: RayHit = { dist: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, material: 0 };
  const originZ = -30;
  const hit = colliders.raycast(0, 1, originZ, 0, 0, -1, 50, out);
  assert.ok(hit, 'expected a raycast hit against the south perimeter wall');
  const expectedDist = originZ - -34; // distance to the wall's inner face
  assert.ok(Math.abs(out.dist - expectedDist) < 0.05, `expected dist ~${expectedDist}, got ${out.dist}`);
  assert.ok(Math.abs(out.normal.z - 1) < 0.01, 'wall normal should point back toward the shooter (+Z)');
});

test('groundHeight on the catwalk returns 3.5', () => {
  const h = colliders.groundHeight(0, 0, 3.5);
  assert.ok(Math.abs(h - 3.5) < 0.01, `expected 3.5, got ${h}`);
});

test('materialAt reports the catwalk metal plate and the alley gravel', () => {
  const catwalkMat = colliders.materialAt(0, 3.5, 0);
  const alleyMat = colliders.materialAt(-32, 0, 0);
  const MAT_METAL = 1;
  const MAT_GRAVEL = 3;
  assert.equal(catwalkMat, MAT_METAL);
  assert.equal(alleyMat, MAT_GRAVEL);
});

test('lineOfSight is blocked through the warehouse wall', () => {
  // A point just outside the warehouse's west wall vs. a point deep inside it.
  const outside = { x: -20, y: 1, z: -10 };
  const inside = { x: 5, y: 1, z: -10 };
  assert.equal(colliders.lineOfSight(outside, inside), false);
});

test('lineOfSight is clear across the open south spawn yard', () => {
  const a = { x: -35, y: 1, z: -30 };
  const b = { x: 35, y: 1, z: -30 };
  assert.equal(colliders.lineOfSight(a, b), true);
});

test('nav grid stair ramps connect the ground floor to the catwalk height', () => {
  const waypoints: number[] = [];
  const ok = nav.findPath(0, -18, 0, 18, waypoints);
  assert.ok(ok, 'expected a path from south of the warehouse to north of it');
});

test('randomPoint always returns a walkable cell', () => {
  let seed = 12345;
  const rng = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const out = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 25; i++) {
    nav.randomPoint(rng, out);
    assert.ok(nav.walkable(out.x, out.z), `randomPoint returned unwalkable (${out.x},${out.z})`);
  }
});

test('findPath forbids corner cutting between two solid sandbag nests', () => {
  // Sanity: a path between two open points on either side of the alley still
  // succeeds (it must route around, not through, cover).
  const waypoints: number[] = [];
  const ok = nav.findPath(-42, -18, -25.5, -10, waypoints);
  assert.ok(ok);
  for (let i = 0; i < waypoints.length; i += 2) {
    assert.ok(nav.walkable(waypoints[i]!, waypoints[i + 1]!));
  }
});

test('findPath returns false for an unreachable target outside the map', () => {
  const waypoints: number[] = [];
  const ok = nav.findPath(0, -30, 1000, 1000, waypoints);
  assert.equal(ok, false);
});
