import { Message, Messages } from './shared-types';
import { checksum53, encodeForUri, htmlEscape, htmlUnescape } from '@tubular/util';
import axios from 'axios';
import { HtmlParser } from 'fortissimo-html';
import { DomElement, DomNode } from 'fortissimo-html/dist/dom.js';
import { SessionInfo } from './session-info';
import * as puppeteer from 'puppeteer';

const domain = process.env.CHAT_DOMAIN;
const parser = new HtmlParser();

let browser: puppeteer.Browser;

function getTextAndMarkupAsBBCode(elems: DomElement[], domain: string): string {
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

function convertBBCodeToHtml(text: string): string {
  text = text.replace(/\[(\/?)(b|code|i|img|s|s1|s2|s3|s4|s5|u|url=.*?|url)]/g, '<$1$2>')
    .replace(/<s(\d)>/g, '<span class="fontSize$1">').replace(/<\/s\d>/g, '</span>')
    .replace(/<url=(.*?)>(.*?)<\/url>/g,  (_$0, $1, $2) => `<a href="${$1}">${$2}</a>`)
    .replace(/<img>(.*?)<\/img>/g, '<img src="$1" alt="">')
    .replace(/(^|>)(.*?)(<|$)/g, (_$0, $1, $2, $3) => `${$1}${htmlEscape($2)}${$3}`);

  return text;
}

function extractMessage(messageRow: DomNode): Message {
  const bbCode = getTextAndMarkupAsBBCode(messageRow.querySelector('.messageComment').children, domain);
  const html = convertBBCodeToHtml(bbCode);
  const nameElem = messageRow.querySelector('.messageName');
  const style = nameElem?.valuesLookup['style'];
  let nameIndex = 1;
  let email: string;
  const firstNode = nameElem?.children?.at(0) as DomNode;

  if (firstNode?.tag === 'a') {
    email = firstNode.valuesLookup['href'];
    ++nameIndex;
  }

  const name = (nameElem?.children?.at(nameIndex) as DomNode)?.children?.at(0)?.content;
  const timestamp = messageRow.querySelector('.messageDate')?.children?.at(0)?.content?.slice(1, -1)
    .replace('-', 'T').replace(/\//g, '-').replace(/\b(\d)\b/g, '0$1');
  const trip = (nameElem?.children?.at(nameIndex + 1) as DomNode)?.content?.substring(1);
  const hash = checksum53(`${name};${trip || ''};${timestamp}`);

  return { email, hash, name, style, text: html, timestamp, trip };
}

export async function legacyBrowserSetup(): Promise<SessionInfo> {
  browser = browser || (await puppeteer.launch());
  const session: SessionInfo = { context: await browser.createBrowserContext() };
  // sessions.set(req.sessionID, sesh);
  session.page = await session.context.newPage();
  session.page.on('console', msg => {
    console.log('Puppeteer %s: %s', msg.type, msg.text()); // eslint-disable-line @typescript-eslint/unbound-method
  });
  await loadEnterForm(session.page);

  return session;
}
async function loadEnterForm(page: puppeteer.Page): Promise<void> {
  await page.goto(`http://${domain}/comchat.cgi?mode=form&nam=&eml=&col=&retime=40&line=20`);
  await page.waitForSelector('form');
  await page.$eval('form', form => form.setAttribute('target', '_self'));
}

export async function getLegacyMessages(name: string): Promise<Messages> {
  try {
    const url = `https://${domain}/comchat.cgi?retime=20&lines=200&name=${encodeForUri(name, true)}`;
    const raw = (await axios.get(url)).data;
    const dom = parser.parse(raw).domRoot;
    const body = dom.querySelector('body');
    const participantDiv = body?.querySelector('#participantList');
    const participants = Array.from(new Set(participantDiv.children[0].content.trim().replace(/^.*:\s*/g, '').split(/[◆◇]/)
    .map(p => p.trim()).filter(p => !!p)).values()).sort();
    const messageRows = body?.querySelectorAll('.messageRow').reverse();
    let messages = messageRows.map(row => extractMessage(row));
    const hashes = new Set<string>();

    // Filter duplicate messages by hashcode.
    messages = messages.filter(m => !hashes.has(m.hash) && hashes.add(m.hash));

    return { messages, participants };
  }
  catch (err) {
    return { errorMessage: ((err as any).message) || String(err) };
  }
}

export async function enterLegacyChat(session: SessionInfo, name: string, email: string, color: number): Promise<void> {
  if (session?.inChat)
    return;

  const page = session.page;

  await page.waitForSelector('input[name="name"]');
  await page.$eval('input[name="name"]', (input, name) => input.value = name, name);
  await page.$eval('input[name="email"]', (input, email) => input.value = email || '', email);

  try {
    await page.$eval(`input[type="radio"][value="${color}"]`, btn => btn.click());
  }
  catch {}

  await page.$eval('input[type="submit"]', btn => btn.click());
  await page.waitForSelector('input[name="comment"]');
  await page.$eval('form', form => form.setAttribute('target', '_blank'));
  session.inChat = true;
}

export async function leaveLegacyChat(session: SessionInfo): Promise<void> {
  const page = session.page;

  await page.waitForSelector('input[type="button"]');
  await page.$eval('input[type="button"]', btn => btn.click());
  session.inChat = false;
  const oldPage = page;
  session.page = await session.context.newPage();
  await oldPage.close();
  await loadEnterForm(session.page);
}

export async function legacySendMessage(session: SessionInfo, name: string, email: string,
                           comment: string, color: number, tripCode: string): Promise<void> {
  if (!session?.inChat)
    await enterLegacyChat(session, name, email, color);

  const page = session.page;
  let face = '';
  const $ = /^(.*)(\u2000(.+)\u2000)\s*$/.exec(comment);

  if ($) {
    comment = $[1];
    face = $[3];
  }

  await page.waitForSelector('input[name="comment"]');
  await page.$eval('select[name="color"]', (sel, c) => sel.value = c, color);
  await page.$eval('#face', (sel, face) => sel.value = face, face);
  await page.$eval('input[name="comment"]', (input, comment) => input.value = comment, comment || '\u00A0');
  await page.$eval('input[name="password"]', (input, tripCode) => input.value = tripCode, tripCode || '');
  await page.focus('input[name="comment"]');
  await page.keyboard.press('Enter');
}
