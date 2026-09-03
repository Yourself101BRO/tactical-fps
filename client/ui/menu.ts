// Main menu: name, Host / Join / Practice, Settings, Credits. Plan §3, §7.

import { BOT_RECRUIT, BOT_REGULAR, BOT_VETERAN, MAX_PLAYERS, MODE_FFA, MODE_SND, MODE_TDM } from '../../shared/constants.ts';
import type { Settings } from '../settings.ts';
import { saveSettings } from '../settings.ts';

export interface MenuHandlers {
  onHost(mode: number, bots: number, difficulty: number): void;
  onJoin(code: string): void;
  onPractice(mode: number, bots: number, difficulty: number): void;
  onSettings(): void;
  onCredits(): void;
}

export interface MenuOpts {
  serverReachable: boolean;
  prefillCode?: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const MODE_OPTIONS: Array<[number, string]> = [
  [MODE_FFA, 'Free-for-All'],
  [MODE_TDM, 'Team Deathmatch'],
  [MODE_SND, 'Search & Destroy'],
];

const DIFFICULTY_OPTIONS: Array<[number, string]> = [
  [BOT_RECRUIT, 'Recruit'],
  [BOT_REGULAR, 'Regular'],
  [BOT_VETERAN, 'Veteran'],
];

export class MenuScreen {
  readonly element: HTMLDivElement;

  constructor(settings: Settings, handlers: MenuHandlers, opts: MenuOpts) {
    this.element = el('div', 'screen menu-screen');
    const panel = el('div', 'panel menu-panel');

    panel.appendChild(el('div', 'menu-title', 'TACTICAL FPS'));
    if (!opts.serverReachable) {
      const warn = el('div', 'menu-warn', 'Dedicated server unreachable — Host will fall back to peer-to-peer.');
      panel.appendChild(warn);
    }

    // Name.
    const nameField = el('div', 'field');
    nameField.appendChild(el('label', undefined, 'Name'));
    const nameInput = el('input', 'text-input') as HTMLInputElement;
    nameInput.type = 'text';
    nameInput.maxLength = 16;
    nameInput.value = settings.name;
    nameInput.addEventListener('change', () => {
      const v = nameInput.value.trim();
      if (v) {
        settings.name = v;
        saveSettings(settings);
      } else {
        nameInput.value = settings.name;
      }
    });
    nameField.appendChild(nameInput);
    panel.appendChild(nameField);

    // Mode / bots / difficulty (shared by Host and Practice).
    const modeField = el('div', 'field');
    modeField.appendChild(el('label', undefined, 'Mode'));
    const modeSelect = el('select', 'select-input') as HTMLSelectElement;
    for (const [value, label] of MODE_OPTIONS) {
      const o = el('option', undefined, label) as HTMLOptionElement;
      o.value = String(value);
      modeSelect.appendChild(o);
    }
    modeField.appendChild(modeSelect);
    panel.appendChild(modeField);

    const botsField = el('div', 'field');
    botsField.appendChild(el('label', undefined, 'Bots'));
    const botsInput = el('input', 'range-input') as HTMLInputElement;
    botsInput.type = 'range';
    botsInput.min = '0';
    botsInput.max = String(MAX_PLAYERS - 1);
    botsInput.value = '5';
    const botsValue = el('span', 'range-value', botsInput.value);
    botsInput.addEventListener('input', () => {
      botsValue.textContent = botsInput.value;
    });
    botsField.appendChild(botsInput);
    botsField.appendChild(botsValue);
    panel.appendChild(botsField);

    const diffField = el('div', 'field');
    diffField.appendChild(el('label', undefined, 'Bot difficulty'));
    const diffSelect = el('select', 'select-input') as HTMLSelectElement;
    for (const [value, label] of DIFFICULTY_OPTIONS) {
      const o = el('option', undefined, label) as HTMLOptionElement;
      o.value = String(value);
      diffSelect.appendChild(o);
    }
    diffSelect.value = String(BOT_REGULAR);
    diffField.appendChild(diffSelect);
    panel.appendChild(diffField);

    const readSelections = (): [number, number, number] => [
      Number(modeSelect.value),
      Number(botsInput.value),
      Number(diffSelect.value),
    ];

    const actions = el('div', 'menu-actions');
    const hostBtn = el('button', 'btn btn-primary', 'Host') as HTMLButtonElement;
    hostBtn.addEventListener('click', () => {
      const [mode, bots, difficulty] = readSelections();
      handlers.onHost(mode, bots, difficulty);
    });
    const practiceBtn = el('button', 'btn', 'Practice (offline)') as HTMLButtonElement;
    practiceBtn.addEventListener('click', () => {
      const [mode, bots, difficulty] = readSelections();
      handlers.onPractice(mode, bots, difficulty);
    });
    actions.appendChild(hostBtn);
    actions.appendChild(practiceBtn);
    panel.appendChild(actions);

    // Join.
    const joinRow = el('div', 'menu-join-row');
    const joinInput = el('input', 'text-input code-input') as HTMLInputElement;
    joinInput.type = 'text';
    joinInput.maxLength = 4;
    joinInput.placeholder = 'CODE';
    joinInput.autocapitalize = 'characters';
    joinInput.value = opts.prefillCode ?? '';
    const joinBtn = el('button', 'btn', 'Join') as HTMLButtonElement;
    joinBtn.addEventListener('click', () => {
      const code = joinInput.value.trim().toUpperCase();
      if (code.length === 4) handlers.onJoin(code);
    });
    joinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinBtn.click();
    });
    joinRow.appendChild(joinInput);
    joinRow.appendChild(joinBtn);
    panel.appendChild(joinRow);
    if (opts.prefillCode) {
      // Auto-attempt the join once, matching a friend's shared link.
      queueMicrotask(() => joinBtn.click());
    }

    const footer = el('div', 'menu-footer');
    const settingsBtn = el('button', 'btn btn-ghost', 'Settings') as HTMLButtonElement;
    settingsBtn.addEventListener('click', () => handlers.onSettings());
    const creditsBtn = el('button', 'btn btn-ghost', 'Credits') as HTMLButtonElement;
    creditsBtn.addEventListener('click', () => handlers.onCredits());
    footer.appendChild(settingsBtn);
    footer.appendChild(creditsBtn);
    panel.appendChild(footer);

    this.element.appendChild(panel);
  }
}
