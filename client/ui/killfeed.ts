// 5-line kill feed shown in the top-right of the HUD. Pure DOM: rows are kept
// as long-lived elements and only their opacity/removal churns per frame, so
// update() allocates nothing when nothing has died lately. Plan §7.

import { KILLFEED_SECONDS, KILL_BOMB, KILL_FALL, KILL_FRAG, KILL_MELEE } from '../../shared/constants.ts';
import { weaponName } from '../../shared/weapons.ts';

interface KillRow {
  el: HTMLDivElement;
  ttl: number;
}

function weaponLabel(weaponId: number, headshot: boolean): string {
  switch (weaponId) {
    case KILL_MELEE:
      return '🔪';
    case KILL_FRAG:
      return '💣';
    case KILL_FALL:
      return '⬇';
    case KILL_BOMB:
      return '💥';
    default:
      return (headshot ? '🎯 ' : '') + weaponName(weaponId);
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
      killerSpan.textContent = killerName;
      row.appendChild(killerSpan);
    }

    const weaponSpan = document.createElement('span');
    weaponSpan.className = 'kf-weapon' + (headshot ? ' kf-headshot' : '');
    weaponSpan.textContent = weaponLabel(weaponId, headshot);
    row.appendChild(weaponSpan);

    const victimSpan = document.createElement('span');
    victimSpan.className = 'kf-name kf-team-' + victimTeam;
    victimSpan.textContent = victimName;
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
