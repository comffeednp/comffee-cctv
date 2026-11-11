import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { LIVE_TOKEN_TTL_MS } from '../../src/contracts.ts';
import { issueLiveToken, verifyLiveToken } from '../../src/streamtoken.ts';

const key = randomBytes(32);
const now = 1_800_000_000_000;

test('a fresh token verifies with its path, user and expiry', () => {
  const { token, expiresMs } = issueLiveToken(key, 'c5', 9, now);
  assert.equal(expiresMs, now + LIVE_TOKEN_TTL_MS);
  assert.match(token, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(verifyLiveToken(key, token, now + 1000), { path: 'c5', userId: 9, expiresMs });
});

test('tokens expire after 60 seconds', () => {
  const { token } = issueLiveToken(key, 'c5', 9, now);
  assert.ok(verifyLiveToken(key, token, now + LIVE_TOKEN_TTL_MS - 1));
  assert.equal(verifyLiveToken(key, token, now + LIVE_TOKEN_TTL_MS), null);
  assert.equal(verifyLiveToken(key, token, now + LIVE_TOKEN_TTL_MS + 3_600_000), null);
});

test('the path is bound by the signature', () => {
  const { token } = issueLiveToken(key, 'c5', 9, now);
  const [v, , mac] = token.split('.');
  const otherPayload = Buffer.from(JSON.stringify({ p: 'c6', u: 9, e: now + LIVE_TOKEN_TTL_MS })).toString('base64url');
  assert.equal(verifyLiveToken(key, `${v}.${otherPayload}.${mac}`, now), null);
  assert.equal(verifyLiveToken(key, token, now)?.path, 'c5');
});

test('wrong key, altered signature and malformed tokens fail', () => {
  const { token } = issueLiveToken(key, 'c5', 9, now);
  assert.equal(verifyLiveToken(randomBytes(32), token, now), null);
  const flipped = token.slice(0, -2) + (token.endsWith('A') ? 'B' : 'A') + token.slice(-1);
  assert.equal(verifyLiveToken(key, flipped, now), null);
  for (const bad of ['', 'v1', 'v1..', 'v2.' + token.slice(3), token + '.x', 'x'.repeat(600), 42, null, undefined]) {
    assert.equal(verifyLiveToken(key, bad, now), null);
  }
});

test('a correctly signed token with an expiry far in the future is refused', () => {
  const payload = Buffer.from(JSON.stringify({ p: 'c5', u: 9, e: now + 3_600_000 })).toString('base64url');
  const mac = createHmac('sha256', key).update(`v1.${payload}`).digest('base64url');
  assert.equal(verifyLiveToken(key, `v1.${payload}.${mac}`, now), null);
});

test('a correctly signed token with bad claims is refused', () => {
  for (const claims of [{ p: '', u: 9, e: now + 1000 }, { p: 'c5', u: 0, e: now + 1000 }, { p: 'c5', u: 9 }, [1, 2]]) {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const mac = createHmac('sha256', key).update(`v1.${payload}`).digest('base64url');
    assert.equal(verifyLiveToken(key, `v1.${payload}.${mac}`, now), null);
  }
});
