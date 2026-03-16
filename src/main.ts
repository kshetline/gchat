import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { parseColor } from '@tubular/util';

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));

export const colors = ['#000000', '#000080', '#4444cc', '#44cc44', '#cc9911', '#cc4444', '#cc6600', '',
                       '#008040', '#33aaaa', '#cc44cc', '#800000', '#FF80C0', '#b87333', '#8ca9d9', '#4682b4'];

export function colorByIndex(index: number, darkMode = false): string {
  if (index === 0 && darkMode)
    return '#FFFFFF';
  else
    return colors[index % colors.length];
}

export function colorFromStyle(styleOrColor: string): string {
  return (/color:\s*([^;]+)\b/.exec(styleOrColor) || [])[1] || styleOrColor;
}

export function getTextBackground(styleOrColor: string, darkMode = false): string {
  const color = colorFromStyle(styleOrColor);
  let lightBackground = true;

  if (color) {
    const rgb = parseColor(color);
    const luminance = rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114;

    if (darkMode ? luminance > 85 : luminance > 140)
      lightBackground = false;
  }

  return lightBackground ? (darkMode ? '#AAA' : 'white') : '#333';
}
