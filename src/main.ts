import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { parseColor } from '@tubular/util';

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));

export const colors = ['#000000', '#000080', '#4444cc', '#44cc44', '#cc9911', '#cc4444', '#cc6600', '',
                       '#008040', '#33aaaa', '#cc44cc', '#800000', '#FF80C0', '#b87333', '#8ca9d9', '#4682b4'];

export function getTextBackground(styleOrColor: string): string {
  const color = (/color:\s*([^;]+)\b/.exec(styleOrColor) || [])[1] || styleOrColor;

  if (color) {
    const rgb = parseColor(color);

    if (rgb.r * 0.3 + rgb.g * 0.59 + rgb.b * 0.11 > 140)
      return '#333333';
  }

  return 'white';
}
