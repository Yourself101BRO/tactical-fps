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
  MOVE_SPRINT,
  MOVE_TACSPRINT,
  ROUND_END,
  ROUND_START,
  TEAM_A,
  TEAM_B,
  WEAPON_NONE,
  ZONE_HEAD,
} from '../../shared/constants.ts';
import { yawPitchToDir } from '../../shared/math.ts';
import { weaponName } from '../../shared/weapons.ts';
import type { PlayerState, RoomState, Snapshot } from '../../shared/types.ts';
import type { Vec3 } from '../../shared/types.ts';
import { Killfeed } from './killfeed.ts';
import type { Minimap } from './minimap.ts';

export type PromptKind = 'MOUNT' | 'MANTLE' | 'PLANT' | 'DEFUSE' | null;

const PROMPT_TEXT: Record<Exclude<PromptKind, null>, string> = {
  MOUNT: 'Hold to Mount',
  MANTLE: 'Jump to Mantle',
  PLANT: 'Hold [F] to Plant',
  DEFUSE: 'Hold [F] to Defuse',
};

interface DamageArc {
  el: HTMLDivElement;
  ttl: number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

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
  private readonly scoreText: HTMLSpanElement;
  private readonly timerText: HTMLSpanElement;
  private readonly pingText: HTMLSpanElement;
  private readonly stalledEl: HTMLDivElement;
  private readonly promptEl: HTMLDivElement;
  private readonly bannerEl: HTMLDivElement;
  private readonly bombEl: HTMLDivElement;
  private readonly flashEl: HTMLDivElement;
  private readonly scopeEl: HTMLDivElement;
  private readonly cookEl: HTMLDivElement;
  private readonly sprintIconEl: HTMLDivElement;
  private readonly minimapSlot: HTMLDivElement;
  private readonly vignetteEl: HTMLDivElement;
  private readonly grenadesEl: HTMLDivElement;

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
  private lastEventTick = -1;
  private readonly fwdScratch: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(root: HTMLElement) {
    this.element = el('div', 'hud');
    root.appendChild(this.element);

    // Crosshair: 4 dynamic lines that spread apart with `setSpread`.
    this.crosshair = el('div', 'crosshair');
    this.crosshairLines = [
      el('div', 'ch-line ch-top'),
      el('div', 'ch-line ch-bottom'),
      el('div', 'ch-line ch-left'),
      el('div', 'ch-line ch-right'),
    ];
    for (const l of this.crosshairLines) this.crosshair.appendChild(l);
    this.element.appendChild(this.crosshair);

    this.hitmarkerEl = el('div', 'hitmarker');
    this.hitmarkerEl.textContent = '✕';
    this.element.appendChild(this.hitmarkerEl);

    this.damageArcsEl = el('div', 'damage-arcs');
    this.element.appendChild(this.damageArcsEl);

    this.scopeEl = el('div', 'scope-overlay');
    this.element.appendChild(this.scopeEl);

    this.flashEl = el('div', 'flash-overlay');
    this.element.appendChild(this.flashEl);

    this.vignetteEl = el('div', 'damage-vignette');
    this.element.appendChild(this.vignetteEl);

    // Bottom-left: health.
    const healthWrap = el('div', 'hud-health');
    this.healthFill = el('div', 'health-fill');
    const healthBar = el('div', 'health-bar');
    healthBar.appendChild(this.healthFill);
    this.healthText = el('span', 'health-text');
    healthWrap.appendChild(healthBar);
    healthWrap.appendChild(this.healthText);
    this.element.appendChild(healthWrap);

    // Bottom-right: ammo.
    const ammoWrap = el('div', 'hud-ammo');
    this.weaponText = el('span', 'weapon-name');
    this.ammoText = el('span', 'ammo-count');
    this.reserveText = el('span', 'ammo-reserve');
    ammoWrap.appendChild(this.weaponText);
    const ammoRow = el('div', 'ammo-row');
    ammoRow.appendChild(this.ammoText);
    ammoRow.appendChild(this.reserveText);
    ammoWrap.appendChild(ammoRow);
    this.grenadesEl = el('div', 'grenade-counts');
    ammoWrap.appendChild(this.grenadesEl);
    this.element.appendChild(ammoWrap);

    // Top-center: score/timer, objective banner.
    const topCenter = el('div', 'hud-top-center');
    this.scoreText = el('span', 'hud-score');
    this.timerText = el('span', 'hud-timer');
    topCenter.appendChild(this.scoreText);
    topCenter.appendChild(this.timerText);
    this.bombEl = el('div', 'hud-bomb-timer');
    topCenter.appendChild(this.bombEl);
    this.element.appendChild(topCenter);

    this.bannerEl = el('div', 'hud-banner');
    this.element.appendChild(this.bannerEl);

    // Top-right: ping, killfeed.
    const topRight = el('div', 'hud-top-right');
    this.pingText = el('span', 'hud-ping');
    topRight.appendChild(this.pingText);
    topRight.appendChild(this.killfeed.element);
    this.element.appendChild(topRight);

    this.stalledEl = el('div', 'hud-stalled');
    this.stalledEl.textContent = 'RECONNECTING…';
    this.element.appendChild(this.stalledEl);

    // Bottom-center: interact prompt, cook indicator, sprint icon.
    this.promptEl = el('div', 'hud-prompt');
    this.element.appendChild(this.promptEl);
    this.cookEl = el('div', 'hud-cook');
    this.element.appendChild(this.cookEl);
    this.sprintIconEl = el('div', 'hud-sprint-icon');
    this.sprintIconEl.textContent = '»';
    this.element.appendChild(this.sprintIconEl);

    // Top-left: minimap mount.
    this.minimapSlot = el('div', 'hud-minimap');
    this.element.appendChild(this.minimapSlot);
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
    this.hitmarkerTtl = 0.25;
    this.hitmarkerEl.classList.toggle('headshot', headshot);
    this.hitmarkerEl.classList.add('active');
  }

  /** angleRad: 0 = directly ahead, +/-π = directly behind, sign = left/right. */
  damageFrom(angleRad: number): void {
    const arcEl = el('div', 'damage-arc');
    arcEl.style.transform = `rotate(${angleRad}rad) translateY(-90px)`;
    this.damageArcsEl.appendChild(arcEl);
    this.damageArcs.push({ el: arcEl, ttl: 1.0 });
  }

  setPrompt(kind: PromptKind): void {
    if (kind === this.lastPromptKind) return;
    this.lastPromptKind = kind;
    if (kind === null) {
      this.promptEl.hidden = true;
      this.promptEl.textContent = '';
    } else {
      this.promptEl.hidden = false;
      this.promptEl.textContent = PROMPT_TEXT[kind];
    }
  }

  /** 0..1 white-out strength (flashbang or damage feedback flash). */
  flash(strength: number): void {
    this.flashStrength = Math.max(0, Math.min(1, strength));
    this.flashEl.style.opacity = String(this.flashStrength);
  }

  showScope(on: boolean): void {
    this.scopeEl.hidden = !on;
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

    this.crosshair.hidden = !local || !local.alive;
    if (local && local.alive) {
      this.updateHealth(local);
      this.updateAmmo(local);
      this.updateMoveIcons(local);
      this.cookEl.hidden = local.cookT <= 0;
      if (local.cookT > 0) this.cookEl.textContent = `COOKING ${local.cookT.toFixed(1)}s`;
      this.grenadesEl.textContent = `${local.lethalCount} ${local.tacticalCount}`;
    } else {
      this.cookEl.hidden = true;
    }

    if (room) {
      // FFA has no team score; TDM/S&D show rounds/score by team.
      this.scoreText.textContent = room.mode === MODE_FFA ? '' : `${room.roundsWon[0]} - ${room.roundsWon[1]}`;
    }
    if (snap) {
      this.timerText.textContent = formatClock(snap.timeLeft);
      this.updateBomb(snap);
      this.processEvents(snap, room);
    }

    this.pingText.textContent = `${Math.round(rtt)}ms`;
    this.stalledEl.hidden = !stalled;

    this.tickTransients(dt);
  }

  private updateHealth(local: PlayerState): void {
    if (local.health === this.lastHealth) return;
    const regen = local.health > this.lastHealth;
    this.lastHealth = local.health;
    const pct = Math.max(0, Math.min(100, local.health));
    this.healthFill.style.width = `${pct}%`;
    this.healthText.textContent = String(Math.ceil(local.health));
    this.healthFill.classList.toggle('low', local.health < 30);
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
  }

  private updateMoveIcons(local: PlayerState): void {
    this.sprintIconEl.hidden = local.moveState !== MOVE_SPRINT && local.moveState !== MOVE_TACSPRINT;
    this.sprintIconEl.classList.toggle('tac', local.moveState === MOVE_TACSPRINT);
  }

  private updateBomb(snap: Snapshot): void {
    if (snap.bombState === BOMB_PLANTED) {
      this.bombEl.hidden = false;
      this.bombEl.textContent = `BOMB ${formatClock(snap.bombTimer)}`;
    } else {
      this.bombEl.hidden = true;
    }
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
        a.el.style.opacity = String(Math.max(0, a.ttl));
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
