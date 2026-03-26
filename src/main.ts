import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { parseColor, regexEscape } from '@tubular/util';
import { colors } from '../server/src/shared-types';

bootstrapApplication(App, appConfig)
  .catch(err => console.error(err));

export const kaomoji = [
  '(＾_＾)', '(＾_＾；)', '(*＾＾*)', '(；_；)', '(ーー；', 'ｍ（_ _）ｍ', '(・_・)', '(＾＾）/~~',
  '(＠_＠)', '＼（＾Ｏ＾）／', '(？_？)', '(｀・ω・´) ', 'ヽ(´ー｀)ノ', '(;´Д`)', 'ヽ(´∇`)ノ', '(´∇`)σ',
  '(;^Д^)', '(;ﾟ∇ﾟ)', '(;ﾟДﾟ)', 'ヽ(`Д´)ノ', '(ρ_;)', '(´￢`)', 'ヽ(ﾟρﾟ)ノ', 'ヽ(´π｀)ノ',
  '(ﾟДﾟ)', '(´人｀)', 'ъ( ﾟｰ^)', '(⌒∇⌒ゞ)', '(^^;ﾜﾗ', '┐(´∀｀)┌', '(｀∩´)σ'
];
export const kaomojiRegex = new RegExp(`(${kaomoji.map(regexEscape).join('|')})`, 'g');

export function colorByIndex(index: number, darkMode = false): string {
  if (index === 0 && darkMode)
    return '#FFFFFF';
  else
    return colors[index % colors.length].trimEnd();
}

export function colorFromStyle(styleOrColor: string): string {
  return (/color:\s*([^;]+)\b/.exec(styleOrColor) || [])[1] || styleOrColor;
}
export function getLuminance(color: string): number {
  const rgb = parseColor(color);

  return rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114;
}

export function getTextBackground(styleOrColor: string, darkMode = false): string {
  const color = colorFromStyle(styleOrColor);
  let lightBackground = true;

  if (color) {
    const luminance = getLuminance(color);

    if (darkMode ? luminance > 85 : luminance > 140)
      lightBackground = false;
  }

  return lightBackground ? (darkMode ? '#AAA' : '#FFF') : '#333';
}

let clickSuppress: any;

export function startClickSuppress(): void {
  if (clickSuppress)
    clearTimeout(clickSuppress);

  clickSuppress = setTimeout((): any => clickSuppress = undefined, 250);
}

export function shouldIgnoreClick(): boolean {
  return !!clickSuppress;
}

type NotificationType = 'info' | 'success' | 'warning' | 'error';

export type NotificationHandler = (type: NotificationType, message: string) => void;

let notificationHandler: NotificationHandler;

export function registerNotificationHandler(handler: NotificationHandler): void {
  notificationHandler = handler;
}

export function notify(type: NotificationType, message: string): void {
  if (notificationHandler)
    notificationHandler(type, message);
  else {
    switch (type) {
      case 'info':
        console.info(message);
        break;
      case 'success':
        console.log(message);
        break;
      case 'warning':
        console.warn(message);
        break;
      case 'error':
        console.error(message);
        break;
    }
  }
}
