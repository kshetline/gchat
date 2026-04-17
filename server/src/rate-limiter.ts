import express from 'express';
import { getIp, getToken } from './chat-util.js';
import { clone } from '@tubular/util';
import { getDb } from './db.js';

export const TIME_WINDOW = 60; // seconds
const ALLOWED_GET_REQUESTS = 40;
const ALLOWED_REQUESTS = 12;
const LOCKOUT_TIME = 900; // 15 minutes
const LOCKOUT_TIME_GET = 60; // 1 minute

interface Identifiers {
  ip: string;
  token: string;
  name: string;
  email: string;
}

const accessTimes: Record<string, { ids: Identifiers; time: number }[]> = {
  ip: [],
  token: [],
  name: [],
  email: []
};
const getAccessTimes = clone(accessTimes);
const legacyAccessTimes = clone(accessTimes);
const lockouts: Record<string, number> = {};

export function tallyForLockout(now: number, isGet: boolean, ip: string, token: string,
                                name: string, email: string, legacy = false): [Identifiers, boolean, boolean] {
  const ids = { ip, token, name, email };
  const times = isGet ? getAccessTimes : legacy ? legacyAccessTimes : accessTimes;
  const limit = isGet ? ALLOWED_GET_REQUESTS : ALLOWED_REQUESTS;
  const lockoutTime = isGet ? LOCKOUT_TIME_GET : LOCKOUT_TIME;

  for (const key in ids)
    times[key].push({ ids, time: now });

  for (const key in times)
    times[key] = times[key].filter(entry => now - entry.time < TIME_WINDOW);

  const counts = Object.keys(times).map(key => ({ key, count: times[key]
    .reduce((count, entry) => count + ((entry.ids as any)[key] &&
    (entry.ids as any)[key] === (ids as any)[key] ? 1 : 0), 0) }));
  let shouldLockout = false;
  let wasLockedOut = false;

  for (const { key, count } of counts) {
    const lockKey = `${key};${+isGet};${(ids as any)[key]}`;

    if (count >= limit) {
      shouldLockout = true;
      wasLockedOut = !lockouts[lockKey];
      lockouts[lockKey] = now;
    }
    else if (lockouts[lockKey] && now - lockouts[lockKey] < lockoutTime)
      shouldLockout = true;
  }

  for (const key in lockouts)
    if (now - lockouts[key] > lockoutTime)
      delete lockouts[key];

  return [ids, shouldLockout, wasLockedOut];
}

export const rateLimiter = async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
  const isGetRequest = req.method === 'GET';
  const now = Date.now() / 1000;
  const [ids, shouldLockout, wasLockedOut] = tallyForLockout(now, isGetRequest, getIp(req), getToken(req),
    req.query.name || req.body?.name, req.query.email as string);

  if (shouldLockout) {
    if (!wasLockedOut) {
      console.warn(`Rate limit exceeded for ${ids.ip} (${ids.name || ids.email})`);

      if (!isGetRequest) {
        try {
          await (await getDb()).run(
            'UPDATE messages SET deleted = 1, spam = 1 WHERE ip = ? OR name = ? OR session_id = ? OR email = ?',
            ids.ip, ids.name, ids.token, ids.email);
        }
        catch {}
      }
    }

    res.status(429).send('Too many requests');
    return;
  }

  next();
};

export function clearLegacyAccessTimes(): void {
  legacyAccessTimes.ip = [];
  legacyAccessTimes.token = [];
  legacyAccessTimes.name = [];
  legacyAccessTimes.email = [];
}
