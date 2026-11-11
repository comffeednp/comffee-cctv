import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RecordingDaysResponse, RecordingsPage } from '../../../shared/api-types.ts';
import { HttpError } from '../../src/contracts.ts';
import type { AppDeps, AuthHelpers, SessionUser } from '../../src/contracts.ts';
import { openDatabase } from '../../src/db.ts';
import { createAuditWriter } from '../../src/audit.ts';
import { registerRecordingRoutes } from '../../src/api/recordings.ts';
import { segmentRelPath, vaultRoot } from '../../src/media/storage-paths.ts';

const dataDir = mkdtempSync(path.join(tmpdir(), 'ccv-rec-'));
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const MIN = 60_000;
const T0 = Date.parse('2026-03-01T17:00:00.000Z');
/** Locations are created before any of their footage. */
const LOCATIONS_CREATED = Date.parse('2026-01-01T00:00:00.000Z');

function seed(): DatabaseSync {
  const db = openDatabase(':memory:');
  const t = Date.now();
  const user = db.prepare(
    'INSERT INTO users (id, username, password_hash, role, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  user.run(1, 'owner', 'x', 'owner', t, t);
  user.run(2, 'viewer', 'x', 'viewer', t, t);
  user.run(3, 'nobody', 'x', 'viewer', t, t);
  const loc = db.prepare("INSERT INTO locations (id, name, timezone, connector, created_at) VALUES (?, ?, ?, 'direct', ?)");
  loc.run(1, 'Front', 'Asia/Manila', LOCATIONS_CREATED);
  loc.run(2, 'Back', 'UTC', LOCATIONS_CREATED);
  db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (2, 1)').run();
  const cam = db.prepare(
    "INSERT INTO cameras (id, location_id, name, lan_ip, vendor, main_path, username, password_enc, created_at) VALUES (?, ?, ?, ?, 'tapo', '/stream1', 'u', 'x', ?)",
  );
  cam.run(1, 1, 'Door', '192.168.1.10', t);
  cam.run(2, 2, 'Yard', '192.168.1.11', t);
  cam.run(3, 1, 'Hall', '192.168.1.12', t);
  const seg = db.prepare(
    'INSERT INTO segments (id, camera_id, camera_name, location_id, start_at, duration_ms, size_bytes, key_id, rel_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const vault = vaultRoot(dataDir);
  const add = (id: number, cameraId: number, locationId: number, start: number, duration = 5 * MIN): void => {
    const rel = segmentRelPath(locationId, cameraId, start);
    const file = path.join(vault, ...rel.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(`segment-${id}`));
    seg.run(id, cameraId, cameraId === 1 ? 'Door' : 'Yard', locationId, start, duration, 9, 'ab'.repeat(16), rel);
  };
  // Location 1 (viewer 2 may see it): five back-to-back segments from 17:00 UTC (01:00 Manila, next day).
  for (let i = 0; i < 5; i++) add(10 + i, 1, 1, T0 + i * 5 * MIN);
  // Another camera with the same start time (ids break the tie in pagination).
  add(20, 3, 1, T0 + 2 * 5 * MIN);
  // Location 2: three segments.
  for (let i = 0; i < 3; i++) add(30 + i, 2, 2, T0 + i * 5 * MIN);
  // Feb 28 16:30 UTC = Mar 1 00:30 Manila; Mar 31 16:30 UTC = Apr 1 00:30 Manila.
  add(40, 1, 1, Date.parse('2026-02-28T16:30:00.000Z'));
  add(41, 1, 1, Date.parse('2026-03-31T16:30:00.000Z'));
  // Crosses Manila midnight (Mar 10 15:58 UTC -> 16:03 UTC, midnight is 16:00 UTC).
  add(42, 1, 1, Date.parse('2026-03-10T15:58:00.000Z'));
  return db;
}

function testAuth(db: DatabaseSync): AuthHelpers {
  const userOf = (req: FastifyRequest): SessionUser => {
    const id = Number(req.headers['x-test-user']);
    const row = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id) as
      | { id: number; username: string; role: 'owner' | 'viewer' }
      | undefined;
    if (!row) throw new HttpError(401, 'not_signed_in', 'Not signed in');
    const ids = (db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(id) as { location_id: number }[]).map(
      (r) => r.location_id,
    );
    return { id: row.id, username: row.username, role: row.role, locationIds: row.role === 'owner' ? 'all' : ids };
  };
  const can = (user: SessionUser, locationId: number): boolean =>
    user.locationIds === 'all' || user.locationIds.includes(locationId);
  return {
    requireUser: userOf,
    requireOwner(req) {
      const u = userOf(req);
      if (u.role !== 'owner') throw new HttpError(403, 'owner_only', 'Owner only');
      return u;
    },
    canAccessLocation: can,
    assertLocationAccess(user, locationId) {
      const exists = db.prepare('SELECT 1 AS one FROM locations WHERE id = ?').get(locationId) !== undefined;
      if (!exists || !can(user, locationId)) throw new HttpError(404, 'not_found', 'Not found');
    },
    verifyPassword: async () => false,
    userCanStillView: () => false,
  };
}

async function makeApp(db: DatabaseSync): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    return reply.code(500).send({ error: { code: 'internal', message: String(err) } });
  });
  const config = { dataDir } as AppDeps['config'];
  registerRecordingRoutes(app, { db, config, auth: testAuth(db), audit: createAuditWriter(db) } as unknown as AppDeps);
  await app.ready();
  return app;
}

async function get(app: FastifyInstance, user: number, url: string): Promise<{ status: number; json: unknown; body: string }> {
  const res = await app.inject({ method: 'GET', url, headers: { 'x-test-user': String(user) } });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    // Binary body.
  }
  return { status: res.statusCode, json, body: res.body };
}

test('viewers only list recordings of their own locations; other locations and cameras are 404', async () => {
  const db = seed();
  const app = await makeApp(db);
  const mine = (await get(app, 2, '/api/recordings?limit=500')).json as RecordingsPage;
  assert.ok(mine.items.length > 0);
  assert.ok(mine.items.every((i) => i.locationId === 1));
  assert.equal((await get(app, 2, '/api/recordings?locationId=2')).status, 404);
  assert.equal((await get(app, 2, '/api/recordings?cameraId=2')).status, 404);
  assert.equal((await get(app, 2, '/api/recordings?locationId=999')).status, 404);
  const none = (await get(app, 3, '/api/recordings')).json as RecordingsPage;
  assert.deepEqual(none, { items: [], nextCursor: null });
  const all = (await get(app, 1, '/api/recordings?limit=500')).json as RecordingsPage;
  assert.equal(all.items.length, db.prepare('SELECT COUNT(*) AS n FROM segments').get()?.n);
  await app.close();
});

test('keyset pagination walks every recording once, in both orders', async () => {
  const db = seed();
  const app = await makeApp(db);
  for (const order of ['desc', 'asc'] as const) {
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = `/api/recordings?order=${order}&limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const page = (await get(app, 1, url)).json as RecordingsPage;
      assert.ok(page.items.length <= 3);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    const expected = (
      db.prepare(`SELECT id FROM segments ORDER BY start_at ${order}, id ${order}`).all() as { id: number }[]
    ).map((r) => r.id);
    assert.deepEqual(seen, expected, order);
  }
  const first = (await get(app, 1, '/api/recordings?order=desc&limit=2')).json as RecordingsPage;
  assert.ok(first.nextCursor);
  assert.equal((await get(app, 1, `/api/recordings?order=asc&cursor=${first.nextCursor}`)).status, 422, 'cursor from the other order');
  assert.equal((await get(app, 1, '/api/recordings?cursor=garbage!')).status, 422);
  assert.equal((await get(app, 1, '/api/recordings?limit=501')).status, 422);
  assert.equal((await get(app, 1, '/api/recordings?order=up')).status, 422);
  assert.equal((await get(app, 1, '/api/recordings?from=yesterday')).status, 422);
  await app.close();
});

test('from and to select segments that overlap the window', async () => {
  const db = seed();
  const app = await makeApp(db);
  const from = new Date(T0 + 7 * MIN).toISOString(); // inside segment 11 (17:05-17:10)
  const to = new Date(T0 + 10 * MIN).toISOString(); // segment 12 starts exactly here: excluded
  const page = (await get(app, 1, `/api/recordings?locationId=1&from=${from}&to=${to}&order=asc`)).json as RecordingsPage;
  assert.deepEqual(page.items.map((i) => i.id), [11]);
  assert.equal(page.items[0]?.end, new Date(T0 + 10 * MIN).toISOString());
  await app.close();
});

test('days are counted in the location timezone', async () => {
  const db = seed();
  const app = await makeApp(db);
  const res = (await get(app, 2, '/api/recordings/days?locationId=1&month=2026-03')).json as RecordingDaysResponse;
  const byDate = new Map(res.days.map((d) => [d.date, d]));
  assert.equal(byDate.get('2026-03-01')?.segmentCount, 1, 'Feb 28 16:30 UTC is Mar 1 in Manila');
  assert.equal(byDate.get('2026-03-02')?.segmentCount, 6, '17:00 UTC is the next day in Manila');
  // Five back-to-back segments plus one overlapping copy: 25 covered minutes, not 30.
  assert.equal(byDate.get('2026-03-02')?.coveredMinutes, 25);
  assert.equal(byDate.get('2026-03-10')?.coveredMinutes, 2, 'part before Manila midnight');
  assert.equal(byDate.get('2026-03-11')?.coveredMinutes, 3, 'part after Manila midnight');
  assert.equal(byDate.has('2026-03-31'), false);
  assert.equal(byDate.has('2026-04-01'), false, 'Mar 31 16:30 UTC is April in Manila');
  assert.equal((await get(app, 2, '/api/recordings/days?locationId=2&month=2026-03')).status, 404);
  assert.equal((await get(app, 2, '/api/recordings/days?locationId=1&month=2026-13')).status, 422);
  assert.equal((await get(app, 2, '/api/recordings/days?month=2026-03')).status, 422);
  await app.close();
});

test('file download is scoped, sends the stored bytes and is audited', async () => {
  const db = seed();
  const app = await makeApp(db);
  assert.equal((await get(app, 2, '/api/recordings/30/file')).status, 404, 'other location');
  assert.equal((await get(app, 2, '/api/recordings/9999/file')).status, 404);
  assert.equal((await get(app, 2, '/api/recordings/abc/file')).status, 404);
  const res = await app.inject({ method: 'GET', url: '/api/recordings/10/file', headers: { 'x-test-user': '2' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.equal(res.headers['content-length'], String('segment-10'.length));
  assert.equal(res.body, 'segment-10');
  const audit = db.prepare("SELECT user_id, action, target FROM audit_log WHERE action = 'recording.download'").all();
  assert.deepEqual(audit.map((r) => ({ ...r })), [{ user_id: 2, action: 'recording.download', target: 'segment:10' }]);
  await app.close();
});

test('footage of a deleted location is never shown under a new location that got the same id', async () => {
  const db = seed();
  const app = await makeApp(db);
  // Location 2 is deleted (its segments 30-32 are kept) and a new location receives id 2 later.
  db.prepare('DELETE FROM locations WHERE id = 2').run();
  db.prepare("INSERT INTO locations (id, name, timezone, connector, created_at) VALUES (2, 'New', 'UTC', 'direct', ?)").run(
    Date.parse('2026-06-01T00:00:00.000Z'),
  );
  db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (3, 2)').run();

  const scoped = (await get(app, 3, '/api/recordings?limit=500')).json as RecordingsPage;
  assert.deepEqual(scoped.items, [], 'viewer of the new location');
  const filtered = (await get(app, 3, '/api/recordings?locationId=2')).json as RecordingsPage;
  assert.deepEqual(filtered.items, []);
  assert.equal((await get(app, 3, '/api/recordings/30/file')).status, 404);
  const days = (await get(app, 3, '/api/recordings/days?locationId=2&month=2026-03')).json as RecordingDaysResponse;
  assert.deepEqual(days.days, []);
  const ownerFiltered = (await get(app, 1, '/api/recordings?locationId=2')).json as RecordingsPage;
  assert.deepEqual(ownerFiltered.items, [], 'not counted as the new location for the owner either');
  const ownerAll = (await get(app, 1, '/api/recordings?limit=500')).json as RecordingsPage;
  assert.ok(ownerAll.items.some((i) => i.id === 30), 'the owner still reaches the kept footage');
  assert.equal((await get(app, 1, '/api/recordings/30/file')).status, 200);
  await app.close();
});
