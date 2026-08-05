import axios from 'axios';
import { HtmlParser } from 'fortissimo-html';
import { DbMessage, MessageInfo } from './shared-types';
import { Now, parseChatTime } from './chat-util.js';
import { getDb } from './db.js';

const ADMIN_URL = process.env.CHAT_ADMIN_URL;
const ADMIN_PASSWORD = process.env.CHAT_ADMIN_PWD;
const IP_UPDATE_INTERVAL = 90000; // 90 seconds
const IP_UPDATE_BACKDATING = 7_200_000; // 2 hours

const parser = new HtmlParser();

export async function getLegacyPostData(): Promise<MessageInfo[]> {
  if (!ADMIN_URL || !ADMIN_PASSWORD)
    return [];

  const params = new URLSearchParams();
  const result: MessageInfo[] = [];

  params.append('pass', ADMIN_PASSWORD);
  params.append('mente_data', 'Select');

  try {
    const raw = (await axios.post(ADMIN_URL, params)).data;
    const dom = parser.parse(raw).domRoot;
    const rows = dom.querySelector('#adminMessageList').querySelectorAll('.adminMessageRow');

    for (const row of rows) {
      const dAndB = row.querySelectorAll('button').find(b => (b.getAttribute('name') || [])[1] === 'quick_delete_and_ban');
      const value = (dAndB?.getAttribute('value') || [])[1];
      const parts = value?.split('|') || [];
      const name = row.querySelector('b')?.textContent;
      const info: MessageInfo = {
        ip: parts[1],
        name,
        time: parseChatTime(parts[0])
      };

      result.push(info);
    }
  }
  catch (error) {
    console.error('Error fetching legacy admin data:', error);
  }

  return result;
}

let lastIpUpdate = 0;

export async function updateRemoteIps(allTime = false): Promise<void> {
  if (!ADMIN_URL || !ADMIN_PASSWORD)
    return;

  const now = Now();

  if (now < lastIpUpdate + IP_UPDATE_INTERVAL)
    return;

  try {
    const db = await getDb();
    const noIp = await db.all<DbMessage>('SELECT * FROM messages WHERE remote = 1 AND (ip IS NULL OR ip = \'\') AND time > ?',
      allTime || lastIpUpdate === 0 ? 0 : now - IP_UPDATE_BACKDATING);

    if (!noIp || noIp.length === 0)
      return;

    const infos = await getLegacyPostData();
    const map = new Map<string, MessageInfo>();

    for (const info of infos)
      map.set(`${info.name}\t${info.time}`, info);

    for (const message of noIp) {
      const info = map.get(`${message.name}\t${message.time}`);

      if (info)
        await db.run('UPDATE messages SET ip = ? WHERE id = ?', info.ip, message.id);
    }
  }
  catch (error) {
    console.error('Error fetching legacy admin data:', error);
  }

  lastIpUpdate = now;
}

export async function adminDeleteMessage(_name: string, time: number): Promise<void> {
  const params = new URLSearchParams();

  params.append('pass', ADMIN_PASSWORD);
  params.append('mente_data', '1');
  params.append('quick_delete_message',
    new Date(time * 1000).toISOString().substring(0, 19).replace(/-0/g, '-').replace(/-/g, '/').replace(/T/, '-'));

  await axios.post(ADMIN_URL, params);
}
