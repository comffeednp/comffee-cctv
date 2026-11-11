/**
 * MediaMTX HTTP auth hook decisions (POST /internal/mediamtx-auth):
 * 1. Request not from 127.0.0.1: deny.
 * 2. Internal user and password (constant-time compare): allow any action.
 * 3. Action "read" over "webrtc" with a valid live token for exactly that path, whose user still exists,
 *    is not disabled and may still view the camera's location: allow until LIVE_SESSION_MAX_MS from now.
 *    MediaMTX reads that end time from the reply ({"expireAt"}) and closes the session then, so the
 *    player has to come back with a fresh token and access is checked again.
 * 4. Everything else: deny.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { verifyLiveToken } from '../streamtoken.ts';

export interface AuthHookContext {
  internalUser: string;
  internalPassword: string;
  streamTokenKey: Buffer;
  /** Location of a camera, or null when the camera does not exist. */
  cameraLocationId(cameraId: number): number | null;
  /** User exists, is not disabled and may view this location. */
  userCanStillView(userId: number, locationId: number): boolean;
  now(): number;
}

const VIEW_PATH_RE = /^c([1-9]\d{0,15})$/;

/** Longest a live view session runs before MediaMTX closes it and the viewer's access is checked again. */
export const LIVE_SESSION_MAX_MS = 10 * 60_000;

/** Outcome of the hook: allowed or not, and for live viewers the time MediaMTX must end the session. */
export interface MediamtxAuthDecision {
  allow: boolean;
  /** Epoch ms; null for the internal user (its sessions never expire) and for denials. */
  expireAt: number | null;
}

const DENY: MediamtxAuthDecision = { allow: false, expireAt: null };

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time string comparison (hashing first makes the lengths equal). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function isInternal(user: unknown, password: unknown, ctx: AuthHookContext): boolean {
  if (typeof user !== 'string' || typeof password !== 'string') return false;
  if (ctx.internalUser === '' || ctx.internalPassword === '') return false;
  const userOk = safeEqual(user, ctx.internalUser);
  const passwordOk = safeEqual(password, ctx.internalPassword);
  return userOk && passwordOk;
}

/** Whether MediaMTX may let this request through, and until when. Never throws. */
export function mediamtxAuthDecision(fromLoopback: boolean, body: unknown, ctx: AuthHookContext): MediamtxAuthDecision {
  try {
    if (!fromLoopback) return DENY;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return DENY;
    const b = body as Record<string, unknown>;
    if (isInternal(b.user, b.password, ctx)) return { allow: true, expireAt: null };

    if (b.action !== 'read' || b.protocol !== 'webrtc' || typeof b.path !== 'string') return DENY;
    const nowMs = ctx.now();
    const claims = verifyLiveToken(ctx.streamTokenKey, b.token, nowMs);
    if (!claims || claims.path !== b.path) return DENY;
    const m = VIEW_PATH_RE.exec(b.path);
    if (!m) return DENY;
    const cameraId = Number(m[1]);
    if (!Number.isSafeInteger(cameraId)) return DENY;
    const locationId = ctx.cameraLocationId(cameraId);
    if (locationId === null) return DENY;
    if (!ctx.userCanStillView(claims.userId, locationId)) return DENY;
    return { allow: true, expireAt: nowMs + LIVE_SESSION_MAX_MS };
  } catch {
    return DENY;
  }
}

/** True when MediaMTX may let this request through. Never throws. */
export function decideMediamtxAuth(fromLoopback: boolean, body: unknown, ctx: AuthHookContext): boolean {
  return mediamtxAuthDecision(fromLoopback, body, ctx).allow;
}

/** Request came straight from 127.0.0.1 (not forwarded by a proxy). */
export function isDirectLoopback(remoteAddress: string | undefined, headers: Record<string, unknown>): boolean {
  if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::ffff:127.0.0.1') return false;
  return headers['x-forwarded-for'] === undefined && headers['forwarded'] === undefined && headers['x-real-ip'] === undefined;
}
