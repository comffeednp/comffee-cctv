/**
 * Retention (per location retention_days) and the disk guard (keep free space above
 * max(10% of the disk, 5 GiB) by deleting the oldest recordings across all locations).
 */

import { rmdir, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { RETENTION_DAYS_DEFAULT } from '../../../shared/api-types.ts';
import { resolveVaultFile } from './storage-paths.ts';

const DAY_MS = 86_400_000;
const GIB = 1024 ** 3;
export const MIN_FREE_FLOOR_BYTES = 5 * GIB;
const BATCH = 500;

export interface StoredSegment {
  id: number;
  rel_path: string;
  size_bytes: number;
}

/** Disk guard threshold: max(10% of the disk, 5 GiB). */
export function minFreeBytes(totalBytes: number): number {
  return Math.max(Math.floor(totalBytes * 0.1), MIN_FREE_FLOOR_BYTES);
}

export async function diskSpace(dir: string): Promise<{ totalBytes: number; freeBytes: number }> {
  const s = await statfs(dir);
  return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
}

/**
 * Segments past their location's retention: start_at + duration_ms older than retention_days.
 * Segments of a deleted location use the default retention, also when a later location received the
 * same id (a segment older than the location row is not that location's).
 */
export function selectExpiredSegments(db: DatabaseSync, nowMs: number, limit: number = BATCH): StoredSegment[] {
  const out: StoredSegment[] = [];
  const locations = db.prepare('SELECT id, retention_days, created_at FROM locations').all() as {
    id: number;
    retention_days: number;
    created_at: number;
  }[];
  const perLocation = db.prepare(
    'SELECT id, rel_path, size_bytes FROM segments WHERE location_id = ? AND start_at >= ? AND start_at < ? AND start_at + duration_ms < ? ORDER BY start_at LIMIT ?',
  );
  for (const loc of locations) {
    if (out.length >= limit) break;
    const cutoff = nowMs - loc.retention_days * DAY_MS;
    out.push(...(perLocation.all(loc.id, loc.created_at, cutoff, cutoff, limit - out.length) as unknown as StoredSegment[]));
  }
  if (out.length < limit) {
    const cutoff = nowMs - RETENTION_DAYS_DEFAULT * DAY_MS;
    const orphans = db
      .prepare(
        `SELECT id, rel_path, size_bytes FROM segments
         WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = segments.location_id AND l.created_at <= segments.start_at)
         AND start_at + duration_ms < ? ORDER BY start_at LIMIT ?`,
      )
      .all(cutoff, limit - out.length) as unknown as StoredSegment[];
    out.push(...orphans);
  }
  return out;
}

/** Oldest segments across all locations until their sizes add up to `bytesNeeded` (at least one). */
export function selectOldestSegments(db: DatabaseSync, bytesNeeded: number, limit: number = BATCH): StoredSegment[] {
  const rows = db
    .prepare('SELECT id, rel_path, size_bytes FROM segments ORDER BY start_at, id LIMIT ?')
    .all(limit) as unknown as StoredSegment[];
  const out: StoredSegment[] = [];
  let sum = 0;
  for (const row of rows) {
    out.push(row);
    sum += row.size_bytes;
    if (sum >= bytesNeeded) break;
  }
  return out;
}

/**
 * Deletes the vault files and rows. A file that cannot be removed (other than already missing)
 * keeps its row so the next run tries again. Returns the rows actually removed.
 */
export async function deleteSegments(
  db: DatabaseSync,
  vaultDir: string,
  rows: StoredSegment[],
  log: (message: string) => void = () => undefined,
): Promise<StoredSegment[]> {
  const del = db.prepare('DELETE FROM segments WHERE id = ?');
  const removed: StoredSegment[] = [];
  const dayDirs = new Set<string>();
  for (const row of rows) {
    const file = resolveVaultFile(vaultDir, row.rel_path);
    if (file) {
      try {
        await unlink(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log(`retention: cannot delete recording ${row.id}: ${(err as Error).message}`);
          continue;
        }
      }
      dayDirs.add(path.dirname(file));
    }
    del.run(row.id);
    removed.push(row);
  }
  // Tidy empty day folders (and camera/location folders above them).
  for (const dir of dayDirs) {
    let current = dir;
    for (let i = 0; i < 3; i++) {
      try {
        await rmdir(current);
      } catch {
        break;
      }
      current = path.dirname(current);
    }
  }
  return removed;
}

/** Deletes every expired segment. Returns how many were removed. */
export async function runRetention(
  db: DatabaseSync,
  vaultDir: string,
  nowMs: number,
  log: (message: string) => void = () => undefined,
): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = selectExpiredSegments(db, nowMs, BATCH);
    if (rows.length === 0) break;
    const removed = await deleteSegments(db, vaultDir, rows, log);
    total += removed.length;
    if (removed.length < rows.length) break;
  }
  return total;
}

export interface DiskGuardResult {
  deleted: number;
  freedBytes: number;
  freeBytes: number;
  minFreeBytes: number;
}

/**
 * When free space is below the threshold, deletes the oldest recordings (roughly the missing amount)
 * and checks again, a few rounds at most per run.
 */
export async function runDiskGuard(
  db: DatabaseSync,
  vaultDir: string,
  spaceOf: (dir: string) => Promise<{ totalBytes: number; freeBytes: number }> = diskSpace,
  log: (message: string) => void = () => undefined,
): Promise<DiskGuardResult> {
  let deleted = 0;
  let freedBytes = 0;
  let space = await spaceOf(vaultDir);
  const threshold = minFreeBytes(space.totalBytes);
  for (let round = 0; round < 5 && space.freeBytes < threshold; round++) {
    const rows = selectOldestSegments(db, threshold - space.freeBytes);
    if (rows.length === 0) break;
    const removed = await deleteSegments(db, vaultDir, rows, log);
    if (removed.length === 0) break;
    deleted += removed.length;
    for (const r of removed) freedBytes += r.size_bytes;
    space = await spaceOf(vaultDir);
  }
  return { deleted, freedBytes, freeBytes: space.freeBytes, minFreeBytes: threshold };
}
