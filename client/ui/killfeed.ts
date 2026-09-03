// 5-line kill feed shown in the top-right of the HUD. Pure DOM: rows are kept
// as long-lived elements and only their opacity/removal churns per frame, so
// update() allocates nothing when nothing has died lately. Plan §7.
//
// MW-style presentation: a weapon-category badge (or a small monoline icon for
// melee/frag/fall/bomb) between killer and victim, a skull badge for
// headshots, team-colored names, and a slide-in/fade entrance driven by CSS.

import { KILL_BOMB, KILL_FALL, KILL_FRAG, KILL_MELEE, KILLFEED_SECONDS, TEAM_A, TEAM_B, WEAPON_AR, WEAPON_PISTOL, WEAPON_SHOTGUN, WEAPON_SMG, WEAPON_SNIPER } from '../../shared/constants.ts';

interface KillRow {
  el: HTMLDivElement;
  ttl: number;
}

/** Small monoline icon, currentColor stroke/fill, safe within a 0..16 viewBox. */
export function svgIcon(inner: string): string {
  return `<svg viewBox="0 0 16 16" class="glyph-svg" aria-hidden="true" focusable="false">${inner}</svg>`;
}

export const ICON_MELEE = svgIcon(
  '<path d="M2 14 L10.5 5.5 M10.5 5.5 L14 2 M8.6 3.6 L12.4 7.4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
);
export const ICON_FRAG = svgIcon(
  '<circle cx="8" cy="9.5" r="4.6" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M8 4.9 L8 2.4 M6.4 2.4 L9.6 2.4 M8 2.4 L10 1" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>',
);
export const ICON_FLASH = svgIcon(
  '<path d="M8.5 1 L4.5 9 L7.3 9 L6.3 15 L12 6.2 L8.6 6.2 Z" fill="currentColor"/>',
);
export const ICON_FALL = svgIcon(
  '<path d="M4 5.5 L8 10 L12 5.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 2.5 L8 9.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
);
export const ICON_BOMB = svgIcon(
  '<path d="M8 1.5 L9.2 6 L13.5 4.7 L10.3 8 L13.5 11.3 L9.2 10 L8 14.5 L6.8 10 L2.5 11.3 L5.7 8 L2.5 4.7 L6.8 6 Z" fill="currentColor"/>',
);
export const ICON_SKULL = svgIcon(
  '<circle cx="8" cy="7" r="5.2" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="5.8" cy="7" r="1.15" fill="currentColor"/><circle cx="10.2" cy="7" r="1.15" fill="currentColor"/><path d="M6 11.4 L6 13.2 M8 11.8 L8 13.6 M10 11.4 L10 13.2" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/>',
);

/** Team identity glyph, used everywhere team color alone would not suffice. */
export const TEAM_GLYPH: Record<number, string> = {
  [TEAM_A]: '▲',
  [TEAM_B]: '■',
};

const WEAPON_BADGE: Record<number, string> = {
  [WEAPON_AR]: 'AR',
  [WEAPON_SMG]: 'SMG',
  [WEAPON_SNIPER]: 'SNP',
  [WEAPON_SHOTGUN]: 'SHG',
  [WEAPON_PISTOL]: 'PST',
};

function weaponGlyphHtml(weaponId: number): string {
  switch (weaponId) {
    case KILL_MELEE:
      return `<span class="kf-icon" title="Melee">${ICON_MELEE}</span>`;
    case KILL_FRAG:
      return `<span class="kf-icon" title="Grenade">${ICON_FRAG}</span>`;
    case KILL_FALL:
      return `<span class="kf-icon" title="Fall damage">${ICON_FALL}</span>`;
    case KILL_BOMB:
      return `<span class="kf-icon kf-icon-bomb" title="Bomb">${ICON_BOMB}</span>`;
    default:
      return `<span class="kf-badge">${WEAPON_BADGE[weaponId] ?? '?'}</span>`;
  }
}

export class Killfeed {
  readonly element: HTMLDivElement;
  private readonly rows: KillRow[] = [];
  private readonly maxRows = 5;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'killfeed';
  }

  /** killerName is '' for environmental/self kills (fall damage, own grenade). */
  push(
    killerName: string,
    victimName: string,
    weaponId: number,
    headshot: boolean,
    killerTeam: number,
    victimTeam: number,
    involvesLocal: boolean,
  ): void {
    const row = document.createElement('div');
    row.className = 'kf-row' + (involvesLocal ? ' kf-local' : '');

    if (killerName) {
      const killerSpan = document.createElement('span');
      killerSpan.className = 'kf-name kf-team-' + killerTeam;
      const glyph = TEAM_GLYPH[killerTeam];
      if (glyph) {
        const g = document.createElement('span');
        g.className = 'kf-team-glyph';
        g.textContent = glyph;
        killerSpan.appendChild(g);
      }
      killerSpan.appendChild(document.createTextNode(killerName));
      row.appendChild(killerSpan);
    }

    const mid = document.createElement('span');
    mid.className = 'kf-weapon';
    // Trusted, static markup only (icon constants / a fixed lookup table) — never
    // derived from killerName/victimName, which are untrusted player-chosen text.
    mid.innerHTML = weaponGlyphHtml(weaponId);
    row.appendChild(mid);

    if (headshot) {
      const skull = document.createElement('span');
      skull.className = 'kf-headshot-badge';
      skull.innerHTML = ICON_SKULL;
      row.appendChild(skull);
    }

    const victimSpan = document.createElement('span');
    victimSpan.className = 'kf-name kf-team-' + victimTeam;
    const vGlyph = TEAM_GLYPH[victimTeam];
    if (vGlyph) {
      const g = document.createElement('span');
      g.className = 'kf-team-glyph';
      g.textContent = vGlyph;
      victimSpan.appendChild(g);
    }
    victimSpan.appendChild(document.createTextNode(victimName));
    row.appendChild(victimSpan);

    this.element.appendChild(row);
    this.rows.push({ el: row, ttl: KILLFEED_SECONDS });
    while (this.rows.length > this.maxRows) {
      const old = this.rows.shift();
      old?.el.remove();
    }
  }

  /** Ages and fades rows; call once per rendered frame with the frame dt. */
  update(dt: number): void {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i]!;
      r.ttl -= dt;
      if (r.ttl <= 0) {
        r.el.remove();
        this.rows.splice(i, 1);
      } else if (r.ttl < 1) {
        r.el.style.opacity = String(Math.max(0, r.ttl));
      }
    }
  }
}
