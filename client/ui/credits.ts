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

function isPublicDomain(license: string): boolean {
  return /cc0|public domain|cc-pd/i.test(license);
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
      const pd = isPublicDomain(entry.license);
      const row = el('div', 'credit-row' + (entry.attributionRequired ? ' cc-by' : pd ? ' cc0' : ''));
      const rowHead = el('div', 'credit-row-head');
      rowHead.appendChild(el('div', 'credit-name', entry.name));
      if (entry.attributionRequired) rowHead.appendChild(el('span', 'license-badge badge-by', 'ATTRIBUTION REQUIRED'));
      else if (pd) rowHead.appendChild(el('span', 'license-badge badge-cc0', 'CC0'));
      row.appendChild(rowHead);
      row.appendChild(el('div', 'credit-author', `by ${entry.author}`));
      const licenseRow = el('div', 'credit-license');
      licenseRow.appendChild(link(entry.licenseUrl, entry.license));
      licenseRow.appendChild(el('span', 'credit-sep', '·'));
      licenseRow.appendChild(link(entry.sourceUrl, 'Source'));
      row.appendChild(licenseRow);
      list.appendChild(row);
    }
    panel.appendChild(list);

    const backBtn = el('button', 'btn btn-primary', 'Back') as HTMLButtonElement;
    backBtn.type = 'button';
    backBtn.addEventListener('click', () => onBack());
    panel.appendChild(backBtn);

    this.element.appendChild(panel);
  }
}
