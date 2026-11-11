/**
 * Recording routes:
 * - GET /api/recordings?locationId&cameraId&from&to&order&limit&cursor (keyset pagination)
 * - GET /api/recordings/days?locationId&cameraId&month=YYYY-MM (days in the location timezone)
 * - GET /api/recordings/:id/file (encrypted CCV1 bytes, audited)
 * Viewers only see their own locations; anything else is 404.
 * A segment counts for a location only when it started after that location row was created. Footage kept
 * from a deleted location whose id was later given to a new location is therefore never shown or served
 * as the new location's (only an owner, who sees everything, can still reach it without a location filter).
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RECORDINGS_PAGE_MAX } from '../../../shared/api-types.ts';
import type { RecordingDay, RecordingDaysResponse, RecordingItem, RecordingsPage } from '../../../shared/api-types.ts';
import type { AppDeps, SessionUser } from '../contracts.ts';
import { requestMeta } from '../audit.ts';
import { invalidInput, iso, notFound, parseIdParam, queryInt, queryTime, queryValue } from '../media/params.ts';
import { resolveVaultFile, vaultRoot } from '../media/storage-paths.ts';
import { MAX_SEGMENT_MS } from '../media/sweeper.ts';
import { daysInMonth, isValidTimeZone, zonedMidnightUtc } from '../media/timezone.ts';

const DEFAULT_LIMIT = 100;
const MAX_ID = Number.MAX_SAFE_INTEGER;

interface SegmentRow {
  id: number;
  camera_id: number;
  camera_name: string;
  location_id: number;
  start_at: number;
  duration_ms: number;
  size_bytes: number;
  key_id: string;
  rel_path: string;
}

type Order = 'asc' | 'desc';

function toItem(r: SegmentRow): RecordingItem {
  return {
    id: r.id,
    cameraId: r.camera_id,
    cameraName: r.camera_name,
    locationId: r.location_id,
    start: iso(r.start_at),
    end: iso(r.start_at + r.duration_ms),
    durationMs: r.duration_ms,
    sizeBytes: r.size_bytes,
    keyId: r.key_id,
  };
}

/** Opaque cursor: the order and the (start_at, id) of the last item of the previous page. */
export function encodeCursor(order: Order, startAt: number, id: number): string {
  return Buffer.from(JSON.stringify({ o: order, s: startAt, i: id }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, order: Order): { startAt: number; id: number } {
  const bad = invalidInput('cursor is invalid');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) throw bad;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw bad;
  }
  const c = value as { o?: unknown; s?: unknown; i?: unknown } | null;
  if (!c || c.o !== order || !Number.isSafeInteger(c.s) || !Number.isSafeInteger(c.i)) throw bad;
  return { startAt: c.s as number, id: c.i as number };
}

/** Segment started after its location row was created (excludes footage of an earlier location with the same id). */
const CURRENT_LOCATION_SQL = 'start_at >= (SELECT l.created_at FROM locations l WHERE l.id = segments.location_id)';

/** SQL restriction to the caller's locations; null when they have none. */
function scope(user: SessionUser): { sql: string; params: number[] } | null {
  if (user.locationIds === 'all') return { sql: '', params: [] };
  if (user.locationIds.length === 0) return null;
  return {
    sql: `location_id IN (${user.locationIds.map(() => '?').join(',')}) AND ${CURRENT_LOCATION_SQL}`,
    params: [...user.locationIds],
  };
}

function parseMonth(value: string | undefined): { year: number; month: number } {
  const m = value === undefined ? null : /^(\d{4})-(\d{2})$/.exec(value);
  const year = m ? Number(m[1]) : NaN;
  const month = m ? Number(m[2]) : NaN;
  if (!m || year < 2000 || year > 2200 || month < 1 || month > 12) throw invalidInput('month must look like 2026-01');
  return { year, month };
}

export function registerRecordingRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, auth, config, audit } = deps;
  const vaultDir = vaultRoot(config.dataDir);
  const cameraLocationStmt = db.prepare('SELECT location_id FROM cameras WHERE id = ?');
  const locationStmt = db.prepare('SELECT id, timezone, created_at FROM locations WHERE id = ?');
  const segmentStmt = db.prepare('SELECT * FROM segments WHERE id = ?');

  /** A camera that still exists must be visible to the caller (404 otherwise). */
  function checkCamera(user: SessionUser, cameraId: number | undefined): void {
    if (cameraId === undefined) return;
    const cam = cameraLocationStmt.get(cameraId) as { location_id: number } | undefined;
    if (cam && !auth.canAccessLocation(user, cam.location_id)) throw notFound('Camera not found');
  }

  /* GET /api/recordings */
  app.get('/api/recordings', async (req: FastifyRequest): Promise<RecordingsPage> => {
    const user = auth.requireUser(req);
    const q = req.query;
    const locationId = queryInt(q, 'locationId', 1, MAX_ID);
    const cameraId = queryInt(q, 'cameraId', 1, MAX_ID);
    const from = queryTime(q, 'from');
    const to = queryTime(q, 'to');
    const orderText = queryValue(q, 'order') ?? 'desc';
    if (orderText !== 'asc' && orderText !== 'desc') throw invalidInput('order must be asc or desc');
    const order: Order = orderText;
    const limit = queryInt(q, 'limit', 1, RECORDINGS_PAGE_MAX) ?? DEFAULT_LIMIT;
    const cursorText = queryValue(q, 'cursor');
    const cursor = cursorText === undefined ? null : decodeCursor(cursorText, order);

    if (locationId !== undefined) auth.assertLocationAccess(user, locationId);
    checkCamera(user, cameraId);
    const s = scope(user);
    if (!s) return { items: [], nextCursor: null };

    const where: string[] = [];
    const params: number[] = [];
    if (s.sql) {
      where.push(s.sql);
      params.push(...s.params);
    }
    if (locationId !== undefined) {
      where.push('location_id = ?', CURRENT_LOCATION_SQL);
      params.push(locationId);
    }
    if (cameraId !== undefined) {
      where.push('camera_id = ?');
      params.push(cameraId);
    }
    if (from !== undefined) {
      // Segments whose end is after `from`; the start bound keeps the index usable.
      where.push('start_at + duration_ms > ?', 'start_at > ?');
      params.push(from, from - MAX_SEGMENT_MS);
    }
    if (to !== undefined) {
      where.push('start_at < ?');
      params.push(to);
    }
    if (cursor) {
      where.push(order === 'desc' ? '(start_at < ? OR (start_at = ? AND id < ?))' : '(start_at > ? OR (start_at = ? AND id > ?))');
      params.push(cursor.startAt, cursor.startAt, cursor.id);
    }
    const dir = order === 'desc' ? 'DESC' : 'ASC';
    const sql = `SELECT * FROM segments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY start_at ${dir}, id ${dir} LIMIT ?`;
    const rows = db.prepare(sql).all(...params, limit + 1) as unknown as SegmentRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toItem),
      nextCursor: rows.length > limit && last ? encodeCursor(order, last.start_at, last.id) : null,
    };
  });

  /* GET /api/recordings/days */
  app.get('/api/recordings/days', async (req: FastifyRequest): Promise<RecordingDaysResponse> => {
    const user = auth.requireUser(req);
    const q = req.query;
    const locationId = queryInt(q, 'locationId', 1, MAX_ID);
    if (locationId === undefined) throw invalidInput('locationId is required');
    const cameraId = queryInt(q, 'cameraId', 1, MAX_ID);
    const { year, month } = parseMonth(queryValue(q, 'month'));
    auth.assertLocationAccess(user, locationId);
    checkCamera(user, cameraId);
    const loc = locationStmt.get(locationId) as { id: number; timezone: string; created_at: number } | undefined;
    if (!loc) throw notFound('Location not found');
    const tz = isValidTimeZone(loc.timezone) ? loc.timezone : 'UTC';

    const count = daysInMonth(year, month);
    const bounds: number[] = [];
    for (let d = 1; d <= count + 1; d++) bounds.push(zonedMidnightUtc(year, month, d, tz));
    const monthStart = bounds[0] as number;
    const monthEnd = bounds[count] as number;

    const params: number[] = [locationId];
    let cameraSql = '';
    if (cameraId !== undefined) {
      cameraSql = ' AND camera_id = ?';
      params.push(cameraId);
    }
    params.push(loc.created_at);
    const stmt = db.prepare(
      `SELECT start_at, duration_ms FROM segments WHERE location_id = ?${cameraSql}
       AND start_at >= ? AND start_at < ? AND start_at > ? AND start_at + duration_ms > ? ORDER BY start_at`,
    );

    // Per day: segment count and the union of covered time (cameras overlap; minutes are not double counted).
    const segCount = new Array<number>(count).fill(0);
    const covered = new Array<number>(count).fill(0);
    const runStart = new Array<number>(count).fill(-1);
    const runEnd = new Array<number>(count).fill(-1);
    const dayOf = (t: number): number => {
      let lo = 0;
      let hi = count - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((bounds[mid] as number) <= t) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };

    for (const raw of stmt.iterate(...params, monthEnd, monthStart - MAX_SEGMENT_MS, monthStart)) {
      const row = raw as unknown as { start_at: number; duration_ms: number };
      const start = Math.max(row.start_at, monthStart);
      const end = Math.min(row.start_at + row.duration_ms, monthEnd);
      const first = dayOf(start);
      const lastDay = end > start ? dayOf(end - 1) : first;
      for (let d = first; d <= lastDay; d++) {
        const a = Math.max(start, bounds[d] as number);
        const b = Math.min(end, bounds[d + 1] as number);
        segCount[d] = (segCount[d] as number) + 1;
        if (b <= a) continue;
        if ((runEnd[d] as number) < a) {
          if ((runEnd[d] as number) > (runStart[d] as number)) covered[d] = (covered[d] as number) + (runEnd[d] as number) - (runStart[d] as number);
          runStart[d] = a;
          runEnd[d] = b;
        } else if (b > (runEnd[d] as number)) {
          runEnd[d] = b;
        }
      }
    }

    const days: RecordingDay[] = [];
    for (let d = 0; d < count; d++) {
      if ((segCount[d] as number) === 0) continue;
      const total = (covered[d] as number) + Math.max(0, (runEnd[d] as number) - (runStart[d] as number));
      days.push({
        date: `${year}-${String(month).padStart(2, '0')}-${String(d + 1).padStart(2, '0')}`,
        segmentCount: segCount[d] as number,
        coveredMinutes: Math.round(total / 60_000),
      });
    }
    return { days };
  });

  /* GET /api/recordings/:id/file */
  app.get('/api/recordings/:id/file', async (req: FastifyRequest, reply: FastifyReply) => {
    const user = auth.requireUser(req);
    const id = parseIdParam((req.params as Record<string, unknown>).id);
    const row = segmentStmt.get(id) as unknown as SegmentRow | undefined;
    if (!row || !auth.canAccessLocation(user, row.location_id)) throw notFound('Recording not found');
    if (user.locationIds !== 'all') {
      const loc = locationStmt.get(row.location_id) as { created_at: number } | undefined;
      if (!loc || row.start_at < loc.created_at) throw notFound('Recording not found');
    }
    const file = resolveVaultFile(vaultDir, row.rel_path);
    if (!file) throw notFound('Recording not found');
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      throw notFound('Recording file is missing');
    }
    audit({ userId: user.id, username: user.username, action: 'recording.download', target: `segment:${row.id}`, ...requestMeta(req) });
    const stamp = iso(row.start_at).replace(/[:.]/g, '-');
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(size))
      .header('content-disposition', `attachment; filename="c${row.camera_id}-${stamp}.ccv"`)
      .header('cache-control', 'no-store')
      .send(createReadStream(file));
  });
}
