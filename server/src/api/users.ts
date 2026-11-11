/**
 * Accounts, owner only: GET/POST /api/users, PATCH/DELETE /api/users/:id.
 * Only viewer accounts are created or changed here. Nobody can create a second owner or change
 * the owner's role; the owner manages their own account under /api/me.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { OkResponse, UserSummary, UsersResponse } from '../../../shared/api-types.ts';
import { HttpError } from '../contracts.ts';
import type { RegisterRoutes } from '../contracts.ts';
import { requestMeta } from '../audit.ts';
import { getUserById, toUserSummary, usernameProblem } from '../auth/accounts.ts';
import type { UserRow } from '../auth/accounts.ts';
import { deleteUserChallenges } from '../auth/challenges.ts';
import { hashPassword, passwordProblem } from '../auth/password.ts';
import { asAuthService } from '../auth/service.ts';
import { deleteUserSessions } from '../auth/sessions.ts';
import { isUniqueViolation, transaction } from '../db.ts';
import { bodyObject, idParam, invalidInput, notFound } from '../http.ts';

const MAX_LOCATIONS = 1000;

/** Validates a list of existing location ids (duplicates removed). */
function locationList(db: DatabaseSync, value: unknown): number[] {
  if (!Array.isArray(value)) throw invalidInput('locationIds must be a list of location ids');
  if (value.length > MAX_LOCATIONS) throw invalidInput('Too many locations');
  const ids = [...new Set(value)];
  const exists = db.prepare('SELECT 1 FROM locations WHERE id = ?');
  for (const id of ids) {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || !exists.get(id)) {
      throw invalidInput('One of the chosen locations does not exist');
    }
  }
  return (ids as number[]).sort((a, b) => a - b);
}

function setLocations(db: DatabaseSync, userId: number, ids: number[]): void {
  db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(userId);
  const insert = db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (?, ?)');
  for (const id of ids) insert.run(userId, id);
}

/** Rejects any attempt to make an account anything but a viewer. */
function rejectRoleChange(body: Record<string, unknown>): void {
  if ('role' in body && body.role !== 'viewer') {
    throw invalidInput('Only viewer accounts can be created or changed. There is exactly one owner.');
  }
}

export const registerUserRoutes: RegisterRoutes = (app, deps) => {
  const { db } = deps;
  const auth = asAuthService(deps.auth);

  function viewerOr404(id: number): UserRow {
    const row = getUserById(db, id);
    if (!row) throw notFound();
    if (row.role !== 'viewer') {
      throw invalidInput('The owner account cannot be changed here. Use your account settings instead.');
    }
    return row;
  }

  app.get('/api/users', async (req): Promise<UsersResponse> => {
    auth.requireOwner(req);
    const rows = db.prepare("SELECT * FROM users ORDER BY role = 'owner' DESC, username COLLATE NOCASE").all() as unknown as UserRow[];
    const now = auth.now();
    return { users: rows.map((r) => toUserSummary(db, r, now)) };
  });

  app.post('/api/users', async (req): Promise<UserSummary> => {
    const owner = auth.requireOwner(req);
    const body = bodyObject(req);
    rejectRoleChange(body);
    const nameProblem = usernameProblem(body.username);
    if (nameProblem) throw invalidInput(nameProblem);
    const pwProblem = passwordProblem(body.password);
    if (pwProblem) throw invalidInput(pwProblem);
    const ids = locationList(db, body.locationIds ?? []);
    const username = body.username as string;

    const hash = await hashPassword(body.password as string);
    const now = auth.now();
    let id: number;
    try {
      id = transaction(db, () => {
        const res = db
          .prepare(
            "INSERT INTO users (username, password_hash, role, totp_enabled, created_at, password_changed_at) VALUES (?, ?, 'viewer', 0, ?, ?)",
          )
          .run(username, hash, now, now);
        const newId = Number(res.lastInsertRowid);
        setLocations(db, newId, locationList(db, ids));
        return newId;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'conflict', 'That username is already taken');
      throw err;
    }
    deps.audit({
      userId: owner.id,
      action: 'user.create',
      target: `user:${id}`,
      detail: `viewer ${username}; locations ${ids.join(',') || 'none'}`,
      ...requestMeta(req),
    });
    const row = getUserById(db, id);
    if (!row) throw notFound();
    return toUserSummary(db, row, auth.now());
  });

  app.patch('/api/users/:id', async (req): Promise<UserSummary> => {
    const owner = auth.requireOwner(req);
    const id = idParam((req.params as { id?: string }).id);
    const target = viewerOr404(id);
    const body = bodyObject(req);
    rejectRoleChange(body);

    const ids = body.locationIds === undefined ? undefined : locationList(db, body.locationIds);
    if (body.disabled !== undefined && typeof body.disabled !== 'boolean') throw invalidInput('disabled must be true or false');
    if (body.resetTotp !== undefined && typeof body.resetTotp !== 'boolean') throw invalidInput('resetTotp must be true or false');
    const disabled = body.disabled as boolean | undefined;
    const resetTotp = body.resetTotp === true;
    let newHash: string | undefined;
    if (body.newPassword !== undefined) {
      const problem = passwordProblem(body.newPassword);
      if (problem) throw invalidInput(problem);
    }
    if (body.newPassword !== undefined || resetTotp) {
      if (typeof body.password !== 'string' || body.password === '') throw invalidInput('Enter your own password to confirm');
      if (!(await auth.verifyPassword(owner.id, body.password))) {
        throw new HttpError(422, 'wrong_password', 'Your password is not correct');
      }
      if (body.newPassword !== undefined) newHash = await hashPassword(body.newPassword as string);
    }

    const changes: string[] = [];
    const now = auth.now();
    transaction(db, () => {
      // The row may have changed while the password was hashed.
      viewerOr404(id);
      let endSessions = false;
      if (ids !== undefined) {
        setLocations(db, id, ids);
        changes.push(`locations ${ids.join(',') || 'none'}`);
      }
      if (disabled !== undefined && (disabled ? 1 : 0) !== target.disabled) {
        db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
        changes.push(disabled ? 'disabled' : 'enabled');
        if (disabled) endSessions = true;
      }
      if (newHash !== undefined) {
        db.prepare(
          'UPDATE users SET password_hash = ?, password_changed_at = ?, failed_count = 0, first_failed_at = 0, locked_until = 0 WHERE id = ?',
        ).run(newHash, now, id);
        changes.push('new password');
        endSessions = true;
      }
      if (resetTotp) {
        db.prepare('UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0, totp_last_step = 0 WHERE id = ?').run(id);
        changes.push('2-step reset');
        endSessions = true;
      }
      if (endSessions) {
        deleteUserSessions(db, id);
        deleteUserChallenges(db, id);
      }
    });

    if (changes.length > 0) {
      deps.audit({ userId: owner.id, action: 'user.update', target: `user:${id}`, detail: changes.join('; '), ...requestMeta(req) });
    }
    const row = getUserById(db, id);
    if (!row) throw notFound();
    return toUserSummary(db, row, auth.now());
  });

  app.delete('/api/users/:id', async (req): Promise<OkResponse> => {
    const owner = auth.requireOwner(req);
    const id = idParam((req.params as { id?: string }).id);
    const target = viewerOr404(id);
    db.prepare("DELETE FROM users WHERE id = ? AND role = 'viewer'").run(id);
    deps.audit({
      userId: owner.id,
      action: 'user.delete',
      target: `user:${id}`,
      detail: `viewer ${target.username}`,
      ...requestMeta(req),
    });
    return { ok: true };
  });
};
