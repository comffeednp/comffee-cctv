import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { HUB_CONFIG_DEFAULTS, HttpError } from '../../src/contracts.ts';
import type { ConnectorService, MediaManagerDeps } from '../../src/contracts.ts';
import { openDatabase } from '../../src/db.ts';
import { createBox } from '../../src/crypto/box.ts';
import { createMediaManager } from '../../src/media/manager.ts';
import type { MediaMtxClient, MediaMtxPathState } from '../../src/media/mediamtx-api.ts';
import {
  buildCameraPathConfs,
  cameraRtspUrl,
  parseGoDuration,
  pathConfMatches,
  redactUrls,
  transcodeCommand,
} from '../../src/media/paths.ts';
import type { PathEnv } from '../../src/media/paths.ts';

const env: PathEnv = {
  mediamtxRtsp: 'rtsp://127.0.0.1:8554',
  internalUser: 'hub',
  internalPassword: "p@ss w$rd'(x)",
  ffmpegPath: 'ffmpeg',
};
const target = { host: '10.78.3.20', port: 554 };

test('camera URLs carry URL-encoded credentials', () => {
  assert.equal(cameraRtspUrl(target, '/stream1', 'admin', 'a:b@c/d'), 'rtsp://admin:a%3Ab%40c%2Fd@10.78.3.20:554/stream1');
  assert.equal(cameraRtspUrl(target, '/live', '', ''), 'rtsp://10.78.3.20:554/live');
});

test('1080p and 360p pull the camera directly; recording decides record and on-demand', () => {
  const on = buildCameraPathConfs({ id: 4, quality: '1080p', streamPath: '/stream1', username: 'u', password: 'p', record: true }, target, env);
  assert.deepEqual([...on.keys()], ['c4']);
  assert.equal(on.get('c4')?.source, 'rtsp://u:p@10.78.3.20:554/stream1');
  assert.equal(on.get('c4')?.record, true);
  assert.equal(on.get('c4')?.sourceOnDemand, false);
  assert.equal(on.get('c4')?.rtspTransport, 'tcp');
  const off = buildCameraPathConfs({ id: 4, quality: '360p', streamPath: '/stream2', username: 'u', password: 'p', record: false }, target, env);
  assert.equal(off.get('c4')?.source, 'rtsp://u:p@10.78.3.20:554/stream2');
  assert.equal(off.get('c4')?.record, false);
  assert.equal(off.get('c4')?.sourceOnDemand, true);
});

test('720p adds a source path and an ffmpeg job that publishes with the internal credentials', () => {
  const on = buildCameraPathConfs({ id: 7, quality: '720p', streamPath: '/stream1', username: 'u', password: 'p', record: true }, target, env);
  assert.deepEqual([...on.keys()].sort(), ['c7', 'c7_src']);
  const src = on.get('c7_src');
  const view = on.get('c7');
  assert.equal(src?.record, false);
  assert.equal(src?.sourceOnDemand, false);
  assert.equal(view?.source, 'publisher');
  assert.equal(view?.record, true);
  assert.equal(view?.runOnInitRestart, true);
  assert.equal(view?.runOnDemand, '');
  const cmd = String(view?.runOnInit);
  assert.match(cmd, /-i rtsp:\/\/hub:p%40ss%20w%24rd%27%28x%29@127\.0\.0\.1:8554\/c7_src /);
  assert.match(cmd, /rtsp:\/\/hub:[^ ]+@127\.0\.0\.1:8554\/c7$/);
  assert.match(cmd, /scale=-2:720,fps=15/);
  assert.match(cmd, /-b:v 300k/);
  assert.match(cmd, / -an /);
  assert.doesNotMatch(cmd, /[$'"()\\]/, 'nothing the MediaMTX command parser would expand or split');

  const off = buildCameraPathConfs({ id: 7, quality: '720p', streamPath: '/stream1', username: 'u', password: 'p', record: false }, target, env);
  assert.equal(off.get('c7_src')?.sourceOnDemand, true);
  assert.equal(off.get('c7')?.runOnInit, '');
  assert.equal(off.get('c7')?.runOnDemand, transcodeCommand(7, env));
  assert.equal(off.get('c7')?.runOnDemandRestart, true);
});

test('config comparison ignores unrelated keys and normalises durations', () => {
  const desired = { source: 'publisher', record: true, runOnDemandStartTimeout: '20s', runOnInit: '' };
  assert.equal(pathConfMatches({ ...desired, maxReaders: 0, runOnInit: null, runOnDemandStartTimeout: '20s' }, desired), true);
  assert.equal(pathConfMatches({ ...desired, runOnDemandStartTimeout: '0h0m20s' }, desired), true);
  assert.equal(pathConfMatches({ ...desired, record: false }, desired), false);
  assert.equal(pathConfMatches({ ...desired, runOnDemandStartTimeout: '10s' }, desired), false);
  assert.equal(parseGoDuration('1m30s'), 90_000);
  assert.equal(parseGoDuration('500ms'), 500);
  assert.equal(parseGoDuration('abc'), null);
});

test('credentials are hidden in log text', () => {
  assert.equal(redactUrls('failed rtsp://admin:secret@10.0.0.2:554/x'), 'failed rtsp://***@10.0.0.2:554/x');
});

/* ------------------------------------------------------------ manager */

function fakeClient(initial: Record<string, Record<string, unknown>>) {
  const confs = new Map<string, Record<string, unknown>>(Object.entries(initial));
  const calls: string[] = [];
  let states: MediaMtxPathState[] = [];
  const client: MediaMtxClient = {
    async listPathConfs() {
      return new Map([...confs].map(([k, v]) => [k, { ...v, name: k }]));
    },
    async getPathConf(name) {
      const c = confs.get(name);
      return c ? { ...c, name } : null;
    },
    async addPathConf(name, conf) {
      calls.push(`add ${name}`);
      confs.set(name, { ...conf });
    },
    async replacePathConf(name, conf) {
      calls.push(`replace ${name}`);
      confs.set(name, { ...conf });
    },
    async deletePathConf(name) {
      calls.push(`delete ${name}`);
      confs.delete(name);
    },
    async listPaths() {
      return states;
    },
  };
  return { client, confs, calls, setStates: (s: MediaMtxPathState[]) => (states = s) };
}

function managerSetup(db: DatabaseSync, client: MediaMtxClient, offline: Set<number> = new Set()) {
  const box = createBox(randomBytes(32));
  const connectors = {
    async resolveCameraAddress(locationId: number, lanIp: string, port: number) {
      if (offline.has(locationId)) throw new HttpError(503, 'unavailable', 'Bridge not connected');
      return { host: lanIp, port };
    },
  } as unknown as ConnectorService;
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ccv-mgr-'));
  const deps = {
    db,
    box,
    connectors,
    config: { ...HUB_CONFIG_DEFAULTS, dataDir },
    secrets: { masterKey: randomBytes(32), streamTokenKey: randomBytes(32), mediamtxUser: 'hub', mediamtxPassword: 'pw' },
    audit: () => undefined,
  } as unknown as MediaManagerDeps;
  let t = 1_000_000;
  const manager = createMediaManager(deps, { client, now: () => t, log: () => undefined, reachable: async () => true });
  return { manager, box, dataDir, advance: (ms: number) => (t += ms), cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}

function seedCameras(db: DatabaseSync, sealed: string): void {
  db.prepare("INSERT INTO locations (id, name, timezone, connector, created_at) VALUES (1, 'A', 'UTC', 'direct', 0), (2, 'B', 'UTC', 'bridge', 0)").run();
  const cam = db.prepare(
    "INSERT INTO cameras (id, location_id, name, lan_ip, vendor, main_path, sub_path, username, password_enc, quality, recording, created_at) VALUES (?, ?, 'cam', ?, 'tapo', '/stream1', '/stream2', 'u', ?, ?, ?, 0)",
  );
  cam.run(1, 1, '192.168.1.10', sealed, '1080p', 1);
  cam.run(2, 1, '192.168.1.11', sealed, '720p', 1);
  cam.run(3, 2, '192.168.5.12', sealed, '360p', 1);
}

test('reconcile adds, fixes and removes managed paths, keeps unreachable cameras and foreign paths', async () => {
  const db = openDatabase(':memory:');
  const fake = fakeClient({
    c1: { source: 'rtsp://old', record: false },
    c3: { source: 'rtsp://kept-while-offline', record: true },
    c99: { source: 'publisher' },
    other: { source: 'publisher' },
  });
  const { manager, box, dataDir, cleanup } = managerSetup(db, fake.client, new Set([2]));
  seedCameras(db, box.seal('secret'));

  await manager.reconcile();
  assert.deepEqual(fake.calls.sort(), ['add c2', 'add c2_src', 'delete c99', 'replace c1'].sort());
  // No vault key yet: nothing records, sources wait for viewers.
  assert.equal(fake.confs.get('c1')?.record, false);
  assert.equal(fake.confs.get('c1')?.sourceOnDemand, true);
  assert.equal(fake.confs.get('c1')?.source, 'rtsp://u:secret@192.168.1.10:554/stream1');
  assert.equal(fake.confs.get('c3')?.source, 'rtsp://kept-while-offline', 'offline location keeps its paths');
  assert.ok(fake.confs.has('other'), 'paths the hub does not own are left alone');

  fake.calls.length = 0;
  await manager.reconcile();
  assert.deepEqual(fake.calls, [], 'a second reconcile changes nothing');

  db.prepare("INSERT INTO vault_keys (key_id, spki_b64, created_at, active) VALUES ('k', 'x', 0, 1)").run();
  await manager.applyCamera(2);
  assert.deepEqual(fake.calls.sort(), ['replace c2', 'replace c2_src']);
  assert.equal(fake.confs.get('c2')?.record, true);
  assert.notEqual(fake.confs.get('c2')?.runOnInit, '');

  db.prepare('UPDATE locations SET recording_paused = 1 WHERE id = 1').run();
  await manager.applyLocation(1);
  assert.equal(fake.confs.get('c1')?.record, false);
  assert.equal(fake.confs.get('c2')?.record, false);

  db.prepare("UPDATE cameras SET quality = '1080p' WHERE id = 2").run();
  await manager.applyCamera(2);
  assert.equal(fake.confs.has('c2_src'), false, 'source path removed when no longer transcoding');

  const rawFile = (name: string): string => {
    mkdirSync(path.join(dataDir, 'raw', name), { recursive: true });
    const file = path.join(dataDir, 'raw', name, '2026-06-15_11-00-00-000000.mp4');
    writeFileSync(file, 'segment');
    return file;
  };
  const deletedRaw = rawFile('c1');
  const otherRaw = rawFile('c2');
  db.prepare('DELETE FROM cameras WHERE id = 1').run();
  await manager.removeCamera(1);
  assert.equal(fake.confs.has('c1'), false);
  assert.equal(existsSync(deletedRaw), false, 'unfinished segment of the deleted camera is discarded');
  assert.equal(existsSync(otherRaw), true);
  await manager.removeCamera(2);
  assert.equal(existsSync(otherRaw), true, 'kept while a camera row with that id exists');
  cleanup();
});

test('camera status comes from MediaMTX path state, with a bitrate from two samples', async () => {
  const db = openDatabase(':memory:');
  const fake = fakeClient({});
  const { manager, box, advance, cleanup } = managerSetup(db, fake.client);
  seedCameras(db, box.seal('secret'));
  fake.setStates([
    { name: 'c1', online: true, inboundBytes: 1_000_000 },
    { name: 'c2_src', online: true, inboundBytes: 0 },
    { name: 'c2', online: true, inboundBytes: 0 },
  ]);
  assert.deepEqual(await manager.cameraStatus(1), { online: true, bitrateKbps: null });
  advance(10_000);
  fake.setStates([
    { name: 'c1', online: true, inboundBytes: 1_000_000 + 250_000 },
    { name: 'c2_src', online: true, inboundBytes: 1_250_000 },
    { name: 'c2', online: true, inboundBytes: 375_000 },
  ]);
  assert.deepEqual(await manager.cameraStatus(1), { online: true, bitrateKbps: 200 });
  assert.deepEqual(await manager.cameraStatus(2), { online: true, bitrateKbps: 1000 }, 'rate pulled from the camera');
  assert.deepEqual(await manager.cameraStatus(3), { online: false, bitrateKbps: null });
  cleanup();
});
