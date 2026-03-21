import { AsyncDatabase } from 'promised-sqlite3';


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
      "edit_count" INTEGER NOT NULL,
      "deleted" BOOLEAN NOT NULL,
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
