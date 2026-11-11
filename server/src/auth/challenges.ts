/**
 * Login challenges: 32 random bytes (base64url), stored as SHA-256 hex, 5-minute expiry, single use.
 * Purposes: 'login' (2-step code of an enrolled user), 'enroll' (first 2-step at login),
 * 'setup' (owner created at first setup), 'reset' (user replaces their own 2-step).
 * Enrollment purposes carry the new secret, sealed with the master key.
 */

import type { DatabaseSync } from 'node:sqlite';
import { randomToken, sha256Hex } from './tokens.ts';

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export type ChallengePurpose = 'login' | 'enroll' | 'setup' | 'reset';

export interface ChallengeRow {
  idHash: string;
  userId: number;
  purpose: ChallengePurpose;
  totpSecretEnc: string | null;
  expiresAt: number;
}

export function createChallenge(
  db: DatabaseSync,
  userId: number,
  purpose: ChallengePurpose,
  totpSecretEnc: string | null,
  now: number,
): string {
  const token = randomToken();
  db.prepare(
    'INSERT INTO login_challenges (id_hash, user_id, purpose, totp_secret_enc, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(sha256Hex(token), userId, purpose, totpSecretEnc, now + CHALLENGE_TTL_MS);
  return token;
}

/** The unexpired challenge for a token, or null. */
export function findChallenge(db: DatabaseSync, token: string, now: number): ChallengeRow | null {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const idHash = sha256Hex(token);
  const row = db
    .prepare('SELECT user_id, purpose, totp_secret_enc, expires_at FROM login_challenges WHERE id_hash = ?')
    .get(idHash) as
    | { user_id: number; purpose: ChallengePurpose; totp_secret_enc: string | null; expires_at: number }
    | undefined;
  if (!row) return null;
  if (now >= row.expires_at) {
    db.prepare('DELETE FROM login_challenges WHERE id_hash = ?').run(idHash);
    return null;
  }
  return { idHash, userId: row.user_id, purpose: row.purpose, totpSecretEnc: row.totp_secret_enc, expiresAt: row.expires_at };
}

/** Uses up a challenge. False when it was already used (so two requests cannot both succeed). */
export function consumeChallenge(db: DatabaseSync, idHash: string): boolean {
  return Number(db.prepare('DELETE FROM login_challenges WHERE id_hash = ?').run(idHash).changes) === 1;
}

export function deleteUserChallenges(db: DatabaseSync, userId: number, purposes?: ChallengePurpose[]): void {
  if (purposes && purposes.length > 0) {
    const marks = purposes.map(() => '?').join(', ');
    db.prepare(`DELETE FROM login_challenges WHERE user_id = ? AND purpose IN (${marks})`).run(userId, ...purposes);
  } else {
    db.prepare('DELETE FROM login_challenges WHERE user_id = ?').run(userId);
  }
}

export function pruneChallenges(db: DatabaseSync, now: number): void {
  db.prepare('DELETE FROM login_challenges WHERE expires_at <= ?').run(now);
}
