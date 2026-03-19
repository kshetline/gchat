import axios from 'axios';
import cookieParser from 'cookie-parser';
import express from 'express';
import session from 'express-session';
import { HtmlParser } from 'fortissimo-html';
import { DomElement, DomNode } from 'fortissimo-html/dist/dom';
import * as puppeteer from 'puppeteer';
import { Config, Message, Messages } from './shared-types';
import { checksum53, encodeForUri, toBoolean, toInt } from '@tubular/util';
import { uploadSingle } from './uploader';
import { SessionInfo } from './session-info';

let browser: puppeteer.Browser;

const app = express();
const port = toInt(process.env.HTTP_PORT) || 3000;
const domain = process.env.CHAT_DOMAIN;
const parser = new HtmlParser();
const sessions = new Map<string, SessionInfo>();
const config: Config = {
  backgroundColor: process.env.CHAT_BACKGROUND || '#DDD',
  navigation: process.env.NAV_LINKS.split(';').map(link => link.split('::'))
    .map(link => ({ name: link[0], url: link[1], target: link[2] || '_blank' })),
  title: process.env.CHAT_TITLE,
};

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
  try {
    const url = `https://${domain}/comchat.cgi?retime=20&lines=200&name=${encodeForUri(name, true)}`;
    const raw = (await axios.get(url)).data;
    const dom = parser.parse(raw).domRoot;
    const body = dom.querySelector('body');
    const participantDiv = body?.querySelector('#participantList');
    const participants = Array.from(new Set(participantDiv.children[0].content.trim().replace(/^.*:\s*/g, '').split(/[◆◇]/)
      .map(p => p.trim()).filter(p => !!p)).values()).sort();
    const messageRows = body?.querySelectorAll('.messageRow').reverse();
    const messages = messageRows.map(row => extractMessage(row));

    return { messages, participants };
  }
  catch (err) {
    return { errorMessage: ((err as any).message) || String(err) };
  }
}

async function loadEnterForm(page: puppeteer.Page): Promise<void> {
  await page.goto(`http://${domain}/comchat.cgi?mode=form&nam=&eml=&col=&retime=40&line=20`);
  await page.waitForSelector('form');
  await page.$eval('form', form => form.setAttribute('target', '_self'));
}

async function enterChat(sesh: string, name: string, email: string, color: number): Promise<void> {
  const session = sessions.get(sesh);

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

async function leaveChat(sesh: string): Promise<void> {
  const session = sessions.get(sesh);
  const page = session.page;

  await page.waitForSelector('input[type="button"]');
  await page.$eval('input[type="button"]', btn => btn.click());
  session.inChat = false;
  const oldPage = page;
  session.page = await session.context.newPage();
  await oldPage.close();
  await loadEnterForm(session.page);
}

async function sendMessage(sesh: string, name: string, email: string,
                           comment: string, color: number, tripCode: string): Promise<void> {
  const session = sessions.get(sesh);

  if (!session?.inChat) {
    await enterChat(sesh, name, email, color);
  }

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

app.use(session({
  secret: process.env.SESSION_KEY,
  resave: true,
  saveUninitialized: true,
  cookie: { secure: toBoolean(process.env.SESSION_SECURE) }
}));

app.use(async (req, _res, next) => {
  let sesh = sessions.get(req.sessionID);

  if (!sesh) {
    browser = browser || (await puppeteer.launch());
    sesh = { context: await browser.createBrowserContext() };
    sessions.set(req.sessionID, sesh);
    sesh.page = await sesh.context.newPage();
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

app.get('/api/config', (_req, res) => {
  res.json(config);
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
  const q = req.query as any;

  await sendMessage(req.sessionID, q.name, q.email, q.comment, q.color, q.tripCode);
  res.send('null');
});

app.post('/api/upload', async (req, res) => {
  let session = sessions.get(req.sessionID);

  try {
    const file = await uploadSingle(session, req, res);
    const fileUrl = `/uploads/${file.filename}`;
    res.json({ url: fileUrl });
  }
  catch (error) {
    console.error('Upload error:', error);
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Upload failed'
    });
  }
});
