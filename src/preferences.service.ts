import { Injectable } from '@angular/core';
import { clone, forEach, throttle } from '@tubular/util';
import { Preferences } from '../server/src/shared-types';

const defaultPrefs: Preferences = {
  allowDMs: false, color: 0, email: '', localTime: true, name: '', newOnBottom: true, notifySound: true, tripCode: ''
};

@Injectable({
  providedIn: 'root',
})
export class PreferencesService {
  private prefs = clone(defaultPrefs);

  constructor() {
    const prefsStr = localStorage.getItem('gchat');

    if (prefsStr) {
      try {
        this.prefs = JSON.parse(prefsStr);

        if (!this.prefs || (typeof this.prefs !== 'object'))
          this.prefs = undefined;
        else {
          const prefs = this.prefs as any;

          forEach(defaultPrefs as Record<string, any>, (key, value) => {
            if (prefs[key] === undefined || typeof prefs[key] !== typeof value)
              prefs[key] = value;
          });
        }
      }
      catch {}
    }
  }

  get(): Preferences {
    return this.prefs && clone(this.prefs);
  }

  private savePrefs(): void {
    localStorage.setItem('gchat', JSON.stringify(this.prefs));
  }

  private throttledSavePrefs = throttle(-2000, this.savePrefs.bind(this));

  set(newPrefs: Preferences): void {
    this.prefs = newPrefs && clone(newPrefs);
    this.throttledSavePrefs();
  }
}
