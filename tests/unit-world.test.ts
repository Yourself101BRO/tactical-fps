// Unit tests for shared/sim/world.ts, shared/sim/lagcomp.ts and
// shared/sim/grenades.ts. Uses the real map (MAP_COMPOUND_LAYOUT via
// buildColliders) when shared/map/layout.ts exists; otherwise falls back to a
// minimal flat-ground layout literal so this suite is independently runnable
// while that module is still being written concurrently.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../shared/sim/world.ts';
import { HitHistory } from '../shared/sim/lagcomp.ts';
import { explode, flashStrength } from '../shared/sim/grenades.ts';
import type { ModeRules, SpawnChoice, WorldView } from '../shared/sim/types.ts';
import { createInputCmd, defaultLoadout, vec3 } from '../shared/types.ts';
import type { MapLayout } from '../shared/map/types.ts';
import {
  BTN_FIRE,
  EV_KILL,
  FRAG_DAMAGE_MAX,
  FRAG_DAMAGE_MIN,
  HEALTH_MAX,
  INTERP_TICKS,
  MAT_CONCRETE,
  PROJ_FRAG,
  TEAM_A,
  TEAM_B,
  TICK_DT,
  WEAPON_PISTOL,
} from '../shared/constants.ts';

// ---------------------------------------------------------------------------
// A minimal flat layout used only if shared/map/layout.ts is not yet present.
// ---------------------------------------------------------------------------
const FALLBACK_LAYOUT: MapLayout = {
  id: 0,
  name: 'test-flat',
  width: 100,
  depth: 100,
  boxes: [{ x: -50, y: -1, z: -50, w: 100, h: 1, d: 100, material: MAT_CONCRETE, tag: 'floor' }],
  ramps: [],
  props: [],
  spawns: [
    { team: TEAM_A, x: -10, y: 0, z: 0, yaw: 0 },
    { team: TEAM_B, x: 10, y: 0, z: 0, yaw: Math.PI },
  ],
  sites: [],
  lights: [],
  navCellSize: 1,
  groundMaterial: MAT_CONCRETE,
  killY: -50,
};

async function getLayout(): Promise<MapLayout> {
  try {
    const mod = await import('../shared/map/layout.ts');
    const layout = (mod as { MAP_COMPOUND_LAYOUT?: MapLayout }).MAP_COMPOUND_LAYOUT;
    if (layout) return layout;
  } catch {
    // not written yet — fall back below
  }
  return FALLBACK_LAYOUT;
}

/** A trivial always-hostile ruleset good enough to exercise onKill/isEnemy. */
function makeStubRules(): ModeRules {
  return {
    mode: 0,
    teamBased: true,
    phase: 3,
    timeLeft: 0,
    scores: [0, 0],
    round: 0,
    roundsWon: [0, 0],
    bomb: { state: 0, site: -1, timer: 0, carrier: 0, pos: vec3() },
    winnerTeam: 0,
    winnerId: 0,
    start(): void {},
    tick(): void {},
    onKill(_world: WorldView, killer, victim): void {
      if (killer) this.scores[killer.team === TEAM_A ? 0 : 1]++;
      void victim;
    },
    onPlayerJoin(): void {},
    onPlayerLeave(): void {},
    canRespawn(): boolean {
      return true;
    },
    pickSpawn(): SpawnChoice {
      return { x: 0, y: 0, z: 0, yaw: 0 };
    },
    interact(): void {},
    isEnemy(a, b): boolean {
      return a.team !== b.team;
    },
    assignTeam(): number {
      return TEAM_A;
    },
    result() {
      return { winnerTeam: 0, winnerId: 0, players: [] };
    },
    finished: false,
  };
}

async function makeWorld(): Promise<World> {
  const layout = await getLayout();
  const world = new World(layout, 12345);
  world.rules = makeStubRules();
  return world;
}

test('applyInput rejects a stale seq and accepts increasing seqs', async () => {
  const world = await makeWorld();
  const p = world.addPlayer(1, 'a', TEAM_A, false, defaultLoadout());
  p.alive = true;

  const c1 = createInputCmd();
  c1.seq = 5;
  c1.tick = 1;
  assert.equal(world.applyInput(1, c1), true);

  world.step(TICK_DT); // drains queue, sets lastAppliedSeq = 5

  const stale = createInputCmd();
  stale.seq = 3;
  stale.tick = 2;
  assert.equal(world.applyInput(1, stale), false, 'seq below lastAppliedSeq must be rejected');

  const dup = createInputCmd();
  dup.seq = 5;
  dup.tick = 2;
  assert.equal(world.applyInput(1, dup), false, 'seq equal to lastAppliedSeq must be rejected');

  const fresh = createInputCmd();
  fresh.seq = 6;
  fresh.tick = 2;
  assert.equal(world.applyInput(1, fresh), true, 'a genuinely newer seq must be accepted');
});

test('unknown player id is rejected without throwing', async () => {
  const world = await makeWorld();
  const cmd = createInputCmd();
  cmd.seq = 1;
  assert.equal(world.applyInput(999, cmd), false);
});

test('lag-compensated raycast hits a target at its rewound position even though it has since moved', async () => {
  const world = await makeWorld();
  const shooter = world.addPlayer(1, 'shooter', TEAM_A, false, defaultLoadout());
  const target = world.addPlayer(2, 'target', TEAM_B, false, defaultLoadout());
  shooter.alive = true;
  target.alive = true;
  shooter.pos.x = 0; shooter.pos.y = 0; shooter.pos.z = 0; shooter.yaw = 0;
  target.pos.x = 0; target.pos.y = 0; target.pos.z = -10;

  // Record history while the target sits at z = -10 ...
  const history = new HitHistory();
  let rewoundTick = 0;
  for (let i = 0; i < 5; i++) {
    world.step(TICK_DT);
    if (i === 2) {
      rewoundTick = world.tick;
      history.record(rewoundTick, [shooter, target]); // capture the historical position HERE, before it moves
    }
  }

  // ... then the target moves far away (as if the network is still catching up on the shooter's client).
  target.pos.x = 50; target.pos.z = 50;
  world.step(TICK_DT);

  const out = { id: 0, zone: -1, dist: 0, point: vec3() };
  const dir = vec3(0, 0, -1);
  const origin = vec3(0, eyeHeightGuess(shooter), 0);
  const got = history.raycast(rewoundTick, origin, dir, 50, shooter.id, (p) => p.alive && p.team !== shooter.team, out);
  assert.equal(got, true, 'expected a hit against the historical (not live) target position');
  assert.equal(out.id, 2);
});

function eyeHeightGuess(p: { pos: { y: number } }): number {
  // Small local helper: avoids importing movement.ts (owned by another agent)
  // into the test just to compute an eye offset for a synthetic raycast origin.
  return p.pos.y + 1.6;
}

test('World.step: a fired shot resolves against the target rewound position, killing it even though it has since moved away', async () => {
  const world = await makeWorld();
  const shooter = world.addPlayer(1, 'shooter', TEAM_A, false, defaultLoadout());
  const target = world.addPlayer(2, 'target', TEAM_B, false, defaultLoadout());
  shooter.alive = true;
  target.alive = true;
  shooter.pos.x = 0; shooter.pos.y = 0; shooter.pos.z = 0; shooter.yaw = 0; shooter.pitch = 0;
  target.pos.x = 0; target.pos.y = 0; target.pos.z = -10;
  target.health = 1;
  shooter.slots[0]!.weapon = WEAPON_PISTOL;
  shooter.slots[0]!.mag = 10;
  shooter.slots[0]!.reserve = 0;
  shooter.activeSlot = 0;

  // Advance a handful of ticks with the target sitting at z=-10 so HitHistory
  // has real frames recorded for it.
  let tickWhenAtOldPos = 0;
  for (let i = 0; i < 10; i++) {
    world.step(TICK_DT);
    tickWhenAtOldPos = world.tick;
  }

  // The target now moves out of the line of fire entirely...
  target.pos.x = 50; target.pos.z = 50;

  // ...and the shooter's input claims cmd.tick = tickWhenAtOldPos + INTERP_TICKS,
  // so World's rewindTick formula (cmd.tick - INTERP_TICKS, clamped) lands
  // exactly on tickWhenAtOldPos: this is exactly what a laggy client's cmd.tick
  // stamp looks like when its shot was aimed while the target was still there.
  const cmd = createInputCmd();
  cmd.seq = 1;
  cmd.tick = tickWhenAtOldPos + INTERP_TICKS;
  cmd.yaw = 0; cmd.pitch = 0; cmd.buttons = BTN_FIRE;
  world.applyInput(shooter.id, cmd);
  world.step(TICK_DT);

  assert.equal(target.alive, false, 'the shot should hit the target at its rewound position, not its current (moved) one');
});

test('World.step resolves a fired shot into damage, a kill event and rules.onKill scoring', async () => {
  const world = await makeWorld();
  const shooter = world.addPlayer(1, 'shooter', TEAM_A, false, defaultLoadout());
  const target = world.addPlayer(2, 'target', TEAM_B, false, defaultLoadout());
  shooter.alive = true;
  target.alive = true;
  shooter.pos.x = 0; shooter.pos.y = 0; shooter.pos.z = 0; shooter.yaw = 0; shooter.pitch = 0;
  target.pos.x = 0; target.pos.y = 0; target.pos.z = -5;
  target.health = 1; // one shot should be enough to kill regardless of weapon damage falloff

  // Give the shooter a loaded pistol directly (weaponstate.ts owns giveLoadout;
  // this test only needs a non-empty mag so stepWeapon actually fires).
  shooter.slots[0]!.weapon = WEAPON_PISTOL;
  shooter.slots[0]!.mag = 10;
  shooter.slots[0]!.reserve = 0;
  shooter.activeSlot = 0;

  // Warm the world up a few ticks (realistic: firing only ever happens after
  // ticks have already elapsed, e.g. past WARMUP) so HitHistory has frames.
  for (let i = 0; i < 3; i++) world.step(TICK_DT);

  const scoreBefore = world.rules.scores[0];

  const cmd = createInputCmd();
  cmd.seq = 1;
  // cmd.tick = world.tick + INTERP_TICKS collapses the rewind formula to "now",
  // the same trick BotBrain.think uses (see shared/sim/bots.ts in the plan).
  cmd.tick = world.tick + INTERP_TICKS;
  cmd.yaw = 0;
  cmd.pitch = 0;
  cmd.buttons = BTN_FIRE;
  world.applyInput(shooter.id, cmd);
  world.step(TICK_DT);

  const killEvents = world.events.filter((e) => e.type === EV_KILL);
  assert.ok(killEvents.length >= 1, 'expected at least one EV_KILL event after a lethal shot');
  assert.equal(target.alive, false);
  assert.equal(target.health, 0);
  assert.equal(target.deaths, 1);
  assert.equal(shooter.kills, 1);
  assert.ok(world.rules.scores[0] > scoreBefore, 'rules.onKill should have been invoked and scored the kill');
});

test('frag grenade explosion: lethal close in, wounding but survivable further out', async () => {
  const world = await makeWorld();
  const owner = world.addPlayer(1, 'owner', TEAM_A, false, defaultLoadout());
  const near = world.addPlayer(2, 'near', TEAM_B, false, defaultLoadout());
  const far = world.addPlayer(3, 'far', TEAM_B, false, defaultLoadout());
  owner.alive = true; near.alive = true; far.alive = true;
  owner.pos.x = 0; owner.pos.y = 0; owner.pos.z = 0;
  near.pos.x = 1; near.pos.y = 0; near.pos.z = 0; // 1 m away: inside FRAG_RADIUS_FULL -> max damage
  far.pos.x = 5; far.pos.y = 0; far.pos.z = 0; // 5 m away: between full and outer radius -> partial damage
  near.health = HEALTH_MAX;
  far.health = HEALTH_MAX;

  const proj = world.spawnProjectile(PROJ_FRAG, owner.id, owner.team, vec3(0, 0, 0), vec3(0, 0, 0), 0);
  explode(world, proj);

  // FRAG_DAMAGE_MAX (120) exceeds HEALTH_MAX (100), so full damage at point-blank range is always lethal.
  assert.equal(near.alive, false, 'near player should have been killed by a point-blank frag');
  assert.equal(near.health, 0);
  assert.ok(far.health < HEALTH_MAX, 'far player should take some damage');
  assert.ok(far.health > HEALTH_MAX - FRAG_DAMAGE_MAX, 'far player should take less than max damage');
  assert.ok(HEALTH_MAX - far.health >= FRAG_DAMAGE_MIN - 1, 'far player damage should be at least roughly the minimum falloff damage');
});

test('flash strength is higher facing the flash than facing away, and zero beyond radius', async () => {
  const world = await makeWorld();
  const viewer = world.addPlayer(1, 'viewer', TEAM_A, false, defaultLoadout());
  viewer.alive = true;
  viewer.pos.x = 0; viewer.pos.y = 0; viewer.pos.z = 0;

  const proj = world.spawnProjectile(PROJ_FRAG /* kind irrelevant to flashStrength */, 2, TEAM_B, vec3(0, 0, -3), vec3(0, 0, 0), 0);

  viewer.yaw = 0; // facing -Z (yawPitchToDir(0,0) convention), i.e. toward the flash
  const towards = flashStrength(world, proj, viewer);

  viewer.yaw = Math.PI; // facing +Z, away from the flash
  const away = flashStrength(world, proj, viewer);

  assert.ok(towards > away, `facing the flash (${towards}) should be stronger than facing away (${away})`);
  assert.ok(towards > 0);

  const farProj = world.spawnProjectile(PROJ_FRAG, 2, TEAM_B, vec3(0, 0, -1000), vec3(0, 0, 0), 0);
  assert.equal(flashStrength(world, farProj, viewer), 0, 'beyond FLASH_RADIUS the strength must be exactly 0');
});

test('respawn resets health, position and grenade counts, and emits EV_RESPAWN', async () => {
  const world = await makeWorld();
  const p = world.addPlayer(1, 'p', TEAM_A, false, defaultLoadout());
  p.alive = false;
  p.health = 0;
  p.lethalCount = 0;
  p.tacticalCount = 0;

  world.respawn(p.id, { x: 3, y: 0, z: 4, yaw: 1.2 });

  assert.equal(p.alive, true);
  assert.equal(p.health, HEALTH_MAX);
  assert.equal(p.pos.x, 3);
  assert.equal(p.pos.z, 4);
  assert.equal(p.yaw, 1.2);
  assert.ok(p.lethalCount > 0);
  assert.ok(world.events.some((e) => e.type === 9 /* EV_RESPAWN */ && (e as { player: number }).player === p.id));
});
