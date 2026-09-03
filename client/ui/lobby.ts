// Lobby: room code (huge, with copy/share), teams, mode/bots/difficulty
// (host only), start, chat. Plan §3, §7.

import { BOT_RECRUIT, BOT_REGULAR, BOT_VETERAN, MAX_PLAYERS, MODE_FFA, MODE_SND, MODE_TDM, TEAM_A, TEAM_B } from '../../shared/constants.ts';
import type { RoomState } from '../../shared/types.ts';

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

export class LobbyScreen implements LobbyController {
  readonly element: HTMLDivElement;

  private readonly codeEl: HTMLDivElement;
  private readonly modeSelect: HTMLSelectElement;
  private readonly botsInput: HTMLInputElement;
  private readonly botsValue: HTMLSpanElement;
  private readonly diffSelect: HTMLSelectElement;
  private readonly playerList: HTMLDivElement;
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

    // Room code + share.
    const codeBlock = el('div', 'lobby-code-block');
    this.codeEl = el('div', 'lobby-code', state.code);
    codeBlock.appendChild(this.codeEl);
    const joinUrl = () => `${location.origin}/?room=${this.codeEl.textContent ?? ''}`;
    const copyBtn = el('button', 'btn', 'Copy Link') as HTMLButtonElement;
    copyBtn.addEventListener('click', () => {
      navigator.clipboard?.writeText(joinUrl()).catch(() => {});
      copyBtn.textContent = 'Copied!';
      setTimeout(() => (copyBtn.textContent = 'Copy Link'), 1200);
    });
    const shareBtn = el('button', 'btn', 'Share') as HTMLButtonElement;
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
    codeBlock.appendChild(copyBtn);
    codeBlock.appendChild(shareBtn);
    panel.appendChild(codeBlock);

    // Host-only match settings.
    this.hostControls = el('div', 'lobby-host-controls');
    const modeField = el('div', 'field');
    modeField.appendChild(el('label', undefined, 'Mode'));
    this.modeSelect = el('select', 'select-input') as HTMLSelectElement;
    for (const [value, label] of Object.entries(MODE_NAMES)) {
      const o = el('option', undefined, label) as HTMLOptionElement;
      o.value = value;
      this.modeSelect.appendChild(o);
    }
    this.modeSelect.addEventListener('change', () => handlers.onSetMode(Number(this.modeSelect.value)));
    modeField.appendChild(this.modeSelect);
    this.hostControls.appendChild(modeField);

    const botsField = el('div', 'field');
    botsField.appendChild(el('label', undefined, 'Bots'));
    this.botsInput = el('input', 'range-input') as HTMLInputElement;
    this.botsInput.type = 'range';
    this.botsInput.min = '0';
    this.botsInput.max = String(MAX_PLAYERS - 1);
    this.botsValue = el('span', 'range-value');
    this.botsInput.addEventListener('input', () => {
      this.botsValue.textContent = this.botsInput.value;
    });
    this.botsInput.addEventListener('change', () => handlers.onSetBots(Number(this.botsInput.value)));
    botsField.appendChild(this.botsInput);
    botsField.appendChild(this.botsValue);
    this.hostControls.appendChild(botsField);

    const diffField = el('div', 'field');
    diffField.appendChild(el('label', undefined, 'Bot difficulty'));
    this.diffSelect = el('select', 'select-input') as HTMLSelectElement;
    for (const [value, label] of Object.entries(DIFFICULTY_NAMES)) {
      const o = el('option', undefined, label) as HTMLOptionElement;
      o.value = value;
      this.diffSelect.appendChild(o);
    }
    this.diffSelect.addEventListener('change', () => handlers.onSetDifficulty(Number(this.diffSelect.value)));
    diffField.appendChild(this.diffSelect);
    this.hostControls.appendChild(diffField);
    panel.appendChild(this.hostControls);

    // Team switch (non-FFA).
    this.teamButtons = el('div', 'lobby-team-buttons');
    const teamABtn = el('button', 'btn team-a-btn', 'Join Team A') as HTMLButtonElement;
    teamABtn.addEventListener('click', () => handlers.onSetTeam(TEAM_A));
    const teamBBtn = el('button', 'btn team-b-btn', 'Join Team B') as HTMLButtonElement;
    teamBBtn.addEventListener('click', () => handlers.onSetTeam(TEAM_B));
    this.teamButtons.appendChild(teamABtn);
    this.teamButtons.appendChild(teamBBtn);
    panel.appendChild(this.teamButtons);

    // Player list.
    this.playerList = el('div', 'lobby-player-list');
    panel.appendChild(this.playerList);

    // Actions.
    const actions = el('div', 'lobby-actions');
    const loadoutBtn = el('button', 'btn', 'Loadout') as HTMLButtonElement;
    loadoutBtn.addEventListener('click', () => handlers.onLoadout());
    this.startBtn = el('button', 'btn btn-primary', 'Start') as HTMLButtonElement;
    this.startBtn.addEventListener('click', () => handlers.onStart());
    const leaveBtn = el('button', 'btn btn-danger', 'Leave') as HTMLButtonElement;
    leaveBtn.addEventListener('click', () => handlers.onLeave());
    actions.appendChild(loadoutBtn);
    actions.appendChild(this.startBtn);
    actions.appendChild(leaveBtn);
    panel.appendChild(actions);

    // Chat.
    const chatWrap = el('div', 'lobby-chat');
    this.chatLog = el('div', 'lobby-chat-log');
    const chatRow = el('div', 'lobby-chat-row');
    this.chatInput = el('input', 'text-input') as HTMLInputElement;
    this.chatInput.maxLength = 64;
    this.chatInput.placeholder = 'Say something…';
    const sendBtn = el('button', 'btn', 'Send') as HTMLButtonElement;
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
    panel.appendChild(chatWrap);

    this.element.appendChild(panel);
    this.update(state);
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
    this.teamButtons.hidden = state.mode === MODE_FFA;

    this.playerList.textContent = '';
    const sorted = [...state.players].sort((a, b) => b.score - a.score);
    for (const p of sorted) {
      const row = el('div', 'lobby-player-row' + (p.id === this.localId ? ' me' : ''));
      const teamDot = el('span', 'team-dot team-' + (p.team === TEAM_A ? 'a' : p.team === TEAM_B ? 'b' : 'none'));
      row.appendChild(teamDot);
      row.appendChild(el('span', 'lobby-player-name', p.name + (p.id === state.hostId ? ' 👑' : '') + (p.isBot ? ' 🤖' : '')));
      row.appendChild(el('span', 'lobby-player-ping', p.isBot ? '' : `${p.ping}ms`));
      if (isHost && p.id !== this.localId && !p.isBot) {
        const kickBtn = el('button', 'btn btn-ghost btn-small', 'Kick') as HTMLButtonElement;
        kickBtn.addEventListener('click', () => this.handlers.onKick(p.id));
        row.appendChild(kickBtn);
      }
      this.playerList.appendChild(row);
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
