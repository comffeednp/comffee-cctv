/**
 * MediaManager: keeps MediaMTX paths in line with the database (through the MediaMTX API with the
 * internal credentials), runs the segment sweeper, retention and the disk guard, and reports camera
 * status from the MediaMTX API.
 */

import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Quality } from '../../../shared/api-types.ts';
import { cameraPathName, cameraSourcePathName } from '../contracts.ts';
import type { MediaManager, MediaManagerDeps } from '../contracts.ts';
import { createMediaMtxClient } from './mediamtx-api.ts';
import type { MediaMtxClient, MediaMtxPathState } from './mediamtx-api.ts';
import { MANAGED_PATH_RE, buildCameraPathConfs, pathConfMatches, redactUrls } from './paths.ts';
import type { PathConf, PathEnv } from './paths.ts';
import { rtspReachable } from './probe.ts';
import { runDiskGuard, runRetention } from './retention.ts';
import { rawRoot, vaultRoot } from './storage-paths.ts';
import { sweepOnce } from './sweeper.ts';

export const RECONCILE_INTERVAL_MS = 60_000;
export const SWEEP_INTERVAL_MS = 15_000;
export const RETENTION_INTERVAL_MS = 3_600_000;
/** Path state from MediaMTX is reused this long by cameraStatus. */
const SNAPSHOT_TTL_MS = 3_000;
/** Bitrate needs two samples at least this far apart. */
const RATE_MIN_GAP_MS = 2_000;
const RESOLVE_CONCURRENCY = 8;
const REACH_CONCURRENCY = 4;

export interface MediaManagerOptions {
  client?: MediaMtxClient;
  now?: () => number;
  reachable?: (host: string, port: number) => Promise<boolean>;
  log?: (message: string) => void;
}

interface CameraRow {
  id: number;
  location_id: number;
  lan_ip: string;
  rtsp_port: number;
  main_path: string;
  sub_path: string | null;
  username: string;
  password_enc: string;
  quality: Quality;
  recording: number;
  recording_paused: number;
}

const CAMERA_SELECT = `SELECT c.id, c.location_id, c.lan_ip, c.rtsp_port, c.main_path, c.sub_path, c.username,
  c.password_enc, c.quality, c.recording, l.recording_paused
  FROM cameras c JOIN locations l ON l.id = c.location_id`;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

export function createMediaManager(deps: MediaManagerDeps, options: MediaManagerOptions = {}): MediaManager {
  const { db, config, secrets, box, connectors, audit } = deps;
  const client =
    options.client ?? createMediaMtxClient(config.mediamtxApi, secrets.mediamtxUser, secrets.mediamtxPassword);
  const now = options.now ?? Date.now;
  const reachable = options.reachable ?? ((host: string, port: number) => rtspReachable(host, port));
  const log = options.log ?? ((message: string) => console.error(`[media] ${redactUrls(message)}`));
  const rawDir = rawRoot(config.dataDir);
  const vaultDir = vaultRoot(config.dataDir);
  const env: PathEnv = {
    mediamtxRtsp: config.mediamtxRtsp,
    internalUser: secrets.mediamtxUser,
    internalPassword: secrets.mediamtxPassword,
    ffmpegPath: config.ffmpegPath,
  };

  const cameraStmt = db.prepare(`${CAMERA_SELECT} WHERE c.id = ?`);
  const allCamerasStmt = db.prepare(`${CAMERA_SELECT} ORDER BY c.id`);
  const activeKeyStmt = db.prepare('SELECT 1 AS one FROM vault_keys WHERE active = 1 LIMIT 1');
  const cameraExistsStmt = db.prepare('SELECT 1 AS one FROM cameras WHERE id = ?');

  /* -------------------------------------------------------- path changes */

  // Every change to MediaMTX paths runs one at a time, in order.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  function hasActiveKey(): boolean {
    return activeKeyStmt.get() !== undefined;
  }

  /** Desired paths for one camera; null when the camera cannot be reached right now (keep what exists). */
  async function desiredFor(row: CameraRow, keyExists: boolean): Promise<Map<string, PathConf> | null> {
    let password: string;
    try {
      password = box.open(row.password_enc);
    } catch {
      log(`camera ${row.id}: stored password cannot be opened`);
      return null;
    }
    let target: { host: string; port: number };
    try {
      target = await connectors.resolveCameraAddress(row.location_id, row.lan_ip, row.rtsp_port);
    } catch {
      return null;
    }
    const streamPath = row.quality === '360p' ? (row.sub_path ?? row.main_path) : row.main_path;
    return buildCameraPathConfs(
      {
        id: row.id,
        quality: row.quality,
        streamPath,
        username: row.username,
        password,
        record: row.recording === 1 && row.recording_paused === 0 && keyExists,
      },
      target,
      env,
    );
  }

  async function applyOne(name: string, desired: PathConf | undefined, current: Record<string, unknown> | null): Promise<void> {
    try {
      if (desired && !current) await client.addPathConf(name, desired);
      else if (desired && current && !pathConfMatches(current, desired)) await client.replacePathConf(name, desired);
      else if (!desired && current) await client.deletePathConf(name);
    } catch (err) {
      log(`path ${name}: ${(err as Error).message}`);
      throw err;
    }
  }

  async function reconcileNow(): Promise<void> {
    const keyExists = hasActiveKey();
    const rows = allCamerasStmt.all() as unknown as CameraRow[];
    const current = await client.listPathConfs();
    const wanted = await mapLimit(rows, RESOLVE_CONCURRENCY, (row) => desiredFor(row, keyExists));
    const desired = new Map<string, PathConf>();
    const keep = new Set<string>();
    rows.forEach((row, i) => {
      const confs = wanted[i];
      if (confs) {
        for (const [name, conf] of confs) desired.set(name, conf);
      } else {
        keep.add(cameraPathName(row.id));
        keep.add(cameraSourcePathName(row.id));
      }
    });
    for (const [name, conf] of desired) {
      await applyOne(name, conf, current.get(name) ?? null).catch(() => undefined);
    }
    for (const name of current.keys()) {
      if (MANAGED_PATH_RE.test(name) && !desired.has(name) && !keep.has(name)) {
        await applyOne(name, undefined, current.get(name) ?? null).catch(() => undefined);
      }
    }
  }

  async function applyCameraNow(cameraId: number): Promise<void> {
    const names = [cameraPathName(cameraId), cameraSourcePathName(cameraId)];
    const row = cameraStmt.get(cameraId) as unknown as CameraRow | undefined;
    if (!row) {
      for (const name of names) await client.deletePathConf(name);
      reach.delete(cameraId);
      return;
    }
    const desired = await desiredFor(row, hasActiveKey());
    if (!desired) return;
    for (const name of names) {
      await applyOne(name, desired.get(name), await client.getPathConf(name));
    }
  }

  /* -------------------------------------------------------- camera status */

  let snapshot: { at: number; paths: Map<string, MediaMtxPathState> } | null = null;
  let snapshotPending: Promise<Map<string, MediaMtxPathState>> | null = null;
  const samples = new Map<string, { at: number; bytes: number }>();
  const rates = new Map<string, number>();
  const reach = new Map<number, boolean>();

  function recordSamples(states: MediaMtxPathState[], at: number): void {
    for (const s of states) {
      const prev = samples.get(s.name);
      if (!prev || s.inboundBytes < prev.bytes) {
        samples.set(s.name, { at, bytes: s.inboundBytes });
        rates.delete(s.name);
        continue;
      }
      const gap = at - prev.at;
      if (gap < RATE_MIN_GAP_MS) continue;
      // bytes * 8 / ms = kbit/s
      rates.set(s.name, Math.round(((s.inboundBytes - prev.bytes) * 8) / gap));
      samples.set(s.name, { at, bytes: s.inboundBytes });
    }
    const names = new Set(states.map((s) => s.name));
    for (const name of samples.keys()) {
      if (!names.has(name)) {
        samples.delete(name);
        rates.delete(name);
      }
    }
  }

  function pathsSnapshot(force = false): Promise<Map<string, MediaMtxPathState>> {
    const t = now();
    if (!force && snapshot && t - snapshot.at < SNAPSHOT_TTL_MS) return Promise.resolve(snapshot.paths);
    if (snapshotPending) return snapshotPending;
    snapshotPending = client
      .listPaths()
      .then((states) => {
        const at = now();
        recordSamples(states, at);
        const paths = new Map(states.map((s) => [s.name, s]));
        snapshot = { at, paths };
        return paths;
      })
      .finally(() => {
        snapshotPending = null;
      });
    return snapshotPending;
  }

  /** Cameras pulled only on demand are checked with a light RTSP request so their status is not always "offline". */
  async function refreshReachability(): Promise<void> {
    const paths = await pathsSnapshot(true).catch(() => null);
    if (!paths) return;
    const keyExists = hasActiveKey();
    const rows = allCamerasStmt.all() as unknown as CameraRow[];
    const ids = new Set(rows.map((r) => r.id));
    for (const id of reach.keys()) if (!ids.has(id)) reach.delete(id);
    const idle = rows.filter((row) => {
      const recording = row.recording === 1 && row.recording_paused === 0 && keyExists;
      const online = paths.get(cameraPathName(row.id))?.online || paths.get(cameraSourcePathName(row.id))?.online;
      if (online) reach.set(row.id, true);
      return !recording && !online;
    });
    await mapLimit(idle, REACH_CONCURRENCY, async (row) => {
      try {
        const target = await connectors.resolveCameraAddress(row.location_id, row.lan_ip, row.rtsp_port);
        reach.set(row.id, await reachable(target.host, target.port));
      } catch {
        reach.set(row.id, false);
      }
    });
  }

  /* -------------------------------------------------------- recording pipeline */

  let sweeping: Promise<void> | null = null;
  function sweepAndGuard(): Promise<void> {
    if (sweeping) return sweeping;
    sweeping = (async () => {
      try {
        await sweepOnce({ db, rawDir, vaultDir, now, log });
      } catch (err) {
        log(`sweep failed: ${(err as Error).message}`);
      }
      try {
        const guard = await runDiskGuard(db, vaultDir, undefined, log);
        if (guard.deleted > 0) {
          const freedMiB = Math.round(guard.freedBytes / 1048576);
          audit({
            userId: null,
            username: 'system',
            action: 'storage.prune',
            target: 'storage',
            detail: `Low disk space: deleted the ${guard.deleted} oldest recordings (${freedMiB} MiB)`,
          });
        }
      } catch (err) {
        log(`disk guard failed: ${(err as Error).message}`);
      }
    })().finally(() => {
      sweeping = null;
    });
    return sweeping;
  }

  let retaining: Promise<void> | null = null;
  function retention(): Promise<void> {
    if (retaining) return retaining;
    retaining = runRetention(db, vaultDir, now(), log)
      .then(() => undefined)
      .catch((err: Error) => log(`retention failed: ${err.message}`))
      .finally(() => {
        retaining = null;
      });
    return retaining;
  }

  /* -------------------------------------------------------- lifecycle */

  const timers: ReturnType<typeof setInterval>[] = [];
  let reconcileTick: Promise<void> | null = null;
  let stopped = false;

  function periodicReconcile(): Promise<void> {
    if (reconcileTick) return reconcileTick;
    reconcileTick = (async () => {
      try {
        await manager.reconcile();
      } catch (err) {
        log(`reconcile failed: ${(err as Error).message}`);
      }
      await refreshReachability().catch(() => undefined);
    })().finally(() => {
      reconcileTick = null;
    });
    return reconcileTick;
  }

  const manager: MediaManager = {
    async start() {
      stopped = false;
      await mkdir(rawDir, { recursive: true, mode: 0o700 });
      await mkdir(vaultDir, { recursive: true, mode: 0o700 });
      await retention();
      await periodicReconcile();
      void sweepAndGuard();
      if (stopped) return;
      timers.push(
        setInterval(() => void periodicReconcile(), RECONCILE_INTERVAL_MS),
        setInterval(() => void sweepAndGuard(), SWEEP_INTERVAL_MS),
        setInterval(() => void retention(), RETENTION_INTERVAL_MS),
      );
      for (const t of timers) t.unref();
    },

    async stop() {
      stopped = true;
      for (const t of timers.splice(0)) clearInterval(t);
      await Promise.allSettled([sweeping, retaining, reconcileTick, queue]);
    },

    reconcile() {
      return serial(reconcileNow);
    },

    applyCamera(cameraId: number) {
      return serial(() => applyCameraNow(cameraId));
    },

    removeCamera(cameraId: number) {
      return serial(async () => {
        await client.deletePathConf(cameraPathName(cameraId));
        await client.deletePathConf(cameraSourcePathName(cameraId));
        reach.delete(cameraId);
        // The unfinished last segment of a deleted camera is discarded now, so it can never be swept in
        // under a later camera. Skipped when a camera row with this id exists again: the sweeper then
        // drops files older than that row.
        if (Number.isSafeInteger(cameraId) && cameraId > 0 && cameraExistsStmt.get(cameraId) === undefined) {
          await rm(path.join(rawDir, cameraPathName(cameraId)), { recursive: true, force: true }).catch((err: Error) =>
            log(`camera ${cameraId}: raw files could not be removed: ${err.message}`),
          );
        }
      });
    },

    applyLocation(_locationId: number) {
      // Pause, connector and address changes can touch every camera of the location (or remove them all).
      return serial(reconcileNow);
    },

    async cameraStatus(cameraId: number) {
      let paths: Map<string, MediaMtxPathState>;
      try {
        paths = await pathsSnapshot();
      } catch {
        return { online: false, bitrateKbps: null };
      }
      const view = paths.get(cameraPathName(cameraId));
      const src = paths.get(cameraSourcePathName(cameraId));
      if (view?.online || src?.online) {
        // Bitrate of the stream pulled from the camera (what the business uploads).
        const pulled = src ?? view;
        return { online: true, bitrateKbps: pulled ? (rates.get(pulled.name) ?? null) : null };
      }
      return { online: reach.get(cameraId) ?? false, bitrateKbps: null };
    },
  };

  return manager;
}

