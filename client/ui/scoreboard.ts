// Tab scoreboard overlay: players grouped by team (FFA is one flat list),
// sorted by score, local row highlighted. Plan §7.

import { MODE_FFA, TEAM_A, TEAM_B } from '../../shared/constants.ts';
import type { LobbyPlayer, RoomState } from '../../shared/types.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function buildRow(p: LobbyPlayer, localId: number): HTMLDivElement {
  const row = el('div', 'sb-row' + (p.id === localId ? ' me' : ''));
  row.appendChild(el('span', 'sb-name', p.name + (p.isBot ? ' 🤖' : '')));
  row.appendChild(el('span', 'sb-kills', String(p.kills)));
  row.appendChild(el('span', 'sb-deaths', String(p.deaths)));
  row.appendChild(el('span', 'sb-score', String(p.score)));
  row.appendChild(el('span', 'sb-ping', p.isBot ? '' : `${p.ping}ms`));
  return row;
}

export class ScoreboardOverlay {
  readonly element: HTMLDivElement;
  private readonly body: HTMLDivElement;

  constructor() {
    this.element = el('div', 'scoreboard-overlay');
    this.element.hidden = true;
    const panel = el('div', 'scoreboard-panel');
    panel.appendChild(el('div', 'sb-title', 'SCOREBOARD'));
    const header = el('div', 'sb-row sb-header');
    header.appendChild(el('span', 'sb-name', 'Name'));
    header.appendChild(el('span', 'sb-kills', 'K'));
    header.appendChild(el('span', 'sb-deaths', 'D'));
    header.appendChild(el('span', 'sb-score', 'SCORE'));
    header.appendChild(el('span', 'sb-ping', 'PING'));
    panel.appendChild(header);
    this.body = el('div', 'sb-body');
    panel.appendChild(this.body);
    this.element.appendChild(panel);
  }

  update(state: RoomState, localId: number): void {
    this.body.textContent = '';
    if (state.mode === MODE_FFA) {
      const sorted = [...state.players].sort((a, b) => b.score - a.score);
      for (const p of sorted) this.body.appendChild(buildRow(p, localId));
      return;
    }
    for (const [team, label, cls] of [
      [TEAM_A, 'TEAM A', 'sb-team-a'],
      [TEAM_B, 'TEAM B', 'sb-team-b'],
    ] as const) {
      this.body.appendChild(el('div', `sb-team-header ${cls}`, `${label} — ${state.roundsWon[team === TEAM_A ? 0 : 1]}`));
      const sorted = state.players.filter((p) => p.team === team).sort((a, b) => b.score - a.score);
      for (const p of sorted) this.body.appendChild(buildRow(p, localId));
    }
  }

  show(): void {
    this.element.hidden = false;
  }

  hide(): void {
    this.element.hidden = true;
  }
}
