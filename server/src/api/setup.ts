/**
 * First setup: GET /api/setup/status, POST /api/setup/owner (both public).
 */

import type { SetupStatus, TotpEnrollment } from '../../../shared/api-types.ts';
import { HttpError } from '../contracts.ts';
import type { RegisterRoutes } from '../contracts.ts';
import { requestMeta } from '../audit.ts';
import { getUserById, ownerExists, usernameProblem } from '../auth/accounts.ts';
import { hashPassword, passwordProblem } from '../auth/password.ts';
import { asAuthService } from '../auth/service.ts';
import { consumeSetupCode, isSetupCodeValid } from '../auth/setup-codes.ts';
import { isIpBlocked, recordIpFailure } from '../auth/throttle.ts';
import { isUniqueViolation, transaction } from '../db.ts';
import { bodyObject, invalidInput } from '../http.ts';

const OWNER_EXISTS = 'The owner account already exists. Please sign in.';

export const registerSetupRoutes: RegisterRoutes = (app, deps) => {
  const { db } = deps;
  const auth = asAuthService(deps.auth);

  app.get('/api/setup/status', async (): Promise<SetupStatus> => {
    const hasVaultKey = !!db.prepare('SELECT 1 FROM vault_keys WHERE active = 1').get();
    return { needsSetup: !ownerExists(db), hasVaultKey };
  });

  app.post('/api/setup/owner', async (req): Promise<TotpEnrollment> => {
    const now = auth.now();
    if (isIpBlocked(db, req.ip, 'setup', now)) {
      throw new HttpError(429, 'throttled', 'Too many setup tries. Please wait an hour and try again.');
    }
    if (ownerExists(db)) throw new HttpError(409, 'conflict', OWNER_EXISTS);

    const body = bodyObject(req);
    const { setupCode, username, password } = body;
    // Check the code before any expensive work, so wrong codes cost nothing and are counted.
    if (!isSetupCodeValid(db, setupCode, now)) {
      recordIpFailure(db, req.ip, 'setup', now);
      throw invalidInput('That setup code is wrong, used or expired. Run the setup-code command on the hub for a new one.');
    }
    const nameProblem = usernameProblem(username);
    if (nameProblem) throw invalidInput(nameProblem);
    const pwProblem = passwordProblem(password);
    if (pwProblem) throw invalidInput(pwProblem);

    const passwordHash = await hashPassword(password as string);
    const createdAt = auth.now();
    let ownerId: number;
    try {
      ownerId = transaction(db, () => {
        if (ownerExists(db)) throw new HttpError(409, 'conflict', OWNER_EXISTS);
        if (!consumeSetupCode(db, setupCode, createdAt)) {
          throw invalidInput('That setup code is wrong, used or expired. Run the setup-code command on the hub for a new one.');
        }
        const res = db
          .prepare(
            "INSERT INTO users (username, password_hash, role, totp_enabled, created_at, password_changed_at) VALUES (?, ?, 'owner', 0, ?, ?)",
          )
          .run(username as string, passwordHash, createdAt, createdAt);
        return Number(res.lastInsertRowid);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'conflict', OWNER_EXISTS);
      throw err;
    }

    const owner = getUserById(db, ownerId);
    if (!owner) throw new Error('Owner row missing after insert');
    deps.audit({ userId: owner.id, username: owner.username, action: 'setup.owner', target: `user:${owner.id}`, ...requestMeta(req) });
    return auth.startEnrollment(owner, 'setup');
  });
};
