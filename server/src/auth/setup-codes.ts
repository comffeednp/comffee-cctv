/**
 * One-time setup codes: base32 of 16 random bytes (128 bits), valid 24 h, stored as SHA-256 hex.
 * Printed by the hub command line ("setup-code"); used once by POST /api/setup/owner.
 * "setup-code --code <code>" registers a code made elsewhere (the desktop app passes one to the
 * unattended installer): base32, 26 to 64 characters, stored the same way, valid 30 days.
 */

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { base32Encode } from './totp.ts';
import { sha256Hex } from './tokens.ts';

export const SETUP_CODE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * A code registered with "setup-code --code" (the desktop app's unattended install) lasts 30 days:
 * the owner may open the new hub long after the cloud server finished installing.
 */
export const REGISTERED_SETUP_CODE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Base32 alphabet, 26 (128 bits) to 64 characters after normalising. */
const CODE_RE = /^[A-Z2-7]{26,64}$/;

/** Upper case without spaces or dashes, so "abcd-efgh" and "ABCDEFGH" are the same code. */
export function normaliseSetupCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

/** Groups of four for reading aloud or typing: ABCD-EFGH-... */
export function formatSetupCode(code: string): string {
  return normaliseSetupCode(code).replace(/(.{4})(?=.)/g, '$1-');
}

/** Stores a new code and returns it (shown once, never stored in plain text). */
export function createSetupCode(db: DatabaseSync, now: number): string {
  const code = base32Encode(randomBytes(16));
  db.prepare('INSERT INTO setup_codes (code_hash, expires_at, used) VALUES (?, ?, 0)').run(
    sha256Hex(code),
    now + SETUP_CODE_TTL_MS,
  );
  return formatSetupCode(code);
}

function codeHash(code: unknown): string | null {
  if (typeof code !== 'string' || code.length > 128) return null;
  const clean = normaliseSetupCode(code);
  if (!CODE_RE.test(clean)) return null;
  return sha256Hex(clean);
}

/** True when the text is a usable setup code (base32, 26 to 64 characters; spaces and dashes ignored). */
export function isSetupCodeShape(code: unknown): code is string {
  return codeHash(code) !== null;
}

/**
 * Stores a code made elsewhere (only its hash), valid 30 days from now. Registering the same unused
 * code again renews it. Returns false when that code was already used.
 */
export function registerSetupCode(db: DatabaseSync, code: string, now: number): boolean {
  const hash = codeHash(code);
  if (!hash) throw new Error('The setup code must be base32 (letters A-Z and digits 2-7), 26 to 64 characters.');
  db.prepare(
    'INSERT INTO setup_codes (code_hash, expires_at, used) VALUES (?, ?, 0) ON CONFLICT(code_hash) DO UPDATE SET expires_at = excluded.expires_at WHERE used = 0',
  ).run(hash, now + REGISTERED_SETUP_CODE_TTL_MS);
  const row = db.prepare('SELECT used FROM setup_codes WHERE code_hash = ?').get(hash) as { used: number } | undefined;
  return row !== undefined && Number(row.used) === 0;
}

export function isSetupCodeValid(db: DatabaseSync, code: unknown, now: number): boolean {
  const hash = codeHash(code);
  if (!hash) return false;
  return !!db.prepare('SELECT 1 FROM setup_codes WHERE code_hash = ? AND used = 0 AND expires_at > ?').get(hash, now);
}

/** Marks the code used. False when it is unknown, expired or already used. */
export function consumeSetupCode(db: DatabaseSync, code: unknown, now: number): boolean {
  const hash = codeHash(code);
  if (!hash) return false;
  const res = db
    .prepare('UPDATE setup_codes SET used = 1 WHERE code_hash = ? AND used = 0 AND expires_at > ?')
    .run(hash, now);
  return Number(res.changes) === 1;
}

export function pruneSetupCodes(db: DatabaseSync, now: number): void {
  db.prepare('DELETE FROM setup_codes WHERE expires_at <= ? OR used = 1').run(now);
}
