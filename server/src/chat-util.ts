import { checksum53, htmlEscape, htmlUnescape, isNumber } from '@tubular/util';
import { DomElement, DomNode } from 'fortissimo-html/dist/dom.js';
import express from 'express';

const IP_MATCHER = /(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)/;
const IMAGE_DOMAIN = process.env.CHAT_DOMAIN_FOR_IMAGES;

export function getIp(req: express.Request): string {
  return req.ip || req.socket?.remoteAddress || (req as any).connection?.remoteAddress || (req as any).connection?.socket?.remoteAddress;
}

export function extractIp(str: string): string {
  return IP_MATCHER.exec(str)?.[0] || '';
}

export function getToken(req: express.Request): string {
  const auth = req.headers.authorization;
  return auth?.startsWith('Bearer ') ? auth.slice(7) : null;
}

export function messageHash(name: string, trip: string, timestamp: string | number): string {
  if (isNumber(timestamp))
    timestamp = new Date(timestamp * 1000).toISOString().slice(0, 19);

  return checksum53(`${name};${trip || ''};${timestamp}`);
}

export function convertBBCodeToHtml(text: string): string {
  text = text.replace(/</g, '\uFFFDlt;').replace(/>/g, '\uFFFDgt;')
    .replace(/\[(\/?)(b|code|del|i|img|kao|s|s1|s2|s3|s4|s5|u|url=.*?|url)]/g, '<$1$2>')
    .replace(/<del>/g, '<s>').replace(/<\/del>/g, '</s>')
    .replace(/<s(\d)>/g, '<span class="fontSize$1">').replace(/<\/s\d>/g, '</span>')
    .replace(/<kao>/g, '<span class="kaomoji">').replace(/<\/kao>/g, '</span>')
    .replace(/<url=(.*?)>(.*?)<\/url>/g,  (_$0, $1, $2) => `<a href="${$1}" target="_blank">${$2}</a>`)
    .replace(/<img>(.*?)<\/img>/g, '<img src="$1" alt="">')
    .replace(/(^|>)(.*?)(<|$)/g, (_$0, $1, $2, $3) => `${$1}${htmlEscape($2)}${$3}`)
    .replace(/\uFFFD/g, '&');

  return text;
}

export function getTextAndMarkupAsBBCode(elems: DomElement[], domain: string): string {
  if (!elems)
    return '';

  let text = '';

  for (const elem of elems) {
    if (elem instanceof DomNode) {
      const inner = getTextAndMarkupAsBBCode(elem.children, domain);
      let fromElem = `[${elem.tag}]${inner}[/${elem.tag}]`;

      if (elem.tag === 'a')
        fromElem = `[url=${inner}]${inner}[/url]`;
      else if (elem.tag === 'del')
        fromElem = `[s]${inner}[/s]`;
      else if (elem.tag === 'span') {
        const qlass = elem.valuesLookup['class'];

        if (qlass === 'kaomoji')
          fromElem = `[kao]${inner}[/kao]`;
        else if (/^fontSize\d/.test(qlass)) {
          const size = qlass.slice(-1);

          fromElem = `[s${size}]${inner}[/s${size}]`;
        }
        else
          fromElem = inner; // No other styling supported
      }
      else if (elem.tag === 'img') {
        const alt = elem.valuesLookup['alt'];

        if (alt)
          fromElem = alt;
        else {
          const src = elem.valuesLookup['src']?.replace(/^\/(.*)$/, `https://${IMAGE_DOMAIN || domain}/$1`);

          fromElem = `[img]${src}[/img]`;
        }
      }

      text += fromElem;
    }
    else
      text += htmlUnescape(elem.content || '');
  }

  return text;
}

export function simplifyError(err: any): any {
  const message = err.code || err.message || err.toString();

  if (message.includes('ENOTFOUND'))
    return 'Chat server not found';
  else if (message.includes('ECONNREFUSED'))
    return 'Chat server refused connection';
  else if (message.includes('ECONNRESET'))
    return 'Chat server reset connection';
  else if (message.includes('ETIMEDOUT'))
    return 'Chat server timed out';
  else if (message.includes('ER_PARSE_ERROR'))
    return 'SQL parse error: ' + err.sqlMessage;

  return message;
}

export function unescapeUnicode(text: string): string {
  return text.replace(/#U\+([0-9A-F]{4})/gi, (_$0, $1) => String.fromCharCode(parseInt($1, 16)));
}

export function timeStamp(): string {
  return '[' + new Date().toISOString().slice(0, 19) + 'Z]';
}

export function Now(): number { return Math.floor(Date.now() / 1000); }

export function parseChatTime(time: string, asString?: string[]): number {
  const parts = time?.split(/[- :/]/).map((p, i) => p.padStart(i === 0 ? 4 : 2, '0'));
  const timestamp = parts?.length !== 6 ? null : `${parts[0]}-${parts[1]}-${parts[2]}T${parts[3]}:${parts[4]}:${parts[5]}`;

  if (asString)
    asString[0] = timestamp;

  return timestamp ? Math.floor(new Date(timestamp + 'Z').getTime() / 1000) : 0;
}
