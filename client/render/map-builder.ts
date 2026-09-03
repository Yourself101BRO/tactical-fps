// Turns a declarative MapLayout into renderable three.js geometry: boxes and
// ramps merged per-material into as few draw calls as possible, a ground
// plane, props, site markers and point lights. UVs are generated in world
// units via per-face box projection so textures tile seamlessly across
// separately-declared boxes that share an edge.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Box, LightPlacement, MapLayout, PropPlacement, Ramp, Site } from '../../shared/map/types.ts';
import { MAT_CONCRETE } from '../../shared/constants.ts';
import { MaterialLibrary } from './materials.ts';
import { PropLibrary } from './props.ts';
import type { Quality } from './renderer.ts';

export interface BuiltMap {
  group: THREE.Group;
  lights: THREE.Light[];
}

const DEFAULT_REPEAT_METRES = 2.5;
const REPEAT_METRES_BY_MATERIAL: Partial<Record<number, number>> = {
  [MAT_CONCRETE]: 3,
};
const MOBILE_MAX_LIGHTS = 4;
const SITE_LETTERS = ['A', 'B', 'C', 'D'];

export function buildMap(layout: MapLayout, materials: MaterialLibrary, props: PropLibrary, quality: Quality): BuiltMap {
  const group = new THREE.Group();
  group.name = `map:${layout.name}`;

  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const pushGeom = (mat: THREE.Material, geom: THREE.BufferGeometry): void => {
    let list = buckets.get(mat);
    if (!list) {
      list = [];
      buckets.set(mat, list);
    }
    list.push(geom);
  };

  for (const box of layout.boxes) {
    pushGeom(resolveBoxMaterial(box, materials), buildBoxGeometry(box));
  }
  for (const ramp of layout.ramps) {
    pushGeom(materials.forMaterialId(ramp.material), buildRampGeometry(ramp));
  }

  for (const [mat, geoms] of buckets) {
    const merged = mergeGeometries(geoms, false);
    for (const g of geoms) g.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  group.add(buildGroundPlane(layout, materials));

  placeProps(group, layout, props);

  for (const site of layout.sites) group.add(buildSiteMarker(site));

  const lights = placeLights(group, layout, props, quality);

  return { group, lights };
}

// ---------------------------------------------------------------------------
// Material resolution
// ---------------------------------------------------------------------------

function repeatFor(material: number): number {
  return REPEAT_METRES_BY_MATERIAL[material] ?? DEFAULT_REPEAT_METRES;
}

function isFloorTag(tag: string | undefined): boolean {
  return tag === 'floor' || tag === 'ground' || tag === 'catwalk';
}

function resolveBoxMaterial(box: Box, materials: MaterialLibrary): THREE.MeshStandardMaterial {
  if (box.texture) return materials.surface(box.texture, repeatFor(box.material));
  // Concrete has distinct floor vs. wall surfaces; every other material uses
  // one default surface regardless of orientation.
  if (box.material === MAT_CONCRETE && isFloorTag(box.tag)) {
    return materials.surface('concrete_floor_01', repeatFor(box.material));
  }
  return materials.forMaterialId(box.material);
}

// ---------------------------------------------------------------------------
// Geometry: boxes
// ---------------------------------------------------------------------------

function buildBoxGeometry(box: Box): THREE.BufferGeometry {
  const geom = new THREE.BoxGeometry(box.w, box.h, box.d);
  geom.translate(box.x + box.w / 2, box.y + box.h / 2, box.z + box.d / 2);
  applyPlanarWorldUV(geom);
  return geom;
}

/** Recomputes UVs in world-space metres via per-face box projection (dominant
 * normal axis picks the projection plane), so tiling repeat is uniform and
 * seamless across every box using the same material, regardless of size. */
function applyPlanarWorldUV(geom: THREE.BufferGeometry): void {
  const pos = geom.getAttribute('position');
  const nrm = geom.getAttribute('normal');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = nrm.getX(i);
    const ny = nrm.getY(i);
    const nz = nrm.getZ(i);
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);

    let u: number;
    let v: number;
    if (ax >= ay && ax >= az) {
      u = nx >= 0 ? -z : z;
      v = y;
    } else if (ay >= ax && ay >= az) {
      u = x;
      v = ny >= 0 ? -z : z;
    } else {
      u = nz >= 0 ? x : -x;
      v = y;
    }
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
}

// ---------------------------------------------------------------------------
// Geometry: ramps
// ---------------------------------------------------------------------------

type P3 = [number, number, number];

/** Builds a wedge (triangular prism): a flat bottom at box.y, a sloped top
 * surface rising from the low edge (height y) to the high edge (height y+h)
 * per Ramp.dir, a vertical back wall closing the high edge, and two
 * triangular side walls. Winding is corrected afterward (fixOutwardWinding)
 * rather than hand-derived per direction, since the four `dir` cases are
 * mirror images of each other and easy to get backwards by hand. */
function buildRampGeometry(ramp: Ramp): THREE.BufferGeometry {
  const { x, y, z, w, h, d, dir } = ramp;
  const x0 = x;
  const x1 = x + w;
  const y0 = y;
  const y1 = y + h;
  const z0 = z;
  const z1 = z + d;

  // lowA/lowB are the two ends of the low (height y0) edge; highA/highB the
  // two ends of the high (height y1) edge, ordered so A/B share the same
  // side (z0 or x0) between low and high.
  let lowA: P3, lowB: P3, highA: P3, highB: P3;
  if (dir === 0) {
    // Rises along +X.
    lowA = [x0, y0, z0]; lowB = [x0, y0, z1];
    highA = [x1, y1, z0]; highB = [x1, y1, z1];
  } else if (dir === 2) {
    // Rises along -X.
    lowA = [x1, y0, z0]; lowB = [x1, y0, z1];
    highA = [x0, y1, z0]; highB = [x0, y1, z1];
  } else if (dir === 1) {
    // Rises along +Z.
    lowA = [x0, y0, z0]; lowB = [x1, y0, z0];
    highA = [x0, y1, z1]; highB = [x1, y1, z1];
  } else {
    // dir === 3: rises along -Z.
    lowA = [x0, y0, z1]; lowB = [x1, y0, z1];
    highA = [x0, y1, z0]; highB = [x1, y1, z0];
  }

  const bottom: P3[] = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]];
  const top: P3[] = [lowA, lowB, highB, highA];
  const back: P3[] = [[highA[0], y0, highA[2]], [highB[0], y0, highB[2]], highB, highA];
  const sideA: P3[] = [[lowA[0], y0, lowA[2]], [highA[0], y0, highA[2]], highA];
  const sideB: P3[] = [[lowB[0], y0, lowB[2]], highB, [highB[0], y0, highB[2]]];

  const positions: number[] = [];
  const indices: number[] = [];
  const addPolygon = (pts: P3[]): void => {
    const start = positions.length / 3;
    for (const p of pts) positions.push(p[0], p[1], p[2]);
    for (let i = 1; i < pts.length - 1; i++) indices.push(start, start + i, start + i + 1);
  };
  addPolygon(bottom);
  addPolygon(top);
  addPolygon(back);
  addPolygon(sideA);
  addPolygon(sideB);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);

  fixOutwardWinding(geom, x + w / 2, y + h / 2, z + d / 2);
  geom.computeVertexNormals();
  applyPlanarWorldUV(geom);
  return geom;
}

/** Flips any triangle whose face normal points toward (cx,cy,cz) — i.e. makes
 * every face wind so its normal points away from the solid's centre. */
function fixOutwardWinding(geom: THREE.BufferGeometry, cx: number, cy: number, cz: number): void {
  const pos = geom.getAttribute('position');
  const index = geom.getIndex();
  if (!index) return;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < index.count; i += 3) {
    const ia = index.getX(i);
    const ib = index.getX(i + 1);
    const ic = index.getX(i + 2);
    a.fromBufferAttribute(pos, ia);
    b.fromBufferAttribute(pos, ib);
    c.fromBufferAttribute(pos, ic);
    e1.subVectors(b, a);
    e2.subVectors(c, a);
    n.crossVectors(e1, e2);
    const centroidX = (a.x + b.x + c.x) / 3;
    const centroidY = (a.y + b.y + c.y) / 3;
    const centroidZ = (a.z + b.z + c.z) / 3;
    const toCenterX = cx - centroidX;
    const toCenterY = cy - centroidY;
    const toCenterZ = cz - centroidZ;
    if (n.x * toCenterX + n.y * toCenterY + n.z * toCenterZ > 0) {
      index.setX(i + 1, ic);
      index.setX(i + 2, ib);
    }
  }
  index.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Ground plane
// ---------------------------------------------------------------------------

function buildGroundPlane(layout: MapLayout, materials: MaterialLibrary): THREE.Mesh {
  const size = Math.max(layout.width, layout.depth) * 6;
  const geom = new THREE.PlaneGeometry(size, size, 1, 1);
  geom.rotateX(-Math.PI / 2);
  applyPlanarWorldUV(geom);
  const mat = materials.forMaterialId(layout.groundMaterial);
  const mesh = new THREE.Mesh(geom, mat);
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  return mesh;
}

// ---------------------------------------------------------------------------
// Props: instanced when a prop id repeats, individual clones otherwise
// ---------------------------------------------------------------------------

function placeProps(group: THREE.Group, layout: MapLayout, props: PropLibrary): void {
  const byId = new Map<string, PropPlacement[]>();
  for (const placement of layout.props) {
    let list = byId.get(placement.prop);
    if (!list) {
      list = [];
      byId.set(placement.prop, list);
    }
    list.push(placement);
  }

  for (const [propId, placements] of byId) {
    if (placements.length > 1) {
      const instanced = tryBuildInstanced(propId, placements, props);
      if (instanced) {
        group.add(...instanced);
        continue;
      }
    }
    for (const placement of placements) {
      const obj = props.get(propId);
      obj.position.set(placement.x, placement.y, placement.z);
      obj.rotation.y = placement.yaw;
      if (placement.scale) obj.scale.setScalar(placement.scale);
      group.add(obj);
    }
  }
}

/** Instances a prop across every placement when its model is a single mesh
 * (the common case for the low-poly OpenGameArt/Poly Haven props this game
 * uses). Multi-mesh models (e.g. a fixture with separate cage + bulb meshes)
 * fall back to individual clones — still correct, just one draw call each. */
function tryBuildInstanced(propId: string, placements: PropPlacement[], props: PropLibrary): THREE.Object3D[] | null {
  const sample = props.get(propId);
  const meshes: THREE.Mesh[] = [];
  sample.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) meshes.push(mesh);
  });
  if (meshes.length !== 1) return null;

  const source = meshes[0]!;
  const instanced = new THREE.InstancedMesh(source.geometry, source.material, placements.length);
  instanced.castShadow = true;
  instanced.receiveShadow = true;
  instanced.name = `props:${propId}`;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const euler = new THREE.Euler();
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i]!;
    euler.set(0, p.yaw, 0);
    q.setFromEuler(euler);
    s.setScalar(p.scale ?? 1);
    m.compose(new THREE.Vector3(p.x, p.y, p.z), q, s);
    instanced.setMatrixAt(i, m);
  }
  instanced.instanceMatrix.needsUpdate = true;

  return [instanced];
}

// ---------------------------------------------------------------------------
// Site markers
// ---------------------------------------------------------------------------

function buildSiteMarker(site: Site): THREE.Group {
  const group = new THREE.Group();
  group.name = `site:${site.name}`;

  const ringGeom = new THREE.RingGeometry(site.radius * 0.85, site.radius, 32);
  ringGeom.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xffaa33,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.position.set(site.x, site.y + 0.03, site.z);
  group.add(ring);

  const label = SITE_LETTERS[site.id] ?? site.name.charAt(0).toUpperCase();
  const sprite = buildLetterSprite(label);
  sprite.position.set(site.x, site.y + 2.4, site.z);
  group.add(sprite);

  return group;
}

function buildLetterSprite(letter: string): THREE.Sprite {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(20,20,20,0.35)';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffaa33';
    ctx.font = `bold ${Math.round(size * 0.55)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, size / 2, size / 2 + 4);
  }
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.setScalar(1.1);
  return sprite;
}

// ---------------------------------------------------------------------------
// Lights
// ---------------------------------------------------------------------------

function placeLights(group: THREE.Group, layout: MapLayout, props: PropLibrary, quality: Quality): THREE.Light[] {
  const lights: THREE.Light[] = [];
  const maxLights = quality === 'mobile' ? MOBILE_MAX_LIGHTS : layout.lights.length;

  for (const spec of layout.lights) {
    if (lights.length >= maxLights) break;
    lights.push(...placeOneLight(group, spec, props));
  }
  return lights;
}

function placeOneLight(group: THREE.Group, spec: LightPlacement, props: PropLibrary): THREE.Light[] {
  const light = new THREE.PointLight(spec.color, spec.intensity, spec.range, 2);
  light.position.set(spec.x, spec.y, spec.z);
  // Point lights never cast shadows: the sun (CSM on desktop, one shadow map
  // on mobile) carries all shadow cost; per-light cubemap shadows would blow
  // the draw/GPU budget at the light counts this map uses.
  light.castShadow = false;
  group.add(light);

  if (spec.fixture) {
    const fixture = props.get(spec.fixture);
    fixture.position.set(spec.x, spec.y, spec.z);
    group.add(fixture);
  }

  return [light];
}
