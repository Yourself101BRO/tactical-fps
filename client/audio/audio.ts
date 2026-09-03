// Core Web Audio engine: bus routing, spatialized playback with a voice cap,
// the iOS unlock trick (a silent looping <audio> element so the hardware
// ring/silent switch doesn't mute Web Audio), the listener transform, and the
// flash-deafen effect. This module never touches the network or gameplay
// state directly — callers hand it AudioBuffers (from synth-guns.ts /
// samples.ts) and Vec3 positions.
//
// Construction is side-effect free (no AudioContext is created until
// unlock() runs from a real user gesture), so this file can be imported
// under Node for type-checking and unit tests without a DOM.

import type { Vec3 } from '../../shared/types.ts';

const MAX_VOICES = 32;
const FLASH_FILTER_FREQ_NORMAL = 20_000;
const FLASH_FILTER_FREQ_DEAFENED = 800;
const FLASH_RING_FREQ = 4000;
const DEFAULT_REF_DISTANCE = 2;
const DEFAULT_MAX_DISTANCE = 80;
const DEFAULT_ROLLOFF = 1.2;

export type Bus = 'sfx' | 'ui';

export interface PlayOptions {
  /** World-space emitter position. Omitted = unpanned, full volume (e.g. UI, or the local player's own weapon). */
  pos?: Vec3;
  volume?: number;
  /** Playback rate multiplier, used for pitch jitter. */
  pitch?: number;
  loop?: boolean;
  /** Which bus to route through. Defaults to 'sfx'. */
  bus?: Bus;
  refDistance?: number;
  maxDistance?: number;
  rolloff?: number;
}

export interface Handle {
  /** Stops playback immediately and frees the voice slot. Safe to call more than once. */
  stop(): void;
  /** Live volume control (also used by the voice-stealing heuristic). */
  setVolume(v: number): void;
  /** Live position update for a moving emitter, without re-triggering play(). No-op if played unpanned. */
  setPosition(pos: Vec3): void;
}

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  panner: PannerNode | null;
  volume: number;
}

const INERT_HANDLE: Handle = { stop() {}, setVolume() {}, setPosition() {} };

export class AudioEngine {
  private _ctx: AudioContext | null = null;
  /** Populated once unlock() has created the AudioContext. */
  buses: { master: GainNode; sfx: GainNode; ui: GainNode } | null = null;
  /** True once the iOS silent-<audio> unlock trick has been applied (shows the one-time hint). */
  iosMuteHint = false;

  private sfxFilter: BiquadFilterNode | null = null;
  private readonly voices: Voice[] = [];
  private readonly panningModel: PanningModelType;
  private silentAudioEl: HTMLAudioElement | null = null;
  private flashRing: { osc: OscillatorNode } | null = null;

  constructor() {
    const ua = typeof navigator !== 'undefined' ? (navigator.userAgent ?? '') : '';
    // HRTF is the higher-quality panner but is more expensive; mobile gets
    // the cheaper equalpower model as the plan specifies.
    this.panningModel = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ? 'equalpower' : 'HRTF';
  }

  get ctx(): AudioContext | null {
    return this._ctx;
  }

  /** True once the context exists and is actually running (not suspended by autoplay policy). */
  get isReady(): boolean {
    return this._ctx !== null && this._ctx.state === 'running';
  }

  /** Call from a user gesture handler (click/touchstart/keydown). Safe to call repeatedly. */
  async unlock(): Promise<void> {
    if (!this._ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctor();
      const master = ctx.createGain();
      const sfx = ctx.createGain();
      const ui = ctx.createGain();
      const sfxFilter = ctx.createBiquadFilter();
      sfxFilter.type = 'lowpass';
      sfxFilter.frequency.value = FLASH_FILTER_FREQ_NORMAL;
      sfx.connect(sfxFilter);
      sfxFilter.connect(master);
      ui.connect(master);
      master.connect(ctx.destination);
      this._ctx = ctx;
      this.buses = { master, sfx, ui };
      this.sfxFilter = sfxFilter;
    }
    if (this._ctx.state !== 'running') {
      try {
        await this._ctx.resume();
      } catch {
        // Still blocked (no real gesture yet) — caller re-invokes unlock() on the next one.
      }
    }
    this.applyIosUnlockHack();
  }

  /** iOS silences Web Audio entirely with the ring/silent switch, but exempts <audio> elements
   *  routed through the "ambient"/media category. Looping a near-silent one keeps the game audible. */
  private applyIosUnlockHack(): void {
    if (this.silentAudioEl || typeof document === 'undefined' || typeof navigator === 'undefined') return;
    const ua = navigator.userAgent ?? '';
    const platform = navigator.platform ?? '';
    const isIOS = /iP(hone|od|ad)/.test(ua) || (platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1);
    if (!isIOS) return;
    try {
      const el = document.createElement('audio');
      el.src = makeSilentWavUrl(1, 4000);
      el.loop = true;
      el.setAttribute('playsinline', '');
      el.volume = 0.0001; // inaudible, but "playing" is what routes the session through the right category
      void el.play().then(() => {
        // Only a successful play() routes the session; a blocked one must be retried on the next gesture.
        this.silentAudioEl = el;
        this.iosMuteHint = true;
      }).catch(() => {
        // Blocked until a later real gesture; unlock() retries this whole method then.
      });
    } catch {
      // Best-effort only: worst case the game is silent with the ring switch on, nothing crashes.
    }
  }

  setVolumes(master: number, sfx: number, ui: number): void {
    if (!this.buses) return;
    this.buses.master.gain.value = master;
    this.buses.sfx.gain.value = sfx;
    this.buses.ui.gain.value = ui;
  }

  /** Positions the Web Audio listener. Call once per rendered frame with the local camera's state.
   *  yaw/pitch follow the InputCmd convention: yaw 0 faces -Z, increasing yaw turns left. */
  setListener(pos: Vec3, yaw: number, pitch: number): void {
    const ctx = this._ctx;
    if (!ctx) return;
    const listener = ctx.listener;
    const fx = -Math.sin(yaw) * Math.cos(pitch);
    const fy = Math.sin(pitch);
    const fz = -Math.cos(yaw) * Math.cos(pitch);
    if (listener.positionX) {
      const now = ctx.currentTime;
      listener.positionX.setValueAtTime(pos.x, now);
      listener.positionY.setValueAtTime(pos.y, now);
      listener.positionZ.setValueAtTime(pos.z, now);
      listener.forwardX.setValueAtTime(fx, now);
      listener.forwardY.setValueAtTime(fy, now);
      listener.forwardZ.setValueAtTime(fz, now);
      listener.upX.setValueAtTime(0, now);
      listener.upY.setValueAtTime(1, now);
      listener.upZ.setValueAtTime(0, now);
    } else {
      // Old-Safari fallback (deprecated but still present in the DOM lib).
      listener.setPosition(pos.x, pos.y, pos.z);
      listener.setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  /** Plays a buffer through a bus, with optional 3D positioning. Returns an inert handle if
   *  called before unlock() so callers can fire-and-forget ahead of the first user gesture. */
  play(buffer: AudioBuffer, opts: PlayOptions = {}): Handle {
    const ctx = this._ctx;
    const buses = this.buses;
    if (!ctx || !buses) return INERT_HANDLE;

    const bus = opts.bus === 'ui' ? buses.ui : buses.sfx;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = opts.loop ?? false;
    source.playbackRate.value = opts.pitch ?? 1;

    const gain = ctx.createGain();
    gain.gain.value = opts.volume ?? 1;

    let panner: PannerNode | null = null;
    if (opts.pos) {
      panner = ctx.createPanner();
      panner.panningModel = this.panningModel;
      panner.distanceModel = 'inverse';
      panner.refDistance = opts.refDistance ?? DEFAULT_REF_DISTANCE;
      panner.maxDistance = opts.maxDistance ?? DEFAULT_MAX_DISTANCE;
      panner.rolloffFactor = opts.rolloff ?? DEFAULT_ROLLOFF;
      setPannerPosition(panner, opts.pos);
      source.connect(gain);
      gain.connect(panner);
      panner.connect(bus);
    } else {
      source.connect(gain);
      gain.connect(bus);
    }

    const voice: Voice = { source, gain, panner, volume: opts.volume ?? 1 };
    this.stealQuietestVoiceIfFull();
    this.voices.push(voice);
    source.onended = () => {
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
    };
    source.start();

    return {
      stop: () => stopVoice(voice),
      setVolume: (v: number) => {
        gain.gain.value = v;
        voice.volume = v;
      },
      setPosition: (p: Vec3) => {
        if (panner) setPannerPosition(panner, p);
      },
    };
  }

  private stealQuietestVoiceIfFull(): void {
    if (this.voices.length < MAX_VOICES) return;
    let quietest = this.voices[0]!;
    for (const v of this.voices) if (v.volume < quietest.volume) quietest = v;
    stopVoice(quietest);
    const i = this.voices.indexOf(quietest);
    if (i >= 0) this.voices.splice(i, 1);
  }

  /** Muffles the sfx bus (lowpass toward 800 Hz) and rings a fading 4 kHz tone on the master
   *  bus, as felt after a nearby flashbang. Ramps back to clean over `seconds`. */
  flashDeafen(seconds: number): void {
    const ctx = this._ctx;
    if (!ctx || !this.sfxFilter || !this.buses) return;
    const dur = Math.max(0.05, seconds);
    const now = ctx.currentTime;

    const f = this.sfxFilter.frequency;
    f.cancelScheduledValues(now);
    f.setValueAtTime(FLASH_FILTER_FREQ_DEAFENED, now);
    f.exponentialRampToValueAtTime(FLASH_FILTER_FREQ_NORMAL, now + dur);

    if (this.flashRing) {
      try { this.flashRing.osc.stop(); } catch { /* already stopped */ }
      this.flashRing = null;
    }
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = FLASH_RING_FREQ;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.16, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(g);
    g.connect(this.buses.master);
    osc.start(now);
    osc.stop(now + dur + 0.05);
    this.flashRing = { osc };
    osc.onended = () => {
      if (this.flashRing?.osc === osc) this.flashRing = null;
    };
  }

  /** Call on document visibilitychange -> hidden. */
  async suspend(): Promise<void> {
    if (this._ctx && this._ctx.state === 'running') {
      try { await this._ctx.suspend(); } catch { /* ignore */ }
    }
  }

  /** Call on document visibilitychange -> visible. */
  async resume(): Promise<void> {
    if (this._ctx && this._ctx.state === 'suspended') {
      try { await this._ctx.resume(); } catch { /* ignore */ }
    }
  }
}

function stopVoice(voice: Voice): void {
  try { voice.source.stop(); } catch { /* already stopped/ended */ }
}

function setPannerPosition(panner: PannerNode, pos: Vec3): void {
  if (panner.positionX) {
    panner.positionX.value = pos.x;
    panner.positionY.value = pos.y;
    panner.positionZ.value = pos.z;
  } else {
    panner.setPosition(pos.x, pos.y, pos.z);
  }
}

/** Builds a data: URL for a short silent mono 8-bit WAV, used only by the iOS unlock trick. */
function makeSilentWavUrl(durationSec: number, sampleRate: number): string {
  const byteLen = Math.max(1, Math.round(durationSec * sampleRate));
  const header = 44;
  const buf = new ArrayBuffer(header + byteLen);
  const view = new DataView(buf);
  let p = 0;
  const writeStr = (s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i));
  };
  writeStr('RIFF');
  view.setUint32(p, 36 + byteLen, true); p += 4;
  writeStr('WAVE');
  writeStr('fmt ');
  view.setUint32(p, 16, true); p += 4;
  view.setUint16(p, 1, true); p += 2; // PCM
  view.setUint16(p, 1, true); p += 2; // mono
  view.setUint32(p, sampleRate, true); p += 4;
  view.setUint32(p, sampleRate, true); p += 4; // byte rate (1 byte/sample at 8-bit mono)
  view.setUint16(p, 1, true); p += 2; // block align
  view.setUint16(p, 8, true); p += 2; // bits per sample
  writeStr('data');
  view.setUint32(p, byteLen, true); p += 4;
  const samples = new Uint8Array(buf, header, byteLen);
  samples.fill(128); // silence in 8-bit unsigned PCM
  const blob = new Blob([buf], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}
