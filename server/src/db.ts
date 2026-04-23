import { AsyncDatabase } from 'promised-sqlite3';
import { DbParticipant } from './shared-types.js';
import mysql from 'mysql2/promise';
import { AsyncDatabaseWrapperForMySQL } from './mysql-wrapper.js';
import { isShuttingDown } from './app.js';

let db: AsyncDatabase;
let inInit = false;

export async function getDb(): Promise<AsyncDatabase> {
  if (db)
    return db;
  else if (inInit) return new Promise<AsyncDatabase>(resolve => {
    const interval = setInterval(() => {
      if (!inInit || isShuttingDown()) {
        clearInterval(interval);
        resolve(db);
      }
    }, 100);
  });

  inInit = true;

  let forMySQL = false;

  if (process.env.MYSQL_HOST) {
    forMySQL = true;

    const connection = await mysql.createConnection({
      host: process.env.MYSQL_HOST,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DB
    });

    db = new AsyncDatabaseWrapperForMySQL(connection);
  }
  else
    db = await AsyncDatabase.open(process.env.CHAT_DB_PATH || 'chat.sqlite');

  const modifyIfNeeded = forMySQL ?
    (sql: string) => sql.replace(/\bUNIQUE PRIMARY KEY AUTOINCREMENT\b/g, 'AUTO_INCREMENT PRIMARY KEY')
      + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci' :
    (sql: string) => sql;

  await db.exec(modifyIfNeeded(
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT,
      dm INTEGER NOT NULL DEFAULT 0,
      time INTEGER NOT NULL DEFAULT 0,
      synced_time INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      trip TEXT,
      email TEXT,
      remote BOOLEAN NOT NULL,
      ip TEXT,
      session_id TEXT,
      style TEXT,
      message TEXT NOT NULL,
      hash TEXT NOT NULL,
      edit_count INTEGER NOT NULL DEFAULT 0,
      deleted BOOLEAN NOT NULL DEFAULT 0,
      spam BOOLEAN NOT NULL DEFAULT 0,
      flagged BOOLEAN NOT NULL DEFAULT 0
    )`));

  await db.exec(modifyIfNeeded(
    `CREATE TABLE IF NOT EXISTS participants (
      id INTEGER NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      trip TEXT,
      email TEXT,
      ip TEXT,
      session_id TEXT,
      remote BOOLEAN NOT NULL,
      proxied BOOLEAN NOT NULL DEFAULT 0,
      last_active INTEGER NOT NULL DEFAULT 0,
      last_post INTEGER NOT NULL DEFAULT 0,
      allow_dm  BOOLEAN NOT NULL DEFAULT 0
    )`));

  await db.exec(modifyIfNeeded(
    `CREATE TABLE IF NOT EXISTS dm_session (
      id INTEGER NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT,
      ekey TEXT NOT NULL,
      name1 TEXT NOT NULL,
      name1_present INTEGER NOT NULL DEFAULT 0,
      name2 TEXT NOT NULL,
      name2_present INTEGER NOT NULL DEFAULT 0,
      start_time INTEGER NOT NULL,
      last_post INTEGER NOT NULL DEFAULT 0
  )`));

  inInit = false;

  return db;
}

export async function getNamedParticipantRecord(name: string): Promise<DbParticipant> {
  const db = await getDb();

  return await db.get<DbParticipant>(`SELECT * FROM participants where name = ? ORDER BY last_active DESC LIMIT 1`, name);
}
