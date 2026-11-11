/**
 * Failure throttling.
 *
 * Per IP (table ip_failures):
 *   login   20 failures within 15 min -> blocked 15 min (password and 2-step code failures)
 *   setup   10 failures within 1 h    -> blocked 1 h
 *   bridge  10 failures within 15 min -> blocked 15 min
 * Per typed username (rows in ip_failures keyed on a hash of the lowercased name), counted the same
 * whether or not the account exists, so the answers never show which usernames are real:
 *   login-pair  5 password failures for one name from one IP within 15 min  -> that pair blocked 15 min
 *   login-name  100 password failures for one name from all IPs within 15 min -> that name blocked 15 min
 * Per user (users.failed_count / first_failed_at / locked_until), only after the password was right
 * (wrong 2-step codes) or for password re-checks of a signed-in user:
 *   5 failures within 15 min -> locked 15 min
 */

import type { DatabaseSync } from 'node:sqlite';
import type { IpFailureKind } from '../contracts.ts';
import { sha256Hex } from './tokens.ts';

const MIN = 60_000;

interface Limit {
  max: number;
  windowMs: number;
  blockMs: number;
}

export const IP_LIMITS: Record<IpFailureKind, Limit> = {
  login: { max: 20, windowMs: 15 * MIN, blockMs: 15 * MIN },
  setup: { max: 10, windowMs: 60 * MIN, blockMs: 60 * MIN },
  bridge: { max: 10, windowMs: 15 * MIN, blockMs: 15 * MIN },
};

/** Per-username sign-in limits. The all-IP cap is high so that one network cannot lock an account out everywhere. */
export const NAME_LIMITS: Record<'pair' | 'name', Limit> = {
  pair: { max: 5, windowMs: 15 * MIN, blockMs: 15 * MIN },
  name: { max: 100, windowMs: 15 * MIN, blockMs: 15 * MIN },
};
const PAIR_KIND = 'login-pair';
const NAME_KIND = 'login-name';

export const USER_MAX_FAILURES = 5;
export const USER_FAILURE_WINDOW_MS = 15 * MIN;
export const USER_LOCK_MS = 15 * MIN;

function recordFailureRow(db: DatabaseSync, key: string, kind: string, now: number): number {
  return Number(db.prepare('INSERT INTO ip_failures (ip, kind, at) VALUES (?, ?, ?)').run(key, kind, now).lastInsertRowid);
}

/** Records one failure for an IP; returns the row id. */
export function recordIpFailure(db: DatabaseSync, ip: string, kind: IpFailureKind, now: number = Date.now()): number {
  return recordFailureRow(db, ip, kind, now);
}

function blockedUntil(db: DatabaseSync, key: string, kind: string, limit: Limit, now: number): number {
  const { max, windowMs, blockMs } = limit;
  const rows = db
    .prepare('SELECT at FROM ip_failures WHERE ip = ? AND kind = ? AND at > ? ORDER BY at ASC')
    .all(key, kind, now - windowMs - blockMs) as { at: number }[];
  let until = 0;
  for (let i = max - 1; i < rows.length; i++) {
    const end = rows[i].at;
    if (end - rows[i - max + 1].at < windowMs && end + blockMs > now) until = Math.max(until, end + blockMs);
  }
  return until;
}

/**
 * Returns the unix ms until which the IP is blocked for this kind, or 0 when it is not.
 * A block starts at the failure that completes `max` failures within the window and lasts blockMs.
 */
export function ipBlockedUntil(db: DatabaseSync, ip: string, kind: IpFailureKind, now: number = Date.now()): number {
  return blockedUntil(db, ip, kind, IP_LIMITS[kind], now);
}

export function isIpBlocked(db: DatabaseSync, ip: string, kind: IpFailureKind, now: number = Date.now()): boolean {
  return ipBlockedUntil(db, ip, kind, now) > now;
}

/** The throttle key of a typed username: a hash, so mistyped passwords in the name field are never stored. */
export function loginNameKey(username: string): string {
  return sha256Hex('login-name:' + username.toLowerCase());
}

function pairKey(nameKey: string, ip: string): string {
  return nameKey + '|' + ip;
}

/** True while this username is blocked for this IP, or for every IP. */
export function isLoginNameBlocked(db: DatabaseSync, nameKey: string, ip: string, now: number = Date.now()): boolean {
  return (
    blockedUntil(db, pairKey(nameKey, ip), PAIR_KIND, NAME_LIMITS.pair, now) > now ||
    blockedUntil(db, nameKey, NAME_KIND, NAME_LIMITS.name, now) > now
  );
}

/**
 * Counts one password try as a failure for the IP, the (name, IP) pair and the name. Called before the
 * slow password check so that parallel tries cannot all pass the limits; returns the row ids so that a
 * right password can take the try back with forgetLoginFailure.
 */
export function recordLoginFailure(db: DatabaseSync, ip: string, nameKey: string, now: number = Date.now()): number[] {
  return [
    recordFailureRow(db, ip, 'login', now),
    recordFailureRow(db, pairKey(nameKey, ip), PAIR_KIND, now),
    recordFailureRow(db, nameKey, NAME_KIND, now),
  ];
}

export function forgetLoginFailure(db: DatabaseSync, rowIds: number[]): void {
  const del = db.prepare('DELETE FROM ip_failures WHERE rowid = ?');
  for (const id of rowIds) del.run(id);
}

/** Clears the (name, IP) pair count after a full sign-in. */
export function clearLoginPairFailures(db: DatabaseSync, nameKey: string, ip: string): void {
  db.prepare('DELETE FROM ip_failures WHERE ip = ? AND kind = ?').run(pairKey(nameKey, ip), PAIR_KIND);
}

/** Counts one failure for a user; locks the account after USER_MAX_FAILURES within the window. */
export function recordUserFailure(db: DatabaseSync, userId: number, now: number = Date.now()): void {
  const row = db.prepare('SELECT failed_count, first_failed_at FROM users WHERE id = ?').get(userId) as
    | { failed_count: number; first_failed_at: number }
    | undefined;
  if (!row) return;
  const fresh = row.first_failed_at === 0 || now - row.first_failed_at >= USER_FAILURE_WINDOW_MS;
  const count = fresh ? 1 : row.failed_count + 1;
  const first = fresh ? now : row.first_failed_at;
  if (count >= USER_MAX_FAILURES) {
    db.prepare('UPDATE users SET failed_count = 0, first_failed_at = 0, locked_until = ? WHERE id = ?').run(
      now + USER_LOCK_MS,
      userId,
    );
  } else {
    db.prepare('UPDATE users SET failed_count = ?, first_failed_at = ? WHERE id = ?').run(count, first, userId);
  }
}

export function clearUserFailures(db: DatabaseSync, userId: number): void {
  db.prepare('UPDATE users SET failed_count = 0, first_failed_at = 0, locked_until = 0 WHERE id = ?').run(userId);
}

export function isUserLocked(lockedUntil: number, now: number = Date.now()): boolean {
  return lockedUntil > now;
}

/** Deletes failure rows too old to matter for any kind. */
export function pruneIpFailures(db: DatabaseSync, now: number = Date.now()): void {
  const keep = Math.max(...[...Object.values(IP_LIMITS), ...Object.values(NAME_LIMITS)].map((l) => l.windowMs + l.blockMs));
  db.prepare('DELETE FROM ip_failures WHERE at < ?').run(now - keep);
}
