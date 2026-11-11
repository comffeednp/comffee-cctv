import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  DB_PRAGMAS_SQL,
  HUB_CONFIG_DEFAULTS,
  HttpError,
  SCHEMA_SQL,
  type AppDeps,
  type AuditEntry,
  type AuthHelpers,
  type HubConfig,
  type MediaManager,
  type SessionUser,
} from '../../src/contracts.ts';
import { registerLocationRoutes } from '../../src/api/locations.ts';
import { createConnectorServiceWith } from '../../src/sites/connectors.ts';

const HUB_KEY = Buffer.alloc(32, 1).toString('base64');
const ROUTER_KEY = Buffer.alloc(32, 2).toString('base64');
const PASSWORD = 'correct horse battery';

async function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(DB_PRAGMAS_SQL);
  db.exec(SCHEMA_SQL);
  const config: HubConfig = {
    ...HUB_CONFIG_DEFAULTS,
    publicOrigin: 'https://cctv.example.com',
    publicHost: 'cctv.example.com',
    publicIp: '203.0.113.10',
    wireguard: { ...HUB_CONFIG_DEFAULTS.wireguard, enabled: true, publicKey: HUB_KEY },
  };
  const owner: SessionUser = { id: 1, username: 'owner', role: 'owner', locationIds: 'all' };
  const viewer: SessionUser = { id: 2, username: 'viewer', role: 'viewer', locationIds: [] };
  const users: Record<string, SessionUser> = { owner, viewer };
  const canAccess = (u: SessionUser, id: number): boolean => u.locationIds === 'all' || u.locationIds.includes(id);
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
    canAccessLocation: canAccess,
    assertLocationAccess(u, id) {
      if (!canAccess(u, id)) throw new HttpError(404, 'not_found', 'Not found');
    },
    verifyPassword: async (_id, pw) => pw === PASSWORD,
    userCanStillView: () => true,
  };
  const audits: AuditEntry[] = [];
  const mediaCalls: string[] = [];
  const media: MediaManager = {
    start: async () => undefined,
    stop: async () => undefined,
    reconcile: async () => undefined,
    applyCamera: async () => undefined,
    removeCamera: async (id) => void mediaCalls.push(`remove:${id}`),
    applyLocation: async (id) => void mediaCalls.push(`apply:${id}`),
    cameraStatus: async () => ({ online: false, bitrateKbps: null }),
  };
  const wgCalls: string[] = [];
  const box = { seal: (s: string) => s, open: (s: string) => s };
  const secrets = { masterKey: Buffer.alloc(32), streamTokenKey: Buffer.alloc(32), mediamtxUser: 'u', mediamtxPassword: 'p' };
  const audit = (e: AuditEntry): void => void audits.push(e);
  const connectors = createConnectorServiceWith(
    { db, config, secrets, box, audit },
    {
      runCommand: async (program, args) => {
        wgCalls.push([program, ...args].join(' '));
        return { code: 0, stdout: '', stderr: '' };
      },
    },
  );
  const deps: AppDeps = { db, config, secrets, box, auth, audit, media, connectors };
  const app: FastifyInstance = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    return reply.code(500).send({ error: { code: 'internal', message: String(err) } });
  });
  await registerLocationRoutes(app, deps);
  await app.ready();
  const call = async (who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) => {
    const res = await app.inject({
      method,
      url,
      headers: { 'x-test-user': who, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };
  const close = async (): Promise<void> => {
    await app.close();
    await connectors.stop();
    db.close();
  };
  return { db, app, call, viewer, audits, mediaCalls, wgCalls, close };
}

const router = (name: string) => ({ name, timezone: 'Asia/Manila', connector: 'router', cameraSubnet: '192.168.1.0/24' });

test('router locations get the lowest free slot and need a /24 camera network', async () => {
  const t = await setup();
  try {
    const a = await t.call('owner', 'POST', '/api/locations', router('A'));
    const b = await t.call('owner', 'POST', '/api/locations', router('B'));
    assert.equal(a.status, 200);
    assert.equal(a.body.slot, 1);
    assert.equal(b.body.slot, 2);
    const del = await t.call('owner', 'DELETE', `/api/locations/${a.body.id}`, { password: PASSWORD });
    assert.equal(del.status, 200);
    const c = await t.call('owner', 'POST', '/api/locations', router('C'));
    assert.equal(c.body.slot, 1, 'freed slot is reused');
    assert.equal((await t.call('owner', 'POST', '/api/locations', { ...router('D'), cameraSubnet: null })).status, 422);
    assert.equal((await t.call('owner', 'POST', '/api/locations', { ...router('D'), cameraSubnet: '192.168.0.0/23' })).status, 422);
    assert.equal((await t.call('owner', 'POST', '/api/locations', { ...router('D'), timezone: 'Mars/Base' })).status, 422);
    assert.equal((await t.call('owner', 'POST', '/api/locations', { ...router('D'), wanRoutingTable: 'a"b' })).status, 422);
    assert.ok(t.audits.some((e) => e.action === 'location.create'));
  } finally {
    await t.close();
  }
});

test('viewers see only their own locations, without network details, and cannot change anything', async () => {
  const t = await setup();
  try {
    const mine = await t.call('owner', 'POST', '/api/locations', { name: 'Mine', timezone: 'UTC', connector: 'direct', cameraSubnet: '192.168.7.0/24' });
    const other = await t.call('owner', 'POST', '/api/locations', { name: 'Other', timezone: 'UTC', connector: 'bridge' });
    t.viewer.locationIds = [mine.body.id as number];
    const list = await t.call('viewer', 'GET', '/api/locations');
    const locations = list.body.locations as Array<Record<string, unknown>>;
    assert.deepEqual(locations.map((l) => l.name), ['Mine']);
    assert.equal(locations[0].cameraSubnet, null);
    assert.equal((await t.call('viewer', 'GET', `/api/locations/${other.body.id}`)).status, 404);
    assert.equal((await t.call('viewer', 'GET', '/api/locations/999')).status, 404);
    assert.equal((await t.call('viewer', 'POST', '/api/locations', router('X'))).status, 403);
    assert.equal((await t.call('viewer', 'PATCH', `/api/locations/${mine.body.id}`, { name: 'Y' })).status, 403);
    assert.equal((await t.call('viewer', 'GET', `/api/locations/${mine.body.id}/setup`)).status, 403);
    assert.equal((await t.call('nobody', 'GET', '/api/locations')).status, 401);
  } finally {
    await t.close();
  }
});

test('router key: validated, unique, applied to the hub tunnel; pause is audited', async () => {
  const t = await setup();
  try {
    const a = await t.call('owner', 'POST', '/api/locations', router('A'));
    const b = await t.call('owner', 'POST', '/api/locations', { ...router('B'), cameraSubnet: '192.168.2.0/24' });
    assert.equal((await t.call('owner', 'PATCH', `/api/locations/${a.body.id}`, { routerPublicKey: 'not a key' })).status, 422);
    assert.equal((await t.call('owner', 'PATCH', `/api/locations/${a.body.id}`, { routerPublicKey: HUB_KEY })).status, 422);
    const ok = await t.call('owner', 'PATCH', `/api/locations/${a.body.id}`, { routerPublicKey: ROUTER_KEY });
    assert.equal(ok.status, 200);
    assert.ok(t.wgCalls.includes(`wg set wg0 peer ${ROUTER_KEY} allowed-ips 10.77.1.2/32,10.78.1.0/24`));
    assert.equal((await t.call('owner', 'PATCH', `/api/locations/${b.body.id}`, { routerPublicKey: ROUTER_KEY })).status, 409);
    const paused = await t.call('owner', 'PATCH', `/api/locations/${a.body.id}`, { recordingPaused: true });
    assert.equal(paused.body.recordingPaused, true);
    assert.ok(t.audits.some((e) => e.action === 'location.recording_off'));
    assert.ok(t.mediaCalls.includes(`apply:${a.body.id}`));
    const moved = await t.call('owner', 'PATCH', `/api/locations/${a.body.id}`, { connector: 'bridge' });
    assert.equal(moved.body.slot, null);
    assert.ok(t.wgCalls.includes(`wg set wg0 peer ${ROUTER_KEY} remove`), 'leaving the router connector removes the peer');
  } finally {
    await t.close();
  }
});

test('setup text, bridge token shown once and stored hashed', async () => {
  const t = await setup();
  try {
    const r = await t.call('owner', 'POST', '/api/locations', router('A'));
    const setup = await t.call('owner', 'GET', `/api/locations/${r.body.id}/setup`);
    assert.equal(setup.status, 200);
    const rs = setup.body.router as Record<string, unknown>;
    assert.match(String(rs.routerOsScript), /10\.78\.1\.0\/24 action=netmap to-addresses=192\.168\.1\.0\/24/);
    assert.equal(rs.routerPublicKeySet, false);

    const br = await t.call('owner', 'POST', '/api/locations', { name: 'B', timezone: 'UTC', connector: 'bridge' });
    const before = await t.call('owner', 'GET', `/api/locations/${br.body.id}/setup`);
    const bs = before.body.bridge as Record<string, unknown>;
    assert.equal(bs.hasToken, false);
    assert.equal(bs.command, 'comffee-cctv-bridge --hub wss://cctv.example.com/bridge --token <token>');
    const tok = await t.call('owner', 'POST', `/api/locations/${br.body.id}/bridge-token`, {});
    const token = String(tok.body.token);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(tok.body.command, `comffee-cctv-bridge --hub wss://cctv.example.com/bridge --token ${token}`);
    const row = t.db.prepare('SELECT bridge_token_hash FROM locations WHERE id = ?').get(br.body.id as number) as { bridge_token_hash: string };
    assert.equal(row.bridge_token_hash, createHash('sha256').update(token).digest('hex'));
    assert.ok(!JSON.stringify(t.audits).includes(token), 'the token never reaches the audit log');
    assert.equal((await t.call('owner', 'POST', `/api/locations/${r.body.id}/bridge-token`, {})).status, 422);
  } finally {
    await t.close();
  }
});

test('delete re-checks the password; detection is rate limited', async () => {
  const t = await setup();
  try {
    const d = await t.call('owner', 'POST', '/api/locations', { name: 'D', timezone: 'UTC', connector: 'direct' });
    t.db.prepare(
      "INSERT INTO cameras (location_id, name, lan_ip, vendor, main_path, username, password_enc, created_at) VALUES (?, 'Cam', '192.168.1.5', 'tapo', '/stream1', 'u', 'x', 0)",
    ).run(d.body.id as number);
    const wrong = await t.call('owner', 'DELETE', `/api/locations/${d.body.id}`, { password: 'nope nope nope' });
    assert.equal(wrong.status, 422);
    assert.equal((wrong.body.error as Record<string, unknown>).code, 'wrong_password');
    assert.equal((await t.call('owner', 'DELETE', `/api/locations/${d.body.id}`, {})).status, 422);

    for (let i = 0; i < 6; i++) {
      assert.equal((await t.call('owner', 'POST', `/api/locations/${d.body.id}/detect`, {})).status, 422, 'no camera network set');
    }
    assert.equal((await t.call('owner', 'POST', `/api/locations/${d.body.id}/detect`, {})).status, 429);

    const ok = await t.call('owner', 'DELETE', `/api/locations/${d.body.id}`, { password: PASSWORD });
    assert.equal(ok.status, 200);
    assert.equal((await t.call('owner', 'GET', `/api/locations/${d.body.id}`)).status, 404);
    assert.ok(t.mediaCalls.some((c) => c.startsWith('remove:')), 'cameras of the location are removed from media');
    assert.ok(t.audits.some((e) => e.action === 'location.delete'));
  } finally {
    await t.close();
  }
});
