// Tab scoreboard overlay: players grouped by team (FFA is one flat list),
// sorted by score, local row highlighted. Plan §7.

import { MODE_FFA, TEAM_A, TEAM_B } from '../../shared/constants.ts';
import type { LobbyPlayer, RoomState } from '../../shared/types.ts';
import { TEAM_GLYPH } from './killfeed.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function nameCell(name: string, team: number, isBot: boolean): HTMLDivElement {
  const cell = el('div', 'sb-name-cell');
  const glyph = TEAM_GLYPH[team];
  if (glyph) cell.appendChild(el('span', 'sb-team-glyph sb-team-' + (team === TEAM_A ? 'a' : 'b'), glyph));
  cell.appendChild(el('span', 'sb-name', name));
  if (isBot) cell.appendChild(el('span', 'sb-bot-tag', 'BOT'));
  return cell;
}

function buildRow(p: LobbyPlayer, localId: number, rank: number): HTMLDivElement {
  const row = el('div', 'sb-row' + (p.id === localId ? ' me' : ''));
  row.appendChild(el('span', 'sb-rank', String(rank)));
  row.appendChild(nameCell(p.name, p.team, p.isBot));
  row.appendChild(el('span', 'sb-kills', String(p.kills)));
  row.appendChild(el('span', 'sb-deaths', String(p.deaths)));
  row.appendChild(el('span', 'sb-score', String(p.score)));
  row.appendChild(el('span', 'sb-ping', p.isBot ? '—' : `${p.ping}ms`));
  return row;
}

function buildHeader(): HTMLDivElement {
  const header = el('div', 'sb-row sb-header');
  header.appendChild(el('span', 'sb-rank', '#'));
  header.appendChild(el('div', 'sb-name-cell', 'NAME'));
  header.appendChild(el('span', 'sb-kills', 'K'));
  header.appendChild(el('span', 'sb-deaths', 'D'));
  header.appendChild(el('span', 'sb-score', 'SCORE'));
  header.appendChild(el('span', 'sb-ping', 'PING'));
  return header;
}

export class ScoreboardOverlay {
  readonly element: HTMLDivElement;
  private readonly body: HTMLDivElement;

  constructor() {
    this.element = el('div', 'scoreboard-overlay');
    this.element.hidden = true;
    const panel = el('div', 'scoreboard-panel');
    panel.appendChild(el('div', 'sb-title', 'SCOREBOARD'));
    this.body = el('div', 'sb-body');
    panel.appendChild(this.body);
    this.element.appendChild(panel);
  }

  update(state: RoomState, localId: number): void {
    this.body.textContent = '';
    if (state.mode === MODE_FFA) {
      this.body.appendChild(buildHeader());
      const sorted = [...state.players].sort((a, b) => b.score - a.score);
      sorted.forEach((p, i) => this.body.appendChild(buildRow(p, localId, i + 1)));
      return;
    }
    for (const [team, label, cls] of [
      [TEAM_A, 'TEAM A', 'sb-team-a'],
      [TEAM_B, 'TEAM B', 'sb-team-b'],
    ] as const) {
      const header = el('div', `sb-team-header ${cls}`);
      header.appendChild(el('span', 'sb-team-glyph', TEAM_GLYPH[team] ?? ''));
      header.appendChild(el('span', 'sb-team-name', label));
      header.appendChild(el('span', 'sb-team-rounds', String(state.roundsWon[team === TEAM_A ? 0 : 1])));
      this.body.appendChild(header);
      this.body.appendChild(buildHeader());
      const sorted = state.players.filter((p) => p.team === team).sort((a, b) => b.score - a.score);
      sorted.forEach((p, i) => this.body.appendChild(buildRow(p, localId, i + 1)));
    }
  }

  show(): void {
    this.element.hidden = false;
  }

  hide(): void {
    this.element.hidden = true;
  }
}
