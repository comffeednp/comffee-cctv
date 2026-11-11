/**
 * Sessions: the session cookie holds 32 random bytes (base64url); the database stores SHA-256 hex.
 * Idle timeout 12 h, absolute limit 7 days.
 *
 * The cookie is named "__Host-" + SESSION_COOKIE. Browsers accept that prefix only with Secure, Path=/
 * and no Domain, so a sibling host (for example another name under the same shared parent domain)
 * cannot plant a cookie that shadows ours. Development without HTTPS (devInsecureCookies) cannot use
 * the prefix and falls back to the plain name.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE } from '../../../shared/api-types.ts';
import type { HubConfig } from '../contracts.ts';
import { randomToken, sha256Hex } from './tokens.ts';

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
/** last_seen_at is written at most this often per session. */
const TOUCH_INTERVAL_MS = 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface SessionRow {
  idHash: string;
  userId: number;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export function createSession(
  db: DatabaseSync,
  userId: number,
  meta: { ip?: string; userAgent?: string },
  now: number,
): string {
  const token = randomToken();
  db.prepare(
    'INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(sha256Hex(token), userId, now, now, now + SESSION_ABSOLUTE_MS, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null);
  return token;
}

/** The live session for a cookie token, or null. Expired sessions are deleted; live ones are touched. */
export function findSession(db: DatabaseSync, token: string, now: number): SessionRow | null {
  if (!TOKEN_RE.test(token)) return null;
  const idHash = sha256Hex(token);
  const row = db
    .prepare('SELECT user_id, created_at, last_seen_at, expires_at FROM sessions WHERE id_hash = ?')
    .get(idHash) as { user_id: number; created_at: number; last_seen_at: number; expires_at: number } | undefined;
  if (!row) return null;
  if (now >= row.expires_at || now - row.last_seen_at >= SESSION_IDLE_MS) {
    db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
    return null;
  }
  let lastSeenAt = row.last_seen_at;
  if (now - lastSeenAt >= TOUCH_INTERVAL_MS) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(now, idHash);
    lastSeenAt = now;
  }
  return { idHash, userId: row.user_id, createdAt: row.created_at, lastSeenAt, expiresAt: row.expires_at };
}

export function deleteSessionByHash(db: DatabaseSync, idHash: string): void {
  db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
}

/** Deletes every session of a user, except the one with exceptIdHash when given. */
export function deleteUserSessions(db: DatabaseSync, userId: number, exceptIdHash?: string): void {
  if (exceptIdHash) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?').run(userId, exceptIdHash);
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

export function pruneSessions(db: DatabaseSync, now: number): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?').run(now, now - SESSION_IDLE_MS);
}

export function sessionCookieName(config: HubConfig): string {
  return config.devInsecureCookies ? SESSION_COOKIE : '__Host-' + SESSION_COOKIE;
}

/**
 * Every well-formed session token in the request's Cookie header, in order. Callers try each one, so a
 * junk cookie of the same name sent first cannot hide the real one.
 */
export function readSessionTokens(req: FastifyRequest, config: HubConfig): string[] {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header === '') return [];
  const name = sessionCookieName(config);
  const tokens: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    if (TOKEN_RE.test(value) && tokens.length < 10) tokens.push(value);
  }
  return tokens;
}

function cookieAttributes(config: HubConfig, maxAgeSeconds: number): string {
  const secure = config.devInsecureCookies ? '' : '; Secure';
  return `; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${maxAgeSeconds}`;
}

export function setSessionCookie(reply: FastifyReply, config: HubConfig, token: string): void {
  reply.header('set-cookie', `${sessionCookieName(config)}=${token}${cookieAttributes(config, SESSION_ABSOLUTE_MS / 1000)}`);
}

export function clearSessionCookie(reply: FastifyReply, config: HubConfig): void {
  reply.header('set-cookie', `${sessionCookieName(config)}=${cookieAttributes(config, 0)}`);
}
