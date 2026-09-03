// Boot screen: asset-load progress bar shown before the menu. Plan §7.

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class BootScreen {
  readonly element: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  private readonly label: HTMLDivElement;
  private readonly errorEl: HTMLDivElement;

  constructor() {
    this.element = el('div', 'screen boot-screen');
    const panel = el('div', 'panel boot-panel');
    const title = el('div', 'boot-title', 'TACTICAL FPS');
    const barWrap = el('div', 'boot-bar');
    this.fill = el('div', 'boot-bar-fill');
    barWrap.appendChild(this.fill);
    this.label = el('div', 'boot-label', 'Loading…');
    this.errorEl = el('div', 'boot-error');
    this.errorEl.hidden = true;
    panel.appendChild(title);
    panel.appendChild(barWrap);
    panel.appendChild(this.label);
    panel.appendChild(this.errorEl);
    this.element.appendChild(panel);
  }

  setProgress(done: number, total: number, label: string): void {
    const pct = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
    this.fill.style.width = `${pct}%`;
    this.label.textContent = `${label} (${done}/${total})`;
  }

  setError(text: string): void {
    this.errorEl.hidden = false;
    this.errorEl.textContent = text;
  }
}
