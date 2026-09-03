// Types describing public/assets/index.json, the manifest fetch-assets.mjs
// writes and loader.ts reads. Pure data shapes: no DOM, no three.js. Keeping
// this in its own module lets other client code (materials.ts, the credits
// screen) depend on the shape without pulling in the three.js-heavy loader.

/** 512 px mobile companions live alongside the 1k originals when present. */
export interface AssetIndexTextureSet {
  diff?: string;
  nor?: string;
  rough?: string;
  diff512?: string;
  nor512?: string;
  rough512?: string;
}

export interface AssetIndexEntry {
  category: string;
  name: string;
  author: string;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
  attributionRequired: boolean;
  /** Every file this asset produced, as site-relative URLs under /assets/. */
  files: string[];
  /** The best model file to load (by the manifest's `prefer` order), or null for non-model assets. */
  primary: string | null;
  /** Present for `category: "texture"` entries. */
  textures?: AssetIndexTextureSet;
  /** True when the download failed; the loader must fall back for this id. */
  failed?: boolean;
}

export interface AssetIndex {
  version: 1;
  /** The --tier the index was built for ('desktop' | 'mobile' | 'all'). */
  tier: string;
  /** Keyed by the asset id from scripts/asset-manifest.json (e.g. "weapon_ar", "tex_concrete_floor"). */
  assets: Record<string, AssetIndexEntry>;
}

/** One row of the in-game credits screen and CREDITS.md. */
export interface CreditEntry {
  name: string;
  author: string;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
  attributionRequired: boolean;
}
