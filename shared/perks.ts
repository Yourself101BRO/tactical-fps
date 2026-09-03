// The 6 perks from plan §4. Each perk only scales a constant that already
// exists in shared/constants.ts — no new tunables are introduced here.

import {
  AMPED_SWAP_MULT,
  EOD_EXPLOSIVE_MULT,
  PERK_AMPED,
  PERK_COUNT,
  PERK_DOUBLE_TIME,
  PERK_EOD,
  PERK_GHOST,
  PERK_NONE,
  PERK_QUICK_FIX,
  PERK_TRACKER,
  REGEN_DELAY,
  REGEN_DELAY_QUICK_FIX,
} from './constants.ts';
import type { PlayerState } from './types.ts';

export interface PerkDef {
  id: number;
  name: string;
  description: string;
}

export const PERKS: readonly PerkDef[] = [
  { id: PERK_NONE, name: 'None', description: 'No perk equipped.' },
  { id: PERK_DOUBLE_TIME, name: 'Double Time', description: 'Tactical sprint lasts twice as long; crouch-move speed is 15% faster.' },
  { id: PERK_EOD, name: 'E.O.D.', description: 'Take half damage from explosives.' },
  { id: PERK_GHOST, name: 'Ghost', description: 'Hidden from the minimap while it would otherwise reveal you.' },
  { id: PERK_AMPED, name: 'Amped', description: 'Weapon swap speed is 1.7x faster.' },
  { id: PERK_QUICK_FIX, name: 'Quick Fix', description: 'Health regen starts after 1.5s instead of 4s.' },
  { id: PERK_TRACKER, name: 'Tracker', description: 'See enemy footstep decals for 3s after they pass nearby.' },
];

if (PERKS.length !== PERK_COUNT) {
  throw new Error(`PERKS table has ${PERKS.length} entries, expected PERK_COUNT=${PERK_COUNT}`);
}

export function hasPerk(state: PlayerState, perk: number): boolean {
  return state.perks[0] === perk || state.perks[1] === perk;
}

export function tacSprintDurationMult(state: PlayerState): number {
  return hasPerk(state, PERK_DOUBLE_TIME) ? 2 : 1;
}

export function crouchSpeedMult(state: PlayerState): number {
  return hasPerk(state, PERK_DOUBLE_TIME) ? 1.15 : 1;
}

export function explosiveDamageMult(state: PlayerState): number {
  return hasPerk(state, PERK_EOD) ? EOD_EXPLOSIVE_MULT : 1;
}

export function swapTimeMult(state: PlayerState): number {
  return hasPerk(state, PERK_AMPED) ? AMPED_SWAP_MULT : 1;
}

export function regenDelayFor(state: PlayerState): number {
  return hasPerk(state, PERK_QUICK_FIX) ? REGEN_DELAY_QUICK_FIX : REGEN_DELAY;
}

export function isGhost(state: PlayerState): boolean {
  return hasPerk(state, PERK_GHOST);
}

export function hasTracker(state: PlayerState): boolean {
  return hasPerk(state, PERK_TRACKER);
}
