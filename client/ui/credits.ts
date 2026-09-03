// Credits screen: author/license/source for every downloaded asset. CC-BY
// (attribution-required) entries are highlighted since that license needs
// to be surfaced, not just recorded in CREDITS.md. Plan §5, §7.

import type { CreditEntry } from '../assets/index-types.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function link(href: string, text: string): HTMLAnchorElement {
  const a = el('a', 'credit-link', text) as HTMLAnchorElement;
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

export class CreditsScreen {
  readonly element: HTMLDivElement;

  constructor(entries: readonly CreditEntry[], onBack: () => void) {
    this.element = el('div', 'screen credits-screen');
    const panel = el('div', 'panel credits-panel');
    panel.appendChild(el('div', 'credits-title', 'CREDITS'));
    panel.appendChild(el('div', 'credits-subtitle', 'Every downloaded asset, with its author, license and source.'));

    const list = el('div', 'credits-list');
    if (entries.length === 0) {
      list.appendChild(el('div', 'credits-empty', 'Asset list not loaded yet.'));
    }
    for (const entry of entries) {
      const row = el('div', 'credit-row' + (entry.attributionRequired ? ' cc-by' : ''));
      row.appendChild(el('div', 'credit-name', entry.name));
      row.appendChild(el('div', 'credit-author', `by ${entry.author}`));
      const licenseRow = el('div', 'credit-license');
      licenseRow.appendChild(link(entry.licenseUrl, entry.license));
      if (entry.attributionRequired) licenseRow.appendChild(el('span', 'cc-by-badge', 'ATTRIBUTION REQUIRED'));
      row.appendChild(licenseRow);
      row.appendChild(link(entry.sourceUrl, 'Source'));
      list.appendChild(row);
    }
    panel.appendChild(list);

    const backBtn = el('button', 'btn btn-primary', 'Back') as HTMLButtonElement;
    backBtn.addEventListener('click', () => onBack());
    panel.appendChild(backBtn);

    this.element.appendChild(panel);
  }
}
