import cookieParser from 'cookie-parser';
import express from 'express';
import session from 'express-session';
import { Config } from './shared-types.js';
import { toBoolean, toInt } from '@tubular/util';
import { uploadSingle } from './uploader.js';
import { SessionInfo } from './session-info';
import { enterLegacyChat, getLegacyMessages, leaveLegacyChat, legacyBrowserSetup, legacySendMessage } from './legacy.js';

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

app.use(session({
  secret: process.env.SESSION_KEY,
  resave: true,
  saveUninitialized: true,
  cookie: { secure: toBoolean(process.env.SESSION_SECURE) }
}));

app.use(async (req, _res, next) => {
  let session = sessions.get(req.sessionID);

  if (!session) {
    session = await legacyBrowserSetup();
    sessions.set(req.sessionID, session);
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
  res.json(await getLegacyMessages(req.query.name as string));
});

app.post('/api/enter', async (req, res) => {
  const q = req.query as any;

  await enterLegacyChat(sessions.get(req.sessionID), q.name, q.email, q.color);
  res.send('null');
});

app.post('/api/leave', async (req, res) => {
  await leaveLegacyChat(sessions.get(req.sessionID));
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
