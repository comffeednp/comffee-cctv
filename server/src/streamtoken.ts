/**
 * Live view tokens for MediaMTX WHEP requests.
 *
 * Format: "v1." + base64url(JSON {p: path, u: userId, e: expiresMs}) + "." +
 * base64url(HMAC-SHA256(stream-token.key, "v1." + payload)). Valid LIVE_TOKEN_TTL_MS.
 * The browser sends it as "Authorization: Bearer <token>"; MediaMTX hands it to the auth hook.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { LIVE_TOKEN_TTL_MS } from './contracts.ts';

const VERSION = 'v1';
const MAX_TOKEN_LENGTH = 512;
const MAX_PATH_LENGTH = 128;
/** Tolerance for a token whose expiry is slightly further ahead than one TTL (clock adjustments). */
const CLOCK_SKEW_MS = 5_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface LiveTokenClaims {
  path: string;
  userId: number;
  expiresMs: number;
}

function sign(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** Issues a token for one MediaMTX path and one user. */
export function issueLiveToken(
  key: Buffer,
  path: string,
  userId: number,
  nowMs: number = Date.now(),
): { token: string; expiresMs: number } {
  if (key.length < 32) throw new Error('Stream token key is too short');
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) throw new Error('Invalid path for a live token');
  if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('Invalid user id for a live token');
  const expiresMs = nowMs + LIVE_TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ p: path, u: userId, e: expiresMs }), 'utf8').toString('base64url');
  const signed = `${VERSION}.${payload}`;
  return { token: `${signed}.${sign(key, signed).toString('base64url')}`, expiresMs };
}

/** Returns the claims of a valid, unexpired token, or null. Never throws. */
export function verifyLiveToken(key: Buffer, token: unknown, nowMs: number = Date.now()): LiveTokenClaims | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [version, payload, mac] = parts as [string, string, string];
  if (version !== VERSION || !BASE64URL.test(payload) || !BASE64URL.test(mac)) return null;

  const expected = sign(key, `${version}.${payload}`);
  const given = Buffer.from(mac, 'base64url');
  // Reject non-canonical encodings so one token has exactly one spelling.
  if (given.length !== expected.length || given.toString('base64url') !== mac) return null;
  if (!timingSafeEqual(given, expected)) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) return null;
  const { p, u, e } = claims as Record<string, unknown>;
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH_LENGTH) return null;
  if (typeof u !== 'number' || !Number.isSafeInteger(u) || u < 1) return null;
  if (typeof e !== 'number' || !Number.isSafeInteger(e)) return null;
  if (e <= nowMs) return null;
  if (e > nowMs + LIVE_TOKEN_TTL_MS + CLOCK_SKEW_MS) return null;
  return { path: p, userId: u, expiresMs: e };
}
