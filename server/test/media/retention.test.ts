import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { bytesToBase64, exportSpki, generateVaultKeyPair, keyIdFromSpki, openVaultFile } from '../../../shared/vault-format.ts';
import { openDatabase } from '../../src/db.ts';
import {
  MIN_FREE_FLOOR_BYTES,
  minFreeBytes,
  runDiskGuard,
  runRetention,
  selectExpiredSegments,
} from '../../src/media/retention.ts';
import { segmentRelPath } from '../../src/media/storage-paths.ts';
import { completeSegments, parseSegmentStart, sweepOnce } from '../../src/media/sweeper.ts';
import type { RawFile } from '../../src/media/sweeper.ts';

const DAY = 86_400_000;
const MIN = 60_000;
const NOW = Date.parse('2026-06-15T12:00:00.000Z');
const root = mkdtempSync(path.join(tmpdir(), 'ccv-ret-'));
test.after(() => rmSync(root, { recursive: true, force: true }));

function baseDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  const loc = db.prepare("INSERT INTO locations (id, name, timezone, connector, retention_days, created_at) VALUES (?, ?, 'UTC', 'direct', ?, 0)");
  loc.run(1, 'Short', 1);
  loc.run(2, 'Long', 20);
  const cam = db.prepare(
    "INSERT INTO cameras (id, location_id, name, lan_ip, vendor, main_path, username, password_enc, created_at) VALUES (?, ?, ?, ?, 'tapo', '/stream1', 'u', 'x', 0)",
  );
  cam.run(1, 1, 'Door', '192.168.1.10');
  cam.run(2, 2, 'Yard', '192.168.1.11');
  return db;
}

function addSegment(db: DatabaseSync, vaultDir: string, id: number, cameraId: number, locationId: number, start: number, size = 100): string {
  const rel = segmentRelPath(locationId, cameraId, start);
  const file = path.join(vaultDir, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.alloc(size, 1));
  db.prepare(
    'INSERT INTO segments (id, camera_id, camera_name, location_id, start_at, duration_ms, size_bytes, key_id, rel_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, cameraId, 'cam', locationId, start, 5 * MIN, size, 'ab'.repeat(16), rel);
  return file;
}

test('retention selects segments whose end is older than each location keeps them', () => {
  const db = baseDb();
  const vault = path.join(root, 'sel');
  addSegment(db, vault, 1, 1, 1, NOW - DAY - 6 * MIN); // ended 1 day + 1 min ago: expired (1 day)
  addSegment(db, vault, 2, 1, 1, NOW - DAY - 4 * MIN); // ends 1 min inside the window: kept
  addSegment(db, vault, 3, 2, 2, NOW - 2 * DAY); // location keeps 20 days: kept
  addSegment(db, vault, 4, 2, 2, NOW - 21 * DAY); // expired
  addSegment(db, vault, 5, 9, 99, NOW - 21 * DAY); // deleted location: default 20 days, expired
  addSegment(db, vault, 6, 9, 99, NOW - 19 * DAY); // deleted location, kept
  const ids = selectExpiredSegments(db, NOW).map((r) => r.id).sort();
  assert.deepEqual(ids, [1, 4, 5]);
  assert.equal(selectExpiredSegments(db, NOW, 2).length, 2, 'limit');
});

test('runRetention removes files and rows and tidies empty folders', async () => {
  const db = baseDb();
  const vault = path.join(root, 'run');
  const expired = addSegment(db, vault, 1, 1, 1, NOW - 3 * DAY);
  const kept = addSegment(db, vault, 2, 2, 2, NOW - 3 * DAY);
  assert.equal(await runRetention(db, vault, NOW), 1);
  assert.equal(existsSync(expired), false);
  assert.equal(existsSync(path.dirname(expired)), false, 'empty day folder removed');
  assert.equal(existsSync(kept), true);
  assert.equal(existsSync(vault), true, 'vault root stays');
  assert.deepEqual((db.prepare('SELECT id FROM segments').all() as { id: number }[]).map((r) => r.id), [2]);
});

test('disk guard threshold is max(10% of disk, 5 GiB)', () => {
  assert.equal(minFreeBytes(20 * 1024 ** 3), MIN_FREE_FLOOR_BYTES);
  assert.equal(minFreeBytes(200 * 1024 ** 3), 20 * 1024 ** 3);
});

test('disk guard deletes the oldest recordings across locations until free space is back', async () => {
  const db = baseDb();
  const vault = path.join(root, 'guard');
  const total = 100 * 1024 ** 3;
  const threshold = minFreeBytes(total);
  let free = threshold - 250; // 250 bytes short
  addSegment(db, vault, 1, 2, 2, NOW - 5 * DAY, 100); // oldest
  addSegment(db, vault, 2, 1, 1, NOW - 4 * DAY, 100);
  addSegment(db, vault, 3, 2, 2, NOW - 3 * DAY, 100);
  addSegment(db, vault, 4, 1, 1, NOW - 2 * DAY, 100); // newest
  const sizes = new Map([1, 2, 3, 4].map((id) => [id, 100]));
  const spaceOf = async () => {
    const remaining = (db.prepare('SELECT id FROM segments').all() as { id: number }[]).map((r) => r.id);
    const deleted = [...sizes.keys()].filter((id) => !remaining.includes(id)).length;
    return { totalBytes: total, freeBytes: free + deleted * 100 };
  };
  const result = await runDiskGuard(db, vault, spaceOf);
  assert.equal(result.deleted, 3);
  assert.deepEqual((db.prepare('SELECT id FROM segments').all() as { id: number }[]).map((r) => r.id), [4]);
  free = threshold + 1;
  assert.equal((await runDiskGuard(db, vault, spaceOf)).deleted, 0, 'nothing deleted with enough space');
});

test('segment file names give UTC start times', () => {
  assert.equal(parseSegmentStart('2026-06-15_11-50-00-123456.mp4'), Date.parse('2026-06-15T11:50:00.123Z'));
  assert.equal(parseSegmentStart('2026-06-15_11-50-00-123456.mp4.part'), null);
  assert.equal(parseSegmentStart('2026-13-15_11-50-00-123456.mp4'), null);
  assert.equal(parseSegmentStart('notes.txt'), null);
});

test('only finished files are swept, with durations from the next start or the file time', () => {
  const f = (name: string, mtimeMs: number): RawFile => ({ name, startMs: parseSegmentStart(name) as number, mtimeMs, size: 1 });
  const a = f('2026-06-15_11-00-00-000000.mp4', Date.parse('2026-06-15T11:05:00Z'));
  const gap = f('2026-06-15_11-05-00-000000.mp4', Date.parse('2026-06-15T11:07:00Z')); // camera dropped after 2 min
  const b = f('2026-06-15_11-30-00-000000.mp4', NOW - 2 * MIN); // newest, still being written
  const done = completeSegments([b, gap, a], NOW);
  assert.deepEqual(done.map((d) => [d.file.name, d.durationMs]), [
    [a.name, 5 * MIN],
    [gap.name, 2 * MIN],
  ]);
  const settled = completeSegments([b], NOW + 10 * MIN);
  assert.deepEqual(settled.map((d) => d.durationMs), [28 * MIN]);
});

test('sweepOnce encrypts finished segments, records them and removes the raw files', async () => {
  const db = baseDb();
  const rawDir = path.join(root, 'sweep', 'raw');
  const vaultDir = path.join(root, 'sweep', 'vault');
  const pair = await generateVaultKeyPair();
  const spki = await exportSpki(pair.publicKey);
  const keyId = await keyIdFromSpki(spki);

  const write = (dir: string, name: string, body: string, mtimeMs: number): string => {
    mkdirSync(path.join(rawDir, dir), { recursive: true });
    const file = path.join(rawDir, dir, name);
    writeFileSync(file, body);
    utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return file;
  };
  const oldMtime = NOW - 30 * MIN;
  const first = write('c1', '2026-06-15_11-00-00-000000.mp4', 'first segment', oldMtime);
  const newest = write('c1', '2026-06-15_11-55-00-000000.mp4', 'still recording', NOW - MIN);
  const unknown = write('c77', '2026-06-15_11-00-00-000000.mp4', 'deleted camera', oldMtime);
  const log: string[] = [];
  const ctx = { db, rawDir, vaultDir, now: () => NOW, log: (m: string) => log.push(m) };

  // No vault key yet: finished raw files are dropped, nothing is stored.
  const noKey = await sweepOnce(ctx);
  assert.equal(noKey.stored, 0);
  assert.equal(existsSync(first), false);
  assert.equal(existsSync(unknown), false);
  assert.equal(existsSync(newest), true);

  db.prepare('INSERT INTO vault_keys (key_id, spki_b64, created_at, active) VALUES (?, ?, 0, 1)').run(keyId, bytesToBase64(spki));
  const again = write('c1', '2026-06-15_11-00-00-000000.mp4', 'first segment', oldMtime);
  const result = await sweepOnce(ctx);
  assert.deepEqual(result, { stored: 1, discarded: 0, failed: 0 }, log.join('\n'));
  assert.equal(existsSync(again), false);
  assert.equal(existsSync(newest), true, 'the newest file is still being written');

  const row = db.prepare('SELECT * FROM segments').get() as Record<string, unknown>;
  assert.equal(row.camera_id, 1);
  assert.equal(row.camera_name, 'Door');
  assert.equal(row.location_id, 1);
  assert.equal(row.start_at, Date.parse('2026-06-15T11:00:00Z'));
  assert.equal(row.duration_ms, 30 * MIN, 'last written at 11:30; the gap until the next file is not counted');
  assert.equal(row.key_id, keyId);
  const stored = new Uint8Array(readFileSync(path.join(vaultDir, ...(row.rel_path as string).split('/'))));
  assert.equal(stored.length, row.size_bytes);
  const opened = await openVaultFile(stored, pair.privateKey);
  assert.equal(Buffer.from(opened.plain).toString(), 'first segment');
  assert.equal(opened.header.meta.cameraId, 1);
  assert.equal(opened.header.meta.start, '2026-06-15T11:00:00.000Z');

  // Camera 2 was deleted and a new camera received id 2 at another location: the old raw file is dropped.
  db.prepare('DELETE FROM cameras WHERE id = 2').run();
  db.prepare(
    "INSERT INTO cameras (id, location_id, name, lan_ip, vendor, main_path, username, password_enc, created_at) VALUES (2, 1, 'New', '192.168.1.20', 'tapo', '/s', 'u', 'x', ?)",
  ).run(NOW - 20 * MIN);
  const leftover = write('c2', '2026-06-15_11-20-00-000000.mp4', 'old camera', oldMtime);
  const own = write('c2', '2026-06-15_11-45-00-000000.mp4', 'new camera', NOW - 10 * MIN);
  const reused = await sweepOnce(ctx);
  assert.equal(existsSync(leftover), false);
  assert.equal(existsSync(own), false);
  assert.deepEqual(reused, { stored: 1, discarded: 1, failed: 0 }, log.join('\n'));
  const rows = db.prepare('SELECT camera_id, location_id, start_at FROM segments WHERE camera_id = 2').all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ camera_id: 2, location_id: 1, start_at: Date.parse('2026-06-15T11:45:00Z') }]);
});
