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

    const body = el('div', 'settings-body');
    panel.appendChild(body);

    const commit = () => saveSettings(settings);

    // Every field call targets the most recently opened group.
    let target: HTMLElement = body;
    const group = (title: string): HTMLDivElement => {
      const g = el('div', 'settings-group');
      const head = el('div', 'settings-group-title');
      head.appendChild(el('span', 'settings-group-bar'));
      head.appendChild(el('span', undefined, title));
      g.appendChild(head);
      body.appendChild(g);
      target = g;
      return g;
    };

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
      target.appendChild(field);
    };

    const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
      const field = el('div', 'field field-toggle');
      const lbl = el('label', undefined, label);
      const sw = el('button', 'toggle-switch' + (get() ? ' on' : '')) as HTMLButtonElement;
      sw.type = 'button';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', String(get()));
      sw.appendChild(el('span', 'toggle-knob'));
      sw.addEventListener('click', () => {
        const v = !get();
        set(v);
        sw.classList.toggle('on', v);
        sw.setAttribute('aria-checked', String(v));
        commit();
      });
      field.appendChild(lbl);
      field.appendChild(sw);
      target.appendChild(field);
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
      target.appendChild(field);
    };

    group('Controls');
    slider('Sensitivity', 0.1, 4, 0.05, () => settings.sensitivity, (v) => (settings.sensitivity = v));
    slider('ADS sensitivity ×', 0.1, 1.5, 0.05, () => settings.adsSensMult, (v) => (settings.adsSensMult = v));
    slider('Field of view', FOV_MIN, FOV_MAX, 1, () => settings.fov, (v) => (settings.fov = v), (v) => String(Math.round(v)));
    toggle('Invert look Y', () => settings.invertY, (v) => (settings.invertY = v));
    toggle('ADS toggle (vs hold)', () => settings.adsToggle, (v) => (settings.adsToggle = v));
    toggle('Auto-sprint', () => settings.autoSprint, (v) => (settings.autoSprint = v));
    toggle('Auto-mount', () => settings.autoMount, (v) => (settings.autoMount = v));

    group('Video');
    select('Quality', ['auto', 'desktop', 'mobile'] as const, () => settings.quality, (v) => (settings.quality = v));
    select('Character model', ['operator', 'soldier'] as const, () => settings.character, (v) => (settings.character = v));

    group('Audio');
    slider('Master volume', 0, 1, 0.01, () => settings.volumeMaster, (v) => (settings.volumeMaster = v), (v) => `${Math.round(v * 100)}%`);
    slider('SFX volume', 0, 1, 0.01, () => settings.volumeSfx, (v) => (settings.volumeSfx = v), (v) => `${Math.round(v * 100)}%`);
    slider('UI volume', 0, 1, 0.01, () => settings.volumeUi, (v) => (settings.volumeUi = v), (v) => `${Math.round(v * 100)}%`);
    if (opts.isIos) {
      target.appendChild(el('div', 'settings-ios-hint', "Flip the side switch to hear gunfire — iOS silences Web Audio while the ring/silent switch is on."));
    }

    group('Touch');
    slider('Button size', 0.7, 1.5, 0.05, () => settings.touchScale, (v) => (settings.touchScale = v), (v) => `${Math.round(v * 100)}%`);
    slider('Button opacity', 0.2, 1, 0.05, () => settings.touchOpacity, (v) => (settings.touchOpacity = v), (v) => `${Math.round(v * 100)}%`);
    toggle('Vibration', () => settings.vibrate, (v) => (settings.vibrate = v));

    const gyroField = el('div', 'field field-toggle');
    gyroField.appendChild(el('label', undefined, 'Gyro look'));
    const gyroSw = el('button', 'toggle-switch' + (settings.gyro ? ' on' : '')) as HTMLButtonElement;
    gyroSw.type = 'button';
    gyroSw.setAttribute('role', 'switch');
    gyroSw.setAttribute('aria-checked', String(settings.gyro));
    gyroSw.appendChild(el('span', 'toggle-knob'));
    gyroSw.addEventListener('click', async () => {
      const next = !settings.gyro;
      if (next && opts.onGyroPermission) {
        const granted = await opts.onGyroPermission();
        if (!granted) {
          settings.gyro = false;
          gyroSw.classList.remove('on');
          gyroSw.setAttribute('aria-checked', 'false');
          commit();
          return;
        }
      }
      settings.gyro = next;
      gyroSw.classList.toggle('on', next);
      gyroSw.setAttribute('aria-checked', String(next));
      commit();
    });
    gyroField.appendChild(gyroSw);
    target.appendChild(gyroField);

    const actions = el('div', 'settings-actions');
    if (opts.onCredits) {
      const creditsLink = el('button', 'btn btn-ghost', 'Credits') as HTMLButtonElement;
      creditsLink.type = 'button';
      creditsLink.addEventListener('click', () => opts.onCredits?.());
      actions.appendChild(creditsLink);
    }
    const doneBtn = el('button', 'btn btn-primary', 'Done') as HTMLButtonElement;
    doneBtn.type = 'button';
    doneBtn.addEventListener('click', () => onClose());
    actions.appendChild(doneBtn);
    panel.appendChild(actions);

    this.element.appendChild(panel);
  }
}
