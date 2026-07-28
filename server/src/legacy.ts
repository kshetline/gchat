import { DbMessage, DbParticipant, kaomojiOriginal, Message, Messages, ParticipantInfo } from './shared-types.js';
import { encodeForUri, htmlUnescape, processMillis, sleep } from '@tubular/util';
import axios, { AxiosInstance } from 'axios';
import { HtmlParser } from 'fortissimo-html';
import { DomNode } from 'fortissimo-html/dist/dom.js';
import { getDb } from './db.js';
import { convertBBCodeToHtml, getTextAndMarkupAsBBCode, messageHash, Now, simplifyError } from './chat-util.js';
import tripcode from 'tripcode';
import { isShuttingDown, MAX_IDLE_PARTICIPANT_AGE } from './app.js';
import { clearLegacyAccessTimes, tallyForLockout, TIME_WINDOW } from './intrusion-detector.js';
import { distance } from 'fastest-levenshtein';
import { sendToAll } from './web-socket.js';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';

const domain = process.env.CHAT_DOMAIN;
const userEdit = process.env.CHAT_USER_EDIT ? domain + process.env.CHAT_USER_EDIT : null;
const proxyName = process.env.CHAT_PROXY || 'CHAT②';
const proxyTrip = process.env.CHAT_PROXY_TRIPCODE;
const proxyTripEncoded = tripcode(proxyTrip);
const parser = new HtmlParser();
export const MAX_IDLE_PARTICIPANT_LEEWAY = 600; // 10 minutes
const DEPARTURE_SUSTAIN = 660; // 11 minutes
const MESSAGE_POLL_RATE = 5000; // 5 seconds
const MESSAGE_REPOLL_RATE = 1000; // 1 second
const MESSAGE_FULL_REPOLL_DELAY = 10_000; // 10 seconds

export let participantsRaw: string;
export let lastSuccessfulLegacyPoll = -1;

let chatClient: AxiosInstance;
const jar = new CookieJar();

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

const pendingDuplicates: PendingDuplicate[] = [];
const departureTimes = new Map<string, number>();

export function addPendingDuplicate(id: number, time: number, name: string, comment: string): void {
  pendingDuplicates.push({ id, time, name, comment });
}

export function announceDeparture(name: string): void {
  departureTimes.set(name, Now());
}

export function clearDeparture(name: string): void {
  departureTimes.delete(name);
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

  const name = htmlUnescape((nameElem?.children?.at(nameIndex) as DomNode)?.children?.at(0)?.content || '').trim();
  const rawTime = messageRow.querySelector('.messageDate')?.children?.at(0)?.content?.slice(1, -1);
  const parts = rawTime?.split(/[- :/]/).map((p, i) => p.padStart(i === 0 ? 4 : 2, '0'));
  const timestamp = parts?.length !== 6 ? null : `${parts[0]}-${parts[1]}-${parts[2]}T${parts[3]}:${parts[4]}:${parts[5]}`;
  const time = Math.floor(new Date(timestamp + 'Z').getTime() / 1000);
  const trip = (nameElem?.children?.at(nameIndex + 1) as DomNode)?.content?.substring(1);
  const hash = messageHash(name, trip, timestamp);

  return { bbCode, email, hash, msgId: -1, name, style, synced: false, html, remote: true, time, trip };
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

  if (currentNames)
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

const DELAYED_MESSAGE_REGEX = /\s*\[s2]\[i]〔delayed \d+s〕\[\/i]\[\/s2]$/;
const MAX_SEND_TRIES = 10;
const SEND_RETRY_DELAY = 1000;
const MARK_AS_DELAYED = 45;
const MAX_SEND_DELAY = 90;

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ').replace(/◇/g, '♦').replace(DELAYED_MESSAGE_REGEX, '');
}

function similar(s1: string, s2: string): boolean {
  s1 = normalize(s1);
  s2 = normalize(s2);

  return s1 === s2;
}

function findClosestMessage(msgs: Message[], timestamp: number): Message {
  if (!msgs.length) return undefined;

  let lo = 0;
  let hi = msgs.length - 1;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;

    if (msgs[mid].time < timestamp)
      lo = mid + 1;
    else
      hi = mid;
  }

  if (lo === 0) return msgs[0];
  if (lo === msgs.length) return msgs[msgs.length - 1];

  const before = msgs[lo - 1];
  const after = msgs[lo];

  return (timestamp - before.time <= after.time - timestamp) ? before : after;
}

let lastLatest = 0;
let badResponses = 0;
let lastBadResponseReport = 0;
const lastSeen = new Map<string, number>();

async function pollLegacyMessages(overrideCount?: number): Promise<void> {
  if (isShuttingDown()) return;

  const now = processMillis();
  const retrieveCount = overrideCount ??
    (lastLegacyPoll < 0 || now > lastLegacyPoll + 3_600_000 ? 1000 : now > lastLegacyPoll + 600_000 ? 200 : 30);
  let existing: Map<string, DbMessage>;
  let failed = false;

  try {
    const db = await getDb();
    existing = (await db.all<DbMessage>('SELECT * FROM messages WHERE dm = 0 AND deleted = 0 AND flagged = 0 AND LENGTH(style) > 2'))
      .reduce((acc, row) => acc.set(row.hash, row), new Map<string, DbMessage>());
    const messages = await getLegacyMessages('', retrieveCount);
    const remoteExisting = new Set(messages.messages.map(m => m.hash));
    let earliest = Number.MAX_SAFE_INTEGER;
    let latest = 0;
    const row = await db.get<DbMessage>('SELECT time FROM messages WHERE dm = 0 ORDER BY time DESC LIMIT 1');
    const latestInDb = row?.time;
    const clockNow = Now();

    departureTimes.forEach((time, name) => {
      if (clockNow - time > DEPARTURE_SUSTAIN)
        departureTimes.delete(name);
    });

    for (let i = pendingDuplicates.length - 1; i >= 0; --i) {
      const time = pendingDuplicates[i].time;

      if (time < clockNow - MAX_SEND_DELAY)
        pendingDuplicates.splice(i, 1);
    }

    for (let i = messages.messages?.length - 1; i >= 0 && pendingDuplicates.length > 0; --i) {
      const message = messages.messages[i];
      const delayMsg = (DELAYED_MESSAGE_REGEX.exec(message.bbCode) || [])[0] || '';
      const allowedDelay = delayMsg ? 120 : 60;
      const dupIndex = pendingDuplicates.findIndex(d => d.name === message.name && similar(d.comment, message.bbCode) &&
        Math.abs(d.time - message.time) < allowedDelay);

      if (dupIndex >= 0) {
        const duplicate = pendingDuplicates[dupIndex];

        messages.messages.splice(i, 1);
        pendingDuplicates.splice(dupIndex, 1);

        await db.run('UPDATE messages SET synced_time = ?, synced = 1, hash = ?, message = ? WHERE id = ?',
          message.time, message.hash, message.bbCode + delayMsg, duplicate.id);
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

    [...existing.entries()].forEach(([hash, msg]) =>
      (msg.time < earliest + 600 || msg.time > Math.max(latestInDb - 120, clockNow - 60)) && existing.delete(hash));

    let modified = false;

    // Check messages in our DB which are not found in the legacy chat anymore, at least with a matching hash.
    for (const hash of existing.keys()) {
      const msg = existing.get(hash);
      const row = await db.get<DbMessage>('SELECT * FROM messages WHERE dm = 0 AND hash = ? and name = ? LIMIT 1', hash, msg.name);

      if (row) {
        const sameNameMessages = messages.messages.reduce((acc, m) => m.name === msg.name ? [...acc, m] : acc, []);
        const closestMessage = findClosestMessage(sameNameMessages, msg.time);

        // Within 15 seconds of the timestamp in the DB, update the synced_time column.
        if (closestMessage && Math.abs(closestMessage.time - row.synced_time) < 15 && distance(closestMessage.bbCode, msg.message) < 5) {
          if (closestMessage.time !== row.synced_time)
            await db.run('UPDATE messages SET hash = ?, synced_time = ? WHERE id = ?', closestMessage.hash, closestMessage.time, row.id);
        }
        // Otherwise, presume the message was administratively deleted on the legacy site and follow suit here.
        else if (!remoteExisting.has(hash) && (row.synced || row.synced_time < clockNow - MAX_SEND_DELAY)) {
          // This might be a new local message that failed to sync back to the legacy chat.
          // If so, keep the message, flag it in user display as not being visible in the legacy chat.
          const del = (row.remote > 0 || row.synced) ? 1 : 0;

          await db.run('UPDATE messages SET deleted = ?, flagged = 1 WHERE id = ?', del, row.id);
          existing.delete(hash);
          modified = true;
        }
      }
    }

    if (retrieveCount < 1000 && latestInDb && earliest > latestInDb)
      return pollLegacyMessages(1000);

    if (latest > lastLatest || modified) {
      lastLatest = latest;
      setTimeout(() => sendToAll('newMessages'), 1000);
    }

    const latestPosts = new Map<string, number>();

    for (const message of messages.messages || [])
      latestPosts.set(message.name, message.time);

    for (const participant of (messages.participants || []).map(p => p.name)) {
      if (!participant || participant === proxyName)
        continue;

      lastSeen.set(participant, now);

      let row = await db.get<DbParticipant>('SELECT * FROM participants where name = ? AND remote = 0 LIMIT 1', participant);

      if (row) {
        if (firstParticipantPoll)
          await db.run('UPDATE participants SET last_active = ? WHERE id = ?', clockNow, row.id);

        continue;
      }

      row = await db.get<DbParticipant>('SELECT * FROM participants where name = ? AND remote = 1 LIMIT 1', participant);

      const lastActive = latestPosts.has(participant) ? latestPosts.get(participant) : clockNow;
      const lastPost = latestPosts.has(participant) ? latestPosts.get(participant) : 0;

      if (!row && (!departureTimes.has(participant) || lastPost > departureTimes.get(participant) + 60)) {
        const changes = (await db.run('INSERT INTO participants (name, remote, last_active, last_post) VALUES (?, ?, ?, ?)',
          participant, 1, lastActive, lastPost))?.changes ?? 0;

        departureTimes.delete(participant);

        if (changes > 0)
          console.info(`Created remote participant record for ${participant}`);
      }
    }

    firstParticipantPoll = false;

    const rows = await db.all<DbParticipant>('SELECT * FROM participants where remote = 1');

    for (const row of rows) {
      if (messages.participants?.findIndex(p => p.name === row.name) < 0 && (lastSeen.get(row.name) ?? 0) < now - 120_000 &&
          ((await db.run('DELETE FROM participants WHERE name = ? AND remote = 1', row.name))?.changes || 0) > 0)
        console.info(`Deleted remote participant record for ${row.name}`);
    }

    for (const participant of Array.from(latestPosts.keys())) {
      if (latestPosts.get(participant))
        await db.run('UPDATE participants SET last_active = ?1, last_post = ?1 WHERE name = ?2 AND remote = 1',
          latestPosts.get(participant), participant);
    }
  }
  catch (err) {
    failed = true;

    const error = simplifyError(err);

    if (error === 'ERR_BAD_RESPONSE')
      ++badResponses;
    else
      console.error(`Error polling legacy chat: ${error}`);
  }

  if (lastBadResponseReport < now - 300_000) {
    if (badResponses > 0)
      console.error(`ERR_BAD_RESPONSE x ${badResponses} in last five minutes`);

    badResponses = 0;
    lastBadResponseReport = now;
  }

  if (!isShuttingDown()) {
    if (existing.size < 1000)
      pollingTimeout = setTimeout(() => pollLegacyMessages(1000).catch(), MESSAGE_FULL_REPOLL_DELAY);
    else
      pollingTimeout = setTimeout(() => pollLegacyMessages().catch(), failed ? MESSAGE_REPOLL_RATE : MESSAGE_POLL_RATE);
  }

  lastLegacyPoll = processMillis();
}

pollLegacyMessages().catch();

const MAX_ENTER_TRIES = 3;
const ENTER_RETRY_DELAY = 1000;
const MAX_ENTER_DELAY = 30;

export async function enterLegacyChat(ip: string, name: string, email: string, color: number,
                                      tries = 0, sendTime = processMillis()): Promise<void> {
  chatClient = chatClient || wrapper(axios.create({ jar }));
  await chatClient.get(`https://${domain}/comchat.cgi?mode=form&name=&email=&color=&retime=30&lines=30`);

  const now = processMillis();
  const formUrl = `https://${domain}/comchat.cgi`;
  let error = '';
  const delayed = Math.floor((now - sendTime) / 1000);

  try {
    const params = new URLSearchParams();

    params.append('name', name);
    params.append('email', email);
    params.append('mode', 'into');
    params.append('retime', '20');
    params.append('lines', '30');
    params.append('xip', ip);

    await chatClient.post(formUrl, params);
    inChat = true;
  }
  catch (err: any) {
    error = err.message || String(err);
  }

  if (error) {
    console.error('Failed to enter legacy chat:', error);

    if (tries < MAX_ENTER_TRIES && delayed < MAX_ENTER_DELAY) {
      await sleep(ENTER_RETRY_DELAY);
      return enterLegacyChat(ip, name, email, color, tries + 1, sendTime);
    }
  }
}

export async function leaveLegacyChat(): Promise<void> {
  if (!chatClient)
    return;

  const formUrl = `https://${domain}/comchat.cgi`;
  const params = new URLSearchParams();

  params.append('name', proxyName);
  params.append('mode', 'out');

  try {
    await chatClient.get(formUrl, { params });
  }
  catch {}

  await jar.removeAllCookies();
  chatClient = null;
  inChat = false;
}

export async function legacySendMessage(ip: string, name: string, email: string, comment0: string,
                                        color: number, tripCode: string, tries = 0, sendTime = processMillis()): Promise<void> {
  if (!inChat)
    await enterLegacyChat(ip, proxyName, null, 0);

  const now = processMillis();
  const formUrl = `https://${domain}/comchat.cgi`;
  let error = '';
  let comment = `《${name}${tripCode ? '◆' + tripcode(tripCode) : ''}》${comment0}`;
  let face = '';
  const $ = /^(.+)(\[kao](.+)\[\/kao])\s*$/.exec(comment);

  if ($ && kaomojiOriginal.has($[3])) {
    comment = $[1];
    face = $[3];
  }

  const delayed = Math.floor((now - sendTime) / 1000);

  if (delayed > MARK_AS_DELAYED)
    comment += ` [s2][i]〔delayed ${delayed}s〕[/i][/s2]`;

  try {
    const params = new URLSearchParams();

    params.append('name', proxyName);
    params.append('email', email);
    params.append('password', proxyTrip || '');
    params.append('comment', comment || '\u00A0');
    params.append('face', face);
    params.append('color', color.toString() || '');
    params.append('mode', 'regist');
    params.append('retime', '20');
    params.append('lines', '30');
    params.append('xip', ip);

    await axios.post(formUrl, params);
  }
  catch (err: any) {
    error = err.message || String(err);
  }

  if (error) {
    console.error(`Failed to send legacy message for ${name}:`, error);

    if (tries < MAX_SEND_TRIES && delayed < MAX_SEND_DELAY)
      setTimeout(() => legacySendMessage(ip, name, email, comment0, color, tripCode, tries + 1, sendTime).catch(), SEND_RETRY_DELAY);
  }
}

const pendingRetries = new Map<string, any>();
const MAX_EDIT_TRIES = 5;
const EDIT_RETRY_DELAY = 10000;

export async function legacyEditMessage(name: string, trip: string, date: number, message: string, color?: string, tries = 1): Promise<void> {
  if (!userEdit)
    return;

  const db = await getDb();
  const dbMessage = await db.get<DbMessage>('SELECT * FROM messages WHERE name = ? AND trip = ? AND time = ? AND synced_time != ?',
    name, trip, date, date);

  if (dbMessage)
    date = dbMessage.synced_time;

  const key = `${name}\t${trip}\t${date}`;
  const pendingRetry = pendingRetries.get(key);

  if (pendingRetry) { // Forget pending retries if a fresh new edit is attempted
    clearTimeout(pendingRetry);
    pendingRetries.delete(key);
  }

  try {
    const params = new URLSearchParams();

    params.append('name', name);
    params.append('trip', trip);
    params.append('date', date.toString());
    params.append('message', message);
    params.append('color', color || '');

    const response = await axios.post(`https://${userEdit}`, params);

    // Attempt to edit a message might occur before the remote chat has obtained the original message.
    if (tries < MAX_EDIT_TRIES && response.data.startsWith('not ')) {
      pendingRetries.set(key, setTimeout(() => {
        pendingRetries.delete(key);
        legacyEditMessage(name, trip, date, message, color, tries + 1).catch();
      }, EDIT_RETRY_DELAY));
    }

    pendingRetries.set(key, setTimeout(() => {
      legacyEditMessage(name, trip, date, message, color, tries + 1).catch();
    }, 1000));
  }
  catch (err: any) {
    console.error(`Failed to edit legacy message for ${name} at ${new Date(date * 1000).toISOString().slice(0, 19)}:`,
      err.message || String(err));
  }
}

export async function legacyDeleteMessage(name: string, trip: string, date: number): Promise<void> {
  await legacyEditMessage(name, trip, date, '');
}

export function stopLegacyPolling(): void {
  if (pollingTimeout) {
    clearTimeout(pollingTimeout);
    pollingTimeout = undefined;
  }
}
