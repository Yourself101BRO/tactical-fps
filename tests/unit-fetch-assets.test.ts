// Unit tests for the pure, dependency-free helpers in scripts/fetch-assets.mjs
// (glob matching, primary-model selection, Poly Haven map-name normalization).
// Importing the module does NOT trigger a real fetch run — main() only runs
// when the file is executed directly (see the import.meta.url guard at its
// bottom), which is exactly what makes it safe to import here.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// fetch-assets.mjs is a plain Node script (not compiled, no .d.ts), so
// importing it has no declared type under strict mode — the whole module
// namespace is cast to the shape of the pure helpers this test uses below.
// @ts-expect-error -- no declaration file for this plain-JS sibling script
import * as fetchAssetsModule from '../scripts/fetch-assets.mjs';

interface FetchAssetsHelpers {
  globToRegExp(glob: string): RegExp;
  matchesAnyGlob(relPath: string, globs: string[] | undefined): boolean;
  pickPrimary(files: string[], prefer: string[] | undefined): string | null;
  normalizeMapName(map: string): string;
  textureMapFromFiles(files: string[], asset: { maps: string[] }): Record<string, string>;
}

const { globToRegExp, matchesAnyGlob, normalizeMapName, pickPrimary, textureMapFromFiles } =
  fetchAssetsModule as unknown as FetchAssetsHelpers;

test('globToRegExp: "*" matches any run of characters, is case-insensitive, anchored', () => {
  const re = globToRegExp('*.wav');
  assert.ok(re.test('shot.wav'));
  assert.ok(re.test('SHOT.WAV'));
  assert.ok(!re.test('shot.wav.bak'));
  assert.ok(!re.test('shotwav'));
});

test('matchesAnyGlob: matches on basename even when given a nested relative path', () => {
  assert.ok(matchesAnyGlob('sounds/deep/reload.wav', ['*.wav', '*.ogg']));
  assert.ok(!matchesAnyGlob('models/gun.glb', ['*.wav', '*.ogg']));
  assert.equal(matchesAnyGlob('anything', undefined), false);
  assert.equal(matchesAnyGlob('anything', []), false);
});

test('pickPrimary: honors an explicit prefer order over the default', () => {
  const files = ['/assets/weapons/ar/gun.obj', '/assets/weapons/ar/gun.fbx', '/assets/weapons/ar/gun.gltf'];
  assert.equal(pickPrimary(files, ['fbx', 'obj', 'gltf']), '/assets/weapons/ar/gun.fbx');
  // Default order is glb > gltf > fbx > dae > obj.
  assert.equal(pickPrimary(files, undefined), '/assets/weapons/ar/gun.gltf');
});

test('pickPrimary: falls back to the first file when nothing matches any preferred extension', () => {
  const files = ['/assets/props/thing.usdz'];
  assert.equal(pickPrimary(files, ['glb', 'gltf']), '/assets/props/thing.usdz');
});

test('pickPrimary: null for an empty file list', () => {
  assert.equal(pickPrimary([], undefined), null);
});

test('normalizeMapName: nor_gl/nor_dx collapse to "nor", arm and rough both collapse to "rough"', () => {
  assert.equal(normalizeMapName('nor_gl'), 'nor');
  assert.equal(normalizeMapName('nor_dx'), 'nor');
  assert.equal(normalizeMapName('rough'), 'rough');
  assert.equal(normalizeMapName('arm'), 'rough');
  assert.equal(normalizeMapName('diff'), 'diff');
});

test('textureMapFromFiles: reconstructs the textures bundle (incl. 512px variants) from a plain file list', () => {
  const asset = { maps: ['diff', 'nor_gl', 'rough'] };
  const files = [
    '/assets/textures/concrete_floor_01/concrete_floor_01_diff_1k.jpg',
    '/assets/textures/concrete_floor_01/concrete_floor_01_diff_1k_512.jpg',
    '/assets/textures/concrete_floor_01/concrete_floor_01_nor_gl_1k.jpg',
    '/assets/textures/concrete_floor_01/concrete_floor_01_rough_1k.jpg',
  ];
  const out = textureMapFromFiles(files, asset);
  assert.equal(out.diff, files[0]);
  assert.equal(out.diff512, files[1]);
  assert.equal(out.nor, files[2]);
  assert.equal(out.rough, files[3]);
});

test('textureMapFromFiles: an "arm" fallback file is reported under "rough"', () => {
  const asset = { maps: ['diff', 'nor_gl', 'rough'] };
  const files = ['/assets/textures/x/x_arm_1k.jpg', '/assets/textures/x/x_arm_1k_512.jpg'];
  const out = textureMapFromFiles(files, asset);
  assert.equal(out.rough, files[0]);
  assert.equal(out.rough512, files[1]);
});
