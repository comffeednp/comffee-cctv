import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import { openDatabase } from '../../src/db.ts';
import type { AppDeps, AuthHelpers, Secrets } from '../../src/contracts.ts';
import { LIVE_TOKEN_TTL_MS } from '../../src/contracts.ts';
import { LIVE_SESSION_MAX_MS, decideMediamtxAuth, isDirectLoopback, mediamtxAuthDecision } from '../../src/media/auth-hook.ts';
import type { AuthHookContext } from '../../src/media/auth-hook.ts';
import { issueLiveToken } from '../../src/streamtoken.ts';
import { registerInternalRoutes } from '../../src/api/internal.ts';

const secrets: Secrets = {
  masterKey: randomBytes(32),
  streamTokenKey: randomBytes(32),
  mediamtxUser: 'hub-internal',
  mediamtxPassword: 'internal-password-123',
};

function seed(): DatabaseSync {
  const db = openDatabase(':memory:');
  const t = Date.now();
  const user = db.prepare(
    'INSERT INTO users (id, username, password_hash, role, disabled, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  user.run(1, 'owner', 'x', 'owner', 0, t, t);
  user.run(2, 'viewer', 'x', 'viewer', 0, t, t);
  user.run(3, 'disabled', 'x', 'viewer', 1, t, t);
  const loc = db.prepare("INSERT INTO locations (id, name, timezone, connector, created_at) VALUES (?, ?, 'UTC', 'direct', ?)");
  loc.run(1, 'Front', t);
  loc.run(2, 'Back', t);
  db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (2, 1), (3, 1)').run();
  const cam = db.prepare(
    "INSERT INTO cameras (id, location_id, name, lan_ip, vendor, main_path, username, password_enc, created_at) VALUES (?, ?, ?, ?, 'tapo', '/stream1', 'u', 'x', ?)",
  );
  cam.run(1, 1, 'Door', '192.168.1.10', t);
  cam.run(2, 2, 'Yard', '192.168.1.11', t);
  return db;
}

/** Same rule as the core helper: user exists, not disabled, owner or listed for the location. */
function userCanStillView(db: DatabaseSync, userId: number, locationId: number): boolean {
  const u = db.prepare('SELECT role, disabled FROM users WHERE id = ?').get(userId) as { role: string; disabled: number } | undefined;
  if (!u || u.disabled) return false;
  if (u.role === 'owner') return true;
  return db.prepare('SELECT 1 AS one FROM user_locations WHERE user_id = ? AND location_id = ?').get(userId, locationId) !== undefined;
}

function context(db: DatabaseSync, nowMs = Date.now()): AuthHookContext {
  return {
    internalUser: secrets.mediamtxUser,
    internalPassword: secrets.mediamtxPassword,
    streamTokenKey: secrets.streamTokenKey,
    cameraLocationId(id) {
      const row = db.prepare('SELECT location_id FROM cameras WHERE id = ?').get(id) as { location_id: number } | undefined;
      return row ? row.location_id : null;
    },
    userCanStillView: (u, l) => userCanStillView(db, u, l),
    now: () => nowMs,
  };
}

const token = (path: string, userId: number, at = Date.now()): string =>
  issueLiveToken(secrets.streamTokenKey, path, userId, at).token;

const read = (path: string, tok: string) => ({ user: '', password: '', token: tok, action: 'read', path, protocol: 'webrtc' });

test('internal credentials are allowed only from 127.0.0.1', () => {
  const db = seed();
  const internal = { user: secrets.mediamtxUser, password: secrets.mediamtxPassword, action: 'publish', path: 'c1', protocol: 'rtsp' };
  assert.equal(decideMediamtxAuth(true, internal, context(db)), true);
  assert.equal(decideMediamtxAuth(true, { ...internal, action: 'api', path: '' }, context(db)), true);
  assert.equal(decideMediamtxAuth(false, internal, context(db)), false);
  assert.equal(decideMediamtxAuth(true, { ...internal, password: 'wrong' }, context(db)), false);
  assert.equal(decideMediamtxAuth(true, { ...internal, user: 'other' }, context(db)), false);
});

test('a live token allows WebRTC read of exactly its path', () => {
  const db = seed();
  const ctx = context(db);
  assert.equal(decideMediamtxAuth(true, read('c1', token('c1', 2)), ctx), true);
  assert.equal(decideMediamtxAuth(true, read('c1', token('c1', 1)), ctx), true, 'owner');
  assert.equal(decideMediamtxAuth(true, read('c2', token('c1', 2)), ctx), false, 'token for another path');
  assert.equal(decideMediamtxAuth(true, read('c1_src', token('c1_src', 1)), ctx), false, 'source path is never viewable');
  assert.equal(decideMediamtxAuth(true, read('c2', token('c2', 2)), ctx), false, 'viewer without access to that location');
  assert.equal(decideMediamtxAuth(false, read('c1', token('c1', 2)), ctx), false, 'not from loopback');
});

test('publishing or reading over other protocols with a token is denied', () => {
  const db = seed();
  const ctx = context(db);
  const tok = token('c1', 1);
  assert.equal(decideMediamtxAuth(true, { ...read('c1', tok), action: 'publish' }, ctx), false);
  assert.equal(decideMediamtxAuth(true, { ...read('c1', tok), action: 'playback' }, ctx), false);
  assert.equal(decideMediamtxAuth(true, { ...read('c1', tok), protocol: 'rtsp' }, ctx), false);
  assert.equal(decideMediamtxAuth(true, { ...read('c1', tok), protocol: 'hls' }, ctx), false);
  assert.equal(decideMediamtxAuth(true, { ...read('c1', ''), user: '', password: '' }, ctx), false);
});

test('revoked users are denied: disabled, deleted, access removed, camera deleted, token expired', () => {
  const db = seed();
  assert.equal(decideMediamtxAuth(true, read('c1', token('c1', 3)), context(db)), false, 'disabled user');
  const tok = token('c1', 2);
  assert.equal(decideMediamtxAuth(true, read('c1', tok), context(db)), true);
  assert.equal(decideMediamtxAuth(true, read('c1', tok), context(db, Date.now() + LIVE_TOKEN_TTL_MS + 1)), false, 'expired');
  db.prepare('DELETE FROM user_locations WHERE user_id = 2').run();
  assert.equal(decideMediamtxAuth(true, read('c1', tok), context(db)), false, 'location access removed');
  db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (2, 1)').run();
  db.prepare('UPDATE users SET disabled = 1 WHERE id = 2').run();
  assert.equal(decideMediamtxAuth(true, read('c1', tok), context(db)), false, 'disabled after the token was issued');
  db.prepare('DELETE FROM users WHERE id = 2').run();
  assert.equal(decideMediamtxAuth(true, read('c1', tok), context(db)), false, 'deleted user');
  const ownerTok = token('c1', 1);
  db.prepare('DELETE FROM cameras WHERE id = 1').run();
  assert.equal(decideMediamtxAuth(true, read('c1', ownerTok), context(db)), false, 'camera deleted');
});

test('malformed bodies are denied', () => {
  const db = seed();
  for (const body of [null, 'x', [], 42, {}, { action: 'read', protocol: 'webrtc', path: 'c1' }]) {
    assert.equal(decideMediamtxAuth(true, body, context(db)), false);
  }
});

test('loopback check refuses forwarded requests', () => {
  assert.equal(isDirectLoopback('127.0.0.1', {}), true);
  assert.equal(isDirectLoopback('::ffff:127.0.0.1', {}), true);
  assert.equal(isDirectLoopback('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }), false);
  assert.equal(isDirectLoopback('127.0.0.1', { forwarded: 'for=1.2.3.4' }), false);
  assert.equal(isDirectLoopback('10.0.0.5', {}), false);
  assert.equal(isDirectLoopback(undefined, {}), false);
});

test('POST /internal/mediamtx-auth answers 200 or 401', async () => {
  const db = seed();
  const auth = { userCanStillView: (u: number, l: number) => userCanStillView(db, u, l) } as unknown as AuthHelpers;
  const app = Fastify();
  registerInternalRoutes(app, { db, secrets, auth } as unknown as AppDeps);
  const internal = { user: secrets.mediamtxUser, password: secrets.mediamtxPassword, action: 'api', path: '', protocol: '' };
  const send = (payload: unknown, remoteAddress = '127.0.0.1', headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/internal/mediamtx-auth', payload: payload as object, remoteAddress, headers });

  assert.equal((await send(internal)).statusCode, 200);
  assert.equal((await send(internal, '203.0.113.9')).statusCode, 401);
  assert.equal((await send(internal, '127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })).statusCode, 401);
  assert.equal((await send(read('c1', token('c1', 2)))).statusCode, 200);
  assert.equal((await send({ ...read('c1', token('c1', 2)), action: 'publish' })).statusCode, 401);
  assert.equal((await send(read('c1', token('c1', 3)))).statusCode, 401);
  const ok = await send(internal);
  assert.equal(ok.body, '');
  const before = Date.now();
  const viewer = await send(read('c1', token('c1', 2)));
  assert.equal(viewer.statusCode, 200);
  const expireAt = Date.parse((viewer.json() as { expireAt: string }).expireAt);
  assert.ok(expireAt >= before + LIVE_SESSION_MAX_MS && expireAt <= Date.now() + LIVE_SESSION_MAX_MS, 'live session ends');
  await app.close();
});

test('live viewer sessions end after LIVE_SESSION_MAX_MS; internal sessions do not', () => {
  const db = seed();
  const nowMs = Date.now();
  const ctx = context(db, nowMs);
  assert.deepEqual(mediamtxAuthDecision(true, read('c1', token('c1', 2, nowMs)), ctx), {
    allow: true,
    expireAt: nowMs + LIVE_SESSION_MAX_MS,
  });
  const internal = { user: secrets.mediamtxUser, password: secrets.mediamtxPassword, action: 'publish', path: 'c1', protocol: 'rtsp' };
  assert.deepEqual(mediamtxAuthDecision(true, internal, ctx), { allow: true, expireAt: null });
  assert.deepEqual(mediamtxAuthDecision(true, read('c2', token('c2', 2, nowMs)), ctx), { allow: false, expireAt: null });
});
