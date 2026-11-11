/**
 * GET /api/storage (owner only): disk use, the disk guard threshold and use per location.
 * Footage kept from a deleted location counts toward vaultBytes but never toward a later location that
 * received the same id (segments older than the location row are left out of its totals).
 */

import { existsSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { StorageLocation, StorageResponse } from '../../../shared/api-types.ts';
import { HttpError } from '../contracts.ts';
import type { AppDeps } from '../contracts.ts';
import { iso } from '../media/params.ts';
import { diskSpace, minFreeBytes } from '../media/retention.ts';
import { vaultRoot } from '../media/storage-paths.ts';

const DAY_MS = 86_400_000;
/** Shortest span used for the daily average, so one fresh segment does not extrapolate wildly. */
const MIN_SPAN_MS = 3_600_000;

export function registerStorageRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, auth, config } = deps;
  const vaultDir = vaultRoot(config.dataDir);

  app.get('/api/storage', async (req: FastifyRequest): Promise<StorageResponse> => {
    auth.requireOwner(req);
    let space: { totalBytes: number; freeBytes: number };
    try {
      space = await diskSpace(existsSync(vaultDir) ? vaultDir : config.dataDir);
    } catch {
      throw new HttpError(503, 'unavailable', 'Disk space could not be read');
    }
    const minFree = minFreeBytes(space.totalBytes);
    const totals = new Map<number, { bytes: number; oldest: number; newest: number }>();
    const all = db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM segments').get() as { bytes: number };
    const vaultBytes = all.bytes;
    const rows = db
      .prepare(
        `SELECT s.location_id, SUM(s.size_bytes) AS bytes, MIN(s.start_at) AS oldest, MAX(s.start_at + s.duration_ms) AS newest
         FROM segments s JOIN locations l ON l.id = s.location_id AND s.start_at >= l.created_at GROUP BY s.location_id`,
      )
      .all() as unknown as { location_id: number; bytes: number; oldest: number; newest: number }[];
    for (const r of rows) {
      totals.set(r.location_id, { bytes: r.bytes, oldest: r.oldest, newest: r.newest });
    }
    const locations = db
      .prepare('SELECT id, name, retention_days FROM locations ORDER BY name COLLATE NOCASE, id')
      .all() as unknown as { id: number; name: string; retention_days: number }[];

    // Space recordings can still use before the disk guard starts deleting.
    const usableFree = Math.max(0, space.freeBytes - minFree);
    const perLocation: StorageLocation[] = locations.map((loc) => {
      const t = totals.get(loc.id);
      if (!t) {
        return {
          locationId: loc.id,
          name: loc.name,
          bytes: 0,
          oldest: null,
          newest: null,
          avgBytesPerDay: 0,
          estimatedDaysFit: null,
          retentionDays: loc.retention_days,
        };
      }
      const spanDays = Math.max(t.newest - t.oldest, MIN_SPAN_MS) / DAY_MS;
      const avg = t.bytes / spanDays;
      return {
        locationId: loc.id,
        name: loc.name,
        bytes: t.bytes,
        oldest: iso(t.oldest),
        newest: iso(t.newest),
        avgBytesPerDay: Math.round(avg),
        estimatedDaysFit: avg > 0 ? Math.round(((usableFree + t.bytes) / avg) * 10) / 10 : null,
        retentionDays: loc.retention_days,
      };
    });

    return {
      totalBytes: space.totalBytes,
      freeBytes: space.freeBytes,
      vaultBytes,
      minFreeBytes: minFree,
      perLocation,
    };
  });
}
