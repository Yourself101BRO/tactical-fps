// Top-level UI orchestrator: owns every screen/overlay and the single active
// full-viewport "screen" swap. Plan §7 (all screens), §3 (lobby flow), §9.

import type { Loadout, MatchResult, RoomState } from '../../shared/types.ts';
import type { MapLayout } from '../../shared/map/types.ts';
import type { Settings } from '../settings.ts';
import type { CreditEntry } from '../assets/index-types.ts';

import { BootScreen } from './boot.ts';
import type { MenuHandlers, MenuOpts } from './menu.ts';
import { MenuScreen } from './menu.ts';
import type { LobbyController, LobbyHandlers } from './lobby.ts';
import { LobbyScreen } from './lobby.ts';
import { LoadoutScreen } from './loadout.ts';
import { Hud } from './hud.ts';
import { SpectateOverlay } from './spectate.ts';
import { ScoreboardOverlay } from './scoreboard.ts';
import type { SettingsOpts } from './settings-screen.ts';
import { SettingsScreen } from './settings-screen.ts';
import { ResultsScreen } from './results.ts';
import { CreditsScreen } from './credits.ts';
import { Minimap } from './minimap.ts';

export type { LobbyHandlers, LobbyController, MenuHandlers, MenuOpts, SettingsOpts };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface PauseHandlers {
  onResume(): void;
  onSettings(): void;
  onLeave(): void;
}

export class UI {
  readonly root: HTMLElement;
  settings: Settings;

  private readonly screensLayer: HTMLDivElement;
  private readonly hudLayer: HTMLDivElement;
  private readonly overlayLayer: HTMLDivElement;
  private readonly messageLayer: HTMLDivElement;
  private readonly rotateLayer: HTMLDivElement;
  private readonly reconnectLayer: HTMLDivElement;
  private readonly pauseLayer: HTMLDivElement;

  private activeScreen: HTMLElement | null = null;
  private hud: Hud | null = null;
  private spectate: SpectateOverlay | null = null;
  private scoreboard: ScoreboardOverlay | null = null;
  private lastCredits: readonly CreditEntry[] = [];

  constructor(root: HTMLElement, settings: Settings) {
    this.root = root;
    this.settings = settings;

    this.screensLayer = el('div', 'ui-layer ui-screens');
    this.hudLayer = el('div', 'ui-layer ui-hud-layer');
    this.overlayLayer = el('div', 'ui-layer ui-overlays');
    this.pauseLayer = el('div', 'ui-layer ui-pause-layer');
    this.reconnectLayer = el('div', 'ui-layer ui-reconnect-layer');
    this.messageLayer = el('div', 'ui-layer ui-message-layer');
    this.rotateLayer = el('div', 'ui-layer ui-rotate-layer');

    root.appendChild(this.screensLayer);
    root.appendChild(this.hudLayer);
    root.appendChild(this.overlayLayer);
    root.appendChild(this.pauseLayer);
    root.appendChild(this.reconnectLayer);
    root.appendChild(this.messageLayer);
    root.appendChild(this.rotateLayer);
    // Modal layers take pointer events when visible, so they must start hidden or
    // they swallow every click on the menu underneath.
    this.messageLayer.hidden = true;
    this.pauseLayer.hidden = true;

    // Static overlays built once.
    const reconnectBanner = el('div', 'reconnect-banner', 'RECONNECTING…');
    reconnectBanner.hidden = true;
    this.reconnectLayer.appendChild(reconnectBanner);

    const rotatePrompt = el('div', 'rotate-prompt');
    rotatePrompt.appendChild(el('div', 'rotate-icon', '⟳'));
    rotatePrompt.appendChild(el('div', 'rotate-text', 'Rotate your device to landscape'));
    rotatePrompt.hidden = true;
    this.rotateLayer.appendChild(rotatePrompt);
  }

  // -- Screen swap -----------------------------------------------------
  private swapScreen(element: HTMLElement): void {
    if (this.activeScreen) this.activeScreen.remove();
    this.activeScreen = element;
    this.screensLayer.hidden = false;
    this.screensLayer.appendChild(element);
  }

  hideScreens(): void {
    if (this.activeScreen) {
      this.activeScreen.remove();
      this.activeScreen = null;
    }
    this.screensLayer.hidden = true;
  }

  // -- Boot --------------------------------------------------------------
  showBoot(): BootScreen {
    const screen = new BootScreen();
    this.swapScreen(screen.element);
    return screen;
  }

  // -- Menu ----------------------------------------------------------------
  showMenu(handlers: MenuHandlers, opts: MenuOpts): void {
    const screen = new MenuScreen(this.settings, handlers, opts);
    this.swapScreen(screen.element);
  }

  // -- Lobby -----------------------------------------------------------
  showLobby(state: RoomState, localId: number, handlers: LobbyHandlers): LobbyController {
    const screen = new LobbyScreen(state, localId, handlers);
    this.swapScreen(screen.element);
    return screen;
  }

  // -- Loadout ---------------------------------------------------------
  showLoadout(current: Loadout, onSave: (loadout: Loadout) => void, onBack: () => void): void {
    const screen = new LoadoutScreen(current, onSave, onBack);
    this.swapScreen(screen.element);
  }

  // -- HUD ---------------------------------------------------------------
  showHud(): Hud {
    if (this.hud) this.hud.element.remove();
    this.hud = new Hud(this.hudLayer);
    this.hud.show();
    return this.hud;
  }

  // -- Spectate --------------------------------------------------------
  showSpectate(): SpectateOverlay {
    if (!this.spectate) {
      this.spectate = new SpectateOverlay();
      this.overlayLayer.appendChild(this.spectate.element);
    }
    return this.spectate;
  }

  // -- Scoreboard --------------------------------------------------------
  showScoreboard(): ScoreboardOverlay {
    if (!this.scoreboard) {
      this.scoreboard = new ScoreboardOverlay();
      this.overlayLayer.appendChild(this.scoreboard.element);
    }
    return this.scoreboard;
  }

  // -- Results -----------------------------------------------------------
  showResults(result: MatchResult, localId: number, onContinue: () => void): void {
    const screen = new ResultsScreen(result, localId, onContinue);
    this.swapScreen(screen.element);
  }

  // -- Settings ------------------------------------------------------------
  showSettings(onClose: () => void, opts: SettingsOpts): void {
    const fullOpts: SettingsOpts = {
      ...opts,
      onCredits: opts.onCredits ?? (() => this.showCredits(this.lastCredits, () => this.showSettings(onClose, opts))),
    };
    const screen = new SettingsScreen(this.settings, onClose, fullOpts);
    this.swapScreen(screen.element);
  }

  // -- Credits -------------------------------------------------------------
  showCredits(entries: readonly CreditEntry[], onBack: () => void): void {
    this.lastCredits = entries;
    const screen = new CreditsScreen(entries, onBack);
    this.swapScreen(screen.element);
  }

  // -- Message modal -----------------------------------------------------
  showMessage(title: string, text: string, onOk: () => void): void {
    this.messageLayer.textContent = '';
    const modal = el('div', 'modal-backdrop');
    const panel = el('div', 'modal-panel');
    panel.appendChild(el('div', 'modal-title', title));
    panel.appendChild(el('div', 'modal-text', text));
    const okBtn = el('button', 'btn btn-primary', 'OK') as HTMLButtonElement;
    okBtn.addEventListener('click', () => {
      this.messageLayer.textContent = '';
      this.messageLayer.hidden = true;
      onOk();
    });
    panel.appendChild(okBtn);
    modal.appendChild(panel);
    this.messageLayer.appendChild(modal);
    this.messageLayer.hidden = false;
  }

  /** Dismiss any modal message (e.g. a "Connecting…" notice once the connection is up). */
  hideMessage(): void {
    this.messageLayer.hidden = true;
    this.messageLayer.replaceChildren();
  }

  // -- Rotate prompt -------------------------------------------------------
  showRotatePrompt(show: boolean): void {
    const prompt = this.rotateLayer.firstElementChild as HTMLElement | null;
    if (prompt) prompt.hidden = !show;
  }

  // -- Reconnecting banner -------------------------------------------------
  showReconnecting(show: boolean): void {
    const banner = this.reconnectLayer.firstElementChild as HTMLElement | null;
    if (banner) banner.hidden = !show;
  }

  // -- Connect error -------------------------------------------------------
  showConnectError(text: string, onRetry: () => void, onBack: () => void): void {
    const screen = el('div', 'screen connect-error-screen');
    const panel = el('div', 'panel');
    panel.appendChild(el('div', 'connect-error-title', 'Connection Failed'));
    panel.appendChild(el('div', 'connect-error-text', text));
    const actions = el('div', 'connect-error-actions');
    const retryBtn = el('button', 'btn btn-primary', 'Retry') as HTMLButtonElement;
    retryBtn.addEventListener('click', () => onRetry());
    const backBtn = el('button', 'btn', 'Back to Menu') as HTMLButtonElement;
    backBtn.addEventListener('click', () => onBack());
    actions.appendChild(retryBtn);
    actions.appendChild(backBtn);
    panel.appendChild(actions);
    screen.appendChild(panel);
    this.swapScreen(screen);
  }

  // -- Pause menu ----------------------------------------------------------
  setPauseMenu(show: boolean, handlers?: PauseHandlers): void {
    if (!show || !handlers) {
      this.pauseLayer.textContent = '';
      this.pauseLayer.hidden = true;
      return;
    }
    this.pauseLayer.textContent = '';
    const modal = el('div', 'modal-backdrop');
    const panel = el('div', 'modal-panel pause-panel');
    panel.appendChild(el('div', 'modal-title', 'PAUSED'));
    const resumeBtn = el('button', 'btn btn-primary', 'Resume') as HTMLButtonElement;
    resumeBtn.addEventListener('click', () => handlers.onResume());
    const settingsBtn = el('button', 'btn', 'Settings') as HTMLButtonElement;
    settingsBtn.addEventListener('click', () => handlers.onSettings());
    const leaveBtn = el('button', 'btn btn-danger', 'Leave Match') as HTMLButtonElement;
    leaveBtn.addEventListener('click', () => handlers.onLeave());
    panel.appendChild(resumeBtn);
    panel.appendChild(settingsBtn);
    panel.appendChild(leaveBtn);
    modal.appendChild(panel);
    this.pauseLayer.appendChild(modal);
    this.pauseLayer.hidden = false;
  }

  /** Convenience for the integrator: builds a Minimap from the active map layout. */
  static buildMinimap(layout: MapLayout, size = 120): Minimap {
    return new Minimap(layout, size);
  }
}
