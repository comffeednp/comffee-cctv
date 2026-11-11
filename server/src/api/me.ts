/**
 * Own account: GET /api/me, POST /api/me/password, POST /api/me/totp/reset (signed in).
 */

import type { Me, OkResponse, TotpEnrollment } from '../../../shared/api-types.ts';
import { HttpError } from '../contracts.ts';
import type { RegisterRoutes } from '../contracts.ts';
import { requestMeta } from '../audit.ts';
import { getUserById, toMe } from '../auth/accounts.ts';
import { hashPassword, passwordProblem } from '../auth/password.ts';
import { asAuthService } from '../auth/service.ts';
import { deleteUserSessions } from '../auth/sessions.ts';
import { transaction } from '../db.ts';
import { bodyObject, invalidInput } from '../http.ts';

const WRONG_PASSWORD = 'Your current password is not correct';

export const registerMeRoutes: RegisterRoutes = (app, deps) => {
  const { db } = deps;
  const auth = asAuthService(deps.auth);

  app.get('/api/me', async (req): Promise<Me> => {
    const user = auth.requireUser(req);
    const row = getUserById(db, user.id);
    if (!row) throw new HttpError(401, 'not_signed_in', 'Please sign in');
    return toMe(db, row);
  });

  app.post('/api/me/password', async (req): Promise<OkResponse> => {
    const user = auth.requireUser(req);
    const current = auth.currentSession(req);
    const body = bodyObject(req);
    const { currentPassword, newPassword } = body;
    const problem = passwordProblem(newPassword);
    if (problem) throw invalidInput(problem);
    if (!(await auth.verifyPassword(user.id, typeof currentPassword === 'string' ? currentPassword : ''))) {
      throw new HttpError(422, 'wrong_password', WRONG_PASSWORD);
    }
    const hash = await hashPassword(newPassword as string);
    transaction(db, () => {
      db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(hash, auth.now(), user.id);
      deleteUserSessions(db, user.id, current?.session.idHash);
    });
    deps.audit({ userId: user.id, action: 'account.password', target: `user:${user.id}`, ...requestMeta(req) });
    return { ok: true };
  });

  app.post('/api/me/totp/reset', async (req): Promise<TotpEnrollment> => {
    const user = auth.requireUser(req);
    const body = bodyObject(req);
    if (!(await auth.verifyPassword(user.id, typeof body.password === 'string' ? body.password : ''))) {
      throw new HttpError(422, 'wrong_password', WRONG_PASSWORD);
    }
    deps.audit({
      userId: user.id,
      action: 'account.totp_reset',
      target: `user:${user.id}`,
      detail: 'new 2-step code requested',
      ...requestMeta(req),
    });
    return auth.startEnrollment(user, 'reset');
  });
};
