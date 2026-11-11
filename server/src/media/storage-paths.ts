/**
 * Folders under config.dataDir used by the recording pipeline.
 */

import path from 'node:path';

/** raw/<pathName>/<files>: plain fMP4 segments MediaMTX writes; the sweeper encrypts and removes them. */
export function rawRoot(dataDir: string): string {
  return path.join(dataDir, 'raw');
}

/** vault/<locationId>/<cameraId>/<YYYY-MM-DD UTC>/<startMs>.ccv */
export function vaultRoot(dataDir: string): string {
  return path.join(dataDir, 'vault');
}

/** Relative vault path of a segment (forward slashes, as stored in segments.rel_path). */
export function segmentRelPath(locationId: number, cameraId: number, startMs: number): string {
  const day = new Date(startMs).toISOString().slice(0, 10);
  return `${locationId}/${cameraId}/${day}/${startMs}.ccv`;
}

/** Absolute path of a stored rel_path; null if it would leave the vault folder. */
export function resolveVaultFile(vaultDir: string, relPath: string): string | null {
  if (!/^\d+\/\d+\/\d{4}-\d{2}-\d{2}\/\d+\.ccv$/.test(relPath)) return null;
  const full = path.resolve(vaultDir, ...relPath.split('/'));
  const root = path.resolve(vaultDir) + path.sep;
  return full.startsWith(root) ? full : null;
}
