// TEMP STUB for isolated verification of assignment-C files only. Will be deleted.
import type { PlayerState, Vec3 } from './types.ts';
import { WEAPON_AR, WEAPON_COUNT, WEAPON_PISTOL, WEAPON_SHOTGUN, ZONE_CHEST, ZONE_HEAD } from './constants.ts';

export interface WeaponDef {
  id: number;
  name: string;
  slot: number;
  damageRanges: number[];
  damageValues: number[];
  rpm: number;
  magSize: number;
  reserveMax: number;
  reloadTac: number;
  reloadEmpty: number;
  adsTime: number;
  adsFov: number;
  adsMoveSpeed: number;
  sprintOut: number;
  recoilPitch: number;
  recoilYaw: number;
  recoilPattern: 'rise' | 'drift' | 'random';
  spreadStand: number;
  spreadCrouch: number;
  spreadMove: number;
  spreadJump: number;
  spreadAds: number;
  multHead: number;
  multChest: number;
  multLimb: number;
  pellets: number;
  pelletConeAds: number;
  pelletConeHip: number;
  semiAuto: boolean;
  shellReload: boolean;
  shellTime: number;
  modelLength: number;
  fireSoundId: string;
}

function make(id: number, name: string, pellets = 1): WeaponDef {
  return {
    id, name, slot: 0,
    damageRanges: [999], damageValues: [30],
    rpm: 6000, magSize: 30, reserveMax: 120, reloadTac: 2, reloadEmpty: 2.5,
    adsTime: 0.25, adsFov: 60, adsMoveSpeed: 2.6, sprintOut: 0.25,
    recoilPitch: 0.35, recoilYaw: 0.1, recoilPattern: 'rise',
    spreadStand: 2, spreadCrouch: 1.5, spreadMove: 4, spreadJump: 7, spreadAds: 0.5,
    multHead: 1.4, multChest: 1.0, multLimb: 0.9,
    pellets, pelletConeAds: 5, pelletConeHip: 8,
    semiAuto: false, shellReload: false, shellTime: 0.5,
    modelLength: 0.7, fireSoundId: name,
  };
}

export const WEAPONS: readonly WeaponDef[] = (() => {
  const arr: WeaponDef[] = [];
  arr[WEAPON_AR] = make(WEAPON_AR, 'AR');
  arr[1] = make(1, 'SMG');
  arr[2] = make(2, 'Sniper');
  arr[WEAPON_SHOTGUN] = make(WEAPON_SHOTGUN, 'Shotgun', 8);
  arr[WEAPON_PISTOL] = make(WEAPON_PISTOL, 'Pistol');
  arr.length = WEAPON_COUNT;
  return arr;
})();

export function damageAt(def: WeaponDef, _dist: number, zone: number): number {
  const base = def.damageValues[0] ?? 30;
  const mult = zone === ZONE_HEAD ? def.multHead : zone === ZONE_CHEST ? def.multChest : def.multLimb;
  return base * mult;
}

export function recoilAt(_def: WeaponDef, _shotIndex: number, _rng: () => number): { pitch: number; yaw: number } {
  return { pitch: 0, yaw: 0 };
}

export function spreadFor(_def: WeaponDef, _state: PlayerState): number {
  return 0;
}

export function pelletDirs(def: WeaponDef, dir: Vec3, _coneRad: number, _rng: () => number, out: Vec3[]): number {
  const n = Math.max(1, def.pellets);
  for (let i = 0; i < n && i < out.length; i++) {
    out[i]!.x = dir.x; out[i]!.y = dir.y; out[i]!.z = dir.z;
  }
  return Math.min(n, out.length);
}

export function weaponName(id: number): string {
  return WEAPONS[id]?.name ?? 'unknown';
}
