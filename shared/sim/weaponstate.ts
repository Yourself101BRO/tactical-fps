// TEMP STUB for isolated verification of assignment-C files only. Will be deleted.
import type { InputCmd, Loadout, PlayerState } from '../types.ts';
import type { WeaponEvents } from './types.ts';
import { WEAPONS } from '../weapons.ts';
import type { WeaponDef } from '../weapons.ts';
import { BTN_FIRE, BTN_RELOAD } from '../constants.ts';

export function activeWeaponDef(state: PlayerState): WeaponDef {
  const w = state.slots[state.activeSlot]!.weapon;
  return WEAPONS[w] ?? WEAPONS[0]!;
}

export function canFire(state: PlayerState): boolean {
  return state.slots[state.activeSlot]!.mag > 0 && state.reloadT <= 0;
}

export function isReloading(state: PlayerState): boolean {
  return state.reloadT > 0;
}

export function giveLoadout(state: PlayerState, loadout: Loadout): void {
  const primaryDef = WEAPONS[loadout.primary]!;
  const secondaryDef = WEAPONS[loadout.secondary]!;
  state.slots[0]!.weapon = loadout.primary;
  state.slots[0]!.mag = primaryDef.magSize;
  state.slots[0]!.reserve = primaryDef.reserveMax;
  state.slots[1]!.weapon = loadout.secondary;
  state.slots[1]!.mag = secondaryDef.magSize;
  state.slots[1]!.reserve = secondaryDef.reserveMax;
  state.lethal = loadout.lethal;
  state.tactical = loadout.tactical;
  state.perks = [loadout.perk1, loadout.perk2];
}

export function stepWeapon(state: PlayerState, cmd: InputCmd, _dt: number, out: WeaponEvents): void {
  const slot = state.slots[state.activeSlot]!;
  const def = activeWeaponDef(state);
  const firePressed = (cmd.buttons & BTN_FIRE) !== 0;
  const firePrevPressed = (state.lastButtons & BTN_FIRE) !== 0;
  const wantsFire = def.semiAuto ? (firePressed && !firePrevPressed) : firePressed;

  state.firing = false;
  if (wantsFire && slot.mag > 0 && state.reloadT <= 0) {
    slot.mag--;
    state.shotIndex++;
    state.firing = true;
    out.shots = 1;
    out.firedWeapon = slot.weapon;
  } else if (wantsFire && slot.mag <= 0) {
    out.dryFire = true;
  }

  const reloadPressed = (cmd.buttons & BTN_RELOAD) !== 0;
  const reloadPrevPressed = (state.lastButtons & BTN_RELOAD) !== 0;
  if (reloadPressed && !reloadPrevPressed && slot.mag < def.magSize && slot.reserve > 0 && state.reloadT <= 0) {
    state.reloadT = def.reloadTac;
    state.reloadTotal = def.reloadTac;
    out.reloadStarted = true;
  }
  if (state.reloadT > 0) {
    state.reloadT = Math.max(0, state.reloadT - _dt);
    if (state.reloadT === 0) {
      const need = def.magSize - slot.mag;
      const take = Math.min(need, slot.reserve);
      slot.mag += take;
      slot.reserve -= take;
      out.reloadFinished = true;
    }
  }

  state.lastButtons = cmd.buttons;
}
