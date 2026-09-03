// Top-level input device: picks desktop vs touch, owns yaw/pitch accumulation
// (mouse/touch/gyro all feed the same accumulator), and builds InputCmd. DOM
// orchestration only — no shared/sim state, no three.js. See plan §3 (60 Hz
// cadence — sampling itself is the integrator's job, this class just needs to
// be safely callable at that rate) and §7 (sensitivity/ADS/mount rules).

import type { Settings } from '../settings.ts';
import type { InputCmd } from '../../shared/types.ts';
import { createInputCmd } from '../../shared/types.ts';
import { clamp, wrapAngle } from '../../shared/math.ts';
import {
  ADS_SENS_MULT,
  ADS_SENS_MULT_SNIPER,
  BTN_ADS,
  BTN_MOUNT,
  BTN_SPRINT,
  SLOT_PRIMARY,
  SLOT_SECONDARY,
} from '../../shared/constants.ts';
import { KeyboardMouse } from './keyboard-mouse.ts';
import { TouchControls, isTouchDevice } from './touch.ts';
import { Gyro } from './gyro.ts';

/** rad/px at sensitivity=1, hip-fire, mouse. */
const DESKTOP_RAD_PER_PX = 0.0022;
/** deg/px at sensitivity=1, hip-fire, touch drag-look. */
const TOUCH_DEG_PER_PX = 0.25;
const DEG2RAD = Math.PI / 180;
const MAX_PITCH = 89 * DEG2RAD;

export type InputMode = 'desktop' | 'touch';

/**
 * Facade over the active input device(s). Consumers call sample() once per
 * 60 Hz input tick to get a fresh InputCmd; yaw/pitch, scoreboardHeld and
 * menuPressed may be polled at any rate (e.g. every render frame).
 */
export class InputManager {
  readonly mode: InputMode;
  private readonly settings: Settings;

  private readonly keyboardMouse: KeyboardMouse;
  private readonly touch: TouchControls;
  private readonly gyro = new Gyro();
  private gyroActive = false;

  private enabled = true;
  private attached = false;

  yaw = 0;
  pitch = 0;
  private activeSlot = SLOT_PRIMARY;

  /** Set by the owner (UI); invoked synchronously on Escape / the touch menu button. */
  onMenu: () => void = () => {};

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement, settings: Settings) {
    this.settings = settings;
    this.mode = isTouchDevice() ? 'touch' : 'desktop';
    this.keyboardMouse = new KeyboardMouse(canvas, settings, { onMenu: () => this.onMenu() });
    this.touch = new TouchControls(uiRoot, settings, { onMenu: () => this.onMenu() });
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    if (this.mode === 'desktop') {
      this.keyboardMouse.attach();
    } else {
      this.touch.attach();
      this.touch.show();
    }
    if (this.settings.gyro && this.mode === 'touch') void this.enableGyro();
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.keyboardMouse.detach();
    this.touch.detach();
    this.touch.hide();
    this.gyro.stop();
    this.gyroActive = false;
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
  }

  /**
   * Requests the iOS motion-permission gesture (no-op elsewhere) and starts the
   * gyro if granted. Call from a user-gesture handler (the plan's "permission
   * button"). Safe to call multiple times.
   */
  async enableGyro(): Promise<boolean> {
    const granted = await this.gyro.requestPermission();
    if (granted) {
      this.gyro.start();
      this.gyroActive = true;
    }
    return granted;
  }

  disableGyro(): void {
    this.gyro.stop();
    this.gyroActive = false;
  }

  requestPointerLock(): void {
    if (this.mode === 'desktop') this.keyboardMouse.requestPointerLock();
  }

  get pointerLocked(): boolean {
    return this.mode === 'desktop' && this.keyboardMouse.locked;
  }

  /** Live: true while the scoreboard key/button is held. */
  get scoreboardHeld(): boolean {
    return this.mode === 'desktop' ? this.keyboardMouse.scoreboardHeld : this.touch.scoreboardHeld;
  }

  /** Edge: true once after a menu key/button press; polling this getter drains it. */
  get menuPressed(): boolean {
    if (this.mode === 'desktop') return this.keyboardMouse.uiActions.menuPressed;
    // TouchControls.consume() also drains its own menuPressed edge; polling here
    // is a convenience for UI code that isn't otherwise calling consume().
    return false;
  }

  /** Snap the camera (respawn, spectate cut) without touching accumulated deltas. */
  setYawPitch(yaw: number, pitch: number): void {
    this.yaw = wrapAngle(yaw);
    this.pitch = clamp(pitch, -MAX_PITCH, MAX_PITCH);
  }

  private sensitivityMult(adsActive: boolean, sniperActive: boolean): number {
    if (!adsActive) return 1;
    const base = ADS_SENS_MULT * this.settings.adsSensMult;
    return sniperActive ? base * (ADS_SENS_MULT_SNIPER / ADS_SENS_MULT) : base;
  }

  private applyLook(dxPx: number, dyPx: number, radPerPx: number, adsActive: boolean, sniperActive: boolean): void {
    if (dxPx === 0 && dyPx === 0) return;
    const rate = radPerPx * this.settings.sensitivity * this.sensitivityMult(adsActive, sniperActive);
    // yaw increases turning left (three.js convention); moving the input right
    // (positive dx) must turn the view right, so yaw decreases.
    this.yaw = wrapAngle(this.yaw - dxPx * rate);
    // pitch is up-positive; moving the input down (positive dy) looks down.
    const dir = this.settings.invertY ? -1 : 1;
    this.pitch = clamp(this.pitch - dyPx * rate * dir, -MAX_PITCH, MAX_PITCH);
  }

  private applyGyro(adsActive: boolean, sniperActive: boolean): void {
    if (!this.gyroActive) return;
    const g = this.gyro.consume();
    if (g.dYaw === 0 && g.dPitch === 0) return;
    const mult = this.sensitivityMult(adsActive, sniperActive) * this.settings.sensitivity;
    this.yaw = wrapAngle(this.yaw + g.dYaw * mult);
    const dir = this.settings.invertY ? -1 : 1;
    this.pitch = clamp(this.pitch + g.dPitch * mult * dir, -MAX_PITCH, MAX_PITCH);
  }

  /**
   * Builds one InputCmd from the active device. `adsActive`/`sniperActive`
   * describe the player's *current confirmed* aim state (from weapon/prediction
   * state, not from the raw ADS button) so mouse/touch sensitivity ramps with
   * actual scope zoom rather than jumping the instant the button is pressed.
   */
  sample(seq: number, tick: number, adsActive: boolean, sniperActive: boolean): InputCmd {
    const cmd = createInputCmd();
    cmd.seq = seq;
    cmd.tick = tick;

    if (!this.enabled) {
      cmd.yaw = this.yaw;
      cmd.pitch = this.pitch;
      cmd.weaponSlot = this.activeSlot;
      return cmd;
    }

    let buttons = 0;
    if (this.mode === 'desktop') {
      const d = this.keyboardMouse.consume();
      cmd.moveX = d.moveX;
      cmd.moveY = d.moveY;
      buttons = d.buttons;
      if (d.weaponSlot !== -1) this.activeSlot = d.weaponSlot;
      else if (d.scroll !== 0) this.activeSlot = this.activeSlot === SLOT_PRIMARY ? SLOT_SECONDARY : SLOT_PRIMARY;
      this.applyLook(d.dx, d.dy, DESKTOP_RAD_PER_PX, adsActive, sniperActive);
    } else {
      const d = this.touch.consume();
      cmd.moveX = d.moveX;
      cmd.moveY = d.moveY;
      buttons = d.buttons;
      if (d.weaponSlot !== -1) this.activeSlot = d.weaponSlot;
      if (this.settings.autoSprint && (d.moveX !== 0 || d.moveY !== 0)) buttons |= BTN_SPRINT;
      this.applyLook(d.lookDX, d.lookDY, TOUCH_DEG_PER_PX * DEG2RAD, adsActive, sniperActive);
    }

    this.applyGyro(adsActive, sniperActive);

    if (this.settings.autoMount && (buttons & BTN_ADS) !== 0) buttons |= BTN_MOUNT;

    cmd.yaw = this.yaw;
    cmd.pitch = this.pitch;
    cmd.buttons = buttons;
    cmd.weaponSlot = this.activeSlot;
    return cmd;
  }
}
