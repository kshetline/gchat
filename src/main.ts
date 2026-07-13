import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { isString, parseColor } from '@tubular/util';
import { colors } from '../server/src/shared-types';

bootstrapApplication(App, appConfig)
  .catch(err => console.error(err));

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

    if (darkMode ? luminance > 110 : luminance > 140)
      lightBackground = false;
  }

  return lightBackground ? (darkMode ? '#CCC' : '#FFF') : '#333';
}

export function showInvisibles(text: string): string {
  return text.replace(/\p{Cc}|\p{Cn}|\p{Co}|\p{Cs}/gu, (m) => {
    const cp = m.codePointAt(0).toString(16).toUpperCase();
    return `<span class="code-point"><span>«${cp}»</span></span>`;
  });
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

export let isTyping = (_name: string, _dm: number): boolean => false;

export function setIsTypingFunction(fn: (name: string, dm: number) => boolean): void {
  isTyping = fn;
}

let acknowledgementFailed = false;

export async function userscriptAction(actionOrMaxWait: string | number, ...args: any[]): Promise<string | null> {
  let action: string;
  let maxWait = 0;

  if (isString(actionOrMaxWait))
    action = actionOrMaxWait;
  else {
    maxWait = actionOrMaxWait;
    action = args[0];
    args.splice(0, 1);
  }

  return new Promise<string | null>(((resolve, reject) => {
    let acknowledged = false;
    let resolved = false;

    parent.postMessage([action, ...args], '*');

    const listener = (evt: MessageEvent) => {
      if (resolved)
        return;

      const message = evt.data[0];

      if (message === 'ack:' + action)
        acknowledged = true;
      else if (message === action) {
        window.removeEventListener('message', listener);
        acknowledged = true;
        resolved = true;
        resolve(evt.data[1]);
      }
    };

    window.addEventListener('message', listener);

    if (!acknowledgementFailed) {
      setTimeout(() => {
        if (!acknowledged) {
          acknowledgementFailed = true;
          window.removeEventListener('message', listener);
          resolved = true;
          reject('Userscript not responding. You may have to reload the page.\n\nUserscript v2026.05.06 or later now required.');
        }
      }, 2500);
    }

    if (maxWait > 0)
      setTimeout(() => { if (!resolved) {
        window.removeEventListener('message', listener);
        resolved = true;
        reject(`Timed out waiting for message ${action}`);
      } }, maxWait);
  }));
}
