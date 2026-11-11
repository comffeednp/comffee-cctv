import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AddDetectedResponse, CameraSummary, LocationSummary } from '../../../shared/api-types.ts';
import { HUB_CONFIG_DEFAULTS, HttpError } from '../../src/contracts.ts';
import type { AppDeps, AuditEntry, AuthHelpers, HubConfig, SessionUser } from '../../src/contracts.ts';
import { openDatabase } from '../../src/db.ts';
import { createBox } from '../../src/crypto/box.ts';
import { registerCameraRoutes } from '../../src/api/cameras.ts';
import { registerLocationRoutes } from '../../src/api/locations.ts';

const CAM_USER = 'tapo-admin';
const CAM_PASS = 'Cam-Pass-7741';
/** The fake stream test fails for this camera address. */
const BAD_IP = '192.168.1.66';

async function setup(configOverride: Partial<HubConfig> = {}) {
  const db: DatabaseSync = openDatabase(':memory:');
  const owner: SessionUser = { id: 1, username: 'owner', role: 'owner', locationIds: 'all' };
  const viewer: SessionUser = { id: 2, username: 'viewer', role: 'viewer', locationIds: [] };
  const users: Record<string, SessionUser> = { owner, viewer };
  const can = (u: SessionUser, id: number): boolean => u.locationIds === 'all' || u.locationIds.includes(id);
  const auth: AuthHelpers = {
    requireUser(req: FastifyRequest) {
      const u = users[String(req.headers['x-test-user'])];
      if (!u) throw new HttpError(401, 'not_signed_in', 'Sign in');
      return u;
    },
    requireOwner(req: FastifyRequest) {
      const u = auth.requireUser(req);
      if (u.role !== 'owner') throw new HttpError(403, 'owner_only', 'Owner only');
      return u;
    },
    canAccessLocation: can,
    assertLocationAccess(u, id) {
      if (!can(u, id)) throw new HttpError(404, 'not_found', 'Not found');
    },
    verifyPassword: async () => false,
    userCanStillView: () => true,
  };
  const audits: AuditEntry[] = [];
  const probed: string[] = [];
  const box = createBox(randomBytes(32));
  const config: HubConfig = { ...HUB_CONFIG_DEFAULTS, publicOrigin: 'https://cctv.example.com', ...configOverride };
  const deps = {
    db,
    box,
    auth,
    config,
    audit: (e: AuditEntry) => void audits.push(e),
    media: {
      applyCamera: async () => undefined,
      removeCamera: async () => undefined,
      applyLocation: async () => undefined,
      cameraStatus: async () => ({ online: true, bitrateKbps: 512 }),
    },
    connectors: {
      locationStatus: () => ({ online: true, lastSeen: null }),
      onLocationChanged: async () => undefined,
      resolveCameraAddress: async (_l: number, ip: string, port: number) => ({ host: ip, port }),
      deviceInfo: async () => ({ manufacturer: 'Maker', model: 'C200' }),
    },
  } as unknown as AppDeps;
  const app: FastifyInstance = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    return reply.code(500).send({ error: { code: 'internal', message: String(err) } });
  });
  await registerLocationRoutes(app, deps);
  registerCameraRoutes(app, deps, {
    probe: async (_ffprobe, url) => {
      probed.push(url);
      return url.includes(`@${BAD_IP}:`)
        ? { ok: false, codec: null, width: null, height: null, fps: null, error: 'Wrong camera username or password' }
        : { ok: true, codec: 'h264', width: 1280, height: 720, fps: 15, error: null };
    },
  });
  await app.ready();
  const call = async (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) => {
    const res = await app.inject({ method, url, headers: { 'x-test-user': who }, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: res.statusCode, text: res.body, json: res.json() as Record<string, unknown> };
  };
  const close = async (): Promise<void> => {
    await app.close();
    db.close();
  };
  return { db, box, call, viewer, audits, probed, close };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function directLocation(t: Setup): Promise<number> {
  const r = await t.call('owner', 'POST', '/api/locations', { name: 'Shop', timezone: 'UTC', connector: 'direct', cameraSubnet: '192.168.1.0/24' });
  assert.equal(r.status, 200, r.text);
  return r.json.id as number;
}

const saveLogin = (t: Setup, id: number) =>
  t.call('owner', 'PATCH', `/api/locations/${id}`, { cameraUsername: CAM_USER, cameraPassword: CAM_PASS });

test('camera login: saved sealed, cleared, audited without values and never returned', async () => {
  const t = await setup();
  try {
    const id = await directLocation(t);
    const fresh = (await t.call('owner', 'GET', `/api/locations/${id}`)).json as unknown as LocationSummary;
    assert.equal(fresh.hasCameraLogin, false);
    assert.equal(fresh.cameraUsername, null);

    assert.equal((await t.call('owner', 'PATCH', `/api/locations/${id}`, { cameraUsername: CAM_USER })).status, 422, 'password missing');
    assert.equal((await t.call('owner', 'PATCH', `/api/locations/${id}`, { cameraPassword: CAM_PASS })).status, 422, 'username missing');
    assert.equal((await t.call('owner', 'PATCH', `/api/locations/${id}`, { cameraUsername: CAM_USER, cameraPassword: '' })).status, 422);
    assert.equal((await t.call('owner', 'PATCH', `/api/locations/${id}`, { cameraUsername: CAM_USER, cameraPassword: 'x'.repeat(129) })).status, 422);
    assert.equal(
      (await t.call('owner', 'PATCH', `/api/locations/${id}`, { cameraUsername: CAM_USER, cameraPassword: CAM_PASS, clearCameraLogin: true })).status,
      422,
      'save and clear at once',
    );
    assert.equal((await t.call('viewer', 'PATCH', `/api/locations/${id}`, { cameraUsername: CAM_USER, cameraPassword: CAM_PASS })).status, 403);

    const saved = await saveLogin(t, id);
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.hasCameraLogin, true);
    assert.equal(saved.json.cameraUsername, CAM_USER);
    assert.equal(saved.text.includes(CAM_PASS), false, 'the password is never returned');
    const row = t.db.prepare('SELECT camera_username, camera_password_enc FROM locations WHERE id = ?').get(id) as {
      camera_username: string;
      camera_password_enc: string;
    };
    assert.equal(row.camera_username, CAM_USER);
    assert.notEqual(row.camera_password_enc, CAM_PASS);
    assert.equal(t.box.open(row.camera_password_enc), CAM_PASS);
    const loginAudits = t.audits.filter((a) => (a.action as string) === 'location.camera_login');
    assert.deepEqual(loginAudits.map((a) => a.detail), ['saved']);
    assert.equal(JSON.stringify(t.audits).includes(CAM_PASS), false, 'the password never reaches the audit log');

    const list = await t.call('owner', 'GET', '/api/locations');
    assert.equal(list.text.includes(CAM_PASS), false);

    t.viewer.locationIds = [id];
    const asViewer = (await t.call('viewer', 'GET', `/api/locations/${id}`)).json as unknown as LocationSummary;
    assert.equal(asViewer.hasCameraLogin, true);
    assert.equal(asViewer.cameraUsername, null, 'viewers never see the camera username');

    const cleared = await t.call('owner', 'PATCH', `/api/locations/${id}`, { clearCameraLogin: true });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.hasCameraLogin, false);
    assert.equal(cleared.json.cameraUsername, null);
    const after = t.db.prepare('SELECT camera_username, camera_password_enc FROM locations WHERE id = ?').get(id) as Record<string, unknown>;
    assert.equal(after.camera_username, null);
    assert.equal(after.camera_password_enc, null);
    assert.deepEqual(
      t.audits.filter((a) => (a.action as string) === 'location.camera_login').map((a) => a.detail),
      ['saved', 'removed'],
    );
  } finally {
    await t.close();
  }
});

test('cameras added or tested without a login use the saved one; the camera keeps its own sealed copy', async () => {
  const t = await setup();
  try {
    const id = await directLocation(t);
    const cam = { locationId: id, name: 'Door', lanIp: '192.168.1.20', vendor: 'tapo' };
    const none = await t.call('owner', 'POST', '/api/cameras', cam);
    assert.equal(none.status, 422);
    assert.match(String((none.json.error as Record<string, unknown>).message), /Save a camera login for this location first/);
    assert.equal((await t.call('owner', 'POST', '/api/cameras/test', cam)).status, 422);
    assert.equal((await t.call('owner', 'POST', '/api/cameras', { ...cam, username: 'only-name' })).status, 422, 'both or neither');

    await saveLogin(t, id);
    const created = await t.call('owner', 'POST', '/api/cameras', cam);
    assert.equal(created.status, 200, created.text);
    const summary = created.json as unknown as CameraSummary;
    assert.equal(summary.username, CAM_USER);
    assert.equal(created.text.includes(CAM_PASS), false);
    const stored = t.db.prepare('SELECT username, password_enc FROM cameras WHERE id = ?').get(summary.id) as { username: string; password_enc: string };
    assert.equal(stored.username, CAM_USER);
    assert.equal(t.box.open(stored.password_enc), CAM_PASS);

    const tested = await t.call('owner', 'POST', '/api/cameras/test', { ...cam, lanIp: '192.168.1.21' });
    assert.equal(tested.status, 200, tested.text);
    assert.equal(tested.text.includes(CAM_PASS), false);
    assert.ok(t.probed.some((u) => u.includes(`${CAM_USER}:${CAM_PASS}@192.168.1.21:554/stream1`)), 'tested with the saved login');

    const own = await t.call('owner', 'POST', '/api/cameras', { ...cam, lanIp: '192.168.1.22', username: 'other', password: 'other-pass' });
    assert.equal((own.json as unknown as CameraSummary).username, 'other', 'a login sent with the camera wins');

    // Removing the saved login leaves the cameras' own copies alone.
    await t.call('owner', 'PATCH', `/api/locations/${id}`, { clearCameraLogin: true });
    const kept = t.db.prepare('SELECT password_enc FROM cameras WHERE id = ?').get(summary.id) as { password_enc: string };
    assert.equal(t.box.open(kept.password_enc), CAM_PASS);
  } finally {
    await t.close();
  }
});

test('add detected cameras: owner only, saved login needed, addresses checked, named with the next free numbers', async () => {
  const t = await setup();
  try {
    const id = await directLocation(t);
    const url = `/api/locations/${id}/cameras/add-detected`;
    const tapoAt = (ip: string) => ({ ip, rtspPort: 554, onvifPort: 2020, vendor: 'tapo' });

    assert.equal((await t.call('viewer', 'POST', url, { devices: [tapoAt('192.168.1.30')] })).status, 403);
    assert.equal((await t.call('owner', 'POST', '/api/locations/999/cameras/add-detected', { devices: [tapoAt('192.168.1.30')] })).status, 404);
    const noLogin = await t.call('owner', 'POST', url, { devices: [tapoAt('192.168.1.30')] });
    assert.equal(noLogin.status, 422);
    assert.match(String((noLogin.json.error as Record<string, unknown>).message), /Save a camera login/);

    await saveLogin(t, id);
    assert.equal((await t.call('owner', 'POST', url, { devices: [] })).status, 422);
    assert.equal((await t.call('owner', 'POST', url, { devices: [tapoAt('192.168.2.30')] })).status, 422, 'outside the camera network');
    assert.equal((await t.call('owner', 'POST', url, { devices: [tapoAt('8.8.8.8')] })).status, 422, 'not a private address');
    assert.equal((await t.call('owner', 'POST', url, { devices: [{ ip: 'not-an-ip' }] })).status, 422);
    assert.equal(t.probed.length, 0, 'a bad list tests nothing');

    // Existing names: Camera 1 and Camera 3, so the new ones are Camera 2 and Camera 4.
    const insert = t.db.prepare(
      "INSERT INTO cameras (location_id, name, lan_ip, vendor, main_path, username, password_enc, created_at) VALUES (?, ?, ?, 'tapo', '/stream1', 'u', 'x', 0)",
    );
    insert.run(id, 'Camera 1', '192.168.1.10');
    insert.run(id, 'Camera 3', '192.168.1.11');

    const res = await t.call('owner', 'POST', url, {
      devices: [
        tapoAt('192.168.1.40'),
        tapoAt('192.168.1.10'), // already added
        tapoAt(BAD_IP), // fails the stream test
        { ip: '192.168.1.41', rtspPort: 554, onvifPort: null, vendor: null }, // no vendor guess: stream path unknown
        tapoAt('192.168.1.42'),
        tapoAt('192.168.1.42'), // listed twice
      ],
    });
    assert.equal(res.status, 200, res.text);
    const body = res.json as unknown as AddDetectedResponse;
    assert.deepEqual(
      body.added.map((c) => [c.name, c.lanIp, c.vendor, c.mainPath, c.subPath, c.username]),
      [
        ['Camera 2', '192.168.1.40', 'tapo', '/stream1', '/stream2', CAM_USER],
        ['Camera 4', '192.168.1.42', 'tapo', '/stream1', '/stream2', CAM_USER],
      ],
    );
    assert.deepEqual(body.failed.map((f) => f.ip).sort(), ['192.168.1.10', '192.168.1.41', BAD_IP].sort());
    assert.equal(body.failed.find((f) => f.ip === BAD_IP)?.error, 'Wrong camera username or password');
    assert.equal(res.text.includes(CAM_PASS), false);
    const sealed = t.db.prepare('SELECT password_enc FROM cameras WHERE lan_ip = ?').get('192.168.1.40') as { password_enc: string };
    assert.equal(t.box.open(sealed.password_enc), CAM_PASS);
    assert.equal(t.audits.filter((a) => a.action === 'camera.create').length, 2, 'each add is audited');
    assert.equal(t.probed.filter((u) => u.endsWith('/stream1')).length, 3, 'three cameras were stream-tested, once each');

    // A bridge location takes any private address and no camera network.
    const bridge = await t.call('owner', 'POST', '/api/locations', { name: 'Branch', timezone: 'UTC', connector: 'bridge' });
    const bid = bridge.json.id as number;
    await saveLogin(t, bid);
    const viaBridge = await t.call('owner', 'POST', `/api/locations/${bid}/cameras/add-detected`, { devices: [tapoAt('10.20.30.40')] });
    assert.equal(viaBridge.status, 200, viaBridge.text);
    assert.deepEqual((viaBridge.json as unknown as AddDetectedResponse).added.map((c) => c.name), ['Camera 1']);
    assert.equal(
      (await t.call('owner', 'POST', `/api/locations/${bid}/cameras/add-detected`, { devices: [{ ...tapoAt('10.20.30.41'), rtspPort: 8554 }] })).status,
      422,
      'bridge ports are limited',
    );
  } finally {
    await t.close();
  }
});

test('bridge setup shows the download address from the hub settings, or none', async () => {
  const none = await setup();
  try {
    const b = await none.call('owner', 'POST', '/api/locations', { name: 'B', timezone: 'UTC', connector: 'bridge' });
    const s = await none.call('owner', 'GET', `/api/locations/${b.json.id}/setup`);
    assert.equal((s.json.bridge as Record<string, unknown>).downloadUrl, null);
  } finally {
    await none.close();
  }
  const set = await setup({ bridgeDownloadUrl: 'https://downloads.example.com/bridge/' });
  try {
    const b = await set.call('owner', 'POST', '/api/locations', { name: 'B', timezone: 'UTC', connector: 'bridge' });
    const s = await set.call('owner', 'GET', `/api/locations/${b.json.id}/setup`);
    assert.equal((s.json.bridge as Record<string, unknown>).downloadUrl, 'https://downloads.example.com/bridge/');
  } finally {
    await set.close();
  }
});
