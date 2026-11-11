/**
 * Sign-in: POST /api/auth/login, POST /api/auth/totp (public), POST /api/auth/logout.
 */

import type { LoginResponse, LogoutResponse, Me } from '../../../shared/api-types.ts';
import { HttpError } from '../contracts.ts';
import type { RegisterRoutes } from '../contracts.ts';
import { requestMeta } from '../audit.ts';
import { getUserById, getUserByName, toMe } from '../auth/accounts.ts';
import { consumeChallenge, createChallenge, deleteUserChallenges, findChallenge } from '../auth/challenges.ts';
import { burnPasswordCheck, verifyPasswordHash } from '../auth/password.ts';
import { LOCKED_MESSAGE, asAuthService } from '../auth/service.ts';
import { deleteUserSessions } from '../auth/sessions.ts';
import {
  clearLoginPairFailures,
  clearUserFailures,
  forgetLoginFailure,
  isIpBlocked,
  isLoginNameBlocked,
  isUserLocked,
  loginNameKey,
  recordIpFailure,
  recordLoginFailure,
  recordUserFailure,
} from '../auth/throttle.ts';
import { verifyTotp } from '../auth/totp.ts';
import { transaction } from '../db.ts';
import { bodyObject } from '../http.ts';

const WRONG_LOGIN = 'Wrong username or password';
const WRONG_CODE = 'Wrong code. Check the time on your phone and try again.';
const CHALLENGE_GONE = 'This sign-in step has expired. Please sign in again.';
const IP_BLOCKED = 'Too many tries from your network. Please wait 15 minutes and try again.';
const BUSY = 'Another sign-in from your network is being checked. Please try again in a moment.';
const MAX_FIELD = 1000;
/** Password checks one IP may have running at once (each one uses a large block of memory). */
const MAX_CHECKS_PER_IP = 2;

export const registerAuthRoutes: RegisterRoutes = (app, deps) => {
  const { db } = deps;
  const auth = asAuthService(deps.auth);

  // Password checks running right now, per IP. Caps the memory and threads one network can tie up.
  const checksRunning = new Map<string, number>();

  app.post('/api/auth/login', async (req): Promise<LoginResponse> => {
    const meta = requestMeta(req);
    const started = auth.now();
    if (isIpBlocked(db, req.ip, 'login', started)) throw new HttpError(429, 'throttled', IP_BLOCKED);

    const body = bodyObject(req);
    const username = typeof body.username === 'string' ? body.username.slice(0, MAX_FIELD) : '';
    const password = typeof body.password === 'string' ? body.password.slice(0, MAX_FIELD) : '';
    // Limits are keyed on the typed name whether or not the account exists, so the answers are the same
    // for real and unknown usernames; the (name, IP) pair locks first, so one network cannot lock an account out everywhere.
    const nameKey = loginNameKey(username);
    if (isLoginNameBlocked(db, nameKey, req.ip, started)) throw new HttpError(429, 'throttled', LOCKED_MESSAGE);

    const running = checksRunning.get(req.ip) ?? 0;
    if (running >= MAX_CHECKS_PER_IP) throw new HttpError(429, 'throttled', BUSY);

    // Count the try as a failure before the slow check, so parallel tries cannot all slip past the limits
    // above. A right password takes it back.
    const pending = recordLoginFailure(db, req.ip, nameKey, started);
    const user = username ? getUserByName(db, username) : undefined;

    let ok = false;
    checksRunning.set(req.ip, running + 1);
    try {
      if (!user || user.disabled === 1 || password === '') {
        await burnPasswordCheck(password);
      } else {
        ok = await verifyPasswordHash(password, user.password_hash);
      }
    } finally {
      const left = (checksRunning.get(req.ip) ?? 1) - 1;
      if (left > 0) checksRunning.set(req.ip, left);
      else checksRunning.delete(req.ip);
    }

    const now = auth.now();
    if (!ok || !user) {
      deps.audit({
        userId: user ? user.id : null,
        username: user ? user.username : undefined,
        action: 'auth.login_failed',
        detail: user ? (user.disabled === 1 ? 'account disabled' : 'wrong password') : 'unknown username',
        ...meta,
      });
      throw new HttpError(401, 'wrong_credentials', WRONG_LOGIN);
    }
    forgetLoginFailure(db, pending);

    // Locked by wrong 2-step codes. Checked only once the password is right, so it shows nothing to a guesser.
    const fresh = getUserById(db, user.id);
    if (!fresh || fresh.disabled === 1) throw new HttpError(401, 'wrong_credentials', WRONG_LOGIN);
    if (isUserLocked(fresh.locked_until, now)) throw new HttpError(429, 'throttled', LOCKED_MESSAGE);

    if (fresh.totp_enabled === 1 && fresh.totp_secret_enc) {
      deleteUserChallenges(db, fresh.id, ['login', 'enroll', 'setup']);
      const challenge = createChallenge(db, fresh.id, 'login', null, now);
      return { next: 'totp', challenge };
    }
    return { next: 'enroll-totp', ...auth.startEnrollment(fresh, 'enroll') };
  });

  app.post('/api/auth/totp', async (req, reply): Promise<Me> => {
    const meta = requestMeta(req);
    const now = auth.now();
    if (isIpBlocked(db, req.ip, 'login', now)) throw new HttpError(429, 'throttled', IP_BLOCKED);

    const body = bodyObject(req);
    const challenge = findChallenge(db, typeof body.challenge === 'string' ? body.challenge : '', now);
    if (!challenge) throw new HttpError(401, 'challenge_expired', CHALLENGE_GONE);

    const user = getUserById(db, challenge.userId);
    if (!user || user.disabled === 1) {
      consumeChallenge(db, challenge.idHash);
      throw new HttpError(401, 'challenge_expired', CHALLENGE_GONE);
    }
    if (isUserLocked(user.locked_until, now)) throw new HttpError(429, 'throttled', LOCKED_MESSAGE);

    const enrolling = challenge.purpose !== 'login';
    const sealed = enrolling ? challenge.totpSecretEnc : user.totp_secret_enc;
    // First-time enrollment (login or setup) is only valid while the account still has no 2-step.
    const staleEnrollment = (challenge.purpose === 'enroll' || challenge.purpose === 'setup') && user.totp_enabled === 1;
    if (!sealed || (!enrolling && user.totp_enabled !== 1) || staleEnrollment) {
      consumeChallenge(db, challenge.idHash);
      throw new HttpError(401, 'challenge_expired', CHALLENGE_GONE);
    }
    let secret: string;
    try {
      secret = deps.box.open(sealed);
    } catch {
      consumeChallenge(db, challenge.idHash);
      throw new HttpError(500, 'internal', 'The stored 2-step secret could not be read');
    }

    const code = typeof body.code === 'string' ? body.code.replace(/\s/g, '') : '';
    // A fresh secret has no used steps yet; an enrolled one must not accept a code twice.
    const step = verifyTotp(secret, code, now, enrolling ? 0 : user.totp_last_step);
    if (step === null) {
      recordIpFailure(db, req.ip, 'login', now);
      recordUserFailure(db, user.id, now);
      deps.audit({ userId: user.id, action: 'auth.login_failed', detail: 'wrong 2-step code', ...meta });
      throw new HttpError(401, 'wrong_credentials', WRONG_CODE);
    }

    transaction(db, () => {
      if (!consumeChallenge(db, challenge.idHash)) throw new HttpError(401, 'challenge_expired', CHALLENGE_GONE);
      if (enrolling) {
        db.prepare('UPDATE users SET totp_secret_enc = ?, totp_enabled = 1, totp_last_step = ? WHERE id = ?').run(
          sealed,
          step,
          user.id,
        );
        // Other open enrollments are void now.
        deleteUserChallenges(db, user.id);
        // A new 2-step secret signs out every other device.
        if (challenge.purpose === 'reset') deleteUserSessions(db, user.id);
      } else {
        db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
      }
      clearUserFailures(db, user.id);
      clearLoginPairFailures(db, loginNameKey(user.username), req.ip);
    });

    auth.startSession(req, reply, user.id);
    if (enrolling) deps.audit({ userId: user.id, action: 'auth.totp_enrolled', detail: challenge.purpose, ...meta });
    deps.audit({ userId: user.id, action: 'auth.login', ...meta });

    const fresh = getUserById(db, user.id);
    if (!fresh) throw new HttpError(401, 'not_signed_in', 'Please sign in');
    return toMe(db, fresh);
  });

  app.post('/api/auth/logout', async (req, reply): Promise<LogoutResponse> => {
    const ended = auth.endSession(req, reply);
    if (ended) deps.audit({ userId: ended.user.id, action: 'auth.logout', ...requestMeta(req) });
    return { ok: true };
  });
};
