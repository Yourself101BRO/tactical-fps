// Unit tests for shared/weapons.ts and shared/sim/weaponstate.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BTN_FIRE,
  BTN_RELOAD,
  LETHAL_FRAG,
  PERK_NONE,
  TACTICAL_FLASH,
  TEAM_A,
  TICK_DT,
  WEAPON_AR,
  WEAPON_PISTOL,
  WEAPON_SHOTGUN,
  WEAPON_SNIPER,
  ZONE_HEAD,
} from '../shared/constants.ts';
import { createInputCmd, createPlayerState, vec3 } from '../shared/types.ts';
import type { Loadout, PlayerState, Vec3 } from '../shared/types.ts';
import { createWeaponEvents, resetWeaponEvents } from '../shared/sim/types.ts';
import type { WeaponEvents } from '../shared/sim/types.ts';
import { canFire, giveLoadout, isReloading, stepWeapon } from '../shared/sim/weaponstate.ts';
import { WEAPONS, damageAt, pelletDirs, recoilAt } from '../shared/weapons.ts';
import { degToRad, mulberry32 } from '../shared/math.ts';

function loadoutWith(primary: number, secondary = WEAPON_PISTOL): Loadout {
  return { primary, secondary, lethal: LETHAL_FRAG, tactical: TACTICAL_FLASH, perk1: PERK_NONE, perk2: PERK_NONE };
}

function newPlayer(primary: number): PlayerState {
  const s = createPlayerState(1, 'p', TEAM_A);
  s.alive = true;
  giveLoadout(s, loadoutWith(primary));
  return s;
}

/**
 * Steps until `n` shots have fired, alternating press/release each tick so it
 * works for both automatic weapons (fires whenever the rpm cooldown allows)
 * and semi-auto ones (need a fresh press edge per shot).
 */
function fireShots(s: PlayerState, n: number, events: WeaponEvents): void {
  const cmd = createInputCmd();
  let fired = 0;
  for (let guard = 0; guard < 8000 && fired < n; guard++) {
    cmd.buttons = BTN_FIRE;
    resetWeaponEvents(events);
    stepWeapon(s, cmd, TICK_DT, events);
    fired += events.shots;
    if (fired >= n) break;
    cmd.buttons = 0;
    resetWeaponEvents(events);
    stepWeapon(s, cmd, TICK_DT, events);
  }
  assert.equal(fired, n, `fireShots: expected to fire ${n}, fired ${fired}`);
}

// ---------------------------------------------------------------------------
test('automatic weapon (AR) fire rate matches its rpm', () => {
  const s = newPlayer(WEAPON_AR);
  const def = WEAPONS[WEAPON_AR]!;
  const events = createWeaponEvents();
  const cmd = createInputCmd();
  cmd.buttons = BTN_FIRE;

  const seconds = 2;
  const ticks = Math.round(seconds / TICK_DT);
  let shots = 0;
  for (let i = 0; i < ticks; i++) {
    resetWeaponEvents(events);
    stepWeapon(s, cmd, TICK_DT, events);
    shots += events.shots;
  }
  const expected = seconds * (def.rpm / 60);
  assert.ok(Math.abs(shots - expected) <= 2, `expected ~${expected} shots at ${def.rpm} rpm, got ${shots}`);
});

test('semi-auto weapon fires once per press, not while held', () => {
  const s = newPlayer(WEAPON_SNIPER);
  assert.ok(WEAPONS[WEAPON_SNIPER]!.semiAuto);
  const events = createWeaponEvents();
  const cmd = createInputCmd();
  cmd.buttons = BTN_FIRE;

  let shots = 0;
  for (let i = 0; i < 60; i++) { // hold for a full second — should still be exactly one shot
    resetWeaponEvents(events);
    stepWeapon(s, cmd, TICK_DT, events);
    shots += events.shots;
  }
  assert.equal(shots, 1, 'holding fire on a semi-auto weapon should only fire once');

  // Release and wait out the sniper's rpm cooldown (45rpm ≈ 1.33s) before a
  // fresh press — otherwise the rpm gate, not the edge-detect, would be what's
  // being tested here.
  cmd.buttons = 0;
  const cooldownTicks = Math.ceil(60 / WEAPONS[WEAPON_SNIPER]!.rpm / TICK_DT) + 2;
  for (let i = 0; i < cooldownTicks; i++) { resetWeaponEvents(events); stepWeapon(s, cmd, TICK_DT, events); }

  cmd.buttons = BTN_FIRE; // press again
  resetWeaponEvents(events);
  stepWeapon(s, cmd, TICK_DT, events);
  shots += events.shots;
  assert.equal(shots, 2, 'a fresh press should fire a second shot once the rpm cooldown has cleared');
});

test('AR reload after a partial mag takes reloadTac and refills the mag', () => {
  const s = newPlayer(WEAPON_AR);
  const def = WEAPONS[WEAPON_AR]!;
  const events = createWeaponEvents();
  fireShots(s, 5, events);
  assert.equal(s.slots[0]!.mag, def.magSize - 5);

  const reloadCmd = createInputCmd();
  reloadCmd.buttons = BTN_RELOAD;
  resetWeaponEvents(events);
  stepWeapon(s, reloadCmd, TICK_DT, events);
  assert.ok(events.reloadStarted);
  assert.ok(Math.abs(s.reloadTotal - def.reloadTac) < 1e-9);

  reloadCmd.buttons = 0;
  let elapsed = TICK_DT;
  let finishedAt = -1;
  for (let i = 0; i < 600 && isReloading(s); i++) {
    resetWeaponEvents(events);
    stepWeapon(s, reloadCmd, TICK_DT, events);
    elapsed += TICK_DT;
    if (events.reloadFinished) finishedAt = elapsed;
  }
  assert.ok(finishedAt > 0, 'reload should finish');
  assert.ok(Math.abs(finishedAt - def.reloadTac) < TICK_DT * 2, `expected ~${def.reloadTac}s, got ${finishedAt}`);
  assert.equal(s.slots[0]!.mag, def.magSize);
});

test('AR reload from an empty mag takes reloadEmpty', () => {
  const s = newPlayer(WEAPON_AR);
  const def = WEAPONS[WEAPON_AR]!;
  const events = createWeaponEvents();
  fireShots(s, def.magSize, events);
  assert.equal(s.slots[0]!.mag, 0);

  const reloadCmd = createInputCmd();
  reloadCmd.buttons = BTN_RELOAD;
  resetWeaponEvents(events);
  stepWeapon(s, reloadCmd, TICK_DT, events);
  assert.ok(Math.abs(s.reloadTotal - def.reloadEmpty) < 1e-9);

  reloadCmd.buttons = 0;
  let elapsed = TICK_DT;
  let finishedAt = -1;
  for (let i = 0; i < 600 && isReloading(s); i++) {
    resetWeaponEvents(events);
    stepWeapon(s, reloadCmd, TICK_DT, events);
    elapsed += TICK_DT;
    if (events.reloadFinished) finishedAt = elapsed;
  }
  assert.ok(Math.abs(finishedAt - def.reloadEmpty) < TICK_DT * 2, `expected ~${def.reloadEmpty}s, got ${finishedAt}`);
  assert.equal(s.slots[0]!.mag, def.magSize);
});

test('shotgun reloads one shell at a time and firing cancels the remainder', () => {
  const s = newPlayer(WEAPON_SHOTGUN);
  const def = WEAPONS[WEAPON_SHOTGUN]!;
  assert.ok(def.shellReload);
  const events = createWeaponEvents();
  fireShots(s, 2, events);
  assert.equal(s.slots[0]!.mag, def.magSize - 2);

  const reloadCmd = createInputCmd();
  reloadCmd.buttons = BTN_RELOAD;
  resetWeaponEvents(events);
  stepWeapon(s, reloadCmd, TICK_DT, events);
  assert.ok(events.reloadStarted);
  assert.ok(Math.abs(s.reloadTotal - def.shellTime) < 1e-9);

  reloadCmd.buttons = 0;
  const oneShellTicks = Math.round(def.shellTime / TICK_DT) + 1;
  for (let i = 0; i < oneShellTicks; i++) { resetWeaponEvents(events); stepWeapon(s, reloadCmd, TICK_DT, events); }
  assert.equal(s.slots[0]!.mag, def.magSize - 1, 'exactly one shell should have loaded so far');
  assert.ok(isReloading(s), 'a second shell should still be loading');

  const fireCmd = createInputCmd();
  fireCmd.buttons = BTN_FIRE;
  resetWeaponEvents(events);
  stepWeapon(s, fireCmd, TICK_DT, events);
  assert.ok(!isReloading(s), 'firing should cancel the remaining shell reload');
});

test('pelletDirs fires the shotgun\'s full pellet count, all unit vectors within its cone', () => {
  const def = WEAPONS[WEAPON_SHOTGUN]!;
  const rng = mulberry32(12345);
  const dir: Vec3 = vec3(0, 0, -1);
  const out: Vec3[] = [];
  for (let i = 0; i < def.pellets; i++) out.push(vec3());

  const coneRad = degToRad(def.pelletConeHip);
  const n = pelletDirs(def, dir, coneRad, rng, out);
  assert.equal(n, 8);
  assert.equal(def.pellets, 8);

  const cosCone = Math.cos(coneRad) - 1e-6;
  for (const v of out) {
    const len = Math.hypot(v.x, v.y, v.z);
    assert.ok(Math.abs(len - 1) < 1e-6, 'pellet direction should be unit length');
    const dot = v.x * dir.x + v.y * dir.y + v.z * dir.z;
    assert.ok(dot >= cosCone, `pellet direction outside the cone: dot=${dot}`);
  }
});

test('damageAt applies range bands and zone multipliers', () => {
  const def = WEAPONS[WEAPON_AR]!;
  assert.equal(damageAt(def, 10, ZONE_HEAD), 28 * def.multHead);
  assert.equal(damageAt(def, 30, ZONE_HEAD), 24 * def.multHead);
  assert.equal(damageAt(def, 100, ZONE_HEAD), 20 * def.multHead);
});

test('recoilAt is deterministic for a given rng seed', () => {
  const def = WEAPONS[WEAPON_AR]!;
  const a = recoilAt(def, 3, mulberry32(42));
  const aPitch = a.pitch, aYaw = a.yaw;
  const b = recoilAt(def, 3, mulberry32(42));
  assert.equal(b.pitch, aPitch);
  assert.equal(b.yaw, aYaw);
});

test('giveLoadout fills full mags/reserves, grenade counts and perks', () => {
  const s = createPlayerState(1, 'p', TEAM_A);
  const loadout: Loadout = { primary: WEAPON_AR, secondary: WEAPON_PISTOL, lethal: LETHAL_FRAG, tactical: TACTICAL_FLASH, perk1: 1, perk2: 4 };
  giveLoadout(s, loadout);
  const ar = WEAPONS[WEAPON_AR]!;
  const pistol = WEAPONS[WEAPON_PISTOL]!;
  assert.equal(s.slots[0]!.weapon, WEAPON_AR);
  assert.equal(s.slots[0]!.mag, ar.magSize);
  assert.equal(s.slots[0]!.reserve, ar.reserveMax);
  assert.equal(s.slots[1]!.weapon, WEAPON_PISTOL);
  assert.equal(s.slots[1]!.mag, pistol.magSize);
  assert.equal(s.slots[1]!.reserve, pistol.reserveMax);
  assert.deepEqual(s.perks, [1, 4]);
  assert.equal(s.lethalCount, 1);
  assert.equal(s.tacticalCount, 1);
});

test('canFire is false while reloading and true once the mag is topped off', () => {
  const s = newPlayer(WEAPON_AR);
  const events = createWeaponEvents();
  fireShots(s, 5, events);
  const reloadCmd = createInputCmd();
  reloadCmd.buttons = BTN_RELOAD;
  resetWeaponEvents(events);
  stepWeapon(s, reloadCmd, TICK_DT, events);
  assert.ok(!canFire(s));
  reloadCmd.buttons = 0;
  for (let i = 0; i < 600 && isReloading(s); i++) { resetWeaponEvents(events); stepWeapon(s, reloadCmd, TICK_DT, events); }
  assert.ok(canFire(s));
});
