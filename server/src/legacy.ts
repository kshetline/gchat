import { DbMessage, DbParticipant, Message, Messages } from './shared-types';
import { checksum53, encodeForUri, htmlUnescape, processMillis } from '@tubular/util';
import axios from 'axios';
import { HtmlParser } from 'fortissimo-html';
import { DomElement, DomNode } from 'fortissimo-html/dist/dom.js';
import * as puppeteer from 'puppeteer';
import { convertBBCodeToHtml, getDb } from './db.js';

const domain = process.env.CHAT_DOMAIN;
const proxyName = process.env.CHAT_PROXY;
const proxyTrip = process.env.CHAT_PROXY_TRIPCODE;
const parser = new HtmlParser();

export let browser: puppeteer.Browser;

let messagePage: puppeteer.Page;
let inChat = false;
let lastLegacyPoll = -1;

async function pollLegacyMessages(overrideCount?: number): Promise<void> {
  const now = processMillis();
  const retrieveCount = overrideCount ??
    (lastLegacyPoll < 0 || now > lastLegacyPoll + 3_600_000 ? 1000 : now > lastLegacyPoll + 600_000 ? 200 : 30);

  try {
    const messages = await getLegacyMessages(proxyName, retrieveCount);
    let earliest = Number.MAX_SAFE_INTEGER;
    let latest = 0;
    const db = await getDb();
    const row = await db.get<DbMessage>('SELECT time FROM messages ORDER BY time DESC LIMIT 1');
    const latestInDb = row?.time;

    for (const message of messages.messages || []) {
      if (message.time) {
        earliest = Math.min(message.time, earliest);
        latest = Math.max(message.time, latest);

        if (message.time > latestInDb - 300 || retrieveCount >= 1000) {
          const row = await db.get<DbMessage>('SELECT hash FROM messages WHERE hash = ? LIMIT 1', message.hash);

          if (!row)
            await db.run('INSERT INTO messages (time, synced_time, name, trip, email, remote, style, message, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              message.time, message.time, message.name, message.trip, message.email, 1, message.style, message.bbCode, message.hash);
        }
      }
    }

    for (const participant of messages.participants || []) {
      if (participant === proxyName)
        continue;

      let row = await db.get<DbParticipant>('SELECT * FROM participants where name = ? AND remote = 0 LIMIT 1', participant);

      if (row)
        continue;

      row = await db.get<DbParticipant>('SELECT * FROM participants where name = ? AND remote = 1 LIMIT 1', participant);

      if (!row)
        await db.run('INSERT INTO participants (name, remote, last_active, last_post) VALUES (?, ?, ?, ?)',
          participant, 1, Math.floor(Date.now() / 1000), 0);
    }
  }
  catch (err) {
    console.error('Error polling legacy chat:', err);
  }

  setTimeout(pollLegacyMessages, 10_000);
  lastLegacyPoll = processMillis();
}

pollLegacyMessages().finally();
legacyBrowserSetup().finally();

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
  const time = Math.floor(new Date(timestamp + 'Z').getTime() / 1000);
  const trip = (nameElem?.children?.at(nameIndex + 1) as DomNode)?.content?.substring(1);
  const hash = checksum53(`${name};${trip || ''};${timestamp}`);

  return { bbCode, email, hash, msgId: -1, name, style, html, remote: true, time, trip };
}

async function legacyBrowserSetup(): Promise<void> {
  browser = browser || (await puppeteer.launch());

  messagePage = messagePage || await browser.newPage();
  messagePage.on('console', msg => {
    console.log('Puppeteer %s: %s', msg.type, msg.text()); // eslint-disable-line @typescript-eslint/unbound-method
  });
  await loadEnterForm(messagePage);
}

async function loadEnterForm(page: puppeteer.Page): Promise<void> {
  await page.goto(`http://${domain}/comchat.cgi?mode=form&nam=&eml=&col=&retime=40&line=20`);
  await page.waitForSelector('form');
  await page.$eval('form', form => form.setAttribute('target', '_self'));
}

export async function getLegacyMessages(name: string, count = 200): Promise<Messages> {
  try {
    const url = `https://${domain}/comchat.cgi?retime=120&lines=${count}&name=${encodeForUri(name, true)}`;
    const raw = (await axios.get(url)).data;
    const dom = parser.parse(raw).domRoot;
    const body = dom.querySelector('body');
    const participantDiv = body?.querySelector('#participantList');
    const participants = Array.from(new Set(participantDiv.children[0].content.trim().replace(/^.*:\s*/g, '').split(/[◆◇]/)
      .map(p => p.trim()).filter(p => !!p)).values()).sort();
    const messageRows = body?.querySelectorAll('.messageRow').reverse();
    let messages = messageRows.map(row => extractMessage(row)).filter(m => m.name !== proxyName);
    const proxyMessages = messageRows.map(row => extractMessage(row)).filter(m => m.name === proxyName);
    const hashes = new Set<string>();

    // Filter duplicate messages by hashcode.
    messages = messages.filter(m => !hashes.has(m.hash) && hashes.add(m.hash));

    const latestPosts = new Map<string, number>();

    for (const message of messages) {
      const latest = latestPosts.get(message.name) || message.time;

      latestPosts.set(message.name, message.time > latest ? message.time : latest);
    }

    const db = await getDb();

    for (const message of proxyMessages) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const [_$0, name, msg] = /^《(.+?)》(.*)$/.exec(message.bbCode) || [];

      if (name && msg)
        await db.run('UPDATE messages SET synced_time = ? WHERE name = ? AND message = ? AND synced_time = time AND ABS(synced_time - ?) < 120',
          message.time, name, msg, message.time);
    }

    for (const participant of Array.from(latestPosts.keys()))
      await db.run('UPDATE participants SET last_post = ?1, last_active = MAX(last_active, ?1) WHERE name = ?2 and remote = 1',
        latestPosts.get(participant), participant);

    return { messages, participants };
  }
  catch (err) {
    return { errorMessage: ((err as any).message) || String(err) };
  }
}

export async function enterLegacyChat(name: string, email: string, color: number): Promise<void> {
  messagePage = messagePage || await browser.newPage();

  await messagePage.waitForSelector('input[name="name"]');
  await messagePage.$eval('input[name="name"]', (input, name) => input.value = name, name);
  await messagePage.$eval('input[name="email"]', (input, email) => input.value = email || '', email);

  try {
    await messagePage.$eval(`input[type="radio"][value="${color}"]`, btn => btn.click());
  }
  catch {}

  await messagePage.$eval('input[type="submit"]', btn => btn.click());
  await messagePage.waitForSelector('input[name="comment"]');
  await messagePage.$eval('form', form => form.setAttribute('target', '_blank'));

  inChat = true;
}

export async function leaveLegacyChat(): Promise<void> {
  if (!messagePage)
    return;

  await messagePage.waitForSelector('input[type="button"]');
  await messagePage.$eval('input[type="button"]', btn => btn.click());

  const oldPage = messagePage;
  messagePage = await browser.newPage();
  await oldPage.close();
  await loadEnterForm(messagePage);
  inChat = false;
}

export async function legacySendMessage(name: string, _email: string, comment: string, color: number, _tripCode: string): Promise<void> {
  if (!inChat)
    await enterLegacyChat(proxyName, null, 0);

  messagePage = messagePage || await browser.newPage();
  comment = `《${name}》${comment}`;

  let face = '';
  const $ = /^(.*)(\u2000(.+)\u2000)\s*$/.exec(comment);

  if ($) {
    comment = $[1];
    face = $[3];
  }

  await messagePage.waitForSelector('input[name="comment"]');
  await messagePage.$eval('select[name="color"]', (sel, c) => sel.value = c, color);
  await messagePage.$eval('#face', (sel, face) => sel.value = face, face);
  await messagePage.$eval('input[name="comment"]', (input, comment) => input.value = comment, comment || '\u00A0');
  await messagePage.$eval('input[name="password"]', (input, tripCode) => input.value = tripCode, proxyTrip || '');
  await messagePage.focus('input[name="comment"]');
  await messagePage.keyboard.press('Enter');
}
