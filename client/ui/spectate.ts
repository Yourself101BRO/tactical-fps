// Spectate overlay: shown while dead in a round-based mode (S&D). No network
// message of its own — the camera-follow and cycling logic live in the
// renderer/input layer; this is just the name/health readout and hint. §3, §7.

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const EYE_ICON =
  '<svg viewBox="0 0 16 16" class="glyph-svg" aria-hidden="true"><path d="M1 8 C3 4 6 2.4 8 2.4 C10 2.4 13 4 15 8 C13 12 10 13.6 8 13.6 C6 13.6 3 12 1 8 Z" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="8" cy="8" r="2.3" fill="currentColor"/></svg>';

export class SpectateOverlay {
  readonly element: HTMLDivElement;
  private readonly nameEl: HTMLDivElement;
  private readonly healthFill: HTMLDivElement;
  private readonly healthText: HTMLSpanElement;
  private lastHealth = -1;

  constructor() {
    this.element = el('div', 'spectate-overlay');
    this.element.hidden = true;
    const bar = el('div', 'spectate-bar');
    const label = el('div', 'spectate-label');
    label.innerHTML = EYE_ICON;
    label.appendChild(document.createTextNode('SPECTATING'));
    bar.appendChild(label);
    this.nameEl = el('div', 'spectate-name');
    bar.appendChild(this.nameEl);
    const healthBar = el('div', 'spectate-health-bar');
    this.healthFill = el('div', 'spectate-health-fill');
    healthBar.appendChild(this.healthFill);
    bar.appendChild(healthBar);
    this.healthText = el('span', 'spectate-health-text');
    bar.appendChild(this.healthText);
    bar.appendChild(el('div', 'spectate-hint', '◀ FIRE / ADS ▶  cycle'));
    this.element.appendChild(bar);
  }

  setTarget(name: string, health: number): void {
    this.nameEl.textContent = name;
    const pct = Math.max(0, Math.min(100, health));
    if (Math.round(health) === this.lastHealth) return;
    this.lastHealth = Math.round(health);
    this.healthFill.style.width = `${pct}%`;
    this.healthFill.classList.toggle('low', health < 30);
    this.healthText.textContent = String(Math.ceil(health));
  }

  show(): void {
    this.element.hidden = false;
  }

  hide(): void {
    this.element.hidden = true;
  }
}
