// Simulation-side contracts between modules built by different agents:
// movement (stepPlayer) ↔ world, weapon stepping ↔ world/prediction,
// world ↔ mode rules ↔ room ↔ bots. Pure TypeScript.

import type { GameEvent, InputCmd, MatchResult, PlayerState, ProjectileState, Vec3 } from '../types.ts';
import type { MapColliders, NavGrid } from '../map/types.ts';

// ---------------------------------------------------------------------------
// Events emitted by the pure step functions (reset by the caller each tick)
// ---------------------------------------------------------------------------
export interface MovementEvents {
  jumped: boolean;
  /** Vertical impact speed on landing (0 = no landing this tick). */
  landedSpeed: number;
  /** Fall damage to apply this tick (0 = none). */
  fallDamage: number;
  /** MAT_* of a footstep this tick, or -1. */
  footstepMaterial: number;
  slideStarted: boolean;
  slideCancelled: boolean;
  mantleStarted: boolean;
  mountedChanged: boolean;
  stanceChanged: boolean;
  /** True when the player fell below the kill plane. */
  fellOut: boolean;
}

export function createMovementEvents(): MovementEvents {
  return {
    jumped: false,
    landedSpeed: 0,
    fallDamage: 0,
    footstepMaterial: -1,
    slideStarted: false,
    slideCancelled: false,
    mantleStarted: false,
    mountedChanged: false,
    stanceChanged: false,
    fellOut: false,
  };
}

export function resetMovementEvents(e: MovementEvents): void {
  e.jumped = false;
  e.landedSpeed = 0;
  e.fallDamage = 0;
  e.footstepMaterial = -1;
  e.slideStarted = false;
  e.slideCancelled = false;
  e.mantleStarted = false;
  e.mountedChanged = false;
  e.stanceChanged = false;
  e.fellOut = false;
}

export interface WeaponEvents {
  /** Number of shots fired this tick (shotguns fire one shot of many pellets). */
  shots: number;
  /** Weapon id that fired. */
  firedWeapon: number;
  reloadStarted: boolean;
  reloadFinished: boolean;
  /** Swap completed this tick (new active slot is in state). */
  swapped: boolean;
  dryFire: boolean;
  meleeStarted: boolean;
  /** True on the tick the melee hit window resolves (World does the hit test). */
  meleeHit: boolean;
  /** PROJ_* thrown this tick, or -1. */
  threwKind: number;
  cookStarted: boolean;
}

export function createWeaponEvents(): WeaponEvents {
  return {
    shots: 0,
    firedWeapon: 0,
    reloadStarted: false,
    reloadFinished: false,
    swapped: false,
    dryFire: false,
    meleeStarted: false,
    meleeHit: false,
    threwKind: -1,
    cookStarted: false,
  };
}

export function resetWeaponEvents(e: WeaponEvents): void {
  e.shots = 0;
  e.firedWeapon = 0;
  e.reloadStarted = false;
  e.reloadFinished = false;
  e.swapped = false;
  e.dryFire = false;
  e.meleeStarted = false;
  e.meleeHit = false;
  e.threwKind = -1;
  e.cookStarted = false;
}

/** Signature of shared/movement.ts#stepPlayer. */
export type StepPlayerFn = (
  state: PlayerState,
  cmd: InputCmd,
  colliders: MapColliders,
  dt: number,
  out: MovementEvents,
) => void;

/** Signature of shared/sim/weaponstate.ts#stepWeapon. */
export type StepWeaponFn = (state: PlayerState, cmd: InputCmd, dt: number, out: WeaponEvents) => void;

// ---------------------------------------------------------------------------
// World ↔ modes ↔ room ↔ bots
// ---------------------------------------------------------------------------
export interface SpawnChoice {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface BombState {
  /** BOMB_* */
  state: number;
  /** Site id (0/1) when planted, else -1. */
  site: number;
  /** Seconds until detonation when planted, else 0. */
  timer: number;
  /** Carrier player id, or 0. */
  carrier: number;
  /** World position when dropped or planted. */
  pos: Vec3;
}

/**
 * The public surface of shared/sim/world.ts#World that mode rules, bots and
 * the room use. World implements this interface.
 */
export interface WorldView {
  readonly tick: number;
  readonly colliders: MapColliders;
  readonly nav: NavGrid;
  readonly players: Map<number, PlayerState>;
  readonly projectiles: ProjectileState[];
  /** Events produced this tick; Room drains them into snapshots. */
  readonly events: GameEvent[];
  /** Deterministic RNG in [0,1). */
  readonly rng: () => number;
  /** When true nothing moves or fires (S&D freeze, match end). */
  frozen: boolean;
  /** Set by Room; World uses it for friendly-fire and win logic. */
  rules: ModeRules;
  respawn(id: number, spawn: SpawnChoice): void;
  /** Applies damage with zone multipliers already applied; handles death, events and scoring via rules.onKill. */
  damage(targetId: number, amount: number, attackerId: number, zone: number, weapon: number): void;
  /** Instant kill (melee, bomb, fall). */
  kill(victimId: number, killerId: number, weapon: number, headshot: boolean): void;
  hasLineOfSight(a: Vec3, b: Vec3): boolean;
  /** Eye position of a player (pos + eye height for stance). */
  eyePos(p: PlayerState, out: Vec3): Vec3;
  /** Spawn a grenade projectile. */
  spawnProjectile(kind: number, owner: number, team: number, pos: Vec3, vel: Vec3, fuse: number): ProjectileState;
}

/**
 * Match rules strategy owned by Room. One instance per match. Everything here
 * is deterministic given the world; no clocks.
 */
export interface ModeRules {
  readonly mode: number;
  readonly teamBased: boolean;
  /** PHASE_* */
  phase: number;
  /** Seconds left in the current phase. */
  timeLeft: number;
  scores: [number, number];
  round: number;
  roundsWon: [number, number];
  bomb: BombState;
  /** Set when the match is decided (TEAM_* or a player id in FFA). */
  winnerTeam: number;
  winnerId: number;

  /** Called once when the host starts the match (players already in the world). */
  start(world: WorldView): void;
  /** Called every tick after world.step(); drives phases, timers, win conditions, respawns. */
  tick(world: WorldView, dt: number): void;
  onKill(world: WorldView, killer: PlayerState | null, victim: PlayerState, weapon: number, headshot: boolean): void;
  onPlayerJoin(world: WorldView, player: PlayerState): void;
  onPlayerLeave(world: WorldView, player: PlayerState): void;
  /** May the (dead) player respawn now? */
  canRespawn(world: WorldView, player: PlayerState): boolean;
  pickSpawn(world: WorldView, team: number): SpawnChoice;
  /** Called per tick for players holding INTERACT (plant/defuse). */
  interact(world: WorldView, player: PlayerState, dt: number): void;
  isEnemy(a: PlayerState, b: PlayerState): boolean;
  /** Team assignment for a joining player. */
  assignTeam(world: WorldView): number;
  result(world: WorldView): MatchResult;
  /** True once phase is PHASE_MATCH_END. */
  readonly finished: boolean;
}

export interface BotBrainLike {
  readonly id: number;
  think(world: WorldView, rules: ModeRules, tick: number): InputCmd;
}
