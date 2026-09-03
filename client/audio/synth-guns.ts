// Fully synthesized weapon and equipment audio: no samples, no network.
// Every AudioBuffer this module hands out is built from raw Float32 DSP —
// additive noise/tone layers run through a couple of cheap State-Variable
// Filters (Chamberlin topology) — so buildGunshotBank() stays synchronous
// and every buffer is generated once and cached. All the duration/frequency
// numbers below implement the design brief in the plan (§6); none of it is a
// gameplay tunable, so none of it lives in shared/constants.ts.
//
// This module never touches the DOM at import time (only inside functions
// that receive an already-constructed AudioContext), so it can be imported
// under Node for type-checking and unit tests.

import {
  WEAPON_AR,
  WEAPON_SMG,
  WEAPON_SNIPER,
  WEAPON_SHOTGUN,
  WEAPON_PISTOL,
  WEAPON_COUNT,
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
import type { Vec3 } from '../../shared/types.ts';
import type { AudioEngine } from './audio.ts';

// ---------------------------------------------------------------------------
// Tiny synchronous DSP toolkit (plain Float32Array<ArrayBuffer> in, Float32Array<ArrayBuffer> out)
// ---------------------------------------------------------------------------

// Module-local xorshift32 — deterministic-enough variety generator, not tied
// to any gameplay outcome, so it deliberately does NOT use shared/math.ts's
// mulberry32 (that RNG is reserved for simulation determinism).
let rngState = 0x9e3779b9;
function rnd(): number {
  rngState ^= rngState << 13; rngState |= 0;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5; rngState |= 0;
  return (rngState >>> 0) / 4294967296;
}
function noiseSample(): number {
  return rnd() * 2 - 1;
}

/** Chamberlin state-variable filter, one O(n) pass producing both taps. */
function svf(input: Float32Array<ArrayBuffer>, sr: number, freq: number, q: number): { low: Float32Array<ArrayBuffer>; band: Float32Array<ArrayBuffer> } {
  const low = new Float32Array(input.length);
  const band = new Float32Array(input.length);
  const f = 2 * Math.sin((Math.PI * Math.min(freq, sr * 0.45)) / sr);
  const qInv = 1 / q;
  let l = 0;
  let b = 0;
  for (let i = 0; i < input.length; i++) {
    const high = input[i]! - l - qInv * b;
    b += f * high;
    l += f * b;
    low[i] = l;
    band[i] = b;
  }
  return { low, band };
}

function softClip(buf: Float32Array<ArrayBuffer>): void {
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i]!);
}

function mixAt(dst: Float32Array<ArrayBuffer>, src: Float32Array<ArrayBuffer>, offset: number, amp: number): void {
  const n = Math.min(src.length, dst.length - offset);
  for (let i = 0; i < n; i++) dst[offset + i] += src[i]! * amp;
}

function expEnv(n: number, decayFrac: number): Float32Array<ArrayBuffer> {
  const env = new Float32Array(n);
  const tau = Math.max(1, n * decayFrac);
  for (let i = 0; i < n; i++) env[i] = Math.exp(-i / tau);
  return env;
}

function applyEnv(buf: Float32Array<ArrayBuffer>, env: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i]! * env[i]!;
  return out;
}

function whiteNoise(n: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = noiseSample();
  return out;
}

function sineSweep(n: number, sr: number, freqStart: number, freqEnd: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = freqStart + (freqEnd - freqStart) * (i / n);
    phase += (f / sr) * Math.PI * 2;
    out[i] = Math.sin(phase);
  }
  return out;
}

function toBuffer(ctx: AudioContext, data: Float32Array<ArrayBuffer>, sr: number): AudioBuffer {
  const buf = ctx.createBuffer(1, data.length, sr);
  buf.copyToChannel(data, 0);
  return buf;
}

// ---------------------------------------------------------------------------
// Gunshot synthesis
// ---------------------------------------------------------------------------

interface ShotParams {
  /** Centre frequency of the noise body's bandpass, Hz. */
  centerFreq: number;
  /** Noise-body length, seconds. */
  bodyLen: number;
}

const SHOT_PARAMS: Record<number, ShotParams> = {
  [WEAPON_AR]: { centerFreq: 700, bodyLen: 0.09 },
  [WEAPON_SMG]: { centerFreq: 900, bodyLen: 0.065 },
  [WEAPON_SNIPER]: { centerFreq: 400, bodyLen: 0.18 },
  [WEAPON_SHOTGUN]: { centerFreq: 350, bodyLen: 0.14 },
  [WEAPON_PISTOL]: { centerFreq: 800, bodyLen: 0.07 },
};

/** Exported so tests can check every weapon id has synthesis parameters without touching AudioContext. */
export function shotParamsFor(weaponId: number): ShotParams {
  return SHOT_PARAMS[weaponId] ?? SHOT_PARAMS[WEAPON_AR]!;
}

const TAIL_LEN = 0.8;

function synthShot(sr: number, params: ShotParams, opts: { bassBoost?: boolean; lowpassOnly?: boolean } = {}): Float32Array<ArrayBuffer> {
  const total = params.bodyLen + TAIL_LEN + 0.05;
  const n = Math.ceil(total * sr);
  const out = new Float32Array(n);

  // 2 ms click transient.
  const clickN = Math.max(1, Math.floor(0.002 * sr));
  mixAt(out, applyEnv(whiteNoise(clickN), expEnv(clickN, 0.3)), 0, 0.9);

  // Band-passed noise body at the weapon's centre frequency.
  const bodyN = Math.max(1, Math.floor(params.bodyLen * sr));
  const bodyFiltered = svf(whiteNoise(bodyN), sr, params.centerFreq, 2.2).band;
  mixAt(out, applyEnv(bodyFiltered, expEnv(bodyN, 0.35)), 0, 0.85);

  // 60 -> 30 Hz thump under the body; local (own-weapon) shots get extra sub-bass presence.
  const thumpN = Math.min(bodyN, Math.floor(0.08 * sr));
  mixAt(out, applyEnv(sineSweep(thumpN, sr, 60, 30), expEnv(thumpN, 0.5)), 0, opts.bassBoost ? 0.75 : 0.45);
  if (opts.bassBoost) {
    mixAt(out, applyEnv(sineSweep(thumpN, sr, 30, 18), expEnv(thumpN, 0.6)), 0, 0.35);
  }

  // Mechanical tick just after the click.
  const tickOffset = Math.floor(0.004 * sr);
  const tickN = Math.max(1, Math.floor(0.006 * sr));
  mixAt(out, applyEnv(svf(whiteNoise(tickN), sr, 3500, 3).band, expEnv(tickN, 0.3)), tickOffset, 0.22);

  // Synthesized reverb tail: filtered decaying noise, generated directly into
  // the buffer as a lightweight stand-in for a convolution reverb so the
  // whole bank stays synchronous.
  const tailN = Math.floor(TAIL_LEN * sr);
  const tailFiltered = svf(whiteNoise(tailN), sr, params.centerFreq * 0.75, 1.1).band;
  mixAt(out, applyEnv(tailFiltered, expEnv(tailN, 0.28)), bodyN, 0.16);

  let result = out;
  if (opts.lowpassOnly) result = svf(out, sr, 1200, 0.9).low;
  softClip(result);
  return result;
}

interface WeaponBufferSet {
  /** Own-weapon shots: unpanned, extra low end. */
  local: AudioBuffer[];
  /** Other players' shots within DISTANCE_THRESHOLD metres: panned, bright. */
  near: AudioBuffer[];
  /** Other players' shots beyond DISTANCE_THRESHOLD metres: panned, low-passed, scheduled with a delay. */
  distant: AudioBuffer[];
}

const VARIATIONS_PER_WEAPON = 3;

function buildWeaponBufferSet(ctx: AudioContext, params: ShotParams): WeaponBufferSet {
  const sr = ctx.sampleRate;
  const local: AudioBuffer[] = [];
  const near: AudioBuffer[] = [];
  const distant: AudioBuffer[] = [];
  for (let i = 0; i < VARIATIONS_PER_WEAPON; i++) {
    near.push(toBuffer(ctx, synthShot(sr, params), sr));
    local.push(toBuffer(ctx, synthShot(sr, params, { bassBoost: true }), sr));
    distant.push(toBuffer(ctx, synthShot(sr, params, { lowpassOnly: true }), sr));
  }
  return { local, near, distant };
}

// ---------------------------------------------------------------------------
// One-shot percussive sounds (reload clicks, hitmarker, melee, grenades, UI)
// ---------------------------------------------------------------------------

interface ImpulseOpts {
  burstLen: number;
  burstDecay: number;
  burstAmp: number;
  filterFreq?: number;
  filterQ?: number;
  ringFreq?: number;
  ringLen?: number;
  ringDecay?: number;
  ringAmp?: number;
  thumpFreq?: number;
  thumpLen?: number;
  thumpDecay?: number;
  thumpAmp?: number;
}

function synthImpulse(sr: number, opts: ImpulseOpts): Float32Array<ArrayBuffer> {
  const totalLen = Math.max(opts.burstLen, opts.ringLen ?? 0, opts.thumpLen ?? 0);
  const n = Math.max(1, Math.ceil(totalLen * sr) + 1);
  const out = new Float32Array(n);

  const burstN = Math.max(1, Math.floor(opts.burstLen * sr));
  const burstRaw = whiteNoise(burstN);
  const burstSignal = opts.filterFreq ? svf(burstRaw, sr, opts.filterFreq, opts.filterQ ?? 2).band : burstRaw;
  mixAt(out, applyEnv(burstSignal, expEnv(burstN, opts.burstDecay)), 0, opts.burstAmp);

  if (opts.ringFreq && opts.ringLen) {
    const ringN = Math.floor(opts.ringLen * sr);
    mixAt(out, applyEnv(sineSweep(ringN, sr, opts.ringFreq, opts.ringFreq), expEnv(ringN, opts.ringDecay ?? 0.3)), 0, opts.ringAmp ?? opts.burstAmp * 0.6);
  }
  if (opts.thumpFreq && opts.thumpLen) {
    const thumpN = Math.floor(opts.thumpLen * sr);
    mixAt(out, applyEnv(sineSweep(thumpN, sr, opts.thumpFreq, opts.thumpFreq), expEnv(thumpN, opts.thumpDecay ?? 0.4)), 0, opts.thumpAmp ?? opts.burstAmp * 0.7);
  }
  softClip(out);
  return out;
}

function concatMix(sr: number, parts: { data: Float32Array<ArrayBuffer>; offsetSec: number }[]): Float32Array<ArrayBuffer> {
  let maxLen = 0;
  for (const p of parts) maxLen = Math.max(maxLen, Math.floor(p.offsetSec * sr) + p.data.length);
  const out = new Float32Array(maxLen);
  for (const p of parts) mixAt(out, p.data, Math.floor(p.offsetSec * sr), 1);
  softClip(out);
  return out;
}

function reloadClickData(sr: number, kind: 'magOut' | 'magIn' | 'charge' | 'shell'): Float32Array<ArrayBuffer> {
  switch (kind) {
    case 'magOut':
      return synthImpulse(sr, { burstLen: 0.05, burstDecay: 0.3, burstAmp: 0.5, filterFreq: 3000, ringFreq: 1800, ringLen: 0.08, ringDecay: 0.35 });
    case 'magIn':
      return synthImpulse(sr, { burstLen: 0.06, burstDecay: 0.3, burstAmp: 0.55, filterFreq: 2500, thumpFreq: 140, thumpLen: 0.1, thumpDecay: 0.4 });
    case 'charge': {
      const pull = synthImpulse(sr, { burstLen: 0.03, burstDecay: 0.25, burstAmp: 0.5, filterFreq: 4000, ringFreq: 2400, ringLen: 0.04, ringDecay: 0.3 });
      const release = synthImpulse(sr, { burstLen: 0.025, burstDecay: 0.2, burstAmp: 0.6, filterFreq: 3200, ringFreq: 2000, ringLen: 0.05, ringDecay: 0.3 });
      return concatMix(sr, [{ data: pull, offsetSec: 0 }, { data: release, offsetSec: 0.09 }]);
    }
    case 'shell':
      return synthImpulse(sr, { burstLen: 0.07, burstDecay: 0.35, burstAmp: 0.5, filterFreq: 1500, thumpFreq: 200, thumpLen: 0.06, thumpDecay: 0.4 });
  }
}

function hitmarkerData(sr: number, headshot: boolean): Float32Array<ArrayBuffer> {
  const freq = headshot ? 1900 : 1300;
  const n = Math.floor(0.05 * sr);
  const out = applyEnv(sineSweep(n, sr, freq, freq), expEnv(n, headshot ? 0.4 : 0.25));
  if (headshot) {
    const n2 = Math.floor(0.04 * sr);
    mixAt(out, applyEnv(sineSweep(n2, sr, freq * 1.5, freq * 1.5), expEnv(n2, 0.35)), 0, 0.5);
  }
  softClip(out);
  return out;
}

function dryFireData(sr: number): Float32Array<ArrayBuffer> {
  return synthImpulse(sr, { burstLen: 0.015, burstDecay: 0.25, burstAmp: 0.6, filterFreq: 3000, ringFreq: 2600, ringLen: 0.02, ringDecay: 0.25 });
}

function explosionData(sr: number, big: boolean): Float32Array<ArrayBuffer> {
  const tailLen = big ? 2.2 : 1.4;
  const bodyLen = big ? 0.35 : 0.22;
  const n = Math.ceil((bodyLen + tailLen) * sr);
  const out = new Float32Array(n);

  const bodyN = Math.floor(bodyLen * sr);
  mixAt(out, applyEnv(svf(whiteNoise(bodyN), sr, 180, 1.4).low, expEnv(bodyN, 0.3)), 0, 1);

  const subN = Math.min(bodyN * 2, n);
  mixAt(out, applyEnv(sineSweep(subN, sr, 80, 20), expEnv(subN, 0.35)), 0, 0.6);

  const tailN = Math.floor(tailLen * sr);
  mixAt(out, applyEnv(svf(whiteNoise(tailN), sr, 300, 1.0).band, expEnv(tailN, 0.3)), bodyN, 0.3);

  softClip(out);
  return out;
}

function flashbangData(sr: number): Float32Array<ArrayBuffer> {
  const n = Math.ceil(0.6 * sr);
  const out = new Float32Array(n);
  const bodyN = Math.floor(0.05 * sr);
  mixAt(out, applyEnv(whiteNoise(bodyN), expEnv(bodyN, 0.15)), 0, 1);
  const ringN = Math.floor(0.3 * sr);
  mixAt(out, applyEnv(sineSweep(ringN, sr, 3200, 3200), expEnv(ringN, 0.4)), bodyN, 0.35);
  softClip(out);
  return out;
}

function meleeSwingData(sr: number): Float32Array<ArrayBuffer> {
  // A noise burst swept through a moving bandpass centre frequency (up then
  // back down) reads as a "whoosh" much better than a static filter.
  const n = Math.floor(0.2 * sr);
  const raw = whiteNoise(n);
  const out = new Float32Array(n);
  let l = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const freq = 400 + 1400 * Math.sin(Math.PI * t);
    const f = 2 * Math.sin((Math.PI * Math.min(freq, sr * 0.45)) / sr);
    const high = raw[i]! - l - 1.2 * b;
    b += f * high;
    l += f * b;
    out[i] = b * Math.sin(Math.PI * t);
  }
  softClip(out);
  return out;
}

function meleeHitData(sr: number): Float32Array<ArrayBuffer> {
  return synthImpulse(sr, { burstLen: 0.08, burstDecay: 0.25, burstAmp: 0.8, filterFreq: 500, thumpFreq: 90, thumpLen: 0.07, thumpDecay: 0.35 });
}

function grenadePinData(sr: number): Float32Array<ArrayBuffer> {
  return synthImpulse(sr, { burstLen: 0.008, burstDecay: 0.3, burstAmp: 0.4, filterFreq: 5000, ringFreq: 3800, ringLen: 0.02, ringDecay: 0.25 });
}

function toneBeepData(sr: number, freq: number, len: number, decayFrac: number): Float32Array<ArrayBuffer> {
  const n = Math.floor(len * sr);
  const out = applyEnv(sineSweep(n, sr, freq, freq), expEnv(n, decayFrac));
  softClip(out);
  return out;
}

// ---------------------------------------------------------------------------
// Material-tinted footstep/impact fallbacks (used when samples.ts has none)
// ---------------------------------------------------------------------------

interface MaterialTone {
  freq: number;
  len: number;
  metallic?: boolean;
}

const FOOTSTEP_TONE: Record<number, MaterialTone> = {
  [MAT_CONCRETE]: { freq: 220, len: 0.09 },
  [MAT_METAL]: { freq: 500, len: 0.1, metallic: true },
  [MAT_WOOD]: { freq: 300, len: 0.1 },
  [MAT_GRAVEL]: { freq: 700, len: 0.12 },
  [MAT_ASPHALT]: { freq: 230, len: 0.09 },
  [MAT_BRICK]: { freq: 250, len: 0.09 },
  [MAT_PLASTER]: { freq: 260, len: 0.09 },
  [MAT_SAND]: { freq: 600, len: 0.14 },
  [MAT_FLESH]: { freq: 400, len: 0.08 },
};

const IMPACT_TONE: Record<number, MaterialTone> = {
  [MAT_CONCRETE]: { freq: 900, len: 0.05 },
  [MAT_METAL]: { freq: 2200, len: 0.09, metallic: true },
  [MAT_WOOD]: { freq: 600, len: 0.06 },
  [MAT_GRAVEL]: { freq: 1400, len: 0.05 },
  [MAT_ASPHALT]: { freq: 950, len: 0.05 },
  [MAT_BRICK]: { freq: 1000, len: 0.05 },
  [MAT_PLASTER]: { freq: 850, len: 0.05 },
  [MAT_SAND]: { freq: 500, len: 0.07 },
  [MAT_FLESH]: { freq: 300, len: 0.06 },
};

function materialToneData(sr: number, tone: MaterialTone): Float32Array<ArrayBuffer> {
  const n = Math.max(1, Math.floor(tone.len * sr));
  const raw = whiteNoise(n);
  const filtered = tone.metallic ? svf(raw, sr, tone.freq, 6).band : svf(raw, sr, tone.freq, 1.5).low;
  const out = applyEnv(filtered, expEnv(n, 0.3));
  if (tone.metallic) {
    mixAt(out, applyEnv(sineSweep(n, sr, tone.freq, tone.freq), expEnv(n, 0.35)), 0, 0.4);
  }
  softClip(out);
  return out;
}

// ---------------------------------------------------------------------------
// Public bank
// ---------------------------------------------------------------------------

export interface GunshotFireOpts {
  /** Emitter position; ignored (unpanned) when local is true. */
  pos?: Vec3;
  /** Metres from the listener; used to pick the near/distant variant and its playback delay. */
  distance?: number;
  /** True for the local player's own weapon: unpanned, full volume, extra low end. */
  local: boolean;
}

export interface GunshotBank {
  fire(weaponId: number, opts: GunshotFireOpts, engine: AudioEngine): void;
  reloadClick(kind: 'magOut' | 'magIn' | 'charge' | 'shell'): AudioBuffer;
  hitmarker(headshot: boolean): AudioBuffer;
  dryFire(): AudioBuffer;
  explosion(): AudioBuffer;
  flashbang(): AudioBuffer;
  meleeSwing(): AudioBuffer;
  meleeHit(): AudioBuffer;
  grenadePin(): AudioBuffer;
  plantBeep(): AudioBuffer;
  bombExplosion(): AudioBuffer;
  footstepFallback(material: number): AudioBuffer;
  impactFallback(material: number): AudioBuffer;
  uiBeep(): AudioBuffer;
}

/** Shots farther than this play the low-passed "distant" variant with a propagation delay. */
const DISTANCE_THRESHOLD_M = 30;
/** Sound travels roughly this many seconds per 100 m (used only for the felt delay, not physically exact). */
const DISTANT_DELAY_SEC_PER_100M = 0.3;
const PITCH_JITTER = 0.03;

/** Builds every synthesized buffer once (gunshots eagerly; the smaller one-shots lazily on first
 *  use) against the given AudioContext's sample rate. Fully synchronous — no network, no samples. */
export function buildGunshotBank(ctx: AudioContext): GunshotBank {
  const sr = ctx.sampleRate;

  const weaponSets = new Map<number, WeaponBufferSet>();
  for (let w = 0; w < WEAPON_COUNT; w++) weaponSets.set(w, buildWeaponBufferSet(ctx, shotParamsFor(w)));

  const reloadCache = new Map<string, AudioBuffer>();
  const footstepCache = new Map<number, AudioBuffer>();
  const impactCache = new Map<number, AudioBuffer>();
  let hitmarkerHead: AudioBuffer | null = null;
  let hitmarkerBody: AudioBuffer | null = null;
  let dryFireBuf: AudioBuffer | null = null;
  let explosionBuf: AudioBuffer | null = null;
  let bombExplosionBuf: AudioBuffer | null = null;
  let flashbangBuf: AudioBuffer | null = null;
  let meleeSwingBuf: AudioBuffer | null = null;
  let meleeHitBuf: AudioBuffer | null = null;
  let grenadePinBuf: AudioBuffer | null = null;
  let plantBeepBuf: AudioBuffer | null = null;
  let uiBeepBuf: AudioBuffer | null = null;

  function pick(arr: AudioBuffer[]): AudioBuffer {
    return arr[Math.floor(rnd() * arr.length)] ?? arr[0]!;
  }

  return {
    fire(weaponId, opts, engine) {
      const set = weaponSets.get(weaponId) ?? weaponSets.get(WEAPON_AR)!;
      const distance = opts.distance ?? 0;
      const pitch = 1 + (rnd() * 2 - 1) * PITCH_JITTER;
      const isDistant = !opts.local && distance > DISTANCE_THRESHOLD_M;
      const buffer = opts.local ? pick(set.local) : isDistant ? pick(set.distant) : pick(set.near);

      const playIt = (): void => {
        engine.play(buffer, { pos: opts.local ? undefined : opts.pos, volume: 1, pitch, bus: 'sfx' });
      };
      if (isDistant) {
        setTimeout(playIt, (distance / 100) * DISTANT_DELAY_SEC_PER_100M * 1000);
      } else {
        playIt();
      }
    },

    reloadClick(kind) {
      let buf = reloadCache.get(kind);
      if (!buf) {
        buf = toBuffer(ctx, reloadClickData(sr, kind), sr);
        reloadCache.set(kind, buf);
      }
      return buf;
    },
    hitmarker(headshot) {
      if (headshot) return (hitmarkerHead ??= toBuffer(ctx, hitmarkerData(sr, true), sr));
      return (hitmarkerBody ??= toBuffer(ctx, hitmarkerData(sr, false), sr));
    },
    dryFire() {
      return (dryFireBuf ??= toBuffer(ctx, dryFireData(sr), sr));
    },
    explosion() {
      return (explosionBuf ??= toBuffer(ctx, explosionData(sr, false), sr));
    },
    bombExplosion() {
      return (bombExplosionBuf ??= toBuffer(ctx, explosionData(sr, true), sr));
    },
    flashbang() {
      return (flashbangBuf ??= toBuffer(ctx, flashbangData(sr), sr));
    },
    meleeSwing() {
      return (meleeSwingBuf ??= toBuffer(ctx, meleeSwingData(sr), sr));
    },
    meleeHit() {
      return (meleeHitBuf ??= toBuffer(ctx, meleeHitData(sr), sr));
    },
    grenadePin() {
      return (grenadePinBuf ??= toBuffer(ctx, grenadePinData(sr), sr));
    },
    plantBeep() {
      return (plantBeepBuf ??= toBuffer(ctx, toneBeepData(sr, 1000, 0.15, 0.5), sr));
    },
    uiBeep() {
      return (uiBeepBuf ??= toBuffer(ctx, toneBeepData(sr, 1500, 0.06, 0.4), sr));
    },
    footstepFallback(material) {
      let buf = footstepCache.get(material);
      if (!buf) {
        const tone = FOOTSTEP_TONE[material] ?? FOOTSTEP_TONE[MAT_CONCRETE]!;
        buf = toBuffer(ctx, materialToneData(sr, tone), sr);
        footstepCache.set(material, buf);
      }
      return buf;
    },
    impactFallback(material) {
      let buf = impactCache.get(material);
      if (!buf) {
        const tone = IMPACT_TONE[material] ?? IMPACT_TONE[MAT_CONCRETE]!;
        buf = toBuffer(ctx, materialToneData(sr, tone), sr);
        impactCache.set(material, buf);
      }
      return buf;
    },
  };
}
