// Rotating 120px minimap. The static floor plan (walls/floors by tag, site
// letters) is rendered once into an offscreen canvas from the MapLayout at
// construction time; update() only redraws the small visible canvas each
// frame, transformed so the player is centered and facing screen-up. Plan §7.

import { TEAM_A, TEAM_B } from '../../shared/constants.ts';
import { yawPitchToDir } from '../../shared/math.ts';
import type { Vec3 } from '../../shared/types.ts';
import type { SnapshotPlayer } from '../../shared/types.ts';
import type { MapLayout, Site } from '../../shared/map/types.ts';

const STATIC_SIZE = 512;

// Design tokens (kept in sync with the palette in hud.css / styles.css —
// canvas fills can't read CSS custom properties, so the hex values are
// duplicated here deliberately).
const COL_BG = '#13161b';
const COL_FLOOR = '#1c2026';
const COL_WALL = '#3a4048';
const COL_ACCENT = '#f2b134';
const COL_TEAM_A = '#2f7bd6';
const COL_TEAM_B = '#d6532f';
const COL_DANGER = '#d64541';

/** Team identity is drawn as both a color AND a distinct blip shape — never
 * color alone: TEAM_A reads as a triangle, TEAM_B as a diamond, anything
 * else (FFA) as a plain dot. */
function drawBlip(ctx: CanvasRenderingContext2D, team: number, color: string, ringed: boolean): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (team === TEAM_B) {
    ctx.moveTo(0, -5.5);
    ctx.lineTo(4.5, 0);
    ctx.lineTo(0, 5.5);
    ctx.lineTo(-4.5, 0);
  } else if (team === TEAM_A) {
    ctx.moveTo(0, -5.5);
    ctx.lineTo(4, 4.5);
    ctx.lineTo(-4, 4.5);
  } else {
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
  }
  ctx.closePath();
  ctx.fill();
  // "Spotted" ring: the tell that this enemy blip is only here because it was
  // fire-revealed, not a permanent read of their position.
  if (ringed) {
    ctx.strokeStyle = 'rgba(232, 230, 227, 0.85)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(0, 0, 7.5, 0, Math.PI * 2);
    ctx.stroke();
  }
}

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
    sctx.fillStyle = COL_BG;
    sctx.fillRect(0, 0, STATIC_SIZE, STATIC_SIZE);

    for (const box of layout.boxes) {
      const [x0, y0] = this.worldToStatic(box.x, box.z);
      const w = box.w * this.scale;
      const d = box.d * this.scale;
      sctx.fillStyle = box.tag === 'floor' || box.tag === 'catwalk' ? COL_FLOOR : COL_WALL;
      sctx.fillRect(x0, y0, w, d);
    }

    // Site markers, drawn on top so they read clearly against the floor plan.
    sctx.font = 'bold 20px "Barlow Condensed", "Arial Narrow", Impact, sans-serif';
    sctx.textAlign = 'center';
    sctx.textBaseline = 'middle';
    for (const site of layout.sites) {
      const [sx, sz] = this.worldToStatic(site.x, site.z);
      const r = Math.max(6, site.radius * this.scale);
      sctx.strokeStyle = COL_ACCENT;
      sctx.lineWidth = 2;
      sctx.beginPath();
      sctx.arc(sx, sz, r, 0, Math.PI * 2);
      sctx.stroke();
      sctx.fillStyle = COL_ACCENT;
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

    // Bomb icon: a small pulsing-red diamond with a dot, unmistakable even at
    // this scale (and distinct in shape from any player blip).
    if (bombPos) {
      const [bx, bz] = this.worldToStatic(bombPos.x, bombPos.z);
      ctx.save();
      ctx.translate(bx, bz);
      ctx.fillStyle = COL_DANGER;
      ctx.beginPath();
      ctx.moveTo(0, -5);
      ctx.lineTo(5, 0);
      ctx.lineTo(0, 5);
      ctx.lineTo(-5, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = COL_BG;
      ctx.beginPath();
      ctx.arc(0, 0, 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Players: teammates always shown as directional blips, enemies only
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
      // above), so the blip only needs its own bearing in the same convention.
      yawPitchToDir(p.yaw, 0, this.scratch);
      ctx.rotate(Math.atan2(-this.scratch.x, -this.scratch.z));
      drawBlip(ctx, p.team, isTeammate ? COL_TEAM_A : COL_TEAM_B, !isTeammate);
      ctx.restore();
    }

    ctx.restore();

    // Local player: fixed at center, always pointing up, amber so it always
    // reads as "you" regardless of which team color that clashes with.
    ctx.save();
    ctx.translate(s / 2, s / 2);
    ctx.fillStyle = COL_ACCENT;
    ctx.strokeStyle = COL_BG;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, -6.5);
    ctx.lineTo(4.5, 5.5);
    ctx.lineTo(0, 3);
    ctx.lineTo(-4.5, 5.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
