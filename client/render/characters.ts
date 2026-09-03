// Third-person representation of every other player: one skinned clone per
// player with an AnimationMixer driven by a small locomotion/aim blend tree,
// plus event-driven one-shots (shoot/reload/hit/jump transitions) and an
// animation LOD system so mixer cost stays bounded with many players.
//
// This file receives already-interpolated per-player state (SnapshotPlayer,
// produced by client/net/interpolation.ts) — it only ever sets transforms and
// animation weights from that state, never predicts or smooths positions.

import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import type { GameAssets } from '../assets/loader.ts';
import type { MaterialLibrary } from './materials.ts';
import type { GameEvent, SnapshotPlayer, Vec3 } from '../../shared/types.ts';
import { WEAPONS } from '../../shared/weapons.ts';
import { damp } from '../../shared/math.ts';
import {
  EV_FIRE,
  EV_HIT,
  EV_KILL,
  EV_RELOAD,
  HEIGHT_STAND,
  MOVE_AIR,
  MOVE_SLIDE,
  MOVE_TACSPRINT,
  PLAYER_RADIUS,
  SPEED_CROUCH,
  SPEED_SPRINT,
  SPEED_TACSPRINT,
  SPEED_WALK,
  STANCE_CROUCH,
  STANCE_PRONE,
  TEAM_NONE,
  WEAPON_NONE,
  ZONE_HEAD,
} from '../../shared/constants.ts';

// ---------------------------------------------------------------------------
// Tunables (cosmetic only — never fed back into the simulation)
// ---------------------------------------------------------------------------
const LOD_DISTANCE = 25;
const LOD_FULL_RATE_CAP = 8;
const LOD_REDUCED_STRIDE = 4; // mixer.update runs on every 4th call for reduced-LOD characters
const WEIGHT_BLEND_HZ = 12;
const OVERLAY_BLEND_HZ = 20;
const NAMEPLATE_FADE_START = 8;
const NAMEPLATE_FADE_END = 30;
const PRONE_DROP_M = 0.45;
const PRONE_PITCH_DEG = 75;
const JUMP_START_HOLD = 0.2;
const JUMP_LAND_HOLD = 0.25;
const HIT_HOLD = 0.35;
const SHOOT_HOLD = 0.18;
const RELOAD_MIN_HOLD = 0.6;

// Locomotion speed anchors (m/s) → weight anchors, per plan §5/§6.
const LOCOMOTION_ANCHORS = [0, 2, 4.3, 6.2] as const;
const LOCOMOTION_KEYS = ['idle', 'walk', 'jog', 'sprint'] as const;
const CROUCH_ANCHORS = [0, SPEED_CROUCH] as const;
const CROUCH_KEYS = ['crouchIdle', 'crouchFwd'] as const;
const AIM_ANCHORS = [-Math.PI / 2, 0, Math.PI / 2] as const;
const AIM_KEYS = ['aimDown', 'aimNeutral', 'aimUp'] as const;

/** Canonical clip keys this file understands, resolved once from whatever rig loaded. */
type ClipKey =
  | 'idle' | 'walk' | 'jog' | 'sprint'
  | 'crouchIdle' | 'crouchFwd'
  | 'jumpStart' | 'jumpLoop' | 'jumpLand'
  | 'aimUp' | 'aimNeutral' | 'aimDown'
  | 'shoot' | 'reload' | 'hitChest' | 'hitHead' | 'death' | 'roll';

/** First matching suffix wins; suffixes are matched case-insensitively against the clip name after any 'Rig|'/'CharacterArmature|' prefix. Covers both the Quaternius mannequin and the Soldier rig clip sets. */
const CLIP_ALIASES: Record<ClipKey, readonly string[]> = {
  idle: ['idle_loop', 'idle_gun'],
  walk: ['walk_loop'],
  jog: ['jog_fwd_loop', 'run'],
  sprint: ['sprint_loop', 'run_shoot', 'run'],
  crouchIdle: ['crouch_idle_loop'],
  crouchFwd: ['crouch_fwd_loop'],
  jumpStart: ['jump_start'],
  jumpLoop: ['jump_loop'],
  jumpLand: ['jump_land'],
  aimUp: ['pistol_aim_up'],
  aimNeutral: ['pistol_aim_neutral', 'pistol_idle_loop'],
  aimDown: ['pistol_aim_down'],
  shoot: ['pistol_shoot', 'gun_shoot', 'run_shoot'],
  reload: ['pistol_reload'],
  hitChest: ['hit_chest', 'hitrecieve', 'hitreceive'],
  hitHead: ['hit_head'],
  death: ['death01', 'death'],
  roll: ['roll'],
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Normalizes a clip name for matching: strips an 'Armature|' style prefix and lowercases. */
function normalizeClipName(name: string): string {
  const bar = name.lastIndexOf('|');
  return (bar >= 0 ? name.slice(bar + 1) : name).toLowerCase();
}

/** Resolves every ClipKey to a clip from the rig's clip list, once per loaded character rig. */
function resolveClips(clips: readonly THREE.AnimationClip[]): Partial<Record<ClipKey, THREE.AnimationClip>> {
  const normalized = clips.map((c) => ({ clip: c, name: normalizeClipName(c.name) }));
  const out: Partial<Record<ClipKey, THREE.AnimationClip>> = {};
  for (const key of Object.keys(CLIP_ALIASES) as ClipKey[]) {
    for (const alias of CLIP_ALIASES[key]) {
      const hit = normalized.find((n) => n.name === alias || n.name.endsWith(alias));
      if (hit) { out[key] = hit.clip; break; }
    }
  }
  return out;
}

/** Distributes `value` across the two nearest anchors, adding into `target[keys[i]]`. */
function blendAnchors(value: number, anchors: readonly number[], keys: readonly string[], target: Record<string, number>): void {
  if (value <= anchors[0]!) { target[keys[0]!] = (target[keys[0]!] ?? 0) + 1; return; }
  const last = anchors.length - 1;
  if (value >= anchors[last]!) { target[keys[last]!] = (target[keys[last]!] ?? 0) + 1; return; }
  for (let i = 0; i < last; i++) {
    const a = anchors[i]!, b = anchors[i + 1]!;
    if (value <= b) {
      const t = (value - a) / (b - a);
      target[keys[i]!] = (target[keys[i]!] ?? 0) + (1 - t);
      target[keys[i + 1]!] = (target[keys[i + 1]!] ?? 0) + t;
      return;
    }
  }
}

function findBoneByName(root: THREE.Object3D, needles: readonly string[]): THREE.Object3D | undefined {
  let found: THREE.Object3D | undefined;
  root.traverse((obj) => {
    if (found) return;
    const n = obj.name.toLowerCase();
    if (needles.some((needle) => n.includes(needle))) found = obj;
  });
  return found;
}

function findByName(root: THREE.Object3D, needle: string): THREE.Object3D | undefined {
  let found: THREE.Object3D | undefined;
  root.traverse((obj) => {
    if (!found && obj.name.toLowerCase().includes(needle)) found = obj;
  });
  return found;
}

function applyTeamMaterials(root: THREE.Object3D, materials: MaterialLibrary, team: number): void {
  let sawNamed = false;
  let sawAny = false;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (let i = 0; i < mats.length; i++) {
      const name = mats[i]?.name ?? '';
      sawAny = true;
      if (name === 'M_Main') {
        sawNamed = true;
        setMat(mesh, i, materials.operatorBody());
      } else if (name === 'M_Joints') {
        sawNamed = true;
        setMat(mesh, i, materials.team(team));
      }
    }
  });
  if (!sawNamed && sawAny) {
    // Fallback: no named material slots found anywhere on the rig — mark the
    // first mesh's first material slot with the team colour so players can
    // still tell teams apart at a glance.
    let done = false;
    root.traverse((obj) => {
      if (done) return;
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      setMat(mesh, 0, materials.team(team));
      done = true;
    });
  }
}

function setMat(mesh: THREE.Mesh, index: number, mat: THREE.Material): void {
  if (Array.isArray(mesh.material)) mesh.material[index] = mat;
  else mesh.material = mat;
}

function buildFallbackCharacter(materials: MaterialLibrary, team: number): THREE.Object3D {
  const group = new THREE.Group();
  const bodyH = HEIGHT_STAND - PLAYER_RADIUS;
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(PLAYER_RADIUS * 0.8, bodyH - PLAYER_RADIUS * 0.8, 4, 8), materials.team(team));
  body.position.y = bodyH / 2 + PLAYER_RADIUS * 0.4;
  group.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), materials.operatorBody());
  head.position.y = bodyH + PLAYER_RADIUS * 0.4 + 0.1;
  group.add(head);
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.5), materials.gunmetal());
  gun.position.set(0.18, bodyH * 0.55, -0.2);
  group.add(gun);
  return group;
}

/** Per-player rendered state: the network container, its skinned clone, mixer, actions and LOD bookkeeping. */
interface CharInstance {
  container: THREE.Group; // position/yaw only, driven by SnapshotPlayer
  poseGroup: THREE.Group; // prone drop/tilt and any other cosmetic pose offset
  root: THREE.Object3D; // the skinned clone (or fallback mesh group)
  mixer: THREE.AnimationMixer | null;
  actions: Partial<Record<ClipKey, THREE.AnimationAction>>;
  weights: Record<string, number>;
  isFallback: boolean;
  weaponId: number;
  weaponMesh: THREE.Object3D | null;
  handBone: THREE.Object3D | null;
  nameplate: THREE.Sprite | null;
  nameplateCanvas: HTMLCanvasElement | null;
  nameplateCtx: CanvasRenderingContext2D | null;
  nameplateText: string;
  prevMoveState: number;
  overlayAction: THREE.AnimationAction | null;
  overlayBlend: number;
  overlayHold: number;
  overlayActive: boolean;
  isDead: boolean;
  lodCounter: number;
  fullRate: boolean;
}

export class CharacterManager {
  private readonly scene: THREE.Scene;
  private readonly assets: GameAssets;
  private readonly materials: MaterialLibrary;
  private readonly resolved: Partial<Record<ClipKey, THREE.AnimationClip>>;

  private readonly chars = new Map<number, CharInstance>();
  private localTeam = TEAM_NONE;

  private readonly rankBuf: { id: number; dist: number }[] = [];

  constructor(scene: THREE.Scene, assets: GameAssets, materials: MaterialLibrary) {
    this.scene = scene;
    this.assets = assets;
    this.materials = materials;
    this.resolved = assets.character.source === 'fallback' ? {} : resolveClips(assets.character.clips);
  }

  update(remotes: Map<number, SnapshotPlayer>, localId: number, camPos: Vec3, dt: number): void {
    // Track the local player's team opportunistically (SnapshotPlayer carries
    // no `name`, and only sometimes includes the local id — see the report's
    // "gaps" section) so teammate nameplates can be filtered.
    const localSp = remotes.get(localId);
    if (localSp) this.localTeam = localSp.team;

    // Remove characters no longer present.
    for (const id of this.chars.keys()) {
      if (!remotes.has(id) || id === localId) this.removeChar(id);
    }

    // Rank by distance for the "at most 8 full-rate" LOD budget.
    this.rankBuf.length = 0;
    for (const [id, sp] of remotes) {
      if (id === localId) continue;
      const dx = sp.pos.x - camPos.x, dy = sp.pos.y - camPos.y, dz = sp.pos.z - camPos.z;
      this.rankBuf.push({ id, dist: Math.sqrt(dx * dx + dy * dy + dz * dz) });
    }
    this.rankBuf.sort((a, b) => a.dist - b.dist);
    const fullRateIds = new Set<number>();
    for (let i = 0; i < this.rankBuf.length && i < LOD_FULL_RATE_CAP; i++) {
      if (this.rankBuf[i]!.dist <= LOD_DISTANCE) fullRateIds.add(this.rankBuf[i]!.id);
    }

    for (const [id, sp] of remotes) {
      if (id === localId) continue;
      let ch = this.chars.get(id);
      if (!ch) { ch = this.createChar(sp); this.chars.set(id, ch); }
      ch.fullRate = fullRateIds.has(id);
      this.updateChar(ch, sp, camPos, dt);
    }
  }

  onEvent(e: GameEvent): void {
    switch (e.type) {
      case EV_FIRE: {
        const ch = this.chars.get(e.shooter);
        if (ch) this.playOverlay(ch, 'shoot', SHOOT_HOLD);
        break;
      }
      case EV_RELOAD: {
        const ch = this.chars.get(e.player);
        if (ch) {
          const dur = this.resolved.reload?.duration ?? RELOAD_MIN_HOLD;
          this.playOverlay(ch, 'reload', Math.max(RELOAD_MIN_HOLD, dur));
        }
        break;
      }
      case EV_HIT: {
        const ch = this.chars.get(e.target);
        if (ch) this.playOverlay(ch, e.zone === ZONE_HEAD ? 'hitHead' : 'hitChest', HIT_HOLD);
        break;
      }
      case EV_KILL: {
        // The death pose itself is driven off SnapshotPlayer.alive each frame;
        // this just clears any in-flight overlay so it doesn't fight the death clip.
        const ch = this.chars.get(e.victim);
        if (ch) { ch.overlayActive = false; }
        break;
      }
      default:
        break;
    }
  }

  // -------------------------------------------------------------------
  private createChar(sp: SnapshotPlayer): CharInstance {
    const container = new THREE.Group();
    const poseGroup = new THREE.Group();
    container.add(poseGroup);
    this.scene.add(container);

    const isFallback = this.assets.character.source === 'fallback';
    let root: THREE.Object3D;
    let mixer: THREE.AnimationMixer | null = null;
    const actions: Partial<Record<ClipKey, THREE.AnimationAction>> = {};

    if (isFallback) {
      root = buildFallbackCharacter(this.materials, sp.team);
    } else {
      root = skeletonClone(this.assets.character.scene) as THREE.Object3D;
      mixer = new THREE.AnimationMixer(root);
      for (const key of Object.keys(this.resolved) as ClipKey[]) {
        const clip = this.resolved[key]!;
        const action = mixer.clipAction(clip);
        if (key === 'aimUp' || key === 'aimNeutral' || key === 'aimDown') {
          const reference = this.resolved.aimNeutral ?? this.resolved.idle ?? clip;
          const additive = THREE.AnimationUtils.makeClipAdditive(clip.clone(), 0, reference, 30);
          const additiveAction = mixer.clipAction(additive);
          additiveAction.blendMode = THREE.AdditiveAnimationBlendMode;
          additiveAction.play();
          additiveAction.setEffectiveWeight(0);
          actions[key] = additiveAction;
          continue;
        }
        action.play();
        action.setEffectiveWeight(0);
        actions[key] = action;
      }
      actions.death?.setLoop(THREE.LoopOnce, 1);
      if (actions.death) actions.death.clampWhenFinished = true;
    }
    applyTeamMaterials(root, this.materials, sp.team);
    poseGroup.add(root);

    // FBX2glTF strips the dots from Rigify names: 'DEF-hand.R' arrives as 'DEF-handR'.
    const handBone = isFallback ? null : findBoneByName(root, ['hand.r', 'hand_r', 'def-handr', 'righthand', 'hand_right', 'r_hand']) ?? null;

    return {
      container,
      poseGroup,
      root,
      mixer,
      actions,
      weights: {},
      isFallback,
      weaponId: WEAPON_NONE,
      weaponMesh: null,
      handBone,
      nameplate: null,
      nameplateCanvas: null,
      nameplateCtx: null,
      nameplateText: '',
      prevMoveState: sp.moveState,
      overlayAction: null,
      overlayBlend: 0,
      overlayHold: 0,
      overlayActive: false,
      isDead: false,
      lodCounter: 0,
      fullRate: true,
    };
  }

  private removeChar(id: number): void {
    const ch = this.chars.get(id);
    if (!ch) return;
    this.scene.remove(ch.container);
    ch.mixer?.stopAllAction();
    this.chars.delete(id);
  }

  private updateChar(ch: CharInstance, sp: SnapshotPlayer, camPos: Vec3, dt: number): void {
    // --- transform: position/yaw are already interpolated upstream ---------
    ch.container.position.set(sp.pos.x, sp.pos.y, sp.pos.z);
    ch.container.rotation.set(0, sp.yaw, 0);

    const prone = sp.stance === STANCE_PRONE && sp.alive;
    const targetTiltRad = prone ? (PRONE_PITCH_DEG * Math.PI) / 180 : 0;
    const targetDrop = prone ? -PRONE_DROP_M : 0;
    ch.poseGroup.position.y = damp(ch.poseGroup.position.y, targetDrop, 10, dt);
    ch.poseGroup.rotation.x = damp(ch.poseGroup.rotation.x, targetTiltRad, 10, dt);

    // --- weapon attach (only rebuilt when the weapon id actually changes) --
    if (sp.weapon !== ch.weaponId) this.attachWeapon(ch, sp.weapon);

    // --- nameplate: teammates only, faded by distance ----------------------
    this.updateNameplate(ch, sp, camPos);

    if (ch.isFallback || !ch.mixer) return; // no animation to drive

    // --- death: persistent full override, no locomotion/aim underneath ----
    if (!sp.alive) {
      if (!ch.isDead) {
        ch.isDead = true;
        ch.overlayActive = false;
        for (const key of Object.keys(ch.actions) as ClipKey[]) ch.actions[key]?.setEffectiveWeight(0);
        const death = ch.actions.death;
        if (death) { death.reset(); death.play(); death.setEffectiveWeight(1); }
      }
      ch.mixer.update(dt);
      return;
    }
    if (ch.isDead) ch.isDead = false; // respawned

    // --- animation LOD: reduced-rate characters skip most of the work ------
    ch.lodCounter++;
    const shouldSample = ch.fullRate || (ch.lodCounter % LOD_REDUCED_STRIDE === 0);
    if (!shouldSample) return;
    const sampleDt = ch.fullRate ? dt : dt * LOD_REDUCED_STRIDE;

    // --- base pose target weights ------------------------------------------
    const target: Record<string, number> = {};
    const horizSpeed = Math.hypot(sp.vel.x, sp.vel.z);
    if (sp.moveState === MOVE_SLIDE) {
      target.roll = 1;
    } else if (sp.moveState === MOVE_AIR) {
      target.jumpLoop = 1;
    } else if (prone) {
      target.crouchIdle = 1;
    } else if (sp.stance === STANCE_CROUCH) {
      blendAnchors(horizSpeed, CROUCH_ANCHORS, CROUCH_KEYS, target);
    } else {
      const speedCap = sp.moveState === MOVE_TACSPRINT ? SPEED_TACSPRINT : SPEED_SPRINT;
      blendAnchors(Math.min(horizSpeed, speedCap), LOCOMOTION_ANCHORS, LOCOMOTION_KEYS, target);
    }

    // Jump transition one-shots.
    const enteredAir = sp.moveState === MOVE_AIR && ch.prevMoveState !== MOVE_AIR;
    const leftAir = sp.moveState !== MOVE_AIR && ch.prevMoveState === MOVE_AIR;
    if (enteredAir) this.playOverlay(ch, 'jumpStart', JUMP_START_HOLD);
    if (leftAir) this.playOverlay(ch, 'jumpLand', JUMP_LAND_HOLD);
    ch.prevMoveState = sp.moveState;

    // Smoothly chase target weights for the base locomotion actions.
    for (const key of [...LOCOMOTION_KEYS, ...CROUCH_KEYS, 'jumpLoop', 'roll'] as const) {
      const cur = ch.weights[key] ?? 0;
      ch.weights[key] = damp(cur, target[key] ?? 0, WEIGHT_BLEND_HZ, sampleDt);
    }

    // --- overlay one-shots (shoot/reload/hit/jump transitions) -------------
    if (ch.overlayActive) {
      ch.overlayBlend = damp(ch.overlayBlend, 1, OVERLAY_BLEND_HZ, sampleDt);
      ch.overlayHold -= sampleDt;
      if (ch.overlayHold <= 0) ch.overlayActive = false;
    } else {
      ch.overlayBlend = damp(ch.overlayBlend, 0, OVERLAY_BLEND_HZ, sampleDt);
      if (ch.overlayBlend < 0.01 && ch.overlayAction) {
        ch.overlayAction.stop();
        ch.overlayAction = null;
      }
    }
    const baseScale = 1 - ch.overlayBlend;
    for (const key of [...LOCOMOTION_KEYS, ...CROUCH_KEYS, 'jumpLoop', 'roll'] as const) {
      ch.actions[key]?.setEffectiveWeight((ch.weights[key] ?? 0) * baseScale);
    }
    ch.overlayAction?.setEffectiveWeight(ch.overlayBlend);

    // --- aim layer (additive), dropped for reduced-LOD characters ----------
    const aimEnabled = ch.fullRate && ch.overlayBlend < 0.5;
    const aimTarget: Record<string, number> = {};
    if (aimEnabled) blendAnchors(sp.pitch, AIM_ANCHORS, AIM_KEYS, aimTarget);
    for (const key of AIM_KEYS) {
      const cur = ch.weights[key] ?? 0;
      const next = damp(cur, aimEnabled ? (aimTarget[key] ?? 0) : 0, WEIGHT_BLEND_HZ, sampleDt);
      ch.weights[key] = next;
      ch.actions[key]?.setEffectiveWeight(next * baseScale);
    }

    ch.mixer.update(sampleDt);
  }

  private playOverlay(ch: CharInstance, key: ClipKey, holdSeconds: number): void {
    if (ch.isFallback || !ch.mixer) return;
    const action = ch.actions[key];
    if (!action) return;
    if (ch.overlayAction && ch.overlayAction !== action) ch.overlayAction.stop();
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = false;
    action.play();
    ch.overlayAction = action;
    ch.overlayHold = holdSeconds;
    ch.overlayActive = true;
  }

  private attachWeapon(ch: CharInstance, weaponId: number): void {
    if (ch.weaponMesh) {
      ch.weaponMesh.parent?.remove(ch.weaponMesh);
      ch.weaponMesh = null;
    }
    ch.weaponId = weaponId;
    if (weaponId === WEAPON_NONE) return;
    const def = WEAPONS[weaponId];
    const source = this.assets.weapons.get(weaponId);
    if (!def || !source) return;
    // The loader already normalized the wrapper (barrel along -Z, length =
    // def.modelLength, Muzzle/Grip empties). Never touch the wrapper's own
    // transform; put it in a holder that undoes the bone's world scale and
    // turns the barrel (-Z) along the bone's +Y axis, then slide the Grip
    // empty onto the bone origin.
    const mesh = source.clone(true);
    const holder = new THREE.Group();
    holder.name = `weapon_holder_${def.id}`;
    holder.add(mesh);
    const attachPoint = ch.handBone ?? ch.root;
    attachPoint.add(holder);
    attachPoint.updateMatrixWorld(true);
    const boneScale = new THREE.Vector3();
    attachPoint.getWorldScale(boneScale);
    holder.scale.set(1 / Math.max(boneScale.x, 1e-6), 1 / Math.max(boneScale.y, 1e-6), 1 / Math.max(boneScale.z, 1e-6));
    if (ch.handBone) holder.rotation.set(Math.PI / 2, 0, 0);
    holder.updateMatrixWorld(true);

    const grip = findByName(mesh, 'grip');
    if (grip) {
      const gripInHolder = new THREE.Vector3();
      grip.getWorldPosition(gripInHolder);
      holder.worldToLocal(gripInHolder);
      mesh.position.sub(gripInHolder);
    }
    ch.weaponMesh = holder;
  }

  private updateNameplate(ch: CharInstance, sp: SnapshotPlayer, camPos: Vec3): void {
    const isTeammate = this.localTeam !== TEAM_NONE && sp.team === this.localTeam;
    if (!isTeammate) {
      if (ch.nameplate) ch.nameplate.visible = false;
      return;
    }
    // SnapshotPlayer carries no player name (only LobbyPlayer does), so the
    // nameplate falls back to an id/bot label — see the report's gaps.
    const text = sp.isBot ? `Bot ${sp.id}` : `P${sp.id}`;
    if (!ch.nameplate || ch.nameplateText !== text) {
      this.buildNameplate(ch, text);
    }
    const nameplate = ch.nameplate!;
    nameplate.visible = true;
    nameplate.position.set(0, HEIGHT_STAND + 0.3, 0);
    const dx = sp.pos.x - camPos.x, dy = sp.pos.y + HEIGHT_STAND - camPos.y, dz = sp.pos.z - camPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const fade = 1 - clamp01((dist - NAMEPLATE_FADE_START) / (NAMEPLATE_FADE_END - NAMEPLATE_FADE_START));
    (nameplate.material as THREE.SpriteMaterial).opacity = clamp01(fade);
  }

  private buildNameplate(ch: CharInstance, text: string): void {
    const canvas = ch.nameplateCanvas ?? document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = ch.nameplateCtx ?? canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '600 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 12, canvas.width, 40);
    ctx.fillStyle = '#eaf6ff';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    if (!ch.nameplate) {
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(0.9, 0.22, 1);
      ch.container.add(sprite);
      ch.nameplate = sprite;
      ch.nameplateCanvas = canvas;
      ch.nameplateCtx = ctx;
    } else {
      (ch.nameplate.material.map as THREE.CanvasTexture).needsUpdate = true;
    }
    ch.nameplateText = text;
  }
}
