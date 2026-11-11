/**
 * Random tokens and their stored form.
 */

import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes, base64url. Used for session ids and login challenges. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex: how tokens are stored in the database. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
