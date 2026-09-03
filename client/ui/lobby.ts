// Lobby: room code (huge, with copy/share), teams, mode/bots/difficulty
// (host only), start, chat. Plan §3, §7.

import { BOT_RECRUIT, BOT_REGULAR, BOT_VETERAN, MAX_PLAYERS, MODE_FFA, MODE_SND, MODE_TDM, TEAM_A, TEAM_B } from '../../shared/constants.ts';
import type { LobbyPlayer, RoomState } from '../../shared/types.ts';

export interface LobbyHandlers {
  onStart(): void;
  onSetMode(mode: number): void;
  onSetBots(n: number): void;
  onSetDifficulty(d: number): void;
  onSetTeam(team: number): void;
  onKick(id: number): void;
  onLoadout(): void;
  onLeave(): void;
  onChat(text: string): void;
}

export interface LobbyController {
  update(state: RoomState): void;
  pushChat(from: string, text: string): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const MODE_NAMES: Record<number, string> = { [MODE_FFA]: 'Free-for-All', [MODE_TDM]: 'Team Deathmatch', [MODE_SND]: 'Search & Destroy' };
const DIFFICULTY_NAMES: Record<number, string> = { [BOT_RECRUIT]: 'Recruit', [BOT_REGULAR]: 'Regular', [BOT_VETERAN]: 'Veteran' };

const ICON_CROWN =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M2 8.5 6 11l6-7 6 7 4-2.5L20.5 18h-17L2 8.5Z"/></svg>';

/** 4-bar signal glyph; `level` 0-4 bars lit. Never the only ping cue — the ms label sits beside it. */
function pingBars(ping: number): HTMLSpanElement {
  const level = ping <= 0 ? 0 : ping < 60 ? 4 : ping < 110 ? 3 : ping < 180 ? 2 : 1;
  const wrap = el('span', 'ping-bars');
  for (let i = 0; i < 4; i++) {
    const bar = el('span', 'ping-bar' + (i < level ? ' lit' : ''));
    bar.style.height = `${4 + i * 3}px`;
    wrap.appendChild(bar);
  }
  return wrap;
}

export class LobbyScreen implements LobbyController {
  readonly element: HTMLDivElement;

  private readonly codeEl: HTMLDivElement;
  private readonly modeSelect: HTMLSelectElement;
  private readonly botsInput: HTMLInputElement;
  private readonly botsValue: HTMLSpanElement;
  private readonly diffSelect: HTMLSelectElement;
  private readonly rosterTeams: HTMLDivElement;
  private readonly rosterFfa: HTMLDivElement;
  private readonly teamAList: HTMLDivElement;
  private readonly teamBList: HTMLDivElement;
  private readonly teamACount: HTMLSpanElement;
  private readonly teamBCount: HTMLSpanElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly hostControls: HTMLDivElement;
  private readonly teamButtons: HTMLDivElement;
  private readonly chatLog: HTMLDivElement;
  private readonly chatInput: HTMLInputElement;
  private readonly localId: number;
  private readonly handlers: LobbyHandlers;
  private lastIsHost = false;

  constructor(state: RoomState, localId: number, handlers: LobbyHandlers) {
    this.localId = localId;
    this.handlers = handlers;
    this.element = el('div', 'screen lobby-screen');
    const panel = el('div', 'panel lobby-panel');

    // ---- Header: room code + share -----------------------------------
    const codeBlock = el('div', 'lobby-code-block');
    codeBlock.appendChild(el('div', 'lobby-code-label', 'ROOM CODE'));
    const codeRow = el('div', 'lobby-code-row');
    this.codeEl = el('div', 'lobby-code', state.code);
    codeRow.appendChild(this.codeEl);
    const joinUrl = () => `${location.origin}/?room=${this.codeEl.textContent ?? ''}`;
    const codeActions = el('div', 'lobby-code-actions');
    const copyBtn = el('button', 'btn btn-small', 'Copy Link') as HTMLButtonElement;
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard?.writeText(joinUrl()).catch(() => {});
      copyBtn.textContent = 'Copied!';
      setTimeout(() => (copyBtn.textContent = 'Copy Link'), 1200);
    });
    const shareBtn = el('button', 'btn btn-small', 'Share') as HTMLButtonElement;
    shareBtn.type = 'button';
    shareBtn.addEventListener('click', () => {
      const nav = navigator as Navigator & { share?: (data: { title?: string; text?: string; url?: string }) => Promise<void> };
      if (nav.share) {
        nav.share({ title: 'Tactical FPS', text: `Join my game — code ${this.codeEl.textContent}`, url: joinUrl() }).catch(() => {});
      } else {
        navigator.clipboard?.writeText(joinUrl()).catch(() => {});
        shareBtn.textContent = 'Copied!';
        setTimeout(() => (shareBtn.textContent = 'Share'), 1200);
      }
    });
    codeActions.appendChild(copyBtn);
    codeActions.appendChild(shareBtn);
    codeRow.appendChild(codeActions);
    codeBlock.appendChild(codeRow);
    panel.appendChild(codeBlock);

    // ---- Host-only match settings strip -------------------------------
    this.hostControls = el('div', 'lobby-host-controls');
    this.hostControls.appendChild(el('div', 'lobby-strip-hint', 'HOST SETTINGS'));
    const stripRow = el('div', 'lobby-strip-row');
    const modeField = el('div', 'strip-field');
    modeField.appendChild(el('label', undefined, 'Mode'));
    this.modeSelect = el('select', 'select-input') as HTMLSelectElement;
    for (const [value, label] of Object.entries(MODE_NAMES)) {
      const o = el('option', undefined, label) as HTMLOptionElement;
      o.value = value;
      this.modeSelect.appendChild(o);
    }
    this.modeSelect.addEventListener('change', () => handlers.onSetMode(Number(this.modeSelect.value)));
    modeField.appendChild(this.modeSelect);
    stripRow.appendChild(modeField);

    const botsField = el('div', 'strip-field');
    botsField.appendChild(el('label', undefined, 'Bots'));
    const botsRow = el('div', 'slider-row');
    this.botsInput = el('input', 'range-input') as HTMLInputElement;
    this.botsInput.type = 'range';
    this.botsInput.min = '0';
    this.botsInput.max = String(MAX_PLAYERS - 1);
    this.botsValue = el('span', 'range-value');
    this.botsInput.addEventListener('input', () => {
      this.botsValue.textContent = this.botsInput.value;
    });
    this.botsInput.addEventListener('change', () => handlers.onSetBots(Number(this.botsInput.value)));
    botsRow.appendChild(this.botsInput);
    botsRow.appendChild(this.botsValue);
    botsField.appendChild(botsRow);
    stripRow.appendChild(botsField);

    const diffField = el('div', 'strip-field');
    diffField.appendChild(el('label', undefined, 'Difficulty'));
    this.diffSelect = el('select', 'select-input') as HTMLSelectElement;
    for (const [value, label] of Object.entries(DIFFICULTY_NAMES)) {
      const o = el('option', undefined, label) as HTMLOptionElement;
      o.value = value;
      this.diffSelect.appendChild(o);
    }
    this.diffSelect.addEventListener('change', () => handlers.onSetDifficulty(Number(this.diffSelect.value)));
    diffField.appendChild(this.diffSelect);
    stripRow.appendChild(diffField);
    this.hostControls.appendChild(stripRow);
    panel.appendChild(this.hostControls);

    // ---- Team switch (non-FFA) ----------------------------------------
    this.teamButtons = el('div', 'lobby-team-buttons');
    const teamABtn = el('button', 'btn team-a-btn', '▲ Join Team A') as HTMLButtonElement;
    teamABtn.type = 'button';
    teamABtn.addEventListener('click', () => handlers.onSetTeam(TEAM_A));
    const teamBBtn = el('button', 'btn team-b-btn', '▼ Join Team B') as HTMLButtonElement;
    teamBBtn.type = 'button';
    teamBBtn.addEventListener('click', () => handlers.onSetTeam(TEAM_B));
    this.teamButtons.appendChild(teamABtn);
    this.teamButtons.appendChild(teamBBtn);
    panel.appendChild(this.teamButtons);

    // ---- Main: roster (two-column team, or flat FFA) + chat -----------
    const columns = el('div', 'lobby-columns');

    const rosterWrap = el('div', 'lobby-roster-wrap');
    this.rosterTeams = el('div', 'team-roster');
    const colA = el('div', 'team-roster-col team-roster-a');
    const headA = el('div', 'team-roster-head');
    headA.appendChild(el('span', 'team-glyph team-glyph-a', '▲'));
    headA.appendChild(el('span', undefined, 'TEAM A'));
    this.teamACount = el('span', 'team-roster-count', '0');
    headA.appendChild(this.teamACount);
    colA.appendChild(headA);
    this.teamAList = el('div', 'team-roster-list');
    colA.appendChild(this.teamAList);
    const colB = el('div', 'team-roster-col team-roster-b');
    const headB = el('div', 'team-roster-head');
    headB.appendChild(el('span', 'team-glyph team-glyph-b', '▼'));
    headB.appendChild(el('span', undefined, 'TEAM B'));
    this.teamBCount = el('span', 'team-roster-count', '0');
    headB.appendChild(this.teamBCount);
    colB.appendChild(headB);
    this.teamBList = el('div', 'team-roster-list');
    colB.appendChild(this.teamBList);
    this.rosterTeams.appendChild(colA);
    this.rosterTeams.appendChild(colB);
    rosterWrap.appendChild(this.rosterTeams);

    this.rosterFfa = el('div', 'roster-ffa');
    rosterWrap.appendChild(this.rosterFfa);
    columns.appendChild(rosterWrap);

    const chatWrap = el('div', 'lobby-chat');
    chatWrap.appendChild(el('div', 'lobby-chat-title', 'COMMS'));
    this.chatLog = el('div', 'lobby-chat-log');
    const chatRow = el('div', 'lobby-chat-row');
    this.chatInput = el('input', 'text-input') as HTMLInputElement;
    this.chatInput.maxLength = 64;
    this.chatInput.placeholder = 'Say something…';
    const sendBtn = el('button', 'btn btn-small', 'Send') as HTMLButtonElement;
    sendBtn.type = 'button';
    const send = () => {
      const text = this.chatInput.value.trim();
      if (text) {
        handlers.onChat(text);
        this.chatInput.value = '';
      }
    };
    sendBtn.addEventListener('click', send);
    this.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
    });
    chatRow.appendChild(this.chatInput);
    chatRow.appendChild(sendBtn);
    chatWrap.appendChild(this.chatLog);
    chatWrap.appendChild(chatRow);
    columns.appendChild(chatWrap);

    panel.appendChild(columns);

    // ---- Actions --------------------------------------------------------
    const actions = el('div', 'lobby-actions');
    const loadoutBtn = el('button', 'btn', 'Loadout') as HTMLButtonElement;
    loadoutBtn.type = 'button';
    loadoutBtn.addEventListener('click', () => handlers.onLoadout());
    this.startBtn = el('button', 'btn btn-primary btn-start', 'START MATCH') as HTMLButtonElement;
    this.startBtn.type = 'button';
    this.startBtn.addEventListener('click', () => handlers.onStart());
    const leaveBtn = el('button', 'btn btn-danger', 'Leave') as HTMLButtonElement;
    leaveBtn.type = 'button';
    leaveBtn.addEventListener('click', () => handlers.onLeave());
    actions.appendChild(loadoutBtn);
    actions.appendChild(this.startBtn);
    actions.appendChild(leaveBtn);
    panel.appendChild(actions);

    this.element.appendChild(panel);
    this.update(state);
  }

  private renderPlayerRow(p: LobbyPlayer, state: RoomState, isHost: boolean): HTMLDivElement {
    const row = el('div', 'lobby-player-row' + (p.id === this.localId ? ' me' : ''));
    const nameWrap = el('span', 'lobby-player-name');
    if (p.id === state.hostId) {
      const crown = el('span', 'host-crown');
      crown.innerHTML = ICON_CROWN;
      nameWrap.appendChild(crown);
    }
    nameWrap.appendChild(document.createTextNode(p.name));
    if (p.isBot) nameWrap.appendChild(el('span', 'bot-tag', 'BOT'));
    row.appendChild(nameWrap);
    if (!p.isBot) {
      const pingWrap = el('span', 'lobby-player-ping');
      pingWrap.appendChild(pingBars(p.ping));
      pingWrap.appendChild(el('span', 'ping-ms', `${p.ping}ms`));
      row.appendChild(pingWrap);
    } else {
      row.appendChild(el('span', 'lobby-player-ping'));
    }
    if (isHost && p.id !== this.localId && !p.isBot) {
      const kickBtn = el('button', 'btn btn-ghost btn-small', 'Kick') as HTMLButtonElement;
      kickBtn.type = 'button';
      kickBtn.addEventListener('click', () => this.handlers.onKick(p.id));
      row.appendChild(kickBtn);
    }
    return row;
  }

  update(state: RoomState): void {
    this.codeEl.textContent = state.code;
    const isHost = state.hostId === this.localId;
    if (isHost !== this.lastIsHost) {
      this.lastIsHost = isHost;
      this.hostControls.hidden = !isHost;
      this.startBtn.hidden = !isHost;
    }
    if (document.activeElement !== this.modeSelect) this.modeSelect.value = String(state.mode);
    if (document.activeElement !== this.botsInput) {
      this.botsInput.value = String(state.botCount);
      this.botsValue.textContent = String(state.botCount);
    }
    if (document.activeElement !== this.diffSelect) this.diffSelect.value = String(state.botDifficulty);

    const isFfa = state.mode === MODE_FFA;
    this.teamButtons.hidden = isFfa;
    this.rosterTeams.hidden = isFfa;
    this.rosterFfa.hidden = !isFfa;

    const sorted = [...state.players].sort((a, b) => b.score - a.score);
    if (isFfa) {
      this.rosterFfa.textContent = '';
      for (const p of sorted) this.rosterFfa.appendChild(this.renderPlayerRow(p, state, isHost));
    } else {
      this.teamAList.textContent = '';
      this.teamBList.textContent = '';
      let countA = 0;
      let countB = 0;
      for (const p of sorted) {
        if (p.team === TEAM_A) {
          countA++;
          this.teamAList.appendChild(this.renderPlayerRow(p, state, isHost));
        } else if (p.team === TEAM_B) {
          countB++;
          this.teamBList.appendChild(this.renderPlayerRow(p, state, isHost));
        }
      }
      this.teamACount.textContent = String(countA);
      this.teamBCount.textContent = String(countB);
    }
  }

  pushChat(from: string, text: string): void {
    const row = el('div', 'chat-row');
    row.appendChild(el('span', 'chat-from', from + ': '));
    row.appendChild(el('span', 'chat-text', text));
    this.chatLog.appendChild(row);
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }
}
