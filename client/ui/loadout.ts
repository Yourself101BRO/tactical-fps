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
function rawMetrics(w: WeaponDef): { damage: number; rate: number; range: number; mobility: number; control: number } {
  const damage = w.damageValues.length > 0 ? Math.max(...w.damageValues) * (w.pellets > 1 ? w.pellets : 1) : 0;
  const rate = w.rpm;
  const range = w.damageRanges.length > 0 ? w.damageRanges[w.damageRanges.length - 1]! : 0;
  const mobility = w.adsMoveSpeed;
  const control = 1 / (w.recoilPitch + w.recoilYaw + 0.001);
  return { damage, rate, range, mobility, control };
}

function computeStats(weapons: readonly WeaponDef[]): Map<number, WeaponStats> {
  const raw = weapons.map(rawMetrics);
  const bounds = (key: keyof ReturnType<typeof rawMetrics>) => {
    const values = raw.map((r) => r[key]);
    return [Math.min(...values), Math.max(...values)] as const;
  };
  const [dMin, dMax] = bounds('damage');
  const [rMin, rMax] = bounds('rate');
  const [gMin, gMax] = bounds('range');
  const [mMin, mMax] = bounds('mobility');
  const [cMin, cMax] = bounds('control');

  const out = new Map<number, WeaponStats>();
  weapons.forEach((w, i) => {
    const m = raw[i]!;
    out.set(w.id, {
      damage: normalize(m.damage, dMin, dMax),
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

export class LoadoutScreen {
  readonly element: HTMLDivElement;

  constructor(current: Loadout, onSave: (loadout: Loadout) => void, onBack: () => void) {
    this.element = el('div', 'screen loadout-screen');
    const panel = el('div', 'panel loadout-panel');
    panel.appendChild(el('div', 'loadout-title', 'LOADOUT'));

    const stats = computeStats(WEAPONS);
    const loadout: Loadout = { ...current };

    const weaponSection = (slotLabel: string, slot: number, selected: number, onPick: (id: number) => void) => {
      const section = el('div', 'loadout-section');
      section.appendChild(el('div', 'loadout-section-title', slotLabel));
      const cards = el('div', 'weapon-cards');
      const options = WEAPONS.filter((w: WeaponDef) => w.slot === slot);
      for (const w of options) {
        const card = el('div', 'weapon-card' + (w.id === selected ? ' selected' : ''));
        card.appendChild(el('div', 'weapon-card-name', w.name));
        const s = stats.get(w.id)!;
        statBar(card, 'DMG', s.damage);
        statBar(card, 'RATE', s.rate);
        statBar(card, 'RANGE', s.range);
        statBar(card, 'MOBILITY', s.mobility);
        statBar(card, 'CONTROL', s.control);
        card.addEventListener('click', () => {
          onPick(w.id);
          for (const c of Array.from(cards.children)) c.classList.remove('selected');
          card.classList.add('selected');
        });
        cards.appendChild(card);
      }
      section.appendChild(cards);
      panel.appendChild(section);
    };

    weaponSection('Primary', SLOT_PRIMARY, loadout.primary, (id) => (loadout.primary = id));
    weaponSection('Secondary', SLOT_SECONDARY, loadout.secondary, (id) => (loadout.secondary = id));

    // Lethal / tactical: v1 ships exactly one of each (frag, flash), so this
    // is a fixed readout rather than a picker — the perk-style card layout
    // still communicates what the player is carrying.
    const equipSection = el('div', 'loadout-section');
    equipSection.appendChild(el('div', 'loadout-section-title', 'Equipment'));
    const equipRow = el('div', 'equip-row');
    equipRow.appendChild(el('div', 'equip-chip', 'Lethal: Frag Grenade'));
    equipRow.appendChild(el('div', 'equip-chip', 'Tactical: Flashbang'));
    equipSection.appendChild(equipRow);
    panel.appendChild(equipSection);
    loadout.lethal = LETHAL_FRAG;
    loadout.tactical = TACTICAL_FLASH;

    // Perks: 2 slots, no duplicates (PERK_NONE may repeat — it means "empty").
    const perkSection = el('div', 'loadout-section');
    perkSection.appendChild(el('div', 'loadout-section-title', 'Perks'));
    const perkSlots = el('div', 'perk-slots');
    panel.appendChild(perkSection);

    const renderPerkSlot = (slotIndex: 0 | 1) => {
      const wrap = el('div', 'perk-slot');
      const select = el('select', 'select-input') as HTMLSelectElement;
      for (const perk of PERKS) {
        const o = el('option', undefined, perk.name) as HTMLOptionElement;
        o.value = String(perk.id);
        o.title = perk.description;
        select.appendChild(o);
      }
      select.value = String(slotIndex === 0 ? loadout.perk1 : loadout.perk2);
      select.addEventListener('change', () => {
        const picked = Number(select.value);
        const other = slotIndex === 0 ? loadout.perk2 : loadout.perk1;
        if (picked !== PERK_NONE && picked === other) {
          // No duplicate non-empty perks: bump the change back and clear the other slot instead.
          if (slotIndex === 0) loadout.perk2 = PERK_NONE;
          else loadout.perk1 = PERK_NONE;
          const otherSelect = perkSlots.children[slotIndex === 0 ? 1 : 0]?.querySelector('select');
          if (otherSelect instanceof HTMLSelectElement) otherSelect.value = String(PERK_NONE);
        }
        if (slotIndex === 0) loadout.perk1 = picked;
        else loadout.perk2 = picked;
        const desc = PERKS.find((p: PerkDef) => p.id === picked)?.description ?? '';
        descEl.textContent = desc;
      });
      const descEl = el('div', 'perk-desc', PERKS.find((p: PerkDef) => p.id === (slotIndex === 0 ? loadout.perk1 : loadout.perk2))?.description ?? '');
      wrap.appendChild(select);
      wrap.appendChild(descEl);
      perkSlots.appendChild(wrap);
    };
    renderPerkSlot(0);
    renderPerkSlot(1);
    perkSection.appendChild(perkSlots);

    const actions = el('div', 'loadout-actions');
    const backBtn = el('button', 'btn', 'Back') as HTMLButtonElement;
    backBtn.addEventListener('click', () => onBack());
    const saveBtn = el('button', 'btn btn-primary', 'Save') as HTMLButtonElement;
    saveBtn.addEventListener('click', () => onSave({ ...loadout }));
    actions.appendChild(backBtn);
    actions.appendChild(saveBtn);
    panel.appendChild(actions);

    this.element.appendChild(panel);
  }
}
