/**
 * Password hashing: scrypt N=32768 r=8 p=1, 64-byte key, 16-byte salt, maxmem 64 MiB.
 * Stored as "scrypt$32768$8$1$<saltB64>$<hashB64>".
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../../shared/api-types.ts';

const N = 32768;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_BYTES = 16;
const MAXMEM = 64 * 1024 * 1024;

function scryptAsync(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, KEY_LEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // Bounds keep a damaged or hostile row from costing unbounded CPU or memory.
  if (!Number.isInteger(n) || n < 2 || n > 1 << 20 || (n & (n - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 32) return null;
  if (!Number.isInteger(p) || p < 1 || p > 16) return null;
  const salt = Buffer.from(parts[4], 'base64');
  const key = Buffer.from(parts[5], 'base64');
  if (salt.length < 8 || key.length < 16 || key.length > 128) return null;
  return { n, r, p, salt, key };
}

let dummyHash: Promise<string> | null = null;

/** A real hash of a random password, used so unknown usernames cost the same time as known ones. */
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString('base64url'));
  return dummyHash;
}

/** Constant-time check of a password against a stored hash. False for a malformed hash. */
export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const key = await scryptAsync(password, parsed.salt, parsed.key.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    maxmem: MAXMEM,
  });
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

/** Runs the same scrypt work as a real check, then fails. */
export async function burnPasswordCheck(password: string): Promise<false> {
  await verifyPasswordHash(password, await getDummyHash());
  return false;
}

/** Null when the password is acceptable, otherwise a plain message. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string') return 'Password is required';
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  return null;
}
