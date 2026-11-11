/**
 * Segment sweeper: encrypts finished MediaMTX segments from raw/ into the vault and records them.
 *
 * In each raw/<path>/ folder every file except the newest is complete; the newest is complete once its
 * modification time is more than 6 minutes old. Start time comes from the file name (UTC).
 * Duration = next file's start minus this start, capped by this file's own modification time (so a gap
 * in recording does not stretch a segment), or for the last file, modification time minus start.
 * A file that started before its camera row was created belongs to an earlier, deleted camera with the
 * same id and is discarded, so it is never stored under the new camera or its location.
 */

import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { encryptFileToVault, loadVaultPublicKey } from '../crypto/vault-node.ts';
import type { VaultPublicKey } from '../crypto/vault-node.ts';
import { redactUrls } from './paths.ts';
import { segmentRelPath } from './storage-paths.ts';

/** MediaMTX recordPath %Y-%m-%d_%H-%M-%S-%f plus the ".mp4" extension it adds for fMP4. */
export const SEGMENT_NAME_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{6})\.mp4$/;
/** The newest file in a folder counts as finished once untouched this long. */
export const SETTLE_MS = 6 * 60_000;
/** Longest duration stored for one segment; MediaMTX cuts every 5 minutes. */
export const MAX_SEGMENT_MS = 60 * 60_000;
const RAW_DIR_RE = /^c([1-9]\d{0,15})$/;

export interface RawFile {
  name: string;
  startMs: number;
  mtimeMs: number;
  size: number;
}

export interface CompleteSegment {
  file: RawFile;
  durationMs: number;
}

/** Start time (UTC ms) from a segment file name, or null when the name does not match. */
export function parseSegmentStart(name: string): number | null {
  const m = SEGMENT_NAME_RE.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s, us] = m.slice(1).map(Number) as [number, number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s) + Math.floor(us / 1000);
  return Number.isFinite(ms) ? ms : null;
}

function clampDuration(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(Math.round(ms), MAX_SEGMENT_MS);
}

/** Which files of one folder are finished, with their durations, oldest first. */
export function completeSegments(files: RawFile[], nowMs: number, settleMs: number = SETTLE_MS): CompleteSegment[] {
  const sorted = [...files].sort((a, b) => a.startMs - b.startMs || a.name.localeCompare(b.name));
  const out: CompleteSegment[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const file = sorted[i] as RawFile;
    const next = sorted[i + 1];
    const ownEnd = file.mtimeMs - file.startMs;
    if (next) {
      out.push({ file, durationMs: clampDuration(Math.min(next.startMs - file.startMs, ownEnd)) });
    } else if (nowMs - file.mtimeMs > settleMs) {
      out.push({ file, durationMs: clampDuration(ownEnd) });
    }
  }
  return out;
}

export interface ActiveVaultKey {
  keyId: string;
  publicKey: VaultPublicKey;
}

let keyCache: { spkiB64: string; key: VaultPublicKey } | null = null;

/** The active vault key, or null when none is set (recording is off then). */
export function loadActiveVaultKey(db: DatabaseSync): ActiveVaultKey | null {
  const row = db
    .prepare('SELECT key_id, spki_b64 FROM vault_keys WHERE active = 1 ORDER BY created_at DESC LIMIT 1')
    .get() as { key_id: string; spki_b64: string } | undefined;
  if (!row) return null;
  if (keyCache?.spkiB64 !== row.spki_b64) keyCache = { spkiB64: row.spki_b64, key: loadVaultPublicKey(row.spki_b64) };
  return { keyId: keyCache.key.keyId, publicKey: keyCache.key };
}

export interface SweepContext {
  db: DatabaseSync;
  rawDir: string;
  vaultDir: string;
  now(): number;
  log(message: string): void;
}

export interface SweepResult {
  stored: number;
  discarded: number;
  failed: number;
}

async function listRawFiles(dir: string): Promise<RawFile[]> {
  const out: RawFile[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const startMs = parseSegmentStart(name);
    if (startMs === null) continue;
    try {
      const st = await stat(path.join(dir, name));
      if (st.isFile()) out.push({ name, startMs, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // Removed meanwhile.
    }
  }
  return out;
}

async function removeRaw(file: string): Promise<void> {
  await unlink(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

/** One sweep over raw/. Errors on one file are logged and that file is retried on the next sweep. */
export async function sweepOnce(ctx: SweepContext): Promise<SweepResult> {
  const result: SweepResult = { stored: 0, discarded: 0, failed: 0 };
  let dirs: string[];
  try {
    dirs = await readdir(ctx.rawDir);
  } catch {
    return result;
  }
  const cameraStmt = ctx.db.prepare('SELECT id, name, location_id, created_at FROM cameras WHERE id = ?');
  const existsStmt = ctx.db.prepare('SELECT 1 AS one FROM segments WHERE rel_path = ?');
  const insertStmt = ctx.db.prepare(
    'INSERT INTO segments (camera_id, camera_name, location_id, start_at, duration_ms, size_bytes, key_id, rel_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );

  let key: ActiveVaultKey | null;
  try {
    key = loadActiveVaultKey(ctx.db);
  } catch (err) {
    ctx.log(`sweeper: the active vault key cannot be loaded: ${(err as Error).message}`);
    key = null;
  }

  for (const dirName of dirs) {
    const m = RAW_DIR_RE.exec(dirName);
    if (!m) continue;
    const cameraId = Number(m[1]);
    const dir = path.join(ctx.rawDir, dirName);
    const files = await listRawFiles(dir);
    for (const seg of completeSegments(files, ctx.now())) {
      const rawPath = path.join(dir, seg.file.name);
      try {
        const camera = cameraStmt.get(cameraId) as
          | { id: number; name: string; location_id: number; created_at: number }
          | undefined;
        if (!camera || !key || seg.file.size === 0 || seg.file.startMs < camera.created_at) {
          await removeRaw(rawPath);
          result.discarded++;
          continue;
        }
        const relPath = segmentRelPath(camera.location_id, camera.id, seg.file.startMs);
        if (existsStmt.get(relPath)) {
          // Stored before a crash removed the raw file.
          await removeRaw(rawPath);
          continue;
        }
        const { sizeBytes } = await encryptFileToVault(
          rawPath,
          path.join(ctx.vaultDir, ...relPath.split('/')),
          key.publicKey,
          {
            v: 1,
            cameraId: camera.id,
            locationId: camera.location_id,
            start: new Date(seg.file.startMs).toISOString(),
            durationMs: seg.durationMs,
            mime: 'video/mp4',
          },
        );
        insertStmt.run(
          camera.id,
          camera.name,
          camera.location_id,
          seg.file.startMs,
          seg.durationMs,
          sizeBytes,
          key.keyId,
          relPath,
        );
        await removeRaw(rawPath);
        result.stored++;
      } catch (err) {
        result.failed++;
        ctx.log(`sweeper: ${dirName}/${seg.file.name} failed: ${redactUrls((err as Error).message)}`);
      }
    }
  }
  return result;
}
