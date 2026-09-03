// Main menu: name, Host / Join / Practice, Settings, Credits. Plan §3, §7.

import { BOT_RECRUIT, BOT_REGULAR, BOT_VETERAN, MAX_PLAYERS, MODE_FFA, MODE_SND, MODE_TDM, PROTOCOL_VERSION } from '../../shared/constants.ts';
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

function icon(svgInner: string): HTMLDivElement {
  const wrap = el('div', 'menu-action-icon');
  wrap.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">${svgInner}</svg>`;
  return wrap;
}

const ICON_HOST = '<path d="M12 13.5a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z" fill="currentColor"/><path d="M12 11.3V3M7.8 7.2a6 6 0 0 1 8.4 0M4.6 4a10.4 10.4 0 0 1 14.8 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>';
const ICON_JOIN = '<path d="M9 4H4v16h5M15 4h5v16h-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M9.5 12h5m0 0-2-2m2 2-2 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';
const ICON_PRACTICE = '<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="12" cy="12" r="3.2" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>';

const MODE_TABS: Array<[number, string, string]> = [
  [MODE_FFA, 'FFA', 'Free-for-all. Highest score wins — no teams.'],
  [MODE_TDM, 'TDM', 'Team Deathmatch. First team to the kill target wins.'],
  [MODE_SND, 'S&D', 'Search & Destroy. One life per round; plant or defuse.'],
];

const DIFFICULTY_OPTIONS: Array<[number, string]> = [
  [BOT_RECRUIT, 'Recruit'],
  [BOT_REGULAR, 'Regular'],
  [BOT_VETERAN, 'Veteran'],
];

/** A 4-cell monospaced code entry. Cells auto-advance and merge into one string. */
function buildCodeCells(initial: string, onComplete: (code: string) => void): { wrap: HTMLDivElement; get: () => string; focusFirst: () => void; clear: () => void } {
  const wrap = el('div', 'code-cells');
  const inputs: HTMLInputElement[] = [];
  for (let i = 0; i < 4; i++) {
    const cell = el('input', 'code-cell') as HTMLInputElement;
    cell.type = 'text';
    cell.maxLength = 1;
    cell.inputMode = 'text';
    cell.autocapitalize = 'characters';
    cell.autocomplete = 'off';
    cell.spellcheck = false;
    cell.value = (initial[i] ?? '').toUpperCase();
    inputs.push(cell);
    wrap.appendChild(cell);
  }
  const get = () => inputs.map((c) => c.value.trim().toUpperCase()).join('');
  const checkComplete = () => {
    const code = get();
    if (code.length === 4) onComplete(code);
  };
  inputs.forEach((cell, i) => {
    cell.addEventListener('input', () => {
      cell.value = cell.value.replace(/[^a-zA-Z0-9]/g, '').slice(-1).toUpperCase();
      if (cell.value && i < 3) inputs[i + 1]!.focus();
      checkComplete();
    });
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !cell.value && i > 0) {
        inputs[i - 1]!.focus();
        inputs[i - 1]!.value = '';
      } else if (e.key === 'Enter') {
        checkComplete();
      } else if (e.key === 'ArrowLeft' && i > 0) {
        inputs[i - 1]!.focus();
      } else if (e.key === 'ArrowRight' && i < 3) {
        inputs[i + 1]!.focus();
      }
    });
    cell.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text') ?? '';
      if (text.length >= 1) {
        e.preventDefault();
        const chars = text.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 4).split('');
        chars.forEach((c, j) => {
          if (inputs[j]) inputs[j]!.value = c;
        });
        const last = Math.min(chars.length, 4) - 1;
        if (last >= 0) inputs[Math.min(last, 3)]!.focus();
        checkComplete();
      }
    });
  });
  return {
    wrap,
    get,
    focusFirst: () => inputs[0]?.focus(),
    clear: () => inputs.forEach((c) => (c.value = '')),
  };
}

export class MenuScreen {
  readonly element: HTMLDivElement;

  constructor(settings: Settings, handlers: MenuHandlers, opts: MenuOpts) {
    this.element = el('div', 'screen menu-screen');
    const panel = el('div', 'menu-panel');

    // ---- Hero -------------------------------------------------------
    const hero = el('div', 'menu-hero');
    hero.appendChild(el('div', 'menu-kicker', 'BROWSER TACTICAL COMBAT'));
    const titleWrap = el('div', 'menu-title-wrap');
    titleWrap.appendChild(el('div', 'menu-title', 'TACTICAL FPS'));
    titleWrap.appendChild(el('div', 'menu-title-bar'));
    hero.appendChild(titleWrap);
    hero.appendChild(el('div', 'menu-subtitle', 'Fast, free, no install. Host a room, drop a code, drop in.'));
    if (!opts.serverReachable) {
      hero.appendChild(el('div', 'menu-warn', 'Dedicated server unreachable — Host will fall back to peer-to-peer.'));
    }
    panel.appendChild(hero);

    // ---- Body (two columns on wide screens) --------------------------
    const body = el('div', 'menu-body');

    // -- Left: callsign, mode tabs, bots/difficulty strip, actions.
    const left = el('div', 'menu-col menu-col-main');

    const callsignField = el('div', 'callsign-field');
    callsignField.appendChild(el('div', 'callsign-label', 'CALLSIGN'));
    const nameInput = el('input', 'callsign-input') as HTMLInputElement;
    nameInput.type = 'text';
    nameInput.maxLength = 16;
    nameInput.value = settings.name;
    nameInput.autocomplete = 'off';
    nameInput.spellcheck = false;
    nameInput.addEventListener('change', () => {
      const v = nameInput.value.trim();
      if (v) {
        settings.name = v;
        saveSettings(settings);
      } else {
        nameInput.value = settings.name;
      }
    });
    callsignField.appendChild(nameInput);
    left.appendChild(callsignField);

    // Mode segmented tabs.
    const modeBlock = el('div', 'menu-mode-block');
    modeBlock.appendChild(el('div', 'menu-section-label', 'Mode'));
    const modeTabs = el('div', 'mode-tabs');
    const modeDesc = el('div', 'mode-desc');
    let selectedMode = MODE_TDM;
    const tabButtons: HTMLButtonElement[] = [];
    for (const [value, label, desc] of MODE_TABS) {
      const tab = el('button', 'mode-tab', label) as HTMLButtonElement;
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.addEventListener('click', () => {
        selectedMode = value;
        for (const t of tabButtons) t.classList.remove('active');
        tab.classList.add('active');
        modeDesc.textContent = desc;
      });
      tabButtons.push(tab);
      modeTabs.appendChild(tab);
      if (value === selectedMode) {
        tab.classList.add('active');
        modeDesc.textContent = desc;
      }
    }
    modeBlock.appendChild(modeTabs);
    modeBlock.appendChild(modeDesc);
    left.appendChild(modeBlock);

    // Bots + difficulty strip.
    const strip = el('div', 'menu-strip');
    const botsField = el('div', 'strip-field');
    botsField.appendChild(el('div', 'menu-section-label', 'Bots'));
    const botsRow = el('div', 'slider-row');
    const botsInput = el('input', 'range-input') as HTMLInputElement;
    botsInput.type = 'range';
    botsInput.min = '0';
    botsInput.max = String(MAX_PLAYERS - 1);
    botsInput.value = '5';
    const botsValue = el('span', 'range-value', botsInput.value);
    botsInput.addEventListener('input', () => {
      botsValue.textContent = botsInput.value;
    });
    botsRow.appendChild(botsInput);
    botsRow.appendChild(botsValue);
    botsField.appendChild(botsRow);
    strip.appendChild(botsField);

    const diffField = el('div', 'strip-field');
    diffField.appendChild(el('div', 'menu-section-label', 'Difficulty'));
    const diffSelect = el('select', 'select-input') as HTMLSelectElement;
    for (const [value, label] of DIFFICULTY_OPTIONS) {
      const o = el('option', undefined, label) as HTMLOptionElement;
      o.value = String(value);
      diffSelect.appendChild(o);
    }
    diffSelect.value = String(BOT_REGULAR);
    diffField.appendChild(diffSelect);
    strip.appendChild(diffField);
    left.appendChild(strip);

    const readSelections = (): [number, number, number] => [selectedMode, Number(botsInput.value), Number(diffSelect.value)];

    // Big action rows.
    const actions = el('div', 'menu-actions');

    const hostRow = el('div', 'menu-action-row menu-action-primary') as HTMLDivElement;
    hostRow.tabIndex = 0;
    hostRow.setAttribute('role', 'button');
    hostRow.appendChild(icon(ICON_HOST));
    const hostBody = el('div', 'menu-action-body');
    hostBody.appendChild(el('div', 'menu-action-title', 'HOST MATCH'));
    hostBody.appendChild(el('div', 'menu-action-desc', 'Start a room on the dedicated server and share the code.'));
    hostRow.appendChild(hostBody);
    hostRow.appendChild(el('div', 'menu-action-chev', '›'));
    const doHost = () => {
      const [mode, bots, difficulty] = readSelections();
      handlers.onHost(mode, bots, difficulty);
    };
    hostRow.addEventListener('click', doHost);
    hostRow.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doHost(); }
    });
    actions.appendChild(hostRow);

    const joinRow = el('div', 'menu-action-row menu-action-join') as HTMLDivElement;
    joinRow.appendChild(icon(ICON_JOIN));
    const joinBody = el('div', 'menu-action-body');
    joinBody.appendChild(el('div', 'menu-action-title', 'JOIN WITH CODE'));
    const codeCells = buildCodeCells(opts.prefillCode ?? '', (code) => handlers.onJoin(code));
    joinBody.appendChild(codeCells.wrap);
    joinRow.appendChild(joinBody);
    const joinBtn = el('button', 'btn btn-small join-go-btn', 'GO') as HTMLButtonElement;
    joinBtn.type = 'button';
    joinBtn.addEventListener('click', () => {
      const code = codeCells.get();
      if (code.length === 4) handlers.onJoin(code);
      else codeCells.focusFirst();
    });
    joinRow.appendChild(joinBtn);
    actions.appendChild(joinRow);
    if (opts.prefillCode && opts.prefillCode.length === 4) {
      // Auto-attempt the join once, matching a friend's shared link.
      queueMicrotask(() => handlers.onJoin(opts.prefillCode!.toUpperCase()));
    }

    const practiceRow = el('div', 'menu-action-row') as HTMLDivElement;
    practiceRow.tabIndex = 0;
    practiceRow.setAttribute('role', 'button');
    practiceRow.appendChild(icon(ICON_PRACTICE));
    const practiceBody = el('div', 'menu-action-body');
    practiceBody.appendChild(el('div', 'menu-action-title', 'PRACTICE VS BOTS'));
    practiceBody.appendChild(el('div', 'menu-action-desc', 'Offline match against AI. No connection required.'));
    practiceRow.appendChild(practiceBody);
    practiceRow.appendChild(el('div', 'menu-action-chev', '›'));
    const doPractice = () => {
      const [mode, bots, difficulty] = readSelections();
      handlers.onPractice(mode, bots, difficulty);
    };
    practiceRow.addEventListener('click', doPractice);
    practiceRow.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doPractice(); }
    });
    actions.appendChild(practiceRow);

    left.appendChild(actions);
    body.appendChild(left);
    panel.appendChild(body);

    // ---- Footer -------------------------------------------------------
    const footer = el('div', 'menu-footer');
    const footerLinks = el('div', 'menu-footer-links');
    const settingsBtn = el('button', 'btn btn-ghost', 'Settings') as HTMLButtonElement;
    settingsBtn.type = 'button';
    settingsBtn.addEventListener('click', () => handlers.onSettings());
    const creditsBtn = el('button', 'btn btn-ghost', 'Credits') as HTMLButtonElement;
    creditsBtn.type = 'button';
    creditsBtn.addEventListener('click', () => handlers.onCredits());
    footerLinks.appendChild(settingsBtn);
    footerLinks.appendChild(creditsBtn);
    footer.appendChild(footerLinks);
    footer.appendChild(el('div', 'menu-footer-hint', `PROTOCOL ${PROTOCOL_VERSION} · WASD MOVE · MOUSE LOOK · CLICK TO PLAY`));
    panel.appendChild(footer);

    this.element.appendChild(panel);
  }
}
