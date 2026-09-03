// Desktop keyboard + mouse input device. DOM-only (no shared/sim, no three.js);
// accumulates raw deltas/held state from browser events and hands InputManager
// a drained snapshot on each consume(). See plan §7 (desktop bindings).

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
  BTN_INTERACT,
  SLOT_PRIMARY,
  SLOT_SECONDARY,
} from '../../shared/constants.ts';

/** Two Shift presses inside this window arm tactical sprint. Input feel, not a sim tunable. */
const DOUBLE_TAP_SPRINT_MS = 300;

export interface KMConsumeResult {
  /** Mouse delta in pixels accumulated since the last consume() (movementX/Y under pointer lock). */
  dx: number;
  dy: number;
  /** Strafe/forward axes in [-1, 1] from WASD. */
  moveX: number;
  moveY: number;
  /** BTN_* bitmask currently held. */
  buttons: number;
  /** SLOT_PRIMARY/SLOT_SECONDARY on an explicit 1/2 keypress this interval, else -1. */
  weaponSlot: number;
  /** Net mouse-wheel swap direction since the last consume. */
  scroll: -1 | 0 | 1;
}

export interface KMUiActions {
  /** Live: true while Tab is held. */
  scoreboardHeld: boolean;
  /** Edge: true exactly once per Escape press; reading this property clears it. */
  menuPressed: boolean;
}

export interface KeyboardMouseCallbacks {
  /** Fired synchronously on Escape keydown, in addition to the polled uiActions.menuPressed. */
  onMenu?: () => void;
}

/**
 * Keyboard + mouse device backend. Owns its own DOM listeners; attach()/detach()
 * are idempotent. All game-relevant state is drained by consume(); scoreboardHeld
 * and menuPressed are read through the separate `uiActions` getter so UI code can
 * poll them independently of the 60 Hz input-sampling cadence.
 */
export class KeyboardMouse {
  private readonly canvas: HTMLCanvasElement;
  private readonly settings: Settings;
  private readonly callbacks: KeyboardMouseCallbacks;

  private attached = false;
  locked = false;
  onLockChange: (locked: boolean) => void = () => {};

  private readonly keys = new Set<string>();
  private accDx = 0;
  private accDy = 0;
  private scrollDir: -1 | 0 | 1 = 0;
  private pendingSlot = -1;
  private menuEdge = false;

  // Double-tap sprint tracking.
  private lastShiftDownAt = -Infinity;
  private shiftHeld = false;
  private tacSprintArmed = false;

  // ADS hold/toggle.
  private adsPhysicallyHeld = false;
  private adsToggleLatch = false;

  // Bound handlers (stored so detach() can remove exactly what attach() added).
  private readonly onKeyDown = (e: KeyboardEvent): void => this.handleKeyDown(e);
  private readonly onKeyUp = (e: KeyboardEvent): void => this.handleKeyUp(e);
  private readonly onMouseDown = (e: MouseEvent): void => this.handleMouseDown(e);
  private readonly onMouseUp = (e: MouseEvent): void => this.handleMouseUp(e);
  private readonly onMouseMove = (e: MouseEvent): void => this.handleMouseMove(e);
  private readonly onWheel = (e: WheelEvent): void => this.handleWheel(e);
  private readonly onContextMenu = (e: Event): void => e.preventDefault();
  private readonly onPointerLockChange = (): void => this.handlePointerLockChange();
  private readonly onCanvasClick = (): void => this.requestPointerLock();
  private readonly onBlur = (): void => this.releaseAllHeldState();

  constructor(canvas: HTMLCanvasElement, settings: Settings, callbacks: KeyboardMouseCallbacks = {}) {
    this.canvas = canvas;
    this.settings = settings;
    this.callbacks = callbacks;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    this.canvas.addEventListener('click', this.onCanvasClick);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('click', this.onCanvasClick);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.releaseAllHeldState();
  }

  requestPointerLock(): void {
    if (document.pointerLockElement !== this.canvas) {
      // Newer browsers return a promise; embedded/iframe contexts reject it. Never let that surface.
      const result = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (result && typeof result.catch === 'function') result.catch(() => {});
    }
  }

  private handlePointerLockChange(): void {
    this.locked = document.pointerLockElement === this.canvas;
    this.onLockChange(this.locked);
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
    // Auto-repeat never changes held/edge state; only the initial press matters.
    if (e.repeat) return;
    this.keys.add(e.code);
    switch (e.code) {
      case 'ShiftLeft':
      case 'ShiftRight': {
        const now = performance.now();
        if (now - this.lastShiftDownAt < DOUBLE_TAP_SPRINT_MS) this.tacSprintArmed = true;
        this.lastShiftDownAt = now;
        this.shiftHeld = true;
        break;
      }
      case 'Digit1':
        this.pendingSlot = SLOT_PRIMARY;
        break;
      case 'Digit2':
        this.pendingSlot = SLOT_SECONDARY;
        break;
      case 'Escape':
        this.menuEdge = true;
        this.callbacks.onMenu?.();
        break;
      default:
        break;
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code);
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      this.shiftHeld = false;
      this.tacSprintArmed = false;
    }
  }

  private handleMouseDown(e: MouseEvent): void {
    if (e.button === 0) {
      this.keys.add('Mouse0');
    } else if (e.button === 2) {
      this.adsPhysicallyHeld = true;
      if (this.settings.adsToggle) this.adsToggleLatch = !this.adsToggleLatch;
    }
  }

  private handleMouseUp(e: MouseEvent): void {
    if (e.button === 0) this.keys.delete('Mouse0');
    else if (e.button === 2) this.adsPhysicallyHeld = false;
  }

  private handleMouseMove(e: MouseEvent): void {
    this.accDx += e.movementX;
    this.accDy += e.movementY;
  }

  private handleWheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.deltaY !== 0) this.scrollDir = e.deltaY > 0 ? 1 : -1;
  }

  /** Window blur (alt-tab, etc.) — drop all held state so nothing sticks. */
  private releaseAllHeldState(): void {
    this.keys.clear();
    this.shiftHeld = false;
    this.tacSprintArmed = false;
    this.adsPhysicallyHeld = false;
  }

  /** Live UI-facing state; menuPressed is an edge flag cleared on read. */
  get uiActions(): KMUiActions {
    const menuPressed = this.menuEdge;
    this.menuEdge = false;
    return { scoreboardHeld: this.keys.has('Tab'), menuPressed };
  }

  /** Live scoreboard-held state without draining the menu edge (used by InputManager polling). */
  get scoreboardHeld(): boolean {
    return this.keys.has('Tab');
  }

  consume(): KMConsumeResult {
    const moveX = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    const moveY = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);

    let buttons = 0;
    if (this.keys.has('Space')) buttons |= BTN_JUMP;
    if (this.keys.has('KeyC')) buttons |= BTN_CROUCH;
    if (this.keys.has('KeyZ')) buttons |= BTN_PRONE;
    if (this.keys.has('Mouse0')) buttons |= BTN_FIRE;
    if (this.keys.has('KeyR')) buttons |= BTN_RELOAD;
    if (this.keys.has('KeyG')) buttons |= BTN_LETHAL;
    if (this.keys.has('KeyT')) buttons |= BTN_TACTICAL;
    if (this.keys.has('KeyV')) buttons |= BTN_MELEE;
    if (this.keys.has('KeyF')) buttons |= BTN_INTERACT;
    if (this.shiftHeld) {
      buttons |= BTN_SPRINT;
      if (this.tacSprintArmed) buttons |= BTN_TACSPRINT;
    }
    const adsOn = this.settings.adsToggle ? this.adsToggleLatch : this.adsPhysicallyHeld;
    if (adsOn) buttons |= BTN_ADS;

    const result: KMConsumeResult = {
      dx: this.accDx,
      dy: this.accDy,
      moveX,
      moveY,
      buttons,
      weaponSlot: this.pendingSlot,
      scroll: this.scrollDir,
    };
    this.accDx = 0;
    this.accDy = 0;
    this.pendingSlot = -1;
    this.scrollDir = 0;
    return result;
  }
}
