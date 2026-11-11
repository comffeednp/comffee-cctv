/**
 * Audit log writer. One row per action; never throws.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { FastifyRequest } from 'fastify';
import type { AuditEntry } from './contracts.ts';

const MAX_TEXT = 500;
const MAX_USER_AGENT = 300;

function clip(value: string | undefined | null, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return value.length > max ? value.slice(0, max) : value;
}

/** The ip and userAgent fields of an AuditEntry, taken from a request. */
export function requestMeta(req: FastifyRequest): { ip: string; userAgent: string | undefined } {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, userAgent: typeof ua === 'string' ? ua : undefined };
}

export function createAuditWriter(db: DatabaseSync, now: () => number = Date.now): (entry: AuditEntry) => void {
  const insert = db.prepare(
    'INSERT INTO audit_log (at, user_id, username, action, target, detail, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const lookup = db.prepare('SELECT username FROM users WHERE id = ?');
  return (entry: AuditEntry): void => {
    try {
      let username = entry.username;
      if (username === undefined && typeof entry.userId === 'number') {
        const row = lookup.get(entry.userId) as { username: string } | undefined;
        username = row?.username;
      }
      insert.run(
        now(),
        entry.userId ?? null,
        clip(username, 64),
        entry.action,
        clip(entry.target, 200),
        clip(entry.detail, MAX_TEXT),
        clip(entry.ip, 64),
        clip(entry.userAgent, MAX_USER_AGENT),
      );
    } catch (err) {
      console.error('audit write failed:', (err as Error).message);
    }
  };
}
