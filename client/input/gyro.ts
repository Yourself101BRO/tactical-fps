// Optional gyroscope look input (mobile). DOM-only, gated behind an explicit
// user gesture on iOS (DeviceOrientationEvent.requestPermission). See plan §7
// ("optional gyro behind a permission button").
//
// NOTE on landscape mapping: the game is landscape-only. `devicemotion`'s
// rotationRate is reported in the device's own (portrait) frame regardless of
// screen orientation, so this module remaps axes using screen.orientation.angle.
// The exact sign/axis mapping below is a best-effort default (like the plan's
// own PMREM guard, it explicitly needs real-device verification/tuning —
// desktop/simulator testing cannot confirm it feels right).

const DEG2RAD = Math.PI / 180;

export interface GyroDelta {
  /** Radians, positive = turning left (matches InputCmd.yaw convention). */
  dYaw: number;
  /** Radians, positive = looking up. */
  dPitch: number;
}

/** Minimal shape for the non-standard iOS 13+ permission gate; not in lib.dom. */
interface DeviceOrientationEventCtorIOS {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

export class Gyro {
  private active = false;
  private lastEventAt = -1;
  private accYaw = 0;
  private accPitch = 0;

  private readonly onMotion = (e: DeviceMotionEvent): void => this.handleMotion(e);

  /**
   * Requests the iOS 13+ motion-permission gesture if needed. Must be called
   * from within a user-gesture handler (button click). Resolves true when
   * motion events are (or already were) permitted, false when the user denies
   * or the device errors. On platforms without the gate (Android, desktop)
   * this resolves true immediately.
   */
  async requestPermission(): Promise<boolean> {
    const ctor = (typeof DeviceOrientationEvent !== 'undefined' ? DeviceOrientationEvent : undefined) as
      | (DeviceOrientationEventCtorIOS & typeof DeviceOrientationEvent)
      | undefined;
    if (!ctor || typeof ctor.requestPermission !== 'function') return true;
    try {
      const result = await ctor.requestPermission();
      return result === 'granted';
    } catch {
      return false;
    }
  }

  start(): void {
    if (this.active) return;
    if (typeof window === 'undefined' || !('DeviceMotionEvent' in window)) return;
    this.active = true;
    this.lastEventAt = -1;
    this.accYaw = 0;
    this.accPitch = 0;
    window.addEventListener('devicemotion', this.onMotion);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    window.removeEventListener('devicemotion', this.onMotion);
  }

  private currentLandscapeAngle(): number {
    const orientation = (screen as unknown as { orientation?: { angle: number } }).orientation;
    if (orientation && typeof orientation.angle === 'number') return orientation.angle;
    const legacy = (window as unknown as { orientation?: number }).orientation;
    return typeof legacy === 'number' ? legacy : 0;
  }

  private handleMotion(e: DeviceMotionEvent): void {
    const rate = e.rotationRate;
    if (!rate) return;
    const now = performance.now();
    if (this.lastEventAt < 0) {
      this.lastEventAt = now;
      return;
    }
    const dt = Math.min(0.1, (now - this.lastEventAt) / 1000);
    this.lastEventAt = now;

    const alpha = rate.alpha ?? 0; // deg/s, rotation around Z
    const beta = rate.beta ?? 0; // deg/s, rotation around X
    const gamma = rate.gamma ?? 0; // deg/s, rotation around Y

    const angle = this.currentLandscapeAngle();
    let yawRateDeg: number;
    let pitchRateDeg: number;
    if (angle === 90) {
      // landscape-primary: device rotated so its right edge points up.
      yawRateDeg = -beta;
      pitchRateDeg = gamma;
    } else if (angle === 270 || angle === -90) {
      // landscape-secondary.
      yawRateDeg = beta;
      pitchRateDeg = -gamma;
    } else {
      // Portrait fallback (shouldn't occur in the landscape-only game view).
      yawRateDeg = -gamma;
      pitchRateDeg = beta;
    }
    // `alpha` (compass heading rate) is intentionally unused: it drifts and
    // double-counts yaw already derived from beta/gamma above.
    void alpha;

    this.accYaw += yawRateDeg * DEG2RAD * dt;
    this.accPitch += pitchRateDeg * DEG2RAD * dt;
  }

  /** Drains and returns the accumulated look delta since the last consume(). */
  consume(): GyroDelta {
    const result: GyroDelta = { dYaw: this.accYaw, dPitch: this.accPitch };
    this.accYaw = 0;
    this.accPitch = 0;
    return result;
  }
}
