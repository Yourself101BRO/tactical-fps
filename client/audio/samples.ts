// Loads and decodes the real (downloaded) impact/footstep/UI audio samples
// declared in GameAssetAudioUrls (see client/assets/loader.ts), with bounded
// fetch concurrency and graceful degradation: any URL that 404s or fails to
// decode is simply dropped. Callers get `null` back for anything missing so
// they can fall back to the synthesized bank in synth-guns.ts — nothing here
// throws for a missing file.
//
// groupByPrefix() in loader.ts derives its group keys by stripping the
// "impact" prefix and lower-casing the remaining leading run of letters, so
// a Kenney file named impactMetal_000.ogg lands under audioUrls.impacts.metal
// (not "impactMetal") — the mappings below match that exactly.

import {
  MAT_CONCRETE,
  MAT_METAL,
  MAT_WOOD,
  MAT_GRAVEL,
  MAT_ASPHALT,
  MAT_BRICK,
  MAT_PLASTER,
  MAT_SAND,
  MAT_FLESH,
} from '../../shared/constants.ts';
import type { GameAssetAudioUrls } from '../assets/loader.ts';

export type UiSoundName = 'click' | 'confirm' | 'error' | 'tick' | 'hover';

export interface SampleBank {
  impact(material: number): AudioBuffer | null;
  footstep(material: number): AudioBuffer | null;
  ui(name: UiSoundName): AudioBuffer | null;
  casing(): AudioBuffer | null;
  /** True once at least one sample decoded successfully; false means rely entirely on synth-guns.ts. */
  loaded: boolean;
}

const FETCH_CONCURRENCY = 6;

/** Local LCG — deliberately not shared/math.ts's mulberry32, which is reserved for simulation
 *  determinism. Pure and allocation-free per call: state lives in the closure, not on the heap. */
export function createLcg(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
const rnd = createLcg(0x2f6e2b1);

function pickRandom(list: readonly AudioBuffer[]): AudioBuffer | null {
  if (list.length === 0) return null;
  return list[Math.floor(rnd() * list.length)] ?? null;
}

/** MAT_* -> Kenney impact-sounds group keys (audioUrls.impacts), tried in priority order until
 *  one has samples. Concrete/brick/plaster/asphalt share the two "hard surface" groups. */
export function impactGroupsFor(material: number): string[] {
  switch (material) {
    case MAT_METAL:
      return ['metal'];
    case MAT_WOOD:
      return ['wood'];
    case MAT_CONCRETE:
    case MAT_BRICK:
    case MAT_PLASTER:
    case MAT_ASPHALT:
      return ['plate', 'mining'];
    case MAT_GRAVEL:
    case MAT_SAND:
    case MAT_FLESH:
      return ['soft'];
    default:
      return ['plate', 'mining'];
  }
}

/** MAT_* -> footstep surface group key (audioUrls.footsteps), or null when no footstep sound
 *  makes sense for that material (flesh — players don't walk on other players). */
export function footstepSurfaceFor(material: number): string | null {
  // Folder names of the OpenGameArt "Footsteps on different surfaces" pack:
  // boots (hard floor), tile, metal, gravel, wood, grass, water, plus non-human sets.
  switch (material) {
    case MAT_CONCRETE:
    case MAT_ASPHALT:
    case MAT_BRICK:
      return 'boots';
    case MAT_PLASTER:
      return 'tile';
    case MAT_METAL:
      return 'metal';
    case MAT_GRAVEL:
    case MAT_SAND:
      return 'gravel';
    case MAT_WOOD:
      return 'wood';
    case MAT_FLESH:
      return null;
    default:
      return 'boots';
  }
}

/** UI name -> candidate key prefixes in audioUrls.ui (single url per key, e.g. "click_001"),
 *  tried in order. The Kenney Interface Sounds set has no dedicated "hover" file, so hover
 *  falls back to the softer glass_* blip, then to click as a last resort. */
const UI_PREFIXES: Record<UiSoundName, string[]> = {
  click: ['click'],
  confirm: ['confirmation', 'confirm'],
  error: ['error'],
  tick: ['tick'],
  hover: ['glass', 'click'],
};

async function fetchDecodeAll(ctx: AudioContext, urls: readonly string[]): Promise<(AudioBuffer | null)[]> {
  const results: (AudioBuffer | null)[] = new Array(urls.length).fill(null);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= urls.length) return;
      const url = urls[i]!;
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const arrayBuffer = await res.arrayBuffer();
        results[i] = await ctx.decodeAudioData(arrayBuffer);
      } catch {
        // Missing or corrupt file: leave as null, caller falls back to synth-guns.ts.
      }
    }
  }
  const workerCount = Math.min(FETCH_CONCURRENCY, Math.max(1, urls.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function loadSampleBank(ctx: AudioContext, audioUrls: GameAssetAudioUrls): Promise<SampleBank> {
  // Flatten every URL we might need into one fetch pool (bounded concurrency),
  // then re-associate the decoded results back into named groups.
  const impactGroups = Object.keys(audioUrls.impacts);
  const footstepGroups = Object.keys(audioUrls.footsteps);
  const uiKeys = Object.keys(audioUrls.ui);

  const allUrls: string[] = [];
  const impactSpans = new Map<string, [start: number, len: number]>();
  for (const g of impactGroups) {
    const urls = audioUrls.impacts[g] ?? [];
    impactSpans.set(g, [allUrls.length, urls.length]);
    allUrls.push(...urls);
  }
  const footstepSpans = new Map<string, [start: number, len: number]>();
  for (const g of footstepGroups) {
    const urls = audioUrls.footsteps[g] ?? [];
    footstepSpans.set(g, [allUrls.length, urls.length]);
    allUrls.push(...urls);
  }
  const uiStart = allUrls.length;
  for (const k of uiKeys) allUrls.push(audioUrls.ui[k]!);

  const decoded = await fetchDecodeAll(ctx, allUrls);

  const impacts = new Map<string, AudioBuffer[]>();
  for (const [g, [start, len]] of impactSpans) {
    impacts.set(g, decoded.slice(start, start + len).filter((b): b is AudioBuffer => b !== null));
  }
  const footsteps = new Map<string, AudioBuffer[]>();
  for (const [g, [start, len]] of footstepSpans) {
    footsteps.set(g, decoded.slice(start, start + len).filter((b): b is AudioBuffer => b !== null));
  }
  const ui = new Map<string, AudioBuffer>();
  for (let i = 0; i < uiKeys.length; i++) {
    const buf = decoded[uiStart + i];
    if (buf) ui.set(uiKeys[i]!, buf);
  }

  let anyLoaded = false;
  for (const b of decoded) {
    if (b) { anyLoaded = true; break; }
  }

  function findUiVariants(name: UiSoundName): AudioBuffer[] {
    const out: AudioBuffer[] = [];
    for (const prefix of UI_PREFIXES[name]) {
      for (const [key, buf] of ui) if (key.startsWith(prefix)) out.push(buf);
      if (out.length > 0) break;
    }
    return out;
  }

  return {
    impact(material) {
      for (const group of impactGroupsFor(material)) {
        const list = impacts.get(group);
        if (list && list.length > 0) return pickRandom(list);
      }
      return null;
    },
    footstep(material) {
      const surface = footstepSurfaceFor(material);
      if (!surface) return null;
      const list = footsteps.get(surface);
      return list && list.length > 0 ? pickRandom(list) : null;
    },
    ui(name) {
      return pickRandom(findUiVariants(name));
    },
    casing() {
      // Neither pack ships a dedicated shell-casing sample; a metal impact is
      // the closest available substitute (both are a short metal-on-hard-surface tink).
      const list = impacts.get('metal');
      return list && list.length > 0 ? pickRandom(list) : null;
    },
    loaded: anyLoaded,
  };
}
