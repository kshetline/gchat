import { AsyncDatabase } from 'promised-sqlite3';
import { DbParticipant } from './shared-types.js';

let db: AsyncDatabase;

export async function getDb(): Promise<AsyncDatabase> {
  if (db)
    return db;

  db = await AsyncDatabase.open(process.env.CHAT_DB_PATH || 'chat.sqlite');

  await db.exec(
    `CREATE TABLE IF NOT EXISTS "messages" (
      "id" INTEGER NOT NULL UNIQUE,
      "time" INTEGER NOT NULL DEFAULT 0,
      "synced_time" INTEGER NOT NULL DEFAULT 0,
      "name" TEXT NOT NULL,
      "trip" TEXT,
      "email" TEXT,
      "remote" INTEGER NOT NULL,
      "ip" TEXT,
      "session_id" TEXT,
      "style" TEXT,
      "message" TEXT NOT NULL,
      "hash" TEXT NOT NULL,
      "edit_count" INTEGER NOT NULL DEFAULT 0,
      "deleted" INTEGER NOT NULL DEFAULT 0,
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
      "remote" INTEGER NOT NULL,
      "last_active" INTEGER NOT NULL DEFAULT 0,
      "last_post" INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY("id" AUTOINCREMENT)
    )`);

  return db;
}

export async function getNamedParticipantRecord(name: string): Promise<DbParticipant> {
  const db = await getDb();

  return await db.get<DbParticipant>(`SELECT * FROM participants where name = ? ORDER BY last_active DESC LIMIT 1`, name);
}
