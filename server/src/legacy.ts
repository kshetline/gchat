import { DbMessage, DbParticipant, kaomojiEndRegex, Message, Messages, ParticipantInfo } from './shared-types.js';
import { encodeForUri, htmlUnescape, processMillis } from '@tubular/util';
import axios from 'axios';
import { HtmlParser } from 'fortissimo-html';
import { DomNode } from 'fortissimo-html/dist/dom.js';
import * as puppeteer from 'puppeteer';
import { getDb } from './db.js';
import { convertBBCodeToHtml, getTextAndMarkupAsBBCode, messageHash, Now, simplifyError } from './chat-util.js';
import tripcode from 'tripcode';
import { isShuttingDown, MAX_IDLE_PARTICIPANT_AGE } from './app.js';
import { clearLegacyAccessTimes, tallyForLockout, TIME_WINDOW } from './intrusion-detector.js';

const domain = process.env.CHAT_DOMAIN;
const proxyName = process.env.CHAT_PROXY || 'CHAT②';
const proxyTrip = process.env.CHAT_PROXY_TRIPCODE;
const proxyTripEncoded = tripcode(proxyTrip);
const parser = new HtmlParser();
export const MAX_IDLE_PARTICIPANT_LEEWAY = 600; // 10 minutes

export let browser: puppeteer.Browser;
export let participantsRaw: string;
export let lastSuccessfulLegacyPoll = -1;

let messagePage: puppeteer.Page;
let inChat = false;
let lastLegacyPoll = -1;
let firstParticipantPoll = true;
let pollingTimeout: NodeJS.Timeout;

interface PendingDuplicate {
  id: number;
  time: number;
  name: string;
  comment: string;
}

export const pendingDuplicates: PendingDuplicate[] = [];

export function addPendingDuplicate(id: number, time: number, name: string, comment: string): void {
  pendingDuplicates.push({ id, time, name, comment });
}

function extractMessage(messageRow: DomNode): Message {
  const bbCode = getTextAndMarkupAsBBCode(messageRow.querySelector('.messageComment').children, domain)
    .replace(kaomojiEndRegex, '\u2000$1\u2000');
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

  const name = htmlUnescape((nameElem?.children?.at(nameIndex) as DomNode)?.children?.at(0)?.content || '').trim();
  const rawTime = messageRow.querySelector('.messageDate')?.children?.at(0)?.content?.slice(1, -1);
  const parts = rawTime?.split(/[- :/]/).map((p, i) => p.padStart(i === 0 ? 4 : 2, '0'));
  const timestamp = parts?.length !== 6 ? null : `${parts[0]}-${parts[1]}-${parts[2]}T${parts[3]}:${parts[4]}:${parts[5]}`;
  const time = Math.floor(new Date(timestamp + 'Z').getTime() / 1000);
  const trip = (nameElem?.children?.at(nameIndex + 1) as DomNode)?.content?.substring(1);
  const hash = messageHash(name, trip, timestamp);

  return { bbCode, email, hash, msgId: -1, name, style, html, remote: true, time, trip };
}

export async function getLegacyMessages(name: string, count = 200): Promise<Messages> {
  const url = `https://${domain}/comchat.cgi?retime=120&lines=${count}&name=${encodeForUri(name, true)}`;
  const raw = (await axios.get(url)).data;
  const dom = parser.parse(raw).domRoot;
  const body = dom.querySelector('body');
  const participantDiv = body?.querySelector('#participantList');
  participantsRaw = participantDiv.children[0].content.trim().replace(/^.*:\s*/g, '').replace(/[◆◇]/g, '\t').trim();
  const participants = Array.from(new Set(participantsRaw.split(/\t+/)
    .map(p => p.trim()).filter(p => !!p)).values()).sort().map(p => ({ name: p }) as ParticipantInfo);
  const messageRows = body?.querySelectorAll('.messageRow').reverse();
  let messages = messageRows.map(row => extractMessage(row)).filter(m => m.name !== proxyName || m.trip !== proxyTripEncoded);
  const proxyMessages = messageRows.map(row => extractMessage(row)).filter(m => m.name === proxyName && m.trip === proxyTripEncoded);
  const hashes = new Set<string>();

  // Find proxied messages (with alternate tripcode) and reformat them to remove CHAT② proxy.
  for (const message of messages) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [_$0, name, trip, msg] = /^《(.+?)([◆◇].+?)?》(.*)$/.exec(message.bbCode) || [];

    if (message.name === proxyName && name && msg) {
      message.name = name;
      message.trip = trip?.slice(1) || '';
      message.html = message.html.substring(message.bbCode.length - msg.length);
      message.bbCode = msg;
      message.hash = messageHash(name, message.trip, message.time);
    }
  }

  clearLegacyAccessTimes();

  // Purge likely spam
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [_ids, shouldLockout, wasLockedOut] =
      await tallyForLockout(message.time, false, null, null, message.name, message.trip, message.email, message.bbCode, true);

    if (shouldLockout) {
      if (!wasLockedOut) {
        for (let j = i - 1; j >= 0; --j) {
          const prevMessage = messages[j];

          if (prevMessage.time < message.time - TIME_WINDOW * 2)
            break;

          if ((prevMessage.name && prevMessage.name === message.name) ||
              (prevMessage.email && prevMessage.email === message.email)) {
            messages.splice(j, 1);
            --i;
          }
        }
      }

      messages.splice(i, 1);
      --i;
    }
  }

  // Filter duplicate messages by hashcode.
  messages = messages.filter(m => !hashes.has(m.hash) && hashes.add(m.hash));

  const db = await getDb();

  for (const message of proxyMessages) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [_$0, name, trip, msg] = /^《(.+?)([◆◇].+?)?》(.*)$/.exec(message.bbCode) || [];

    if (name && msg) {
      // Use proxy messages to update the synced_time column in the messages table.
      let result = await db.run(`UPDATE messages SET synced_time = ? WHERE name = ? AND message = ? AND synced_time = time
        AND ABS(synced_time - ?) < 120 AND ABS(synced_time - ?) > 2`, message.time, name, msg, message.time);

      // Was the proxy message not found in our database? Check again without the goal of syncing the timestamp.
      if (result.changes === 0) {
        result = await db.run(`UPDATE messages SET synced_time = ? WHERE name = ? AND message = ? AND synced_time = time
            AND ABS(synced_time - ?) <= 2`, message.time, name, msg, message.time);

        // Still not found? Then it probably comes from a different chat proxy. Fix the name and treat it as a new message.
        if (result.changes === 0) {
          message.name = name;
          message.trip = trip?.slice(1) || '';
          message.html = message.html.substring(message.bbCode.length - msg.length);
          message.bbCode = msg;
          message.hash = messageHash(name, trip, message.time);

          const index = messages.findIndex(m => m.time >= message.time);

          if (index >= 0)
            messages.splice(index, 0, message);
          else
            messages.push(message);
        }
      }
    }
  }

  const now = Now();
  const gettingOld = now - MAX_IDLE_PARTICIPANT_AGE + MAX_IDLE_PARTICIPANT_LEEWAY;
  const currentNames = participants.map(p => `'${p.name.replace(/'/g, "''")}'`).join(',');

  await db.run(`UPDATE participants SET last_active = ? WHERE remote = 1 AND name IN (${currentNames}) AND last_active < ?`,
    gettingOld + MAX_IDLE_PARTICIPANT_LEEWAY, gettingOld);

  const latestPosts = new Map<string, number>();

  for (const message of messages) {
    const latest = latestPosts.get(message.name) || message.time;

    latestPosts.set(message.name, Math.max(message.time, latest));
  }

  for (const participant of Array.from(latestPosts.keys())) {
    const latest = latestPosts.get(participant);

    if (latest) {
      await db.run('UPDATE participants SET last_post = ?1, last_active = MAX(last_active, ?1) WHERE name = ?2 AND remote = 1',
        latest, participant);
      await db.run('UPDATE participants SET last_post = ? WHERE name = ? AND remote = 0',
        latest, participant);
    }
  }

  lastSuccessfulLegacyPoll = now;

  return { messages, participants, participantsRaw };
}

async function pollLegacyMessages(overrideCount?: number): Promise<void> {
  if (isShuttingDown()) return;

  const now = processMillis();
  const retrieveCount = overrideCount ??
    (lastLegacyPoll < 0 || now > lastLegacyPoll + 3_600_000 ? 1000 : now > lastLegacyPoll + 600_000 ? 200 : 30);
  let existing: Map<string, number>;

  try {
    const db = await getDb();
    existing = (await db.all<any>('SELECT hash, synced_time, name, trip, message FROM messages WHERE dm = 0 AND deleted = 0'))
      .reduce((acc, row) => acc.set(row.hash, row.synced_time), new Map<string, number>());
    const messages = await getLegacyMessages('', retrieveCount);
    const remoteExisting = new Set(messages.messages.map(m => m.hash));
    let earliest = Number.MAX_SAFE_INTEGER;
    let latest = 0;
    const row = await db.get<DbMessage>('SELECT time FROM messages WHERE dm = 0 ORDER BY time DESC LIMIT 1');
    const latestInDb = row?.time;
    const clockNow = Now();

    for (let i = pendingDuplicates.length - 1; i >= 0; --i) {
      const time = pendingDuplicates[i].time;

      if (time < clockNow - 60)
        pendingDuplicates.splice(i, 1);
    }

    for (let i = messages.messages?.length - 1; i >= 0; --i) {
      const message = messages.messages[i];
      const dupIndex = pendingDuplicates.findIndex(d => d.name === message.name && d.comment === message.bbCode &&
        Math.abs(d.time - message.time) < 60);

      if (dupIndex >= 0) {
        const duplicate = pendingDuplicates[dupIndex];

        messages.messages.splice(i, 1);
        pendingDuplicates.splice(dupIndex, 1);

        await db.run('UPDATE messages SET synced_time = ?, hash = ? WHERE id = ?', message.time, message.hash, duplicate.id);
      }

      existing.delete(message.hash);
    }

    for (const message of messages.messages || []) {
      if (message.time) {
        earliest = Math.min(message.time, earliest);
        latest = Math.max(message.time, latest);

        if (message.time > latestInDb - 300 || retrieveCount >= 1000) {
          let row = await db.get<DbMessage>('SELECT hash FROM messages WHERE dm = 0 AND hash = ? LIMIT 1', message.hash);

          if (row && row.remote === 1 && row.deleted !== 0 && row.spam === 0)
            await db.run('UPDATE messages SET deleted = 1 WHERE id = ?', message.msgId);
          else {
            if (!row)
              row = await db.get<DbMessage>(`SELECT hash FROM messages WHERE dm = 0 AND name = ? AND message = ? AND
                                               (synced_time = ?3 OR time = ?3) LIMIT 1`,
                message.name, message.bbCode, message.time);

            if (!row && message.name !== proxyName)
              await db.run('INSERT INTO messages (time, synced_time, name, trip, email, remote, style, message, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                message.time, message.time, message.name, message.trip, message.email, 1, message.style, message.bbCode, message.hash);
          }
        }
      }
    }

    [...existing.entries()].forEach(([hash, time]) => (time < earliest + 600 || time > latestInDb - 300) && existing.delete(hash));

    // Check messages in our DB which are not found in the legacy chat anymore, at least with a matching hash.
    for (const hash of existing.keys()) {
      const time = existing.get(hash);
      const row = await db.get<DbMessage>('SELECT * FROM messages WHERE dm = 0 AND hash = ? LIMIT 1', hash);

      if (row) {
        // Within 5 seconds of the timestamp in the DB, update the synced_time column.
        if (time !== row.synced_time && Math.abs(time - row.synced_time) < 5)
          await db.run('UPDATE messages SET synced_time = ? WHERE dm = 0 AND hash = ?', time, messageHash(row.name, row.trip, time));
        // Otherwise, presume the message was administratively deleted on the legacy site and follow suit here.
        else if (!remoteExisting.has(hash) && row.synced_time < clockNow - 600) {
          // TODO: Figure out why these flagged messages aren't the candidates for deletion that I think they should be.
          await db.run('UPDATE messages SET flagged = 1 WHERE dm = 0 AND hash = ?', hash);
          existing.delete(hash);
        }
      }
    }

    if (retrieveCount < 1000 && latestInDb && earliest > latestInDb)
      return pollLegacyMessages(1000);

    for (const participant of (messages.participants || []).map(p => p.name)) {
      if (!participant || participant === proxyName)
        continue;

      let row = await db.get<DbParticipant>('SELECT * FROM participants where name = ? AND remote = 0 LIMIT 1', participant);

      if (row) {
        if (firstParticipantPoll)
          await db.run('UPDATE participants SET last_active = ? WHERE id = ?', clockNow, row.id);

        continue;
      }

      row = await db.get<DbParticipant>('SELECT * FROM participants where name = ? AND remote = 1 LIMIT 1', participant);

      if (!row)
        await db.run('INSERT INTO participants (name, remote, last_active, last_post) VALUES (?, ?, ?, ?)',
          participant, 1, clockNow, 0);
    }

    firstParticipantPoll = false;

    const rows = await db.all<DbParticipant>('SELECT * FROM participants where remote = 1');

    for (const row of rows) {
      if (messages.participants?.findIndex(p => p.name === row.name) < 0)
        await db.run('DELETE FROM participants WHERE name = ? AND remote = 1', row.name);
    }

    const latestPosts = new Map<string, number>();

    for (const message of messages.messages || [])
      latestPosts.set(message.name, message.time);

    for (const participant of Array.from(latestPosts.keys())) {
      if (latestPosts.get(participant))
        await db.run('UPDATE participants SET last_active = ?1, last_post = ?1 WHERE name = ?2 AND remote = 1',
          latestPosts.get(participant), participant);
    }
  }
  catch (err) {
    console.error(`Error polling legacy chat: ${simplifyError(err)}`);
  }

  if (!isShuttingDown()) {
    if (existing.size < 1000)
      pollingTimeout = setTimeout(() => pollLegacyMessages(1000), 10_000);
    else
      pollingTimeout = setTimeout(pollLegacyMessages, 10_000);
  }

  lastLegacyPoll = processMillis();
}

pollLegacyMessages().finally();
legacyBrowserSetup().finally();

async function legacyBrowserSetup(): Promise<void> {
  browser = browser || (await (process.env.CHROME_PATH ?
    puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      executablePath: process.env.CHROME_PATH
    }) :
    puppeteer.launch()));

  if (!messagePage) {
    messagePage = await browser.newPage();
    messagePage.on('console', msg => {
      const type = msg.type();

      if (type !== 'verbose')
        console.log('Puppeteer (%s): %s', type, msg.text());
    });
  }

  await loadEnterForm(messagePage);
}

async function loadEnterForm(page: puppeteer.Page): Promise<void> {
  await page.goto(`https://${domain}/comchat.cgi?mode=form&nam=&eml=&col=&retime=40&line=20`);
  await page.waitForSelector('form');
  await page.$eval('form', form => form.setAttribute('target', '_self'));
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

export async function legacySendMessage(name: string, _email: string, comment: string, color: number, tripCode: string): Promise<void> {
  if (!inChat)
    await enterLegacyChat(proxyName, null, 0);

  messagePage = messagePage || await browser.newPage();
  comment = `《${name}${tripCode ? '◆' + tripcode(tripCode) : ''}》${comment}`;

  // Clean up spun-off pages created by previous message sending.
  const pages = [...await browser.pages()];
  const formUrl = `https://${domain}/comchat.cgi`;

  for (const page of pages) {
    if (page.url() === formUrl)
      await page.close();
  }

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

export function stopLegacyPolling(): void {
  if (pollingTimeout) {
    clearTimeout(pollingTimeout);
    pollingTimeout = undefined;
  }
}
