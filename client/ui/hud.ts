// Match HUD: crosshair, health/ammo, hitmarkers, damage-direction arcs,
// objective banner, prompts, minimap and killfeed mounts. DOM-only, minimal
// churn — cached elements, values only written when they change. Plan §7.

import {
  BOMB_PLANTED,
  EV_DEFUSE,
  EV_FLASHED,
  EV_HIT,
  EV_KILL,
  EV_PLANT,
  EV_ROUND,
  MODE_FFA,
  MODE_SND,
  MODE_TDM,
  MOVE_SPRINT,
  MOVE_TACSPRINT,
  ROUND_END,
  ROUND_START,
  SND_DEFUSE_TIME,
  SND_PLANT_TIME,
  SND_ROUNDS_TO_WIN,
  TEAM_A,
  TEAM_B,
  WEAPON_NONE,
  ZONE_HEAD,
} from '../../shared/constants.ts';
import { yawPitchToDir } from '../../shared/math.ts';
import { weaponName } from '../../shared/weapons.ts';
import type { LobbyPlayer, PlayerState, RoomState, Snapshot } from '../../shared/types.ts';
import type { Vec3 } from '../../shared/types.ts';
import { ICON_FLASH, ICON_FRAG, TEAM_GLYPH, svgIcon } from './killfeed.ts';
import { Killfeed } from './killfeed.ts';
import type { Minimap } from './minimap.ts';

export type PromptKind = 'MOUNT' | 'MANTLE' | 'PLANT' | 'DEFUSE' | null;

const PROMPT_TEXT: Record<Exclude<PromptKind, null>, string> = {
  MOUNT: 'HOLD TO MOUNT',
  MANTLE: 'JUMP TO MANTLE',
  PLANT: 'HOLD TO PLANT',
  DEFUSE: 'HOLD TO DEFUSE',
};
/** Key-cap shown in the prompt chip. Mount/mantle map to physical keys; the
 * touch layout has no literal key, so those get a small icon glyph instead. */
const PROMPT_KEY: Record<Exclude<PromptKind, null>, string> = {
  MOUNT: '⎕', // ⎕ generic "hold" glyph, since mount has no single bound key
  MANTLE: 'SPACE',
  PLANT: 'F',
  DEFUSE: 'F',
};
/** kind -> total seconds to fill the progress ring, or null for no ring. */
const PROMPT_DURATION: Partial<Record<Exclude<PromptKind, null>, number>> = {
  PLANT: SND_PLANT_TIME,
  DEFUSE: SND_DEFUSE_TIME,
};

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const COMPASS_PX_PER_DEG = 3;
const PROMPT_RING_R = 17;
const PROMPT_RING_C = 2 * Math.PI * PROMPT_RING_R;

interface DamageArc {
  el: HTMLDivElement;
  ttl: number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function svgNS<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]!);
  return e;
}

function cardinalName(deg: number): string {
  const idx = Math.round(deg / 45) % 8;
  return CARDINALS[idx]!;
}

const HITMARKER_SVG = svgIcon('<path d="M4 4 L20 20 M20 4 L4 20" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>').replace(
  '0 0 16 16',
  '0 0 24 24',
);
const SPRINT_SVG = svgIcon(
  '<path d="M4 3 L9 8 L4 13 M9 3 L14 8 L9 13" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
);

export class Hud {
  readonly element: HTMLDivElement;
  readonly killfeed = new Killfeed();
  minimap: Minimap | null = null;

  private readonly crosshair: HTMLDivElement;
  private readonly crosshairLines: HTMLDivElement[];
  private readonly hitmarkerEl: HTMLDivElement;
  private readonly damageArcsEl: HTMLDivElement;
  private readonly healthFill: HTMLDivElement;
  private readonly healthText: HTMLSpanElement;
  private readonly ammoText: HTMLSpanElement;
  private readonly reserveText: HTMLSpanElement;
  private readonly weaponText: HTMLSpanElement;
  private readonly timerText: HTMLSpanElement;
  private readonly pingText: HTMLSpanElement;
  private readonly lagBadgeEl: HTMLDivElement;
  private readonly promptEl: HTMLDivElement;
  private readonly promptKeyEl: HTMLSpanElement;
  private readonly promptTextEl: HTMLSpanElement;
  private readonly promptRingFg: SVGCircleElement;
  private readonly bannerEl: HTMLDivElement;
  private readonly bombEl: HTMLDivElement;
  private readonly bombTimeEl: HTMLSpanElement;
  private readonly flashEl: HTMLDivElement;
  private readonly scopeEl: HTMLDivElement;
  private readonly cookEl: HTMLDivElement;
  private readonly sprintIconEl: HTMLDivElement;
  private readonly minimapSlot: HTMLDivElement;
  private readonly compassStripEl: HTMLDivElement;
  private readonly compassLabelEl: HTMLSpanElement;
  private readonly vignetteEl: HTMLDivElement;
  private readonly lethalCountEl: HTMLSpanElement;
  private readonly tacticalCountEl: HTMLSpanElement;
  private readonly reloadWrapEl: HTMLDivElement;
  private readonly reloadFillEl: HTMLDivElement;
  private readonly scoreModeEl: HTMLDivElement;

  // Score sub-elements, (re)built by buildScoreMode() when room.mode changes.
  private scoreTdmA: HTMLSpanElement | null = null;
  private scoreTdmB: HTMLSpanElement | null = null;
  private scoreFfaName: HTMLSpanElement | null = null;
  private scoreFfaKills: HTMLSpanElement | null = null;
  private scoreSndRound: HTMLSpanElement | null = null;
  private scoreSndPipsA: HTMLDivElement | null = null;
  private scoreSndPipsB: HTMLDivElement | null = null;

  private readonly damageArcs: DamageArc[] = [];
  private hitmarkerTtl = 0;
  private bannerTtl = 0;
  private flashStrength = 0;
  private lastLocalId = 0;
  private lastHealth = -1;
  private lastAmmo = -1;
  private lastReserve = -1;
  private lastWeapon = -1;
  private lastSpreadPx = -1;
  private lastPromptKind: PromptKind = null;
  private lastPromptProgress = -1;
  private lastEventTick = -1;
  private lastLethal = -1;
  private lastTactical = -1;
  private lastReloadActive = false;
  private lastReloadFrac = -1;
  private lastScoreMode = -1;
  private lastRoundsA = -1;
  private lastRoundsB = -1;
  private lastSndRoundNo = -1;
  private lastFfaKey = '';
  private lastHeadingDeg = NaN;
  private lastPingBucket = '';
  private aliveForCrosshair = false;
  private scopeActive = false;
  private readonly fwdScratch: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(root: HTMLElement) {
    this.element = el('div', 'hud');
    root.appendChild(this.element);

    // Crosshair: 4 dynamic lines that spread apart with `setSpread`, plus a
    // static center dot. Hidden while dead/spectating or while scoped.
    this.crosshair = el('div', 'crosshair');
    this.crosshairLines = [
      el('div', 'ch-line ch-top'),
      el('div', 'ch-line ch-bottom'),
      el('div', 'ch-line ch-left'),
      el('div', 'ch-line ch-right'),
    ];
    for (const l of this.crosshairLines) this.crosshair.appendChild(l);
    this.crosshair.appendChild(el('div', 'ch-dot'));
    this.element.appendChild(this.crosshair);

    this.hitmarkerEl = el('div', 'hitmarker');
    this.hitmarkerEl.innerHTML = HITMARKER_SVG;
    this.element.appendChild(this.hitmarkerEl);

    this.damageArcsEl = el('div', 'damage-arcs');
    this.element.appendChild(this.damageArcsEl);

    // Scope overlay: black vignette with a circular window + fine reticle.
    this.scopeEl = el('div', 'scope-overlay');
    this.scopeEl.appendChild(el('div', 'scope-mask'));
    const reticle = el('div', 'scope-reticle');
    reticle.innerHTML = svgIcon(
      '<path d="M8 0.5 L8 5 M8 11 L8 15.5 M0.5 8 L5 8 M11 8 L15.5 8" stroke="currentColor" stroke-width="0.4" fill="none"/>' +
        '<circle cx="8" cy="8" r="0.5" fill="currentColor"/>' +
        '<path d="M8 2.4 L8.6 3.4 L7.4 3.4 Z" fill="currentColor"/>',
    ).replace('class="glyph-svg"', 'class="scope-reticle-svg"');
    this.scopeEl.appendChild(reticle);
    this.scopeEl.hidden = true;
    this.element.appendChild(this.scopeEl);

    this.flashEl = el('div', 'flash-overlay');
    this.element.appendChild(this.flashEl);

    this.vignetteEl = el('div', 'damage-vignette');
    this.element.appendChild(this.vignetteEl);

    // Bottom-left: health, segmented via a CSS overlay on healthFill.
    const healthWrap = el('div', 'hud-health');
    const healthIcon = el('div', 'health-icon');
    healthIcon.innerHTML = svgIcon('<path d="M8 13.5 C3 10 1 7.2 1 4.9 C1 2.9 2.6 1.5 4.4 1.5 C5.9 1.5 7.1 2.4 8 3.7 C8.9 2.4 10.1 1.5 11.6 1.5 C13.4 1.5 15 2.9 15 4.9 C15 7.2 13 10 8 13.5 Z" fill="currentColor"/>');
    healthWrap.appendChild(healthIcon);
    const healthBody = el('div', 'health-body');
    const healthBar = el('div', 'health-bar');
    this.healthFill = el('div', 'health-fill');
    healthBar.appendChild(this.healthFill);
    this.healthText = el('span', 'health-text');
    healthBody.appendChild(healthBar);
    healthBody.appendChild(this.healthText);
    healthWrap.appendChild(healthBody);
    this.element.appendChild(healthWrap);

    // Bottom-right: ammo, reload progress, equipment.
    const ammoWrap = el('div', 'hud-ammo');
    this.weaponText = el('span', 'weapon-name');
    ammoWrap.appendChild(this.weaponText);
    const ammoRow = el('div', 'ammo-row');
    this.ammoText = el('span', 'ammo-count');
    this.reserveText = el('span', 'ammo-reserve');
    ammoRow.appendChild(this.ammoText);
    ammoRow.appendChild(this.reserveText);
    ammoWrap.appendChild(ammoRow);
    this.reloadWrapEl = el('div', 'reload-wrap');
    this.reloadWrapEl.appendChild(el('span', 'reload-label')).textContent = 'RELOADING';
    const reloadBar = el('div', 'reload-bar');
    this.reloadFillEl = el('div', 'reload-fill');
    reloadBar.appendChild(this.reloadFillEl);
    this.reloadWrapEl.appendChild(reloadBar);
    this.reloadWrapEl.hidden = true;
    ammoWrap.appendChild(this.reloadWrapEl);

    const equipRow = el('div', 'hud-equip');
    const lethalItem = el('div', 'eq-item eq-lethal');
    const lethalIcon = el('span', 'eq-icon');
    lethalIcon.innerHTML = ICON_FRAG;
    this.lethalCountEl = el('span', 'eq-count');
    lethalItem.appendChild(lethalIcon);
    lethalItem.appendChild(this.lethalCountEl);
    const tacticalItem = el('div', 'eq-item eq-tactical');
    const tacticalIcon = el('span', 'eq-icon');
    tacticalIcon.innerHTML = ICON_FLASH;
    this.tacticalCountEl = el('span', 'eq-count');
    tacticalItem.appendChild(tacticalIcon);
    tacticalItem.appendChild(this.tacticalCountEl);
    equipRow.appendChild(lethalItem);
    equipRow.appendChild(tacticalItem);
    ammoWrap.appendChild(equipRow);
    this.element.appendChild(ammoWrap);

    // Top-center: timer, mode-specific score, bomb timer, objective banner.
    const topCenter = el('div', 'hud-top-center');
    this.timerText = el('span', 'hud-timer');
    topCenter.appendChild(this.timerText);
    this.scoreModeEl = el('div', 'hud-score');
    topCenter.appendChild(this.scoreModeEl);
    this.bombEl = el('div', 'hud-bomb-timer');
    const bombIcon = el('span', 'bomb-timer-icon');
    bombIcon.innerHTML = svgIcon('<circle cx="7" cy="9" r="5.5" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M10.6 5.4 L12.5 3.5 M11.7 2 L14 3.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/>');
    this.bombEl.appendChild(bombIcon);
    this.bombTimeEl = el('span', 'bomb-time');
    this.bombEl.appendChild(this.bombTimeEl);
    this.bombEl.hidden = true;
    topCenter.appendChild(this.bombEl);
    this.element.appendChild(topCenter);

    this.bannerEl = el('div', 'hud-banner');
    this.element.appendChild(this.bannerEl);

    // Top-right: ping + lag badge, killfeed.
    const topRight = el('div', 'hud-top-right');
    const pingRow = el('div', 'hud-ping-row');
    this.pingText = el('span', 'hud-ping');
    pingRow.appendChild(this.pingText);
    this.lagBadgeEl = el('div', 'hud-lag-badge');
    this.lagBadgeEl.textContent = 'LAG';
    this.lagBadgeEl.hidden = true;
    pingRow.appendChild(this.lagBadgeEl);
    topRight.appendChild(pingRow);
    topRight.appendChild(this.killfeed.element);
    this.element.appendChild(topRight);

    // Bottom-center: interact prompt (key-cap + progress ring), cook indicator, sprint icon.
    this.promptEl = el('div', 'hud-prompt');
    const promptRingWrap = el('div', 'prompt-ring');
    const ringSvg = svgNS('svg', { viewBox: '0 0 40 40', class: 'prompt-ring-svg' });
    const ringBg = svgNS('circle', { cx: '20', cy: '20', r: String(PROMPT_RING_R), class: 'prompt-ring-bg' });
    this.promptRingFg = svgNS('circle', { cx: '20', cy: '20', r: String(PROMPT_RING_R), class: 'prompt-ring-fg' });
    this.promptRingFg.style.strokeDasharray = String(PROMPT_RING_C);
    this.promptRingFg.style.strokeDashoffset = String(PROMPT_RING_C);
    ringSvg.appendChild(ringBg);
    ringSvg.appendChild(this.promptRingFg);
    promptRingWrap.appendChild(ringSvg);
    this.promptKeyEl = el('span', 'prompt-key');
    promptRingWrap.appendChild(this.promptKeyEl);
    this.promptEl.appendChild(promptRingWrap);
    this.promptTextEl = el('span', 'prompt-label');
    this.promptEl.appendChild(this.promptTextEl);
    this.promptEl.hidden = true;
    this.element.appendChild(this.promptEl);

    this.cookEl = el('div', 'hud-cook');
    this.element.appendChild(this.cookEl);

    this.sprintIconEl = el('div', 'hud-sprint-icon');
    this.sprintIconEl.innerHTML = SPRINT_SVG;
    this.element.appendChild(this.sprintIconEl);

    // Top-left: minimap in a slanted frame with a compass strip.
    const minimapFrame = el('div', 'hud-minimap-frame');
    this.minimapSlot = el('div', 'hud-minimap-mask');
    minimapFrame.appendChild(this.minimapSlot);
    const compass = el('div', 'hud-compass');
    this.compassStripEl = el('div', 'hud-compass-strip');
    compass.appendChild(this.compassStripEl);
    this.compassLabelEl = el('span', 'hud-compass-label');
    compass.appendChild(this.compassLabelEl);
    minimapFrame.appendChild(compass);
    this.element.appendChild(minimapFrame);
  }

  setMinimap(m: Minimap | null): void {
    if (this.minimap && this.minimap.element.parentElement === this.minimapSlot) {
      this.minimapSlot.removeChild(this.minimap.element);
    }
    this.minimap = m;
    if (m) this.minimapSlot.appendChild(m.element);
  }

  show(): void {
    this.element.hidden = false;
  }

  hide(): void {
    this.element.hidden = true;
  }

  hitmarker(headshot: boolean): void {
    this.hitmarkerTtl = 0.2;
    this.hitmarkerEl.classList.remove('active');
    // Force a reflow so re-triggering mid-animation restarts the CSS animation.
    void this.hitmarkerEl.offsetWidth;
    this.hitmarkerEl.classList.toggle('headshot', headshot);
    this.hitmarkerEl.classList.add('active');
  }

  /** angleRad: 0 = directly ahead, +/-π = directly behind, sign = left/right. */
  damageFrom(angleRad: number): void {
    const arcEl = el('div', 'damage-arc');
    arcEl.style.transform = `rotate(${angleRad}rad) translateY(-92px)`;
    this.damageArcsEl.appendChild(arcEl);
    this.damageArcs.push({ el: arcEl, ttl: 1.2 });
  }

  setPrompt(kind: PromptKind): void {
    if (kind === this.lastPromptKind) return;
    this.lastPromptKind = kind;
    this.lastPromptProgress = -1;
    if (kind === null) {
      this.promptEl.hidden = true;
      return;
    }
    this.promptEl.hidden = false;
    this.promptKeyEl.textContent = PROMPT_KEY[kind];
    this.promptTextEl.textContent = PROMPT_TEXT[kind];
    const hasRing = PROMPT_DURATION[kind] !== undefined;
    this.promptEl.classList.toggle('has-ring', hasRing);
    this.promptRingFg.style.strokeDashoffset = String(PROMPT_RING_C);
  }

  /** 0..1 white-out strength (flashbang or damage feedback flash). */
  flash(strength: number): void {
    this.flashStrength = Math.max(0, Math.min(1, strength));
    this.flashEl.style.opacity = String(this.flashStrength);
  }

  showScope(on: boolean): void {
    this.scopeEl.hidden = !on;
    this.scopeActive = on;
    this.refreshCrosshairVisibility();
  }

  /** Dynamic crosshair spread radius, in pixels from center. */
  setSpread(px: number): void {
    if (Math.abs(px - this.lastSpreadPx) < 0.25) return;
    this.lastSpreadPx = px;
    const gap = 4 + px;
    this.crosshairLines[0]!.style.transform = `translateY(${-gap}px)`;
    this.crosshairLines[1]!.style.transform = `translateY(${gap}px)`;
    this.crosshairLines[2]!.style.transform = `translateX(${-gap}px)`;
    this.crosshairLines[3]!.style.transform = `translateX(${gap}px)`;
  }

  banner(text: string, seconds: number): void {
    this.bannerEl.textContent = text;
    this.bannerEl.classList.remove('active');
    void this.bannerEl.offsetWidth;
    this.bannerEl.classList.add('active');
    this.bannerTtl = seconds;
  }

  /**
   * Drives every per-frame HUD readout. `local` is the recipient's own
   * predicted/authoritative state (null while dead/spectating — ammo, health
   * and the crosshair are hidden in that case, the rest of the HUD keeps
   * ticking so killfeed/timer/banner stay live for the spectate overlay).
   */
  update(local: PlayerState | null, snap: Snapshot | null, room: RoomState | null, rtt: number, stalled: boolean, dt: number): void {
    if (local) this.lastLocalId = local.id;

    this.aliveForCrosshair = !!local && local.alive;
    this.refreshCrosshairVisibility();
    if (local && local.alive) {
      this.updateHealth(local);
      this.updateAmmo(local);
      this.updateMoveIcons(local);
      this.updateEquipment(local);
      this.updatePromptProgress(local);
      this.updateCompass(local.yaw);
      this.cookEl.hidden = local.cookT <= 0;
      if (local.cookT > 0) this.cookEl.textContent = `COOKING ${local.cookT.toFixed(1)}s`;
    } else {
      this.cookEl.hidden = true;
    }

    if (room) this.updateScore(room);
    if (snap) {
      this.timerText.textContent = formatClock(snap.timeLeft);
      this.updateBomb(snap);
      this.processEvents(snap, room);
    }

    this.updatePing(rtt);
    if (stalled !== !this.lagBadgeEl.hidden) this.lagBadgeEl.hidden = !stalled;

    this.tickTransients(dt);
  }

  private refreshCrosshairVisibility(): void {
    this.crosshair.hidden = !this.aliveForCrosshair || this.scopeActive;
  }

  private updateHealth(local: PlayerState): void {
    if (local.health === this.lastHealth) return;
    const regen = local.health > this.lastHealth;
    this.lastHealth = local.health;
    const pct = Math.max(0, Math.min(100, local.health));
    this.healthFill.style.width = `${pct}%`;
    this.healthText.textContent = String(Math.ceil(local.health));
    this.healthFill.classList.toggle('low', local.health < 30);
    this.healthFill.classList.toggle('critical', local.health < 15);
    this.vignetteEl.style.opacity = local.health < 30 ? String(1 - local.health / 30) : '0';
    if (regen) {
      this.healthFill.classList.add('regen');
      setTimeout(() => this.healthFill.classList.remove('regen'), 300);
    }
  }

  private updateAmmo(local: PlayerState): void {
    const slot = local.slots[local.activeSlot];
    const weapon = slot?.weapon ?? WEAPON_NONE;
    const mag = slot?.mag ?? 0;
    const reserve = slot?.reserve ?? 0;
    if (weapon !== this.lastWeapon) {
      this.lastWeapon = weapon;
      this.weaponText.textContent = weapon === WEAPON_NONE ? '' : weaponName(weapon);
    }
    if (mag !== this.lastAmmo) {
      this.lastAmmo = mag;
      this.ammoText.textContent = String(mag);
      this.ammoText.classList.toggle('empty', mag === 0);
    }
    if (reserve !== this.lastReserve) {
      this.lastReserve = reserve;
      this.reserveText.textContent = `/ ${reserve}`;
    }

    const reloading = local.reloadT > 0;
    if (reloading !== this.lastReloadActive) {
      this.lastReloadActive = reloading;
      this.reloadWrapEl.hidden = !reloading;
    }
    if (reloading) {
      const frac = local.reloadTotal > 0 ? 1 - local.reloadT / local.reloadTotal : 0;
      if (Math.abs(frac - this.lastReloadFrac) > 0.01) {
        this.lastReloadFrac = frac;
        this.reloadFillEl.style.width = `${Math.max(0, Math.min(100, frac * 100))}%`;
      }
    }
  }

  private updateEquipment(local: PlayerState): void {
    if (local.lethalCount !== this.lastLethal) {
      this.lastLethal = local.lethalCount;
      this.lethalCountEl.textContent = String(local.lethalCount);
    }
    if (local.tacticalCount !== this.lastTactical) {
      this.lastTactical = local.tacticalCount;
      this.tacticalCountEl.textContent = String(local.tacticalCount);
    }
  }

  private updateMoveIcons(local: PlayerState): void {
    this.sprintIconEl.hidden = local.moveState !== MOVE_SPRINT && local.moveState !== MOVE_TACSPRINT;
    this.sprintIconEl.classList.toggle('tac', local.moveState === MOVE_TACSPRINT);
  }

  private updatePromptProgress(local: PlayerState): void {
    const kind = this.lastPromptKind;
    if (kind === null) return;
    const total = PROMPT_DURATION[kind];
    if (total === undefined) return;
    const progress = Math.max(0, Math.min(1, local.interactT / total));
    if (Math.abs(progress - this.lastPromptProgress) < 0.01) return;
    this.lastPromptProgress = progress;
    this.promptRingFg.style.strokeDashoffset = String(PROMPT_RING_C * (1 - progress));
  }

  private updateBomb(snap: Snapshot): void {
    const planted = snap.bombState === BOMB_PLANTED;
    if (planted !== !this.bombEl.hidden) this.bombEl.hidden = !planted;
    if (planted) this.bombTimeEl.textContent = formatClock(snap.bombTimer);
  }

  private updatePing(rtt: number): void {
    const bucket = rtt < 60 ? 'good' : rtt < 120 ? 'warn' : 'bad';
    this.pingText.textContent = `${Math.round(rtt)}ms`;
    if (bucket !== this.lastPingBucket) {
      this.lastPingBucket = bucket;
      this.pingText.classList.remove('ping-good', 'ping-warn', 'ping-bad');
      this.pingText.classList.add(`ping-${bucket}`);
    }
  }

  /** (Re)builds the mode-specific score readout; cheap and only runs on a
   * mode change (once per match, in practice). */
  private buildScoreMode(mode: number): void {
    this.scoreModeEl.textContent = '';
    this.scoreTdmA = this.scoreTdmB = this.scoreFfaName = this.scoreFfaKills = this.scoreSndRound = null;
    this.scoreSndPipsA = this.scoreSndPipsB = null;
    this.lastRoundsA = this.lastRoundsB = -1;
    this.lastSndRoundNo = -1;
    this.lastFfaKey = '';

    if (mode === MODE_TDM) {
      const wrap = el('div', 'score-tdm');
      const a = el('span', 'score-team score-team-a');
      a.appendChild(el('span', 'score-glyph')).textContent = TEAM_GLYPH[TEAM_A]!;
      this.scoreTdmA = el('b', 'score-num');
      a.appendChild(this.scoreTdmA);
      const sep = el('span', 'score-sep');
      sep.textContent = '–';
      const b = el('span', 'score-team score-team-b');
      b.appendChild(el('span', 'score-glyph')).textContent = TEAM_GLYPH[TEAM_B]!;
      this.scoreTdmB = el('b', 'score-num');
      b.appendChild(this.scoreTdmB);
      wrap.appendChild(a);
      wrap.appendChild(sep);
      wrap.appendChild(b);
      this.scoreModeEl.appendChild(wrap);
    } else if (mode === MODE_SND) {
      const wrap = el('div', 'score-snd');
      this.scoreSndPipsA = el('div', 'snd-pips snd-pips-a');
      for (let i = 0; i < SND_ROUNDS_TO_WIN; i++) this.scoreSndPipsA.appendChild(el('span', 'snd-pip'));
      this.scoreSndRound = el('span', 'score-round-label');
      this.scoreSndPipsB = el('div', 'snd-pips snd-pips-b');
      for (let i = 0; i < SND_ROUNDS_TO_WIN; i++) this.scoreSndPipsB.appendChild(el('span', 'snd-pip'));
      wrap.appendChild(this.scoreSndPipsA);
      wrap.appendChild(this.scoreSndRound);
      wrap.appendChild(this.scoreSndPipsB);
      this.scoreModeEl.appendChild(wrap);
    } else if (mode === MODE_FFA) {
      const wrap = el('div', 'score-ffa');
      wrap.appendChild(el('span', 'score-ffa-label')).textContent = 'LEADER';
      this.scoreFfaName = el('span', 'score-ffa-name');
      this.scoreFfaKills = el('b', 'score-ffa-kills');
      wrap.appendChild(this.scoreFfaName);
      wrap.appendChild(this.scoreFfaKills);
      this.scoreModeEl.appendChild(wrap);
    }
  }

  private setPips(container: HTMLDivElement, count: number): void {
    const kids = container.children;
    for (let i = 0; i < kids.length; i++) kids[i]!.classList.toggle('filled', i < count);
  }

  private updateScore(room: RoomState): void {
    if (room.mode !== this.lastScoreMode) {
      this.lastScoreMode = room.mode;
      this.buildScoreMode(room.mode);
    }
    if (room.mode === MODE_TDM) {
      if (room.roundsWon[0] !== this.lastRoundsA) {
        this.lastRoundsA = room.roundsWon[0];
        this.scoreTdmA!.textContent = String(room.roundsWon[0]);
      }
      if (room.roundsWon[1] !== this.lastRoundsB) {
        this.lastRoundsB = room.roundsWon[1];
        this.scoreTdmB!.textContent = String(room.roundsWon[1]);
      }
    } else if (room.mode === MODE_SND) {
      if (room.round !== this.lastSndRoundNo) {
        this.lastSndRoundNo = room.round;
        this.scoreSndRound!.textContent = `ROUND ${room.round}`;
      }
      if (room.roundsWon[0] !== this.lastRoundsA) {
        this.lastRoundsA = room.roundsWon[0];
        this.setPips(this.scoreSndPipsA!, room.roundsWon[0]);
      }
      if (room.roundsWon[1] !== this.lastRoundsB) {
        this.lastRoundsB = room.roundsWon[1];
        this.setPips(this.scoreSndPipsB!, room.roundsWon[1]);
      }
    } else if (room.mode === MODE_FFA) {
      let leader: LobbyPlayer | null = null;
      for (const p of room.players) if (!leader || p.kills > leader.kills) leader = p;
      const key = leader ? `${leader.id}:${leader.kills}` : '';
      if (key !== this.lastFfaKey) {
        this.lastFfaKey = key;
        this.scoreFfaName!.textContent = leader ? leader.name : '—';
        this.scoreFfaKills!.textContent = leader ? String(leader.kills) : '';
      }
    }
  }

  /** Updates the compass strip from the local player's yaw. Cosmetic only —
   * no fixed in-world "north" is defined, this just tracks facing smoothly. */
  private updateCompass(yaw: number): void {
    const deg = Math.round((((-yaw * 180) / Math.PI) % 360 + 360) % 360);
    if (deg === this.lastHeadingDeg) return;
    this.lastHeadingDeg = deg;
    this.compassStripEl.style.backgroundPositionX = `${-(deg * COMPASS_PX_PER_DEG)}px`;
    this.compassLabelEl.textContent = cardinalName(deg);
  }

  private resolveName(id: number, room: RoomState | null): string {
    const p = room?.players.find((pl) => pl.id === id);
    return p?.name ?? `Player${id}`;
  }

  private resolveTeam(id: number, room: RoomState | null): number {
    const p = room?.players.find((pl) => pl.id === id);
    return p?.team ?? 0;
  }

  private processEvents(snap: Snapshot, room: RoomState | null): void {
    if (snap.tick === this.lastEventTick) return; // avoid double-processing a resent snapshot
    this.lastEventTick = snap.tick;
    const localId = this.lastLocalId;
    const localPlayer = snap.players.find((p) => p.id === localId);

    for (const ev of snap.events) {
      switch (ev.type) {
        case EV_HIT: {
          if (ev.attacker === localId) this.hitmarker(ev.zone === ZONE_HEAD);
          if (ev.target === localId && localPlayer) {
            const attacker = snap.players.find((p) => p.id === ev.attacker);
            if (attacker) this.damageFrom(this.angleTo(localPlayer, attacker.pos));
          }
          break;
        }
        case EV_KILL: {
          const killerName = ev.killer === ev.victim ? '' : this.resolveName(ev.killer, room);
          const victimName = this.resolveName(ev.victim, room);
          const involvesLocal = ev.killer === localId || ev.victim === localId;
          this.killfeed.push(
            killerName,
            victimName,
            ev.weapon,
            ev.headshot,
            this.resolveTeam(ev.killer, room),
            this.resolveTeam(ev.victim, room),
            involvesLocal,
          );
          break;
        }
        case EV_FLASHED: {
          if (ev.victim === localId) this.flash(ev.strength);
          break;
        }
        case EV_PLANT: {
          this.banner(`BOMB PLANTED — SITE ${String.fromCharCode(65 + ev.site)}`, 3);
          break;
        }
        case EV_DEFUSE: {
          this.banner('BOMB DEFUSED', 3);
          break;
        }
        case EV_ROUND: {
          if (ev.state === ROUND_START) this.banner(`ROUND ${ev.round}`, 2);
          else if (ev.state === ROUND_END) {
            const teamText = ev.winner === TEAM_A ? 'TEAM A' : ev.winner === TEAM_B ? 'TEAM B' : 'DRAW';
            this.banner(`${teamText} WINS THE ROUND`, 3);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  /** Bearing of `targetPos` relative to `from`'s forward, in [-π, π]. */
  private angleTo(from: { pos: Vec3; yaw: number }, targetPos: Vec3): number {
    yawPitchToDir(from.yaw, 0, this.fwdScratch);
    const dx = targetPos.x - from.pos.x;
    const dz = targetPos.z - from.pos.z;
    const distXZ = Math.hypot(dx, dz) || 1;
    const dirX = dx / distXZ;
    const dirZ = dz / distXZ;
    const dot = this.fwdScratch.x * dirX + this.fwdScratch.z * dirZ;
    const cross = this.fwdScratch.x * dirZ - this.fwdScratch.z * dirX;
    return Math.atan2(cross, dot);
  }

  private tickTransients(dt: number): void {
    if (this.hitmarkerTtl > 0) {
      this.hitmarkerTtl -= dt;
      if (this.hitmarkerTtl <= 0) this.hitmarkerEl.classList.remove('active', 'headshot');
    }
    if (this.flashStrength > 0) {
      this.flashStrength = Math.max(0, this.flashStrength - dt / 1.5);
      this.flashEl.style.opacity = String(this.flashStrength);
    }
    if (this.bannerTtl > 0) {
      this.bannerTtl -= dt;
      if (this.bannerTtl <= 0) this.bannerEl.classList.remove('active');
    }
    for (let i = this.damageArcs.length - 1; i >= 0; i--) {
      const a = this.damageArcs[i]!;
      a.ttl -= dt;
      if (a.ttl <= 0) {
        a.el.remove();
        this.damageArcs.splice(i, 1);
      } else {
        a.el.style.opacity = String(Math.min(1, a.ttl * 1.5));
      }
    }
    this.killfeed.update(dt);
  }
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}
