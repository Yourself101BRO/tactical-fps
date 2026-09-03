// Weapon data table and pure gunplay math (damage falloff, recoil patterns,
// hip/ADS spread, shotgun pellet cones). Every number below comes straight
// from plan §4's weapon table; nothing here is hardcoded elsewhere.

import {
  LANDING_SPREAD_BUMP,
  STANCE_CROUCH,
  STANCE_PRONE,
  WEAPON_AR,
  WEAPON_COUNT,
  WEAPON_PISTOL,
  WEAPON_SHOTGUN,
  WEAPON_SMG,
  WEAPON_SNIPER,
  ZONE_CHEST,
  ZONE_HEAD,
  ZONE_LIMB,
} from './constants.ts';
import { degToRad, lerp } from './math.ts';
import type { PlayerState, Vec3 } from './types.ts';

/** One of the three per-shot recoil patterns described in plan §4. */
export type RecoilPattern = 'rise' | 'drift' | 'random';

export interface WeaponDef {
  id: number;
  name: string;
  /** SLOT_PRIMARY or SLOT_SECONDARY. */
  slot: number;

  // Damage falloff: distance breakpoints (metres) and the damage band below
  // each breakpoint. `damageValues.length === damageRanges.length + 1`.
  // damageRanges = [] means a single flat damage value (e.g. the sniper).
  damageRanges: number[];
  damageValues: number[];

  rpm: number;
  magSize: number;
  /** Spare ammo capacity, not counting the mag. */
  reserveMax: number;
  reloadTac: number;
  reloadEmpty: number;

  adsTime: number;
  adsFov: number;
  /** Movement speed cap (m/s) while aiming down sights. */
  adsMoveSpeed: number;
  /** Seconds after sprint ends before the weapon may fire again. */
  sprintOut: number;

  /** Degrees of per-shot vertical kick / horizontal kick magnitude. */
  recoilPitch: number;
  recoilYaw: number;
  recoilPattern: RecoilPattern;

  // Hip-fire spread cone half-angle (degrees) by state.
  spreadStand: number;
  spreadCrouch: number;
  spreadMove: number;
  spreadJump: number;
  /** ADS spread cone half-angle (degrees). */
  spreadAds: number;

  multHead: number;
  multChest: number;
  multLimb: number;

  /** Shotgun-only: pellets per shot and their cone half-angles (degrees). */
  pellets: number;
  pelletConeAds: number;
  pelletConeHip: number;

  /** Semi-auto: one shot per BTN_FIRE press edge, gated by `rpm` as a cooldown. */
  semiAuto: boolean;
  /** Shotgun-only: reload one shell at a time (`shellTime` each), cancelable. */
  shellReload: boolean;
  shellTime: number;

  /** Viewmodel normalization target length (metres), for the asset loader. */
  modelLength: number;
  /** Matches the WEAPON_* id; the audio module keys its synthesized gunshot off this. */
  fireSoundId: number;
}

export const WEAPONS: readonly WeaponDef[] = [
  // --- WEAPON_AR ---
  {
    id: WEAPON_AR,
    name: 'AR',
    slot: 0,
    damageRanges: [25, 45],
    damageValues: [28, 24, 20],
    rpm: 800,
    magSize: 30,
    reserveMax: 120,
    reloadTac: 2.1,
    reloadEmpty: 2.6,
    adsTime: 0.25,
    adsFov: 60,
    adsMoveSpeed: 2.6,
    sprintOut: 0.25,
    recoilPitch: 0.35,
    recoilYaw: 0.12,
    recoilPattern: 'rise',
    spreadStand: 2.5,
    spreadCrouch: 1.8,
    spreadMove: 4.0,
    spreadJump: 7.0,
    spreadAds: 0.35,
    multHead: 1.4,
    multChest: 1.0,
    multLimb: 0.9,
    pellets: 1,
    pelletConeAds: 0,
    pelletConeHip: 0,
    semiAuto: false,
    shellReload: false,
    shellTime: 0,
    modelLength: 0.9,
    fireSoundId: WEAPON_AR,
  },
  // --- WEAPON_SMG ---
  {
    id: WEAPON_SMG,
    name: 'SMG',
    slot: 0,
    damageRanges: [12, 25],
    damageValues: [26, 21, 17],
    rpm: 900,
    magSize: 32,
    reserveMax: 160,
    reloadTac: 1.8,
    reloadEmpty: 2.2,
    adsTime: 0.20,
    adsFov: 65,
    adsMoveSpeed: 3.0,
    sprintOut: 0.18,
    recoilPitch: 0.28,
    recoilYaw: 0.20,
    recoilPattern: 'random',
    spreadStand: 1.8,
    spreadCrouch: 1.3,
    spreadMove: 2.6,
    spreadJump: 5.0,
    spreadAds: 0.30,
    multHead: 1.3,
    multChest: 1.0,
    multLimb: 0.9,
    pellets: 1,
    pelletConeAds: 0,
    pelletConeHip: 0,
    semiAuto: false,
    shellReload: false,
    shellTime: 0,
    modelLength: 0.65,
    fireSoundId: WEAPON_SMG,
  },
  // --- WEAPON_SNIPER (semi-auto, one-shot upper torso) ---
  {
    id: WEAPON_SNIPER,
    name: 'Sniper',
    slot: 0,
    damageRanges: [],
    damageValues: [95],
    rpm: 45,
    magSize: 5,
    reserveMax: 25,
    reloadTac: 2.8,
    reloadEmpty: 3.2,
    adsTime: 0.50,
    adsFov: 18,
    adsMoveSpeed: 2.0,
    sprintOut: 0.40,
    recoilPitch: 3.0,
    recoilYaw: 0.5,
    recoilPattern: 'drift',
    spreadStand: 12,
    spreadCrouch: 9,
    spreadMove: 14,
    spreadJump: 20,
    spreadAds: 0.15,
    multHead: 1.5,
    // "one-shot upper torso": chest multiplier alone (1.1) is enough to kill
    // through the 95 flat damage value at full health.
    multChest: 1.1,
    multLimb: 0.85,
    pellets: 1,
    pelletConeAds: 0,
    pelletConeHip: 0,
    semiAuto: true,
    shellReload: false,
    shellTime: 0,
    modelLength: 1.1,
    fireSoundId: WEAPON_SNIPER,
  },
  // --- WEAPON_SHOTGUN (8 pellets, shell-by-shell reload) ---
  {
    id: WEAPON_SHOTGUN,
    name: 'Shotgun',
    slot: 0,
    damageRanges: [8, 14, 22],
    damageValues: [14, 8, 4, 0],
    rpm: 200,
    magSize: 8,
    reserveMax: 32,
    // Unused: shellReload drives per-shell timing via shellTime instead.
    reloadTac: 0,
    reloadEmpty: 0,
    adsTime: 0.30,
    adsFov: 70,
    adsMoveSpeed: 2.8,
    sprintOut: 0.28,
    recoilPitch: 1.8,
    recoilYaw: 0.6,
    recoilPattern: 'drift',
    // Hip spread is unused for the shotgun (pelletConeHip drives the pattern instead).
    spreadStand: 0,
    spreadCrouch: 0,
    spreadMove: 0,
    spreadJump: 0,
    spreadAds: 0,
    multHead: 1.1,
    multChest: 1.0,
    multLimb: 1.0,
    pellets: 8,
    pelletConeAds: 5,
    pelletConeHip: 8,
    semiAuto: true,
    shellReload: true,
    shellTime: 0.5,
    modelLength: 1.0,
    fireSoundId: WEAPON_SHOTGUN,
  },
  // --- WEAPON_PISTOL ---
  {
    id: WEAPON_PISTOL,
    name: 'Pistol',
    slot: 1,
    damageRanges: [15, 30],
    damageValues: [34, 26, 20],
    rpm: 450,
    magSize: 15,
    reserveMax: 60,
    reloadTac: 1.4,
    reloadEmpty: 1.7,
    adsTime: 0.18,
    adsFov: 70,
    adsMoveSpeed: 3.2,
    sprintOut: 0.15,
    recoilPitch: 0.9,
    recoilYaw: 0.3,
    recoilPattern: 'drift',
    spreadStand: 2.2,
    spreadCrouch: 1.6,
    spreadMove: 3.2,
    spreadJump: 6.0,
    spreadAds: 0.25,
    multHead: 1.4,
    multChest: 1.0,
    multLimb: 0.9,
    pellets: 1,
    pelletConeAds: 0,
    pelletConeHip: 0,
    semiAuto: true,
    shellReload: false,
    shellTime: 0,
    modelLength: 0.25,
    fireSoundId: WEAPON_PISTOL,
  },
];

if (WEAPONS.length !== WEAPON_COUNT) {
  throw new Error(`WEAPONS table has ${WEAPONS.length} entries, expected WEAPON_COUNT=${WEAPON_COUNT}`);
}

/** Zone multiplier for a weapon (ZONE_HEAD/CHEST/LIMB). */
function zoneMult(def: WeaponDef, zone: number): number {
  if (zone === ZONE_HEAD) return def.multHead;
  if (zone === ZONE_LIMB) return def.multLimb;
  return def.multChest;
}

/** Base (pre-zone-multiplier) damage at `dist` metres, from the range bands. */
function baseDamageAt(def: WeaponDef, dist: number): number {
  for (let i = 0; i < def.damageRanges.length; i++) {
    if (dist <= def.damageRanges[i]!) return def.damageValues[i]!;
  }
  return def.damageValues[def.damageValues.length - 1]!;
}

/** Damage for one hit at `dist` metres against `zone` (ZONE_*). */
export function damageAt(def: WeaponDef, dist: number, zone: number): number {
  return baseDamageAt(def, dist) * zoneMult(def, zone);
}

// Scratch used only inside recoilAt; never shared across calls (synchronous, no reentrancy).
const RECOIL_OUT = { pitch: 0, yaw: 0 };

/**
 * Per-shot recoil kick in radians. `shotIndex` is the 0-based index within
 * the current burst (resets after a pause, per PlayerState.shotIndex).
 * `rng` must be a deterministic generator (mulberry32), never Math.random.
 */
export function recoilAt(def: WeaponDef, shotIndex: number, rng: () => number): { pitch: number; yaw: number } {
  let pitchDeg: number;
  let yawDeg: number;

  if (def.recoilPattern === 'rise') {
    // AR: climbs for the first 8 shots, then holds while drifting right.
    const climb = Math.min(shotIndex, 8);
    pitchDeg = def.recoilPitch * (0.55 + 0.45 * (climb / 8));
    yawDeg = def.recoilYaw * (rng() * 2 - 1) * 0.35;
    if (shotIndex >= 8) yawDeg += def.recoilYaw * Math.min((shotIndex - 8) / 8, 1);
  } else if (def.recoilPattern === 'random') {
    // SMG: a random walk — mostly-vertical kick, fully random horizontal jitter.
    pitchDeg = def.recoilPitch * (0.7 + rng() * 0.3);
    yawDeg = def.recoilYaw * (rng() * 2 - 1);
  } else {
    // 'drift': sniper/shotgun/pistol — simple constant kick with small random drift.
    pitchDeg = def.recoilPitch;
    yawDeg = def.recoilYaw * (rng() * 2 - 1);
  }

  RECOIL_OUT.pitch = degToRad(pitchDeg);
  RECOIL_OUT.yaw = degToRad(yawDeg);
  return RECOIL_OUT;
}

/**
 * Hip/ADS spread cone half-angle in radians for the given weapon and player
 * state: picks the stance band, bumps for movement/airborne/landing, blends
 * toward the ADS cone by `state.adsT`, and halves while mounted.
 */
export function spreadFor(def: WeaponDef, state: PlayerState): number {
  const airborne = !state.onGround;
  let hipDeg: number;
  if (airborne) {
    hipDeg = def.spreadJump;
  } else if (state.stance === STANCE_CROUCH || state.stance === STANCE_PRONE) {
    hipDeg = def.spreadCrouch;
  } else {
    hipDeg = def.spreadStand;
  }

  const moving = Math.hypot(state.vel.x, state.vel.z) > 0.5;
  if (moving && !airborne) hipDeg = Math.max(hipDeg, def.spreadMove);

  let deg = lerp(hipDeg, def.spreadAds, state.adsT);
  if (state.landingT > 0) deg += LANDING_SPREAD_BUMP;
  if (state.mounted) deg *= 0.5;
  return degToRad(Math.max(0, deg));
}

// Scratch basis vectors for pelletDirs — module-level so the function stays
// allocation-free; safe because it is never called reentrantly.
let bux = 0, buy = 0, buz = 0;
let bvx = 0, bvy = 0, bvz = 0;

/**
 * Fills `out[0..n)` (pre-allocated Vec3 objects, mutated in place — never
 * pushed/allocated) with shotgun pellet directions randomly distributed in a
 * cone of half-angle `coneRad` around unit `dir`. Returns the pellet count
 * written (min of def.pellets and out.length).
 */
export function pelletDirs(def: WeaponDef, dir: Vec3, coneRad: number, rng: () => number, out: Vec3[]): number {
  const n = Math.min(def.pellets, out.length);
  if (n <= 0) return 0;

  // Build an orthonormal basis (bu, bv) perpendicular to dir.
  const ax = Math.abs(dir.x), ay = Math.abs(dir.y), az = Math.abs(dir.z);
  // Pick the world axis least aligned with dir to avoid a degenerate cross product.
  let hx = 0, hy = 0, hz = 0;
  if (ax <= ay && ax <= az) hx = 1; else if (ay <= az) hy = 1; else hz = 1;
  // bu = normalize(dir x helper)
  bux = dir.y * hz - dir.z * hy;
  buy = dir.z * hx - dir.x * hz;
  buz = dir.x * hy - dir.y * hx;
  const buLen = Math.sqrt(bux * bux + buy * buy + buz * buz) || 1;
  bux /= buLen; buy /= buLen; buz /= buLen;
  // bv = dir x bu (already unit since dir and bu are orthonormal unit vectors)
  bvx = dir.y * buz - dir.z * buy;
  bvy = dir.z * bux - dir.x * buz;
  bvz = dir.x * buy - dir.y * bux;

  const cone = Math.max(0, coneRad);
  for (let i = 0; i < n; i++) {
    const azimuth = rng() * Math.PI * 2;
    // Not perfectly solid-angle-uniform, but even and adequate for gameplay spread.
    const polar = rng() * cone;
    const sinP = Math.sin(polar), cosP = Math.cos(polar);
    const cosA = Math.cos(azimuth), sinA = Math.sin(azimuth);
    const v = out[i]!;
    v.x = dir.x * cosP + (bux * cosA + bvx * sinA) * sinP;
    v.y = dir.y * cosP + (buy * cosA + bvy * sinA) * sinP;
    v.z = dir.z * cosP + (buz * cosA + bvz * sinA) * sinP;
  }
  return n;
}

export function weaponName(id: number): string {
  return WEAPONS[id]?.name ?? 'Unknown';
}
