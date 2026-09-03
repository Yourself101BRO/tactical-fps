// Builds and caches every MeshStandardMaterial the renderer uses: named PBR
// surfaces (from loaded textures, with a procedural flat-color fallback when a
// texture set failed to download), weapon gunmetal/polymer, team tints and the
// operator's tactical-fabric body material.
import * as THREE from 'three';
import {
  MAT_ASPHALT,
  MAT_BRICK,
  MAT_CONCRETE,
  MAT_GRAVEL,
  MAT_METAL,
  MAT_PLASTER,
  MAT_SAND,
  MAT_WOOD,
  TEAM_A,
  TEAM_B,
} from '../../shared/constants.ts';
import type { GameAssets } from '../assets/loader.ts';

export type Quality = 'desktop' | 'mobile';

/** Default named surface (matches the keys `client/assets/loader.ts` is expected to
 * populate `GameAssets.textures` with) used by forMaterialId() per MAT_*. Concrete's
 * default is the wall variant — map-builder.ts special-cases floor-tagged concrete
 * boxes to request 'concrete_floor_01' directly via surface(). */
const DEFAULT_SURFACE_FOR_MATERIAL: Partial<Record<number, string>> = {
  [MAT_CONCRETE]: 'concrete_wall_007',
  [MAT_METAL]: 'metal_plate',
  [MAT_WOOD]: 'worn_planks',
  [MAT_GRAVEL]: 'sandy_gravel_02',
  [MAT_ASPHALT]: 'asphalt_02',
  [MAT_BRICK]: 'brick_wall_02',
  [MAT_PLASTER]: 'plastered_wall_02',
  [MAT_SAND]: 'sandy_gravel_02',
};

/** Approximate flat-color fallback per MAT_* when the real texture set is missing. */
const FALLBACK_COLOR_FOR_MATERIAL: Partial<Record<number, number>> = {
  [MAT_CONCRETE]: 0x9a9a92,
  [MAT_METAL]: 0x8b8f94,
  [MAT_WOOD]: 0x6b4a2f,
  [MAT_GRAVEL]: 0x8a8478,
  [MAT_ASPHALT]: 0x3a3a3c,
  [MAT_BRICK]: 0x8a4a3a,
  [MAT_PLASTER]: 0xc9c2b3,
  [MAT_SAND]: 0xcbb98a,
};

const FALLBACK_COLOR_DEFAULT = 0x808080;

/** TEAM_NONE (and anything else unrecognized) shares this neutral color. */
function teamColor(team: number): number {
  if (team === TEAM_A) return 0x2f7bd6;
  if (team === TEAM_B) return 0xd6532f;
  return 0x9aa0a6;
}

/** Deterministic pseudo-noise (no Math.random dependency) for the procedural fallback texture. */
function hashNoise(x: number, y: number): number {
  const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return v - Math.floor(v);
}

export class MaterialLibrary {
  private readonly assets: GameAssets;
  private readonly anisotropy: number;
  private readonly cache = new Map<string, THREE.MeshStandardMaterial>();
  private readonly named = new Map<string, THREE.MeshStandardMaterial>();

  constructor(assets: GameAssets, quality: Quality) {
    this.assets = assets;
    // The renderer's max anisotropy isn't available here (MaterialLibrary is
    // built without a renderer reference); 8 is safely supported by every
    // desktop GPU this game targets, 1 keeps mobile bandwidth down.
    this.anisotropy = quality === 'desktop' ? 8 : 1;
  }

  /** Every material this library has produced so far (e.g. so the integrator can
   * call CSM.setupMaterial() on each one for correct cascade shadow blending). */
  all(): IterableIterator<THREE.MeshStandardMaterial> {
    return this.cache.values();
  }

  /** Named PBR surface built from assets.textures.get(name); cached per name.
   * repeatMetres controls tiling: material.repeat = 1 / repeatMetres against
   * world-unit UVs produced by map-builder.ts's per-face box projection. */
  surface(name: string, repeatMetres: number): THREE.MeshStandardMaterial {
    const cached = this.cache.get(name);
    if (cached) return cached;

    const set = this.assets.textures.get(name);
    const mat = set ? this.buildTexturedSurface(set, repeatMetres) : this.buildFallbackSurface(name);
    this.cache.set(name, mat);
    return mat;
  }

  private buildTexturedSurface(
    set: { map: THREE.Texture; normalMap: THREE.Texture | null; roughnessMap: THREE.Texture | null },
    repeatMetres: number,
  ): THREE.MeshStandardMaterial {
    const repeat = 1 / Math.max(0.01, repeatMetres);

    const map = set.map.clone();
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(repeat, repeat);
    map.anisotropy = this.anisotropy;
    map.needsUpdate = true;

    let normalMap: THREE.Texture | undefined;
    if (set.normalMap) {
      normalMap = set.normalMap.clone();
      normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
      normalMap.repeat.set(repeat, repeat);
      normalMap.anisotropy = this.anisotropy;
      normalMap.needsUpdate = true;
    }

    let roughnessMap: THREE.Texture | undefined;
    if (set.roughnessMap) {
      roughnessMap = set.roughnessMap.clone();
      roughnessMap.wrapS = roughnessMap.wrapT = THREE.RepeatWrapping;
      roughnessMap.repeat.set(repeat, repeat);
      roughnessMap.anisotropy = this.anisotropy;
      roughnessMap.needsUpdate = true;
    }

    return new THREE.MeshStandardMaterial({
      map,
      normalMap,
      roughnessMap,
      roughness: roughnessMap ? 1 : 0.85,
      metalness: 0.0,
    });
  }

  private buildFallbackSurface(name: string): THREE.MeshStandardMaterial {
    const color = this.guessFallbackColor(name);
    return new THREE.MeshStandardMaterial({
      map: this.noiseTexture(color),
      roughness: 0.9,
      metalness: 0.02,
    });
  }

  private guessFallbackColor(name: string): number {
    const n = name.toLowerCase();
    if (n.includes('concrete')) return FALLBACK_COLOR_FOR_MATERIAL[MAT_CONCRETE]!;
    if (n.includes('metal')) return FALLBACK_COLOR_FOR_MATERIAL[MAT_METAL]!;
    if (n.includes('plank') || n.includes('wood')) return FALLBACK_COLOR_FOR_MATERIAL[MAT_WOOD]!;
    if (n.includes('gravel') || n.includes('sand')) return FALLBACK_COLOR_FOR_MATERIAL[MAT_GRAVEL]!;
    if (n.includes('asphalt')) return FALLBACK_COLOR_FOR_MATERIAL[MAT_ASPHALT]!;
    if (n.includes('brick')) return FALLBACK_COLOR_FOR_MATERIAL[MAT_BRICK]!;
    if (n.includes('plaster')) return FALLBACK_COLOR_FOR_MATERIAL[MAT_PLASTER]!;
    return FALLBACK_COLOR_DEFAULT;
  }

  /** A small tileable procedural noise texture so fallback surfaces aren't a dead flat color. */
  private noiseTexture(baseColor: number): THREE.Texture {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return new THREE.Texture();

    const base = new THREE.Color(baseColor);
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const n = hashNoise(x, y) * 0.16 - 0.08;
        img.data[i] = Math.round(THREE.MathUtils.clamp((base.r + n) * 255, 0, 255));
        img.data[i + 1] = Math.round(THREE.MathUtils.clamp((base.g + n) * 255, 0, 255));
        img.data[i + 2] = Math.round(THREE.MathUtils.clamp((base.b + n) * 255, 0, 255));
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 4);
    return tex;
  }

  /** Default surface for a MAT_* id with no explicit Box.texture hint. */
  forMaterialId(mat: number): THREE.MeshStandardMaterial {
    const name = DEFAULT_SURFACE_FOR_MATERIAL[mat];
    if (name) return this.surface(name, 2.5);
    return this.buildFallbackSurface(`mat_${mat}`);
  }

  gunmetal(): THREE.MeshStandardMaterial {
    return this.getNamed('_gunmetal', () => new THREE.MeshStandardMaterial({ color: 0x2b2d30, roughness: 0.45, metalness: 0.85 }));
  }

  polymer(): THREE.MeshStandardMaterial {
    return this.getNamed('_polymer', () => new THREE.MeshStandardMaterial({ color: 0x1b1d1f, roughness: 0.7, metalness: 0.05 }));
  }

  team(team: number): THREE.MeshStandardMaterial {
    return this.getNamed(`_team:${team}`, () => {
      const color = teamColor(team);
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1 });
      mat.emissive = new THREE.Color(color);
      mat.emissiveIntensity = 0.15;
      return mat;
    });
  }

  operatorBody(): THREE.MeshStandardMaterial {
    return this.getNamed('_operatorBody', () => {
      const mat = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.85, metalness: 0.0 });
      mat.normalMap = this.weaveNormalTexture();
      mat.normalScale = new THREE.Vector2(0.4, 0.4);
      mat.needsUpdate = true;
      return mat;
    });
  }

  private getNamed(key: string, build: () => THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
    const cached = this.named.get(key);
    if (cached) return cached;
    const mat = build();
    this.named.set(key, mat);
    this.cache.set(key, mat);
    return mat;
  }

  /** Subtle repeating diagonal-weave normal map for a dark tactical fabric look. */
  private weaveNormalTexture(): THREE.Texture {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    if (!ctx) return tex;

    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const weaveA = Math.sin((x + y) * 1.4);
        const weaveB = Math.sin((x - y) * 1.4);
        const nx = 0.5 + weaveA * 0.12;
        const ny = 0.5 + weaveB * 0.12;
        img.data[i] = Math.round(THREE.MathUtils.clamp(nx * 255, 0, 255));
        img.data[i + 1] = Math.round(THREE.MathUtils.clamp(ny * 255, 0, 255));
        img.data[i + 2] = 255;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(6, 6);
    tex.needsUpdate = true;
    return tex;
  }
}
