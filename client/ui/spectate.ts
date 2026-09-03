// Spectate overlay: shown while dead in a round-based mode (S&D). No network
// message of its own — the camera-follow and cycling logic live in the
// renderer/input layer; this is just the name/health readout and hint. §3, §7.

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class SpectateOverlay {
  readonly element: HTMLDivElement;
  private readonly nameEl: HTMLDivElement;
  private readonly healthFill: HTMLDivElement;
  private readonly healthText: HTMLSpanElement;

  constructor() {
    this.element = el('div', 'spectate-overlay');
    this.element.hidden = true;
    const bar = el('div', 'spectate-bar');
    bar.appendChild(el('div', 'spectate-label', 'SPECTATING'));
    this.nameEl = el('div', 'spectate-name');
    bar.appendChild(this.nameEl);
    const healthBar = el('div', 'spectate-health-bar');
    this.healthFill = el('div', 'spectate-health-fill');
    healthBar.appendChild(this.healthFill);
    this.healthText = el('span', 'spectate-health-text');
    bar.appendChild(healthBar);
    bar.appendChild(this.healthText);
    bar.appendChild(el('div', 'spectate-hint', 'Fire / ADS or ◀ ▶ to cycle'));
    this.element.appendChild(bar);
  }

  setTarget(name: string, health: number): void {
    this.nameEl.textContent = name;
    const pct = Math.max(0, Math.min(100, health));
    this.healthFill.style.width = `${pct}%`;
    this.healthText.textContent = String(Math.ceil(health));
  }

  show(): void {
    this.element.hidden = false;
  }

  hide(): void {
    this.element.hidden = true;
  }
}
