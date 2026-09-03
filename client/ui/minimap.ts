// Rotating 120px minimap. The static floor plan (walls/floors by tag, site
// letters) is rendered once into an offscreen canvas from the MapLayout at
// construction time; update() only redraws the small visible canvas each
// frame, transformed so the player is centered and facing screen-up. Plan §7.

import { yawPitchToDir } from '../../shared/math.ts';
import type { Vec3 } from '../../shared/types.ts';
import type { SnapshotPlayer } from '../../shared/types.ts';
import type { MapLayout, Site } from '../../shared/map/types.ts';

const STATIC_SIZE = 512;

export class Minimap {
  readonly element: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly staticCanvas: HTMLCanvasElement;
  private readonly size: number;
  private readonly scale: number;
  private readonly originX: number;
  private readonly originZ: number;
  private readonly sites: readonly Site[];
  private readonly scratch: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(layout: MapLayout, size = 120) {
    this.size = size;
    this.sites = layout.sites;
    this.element = document.createElement('canvas');
    this.element.width = size;
    this.element.height = size;
    this.element.className = 'minimap-canvas';
    const ctx = this.element.getContext('2d');
    if (!ctx) throw new Error('minimap: 2d context unavailable');
    this.ctx = ctx;

    const maxDim = Math.max(layout.width, layout.depth, 1);
    this.scale = STATIC_SIZE / maxDim;
    this.originX = -layout.width / 2;
    this.originZ = -layout.depth / 2;

    this.staticCanvas = document.createElement('canvas');
    this.staticCanvas.width = STATIC_SIZE;
    this.staticCanvas.height = STATIC_SIZE;
    this.paintStatic(layout);
  }

  private worldToStatic(x: number, z: number): [number, number] {
    return [(x - this.originX) * this.scale, (z - this.originZ) * this.scale];
  }

  private paintStatic(layout: MapLayout): void {
    const sctx = this.staticCanvas.getContext('2d');
    if (!sctx) return;
    sctx.fillStyle = '#14171b';
    sctx.fillRect(0, 0, STATIC_SIZE, STATIC_SIZE);

    for (const box of layout.boxes) {
      const [x0, y0] = this.worldToStatic(box.x, box.z);
      const w = box.w * this.scale;
      const d = box.d * this.scale;
      sctx.fillStyle = box.tag === 'floor' || box.tag === 'catwalk' ? '#23282f' : '#3a4048';
      sctx.fillRect(x0, y0, w, d);
    }

    // Site markers, drawn on top so they read clearly against the floor plan.
    sctx.font = 'bold 20px sans-serif';
    sctx.textAlign = 'center';
    sctx.textBaseline = 'middle';
    for (const site of layout.sites) {
      const [sx, sz] = this.worldToStatic(site.x, site.z);
      const r = Math.max(6, site.radius * this.scale);
      sctx.strokeStyle = '#f2b134';
      sctx.lineWidth = 2;
      sctx.beginPath();
      sctx.arc(sx, sz, r, 0, Math.PI * 2);
      sctx.stroke();
      sctx.fillStyle = '#f2b134';
      sctx.fillText(String.fromCharCode(65 + site.id), sx, sz);
    }
  }

  update(
    localPos: Vec3,
    localYaw: number,
    players: Iterable<SnapshotPlayer>,
    localId: number,
    localTeam: number,
    revealedIds: Set<number>,
    sites: readonly Site[],
    bombPos: Vec3 | null,
  ): void {
    const ctx = this.ctx;
    const s = this.size;
    ctx.save();
    ctx.clearRect(0, 0, s, s);
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
    ctx.clip();

    // Rotate the whole map so the player's forward direction points to screen-up.
    yawPitchToDir(localYaw, 0, this.scratch);
    const fx = this.scratch.x;
    const fz = this.scratch.z;
    const rot = Math.atan2(-fx, -fz);

    const [px, pz] = this.worldToStatic(localPos.x, localPos.z);
    ctx.translate(s / 2, s / 2);
    ctx.rotate(rot);
    ctx.translate(-px, -pz);
    ctx.drawImage(this.staticCanvas, 0, 0);

    // Bomb icon.
    if (bombPos) {
      const [bx, bz] = this.worldToStatic(bombPos.x, bombPos.z);
      ctx.fillStyle = '#d64541';
      ctx.beginPath();
      ctx.arc(bx, bz, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Players: teammates always shown as directional arrows, enemies only
    // when fire-revealed (Ghost perk hides them entirely; that filtering is
    // the caller's job via `revealedIds`).
    for (const p of players) {
      if (p.id === localId || !p.alive) continue;
      const isTeammate = p.team === localTeam;
      if (!isTeammate && !revealedIds.has(p.id)) continue;
      const [wx, wz] = this.worldToStatic(p.pos.x, p.pos.z);
      ctx.save();
      ctx.translate(wx, wz);
      // Already inside the map's rotated coordinate frame (the ctx.rotate(rot)
      // above), so the arrow only needs its own bearing in the same convention.
      yawPitchToDir(p.yaw, 0, this.scratch);
      ctx.rotate(Math.atan2(-this.scratch.x, -this.scratch.z));
      ctx.fillStyle = isTeammate ? '#2f7bd6' : '#d64541';
      ctx.beginPath();
      ctx.moveTo(0, -5);
      ctx.lineTo(3.5, 4);
      ctx.lineTo(-3.5, 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();

    // Local player: fixed at center, always pointing up.
    ctx.save();
    ctx.translate(s / 2, s / 2);
    ctx.fillStyle = '#f2b134';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4, 5);
    ctx.lineTo(-4, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
