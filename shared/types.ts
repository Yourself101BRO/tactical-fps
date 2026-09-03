// Every state shape shared by the simulation, protocol, server and client.
// Pure TypeScript: no DOM, no three.js, no clocks. Numbers only in the state
// objects so they can be copied field by field for prediction buffers.

import {
  CONN_ACTIVE,
  HEALTH_MAX,
  HEIGHT_STAND,
  LETHAL_FRAG,
  MOVE_IDLE,
  PERK_NONE,
  SLOT_PRIMARY,
  STANCE_STAND,
  TACTICAL_FLASH,
  WEAPON_AR,
  WEAPON_PISTOL,
} from './constants.ts';

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
export interface InputCmd {
  /** Monotonic per client (u32). */
  seq: number;
  /** The client's estimated server tick when the input was sampled (u32). */
  tick: number;
  /** Strafe axis, right positive, in [-1, 1]. */
  moveX: number;
  /** Forward axis, forward positive, in [-1, 1]. */
  moveY: number;
  /** Radians in [0, 2π). 0 faces -Z; increases turning left (three.js convention). */
  yaw: number;
  /** Radians in [-π/2, π/2], up positive. */
  pitch: number;
  /** BTN_* bitmask (u16). */
  buttons: number;
  /** Desired active weapon slot, 0 or 1. */
  weaponSlot: number;
}

export function createInputCmd(): InputCmd {
  return { seq: 0, tick: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0, buttons: 0, weaponSlot: 0 };
}

export function copyInputCmd(dst: InputCmd, src: InputCmd): InputCmd {
  dst.seq = src.seq;
  dst.tick = src.tick;
  dst.moveX = src.moveX;
  dst.moveY = src.moveY;
  dst.yaw = src.yaw;
  dst.pitch = src.pitch;
  dst.buttons = src.buttons;
  dst.weaponSlot = src.weaponSlot;
  return dst;
}

// ---------------------------------------------------------------------------
// Loadout, lobby, room
// ---------------------------------------------------------------------------
export interface Loadout {
  primary: number;
  secondary: number;
  lethal: number;
  tactical: number;
  perk1: number;
  perk2: number;
}

export function defaultLoadout(): Loadout {
  return {
    primary: WEAPON_AR,
    secondary: WEAPON_PISTOL,
    lethal: LETHAL_FRAG,
    tactical: TACTICAL_FLASH,
    perk1: PERK_NONE,
    perk2: PERK_NONE,
  };
}

export interface HelloMsg {
  protocolVersion: number;
  name: string;
  /** 4 characters from ROOM_CODE_ALPHABET, or '' to let the host create one. */
  roomCode: string;
  /** MODE_* requested when creating a room; MODE_ANY when joining. */
  mode: number;
  /** Requested bot count when creating a room (0..MAX_PLAYERS-1). */
  wantBots: number;
  /** Previous player id when reconnecting within REJOIN_GRACE_MS, else 0. */
  rejoinId: number;
}

export interface WelcomeMsg {
  playerId: number;
  serverTick: number;
  roomCode: string;
  mode: number;
  mapId: number;
  teamId: number;
  /** CONN_* */
  connState: number;
}

export interface LobbyPlayer {
  id: number;
  team: number;
  name: string;
  kills: number;
  deaths: number;
  score: number;
  /** Round-trip in ms, capped to 255. */
  ping: number;
  isBot: boolean;
  /** CONN_* */
  connState: number;
  loadout: Loadout;
}

export interface RoomState {
  code: string;
  /** PHASE_* */
  phase: number;
  mode: number;
  mapId: number;
  hostId: number;
  round: number;
  roundsWon: [number, number];
  /** Seconds left in the current phase. */
  timeLeft: number;
  players: LobbyPlayer[];
  /** BOMB_* */
  bombState: number;
  bombSite: number;
  bombTimer: number;
  /** Bomb carrier id or 0. */
  bombCarrier: number;
  botCount: number;
  botDifficulty: number;
  maxPlayers: number;
}

export interface MatchResultPlayer {
  id: number;
  name: string;
  team: number;
  kills: number;
  deaths: number;
  score: number;
}

export interface MatchResult {
  /** TEAM_A / TEAM_B, or the winning player id in FFA (team field is TEAM_NONE). */
  winnerTeam: number;
  winnerId: number;
  players: MatchResultPlayer[];
}

export interface ChatMsg {
  from: number;
  text: string;
}

// ---------------------------------------------------------------------------
// Simulation state
// ---------------------------------------------------------------------------
export interface WeaponSlotState {
  /** WEAPON_* or WEAPON_NONE. */
  weapon: number;
  mag: number;
  reserve: number;
}

/**
 * The authoritative per-player state. Movement, weapon stepping, prediction
 * and lag compensation all read and write this one shape. Everything that the
 * client must be able to resimulate lives here and is sent in the snapshot's
 * local block (see LocalStateBlock), so keep fields numeric/boolean.
 */
export interface PlayerState {
  id: number;
  team: number;
  name: string;
  isBot: boolean;
  /** CONN_* */
  connState: number;
  perks: [number, number];
  lethal: number;
  tactical: number;

  // --- kinematics ---
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;

  // --- stance and movement state machine ---
  /** STANCE_* the body is in or moving toward. */
  stance: number;
  /** 0..1 progress of the current stance transition (1 = settled). */
  stanceT: number;
  /** Current capsule height (interpolates between stance heights). */
  height: number;
  /** MOVE_* */
  moveState: number;
  /** Seconds spent in the current moveState. */
  stateT: number;
  onGround: boolean;
  /** MAT_* under the feet, for footsteps. */
  groundMaterial: number;
  /** Y at which the current fall began, for fall damage. */
  fallStartY: number;
  /** Seconds sprinting (any kind). */
  sprintT: number;
  /** Remaining tactical sprint seconds. */
  tacT: number;
  /** Remaining tactical sprint cooldown seconds. */
  tacCooldown: number;
  /** Seconds until the weapon is ready after sprinting. */
  sprintOutT: number;
  /** Remaining landing slow-down seconds. */
  landingT: number;
  slideDirX: number;
  slideDirZ: number;
  mantleFrom: Vec3;
  mantleTo: Vec3;
  mantleT: number;
  mantleDuration: number;
  mounted: boolean;
  /** Unit normal of the mounted edge (XZ). */
  mountNX: number;
  mountNZ: number;
  /** Lean offset along the edge in metres, [-MOUNT_LEAN, MOUNT_LEAN]. */
  mountLean: number;
  /** Footstep phase accumulator in metres travelled. */
  footstepDist: number;

  // --- aiming ---
  ads: boolean;
  /** 0..1 aim-down-sight blend. */
  adsT: number;

  // --- health ---
  health: number;
  alive: boolean;
  deathTick: number;
  lastDamageTick: number;
  respawnTick: number;

  // --- weapons ---
  slots: [WeaponSlotState, WeaponSlotState];
  activeSlot: number;
  /** Remaining swap seconds (0 = not swapping). */
  swapT: number;
  swapTo: number;
  /** Remaining reload seconds (0 = not reloading). */
  reloadT: number;
  reloadTotal: number;
  /** Seconds until the next shot may fire. */
  fireCooldown: number;
  /** Consecutive shots for the recoil pattern; resets after a pause. */
  shotIndex: number;
  lastFireTick: number;
  /** True on ticks in which a shot was fired. */
  firing: boolean;
  /** Buttons from the previous command, for edge detection. */
  lastButtons: number;

  // --- equipment ---
  lethalCount: number;
  tacticalCount: number;
  /** Seconds the lethal has been cooked (0 = not holding). */
  cookT: number;
  /** PROJ_* being thrown, or -1. */
  throwKind: number;
  /** Remaining melee seconds (0 = idle). */
  meleeT: number;
  /** Plant/defuse progress in seconds. */
  interactT: number;
  interactSite: number;

  // --- status ---
  /** Remaining flash blindness seconds. */
  flashT: number;
  flashStrength: number;
  /** Remaining seconds the "hit" flag stays up for animation. */
  hitT: number;

  // --- score and net bookkeeping ---
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  lastAppliedSeq: number;
  lastInputTick: number;
  ping: number;
}

export function createPlayerState(id: number, name: string, team: number, isBot = false): PlayerState {
  return {
    id,
    team,
    name,
    isBot,
    connState: CONN_ACTIVE,
    perks: [PERK_NONE, PERK_NONE],
    lethal: LETHAL_FRAG,
    tactical: TACTICAL_FLASH,
    pos: vec3(),
    vel: vec3(),
    yaw: 0,
    pitch: 0,
    stance: STANCE_STAND,
    stanceT: 1,
    height: HEIGHT_STAND,
    moveState: MOVE_IDLE,
    stateT: 0,
    onGround: true,
    groundMaterial: 0,
    fallStartY: 0,
    sprintT: 0,
    tacT: 0,
    tacCooldown: 0,
    sprintOutT: 0,
    landingT: 0,
    slideDirX: 0,
    slideDirZ: 0,
    mantleFrom: vec3(),
    mantleTo: vec3(),
    mantleT: 0,
    mantleDuration: 0,
    mounted: false,
    mountNX: 0,
    mountNZ: 0,
    mountLean: 0,
    footstepDist: 0,
    ads: false,
    adsT: 0,
    health: HEALTH_MAX,
    alive: false,
    deathTick: 0,
    lastDamageTick: 0,
    respawnTick: 0,
    slots: [
      { weapon: WEAPON_AR, mag: 0, reserve: 0 },
      { weapon: WEAPON_PISTOL, mag: 0, reserve: 0 },
    ],
    activeSlot: SLOT_PRIMARY,
    swapT: 0,
    swapTo: SLOT_PRIMARY,
    reloadT: 0,
    reloadTotal: 0,
    fireCooldown: 0,
    shotIndex: 0,
    lastFireTick: 0,
    firing: false,
    lastButtons: 0,
    lethalCount: 0,
    tacticalCount: 0,
    cookT: 0,
    throwKind: -1,
    meleeT: 0,
    interactT: 0,
    interactSite: -1,
    flashT: 0,
    flashStrength: 0,
    hitT: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    score: 0,
    lastAppliedSeq: 0,
    lastInputTick: 0,
    ping: 0,
  };
}

/** Field-by-field copy without allocation (Vec3s are copied by value). */
export function copyPlayerState(dst: PlayerState, src: PlayerState): PlayerState {
  dst.id = src.id;
  dst.team = src.team;
  dst.name = src.name;
  dst.isBot = src.isBot;
  dst.connState = src.connState;
  dst.perks[0] = src.perks[0];
  dst.perks[1] = src.perks[1];
  dst.lethal = src.lethal;
  dst.tactical = src.tactical;
  dst.pos.x = src.pos.x; dst.pos.y = src.pos.y; dst.pos.z = src.pos.z;
  dst.vel.x = src.vel.x; dst.vel.y = src.vel.y; dst.vel.z = src.vel.z;
  dst.yaw = src.yaw;
  dst.pitch = src.pitch;
  dst.stance = src.stance;
  dst.stanceT = src.stanceT;
  dst.height = src.height;
  dst.moveState = src.moveState;
  dst.stateT = src.stateT;
  dst.onGround = src.onGround;
  dst.groundMaterial = src.groundMaterial;
  dst.fallStartY = src.fallStartY;
  dst.sprintT = src.sprintT;
  dst.tacT = src.tacT;
  dst.tacCooldown = src.tacCooldown;
  dst.sprintOutT = src.sprintOutT;
  dst.landingT = src.landingT;
  dst.slideDirX = src.slideDirX;
  dst.slideDirZ = src.slideDirZ;
  dst.mantleFrom.x = src.mantleFrom.x; dst.mantleFrom.y = src.mantleFrom.y; dst.mantleFrom.z = src.mantleFrom.z;
  dst.mantleTo.x = src.mantleTo.x; dst.mantleTo.y = src.mantleTo.y; dst.mantleTo.z = src.mantleTo.z;
  dst.mantleT = src.mantleT;
  dst.mantleDuration = src.mantleDuration;
  dst.mounted = src.mounted;
  dst.mountNX = src.mountNX;
  dst.mountNZ = src.mountNZ;
  dst.mountLean = src.mountLean;
  dst.footstepDist = src.footstepDist;
  dst.ads = src.ads;
  dst.adsT = src.adsT;
  dst.health = src.health;
  dst.alive = src.alive;
  dst.deathTick = src.deathTick;
  dst.lastDamageTick = src.lastDamageTick;
  dst.respawnTick = src.respawnTick;
  for (let i = 0; i < 2; i++) {
    dst.slots[i]!.weapon = src.slots[i]!.weapon;
    dst.slots[i]!.mag = src.slots[i]!.mag;
    dst.slots[i]!.reserve = src.slots[i]!.reserve;
  }
  dst.activeSlot = src.activeSlot;
  dst.swapT = src.swapT;
  dst.swapTo = src.swapTo;
  dst.reloadT = src.reloadT;
  dst.reloadTotal = src.reloadTotal;
  dst.fireCooldown = src.fireCooldown;
  dst.shotIndex = src.shotIndex;
  dst.lastFireTick = src.lastFireTick;
  dst.firing = src.firing;
  dst.lastButtons = src.lastButtons;
  dst.lethalCount = src.lethalCount;
  dst.tacticalCount = src.tacticalCount;
  dst.cookT = src.cookT;
  dst.throwKind = src.throwKind;
  dst.meleeT = src.meleeT;
  dst.interactT = src.interactT;
  dst.interactSite = src.interactSite;
  dst.flashT = src.flashT;
  dst.flashStrength = src.flashStrength;
  dst.hitT = src.hitT;
  dst.kills = src.kills;
  dst.deaths = src.deaths;
  dst.assists = src.assists;
  dst.score = src.score;
  dst.lastAppliedSeq = src.lastAppliedSeq;
  dst.lastInputTick = src.lastInputTick;
  dst.ping = src.ping;
  return dst;
}

export function clonePlayerState(src: PlayerState): PlayerState {
  return copyPlayerState(createPlayerState(src.id, src.name, src.team, src.isBot), src);
}

export interface ProjectileState {
  /** u16 */
  id: number;
  /** PROJ_* */
  kind: number;
  owner: number;
  team: number;
  pos: Vec3;
  vel: Vec3;
  /** Remaining seconds. */
  fuse: number;
  /** True once it has come to rest. */
  resting: boolean;
}

export function createProjectileState(id: number, kind: number, owner: number, team: number): ProjectileState {
  return { id, kind, owner, team, pos: vec3(), vel: vec3(), fuse: 0, resting: false };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------
/** Compact per-player view sent to everyone (30 bytes on the wire). */
export interface SnapshotPlayer {
  id: number;
  team: number;
  isBot: boolean;
  alive: boolean;
  stance: number;
  moveState: number;
  ads: boolean;
  mounted: boolean;
  reloading: boolean;
  firing: boolean;
  flashed: boolean;
  hit: boolean;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  health: number;
  weapon: number;
  mag: number;
  reserve: number;
  /** Free byte for the animation layer (e.g. one-shot ids); 0 = none. */
  animId: number;
}

export function createSnapshotPlayer(): SnapshotPlayer {
  return {
    id: 0,
    team: 0,
    isBot: false,
    alive: false,
    stance: 0,
    moveState: 0,
    ads: false,
    mounted: false,
    reloading: false,
    firing: false,
    flashed: false,
    hit: false,
    pos: vec3(),
    vel: vec3(),
    yaw: 0,
    pitch: 0,
    health: 0,
    weapon: 0,
    mag: 0,
    reserve: 0,
    animId: 0,
  };
}

export function copySnapshotPlayer(dst: SnapshotPlayer, src: SnapshotPlayer): SnapshotPlayer {
  dst.id = src.id; dst.team = src.team; dst.isBot = src.isBot; dst.alive = src.alive;
  dst.stance = src.stance; dst.moveState = src.moveState; dst.ads = src.ads; dst.mounted = src.mounted;
  dst.reloading = src.reloading; dst.firing = src.firing; dst.flashed = src.flashed; dst.hit = src.hit;
  dst.pos.x = src.pos.x; dst.pos.y = src.pos.y; dst.pos.z = src.pos.z;
  dst.vel.x = src.vel.x; dst.vel.y = src.vel.y; dst.vel.z = src.vel.z;
  dst.yaw = src.yaw; dst.pitch = src.pitch; dst.health = src.health; dst.weapon = src.weapon;
  dst.mag = src.mag; dst.reserve = src.reserve; dst.animId = src.animId;
  return dst;
}

/**
 * The full resimulation state of the recipient's own player, sent only to that
 * player inside its snapshot. Prediction adopts this and replays unacked inputs.
 */
export type LocalStateBlock = Pick<
  PlayerState,
  | 'pos' | 'vel' | 'yaw' | 'pitch'
  | 'stance' | 'stanceT' | 'height' | 'moveState' | 'stateT' | 'onGround' | 'groundMaterial' | 'fallStartY'
  | 'sprintT' | 'tacT' | 'tacCooldown' | 'sprintOutT' | 'landingT' | 'slideDirX' | 'slideDirZ'
  | 'mantleFrom' | 'mantleTo' | 'mantleT' | 'mantleDuration'
  | 'mounted' | 'mountNX' | 'mountNZ' | 'mountLean' | 'footstepDist'
  | 'ads' | 'adsT'
  | 'health' | 'alive' | 'deathTick' | 'lastDamageTick' | 'respawnTick'
  | 'slots' | 'activeSlot' | 'swapT' | 'swapTo' | 'reloadT' | 'reloadTotal' | 'fireCooldown' | 'shotIndex' | 'lastFireTick' | 'firing' | 'lastButtons'
  | 'lethalCount' | 'tacticalCount' | 'cookT' | 'throwKind' | 'meleeT' | 'interactT' | 'interactSite'
  | 'flashT' | 'flashStrength' | 'hitT'
  | 'connState' | 'perks' | 'lethal' | 'tactical' | 'team'
>;

// Snapshot events. `type` is an EV_* constant.
export type GameEvent =
  | { type: 0; shooter: number; weapon: number; origin: Vec3; dir: Vec3 }
  | { type: 1; target: number; attacker: number; zone: number; damage: number }
  | { type: 2; killer: number; victim: number; weapon: number; headshot: boolean }
  | { type: 3; pos: Vec3; normal: Vec3; material: number }
  | { type: 4; pos: Vec3; kind: number }
  | { type: 5; victim: number; strength: number }
  | { type: 6; site: number; player: number }
  | { type: 7; site: number; player: number }
  | { type: 8; state: number; winner: number; round: number }
  | { type: 9; player: number }
  | { type: 10; player: number; kind: number }
  | { type: 11; player: number }
  | { type: 12; player: number }
  | { type: 13; player: number };

export interface Snapshot {
  tick: number;
  /** Highest input seq the server has applied for the recipient. */
  lastAckSeq: number;
  /** PHASE_* */
  phase: number;
  /** Seconds left in the current phase. */
  timeLeft: number;
  scores: [number, number];
  /** BOMB_* */
  bombState: number;
  /** Seconds until the bomb explodes (0 when not planted). */
  bombTimer: number;
  players: SnapshotPlayer[];
  projectiles: ProjectileState[];
  events: GameEvent[];
  /** Present only in the recipient's own snapshot. */
  local: LocalStateBlock | null;
}

export function createSnapshot(): Snapshot {
  return {
    tick: 0,
    lastAckSeq: 0,
    phase: 0,
    timeLeft: 0,
    scores: [0, 0],
    bombState: 0,
    bombTimer: 0,
    players: [],
    projectiles: [],
    events: [],
    local: null,
  };
}

// ---------------------------------------------------------------------------
// Decoded message union (what Room and ClientNet switch on)
// ---------------------------------------------------------------------------
export type Message =
  | { kind: 'hello'; hello: HelloMsg }
  | { kind: 'welcome'; welcome: WelcomeMsg }
  | { kind: 'input'; cmds: InputCmd[] }
  | { kind: 'snapshot'; snapshot: Snapshot }
  | { kind: 'ping'; clientTimeMs: number }
  | { kind: 'pong'; clientTimeMs: number; serverTick: number }
  | { kind: 'loadout'; loadout: Loadout }
  | { kind: 'roomState'; roomState: RoomState }
  | { kind: 'matchEnd'; result: MatchResult }
  | { kind: 'chat'; chat: ChatMsg }
  | { kind: 'lobbyCmd'; cmd: LobbyCmd }
  | { kind: 'error'; code: number; message: string };

/** Host-only lobby controls sent by the room host. */
export interface LobbyCmd {
  /** LOBBY_* */
  action: number;
  value: number;
}

export const LOBBY_START = 0;
export const LOBBY_SET_MODE = 1;
export const LOBBY_SET_BOTS = 2;
export const LOBBY_SET_BOT_DIFFICULTY = 3;
export const LOBBY_SET_TEAM = 4;
export const LOBBY_KICK = 5;
export const LOBBY_BACK_TO_LOBBY = 6;

export const ERR_BAD_VERSION = 1;
export const ERR_ROOM_FULL = 2;
export const ERR_ROOM_NOT_FOUND = 3;
export const ERR_BAD_NAME = 4;
export const ERR_KICKED = 5;
