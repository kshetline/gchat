import axios from 'axios';
import cookieParser from 'cookie-parser';
import express from 'express';
import session from 'express-session';
import { HtmlParser } from 'fortissimo-html';
import { DomElement, DomNode } from 'fortissimo-html/dist/dom';
import * as puppeteer from 'puppeteer';
import { Message, Messages } from './shared-types';
import { checksum53, encodeForUri, toBoolean, toInt } from '@tubular/util';

interface SessionInfo {
  browser?: puppeteer.Browser;
  page?: puppeteer.Page;
}

const app = express();
const port = toInt(process.env.HTTP_PORT) || 3000;
const domain = process.env.CHAT_DOMAIN;
const parser = new HtmlParser();
const sessions = new Map<string, SessionInfo>();

function getTextAndMarkup(elems: DomElement[], domain: string): string {
  if (!elems)
    return '';

  let text = '';

  for (const elem of elems) {
    if (elem instanceof DomNode) {
      const inner = getTextAndMarkup(elem.children, domain);
      let fromElem = `<${elem.tag}>${inner}</${elem.tag}>`;

      if (elem.tag === 'a')
        fromElem = fromElem.replace(/^<a>/, `<a href="${inner}" target="_blank">`);
      else if (elem.tag === 'span')
        fromElem = fromElem.replace(/^<span>/, `<span class="${elem.valuesLookup['class']}">`);
      else if (elem.tag === 'img') {
        const alt = elem.valuesLookup['alt'];

        if ([...(alt || '')].length == 1)
          fromElem = alt;
        else {
          const src = elem.valuesLookup['src']?.replace(/^\/(.*)$/, `https://${domain}/$1`);

          fromElem = fromElem.replace(/>.*/, ` src=${src} alt=${alt || ''}>`);
        }
      }

      text += fromElem;
    }
    else
      text += elem.content || '';
  }

  return text;
}

function extractMessage(messageRow: DomNode): Message {
  const text = getTextAndMarkup(messageRow.querySelector('.messageComment').children, domain);
  const nameElem = messageRow.querySelector('.messageName');
  const style = nameElem?.valuesLookup['style'];
  let nameIndex = 1;
  let email: string;
  const firstNode = (nameElem?.children?.at(0) as DomNode);

  if (firstNode?.tag === 'a') {
    email = firstNode.valuesLookup['href'];
    ++nameIndex;
  }

  const name = (nameElem?.children?.at(nameIndex) as DomNode)?.children?.at(0)?.content;
  const timestamp = messageRow.querySelector('.messageDate')?.children?.at(0)?.content?.slice(1, -1)
    .replace('-', 'T').replace(/\//g, '-').replace(/\b(\d)\b/g, '0$1');
  const trip = (nameElem?.children?.at(nameIndex + 1) as DomNode)?.content?.substring(1);
  const hash = checksum53(`${name};${trip || ''};${timestamp}`);

  return { email, hash, name, style, text, timestamp, trip };
}

async function getMessages(name: string): Promise<Messages> {
  const url = `https://${domain}/comchat.cgi?retime=20&lines=200&name=${encodeForUri(name, true)}`;
  const raw = (await axios.get(url)).data;
  const dom = parser.parse(raw).domRoot;
  const body = dom.querySelector('body');
  const participantDiv = body?.querySelector('#participantList');
  const participants = Array.from(new Set(participantDiv.children[0].content.trim().replace(/^.*:\s*/g, '').split(/[◆◇]/)
    .map(p => p.trim()).filter(p => !!p)).values()).sort();
  const messageRows = body?.querySelectorAll('.messageRow').reverse();
  const messages = messageRows.map(row => extractMessage(row));

  return { messages, participants, temp: messageRows[0] };
}

async function loadEnterForm(page: puppeteer.Page): Promise<void> {
  await page.goto(`http://${domain}/comchat.cgi?mode=form&nam=&eml=&col=&retime=40&line=20`);
  await page.waitForSelector('form');
  await page.$eval('form', form => form.setAttribute('target', '_self'));
}

async function enterChat(sesh: string, name: string, email: string, color: number): Promise<void> {
  const page = sessions.get(sesh).page;

  await page.waitForSelector('input[name="name"]');
  await page.type('input[name="name"]', name);
  await page.type('input[name="email"]', email || '');
  await page.$eval(`input[type="radio"][value="${color}"]`, btn => btn.click());
  await page.$eval('input[type="submit"]', btn => btn.click());
  await page.waitForSelector('input[name="comment"]');
  await page.$eval('form', form => form.setAttribute('target', '_blank'));
}

async function leaveChat(sesh: string): Promise<void> {
  const page = sessions.get(sesh).page;

  await page.waitForSelector('input[type="button"]');
  await page.$eval('input[type="submit"]', btn => btn.click());
  await loadEnterForm(page);
}

async function sendMessage(sesh: string, comment: string, color: number): Promise<void> {
  const page = sessions.get(sesh).page;

  await page.waitForSelector('input[name="comment"]');
  await page.$eval('select[name="color"]', (sel, c) => sel.value = c, color);
  await page.type('input[name="comment"]', comment);
  await page.focus('input[name="comment"]');
  await page.keyboard.press('Enter');
}

app.use(session({
  secret: process.env.SESSION_KEY,
  resave: true,
  saveUninitialized: true,
  cookie: { secure: toBoolean(process.env.SESSION_SECURE) }
}));

app.use(async (req, _res, next) => {
  let sesh = sessions.get(req.sessionID);

  if (!sesh) {
    sesh = { browser: await puppeteer.launch() };
    sessions.set(req.sessionID, sesh);
    sesh.page = await sesh.browser.newPage();
    sesh.page.on('console', msg => {
      console.log('Puppeteer %s: %s', msg.type, msg.text());
    });
    await loadEnterForm(sesh.page);
  }

  next();
})

app.use(cookieParser());

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

app.get('/api/messages', async (req, res) => {
  res.json(await getMessages(req.query.name as string));
});

app.post('/api/enter', async (req, res) => {
  const q = req.query as any;

  await enterChat(req.sessionID, q.name, q.email, q.color);
  res.send('null');
});

app.post('/api/leave', async (req, res) => {
  await leaveChat(req.sessionID);
  res.send('null');
});

app.post('/api/send', async (req, res) => {
  await sendMessage(req.sessionID, (req.query as any).comment, (req.query as any).color);
  res.send('null');
});
