import express from 'express';
import cors from 'cors';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { colors, Config, DbDmSession, DbMessage, DbParticipant, DmSession, Message, ParticipantInfo } from './shared-types.js';
import { isEqual, isString, processMillis, toBoolean, toInt } from '@tubular/util';
import { uploadSingle } from './uploader.js';
import { SessionInfo } from './session-info';
import { addPendingDuplicate, enterLegacyChat, lastSuccessfulLegacyPoll, leaveLegacyChat, legacySendMessage, stopLegacyPolling } from './legacy.js';
import { getDb, getNamedParticipantRecord } from './db.js';
import ip_ from 'ip';
import axios from 'axios';
import { convertBBCodeToHtml, extractIp, getIp, getToken, messageHash, Now, timeStamp, unescapeUnicode } from './chat-util.js';
import tripcode from 'tripcode';
import path from 'path';
import fs from 'fs';
import { initExternalUploader, proxyIp } from './external-uploader.js';
import { isBannedName, intrusionDetector, isBannedIp } from './intrusion-detector.js';
import { stopLocalSocksProxy } from './socks-proxy.js';

// noinspection ES6ConvertVarToLetConst
var shuttingDown = false;
export function isShuttingDown(): boolean { return shuttingDown; }

if (process.env.LOG_FILE_PATH) {
  // Send console output to a log file
  const logFile = fs.createWriteStream(
    path.join(process.cwd(), process.env.LOG_FILE_PATH), { flags: 'a' }
  );

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const [method, _stream, prefix] of [
    ['log',   process.stdout, ''],
    ['info',  process.stdout, ''],
    ['error', process.stderr, '[ERR] '],
    ['warn',  process.stderr, '[WARN] '],
  ] as const) {
    const orig = console[method].bind(console);

    console[method] = (...args: unknown[]) => {
      orig(...args);

      if (isString(args[0] && (args[0] as string).includes('%s'))) {
        args[0] = (args[0] as string).replace(/(?<!%)%s/g, () => args.length > 1 ? String(args.splice(1, 1)) : '%s');
      }

      logFile.write(prefix + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') + '\n');
    };
  }
}

export const MAX_IDLE_PARTICIPANT_AGE = 172800; // 2 days
export const MAX_IDLE_PARTICIPANT_SHOW = 7200; // 2 hours

const app = express();
const port = toInt(process.env.PORT) || 3000;
const __dirname = process.cwd();
const devMode = process.argv.includes('-d');
const sessions = new Map<string, SessionInfo>();
const proxyName = process.env.CHAT_PROXY || 'CHAT②';
const config: Config = {
  backgroundColor: process.env.CHAT_BACKGROUND || '#DDD',
  externalUploaderName: unescapeUnicode(process.env.EXTERNAL_UPLOADER_NAME || 'External Uploader'),
  externalUploaderShortName: unescapeUnicode(process.env.EXTERNAL_UPLOADER_SHORT_NAME || 'ExtUploader'),
  fileSizeLimitInMb: toInt(process.env.UPLOAD_MAX_SIZE_MB) || 15000,
  fileSizeLimitExtInMb: toInt(process.env.EXT_UPLOAD_MAX_SIZE_MB) || 200,
  navigation: process.env.NAV_LINKS.split(';').map(link => link.split('::'))
    .map(link => ({ name: link[0], url: link[1], target: link[2] || '_blank' })),
  title: process.env.CHAT_TITLE,
};
const URL_MATCHER = /\b(https?:\/\/[-A-Za-z0-9+&@#/%?=~_()|!:,.;]*[-A-Za-z0-9+&@#/%=~_()|])/g;
const MONITOR_INTERVAL = 60000; // 1 minute
const MAX_DM_AGE = 7200; // 2 hours
const MAX_HISTORY = 5000; // number of chat messages to keep in DB
const MAX_HISTORY_TOLERANCE = 500; // Overflow before deleting messages
const MAX_CLIENT_MESSAGES = 2000;

let proxyStarted = false;
let nextToLastContentUpdate = 0;
let lastContentUpdate = 0;
let lastMessages: Message[] = null;
let monitorTimeout: NodeJS.Timeout;

let serverIp: string;

async function getServerIp(): Promise<string> {
  if (!serverIp)
    serverIp = extractIp((await axios.get(process.env.GET_IP_SERVICE)).data) || '127.0.0.1';

  return serverIp;
}

async function monitor(): Promise<void> {
  if (shuttingDown) return;

  const db = await getDb();
  const now = Now();

  await db.run('DELETE FROM messages WHERE dm > 0 AND synced_time < ?', now - MAX_DM_AGE);
  await db.run('DELETE FROM dm_session WHERE name1_present <= 0 AND name2_present <= 0 AND last_post < ?', now - MAX_DM_AGE);
  await db.run('DELETE FROM participants WHERE last_active < ?', now - MAX_IDLE_PARTICIPANT_AGE);

  const messageCount = (await db.get<any>('SELECT COUNT(*) as count FROM messages WHERE dm = 0'))?.count || 0;

  if (messageCount > MAX_HISTORY + MAX_HISTORY_TOLERANCE)
    await db.run(`DELETE FROM messages WHERE dm = 0 AND id IN (
      SELECT id FROM (
        SELECT id FROM messages ORDER BY synced_time LIMIT ?
      ) AS subquery
    )`, messageCount - MAX_HISTORY);

  monitorTimeout = setTimeout(monitor, MONITOR_INTERVAL);
}

monitor().finally();
initExternalUploader().catch().finally();

async function sessionsCheck(): Promise<void> {
  const now = Now();

  for (const sessionId of sessions.keys()) {
    const session = sessions.get(sessionId);

    if (session.name && session.lastAlive < now - 1800) {
      const db = await getDb();

      await db.run('DELETE FROM participants WHERE name = ? AND remote = 0', session.name);
      sessions.delete(sessionId);
    }
  }
}

export function reportUploadProgress(req: express.Request, progress: number): void {
  const session = sessions.get(getToken(req));

  if (session)
    session.progress = Math.round(progress);
}

async function getDirectMessages(name: string): Promise<DmSession[]> {
  const db = await getDb();
  const result: DmSession[] = [];
  const dmSessions = await db.all<DbDmSession>('SELECT * FROM dm_session WHERE name1 = ? or name2 = ?', name, name);

  for (const dmSession of dmSessions) {
    const whichName = dmSession.name1 === name ? 'name1_present' : 'name2_present';
    const present = dmSession[whichName];

    // Have there been any new messages since this person left the chat? If so, don't broadcast the chat session until
    // there's something new to show.

    if (present < 0 && dmSession.last_post < -present)
      continue;

    const rows = (await db.all<DbMessage>(
      'SELECT * FROM messages WHERE deleted = 0 AND dm = ? ORDER BY messages.synced_time',
        dmSession.id)).slice(-MAX_CLIENT_MESSAGES);
    const messages = rows.filter(row => !row.deleted).map(row => ({
      email: row.email,
      flagged: row.flagged,
      hash: row.hash,
      html: row.style?.length < 2 ? row.message :
        convertBBCodeToHtml(decryptMessage(row.message, dmSession.ekey)) || '???',
      isMe: row.name === name,
      msgId: row.id,
      name: row.name,
      remote: !!row.remote,
      style: row.style,
      time: row.synced_time,
      trip: tripcode(row.trip ?? '')
    } as Message));

    const sessionName = dmSession.name1 === name ? dmSession.name2 : dmSession.name1;

    if (sessionName?.trim())
      result.push({ id: dmSession.id, messages, name: sessionName });
  }

  return result;
}

app.set('trust proxy', 1);

app.use(cors({
  origin: process.env.CHAT_DOMAIN ? `https://${process.env.CHAT_DOMAIN}` : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  credentials: true,
}));

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  reportUploadProgress(req, 0);
  console.error('Global error:', err); // For immediate server visibility

  const errorDetails = {
    message: err.message,
    stack: err.stack,
    route: req.originalUrl,
    method: req.method,
    time: new Date().toISOString(),
  };

  console.log('Global error:', JSON.stringify(errorDetails, null, 2));

  // Check if headers have already been sent to avoid "Can't set headers after they are sent" errors
  if (res.headersSent)
    return next(err); // Pass to default Express error handler if response already started

  // Determine the appropriate status code and message for the client
  const statusCode = err.statusCode || 500; // Custom errors might have a statusCode property
  const message = err.message || 'Internal Server Error';

  // Send a generic, user-friendly error response to the client
  res.status(statusCode).json({ success: false, message });
});

app.use(async (req, res, next) => {
  if (shuttingDown) {
    res.status(503).json({ error: 'Server is shutting down.' });
    return;
  }

  const token = getToken(req);

  if (token && !sessions.has(token)) {
    const ip = getIp(req);
    sessions.set(token, { ip: ip_.isPrivate(ip) ? await getServerIp() : ip, inChat: false } as SessionInfo);
  }

  next();
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

app.use(intrusionDetector);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/token', async (req, res) => {
  const token = randomUUID();
  const ip = getIp(req);

  sessions.set(token, { ip: ip_.isPrivate(ip) ? await getServerIp() : ip, inChat: false } as SessionInfo);
  res.json({ token });
});

app.get('/api/config', (_req, res) => {
  res.json(config);
});

app.get('/api/messages', async (req, res) => {
  const session = sessions.get(getToken(req));
  const q = req.query as any;
  const tripCode = tripcode(q.tripCode);
  const name = ((q.name || '') as string).replace(/#.*$/, '');
  const now = Now();

  if (session) {
    session.lastAlive = now;
    session.name = name;

    if (q.inChat != null)
      session.inChat = toBoolean(q.inChat);
  }

  const db = await getDb();
  const rows = (await db.all<DbMessage>(
    'SELECT * FROM messages WHERE deleted = 0 AND dm = 0 ORDER BY messages.synced_time')).slice(-MAX_CLIENT_MESSAGES);
  let messages = rows.filter(row => !row.deleted).map(row => ({
    email: row.email,
    flagged: row.flagged,
    hash: row.hash,
    html: convertBBCodeToHtml(row.message),
    isMe: row.name === name && (row.session_id === getToken(req) || row.ip === session.ip ||
      (row.trip && (row.trip === q.tripCode || row.trip === tripCode))),
    msgId: row.id,
    name: row.name,
    remote: !!row.remote,
    style: row.style,
    time: row.synced_time,
    trip: row.remote ? row.trip : tripcode(row.trip)
  } as Message));

  const active = toBoolean(req.query.active);
  const force = toBoolean(req.query.force);
  const idleTimeLimit = now - MAX_IDLE_PARTICIPANT_SHOW;
  let participant = await getNamedParticipantRecord(name);

  if (participant) {
    await db.run('UPDATE participants SET allow_dm = ? WHERE id = ?', +toBoolean(q.allowDMs), participant.id);

    if (active && session.inChat)
      await db.run('UPDATE participants SET last_active = ?, remote = 0 WHERE id = ?', now, participant.id);
  }

  const participantNames = (await db.all<any>(
    'SELECT name FROM participants WHERE name != ?1 AND ((last_active > ?2 OR last_post > ?2) OR remote = 0)',
      proxyName, idleTimeLimit)).map(r => r.name);
  const participants = [...new Set(participantNames)].sort().map(p => ({ name: p } as ParticipantInfo));

  for (let i = participants.length - 1; i >= 0; --i) {
    const participantInfo = participants[i];
    const participant = await getNamedParticipantRecord(participantInfo.name);

    if (!participant.remote) {
      let session2 = sessions.get(participant.session_id);

      if (!session2 && participant.name === name) {
        session2 = session;
        await db.run('UPDATE participants SET session_id = ? WHERE id = ?', getToken(req), participant.id);
      }

      if (session2 && !session2.inChat) {
        participants.splice(i, 1);
        continue;
      }
      // last_post should only be greater than last_active for the same screen name posting as a remote participant
      else if (participant.last_post > participant.last_active)
        participant.remote = 1;
    }

    if (participant) {
      participantInfo.allowsDms = !!participant.allow_dm && !participant.remote;
      participantInfo.idle = now - participant.last_active > (participant.remote ? 1800 : 600) ? 1 : 0;
      participantInfo.remote = !!participant.remote;
    }
  }

  participants.sort((a, b) => (a.remote !== b.remote) ? (a.remote ? 1 : -1) : a.name.localeCompare(b.name));

  // Some duplicate messages are still slipping through, so one more check is needed
  for (let i = messages.length - 1; i > messages.length - 25 && i >= 0; --i) {
    const message = messages[i];

    for (let j = i - 1; j > i - 5 && j >= 0; --j) {
      const message2 = messages[j];

      if (message2.name === message.name && Math.abs(message2.time - message.time) < 10 && message2.html === message.html) {
        messages.splice(j, 1);
        await db.run('UPDATE messages SET deleted = 1 WHERE id = ?', message2.msgId);
        --i;
      }
    }
  }

  let deleteCount = 0;
  let appendAt = 0;
  let oldMessages: Message[];

  if (!isEqual(lastMessages, messages, { keysToIgnore: ['isMe'] })) {
    if (lastMessages?.length > 50 && messages?.length > 50) {
      deleteCount = Math.max(lastMessages.findIndex(m => m.hash === messages[0].hash), 0);
      appendAt = messages.findIndex(m => m.hash === lastMessages.at(-1).hash);
      oldMessages = lastMessages.slice(deleteCount);

      if (appendAt < 0)
        appendAt = messages.length;
    }

    lastMessages = messages;
    nextToLastContentUpdate = lastContentUpdate;
    lastContentUpdate = processMillis();
  }

  if (session) {
    if (!force) {
      if (session.lastContentUpdate === nextToLastContentUpdate && appendAt > 0) {
        const overlappingMessages = messages.slice(0, appendAt + 1);

        if (isEqual(oldMessages, overlappingMessages, { keysToIgnore: ['isMe'] }))
          messages = messages.slice(appendAt + 1);
        else
          deleteCount = appendAt = 0;
      }
      else if (session.lastContentUpdate === lastContentUpdate)
        messages = [null];
    }
    else
      deleteCount = appendAt = 0;

    session.lastContentUpdate = lastContentUpdate;
  }
  else
    deleteCount = appendAt = 0;

  await sessionsCheck();

  let lslp = lastSuccessfulLegacyPoll;

  if (lslp <= 0)
    lslp = messages.findLast(m => m.remote)?.time ?? -1;

  res.json({
    messages,
    deleteCount,
    append: appendAt > 0,
    participants,
    dms: await getDirectMessages(name),
    lastSuccessfulLegacyPoll: lslp,
    progress: session?.progress, proxyIp
  });
});

app.post('/api/enter', async (req, res) => {
  const q = req.query as any;

  if (await isBannedName(q.name, tripcode(q.tripCode)) || await isBannedIp(getIp(req))) {
    res.status(400).json({ error: 'Entry into chat room failed' });
    return;
  }

  const framed = toBoolean(q.framed);
  const token = getToken(req);
  const session = sessions.get(token);
  const db = await getDb();
  const now = Now();
  const participant = await db.get<DbParticipant>('SELECT * FROM participants where name = ? AND remote = 0 LIMIT 1', q.name);
  const wasInChat = session.inChat;

  if (!participant && q.name) {
    await db.run('INSERT INTO participants (name, trip, email, ip, session_id, remote, proxied, last_active, last_post) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      q.name, q.tripCode, q.email, session.ip, token, 0, +(!framed), now, 0);
    session.inChat = true;
  }
  else if (q.tripCode === participant.trip || !participant.ip || session.ip === participant.ip ||
           !participant.session_id || token === participant.session_id) {
    await db.run('UPDATE participants SET trip = ?, email = ?, ip = ?, session_id = ?, remote = ?, proxied = ?, last_active = ? WHERE id = ?',
      q.tripCode, q.email, session.ip, token, 0, +(!framed), now, participant.id);
    session.inChat = true;
    await db.run('DELETE FROM participants WHERE name = ? AND remote = 1', q.name);
  }
  else {
    res.status(400).json({
      error: `Chat name '${q.name}' is already in use by another user.`
    });

    return;
  }

  if (session.inChat && !wasInChat) {
    const lastEnterOrLeave = await db.get<any>(`SELECT id, style FROM messages WHERE synced_time > ? AND dm = 0 AND name = ? AND trip = ? AND
      remote = 0 AND LENGTH(style) = 1 ORDER BY synced_time DESC LIMIT 1`, now - 3600, q.name, q.tripCode);

    if (lastEnterOrLeave?.style === 'E')
      await db.run('UPDATE messages SET synced_time = ? WHERE id = ?', now, lastEnterOrLeave.id);
    else {
      const message = 'has joined ' + process.env.CHAT_TITLE;

      await db.run('INSERT INTO messages (dm, time, synced_time, name, trip, email, remote, ip, session_id, style, message, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        0, now, now, q.name, q.tripCode, q.email, 0, session.ip, token, 'E', message, messageHash('E:' + q.name, q.tripCode, now));
    }
  }

  if (!framed && !proxyStarted) {
    await enterLegacyChat(proxyName, null, 0);
    proxyStarted = true;
  }

  res.json(null);
});

app.post('/api/leave', async (req, res) => {
  const q = req.query as any;
  const name = q.name;
  const token = getToken(req);
  const session = sessions.get(token);
  const wasInChat = session.inChat;

  if (!session?.inChat) {
    res.json(null);
    return;
  }

  const db = await getDb();
  const participant = await db.get<DbParticipant>('SELECT * FROM participants where name = ? AND remote = 0 LIMIT 1', name);

  if (participant && (q.tripCode === participant.trip || session.ip === participant.ip || token === participant.session_id)) {
    await db.run('DELETE FROM participants WHERE id = ?', participant.id);
    session.inChat = false;
  }

  if (!session.inChat && wasInChat) {
    const now = Now();
    const message = 'has left ' + process.env.CHAT_TITLE;
    const dms = [0];
    const dmSessions = await db.all<DbDmSession>(
      'SELECT * FROM dm_session WHERE (name1 = ? AND name1_present > 0) or (name2 = ? AND name2_present > 0)', name, name);

    dmSessions.forEach(dm => dms.push(dm.id));

    for (const dm of dms) {
      await db.run('INSERT INTO messages (dm, time, synced_time, name, trip, email, remote, ip, session_id, style, message, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        dm, now, now, name, q.tripCode, q.email, 0, session.ip, token, 'L', message, messageHash('L:' + q.name, q.tripCode, now));
    }
  }

  if (!toBoolean(q.framed)) {
    const proxiedCount = (await db.get<any>('SELECT COUNT(*) as count FROM participants WHERE proxied = 1'))?.count || 0;

    if (!proxiedCount) {
      await leaveLegacyChat();
      proxyStarted = false;
    }
  }

  res.json(null);
});

function colorToStyle(color: number): string {
  return `color:${colors[color].trim()}`;
}

function styleToColor(styleOrColor: string): number {
  const color = (/color:\s*([^;]+)\b/.exec(styleOrColor) || [])[1] || styleOrColor;

  return Math.max(0, colors.findIndex(c => color === c.trim()));
}

function encryptMessage(text: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${Buffer.concat([encrypted, authTag]).toString('base64')}`;
}

export function decryptMessage(encryptedText: string, keyBase64: string): string {
  try {
    const key = Buffer.from(keyBase64, 'base64');
    const [ivBase64, dataBase64] = encryptedText.split(':');
    const iv = Buffer.from(ivBase64, 'base64');
    const data = Buffer.from(dataBase64, 'base64');
    const authTag = data.subarray(data.length - 16);
    const ciphertext = data.subarray(0, data.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);

    decipher.setAuthTag(authTag);

    return decipher.update(ciphertext) + decipher.final('utf8');
  }
  catch (e) {
    console.error('Error decrypting message:', e);
  }

  return encryptedText;
}

app.post('/api/send', async (req, res) => {
  const q = req.query as any;

  if (await isBannedName(q.name, tripcode(q.tripCode)) || await isBannedIp(getIp(req))) {
    res.status(400).json({ error: 'Send message failed' });
    return;
  }

  const token = getToken(req);
  const session = sessions.get(token);
  const db = await getDb();
  const now = Now();
  const style = colorToStyle(q.color);
  let comment = q.comment.replace(URL_MATCHER, '[url=$1]$1[/url]');
  const hash = messageHash(q.name, q.tripCode, now);
  const framed = toBoolean(q.framed);
  const dm = toInt(q.dm);
  let dmSession: DbDmSession;

  session.inChat = true;

  if (dm) {
    dmSession = await db.get<DbDmSession>('SELECT * FROM dm_session WHERE id = ?', dm);

    if (!dmSession) {
      res.status(400).json({ error: 'This chat session is closed.', closed: true });
      return;
    }
    else if (!q.name?.trim()) {
      res.status(400).json({ error: 'You must use a non-blank chat name to send DMs.', closed: true });
      return;
    }
    else
      comment = encryptMessage(comment, dmSession.ekey);
  }

  const result = await db.run('INSERT INTO messages (dm, time, synced_time, name, trip, email, remote, ip, session_id, style, message, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    dm, now, now, q.name, q.tripCode, q.email, 0, session.ip, token, style, comment, hash);

  if (!dm && framed)
    addPendingDuplicate(result.lastID, now, q.name, comment);

  await db.run('UPDATE participants SET last_post = ?1, last_active = ?1 WHERE name = ?2 AND remote = 0', now, q.name);

  if (dmSession)
    await db.run('UPDATE dm_session SET last_post = ? WHERE id = ?', now, dmSession.id);

  const participant = await db.get<DbParticipant>('SELECT * FROM participants where name = ? AND remote = 0 LIMIT 1', q.name);

  if (participant)
    await db.run('UPDATE participants SET last_post = ?1, last_active = ?1 WHERE id = ?2', now, participant.id);

  if (!dm && !framed && !comment.includes('##cpc-only##')) {
    if (!proxyStarted) {
      await enterLegacyChat(proxyName, null, 0);
      proxyStarted = true;
    }

    await legacySendMessage(q.name, null, q.comment, q.color, q.tripCode);
  }

  res.json(null);
});

async function allowedToEdit(req: express.Request, res: express.Response, action = 'edit'): Promise<DbMessage> {
  const q = req.query as any;
  const tripCode = q.tripCode && tripcode(q.tripCode);

  if (!await isBannedName(q.name, tripCode) && !await isBannedIp(getIp(req))) {
    const id = toInt(q.msgId);
    const db = await getDb();
    const message = await db.get<DbMessage>('SELECT * FROM messages WHERE id = ? LIMIT 1', id);

    if (message && message.name === q.name &&
        ((message.trip && (message.trip === q.tripCode || message.trip === tripCode)) ||
          message.session_id !== getToken(req))) {
      if (message.dm) {
        const dmSession = await db.get<DbDmSession>('SELECT * FROM dm_session WHERE id = ?', message.dm);

        if (dmSession)
          message.message = decryptMessage(message.message, dmSession.ekey);
      }

      return message;
    }
  }

  res.status(400).json({ error: `You are not authorized to ${action} this message.` });

  return null;
}

app.get('/api/can-edit', async (req, res) => {
  const message = await allowedToEdit(req, res);

  if (message)
    res.send({ bbCode: message.message, color: styleToColor(message.style) });
});

app.put('/api/update', async (req, res) => {
  if (await allowedToEdit(req, res)) {
    const q = req.query as any;
    const id = toInt(q.msgId);
    const db = await getDb();
    const now = Now();
    let bbCode = (q.bbCode as string).replace(URL_MATCHER, '[url=$1]$1[/url]');
    const dm = (await db.get<any>('SELECT dm FROM messages WHERE id = ?', id))?.dm as number;

    if (dm) {
      const dmSession = await db.get<DbDmSession>('SELECT * FROM dm_session WHERE id = ?', dm);

      if (dmSession)
        bbCode = encryptMessage(bbCode, dmSession.ekey);
    }

    await db.run('UPDATE messages SET edit_count = edit_count + 1, time = ?, message = ?, style = ? WHERE id = ?',
      now, bbCode, colorToStyle(q.color), id);

    res.json(null);
  }
});

app.delete('/api/delete', async (req, res) => {
  if (await allowedToEdit(req, res, 'delete')) {
    const id = toInt(req.query.msgId);
    const db = await getDb();

    await db.run('UPDATE messages SET deleted = 1 WHERE id = ?', id);

    res.json(null);
  }
});

app.post('/api/start-chat', async (req, res) => {
  const q = req.query as any;
  const self = q.self;
  const name = q.name;

  if (self === name) {
    res.status(400).json({ error: 'Cannot start a chat with yourself (not this way, at least).' });
    return;
  }
  else if (!self?.trim()) {
    res.status(400).json({ error: 'You must use a non-blank chat name to send DMs.' });
    return;
  }

  const participant = await getNamedParticipantRecord(name);

  if (!participant || !participant.allow_dm || !sessions.get(participant.session_id)?.inChat) {
    res.status(400).json({ error: `${name} is not available for direct messaging.` });
    return;
  }

  const now = Now();
  const db = await getDb();
  const dmSession = await db.get<DbDmSession>(`SELECT * FROM dm_session WHERE (name1 = ?1 AND name2 = ?2) OR
                                                 (name1 = ?2 AND name2 = ?1)`, name, self);
  if (dmSession) {
    const whichName = dmSession.name1 === self ? 'name1_present' : 'name2_present';

    await db.run(`UPDATE dm_session SET ${whichName} = 1 WHERE id = ?`, dmSession.id);

    const message = 'has joined this private chat';

    await db.run('INSERT INTO messages (dm, time, synced_time, name, trip, email, remote, ip, session_id, style, message, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      dmSession.id, now, now, self, q.tripCode, q.email, 0, getIp(req), '', 'E', message, messageHash('E:' + self, q.tripCode, now));

    res.json({ id: dmSession.id });
    return;
  }

  const encryptionKey = randomBytes(32).toString('base64');
  const result = await db.run('INSERT INTO dm_session (name1, name2, name1_present, ekey, start_time) VALUES (?, ?, 1, ?, ?)',
    self, name, encryptionKey, now);

  const message = 'has started this private chat';

  await db.run('INSERT INTO messages (dm, time, synced_time, name, trip, email, remote, ip, session_id, style, message, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    result.lastID, now, now, self, q.tripCode, q.email, 0, getIp(req), '', 'S', message, messageHash('S:' + self, q.tripCode, now));

  res.json({ id: result.lastID });
});

app.post('/api/leave-chat', async (req, res) => {
  const q = req.query as any;
  const self = q.self;
  const id = toInt(q.id);
  const db = await getDb();
  const dmSession = await db.get<DbDmSession>(`SELECT * FROM dm_session WHERE id = ?`, id);

  if (dmSession) {
    const now = Now();
    let message: string;

    if (!toBoolean(q.viewed))
      await db.run('DELETE FROM dm_session WHERE id = ?', id);
    else {
      const whichName = dmSession.name1 === self ? 'name1_present' : 'name2_present';

      dmSession[whichName] = -Now();
      await db.run(`UPDATE dm_session SET ${whichName} = ? WHERE id = ?`, -Now(), id);

      if (dmSession.name1_present < 0 && dmSession.name2_present < 0)
        await db.run('DELETE FROM dm_session WHERE id = ?', id);
      else
        message = 'has left this private chat';
    }

    if (message)
      await db.run('INSERT INTO messages (dm, time, synced_time, name, trip, email, remote, ip, session_id, style, message, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        dmSession.id, now, now, self, q.tripCode, q.email, 0, getIp(req), '', 'L', message, '');
  }

  res.json(null);
});

app.post('/api/upload', async (req, res) => {
  try {
    const url = await uploadSingle(req, res);

    res.json({ url });
  }
  catch (error) {
    console.error('Upload error:', error);
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Upload failed'
    });
  }
});

app.get('/api/error', (_req, res) => {
  res.status(500).json({ error: 'Internal server error' });
});

app.get('/', (_req, res) => {
  res.send('Static home file not found');
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGUSR2', shutdown);
process.on('unhandledRejection', err => console.error(`${timeStamp()} -- Unhandled rejection:`, err));

function shutdown(signal?: string): void {
  if (devMode && signal === 'SIGTERM') return;

  shuttingDown = true;
  console.log(`${timeStamp()} -- Shutting down...`);
  stopLocalSocksProxy().then(() => getDb().then(db => db.close().then(() => {
    clearTimeout(monitorTimeout);
    stopLegacyPolling();
  })));
}
