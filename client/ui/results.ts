// Match results screen. Plan §7.

import { TEAM_A, TEAM_B } from '../../shared/constants.ts';
import type { MatchResult } from '../../shared/types.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const MEDALS = ['🥇', '🥈', '🥉'];

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

    const banner = el('div', 'results-banner' + (localWon ? ' win' : isTeamMode ? ' loss' : ' neutral'));
    if (isTeamMode) {
      banner.classList.add(result.winnerTeam === TEAM_A ? 'team-a-bg' : 'team-b-bg');
      banner.appendChild(el('div', 'results-banner-glyph', result.winnerTeam === TEAM_A ? '▲' : '▼'));
    }
    banner.appendChild(el('div', 'results-title', headline));
    panel.appendChild(banner);

    const table = el('div', 'results-table');
    const header = el('div', 'results-row results-header');
    header.appendChild(el('span', 'r-rank'));
    header.appendChild(el('span', 'r-name', 'Name'));
    header.appendChild(el('span', 'r-kills', 'K'));
    header.appendChild(el('span', 'r-deaths', 'D'));
    header.appendChild(el('span', 'r-score', 'SCORE'));
    table.appendChild(header);

    const sorted = [...result.players].sort((a, b) => b.score - a.score);
    sorted.forEach((p, i) => {
      const row = el('div', 'results-row' + (p.id === localId ? ' me' : '') + (i < 3 ? ' medal-row' : ''));
      row.appendChild(el('span', 'r-rank', i < 3 ? MEDALS[i]! : String(i + 1)));
      row.appendChild(el('span', 'r-name', p.name));
      row.appendChild(el('span', 'r-kills', String(p.kills)));
      row.appendChild(el('span', 'r-deaths', String(p.deaths)));
      row.appendChild(el('span', 'r-score', String(p.score)));
      table.appendChild(row);
    });
    panel.appendChild(table);

    const continueBtn = el('button', 'btn btn-primary btn-continue', 'CONTINUE') as HTMLButtonElement;
    continueBtn.type = 'button';
    continueBtn.addEventListener('click', () => onContinue());
    panel.appendChild(continueBtn);

    this.element.appendChild(panel);
  }
}
