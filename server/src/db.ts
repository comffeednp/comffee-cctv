/**
 * Database open: PRAGMAs, SCHEMA_SQL and meta schema_version.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PRAGMAS_SQL, SCHEMA_SQL, SCHEMA_VERSION } from './contracts.ts';

/**
 * Extra guard on top of SCHEMA_SQL: at most one owner account can ever exist,
 * whatever code path tries to insert or update a user.
 */
const ONE_OWNER_INDEX_SQL = "CREATE UNIQUE INDEX IF NOT EXISTS users_single_owner ON users(role) WHERE role = 'owner';";

export function dbFile(dataDir: string): string {
  return path.join(dataDir, 'db.sqlite');
}

/** Opens (and creates or upgrades) the hub database. Pass ':memory:' for tests. */
export function openDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  try {
    db.exec(DB_PRAGMAS_SQL);
    db.exec(SCHEMA_SQL);
    db.exec(ONE_OWNER_INDEX_SQL);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (!row) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    } else if (Number(row.value) > SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${row.value} is newer than this hub supports (${SCHEMA_VERSION}). Update the hub.`,
      );
    } else if (Number(row.value) < SCHEMA_VERSION) {
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/** Runs fn inside BEGIN IMMEDIATE / COMMIT, rolling back on any error. fn must be synchronous. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction may already be gone.
    }
    throw err;
  }
}

/** True for a SQLite UNIQUE or PRIMARY KEY violation. */
export function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|PRIMARY KEY/i.test(msg);
}
