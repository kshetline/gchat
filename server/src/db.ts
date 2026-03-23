import { AsyncDatabase } from 'promised-sqlite3';
import { htmlEscape } from '@tubular/util';

let db: AsyncDatabase;

export async function getDb(): Promise<AsyncDatabase> {
  if (db)
    return db;

  db = await AsyncDatabase.open(process.env.CHAT_DB_PATH || 'db.sqlite');

  await db.exec(
    `CREATE TABLE IF NOT EXISTS "messages" (
      "id" INTEGER NOT NULL UNIQUE,
      "time" DATETIME NOT NULL,
      "name" TEXT NOT NULL,
      "trip" TEXT,
      "email" TEXT,
      "remote" BOOLEAN NOT NULL,
      "ip" TEXT,
      "session_id" TEXT,
      "message" TEXT NOT NULL,
      "hash" TEXT NOT NULL,
      "edit_count" INTEGER NOT NULL DEFAULT 0,
      "deleted" BOOLEAN NOT NULL DEFAULT 0,
      PRIMARY KEY("id" AUTOINCREMENT)
    )`);

  await db.exec(
    `CREATE TABLE IF NOT EXISTS "participants" (
      "id" INTEGER NOT NULL UNIQUE,
      "name" TEXT NOT NULL,
      "trip" TEXT,
      "email" TEXT,
      "ip" TEXT,
      "session_id" TEXT,
      "remote" boolean NOT NULL,
      "last_active" datetime,
      "last_post" datetime,
      PRIMARY KEY("id" AUTOINCREMENT)
    )`);

  return db;
}

export function convertBBCodeToHtml(text: string): string {
  text = text.replace(/\[(\/?)(b|code|i|img|s|s1|s2|s3|s4|s5|u|url=.*?|url)]/g, '<$1$2>')
    .replace(/<s(\d)>/g, '<span class="fontSize$1">').replace(/<\/s\d>/g, '</span>')
    .replace(/<url=(.*?)>(.*?)<\/url>/g,  (_$0, $1, $2) => `<a href="${$1}">${$2}</a>`)
    .replace(/<img>(.*?)<\/img>/g, '<img src="$1" alt="">')
    .replace(/(^|>)(.*?)(<|$)/g, (_$0, $1, $2, $3) => `${$1}${htmlEscape($2)}${$3}`);

  return text;
}
