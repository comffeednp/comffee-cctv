/**
 * Audit log, owner only: GET /api/audit?limit&cursor (newest first).
 */

import { AUDIT_PAGE_MAX } from '../../../shared/api-types.ts';
import type { AuditAction, AuditItem, AuditPage } from '../../../shared/api-types.ts';
import type { RegisterRoutes } from '../contracts.ts';
import { iso } from '../auth/accounts.ts';
import { invalidInput } from '../http.ts';

const DEFAULT_LIMIT = 50;

interface AuditRow {
  id: number;
  at: number;
  user_id: number | null;
  username: string | null;
  action: AuditAction;
  target: string | null;
  detail: string | null;
  ip: string | null;
  user_agent: string | null;
}

function encodeCursor(id: number): string {
  return Buffer.from(`a${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const m = /^a([1-9]\d{0,15})$/.exec(text);
  if (!m) throw invalidInput('Invalid cursor');
  return Number(m[1]);
}

export const registerAuditRoutes: RegisterRoutes = (app, deps) => {
  const { db } = deps;

  app.get('/api/audit', async (req): Promise<AuditPage> => {
    deps.auth.requireOwner(req);
    const q = req.query as { limit?: string; cursor?: string };
    let limit = DEFAULT_LIMIT;
    if (q.limit !== undefined) {
      if (!/^\d{1,4}$/.test(q.limit) || Number(q.limit) < 1 || Number(q.limit) > AUDIT_PAGE_MAX) {
        throw invalidInput(`limit must be 1..${AUDIT_PAGE_MAX}`);
      }
      limit = Number(q.limit);
    }
    const before = q.cursor ? decodeCursor(q.cursor) : Number.MAX_SAFE_INTEGER;
    const rows = db
      .prepare('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?')
      .all(before, limit + 1) as unknown as AuditRow[];
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const items: AuditItem[] = page.map((r) => ({
      id: r.id,
      at: iso(r.at),
      userId: r.user_id,
      username: r.username,
      action: r.action,
      target: r.target,
      detail: r.detail,
      ip: r.ip,
      userAgent: r.user_agent,
    }));
    return { items, nextCursor: more ? encodeCursor(page[page.length - 1].id) : null };
  });
};
