// Touch input device: a DOM overlay (floating joystick + drag-look + buttons)
// built with Pointer Events, per-identifier tracked. DOM-only (no shared/sim,
// no three.js). See plan §7 (touch layout) and §9 (iOS specifics).

import type { Settings } from '../settings.ts';
import {
  BTN_JUMP,
  BTN_CROUCH,
  BTN_PRONE,
  BTN_SPRINT,
  BTN_TACSPRINT,
  BTN_FIRE,
  BTN_ADS,
  BTN_RELOAD,
  BTN_MELEE,
  BTN_LETHAL,
  BTN_TACTICAL,
  SLOT_PRIMARY,
  SLOT_SECONDARY,
} from '../../shared/constants.ts';

/** Joystick spawns with this base radius (px), scaled by settings.touchScale. */
const JOYSTICK_BASE_RADIUS = 64;
/** Push magnitude beyond this, sustained, auto-sprints. */
const AUTOSPRINT_MAGNITUDE = 0.9;
/** ...for this long (seconds). */
const AUTOSPRINT_HOLD_S = 0.3;
/** A quick upward flick past this magnitude counts as one "flick" for tac-sprint detection. */
const FLICK_MAGNITUDE = 0.85;
/** Two flicks inside this window (ms) arm tactical sprint for one outgoing sample. */
const FLICK_WINDOW_MS = 450;
/** Crouch button: released before this (ms) = crouch; held past it = prone. */
const PRONE_HOLD_MS = 400;
/** Left zone is this fraction of viewport width; the rest is look/buttons. */
const JOYSTICK_ZONE_FRACTION = 0.45;

export interface TouchConsumeResult {
  moveX: number;
  moveY: number;
  /** Look drag deltas in px accumulated since the last consume. */
  lookDX: number;
  lookDY: number;
  buttons: number;
  /** SLOT_PRIMARY/SLOT_SECONDARY on a swap-button tap this interval, else -1. */
  weaponSlot: number;
  scoreboardHeld: boolean;
  /** Edge: true once per menu-button tap; reading consume() clears it. */
  menuPressed: boolean;
}

export interface TouchCallbacks {
  /** Fired synchronously on menu-button tap, in addition to the polled menuPressed. */
  onMenu?: () => void;
}

/** pointer:coarse or touch points present — used by InputManager to pick a mode. */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const points = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  return coarse || points;
}

const HOLD_BIT: Record<string, number> = {
  'tc-btn-fire': BTN_FIRE,
  'tc-btn-fire2': BTN_FIRE,
  'tc-btn-jump': BTN_JUMP,
  'tc-btn-reload': BTN_RELOAD,
  'tc-btn-lethal': BTN_LETHAL,
  'tc-btn-tactical': BTN_TACTICAL,
  'tc-btn-melee': BTN_MELEE,
};

const STYLE_ID = 'tfps-touch-controls-style';
// Minimal layout so the control scheme works before agent L's touch.css loads.
// Positions honour the safe-area insets per plan §9 (iOS) and stay >=12px from
// the bottom, >=8px from the sides. touch.css (loaded later) may override any
// of this — nothing here is !important.
const INLINE_CSS = `
.tc-root { position: fixed; inset: 0; z-index: 500; touch-action: none; }
.tc-joystick-zone { position: absolute; left: 0; top: 0; width: ${JOYSTICK_ZONE_FRACTION * 100}%; height: 100%; }
.tc-look-zone { position: absolute; right: 0; top: 0; width: ${(1 - JOYSTICK_ZONE_FRACTION) * 100}%; height: 100%; }
.tc-joystick { position: absolute; width: 128px; height: 128px; margin: -64px; border-radius: 50%;
  background: rgba(255,255,255,0.08); border: 2px solid rgba(255,255,255,0.25); display: none; }
.tc-stick { position: absolute; width: 56px; height: 56px; margin: -28px; left: 50%; top: 50%;
  border-radius: 50%; background: rgba(255,255,255,0.35); }
.tc-btn { position: absolute; min-width: 56px; min-height: 56px; border-radius: 50%;
  background: rgba(20,20,20,0.45); border: 1px solid rgba(255,255,255,0.3); color: #fff;
  display: flex; align-items: center; justify-content: center; font: 11px system-ui, sans-serif;
  user-select: none; -webkit-user-select: none; }
.tc-btn.tc-active { background: rgba(255,255,255,0.35); }
.tc-btn-fire { width: 84px; height: 84px; right: calc(env(safe-area-inset-right, 0px) + 16px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 12px); }
.tc-btn-fire2 { width: 56px; height: 56px; right: calc(env(safe-area-inset-right, 0px) + 96px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 110px); }
.tc-btn-ads { right: calc(env(safe-area-inset-right, 0px) + 100px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 20px); }
.tc-btn-jump { right: calc(env(safe-area-inset-right, 0px) + 172px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 90px); }
.tc-btn-crouch { right: calc(env(safe-area-inset-right, 0px) + 172px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 20px); }
.tc-btn-reload { right: calc(env(safe-area-inset-right, 0px) + 16px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 170px); }
.tc-btn-swap { right: calc(env(safe-area-inset-right, 0px) + 96px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 190px); }
.tc-btn-lethal { left: calc(env(safe-area-inset-left, 0px) + 8px); top: calc(env(safe-area-inset-top, 0px) + 12px); }
.tc-btn-tactical { left: calc(env(safe-area-inset-left, 0px) + 72px); top: calc(env(safe-area-inset-top, 0px) + 12px); }
.tc-btn-melee { left: calc(env(safe-area-inset-left, 0px) + 136px); top: calc(env(safe-area-inset-top, 0px) + 12px); }
.tc-btn-score { right: calc(env(safe-area-inset-right, 0px) + 8px); top: calc(env(safe-area-inset-top, 0px) + 12px); }
.tc-btn-menu { right: calc(env(safe-area-inset-right, 0px) + 72px); top: calc(env(safe-area-inset-top, 0px) + 12px); }
`;

interface JoystickState {
  pointerId: number;
  baseX: number;
  baseY: number;
  radius: number;
  sprintHoldStart: number | null;
  flickTimestamps: number[];
  wasLow: boolean;
}

/**
 * Touch device backend. Builds its own DOM under `root`; show()/hide() toggle
 * visibility without tearing listeners down. All movement/look/button state is
 * drained by consume(); scoreboardHeld is also exposed live (it is level state,
 * not edge, so reading it never disturbs consume()).
 */
export class TouchControls {
  private readonly root: HTMLElement;
  private readonly settings: Settings;
  private readonly callbacks: TouchCallbacks;

  private container!: HTMLDivElement;
  private joystickZone!: HTMLDivElement;
  private lookZone!: HTMLDivElement;
  private joystickEl!: HTMLDivElement;
  private stickEl!: HTMLDivElement;
  private readonly buttonEls = new Map<string, HTMLDivElement>();

  private visible = false;
  private attached = false;

  private moveX = 0;
  private moveY = 0;
  private lookDX = 0;
  private lookDY = 0;
  private heldBtnBits = 0;
  private adsToggled = false;
  private pendingSlot = -1;
  private scoreboardHeldFlag = false;
  private menuEdge = false;
  private tacSprintPulse = false;

  private joystick: JoystickState | null = null;
  private readonly lookPointers = new Map<number, { x: number; y: number }>();
  private readonly buttonPointers = new Map<number, string>();
  private crouchPointerId: number | null = null;
  private crouchDownAt = 0;

  private readonly onPointerDown = (e: PointerEvent): void => this.handlePointerDown(e);
  private readonly onPointerMove = (e: PointerEvent): void => this.handlePointerMove(e);
  private readonly onPointerUp = (e: PointerEvent): void => this.handlePointerUpOrCancel(e);

  constructor(root: HTMLElement, settings: Settings, callbacks: TouchCallbacks = {}) {
    this.root = root;
    this.settings = settings;
    this.callbacks = callbacks;
    this.buildDom();
  }

  private ensureStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = INLINE_CSS;
    document.head.appendChild(style);
  }

  private buildDom(): void {
    this.ensureStyle();

    const container = document.createElement('div');
    container.className = 'tc-root';
    container.hidden = true;

    const joystickZone = document.createElement('div');
    joystickZone.className = 'tc-joystick-zone';
    const joystickEl = document.createElement('div');
    joystickEl.className = 'tc-joystick';
    const stickEl = document.createElement('div');
    stickEl.className = 'tc-stick';
    joystickEl.appendChild(stickEl);
    joystickZone.appendChild(joystickEl);

    const lookZone = document.createElement('div');
    lookZone.className = 'tc-look-zone';

    container.appendChild(joystickZone);
    container.appendChild(lookZone);

    const specs: Array<[cls: string, label: string]> = [
      ['tc-btn-fire', 'FIRE'],
      ['tc-btn-fire2', 'fire'],
      ['tc-btn-ads', 'ADS'],
      ['tc-btn-jump', 'JMP'],
      ['tc-btn-crouch', 'CR'],
      ['tc-btn-reload', 'RLD'],
      ['tc-btn-swap', 'SWP'],
      ['tc-btn-lethal', 'LTH'],
      ['tc-btn-tactical', 'TAC'],
      ['tc-btn-melee', 'MLE'],
      ['tc-btn-score', 'TAB'],
      ['tc-btn-menu', 'MENU'],
    ];
    for (const [cls, label] of specs) {
      const el = document.createElement('div');
      el.className = `tc-btn ${cls}`;
      el.textContent = label;
      container.appendChild(el);
      this.buttonEls.set(cls, el);
    }

    this.root.appendChild(container);
    this.container = container;
    this.joystickZone = joystickZone;
    this.lookZone = lookZone;
    this.joystickEl = joystickEl;
    this.stickEl = stickEl;
    this.applyOpacity();
  }

  private applyOpacity(): void {
    this.container.style.opacity = String(this.settings.touchOpacity);
  }

  show(): void {
    this.visible = true;
    this.container.hidden = false;
    this.applyOpacity();
  }

  hide(): void {
    this.visible = false;
    this.container.hidden = true;
    this.resetTransientState();
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.container.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    this.container.addEventListener('pointermove', this.onPointerMove, { passive: false });
    this.container.addEventListener('pointerup', this.onPointerUp, { passive: false });
    this.container.addEventListener('pointercancel', this.onPointerUp, { passive: false });
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.container.removeEventListener('pointerdown', this.onPointerDown);
    this.container.removeEventListener('pointermove', this.onPointerMove);
    this.container.removeEventListener('pointerup', this.onPointerUp);
    this.container.removeEventListener('pointercancel', this.onPointerUp);
    this.resetTransientState();
  }

  private resetTransientState(): void {
    this.joystick = null;
    this.lookPointers.clear();
    this.buttonPointers.clear();
    this.crouchPointerId = null;
    this.heldBtnBits = 0;
    this.moveX = 0;
    this.moveY = 0;
    this.joystickEl.style.display = 'none';
    for (const el of this.buttonEls.values()) el.classList.remove('tc-active');
  }

  get scoreboardHeld(): boolean {
    return this.scoreboardHeldFlag;
  }

  private handlePointerDown(e: PointerEvent): void {
    e.preventDefault();
    const target = e.target as HTMLElement;
    const btnEl = target.closest('.tc-btn') as HTMLElement | null;
    if (btnEl) {
      const handledAsButtonOnly = this.handleButtonDown(btnEl, e.pointerId);
      if (handledAsButtonOnly) return;
      // Fire button also feeds look-drag from the same finger.
      this.lookPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      return;
    }
    if (e.clientX < window.innerWidth * JOYSTICK_ZONE_FRACTION) {
      this.startJoystick(e);
    } else {
      this.lookPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
  }

  /** Returns true if this press is button-only (should not also drive look-drag). */
  private handleButtonDown(btnEl: HTMLElement, pointerId: number): boolean {
    const cls = [...btnEl.classList].find((c) => c !== 'tc-btn' && c !== 'tc-active');
    if (!cls) return true;
    btnEl.classList.add('tc-active');
    this.buttonPointers.set(pointerId, cls);

    if (cls === 'tc-btn-ads') {
      this.adsToggled = !this.adsToggled;
      return true;
    }
    if (cls === 'tc-btn-crouch') {
      this.crouchPointerId = pointerId;
      this.crouchDownAt = performance.now();
      return true;
    }
    if (cls === 'tc-btn-swap') {
      this.currentSlot = this.currentSlot === SLOT_PRIMARY ? SLOT_SECONDARY : SLOT_PRIMARY;
      this.pendingSlot = this.currentSlot;
      return true;
    }
    if (cls === 'tc-btn-score') {
      this.scoreboardHeldFlag = true;
      return true;
    }
    if (cls === 'tc-btn-menu') {
      this.menuEdge = true;
      this.callbacks.onMenu?.();
      return true;
    }
    const bit = HOLD_BIT[cls];
    if (bit !== undefined) {
      this.heldBtnBits |= bit;
      if (cls === 'tc-btn-fire' && this.settings.vibrate && typeof navigator.vibrate === 'function') {
        navigator.vibrate(8);
      }
      // Fire (not fire2) also drives look-drag from the same finger; caller re-registers it.
      return cls !== 'tc-btn-fire';
    }
    return true;
  }

  /** Current desired weapon slot, toggled by the swap button (persists across taps). */
  private currentSlot = SLOT_PRIMARY;

  private startJoystick(e: PointerEvent): void {
    if (this.joystick) return; // one joystick finger at a time
    const radius = JOYSTICK_BASE_RADIUS * this.settings.touchScale;
    this.joystick = {
      pointerId: e.pointerId,
      baseX: e.clientX,
      baseY: e.clientY,
      radius,
      sprintHoldStart: null,
      flickTimestamps: [],
      wasLow: true,
    };
    this.joystickEl.style.display = 'block';
    this.joystickEl.style.left = `${e.clientX}px`;
    this.joystickEl.style.top = `${e.clientY}px`;
    this.stickEl.style.transform = 'translate(0px, 0px)';
  }

  private handlePointerMove(e: PointerEvent): void {
    if (this.joystick && e.pointerId === this.joystick.pointerId) {
      this.updateJoystick(e);
      return;
    }
    const look = this.lookPointers.get(e.pointerId);
    if (look) {
      this.lookDX += e.clientX - look.x;
      this.lookDY += e.clientY - look.y;
      look.x = e.clientX;
      look.y = e.clientY;
    }
  }

  private updateJoystick(e: PointerEvent): void {
    const j = this.joystick;
    if (!j) return;
    const dx = e.clientX - j.baseX;
    const dy = e.clientY - j.baseY;
    const dist = Math.hypot(dx, dy);
    const clamped = Math.min(dist, j.radius);
    const nx = dist > 0 ? dx / dist : 0;
    const ny = dist > 0 ? dy / dist : 0;
    const magnitude = clamped / j.radius;
    this.moveX = nx * magnitude;
    this.moveY = -ny * magnitude; // screen-down is negative forward

    this.stickEl.style.transform = `translate(${nx * clamped}px, ${ny * clamped}px)`;

    // Sustained full push -> auto-sprint.
    const now = performance.now();
    if (magnitude > AUTOSPRINT_MAGNITUDE) {
      if (j.sprintHoldStart === null) j.sprintHoldStart = now;
    } else {
      j.sprintHoldStart = null;
    }

    // Quick double upward flick -> tac-sprint pulse. A "flick" is a transition
    // from a low (<0.3) to high (>=FLICK_MAGNITUDE) upward magnitude; two such
    // transitions inside FLICK_WINDOW_MS arm one tac-sprint pulse.
    const upMagnitude = ny < 0 ? -ny * magnitude : 0;
    if (j.wasLow && upMagnitude >= FLICK_MAGNITUDE) {
      j.flickTimestamps.push(now);
      j.flickTimestamps = j.flickTimestamps.filter((t) => now - t <= FLICK_WINDOW_MS);
      if (j.flickTimestamps.length >= 2) {
        this.tacSprintPulse = true;
        j.flickTimestamps = [];
      }
    }
    j.wasLow = upMagnitude < 0.3;
  }

  private handlePointerUpOrCancel(e: PointerEvent): void {
    if (this.joystick && e.pointerId === this.joystick.pointerId) {
      this.joystick = null;
      this.moveX = 0;
      this.moveY = 0;
      this.joystickEl.style.display = 'none';
      return;
    }
    this.lookPointers.delete(e.pointerId);

    const cls = this.buttonPointers.get(e.pointerId);
    if (cls) {
      this.buttonPointers.delete(e.pointerId);
      this.buttonEls.get(cls)?.classList.remove('tc-active');
      const bit = HOLD_BIT[cls];
      if (bit !== undefined) this.heldBtnBits &= ~bit;
      if (cls === 'tc-btn-score') this.scoreboardHeldFlag = false;
      if (cls === 'tc-btn-crouch' && this.crouchPointerId === e.pointerId) this.crouchPointerId = null;
    }
  }

  consume(): TouchConsumeResult {
    let buttons = this.heldBtnBits;
    if (this.adsToggled) buttons |= BTN_ADS;

    if (this.joystick) {
      if (this.joystick.sprintHoldStart !== null && performance.now() - this.joystick.sprintHoldStart >= AUTOSPRINT_HOLD_S * 1000) {
        buttons |= BTN_SPRINT;
      }
    }
    if (this.tacSprintPulse) {
      buttons |= BTN_SPRINT | BTN_TACSPRINT;
      this.tacSprintPulse = false;
    }

    if (this.crouchPointerId !== null) {
      const held = performance.now() - this.crouchDownAt;
      buttons |= held >= PRONE_HOLD_MS ? BTN_PRONE : BTN_CROUCH;
    }

    const result: TouchConsumeResult = {
      moveX: this.moveX,
      moveY: this.moveY,
      lookDX: this.lookDX,
      lookDY: this.lookDY,
      buttons,
      weaponSlot: this.pendingSlot,
      scoreboardHeld: this.scoreboardHeldFlag,
      menuPressed: this.menuEdge,
    };
    this.lookDX = 0;
    this.lookDY = 0;
    this.pendingSlot = -1;
    this.menuEdge = false;
    return result;
  }
}
