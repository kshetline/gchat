import { Injectable } from '@angular/core';
import { clone, throttle } from '@tubular/util';
import { Preferences } from '../server/src/shared-types';

@Injectable({
  providedIn: 'root',
})
export class PreferencesService {
  private prefs: Preferences = { color: '#000000', email: '', name: ''};

  constructor() {
    const prefsStr = localStorage.getItem('gchat');

    if (prefsStr) {
      try {
        this.prefs = JSON.parse(prefsStr);

        if (!this.prefs || (typeof this.prefs !== 'object'))
          this.prefs = undefined;
      }
      catch (err) {}
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
