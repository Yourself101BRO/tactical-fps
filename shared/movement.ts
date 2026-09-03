// TEMP STUB for isolated verification of assignment-C files only. Will be deleted.
import type { InputCmd, PlayerState } from './types.ts';
import type { MapColliders } from './map/types.ts';
import type { MovementEvents } from './sim/types.ts';
import { EYE_CROUCH, EYE_PRONE, EYE_STAND, HEIGHT_CROUCH, HEIGHT_PRONE, HEIGHT_STAND, STANCE_CROUCH, STANCE_PRONE, SPEED_WALK } from './constants.ts';

export function eyeHeight(state: PlayerState): number {
  if (state.stance === STANCE_CROUCH) return EYE_CROUCH;
  if (state.stance === STANCE_PRONE) return EYE_PRONE;
  return EYE_STAND;
}

export function heightForStance(stance: number): number {
  if (stance === STANCE_CROUCH) return HEIGHT_CROUCH;
  if (stance === STANCE_PRONE) return HEIGHT_PRONE;
  return HEIGHT_STAND;
}

export function currentMaxSpeed(_state: PlayerState): number {
  return SPEED_WALK;
}

/** Trivial stub: just copies aim from the cmd; does not move the body (tests set positions directly). */
export function stepPlayer(state: PlayerState, cmd: InputCmd, _colliders: MapColliders, _dt: number, out: MovementEvents): void {
  state.yaw = cmd.yaw;
  state.pitch = cmd.pitch;
  out.footstepMaterial = -1;
}
