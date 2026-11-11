/**
 * User rows and their API shapes (Me, UserSummary).
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Me, Role, UserSummary } from '../../../shared/api-types.ts';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  totp_secret_enc: string | null;
  totp_enabled: number;
  totp_last_step: number;
  disabled: number;
  failed_count: number;
  first_failed_at: number;
  locked_until: number;
  created_at: number;
  password_changed_at: number;
}

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{2,63}$/;

/** Null when the username is acceptable, otherwise a plain message. */
export function usernameProblem(username: unknown): string | null {
  if (typeof username !== 'string' || username === '') return 'Username is required';
  if (!USERNAME_RE.test(username)) {
    return 'Username must be 3 to 64 characters: letters, digits, dot, dash, underscore or @, starting with a letter or digit';
  }
  return null;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function getUserById(db: DatabaseSync, id: number): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

/** Case-insensitive (users.username is COLLATE NOCASE). */
export function getUserByName(db: DatabaseSync, username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
}

export function ownerExists(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM users WHERE role = 'owner'").get();
}

export function userLocationIds(db: DatabaseSync, userId: number): number[] {
  const rows = db
    .prepare('SELECT location_id FROM user_locations WHERE user_id = ? ORDER BY location_id')
    .all(userId) as { location_id: number }[];
  return rows.map((r) => r.location_id);
}

export function locationIdsOf(db: DatabaseSync, row: UserRow): number[] | 'all' {
  return row.role === 'owner' ? 'all' : userLocationIds(db, row.id);
}

export function toMe(db: DatabaseSync, row: UserRow): Me {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    locationIds: locationIdsOf(db, row),
    totpEnabled: row.totp_enabled === 1,
  };
}

export function toUserSummary(db: DatabaseSync, row: UserRow, now: number): UserSummary {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    locationIds: locationIdsOf(db, row),
    totpEnabled: row.totp_enabled === 1,
    disabled: row.disabled === 1,
    lockedUntil: row.locked_until > now ? iso(row.locked_until) : null,
    createdAt: iso(row.created_at),
    passwordChangedAt: iso(row.password_changed_at),
  };
}
