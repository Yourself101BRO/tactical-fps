// The authoritative simulation. Owns every player's PlayerState, all live
// projectiles, static-map lag compensation, and turns raw InputCmds into
// movement + weapon state + hitscan/melee/grenade resolution + damage/kill/
// respawn/scoring. Pure TypeScript: no DOM, no three.js, no Date.now() (Room
// passes `dt`, always TICK_DT per the networking contract).
//
// Input queueing (documented choice): `applyInput` inserts each accepted cmd
// into a per-player FIFO capped at MAX_PENDING_CMDS (4), kept sorted by seq
// (the transport does not guarantee order) and de-duplicated against both
// `lastAppliedSeq` (already simulated) and `lastQueuedSeq` (already queued,
// so INPUT's redundant resends of the same cmd are cheap no-ops). Each
// `step(dt)` drains every queued cmd for a player, running stepPlayer +
// stepWeapon once per cmd at the given `dt` — so a burst of N cmds delivered
// in the same world tick (network jitter bunching them up) performs N full
// sub-steps, keeping the player's own per-client-tick pacing correct instead
// of permanently falling behind. When nothing is queued (a tick with no new
// input, e.g. a dropped packet), the last cmd actually applied is re-stepped
// once as a repeat. Because the *same* cmd object is reused for a repeat,
// `cmd.buttons` is unchanged from the previous tick, and since movement/
// weapon stepping key edge-triggered actions (jump, reload, swap, melee,
// throw, semi-auto fire) off `state.lastButtons` vs `cmd.buttons`, a repeat
// naturally cannot re-trigger an edge action — it only continues whatever was
// already held (sprint, ADS, full-auto fire under its own cooldown, etc.).

import type {
  GameEvent,
  InputCmd,
  Loadout,
  PlayerState,
  ProjectileState,
  Snapshot,
  Vec3,
} from '../types.ts';
import {
  copyInputCmd,
  createInputCmd,
  createPlayerState,
  createSnapshot,
  createSnapshotPlayer,
  defaultLoadout,
} from '../types.ts';
import type { MapColliders, MapLayout, NavGrid, RayHit } from '../map/types.ts';
import type { ModeRules, MovementEvents, SpawnChoice, WeaponEvents, WorldView } from './types.ts';
import { createMovementEvents, createWeaponEvents, resetMovementEvents, resetWeaponEvents } from './types.ts';
import { buildColliders, buildNavGrid } from '../map/colliders.ts';
import { eyeHeight, stepPlayer } from '../movement.ts';
import { activeWeaponDef, giveLoadout, isReloading, stepWeapon } from './weaponstate.ts';
import type { WeaponDef } from '../weapons.ts';
import { damageAt, pelletDirs, recoilAt, spreadFor } from '../weapons.ts';
import { regenDelayFor } from '../perks.ts';
import { clamp, mulberry32, wrapAngle, yawPitchToDir } from '../math.ts';
import { HitHistory } from './lagcomp.ts';
import type { PlayerHit } from './lagcomp.ts';
import { explode, stepProjectile } from './grenades.ts';
import {
  EV_FIRE,
  EV_HIT,
  EV_IMPACT,
  EV_KILL,
  EV_MELEE,
  EV_RELOAD,
  EV_RESPAWN,
  EV_THROW,
  FLASH_FUSE,
  FLASH_THROW_SPEED,
  FLINCH_PITCH_DEG,
  FLINCH_YAW_DEG,
  FRAG_FUSE,
  FRAG_THROW_SPEED,
  GRENADES_PER_LIFE,
  HEALTH_MAX,
  HEIGHT_STAND,
  INTERP_TICKS,
  KILL_FALL,
  KILL_MELEE,
  LAGCOMP_HISTORY_TICKS,
  MELEE_RANGE,
  MOVE_IDLE,
  PLAYER_RADIUS,
  PROJ_FLASH,
  PROJ_FRAG,
  REGEN_RATE,
  SLOT_PRIMARY,
  STANCE_STAND,
  ZONE_HEAD,
  ZONE_LIMB,
} from '../constants.ts';

// ---------------------------------------------------------------------------
// Local constants: geometry/engineering numbers not covered by shared/constants.ts.
// ---------------------------------------------------------------------------
/** Longest a hitscan ray needs to reach on the ~90x70 m Compound map (with margin). */
const MAX_SHOT_DIST = 300;
/** How long PlayerState.hitT stays up for client hit-reaction animation. */
const HIT_FLASH_TIME = 0.15;
/** Melee forward cone half-angle (plan: "within 60° in front"). */
const MELEE_CONE_COS = Math.cos((60 * Math.PI) / 180);
const MAX_PENDING_CMDS = 4;
const MAX_PELLETS = 16;
const DEG2RAD = Math.PI / 180;
const HALF_PI = Math.PI / 2;

// ---------------------------------------------------------------------------
// Per-player bookkeeping that is not part of the network-visible PlayerState.
// ---------------------------------------------------------------------------
interface PlayerRuntime {
  /** Sorted (by seq) FIFO of accepted-but-not-yet-simulated commands. */
  pending: InputCmd[];
  pendingCount: number;
  /** Highest seq ever accepted into the queue (dedupe against redundant resends). */
  lastQueuedSeq: number;
  /** Last command actually stepped; reused verbatim to repeat a tick with no new input. */
  lastCmd: InputCmd;
  hasLastCmd: boolean;
}

function createRuntime(): PlayerRuntime {
  const pending: InputCmd[] = [];
  for (let i = 0; i < MAX_PENDING_CMDS; i++) pending.push(createInputCmd());
  return { pending, pendingCount: 0, lastQueuedSeq: 0, lastCmd: createInputCmd(), hasLastCmd: false };
}

export class World implements WorldView {
  readonly colliders: MapColliders;
  readonly nav: NavGrid;
  readonly players = new Map<number, PlayerState>();
  readonly projectiles: ProjectileState[] = [];
  readonly events: GameEvent[] = [];
  readonly rng: () => number;
  frozen = false;
  /** Set by Room before/around player join; guarded everywhere it is read so isolated tests may omit it. */
  rules!: ModeRules;
  tick = 0;

  private readonly loadouts = new Map<number, Loadout>();
  private readonly runtimes = new Map<number, PlayerRuntime>();
  private readonly hitHistory = new HitHistory();
  private nextProjectileId = 0;

  // --- allocation-free scratch, reused across ticks ---
  private readonly moveEvents: MovementEvents = createMovementEvents();
  private readonly weaponEvents: WeaponEvents = createWeaponEvents();
  private readonly eyeScratch: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly baseDirScratch: Vec3 = { x: 0, y: 0, z: 1 };
  private readonly velScratch: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly meleeFwdScratch: Vec3 = { x: 0, y: 0, z: 1 };
  private readonly hitScratch: PlayerHit = { id: 0, zone: 0, dist: 0, point: { x: 0, y: 0, z: 0 } };
  private readonly rayHitScratch: RayHit = { dist: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, material: 0 };
  private readonly pelletScratch: Vec3[] = Array.from({ length: MAX_PELLETS }, () => ({ x: 0, y: 0, z: 0 }));

  constructor(layout: MapLayout, seed: number) {
    this.colliders = buildColliders(layout);
    this.nav = buildNavGrid(layout, this.colliders);
    this.rng = mulberry32(seed);
  }

  // -------------------------------------------------------------------------
  // Roster
  // -------------------------------------------------------------------------
  addPlayer(id: number, name: string, team: number, isBot: boolean, loadout: Loadout): PlayerState {
    const p = createPlayerState(id, name, team, isBot);
    this.players.set(id, p);
    this.loadouts.set(id, loadout);
    this.runtimes.set(id, createRuntime());
    if (this.rules) this.rules.onPlayerJoin(this, p);
    return p;
  }

  removePlayer(id: number): void {
    const p = this.players.get(id);
    if (p && this.rules) this.rules.onPlayerLeave(this, p);
    this.players.delete(id);
    this.loadouts.delete(id);
    this.runtimes.delete(id);
  }

  setLoadout(id: number, loadout: Loadout): void {
    this.loadouts.set(id, loadout);
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------
  applyInput(id: number, cmd: InputCmd): boolean {
    const p = this.players.get(id);
    const rt = this.runtimes.get(id);
    if (!p || !rt) return false;
    if (cmd.seq <= p.lastAppliedSeq) return false;
    if (cmd.seq <= rt.lastQueuedSeq) return false;
    if (rt.pendingCount >= MAX_PENDING_CMDS) return false;
    // Insertion sort by seq (queue depth is tiny, so this is cheap and keeps
    // processing order correct even though delivery order is not guaranteed).
    let i = rt.pendingCount;
    while (i > 0 && rt.pending[i - 1]!.seq > cmd.seq) i--;
    for (let j = rt.pendingCount; j > i; j--) copyInputCmd(rt.pending[j]!, rt.pending[j - 1]!);
    copyInputCmd(rt.pending[i]!, cmd);
    rt.pendingCount++;
    rt.lastQueuedSeq = cmd.seq;
    return true;
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------
  step(dt: number): void {
    this.tick++;
    if (!this.frozen) {
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        this.stepOnePlayer(p, dt);
      }
      this.stepProjectilesAll(dt);
      this.applyRegenAndDecay(dt);
    }
    this.hitHistory.record(this.tick, this.players.values());
  }

  private stepOnePlayer(p: PlayerState, dt: number): void {
    const rt = this.runtimes.get(p.id);
    if (!rt) return;
    if (rt.pendingCount > 0) {
      const n = rt.pendingCount;
      rt.pendingCount = 0; // clear up front: a mid-loop death (fall damage) must not re-drain stale cmds next tick
      for (let i = 0; i < n && p.alive; i++) this.applyOneCmd(p, rt.pending[i]!, rt, dt);
    } else if (rt.hasLastCmd) {
      this.applyOneCmd(p, rt.lastCmd, rt, dt);
    }
  }

  private applyOneCmd(p: PlayerState, cmd: InputCmd, rt: PlayerRuntime, dt: number): void {
    resetMovementEvents(this.moveEvents);
    stepPlayer(p, cmd, this.colliders, dt, this.moveEvents);
    this.handleMovementEvents(p, this.moveEvents);

    if (p.alive) {
      resetWeaponEvents(this.weaponEvents);
      stepWeapon(p, cmd, dt, this.weaponEvents);
      this.handleWeaponEvents(p, cmd, this.weaponEvents);
    }

    p.lastAppliedSeq = cmd.seq;
    p.lastInputTick = cmd.tick;
    copyInputCmd(rt.lastCmd, cmd);
    rt.hasLastCmd = true;
  }

  private handleMovementEvents(p: PlayerState, e: MovementEvents): void {
    if (e.fellOut) {
      this.kill(p.id, 0, KILL_FALL, false);
      return;
    }
    if (e.fallDamage > 0) {
      this.damage(p.id, e.fallDamage, 0, ZONE_LIMB, KILL_FALL);
    }
  }

  private handleWeaponEvents(p: PlayerState, cmd: InputCmd, e: WeaponEvents): void {
    if (e.reloadStarted) this.events.push({ type: EV_RELOAD, player: p.id });
    if (e.meleeStarted) this.events.push({ type: EV_MELEE, player: p.id });
    if (e.meleeHit) this.resolveMelee(p);
    if (e.threwKind !== -1) this.resolveThrow(p, e.threwKind);
    if (e.shots > 0) this.resolveShots(p, cmd, e.shots);
  }

  private stepProjectilesAll(dt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const proj = this.projectiles[i]!;
      stepProjectile(this, proj, dt);
      proj.fuse -= dt;
      if (proj.fuse <= 0) {
        explode(this, proj);
        this.projectiles.splice(i, 1);
      }
    }
  }

  private applyRegenAndDecay(dt: number): void {
    for (const p of this.players.values()) {
      if (p.flashT > 0) p.flashT = Math.max(0, p.flashT - dt);
      if (p.hitT > 0) p.hitT = Math.max(0, p.hitT - dt);
      if (!p.alive || p.health >= HEALTH_MAX) continue;
      const secondsSinceDamage = (this.tick - p.lastDamageTick) * dt;
      if (secondsSinceDamage >= regenDelayFor(p)) {
        p.health = Math.min(HEALTH_MAX, p.health + REGEN_RATE * dt);
      }
    }
  }

  clearEvents(): void {
    this.events.length = 0;
  }

  // -------------------------------------------------------------------------
  // Hitscan / melee / throw resolution
  // -------------------------------------------------------------------------
  private resolveShots(shooter: PlayerState, cmd: InputCmd, shots: number): void {
    const def = activeWeaponDef(shooter);
    const weaponId = shooter.slots[shooter.activeSlot]!.weapon;
    // Floor at tick 1: that is the earliest tick HitHistory can ever have recorded
    // (step() increments `tick` before recording), so a shot fired in the first
    // few ticks of a match — before INTERP_TICKS of history exists — rewinds to
    // the oldest available frame instead of a guaranteed-empty negative tick.
    const rewindTick = clamp(cmd.tick - INTERP_TICKS, Math.max(1, this.tick - LAGCOMP_HISTORY_TICKS), this.tick);
    for (let s = 0; s < shots; s++) this.fireOnce(shooter, def, weaponId, rewindTick);
  }

  private fireOnce(shooter: PlayerState, def: WeaponDef, weaponId: number, rewindTick: number): void {
    const eye = this.eyePos(shooter, this.eyeScratch);

    // Actual fired direction includes both the recoil pattern kick and cone
    // spread, per the assignment ("dir = actual shot dir incl. spread/recoil").
    const recoil = recoilAt(def, shooter.shotIndex, this.rng);
    const aimYaw = wrapAngle(shooter.yaw + recoil.yaw);
    const aimPitch = clamp(shooter.pitch + recoil.pitch, -HALF_PI, HALF_PI);
    yawPitchToDir(aimYaw, aimPitch, this.baseDirScratch);

    const isPellet = def.pellets > 1;
    const coneRad = isPellet
      ? (shooter.ads ? def.pelletConeAds : def.pelletConeHip) * DEG2RAD
      : spreadFor(def, shooter);
    const count = Math.min(MAX_PELLETS, pelletDirs(def, this.baseDirScratch, coneRad, this.rng, this.pelletScratch));

    for (let i = 0; i < count; i++) {
      const dir = this.pelletScratch[i]!;
      this.events.push({
        type: EV_FIRE,
        shooter: shooter.id,
        weapon: weaponId,
        origin: { x: eye.x, y: eye.y, z: eye.z },
        dir: { x: dir.x, y: dir.y, z: dir.z },
      });

      const gotPlayer = this.hitHistory.raycast(
        rewindTick,
        eye,
        dir,
        MAX_SHOT_DIST,
        shooter.id,
        (target) => target.alive && (!this.rules || this.rules.isEnemy(shooter, target)),
        this.hitScratch,
      );
      const playerDist = gotPlayer ? this.hitScratch.dist : Infinity;

      const gotWall = this.colliders.raycast(
        eye.x, eye.y, eye.z,
        dir.x, dir.y, dir.z,
        Math.min(playerDist, MAX_SHOT_DIST),
        this.rayHitScratch,
      );

      if (gotWall && this.rayHitScratch.dist <= playerDist) {
        this.events.push({
          type: EV_IMPACT,
          pos: { x: this.rayHitScratch.point.x, y: this.rayHitScratch.point.y, z: this.rayHitScratch.point.z },
          normal: { x: this.rayHitScratch.normal.x, y: this.rayHitScratch.normal.y, z: this.rayHitScratch.normal.z },
          material: this.rayHitScratch.material,
        });
        continue; // wall is in front of (or at) the player hit: it blocks the shot
      }

      if (gotPlayer) {
        const dmg = damageAt(def, playerDist, this.hitScratch.zone);
        this.damage(this.hitScratch.id, dmg, shooter.id, this.hitScratch.zone, weaponId);
      }
    }
  }

  private resolveMelee(shooter: PlayerState): void {
    yawPitchToDir(shooter.yaw, 0, this.meleeFwdScratch);
    let bestId = -1;
    let bestDist = Infinity;
    for (const target of this.players.values()) {
      if (target.id === shooter.id || !target.alive) continue;
      if (this.rules && !this.rules.isEnemy(shooter, target)) continue;
      const dx = target.pos.x - shooter.pos.x;
      const dz = target.pos.z - shooter.pos.z;
      const dist = Math.hypot(dx, dz);
      // Distance approximation of a capsule sweep: shooter's reach plus the target's own body radius.
      if (dist > MELEE_RANGE + PLAYER_RADIUS) continue;
      if (dist > 1e-4) {
        const dot = (this.meleeFwdScratch.x * dx + this.meleeFwdScratch.z * dz) / dist;
        if (dot < MELEE_CONE_COS) continue;
      }
      if (dist < bestDist) {
        bestDist = dist;
        bestId = target.id;
      }
    }
    if (bestId !== -1) this.kill(bestId, shooter.id, KILL_MELEE, false);
  }

  private resolveThrow(shooter: PlayerState, kind: number): void {
    const speed = kind === PROJ_FRAG ? FRAG_THROW_SPEED : FLASH_THROW_SPEED;
    const fuse = kind === PROJ_FRAG ? Math.max(0, FRAG_FUSE - shooter.cookT) : FLASH_FUSE;
    const eye = this.eyePos(shooter, this.eyeScratch);
    yawPitchToDir(shooter.yaw, shooter.pitch, this.baseDirScratch);
    this.velScratch.x = this.baseDirScratch.x * speed;
    this.velScratch.y = this.baseDirScratch.y * speed;
    this.velScratch.z = this.baseDirScratch.z * speed;
    this.spawnProjectile(kind, shooter.id, shooter.team, eye, this.velScratch, fuse);
    this.events.push({ type: EV_THROW, player: shooter.id, kind });
  }

  // -------------------------------------------------------------------------
  // WorldView contract
  // -------------------------------------------------------------------------
  hasLineOfSight(a: Vec3, b: Vec3): boolean {
    return this.colliders.lineOfSight(a, b);
  }

  eyePos(p: PlayerState, out: Vec3): Vec3 {
    out.x = p.pos.x;
    out.y = p.pos.y + eyeHeight(p);
    out.z = p.pos.z;
    return out;
  }

  spawnProjectile(kind: number, owner: number, team: number, pos: Vec3, vel: Vec3, fuse: number): ProjectileState {
    const id = this.nextProjectileId;
    this.nextProjectileId = (this.nextProjectileId + 1) & 0xffff;
    const proj: ProjectileState = {
      id,
      kind,
      owner,
      team,
      pos: { x: pos.x, y: pos.y, z: pos.z },
      vel: { x: vel.x, y: vel.y, z: vel.z },
      fuse,
      resting: false,
    };
    this.projectiles.push(proj);
    return proj;
  }

  damage(targetId: number, amount: number, attackerId: number, zone: number, weapon: number): void {
    const target = this.players.get(targetId);
    if (!target || !target.alive || amount <= 0) return;
    const attacker = attackerId ? this.players.get(attackerId) ?? null : null;

    target.health = clamp(target.health - amount, 0, HEALTH_MAX);
    target.lastDamageTick = this.tick;
    target.hitT = HIT_FLASH_TIME;

    // Deterministic-sign flinch nudge (server-authoritative for this tick's
    // snapshot; the target's own next input overwrites yaw/pitch from their
    // actual mouse movement on the following tick, same as any other input).
    const pitchSign = this.rng() < 0.5 ? -1 : 1;
    target.pitch = clamp(target.pitch + pitchSign * FLINCH_PITCH_DEG * DEG2RAD, -HALF_PI, HALF_PI);
    const yawSign = this.rng() < 0.5 ? -1 : 1;
    target.yaw = wrapAngle(target.yaw + yawSign * FLINCH_YAW_DEG * DEG2RAD);

    this.events.push({ type: EV_HIT, target: targetId, attacker: attackerId, zone, damage: amount });

    if (target.health <= 0) {
      this.killInternal(target, attacker, weapon, zone === ZONE_HEAD);
    }
  }

  kill(victimId: number, killerId: number, weapon: number, headshot: boolean): void {
    const victim = this.players.get(victimId);
    if (!victim || !victim.alive) return;
    const killer = killerId ? this.players.get(killerId) ?? null : null;
    this.killInternal(victim, killer, weapon, headshot);
  }

  private killInternal(victim: PlayerState, killer: PlayerState | null, weapon: number, headshot: boolean): void {
    victim.health = 0;
    victim.alive = false;
    victim.deathTick = this.tick;
    victim.deaths++;
    if (killer && killer.id !== victim.id) killer.kills++;
    if (this.rules) this.rules.onKill(this, killer, victim, weapon, headshot);
    this.events.push({ type: EV_KILL, killer: killer ? killer.id : 0, victim: victim.id, weapon, headshot });
  }

  respawn(id: number, spawn: SpawnChoice): void {
    const p = this.players.get(id);
    if (!p) return;

    p.pos.x = spawn.x; p.pos.y = spawn.y; p.pos.z = spawn.z;
    p.vel.x = 0; p.vel.y = 0; p.vel.z = 0;
    p.yaw = spawn.yaw; p.pitch = 0;

    p.stance = STANCE_STAND; p.stanceT = 1; p.height = HEIGHT_STAND;
    p.moveState = MOVE_IDLE; p.stateT = 0; p.onGround = true;
    p.fallStartY = spawn.y;
    p.sprintT = 0; p.tacT = 0; p.tacCooldown = 0; p.sprintOutT = 0; p.landingT = 0;
    p.slideDirX = 0; p.slideDirZ = 0;
    p.mantleT = 0; p.mantleDuration = 0;
    p.mounted = false; p.mountNX = 0; p.mountNZ = 0; p.mountLean = 0;
    p.footstepDist = 0;

    p.ads = false; p.adsT = 0;

    p.health = HEALTH_MAX;
    p.alive = true;
    p.deathTick = 0;
    p.respawnTick = 0;

    const loadout = this.loadouts.get(id) ?? defaultLoadout();
    giveLoadout(p, loadout);
    p.activeSlot = SLOT_PRIMARY;
    p.swapT = 0; p.swapTo = SLOT_PRIMARY;
    p.reloadT = 0; p.reloadTotal = 0; p.fireCooldown = 0; p.shotIndex = 0; p.lastFireTick = 0; p.firing = false;
    p.lastButtons = 0;

    p.lethalCount = GRENADES_PER_LIFE;
    p.tacticalCount = GRENADES_PER_LIFE;
    p.cookT = 0; p.throwKind = -1; p.meleeT = 0;
    p.interactT = 0; p.interactSite = -1;

    p.flashT = 0; p.flashStrength = 0; p.hitT = 0;

    this.events.push({ type: EV_RESPAWN, player: id });
  }

  // -------------------------------------------------------------------------
  // Snapshotting
  // -------------------------------------------------------------------------
  snapshotFor(recipientId: number): Snapshot {
    const snap = createSnapshot();
    snap.tick = this.tick;

    if (this.rules) {
      snap.phase = this.rules.phase;
      snap.timeLeft = this.rules.timeLeft;
      snap.scores = [this.rules.scores[0], this.rules.scores[1]];
      snap.bombState = this.rules.bomb.state;
      snap.bombTimer = this.rules.bomb.timer;
    }

    const recipient = this.players.get(recipientId);
    if (recipient) snap.lastAckSeq = recipient.lastAppliedSeq;

    for (const p of this.players.values()) {
      const sp = createSnapshotPlayer();
      sp.id = p.id; sp.team = p.team; sp.isBot = p.isBot; sp.alive = p.alive;
      sp.stance = p.stance; sp.moveState = p.moveState; sp.ads = p.ads; sp.mounted = p.mounted;
      sp.reloading = isReloading(p); sp.firing = p.firing; sp.flashed = p.flashT > 0; sp.hit = p.hitT > 0;
      sp.pos.x = p.pos.x; sp.pos.y = p.pos.y; sp.pos.z = p.pos.z;
      sp.vel.x = p.vel.x; sp.vel.y = p.vel.y; sp.vel.z = p.vel.z;
      sp.yaw = p.yaw; sp.pitch = p.pitch; sp.health = p.health;
      const slot = p.slots[p.activeSlot]!;
      sp.weapon = slot.weapon; sp.mag = slot.mag; sp.reserve = slot.reserve;
      sp.animId = 0; // no dedicated one-shot animation-id system owned by World; client infers from moveState/flags
      snap.players.push(sp);
    }

    // Events/projectiles are not further mutated once pushed this tick, so
    // sharing the same objects across every recipient's snapshot this tick is safe.
    for (const proj of this.projectiles) snap.projectiles.push(proj);
    for (const ev of this.events) snap.events.push(ev);

    snap.local = recipient ?? null;
    return snap;
  }
}
