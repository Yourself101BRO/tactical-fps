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
    const wrap = el('div', 'boot-wrap');

    const emblem = el('div', 'boot-emblem');
    emblem.innerHTML =
      '<svg viewBox="0 0 48 48" width="56" height="56" fill="none" aria-hidden="true">' +
      '<circle cx="24" cy="24" r="20" stroke="currentColor" stroke-width="1.5"/>' +
      '<circle cx="24" cy="24" r="12" stroke="currentColor" stroke-width="1.5"/>' +
      '<circle cx="24" cy="24" r="2.6" fill="currentColor"/>' +
      '<path d="M24 1v9M24 38v9M1 24h9M38 24h9" stroke="currentColor" stroke-width="2"/>' +
      '</svg>';
    wrap.appendChild(emblem);

    wrap.appendChild(el('div', 'boot-title', 'TACTICAL FPS'));
    wrap.appendChild(el('div', 'boot-tagline', 'DEPLOYING'));

    const barWrap = el('div', 'boot-bar');
    this.fill = el('div', 'boot-bar-fill');
    barWrap.appendChild(this.fill);
    wrap.appendChild(barWrap);

    this.label = el('div', 'boot-label', 'Loading…');
    wrap.appendChild(this.label);

    this.errorEl = el('div', 'boot-error');
    this.errorEl.hidden = true;
    wrap.appendChild(this.errorEl);

    this.element.appendChild(wrap);
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
