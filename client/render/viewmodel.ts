// First-person weapon viewmodel: procedural motion only (no baked animation
// clips exist for the weapon meshes). Renders into its own scene/camera
// (composited on top of the world by Renderer) so its FOV and near/far can
// differ from the world camera without z-fighting or clipping into geometry.
//
// All the numeric motion targets below (sway degrees/Hz, bob degrees/Hz,
// look-lag degrees/Hz, recoil kick distance/Hz, tac-sprint barrel-up degrees,
// reload/swap/melee/grenade pose shapes) come from plan §4's "Viewmodel
// motion (procedural)" list. They are purely cosmetic (they never feed back
// into PlayerState or the simulation), so — unlike weapon damage/timing
// numbers — they are kept local to this file rather than in
// shared/constants.ts, which is reserved for simulation-affecting tunables.

import * as THREE from 'three';
import type { GameAssets } from '../assets/loader.ts';
import type { MaterialLibrary } from './materials.ts';
import type { PlayerState, Vec3 } from '../../shared/types.ts';
import type { MovementEvents, WeaponEvents } from '../../shared/sim/types.ts';
import { WEAPONS, recoilAt, type WeaponDef } from '../../shared/weapons.ts';
import { damp } from '../../shared/math.ts';
import {
  LANDING_SLOW_TIME,
  MELEE_TIME,
  MOVE_SLIDE,
  MOVE_SPRINT,
  MOVE_TACSPRINT,
  SLIDE_CAMERA_ROLL_DEG,
  SWAP_TIME,
  WEAPON_SNIPER,
} from '../../shared/constants.ts';

const DEG = Math.PI / 180;

// --- idle sway (Lissajous) ---------------------------------------------
const SWAY_HIP_DEG = 0.4;
const SWAY_ADS_DEG = 0.15;
const SWAY_FREQ_X = 0.6; // Hz
const SWAY_FREQ_Y = 0.8; // Hz

// --- walk / sprint bob ---------------------------------------------------
const BOB_WALK_DEG = 0.5;
const BOB_WALK_HZ = 2.2;
const BOB_SPRINT_DEG = 1.2;
const BOB_SPRINT_HZ = 3.0;
const BOB_SPRINT_TILT_DEG = 6.0;
const BOB_BLEND_HZ = 10; // smooths the walk<->sprint bob-shape transition

// --- look-lag ---------------------------------------------------------
const LOOKLAG_MAX_DEG = 1.5;
const LOOKLAG_HZ = 8;
const LOOKLAG_GAIN = 4.0;

// --- per-shot recoil kick -------------------------------------------
const RECOIL_KICK_Z = 0.03; // metres, translated back toward the shooter
const RECOIL_KICK_ROT = 6 * DEG; // baseline rotational kick per shot
const RECOIL_RETURN_HZ = 12;

// --- tac-sprint high pose -------------------------------------------
const TACSPRINT_BARREL_UP_DEG = 35;
const TACSPRINT_RAISE_Y = 0.05;
const TACSPRINT_PULL_Z = 0.06;
const TACSPRINT_BLEND_HZ = 8;

// --- slide ---------------------------------------------------------------
const SLIDE_LOWER_M = 0.06;
const SLIDE_BLEND_HZ = 10;

// --- ADS ---------------------------------------------------------------
const ADS_FORWARD_EPS = 0.04; // keeps the sight just off the near plane instead of exactly at it
const HIP_POS: readonly [number, number, number] = [0.16, -0.17, -0.32];

// --- swap ---------------------------------------------------------------
const SWAP_DIP_M = 0.22;

// --- melee ---------------------------------------------------------------
const MELEE_SWING_DEG = 55;
const MELEE_SWING_FWD_M = 0.1;

// --- grenade ---------------------------------------------------------------
const GRENADE_PULL_LOWER_M = 0.14;
const GRENADE_PULL_TILT_DEG = 10;
const GRENADE_POSE_BLEND_HZ = 10;
const GRENADE_THROW_DURATION = 0.35;
const GRENADE_THROW_SWING_DEG = 70;

const MUZZLE_FLASH_SPRITE_DURATION = 0.04;
const MUZZLE_FLASH_LIGHT_DURATION = 0.05;
const MUZZLE_FLASH_LIGHT_INTENSITY = 6;

/** Keyframed reload pose curve, sampled by (1 - reloadT / reloadTotal). */
interface ReloadKeyframe {
  t: number;
  pos: readonly [number, number, number];
  rot: readonly [number, number, number];
}
const RELOAD_CURVE: readonly ReloadKeyframe[] = [
  { t: 0.0, pos: [0, 0, 0], rot: [0, 0, 0] },
  { t: 0.16, pos: [-0.015, -0.09, 0.05], rot: [22 * DEG, -4 * DEG, -14 * DEG] }, // drop + tilt
  { t: 0.45, pos: [-0.02, -0.11, 0.06], rot: [25 * DEG, 3 * DEG, -10 * DEG] }, // mag out
  { t: 0.68, pos: [-0.01, -0.1, 0.05], rot: [23 * DEG, -3 * DEG, -12 * DEG] }, // mag in
  { t: 0.85, pos: [-0.005, -0.04, 0.02], rot: [8 * DEG, 0, -4 * DEG] }, // charge
  { t: 1.0, pos: [0, 0, 0], rot: [0, 0, 0] },
];

/** Accumulator for this frame's pose offset (metres / radians). Reused across frames. */
interface Pose {
  px: number; py: number; pz: number;
  rx: number; ry: number; rz: number;
}
function resetPose(p: Pose): void {
  p.px = 0; p.py = 0; p.pz = 0;
  p.rx = 0; p.ry = 0; p.rz = 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function easeOutCubic(t: number): number {
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}
function angleDelta(cur: number, prev: number): number {
  let d = cur - prev;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Case-insensitive search by name suffix/substring, matching the loader's normalized empties. */
function findByName(root: THREE.Object3D, needle: string): THREE.Object3D | undefined {
  let found: THREE.Object3D | undefined;
  root.traverse((obj) => {
    if (!found && obj.name.toLowerCase().includes(needle)) found = obj;
  });
  return found;
}

/** Local-space offset of `node` from `root`'s origin (root must be at identity when called). */
function offsetFromRoot(root: THREE.Object3D, node: THREE.Object3D | undefined, scratch: THREE.Vector3): THREE.Vector3 | null {
  if (!node) return null;
  root.updateMatrixWorld(true);
  node.getWorldPosition(scratch);
  return scratch.clone();
}

function buildFallbackGun(def: WeaponDef, materials: MaterialLibrary): THREE.Group {
  const group = new THREE.Group();
  group.name = `fallback_${def.id}`;
  const len = Math.max(def.modelLength, 0.3);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, len), materials.gunmetal());
  body.position.set(0, 0, -len * 0.1);
  group.add(body);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.12, 0.05), materials.polymer());
  grip.position.set(0, -0.1, len * 0.18);
  grip.rotation.x = 0.35;
  group.add(grip);
  const muzzle = new THREE.Object3D();
  muzzle.name = 'Muzzle';
  muzzle.position.set(0, 0, -len * 0.6);
  group.add(muzzle);
  const gripEmpty = new THREE.Object3D();
  gripEmpty.name = 'Grip';
  gripEmpty.position.copy(grip.position);
  group.add(gripEmpty);
  return group;
}

/** Builds the 4-frame additive muzzle-flash sprite atlas once, shared by every trigger. */
function buildMuzzleFlashFrames(): THREE.CanvasTexture[] {
  const frames: THREE.CanvasTexture[] = [];
  for (let f = 0; f < 4; f++) {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    const cx = size / 2;
    const cy = size / 2;
    const coreR = size * (0.16 + f * 0.02);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    grad.addColorStop(0, 'rgba(255,255,240,1)');
    grad.addColorStop(0.4, 'rgba(255,200,80,0.9)');
    grad.addColorStop(1, 'rgba(255,120,20,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();
    // A handful of jagged spikes, rotated per frame, for a flicker feel.
    const spikes = 5;
    const rot = f * 0.6;
    ctx.strokeStyle = 'rgba(255,220,150,0.6)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < spikes; i++) {
      const a = rot + (i / spikes) * Math.PI * 2;
      const len2 = size * (0.35 + 0.15 * ((i + f) % 3));
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * len2, cy + Math.sin(a) * len2);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    frames.push(tex);
  }
  return frames;
}

export class Viewmodel {
  private readonly vmScene: THREE.Scene;
  private readonly vmCamera: THREE.PerspectiveCamera;
  private readonly assets: GameAssets;
  private readonly materials: MaterialLibrary;

  private readonly weaponRoot = new THREE.Group();
  private model: THREE.Object3D | null = null;
  private def: WeaponDef | null = null;
  private weaponId = -1;

  private muzzle: THREE.Object3D | undefined;
  private grip: THREE.Object3D | undefined;
  private sight: THREE.Object3D | undefined;

  /** ADS root offset (position only; orientation stays aligned to the camera). */
  private adsPos: [number, number, number] = [0, 0, 0];

  /** Procedural forearm + hand, reused across weapon swaps and just repositioned. */
  private readonly forearm: THREE.Mesh;
  private readonly hand: THREE.Mesh;

  private readonly shellSpawnPoint = new THREE.Object3D();

  private readonly flashSprite: THREE.Sprite;
  private readonly flashFrames: THREE.CanvasTexture[];
  private readonly flashLight: THREE.PointLight;
  private flashSpriteTimer = 0;
  private flashLightTimer = 0;

  // --- procedural state (all frame-to-frame scalars, no per-frame allocation) ---
  private swayTime = 0;
  private bobTime = 0;
  private bobBlend = 0; // 0 = walk-shaped bob, 1 = sprint-shaped bob
  private prevYaw = 0;
  private prevPitch = 0;
  private lagPitch = 0;
  private lagYaw = 0;
  private recoilPosZ = 0;
  private recoilRotX = 0;
  private recoilRotY = 0;
  private tacBlend = 0;
  private slideBlend = 0;
  private grenadeBlend = 0;
  private throwTimer = 0;
  private firstUpdate = true;

  private readonly pose: Pose = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 };
  private readonly scratchV3 = new THREE.Vector3();

  /** True once ADS is far enough in that the sniper model hides for a scope overlay. */
  scopeVisible = false;

  constructor(vmScene: THREE.Scene, vmCamera: THREE.PerspectiveCamera, assets: GameAssets, materials: MaterialLibrary) {
    this.vmScene = vmScene;
    this.vmCamera = vmCamera;
    this.assets = assets;
    this.materials = materials;

    this.weaponRoot.rotation.order = 'XYZ';
    this.vmScene.add(this.weaponRoot);

    const armMat = materials.operatorBody();
    this.forearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.16, 4, 6), armMat);
    this.hand = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.09), armMat);
    this.weaponRoot.add(this.forearm, this.hand);

    this.shellSpawnPoint.name = 'ShellSpawn';
    this.weaponRoot.add(this.shellSpawnPoint);

    this.flashFrames = buildMuzzleFlashFrames();
    const flashMat = new THREE.SpriteMaterial({
      map: this.flashFrames[0]!,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.flashSprite = new THREE.Sprite(flashMat);
    this.flashSprite.scale.set(0.18, 0.18, 0.18);
    this.flashSprite.visible = false;

    this.flashLight = new THREE.PointLight(0xffaa55, 0, 1.2, 2);
    this.flashLight.visible = false;

    this.setWeapon(0);
  }

  /** Swaps the visible weapon model. Call whenever the active weapon id changes. */
  setWeapon(weaponId: number): void {
    if (weaponId === this.weaponId && this.model) return;
    if (this.model) this.weaponRoot.remove(this.model);

    const def = WEAPONS[weaponId];
    this.weaponId = weaponId;
    this.def = def ?? null;
    if (!def) return;

    let model = this.assets.weapons.get(weaponId);
    model = model ? model.clone(true) : buildFallbackGun(def, this.materials);
    model.position.set(0, 0, 0);
    model.rotation.set(0, 0, 0);
    this.model = model;
    this.weaponRoot.add(model);

    this.muzzle = findByName(model, 'muzzle');
    this.grip = findByName(model, 'grip');
    this.sight = findByName(model, 'sight');

    // Attach the muzzle-flash sprite/light so they inherit the muzzle's transform.
    const muzzleParent = this.muzzle ?? model;
    muzzleParent.add(this.flashSprite);
    muzzleParent.add(this.flashLight);

    // Align the ADS pose so the sight (or the model's top-centre as a fallback)
    // lands on the camera axis (x=0, y=0), a small distance in front of it.
    const sightOffset = offsetFromRoot(this.weaponRoot, this.sight, this.scratchV3);
    if (sightOffset) {
      this.adsPos = [-sightOffset.x, -sightOffset.y, -sightOffset.z - ADS_FORWARD_EPS];
    } else {
      const box = new THREE.Box3().setFromObject(model);
      const cx = (box.min.x + box.max.x) / 2;
      const cz = (box.min.z + box.max.z) / 2;
      this.adsPos = [-cx, -box.max.y, -cz - ADS_FORWARD_EPS];
    }

    // Reposition the procedural arms at the grip (or a length-based estimate).
    const gripOffset = offsetFromRoot(this.weaponRoot, this.grip, this.scratchV3);
    const gx = gripOffset ? gripOffset.x : 0;
    const gy = gripOffset ? gripOffset.y : -0.06;
    const gz = gripOffset ? gripOffset.z : def.modelLength * 0.15;
    this.hand.position.set(gx, gy, gz);
    this.hand.rotation.set(0.2, 0, 0);
    this.forearm.position.set(gx, gy + 0.04, gz + 0.16);
    this.forearm.rotation.set(Math.PI / 2 - 0.3, 0, 0);

    this.shellSpawnPoint.position.set(0.05, -0.01, gz * 0.4);

    // Sniper scope overlay hides the model rather than rendering it up close.
    this.scopeVisible = false;
  }

  /** Applies every §4 procedural motion component and positions the weapon root for this frame. */
  update(local: PlayerState, weaponEvents: WeaponEvents, _movementEvents: MovementEvents, dt: number): void {
    const def = this.def;
    if (!def || !this.model) return;

    if (this.firstUpdate) {
      this.prevYaw = local.yaw;
      this.prevPitch = local.pitch;
      this.firstUpdate = false;
    }

    const pose = this.pose;
    resetPose(pose);

    const adsT = clamp01(local.adsT);
    const adsE = easeOutCubic(adsT);
    const grounded = local.onGround && !local.mounted;
    const horizSpeed = Math.hypot(local.vel.x, local.vel.z);
    const sprinting = local.moveState === MOVE_TACSPRINT || local.moveState === MOVE_SPRINT;

    // --- idle sway (Lissajous), suppressed while mounted -------------------
    if (!local.mounted) {
      this.swayTime += dt;
      const swayAmp = lerp(SWAY_HIP_DEG, SWAY_ADS_DEG, adsT) * DEG;
      pose.rx += Math.sin(this.swayTime * SWAY_FREQ_X * Math.PI * 2) * swayAmp;
      pose.ry += Math.cos(this.swayTime * SWAY_FREQ_Y * Math.PI * 2) * swayAmp * 0.7;
    }

    // --- walk / sprint bob ---------------------------------------------
    {
      const targetBlend = sprinting ? 1 : 0;
      this.bobBlend = damp(this.bobBlend, targetBlend, BOB_BLEND_HZ, dt);
      const freqHz = lerp(BOB_WALK_HZ, BOB_SPRINT_HZ, this.bobBlend);
      const moving = grounded && horizSpeed > 0.15;
      if (moving) this.bobTime += dt * freqHz;
      const speedRatio = sprinting ? 1 : clamp01(horizSpeed / 4.3);
      const ampDeg = moving ? lerp(BOB_WALK_DEG, BOB_SPRINT_DEG, this.bobBlend) * speedRatio : 0;
      const ampDampen = 1 - adsE * 0.7; // bob is reduced, not eliminated, while ADS
      const phase = this.bobTime * Math.PI * 2;
      pose.rx += Math.sin(phase * 2) * ampDeg * DEG * ampDampen;
      pose.ry += Math.sin(phase) * ampDeg * DEG * 0.6 * ampDampen;
      pose.rz += this.bobBlend * BOB_SPRINT_TILT_DEG * DEG * (moving ? 1 : 0) * ampDampen;
    }

    // --- look-lag (spring toward angular-velocity-derived target) -------
    {
      const dYaw = angleDelta(local.yaw, this.prevYaw);
      const dPitch = local.pitch - this.prevPitch;
      this.prevYaw = local.yaw;
      this.prevPitch = local.pitch;
      const maxRad = LOOKLAG_MAX_DEG * DEG;
      const targetYaw = clamp(-dYaw * LOOKLAG_GAIN, -maxRad, maxRad);
      const targetPitch = clamp(dPitch * LOOKLAG_GAIN, -maxRad, maxRad);
      this.lagYaw = damp(this.lagYaw, targetYaw, LOOKLAG_HZ, dt);
      this.lagPitch = damp(this.lagPitch, targetPitch, LOOKLAG_HZ, dt);
      pose.ry += this.lagYaw;
      pose.rx += this.lagPitch;
    }

    // --- per-shot recoil kick, spring return -----------------------------
    if (weaponEvents.shots > 0 && weaponEvents.firedWeapon === this.weaponId) {
      for (let i = 0; i < weaponEvents.shots; i++) {
        const shotIdx = Math.max(0, local.shotIndex - weaponEvents.shots + i + 1);
        const r = recoilAt(def, shotIdx, Math.random);
        this.recoilPosZ += RECOIL_KICK_Z;
        this.recoilRotX += RECOIL_KICK_ROT * (0.6 + 0.4 * Math.min(1, Math.abs(r.pitch) * 4));
        this.recoilRotY += r.yaw * 1.5;
      }
      this.triggerMuzzleFlash();
    }
    this.recoilPosZ = damp(this.recoilPosZ, 0, RECOIL_RETURN_HZ, dt);
    this.recoilRotX = damp(this.recoilRotX, 0, RECOIL_RETURN_HZ, dt);
    this.recoilRotY = damp(this.recoilRotY, 0, RECOIL_RETURN_HZ, dt);
    pose.pz += this.recoilPosZ;
    pose.rx += this.recoilRotX;
    pose.ry += this.recoilRotY;

    // --- reload keyframed curve -------------------------------------------
    if (local.reloadT > 0 && local.reloadTotal > 0) {
      const t = clamp01(1 - local.reloadT / local.reloadTotal);
      sampleReloadCurve(t, pose);
    }

    // --- swap dip ---------------------------------------------------------
    if (local.swapT > 0) {
      const ratio = clamp01(local.swapT / SWAP_TIME);
      pose.py -= Math.sin(ratio * Math.PI) * SWAP_DIP_M;
    }

    // --- tac-sprint high pose ----------------------------------------------
    {
      const target = local.moveState === MOVE_TACSPRINT ? 1 : 0;
      this.tacBlend = damp(this.tacBlend, target, TACSPRINT_BLEND_HZ, dt);
      pose.rx += TACSPRINT_BARREL_UP_DEG * DEG * this.tacBlend;
      pose.py += TACSPRINT_RAISE_Y * this.tacBlend;
      pose.pz += TACSPRINT_PULL_Z * this.tacBlend;
    }

    // --- landing dip --------------------------------------------------------
    if (local.landingT > 0) {
      const ratio = clamp01(local.landingT / LANDING_SLOW_TIME);
      pose.py -= 0.03 * Math.sin(Math.PI * ratio);
    }

    // --- slide: lower + roll ------------------------------------------------
    {
      const target = local.moveState === MOVE_SLIDE ? 1 : 0;
      this.slideBlend = damp(this.slideBlend, target, SLIDE_BLEND_HZ, dt);
      if (this.slideBlend > 1e-4) {
        const sign = local.slideDirX >= 0 ? 1 : -1;
        pose.py -= SLIDE_LOWER_M * this.slideBlend;
        pose.rz += sign * SLIDE_CAMERA_ROLL_DEG * DEG * this.slideBlend;
      }
    }

    // --- melee swing --------------------------------------------------------
    if (local.meleeT > 0) {
      const progress = clamp01(1 - local.meleeT / MELEE_TIME);
      const envelope = Math.sin(progress * Math.PI);
      pose.ry += MELEE_SWING_DEG * DEG * envelope;
      pose.pz -= MELEE_SWING_FWD_M * envelope;
    }

    // --- grenade cook / throw ------------------------------------------------
    {
      const cooking = local.cookT > 0;
      this.grenadeBlend = damp(this.grenadeBlend, cooking ? 1 : 0, GRENADE_POSE_BLEND_HZ, dt);
      if (this.grenadeBlend > 1e-4) {
        pose.py -= GRENADE_PULL_LOWER_M * this.grenadeBlend;
        pose.rx += GRENADE_PULL_TILT_DEG * DEG * this.grenadeBlend;
      }
      if (weaponEvents.threwKind >= 0) this.throwTimer = GRENADE_THROW_DURATION;
      if (this.throwTimer > 0) {
        this.throwTimer = Math.max(0, this.throwTimer - dt);
        const t = 1 - this.throwTimer / GRENADE_THROW_DURATION;
        const envelope = Math.sin(clamp01(t) * Math.PI);
        pose.ry -= GRENADE_THROW_SWING_DEG * DEG * envelope;
        pose.pz -= 0.1 * envelope;
      }
    }

    // --- ADS base position (everything above is an additive offset on top) --
    const basePos: [number, number, number] = [
      lerp(HIP_POS[0], this.adsPos[0], adsE),
      lerp(HIP_POS[1], this.adsPos[1], adsE),
      lerp(HIP_POS[2], this.adsPos[2], adsE),
    ];

    this.weaponRoot.position.set(basePos[0] + pose.px, basePos[1] + pose.py, basePos[2] + pose.pz);
    this.weaponRoot.rotation.set(pose.rx, pose.ry, pose.rz, 'XYZ');

    // --- sniper scope: hide the model once ADS has settled in -------------
    const isSniper = this.weaponId === WEAPON_SNIPER;
    this.scopeVisible = isSniper && adsT > 0.9;
    this.model.visible = !this.scopeVisible;
    this.forearm.visible = !this.scopeVisible;
    this.hand.visible = !this.scopeVisible;

    // --- muzzle flash timers ------------------------------------------------
    this.flashSpriteTimer = Math.max(0, this.flashSpriteTimer - dt);
    this.flashLightTimer = Math.max(0, this.flashLightTimer - dt);
    this.flashSprite.visible = this.flashSpriteTimer > 0 && !this.scopeVisible;
    if (this.flashSprite.visible) {
      const frame = Math.min(3, Math.floor(((MUZZLE_FLASH_SPRITE_DURATION - this.flashSpriteTimer) / MUZZLE_FLASH_SPRITE_DURATION) * 4));
      const mat = this.flashSprite.material as THREE.SpriteMaterial;
      mat.map = this.flashFrames[frame]!;
      mat.needsUpdate = true;
    }
    this.flashLight.visible = this.flashLightTimer > 0 && !this.scopeVisible;
    if (this.flashLight.visible) {
      this.flashLight.intensity = MUZZLE_FLASH_LIGHT_INTENSITY * (this.flashLightTimer / MUZZLE_FLASH_LIGHT_DURATION);
    }
  }

  private triggerMuzzleFlash(): void {
    this.flashSpriteTimer = MUZZLE_FLASH_SPRITE_DURATION;
    this.flashLightTimer = MUZZLE_FLASH_LIGHT_DURATION;
  }

  /** World-space muzzle position, written into `out`. For local tracer origins. */
  muzzleWorldPos(out: Vec3): Vec3 {
    const node = this.muzzle ?? this.model;
    if (!node) {
      out.x = this.vmCamera.position.x;
      out.y = this.vmCamera.position.y;
      out.z = this.vmCamera.position.z;
      return out;
    }
    node.updateWorldMatrix(true, false);
    node.getWorldPosition(this.scratchV3);
    out.x = this.scratchV3.x;
    out.y = this.scratchV3.y;
    out.z = this.scratchV3.z;
    return out;
  }

  /** Local-space point (relative to the weapon root) to spawn ejected shell casings from. */
  getShellSpawnPoint(): THREE.Object3D {
    return this.shellSpawnPoint;
  }
}

function sampleReloadCurve(t: number, out: Pose): void {
  const curve = RELOAD_CURVE;
  let i = 0;
  while (i < curve.length - 2 && t > curve[i + 1]!.t) i++;
  const a = curve[i]!;
  const b = curve[i + 1]!;
  const span = b.t - a.t;
  const local = span > 1e-6 ? clamp01((t - a.t) / span) : 0;
  const e = local * local * (3 - 2 * local);
  out.px += lerp(a.pos[0], b.pos[0], e);
  out.py += lerp(a.pos[1], b.pos[1], e);
  out.pz += lerp(a.pos[2], b.pos[2], e);
  out.rx += lerp(a.rot[0], b.rot[0], e);
  out.ry += lerp(a.rot[1], b.rot[1], e);
  out.rz += lerp(a.rot[2], b.rot[2], e);
}
