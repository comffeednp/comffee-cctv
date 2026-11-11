import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildConfig } from '../../src/config.ts';
import type { AppDeps, ConnectorService, HubConfig, MediaManager } from '../../src/contracts.ts';
import { createAuditWriter } from '../../src/audit.ts';
import { createAuth } from '../../src/auth/service.ts';
import type { AuthService } from '../../src/auth/service.ts';
import { createSetupCode } from '../../src/auth/setup-codes.ts';
import { totpCode } from '../../src/auth/totp.ts';
import { createBox } from '../../src/crypto/box.ts';
import { openDatabase } from '../../src/db.ts';
import { createHttpApp } from '../../src/http.ts';
import { registerAuditRoutes } from '../../src/api/audit.ts';
import { registerAuthRoutes } from '../../src/api/auth.ts';
import { registerKeyRoutes } from '../../src/api/keys.ts';
import { registerMeRoutes } from '../../src/api/me.ts';
import { registerSetupRoutes } from '../../src/api/setup.ts';
import { registerUserRoutes } from '../../src/api/users.ts';

const ORIGIN = 'https://cctv.test';
const OWNER_PW = 'owner password 123';
const VIEWER_PW = 'viewer password 123';
const MIN = 60_000;
/** The test hub uses HTTPS cookies, so the session cookie carries the __Host- prefix. */
const COOKIE = '__Host-ccv_session';

let tmp: string;
let config: HubConfig;
let db: DatabaseSync;
let auth: AuthService;
let app: FastifyInstance;
let clock = 1_800_000_000_000;
let reconcileCalls = 0;

const media: MediaManager = {
  start: async () => {},
  stop: async () => {},
  reconcile: async () => {
    reconcileCalls++;
  },
  applyCamera: async () => {},
  removeCamera: async () => {},
  applyLocation: async () => {},
  cameraStatus: async () => ({ online: false, bitrateKbps: null }),
};

const connectors: ConnectorService = {
  start: async () => {},
  stop: async () => {},
  resolveCameraAddress: async (_l, lanIp, port) => ({ host: lanIp, port }),
  detect: async () => ({ devices: [], scanned: 0, tookMs: 0 }),
  deviceInfo: async () => null,
  locationStatus: () => ({ online: true, lastSeen: null }),
  onLocationChanged: async () => {},
};

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'ccv-api-'));
  const dash = path.join(tmp, 'dash');
  mkdirSync(path.join(dash, 'assets'), { recursive: true });
  writeFileSync(path.join(dash, 'index.html'), '<!doctype html><title>dashboard</title>');
  writeFileSync(path.join(dash, 'assets', 'app.js'), 'console.log(1)');
  config = buildConfig({ publicOrigin: ORIGIN, dataDir: path.join(tmp, 'data'), dashboardDir: dash });
  db = openDatabase(':memory:');
  const box = createBox(randomBytes(32));
  auth = createAuth({ db, config, box, now: () => clock });
  const deps: AppDeps = {
    db,
    config,
    secrets: { masterKey: randomBytes(32), streamTokenKey: randomBytes(32), mediamtxUser: 'u', mediamtxPassword: 'p'.repeat(20) },
    box,
    auth,
    audit: createAuditWriter(db, () => clock),
    media,
    connectors,
  };
  app = await createHttpApp(config);
  for (const register of [registerSetupRoutes, registerAuthRoutes, registerMeRoutes, registerUserRoutes, registerAuditRoutes, registerKeyRoutes]) {
    await register(app, deps);
  }
  // Probe route for the shared location check used by the other route modules.
  app.get('/api/test/locations/:id', async (req) => {
    const user = auth.requireUser(req);
    auth.assertLocationAccess(user, Number((req.params as { id: string }).id));
    return { ok: true };
  });
  app.post('/internal/ping', async () => ({ ok: true }));
  await app.ready();
});

after(async () => {
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

/* -------------------------------------------------------------------- helpers */

interface Call {
  method?: InjectOptions['method'];
  url: string;
  body?: unknown;
  cookie?: string;
  ip?: string;
  headers?: Record<string, string>;
}

function call(c: Call): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { 'x-cctv': '1', ...(c.headers ?? {}) };
  if (c.cookie) headers.cookie = `${COOKIE}=${c.cookie}`;
  const opts: InjectOptions = { method: c.method ?? 'GET', url: c.url, headers, remoteAddress: c.ip ?? '198.51.100.10' };
  if (c.body !== undefined) {
    headers['content-type'] = 'application/json';
    opts.payload = JSON.stringify(c.body);
  }
  return app.inject(opts);
}

function sessionFrom(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  assert.ok(header, 'set-cookie present');
  const m = /^__Host-ccv_session=([A-Za-z0-9_-]+);/.exec(header);
  assert.ok(m, `session cookie in ${header}`);
  return m[1];
}

function code(res: LightMyRequestResponse): string {
  return (res.json() as { error: { code: string } }).error.code;
}

function nextStep(): void {
  clock += 30_000;
}

/** Full sign-in (password + 2-step) for an enrolled user; returns the session token. */
async function signIn(username: string, password: string, secret: string, ip?: string): Promise<string> {
  nextStep();
  const login = await call({ method: 'POST', url: '/api/auth/login', body: { username, password }, ip });
  assert.equal(login.statusCode, 200, login.body);
  const { challenge, next } = login.json() as { challenge: string; next: string };
  assert.equal(next, 'totp');
  const res = await call({ method: 'POST', url: '/api/auth/totp', body: { challenge, code: totpCode(secret, clock) }, ip });
  assert.equal(res.statusCode, 200, res.body);
  return sessionFrom(res);
}

/** First sign-in of a user without 2-step: enroll and return the secret and session. */
async function enroll(username: string, password: string): Promise<{ secret: string; session: string }> {
  nextStep();
  const login = await call({ method: 'POST', url: '/api/auth/login', body: { username, password } });
  assert.equal(login.statusCode, 200, login.body);
  const body = login.json() as { next: string; challenge: string; secretBase32: string };
  assert.equal(body.next, 'enroll-totp');
  const res = await call({ method: 'POST', url: '/api/auth/totp', body: { challenge: body.challenge, code: totpCode(body.secretBase32, clock) } });
  assert.equal(res.statusCode, 200, res.body);
  return { secret: body.secretBase32, session: sessionFrom(res) };
}

function addLocation(name: string): number {
  const res = db
    .prepare("INSERT INTO locations (name, timezone, connector, created_at) VALUES (?, 'UTC', 'direct', 0)")
    .run(name);
  return Number(res.lastInsertRowid);
}

let ownerSecret = '';
let ownerSession = '';

/* ---------------------------------------------------------------------- tests */

test('setup: status, single-use code, owner creation and enrollment', async () => {
  let status = await call({ url: '/api/setup/status' });
  assert.deepEqual(status.json(), { needsSetup: true, hasVaultKey: false });

  const wrong = await call({ method: 'POST', url: '/api/setup/owner', body: { setupCode: 'AAAA-BBBB', username: 'boss', password: OWNER_PW } });
  assert.equal(wrong.statusCode, 422);

  // At most 10 wrong setup codes per IP per hour.
  for (let i = 0; i < 10; i++) {
    const r = await call({ method: 'POST', url: '/api/setup/owner', body: { setupCode: 'X', username: 'boss', password: OWNER_PW }, ip: '192.0.2.50' });
    assert.equal(r.statusCode, 422);
  }
  const throttled = await call({ method: 'POST', url: '/api/setup/owner', body: { setupCode: 'X', username: 'boss', password: OWNER_PW }, ip: '192.0.2.50' });
  assert.equal(throttled.statusCode, 429);

  const expired = createSetupCode(db, clock - 25 * 60 * MIN);
  const exp = await call({ method: 'POST', url: '/api/setup/owner', body: { setupCode: expired, username: 'boss', password: OWNER_PW } });
  assert.equal(exp.statusCode, 422, 'expired code refused');

  const setupCode = createSetupCode(db, clock);
  const shortPw = await call({ method: 'POST', url: '/api/setup/owner', body: { setupCode, username: 'boss', password: 'short' } });
  assert.equal(shortPw.statusCode, 422);

  const res = await call({ method: 'POST', url: '/api/setup/owner', body: { setupCode, username: 'boss', password: OWNER_PW } });
  assert.equal(res.statusCode, 200, res.body);
  const enrollment = res.json() as { challenge: string; secretBase32: string; otpauthUrl: string };
  assert.match(enrollment.otpauthUrl, /^otpauth:\/\/totp\/Comffee%20CCTV:boss\?secret=/);

  const again = await call({ method: 'POST', url: '/api/setup/owner', body: { setupCode, username: 'boss2', password: OWNER_PW } });
  assert.equal(again.statusCode, 409, 'owner exists');

  status = await call({ url: '/api/setup/status' });
  assert.equal((status.json() as { needsSetup: boolean }).needsSetup, false);

  // Wrong code first, then the right one.
  const bad = await call({ method: 'POST', url: '/api/auth/totp', body: { challenge: enrollment.challenge, code: '000000' } });
  assert.equal(bad.statusCode, 401);
  const done = await call({ method: 'POST', url: '/api/auth/totp', body: { challenge: enrollment.challenge, code: totpCode(enrollment.secretBase32, clock) } });
  assert.equal(done.statusCode, 200, done.body);
  assert.deepEqual(done.json(), { id: 1, username: 'boss', role: 'owner', locationIds: 'all', totpEnabled: true });
  const cookie = String(done.headers['set-cookie']);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Path=\//);
  ownerSecret = enrollment.secretBase32;
  ownerSession = sessionFrom(done);

  const reuse = await call({ method: 'POST', url: '/api/auth/totp', body: { challenge: enrollment.challenge, code: totpCode(ownerSecret, clock) } });
  assert.equal(reuse.statusCode, 401, 'challenge is single use');
  assert.equal(code(reuse), 'challenge_expired');

  const me = await call({ url: '/api/me', cookie: ownerSession });
  assert.equal(me.statusCode, 200);
});

test('login: wrong password text, 2-step replay guard and session rotation', async () => {
  const wrong = await call({ method: 'POST', url: '/api/auth/login', body: { username: 'boss', password: 'not the password' } });
  assert.equal(wrong.statusCode, 401);
  assert.deepEqual(wrong.json(), { error: { code: 'wrong_credentials', message: 'Wrong username or password' } });
  const unknown = await call({ method: 'POST', url: '/api/auth/login', body: { username: 'nobody', password: 'not the password' } });
  assert.deepEqual(unknown.json(), wrong.json());

  const first = await signIn('boss', OWNER_PW, ownerSecret);
  // The same code in the same step is refused (replay).
  const login = await call({ method: 'POST', url: '/api/auth/login', body: { username: 'BOSS', password: OWNER_PW } });
  const { challenge } = login.json() as { challenge: string };
  const replay = await call({ method: 'POST', url: '/api/auth/totp', body: { challenge, code: totpCode(ownerSecret, clock) } });
  assert.equal(replay.statusCode, 401);
  assert.equal(code(replay), 'wrong_credentials');

  // A sign-in from a browser that still holds a session replaces that session.
  nextStep();
  const ok = await app.inject({
    method: 'POST',
    url: '/api/auth/totp',
    headers: { 'x-cctv': '1', 'content-type': 'application/json', cookie: `${COOKIE}=${first}` },
    payload: JSON.stringify({ challenge, code: totpCode(ownerSecret, clock) }),
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const second = sessionFrom(ok);
  assert.notEqual(second, first);
  assert.equal((await call({ url: '/api/me', cookie: first })).statusCode, 401, 'old session gone');
  assert.equal((await call({ url: '/api/me', cookie: second })).statusCode, 200);
  assert.equal((await call({ url: '/api/me', cookie: ownerSession })).statusCode, 200, 'other devices stay signed in');

  db.prepare('UPDATE users SET failed_count = 0, first_failed_at = 0 WHERE id = 1').run();
});

test('sessions expire after 12 h idle and 7 days in total', async () => {
  const s = await signIn('boss', OWNER_PW, ownerSecret);
  clock += 11 * 60 * MIN;
  assert.equal((await call({ url: '/api/me', cookie: s })).statusCode, 200);
  clock += 12 * 60 * MIN;
  assert.equal((await call({ url: '/api/me', cookie: s })).statusCode, 401, 'idle 12 h');

  const t = await signIn('boss', OWNER_PW, ownerSecret);
  for (let i = 0; i < 15; i++) {
    clock += 11 * 60 * MIN;
    assert.equal((await call({ url: '/api/me', cookie: t })).statusCode, 200, `day ${i}`);
  }
  clock += 11 * 60 * MIN; // 176 h > 168 h
  assert.equal((await call({ url: '/api/me', cookie: t })).statusCode, 401, 'absolute 7 days');
  ownerSession = await signIn('boss', OWNER_PW, ownerSecret);
});

test('CSRF guard: header, Origin and JSON-only bodies', async () => {
  const noHeader = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: '{}' });
  assert.equal(noHeader.statusCode, 403);
  assert.equal(code(noHeader), 'csrf');
  const foreign = await call({ method: 'POST', url: '/api/auth/login', body: { username: 'a', password: 'b' }, headers: { origin: 'https://evil.test' } });
  assert.equal(foreign.statusCode, 403);
  const text = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-cctv': '1', 'content-type': 'text/plain' }, payload: 'x' });
  assert.equal(text.statusCode, 403);
  const form = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { 'x-cctv': '1', 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'a=b',
  });
  assert.equal(form.statusCode, 403);
  const sameOrigin = await call({ method: 'POST', url: '/api/auth/logout', headers: { origin: ORIGIN } });
  assert.equal(sameOrigin.statusCode, 200, 'empty body with the header and our origin passes');
  const get = await app.inject({ method: 'GET', url: '/api/setup/status' });
  assert.equal(get.statusCode, 200, 'GET needs no header');
  const tooBig = await call({ method: 'POST', url: '/api/auth/login', body: { username: 'x'.repeat(70_000), password: 'y' } });
  assert.equal(tooBig.statusCode, 413);
  const broken = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-cctv': '1', 'content-type': 'application/json' }, payload: '{nope' });
  assert.equal(broken.statusCode, 422);

  // A percent-encoded path reaches the same routes, so it gets the same checks.
  const s = await signIn('boss', OWNER_PW, ownerSecret);
  for (const url of ['/%61pi/auth/logout', '/%61%70%69/auth/logout', '/api/auth/%6Cogout']) {
    const sneaky = await app.inject({ method: 'POST', url, headers: { cookie: `${COOKIE}=${s}`, origin: 'https://evil.test' } });
    assert.equal(sneaky.statusCode, 403, url);
    assert.equal(code(sneaky), 'csrf', url);
  }
  assert.equal((await call({ url: '/api/me', cookie: s })).statusCode, 200, 'session survives');
  const malformed = await call({ method: 'POST', url: '/%E0%A4%A/auth/logout', cookie: s });
  assert.equal(malformed.statusCode, 400);
  const encodedGet = await call({ url: '/%61pi/setup/status' });
  assert.equal(encodedGet.headers['cache-control'], 'no-store');
});

test('session cookie: __Host- prefix, and a planted junk cookie does not hide the real one', async () => {
  const s = await signIn('boss', OWNER_PW, ownerSecret);
  const junk = 'x'.repeat(43);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${COOKIE}=${junk}; ${COOKIE}=${s}` } });
  assert.equal(me.statusCode, 200);
  const plain = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `ccv_session=${s}` } });
  assert.equal(plain.statusCode, 401, 'only the prefixed name counts on an HTTPS hub');
});

test('security headers, no-store on the API, SPA fallback and /internal guard', async () => {
  const api = await call({ url: '/api/setup/status' });
  assert.match(String(api.headers['content-security-policy']), /^default-src 'self'; script-src 'self'/);
  assert.equal(api.headers['x-content-type-options'], 'nosniff');
  assert.equal(api.headers['referrer-policy'], 'no-referrer');
  assert.equal(api.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()');
  assert.equal(api.headers['cache-control'], 'no-store');

  const page = await call({ url: '/live' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /dashboard/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  const deep = await call({ url: '/settings/users?x=1' });
  assert.equal(deep.statusCode, 200);
  assert.match(deep.body, /dashboard/);
  const asset = await call({ url: '/assets/app.js' });
  assert.equal(asset.statusCode, 200);
  assert.match(String(asset.headers['content-security-policy']), /frame-ancestors 'none'/);

  for (const url of ['/api/nothing', '/live/c1/whep', '/bridge/x', '/assets/missing.js']) {
    const r = await call({ url });
    assert.equal(r.statusCode, 404, url);
    assert.equal(code(r), 'not_found', url);
  }

  const local = await app.inject({ method: 'POST', url: '/internal/ping', remoteAddress: '127.0.0.1', headers: { 'content-type': 'application/json' }, payload: '{}' });
  assert.equal(local.statusCode, 200);
  const proxied = await app.inject({
    method: 'POST',
    url: '/internal/ping',
    remoteAddress: '127.0.0.1',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    payload: '{}',
  });
  assert.equal(proxied.statusCode, 404, 'requests through the reverse proxy never reach /internal');
  const remote = await app.inject({ method: 'POST', url: '/internal/ping', remoteAddress: '203.0.113.5', headers: { 'content-type': 'application/json' }, payload: '{}' });
  assert.equal(remote.statusCode, 404);
  const encoded = await app.inject({ method: 'POST', url: '/%69nternal/ping', remoteAddress: '203.0.113.5', headers: { 'content-type': 'application/json' }, payload: '{}' });
  assert.equal(encoded.statusCode, 404, 'an encoded path does not get past the /internal guard');
});

let viewerId = 0;
let viewerSecret = '';
let locA = 0;
let locB = 0;

test('users API: viewers only, never a second owner', async () => {
  locA = addLocation('Front');
  locB = addLocation('Back');

  const asOwner = await call({ method: 'POST', url: '/api/users', cookie: ownerSession, body: { username: 'clerk', password: VIEWER_PW, locationIds: [locA], role: 'owner' } });
  assert.equal(asOwner.statusCode, 422, 'role owner refused');

  const res = await call({ method: 'POST', url: '/api/users', cookie: ownerSession, body: { username: 'clerk', password: VIEWER_PW, locationIds: [locA] } });
  assert.equal(res.statusCode, 200, res.body);
  const viewer = res.json() as { id: number; role: string; locationIds: number[]; totpEnabled: boolean };
  assert.equal(viewer.role, 'viewer');
  assert.deepEqual(viewer.locationIds, [locA]);
  assert.equal(viewer.totpEnabled, false);
  viewerId = viewer.id;

  const dup = await call({ method: 'POST', url: '/api/users', cookie: ownerSession, body: { username: 'CLERK', password: VIEWER_PW, locationIds: [] } });
  assert.equal(dup.statusCode, 409);
  const badLoc = await call({ method: 'POST', url: '/api/users', cookie: ownerSession, body: { username: 'clerk2', password: VIEWER_PW, locationIds: [999] } });
  assert.equal(badLoc.statusCode, 422);

  const promote = await call({ method: 'PATCH', url: `/api/users/${viewerId}`, cookie: ownerSession, body: { role: 'owner' } });
  assert.equal(promote.statusCode, 422);
  const editOwner = await call({ method: 'PATCH', url: '/api/users/1', cookie: ownerSession, body: { disabled: true } });
  assert.equal(editOwner.statusCode, 422, 'owner account is not managed here');
  const deleteOwner = await call({ method: 'DELETE', url: '/api/users/1', cookie: ownerSession });
  assert.equal(deleteOwner.statusCode, 422);
  const missing = await call({ method: 'PATCH', url: '/api/users/9999', cookie: ownerSession, body: {} });
  assert.equal(missing.statusCode, 404);

  const roles = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'").get() as { n: number };
  assert.equal(roles.n, 1);

  const list = await call({ url: '/api/users', cookie: ownerSession });
  assert.equal((list.json() as { users: unknown[] }).users.length, 2);
});

test('viewer: enrolls 2-step, sees only own locations (404 otherwise), owner-only routes refused', async () => {
  const { secret, session } = await enroll('clerk', VIEWER_PW);
  viewerSecret = secret;
  const me = await call({ url: '/api/me', cookie: session });
  assert.deepEqual((me.json() as { locationIds: number[] }).locationIds, [locA]);

  assert.equal((await call({ url: `/api/test/locations/${locA}`, cookie: session })).statusCode, 200);
  const other = await call({ url: `/api/test/locations/${locB}`, cookie: session });
  assert.equal(other.statusCode, 404);
  assert.equal(code(other), 'not_found');
  assert.equal((await call({ url: '/api/test/locations/4242', cookie: session })).statusCode, 404);
  assert.equal((await call({ url: '/api/test/locations/4242', cookie: ownerSession })).statusCode, 404, 'owner: missing location is 404');
  assert.equal((await call({ url: `/api/test/locations/${locB}`, cookie: ownerSession })).statusCode, 200);

  assert.equal(auth.userCanStillView(viewerId, locA), true);
  assert.equal(auth.userCanStillView(viewerId, locB), false);

  const users = await call({ url: '/api/users', cookie: session });
  assert.equal(users.statusCode, 403);
  assert.equal(code(users), 'owner_only');
  assert.equal((await call({ url: '/api/audit', cookie: session })).statusCode, 403);
  assert.equal((await call({ method: 'PUT', url: '/api/keys/vault', cookie: session, body: {} })).statusCode, 403);
  assert.equal((await call({ url: '/api/keys/vault', cookie: session })).statusCode, 200);
  assert.equal((await call({ url: '/api/me' })).statusCode, 401);

  // Owner moves the viewer to location B; access follows at once.
  const patch = await call({ method: 'PATCH', url: `/api/users/${viewerId}`, cookie: ownerSession, body: { locationIds: [locB] } });
  assert.equal(patch.statusCode, 200, patch.body);
  assert.equal((await call({ url: `/api/test/locations/${locA}`, cookie: session })).statusCode, 404);
  assert.equal((await call({ url: `/api/test/locations/${locB}`, cookie: session })).statusCode, 200);

  // Disabling signs the viewer out.
  const off = await call({ method: 'PATCH', url: `/api/users/${viewerId}`, cookie: ownerSession, body: { disabled: true } });
  assert.equal(off.statusCode, 200);
  assert.equal((await call({ url: '/api/me', cookie: session })).statusCode, 401);
  assert.equal(auth.userCanStillView(viewerId, locB), false);
  await call({ method: 'PATCH', url: `/api/users/${viewerId}`, cookie: ownerSession, body: { disabled: false } });
});

test('user lockout after 5 failures, and IP throttle after 20', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await call({ method: 'POST', url: '/api/auth/login', body: { username: 'clerk', password: 'wrong password!!' }, ip: '192.0.2.1' });
    assert.equal(r.statusCode, 401);
  }
  const locked = await call({ method: 'POST', url: '/api/auth/login', body: { username: 'CLERK', password: VIEWER_PW }, ip: '192.0.2.1' });
  assert.equal(locked.statusCode, 429, 'locked even with the right password');
  assert.equal(code(locked), 'throttled');
  // Another network is not locked out by those tries.
  assert.ok(await signIn('clerk', VIEWER_PW, viewerSecret, '192.0.2.2'));

  // An unknown username locks the same way and with the same answer, so it shows nothing about which names exist.
  for (let i = 0; i < 5; i++) {
    const r = await call({ method: 'POST', url: '/api/auth/login', body: { username: 'nobody', password: 'wrong password!!' }, ip: '192.0.2.1' });
    assert.equal(r.statusCode, 401);
  }
  const ghost = await call({ method: 'POST', url: '/api/auth/login', body: { username: 'nobody', password: 'wrong password!!' }, ip: '192.0.2.1' });
  assert.equal(ghost.statusCode, 429);
  assert.deepEqual(ghost.json(), locked.json());
  clock += 15 * MIN;
  const session = await signIn('clerk', VIEWER_PW, viewerSecret, '192.0.2.1');
  assert.ok(session);

  // Parallel tries cannot slip past the limits: only a few reach the password check at all.
  const burst = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      call({ method: 'POST', url: '/api/auth/login', body: { username: 'boss', password: i === 11 ? OWNER_PW : `wrong password ${i}` }, ip: '192.0.2.9' }),
    ),
  );
  const statuses = burst.map((r) => r.statusCode);
  assert.ok(statuses.filter((s) => s === 401).length <= 5, statuses.join(','));
  assert.ok(!statuses.includes(200), 'the right password inside a burst is not confirmed');
  assert.ok(statuses.filter((s) => s === 429).length >= 7, statuses.join(','));
  const counted = db.prepare("SELECT COUNT(*) AS n FROM ip_failures WHERE ip = '192.0.2.9' AND kind = 'login'").get() as { n: number };
  assert.ok(counted.n <= 5, `failures counted: ${counted.n}`);
  clock += 15 * MIN;

  // 2-step code failures count too.
  for (let i = 0; i < 5; i++) {
    nextStep();
    const login = await call({ method: 'POST', url: '/api/auth/login', body: { username: 'clerk', password: VIEWER_PW }, ip: '192.0.2.3' });
    if (login.statusCode === 429) break;
    const { challenge } = login.json() as { challenge: string };
    await call({ method: 'POST', url: '/api/auth/totp', body: { challenge, code: '000000' === totpCode(viewerSecret, clock) ? '111111' : '000000' }, ip: '192.0.2.3' });
  }
  const afterCodes = await call({ method: 'POST', url: '/api/auth/login', body: { username: 'clerk', password: VIEWER_PW }, ip: '192.0.2.3' });
  assert.equal(afterCodes.statusCode, 429);
  clock += 15 * MIN;

  const ip = '203.0.113.77';
  for (let i = 0; i < 20; i++) {
    const r = await call({ method: 'POST', url: '/api/auth/login', body: { username: `ghost${i}`, password: 'wrong password!!' }, ip });
    assert.equal(r.statusCode, 401);
  }
  const blocked = await call({ method: 'POST', url: '/api/auth/login', body: { username: 'boss', password: OWNER_PW }, ip });
  assert.equal(blocked.statusCode, 429);
  const otherIp = await call({ method: 'POST', url: '/api/auth/login', body: { username: 'boss', password: OWNER_PW }, ip: '203.0.113.78' });
  assert.equal(otherIp.statusCode, 200);
  clock += 15 * MIN;
  const freed = await call({ method: 'POST', url: '/api/auth/login', body: { username: 'boss', password: OWNER_PW }, ip });
  assert.equal(freed.statusCode, 200);
});

test('password change keeps this session and signs out the others', async () => {
  const a = await signIn('clerk', VIEWER_PW, viewerSecret);
  const b = await signIn('clerk', VIEWER_PW, viewerSecret);
  const wrong = await call({ method: 'POST', url: '/api/me/password', cookie: a, body: { currentPassword: 'nope nope nope', newPassword: 'a brand new password' } });
  assert.equal(wrong.statusCode, 422);
  assert.equal(code(wrong), 'wrong_password');
  const ok = await call({ method: 'POST', url: '/api/me/password', cookie: a, body: { currentPassword: VIEWER_PW, newPassword: 'a brand new password' } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((await call({ url: '/api/me', cookie: a })).statusCode, 200);
  assert.equal((await call({ url: '/api/me', cookie: b })).statusCode, 401);
  db.prepare('UPDATE users SET failed_count = 0, first_failed_at = 0 WHERE username = ?').run('clerk');
});

test('2-step reset by the user and by the owner', async () => {
  const s = await signIn('clerk', 'a brand new password', viewerSecret);
  const res = await call({ method: 'POST', url: '/api/me/totp/reset', cookie: s, body: { password: 'a brand new password' } });
  assert.equal(res.statusCode, 200, res.body);
  const enr = res.json() as { challenge: string; secretBase32: string };
  nextStep();
  const done = await call({ method: 'POST', url: '/api/auth/totp', cookie: s, body: { challenge: enr.challenge, code: totpCode(enr.secretBase32, clock) } });
  assert.equal(done.statusCode, 200, done.body);
  viewerSecret = enr.secretBase32;
  await signIn('clerk', 'a brand new password', viewerSecret);

  const noPw = await call({ method: 'PATCH', url: `/api/users/${viewerId}`, cookie: ownerSession, body: { resetTotp: true } });
  assert.equal(noPw.statusCode, 422);
  const reset = await call({ method: 'PATCH', url: `/api/users/${viewerId}`, cookie: ownerSession, body: { resetTotp: true, password: OWNER_PW } });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal((reset.json() as { totpEnabled: boolean }).totpEnabled, false);
  const again = await enroll('clerk', 'a brand new password');
  assert.ok(again.secret);
});

test('vault key: owner sets it with a password re-check; audit log lists actions', async () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const spkiB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const wrong = await call({ method: 'PUT', url: '/api/keys/vault', cookie: ownerSession, body: { spkiB64, password: 'not my password' } });
  assert.equal(wrong.statusCode, 422);
  const small = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const weak = await call({ method: 'PUT', url: '/api/keys/vault', cookie: ownerSession, body: { spkiB64: small, password: OWNER_PW } });
  assert.equal(weak.statusCode, 422);
  const before = reconcileCalls;
  const ok = await call({ method: 'PUT', url: '/api/keys/vault', cookie: ownerSession, body: { spkiB64, password: OWNER_PW } });
  assert.equal(ok.statusCode, 200, ok.body);
  const info = ok.json() as { keyId: string; active: boolean };
  assert.match(info.keyId, /^[0-9a-f]{32}$/);
  assert.equal(info.active, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(reconcileCalls, before + 1);
  const list = await call({ url: '/api/keys/vault', cookie: ownerSession });
  assert.equal((list.json() as { activeKeyId: string }).activeKeyId, info.keyId);
  assert.equal(((await call({ url: '/api/setup/status' })).json() as { hasVaultKey: boolean }).hasVaultKey, true);

  const page1 = await call({ url: '/api/audit?limit=3', cookie: ownerSession });
  assert.equal(page1.statusCode, 200);
  const p1 = page1.json() as { items: { id: number; action: string }[]; nextCursor: string };
  assert.equal(p1.items.length, 3);
  assert.equal(p1.items[0].action, 'vault.key_set');
  assert.ok(p1.nextCursor);
  const page2 = await call({ url: `/api/audit?limit=3&cursor=${p1.nextCursor}`, cookie: ownerSession });
  const p2 = page2.json() as { items: { id: number }[] };
  assert.ok(p2.items[0].id < p1.items[2].id);
  assert.equal((await call({ url: '/api/audit?limit=999', cookie: ownerSession })).statusCode, 422);
  const actions = new Set((db.prepare('SELECT action FROM audit_log').all() as { action: string }[]).map((r) => r.action));
  for (const a of ['setup.owner', 'auth.login', 'auth.login_failed', 'auth.totp_enrolled', 'user.create', 'user.update', 'account.password', 'account.totp_reset', 'vault.key_set']) {
    assert.ok(actions.has(a), a);
  }
});

test('logout ends the session; deleting a viewer removes their sessions', async () => {
  const s = await signIn('boss', OWNER_PW, ownerSecret);
  const out = await call({ method: 'POST', url: '/api/auth/logout', cookie: s });
  assert.equal(out.statusCode, 200);
  assert.match(String(out.headers['set-cookie']), /Max-Age=0/);
  assert.equal((await call({ url: '/api/me', cookie: s })).statusCode, 401);

  const viewerRow = db.prepare('SELECT totp_secret_enc FROM users WHERE id = ?').get(viewerId) as { totp_secret_enc: string };
  assert.ok(viewerRow.totp_secret_enc.startsWith('v1:'), '2-step secret is sealed');
  const del = await call({ method: 'DELETE', url: `/api/users/${viewerId}`, cookie: ownerSession });
  assert.equal(del.statusCode, 200);
  const left = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(viewerId) as { n: number };
  assert.equal(left.n, 0);
});
