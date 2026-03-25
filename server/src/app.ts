import cookieParser from 'cookie-parser';
import express from 'express';
import session from 'express-session';
import { colors, Config, DbMessage, DbParticipant, Message, ParticipantInfo } from './shared-types.js';
import { checksum53, isEqual, processMillis, toBoolean, toInt } from '@tubular/util';
import { uploadSingle } from './uploader.js';
import { SessionInfo } from './session-info';
import { enterLegacyChat, legacySendMessage } from './legacy.js';
import { convertBBCodeToHtml, getDb } from './db.js';
import ip_ from 'ip';
import axios from 'axios';

const app = express();
const port = toInt(process.env.HTTP_PORT) || 3000;
const sessions = new Map<string, SessionInfo>();
const proxyName = process.env.CHAT_PROXY;
const config: Config = {
  backgroundColor: process.env.CHAT_BACKGROUND || '#DDD',
  fileSizeLimitInMb: toInt(process.env.UPLOAD_MAX_SIZE_MB),
  navigation: process.env.NAV_LINKS.split(';').map(link => link.split('::'))
    .map(link => ({ name: link[0], url: link[1], target: link[2] || '_blank' })),
  title: process.env.CHAT_TITLE,
};
const URL_MATCHER = /\b(https?:\/\/[-A-Za-z0-9+&@#/%?=~_()|!:,.;]*[-A-Za-z0-9+&@#/%=~_()|])/g;

let proxyStarted = false;
let lastContentUpdate = 0;
let lastMessages: Message[] = null;

function getIp(req: express.Request): string {
  return req.ip || req.socket?.remoteAddress || (req as any).connection?.remoteAddress || (req as any).connection?.socket?.remoteAddress;
}

let serverIp: string;
const IP_MATCHER = /(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)/;

async function getServerIp(): Promise<string> {
  if (!serverIp)
    serverIp = (IP_MATCHER.exec((await axios.get(process.env.GET_IP_SERVICE)).data) || [])[0] || '127.0.0.1';

  return serverIp;
}

app.use(session({
  secret: process.env.SESSION_KEY,
  resave: true,
  saveUninitialized: true,
  cookie: { secure: toBoolean(process.env.SESSION_SECURE) }
}));

app.use(async (req, _res, next) => {
  let session = sessions.get(req.sessionID);
  const ip = getIp(req);

  if (!session) {
    session = ({ ip: ip_.isPrivate(ip) ? await getServerIp() : ip, inChat: false } as SessionInfo);
    sessions.set(req.sessionID, session);
  }

  next();
});

app.use(cookieParser());

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

app.get('/api/config', (_req, res) => {
  res.json(config);
});

async function getNamedParticipantRecord(name: string): Promise<DbParticipant> {
  const db = await getDb();
  let participant = await db.get<DbParticipant>('SELECT * FROM participants where name = ? AND remote = 0 LIMIT 1', name);

  if (!participant)
    participant = await db.get<DbParticipant>('SELECT * FROM participants where name = ? LIMIT 1', name);

  return participant;
}

app.get('/api/messages', async (req, res) => {
  const session = sessions.get(req.sessionID);
  const db = await getDb();
  const rows = (await db.all<DbMessage>('SELECT * FROM messages ORDER BY messages.synced_time')).slice(-1000);
  let messages = rows.filter(row => !row.deleted).map(row => ({
    email: row.email,
    hash: row.hash,
    html: convertBBCodeToHtml(row.message),
    msgId: row.id,
    name: row.name,
    remote: !!row.remote,
    style: row.style,
    time: row.synced_time,
    trip: row.remote ? row.trip : Buffer.from(checksum53(row.trip), 'hex').toString('base64').replace(/=+$/, '')
  } as Message));

  const name = req.query.name as string;
  const active = toBoolean(req.query.active);
  const force = toBoolean(req.query.force);
  const now = Math.floor(Date.now() / 1000);
  const hourAgo = now - 3600;
  let participant = await getNamedParticipantRecord(name);

  if (participant && active)
    await db.run('UPDATE participants SET last_active = ?, remote = 0 WHERE id = ?', now, participant.id);

  const participantNames = (await db.all<DbParticipant>('SELECT * FROM participants'))
    .filter(row => row.last_active > hourAgo || row.last_post > hourAgo).map(row => row.name);
  const participants = [...new Set(participantNames)].sort().map(p => ({ name: p } as ParticipantInfo));

  for (const participantInfo of participants) {
    const participant = await getNamedParticipantRecord(participantInfo.name);

    if (participant)
      participantInfo.idle = now - participant.last_active > (participant.remote ? 1800 : 600) ? 1 : 0;
  }

  if (!isEqual(lastMessages, messages)) {
    lastMessages = messages;
    lastContentUpdate = processMillis();
  }

  if (force || (session && session.lastContentUpdate !== lastContentUpdate))
    session.lastContentUpdate = lastContentUpdate;
  else
    messages = [null];

  res.json({ messages, participants });
});

app.post('/api/enter', async (req, res) => {
  const q = req.query as any;
  const session = sessions.get(req.sessionID);
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  const participant = await db.get<DbParticipant>('SELECT * FROM participants where name = ? AND remote = 0 LIMIT 1', q.name);

  if (!participant) {
    await db.run('INSERT INTO participants (name, trip, email, ip, session_id, remote, last_active, last_post) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      q.name, q.tripCode, q.email, session.ip, req.sessionID, 0, now, 0);
    session.inChat = true;
  }
  else if (q.tripCode === participant.trip || session.ip === participant.ip || req.sessionID === participant.session_id) {
    await db.run('UPDATE participants SET trip = ?, email = ?, ip = ?, session_id = ?, remote = ?, last_active = ? WHERE id = ?',
      q.tripCode, q.email, session.ip, req.sessionID, 0, now, participant.id);
    session.inChat = true;
    await db.run('DELETE FROM participants WHERE name = ? AND remote = 1', q.name);
  }
  else {
    res.status(400).json({
      error: `Chat name '${q.name}' is already in use by another user.`
    });

    return;
  }

  res.send('null');
});

app.post('/api/leave', async (req, res) => {
  const q = req.query as any;
  const session = sessions.get(q.sessionID);

  if (!session?.inChat) {
    res.send('null');
    return;
  }

  const db = await getDb();
  const participant = await db.get<DbParticipant>('SELECT * FROM participants where name = ? LIMIT 1', q.name);

  if (participant && (q.tripCode === participant.trip || session.ip === participant.ip || q.sessionID === participant.session_id)) {
    await db.run('DELETE FROM participants WHERE id = ?', participant.id);
    session.inChat = false;
  }

  res.send('null');
});

app.post('/api/send', async (req, res) => {
  const session = sessions.get(req.sessionID);
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  const q = req.query as any;
  const style = `color:${colors[q.color].trim()}`;
  const comment = q.comment.replace(URL_MATCHER, '[url=$1]$1[/url]');
  const hash = checksum53(`${q.name};${q.tripCode || ''};${new Date(now * 1000).toISOString().substring(0, 19)}`);

  await db.run('INSERT INTO messages (time, synced_time, name, trip, email, remote, ip, session_id, style, message, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    now, now, q.name, q.tripCode, q.email, 0, session.ip, req.sessionID, style, comment, hash);
  await db.run('UPDATE participants SET last_post = ?1, last_active = ?1 WHERE name = ?2 and remote = 0', now, q.name);

  const participant = await db.get<DbParticipant>('SELECT * FROM participants where name = ? AND remote = 0 LIMIT 1', q.name);

  if (participant)
    await db.run('UPDATE participants SET last_post = ?1, last_active = ?1 WHERE id = ?2', now, participant.id);

  if (!proxyStarted) {
    await enterLegacyChat(proxyName, null, 0);
    proxyStarted = true;
  }

  await legacySendMessage(q.name, null, q.comment, q.color, q.trip);
  res.send('null');
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
