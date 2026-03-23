import cookieParser from 'cookie-parser';
import express from 'express';
import session from 'express-session';
import { Config, DbMessage, DbParticipant, Message } from './shared-types.js';
import { toBoolean, toInt } from '@tubular/util';
import { uploadSingle } from './uploader.js';
import { SessionInfo } from './session-info';
import { legacyBrowserSetup, legacySendMessage } from './legacy.js';
import { convertBBCodeToHtml, getDb } from './db.js';
import ip_ from 'ip';
import axios from 'axios';

const app = express();
const port = toInt(process.env.HTTP_PORT) || 3000;
const sessions = new Map<string, SessionInfo>();
const config: Config = {
  backgroundColor: process.env.CHAT_BACKGROUND || '#DDD',
  fileSizeLimitInMb: toInt(process.env.UPLOAD_MAX_SIZE_MB),
  navigation: process.env.NAV_LINKS.split(';').map(link => link.split('::'))
    .map(link => ({ name: link[0], url: link[1], target: link[2] || '_blank' })),
  title: process.env.CHAT_TITLE,
};

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
    session = await legacyBrowserSetup();
    session.ip = ip_.isPrivate(ip) ? await getServerIp() : ip;
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

app.get('/api/messages', async (_req, res) => {
  const db = await getDb();
  const rows = (await db.all<DbMessage>('SELECT * FROM messages ORDER BY time')).slice(-1000);
  const messages = rows.filter(row => !row.deleted).map(row => ({
    email: row.email,
    hash: row.hash,
    html: convertBBCodeToHtml(row.message),
    msgId: row.id,
    name: row.name,
    remote: !!row.remote,
    style: row.style,
    timestamp: row.time,
    trip: row.trip
  } as Message));

  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const participants = Array.from(new Set((await db.all<DbParticipant>('SELECT * FROM participants'))
    .filter(row => row.last_active > hourAgo || row.last_post > hourAgo).map(row => row.name)).values()).sort();

  res.json({ messages, participants });
});

app.post('/api/enter', async (req, res) => {
  const q = req.query as any;
  const session = sessions.get(req.sessionID);

  if (session?.inChat) {
    res.send('null');
    return;
  }

  const db = await getDb();
  const participant = await db.get<DbParticipant>('SELECT * FROM participants where name = ? AND remote = 0 LIMIT 1', q.name);
  const now = new Date().toISOString();

  if (!participant) {
    await db.run('INSERT INTO participants (name, trip, email, ip, session_id, remote, last_active, last_post) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      q.name, q.tripCode, q.email, session.ip, q.sessionID, 0, now, 0);
    session.inChat = true;
  }
  else if (q.tripCode === participant.trip || session.ip === participant.ip || q.sessionID === participant.session_id) {
    await db.run('UPDATE participants SET trip = ?, email = ?, ip = ?, session_id = ?, remote = ?, last_active = ? WHERE id = ?',
      q.tripCode, q.email, session.ip, q.sessionID, 0, now, participant.id);
    session.inChat = true;
    await db.run('DELETE FROM participants WHERE name = ? AND remote = 0', q.name);
  }
  else {
    res.status(400).json({
      error: new Error(`Chat name '${q.name}' is already in use by another user.`)
    });
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
  const q = req.query as any;

  await legacySendMessage(sessions.get(req.sessionID), q.name, q.email, q.comment, q.color, q.tripCode);
  res.send('null');
});

app.post('/api/upload', async (req, res) => {
  let session = sessions.get(req.sessionID);

  try {
    const url = await uploadSingle(session, req, res);

    res.json({ url });
  }
  catch (error) {
    console.error('Upload error:', error);
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Upload failed'
    });
  }
});
