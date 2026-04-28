import express from 'express';
import { getIp, getToken, Now } from './chat-util.js';
import { clone } from '@tubular/util';
import { getDb, getKeyValue } from './db.js';
import tripcode from 'tripcode';
import ip_ from 'ip';

export const TIME_WINDOW = 120; // seconds

const ALLOWED_GET_REQUESTS = 80;
const ALLOWED_REQUESTS = 24;
const LOCKOUT_TIME = 900; // 15 minutes
const LOCKOUT_TIME_GET = 60; // 1 minute

interface Identifiers {
  ip: string;
  token: string;
  name: string;
  email: string;
}

interface IpEntry {
  ip: string;
  expiry: number;
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
let cachedSpamPattern: RegExp;

async function getSpamPattern(): Promise<RegExp> {
  if (cachedSpamPattern) return cachedSpamPattern;

  try {
    cachedSpamPattern = new RegExp(await getKeyValue('spamPattern'));
    setTimeout(() => cachedSpamPattern = null, 10000);

    return cachedSpamPattern;
  }
  catch (e) {
    console.error('Failed to get spam pattern', e);
  }

  return null;
}

let cachedBannedNames: string;
let bannedNames: Map<string, string>;

// The list of banned names consists of a semicolon-separated list of screen names, with or without tripcodes.
//
// When a tripcode is present, it's in the encoded form for a tripcode and is separated from the name with a bullet
// character (•), followed by a plus or minus sign.
//
// name (by itself): Blocks any use of this screen name, regardless of tripcode.
// name•+tripcode: Blocks this name/tripcode combination.
// name•-tripcode: Blocks this name unless it is accompanied by the specific tripcode (good for banning an imposter).
//
// If the regexes below seem overly complex, it's because they allow for the special characters ';' and '•' to be
// escaped with backslashes.
//
const splitNames = (s: string) => s.match(/(?:[^;\\]|\\.)+/g).map(s => s.replace(/\\([^•])/g, '$1'));
const splitNameTrip = (s: string) => s.match(/(?:[^•\\]|\\.)+/g).map(s => s.replace(/\\(.)/g, '$1'));

export async function isBannedName(name: string, trip: string): Promise<boolean> {
  let bannedNameStr = cachedBannedNames;

  if (!bannedNameStr) {
    try {
      bannedNameStr = cachedBannedNames = await getKeyValue('bannedNames') || '';
      bannedNames = splitNames(bannedNameStr).map(n => splitNameTrip(n)).reduce((map, [n, t]) => n && map.set(n, t || ''), new Map());
      setTimeout(() => cachedBannedNames = null, 10000);
    }
    catch (e) {
      console.error('Failed to get banned names list', e);
    }
  }

  if (!bannedNameStr)
    return false;

  let bTrip = bannedNames.get(name);

  return bTrip != null && (!bTrip || '+' + trip === bTrip || (bTrip.startsWith('-') === (trip !== bTrip.slice(1))));
}

let cachedBannedIps: IpEntry[];

export async function isBannedIp(ip: string): Promise<boolean> {
  let bannedIps = cachedBannedIps;

  if (!bannedIps) {
    try {
      const db = await getDb();
      bannedIps = (await db.all<any>('SELECT ip, expiry FROM banned_ips'))
        .map(ipEntry => ({ ip: ipEntry.ip, expiry: ipEntry.expiry ? new Date(ipEntry.expiry).getTime() : null }));
      cachedBannedIps = bannedIps;
      setTimeout(() => cachedBannedIps = null, 10000);
    }
    catch (e) {
      console.error('Failed to get banned IP list', e);
    }
  }

  if (bannedIps) {
    const now = Date.now();

    return (bannedIps.some(ipEntry =>
      (ip.includes('/') ? ip_.cidrSubnet(ipEntry.ip).contains(ip) : ipEntry.ip === ip)
      && (!ipEntry.expiry || ipEntry.expiry > now)));
  }

  return false;
}

export async function tallyForLockout(now: number, isGet: boolean, ip: string, token: string, name: string,
    tripcode: string, email: string, comment: string, legacy = false): Promise<[Identifiers, boolean, boolean]> {
  const ids = { ip, token, name, email };
  const times = isGet ? getAccessTimes : legacy ? legacyAccessTimes : accessTimes;
  const limit = isGet ? ALLOWED_GET_REQUESTS : ALLOWED_REQUESTS;
  const lockoutTime = isGet ? LOCKOUT_TIME_GET : LOCKOUT_TIME;
  const spamPattern = await getSpamPattern();
  let spammish = spamPattern && (spamPattern.test(comment) || spamPattern.test(name));

  if (spammish) {
    const parts = comment?.split(/⏴|◁|◀︎| < /);

    if (parts?.length === 2)
      spammish = spamPattern.test(parts[1]) || spamPattern.test(name);
  }

  // Spammish comments count triple
  for (let i = 0; i < (spammish ? 3 : 1); ++i) {
    for (const key in ids)
      times[key].push({ ids, time: now + i / 10 });
  }

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

  shouldLockout ||= await isBannedName(name, tripcode) || await isBannedIp(ip);

  for (const key in lockouts)
    if (now - lockouts[key] > lockoutTime)
      delete lockouts[key];

  return [ids, shouldLockout, wasLockedOut];
}

export const intrusionDetector = async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
  const isGetRequest = req.method === 'GET';
  const now = Now();
  const q = req.query as Record<string, string> || {};
  const [ids, shouldLockout, wasLockedOut] = await tallyForLockout(now, isGetRequest, getIp(req), getToken(req),
    q.name || req.body?.name, q.tripCode && tripcode(q.tripCode), q.email, q.message);

  if (shouldLockout) {
    if (!wasLockedOut) {
      console.warn(`Rate limit exceeded for ${ids.ip} (${ids.name || ids.email})`);

      if (!isGetRequest) {
        try {
          await (await getDb()).run(
            `UPDATE messages SET deleted = 1, spam = 1
                WHERE synced_time > ? AND (ip = ? OR name = ? OR session_id = ? OR email = ?)`,
            now - TIME_WINDOW * 2, ids.ip, ids.name, ids.token, ids.email);
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
