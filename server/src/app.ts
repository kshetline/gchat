import express from 'express';
import cors from 'cors';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { colors, Config, DbDmSession, DbMessage, DbParticipant, DmSession, Message, ParticipantInfo, TypingStatus } from './shared-types.js';
import { clone, isEqual, isObject, isString, processMillis, throttle, toBoolean, toInt } from '@tubular/util';
import { uploadSingle } from './uploader.js';
import { DbSessionInfo, SessionInfo } from './session-info';
import { addPendingDuplicate, announceDeparture, clearDeparture, enterLegacyChat, lastSuccessfulLegacyPoll, leaveLegacyChat, legacyDeleteMessage, legacyEditMessage, legacySendMessage, participantsRaw, stopLegacyPolling } from './legacy.js';
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
import { startWebSocketServer, sendToAll, sendToIp, wsPort } from './web-socket.js';

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
    ['info',  process.stdout, '[INFO] '],
    ['error', process.stderr, '[ERR]  '],
    ['warn',  process.stderr, '[WARN] '],
  ] as const) {
    const orig = console[method].bind(console);

    console[method] = (...args: unknown[]) => {
      orig(...args);

      if (isString(args[0] && (args[0] as string).includes('%s'))) {
        args[0] = (args[0] as string).replace(/(?<!%)%s/g, () => args.length > 1 ? String(args.splice(1, 1)) : '%s');
      }

      logFile.write(prefix + timeStamp() + ' ' + args.map(a => {
        let str = isObject(a) ? JSON.stringify(a) : String(a);

        if (isObject(a) && str === '{}' && !isEqual(a, {}))
          str = String(a);

        return str;
      }).join(' ') + '\n');
    };
  }
}

export const MAX_IDLE_PARTICIPANT_AGE = 172800; // 2 days
export const MAX_IDLE_SESSION_AGE = 7200; // 2 hours

const app = express();
const port = toInt(process.env.PORT) || 3000;
const __dirname = process.cwd();
const devMode = process.argv.includes('-d');
const sessions = new Map<string, SessionInfo>();
const proxyHidden = toBoolean(process.env.CHAT_PROXY_HIDDEN);
const proxyName = process.env.CHAT_PROXY || 'CHAT②';
const typingStatus = {} as TypingStatus;
const config: Config = {
  backgroundColor: process.env.CHAT_BACKGROUND || '#DDD',
  externalUploaderName: unescapeUnicode(process.env.EXTERNAL_UPLOADER_NAME || 'External Uploader'),
  externalUploaderShortName: unescapeUnicode(process.env.EXTERNAL_UPLOADER_SHORT_NAME || 'ExtUploader'),
  fileSizeLimitInMb: toInt(process.env.UPLOAD_MAX_SIZE_MB) || 15000,
  fileSizeLimitExtInMb: toInt(process.env.EXT_UPLOAD_MAX_SIZE_MB) || 200,
  navigation: process.env.NAV_LINKS.split(';').map(link => link.split('::'))
    .map(link => ({ name: link[0], url: link[1], target: link[2] || '_blank' })),
  title: process.env.CHAT_TITLE,
  wsPort
};
const URL_MATCHER = /\b(https?:\/\/[-A-Za-z0-9+&@#/%?=~_()|!:,.;]*[-A-Za-z0-9+&@#/%=~_()|])/g;
const MONITOR_INTERVAL = 60000; // 1 minute
const MAX_DM_AGE = 7200; // 2 hours
const MAX_HISTORY = 5000; // number of chat messages to keep in DB
const MAX_HISTORY_TOLERANCE = 500; // Overflow before deleting messages
const MAX_CLIENT_MESSAGES = 2000;
const NAME_REUSE_INTERVAL = 900; // 15 minutes

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

  try {
    const db = await getDb();
    const now = Now();

    await db.run('DELETE FROM messages WHERE dm > 0 AND synced_time < ?', now - MAX_DM_AGE);
    await db.run('DELETE FROM dm_session WHERE name1_present <= 1 AND name2_present <= 1 AND start_time < ?1 AND last_post < ?1', now - MAX_DM_AGE);

    for (const participant of await db.all<DbParticipant>('DELETE FROM participants WHERE last_active < ?', now - MAX_IDLE_PARTICIPANT_AGE))
      console.info(`Deleted participant record for ${participant.name}`);
    await db.run('DELETE FROM participants WHERE last_active < ?', now - MAX_IDLE_PARTICIPANT_AGE);

    for (const session of await db.all<DbSessionInfo>('SELECT * FROM sessions WHERE last_alive < ?', now - MAX_IDLE_SESSION_AGE))
      console.info(`Deleted session ${session.token} for ${session.name}, ${session.ip}`);
    await db.run('DELETE FROM sessions WHERE last_alive < ?', now - MAX_IDLE_SESSION_AGE);

    const messageCount = (await db.get<any>('SELECT COUNT(*) as count FROM messages WHERE dm = 0'))?.count || 0;

    if (messageCount > MAX_HISTORY + MAX_HISTORY_TOLERANCE)
      await db.run(`DELETE FROM messages WHERE dm = 0 AND id IN (
        SELECT id FROM (
          SELECT id FROM messages ORDER BY synced_time LIMIT ?
        ) AS subquery
      )`, messageCount - MAX_HISTORY);
  }
  catch (err) {
    console.error('Error cleaning up database:', err);
  }

  monitorTimeout = setTimeout(monitor, MONITOR_INTERVAL);
}

async function getLastSessions(): Promise<void> {
  const db = await getDb();
  const dbSessions = await db.all<DbSessionInfo>('SELECT * FROM sessions');
  const now = Now();
  let count = 0;

  for (const session of dbSessions) {
    if (session.last_alive < now - MAX_IDLE_SESSION_AGE)
      await db.run('DELETE FROM sessions WHERE token = ?', session.token);
    else {
      ++count;
      sessions.set(session.token, {
        allowDm: !!session.allow_dm,
        ip: session.ip,
        inChat: !!session.in_chat,
        lastActive: session.last_active,
        lastAlive: session.last_alive,
        lastContentUpdate: session.last_content_update,
        name: session.name
      });
    }
  }

  console.info(`Restored ${count} old session${count !== 1 ? 's' : ''}`);
}

async function updateDbSession(token: string): Promise<void> {
  const session = token && sessions.get(token);

  if (!session)
    return;

  try {
    const db = await getDb();
    const oldSession = await db.get<DbSessionInfo>('SELECT * FROM sessions WHERE token = ?', token);

    await db.run(`INSERT OR REPLACE INTO sessions
      (token, name, ip, allow_dm, in_chat, last_active, last_alive, last_content_update) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      token, session.name, session.ip, session.allowDm == null ? null : +session.allowDm,
      session.inChat == null ? null : +session.inChat, session.lastActive || 0, session.lastAlive || 0, session.lastContentUpdate || 0);

    if (!oldSession)
      console.info(`Created session ${token} for ${session.name}, ${session.ip}`);
    else if (session.name && (oldSession.name !== session.name || oldSession.ip !== session.ip))
      console.info(`Updated session ${token} with name "${session.name}", ip: ${session.ip}`);
  }
  catch (err: any) {
    console.error(`Failed to update session ${token} in database: ${err.message}`);
  }
}

async function sessionsCheck(): Promise<void> {
  const now = Now();

  for (const sessionId of sessions.keys()) {
    const session = sessions.get(sessionId);

    if (session?.name && session.lastAlive < now - MAX_IDLE_SESSION_AGE) {
      const db = await getDb();

      const changes = (await db.run('DELETE FROM participants WHERE name = ? AND remote = 0', session.name))?.changes;

      if ((changes || 0) > 0)
        console.info(`Deleted participant record for ${session.name}`);

      sessions.delete(sessionId);
      await db.run('DELETE FROM sessions WHERE token = ? ', sessionId);
      console.info(`Deleted session ${sessionId} for ${session.name}, ${session.ip}`);
    }
  }
}

export function reportUploadProgress(req: express.Request, progress: number): void {
  const session = sessions.get(getToken(req));

  if (session)
    session.progress = Math.round(progress);
}

async function getDirectMessages(name: string, tripCode: string, openDmString: string): Promise<DmSession[]> {
  const db = await getDb();
  const openDms = (openDmString || '').split('_').map(d => toInt(d)).filter(d => d > 0);
  const result: DmSession[] = [];
  const dmSessions = await db.all<DbDmSession>('SELECT * FROM dm_session WHERE name1 = ? or name2 = ?', name, name);
  const participantTrip = (await getNamedParticipantRecord(name))?.trip || '';

  if (participantTrip !== (tripCode || ''))
    return [];

  for (const dmSession of dmSessions) {
    const whichName = dmSession.name1 === name ? 'name1_present' : 'name2_present';
    const present = dmSession[whichName];

    // Have there been any new messages since this person left the chat? If so, don't broadcast the chat session until
    // there's something new to show.

    if (present < 0 && !openDms.includes(dmSession.id))
      continue;

    const sessionName = ((dmSession.name1 === name ? dmSession.name2 : dmSession.name1) || '').trim();

    if (dmSession.last_post < -present) {
      if (sessionName)
        result.push({ id: dmSession.id, messages: [null], name: sessionName });

      continue;
    }

    const rows = (await db.all<DbMessage>(
      'SELECT * FROM messages WHERE deleted = 0 AND dm = ? ORDER BY messages.synced_time',
        dmSession.id)).slice(-MAX_CLIENT_MESSAGES);
    const messages = rows.filter(row => !row.deleted).map(row => ({
      editCount: row.edit_count,
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

    if (sessionName)
      result.push({ id: dmSession.id, messages, name: sessionName });
  }

  return result;
}

function cleanName(name: any): string {
  return ((name || '') as string).replace(/#.*$/, '').trim();
}

async function participantCheck(req: express.Request, forceInChat = false, nameOverride?: string): Promise<void> {
  const session = sessions.get(getToken(req));
  const inChat = session?.inChat || forceInChat;
  const q = req.query as any;
  const name = nameOverride ?? cleanName(q.name);
  const token = getToken(req);
  const ip = getIp(req);
  const proxied = +(!toBoolean(q.framed));

  if (!name)
    return;

  if (session) {
    let changed = false;

    if (session.ip !== ip) {
      session.ip = ip;
      changed = true;
    }

    if (!session.inChat && inChat && !session.inChatLock) {
      session.inChat = true;
      session.inChatLock = true;
      changed = true;
    }

    if (changed)
      await updateDbSession(token);
  }

  const db = await getDb();
  const participant = await db.get<DbParticipant>('SELECT * FROM participants where name = ? AND remote = 0 LIMIT 1', name);

  if (!participant) {
    const changes = (await db.run('DELETE FROM participants WHERE name = ?', name))?.changes;

    if ((changes || 0) > 0)
      console.info(`Deleted ${changes} participant record${changes > 1 ? 's' : ''} for ${name}`);

    if (session?.inChat) {
      await db.run('INSERT INTO participants (name, trip, email, ip, session_id, remote, proxied, last_active, last_post) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        name, q.tripCode, q.email, session?.ip, token, 0, proxied, Now(), 0);
      clearDeparture(name);
      console.info(`Created participant record for ${name}${q.tripCode ? '◆' + tripcode(q.tripCode) : ''}`);
    }
  }
  else {
    const changes = (await db.run('DELETE FROM participants WHERE name = ? AND remote = 1', name))?.changes;

    if ((changes || 0) > 0)
      console.info(`Deleted ${changes} remote participant record${changes > 1 ? 's' : ''} for ${name}`);

    if (participant.ip !== ip || participant.trip !== q.tripCode || participant.session_id !== token || participant.proxied !== proxied) {
      await db.run('UPDATE participants SET ip = ?, trip = ?, last_active = ?, session_id = ?, proxied = ? WHERE name = ? AND remote = 0',
        ip, q.tripCode, Now(), token, proxied, name);

      if (participant.trip !== q.tripCode)
        console.info(`Updated participant record for ${name} with ${q.tripCode ? 'trip code ' + tripcode(q.tripCode) : 'empty trip code'}`);
    }
  }
}

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

async function notifyDmPartners(dmSession: DbDmSession, message?: string): Promise<void>;
async function notifyDmPartners(name1: string, name2: string, message?: string): Promise<void>;
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
async function notifyDmPartners(dmSessionOrName: string | DbDmSession, name2orMessage?: string, message?: string): Promise<void> {
  let name1: string;
  let name2: string;

  if (isString(dmSessionOrName)) {
    name1 = dmSessionOrName;
    name2 = name2orMessage;
  }
  else {
    name1 = dmSessionOrName.name1;
    name2 = dmSessionOrName.name2;
    message = name2orMessage;
  }

  message = message ?? 'newDirectMessages';

  const ip1 = (await getNamedParticipantRecord(name1))?.ip;
  const ip2 = (await getNamedParticipantRecord(name2))?.ip;

  if (ip1)
    sendToIp(ip1, message, undefined, name1, sessions);

  if (ip2 && ip2 !== ip1)
    sendToIp(ip2, message, undefined, name2, sessions);
}

async function allowedToEdit(req: express.Request, res: express.Response, action = 'edit'): Promise<DbMessage> {
  const q = req.query as any;
  const name = cleanName(q.name);
  const tripCode = q.tripCode && tripcode(q.tripCode);

  if (!await isBannedName(name, tripCode) && !await isBannedIp(getIp(req))) {
    const id = toInt(q.msgId);
    const db = await getDb();
    const message = await db.get<DbMessage>('SELECT * FROM messages WHERE id = ? LIMIT 1', id);

    if (message && message.name === name &&
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

function hasChatOpen(name: string, dmId: number): boolean {
  return !![...sessions.values()].find(s => s.inChat && s.name === name && (dmId === 0 || s.openDms.has(dmId)));
}

(async () => {
  await getLastSessions();
  monitor().finally();
  initExternalUploader().catch().finally();

  app.set('trust proxy', 1);
  app.use(express.json());
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
    let session: SessionInfo = token && sessions.get(token);

    if (token && !session) {
      const ip = getIp(req);
      session = {
        allowDm: req.query?.allowDm != null ? toBoolean(req.query?.allowDm) : null,
        inChat: req.query?.inChat != null ? toBoolean(req.query?.inChat) : false,
        ip: ip_.isPrivate(ip) ? await getServerIp() : ip,
        lastAlive: Now(),
        lastContentUpdate: 0,
        name: req.query?.name != null ? cleanName(req.query?.name) : null
      };
      sessions.set(token, session);
      await updateDbSession(token);
    }

    next();
  });

  const server = app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });

  startWebSocketServer(server);

  app.use(intrusionDetector);
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/token', async (req, res) => {
    const token = randomUUID();
    const ip = getIp(req);
    const session = {
      ip: ip_.isPrivate(ip) ? await getServerIp() : ip,
      allowDm: req.query?.allowDm != null ? toBoolean(req.query?.allowDm) : null,
      inChat: req.query?.inChat != null ? toBoolean(req.query?.inChat) : false,
      lastAlive: Now(),
      lastContentUpdate: 0,
      name: req.query?.name != null ? cleanName(req.query?.name) : null
    };

    sessions.set(token, session);
    await updateDbSession(token);
    console.info(`Created session ${token} for ${session.name}, ${session.ip}`);

    res.json({ token });
  });

  app.get('/api/config', (_req, res) => {
    res.json(config);
  });

  app.get('/api/messages', async (req, res) => {
    const q = req.query as any;

    if (toBoolean(q.inChat))
      await participantCheck(req);

    const token = getToken(req);
    const session = sessions.get(token);
    const tripCode = tripcode(q.tripCode);
    const name = cleanName(q.name);
    const active = toBoolean(req.query.active);
    const now = Now();

    if (session) {
      // @ts-ignore - Not sure why TS is complaining about lack of explicit type on `d`
      session.openDms = new Set((q.openDms || '').split('_').map(d => toInt(d)).filter(d => d > 0));

      if (active)
        session.lastActive = now;

      session.lastAlive = now;
      session.name = name;

      if (q.inChat != null && !session.inChatLock)
        session.inChat = toBoolean(q.inChat);

      await updateDbSession(token);
    }

    const db = await getDb();
    const rows = (await db.all<DbMessage>(
      'SELECT * FROM messages WHERE deleted = 0 AND dm = 0 ORDER BY messages.synced_time')).slice(-MAX_CLIENT_MESSAGES);
    let messages = rows.filter(row => !row.deleted).map(row => ({
      editCount: row.edit_count,
      email: row.email,
      flagged: row.flagged,
      hash: row.hash,
      html: convertBBCodeToHtml(row.message),
      isMe: row.name === name && (row.session_id === getToken(req) || row.ip === session?.ip ||
        (row.trip && (row.trip === q.tripCode || row.trip === tripCode))),
      msgId: row.id,
      name: row.name,
      remote: !!row.remote,
      style: row.style,
      time: row.synced_time,
      trip: row.remote ? row.trip : tripcode(row.trip)
    } as Message));

    const force = toBoolean(req.query.force);
    let participant = await getNamedParticipantRecord(name);
    const oldAllowDM = participant?.allow_dm;
    let newAllowDM = +toBoolean(q.allowDMs);

    if (session && session.allowDm !== !!newAllowDM) {
      session.allowDm = !!newAllowDM;
      await updateDbSession(token);
    }

    newAllowDM = 0;

    for (const session2 of sessions.values()) {
      if (session2.name === name)
        newAllowDM = newAllowDM || +session2.allowDm;
    }

    if (participant && active) {
      await db.run('UPDATE participants SET allow_dm = ? WHERE id = ?', newAllowDM, participant.id);

      if (session?.inChat)
        await db.run('UPDATE participants SET last_active = ?, remote = 0 WHERE id = ?', now, participant.id);

      if (newAllowDM !== oldAllowDM)
        sendToAll('newMessages');
    }

    const participantNames = (await db.all<any>('SELECT name FROM participants WHERE name != ?',
      proxyName)).map(r => r.name);
    const participants = [...new Set(participantNames)].sort().map(p => ({ name: p } as ParticipantInfo));

    for (let i = participants.length - 1; i >= 0; --i) {
      const participantInfo = participants[i];
      const participant = await getNamedParticipantRecord(participantInfo.name);

      if (participant && !participant.remote) {
        let session2 = sessions.get(participant.session_id);

        if (!session2 && participant.name === name) {
          session2 = session;
          await db.run('UPDATE participants SET session_id = ? WHERE id = ?', getToken(req), participant.id);
          console.info(`Updated session ID for participant ${participantInfo.name}`);
        }

        if (session2 && !session2.inChat) {
          participants.splice(i, 1);
          continue;
        }
        else if (session2) {
          participant.remote = 0;
          participant.last_active = Math.max(participant.last_active, session2.lastActive);
        }
        // last_post should only be greater than last_active for the same screen name posting as a remote participant
        else if (participant.last_post > participant.last_active) {
          participant.remote = 1;
          participant.last_active = participant.last_post;
        }
      }

      if (participant) {
        participantInfo.allowsDms = !!participant.allow_dm && !participant.remote;
        participantInfo.idle = now - Math.max(participant.last_active, participant.last_post) > (participant.remote ? 1800 : 600) ? 1 : 0;
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
      lastContentUpdate = now;
      sendToAll('newMessages');
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
      await updateDbSession(token);
    }
    else
      deleteCount = appendAt = 0;

    await sessionsCheck();

    let lslp = lastSuccessfulLegacyPoll;

    if (lslp <= 0)
      lslp = messages.findLast(m => m?.remote)?.time ?? -1;

    res.json({
      messages,
      deleteCount,
      append: appendAt > 0,
      participants,
      participantsRaw,
      dms: await getDirectMessages(name, q.tripCode, q.openDms),
      lastSuccessfulLegacyPoll: lslp,
      progress: session?.progress,
      proxyIp,
      wsPort
    });
  });

  app.get('/api/dms', async (req, res) => {
    res.json(await getDirectMessages(cleanName(req.query.name), req.query.tripCode as string, req.query.openDms as string));
  });

  app.post('/api/enter', async (req, res) => {
    const q = req.query as any;
    const name = cleanName(q.name);

    if (await isBannedName(name, tripcode(q.tripCode)) || await isBannedIp(getIp(req))) {
      res.status(400).json({ error: 'Entry into chat room failed' });
      return;
    }

    const framed = toBoolean(q.framed);
    const token = getToken(req);
    const session = sessions.get(token) ?? { temp: true } as unknown as SessionInfo;
    const db = await getDb();
    const now = Now();
    const participant = await db.get<DbParticipant>('SELECT * FROM participants where name = ? AND remote = 0 LIMIT 1', name);
    const wasInChat = hasChatOpen(name, 0);

    if (name) {
      if (!participant) {
        const changes = (await db.run('DELETE FROM participants WHERE name = ?', name))?.changes;

        if ((changes || 0) > 0)
          console.info(`Deleted ${changes} participant record${changes > 1 ? 's' : ''} for ${name}`);

        await db.run('INSERT INTO participants (name, trip, email, ip, session_id, remote, proxied, last_active, last_post) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          name, q.tripCode, q.email, session.ip, token, 0, +(!framed), now, 0);
        session.inChat = true;
        session.inChatLock = true;
        clearDeparture(name);
        console.info(`Created participant record for ${name}${q.tripCode ? '◆' + tripcode(q.tripCode) : ''}`);
      }
      else {
        const timeInactive = now - participant.last_active;

        if (timeInactive > NAME_REUSE_INTERVAL ||
              (!participant.trip && q.tripCode) || q.tripCode === participant.trip ||
              !participant.ip || session.ip === participant.ip ||
              !participant.session_id || token === participant.session_id) {
          await db.run('UPDATE participants SET trip = ?, email = ?, ip = ?, session_id = ?, remote = ?, proxied = ?, last_active = ? WHERE id = ?',
            q.tripCode, q.email, session.ip, token, 0, +(!framed), now, participant.id);
          session.inChat = true;
          session.inChatLock = true;
          await updateDbSession(token);
          console.info(`Updated participant record for ${name}${q.tripCode ? '◆' + tripcode(q.tripCode) : ''}`);

          const changes = (await db.run('DELETE FROM participants WHERE name = ? AND remote = 1', name))?.changes;

          if ((changes || 0) > 0)
            console.info(`Deleted ${changes} remote participant record${changes > 1 ? 's' : ''} for ${name}`);
        }
        else {
          const remaining = Math.ceil((NAME_REUSE_INTERVAL - timeInactive) / 60);

          res.status(400).json({
            error: `Chat name '${name}' is already in use by another user.\n\n` +
              `The name will be available again in ${remaining} minute${remaining === 1 ? '' : 's'} if the current user remains inactive for that time.` +
              (participant.trip ? '\n\nReuse the same tripcode previously used along with this name for immediate access.' +
                ' You can use the format "name#tripcode" in the name field to enter the room with your tripcode already set.' : '')
          });

          return;
        }
      }
    }
    else {
      res.status(400).json({
        error: 'Blank chat name not allowed.'
      });

      return;
    }

    if (session.inChat && !wasInChat) {
      const lastEnterOrLeave = await db.get<any>(`SELECT id, style FROM messages WHERE synced_time > ? AND dm = 0 AND name = ? AND trip = ? AND
        remote = 0 AND LENGTH(style) = 1 ORDER BY synced_time DESC LIMIT 1`, now - 3600, name, q.tripCode);

      if (lastEnterOrLeave?.style === 'E')
        await db.run('UPDATE messages SET synced_time = ? WHERE id = ?', now, lastEnterOrLeave.id);
      else {
        const message = 'has joined ' + process.env.CHAT_TITLE;

        await db.run('INSERT INTO messages (dm, time, synced_time, name, trip, email, remote, ip, session_id, style, message, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          0, now, now, name, q.tripCode, q.email, 0, session.ip, token, 'E', message, messageHash('E:' + name, q.tripCode, now));
        sendToAll('newMessages');
      }
    }

    if (!framed && !proxyStarted) {
      await enterLegacyChat(session?.ip, proxyName, null, 0);
      proxyStarted = true;
    }

    if (!(session as any).temp)
      await updateDbSession(token);

    res.json(null);
  });

  app.post('/api/leave', async (req, res) => {
    const q = req.query as any;
    const name = cleanName(q.name);
    const token = getToken(req);
    const session = sessions.get(token);
    const wasInChat = session?.inChat;

    if (!wasInChat) {
      res.json(null);
      return;
    }

    const db = await getDb();
    const participant = await db.get<DbParticipant>('SELECT * FROM participants where name = ? AND remote = 0 LIMIT 1', name);

    if (participant && (q.tripCode === participant.trip || session.ip === participant.ip || token === participant.session_id)) {
      session.inChat = false;
      session.inChatLock = true;

      if (!hasChatOpen(name, 0)) {
        const changes = (await db.run('DELETE FROM participants WHERE id = ?', participant.id))?.changes;

        if ((changes || 0) > 0)
          console.info(`Deleted ${changes} participant record${changes > 1 ? 's' : ''} for ${name}`);
      }

      await updateDbSession(token);
    }

    if (!session.inChat && wasInChat) {
      const now = Now();
      const message = 'has left ' + process.env.CHAT_TITLE;
      const dms = [0];
      const dmSessions = await db.all<DbDmSession>(
        'SELECT * FROM dm_session WHERE (name1 = ? AND name1_present > 0) or (name2 = ? AND name2_present > 0)', name, name);

      dmSessions.forEach(dm => dms.push(dm.id));

      for (const dm of dms) {
        if (session.openDms)
          session.openDms.delete(dm);

        if (!hasChatOpen(name, dm)) {
          await db.run('INSERT INTO messages (dm, time, synced_time, name, trip, email, remote, ip, session_id, style, message, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            dm, now, now, name, q.tripCode, q.email, 0, session.ip, token, 'L', message, messageHash('L:' + q.name, q.tripCode, now));
        }
      }

      announceDeparture(name);
      sendToAll('newMessages');
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

  app.post('/api/send', async (req, res) => {
    await participantCheck(req, true);

    const q = req.query as any;
    const name = cleanName(q.name);

    if (await isBannedName(name, tripcode(q.tripCode)) || await isBannedIp(getIp(req))) {
      res.status(400).json({ error: 'Send message failed' });
      return;
    }

    const token = getToken(req);
    const session = sessions.get(token);
    const db = await getDb();
    const now = Now();
    const style = colorToStyle(q.color);
    const rawComment = (req.body?.comment || q.comment || '').replace(/[\n\r]+/g, ' ');
    let comment = rawComment.replace(URL_MATCHER, '[url=$1]$1[/url]');
    const hash = messageHash(name, q.tripCode, now);
    const framed = toBoolean(q.framed);
    const dm = toInt(q.dm);
    let dmSession: DbDmSession;

    setTypingStatus(name, -1);

    if (session && !session.inChat) {
      session.inChat = true;
      delete session.inChatLock;
      await updateDbSession(token);
    }

    if (dm) {
      dmSession = await db.get<DbDmSession>('SELECT * FROM dm_session WHERE id = ?', dm);

      if (!dmSession) {
        res.status(400).json({ error: 'This chat session is closed.', closed: true });
        return;
      }
      else if (!name) {
        res.status(400).json({ error: 'You must use a non-blank chat name to send DMs.', closed: true });
        return;
      }
      else
        comment = encryptMessage(comment, dmSession.ekey);
    }

    const result = await db.run('INSERT INTO messages (dm, time, synced_time, name, trip, email, remote, ip, session_id, style, message, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      dm, now, now, name, q.tripCode, q.email, 0, session?.ip, token, style, comment, hash);

    if (!dm && (framed || proxyHidden))
      addPendingDuplicate(result.lastID, now, name, comment);

    await db.run('UPDATE participants SET last_post = ?1, last_active = ?1 WHERE name = ?2 AND remote = 0', now, name);

    if (dmSession) {
      await db.run('UPDATE dm_session SET last_post = ? WHERE id = ?', now, dmSession.id);
      await notifyDmPartners(dmSession);
    }
    else
      sendToAll('newMessages');

    const participant = await db.get<DbParticipant>('SELECT * FROM participants where name = ? AND remote = 0 LIMIT 1', name);

    if (participant)
      await db.run('UPDATE participants SET last_post = ?1, last_active = ?1 WHERE id = ?2', now, participant.id);

    if (!dm && !framed && !comment.includes('##cpc-only##')) {
      if (!proxyStarted) {
        await enterLegacyChat(session?.ip, proxyName, null, 0);
        proxyStarted = true;
      }

      await legacySendMessage(session?.ip, name, q.email, rawComment, q.color, q.tripCode);
    }

    res.json(null);
  });

  app.get('/api/can-edit', async (req, res) => {
    const message = await allowedToEdit(req, res);

    if (message)
      res.send({ bbCode: message.message, color: styleToColor(message.style) });
  });

  app.put('/api/update', async (req, res) => {
    await participantCheck(req, true);

    if (await allowedToEdit(req, res)) {
      const q = req.query as any;
      const id = toInt(q.msgId);
      const db = await getDb();
      const now = Now();
      const rawBbCode = req.body?.bbCode || q.bbCode as string || '';
      let bbCode = rawBbCode.replace(URL_MATCHER, '[url=$1]$1[/url]');
      const oldMessage = await db.get<DbMessage>('SELECT * FROM messages WHERE id = ?', id);
      const dm = oldMessage.dm;
      const name = cleanName(q.name);

      setTypingStatus(name, -1);

      if (dm) {
        const dmSession = await db.get<DbDmSession>('SELECT * FROM dm_session WHERE id = ?', dm);

        if (dmSession)
          bbCode = encryptMessage(bbCode, dmSession.ekey);
      }

      await db.run('UPDATE messages SET edit_count = edit_count + 1, time = ?, message = ?, style = ? WHERE id = ?',
        now, bbCode, colorToStyle(q.color), id);
      sendToAll('newMessages');

      if (!dm)
        legacyEditMessage(oldMessage.name, q.tripCode, oldMessage.synced_time, rawBbCode, colors[q.color].trim()).finally();

      res.json(null);
    }
  });

  app.delete('/api/delete', async (req, res) => {
    await participantCheck(req, true);

    if (await allowedToEdit(req, res, 'delete')) {
      const id = toInt(req.query.msgId);
      const db = await getDb();
      const oldMessage = await db.get<DbMessage>('SELECT * FROM messages WHERE id = ?', id);

      await db.run('UPDATE messages SET deleted = 1 WHERE id = ?', id);
      sendToAll('newMessages');

      if (!oldMessage.dm)
        legacyDeleteMessage(oldMessage.name, req.query.tripCode as string, oldMessage.synced_time).finally();

      res.json(null);
    }
  });

  app.post('/api/start-chat', async (req, res) => {
    const q = req.query as any;
    const self = cleanName(q.self);
    await participantCheck(req, true, self);
    const name = ((q.name || '') as string).trim();

    if (self === name) {
      res.status(400).json({ error: 'Cannot start a chat with yourself (not this way, at least).' });
      return;
    }
    else if (!self) {
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
    const token = getToken(req);
    const session = sessions.get(token);

    if (dmSession) {
      if (!session || !hasChatOpen(name, dmSession.id)) {
        const whichName = dmSession.name1 === self ? 'name1_present' : 'name2_present';

        await db.run(`UPDATE dm_session SET ${whichName} = ? WHERE id = ?`, now, dmSession.id);
        console.info(`DM session ${dmSession.id} for ${dmSession.name1} & ${dmSession.name2} joined by ${self}`);

        const lastEnterOrLeave = await db.get<any>(`SELECT id, style FROM messages WHERE synced_time > ? AND dm = ? AND name = ? AND trip = ? AND
          remote = 0 AND LENGTH(style) = 1 ORDER BY synced_time DESC LIMIT 1`, now - 3600, dmSession.id, name, q.tripCode);

        if (lastEnterOrLeave?.style === 'E')
          await db.run('UPDATE messages SET synced_time = ? WHERE id = ?', now, lastEnterOrLeave.id);
        else if (dmSession[whichName] <= 0) {
          const message = 'has joined this private chat';

          await db.run('INSERT INTO messages (dm, time, synced_time, name, trip, email, remote, ip, session_id, style, message, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            dmSession.id, now, now, self, q.tripCode, q.email, 0, getIp(req), '', 'E', message, messageHash('E:' + self, q.tripCode, now));
        }

        if (session) {
          session.openDms = session.openDms || new Set();
          session.openDms.add(dmSession.id);
        }

        await notifyDmPartners(dmSession, 'newDirectMessages');
      }

      res.json({ id: dmSession.id });
      return;
    }

    const encryptionKey = randomBytes(32).toString('base64');
    const result = await db.run('INSERT INTO dm_session (name1, name2, name1_present, ekey, start_time) VALUES (?, ?, 1, ?, ?)',
      self, name, encryptionKey, now);

    const message = 'has started this private chat';

    await db.run('INSERT INTO messages (dm, time, synced_time, name, trip, email, remote, ip, session_id, style, message, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      result.lastID, now, now, self, q.tripCode, q.email, 0, getIp(req), '', 'S', message, messageHash('S:' + self, q.tripCode, now));
    await notifyDmPartners(self, name, 'newMessages');
    console.info(`Created DM session for ${self} & ${name}`);

    if (session) {
      session.openDms = session.openDms || new Set();
      session.openDms.add(result.lastID);
    }

    res.json({ id: result.lastID });
  });

  app.post('/api/leave-chat', async (req, res) => {
    const q = req.query as any;
    const self = cleanName(q.self);
    const id = toInt(q.id);
    const db = await getDb();
    const dmSession = await db.get<DbDmSession>(`SELECT * FROM dm_session WHERE id = ?`, id);
    const token = getToken(req);
    const session = sessions.get(token);

    if (dmSession && session?.openDms)
      session.openDms.delete(dmSession.id);

    if (dmSession && !hasChatOpen(self, dmSession.id)) {
      const now = Now();
      const whichName = dmSession.name1 === self ? 'name1_present' : 'name2_present';
      let message: string;

      if (!toBoolean(q.viewed) && dmSession[whichName] <= 0) {
        await db.run('DELETE FROM dm_session WHERE id = ?', id);
        console.info(`Deleted DM session for ${dmSession.name1} & ${dmSession.name2}`);
      }
      else {
        const whichName = dmSession.name1 === self ? 'name1_present' : 'name2_present';

        dmSession[whichName] = -Now();
        await db.run(`UPDATE dm_session SET ${whichName} = ? WHERE id = ?`, -Now(), id);

        if (dmSession.name1_present < 0 && dmSession.name2_present < 0) {
          await db.run('DELETE FROM dm_session WHERE id = ?', id);
          console.info(`Deleted DM session for ${dmSession.name1} & ${dmSession.name2}`);
        }
        else
          message = 'has left this private chat';
      }

      if (message)
        await db.run('INSERT INTO messages (dm, time, synced_time, name, trip, email, remote, ip, session_id, style, message, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          dmSession.id, now, now, self, q.tripCode, q.email, 0, getIp(req), '', 'L', message, '');

      await notifyDmPartners(dmSession);
    }

    res.json(null);
  });

  app.post('/api/upload', async (req, res) => {
    await participantCheck(req);

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

  const updateTypingStatus = throttle(1000, () => {
    const now = processMillis();
    const status = clone(typingStatus);

    Object.keys(status).forEach(name => {
      status[name].since = now - status[name].since;

      if (status[name].since > 5 || status[name].dm === -1) {
        delete status[name];
      }
    });

    sendToAll('typing', status);
  });

  function setTypingStatus(name: string, dm: number, since = processMillis()): void {
    typingStatus[name] = { dm, since };
    updateTypingStatus();
  }

  app.post('/api/typing', async (req, res) => {
    const dm = toInt(req.body.dm);
    const name = req.body.name;

    if (name)
      setTypingStatus(name, dm);

    res.json(null);
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
})();
