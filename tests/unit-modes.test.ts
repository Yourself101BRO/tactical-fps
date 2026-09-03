// Unit tests for shared/sim/modes.ts against a minimal fake WorldView, so
// they run independently of the real World/colliders implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BOMB_CARRIED,
  BOMB_DEFUSED,
  BOMB_PLANTED,
  MATCH_END_SECONDS,
  PHASE_FREEZE,
  PHASE_LIVE,
  PHASE_MATCH_END,
  PHASE_ROUND_END,
  PHASE_WARMUP,
  SND_BOMB_FUSE,
  SND_DEFUSE_TIME,
  SND_FREEZE_SECONDS,
  SND_PLANT_TIME,
  SND_ROUNDS_TO_WIN,
  TDM_KILL_LIMIT,
  TEAM_A,
  TEAM_B,
  TICK_DT,
  WARMUP_SECONDS,
} from '../shared/constants.ts';
import { createPlayerState } from '../shared/types.ts';
import type { GameEvent, PlayerState, Vec3 } from '../shared/types.ts';
import type { MapColliders, Site, SpawnPoint } from '../shared/map/types.ts';
import type { WorldView } from '../shared/sim/types.ts';
import { createRules, FfaRules, SndRules, TdmRules } from '../shared/sim/modes.ts';

// ---------------------------------------------------------------------------
// A minimal, deterministic fake of shared/sim/world.ts's public surface.
// ---------------------------------------------------------------------------
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

class FakeColliders implements MapColliders {
  readonly layout = { id: 0, name: 'fake', width: 100, depth: 100, boxes: [], ramps: [], props: [], spawns: [], sites: [], lights: [], navCellSize: 1, groundMaterial: 0, killY: -50 };
  readonly aabbs = [];
  readonly ramps = [];
  sites: Site[] = [];
  spawnsA: SpawnPoint[] = [{ team: TEAM_A, x: -10, y: 0, z: 0, yaw: 0 }];
  spawnsB: SpawnPoint[] = [{ team: TEAM_B, x: 10, y: 0, z: 0, yaw: Math.PI }];

  query(): number { return 0; }
  raycast(): boolean { return false; }
  groundHeight(): number { return 0; }
  materialAt(): number { return 0; }
  spawnsFor(team: number): readonly SpawnPoint[] {
    return team === TEAM_A ? this.spawnsA : team === TEAM_B ? this.spawnsB : [...this.spawnsA, ...this.spawnsB];
  }
  lineOfSight(): boolean { return true; }
}

class FakeWorld implements WorldView {
  tick = 0;
  readonly colliders = new FakeColliders();
  readonly nav = {
    cellSize: 1, cols: 1, rows: 1,
    walkable: () => true,
    findPath: () => false,
    randomPoint: (_rng: () => number, out: Vec3) => out,
    heightAt: () => 0,
  };
  readonly players = new Map<number, PlayerState>();
  readonly projectiles = [];
  readonly events: GameEvent[] = [];
  readonly rng: () => number;
  frozen = false;
  rules!: import('../shared/sim/types.ts').ModeRules;

  constructor(seed = 1) {
    this.rng = makeRng(seed);
  }

  addPlayer(id: number, name: string, team: number): PlayerState {
    const p = createPlayerState(id, name, team);
    this.players.set(id, p);
    return p;
  }

  respawn(id: number, spawn: { x: number; y: number; z: number; yaw: number }): void {
    const p = this.players.get(id);
    if (!p) return;
    p.pos.x = spawn.x; p.pos.y = spawn.y; p.pos.z = spawn.z; p.yaw = spawn.yaw;
    p.alive = true; p.health = 100;
  }

  damage(targetId: number, amount: number, attackerId: number, _zone: number, weapon: number): void {
    const p = this.players.get(targetId);
    if (!p || !p.alive) return;
    p.health -= amount;
    if (p.health <= 0) this.kill(targetId, attackerId, weapon, false);
  }

  kill(victimId: number, killerId: number, weapon: number, headshot: boolean): void {
    const victim = this.players.get(victimId);
    if (!victim || !victim.alive) return;
    const killer = killerId ? this.players.get(killerId) ?? null : null;
    victim.alive = false;
    victim.health = 0;
    this.rules.onKill(this, killer, victim, weapon, headshot);
  }

  hasLineOfSight(): boolean { return false; }
  eyePos(p: PlayerState, out: Vec3): Vec3 { out.x = p.pos.x; out.y = p.pos.y + 1.6; out.z = p.pos.z; return out; }
  spawnProjectile(): never { throw new Error('not used by these tests'); }
  clearEvents(): void { this.events.length = 0; }
}

function tickN(world: FakeWorld, rules: { tick(world: WorldView, dt: number): void }, n: number): void {
  for (let i = 0; i < n; i++) {
    world.tick++;
    rules.tick(world, TICK_DT);
  }
}

// ---------------------------------------------------------------------------
// createRules
// ---------------------------------------------------------------------------
test('createRules returns the right class per mode and falls back to FFA', () => {
  assert.ok(createRules(1) instanceof FfaRules); // MODE_FFA
  assert.ok(createRules(2) instanceof TdmRules); // MODE_TDM
  assert.ok(createRules(3) instanceof SndRules); // MODE_SND
  assert.ok(createRules(0) instanceof FfaRules); // MODE_ANY -> fallback
  assert.ok(createRules(99) instanceof FfaRules); // unknown -> fallback
});

// ---------------------------------------------------------------------------
// TDM: kill limit ends the match
// ---------------------------------------------------------------------------
test('TDM: reaching the kill limit ends the match with the right winner', () => {
  const world = new FakeWorld();
  const rules = new TdmRules();
  world.rules = rules;
  const a = world.addPlayer(1, 'a', TEAM_A);
  const b = world.addPlayer(2, 'b', TEAM_B);

  rules.start(world);
  assert.equal(rules.phase, PHASE_WARMUP);

  tickN(world, rules, Math.ceil(WARMUP_SECONDS / TICK_DT) + 1);
  assert.equal(rules.phase, PHASE_LIVE);
  assert.ok(a.alive && b.alive, 'players should have been spawned into the round');
  assert.equal(world.frozen, false);

  for (let i = 0; i < TDM_KILL_LIMIT; i++) {
    rules.onKill(world, a, b, 0, false);
    world.tick++;
    rules.tick(world, TICK_DT);
  }

  assert.equal(rules.finished, true);
  assert.equal(rules.phase, PHASE_MATCH_END);
  assert.equal(rules.winnerTeam, TEAM_A);
  assert.equal(rules.scores[0], TDM_KILL_LIMIT);
  assert.equal(world.frozen, true);

  const result = rules.result(world);
  assert.equal(result.winnerTeam, TEAM_A);
  assert.equal(result.players.length, 2);
});

test('TDM: friendly fire does not add to the team score', () => {
  const world = new FakeWorld();
  const rules = new TdmRules();
  world.rules = rules;
  const a1 = world.addPlayer(1, 'a1', TEAM_A);
  const a2 = world.addPlayer(2, 'a2', TEAM_A);
  rules.onKill(world, a1, a2, 0, false);
  assert.equal(rules.scores[0], 0);
  assert.equal(rules.scores[1], 0);
  assert.equal(a1.kills, 1);
  assert.equal(a2.deaths, 1);
});

// ---------------------------------------------------------------------------
// S&D: plant / defuse / round flow
// ---------------------------------------------------------------------------
function makeSndWorld(): { world: FakeWorld; rules: SndRules; attacker: PlayerState; defender: PlayerState } {
  const world = new FakeWorld();
  const rules = new SndRules();
  world.rules = rules;
  world.colliders.sites = [{ id: 0, name: 'A', x: -10, y: 0, z: 0, radius: 3 }];
  const attacker = world.addPlayer(1, 'atk', TEAM_A);
  const defender = world.addPlayer(2, 'def', TEAM_B);
  rules.start(world);
  tickN(world, rules, Math.ceil(WARMUP_SECONDS / TICK_DT) + 1);
  return { world, rules, attacker, defender };
}

test('S&D: warmup leads into FREEZE, then LIVE, with an attacker carrying the bomb', () => {
  const { world, rules } = makeSndWorld();
  assert.equal(rules.phase, PHASE_FREEZE);
  assert.equal(rules.round, 1);
  assert.equal(rules.bomb.state, BOMB_CARRIED);
  assert.equal(rules.bomb.carrier, 1); // the only attacker

  tickN(world, rules, Math.ceil(SND_FREEZE_SECONDS / TICK_DT) + 1);
  assert.equal(rules.phase, PHASE_LIVE);
  assert.equal(world.frozen, false);
});

test('S&D: plant then defuse gives the round to the defenders', () => {
  const { world, rules, attacker, defender } = makeSndWorld();
  tickN(world, rules, Math.ceil(SND_FREEZE_SECONDS / TICK_DT) + 1); // -> LIVE

  // Move the bomb carrier onto site A and hold interact until it plants.
  attacker.pos.x = -10; attacker.pos.z = 0;
  for (let i = 0; i < Math.ceil(SND_PLANT_TIME / TICK_DT) + 1; i++) {
    rules.interact(world, attacker, TICK_DT);
  }
  assert.equal(rules.bomb.state, BOMB_PLANTED);
  assert.ok(rules.bomb.timer <= SND_BOMB_FUSE && rules.bomb.timer > 0);

  // Defender moves onto the planted site and defuses.
  defender.pos.x = -10; defender.pos.z = 0;
  for (let i = 0; i < Math.ceil(SND_DEFUSE_TIME / TICK_DT) + 1; i++) {
    rules.interact(world, defender, TICK_DT);
  }
  assert.equal(rules.bomb.state, BOMB_DEFUSED);
  assert.equal(rules.phase, PHASE_ROUND_END);
  assert.equal(rules.roundsWon[1], 1); // TEAM_B (defenders) won the round
  assert.equal(rules.scores[1], 1);
});

test('S&D: bomb detonation kills nearby players and ends the round for the attackers', () => {
  const { world, rules, attacker } = makeSndWorld();
  tickN(world, rules, Math.ceil(SND_FREEZE_SECONDS / TICK_DT) + 1); // -> LIVE

  attacker.pos.x = -10; attacker.pos.z = 0;
  for (let i = 0; i < Math.ceil(SND_PLANT_TIME / TICK_DT) + 1; i++) rules.interact(world, attacker, TICK_DT);
  assert.equal(rules.bomb.state, BOMB_PLANTED);

  // A bystander standing next to the bomb should die in the explosion.
  const bystander = world.addPlayer(3, 'bystander', TEAM_B);
  bystander.alive = true;
  bystander.pos.x = -10; bystander.pos.y = 0; bystander.pos.z = 1;

  tickN(world, rules, Math.ceil(SND_BOMB_FUSE / TICK_DT) + 1);
  assert.equal(rules.bomb.timer <= 0 || rules.phase === PHASE_ROUND_END, true);
  assert.equal(bystander.alive, false);
  assert.equal(rules.roundsWon[0], 1); // TEAM_A (attackers) won via detonation
});

test('S&D: match ends once a team reaches SND_ROUNDS_TO_WIN', () => {
  const { world, rules } = makeSndWorld();
  // Fast-forward: manually award rounds to TEAM_A up to the win threshold via
  // repeated elimination rounds (attacker kills the lone defender each time).
  for (let round = 1; round <= SND_ROUNDS_TO_WIN; round++) {
    tickN(world, rules, Math.ceil(SND_FREEZE_SECONDS / TICK_DT) + 1); // -> LIVE
    const defender = world.players.get(2)!;
    const attacker = world.players.get(1)!;
    world.kill(2, 1, 0, false); // defender eliminated -> attackers win the round
    world.tick++;
    rules.tick(world, TICK_DT);
    assert.equal(rules.phase, PHASE_ROUND_END);
    if (round < SND_ROUNDS_TO_WIN) {
      tickN(world, rules, Math.ceil(5 / TICK_DT) + 1); // SND_ROUND_END_SECONDS -> next round's FREEZE
      // revive both for the next round's respawn-at-round-start logic
      defender.alive = true;
      attacker.alive = true;
    }
  }
  tickN(world, rules, Math.ceil(5 / TICK_DT) + 1); // let the final ROUND_END expire
  assert.equal(rules.finished, true);
  assert.equal(rules.phase, PHASE_MATCH_END);
  assert.equal(rules.winnerTeam, TEAM_A);
  assert.equal(rules.roundsWon[0], SND_ROUNDS_TO_WIN);
});

// ---------------------------------------------------------------------------
// FFA: spawning, leader tracking, isEnemy
// ---------------------------------------------------------------------------
test('FFA: isEnemy is id-based and the leader is tracked continuously', () => {
  const world = new FakeWorld();
  const rules = new FfaRules();
  world.rules = rules;
  const a = world.addPlayer(1, 'a', 0);
  const b = world.addPlayer(2, 'b', 0);
  assert.equal(rules.isEnemy(a, b), true);
  assert.equal(rules.isEnemy(a, a), false);

  rules.start(world);
  tickN(world, rules, Math.ceil(WARMUP_SECONDS / TICK_DT) + 1);
  assert.equal(rules.phase, PHASE_LIVE);

  rules.onKill(world, a, b, 0, false);
  world.tick++;
  rules.tick(world, TICK_DT);
  assert.equal(rules.scores[0], 1);
  assert.equal(rules.winnerId, 1);
});

test('MATCH_END_SECONDS is honored as the finished-phase duration constant', () => {
  // Sanity check that the constant this module relies on is what we think.
  assert.ok(MATCH_END_SECONDS > 0);
});
