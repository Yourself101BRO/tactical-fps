// Loads every downloaded/custom asset into three.js objects, normalizes
// weapon and grenade models into a common convention, and falls back to
// client/assets/fallbacks.ts for anything missing or broken. Never throws:
// the worst case is a fully-procedural game.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

import {
  PROJ_FLASH,
  PROJ_FRAG,
  PROJ_SMOKE,
  WEAPON_AR,
  WEAPON_PISTOL,
  WEAPON_SHOTGUN,
  WEAPON_SMG,
  WEAPON_SNIPER,
} from '../../shared/constants.ts';
import { WEAPONS } from '../../shared/weapons.ts';
import type { AssetIndex, AssetIndexEntry, CreditEntry } from './index-types.ts';
import {
  makeFallbackCharacter,
  makeFallbackGrenade,
  makeFallbackProp,
  makeFallbackWeapon,
  makeNoiseTexture,
} from './fallbacks.ts';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type CharacterSource = 'operator' | 'soldier' | 'custom' | 'fallback';

export interface LoadedCharacter {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
  source: CharacterSource;
}

export interface TextureBundle {
  map: THREE.Texture;
  normalMap: THREE.Texture | null;
  roughnessMap: THREE.Texture | null;
}

export interface GameAssetAudioUrls {
  /** Grouped by a lowercase surface/category guessed from the Kenney impact-sounds filenames. */
  impacts: Record<string, string[]>;
  /** Grouped by a lowercase surface guessed from the footsteps pack filenames. */
  footsteps: Record<string, string[]>;
  /** One URL per interface sound, keyed by its filename without extension. */
  ui: Record<string, string>;
}

export interface GameAssets {
  index: AssetIndex;
  character: LoadedCharacter;
  /** Keyed by WEAPON_* id. */
  weapons: Map<number, THREE.Object3D>;
  /** Keyed by PROJ_* id. */
  grenades: Map<number, THREE.Object3D>;
  /** Keyed by the Poly Haven prop slug (e.g. "Barrel_01", "ammo_box"). */
  props: Map<string, THREE.Object3D>;
  /** Keyed by the Poly Haven texture slug (e.g. "concrete_wall_007") — see NOTE below. */
  textures: Map<string, TextureBundle>;
  hdri: THREE.DataTexture | null;
  audioUrls: GameAssetAudioUrls;
  credits: CreditEntry[];
}

/** Shape of public/assets/custom/manifest.json — see docs/CUSTOM_ASSETS.md. */
export interface CustomManifest {
  character?: {
    url: string;
    clipMap?: Record<string, string>;
    scale?: number;
    author?: string;
    license?: string;
    sourceUrl?: string;
  };
  weapons?: Partial<Record<'ar' | 'smg' | 'sniper' | 'shotgun' | 'pistol', {
    url: string;
    scale?: number;
    muzzle?: [number, number, number];
    grip?: [number, number, number];
    author?: string;
    license?: string;
    sourceUrl?: string;
  }>>;
}

export interface LoadAssetsOptions {
  character?: 'operator' | 'soldier';
}

// ---------------------------------------------------------------------------
// Shared loader instances (stateless enough to reuse across calls)
// ---------------------------------------------------------------------------

const gltfLoader = new GLTFLoader();
const fbxLoader = new FBXLoader();
const objLoader = new OBJLoader();
const mtlLoader = new MTLLoader();
const colladaLoader = new ColladaLoader();
const rgbeLoader = new RGBELoader();
const textureLoader = new THREE.TextureLoader();

/** Untextured meshes (OBJ without an .mtl, bare glTF primitives) get this. */
let gunmetalMaterial: THREE.MeshStandardMaterial | null = null;
function getGunmetalMaterial(): THREE.MeshStandardMaterial {
  if (!gunmetalMaterial) {
    gunmetalMaterial = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.45, metalness: 0.85 });
  }
  return gunmetalMaterial;
}

const WEAPON_NAME_BY_ID: Record<number, 'ar' | 'smg' | 'sniper' | 'shotgun' | 'pistol'> = {
  [WEAPON_AR]: 'ar',
  [WEAPON_SMG]: 'smg',
  [WEAPON_SNIPER]: 'sniper',
  [WEAPON_SHOTGUN]: 'shotgun',
  [WEAPON_PISTOL]: 'pistol',
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function emptyIndex(tier: string): AssetIndex {
  return { version: 1, tier, assets: {} };
}

/** Fetch JSON, returning null on any failure (missing file, bad JSON, network error) instead of throwing. */
async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Runs `worker` over `items` with at most `limit` in flight at once. */
async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function runner(): Promise<void> {
    while (next < items.length) {
      const item = items[next++]!;
      await worker(item);
    }
  }
  const runners: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(runner());
  await Promise.all(runners);
}

/** The Poly Haven-style slug a prop/texture asset lives under: the last path segment of its dest folder. */
function slugFromEntry(entry: AssetIndexEntry): string | null {
  const sample = entry.primary ?? entry.files[0] ?? entry.textures?.diff ?? null;
  if (!sample) return null;
  const parts = sample.split('/').filter(Boolean);
  // .../assets/<category>/<slug>/<file>
  return parts.length >= 2 ? parts[parts.length - 2]! : null;
}

function extOf(url: string): string {
  const clean = url.split('?')[0]!;
  const dot = clean.lastIndexOf('.');
  return dot === -1 ? '' : clean.slice(dot + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Generic model loading by extension
// ---------------------------------------------------------------------------

async function loadModelByUrl(url: string): Promise<THREE.Object3D> {
  const ext = extOf(url);
  switch (ext) {
    case 'glb':
    case 'gltf': {
      const gltf = await gltfLoader.loadAsync(url);
      return gltf.scene;
    }
    case 'fbx':
      return await fbxLoader.loadAsync(url);
    case 'obj': {
      const mtlUrl = url.replace(/\.obj$/i, '.mtl');
      try {
        const materials = await mtlLoader.loadAsync(mtlUrl);
        materials.preload();
        objLoader.setMaterials(materials);
      } catch {
        // No sibling .mtl (or it 404s) — objects load with three's default
        // material, and applyDefaultMaterial() below swaps in gunmetal.
        objLoader.setMaterials(null as unknown as never);
      }
      return await objLoader.loadAsync(url);
    }
    case 'dae': {
      const collada = await colladaLoader.loadAsync(url);
      if (!collada) throw new Error(`loader.ts: failed to parse Collada file ${url}`);
      return collada.scene;
    }
    default:
      throw new Error(`loader.ts: unsupported model extension ".${ext}" for ${url}`);
  }
}

/** Meshes with no map (plain OBJ, or glTF primitives that failed to bring materials) get the standard gunmetal look. */
function applyDefaultMaterialIfUntextured(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return;
    const mat = mesh.material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] | undefined;
    const isUntextured = (m: THREE.Material | undefined): boolean => {
      if (!m) return true;
      const std = m as THREE.MeshStandardMaterial;
      return !('map' in std) || !std.map;
    };
    if (Array.isArray(mat)) {
      if (mat.every(isUntextured)) mesh.material = getGunmetalMaterial();
    } else if (isUntextured(mat)) {
      mesh.material = getGunmetalMaterial();
    }
  });
}

// ---------------------------------------------------------------------------
// Weapon normalization
// ---------------------------------------------------------------------------

/** Samples geometry along `axis` to find which extreme has the smaller cross-section (the barrel tip). */
function detectBarrelSign(root: THREE.Object3D, axis: 'x' | 'y' | 'z'): -1 | 1 {
  root.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  let minA = Infinity;
  let maxA = -Infinity;
  const samples: Array<{ a: number; r: number }> = [];

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return;
    const pos = mesh.geometry?.attributes?.['position'];
    if (!pos) return;
    const step = Math.max(1, Math.floor(pos.count / 400));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const a = axis === 'x' ? v.x : axis === 'y' ? v.y : v.z;
      const o1 = axis === 'x' ? v.y : v.x;
      const o2 = axis === 'z' ? v.y : v.z;
      const r = Math.hypot(o1, o2);
      samples.push({ a, r });
      if (a < minA) minA = a;
      if (a > maxA) maxA = a;
    }
  });
  if (samples.length === 0 || !isFinite(minA) || !isFinite(maxA)) return -1;
  const span = maxA - minA || 1;
  let sumMin = 0, cntMin = 0, sumMax = 0, cntMax = 0;
  for (const s of samples) {
    if ((s.a - minA) / span < 0.15) { sumMin += s.r; cntMin++; }
    if ((maxA - s.a) / span < 0.15) { sumMax += s.r; cntMax++; }
  }
  const rMin = cntMin ? sumMin / cntMin : 0;
  const rMax = cntMax ? sumMax / cntMax : 0;
  // The thinner end is the barrel. Return which extreme (min = -1, max = +1) it is.
  return rMin <= rMax ? -1 : 1;
}

/**
 * Centers the model, rotates so the longest axis points -Z with the (auto
 * detected) barrel tip forward, scales to `targetLength`, and adds Muzzle/Grip
 * empties. Returns a new wrapper Group; the source object becomes its child.
 */
function normalizeWeaponObject(source: THREE.Object3D, targetLength: number): THREE.Group {
  const box = new THREE.Box3().setFromObject(source);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const size = new THREE.Vector3();
  box.getSize(size);

  const wrapper = new THREE.Group();
  source.position.sub(center);
  wrapper.add(source);

  let longest: 'x' | 'y' | 'z' = 'x';
  if (size.y >= size.x && size.y >= size.z) longest = 'y';
  else if (size.z >= size.x && size.z >= size.y) longest = 'z';

  const sign = detectBarrelSign(wrapper, longest);
  const axisVec = new THREE.Vector3(
    longest === 'x' ? sign : 0,
    longest === 'y' ? sign : 0,
    longest === 'z' ? sign : 0,
  );
  const targetDir = new THREE.Vector3(0, 0, -1);
  wrapper.quaternion.setFromUnitVectors(axisVec, targetDir);

  // Re-measure in the new orientation (pre-scale) to place Muzzle/Grip and to
  // get the exact length to scale from.
  wrapper.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(wrapper);
  const length = Math.max(1e-4, box2.max.z - box2.min.z);
  const scale = targetLength / length;
  wrapper.scale.setScalar(scale);

  const muzzle = new THREE.Object3D();
  muzzle.name = 'Muzzle';
  muzzle.position.set(0, 0, box2.min.z);
  wrapper.add(muzzle);

  const grip = new THREE.Object3D();
  grip.name = 'Grip';
  grip.position.set(0, -0.05 * length, box2.max.z - 0.35 * length);
  wrapper.add(grip);

  applyDefaultMaterialIfUntextured(wrapper);
  return wrapper;
}

async function loadNormalizedWeapon(url: string, targetLength: number): Promise<THREE.Object3D> {
  const raw = await loadModelByUrl(url);
  return normalizeWeaponObject(raw, targetLength);
}

// ---------------------------------------------------------------------------
// Character loading
// ---------------------------------------------------------------------------

async function loadCharacterFromUrl(url: string): Promise<{ scene: THREE.Group; clips: THREE.AnimationClip[] }> {
  const ext = extOf(url);
  if (ext === 'fbx') {
    const group = await fbxLoader.loadAsync(url);
    return { scene: group, clips: group.animations ?? [] };
  }
  const gltf = await gltfLoader.loadAsync(url);
  return { scene: gltf.scene, clips: gltf.animations ?? [] };
}

/** Renames clips per a canonical-name -> source-clip-name map (see docs/CUSTOM_ASSETS.md), dropping unmatched entries. */
function remapClips(clips: THREE.AnimationClip[], clipMap: Record<string, string>): THREE.AnimationClip[] {
  const bySource = new Map<string, THREE.AnimationClip>();
  for (const c of clips) bySource.set(c.name, c);
  const out: THREE.AnimationClip[] = [];
  for (const [canonical, sourceName] of Object.entries(clipMap)) {
    const src = bySource.get(sourceName);
    if (!src) {
      // Common cause: the exported clip's internal name doesn't exactly match
      // clipMap's value (Mixamo FBX exports name clips things like
      // "mixamo.com|Idle" or "Armature|mixamo.com|Idle" depending on export
      // settings) — see docs/CUSTOM_ASSETS.md for how to find the real name.
      console.warn(
        `[assets] custom character: clipMap["${canonical}"] = "${sourceName}" not found in the file's clips ` +
          `(available: ${clips.map((c) => c.name).join(', ') || '(none)'})`,
      );
      continue;
    }
    const clone = src.clone();
    clone.name = canonical;
    out.push(clone);
  }
  return out;
}

async function loadCharacter(
  index: AssetIndex,
  custom: CustomManifest | null,
  opts: LoadAssetsOptions,
): Promise<LoadedCharacter> {
  if (custom?.character) {
    try {
      const { scene, clips } = await loadCharacterFromUrl(custom.character.url);
      if (custom.character.scale) scene.scale.setScalar(custom.character.scale);
      const finalClips = custom.character.clipMap ? remapClips(clips, custom.character.clipMap) : clips;
      return { scene, clips: finalClips, source: 'custom' };
    } catch (err) {
      console.warn('[assets] custom character failed to load, falling back:', err);
    }
  }

  const wantId = opts.character === 'soldier' ? 'character_soldier' : 'character_operator';
  const entry = index.assets[wantId];
  if (entry && !entry.failed && entry.primary) {
    try {
      const { scene, clips } = await loadCharacterFromUrl(entry.primary);
      return { scene, clips, source: opts.character === 'soldier' ? 'soldier' : 'operator' };
    } catch (err) {
      console.warn(`[assets] ${wantId} failed to load, falling back:`, err);
    }
  }

  const fb = makeFallbackCharacter();
  return { scene: fb.scene, clips: fb.clips, source: 'fallback' };
}

// ---------------------------------------------------------------------------
// Grenades: one OBJ split by child object name into flash/frag/smoke
// ---------------------------------------------------------------------------

async function loadGrenades(index: AssetIndex): Promise<Map<number, THREE.Object3D>> {
  const out = new Map<number, THREE.Object3D>();
  const kinds: Array<{ kind: number; keywords: string[] }> = [
    { kind: PROJ_FLASH, keywords: ['flash'] },
    { kind: PROJ_SMOKE, keywords: ['smoke'] },
    { kind: PROJ_FRAG, keywords: ['frag', 'grenade'] },
  ];

  const entry = index.assets['grenades'];
  const url = entry && !entry.failed ? entry.primary ?? entry.files[0] ?? null : null;
  if (!url) {
    for (const { kind } of kinds) out.set(kind, makeFallbackGrenade(kind));
    return out;
  }

  /** Centre a set of objects in a wrapper scaled to a 9 cm tall grenade. */
  const wrap = (objects: THREE.Object3D[]): THREE.Object3D => {
    const group = new THREE.Group();
    for (const o of objects) group.add(o.clone(true));
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    for (const child of group.children) child.position.sub(center);
    const wrapper = new THREE.Group();
    wrapper.add(group);
    wrapper.scale.setScalar(0.09 / Math.max(size.y, 1e-4));
    return wrapper;
  };

  try {
    const root = await loadModelByUrl(url);
    applyDefaultMaterialIfUntextured(root);
    root.updateMatrixWorld(true);

    // 1) Named objects (flash/smoke/frag) if the file has them.
    const found = new Set<THREE.Object3D>();
    for (const { kind, keywords } of kinds) {
      let match: THREE.Object3D | null = null;
      root.traverse((obj) => {
        if (match || found.has(obj)) return;
        const lower = obj.name.toLowerCase();
        if (keywords.some((k) => lower.includes(k))) match = obj;
      });
      const picked: THREE.Object3D | null = match;
      if (picked) {
        found.add(picked);
        out.set(kind, wrap([picked]));
      }
    }
    if (out.size === kinds.length) return out;

    // 2) Generic object names ("Cylinder.003", "Torus.002", ...): the pack lays the
    // three grenades out side by side, so cluster meshes by their X centroid into
    // three groups and classify by silhouette — the frag has the sphere body, the
    // flashbang carries the torus ring, the smoke is what remains.
    const meshes: Array<{ obj: THREE.Object3D; x: number; name: string }> = [];
    const centroid = new THREE.Vector3();
    root.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const lower = obj.name.toLowerCase();
      if (lower.includes('plane') || lower.includes('ground')) return;
      new THREE.Box3().setFromObject(obj).getCenter(centroid);
      meshes.push({ obj, x: centroid.x, name: lower });
    });
    if (meshes.length >= 3) {
      meshes.sort((a, b) => a.x - b.x);
      // Split at the two largest gaps along X.
      const gaps = meshes.slice(1).map((m, i) => ({ i: i + 1, gap: m.x - meshes[i]!.x }));
      gaps.sort((a, b) => b.gap - a.gap);
      const cuts = gaps.slice(0, 2).map((g) => g.i).sort((a, b) => a - b);
      const groups: Array<typeof meshes> = [meshes.slice(0, cuts[0]), meshes.slice(cuts[0], cuts[1]), meshes.slice(cuts[1])];
      const has = (g: typeof meshes, key: string) => g.some((m) => m.name.includes(key));
      const remaining = new Set(kinds.map((k) => k.kind).filter((k) => !out.has(k)));
      const assign = (g: typeof meshes, kind: number) => {
        if (!remaining.has(kind)) return;
        remaining.delete(kind);
        out.set(kind, wrap(g.map((m) => m.obj)));
      };
      const unassigned: Array<typeof meshes> = [];
      for (const g of groups) {
        if (has(g, 'sphere')) assign(g, PROJ_FRAG);
        else if (has(g, 'torus')) assign(g, PROJ_FLASH);
        else unassigned.push(g);
      }
      for (const g of unassigned) {
        const next = [PROJ_SMOKE, PROJ_FLASH, PROJ_FRAG].find((k) => remaining.has(k));
        if (next !== undefined) assign(g, next);
      }
    }
    for (const { kind } of kinds) if (!out.has(kind)) out.set(kind, makeFallbackGrenade(kind));
  } catch (err) {
    console.warn('[assets] grenades.obj failed to load, using fallbacks:', err);
    for (const { kind } of kinds) if (!out.has(kind)) out.set(kind, makeFallbackGrenade(kind));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Props and textures
// ---------------------------------------------------------------------------

async function loadProp(url: string): Promise<THREE.Object3D> {
  const gltf = await gltfLoader.loadAsync(url);
  return gltf.scene;
}

async function loadTextureBundle(entry: AssetIndexEntry, mobile: boolean): Promise<TextureBundle> {
  const t = entry.textures ?? {};
  const diffUrl = (mobile && t.diff512) || t.diff;
  const norUrl = (mobile && t.nor512) || t.nor;
  const roughUrl = (mobile && t.rough512) || t.rough;
  if (!diffUrl) throw new Error('texture entry has no diffuse map');

  const map = await textureLoader.loadAsync(diffUrl);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.generateMipmaps = true;

  let normalMap: THREE.Texture | null = null;
  if (norUrl) {
    normalMap = await textureLoader.loadAsync(norUrl);
    normalMap.wrapS = THREE.RepeatWrapping;
    normalMap.wrapT = THREE.RepeatWrapping;
  }
  let roughnessMap: THREE.Texture | null = null;
  if (roughUrl) {
    roughnessMap = await textureLoader.loadAsync(roughUrl);
    roughnessMap.wrapS = THREE.RepeatWrapping;
    roughnessMap.wrapT = THREE.RepeatWrapping;
  }
  return { map, normalMap, roughnessMap };
}

// ---------------------------------------------------------------------------
// Audio grouping
// ---------------------------------------------------------------------------

function baseName(url: string): string {
  const file = url.split('/').pop() ?? url;
  return file.replace(/\.[^.]+$/, '');
}

/** Kenney/OpenGameArt files are named "<Category><variant>_<index>.ext"; group by the leading alpha run. */
function groupByPrefix(urls: string[], stripPrefix?: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const url of urls) {
    let name = baseName(url);
    if (stripPrefix && name.toLowerCase().startsWith(stripPrefix)) name = name.slice(stripPrefix.length);
    const m = /^[A-Za-z]+/.exec(name);
    const key = (m ? m[0] : 'misc').toLowerCase();
    (out[key] ??= []).push(url);
  }
  return out;
}

/** The OpenGameArt footsteps pack is organised as "<surface>/<n>.ogg"; group by the parent folder. */
function groupByFolder(urls: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const url of urls) {
    const parts = url.split('/');
    const folder = parts.length >= 2 ? parts[parts.length - 2]! : 'misc';
    (out[folder.toLowerCase()] ??= []).push(url);
  }
  return out;
}

function buildAudioUrls(index: AssetIndex): GameAssetAudioUrls {
  const impactsEntry = index.assets['audio_impacts'];
  const footstepsEntry = index.assets['audio_footsteps'];
  const uiEntry = index.assets['audio_interface'];

  const impacts = impactsEntry && !impactsEntry.failed ? groupByPrefix(impactsEntry.files, 'impact') : {};
  const footsteps = footstepsEntry && !footstepsEntry.failed ? groupByFolder(footstepsEntry.files) : {};
  const ui: Record<string, string> = {};
  if (uiEntry && !uiEntry.failed) {
    for (const url of uiEntry.files) ui[baseName(url)] = url;
  }
  return { impacts, footsteps, ui };
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

function buildCredits(index: AssetIndex, custom: CustomManifest | null): CreditEntry[] {
  const out: CreditEntry[] = [];
  const seen = new Set<string>();
  for (const entry of Object.values(index.assets)) {
    if (entry.failed) continue;
    const key = `${entry.name}|${entry.author}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: entry.name,
      author: entry.author,
      license: entry.license,
      licenseUrl: entry.licenseUrl,
      sourceUrl: entry.sourceUrl,
      attributionRequired: entry.attributionRequired,
    });
  }
  if (custom?.character) {
    out.push({
      name: 'Custom character',
      author: custom.character.author ?? 'unknown',
      license: custom.character.license ?? 'unknown',
      licenseUrl: '',
      sourceUrl: custom.character.sourceUrl ?? '',
      attributionRequired: true,
    });
  }
  if (custom?.weapons) {
    for (const [name, w] of Object.entries(custom.weapons)) {
      if (!w) continue;
      out.push({
        name: `Custom weapon (${name})`,
        author: w.author ?? 'unknown',
        license: w.license ?? 'unknown',
        licenseUrl: '',
        sourceUrl: w.sourceUrl ?? '',
        attributionRequired: true,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Loads every asset category for the given tier. Never throws — any failure
 * (missing index.json, a bad download, an unsupported file) degrades to the
 * matching procedural fallback and a console.warn.
 */
export async function loadAssets(
  tier: 'desktop' | 'mobile',
  onProgress: (done: number, total: number, label: string) => void,
  opts: LoadAssetsOptions = {},
): Promise<GameAssets> {
  const mobile = tier === 'mobile';
  const [index, custom] = await Promise.all([
    fetchJson<AssetIndex>('/assets/index.json'),
    fetchJson<CustomManifest>('/assets/custom/manifest.json'),
  ]);
  const resolvedIndex = index ?? emptyIndex(tier);

  const weapons = new Map<number, THREE.Object3D>();
  const props = new Map<string, THREE.Object3D>();
  const textures = new Map<string, TextureBundle>();
  let hdri: THREE.DataTexture | null = null;
  let grenades = new Map<number, THREE.Object3D>();

  const propEntries = Object.entries(resolvedIndex.assets).filter(([, e]) => e.category === 'prop');
  const textureEntries = Object.entries(resolvedIndex.assets).filter(([, e]) => e.category === 'texture');
  const hdriEntry = resolvedIndex.assets['hdri_parking'];

  const weaponIds = [WEAPON_AR, WEAPON_SMG, WEAPON_SNIPER, WEAPON_SHOTGUN, WEAPON_PISTOL];
  const total = 1 /* character */ + weaponIds.length + 1 /* grenades */ + propEntries.length + textureEntries.length + 1 /* hdri */;
  let done = 0;
  const tick = (label: string): void => {
    done++;
    onProgress(done, total, label);
  };

  const character = await loadCharacter(resolvedIndex, custom, opts);
  tick('character');

  await mapLimit(weaponIds, 6, async (id) => {
    const name = WEAPON_NAME_BY_ID[id]!;
    const customWeapon = custom?.weapons?.[name];
    const targetLength = WEAPONS[id]?.modelLength ?? 0.7;
    if (customWeapon) {
      try {
        const obj = await loadNormalizedWeapon(customWeapon.url, customWeapon.scale ? targetLength * customWeapon.scale : targetLength);
        if (customWeapon.muzzle) {
          const m = obj.getObjectByName('Muzzle');
          if (m) m.position.set(...customWeapon.muzzle);
        }
        if (customWeapon.grip) {
          const g = obj.getObjectByName('Grip');
          if (g) g.position.set(...customWeapon.grip);
        }
        weapons.set(id, obj);
        tick(`weapon:${name}`);
        return;
      } catch (err) {
        console.warn(`[assets] custom weapon "${name}" failed to load, falling back:`, err);
      }
    }
    const entry = resolvedIndex.assets[`weapon_${name}`];
    if (entry && !entry.failed && entry.primary) {
      try {
        weapons.set(id, await loadNormalizedWeapon(entry.primary, targetLength));
        tick(`weapon:${name}`);
        return;
      } catch (err) {
        console.warn(`[assets] weapon_${name} failed to load, falling back:`, err);
      }
    }
    weapons.set(id, makeFallbackWeapon(id));
    tick(`weapon:${name}`);
  });

  grenades = await loadGrenades(resolvedIndex);
  tick('grenades');

  await mapLimit(propEntries, 6, async ([id, entry]) => {
    const slug = slugFromEntry(entry) ?? id;
    if (!entry.failed && entry.primary) {
      try {
        props.set(slug, await loadProp(entry.primary));
        tick(`prop:${slug}`);
        return;
      } catch (err) {
        console.warn(`[assets] prop "${id}" failed to load, falling back:`, err);
      }
    }
    props.set(slug, makeFallbackProp(slug));
    tick(`prop:${slug}`);
  });

  await mapLimit(textureEntries, 6, async ([id, entry]) => {
    const slug = slugFromEntry(entry) ?? id;
    if (!entry.failed) {
      try {
        textures.set(slug, await loadTextureBundle(entry, mobile));
        tick(`texture:${slug}`);
        return;
      } catch (err) {
        console.warn(`[assets] texture "${id}" failed to load, using noise fallback:`, err);
      }
    }
    textures.set(slug, { map: makeNoiseTexture(64, 0x777777), normalMap: null, roughnessMap: null });
    tick(`texture:${slug}`);
  });

  if (hdriEntry && !hdriEntry.failed) {
    const url = hdriEntry.primary ?? hdriEntry.files[0];
    if (url) {
      try {
        const tex = await rgbeLoader.loadAsync(url);
        tex.mapping = THREE.EquirectangularReflectionMapping;
        hdri = tex;
      } catch (err) {
        console.warn('[assets] HDRI failed to load, renderer should use the gradient-sky fallback:', err);
      }
    }
  }
  tick('hdri');

  return {
    index: resolvedIndex,
    character,
    weapons,
    grenades,
    props,
    textures,
    hdri,
    audioUrls: buildAudioUrls(resolvedIndex),
    credits: buildCredits(resolvedIndex, custom),
  };
}
