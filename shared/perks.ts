// TEMP STUB for isolated verification of assignment-C files only. Will be deleted.
import type { PlayerState } from './types.ts';
import { PERK_COUNT, REGEN_DELAY } from './constants.ts';

export const PERKS: readonly { id: number; name: string; description: string }[] = Array.from(
  { length: PERK_COUNT },
  (_, i) => ({ id: i, name: `perk${i}`, description: '' }),
);

export function hasPerk(state: PlayerState, perk: number): boolean {
  return state.perks[0] === perk || state.perks[1] === perk;
}
export function tacSprintDurationMult(_state: PlayerState): number { return 1; }
export function crouchSpeedMult(_state: PlayerState): number { return 1; }
export function explosiveDamageMult(_state: PlayerState): number { return 1; }
export function swapTimeMult(_state: PlayerState): number { return 1; }
export function regenDelayFor(_state: PlayerState): number { return REGEN_DELAY; }
export function isGhost(_state: PlayerState): boolean { return false; }
export function hasTracker(_state: PlayerState): boolean { return false; }
