// Pure-logic tests for client/audio/**. Nothing here touches AudioContext or
// the DOM: buildGunshotBank()/loadSampleBank() need a real Web Audio context
// and are exercised manually/in-browser instead. What's covered here is
// everything that can go wrong without ever creating a sound: the weapon
// parameter table, the material -> asset-group mappings, and the local RNG.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WEAPON_AR,
  WEAPON_SMG,
  WEAPON_SNIPER,
  WEAPON_SHOTGUN,
  WEAPON_PISTOL,
  WEAPON_COUNT,
  MAT_METAL,
  MAT_WOOD,
  MAT_CONCRETE,
  MAT_GRAVEL,
  MAT_FLESH,
} from '../shared/constants.ts';
import { shotParamsFor } from '../client/audio/synth-guns.ts';
import { impactGroupsFor, footstepSurfaceFor, createLcg } from '../client/audio/samples.ts';
import { AudioEngine } from '../client/audio/audio.ts';

test('every weapon id has synthesis parameters', () => {
  for (let w = 0; w < WEAPON_COUNT; w++) {
    const p = shotParamsFor(w);
    assert.ok(p.centerFreq > 0, `weapon ${w} centerFreq`);
    assert.ok(p.bodyLen > 0 && p.bodyLen < 1, `weapon ${w} bodyLen`);
  }
});

test('sniper reads as the lowest, longest gunshot; SMG as the shortest', () => {
  const sniper = shotParamsFor(WEAPON_SNIPER);
  const ar = shotParamsFor(WEAPON_AR);
  const smg = shotParamsFor(WEAPON_SMG);
  const shotgun = shotParamsFor(WEAPON_SHOTGUN);
  const pistol = shotParamsFor(WEAPON_PISTOL);
  // Shotgun (350 Hz) and sniper (400 Hz) are the two lowest, fattest-sounding
  // weapons by design; both should read as darker than the AR.
  assert.ok(sniper.centerFreq < ar.centerFreq);
  assert.ok(shotgun.centerFreq < ar.centerFreq);
  assert.ok(sniper.bodyLen > ar.bodyLen);
  assert.ok(sniper.bodyLen > smg.bodyLen);
  assert.ok(sniper.bodyLen > pistol.bodyLen);
});

test('unknown weapon id falls back to the AR parameters rather than throwing', () => {
  const fallback = shotParamsFor(999);
  assert.deepEqual(fallback, shotParamsFor(WEAPON_AR));
});

test('impact group mapping matches the loader\'s stripped/lower-cased Kenney group keys', () => {
  assert.deepEqual(impactGroupsFor(MAT_METAL), ['metal']);
  assert.deepEqual(impactGroupsFor(MAT_WOOD), ['wood']);
  assert.deepEqual(impactGroupsFor(MAT_CONCRETE), ['plate', 'mining']);
  assert.deepEqual(impactGroupsFor(MAT_GRAVEL), ['soft']);
  assert.deepEqual(impactGroupsFor(MAT_FLESH), ['soft']);
});

test('footstep surface has no sample for flesh but does for the rest', () => {
  assert.equal(footstepSurfaceFor(MAT_FLESH), null);
  assert.equal(footstepSurfaceFor(MAT_METAL), 'metal');
  assert.equal(footstepSurfaceFor(MAT_CONCRETE), 'concrete');
});

test('createLcg is deterministic for a given seed and stays in [0, 1)', () => {
  const a = createLcg(42);
  const b = createLcg(42);
  const seqA = [a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
});

test('createLcg with a different seed diverges', () => {
  const a = createLcg(1);
  const b = createLcg(2);
  assert.notEqual(a(), b());
});

test('AudioEngine construction stays side-effect free so it can run under Node', () => {
  const engine = new AudioEngine();
  assert.equal(engine.ctx, null);
  assert.equal(engine.isReady, false);
  assert.equal(engine.iosMuteHint, false);
  assert.equal(engine.buses, null);
  // play() before unlock() must return a harmless no-op handle, not throw.
  const handle = engine.play({} as AudioBuffer, { volume: 0.5 });
  handle.stop();
  handle.setVolume(0.1);
  handle.setPosition({ x: 0, y: 0, z: 0 });
});
