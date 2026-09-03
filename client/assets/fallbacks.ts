// Procedural placeholders for every asset category. loader.ts falls back to
// these whenever a download is missing, failed, or index.json itself could
// not be fetched, so the game is always playable with zero downloaded bytes.
// three.js only; no DOM, no network. Math.random() is fine here (this is
// client code, not shared/**), since fallback look need not be deterministic.

import * as THREE from 'three';
import { HEIGHT_STAND, PLAYER_RADIUS, PROJ_FLASH, PROJ_FRAG, PROJ_SMOKE } from '../../shared/constants.ts';
import { WEAPONS } from '../../shared/weapons.ts';

/** Shared so every fallback part tints the same way as a real character (team color, damage flash, etc). */
function mainMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.7, metalness: 0.1 });
  mat.name = 'M_Main';
  return mat;
}

function jointMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.85, metalness: 0.0 });
  mat.name = 'M_Joints';
  return mat;
}

function gunmetalMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.45, metalness: 0.85 });
  mat.name = 'M_Gunmetal';
  return mat;
}

// ---------------------------------------------------------------------------
// Character
// ---------------------------------------------------------------------------

/**
 * A mannequin built from primitives: a capsule torso, a head, a handful of
 * joint markers, and a small box standing in for a held weapon. No animation
 * clips — characters.ts should hold a static idle pose when `source === 'fallback'`.
 */
export function makeFallbackCharacter(): { scene: THREE.Group; clips: THREE.AnimationClip[] } {
  const group = new THREE.Group();
  group.name = 'FallbackCharacter';

  const main = mainMaterial();
  const joint = jointMaterial();

  const headRadius = 0.11;
  const capsuleRadius = PLAYER_RADIUS * 0.55;
  const torsoLength = Math.max(0.1, HEIGHT_STAND - headRadius * 2 - capsuleRadius * 2);
  const torsoCenterY = capsuleRadius + torsoLength / 2;

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(capsuleRadius, torsoLength, 4, 8), main);
  torso.position.y = torsoCenterY;
  torso.name = 'Torso';
  group.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(headRadius, 12, 8), joint);
  head.position.y = HEIGHT_STAND - headRadius;
  head.name = 'Head';
  group.add(head);

  // Shoulder / elbow / knee markers: purely decorative, break up the silhouette
  // so the fallback doesn't read as a single capsule at a distance.
  const jointRadius = 0.06;
  const jointPositions: Array<[number, number, number]> = [
    [-capsuleRadius, torsoCenterY + torsoLength * 0.4, 0],
    [capsuleRadius, torsoCenterY + torsoLength * 0.4, 0],
    [-capsuleRadius * 0.8, torsoCenterY - torsoLength * 0.35, 0.05],
    [capsuleRadius * 0.8, torsoCenterY - torsoLength * 0.35, 0.05],
    [-0.12, capsuleRadius * 0.6, 0],
    [0.12, capsuleRadius * 0.6, 0],
  ];
  for (const [x, y, z] of jointPositions) {
    const marker = new THREE.Mesh(new THREE.SphereGeometry(jointRadius, 8, 6), joint);
    marker.position.set(x, y, z);
    group.add(marker);
  }

  // Stand-in weapon so the silhouette reads as "armed" even before the real
  // viewmodel/third-person weapon attaches.
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.55), main);
  gun.position.set(0.22, torsoCenterY + torsoLength * 0.25, 0.15);
  gun.name = 'FallbackGun';
  group.add(gun);

  return { scene: group, clips: [] };
}

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

/**
 * A boxy gunmetal placeholder sized to the real weapon's modelLength, with
 * Muzzle/Grip empties in the same convention the real loader normalizes to
 * (barrel along -Z), so viewmodel.ts and characters.ts never need to special-case it.
 */
export function makeFallbackWeapon(id: number): THREE.Group {
  const def = WEAPONS[id];
  const length = def?.modelLength ?? 0.7;
  const mat = gunmetalMaterial();

  const group = new THREE.Group();
  group.name = `FallbackWeapon_${id}`;

  const bodyLength = length * 0.55;
  const barrelLength = length - bodyLength;

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.11, bodyLength), mat);
  body.position.z = length / 2 - bodyLength / 2;
  group.add(body);

  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, barrelLength, 10), mat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.z = length / 2 - bodyLength - barrelLength / 2;
  group.add(barrel);

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.16, 0.05), mat);
  grip.position.set(0, -0.09, length / 2 - bodyLength * 0.75);
  group.add(grip);

  const muzzle = new THREE.Object3D();
  muzzle.name = 'Muzzle';
  muzzle.position.set(0, 0, -length / 2);
  group.add(muzzle);

  const gripEmpty = new THREE.Object3D();
  gripEmpty.name = 'Grip';
  gripEmpty.position.set(0, -0.03, length / 2 - length * 0.35);
  group.add(gripEmpty);

  return group;
}

// ---------------------------------------------------------------------------
// Grenades
// ---------------------------------------------------------------------------

const GRENADE_HEIGHT = 0.09;

/** kind is PROJ_FRAG / PROJ_FLASH / PROJ_SMOKE. */
export function makeFallbackGrenade(kind: number): THREE.Group {
  const group = new THREE.Group();
  group.name = `FallbackGrenade_${kind}`;

  let color = 0x3a3a2a;
  let geometry: THREE.BufferGeometry;
  if (kind === PROJ_FLASH) {
    color = 0xb8b090;
    geometry = new THREE.CylinderGeometry(GRENADE_HEIGHT * 0.32, GRENADE_HEIGHT * 0.32, GRENADE_HEIGHT, 12);
  } else if (kind === PROJ_SMOKE) {
    color = 0x4a5a4a;
    geometry = new THREE.CylinderGeometry(GRENADE_HEIGHT * 0.36, GRENADE_HEIGHT * 0.36, GRENADE_HEIGHT, 12);
  } else {
    // PROJ_FRAG and any unknown kind: classic ellipsoid frag body.
    geometry = new THREE.SphereGeometry(GRENADE_HEIGHT * 0.5, 12, 10);
  }
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.3 }));
  group.add(mesh);
  return group;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** Generic box/cylinder guesses keyed by substrings in the Poly Haven prop id. */
export function makeFallbackProp(id: string): THREE.Group {
  const group = new THREE.Group();
  group.name = `FallbackProp_${id}`;
  const lower = id.toLowerCase();
  const mat = new THREE.MeshStandardMaterial({ color: 0x555f66, roughness: 0.8, metalness: 0.05 });

  let mesh: THREE.Mesh;
  if (lower.includes('barrel')) {
    mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.88, 16), mat);
    mesh.position.y = 0.44;
  } else if (lower.includes('bag')) {
    mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.28, 0.32), mat);
    mesh.position.y = 0.14;
  } else if (lower.includes('light')) {
    mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.25, 0.2), mat);
    mesh.position.y = -0.1;
  } else {
    // ammo_box, cardboard_box_01 and anything else: a plain crate.
    mesh = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.4, 0.45), mat);
    mesh.position.y = 0.2;
  }
  group.add(mesh);
  return group;
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

/**
 * A small tileable-looking noise texture around baseColor, for when a real
 * PBR texture fails to download. `size` should be a power of two (e.g. 64).
 */
export function makeNoiseTexture(size: number, baseColor: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const base = new THREE.Color(baseColor);
  const br = base.r * 255;
  const bg = base.g * 255;
  const bb = base.b * 255;
  for (let i = 0; i < size * size; i++) {
    const n = (Math.random() - 0.5) * 28; // +/- noise around the base color
    const o = i * 4;
    data[o] = Math.max(0, Math.min(255, br + n));
    data[o + 1] = Math.max(0, Math.min(255, bg + n));
    data[o + 2] = Math.max(0, Math.min(255, bb + n));
    data[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}
