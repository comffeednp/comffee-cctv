import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CameraSummary, CamerasResponse } from '../../../shared/api-types.ts';
import { HUB_CONFIG_DEFAULTS, HttpError } from '../../src/contracts.ts';
import type { AppDeps, AuthHelpers, SessionUser } from '../../src/contracts.ts';
import { openDatabase } from '../../src/db.ts';
import { createBox } from '../../src/crypto/box.ts';
import { registerCameraRoutes } from '../../src/api/cameras.ts';

function seed(): DatabaseSync {
  const db = openDatabase(':memory:');
  const user = db.prepare('INSERT INTO users (id, username, password_hash, role, created_at, password_changed_at) VALUES (?, ?, ?, ?, 0, 0)');
  user.run(1, 'owner', 'x', 'owner');
  user.run(2, 'viewer', 'x', 'viewer');
  const loc = db.prepare('INSERT INTO locations (id, name, timezone, connector, slot, camera_subnet, created_at) VALUES (?, ?, ?, ?, ?, ?, 0)');
  loc.run(1, 'Direct', 'UTC', 'direct', null, null);
  loc.run(2, 'Router', 'UTC', 'router', 3, '192.168.1.0/24');
  loc.run(3, 'Bridge', 'UTC', 'bridge', null, null);
  db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (2, 1)').run();
  return db;
}

function testAuth(db: DatabaseSync): AuthHelpers {
  const userOf = (req: FastifyRequest): SessionUser => {
    const id = Number(req.headers['x-test-user']);
    const row = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id) as
      | { id: number; username: string; role: 'owner' | 'viewer' }
      | undefined;
    if (!row) throw new HttpError(401, 'not_signed_in', 'Not signed in');
    const ids = (db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(id) as { location_id: number }[]).map((r) => r.location_id);
    return { id: row.id, username: row.username, role: row.role, locationIds: row.role === 'owner' ? 'all' : ids };
  };
  const can = (u: SessionUser, l: number): boolean => u.locationIds === 'all' || u.locationIds.includes(l);
  return {
    requireUser: userOf,
    requireOwner(req) {
      const u = userOf(req);
      if (u.role !== 'owner') throw new HttpError(403, 'owner_only', 'Owner only');
      return u;
    },
    canAccessLocation: can,
    assertLocationAccess(u, l) {
      if (!db.prepare('SELECT 1 AS one FROM locations WHERE id = ?').get(l) || !can(u, l)) throw new HttpError(404, 'not_found', 'Not found');
    },
    verifyPassword: async () => false,
    userCanStillView: () => false,
  };
}

async function makeApp(db: DatabaseSync) {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    return reply.code(500).send({ error: { code: 'internal', message: String(err) } });
  });
  const applied: number[] = [];
  const removed: number[] = [];
  const audits: string[] = [];
  const box = createBox(randomBytes(32));
  const deps = {
    db,
    box,
    auth: testAuth(db),
    audit: (e: { action: string }) => audits.push(e.action),
    config: { ...HUB_CONFIG_DEFAULTS, ffprobePath: 'ffprobe-missing-for-tests' },
    media: {
      applyCamera: async (id: number) => void applied.push(id),
      removeCamera: async (id: number) => void removed.push(id),
      cameraStatus: async () => ({ online: true, bitrateKbps: 512 }),
    },
    connectors: {
      resolveCameraAddress: async (_l: number, ip: string, port: number) => ({ host: ip, port }),
      deviceInfo: async () => ({ manufacturer: 'Maker', model: 'C200' }),
    },
  } as unknown as AppDeps;
  registerCameraRoutes(app, deps);
  await app.ready();
  return { app, box, applied, removed, audits };
}

const send = (app: FastifyInstance, user: number, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: { 'x-test-user': String(user) }, ...(payload ? { payload } : {}) });

const tapo = { locationId: 1, name: 'Door', lanIp: '192.168.1.20', vendor: 'tapo', username: 'cam', password: 's3cret-pass' };

test('only the owner creates cameras, in a location that exists; passwords are sealed and never returned', async () => {
  const db = seed();
  const { app, box, applied, audits } = await makeApp(db);
  assert.equal((await send(app, 2, 'POST', '/api/cameras', tapo)).statusCode, 403);
  assert.equal((await send(app, 1, 'POST', '/api/cameras', { ...tapo, locationId: 99 })).statusCode, 404);
  assert.equal((await send(app, 1, 'POST', '/api/cameras', { ...tapo, lanIp: '127.0.0.1' })).statusCode, 422);
  assert.equal((await send(app, 1, 'POST', '/api/cameras', { ...tapo, vendor: 'custom' })).statusCode, 422, 'custom needs a main path');

  const res = await send(app, 1, 'POST', '/api/cameras', tapo);
  assert.equal(res.statusCode, 200, res.body);
  const cam = res.json() as CameraSummary;
  assert.equal(res.body.includes('s3cret-pass'), false);
  assert.equal('password' in cam, false);
  assert.equal(cam.mainPath, '/stream1');
  assert.equal(cam.subPath, '/stream2');
  assert.equal(cam.onvifPort, 2020);
  assert.equal(cam.quality, '720p');
  assert.equal(cam.manufacturer, 'Maker');
  assert.equal(cam.effectiveRecording, false, 'no vault key yet');
  const stored = db.prepare('SELECT password_enc FROM cameras WHERE id = ?').get(cam.id) as { password_enc: string };
  assert.notEqual(stored.password_enc, 's3cret-pass');
  assert.equal(box.open(stored.password_enc), 's3cret-pass');
  assert.deepEqual(applied, [cam.id]);
  assert.ok(audits.includes('camera.create'));
  assert.equal((await send(app, 1, 'POST', '/api/cameras', tapo)).statusCode, 409, 'same address twice');

  const viewerList = (await send(app, 2, 'GET', '/api/cameras')).json() as CamerasResponse;
  assert.equal(viewerList.cameras.length, 1);
  assert.equal(viewerList.cameras[0]?.username, null, 'viewers do not see the camera login');
  assert.equal((await send(app, 2, 'GET', '/api/cameras?locationId=2')).statusCode, 404);
  await app.close();
});

test('connector limits: router needs the camera network and open ports, bridge needs private addresses', async () => {
  const db = seed();
  const { app } = await makeApp(db);
  assert.equal((await send(app, 1, 'POST', '/api/cameras', { ...tapo, locationId: 2, lanIp: '192.168.2.5' })).statusCode, 422);
  assert.equal((await send(app, 1, 'POST', '/api/cameras', { ...tapo, locationId: 2, rtspPort: 8554 })).statusCode, 422);
  assert.equal((await send(app, 1, 'POST', '/api/cameras', { ...tapo, locationId: 2 })).statusCode, 200);
  assert.equal((await send(app, 1, 'POST', '/api/cameras', { ...tapo, locationId: 3, lanIp: '8.8.8.8' })).statusCode, 422);
  assert.equal((await send(app, 1, 'POST', '/api/cameras', { ...tapo, locationId: 3 })).statusCode, 200);
  await app.close();
});

test('update keeps the password unless given, audits recording switches, delete removes media paths', async () => {
  const db = seed();
  const { app, box, removed, audits } = await makeApp(db);
  const cam = (await send(app, 1, 'POST', '/api/cameras', tapo)).json() as CameraSummary;
  const before = (db.prepare('SELECT password_enc FROM cameras WHERE id = ?').get(cam.id) as { password_enc: string }).password_enc;
  assert.equal((await send(app, 2, 'PATCH', `/api/cameras/${cam.id}`, { recording: false })).statusCode, 403);
  const patched = await send(app, 1, 'PATCH', `/api/cameras/${cam.id}`, { recording: false, quality: '1080p' });
  assert.equal(patched.statusCode, 200);
  assert.equal((patched.json() as CameraSummary).recording, false);
  assert.equal((db.prepare('SELECT password_enc FROM cameras WHERE id = ?').get(cam.id) as { password_enc: string }).password_enc, before);
  assert.ok(audits.includes('camera.recording_off'));
  assert.ok(audits.includes('camera.update'));
  await send(app, 1, 'PATCH', `/api/cameras/${cam.id}`, { password: 'new-pass' });
  const after = (db.prepare('SELECT password_enc FROM cameras WHERE id = ?').get(cam.id) as { password_enc: string }).password_enc;
  assert.equal(box.open(after), 'new-pass');
  assert.equal((await send(app, 1, 'PATCH', '/api/cameras/999', { name: 'x' })).statusCode, 404);
  assert.equal((await send(app, 1, 'DELETE', `/api/cameras/${cam.id}`)).statusCode, 200);
  assert.deepEqual(removed, [cam.id]);
  await app.close();
});

test('camera tests are owner only and limited to 30 per hour per user', async () => {
  const db = seed();
  const { app } = await makeApp(db);
  const body = { locationId: 1, lanIp: '192.168.1.30', vendor: 'tapo', username: 'cam', password: 'pw' };
  assert.equal((await send(app, 2, 'POST', '/api/cameras/test', body)).statusCode, 403);
  const first = await send(app, 1, 'POST', '/api/cameras/test', body);
  assert.equal(first.statusCode, 200);
  const result = first.json() as { main: { ok: boolean; error: string; path: string }; sub: unknown; manufacturer: string };
  assert.equal(result.main.ok, false);
  assert.equal(result.main.path, '/stream1');
  assert.equal(result.main.error, 'ffprobe is not installed on the hub');
  assert.equal(first.body.includes('pw@'), false, 'the camera URL is never echoed');
  assert.equal(result.manufacturer, 'Maker');
  for (let i = 1; i < 30; i++) assert.equal((await send(app, 1, 'POST', '/api/cameras/test', body)).statusCode, 200);
  assert.equal((await send(app, 1, 'POST', '/api/cameras/test', body)).statusCode, 429);
  await app.close();
});
