// Settings screen: every field in client/settings.ts#Settings, plus the iOS
// silent-switch hint and a Credits link. Plan §7 (desktop settings list),
// §9 (iOS mute switch), §6.

import { FOV_MAX, FOV_MIN } from '../../shared/constants.ts';
import type { Settings } from '../settings.ts';
import { saveSettings } from '../settings.ts';

export interface SettingsOpts {
  isIos: boolean;
  onGyroPermission?: () => Promise<boolean>;
  /** Optional: wired by UI so the in-settings Credits link can open the credits screen. */
  onCredits?: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class SettingsScreen {
  readonly element: HTMLDivElement;

  constructor(settings: Settings, onClose: () => void, opts: SettingsOpts) {
    this.element = el('div', 'screen settings-screen');
    const panel = el('div', 'panel settings-panel');
    panel.appendChild(el('div', 'settings-title', 'SETTINGS'));

    const commit = () => saveSettings(settings);

    const slider = (
      label: string,
      min: number,
      max: number,
      step: number,
      get: () => number,
      set: (v: number) => void,
      format: (v: number) => string = (v) => v.toFixed(2),
    ) => {
      const field = el('div', 'field');
      field.appendChild(el('label', undefined, label));
      const row = el('div', 'slider-row');
      const input = el('input', 'range-input') as HTMLInputElement;
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(get());
      const valueEl = el('span', 'range-value', format(get()));
      input.addEventListener('input', () => {
        const v = Number(input.value);
        set(v);
        valueEl.textContent = format(v);
        commit();
      });
      row.appendChild(input);
      row.appendChild(valueEl);
      field.appendChild(row);
      panel.appendChild(field);
    };

    const checkbox = (label: string, get: () => boolean, set: (v: boolean) => void) => {
      const field = el('div', 'field field-checkbox');
      const input = el('input') as HTMLInputElement;
      input.type = 'checkbox';
      input.checked = get();
      input.addEventListener('change', () => {
        set(input.checked);
        commit();
      });
      const lbl = el('label', undefined, label);
      field.appendChild(input);
      field.appendChild(lbl);
      panel.appendChild(field);
    };

    const select = <T extends string>(label: string, options: readonly T[], get: () => T, set: (v: T) => void) => {
      const field = el('div', 'field');
      field.appendChild(el('label', undefined, label));
      const input = el('select', 'select-input') as HTMLSelectElement;
      for (const opt of options) {
        const o = el('option', undefined, opt) as HTMLOptionElement;
        o.value = opt;
        input.appendChild(o);
      }
      input.value = get();
      input.addEventListener('change', () => {
        set(input.value as T);
        commit();
      });
      field.appendChild(input);
      panel.appendChild(field);
    };

    panel.appendChild(el('div', 'settings-section-title', 'Controls'));
    slider('Sensitivity', 0.1, 4, 0.05, () => settings.sensitivity, (v) => (settings.sensitivity = v));
    slider('ADS sensitivity ×', 0.1, 1.5, 0.05, () => settings.adsSensMult, (v) => (settings.adsSensMult = v));
    slider('Field of view', FOV_MIN, FOV_MAX, 1, () => settings.fov, (v) => (settings.fov = v), (v) => String(Math.round(v)));
    checkbox('Invert look Y', () => settings.invertY, (v) => (settings.invertY = v));
    checkbox('ADS toggle (vs hold)', () => settings.adsToggle, (v) => (settings.adsToggle = v));
    checkbox('Auto-sprint', () => settings.autoSprint, (v) => (settings.autoSprint = v));
    checkbox('Auto-mount', () => settings.autoMount, (v) => (settings.autoMount = v));

    panel.appendChild(el('div', 'settings-section-title', 'Video'));
    select('Quality', ['auto', 'desktop', 'mobile'] as const, () => settings.quality, (v) => (settings.quality = v));

    panel.appendChild(el('div', 'settings-section-title', 'Audio'));
    slider('Master volume', 0, 1, 0.01, () => settings.volumeMaster, (v) => (settings.volumeMaster = v), (v) => `${Math.round(v * 100)}%`);
    slider('SFX volume', 0, 1, 0.01, () => settings.volumeSfx, (v) => (settings.volumeSfx = v), (v) => `${Math.round(v * 100)}%`);
    slider('UI volume', 0, 1, 0.01, () => settings.volumeUi, (v) => (settings.volumeUi = v), (v) => `${Math.round(v * 100)}%`);
    if (opts.isIos) {
      panel.appendChild(el('div', 'settings-ios-hint', "Flip the side switch to hear gunfire — iOS silences Web Audio while the ring/silent switch is on."));
    }

    panel.appendChild(el('div', 'settings-section-title', 'Touch controls'));
    slider('Button size', 0.7, 1.5, 0.05, () => settings.touchScale, (v) => (settings.touchScale = v), (v) => `${Math.round(v * 100)}%`);
    slider('Button opacity', 0.2, 1, 0.05, () => settings.touchOpacity, (v) => (settings.touchOpacity = v), (v) => `${Math.round(v * 100)}%`);
    checkbox('Vibration', () => settings.vibrate, (v) => (settings.vibrate = v));
    const gyroField = el('div', 'field field-checkbox');
    const gyroCheck = el('input') as HTMLInputElement;
    gyroCheck.type = 'checkbox';
    gyroCheck.checked = settings.gyro;
    gyroCheck.addEventListener('change', async () => {
      if (gyroCheck.checked && opts.onGyroPermission) {
        const granted = await opts.onGyroPermission();
        if (!granted) {
          gyroCheck.checked = false;
          settings.gyro = false;
          commit();
          return;
        }
      }
      settings.gyro = gyroCheck.checked;
      commit();
    });
    gyroField.appendChild(gyroCheck);
    gyroField.appendChild(el('label', undefined, 'Gyro look'));
    panel.appendChild(gyroField);

    panel.appendChild(el('div', 'settings-section-title', 'Character'));
    select('Model', ['operator', 'soldier'] as const, () => settings.character, (v) => (settings.character = v));

    const actions = el('div', 'settings-actions');
    if (opts.onCredits) {
      const creditsLink = el('button', 'btn btn-ghost', 'Credits') as HTMLButtonElement;
      creditsLink.addEventListener('click', () => opts.onCredits?.());
      actions.appendChild(creditsLink);
    }
    const doneBtn = el('button', 'btn btn-primary', 'Done') as HTMLButtonElement;
    doneBtn.addEventListener('click', () => onClose());
    actions.appendChild(doneBtn);
    panel.appendChild(actions);

    this.element.appendChild(panel);
  }
}
