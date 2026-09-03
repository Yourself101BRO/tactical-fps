// First-person camera rig: positions and orients the main render camera from
// the local player's authoritative/predicted state, and layers on every
// cosmetic camera effect from plan §4 (FOV kicks, slide roll, landing dip,
// view punch, screen shake, mount lean). Pure presentation — it never writes
// back into PlayerState.

import * as THREE from 'three';
import type { PlayerState, Vec3 } from '../../shared/types.ts';
import { damp, vec3, yawPitchToDir } from '../../shared/math.ts';
import { eyeHeight } from '../../shared/movement.ts';
import { WEAPONS } from '../../shared/weapons.ts';
import {
  FOV_SPRINT_KICK,
  FOV_TACSPRINT_KICK,
  LANDING_SLOW_TIME,
  MOUNT_LEAN,
  MOVE_MANTLE,
  MOVE_SLIDE,
  MOVE_SPRINT,
  MOVE_TACSPRINT,
  SLIDE_CAMERA_HEIGHT,
  SLIDE_CAMERA_ROLL_DEG,
} from '../../shared/constants.ts';

const DEG2RAD = Math.PI / 180;

/** Exponential "spring" rate (Hz) for the view-punch pitch/yaw kick returning to zero. */
const PUNCH_RETURN_HZ = 12;
/** Exponential rate for the handheld screen-shake amplitude decaying to zero. */
const SHAKE_DECAY_HZ = 6;
/** Small vertical arc added mid-mantle so the camera reads as climbing rather than teleporting. */
const MANTLE_ARC_HEIGHT = 0.12;

function easeOutCubic(t: number): number {
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

/**
 * Owns the main three.js PerspectiveCamera used for world rendering (not the
 * separate viewmodel camera — see viewmodel.ts). One instance per client.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private baseFov: number;

  // View punch (recoil kick applied to the look direction, e.g. from damage
  // flinch or explosions near the player), a spring returning to zero.
  private punchPitch = 0;
  private punchYaw = 0;

  // Handheld shake, an amplitude that decays and drives a per-frame random offset.
  private shakeAmt = 0;
  private shakeTime = 0;

  private readonly tmpPos = vec3();

  constructor(camera: THREE.PerspectiveCamera, baseFov: number) {
    this.camera = camera;
    this.baseFov = baseFov;
    this.camera.rotation.order = 'YXZ';
  }

  setBaseFov(fov: number): void {
    this.baseFov = fov;
  }

  /** Adds an instantaneous kick to the view direction (radians); e.g. damage flinch. */
  punch(pitchRad: number, yawRad: number): void {
    this.punchPitch += pitchRad;
    this.punchYaw += yawRad;
  }

  /** Adds to the current handheld-shake amplitude (0..1-ish); e.g. nearby explosions. */
  shake(amount: number): void {
    this.shakeAmt = Math.max(this.shakeAmt, amount);
  }

  /**
   * Positions and orients the camera for this frame.
   * @param local the recipient's own predicted/authoritative PlayerState
   * @param renderOffset small reconciliation smoothing offset (world space), added to position
   */
  update(local: PlayerState, renderOffset: Vec3, dt: number): void {
    // --- springs / decays -------------------------------------------------
    this.punchPitch = damp(this.punchPitch, 0, PUNCH_RETURN_HZ, dt);
    this.punchYaw = damp(this.punchYaw, 0, PUNCH_RETURN_HZ, dt);
    this.shakeAmt = damp(this.shakeAmt, 0, SHAKE_DECAY_HZ, dt);
    this.shakeTime += dt;

    // --- position -----------------------------------------------------
    const pos = this.tmpPos;
    if (local.moveState === MOVE_MANTLE) {
      // Locked cubic path from the pre-mantle feet position to the post-mantle
      // ledge, independent of local.pos (which snaps once the mantle resolves).
      const t = local.mantleDuration > 0 ? clamp01(local.mantleT / local.mantleDuration) : 1;
      const te = t * t * (3 - 2 * t); // smoothstep ease
      pos.x = lerp(local.mantleFrom.x, local.mantleTo.x, te);
      pos.y = lerp(local.mantleFrom.y, local.mantleTo.y, te) + Math.sin(t * Math.PI) * MANTLE_ARC_HEIGHT;
      pos.z = lerp(local.mantleFrom.z, local.mantleTo.z, te);
      pos.y += eyeHeight(local);
    } else {
      pos.x = local.pos.x;
      pos.y = local.pos.y;
      pos.z = local.pos.z;
      if (local.moveState === MOVE_SLIDE) {
        pos.y += SLIDE_CAMERA_HEIGHT;
      } else {
        pos.y += eyeHeight(local);
      }
    }

    // Landing dip: a brief downward bob that eases out over LANDING_SLOW_TIME.
    if (local.landingT > 0) {
      const ratio = clamp01(local.landingT / LANDING_SLOW_TIME);
      pos.y -= 0.03 * Math.sin(Math.PI * ratio);
    }

    // Mount lean: slide along the mounted edge instead of moving freely.
    if (local.mounted) {
      const leanRatio = MOUNT_LEAN !== 0 ? local.mountLean / MOUNT_LEAN : 0;
      // Edge direction is the mount normal rotated 90° about Y.
      const edgeX = -local.mountNZ;
      const edgeZ = local.mountNX;
      pos.x += edgeX * leanRatio * MOUNT_LEAN;
      pos.z += edgeZ * leanRatio * MOUNT_LEAN;
    }

    pos.x += renderOffset.x;
    pos.y += renderOffset.y;
    pos.z += renderOffset.z;

    // Handheld shake: small random world-space jitter, amplitude-scaled.
    if (this.shakeAmt > 1e-4) {
      const n1 = pseudoNoise(this.shakeTime * 37.1);
      const n2 = pseudoNoise(this.shakeTime * 41.7 + 12.3);
      const n3 = pseudoNoise(this.shakeTime * 29.3 + 5.1);
      pos.x += n1 * this.shakeAmt * 0.05;
      pos.y += n2 * this.shakeAmt * 0.05;
      pos.z += n3 * this.shakeAmt * 0.05;
    }

    this.camera.position.set(pos.x, pos.y, pos.z);

    // --- orientation --------------------------------------------------
    let roll = 0;
    if (local.moveState === MOVE_SLIDE) {
      // Roll toward the slide's lateral direction (sign of the strafe component).
      const sign = local.slideDirX >= 0 ? 1 : -1;
      roll = sign * SLIDE_CAMERA_ROLL_DEG * DEG2RAD;
    }

    this.camera.rotation.set(
      local.pitch + this.punchPitch,
      local.yaw + this.punchYaw,
      roll,
      'YXZ',
    );

    // --- FOV ------------------------------------------------------------
    let kickedFov = this.baseFov;
    if (local.moveState === MOVE_TACSPRINT) kickedFov += FOV_TACSPRINT_KICK;
    else if (local.moveState === MOVE_SPRINT) kickedFov += FOV_SPRINT_KICK;

    const weaponId = local.slots[local.activeSlot]?.weapon;
    const def = weaponId !== undefined ? WEAPONS[weaponId] : undefined;
    const adsFov = def ? def.adsFov : this.baseFov;
    const adsE = easeOutCubic(clamp01(local.adsT));
    const fov = lerp(kickedFov, adsFov, adsE);
    if (Math.abs(this.camera.fov - fov) > 1e-3) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** World-space view direction, written into `out`. */
  getViewDirection(out: Vec3): Vec3 {
    return yawPitchToDir(this.camera.rotation.y, this.camera.rotation.x, out);
  }

  /** World-space camera position, written into `out`. */
  getPosition(out: Vec3): Vec3 {
    out.x = this.camera.position.x;
    out.y = this.camera.position.y;
    out.z = this.camera.position.z;
    return out;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Cheap deterministic pseudo-noise in [-1, 1] for shake jitter (no allocation, no Math.random dependency). */
function pseudoNoise(x: number): number {
  const s = Math.sin(x * 12.9898) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}
