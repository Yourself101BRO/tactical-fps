// Loadout screen: primary, secondary, lethal, tactical, 2 perks. Weapon cards
// show stat bars derived purely from WeaponDef fields (no hardcoded numbers,
// per Hard Rule 5) normalized against the rest of the roster. Plan §4, §7.

import { LETHAL_FRAG, PERK_NONE, SLOT_PRIMARY, SLOT_SECONDARY, TACTICAL_FLASH } from '../../shared/constants.ts';
import { WEAPONS } from '../../shared/weapons.ts';
import type { WeaponDef } from '../../shared/weapons.ts';
import { PERKS } from '../../shared/perks.ts';
import type { Loadout } from '../../shared/types.ts';

// shared/perks.ts documents PERKS only as `readonly {id;name;description}[]`
// (no named interface), so this local shape is duck-typed against that
// rather than importing a type that may not exist.
interface PerkDef {
  id: number;
  name: string;
  description: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

interface WeaponStats {
  damage: number;
  accuracy: number;
  rate: number;
  range: number;
  mobility: number;
  control: number;
}

function normalize(value: number, min: number, max: number): number {
  if (max <= min) return 50;
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}

/** Raw (pre-normalization) per-weapon metrics used for the stat bars. */
function rawMetrics(w: WeaponDef): { damage: number; accuracy: number; rate: number; range: number; mobility: number; control: number } {
  const damage = w.damageValues.length > 0 ? Math.max(...w.damageValues) * (w.pellets > 1 ? w.pellets : 1) : 0;
  // Lower hip/ADS spread cones mean a tighter, more accurate weapon.
  const accuracy = 1 / (w.spreadStand + w.spreadAds + 0.001);
  const rate = w.rpm;
  const range = w.damageRanges.length > 0 ? w.damageRanges[w.damageRanges.length - 1]! : 0;
  const mobility = w.adsMoveSpeed;
  const control = 1 / (w.recoilPitch + w.recoilYaw + 0.001);
  return { damage, accuracy, rate, range, mobility, control };
}

function computeStats(weapons: readonly WeaponDef[]): Map<number, WeaponStats> {
  const raw = weapons.map(rawMetrics);
  const bounds = (key: keyof ReturnType<typeof rawMetrics>) => {
    const values = raw.map((r) => r[key]);
    return [Math.min(...values), Math.max(...values)] as const;
  };
  const [dMin, dMax] = bounds('damage');
  const [aMin, aMax] = bounds('accuracy');
  const [rMin, rMax] = bounds('rate');
  const [gMin, gMax] = bounds('range');
  const [mMin, mMax] = bounds('mobility');
  const [cMin, cMax] = bounds('control');

  const out = new Map<number, WeaponStats>();
  weapons.forEach((w, i) => {
    const m = raw[i]!;
    out.set(w.id, {
      damage: normalize(m.damage, dMin, dMax),
      accuracy: normalize(m.accuracy, aMin, aMax),
      rate: normalize(m.rate, rMin, rMax),
      range: normalize(m.range, gMin, gMax),
      mobility: normalize(m.mobility, mMin, mMax),
      control: normalize(m.control, cMin, cMax),
    });
  });
  return out;
}

function statBar(container: HTMLElement, label: string, pct: number): void {
  const row = el('div', 'stat-row');
  row.appendChild(el('span', 'stat-label', label));
  const bar = el('div', 'stat-bar');
  const fill = el('div', 'stat-bar-fill');
  fill.style.width = `${pct}%`;
  bar.appendChild(fill);
  row.appendChild(bar);
  container.appendChild(row);
}

/** Abstract monochrome silhouette per weapon class — decorative, not literal. */
const WEAPON_ICONS: Record<string, string> = {
  AR: '<rect x="2" y="10" width="14" height="3" rx="1" fill="currentColor"/><rect x="16" y="9.3" width="5" height="1.6" fill="currentColor"/><rect x="5" y="13" width="2.4" height="5" fill="currentColor"/><rect x="9.2" y="6" width="1.6" height="4" fill="currentColor"/>',
  SMG: '<rect x="4" y="10" width="10" height="3" rx="1" fill="currentColor"/><rect x="14" y="9.3" width="4" height="1.4" fill="currentColor"/><rect x="6" y="13" width="2.2" height="4" fill="currentColor"/><rect x="2" y="10.6" width="2" height="4" rx="1" fill="currentColor"/>',
  Sniper: '<rect x="2" y="11" width="18" height="2" rx="1" fill="currentColor"/><circle cx="9" cy="7.6" r="2.4" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="6" y="13" width="2" height="5" fill="currentColor"/>',
  Shotgun: '<rect x="2" y="10" width="16" height="4" rx="1.5" fill="currentColor"/><rect x="6" y="14" width="2.4" height="4" fill="currentColor"/><rect x="18" y="10.6" width="3" height="1.4" fill="currentColor"/>',
  Pistol: '<rect x="4" y="10" width="10" height="2.6" rx="1" fill="currentColor"/><rect x="6" y="12.6" width="2.6" height="6" rx="1" fill="currentColor"/>',
};
const WEAPON_ICON_FALLBACK = '<rect x="3" y="10" width="14" height="3" rx="1" fill="currentColor"/>';

const ICON_FRAG =
  '<circle cx="12" cy="13" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 6.5V3M9.5 4l1 2M14.5 4l-1 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>';
const ICON_FLASH =
  '<rect x="9" y="6" width="6" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 8l2 1M4 16l2-1M20 8l-2 1M20 16l-2-1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>';

function iconEl(svgInner: string, className: string): HTMLDivElement {
  const wrap = el('div', className);
  wrap.innerHTML = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true">${svgInner}</svg>`;
  return wrap;
}

export class LoadoutScreen {
  readonly element: HTMLDivElement;

  constructor(current: Loadout, onSave: (loadout: Loadout) => void, onBack: () => void) {
    this.element = el('div', 'screen loadout-screen');
    const panel = el('div', 'panel loadout-panel');
    const header = el('div', 'loadout-header');
    header.appendChild(el('div', 'loadout-title', 'LOADOUT'));
    header.appendChild(el('div', 'loadout-subtitle', 'Build your kit before you drop in.'));
    panel.appendChild(header);

    const stats = computeStats(WEAPONS);
    const loadout: Loadout = { ...current };

    const weaponSection = (slotLabel: string, slot: number, selected: number, onPick: (id: number) => void) => {
      const section = el('div', 'loadout-section');
      section.appendChild(el('div', 'loadout-section-title', slotLabel));
      const cards = el('div', 'weapon-cards');
      const options = WEAPONS.filter((w: WeaponDef) => w.slot === slot);
      for (const w of options) {
        const card = el('div', 'weapon-card' + (w.id === selected ? ' selected' : ''));
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        const cardHead = el('div', 'weapon-card-head');
        cardHead.appendChild(iconEl(WEAPON_ICONS[w.name] ?? WEAPON_ICON_FALLBACK, 'weapon-card-icon'));
        const nameWrap = el('div', 'weapon-card-name-wrap');
        nameWrap.appendChild(el('div', 'weapon-card-name', w.name));
        nameWrap.appendChild(el('div', 'weapon-card-class', slotLabel.toUpperCase()));
        cardHead.appendChild(nameWrap);
        card.appendChild(cardHead);
        const s = stats.get(w.id)!;
        statBar(card, 'DMG', s.damage);
        statBar(card, 'ACC', s.accuracy);
        statBar(card, 'RANGE', s.range);
        statBar(card, 'RATE', s.rate);
        statBar(card, 'MOBILITY', s.mobility);
        statBar(card, 'CONTROL', s.control);
        const pick = () => {
          onPick(w.id);
          for (const c of Array.from(cards.children)) c.classList.remove('selected');
          card.classList.add('selected');
        };
        card.addEventListener('click', pick);
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
        });
        cards.appendChild(card);
      }
      section.appendChild(cards);
      panel.appendChild(section);
    };

    weaponSection('Primary', SLOT_PRIMARY, loadout.primary, (id) => (loadout.primary = id));
    weaponSection('Secondary', SLOT_SECONDARY, loadout.secondary, (id) => (loadout.secondary = id));

    // Lethal / tactical: v1 ships exactly one of each (frag, flash), so this
    // is a fixed readout rather than a picker — the card-style row still
    // communicates what the player is carrying.
    const equipSection = el('div', 'loadout-section');
    equipSection.appendChild(el('div', 'loadout-section-title', 'Equipment'));
    const equipRow = el('div', 'equip-row');
    const fragChip = el('div', 'equip-chip selected');
    fragChip.appendChild(iconEl(ICON_FRAG, 'equip-chip-icon'));
    const fragBody = el('div', 'equip-chip-body');
    fragBody.appendChild(el('div', 'equip-chip-label', 'Lethal'));
    fragBody.appendChild(el('div', 'equip-chip-name', 'Frag Grenade'));
    fragChip.appendChild(fragBody);
    equipRow.appendChild(fragChip);
    const flashChip = el('div', 'equip-chip selected');
    flashChip.appendChild(iconEl(ICON_FLASH, 'equip-chip-icon'));
    const flashBody = el('div', 'equip-chip-body');
    flashBody.appendChild(el('div', 'equip-chip-label', 'Tactical'));
    flashBody.appendChild(el('div', 'equip-chip-name', 'Flashbang'));
    flashChip.appendChild(flashBody);
    equipRow.appendChild(flashChip);
    equipSection.appendChild(equipRow);
    panel.appendChild(equipSection);
    loadout.lethal = LETHAL_FRAG;
    loadout.tactical = TACTICAL_FLASH;

    // Perks: 2 slots, no duplicates (PERK_NONE may repeat — it means "empty").
    const perkSection = el('div', 'loadout-section');
    perkSection.appendChild(el('div', 'loadout-section-title', 'Perks'));
    const perkSlots = el('div', 'perk-slots');
    perkSection.appendChild(perkSlots);
    panel.appendChild(perkSection);

    const renderPerkSlot = (slotIndex: 0 | 1) => {
      const wrap = el('div', 'perk-slot');
      wrap.appendChild(el('div', 'perk-slot-label', `PERK ${slotIndex + 1}`));
      const chips = el('div', 'perk-chips');
      const currentId = slotIndex === 0 ? loadout.perk1 : loadout.perk2;
      const descEl = el('div', 'perk-desc', PERKS.find((p: PerkDef) => p.id === currentId)?.description ?? '');

      for (const perk of PERKS) {
        const chip = el('button', 'perk-chip' + (perk.id === currentId ? ' selected' : ''), perk.name) as HTMLButtonElement;
        chip.type = 'button';
        chip.title = perk.description;
        chip.addEventListener('click', () => {
          const picked = perk.id;
          const other = slotIndex === 0 ? loadout.perk2 : loadout.perk1;
          if (picked !== PERK_NONE && picked === other) {
            // No duplicate non-empty perks: clear the other slot's selection instead.
            if (slotIndex === 0) loadout.perk2 = PERK_NONE;
            else loadout.perk1 = PERK_NONE;
            const otherSlot = perkSlots.children[slotIndex === 0 ? 1 : 0];
            if (otherSlot) {
              for (const c of Array.from(otherSlot.querySelectorAll('.perk-chip'))) c.classList.remove('selected');
              const noneChip = otherSlot.querySelector('.perk-chip');
              noneChip?.classList.add('selected');
              const otherDesc = otherSlot.querySelector('.perk-desc');
              if (otherDesc) otherDesc.textContent = PERKS.find((p: PerkDef) => p.id === PERK_NONE)?.description ?? '';
            }
          }
          if (slotIndex === 0) loadout.perk1 = picked;
          else loadout.perk2 = picked;
          for (const c of Array.from(chips.children)) c.classList.remove('selected');
          chip.classList.add('selected');
          descEl.textContent = perk.description;
        });
        chips.appendChild(chip);
      }
      wrap.appendChild(chips);
      wrap.appendChild(descEl);
      perkSlots.appendChild(wrap);
    };
    renderPerkSlot(0);
    renderPerkSlot(1);

    const actions = el('div', 'loadout-actions');
    const backBtn = el('button', 'btn', 'Back') as HTMLButtonElement;
    backBtn.type = 'button';
    backBtn.addEventListener('click', () => onBack());
    const saveBtn = el('button', 'btn btn-primary', 'Save') as HTMLButtonElement;
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', () => onSave({ ...loadout }));
    actions.appendChild(backBtn);
    actions.appendChild(saveBtn);
    panel.appendChild(actions);

    this.element.appendChild(panel);
  }
}
