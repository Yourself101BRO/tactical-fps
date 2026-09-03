// Procedural, pooled combat effects: muzzle flashes (for remote shooters —
// the local shooter's own flash lives on the viewmodel), tracers, impact
// sparks/dust/decals, casings, explosions, flashbangs, blood, grenade trails
// and the bomb marker. Every subsystem is a fixed-size ring buffer sized at
// construction time (halved on 'mobile'); update() advances and retires
// entries in place, with zero per-frame allocation on the steady-state path.

import * as THREE from 'three';
import type { MaterialLibrary } from './materials.ts';
import type { Vec3 } from '../../shared/types.ts';
import {
  GRAVITY,
  MAT_ASPHALT,
  MAT_BRICK,
  MAT_CONCRETE,
  MAT_FLESH,
  MAT_GRAVEL,
  MAT_METAL,
  MAT_PLASTER,
  MAT_SAND,
  MAT_WOOD,
} from '../../shared/constants.ts';

type Quality = 'desktop' | 'mobile';

function scaled(n: number, quality: Quality): number {
  return quality === 'mobile' ? Math.max(1, Math.round(n / 2)) : n;
}

/** Per-material spark/dust/decal tint, indexed by MAT_*. */
const MATERIAL_COLOR: Record<number, { spark: number; dust: number; decal: number }> = {
  [MAT_CONCRETE]: { spark: 0xfff2c0, dust: 0xc9c3b6, decal: 0x2b2823 },
  [MAT_METAL]: { spark: 0xfff6d0, dust: 0xb9bcc2, decal: 0x1b1c1f },
  [MAT_WOOD]: { spark: 0xffd9a0, dust: 0x8a6748, decal: 0x2e1f12 },
  [MAT_GRAVEL]: { spark: 0xffe9b0, dust: 0x9c9284, decal: 0x27231d },
  [MAT_ASPHALT]: { spark: 0xffe9b0, dust: 0x555555, decal: 0x111111 },
  [MAT_BRICK]: { spark: 0xffd9a0, dust: 0xa15c45, decal: 0x33170f },
  [MAT_PLASTER]: { spark: 0xfff2c0, dust: 0xd8d2c4, decal: 0x2a271f },
  [MAT_SAND]: { spark: 0xffe9b0, dust: 0xd8c48a, decal: 0x3a3220 },
  [MAT_FLESH]: { spark: 0xff6655, dust: 0x8a1f1f, decal: 0x4a0d0d },
};
const DEFAULT_MATERIAL_COLOR = { spark: 0xffe0a0, dust: 0xaaaaaa, decal: 0x222222 };

function colorFor(material: number): { spark: number; dust: number; decal: number } {
  return MATERIAL_COLOR[material] ?? DEFAULT_MATERIAL_COLOR;
}

/** A small soft-circle sprite texture shared by every point/sprite effect. */
function buildDotTexture(): THREE.CanvasTexture {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildRingTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.strokeStyle = 'rgba(255,220,180,1)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Generic point-sprite particle pool (sparks, dust, blood, grenade trail).
// A single Points object with per-particle position/color/size attributes,
// spawned round-robin into a fixed capacity so old particles are silently
// recycled rather than growing without bound.
// ---------------------------------------------------------------------------
class ParticlePool {
  private readonly capacity: number;
  private readonly points: THREE.Points;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly velX: Float32Array;
  private readonly velY: Float32Array;
  private readonly velZ: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly gravityScale: Float32Array;
  private readonly baseSize: Float32Array;
  private cursor = 0;

  constructor(scene: THREE.Scene, capacity: number, dotTex: THREE.Texture) {
    this.capacity = capacity;
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.velX = new Float32Array(capacity);
    this.velY = new Float32Array(capacity);
    this.velZ = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.gravityScale = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    const mat = new THREE.PointsMaterial({
      map: dotTex,
      vertexColors: true,
      size: 1,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  spawn(pos: Vec3, vx: number, vy: number, vz: number, life: number, size: number, color: number, gravityScale: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.positions[i * 3] = pos.x;
    this.positions[i * 3 + 1] = pos.y;
    this.positions[i * 3 + 2] = pos.z;
    const c = TMP_COLOR.set(color);
    this.colors[i * 3] = c.r;
    this.colors[i * 3 + 1] = c.g;
    this.colors[i * 3 + 2] = c.b;
    this.velX[i] = vx;
    this.velY[i] = vy;
    this.velZ[i] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.gravityScale[i] = gravityScale;
    this.baseSize[i] = size;
    this.sizes[i] = size;
  }

  update(dt: number): void {
    let dirty = false;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i]! <= 0) continue;
      dirty = true;
      this.life[i]! -= dt;
      if (this.life[i]! <= 0) {
        this.sizes[i] = 0;
        continue;
      }
      this.velY[i]! -= GRAVITY * this.gravityScale[i]! * dt;
      this.positions[i * 3]! += this.velX[i]! * dt;
      this.positions[i * 3 + 1]! += this.velY[i]! * dt;
      this.positions[i * 3 + 2]! += this.velZ[i]! * dt;
      const t = this.life[i]! / this.maxLife[i]!;
      this.sizes[i] = this.baseSize[i]! * Math.min(1, t * 2);
    }
    if (dirty) {
      (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (this.points.geometry.getAttribute('size') as THREE.BufferAttribute).needsUpdate = true;
    }
  }
}
const TMP_COLOR = new THREE.Color();

// ---------------------------------------------------------------------------
// Decal ring buffer: reused quad meshes offset along the impact normal.
// ---------------------------------------------------------------------------
class DecalPool {
  private readonly meshes: THREE.Mesh[] = [];
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private cursor = 0;
  private readonly capacity: number;

  constructor(scene: THREE.Scene, capacity: number) {
    this.capacity = capacity;
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    const geo = new THREE.PlaneGeometry(0.14, 0.14);
    for (let i = 0; i < capacity; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.meshes.push(mesh);
    }
  }

  spawn(pos: Vec3, normal: Vec3, color: number, life: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const mesh = this.meshes[i]!;
    const n = new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
    mesh.position.set(pos.x + n.x * 0.01, pos.y + n.y * 0.01, pos.z + n.z * 0.01);
    mesh.lookAt(mesh.position.x + n.x, mesh.position.y + n.y, mesh.position.z + n.z);
    mesh.rotation.z = Math.random() * Math.PI * 2;
    (mesh.material as THREE.MeshBasicMaterial).color.set(color);
    (mesh.material as THREE.MeshBasicMaterial).opacity = 0.85;
    mesh.visible = true;
    this.life[i] = life;
    this.maxLife[i] = life;
  }

  update(dt: number): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i]! <= 0) continue;
      this.life[i]! -= dt;
      const mesh = this.meshes[i]!;
      if (this.life[i]! <= 0) {
        mesh.visible = false;
        continue;
      }
      const t = this.life[i]! / this.maxLife[i]!;
      (mesh.material as THREE.MeshBasicMaterial).opacity = 0.85 * Math.min(1, t * 3);
    }
  }
}

// ---------------------------------------------------------------------------
// Casings: a single InstancedMesh, CPU-tracked per-instance kinematics.
// ---------------------------------------------------------------------------
class CasingPool {
  private readonly mesh: THREE.InstancedMesh;
  private readonly capacity: number;
  private readonly px: Float32Array; private readonly py: Float32Array; private readonly pz: Float32Array;
  private readonly vx: Float32Array; private readonly vy: Float32Array; private readonly vz: Float32Array;
  private readonly rx: Float32Array; private readonly ry: Float32Array; private readonly rz: Float32Array;
  private readonly avx: Float32Array; private readonly avy: Float32Array; private readonly avz: Float32Array;
  private readonly life: Float32Array;
  private cursor = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly p = new THREE.Vector3();

  constructor(scene: THREE.Scene, capacity: number, material: THREE.Material) {
    this.capacity = capacity;
    const geo = new THREE.CylinderGeometry(0.005, 0.005, 0.02, 6);
    this.mesh = new THREE.InstancedMesh(geo, material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
    this.px = new Float32Array(capacity); this.py = new Float32Array(capacity); this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity); this.vy = new Float32Array(capacity); this.vz = new Float32Array(capacity);
    this.rx = new Float32Array(capacity); this.ry = new Float32Array(capacity); this.rz = new Float32Array(capacity);
    this.avx = new Float32Array(capacity); this.avy = new Float32Array(capacity); this.avz = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
  }

  spawn(pos: Vec3, dirX: number, dirY: number, dirZ: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.px[i] = pos.x; this.py[i] = pos.y; this.pz[i] = pos.z;
    const speed = 1.2 + Math.random() * 0.8;
    this.vx[i] = dirX * speed + (Math.random() - 0.5) * 0.5;
    this.vy[i] = Math.abs(dirY) * speed + 1.0 + Math.random() * 0.5;
    this.vz[i] = dirZ * speed + (Math.random() - 0.5) * 0.5;
    this.rx[i] = Math.random() * Math.PI; this.ry[i] = Math.random() * Math.PI; this.rz[i] = Math.random() * Math.PI;
    this.avx[i] = (Math.random() - 0.5) * 20; this.avy[i] = (Math.random() - 0.5) * 20; this.avz[i] = (Math.random() - 0.5) * 20;
    this.life[i] = 3;
    if (this.mesh.count < this.capacity) this.mesh.count = this.capacity;
  }

  update(dt: number): void {
    let any = false;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i]! <= 0) {
        this.m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this.m);
        continue;
      }
      any = true;
      this.life[i]! -= dt;
      this.vy[i]! -= GRAVITY * dt;
      this.px[i]! += this.vx[i]! * dt; this.py[i]! += this.vy[i]! * dt; this.pz[i]! += this.vz[i]! * dt;
      if (this.py[i]! < 0) { this.py[i] = 0; this.vy[i]! *= -0.3; this.vx[i]! *= 0.6; this.vz[i]! *= 0.6; }
      this.rx[i]! += this.avx[i]! * dt; this.ry[i]! += this.avy[i]! * dt; this.rz[i]! += this.avz[i]! * dt;
      this.p.set(this.px[i]!, this.py[i]!, this.pz[i]!);
      this.e.set(this.rx[i]!, this.ry[i]!, this.rz[i]!);
      this.q.setFromEuler(this.e);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Tracers: reused thin stretched boxes, short-lived.
// ---------------------------------------------------------------------------
class TracerPool {
  private readonly meshes: THREE.Mesh[] = [];
  private readonly life: Float32Array;
  private cursor = 0;
  private readonly capacity: number;

  constructor(scene: THREE.Scene, capacity: number) {
    this.capacity = capacity;
    this.life = new Float32Array(capacity);
    const geo = new THREE.BoxGeometry(0.015, 0.015, 1);
    geo.translate(0, 0, -0.5);
    for (let i = 0; i < capacity; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xfff2c0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.meshes.push(mesh);
    }
  }

  spawn(from: Vec3, to: Vec3): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const mesh = this.meshes[i]!;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.max(0.01, Math.sqrt(dx * dx + dy * dy + dz * dz));
    mesh.position.set(to.x, to.y, to.z);
    mesh.lookAt(from.x, from.y, from.z);
    mesh.scale.set(1, 1, len);
    mesh.visible = true;
    this.life[i] = 0.06;
  }

  update(dt: number): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i]! <= 0) continue;
      this.life[i]! -= dt;
      if (this.life[i]! <= 0) this.meshes[i]!.visible = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Muzzle flash (remote shooters): pooled sprites + a small shared light pool.
// ---------------------------------------------------------------------------
class FlashSpritePool {
  private readonly sprites: THREE.Sprite[] = [];
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly baseScale: number;
  private cursor = 0;
  private readonly capacity: number;

  constructor(scene: THREE.Scene, capacity: number, tex: THREE.Texture, color: number, baseScale: number) {
    this.capacity = capacity;
    this.baseScale = baseScale;
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    for (let i = 0; i < capacity; i++) {
      const mat = new THREE.SpriteMaterial({ map: tex, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.setScalar(baseScale);
      sprite.visible = false;
      scene.add(sprite);
      this.sprites.push(sprite);
    }
  }

  spawn(pos: Vec3, life: number, scaleMult = 1): THREE.Sprite {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const sprite = this.sprites[i]!;
    sprite.position.set(pos.x, pos.y, pos.z);
    sprite.visible = true;
    sprite.material.opacity = 1;
    sprite.scale.setScalar(this.baseScale * scaleMult);
    this.life[i] = life;
    this.maxLife[i] = life;
    return sprite;
  }

  update(dt: number): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i]! <= 0) continue;
      this.life[i]! -= dt;
      const sprite = this.sprites[i]!;
      if (this.life[i]! <= 0) { sprite.visible = false; continue; }
      sprite.material.opacity = this.life[i]! / this.maxLife[i]!;
    }
  }
}

class LightPool {
  private readonly lights: THREE.PointLight[] = [];
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly baseIntensity: Float32Array;
  private cursor = 0;
  private readonly capacity: number;

  constructor(scene: THREE.Scene, capacity: number, distance: number) {
    this.capacity = capacity;
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.baseIntensity = new Float32Array(capacity);
    for (let i = 0; i < capacity; i++) {
      const light = new THREE.PointLight(0xffaa55, 0, distance, 2);
      scene.add(light);
      this.lights.push(light);
    }
  }

  spawn(pos: Vec3, life: number, intensity: number, color: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const light = this.lights[i]!;
    light.position.set(pos.x, pos.y, pos.z);
    light.color.set(color);
    light.intensity = intensity;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.baseIntensity[i] = intensity;
  }

  update(dt: number): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i]! <= 0) continue;
      this.life[i]! -= dt;
      const light = this.lights[i]!;
      if (this.life[i]! <= 0) { light.intensity = 0; continue; }
      light.intensity = this.baseIntensity[i]! * (this.life[i]! / this.maxLife[i]!);
    }
  }
}

// ---------------------------------------------------------------------------
// Expanding explosion rings.
// ---------------------------------------------------------------------------
class RingPool {
  private readonly meshes: THREE.Mesh[] = [];
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private cursor = 0;
  private readonly capacity: number;

  constructor(scene: THREE.Scene, capacity: number, tex: THREE.Texture) {
    this.capacity = capacity;
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    const geo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < capacity; i++) {
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.meshes.push(mesh);
    }
  }

  spawn(pos: Vec3, life: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const mesh = this.meshes[i]!;
    mesh.position.set(pos.x, pos.y + 0.05, pos.z);
    mesh.scale.setScalar(0.1);
    mesh.visible = true;
    this.life[i] = life;
    this.maxLife[i] = life;
  }

  update(dt: number, maxRadius: number): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i]! <= 0) continue;
      this.life[i]! -= dt;
      const mesh = this.meshes[i]!;
      if (this.life[i]! <= 0) { mesh.visible = false; continue; }
      const t = 1 - this.life[i]! / this.maxLife[i]!;
      mesh.scale.setScalar(0.1 + t * maxRadius);
      (mesh.material as THREE.MeshBasicMaterial).opacity = 1 - t;
    }
  }
}

// ---------------------------------------------------------------------------
// Effects — the public facade used by the render loop.
// ---------------------------------------------------------------------------
export class Effects {
  private readonly quality: Quality;

  private readonly sparks: ParticlePool;
  private readonly decals: DecalPool;
  private readonly casings: CasingPool;
  private readonly tracers: TracerPool;
  private readonly muzzleFlashes: FlashSpritePool;
  private readonly muzzleLights: LightPool;
  private readonly bigFlashes: FlashSpritePool;
  private readonly explosionLights: LightPool;
  private readonly rings: RingPool;
  private readonly smoke: FlashSpritePool;

  private readonly bombMarkerMesh: THREE.Mesh;
  private readonly bombMarkerLight: THREE.PointLight;
  private bombMarkerBlink = 0;

  private tracerShotParity = false;

  constructor(scene: THREE.Scene, materials: MaterialLibrary, quality: Quality) {
    this.quality = quality;
    const dotTex = buildDotTexture();
    const ringTex = buildRingTexture();

    this.sparks = new ParticlePool(scene, scaled(256, quality), dotTex);
    this.decals = new DecalPool(scene, scaled(64, quality));
    this.casings = new CasingPool(scene, scaled(64, quality), materials.gunmetal());
    this.tracers = new TracerPool(scene, scaled(24, quality));
    this.muzzleFlashes = new FlashSpritePool(scene, scaled(8, quality), dotTex, 0xffaa55, 0.35);
    this.muzzleLights = new LightPool(scene, scaled(4, quality), 6);
    this.bigFlashes = new FlashSpritePool(scene, scaled(4, quality), dotTex, 0xffffff, 1);
    this.explosionLights = new LightPool(scene, scaled(2, quality), 14);
    this.rings = new RingPool(scene, scaled(4, quality), ringTex);
    this.smoke = new FlashSpritePool(scene, scaled(24, quality), dotTex, 0x888888, 0.8);

    const markerGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.5, 8);
    const markerMat = new THREE.MeshBasicMaterial({ color: 0xff3333, transparent: true, opacity: 0.8 });
    this.bombMarkerMesh = new THREE.Mesh(markerGeo, markerMat);
    this.bombMarkerMesh.visible = false;
    scene.add(this.bombMarkerMesh);
    this.bombMarkerLight = new THREE.PointLight(0xff3333, 0, 4, 2);
    scene.add(this.bombMarkerLight);
  }

  /** World-space muzzle flash for a remote shooter (the local shooter's own flash is on the viewmodel). */
  muzzleFlash(pos: Vec3, dir: Vec3): void {
    const flashPos: Vec3 = { x: pos.x + dir.x * 0.05, y: pos.y + dir.y * 0.05, z: pos.z + dir.z * 0.05 };
    this.muzzleFlashes.spawn(flashPos, 0.04);
    this.muzzleLights.spawn(flashPos, 0.05, 4, 0xffaa55);
  }

  /** Additive stretched-quad tracer; internally fires on ~1 in 2 calls per the plan. */
  tracer(from: Vec3, to: Vec3, _weaponId: number): void {
    this.tracerShotParity = !this.tracerShotParity;
    if (!this.tracerShotParity) return;
    this.tracers.spawn(from, to);
  }

  /** Sparks/dust burst plus an 8s decal, coloured by MAT_*. */
  impact(pos: Vec3, normal: Vec3, material: number): void {
    const colors = colorFor(material);
    const sparkCount = material === MAT_METAL ? 10 : 6;
    for (let i = 0; i < sparkCount; i++) {
      const spreadX = (Math.random() - 0.5) * 2 + normal.x * 1.5;
      const spreadY = Math.random() * 1.5 + normal.y * 1.5 + 0.5;
      const spreadZ = (Math.random() - 0.5) * 2 + normal.z * 1.5;
      this.sparks.spawn(pos, spreadX, spreadY, spreadZ, 0.25 + Math.random() * 0.15, 0.03, colors.spark, 1.2);
    }
    for (let i = 0; i < 4; i++) {
      const spreadX = (Math.random() - 0.5) * 0.6 + normal.x * 0.3;
      const spreadY = Math.random() * 0.4 + normal.y * 0.3;
      const spreadZ = (Math.random() - 0.5) * 0.6 + normal.z * 0.3;
      this.sparks.spawn(pos, spreadX, spreadY, spreadZ, 0.6 + Math.random() * 0.3, 0.05, colors.dust, 0.3);
    }
    this.decals.spawn(pos, normal, colors.decal, 8);
  }

  /** Ejected shell casing with gravity, settling after a short bounce. */
  casing(pos: Vec3, dir: Vec3): void {
    this.casings.spawn(pos, dir.x, dir.y, dir.z);
  }

  /** Frag/explosive detonation: flash, expanding ring, smoke billboards, brief light. */
  explosion(pos: Vec3): void {
    this.bigFlashes.spawn(pos, 0.15, 1.2);
    this.rings.spawn(pos, 0.5);
    this.explosionLights.spawn(pos, 0.1, 8, 0xffaa33);
    const smokeCount = scaled(12, this.quality);
    for (let i = 0; i < smokeCount; i++) {
      const angle = (i / smokeCount) * Math.PI * 2;
      const r = 0.3 + Math.random() * 0.5;
      const sp: Vec3 = { x: pos.x + Math.cos(angle) * r, y: pos.y + 0.2, z: pos.z + Math.sin(angle) * r };
      this.smoke.spawn(sp, 1.5, 0.6 + Math.random() * 0.4);
    }
  }

  /** Flashbang white-out burst (no damage/blind logic here — purely visual). */
  flashBang(pos: Vec3): void {
    this.bigFlashes.spawn(pos, 0.25, 2.2);
  }

  /** Dark red particle puff on a body hit. */
  bloodPuff(pos: Vec3): void {
    for (let i = 0; i < 8; i++) {
      const vx = (Math.random() - 0.5) * 1.5;
      const vy = Math.random() * 1.2 + 0.3;
      const vz = (Math.random() - 0.5) * 1.5;
      this.sparks.spawn(pos, vx, vy, vz, 0.4 + Math.random() * 0.2, 0.035, MATERIAL_COLOR[MAT_FLESH]!.dust, 1.0);
    }
  }

  /** One small dust puff per call; call once per rendered frame while a grenade is in flight. */
  grenadeTrail(pos: Vec3): void {
    this.sparks.spawn(pos, 0, 0, 0, 0.3, 0.02, 0x999999, 0.1);
  }

  /** Persistent bomb-site marker; blinks red once planted. */
  bombMarker(pos: Vec3, planted: boolean): void {
    this.bombMarkerMesh.visible = true;
    this.bombMarkerMesh.position.set(pos.x, pos.y + 0.25, pos.z);
    const mat = this.bombMarkerMesh.material as THREE.MeshBasicMaterial;
    mat.color.set(planted ? 0xff2222 : 0xffaa22);
    this.bombMarkerLight.position.set(pos.x, pos.y + 0.4, pos.z);
    this.bombMarkerLight.color.set(planted ? 0xff2222 : 0xffaa22);
    this.bombMarkerLight.intensity = planted ? 2 : 1;
  }

  update(dt: number, _camPos: Vec3): void {
    this.sparks.update(dt);
    this.decals.update(dt);
    this.casings.update(dt);
    this.tracers.update(dt);
    this.muzzleFlashes.update(dt);
    this.muzzleLights.update(dt);
    this.bigFlashes.update(dt);
    this.explosionLights.update(dt);
    this.rings.update(dt, 3.5);
    this.smoke.update(dt);

    if (this.bombMarkerMesh.visible) {
      this.bombMarkerBlink += dt;
      const pulse = 0.6 + 0.4 * Math.sin(this.bombMarkerBlink * 6);
      (this.bombMarkerMesh.material as THREE.MeshBasicMaterial).opacity = pulse;
    }
  }
}
