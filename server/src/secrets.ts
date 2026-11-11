/**
 * Hub secrets under <dataDir>/secrets, created on first start:
 *   master.key               32 random bytes (seals TOTP secrets and camera passwords)
 *   stream-token.key         32 random bytes (signs live tokens)
 *   mediamtx-internal.json   {"user","password"} the hub and its ffmpeg jobs use with MediaMTX
 * Files are written with mode 0600 and the folder with 0700 where the OS supports it.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Secrets } from './contracts.ts';

const KEY_BYTES = 32;

function tightenMode(file: string, mode: number): void {
  if (process.platform === 'win32') return;
  try {
    if ((statSync(file).mode & 0o777) !== mode) chmodSync(file, mode);
  } catch {
    // Best effort: the file is still usable.
  }
}

/** Writes a new file without replacing one that appeared meanwhile; returns false if it already existed. */
function createExclusive(file: string, data: Buffer | string): boolean {
  try {
    writeFileSync(file, data, { mode: 0o600, flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

function loadKey(file: string): Buffer {
  if (!existsSync(file)) createExclusive(file, randomBytes(KEY_BYTES));
  tightenMode(file, 0o600);
  const key = readFileSync(file);
  if (key.length !== KEY_BYTES) throw new Error(`Secret file ${file} must hold exactly ${KEY_BYTES} bytes`);
  return key;
}

function loadInternalLogin(file: string): { user: string; password: string } {
  if (!existsSync(file)) {
    const login = { user: `hub-${randomBytes(6).toString('hex')}`, password: randomBytes(32).toString('base64url') };
    createExclusive(file, JSON.stringify(login) + '\n');
  }
  tightenMode(file, 0o600);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`Secret file ${file} is not valid JSON`);
  }
  const p = parsed as { user?: unknown; password?: unknown };
  if (typeof p.user !== 'string' || typeof p.password !== 'string' || !p.user || p.password.length < 16) {
    throw new Error(`Secret file ${file} must hold {"user","password"} with a password of at least 16 characters`);
  }
  return { user: p.user, password: p.password };
}

export function secretsDir(dataDir: string): string {
  return path.join(dataDir, 'secrets');
}

/** Loads every secret, creating the ones that are missing. */
export function loadOrCreateSecrets(dataDir: string): Secrets {
  const dir = secretsDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  tightenMode(dir, 0o700);
  const masterKey = loadKey(path.join(dir, 'master.key'));
  const streamTokenKey = loadKey(path.join(dir, 'stream-token.key'));
  const internal = loadInternalLogin(path.join(dir, 'mediamtx-internal.json'));
  return { masterKey, streamTokenKey, mediamtxUser: internal.user, mediamtxPassword: internal.password };
}
