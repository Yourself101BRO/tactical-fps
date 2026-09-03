// Per-viewer client settings, persisted to localStorage. Pure browser module:
// no shared/ simulation dependency needed beyond the one cosmetic constant
// below. See plan §7 (settings screen) and §9 (cross-module signature).

import { MAX_NAME_LEN } from '../shared/constants.ts';

export interface Settings {
  name: string;
  sensitivity: number;
  adsSensMult: number;
  fov: number;
  invertY: boolean;
  adsToggle: boolean;
  autoSprint: boolean;
  autoMount: boolean;
  quality: 'auto' | 'desktop' | 'mobile';
  volumeMaster: number;
  volumeSfx: number;
  volumeUi: number;
  touchScale: number;
  touchOpacity: number;
  gyro: boolean;
  vibrate: boolean;
  character: 'operator' | 'soldier';
}

const STORAGE_KEY = 'tfps.settings.v1';

/**
 * A cosmetic per-session default name. This is a client-only, non-deterministic
 * value (never fed into shared/sim), so Math.random() is fine here even though
 * it is banned inside shared/.
 */
function randomName(): string {
  const n = 1000 + Math.floor(Math.random() * 9000);
  return `Operator-${n}`;
}

export function defaultSettings(): Settings {
  return {
    name: randomName(),
    sensitivity: 1,
    adsSensMult: 1,
    fov: 90,
    invertY: false,
    adsToggle: false,
    autoSprint: false,
    autoMount: true,
    quality: 'auto',
    volumeMaster: 0.8,
    volumeSfx: 1,
    volumeUi: 0.8,
    touchScale: 1,
    touchOpacity: 0.7,
    gyro: false,
    vibrate: true,
    character: 'operator',
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Merge a parsed, possibly-stale or foreign blob over defaults field by field. */
function sanitize(defaults: Settings, parsed: Partial<Settings>): Settings {
  const s: Settings = { ...defaults };
  if (typeof parsed.name === 'string' && parsed.name.trim().length > 0) {
    s.name = parsed.name.slice(0, MAX_NAME_LEN);
  }
  if (isFiniteNumber(parsed.sensitivity)) s.sensitivity = parsed.sensitivity;
  if (isFiniteNumber(parsed.adsSensMult)) s.adsSensMult = parsed.adsSensMult;
  if (isFiniteNumber(parsed.fov)) s.fov = parsed.fov;
  if (typeof parsed.invertY === 'boolean') s.invertY = parsed.invertY;
  if (typeof parsed.adsToggle === 'boolean') s.adsToggle = parsed.adsToggle;
  if (typeof parsed.autoSprint === 'boolean') s.autoSprint = parsed.autoSprint;
  if (typeof parsed.autoMount === 'boolean') s.autoMount = parsed.autoMount;
  if (parsed.quality === 'auto' || parsed.quality === 'desktop' || parsed.quality === 'mobile') s.quality = parsed.quality;
  if (isFiniteNumber(parsed.volumeMaster)) s.volumeMaster = parsed.volumeMaster;
  if (isFiniteNumber(parsed.volumeSfx)) s.volumeSfx = parsed.volumeSfx;
  if (isFiniteNumber(parsed.volumeUi)) s.volumeUi = parsed.volumeUi;
  if (isFiniteNumber(parsed.touchScale)) s.touchScale = parsed.touchScale;
  if (isFiniteNumber(parsed.touchOpacity)) s.touchOpacity = parsed.touchOpacity;
  if (typeof parsed.gyro === 'boolean') s.gyro = parsed.gyro;
  if (typeof parsed.vibrate === 'boolean') s.vibrate = parsed.vibrate;
  if (parsed.character === 'operator' || parsed.character === 'soldier') s.character = parsed.character;
  return s;
}

export function loadSettings(): Settings {
  const defaults = defaultSettings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return sanitize(defaults, parsed);
  } catch {
    return defaults;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable (private mode, quota exceeded) — settings simply
    // won't persist across reloads; nothing else in the app depends on it.
  }
}
