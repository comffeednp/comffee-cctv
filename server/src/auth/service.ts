/**
 * The auth service: implements AuthHelpers (contracts.ts) for every route module, plus the
 * session and 2-step helpers the account routes use.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TotpEnrollment } from '../../../shared/api-types.ts';
import { HttpError } from '../contracts.ts';
import type { AuthHelpers, Box, HubConfig, SessionUser } from '../contracts.ts';
import { getUserById, locationIdsOf } from './accounts.ts';
import type { UserRow } from './accounts.ts';
import { createChallenge, deleteUserChallenges } from './challenges.ts';
import type { ChallengePurpose } from './challenges.ts';
import { burnPasswordCheck, getDummyHash, verifyPasswordHash } from './password.ts';
import {
  clearSessionCookie,
  createSession,
  deleteSessionByHash,
  findSession,
  readSessionTokens,
  setSessionCookie,
} from './sessions.ts';
import type { SessionRow } from './sessions.ts';
import { isUserLocked, recordUserFailure } from './throttle.ts';
import { generateTotpSecret, otpauthUrl } from './totp.ts';

export interface CurrentSession {
  session: SessionRow;
  user: SessionUser;
}

export interface AuthService extends AuthHelpers {
  /** Clock in unix ms (tests replace it). */
  now(): number;
  /** The live session and user of this request, or null. Cached per request. */
  currentSession(req: FastifyRequest): CurrentSession | null;
  /** Session user for an account that may sign in (exists, not disabled, 2-step enabled), or null. */
  loadSessionUser(userId: number): SessionUser | null;
  /** Creates a new 2-step secret and a challenge that carries it. */
  startEnrollment(user: Pick<UserRow, 'id' | 'username'>, purpose: Exclude<ChallengePurpose, 'login'>): TotpEnrollment;
  /** Creates a new session, sets the cookie and drops the session the request came with (rotation). */
  startSession(req: FastifyRequest, reply: FastifyReply, userId: number): string;
  /** Deletes this request's session (if any) and clears the cookie. */
  endSession(req: FastifyRequest, reply: FastifyReply): CurrentSession | null;
}

export interface AuthDeps {
  db: DatabaseSync;
  config: HubConfig;
  box: Box;
  now?: () => number;
}

export const LOCKED_MESSAGE = 'Too many tries. Please wait 15 minutes and try again.';

/** AppDeps.auth is typed as AuthHelpers; the account routes need the full service created by createAuth. */
export function asAuthService(auth: AuthHelpers): AuthService {
  const s = auth as Partial<AuthService>;
  if (typeof s.startSession !== 'function' || typeof s.startEnrollment !== 'function' || typeof s.now !== 'function') {
    throw new Error('deps.auth must be created by createAuth()');
  }
  return auth as AuthService;
}

export function createAuth(deps: AuthDeps): AuthService {
  const { db, config, box } = deps;
  const now = deps.now ?? Date.now;
  const cache = new WeakMap<FastifyRequest, CurrentSession | null>();
  const rechecksRunning = new Set<number>();
  // Prepare the dummy hash now so the first unknown-username sign-in takes no longer than others.
  void getDummyHash();

  const locationExists = db.prepare('SELECT 1 FROM locations WHERE id = ?');
  const viewerHasLocation = db.prepare('SELECT 1 FROM user_locations WHERE user_id = ? AND location_id = ?');

  function loadSessionUser(userId: number): SessionUser | null {
    const row = getUserById(db, userId);
    if (!row || row.disabled === 1 || row.totp_enabled !== 1) return null;
    return { id: row.id, username: row.username, role: row.role, locationIds: locationIdsOf(db, row) };
  }

  function currentSession(req: FastifyRequest): CurrentSession | null {
    if (cache.has(req)) return cache.get(req) ?? null;
    let result: CurrentSession | null = null;
    for (const token of readSessionTokens(req, config)) {
      const session = findSession(db, token, now());
      if (!session) continue;
      const user = loadSessionUser(session.userId);
      if (user) {
        result = { session, user };
        break;
      }
      deleteSessionByHash(db, session.idHash);
    }
    cache.set(req, result);
    return result;
  }

  function requireUser(req: FastifyRequest): SessionUser {
    const current = currentSession(req);
    if (!current) throw new HttpError(401, 'not_signed_in', 'Please sign in');
    return current.user;
  }

  function requireOwner(req: FastifyRequest): SessionUser {
    const user = requireUser(req);
    if (user.role !== 'owner') throw new HttpError(403, 'owner_only', 'Only the owner can do this');
    return user;
  }

  function canAccessLocation(user: SessionUser, locationId: number): boolean {
    if (user.locationIds === 'all') return true;
    return user.locationIds.includes(locationId);
  }

  function assertLocationAccess(user: SessionUser, locationId: number): void {
    if (!Number.isSafeInteger(locationId) || !canAccessLocation(user, locationId) || !locationExists.get(locationId)) {
      throw new HttpError(404, 'not_found', 'Not found');
    }
  }

  async function verifyPassword(userId: number, password: string): Promise<boolean> {
    const row = getUserById(db, userId);
    if (typeof password !== 'string' || password.length > 1000 || !row || row.disabled === 1) {
      return burnPasswordCheck(typeof password === 'string' ? password.slice(0, 1000) : '');
    }
    // A locked account cannot be used to guess its own password through a password re-check.
    if (isUserLocked(row.locked_until, now())) throw new HttpError(429, 'throttled', LOCKED_MESSAGE);
    // One re-check per account at a time, so parallel guesses cannot all start before the lock is written.
    if (rechecksRunning.has(userId)) {
      throw new HttpError(429, 'throttled', 'A password check for this account is already running. Please try again in a moment.');
    }
    rechecksRunning.add(userId);
    let ok = false;
    try {
      ok = await verifyPasswordHash(password, row.password_hash);
    } finally {
      rechecksRunning.delete(userId);
    }
    if (!ok) recordUserFailure(db, userId, now());
    return ok;
  }

  function userCanStillView(userId: number, locationId: number): boolean {
    const user = loadSessionUser(userId);
    if (!user || !Number.isSafeInteger(locationId)) return false;
    if (user.role === 'owner') return !!locationExists.get(locationId);
    return !!viewerHasLocation.get(userId, locationId);
  }

  function startEnrollment(
    user: Pick<UserRow, 'id' | 'username'>,
    purpose: Exclude<ChallengePurpose, 'login'>,
  ): TotpEnrollment {
    const secret = generateTotpSecret();
    deleteUserChallenges(db, user.id, purpose === 'reset' ? ['reset'] : ['login', 'enroll', 'setup']);
    const challenge = createChallenge(db, user.id, purpose, box.seal(secret), now());
    return { challenge, secretBase32: secret, otpauthUrl: otpauthUrl(user.username, secret) };
  }

  function startSession(req: FastifyRequest, reply: FastifyReply, userId: number): string {
    for (const previous of readSessionTokens(req, config)) {
      const old = findSession(db, previous, now());
      if (old) deleteSessionByHash(db, old.idHash);
    }
    const ua = req.headers['user-agent'];
    const token = createSession(db, userId, { ip: req.ip, userAgent: typeof ua === 'string' ? ua : undefined }, now());
    setSessionCookie(reply, config, token);
    cache.delete(req);
    return token;
  }

  function endSession(req: FastifyRequest, reply: FastifyReply): CurrentSession | null {
    const current = currentSession(req);
    if (current) deleteSessionByHash(db, current.session.idHash);
    clearSessionCookie(reply, config);
    cache.set(req, null);
    return current;
  }

  return {
    now,
    currentSession,
    loadSessionUser,
    requireUser,
    requireOwner,
    canAccessLocation,
    assertLocationAccess,
    verifyPassword,
    userCanStillView,
    startEnrollment,
    startSession,
    endSession,
  };
}
