import express from 'express';
import cors from 'cors';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { colors, Config, DbDmSession, DbMessage, DbParticipant, DmSession, Message, ParticipantInfo } from './shared-types.js';
import { isEqual, processMillis, toBoolean, toInt } from '@tubular/util';
import { uploadSingle } from './uploader.js';
import { SessionInfo } from './session-info';
import { addPendingDuplicate, enterLegacyChat, leaveLegacyChat, legacySendMessage } from './legacy.js';
import { getDb, getNamedParticipantRecord } from './db.js';
import ip_ from 'ip';
import axios from 'axios';
import { convertBBCodeToHtml, getIp, messageHash } from './chat-util.js';
import tripcode from 'tripcode';
import path from 'path';

const app = express();
const port = toInt(process.env.PORT) || 3000;
const __dirname = process.cwd();
const sessions = new Map<string, SessionInfo>();
const proxyName = process.env.CHAT_PROXY || 'CHAT②';
const config: Config = {
  backgroundColor: process.env.CHAT_BACKGROUND || '#DDD',
  fileSizeLimitInMb: toInt(process.env.UPLOAD_MAX_SIZE_MB),
  navigation: process.env.NAV_LINKS.split(';').map(link => link.split('::'))
    .map(link => ({ name: link[0], url: link[1], target: link[2] || '_blank' })),
  title: process.env.CHAT_TITLE,
};
const URL_MATCHER = /\b(https?:\/\/[-A-Za-z0-9+&@#/%?=~_()|!:,.;]*[-A-Za-z0-9+&@#/%=~_()|])/g;
const MONITOR_INTERVAL = 60000; // 1 minute
const MAX_DM_AGE = 3600; // 1 hour
const MAX_HISTORY = 2000; // chat messages to keep in DB
const MAX_HISTORY_TOLERANCE = 200; // Overflow before deleting messages

let proxyStarted = false;
let lastContentUpdate = 0;
let lastMessages: Message[] = null;

let serverIp: string;
const IP_MATCHER = /(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)/;

async function getServerIp(): Promise<string> {
  if (!serverIp)
    serverIp = (IP_MATCHER.exec((await axios.get(process.env.GET_IP_SERVICE)).data) || [])[0] || '127.0.0.1';

  return serverIp;
}

async function monitor(): Promise<void> {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);

  await db.run('DELETE FROM messages WHERE dm > 0 AND synced_time < ?', now - MAX_DM_AGE);
  await db.run('DELETE FROM dm_session WHERE name1_present = 0 AND name2_present = 0 AND last_post < ?', now - MAX_DM_AGE);

  const messageCount = (await db.get<any>('SELECT COUNT(*) as count FROM messages'))?.count || 0;

  if (messageCount > MAX_HISTORY + MAX_HISTORY_TOLERANCE)
    await db.run('DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY messages.synced_time LIMIT ?)',
      messageCount - MAX_HISTORY);

  setTimeout(monitor, MONITOR_INTERVAL);
}

monitor().finally();

async function sessionsCheck(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  for (const sessionId of sessions.keys()) {
    const session = sessions.get(sessionId);

    if (session.name && session.lastAlive < now - 1800) {
      const db = await getDb();

      await db.run('DELETE FROM participants WHERE name = ? AND remote = 0', session.name);
      sessions.delete(sessionId);
    }
  }
}

async function getDirectMessages(name: string): Promise<DmSession[]> {
  const db = await getDb();
  const result: DmSession[] = [];
  const dmSessions = await db.all<DbDmSession>('SELECT * FROM dm_session WHERE name1 = ? or name2 = ?', name, name);

  for (const dmSession of dmSessions) {
    const rows = (await db.all<DbMessage>(
      'SELECT * FROM messages WHERE deleted = 0 AND dm = ? ORDER BY messages.synced_time',
      dmSession.id)).slice(-1000);
    const messages = rows.filter(row => !row.deleted).map(row => ({
      email: row.email,
      hash: row.hash,
      html: convertBBCodeToHtml(decryptMessage(row.message, dmSession.key)) || '???',
      isMe: row.name === name,
      msgId: row.id,
      name: row.name,
      remote: !!row.remote,
      style: row.style,
      time: row.synced_time,
      trip: row.remote ? row.trip : tripcode(row.trip)
    } as Message));

    result.push({ id: dmSession.id, messages, name: dmSession.name1 === name ? dmSession.name2 : dmSession.name1 });
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

function getToken(req: express.Request): string {
  const auth = req.headers.authorization;
  return auth?.startsWith('Bearer ') ? auth.slice(7) : null;
}

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
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

app.use(async (req, _res, next) => {
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
  const now = Math.floor(Date.now() / 1000);

  if (session) {
    session.lastAlive = now;
    session.name = name;

    if (q.inChat != null)
      session.inChat = toBoolean(q.inChat);
  }

  const db = await getDb();
  const rows = (await db.all<DbMessage>('SELECT * FROM messages WHERE deleted = 0 AND dm = 0 ORDER BY messages.synced_time')).slice(-1000);
  let messages = rows.filter(row => !row.deleted).map(row => ({
    email: row.email,
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
  const twoHoursAgo = now - 7200;
  let participant = await getNamedParticipantRecord(name);

  if (participant) {
    await db.run('UPDATE participants SET allow_dm = ? WHERE id = ?', +toBoolean(q.allowDMs), participant.id);

    if (active && session.inChat)
      await db.run('UPDATE participants SET last_active = ?, remote = 0 WHERE id = ?', now, participant.id);
  }

  const participantNames = (await db.all<any>(
    'SELECT name FROM participants WHERE name != ?1 AND (last_active > ?2 OR last_post > ?2)',
      proxyName, twoHoursAgo)).map(r => r.name);
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
    }

    if (participant) {
      participantInfo.allowsDms = !!participant.allow_dm;
      participantInfo.idle = now - participant.last_active > (participant.remote ? 1800 : 600) ? 1 : 0;
      participantInfo.remote = !!participant.remote;
    }
  }

  // Some duplicate messages are still slipping through, so one more check is needed
  const dupMap = new Map<string, Set<number>>();
  const addKeyIdPair = (key: string, id: number) => {
    if (!dupMap.has(key)) dupMap.set(key, new Set());
    dupMap.get(key).add(id);
  };

  for (const message of messages) {
    if (message.time < now - 600) // Only consider messages from the last 10 minutes
      continue;

    addKeyIdPair(`${message.name}\t${Math.floor(message.time / 10)}\t${message.bbCode}`, message.msgId);
    addKeyIdPair(`${message.name}\t${Math.floor((message.time + 5) / 10)}\t${message.bbCode}`, message.msgId);
  }

  const dupes = [...dupMap.values()].filter(s => s.size > 1);

  for (const dupSet of dupes) {
    const ids = [...dupSet].join(',');
    const matches = await db.all<DbMessage>(`SELECT * FROM messages WHERE id IN (${ids})`);
    const remotes = matches.filter(m => m.remote);

    for (const remote of remotes) {
      const index = messages.findIndex(msg => msg.msgId === remote.id);

      if (index >= 0) {
        messages.splice(index, 1);
        await db.run('DELETE FROM messages WHERE id = ?', remote.id);
        dupSet.delete(remote.id);
      }
    }

    if (dupSet.size > 1)
      console.log(`Duplicate messages found: ${[...dupSet].join(', ')}`);
  }

  if (!isEqual(lastMessages, messages)) {
    lastMessages = messages;
    lastContentUpdate = processMillis();
  }

  if (force || (session && session.lastContentUpdate !== lastContentUpdate))
    session.lastContentUpdate = lastContentUpdate;
  else
    messages = [null];

  await sessionsCheck();
  res.json({ messages, participants, dms: await getDirectMessages(name) });
});

app.post('/api/enter', async (req, res) => {
  const q = req.query as any;
  const token = getToken(req);
  const session = sessions.get(token);
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  const participant = await db.get<DbParticipant>('SELECT * FROM participants where name = ? AND remote = 0 LIMIT 1', q.name);

  if (!participant && q.name) {
    await db.run('INSERT INTO participants (name, trip, email, ip, session_id, remote, last_active, last_post) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      q.name, q.tripCode, q.email, session.ip, token, 0, now, 0);
    session.inChat = true;
  }
  else if (q.tripCode === participant.trip || !participant.ip || session.ip === participant.ip ||
           !participant.session_id || token === participant.session_id) {
    await db.run('UPDATE participants SET trip = ?, email = ?, ip = ?, session_id = ?, remote = ?, last_active = ? WHERE id = ?',
      q.tripCode, q.email, session.ip, token, 0, now, participant.id);
    session.inChat = true;
    await db.run('DELETE FROM participants WHERE name = ? AND remote = 1', q.name);
  }
  else {
    res.status(400).json({
      error: `Chat name '${q.name}' is already in use by another user.`
    });

    return;
  }

  if (!toBoolean(q.framed) && !proxyStarted) {
    await enterLegacyChat(proxyName, null, 0);
    proxyStarted = true;
  }

  res.json(null);
});

app.post('/api/leave', async (req, res) => {
  const q = req.query as any;
  const token = getToken(req);
  const session = sessions.get(token);

  if (!session?.inChat) {
    res.json(null);
    return;
  }

  const db = await getDb();
  const participant = await db.get<DbParticipant>('SELECT * FROM participants where name = ? AND remote = 0 LIMIT 1', q.name);

  if (participant && (q.tripCode === participant.trip || session.ip === participant.ip || token === participant.session_id)) {
    await db.run('DELETE FROM participants WHERE id = ?', participant.id);
    session.inChat = false;
  }

  if (!toBoolean(q.framed) && Array.from(sessions.values()).findIndex(s => s.inChat) < 0) {
    await leaveLegacyChat();
    proxyStarted = false;
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
  const token = getToken(req);
  const session = sessions.get(token);
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  const q = req.query as any;
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
      res.status(400).json({ error: 'This chat session is closed', closed: true });
      return;
    }
    else
      comment = encryptMessage(comment, dmSession.key);
  }

  const result = await db.run('INSERT INTO messages (dm, time, synced_time, name, trip, email, remote, ip, session_id, style, message, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    dm, now, now, q.name, q.tripCode, q.email, 0, session.ip, token, style, comment, hash);

  if (!dm && framed)
    addPendingDuplicate(result.lastID, now, q.name, comment);

  await db.run('UPDATE participants SET last_post = ?1, last_active = ?1 WHERE name = ?2 and remote = 0', now, q.name);

  if (dmSession)
    await db.run('UPDATE dm_session SET last_post = ? WHERE id = ?', now, dmSession.id);

  const participant = await db.get<DbParticipant>('SELECT * FROM participants where name = ? AND remote = 0 LIMIT 1', q.name);

  if (participant)
    await db.run('UPDATE participants SET last_post = ?1, last_active = ?1 WHERE id = ?2', now, participant.id);

  if (!dm && !framed) {
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
  const id = toInt(q.msgId);
  const db = await getDb();
  const message = await db.get<DbMessage>('SELECT * FROM messages WHERE id = ? LIMIT 1', id);

  if (message && message.name === q.name &&
      ((message.trip && (message.trip === q.tripCode || message.trip === tripCode)) ||
        message.session_id !== getToken(req))) {
    if (message.dm) {
      const dmSession = await db.get<DbDmSession>('SELECT * FROM dm_session WHERE id = ?', message.dm);

      if (dmSession)
        message.message = decryptMessage(message.message, dmSession.key);
    }

    return message;
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
    const now = Math.floor(Date.now() / 1000);
    let bbCode = (q.bbCode as string).replace(URL_MATCHER, '[url=$1]$1[/url]');
    const dm = (await db.get<any>('SELECT dm FROM messages WHERE id = ?', id))?.dm as number;

    if (dm) {
      const dmSession = await db.get<DbDmSession>('SELECT * FROM dm_session WHERE id = ?', dm);

      if (dmSession)
        bbCode = encryptMessage(bbCode, dmSession.key);
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

  const participant = await getNamedParticipantRecord(name);

  if (!participant || !participant.allow_dm || !sessions.get(participant.session_id)?.inChat) {
    res.status(400).json({ error: `${name} is not available for direct messaging.` });
    return;
  }

  const db = await getDb();
  const dmSession = await db.get<DbDmSession>(`SELECT * FROM dm_session WHERE (name1 = ?1 AND name2 = ?2) OR
                                                 (name1 = ?2 AND name2 = ?1)`, name, self);
  if (dmSession) {
    const whichName = dmSession.name1 === self ? 'name1_present' : 'name2_present';

    await db.run(`UPDATE dm_session SET ${whichName} = 1 WHERE id = ?`, dmSession.id);
    res.json({ id: dmSession.id });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const encryptionKey = randomBytes(32).toString('base64');
  const result = await db.run('INSERT INTO dm_session (name1, name2, name1_present, key, start_time) VALUES (?, ?, 1, ?, ?)',
    self, name, encryptionKey, now);

  res.json({ id: result.lastID });
});

app.post('/api/leave-chat', async (req, res) => {
  const q = req.query as any;
  const self = q.self;
  const id = toInt(q.id);
  const db = await getDb();
  const dmSession = await db.get<DbDmSession>(`SELECT * FROM dm_session WHERE id = ?`, id);

  if (dmSession) {
    if (!toBoolean(q.viewed))
      await db.run('DELETE FROM dm_session WHERE id = ?', id);
    else {
      const whichName = dmSession.name1 === self ? 'name1_present' : 'name2_present';

      await db.run(`UPDATE dm_session SET ${whichName} = 0 WHERE id = ?`, id);
    }
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
