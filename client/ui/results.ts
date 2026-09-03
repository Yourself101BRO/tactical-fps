// Match results screen. Plan §7.

import { TEAM_A, TEAM_B } from '../../shared/constants.ts';
import type { MatchResult } from '../../shared/types.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class ResultsScreen {
  readonly element: HTMLDivElement;

  constructor(result: MatchResult, localId: number, onContinue: () => void) {
    this.element = el('div', 'screen results-screen');
    const panel = el('div', 'panel results-panel');

    const local = result.players.find((p) => p.id === localId);
    const isTeamMode = result.winnerTeam === TEAM_A || result.winnerTeam === TEAM_B;
    const localWon = isTeamMode ? local?.team === result.winnerTeam : result.winnerId === localId;
    const headline = localWon
      ? 'VICTORY'
      : isTeamMode
        ? 'DEFEAT'
        : `${result.players.find((p) => p.id === result.winnerId)?.name ?? 'SOMEONE'} WINS`;
    const title = el('div', 'results-title' + (localWon ? ' win' : ' loss'), headline);
    panel.appendChild(title);

    const table = el('div', 'results-table');
    const header = el('div', 'results-row results-header');
    header.appendChild(el('span', 'r-name', 'Name'));
    header.appendChild(el('span', 'r-kills', 'K'));
    header.appendChild(el('span', 'r-deaths', 'D'));
    header.appendChild(el('span', 'r-score', 'SCORE'));
    table.appendChild(header);

    const sorted = [...result.players].sort((a, b) => b.score - a.score);
    for (const p of sorted) {
      const row = el('div', 'results-row' + (p.id === localId ? ' me' : ''));
      row.appendChild(el('span', 'r-name', p.name));
      row.appendChild(el('span', 'r-kills', String(p.kills)));
      row.appendChild(el('span', 'r-deaths', String(p.deaths)));
      row.appendChild(el('span', 'r-score', String(p.score)));
      table.appendChild(row);
    }
    panel.appendChild(table);

    const continueBtn = el('button', 'btn btn-primary', 'Continue') as HTMLButtonElement;
    continueBtn.addEventListener('click', () => onContinue());
    panel.appendChild(continueBtn);

    this.element.appendChild(panel);
  }
}
