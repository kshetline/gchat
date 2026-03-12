import axios from 'axios';
import cookieParser from 'cookie-parser';
import express from 'express';
import session from 'express-session';
import { HtmlParser } from 'fortissimo-html';
import { DomElement, DomNode } from 'fortissimo-html/dist/dom';
import * as puppeteer from 'puppeteer';
import { Message, Messages } from './shared-types';
import { encodeForUri, toBoolean, toInt } from '@tubular/util';

interface SessionInfo {
  browser?: puppeteer.Browser;
  page?: puppeteer.Page;
}

const app = express();
const port = toInt(process.env.HTTP_PORT) || 3000;
const domain = process.env.CHAT_DOMAIN;
const parser = new HtmlParser();
const sessions = new Map<string, SessionInfo>();

function getTextAndMarkup(elems: DomElement[]): string {
  if (!elems)
    return '';

  let text = '';

  for (const elem of elems) {
    if (elem instanceof DomNode) {
      const inner = getTextAndMarkup(elem.children);
      let fromElem = `<${elem.tag}>${inner}</${elem.tag}>`;

      if (elem.tag === 'a')
        fromElem = fromElem.replace(/^<a>/, `<a href="${inner}" target="_blank">`);
      else if (elem.tag === 'span')
        fromElem = fromElem.replace(/^<span>/, `<span class="${elem.valuesLookup['class']}">`);

      text += fromElem;
    }
    else
      text += elem.content || '';
  }

  return text;
}

function extractMessage(messageRow: DomNode): Message {
  const text = getTextAndMarkup(messageRow.querySelector('.messageComment').children);
  const nameElem = messageRow.querySelector('.messageName');
  const style = nameElem?.valuesLookup['style'];
  const name = (nameElem?.children[1] as DomNode).children[0]?.content;
  const timestamp = messageRow.querySelector('.messageDate').children[0]?.content?.slice(1, -1)
    .replace('-', 'T').replace(/\//g, '-').replace(/\b(\d)\b/g, '0$1');
  const trip = (nameElem?.children[2] as DomNode)?.content?.substring(1);

  return { name, style, text, timestamp, trip };
}

async function getMessages(name: string): Promise<Messages> {
  const url = `https://${domain}/comchat.cgi?retime=20&lines=30&name=${encodeForUri(name, true)}`;
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

async function enterChat(sesh: string, name: string, email: string): Promise<void> {
  const page = sessions.get(sesh).page;

  await page.waitForSelector('input[name="name"]');
  await page.type('input[name="name"]', name);
  await page.type('input[name="email"]', email || '');
  await page.click('input[type="submit"]');
  await page.waitForSelector('input[name="comment"]');
}

async function leaveChat(name: string): Promise<void> {
  await axios.get(`https://${domain}/comchat.cgi`, { params: { mode: 'out', name } });
}

async function sendMessage(sesh: string, comment: string): Promise<void> {
  const page = sessions.get(sesh).page;

  await page.waitForSelector('input[name="comment"]');
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
    await sesh.page.goto(`http://${domain}/comchat.cgi?mode=form&nam=&eml=&col=&retime=40&line=20`);
    await sesh.page.waitForSelector('form');
    await sesh.page.$eval('form', form => form.setAttribute('target', '_self'));
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
  await enterChat(req.sessionID, (req.query as any).name, (req.query as any).email);
  res.send('null');
});

app.post('/api/leave', async (req, res) => {
  await leaveChat((req.query as any).name);
  res.send('null');
});

app.post('/api/send', async (req, res) => {
  await sendMessage(req.sessionID, (req.query as any).comment);
  res.send('null');
});
