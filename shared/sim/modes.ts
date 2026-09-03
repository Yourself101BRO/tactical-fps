// Match-mode rules: FFA, TDM and Search & Destroy. Pure state machines driven
// by Room.tickOnce() calling rules.tick(world, dt) once per simulation tick.
// No clocks, no DOM, no three.js — everything here is deterministic given the
// WorldView it is handed.
//
// Workaround note (Hard Rule 1): the plan specifies the S&D bomb explosion
// kills everyone within "12 m", but shared/constants.ts has no constant for
// this radius (SPAWN_MIN_ENEMY_DIST is unrelated, despite sharing the value).
// It is declared locally below as BOMB_KILL_RADIUS; the integrator may want to
// promote it to constants.ts.

import {
  BOMB_CARRIED,
  BOMB_DEFUSED,
  BOMB_DROPPED,
  BOMB_EXPLODED,
  BOMB_NONE,
  BOMB_PLANTED,
  CONN_ACTIVE,
  CONN_DISCONNECTED,
  CONN_SPECTATING,
  CONN_WAITING_ROUND,
  DM_TIME_LIMIT,
  EV_DEFUSE,
  EV_PLANT,
  EV_ROUND,
  EYE_STAND,
  FFA_KILL_LIMIT,
  KILL_BOMB,
  MATCH_END_SECONDS,
  MODE_FFA,
  MODE_SND,
  MODE_TDM,
  PHASE_FREEZE,
  PHASE_LIVE,
  PHASE_LOBBY,
  PHASE_MATCH_END,
  PHASE_ROUND_END,
  PHASE_WARMUP,
  RESPAWN_DELAY,
  ROUND_END,
  ROUND_START,
  SND_BOMB_FUSE,
  SND_DEFUSE_TIME,
  SND_FREEZE_SECONDS,
  SND_MAX_ROUNDS,
  SND_PLANT_TIME,
  SND_ROUNDS_TO_WIN,
  SND_ROUND_END_SECONDS,
  SND_ROUND_SECONDS,
  SND_SWAP_AFTER,
  SPAWN_MIN_ENEMY_DIST,
  TDM_KILL_LIMIT,
  TEAM_A,
  TEAM_B,
  TEAM_NONE,
  TICK_DT,
  WARMUP_SECONDS,
} from '../constants.ts';
import { vec3 } from '../types.ts';
import type { MatchResult, MatchResultPlayer, PlayerState } from '../types.ts';
import type { BombState, ModeRules, SpawnChoice, WorldView } from './types.ts';
import type { SpawnPoint } from '../map/types.ts';

/** Score penalty applied to a candidate spawn any enemy has line of sight to. */
const SPAWN_LOS_PENALTY = 30;
/** See the workaround note at the top of this file. */
const BOMB_KILL_RADIUS = 12;

// Reused across calls to avoid per-call allocation; safe because Node is
// single-threaded and pickSpawnFrom never yields mid-computation.
const scratchEyeA = vec3();
const scratchEyeB = vec3();

function countAliveTeam(world: WorldView, team: number): number {
  let n = 0;
  for (const p of world.players.values()) {
    if (p.alive && p.team === team) n++;
  }
  return n;
}

/** Smaller team joins; ties go to TEAM_A. Disconnected slots don't count. */
function assignSmallerTeam(world: WorldView): number {
  let a = 0;
  let b = 0;
  for (const p of world.players.values()) {
    if (p.connState === CONN_DISCONNECTED) continue;
    if (p.team === TEAM_A) a++;
    else if (p.team === TEAM_B) b++;
  }
  return a <= b ? TEAM_A : TEAM_B;
}

/** True when every alive enemy is at least SPAWN_MIN_ENEMY_DIST away from sp. */
function safeSpawn(world: WorldView, sp: SpawnPoint, isEnemy: (p: PlayerState) => boolean): boolean {
  for (const p of world.players.values()) {
    if (!p.alive || !isEnemy(p)) continue;
    const dx = sp.x - p.pos.x;
    const dy = sp.y - p.pos.y;
    const dz = sp.z - p.pos.z;
    if (dx * dx + dy * dy + dz * dz < SPAWN_MIN_ENEMY_DIST * SPAWN_MIN_ENEMY_DIST) return false;
  }
  return true;
}

/**
 * Shared spawn-scoring logic for all three modes: prefer spawns clear of
 * every enemy by SPAWN_MIN_ENEMY_DIST; among those (or, failing that, among
 * every candidate) prefer ones no enemy has line of sight to, with a small
 * rng tie-breaker so bots/players don't all pick the same "best" spawn.
 */
function pickSpawnFrom(world: WorldView, spawns: readonly SpawnPoint[], isEnemy: (p: PlayerState) => boolean): SpawnChoice {
  if (spawns.length === 0) return { x: 0, y: 0, z: 0, yaw: 0 };

  let anySafe = false;
  for (const sp of spawns) {
    if (safeSpawn(world, sp, isEnemy)) { anySafe = true; break; }
  }

  let best: SpawnPoint = spawns[0]!;
  let bestScore = -Infinity;
  for (const sp of spawns) {
    if (anySafe && !safeSpawn(world, sp, isEnemy)) continue;
    scratchEyeA.x = sp.x;
    scratchEyeA.y = sp.y + EYE_STAND;
    scratchEyeA.z = sp.z;
    let hasLOS = false;
    for (const p of world.players.values()) {
      if (!p.alive || !isEnemy(p)) continue;
      world.eyePos(p, scratchEyeB);
      if (world.hasLineOfSight(scratchEyeA, scratchEyeB)) { hasLOS = true; break; }
    }
    const score = (hasLOS ? -SPAWN_LOS_PENALTY : 0) + world.rng() * 2;
    if (score > bestScore) { bestScore = score; best = sp; }
  }
  return { x: best.x, y: best.y, z: best.z, yaw: best.yaw };
}

function siteUnderPlayer(world: WorldView, player: PlayerState): number {
  for (const site of world.colliders.sites) {
    const dx = player.pos.x - site.x;
    const dz = player.pos.z - site.z;
    if (dx * dx + dz * dz <= site.radius * site.radius) return site.id;
  }
  return -1;
}

function buildResultPlayers(world: WorldView): MatchResultPlayer[] {
  const players: MatchResultPlayer[] = [];
  for (const p of world.players.values()) {
    players.push({ id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths, score: p.score });
  }
  return players;
}

function newBomb(): BombState {
  return { state: BOMB_NONE, site: -1, timer: 0, carrier: 0, pos: vec3() };
}

// ---------------------------------------------------------------------------
// Free-for-all: everyone for themselves, first to FFA_KILL_LIMIT or the clock.
// ---------------------------------------------------------------------------
export class FfaRules implements ModeRules {
  readonly mode = MODE_FFA;
  readonly teamBased = false;
  phase = PHASE_LOBBY;
  timeLeft = 0;
  scores: [number, number] = [0, 0];
  round = 0;
  roundsWon: [number, number] = [0, 0];
  bomb: BombState = newBomb();
  winnerTeam = TEAM_NONE;
  winnerId = 0;

  get finished(): boolean {
    return this.phase === PHASE_MATCH_END;
  }

  start(_world: WorldView): void {
    this.phase = PHASE_WARMUP;
    this.timeLeft = WARMUP_SECONDS;
  }

  tick(world: WorldView, dt: number): void {
    this.updateLeader(world);
    switch (this.phase) {
      case PHASE_WARMUP:
        this.timeLeft -= dt;
        if (this.timeLeft <= 0) {
          this.phase = PHASE_LIVE;
          this.timeLeft = DM_TIME_LIMIT;
          this.respawnAll(world);
        }
        break;
      case PHASE_LIVE:
        this.timeLeft = Math.max(0, this.timeLeft - dt);
        if (this.scores[0] >= FFA_KILL_LIMIT || this.timeLeft <= 0) {
          this.phase = PHASE_MATCH_END;
          this.timeLeft = MATCH_END_SECONDS;
        }
        break;
      default:
        break;
    }
    world.frozen = this.phase !== PHASE_LIVE;
  }

  private updateLeader(world: WorldView): void {
    let leader: PlayerState | null = null;
    for (const p of world.players.values()) {
      if (!leader || p.kills > leader.kills) leader = p;
    }
    if (leader) {
      this.scores[0] = leader.kills;
      this.winnerId = leader.id;
    }
  }

  private respawnAll(world: WorldView): void {
    for (const p of world.players.values()) world.respawn(p.id, this.pickSpawn(world, p.team));
    world.events.push({ type: EV_ROUND, state: ROUND_START, winner: 0, round: 0 });
  }

  onKill(world: WorldView, killer: PlayerState | null, victim: PlayerState): void {
    victim.deaths++;
    if (killer && killer.id !== victim.id) killer.kills++;
    victim.respawnTick = world.tick + Math.round(RESPAWN_DELAY / TICK_DT);
  }

  onPlayerJoin(world: WorldView, player: PlayerState): void {
    if (this.phase === PHASE_LIVE) world.respawn(player.id, this.pickSpawn(world, player.team));
  }

  onPlayerLeave(): void {}

  canRespawn(world: WorldView, player: PlayerState): boolean {
    return !player.alive && world.tick >= player.respawnTick;
  }

  pickSpawn(world: WorldView, team: number): SpawnChoice {
    // FFA has no teams; every other alive player is a potential enemy.
    return pickSpawnFrom(world, world.colliders.spawnsFor(team), (p) => p.alive);
  }

  interact(_world: WorldView, player: PlayerState): void {
    player.interactT = 0;
  }

  isEnemy(a: PlayerState, b: PlayerState): boolean {
    return a.id !== b.id;
  }

  assignTeam(_world: WorldView): number {
    return TEAM_NONE;
  }

  result(world: WorldView): MatchResult {
    return { winnerTeam: TEAM_NONE, winnerId: this.winnerId, players: buildResultPlayers(world) };
  }
}

// ---------------------------------------------------------------------------
// Team Deathmatch: 6v6, first to TDM_KILL_LIMIT or the clock.
// ---------------------------------------------------------------------------
export class TdmRules implements ModeRules {
  readonly mode = MODE_TDM;
  readonly teamBased = true;
  phase = PHASE_LOBBY;
  timeLeft = 0;
  scores: [number, number] = [0, 0];
  round = 0;
  roundsWon: [number, number] = [0, 0];
  bomb: BombState = newBomb();
  winnerTeam = TEAM_NONE;
  winnerId = 0;

  get finished(): boolean {
    return this.phase === PHASE_MATCH_END;
  }

  start(_world: WorldView): void {
    this.phase = PHASE_WARMUP;
    this.timeLeft = WARMUP_SECONDS;
  }

  tick(world: WorldView, dt: number): void {
    switch (this.phase) {
      case PHASE_WARMUP:
        this.timeLeft -= dt;
        if (this.timeLeft <= 0) {
          this.phase = PHASE_LIVE;
          this.timeLeft = DM_TIME_LIMIT;
          this.respawnAll(world);
        }
        break;
      case PHASE_LIVE:
        this.timeLeft = Math.max(0, this.timeLeft - dt);
        if (this.scores[0] >= TDM_KILL_LIMIT || this.scores[1] >= TDM_KILL_LIMIT || this.timeLeft <= 0) {
          this.winnerTeam = this.scores[0] >= this.scores[1] ? TEAM_A : TEAM_B;
          this.phase = PHASE_MATCH_END;
          this.timeLeft = MATCH_END_SECONDS;
        }
        break;
      default:
        break;
    }
    world.frozen = this.phase !== PHASE_LIVE;
  }

  private respawnAll(world: WorldView): void {
    for (const p of world.players.values()) world.respawn(p.id, this.pickSpawn(world, p.team));
    world.events.push({ type: EV_ROUND, state: ROUND_START, winner: 0, round: 0 });
  }

  onKill(world: WorldView, killer: PlayerState | null, victim: PlayerState): void {
    victim.deaths++;
    if (killer && killer.id !== victim.id) {
      killer.kills++;
      if (killer.team !== victim.team) {
        const idx = killer.team === TEAM_A ? 0 : 1;
        this.scores[idx]++;
      }
    }
    victim.respawnTick = world.tick + Math.round(RESPAWN_DELAY / TICK_DT);
  }

  onPlayerJoin(world: WorldView, player: PlayerState): void {
    if (this.phase === PHASE_LIVE) world.respawn(player.id, this.pickSpawn(world, player.team));
  }

  onPlayerLeave(): void {}

  canRespawn(world: WorldView, player: PlayerState): boolean {
    return !player.alive && world.tick >= player.respawnTick;
  }

  pickSpawn(world: WorldView, team: number): SpawnChoice {
    return pickSpawnFrom(world, world.colliders.spawnsFor(team), (p) => p.team !== team);
  }

  interact(_world: WorldView, player: PlayerState): void {
    player.interactT = 0;
  }

  isEnemy(a: PlayerState, b: PlayerState): boolean {
    return a.team !== b.team;
  }

  assignTeam(world: WorldView): number {
    return assignSmallerTeam(world);
  }

  result(world: WorldView): MatchResult {
    return { winnerTeam: this.winnerTeam, winnerId: 0, players: buildResultPlayers(world) };
  }
}

// ---------------------------------------------------------------------------
// Search & Destroy: one life per round, plant/defuse, first to SND_ROUNDS_TO_WIN.
// ---------------------------------------------------------------------------
export class SndRules implements ModeRules {
  readonly mode = MODE_SND;
  readonly teamBased = true;
  phase = PHASE_LOBBY;
  timeLeft = 0;
  scores: [number, number] = [0, 0];
  round = 0;
  roundsWon: [number, number] = [0, 0];
  bomb: BombState = newBomb();
  winnerTeam = TEAM_NONE;
  winnerId = 0;

  private attackingTeam = TEAM_A;
  private defendingTeam = TEAM_B;

  get finished(): boolean {
    return this.phase === PHASE_MATCH_END;
  }

  start(_world: WorldView): void {
    this.phase = PHASE_WARMUP;
    this.timeLeft = WARMUP_SECONDS;
    this.round = 0;
    this.roundsWon = [0, 0];
    this.scores = [0, 0];
  }

  tick(world: WorldView, dt: number): void {
    switch (this.phase) {
      case PHASE_WARMUP:
        this.timeLeft -= dt;
        if (this.timeLeft <= 0) this.beginRound(world);
        break;
      case PHASE_FREEZE:
        this.timeLeft -= dt;
        if (this.timeLeft <= 0) {
          this.phase = PHASE_LIVE;
          this.timeLeft = SND_ROUND_SECONDS;
        }
        break;
      case PHASE_LIVE:
        this.tickLive(world, dt);
        break;
      case PHASE_ROUND_END:
        this.timeLeft -= dt;
        if (this.timeLeft <= 0) {
          if (this.roundsWon[0] >= SND_ROUNDS_TO_WIN || this.roundsWon[1] >= SND_ROUNDS_TO_WIN || this.round >= SND_MAX_ROUNDS) {
            this.finishMatch();
          } else {
            this.beginRound(world);
          }
        }
        break;
      default:
        break;
    }
    world.frozen = this.phase !== PHASE_LIVE;
  }

  private tickLive(world: WorldView, dt: number): void {
    this.timeLeft = Math.max(0, this.timeLeft - dt);
    if (this.bomb.state === BOMB_PLANTED) {
      this.bomb.timer -= dt;
      if (this.bomb.timer <= 0) this.detonate(world);
      return;
    }
    const attackersAlive = countAliveTeam(world, this.attackingTeam);
    const defendersAlive = countAliveTeam(world, this.defendingTeam);
    if (attackersAlive === 0) { this.endRound(world, this.defendingTeam); return; }
    if (defendersAlive === 0) { this.endRound(world, this.attackingTeam); return; }
    if (this.timeLeft <= 0) { this.endRound(world, this.defendingTeam); return; }
  }

  private beginRound(world: WorldView): void {
    this.round++;
    this.attackingTeam = this.round <= SND_SWAP_AFTER ? TEAM_A : TEAM_B;
    this.defendingTeam = this.attackingTeam === TEAM_A ? TEAM_B : TEAM_A;
    this.bomb.state = BOMB_NONE;
    this.bomb.site = -1;
    this.bomb.timer = 0;
    this.bomb.carrier = 0;
    this.bomb.pos.x = 0; this.bomb.pos.y = 0; this.bomb.pos.z = 0;

    const attackerIds: number[] = [];
    for (const p of world.players.values()) {
      p.interactT = 0;
      p.interactSite = -1;
      if (p.connState === CONN_WAITING_ROUND || p.connState === CONN_SPECTATING) p.connState = CONN_ACTIVE;
      world.respawn(p.id, this.pickSpawn(world, p.team));
      if (p.team === this.attackingTeam) attackerIds.push(p.id);
    }
    if (attackerIds.length > 0) {
      const idx = Math.floor(world.rng() * attackerIds.length);
      this.bomb.carrier = attackerIds[idx]!;
      this.bomb.state = BOMB_CARRIED;
    }

    this.phase = PHASE_FREEZE;
    this.timeLeft = SND_FREEZE_SECONDS;
    world.events.push({ type: EV_ROUND, state: ROUND_START, winner: 0, round: this.round });
  }

  private endRound(world: WorldView, winningTeam: number): void {
    const idx = winningTeam === TEAM_A ? 0 : 1;
    this.roundsWon[idx]++;
    this.scores[idx] = this.roundsWon[idx];
    this.phase = PHASE_ROUND_END;
    this.timeLeft = SND_ROUND_END_SECONDS;
    world.events.push({ type: EV_ROUND, state: ROUND_END, winner: winningTeam, round: this.round });
  }

  private detonate(world: WorldView): void {
    this.bomb.state = BOMB_EXPLODED;
    for (const p of world.players.values()) {
      if (!p.alive) continue;
      const dx = p.pos.x - this.bomb.pos.x;
      const dy = p.pos.y - this.bomb.pos.y;
      const dz = p.pos.z - this.bomb.pos.z;
      if (dx * dx + dy * dy + dz * dz <= BOMB_KILL_RADIUS * BOMB_KILL_RADIUS) {
        world.kill(p.id, 0, KILL_BOMB, false);
      }
    }
    this.endRound(world, this.attackingTeam);
  }

  private finishMatch(): void {
    this.winnerTeam = this.roundsWon[0] > this.roundsWon[1] ? TEAM_A : TEAM_B;
    this.phase = PHASE_MATCH_END;
    this.timeLeft = MATCH_END_SECONDS;
  }

  onKill(_world: WorldView, killer: PlayerState | null, victim: PlayerState): void {
    victim.deaths++;
    if (killer && killer.id !== victim.id) killer.kills++;
    if (this.bomb.state === BOMB_CARRIED && this.bomb.carrier === victim.id) {
      this.bomb.state = BOMB_DROPPED;
      this.bomb.pos.x = victim.pos.x; this.bomb.pos.y = victim.pos.y; this.bomb.pos.z = victim.pos.z;
      this.bomb.carrier = 0;
    }
  }

  onPlayerJoin(_world: WorldView, player: PlayerState): void {
    if (this.phase === PHASE_LOBBY || this.phase === PHASE_WARMUP) return;
    // A round is in progress: the joiner spectates until the next round start.
    player.connState = CONN_WAITING_ROUND;
  }

  onPlayerLeave(): void {}

  canRespawn(): boolean {
    // One life per round; the next life comes from beginRound(), not a timer.
    return false;
  }

  pickSpawn(world: WorldView, team: number): SpawnChoice {
    return pickSpawnFrom(world, world.colliders.spawnsFor(team), (p) => p.team !== team);
  }

  interact(world: WorldView, player: PlayerState, dt: number): void {
    if (this.phase !== PHASE_LIVE) { player.interactT = 0; return; }

    if (this.bomb.state === BOMB_CARRIED && this.bomb.carrier === player.id) {
      const site = siteUnderPlayer(world, player);
      if (site === -1) { player.interactT = 0; player.interactSite = -1; return; }
      player.interactSite = site;
      player.interactT += dt;
      if (player.interactT >= SND_PLANT_TIME) this.completePlant(world, player, site);
      return;
    }

    if (this.bomb.state === BOMB_PLANTED && player.team === this.defendingTeam) {
      const site = siteUnderPlayer(world, player);
      if (site !== this.bomb.site) { player.interactT = 0; return; }
      player.interactT += dt;
      if (player.interactT >= SND_DEFUSE_TIME) this.completeDefuse(world, player);
      return;
    }

    player.interactT = 0;
  }

  private completePlant(world: WorldView, player: PlayerState, site: number): void {
    this.bomb.state = BOMB_PLANTED;
    this.bomb.site = site;
    this.bomb.timer = SND_BOMB_FUSE;
    this.bomb.carrier = 0;
    this.bomb.pos.x = player.pos.x; this.bomb.pos.y = player.pos.y; this.bomb.pos.z = player.pos.z;
    player.interactT = 0;
    world.events.push({ type: EV_PLANT, site, player: player.id });
  }

  private completeDefuse(world: WorldView, player: PlayerState): void {
    this.bomb.state = BOMB_DEFUSED;
    player.interactT = 0;
    world.events.push({ type: EV_DEFUSE, site: this.bomb.site, player: player.id });
    this.endRound(world, this.defendingTeam);
  }

  isEnemy(a: PlayerState, b: PlayerState): boolean {
    return a.team !== b.team;
  }

  assignTeam(world: WorldView): number {
    return assignSmallerTeam(world);
  }

  result(world: WorldView): MatchResult {
    return { winnerTeam: this.winnerTeam, winnerId: 0, players: buildResultPlayers(world) };
  }
}

/** MODE_ANY and any unrecognized id fall back to FFA. */
export function createRules(mode: number): FfaRules | TdmRules | SndRules {
  switch (mode) {
    case MODE_TDM: return new TdmRules();
    case MODE_SND: return new SndRules();
    case MODE_FFA:
    default:
      return new FfaRules();
  }
}
