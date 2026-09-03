// Binary wire protocol. First byte of every frame is a MSG_* id; everything is
// little-endian through DataView. No JSON on the hot path. Pure TypeScript:
// works identically in Node, the browser and tests.

import {
  MAX_CHAT_LEN,
  MAX_NAME_LEN,
  PITCH_SCALE,
  ROOM_CODE_LEN,
  TIME_SCALE,
  TWO_PI,
  UNIT_DIR_SCALE,
  VEL_SCALE,
  YAW_SCALE,
  EV_FIRE,
  EV_HIT,
  EV_KILL,
  EV_IMPACT,
  EV_EXPLODE,
  EV_FLASHED,
  EV_PLANT,
  EV_DEFUSE,
  EV_ROUND,
  EV_RESPAWN,
  EV_THROW,
  EV_MELEE,
  EV_RELOAD,
  EV_BOMB_PICKUP,
} from './constants.ts';
import {
  createInputCmd,
  createPlayerState,
  createProjectileState,
  createSnapshot,
  createSnapshotPlayer,
  defaultLoadout,
  vec3,
} from './types.ts';
import type {
  ChatMsg,
  GameEvent,
  HelloMsg,
  InputCmd,
  LobbyCmd,
  LobbyPlayer,
  Loadout,
  LocalStateBlock,
  MatchResult,
  Message,
  PlayerState,
  ProjectileState,
  RoomState,
  Snapshot,
  SnapshotPlayer,
  Vec3,
  WelcomeMsg,
} from './types.ts';

// ---------------------------------------------------------------------------
// Message ids
// ---------------------------------------------------------------------------
export const MSG_HELLO = 1;
export const MSG_WELCOME = 2;
export const MSG_INPUT = 3;
export const MSG_SNAPSHOT = 4;
export const MSG_PING = 5;
export const MSG_PONG = 6;
export const MSG_LOADOUT = 7;
export const MSG_ROOM_STATE = 8;
export const MSG_MATCH_END = 9;
export const MSG_CHAT = 10;
export const MSG_LOBBY_CMD = 11;
export const MSG_ERROR = 12;

// ---------------------------------------------------------------------------
// Quantization helpers (exported so tests and the client agree exactly)
// ---------------------------------------------------------------------------
export function wrapYaw(yaw: number): number {
  let y = yaw % TWO_PI;
  if (y < 0) y += TWO_PI;
  return y;
}
export function quantYaw(yaw: number): number {
  return Math.round(wrapYaw(yaw) * YAW_SCALE) & 0xffff;
}
export function dequantYaw(q: number): number {
  return q / YAW_SCALE;
}
export function quantPitch(pitch: number): number {
  const p = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));
  return Math.round(p * PITCH_SCALE);
}
export function dequantPitch(q: number): number {
  return q / PITCH_SCALE;
}
export function quantVel(v: number): number {
  return Math.max(-32767, Math.min(32767, Math.round(v * VEL_SCALE)));
}
export function dequantVel(q: number): number {
  return q / VEL_SCALE;
}
export function quantUnit(v: number): number {
  return Math.max(-127, Math.min(127, Math.round(v * UNIT_DIR_SCALE)));
}
export function dequantUnit(q: number): number {
  return q / UNIT_DIR_SCALE;
}
export function quantTenths(seconds: number): number {
  return Math.max(0, Math.min(65535, Math.round(seconds * TIME_SCALE)));
}
export function dequantTenths(q: number): number {
  return q / TIME_SCALE;
}
function u8clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}
function i8clamp(v: number): number {
  return Math.max(-128, Math.min(127, Math.round(v)));
}
function u16clamp(v: number): number {
  return Math.max(0, Math.min(65535, Math.round(v)));
}

// ---------------------------------------------------------------------------
// Writer / Reader
// ---------------------------------------------------------------------------
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class Writer {
  private buf: ArrayBuffer;
  private view: DataView;
  private bytes: Uint8Array;
  pos = 0;

  constructor(capacity = 512) {
    this.buf = new ArrayBuffer(capacity);
    this.view = new DataView(this.buf);
    this.bytes = new Uint8Array(this.buf);
  }

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.byteLength) return;
    let cap = this.buf.byteLength * 2;
    while (cap < this.pos + n) cap *= 2;
    const nb = new ArrayBuffer(cap);
    new Uint8Array(nb).set(this.bytes.subarray(0, this.pos));
    this.buf = nb;
    this.view = new DataView(nb);
    this.bytes = new Uint8Array(nb);
  }

  u8(v: number): void { this.ensure(1); this.view.setUint8(this.pos, v & 0xff); this.pos += 1; }
  i8(v: number): void { this.ensure(1); this.view.setInt8(this.pos, v); this.pos += 1; }
  u16(v: number): void { this.ensure(2); this.view.setUint16(this.pos, v & 0xffff, true); this.pos += 2; }
  i16(v: number): void { this.ensure(2); this.view.setInt16(this.pos, v, true); this.pos += 2; }
  u32(v: number): void { this.ensure(4); this.view.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  i32(v: number): void { this.ensure(4); this.view.setInt32(this.pos, v | 0, true); this.pos += 4; }
  f32(v: number): void { this.ensure(4); this.view.setFloat32(this.pos, v, true); this.pos += 4; }
  bool(v: boolean): void { this.u8(v ? 1 : 0); }
  vec3f(v: Vec3): void { this.f32(v.x); this.f32(v.y); this.f32(v.z); }
  vel(v: Vec3): void { this.i16(quantVel(v.x)); this.i16(quantVel(v.y)); this.i16(quantVel(v.z)); }
  unit(v: Vec3): void { this.i8(quantUnit(v.x)); this.i8(quantUnit(v.y)); this.i8(quantUnit(v.z)); }

  /** u8 byte length + UTF-8 bytes, truncated to maxBytes (<= 255). */
  str(s: string, maxBytes = 255): void {
    let enc = textEncoder.encode(s);
    if (enc.byteLength > maxBytes) enc = enc.subarray(0, maxBytes);
    this.u8(enc.byteLength);
    this.ensure(enc.byteLength);
    this.bytes.set(enc, this.pos);
    this.pos += enc.byteLength;
  }

  /** Fixed-width ASCII, space padded. */
  ascii(s: string, n: number): void {
    this.ensure(n);
    for (let i = 0; i < n; i++) {
      const c = i < s.length ? s.charCodeAt(i) & 0x7f : 0x20;
      this.view.setUint8(this.pos + i, c);
    }
    this.pos += n;
  }

  /** Returns a tight copy of the written bytes. */
  finish(): Uint8Array {
    return this.bytes.slice(0, this.pos);
  }
}

export class Reader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  pos = 0;

  constructor(data: Uint8Array) {
    this.bytes = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining(): number { return this.bytes.byteLength - this.pos; }
  u8(): number { const v = this.view.getUint8(this.pos); this.pos += 1; return v; }
  i8(): number { const v = this.view.getInt8(this.pos); this.pos += 1; return v; }
  u16(): number { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16(): number { const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u32(): number { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  i32(): number { const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  f32(): number { const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
  bool(): boolean { return this.u8() !== 0; }
  vec3f(out: Vec3): Vec3 { out.x = this.f32(); out.y = this.f32(); out.z = this.f32(); return out; }
  vel(out: Vec3): Vec3 { out.x = dequantVel(this.i16()); out.y = dequantVel(this.i16()); out.z = dequantVel(this.i16()); return out; }
  unit(out: Vec3): Vec3 { out.x = dequantUnit(this.i8()); out.y = dequantUnit(this.i8()); out.z = dequantUnit(this.i8()); return out; }

  str(): string {
    const n = this.u8();
    const s = textDecoder.decode(this.bytes.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }

  ascii(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.view.getUint8(this.pos + i));
    this.pos += n;
    return s.trim();
  }
}

export function peekMessageId(data: Uint8Array): number {
  return data.byteLength > 0 ? data[0]! : 0;
}

// ---------------------------------------------------------------------------
// HELLO / WELCOME
// ---------------------------------------------------------------------------
export function encodeHello(h: HelloMsg): Uint8Array {
  const w = new Writer(64);
  w.u8(MSG_HELLO);
  w.u8(h.protocolVersion);
  w.str(h.name, MAX_NAME_LEN * 4);
  w.ascii(h.roomCode, ROOM_CODE_LEN);
  w.u8(h.mode);
  w.u8(h.wantBots);
  w.u8(h.rejoinId);
  return w.finish();
}

export function decodeHello(r: Reader): HelloMsg {
  return {
    protocolVersion: r.u8(),
    name: r.str(),
    roomCode: r.ascii(ROOM_CODE_LEN),
    mode: r.u8(),
    wantBots: r.u8(),
    rejoinId: r.u8(),
  };
}

export function encodeWelcome(m: WelcomeMsg): Uint8Array {
  const w = new Writer(32);
  w.u8(MSG_WELCOME);
  w.u8(m.playerId);
  w.u32(m.serverTick);
  w.ascii(m.roomCode, ROOM_CODE_LEN);
  w.u8(m.mode);
  w.u8(m.mapId);
  w.u8(m.teamId);
  w.u8(m.connState);
  return w.finish();
}

export function decodeWelcome(r: Reader): WelcomeMsg {
  return {
    playerId: r.u8(),
    serverTick: r.u32(),
    roomCode: r.ascii(ROOM_CODE_LEN),
    mode: r.u8(),
    mapId: r.u8(),
    teamId: r.u8(),
    connState: r.u8(),
  };
}

// ---------------------------------------------------------------------------
// INPUT
// ---------------------------------------------------------------------------
export const INPUT_CMD_BYTES = 17;

export function encodeInput(cmds: readonly InputCmd[]): Uint8Array {
  const w = new Writer(2 + cmds.length * INPUT_CMD_BYTES);
  w.u8(MSG_INPUT);
  w.u8(cmds.length);
  for (const c of cmds) {
    w.u32(c.seq);
    w.u32(c.tick);
    w.i8(i8clamp(c.moveX * 127));
    w.i8(i8clamp(c.moveY * 127));
    w.u16(quantYaw(c.yaw));
    w.i16(quantPitch(c.pitch));
    w.u16(c.buttons);
    w.u8(c.weaponSlot);
  }
  return w.finish();
}

export function decodeInput(r: Reader): InputCmd[] {
  const n = r.u8();
  const out: InputCmd[] = [];
  for (let i = 0; i < n; i++) {
    const c = createInputCmd();
    c.seq = r.u32();
    c.tick = r.u32();
    c.moveX = r.i8() / 127;
    c.moveY = r.i8() / 127;
    c.yaw = dequantYaw(r.u16());
    c.pitch = dequantPitch(r.i16());
    c.buttons = r.u16();
    c.weaponSlot = r.u8();
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// PING / PONG
// ---------------------------------------------------------------------------
export function encodePing(clientTimeMs: number): Uint8Array {
  const w = new Writer(8);
  w.u8(MSG_PING);
  w.u32(clientTimeMs);
  return w.finish();
}

export function encodePong(clientTimeMs: number, serverTick: number): Uint8Array {
  const w = new Writer(12);
  w.u8(MSG_PONG);
  w.u32(clientTimeMs);
  w.u32(serverTick);
  return w.finish();
}

// ---------------------------------------------------------------------------
// LOADOUT
// ---------------------------------------------------------------------------
function writeLoadout(w: Writer, l: Loadout): void {
  w.u8(l.primary);
  w.u8(l.secondary);
  w.u8(l.lethal);
  w.u8(l.tactical);
  w.u8(l.perk1);
  w.u8(l.perk2);
}

function readLoadout(r: Reader): Loadout {
  const l = defaultLoadout();
  l.primary = r.u8();
  l.secondary = r.u8();
  l.lethal = r.u8();
  l.tactical = r.u8();
  l.perk1 = r.u8();
  l.perk2 = r.u8();
  return l;
}

export function encodeLoadout(l: Loadout): Uint8Array {
  const w = new Writer(8);
  w.u8(MSG_LOADOUT);
  writeLoadout(w, l);
  return w.finish();
}

// ---------------------------------------------------------------------------
// SNAPSHOT
// ---------------------------------------------------------------------------
export const SNAPSHOT_PLAYER_BYTES = 30;

function packPlayerFlags(p: SnapshotPlayer): number {
  return (
    (p.alive ? 1 : 0) |
    ((p.team & 3) << 1) |
    ((p.stance & 3) << 3) |
    ((p.moveState & 15) << 5) |
    ((p.ads ? 1 : 0) << 9) |
    ((p.mounted ? 1 : 0) << 10) |
    ((p.reloading ? 1 : 0) << 11) |
    ((p.firing ? 1 : 0) << 12) |
    ((p.flashed ? 1 : 0) << 13) |
    ((p.hit ? 1 : 0) << 14) |
    ((p.isBot ? 1 : 0) << 15)
  );
}

function unpackPlayerFlags(f: number, p: SnapshotPlayer): void {
  p.alive = (f & 1) !== 0;
  p.team = (f >> 1) & 3;
  p.stance = (f >> 3) & 3;
  p.moveState = (f >> 5) & 15;
  p.ads = ((f >> 9) & 1) !== 0;
  p.mounted = ((f >> 10) & 1) !== 0;
  p.reloading = ((f >> 11) & 1) !== 0;
  p.firing = ((f >> 12) & 1) !== 0;
  p.flashed = ((f >> 13) & 1) !== 0;
  p.hit = ((f >> 14) & 1) !== 0;
  p.isBot = ((f >> 15) & 1) !== 0;
}

function writeSnapshotPlayer(w: Writer, p: SnapshotPlayer): void {
  w.u8(p.id);
  w.u16(packPlayerFlags(p));
  w.vec3f(p.pos);
  w.vel(p.vel);
  w.u16(quantYaw(p.yaw));
  w.i16(quantPitch(p.pitch));
  w.u8(u8clamp(p.health));
  w.u8(p.weapon);
  w.u8(u8clamp(p.mag));
  w.u8(u8clamp(p.reserve));
  w.u8(p.animId);
}

function readSnapshotPlayer(r: Reader): SnapshotPlayer {
  const p = createSnapshotPlayer();
  p.id = r.u8();
  unpackPlayerFlags(r.u16(), p);
  r.vec3f(p.pos);
  r.vel(p.vel);
  p.yaw = dequantYaw(r.u16());
  p.pitch = dequantPitch(r.i16());
  p.health = r.u8();
  p.weapon = r.u8();
  p.mag = r.u8();
  p.reserve = r.u8();
  p.animId = r.u8();
  return p;
}

function writeProjectile(w: Writer, p: ProjectileState): void {
  w.u16(p.id);
  w.u8(p.kind);
  w.u8(p.owner);
  w.u8(p.team);
  w.vec3f(p.pos);
  w.vel(p.vel);
  w.u8(u8clamp(p.fuse * TIME_SCALE));
  w.u8(p.resting ? 1 : 0);
}

function readProjectile(r: Reader): ProjectileState {
  const id = r.u16();
  const kind = r.u8();
  const owner = r.u8();
  const team = r.u8();
  const p = createProjectileState(id, kind, owner, team);
  r.vec3f(p.pos);
  r.vel(p.vel);
  p.fuse = r.u8() / TIME_SCALE;
  p.resting = r.u8() !== 0;
  return p;
}

function writeEvent(w: Writer, e: GameEvent): void {
  w.u8(e.type);
  switch (e.type) {
    case EV_FIRE:
      w.u8(e.shooter); w.u8(e.weapon); w.vec3f(e.origin); w.unit(e.dir);
      break;
    case EV_HIT:
      w.u8(e.target); w.u8(e.attacker); w.u8(e.zone); w.u8(u8clamp(e.damage));
      break;
    case EV_KILL:
      w.u8(e.killer); w.u8(e.victim); w.u8(e.weapon); w.u8(e.headshot ? 1 : 0);
      break;
    case EV_IMPACT:
      w.vec3f(e.pos); w.unit(e.normal); w.u8(e.material);
      break;
    case EV_EXPLODE:
      w.vec3f(e.pos); w.u8(e.kind);
      break;
    case EV_FLASHED:
      w.u8(e.victim); w.u8(u8clamp(e.strength * 255));
      break;
    case EV_PLANT:
    case EV_DEFUSE:
      w.u8(e.site); w.u8(e.player);
      break;
    case EV_ROUND:
      w.u8(e.state); w.u8(e.winner); w.u8(e.round);
      break;
    case EV_RESPAWN:
    case EV_MELEE:
    case EV_RELOAD:
    case EV_BOMB_PICKUP:
      w.u8(e.player);
      break;
    case EV_THROW:
      w.u8(e.player); w.u8(e.kind);
      break;
  }
}

function readEvent(r: Reader): GameEvent | null {
  const type = r.u8();
  switch (type) {
    case EV_FIRE: {
      const shooter = r.u8(); const weapon = r.u8();
      const origin = r.vec3f(vec3()); const dir = r.unit(vec3());
      return { type: EV_FIRE, shooter, weapon, origin, dir };
    }
    case EV_HIT: {
      const target = r.u8(); const attacker = r.u8(); const zone = r.u8(); const damage = r.u8();
      return { type: EV_HIT, target, attacker, zone, damage };
    }
    case EV_KILL: {
      const killer = r.u8(); const victim = r.u8(); const weapon = r.u8(); const headshot = r.u8() !== 0;
      return { type: EV_KILL, killer, victim, weapon, headshot };
    }
    case EV_IMPACT: {
      const pos = r.vec3f(vec3()); const normal = r.unit(vec3()); const material = r.u8();
      return { type: EV_IMPACT, pos, normal, material };
    }
    case EV_EXPLODE: {
      const pos = r.vec3f(vec3()); const kind = r.u8();
      return { type: EV_EXPLODE, pos, kind };
    }
    case EV_FLASHED: {
      const victim = r.u8(); const strength = r.u8() / 255;
      return { type: EV_FLASHED, victim, strength };
    }
    case EV_PLANT: {
      const site = r.u8(); const player = r.u8();
      return { type: EV_PLANT, site, player };
    }
    case EV_DEFUSE: {
      const site = r.u8(); const player = r.u8();
      return { type: EV_DEFUSE, site, player };
    }
    case EV_ROUND: {
      const state = r.u8(); const winner = r.u8(); const round = r.u8();
      return { type: EV_ROUND, state, winner, round };
    }
    case EV_RESPAWN: return { type: EV_RESPAWN, player: r.u8() };
    case EV_MELEE: return { type: EV_MELEE, player: r.u8() };
    case EV_RELOAD: return { type: EV_RELOAD, player: r.u8() };
    case EV_BOMB_PICKUP: return { type: EV_BOMB_PICKUP, player: r.u8() };
    case EV_THROW: {
      const player = r.u8(); const kind = r.u8();
      return { type: EV_THROW, player, kind };
    }
    default:
      return null;
  }
}

function writeLocalBlock(w: Writer, s: LocalStateBlock): void {
  w.vec3f(s.pos); w.vec3f(s.vel); w.f32(s.yaw); w.f32(s.pitch);
  w.u8(s.stance); w.f32(s.stanceT); w.f32(s.height); w.u8(s.moveState); w.f32(s.stateT);
  w.bool(s.onGround); w.u8(s.groundMaterial); w.f32(s.fallStartY);
  w.f32(s.sprintT); w.f32(s.tacT); w.f32(s.tacCooldown); w.f32(s.sprintOutT); w.f32(s.landingT);
  w.f32(s.slideDirX); w.f32(s.slideDirZ);
  w.vec3f(s.mantleFrom); w.vec3f(s.mantleTo); w.f32(s.mantleT); w.f32(s.mantleDuration);
  w.bool(s.mounted); w.f32(s.mountNX); w.f32(s.mountNZ); w.f32(s.mountLean); w.f32(s.footstepDist);
  w.bool(s.ads); w.f32(s.adsT);
  w.f32(s.health); w.bool(s.alive); w.u32(s.deathTick); w.u32(s.lastDamageTick); w.u32(s.respawnTick);
  for (let i = 0; i < 2; i++) { w.u8(s.slots[i]!.weapon); w.u16(s.slots[i]!.mag); w.u16(s.slots[i]!.reserve); }
  w.u8(s.activeSlot); w.f32(s.swapT); w.u8(s.swapTo); w.f32(s.reloadT); w.f32(s.reloadTotal);
  w.f32(s.fireCooldown); w.u16(s.shotIndex); w.u32(s.lastFireTick); w.bool(s.firing); w.u16(s.lastButtons);
  w.u8(s.lethalCount); w.u8(s.tacticalCount); w.f32(s.cookT); w.i8(s.throwKind); w.f32(s.meleeT);
  w.f32(s.interactT); w.i8(s.interactSite);
  w.f32(s.flashT); w.f32(s.flashStrength); w.f32(s.hitT);
  w.u8(s.connState); w.u8(s.perks[0]); w.u8(s.perks[1]); w.u8(s.lethal); w.u8(s.tactical); w.u8(s.team);
}

function readLocalBlock(r: Reader): LocalStateBlock {
  const s = createPlayerState(0, '', 0);
  r.vec3f(s.pos); r.vec3f(s.vel); s.yaw = r.f32(); s.pitch = r.f32();
  s.stance = r.u8(); s.stanceT = r.f32(); s.height = r.f32(); s.moveState = r.u8(); s.stateT = r.f32();
  s.onGround = r.bool(); s.groundMaterial = r.u8(); s.fallStartY = r.f32();
  s.sprintT = r.f32(); s.tacT = r.f32(); s.tacCooldown = r.f32(); s.sprintOutT = r.f32(); s.landingT = r.f32();
  s.slideDirX = r.f32(); s.slideDirZ = r.f32();
  r.vec3f(s.mantleFrom); r.vec3f(s.mantleTo); s.mantleT = r.f32(); s.mantleDuration = r.f32();
  s.mounted = r.bool(); s.mountNX = r.f32(); s.mountNZ = r.f32(); s.mountLean = r.f32(); s.footstepDist = r.f32();
  s.ads = r.bool(); s.adsT = r.f32();
  s.health = r.f32(); s.alive = r.bool(); s.deathTick = r.u32(); s.lastDamageTick = r.u32(); s.respawnTick = r.u32();
  for (let i = 0; i < 2; i++) { s.slots[i]!.weapon = r.u8(); s.slots[i]!.mag = r.u16(); s.slots[i]!.reserve = r.u16(); }
  s.activeSlot = r.u8(); s.swapT = r.f32(); s.swapTo = r.u8(); s.reloadT = r.f32(); s.reloadTotal = r.f32();
  s.fireCooldown = r.f32(); s.shotIndex = r.u16(); s.lastFireTick = r.u32(); s.firing = r.bool(); s.lastButtons = r.u16();
  s.lethalCount = r.u8(); s.tacticalCount = r.u8(); s.cookT = r.f32(); s.throwKind = r.i8(); s.meleeT = r.f32();
  s.interactT = r.f32(); s.interactSite = r.i8();
  s.flashT = r.f32(); s.flashStrength = r.f32(); s.hitT = r.f32();
  s.connState = r.u8(); s.perks[0] = r.u8(); s.perks[1] = r.u8(); s.lethal = r.u8(); s.tactical = r.u8(); s.team = r.u8();
  return s;
}

/** Copy the resimulation fields of a local block onto a full PlayerState. */
export function applyLocalBlock(dst: PlayerState, src: LocalStateBlock): void {
  dst.pos.x = src.pos.x; dst.pos.y = src.pos.y; dst.pos.z = src.pos.z;
  dst.vel.x = src.vel.x; dst.vel.y = src.vel.y; dst.vel.z = src.vel.z;
  dst.yaw = src.yaw; dst.pitch = src.pitch;
  dst.stance = src.stance; dst.stanceT = src.stanceT; dst.height = src.height; dst.moveState = src.moveState; dst.stateT = src.stateT;
  dst.onGround = src.onGround; dst.groundMaterial = src.groundMaterial; dst.fallStartY = src.fallStartY;
  dst.sprintT = src.sprintT; dst.tacT = src.tacT; dst.tacCooldown = src.tacCooldown; dst.sprintOutT = src.sprintOutT; dst.landingT = src.landingT;
  dst.slideDirX = src.slideDirX; dst.slideDirZ = src.slideDirZ;
  dst.mantleFrom.x = src.mantleFrom.x; dst.mantleFrom.y = src.mantleFrom.y; dst.mantleFrom.z = src.mantleFrom.z;
  dst.mantleTo.x = src.mantleTo.x; dst.mantleTo.y = src.mantleTo.y; dst.mantleTo.z = src.mantleTo.z;
  dst.mantleT = src.mantleT; dst.mantleDuration = src.mantleDuration;
  dst.mounted = src.mounted; dst.mountNX = src.mountNX; dst.mountNZ = src.mountNZ; dst.mountLean = src.mountLean; dst.footstepDist = src.footstepDist;
  dst.ads = src.ads; dst.adsT = src.adsT;
  dst.health = src.health; dst.alive = src.alive; dst.deathTick = src.deathTick; dst.lastDamageTick = src.lastDamageTick; dst.respawnTick = src.respawnTick;
  for (let i = 0; i < 2; i++) { dst.slots[i]!.weapon = src.slots[i]!.weapon; dst.slots[i]!.mag = src.slots[i]!.mag; dst.slots[i]!.reserve = src.slots[i]!.reserve; }
  dst.activeSlot = src.activeSlot; dst.swapT = src.swapT; dst.swapTo = src.swapTo; dst.reloadT = src.reloadT; dst.reloadTotal = src.reloadTotal;
  dst.fireCooldown = src.fireCooldown; dst.shotIndex = src.shotIndex; dst.lastFireTick = src.lastFireTick; dst.firing = src.firing; dst.lastButtons = src.lastButtons;
  dst.lethalCount = src.lethalCount; dst.tacticalCount = src.tacticalCount; dst.cookT = src.cookT; dst.throwKind = src.throwKind; dst.meleeT = src.meleeT;
  dst.interactT = src.interactT; dst.interactSite = src.interactSite;
  dst.flashT = src.flashT; dst.flashStrength = src.flashStrength; dst.hitT = src.hitT;
  dst.connState = src.connState; dst.perks[0] = src.perks[0]; dst.perks[1] = src.perks[1]; dst.lethal = src.lethal; dst.tactical = src.tactical; dst.team = src.team;
}

export function encodeSnapshot(s: Snapshot): Uint8Array {
  const w = new Writer(64 + s.players.length * SNAPSHOT_PLAYER_BYTES + s.projectiles.length * 24 + s.events.length * 20 + (s.local ? 256 : 0));
  w.u8(MSG_SNAPSHOT);
  w.u32(s.tick);
  w.u32(s.lastAckSeq);
  w.u8(s.phase);
  w.u16(quantTenths(s.timeLeft));
  w.i16(s.scores[0]);
  w.i16(s.scores[1]);
  w.u8(s.bombState);
  w.u16(quantTenths(s.bombTimer));
  w.u8(s.players.length);
  for (const p of s.players) writeSnapshotPlayer(w, p);
  w.u8(s.projectiles.length);
  for (const p of s.projectiles) writeProjectile(w, p);
  w.u8(Math.min(255, s.events.length));
  for (let i = 0; i < Math.min(255, s.events.length); i++) writeEvent(w, s.events[i]!);
  if (s.local) {
    w.u8(1);
    writeLocalBlock(w, s.local);
  } else {
    w.u8(0);
  }
  return w.finish();
}

export function decodeSnapshot(r: Reader): Snapshot {
  const s = createSnapshot();
  s.tick = r.u32();
  s.lastAckSeq = r.u32();
  s.phase = r.u8();
  s.timeLeft = dequantTenths(r.u16());
  s.scores[0] = r.i16();
  s.scores[1] = r.i16();
  s.bombState = r.u8();
  s.bombTimer = dequantTenths(r.u16());
  const np = r.u8();
  for (let i = 0; i < np; i++) s.players.push(readSnapshotPlayer(r));
  const nj = r.u8();
  for (let i = 0; i < nj; i++) s.projectiles.push(readProjectile(r));
  const ne = r.u8();
  for (let i = 0; i < ne; i++) {
    const e = readEvent(r);
    if (e) s.events.push(e);
  }
  s.local = r.u8() ? readLocalBlock(r) : null;
  return s;
}

// ---------------------------------------------------------------------------
// ROOM_STATE / MATCH_END / CHAT / LOBBY_CMD / ERROR
// ---------------------------------------------------------------------------
export function encodeRoomState(rs: RoomState): Uint8Array {
  const w = new Writer(64 + rs.players.length * 40);
  w.u8(MSG_ROOM_STATE);
  w.ascii(rs.code, ROOM_CODE_LEN);
  w.u8(rs.phase);
  w.u8(rs.mode);
  w.u8(rs.mapId);
  w.u8(rs.hostId);
  w.u8(rs.round);
  w.u8(rs.roundsWon[0]);
  w.u8(rs.roundsWon[1]);
  w.u16(quantTenths(rs.timeLeft));
  w.u8(rs.bombState);
  w.u8(rs.bombSite);
  w.u16(quantTenths(rs.bombTimer));
  w.u8(rs.bombCarrier);
  w.u8(rs.botCount);
  w.u8(rs.botDifficulty);
  w.u8(rs.maxPlayers);
  w.u8(rs.players.length);
  for (const p of rs.players) {
    w.u8(p.id);
    w.u8(p.team);
    w.str(p.name, MAX_NAME_LEN * 4);
    w.u16(u16clamp(p.kills));
    w.u16(u16clamp(p.deaths));
    w.u16(u16clamp(p.score));
    w.u8(u8clamp(p.ping));
    w.u8(p.isBot ? 1 : 0);
    w.u8(p.connState);
    writeLoadout(w, p.loadout);
  }
  return w.finish();
}

export function decodeRoomState(r: Reader): RoomState {
  const rs: RoomState = {
    code: r.ascii(ROOM_CODE_LEN),
    phase: r.u8(),
    mode: r.u8(),
    mapId: r.u8(),
    hostId: r.u8(),
    round: r.u8(),
    roundsWon: [0, 0],
    timeLeft: 0,
    players: [],
    bombState: 0,
    bombSite: 0,
    bombTimer: 0,
    bombCarrier: 0,
    botCount: 0,
    botDifficulty: 0,
    maxPlayers: 0,
  };
  rs.roundsWon[0] = r.u8();
  rs.roundsWon[1] = r.u8();
  rs.timeLeft = dequantTenths(r.u16());
  rs.bombState = r.u8();
  rs.bombSite = r.u8();
  rs.bombTimer = dequantTenths(r.u16());
  rs.bombCarrier = r.u8();
  rs.botCount = r.u8();
  rs.botDifficulty = r.u8();
  rs.maxPlayers = r.u8();
  const n = r.u8();
  for (let i = 0; i < n; i++) {
    const p: LobbyPlayer = {
      id: r.u8(),
      team: r.u8(),
      name: r.str(),
      kills: r.u16(),
      deaths: r.u16(),
      score: r.u16(),
      ping: r.u8(),
      isBot: r.u8() !== 0,
      connState: r.u8(),
      loadout: readLoadout(r),
    };
    rs.players.push(p);
  }
  return rs;
}

export function encodeMatchEnd(m: MatchResult): Uint8Array {
  const w = new Writer(16 + m.players.length * 32);
  w.u8(MSG_MATCH_END);
  w.u8(m.winnerTeam);
  w.u8(m.winnerId);
  w.u8(m.players.length);
  for (const p of m.players) {
    w.u8(p.id);
    w.str(p.name, MAX_NAME_LEN * 4);
    w.u8(p.team);
    w.u16(u16clamp(p.kills));
    w.u16(u16clamp(p.deaths));
    w.u16(u16clamp(p.score));
  }
  return w.finish();
}

export function decodeMatchEnd(r: Reader): MatchResult {
  const m: MatchResult = { winnerTeam: r.u8(), winnerId: r.u8(), players: [] };
  const n = r.u8();
  for (let i = 0; i < n; i++) {
    m.players.push({ id: r.u8(), name: r.str(), team: r.u8(), kills: r.u16(), deaths: r.u16(), score: r.u16() });
  }
  return m;
}

export function encodeChat(c: ChatMsg): Uint8Array {
  const w = new Writer(8 + MAX_CHAT_LEN * 4);
  w.u8(MSG_CHAT);
  w.u8(c.from);
  w.str(c.text, MAX_CHAT_LEN * 4);
  return w.finish();
}

export function encodeLobbyCmd(c: LobbyCmd): Uint8Array {
  const w = new Writer(4);
  w.u8(MSG_LOBBY_CMD);
  w.u8(c.action);
  w.u8(c.value);
  return w.finish();
}

export function encodeError(code: number, message: string): Uint8Array {
  const w = new Writer(8 + message.length * 4);
  w.u8(MSG_ERROR);
  w.u8(code);
  w.str(message, 200);
  return w.finish();
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
/** Decode any frame. Returns null for unknown ids or malformed frames. */
export function decodeMessage(data: Uint8Array): Message | null {
  if (data.byteLength === 0) return null;
  const r = new Reader(data);
  const id = r.u8();
  try {
    switch (id) {
      case MSG_HELLO: return { kind: 'hello', hello: decodeHello(r) };
      case MSG_WELCOME: return { kind: 'welcome', welcome: decodeWelcome(r) };
      case MSG_INPUT: return { kind: 'input', cmds: decodeInput(r) };
      case MSG_SNAPSHOT: return { kind: 'snapshot', snapshot: decodeSnapshot(r) };
      case MSG_PING: return { kind: 'ping', clientTimeMs: r.u32() };
      case MSG_PONG: { const t = r.u32(); const tick = r.u32(); return { kind: 'pong', clientTimeMs: t, serverTick: tick }; }
      case MSG_LOADOUT: return { kind: 'loadout', loadout: readLoadout(r) };
      case MSG_ROOM_STATE: return { kind: 'roomState', roomState: decodeRoomState(r) };
      case MSG_MATCH_END: return { kind: 'matchEnd', result: decodeMatchEnd(r) };
      case MSG_CHAT: { const from = r.u8(); const text = r.str(); return { kind: 'chat', chat: { from, text } }; }
      case MSG_LOBBY_CMD: { const action = r.u8(); const value = r.u8(); return { kind: 'lobbyCmd', cmd: { action, value } }; }
      case MSG_ERROR: { const code = r.u8(); const message = r.str(); return { kind: 'error', code, message }; }
      default: return null;
    }
  } catch {
    return null;
  }
}
