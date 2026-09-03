// Per-tick weapon state machine: swap, reload (shell-by-shell for the
// shotgun), fire (rpm cooldown, semi-auto edge detection, ammo), melee,
// and lethal/tactical throws. Pure and allocation-free — called by both
// World.step (authoritative) and the client Predictor (local resimulation),
// so it must depend on nothing but `state`, `cmd` and `dt`.
//
// `state.lastButtons` is owned exclusively by this module: every edge-detect
// check here (fire, reload, swap, melee, lethal/tactical release) reads it as
// "the previous tick's buttons" and this is the only function that writes it,
// once, at the very end of stepWeapon. shared/movement.ts never touches it —
// its own transient triggers (jump, slide start/cancel) are self-gating via
// onGround/moveState instead, so there is no ordering dependency between the
// two step functions on this field.

import {
  BTN_FIRE,
  BTN_LETHAL,
  BTN_MELEE,
  BTN_RELOAD,
  BTN_SWAP,
  BTN_TACTICAL,
  FRAG_FUSE,
  GRENADE_PULL_TIME,
  GRENADES_PER_LIFE,
  MELEE_HIT_AT,
  MELEE_TIME,
  MOVE_MANTLE,
  MOVE_SLIDE,
  MOVE_SPRINT,
  MOVE_TACSPRINT,
  PROJ_FLASH,
  PROJ_FRAG,
  SLIDE_ADS_LOCK,
  SLOT_PRIMARY,
  SLOT_SECONDARY,
  SWAP_TIME,
  WEAPON_AR,
  WEAPON_PISTOL,
} from '../constants.ts';
import { swapTimeMult } from '../perks.ts';
import { WEAPONS } from '../weapons.ts';
import type { WeaponDef } from '../weapons.ts';
import type { InputCmd, Loadout, PlayerState } from '../types.ts';
import type { WeaponEvents } from './types.ts';

/** The active slot's WeaponDef, falling back to the AR if the slot is somehow empty/invalid. */
export function activeWeaponDef(state: PlayerState): WeaponDef {
  const slot = state.slots[state.activeSlot];
  const def = slot ? WEAPONS[slot.weapon] : undefined;
  return def ?? WEAPONS[WEAPON_AR]!;
}

export function isReloading(state: PlayerState): boolean {
  return state.reloadT > 0;
}

/** May the player fire right now (ignoring ammo — that's dryFire's job)? */
export function canFire(state: PlayerState): boolean {
  if (!state.alive) return false;
  if (state.moveState === MOVE_SPRINT || state.moveState === MOVE_TACSPRINT) return false;
  if (state.sprintOutT > 0) return false;
  if (state.moveState === MOVE_MANTLE) return false;
  if (state.moveState === MOVE_SLIDE && state.stateT < SLIDE_ADS_LOCK) return false;
  if (state.reloadT > 0) return false;
  if (state.swapT > 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Swap
// ---------------------------------------------------------------------------
/** Returns true if a slot change was requested this tick (used to cancel an in-progress reload). */
function updateSwap(state: PlayerState, cmd: InputCmd, dt: number, out: WeaponEvents): boolean {
  const otherSlot = state.activeSlot === SLOT_PRIMARY ? SLOT_SECONDARY : SLOT_PRIMARY;
  const pressedToggle = (cmd.buttons & BTN_SWAP) !== 0 && !(state.lastButtons & BTN_SWAP);

  let requested = -1;
  if (pressedToggle) requested = otherSlot;
  else if ((cmd.weaponSlot === SLOT_PRIMARY || cmd.weaponSlot === SLOT_SECONDARY) && cmd.weaponSlot !== state.activeSlot) {
    requested = cmd.weaponSlot;
  }
  const wantsSwap = requested >= 0 && requested !== state.activeSlot;

  if (state.swapT > 0) {
    state.swapT = Math.max(0, state.swapT - dt);
    if (state.swapT === 0) {
      state.activeSlot = state.swapTo;
      out.swapped = true;
    }
    return wantsSwap;
  }

  if (wantsSwap) {
    state.swapTo = requested;
    state.swapT = SWAP_TIME * swapTimeMult(state);
  }
  return wantsSwap;
}

// ---------------------------------------------------------------------------
// Reload (shell-by-shell for the shotgun)
// ---------------------------------------------------------------------------
function updateReload(state: PlayerState, cmd: InputCmd, dt: number, out: WeaponEvents, swapRequested: boolean): void {
  const def = activeWeaponDef(state);
  const slot = state.slots[state.activeSlot]!;

  if (state.reloadT > 0) {
    const cancel = (cmd.buttons & BTN_FIRE) !== 0 || swapRequested ||
      state.moveState === MOVE_SPRINT || state.moveState === MOVE_TACSPRINT;
    if (cancel) {
      state.reloadT = 0;
      state.reloadTotal = 0;
      return;
    }
    state.reloadT = Math.max(0, state.reloadT - dt);
    if (state.reloadT === 0) {
      if (def.shellReload) {
        if (slot.mag < def.magSize && slot.reserve > 0) {
          slot.mag++;
          slot.reserve--;
        }
        if (slot.mag < def.magSize && slot.reserve > 0) {
          // Load the next shell.
          state.reloadT = def.shellTime;
          state.reloadTotal = def.shellTime;
        } else {
          out.reloadFinished = true;
        }
      } else {
        const take = Math.min(def.magSize - slot.mag, slot.reserve);
        slot.mag += take;
        slot.reserve -= take;
        out.reloadFinished = true;
      }
    }
    return;
  }

  const pressed = (cmd.buttons & BTN_RELOAD) !== 0 && !(state.lastButtons & BTN_RELOAD);
  if (pressed && state.swapT === 0 && slot.mag < def.magSize && slot.reserve > 0) {
    if (def.shellReload) {
      state.reloadT = def.shellTime;
      state.reloadTotal = def.shellTime;
    } else {
      const total = slot.mag === 0 ? def.reloadEmpty : def.reloadTac;
      state.reloadT = total;
      state.reloadTotal = total;
    }
    out.reloadStarted = true;
  }
}

// ---------------------------------------------------------------------------
// Fire
// ---------------------------------------------------------------------------
function updateFire(state: PlayerState, cmd: InputCmd, dt: number, out: WeaponEvents): void {
  const def = activeWeaponDef(state);
  const slot = state.slots[state.activeSlot]!;

  // Let the cooldown go slightly negative rather than clamping at 0: at 60Hz
  // most rpm values don't divide evenly into whole ticks (800rpm = 4.5 ticks),
  // so clamping would always round the wait up to the next full tick and bias
  // the achieved rate down (~727rpm instead of 800 for the AR). Adding the
  // interval onto the negative remainder on each shot, instead of resetting to
  // a flat value, keeps the long-run average rate accurate.
  if (state.fireCooldown > 0) state.fireCooldown -= dt;
  const held = (cmd.buttons & BTN_FIRE) !== 0;
  if (!held && state.fireCooldown < 0) state.fireCooldown = 0; // don't bank overshoot while not trying to fire

  state.firing = false;
  const edge = held && !(state.lastButtons & BTN_FIRE);
  const wantsToFire = held && (def.semiAuto ? edge : true);

  if (wantsToFire && canFire(state) && state.fireCooldown <= 0) {
    if (slot.mag > 0) {
      slot.mag--;
      state.fireCooldown += 60 / def.rpm;
      state.firing = true;
      out.shots += 1;
      out.firedWeapon = slot.weapon;
      state.shotIndex += 1;
      state.lastFireTick = 0;
      // A shot interrupts any in-progress reload (weapon comes back up to fire).
      if (state.reloadT > 0) { state.reloadT = 0; state.reloadTotal = 0; }
    } else {
      out.dryFire = true;
    }
  }

  // shotIndex (recoil pattern progress) resets after a 0.3s pause without firing.
  // No world-tick is available to a pure per-state step function, so this field
  // is repurposed here as a seconds-since-last-shot accumulator — see report.
  state.lastFireTick += dt;
  if (state.lastFireTick > 0.3) state.shotIndex = 0;
}

// ---------------------------------------------------------------------------
// Melee
// ---------------------------------------------------------------------------
function updateMelee(state: PlayerState, cmd: InputCmd, dt: number, out: WeaponEvents): void {
  if (state.meleeT > 0) {
    const prev = state.meleeT;
    state.meleeT = Math.max(0, state.meleeT - dt);
    const hitAt = MELEE_TIME - MELEE_HIT_AT;
    if (prev > hitAt && state.meleeT <= hitAt) out.meleeHit = true;
    return;
  }
  const edge = (cmd.buttons & BTN_MELEE) !== 0 && !(state.lastButtons & BTN_MELEE);
  if (edge) {
    state.meleeT = MELEE_TIME;
    out.meleeStarted = true;
  }
}

// ---------------------------------------------------------------------------
// Lethal (cookable frag) / tactical (flash, throws on release, no cook)
// ---------------------------------------------------------------------------
function updateThrow(state: PlayerState, cmd: InputCmd, dt: number, out: WeaponEvents): void {
  const lethalHeld = (cmd.buttons & BTN_LETHAL) !== 0;
  const lethalWasHeld = (state.lastButtons & BTN_LETHAL) !== 0;

  if (lethalWasHeld && !lethalHeld) {
    // Released: state.cookT still holds this throw's total hold duration so
    // World/grenades.ts can read it THIS tick to compute the reduced fuse
    // (FRAG_FUSE - max(0, cookT - GRENADE_PULL_TIME)); it is cleared below
    // next tick once no longer held.
    if (state.cookT > 0 && state.lethalCount > 0) {
      state.lethalCount -= 1;
      out.threwKind = PROJ_FRAG;
    }
  } else if (lethalHeld && state.lethalCount > 0) {
    const prev = state.cookT;
    // Leave a sliver of fuse so a maximally-cooked throw still ticks down.
    state.cookT = Math.min(FRAG_FUSE - 0.1, state.cookT + dt);
    if (prev <= GRENADE_PULL_TIME && state.cookT > GRENADE_PULL_TIME) out.cookStarted = true;
  } else {
    state.cookT = 0;
  }

  const tacHeld = (cmd.buttons & BTN_TACTICAL) !== 0;
  const tacWasHeld = (state.lastButtons & BTN_TACTICAL) !== 0;
  if (tacWasHeld && !tacHeld && state.tacticalCount > 0) {
    state.tacticalCount -= 1;
    out.threwKind = PROJ_FLASH;
  }
}

// ---------------------------------------------------------------------------
// Loadout
// ---------------------------------------------------------------------------
export function giveLoadout(state: PlayerState, loadout: Loadout): void {
  const primaryDef = WEAPONS[loadout.primary] ?? WEAPONS[WEAPON_AR]!;
  const secondaryDef = WEAPONS[loadout.secondary] ?? WEAPONS[WEAPON_PISTOL]!;

  const primarySlot = state.slots[SLOT_PRIMARY]!;
  primarySlot.weapon = primaryDef.id;
  primarySlot.mag = primaryDef.magSize;
  primarySlot.reserve = primaryDef.reserveMax;

  const secondarySlot = state.slots[SLOT_SECONDARY]!;
  secondarySlot.weapon = secondaryDef.id;
  secondarySlot.mag = secondaryDef.magSize;
  secondarySlot.reserve = secondaryDef.reserveMax;

  state.activeSlot = SLOT_PRIMARY;
  state.swapTo = SLOT_PRIMARY;
  state.swapT = 0;
  state.reloadT = 0;
  state.reloadTotal = 0;
  state.fireCooldown = 0;
  state.shotIndex = 0;
  state.lastFireTick = 0;
  state.firing = false;

  state.lethal = loadout.lethal;
  state.tactical = loadout.tactical;
  state.lethalCount = GRENADES_PER_LIFE;
  state.tacticalCount = GRENADES_PER_LIFE;
  state.cookT = 0;
  state.throwKind = -1;
  state.meleeT = 0;

  state.perks = [loadout.perk1, loadout.perk2];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export function stepWeapon(state: PlayerState, cmd: InputCmd, dt: number, out: WeaponEvents): void {
  if (!state.alive) {
    state.lastButtons = cmd.buttons;
    return;
  }

  const swapRequested = updateSwap(state, cmd, dt, out);
  updateReload(state, cmd, dt, out, swapRequested);
  updateFire(state, cmd, dt, out);
  updateMelee(state, cmd, dt, out);
  updateThrow(state, cmd, dt, out);

  state.lastButtons = cmd.buttons;
}
