import { htmlEscape, htmlUnescape } from '@tubular/util';
import { DomElement, DomNode } from 'fortissimo-html/dist/dom.js';
import express from 'express';

export function getIp(req: express.Request): string {
  return req.ip || req.socket?.remoteAddress || (req as any).connection?.remoteAddress || (req as any).connection?.socket?.remoteAddress;
}

export function convertBBCodeToHtml(text: string): string {
  text = text.replace(/</g, '\uFFFDlt;').replace(/>/g, '\uFFFDgt;')
    .replace(/\[(\/?)(b|code|i|img|s|s1|s2|s3|s4|s5|u|url=.*?|url)]/g, '<$1$2>')
    .replace(/<s(\d)>/g, '<span class="fontSize$1">').replace(/<\/s\d>/g, '</span>')
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
      else if (elem.tag === 'span') {
        const qlass = elem.valuesLookup['class'];

        if (/^fontSize\d/.test(qlass)) {
          const size = qlass.slice(-1);

          fromElem = `[s${size}]${inner}[/s${size}]`;
        }
        else
          fromElem = inner; // No other styling supported
      }
      else if (elem.tag === 'img') {
        const alt = elem.valuesLookup['alt'];

        if ([...(alt || '')].length === 1)
          fromElem = alt;
        else {
          const src = elem.valuesLookup['src']?.replace(/^\/(.*)$/, `https://${domain}/$1`);

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
