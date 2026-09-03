// Prop model lookup + cloning for map-builder.ts, with primitive-geometry
// fallbacks so the map still reads correctly when a prop failed to download.
import * as THREE from 'three';
import type { GameAssets } from '../assets/loader.ts';

function fallbackMaterial(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0.05 });
}

function normalizeId(id: string): string {
  return id.toLowerCase().replace(/^prop_/, '');
}

export class PropLibrary {
  private readonly assets: GameAssets;

  constructor(assets: GameAssets) {
    this.assets = assets;
  }

  /** True when a real (downloaded) model exists for this prop id. */
  available(propId: string): boolean {
    return this.resolve(propId) != null;
  }

  /** Returns a shadow-casting clone of the prop, or a primitive fallback shape
   * built from the id's name (never null — the map always has something to draw). */
  get(propId: string): THREE.Object3D {
    const source = this.resolve(propId);
    const object = source ? source.clone(true) : this.buildFallback(propId);
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    return object;
  }

  private resolve(propId: string): THREE.Object3D | null {
    const direct = this.assets.props.get(propId);
    if (direct) return direct;

    const norm = normalizeId(propId);
    for (const [key, obj] of this.assets.props) {
      if (normalizeId(key) === norm) return obj;
    }
    return null;
  }

  private buildFallback(propId: string): THREE.Object3D {
    const id = propId.toLowerCase();
    const group = new THREE.Group();
    let mesh: THREE.Mesh;

    if (id.includes('barrel')) {
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.85, 12), fallbackMaterial(0x555b52));
      mesh.position.y = 0.425;
    } else if (id.includes('bag')) {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.3), fallbackMaterial(0x8a7f63));
      mesh.position.y = 0.175;
    } else if (id.includes('light')) {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), fallbackMaterial(0x222222));
      mesh.position.y = 0.15;
    } else if (id.includes('ammo')) {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.3), fallbackMaterial(0x3a4a2e));
      mesh.position.y = 0.15;
    } else {
      // Generic crate/cardboard-box shape for anything unrecognized.
      mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), fallbackMaterial(0x9c8a63));
      mesh.position.y = 0.25;
    }

    group.add(mesh);
    return group;
  }
}
