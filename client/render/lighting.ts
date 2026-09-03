// Desktop: HDRI-driven IBL (PMREM) + a 2-cascade CSM sun, with a hard guard
// against the iPhone Safari bug where PMREM from a float HDR renders solid
// black. Mobile (and the guard's fallback): a flat gradient sky, a hemisphere
// fill and one simple shadow-casting directional light that follows the
// camera. Fog is the same exp2 rig on both tiers.
import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import type { GameAssets } from '../assets/loader.ts';
import type { Quality, Renderer } from './renderer.ts';

export interface Lighting {
  /** A real DirectionalLight in the scene: csm.lights[0] on desktop, the
   * simple camera-following light on mobile / after the PMREM guard fires. */
  sun: THREE.DirectionalLight;
  /** Non-null only on desktop, where the sun is cascaded shadow mapping. */
  csm: CSM | null;
  /** Call once per frame, after the main camera's transform is finalized for
   * the frame and before Renderer.render(). */
  update(cameraPos: THREE.Vector3): void;
  /** True if the HDRI's PMREM environment map is in use (false whenever the
   * gradient-sky fallback rig is active, for whatever reason). */
  usingHdri: boolean;
  dispose(): void;
}

const FOG_COLOR = 0x8fa3b5;
const FOG_DENSITY = 0.004;

// abandoned_parking's sun is roughly at this azimuth/elevation.
const SUN_AZIMUTH_DEG = 210;
const SUN_ELEVATION_DEG = 40;
const SUN_COLOR = 0xfff1dc;

const CSM_CASCADES = 2;
const CSM_MAX_FAR = 90;
const CSM_SHADOW_MAP_SIZE = 2048;
const CSM_LIGHT_INTENSITY = 3;

const FALLBACK_SKY_COLOR = 0x9fb4c8;
const FALLBACK_HEMI_SKY = 0xcfe0f2;
const FALLBACK_HEMI_GROUND = 0x4a4034;
const FALLBACK_HEMI_INTENSITY = 0.9;
const FALLBACK_SUN_INTENSITY = 2.2;
const FALLBACK_SHADOW_MAP_SIZE_DESKTOP = 2048;
const FALLBACK_SHADOW_MAP_SIZE_MOBILE = 1024;
const FALLBACK_SHADOW_BOX_METRES = 30;
const FALLBACK_SUN_DISTANCE = 60;

const HEMI_FILL_SKY = 0x8fa3b5;
const HEMI_FILL_GROUND = 0x2b2a26;
const HEMI_FILL_INTENSITY = 0.35;

/** Direction FROM the origin TOWARD the sun (unit vector, +Y up). */
function sunDirectionFromAzEl(azimuthDeg: number, elevationDeg: number): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  const horizontal = Math.cos(el);
  return new THREE.Vector3(horizontal * Math.sin(az), Math.sin(el), -horizontal * Math.cos(az)).normalize();
}

function configureOrthoShadow(light: THREE.DirectionalLight, halfSize: number, near: number, far: number): void {
  const cam = light.shadow.camera;
  cam.left = -halfSize;
  cam.right = halfSize;
  cam.top = halfSize;
  cam.bottom = -halfSize;
  cam.near = near;
  cam.far = far;
  cam.updateProjectionMatrix();
}

/** Renders a tiny lit sphere against the candidate environment map and reads
 * its pixels back — the only reliable way to detect the iPhone PMREM-goes-
 * black bug, since the texture "loads" successfully either way. */
function measureEnvLuminance(gl: THREE.WebGLRenderer, envMap: THREE.Texture): number {
  const size = 4;
  const rt = new THREE.WebGLRenderTarget(size, size);
  const scene = new THREE.Scene();
  scene.environment = envMap;
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
  camera.position.set(0, 0, 2);
  const geometry = new THREE.SphereGeometry(0.5, 8, 8);
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.0 });
  const sphere = new THREE.Mesh(geometry, material);
  scene.add(sphere);

  const previousTarget = gl.getRenderTarget();
  gl.setRenderTarget(rt);
  gl.render(scene, camera);
  const buffer = new Uint8Array(size * size * 4);
  gl.readRenderTargetPixels(rt, 0, 0, size, size, buffer);
  gl.setRenderTarget(previousTarget);

  rt.dispose();
  geometry.dispose();
  material.dispose();

  let sum = 0;
  for (let i = 0; i < buffer.length; i += 4) {
    sum += (buffer[i]! + buffer[i + 1]! + buffer[i + 2]!) / 3;
  }
  return sum / (size * size);
}

/** Attempts PMREM IBL from the HDRI; returns null (and cleans up) if the
 * capability check or the black-environment probe fails. */
function tryBuildIbl(gl: THREE.WebGLRenderer, hdri: THREE.DataTexture): THREE.Texture | null {
  const hasHalfFloat = gl.extensions.has('EXT_color_buffer_half_float');
  const hasFloatLinear = gl.extensions.has('OES_texture_float_linear');
  if (!hasHalfFloat && !hasFloatLinear) return null;

  const pmrem = new THREE.PMREMGenerator(gl);
  pmrem.compileEquirectangularShader();
  const renderTarget = pmrem.fromEquirectangular(hdri);
  const envMap = renderTarget.texture;

  const luminance = measureEnvLuminance(gl, envMap);
  pmrem.dispose();

  if (luminance < 2) {
    envMap.dispose();
    return null;
  }
  return envMap;
}

/** Flat gradient sky + hemisphere fill + one simple shadow-casting sun, used
 * on mobile always and on desktop whenever the PMREM guard fires. */
function applyFallbackSky(scene: THREE.Scene, quality: Quality, lightDir: THREE.Vector3): { hemi: THREE.HemisphereLight; sun: THREE.DirectionalLight } {
  scene.environment = null;
  scene.background = new THREE.Color(FALLBACK_SKY_COLOR);

  const hemi = new THREE.HemisphereLight(FALLBACK_HEMI_SKY, FALLBACK_HEMI_GROUND, FALLBACK_HEMI_INTENSITY);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(SUN_COLOR, FALLBACK_SUN_INTENSITY);
  sun.castShadow = true;
  const mapSize = quality === 'desktop' ? FALLBACK_SHADOW_MAP_SIZE_DESKTOP : FALLBACK_SHADOW_MAP_SIZE_MOBILE;
  sun.shadow.mapSize.set(mapSize, mapSize);
  sun.shadow.bias = -0.0015;
  configureOrthoShadow(sun, FALLBACK_SHADOW_BOX_METRES, 1, FALLBACK_SUN_DISTANCE * 2);
  scene.add(sun);
  scene.add(sun.target);
  positionFollowLight(sun, lightDir, new THREE.Vector3(0, 0, 0));

  return { hemi, sun };
}

function positionFollowLight(light: THREE.DirectionalLight, lightDir: THREE.Vector3, targetPos: THREE.Vector3): void {
  light.target.position.copy(targetPos);
  light.position.set(
    targetPos.x - lightDir.x * FALLBACK_SUN_DISTANCE,
    targetPos.y - lightDir.y * FALLBACK_SUN_DISTANCE,
    targetPos.z - lightDir.z * FALLBACK_SUN_DISTANCE,
  );
  light.target.updateMatrixWorld();
}

export function setupLighting(renderer: Renderer, assets: GameAssets, quality: Quality): Lighting {
  const scene = renderer.scene;
  scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);

  const sunDir = sunDirectionFromAzEl(SUN_AZIMUTH_DEG, SUN_ELEVATION_DEG);
  const lightDir = sunDir.clone().negate(); // direction the light travels (into the scene)

  let usingHdri = false;
  let csm: CSM | null = null;
  let sun: THREE.DirectionalLight;
  let mobileSun: THREE.DirectionalLight | null = null;
  let hemiFill: THREE.HemisphereLight | null = null;

  if (quality === 'desktop') {
    let envMap: THREE.Texture | null = null;
    if (assets.hdri) {
      envMap = tryBuildIbl(renderer.three, assets.hdri);
    }
    if (envMap) {
      scene.environment = envMap;
      scene.background = envMap;
      usingHdri = true;
      hemiFill = new THREE.HemisphereLight(HEMI_FILL_SKY, HEMI_FILL_GROUND, HEMI_FILL_INTENSITY);
      scene.add(hemiFill);
      csm = new CSM({
        camera: renderer.camera,
        parent: scene,
        cascades: CSM_CASCADES,
        maxFar: CSM_MAX_FAR,
        mode: 'practical',
        shadowMapSize: CSM_SHADOW_MAP_SIZE,
        lightDirection: lightDir,
        lightIntensity: CSM_LIGHT_INTENSITY,
      });
      for (const light of csm.lights) {
        light.color.set(SUN_COLOR);
        light.castShadow = true;
        light.shadow.bias = -0.00015;
      }
      sun = csm.lights[0] ?? new THREE.DirectionalLight(SUN_COLOR, CSM_LIGHT_INTENSITY);
    } else {
      // IBL unavailable (no HDRI, or the iPhone PMREM guard tripped): one plain
      // shadow-casting sun, no CSM, exactly like the mobile tier.
      const fallback = applyFallbackSky(scene, quality, lightDir);
      hemiFill = fallback.hemi;
      mobileSun = fallback.sun;
      sun = fallback.sun;
    }

  } else {
    const fallback = applyFallbackSky(scene, quality, lightDir);
    hemiFill = fallback.hemi;
    mobileSun = fallback.sun;
    sun = fallback.sun;
  }

  const update = (cameraPos: THREE.Vector3): void => {
    if (csm) {
      csm.update();
    } else if (mobileSun) {
      positionFollowLight(mobileSun, lightDir, cameraPos);
    }
  };

  const dispose = (): void => {
    csm?.dispose();
    if (mobileSun) { scene.remove(mobileSun); mobileSun.dispose(); }
    if (scene.environment && scene.environment !== scene.background) scene.environment.dispose?.();
    if (scene.background instanceof THREE.Texture) scene.background.dispose();
    hemiFill?.dispose();
  };

  return { sun, csm, update, usingHdri, dispose };
}
