// TEMP STUB for isolated verification of assignment-C files only. Will be deleted.
import type { MapLayout } from './types.ts';
import { MAT_CONCRETE } from '../constants.ts';

export const MAP_COMPOUND_LAYOUT: MapLayout = {
  id: 0,
  name: 'Compound (stub)',
  width: 90,
  depth: 70,
  boxes: [{ x: -45, y: -1, z: -35, w: 90, h: 1, d: 70, material: MAT_CONCRETE, tag: 'floor' }],
  ramps: [],
  props: [],
  spawns: [
    { team: 1, x: -20, y: 0, z: 0, yaw: 0 },
    { team: 2, x: 20, y: 0, z: 0, yaw: Math.PI },
  ],
  sites: [],
  lights: [],
  navCellSize: 1,
  groundMaterial: MAT_CONCRETE,
  killY: -50,
};

export function getMapLayout(_id: number): MapLayout {
  return MAP_COMPOUND_LAYOUT;
}
