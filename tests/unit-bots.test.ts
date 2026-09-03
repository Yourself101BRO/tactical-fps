// Unit tests for shared/sim/bots.ts. Fake WorldView/ModeRules/NavGrid/
// MapColliders implementations, no real map or Room needed. node:test, no DOM.
//
// NOTE for the integrator: at the time this file was written, shared/math.ts,
// shared/movement.ts and shared/weapons.ts (owned by other W1 agents) did not
// exist yet, so `node --test tests/unit-bots.test.ts` could not actually be
// executed here — only reasoned through against the documented cross-module
// signatures. Please run it once those land; see the report's "verification"
// section for what to check if anything fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { BotBrain, botName } from '../shared/sim/bots.ts';
import type { ModeRules, WorldView } from '../shared/sim/types.ts';
import type { MapColliders, NavGrid, RayHit, Site } from '../shared/map/types.ts';
import { createPlayerState, vec3 } from '../shared/types.ts';
import type { PlayerState, Vec3 } from '../shared/types.ts';
import {
  BOT_RECRUIT,
  BOT_VETERAN,
  BOMB_NONE,
  BTN_ADS,
  BTN_FIRE,
  BTN_RELOAD,
  HEALTH_MAX,
  INTERP_TICKS,
  MODE_SND,
  MODE_TDM,
  SLOT_PRIMARY,
  SLOT_SECONDARY,
  TEAM_A,
  TEAM_B,
  WEAPON_AR,
  WEAPON_PISTOL,
} from '../shared/constants.ts';

// ---------------------------------------------------------------------------
// Minimal fakes
// ---------------------------------------------------------------------------
function makeSite(id: number, x: number, z: number): Site {
  return { id, name: `site-${id}`, x, y: 0, z, radius: 3 };
}

function makeColliders(sites: Site[] = []): MapColliders {
  return {
    layout: {
      id: 0,
      name: 'test',
      width: 100,
      depth: 100,
      boxes: [],
      ramps: [],
      props: [],
      spawns: [],
      sites,
      lights: [],
      navCellSize: 1,
      groundMaterial: 0,
      killY: -50,
    },
    aabbs: [],
    ramps: [],
    sites,
    query: () => 0,
    raycast: (_ox, _oy, _oz, _dx, _dy, _dz, _maxDist, _out: RayHit) => false,
    groundHeight: () => 0,
    materialAt: () => 0,
    spawnsFor: () => [],
    lineOfSight: () => true,
  };
}

/** A NavGrid whose findPath always returns a single waypoint at (toX, toZ). */
function makeNav(): NavGrid {
  return {
    cellSize: 1,
    cols: 10,
    rows: 10,
    walkable: () => true,
    findPath: (_fromX, _fromZ, toX, toZ, out) => {
      out.push(toX, toZ);
      return true;
    },
    randomPoint: (_rng, out) => {
      out.x = 30;
      out.y = 0;
      out.z = 0;
      return out;
    },
    heightAt: () => 0,
  };
}

interface FakeWorldOptions {
  players: PlayerState[];
  sites?: Site[];
  frozen?: boolean;
  losBlocked?: boolean;
  tick?: number;
}

function makeWorld(opts: FakeWorldOptions): WorldView {
  const players = new Map<number, PlayerState>();
  for (const p of opts.players) players.set(p.id, p);
  const colliders = makeColliders(opts.sites ?? []);
  const nav = makeNav();
  const world: WorldView = {
    tick: opts.tick ?? 0,
    colliders,
    nav,
    players,
    projectiles: [],
    events: [],
    rng: () => 0.5,
    frozen: opts.frozen ?? false,
    // Assigned below once `rules` exists (WorldView.rules is settable).
    rules: undefined as unknown as ModeRules,
    respawn: () => {},
    damage: () => {},
    kill: () => {},
    hasLineOfSight: () => !opts.losBlocked,
    eyePos: (p: PlayerState, out: Vec3) => {
      out.x = p.pos.x;
      out.y = p.pos.y + 1.6;
      out.z = p.pos.z;
      return out;
    },
    spawnProjectile: (kind, owner, team, pos) => ({
      id: 1,
      kind,
      owner,
      team,
      pos: vec3(pos.x, pos.y, pos.z),
      vel: vec3(),
      fuse: 0,
      resting: false,
    }),
  };
  return world;
}

function makeRules(mode: number): ModeRules {
  return {
    mode,
    teamBased: true,
    phase: 3,
    timeLeft: 60,
    scores: [0, 0],
    round: 1,
    roundsWon: [0, 0],
    bomb: { state: BOMB_NONE, site: -1, timer: 0, carrier: 0, pos: vec3() },
    winnerTeam: 0,
    winnerId: 0,
    start: () => {},
    tick: () => {},
    onKill: () => {},
    onPlayerJoin: () => {},
    onPlayerLeave: () => {},
    canRespawn: () => true,
    pickSpawn: () => ({ x: 0, y: 0, z: 0, yaw: 0 }),
    interact: () => {},
    isEnemy: (a, b) => a.team !== b.team && a.team !== 0 && b.team !== 0,
    assignTeam: () => TEAM_A,
    result: () => ({ winnerTeam: 0, winnerId: 0, players: [] }),
    finished: false,
  };
}

function makeSelf(id: number, team: number, x = 0, z = 0): PlayerState {
  const p = createPlayerState(id, `bot${id}`, team, true);
  p.alive = true;
  p.pos.x = x;
  p.pos.z = z;
  p.slots[SLOT_PRIMARY] = { weapon: WEAPON_AR, mag: 30, reserve: 120 };
  p.slots[SLOT_SECONDARY] = { weapon: WEAPON_PISTOL, mag: 15, reserve: 60 };
  return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('botName cycles through the 12 named list', () => {
  assert.equal(botName(0), 'Ghost');
  assert.equal(botName(11), 'Rook');
  assert.equal(botName(12), 'Ghost'); // wraps
});

test('cmd.tick = tick + INTERP_TICKS on every call', () => {
  const self = makeSelf(1, TEAM_A);
  const world = makeWorld({ players: [self] });
  const rules = makeRules(MODE_TDM);
  world.rules = rules;
  const brain = new BotBrain(1, BOT_RECRUIT, 42);

  const cmd = brain.think(world, rules, 100);
  assert.equal(cmd.tick, 100 + INTERP_TICKS);

  const cmd2 = brain.think(world, rules, 101);
  assert.equal(cmd2.tick, 101 + INTERP_TICKS);
  assert.equal(cmd2.seq, cmd.seq + 1);
});

test('never fires (or moves) while world.frozen', () => {
  const self = makeSelf(1, TEAM_A, 0, 0);
  const enemy = makeSelf(2, TEAM_B, 5, 0);
  const world = makeWorld({ players: [self, enemy], frozen: true });
  const rules = makeRules(MODE_TDM);
  world.rules = rules;
  const brain = new BotBrain(1, BOT_VETERAN, 7);

  for (let tick = 0; tick < 30; tick++) {
    const cmd = brain.think(world, rules, tick);
    assert.equal(cmd.buttons & BTN_FIRE, 0, `tick ${tick} fired while frozen`);
    assert.equal(cmd.moveX, 0);
    assert.equal(cmd.moveY, 0);
  }
});

test('roams toward its waypoint: moveY > 0 and yaw turns toward it', () => {
  const self = makeSelf(1, TEAM_A, 0, 0);
  const world = makeWorld({ players: [self] }); // no enemies -> pure roam
  const rules = makeRules(MODE_TDM);
  world.rules = rules;
  const brain = new BotBrain(1, BOT_VETERAN, 3); // fast turn rate so yaw converges quickly

  const cmd1 = brain.think(world, rules, 0);
  assert.ok(cmd1.moveY > 0, 'bot should move forward toward its waypoint');

  // The fake nav always offers a waypoint at (30, 0) -> due "north" in the
  // yaw convention (0 faces -Z). After several ticks at Veteran turn rate
  // (720 deg/s == 12 deg/tick) the bot should have turned substantially away
  // from its initial yaw of 0 toward that point.
  let cmd = cmd1;
  for (let tick = 1; tick < 20; tick++) {
    cmd = brain.think(world, rules, tick);
  }
  assert.notEqual(cmd.yaw, 0, 'yaw should have turned away from its initial heading');
});

test('engages a visible enemy: fires after the reaction delay, ADS beyond 15 m', () => {
  const self = makeSelf(1, TEAM_A, 0, 0);
  const enemy = makeSelf(2, TEAM_B, 20, 0); // 20 m away, beyond BOT_ADS_RANGE (15 m)
  const world = makeWorld({ players: [self, enemy] });
  const rules = makeRules(MODE_TDM);
  world.rules = rules;
  const brain = new BotBrain(1, BOT_VETERAN, 11); // 250 ms reaction = 15 ticks at 60 Hz

  let firedTick = -1;
  for (let tick = 0; tick < 30; tick++) {
    const cmd = brain.think(world, rules, tick);
    assert.notEqual(cmd.buttons & BTN_ADS, 0, `tick ${tick}: should be ADS beyond 15 m`);
    if (cmd.buttons & BTN_FIRE) {
      firedTick = tick;
      break;
    }
  }
  assert.ok(firedTick >= 0, 'bot never fired at a visible enemy');
  // Veteran reaction delay is 250 ms == 15 ticks at 60 Hz; allow a little
  // slack for rounding, but it must not fire immediately on acquisition.
  assert.ok(firedTick >= 10, `fired too early (tick ${firedTick}), reaction delay not respected`);
});

test('reloads when the primary mag is empty and safe (no target)', () => {
  const self = makeSelf(1, TEAM_A, 0, 0);
  self.slots[SLOT_PRIMARY] = { weapon: WEAPON_AR, mag: 0, reserve: 90 };
  const world = makeWorld({ players: [self] }); // no enemies -> "safe"
  const rules = makeRules(MODE_TDM);
  world.rules = rules;
  const brain = new BotBrain(1, BOT_RECRUIT, 5);

  const cmd = brain.think(world, rules, 0);
  assert.equal(cmd.weaponSlot, SLOT_PRIMARY);
  assert.notEqual(cmd.buttons & BTN_RELOAD, 0, 'should press reload on an empty, safe primary');
});

test('switches to the sidearm when the primary is empty under fire', () => {
  const self = makeSelf(1, TEAM_A, 0, 0);
  self.slots[SLOT_PRIMARY] = { weapon: WEAPON_AR, mag: 0, reserve: 90 };
  const enemy = makeSelf(2, TEAM_B, 10, 0);
  const world = makeWorld({ players: [self, enemy] });
  const rules = makeRules(MODE_TDM);
  world.rules = rules;
  const brain = new BotBrain(1, BOT_RECRUIT, 5);

  const cmd = brain.think(world, rules, 0);
  assert.equal(cmd.weaponSlot, SLOT_SECONDARY, 'should swap to the pistol rather than reload under fire');
});

test('health below 40% triggers crouch while engaging', () => {
  const self = makeSelf(1, TEAM_A, 0, 0);
  self.health = 0.3 * HEALTH_MAX;
  const enemy = makeSelf(2, TEAM_B, 10, 0);
  const world = makeWorld({ players: [self, enemy] });
  const rules = makeRules(MODE_TDM);
  world.rules = rules;
  const brain = new BotBrain(1, BOT_RECRUIT, 9);

  const cmd = brain.think(world, rules, 0);
  const BTN_CROUCH = 1 << 1;
  assert.notEqual(cmd.buttons & BTN_CROUCH, 0);
});

test('S&D: the bomb carrier plants once inside the site radius with no enemy visible', () => {
  const site = makeSite(0, 10, 10);
  const self = makeSelf(1, TEAM_A, 10, 10); // already standing on the site
  const world = makeWorld({ players: [self], sites: [site] });
  const rules = makeRules(MODE_SND);
  rules.bomb = { state: BOMB_NONE, site: -1, timer: 0, carrier: 1, pos: vec3(10, 0, 10) };
  world.rules = rules;
  const brain = new BotBrain(1, BOT_RECRUIT, 1);
  // Force the attacker's chosen site deterministically via repeated ticks;
  // the fake rng always seeds the same mulberry32 sequence.
  const cmd = brain.think(world, rules, 0);
  const BTN_INTERACT = 1 << 11;
  assert.notEqual(cmd.buttons & BTN_INTERACT, 0, 'carrier should plant when on-site with no enemy visible');
  assert.equal(cmd.moveX, 0);
  assert.equal(cmd.moveY, 0);
});

// ---------------------------------------------------------------------------
// Optional: run a longer soak against the real map if the map modules exist
// yet (they are owned by another agent and may not be present at review time).
// ---------------------------------------------------------------------------
test('12 bots think for 600 ticks on the real map without throwing (skipped until map/colliders exist)', async (t) => {
  const layoutPath = new URL('../shared/map/layout.ts', import.meta.url);
  const collidersPath = new URL('../shared/map/colliders.ts', import.meta.url);
  if (!existsSync(layoutPath) || !existsSync(collidersPath)) {
    t.skip('shared/map/layout.ts or shared/map/colliders.ts not present yet');
    return;
  }

  const { MAP_COMPOUND_LAYOUT } = await import('../shared/map/layout.ts');
  const { buildColliders, buildNavGrid } = await import('../shared/map/colliders.ts');

  const colliders = buildColliders(MAP_COMPOUND_LAYOUT);
  const nav = buildNavGrid(MAP_COMPOUND_LAYOUT, colliders);

  const players = new Map<number, PlayerState>();
  const brains: BotBrain[] = [];
  for (let i = 0; i < 12; i++) {
    const team = i % 2 === 0 ? TEAM_A : TEAM_B;
    const p = makeSelf(i + 1, team, (i % 6) * 3, Math.floor(i / 6) * 3);
    players.set(p.id, p);
    brains.push(new BotBrain(p.id, i % 3, 1000 + i));
  }

  const rules = makeRules(MODE_TDM);
  const world: WorldView = {
    tick: 0,
    colliders,
    nav,
    players,
    projectiles: [],
    events: [],
    rng: () => 0.5,
    frozen: false,
    rules,
    respawn: () => {},
    damage: () => {},
    kill: () => {},
    hasLineOfSight: (a, b) => colliders.lineOfSight(a, b),
    eyePos: (p, out) => {
      out.x = p.pos.x;
      out.y = p.pos.y + 1.6;
      out.z = p.pos.z;
      return out;
    },
    spawnProjectile: (kind, owner, team, pos) => ({
      id: 1,
      kind,
      owner,
      team,
      pos: vec3(pos.x, pos.y, pos.z),
      vel: vec3(),
      fuse: 0,
      resting: false,
    }),
  };

  for (let tick = 0; tick < 600; tick++) {
    for (const brain of brains) {
      const cmd = brain.think(world, rules, tick);
      assert.ok(Number.isFinite(cmd.yaw) && Number.isFinite(cmd.pitch));
    }
  }
});
