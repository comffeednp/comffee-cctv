import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { runCli } from '../../src/cli.ts';
import { buildConfig, loadConfig } from '../../src/config.ts';
import { createBox } from '../../src/crypto/box.ts';
import { openDatabase } from '../../src/db.ts';
import { loadOrCreateSecrets } from '../../src/secrets.ts';
import { burnPasswordCheck, hashPassword, passwordProblem, verifyPasswordHash } from '../../src/auth/password.ts';
import { base32Decode, base32Encode, hotp, otpauthUrl, totpCode, totpStep, verifyTotp } from '../../src/auth/totp.ts';
import { createSession, findSession, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../../src/auth/sessions.ts';
import {
  consumeSetupCode,
  createSetupCode,
  isSetupCodeValid,
  REGISTERED_SETUP_CODE_TTL_MS,
  registerSetupCode,
  SETUP_CODE_TTL_MS,
} from '../../src/auth/setup-codes.ts';
import {
  forgetLoginFailure,
  ipBlockedUntil,
  isIpBlocked,
  isLoginNameBlocked,
  loginNameKey,
  recordIpFailure,
  recordLoginFailure,
  recordUserFailure,
} from '../../src/auth/throttle.ts';

const MIN = 60_000;

function insertUser(db: ReturnType<typeof openDatabase>, username: string, role: 'owner' | 'viewer' = 'viewer'): number {
  const res = db
    .prepare('INSERT INTO users (username, password_hash, role, created_at, password_changed_at) VALUES (?, ?, ?, 0, 0)')
    .run(username, 'x', role);
  return Number(res.lastInsertRowid);
}

/* ------------------------------------------------------------------ passwords */

test('password hash has the stored format and verifies', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{86}==$/);
  assert.equal(await verifyPasswordHash('correct horse battery', hash), true);
  assert.equal(await verifyPasswordHash('correct horse batterz', hash), false);
  assert.equal(await verifyPasswordHash('correct horse battery', 'scrypt$1$1$1$x$y'), false);
  assert.equal(await verifyPasswordHash('anything', 'plain'), false);
  assert.equal(await burnPasswordCheck('anything at all'), false);
  const again = await hashPassword('correct horse battery');
  assert.notEqual(again, hash, 'salt is random');
});

test('password length rules', () => {
  assert.equal(passwordProblem('a'.repeat(12)), null);
  assert.equal(passwordProblem('a'.repeat(200)), null);
  assert.notEqual(passwordProblem('a'.repeat(11)), null);
  assert.notEqual(passwordProblem('a'.repeat(201)), null);
  assert.notEqual(passwordProblem(undefined), null);
});

/* ----------------------------------------------------------------------- TOTP */

test('base32 matches RFC 4648 vectors (no padding)', () => {
  const vectors: [string, string][] = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];
  for (const [plain, encoded] of vectors) {
    assert.equal(base32Encode(Buffer.from(plain)), encoded);
    assert.equal(base32Decode(encoded).toString(), plain);
  }
  assert.equal(base32Decode('mzxw 6ytb-oi======').toString(), 'foobar');
  assert.throws(() => base32Decode('MZ1'));
});

test('TOTP matches RFC 6238 SHA-1 test vectors', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  const b32 = base32Encode(secret);
  for (const [t, expected] of vectors) {
    assert.equal(hotp(secret, Math.floor(t / 30), 8, 'sha1'), expected, `T=${t}`);
    assert.equal(totpCode(b32, t * 1000), expected.slice(2), `6-digit T=${t}`);
  }
});

test('TOTP window is +-1 step and the replay guard refuses used steps', () => {
  const secret = base32Encode(randomBytes(20));
  const now = 1_800_000_000_000;
  const step = totpStep(now);
  const at = (s: number) => totpCode(secret, s * 30_000);
  assert.equal(verifyTotp(secret, at(step), now, 0), step);
  assert.equal(verifyTotp(secret, at(step - 1), now, 0), step - 1);
  assert.equal(verifyTotp(secret, at(step + 1), now, 0), step + 1);
  // Codes far outside the window fail (unless they happen to collide, which these do not check against).
  const far = at(step - 5);
  if (far !== at(step) && far !== at(step - 1) && far !== at(step + 1)) {
    assert.equal(verifyTotp(secret, far, now, 0), null);
  }
  // Replay: once step is used, the same code and older ones are refused.
  assert.equal(verifyTotp(secret, at(step), now, step), null);
  assert.equal(verifyTotp(secret, at(step - 1), now, step), null);
  assert.equal(verifyTotp(secret, at(step + 1), now, step), step + 1);
  assert.equal(verifyTotp(secret, 'abcdef', now, 0), null);
  assert.equal(verifyTotp(secret, '1234567', now, 0), null);
});

test('otpauth URL uses the issuer and label from the contract', () => {
  assert.equal(
    otpauthUrl('cashier.1', 'ABC'),
    'otpauth://totp/Comffee%20CCTV:cashier.1?secret=ABC&issuer=Comffee%20CCTV&algorithm=SHA1&digits=6&period=30',
  );
});

/* ------------------------------------------------------------------------ box */

test('box seals and opens, and refuses tampered or foreign values', () => {
  const box = createBox(randomBytes(32));
  const sealed = box.seal('JBSWY3DPEHPK3PXP');
  assert.match(sealed, /^v1:/);
  assert.notEqual(box.seal('JBSWY3DPEHPK3PXP'), sealed, 'fresh iv each time');
  assert.equal(box.open(sealed), 'JBSWY3DPEHPK3PXP');
  const raw = Buffer.from(sealed.slice(3), 'base64');
  raw[14] ^= 1;
  assert.throws(() => box.open('v1:' + raw.toString('base64')));
  assert.throws(() => createBox(randomBytes(32)).open(sealed));
  assert.throws(() => box.open('v2:abc'));
});

/* ------------------------------------------------------------ config, secrets */

test('config: defaults, origin check and development mode', () => {
  const cfg = buildConfig({ publicOrigin: 'https://cctv.example.com/' });
  assert.equal(cfg.publicOrigin, 'https://cctv.example.com');
  assert.equal(cfg.publicHost, 'cctv.example.com');
  assert.equal(cfg.listenPort, 8080);
  assert.equal(cfg.devInsecureCookies, false);
  assert.throws(() => buildConfig({}));
  assert.throws(() => buildConfig({ publicOrigin: 'https://cctv.example.com/app' }));
  assert.throws(() => buildConfig({ publicOrigin: 'https://x.example', listenPort: 'eighty' }));

  const dev = loadConfig({ CCTV_DEV: '1', COMFFEE_CCTV_CONFIG: path.join(tmpdir(), 'no-such-hub-config.json') });
  assert.equal(dev.publicOrigin, 'http://localhost:8080');
  assert.equal(dev.devInsecureCookies, true);
  assert.equal(dev.wireguard.enabled, false);
  assert.equal(dev.dataDir, path.resolve('./data'));
  assert.throws(() => loadConfig({ COMFFEE_CCTV_CONFIG: path.join(tmpdir(), 'no-such-hub-config.json') }));
});

test('config: bridge download address is optional and must be https', () => {
  const origin = { publicOrigin: 'https://cctv.example.com' };
  assert.equal(buildConfig(origin).bridgeDownloadUrl, null);
  assert.equal(buildConfig({ ...origin, bridgeDownloadUrl: null }).bridgeDownloadUrl, null);
  assert.equal(buildConfig({ ...origin, bridgeDownloadUrl: '' }).bridgeDownloadUrl, null);
  assert.equal(
    buildConfig({ ...origin, bridgeDownloadUrl: 'https://example.com/releases/latest' }).bridgeDownloadUrl,
    'https://example.com/releases/latest',
  );
  assert.throws(() => buildConfig({ ...origin, bridgeDownloadUrl: 'http://example.com/bridge' }));
  assert.throws(() => buildConfig({ ...origin, bridgeDownloadUrl: 'javascript:alert(1)' }));
  assert.throws(() => buildConfig({ ...origin, bridgeDownloadUrl: 'https://user:pw@example.com/' }));
  assert.throws(() => buildConfig({ ...origin, bridgeDownloadUrl: 42 }));
});

test('secrets are created once and reloaded unchanged', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccv-secrets-'));
  try {
    const a = loadOrCreateSecrets(dir);
    const b = loadOrCreateSecrets(dir);
    assert.equal(a.masterKey.length, 32);
    assert.equal(a.streamTokenKey.length, 32);
    assert.ok(a.masterKey.equals(b.masterKey));
    assert.ok(a.streamTokenKey.equals(b.streamTokenKey));
    assert.equal(a.mediamtxPassword, b.mediamtxPassword);
    assert.ok(a.mediamtxPassword.length >= 16);
    if (process.platform !== 'win32') {
      assert.equal(statSync(path.join(dir, 'secrets', 'master.key')).mode & 0o777, 0o600);
      assert.equal(statSync(path.join(dir, 'secrets', 'mediamtx-internal.json')).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------- database */

test('database has the schema version and refuses a second owner', () => {
  const db = openDatabase(':memory:');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
  assert.equal(row.value, '1');
  insertUser(db, 'boss', 'owner');
  assert.throws(() => insertUser(db, 'boss2', 'owner'), /UNIQUE/);
  const viewer = insertUser(db, 'clerk');
  assert.throws(() => db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(viewer), /UNIQUE/);
  db.close();
});

test('database never gives out a deleted user, location or camera id again', () => {
  const db = openDatabase(':memory:');
  const addLocation = (): number =>
    Number(db.prepare("INSERT INTO locations (name, timezone, connector, created_at) VALUES ('L', 'UTC', 'direct', 0)").run().lastInsertRowid);
  const addCamera = (loc: number, ip: string): number =>
    Number(
      db
        .prepare("INSERT INTO cameras (location_id, name, lan_ip, vendor, main_path, username, password_enc, created_at) VALUES (?, 'C', ?, 'tapo', '/stream1', 'u', 'x', 0)")
        .run(loc, ip).lastInsertRowid,
    );

  const u1 = insertUser(db, 'first');
  db.prepare('DELETE FROM users WHERE id = ?').run(u1);
  assert.ok(insertUser(db, 'second') > u1, 'user id not reused');

  const l1 = addLocation();
  const c1 = addCamera(l1, '192.168.1.5');
  db.prepare('DELETE FROM cameras WHERE id = ?').run(c1);
  const c2 = addCamera(l1, '192.168.1.5');
  assert.ok(c2 > c1, 'camera id not reused');
  db.prepare('DELETE FROM locations WHERE id = ?').run(l1);
  const l2 = addLocation();
  assert.ok(l2 > l1, 'location id not reused');
  assert.ok(addCamera(l2, '192.168.1.5') > c2, 'camera id not reused after its location was deleted');
  db.close();
});

/* ------------------------------------------------------------------- sessions */

test('session idle timeout is 12 h', () => {
  const db = openDatabase(':memory:');
  const uid = insertUser(db, 'clerk');
  const t0 = 1_800_000_000_000;
  const token = createSession(db, uid, { ip: '10.0.0.1' }, t0);
  assert.ok(findSession(db, token, t0 + SESSION_IDLE_MS - 1));
  // That use reset the idle clock.
  assert.ok(findSession(db, token, t0 + 2 * SESSION_IDLE_MS - 2));
  assert.equal(findSession(db, token, t0 + 3 * SESSION_IDLE_MS), null);
  assert.equal(findSession(db, token, t0), null, 'expired session row was deleted');
  db.close();
});

test('session absolute limit is 7 days even when used all the time', () => {
  const db = openDatabase(':memory:');
  const uid = insertUser(db, 'clerk');
  const t0 = 1_800_000_000_000;
  const token = createSession(db, uid, {}, t0);
  let t = t0;
  while (t + 11 * 60 * MIN < t0 + SESSION_ABSOLUTE_MS) {
    t += 11 * 60 * MIN;
    assert.ok(findSession(db, token, t), `alive at ${(t - t0) / 3_600_000} h`);
  }
  assert.equal(findSession(db, token, t0 + SESSION_ABSOLUTE_MS), null);
  assert.equal(findSession(db, 'not-a-token', t0), null);
  db.close();
});

/* ---------------------------------------------------------------- setup codes */

test('setup code works once and expires after 24 h', () => {
  const db = openDatabase(':memory:');
  const t0 = 1_800_000_000_000;
  const code = createSetupCode(db, t0);
  assert.match(code, /^([A-Z2-7]{4}-){6}[A-Z2-7]{2}$/);
  assert.equal(isSetupCodeValid(db, code.toLowerCase().replace(/-/g, ' '), t0 + 1), true);
  assert.equal(consumeSetupCode(db, code, t0 + 1), true);
  assert.equal(consumeSetupCode(db, code, t0 + 2), false, 'single use');
  assert.equal(isSetupCodeValid(db, code, t0 + 2), false);

  const late = createSetupCode(db, t0);
  assert.equal(isSetupCodeValid(db, late, t0 + SETUP_CODE_TTL_MS - 1), true);
  assert.equal(consumeSetupCode(db, late, t0 + SETUP_CODE_TTL_MS), false, 'expired');
  assert.equal(consumeSetupCode(db, 'AAAA', t0), false);
  assert.equal(consumeSetupCode(db, 42, t0), false);
  db.close();
});

test('a registered setup code (desktop install) lasts 30 days, a printed one 24 h', () => {
  const db = openDatabase(':memory:');
  const t0 = 1_800_000_000_000;
  assert.equal(REGISTERED_SETUP_CODE_TTL_MS, 30 * 24 * 60 * 60 * 1000);
  const given = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  assert.equal(registerSetupCode(db, given, t0), true);
  assert.equal(isSetupCodeValid(db, given, t0 + SETUP_CODE_TTL_MS + 1), true, 'still valid after 24 h');
  assert.equal(isSetupCodeValid(db, given, t0 + REGISTERED_SETUP_CODE_TTL_MS - 1), true);
  assert.equal(consumeSetupCode(db, given, t0 + REGISTERED_SETUP_CODE_TTL_MS), false, 'expired after 30 days');

  const printed = createSetupCode(db, t0);
  assert.equal(isSetupCodeValid(db, printed, t0 + SETUP_CODE_TTL_MS), false, 'a printed code keeps 24 h');
  db.close();
});

test('cli setup-code --code registers a given code by its hash only, once', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccv-cli-'));
  try {
    const configFile = path.join(dir, 'hub.json');
    writeFileSync(configFile, JSON.stringify({ dataDir: path.join(dir, 'data'), publicOrigin: 'https://cctv.example.com' }));
    const env = { COMFFEE_CCTV_CONFIG: configFile };
    const run = async (args: string[]) => {
      const lines: string[] = [];
      const code = await runCli(args, { env, out: (l) => lines.push(l), err: (l) => lines.push(l) });
      return { code, text: lines.join('\n') };
    };
    const given = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    assert.equal((await run(['setup-code', '--code', 'too-short'])).code, 1);
    assert.equal((await run(['setup-code', '--code', 'ABCDEFGHIJKLMNOPQRSTUVWXY1'])).code, 1, 'not base32');
    assert.equal((await run(['setup-code', '--code'])).code, 1, 'value missing');
    assert.equal((await run(['setup-code', '--code', given, 'extra'])).code, 1);

    const ok = await run(['setup-code', '--code', given.toLowerCase().replace(/(.{4})/g, '$1-')]);
    assert.equal(ok.code, 0, ok.text);
    assert.equal(ok.text.toUpperCase().replace(/-/g, '').includes(given), false, 'the code is not printed');
    assert.match(ok.text, /https:\/\/cctv\.example\.com\/setup/);
    assert.match(ok.text, /within 30 days/);
    assert.equal((await run(['setup-code', `--code=${given}`])).code, 0, 'registering the same unused code again is fine');

    const db = openDatabase(path.join(dir, 'data', 'db.sqlite'));
    try {
      const rows = db.prepare('SELECT code_hash FROM setup_codes').all() as { code_hash: string }[];
      assert.deepEqual(rows.map((r) => r.code_hash), [createHash('sha256').update(given).digest('hex')]);
      const now = Date.now();
      assert.equal(isSetupCodeValid(db, given, now), true);
      assert.equal(consumeSetupCode(db, given, now), true);
    } finally {
      db.close();
    }
    const reused = await run(['setup-code', '--code', given]);
    assert.equal(reused.code, 1, 'a used code cannot be registered again');
    assert.match(reused.text, /already used/);

    const printed = await run(['setup-code']);
    assert.equal(printed.code, 0);
    assert.match(printed.text, /Setup code: ([A-Z2-7]{4}-){6}[A-Z2-7]{2}/, 'without --code a new code is still printed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------- throttle */

test('IP throttle: 20 login failures in 15 min block that IP for 15 min', () => {
  const db = openDatabase(':memory:');
  const t0 = 1_800_000_000_000;
  for (let i = 0; i < 19; i++) recordIpFailure(db, '203.0.113.9', 'login', t0 + i * 1000);
  assert.equal(isIpBlocked(db, '203.0.113.9', 'login', t0 + 20_000), false);
  recordIpFailure(db, '203.0.113.9', 'login', t0 + 19_000);
  assert.equal(isIpBlocked(db, '203.0.113.9', 'login', t0 + 20_000), true);
  assert.equal(isIpBlocked(db, '198.51.100.1', 'login', t0 + 20_000), false, 'other IPs unaffected');
  assert.equal(isIpBlocked(db, '203.0.113.9', 'setup', t0 + 20_000), false, 'other kinds unaffected');
  assert.equal(ipBlockedUntil(db, '203.0.113.9', 'login', t0 + 20_000), t0 + 19_000 + 15 * MIN);
  assert.equal(isIpBlocked(db, '203.0.113.9', 'login', t0 + 19_000 + 15 * MIN - 1), true);
  assert.equal(isIpBlocked(db, '203.0.113.9', 'login', t0 + 19_000 + 15 * MIN), false);

  // 20 failures spread over more than 15 minutes do not block.
  for (let i = 0; i < 20; i++) recordIpFailure(db, '192.0.2.7', 'login', t0 + i * MIN);
  assert.equal(isIpBlocked(db, '192.0.2.7', 'login', t0 + 20 * MIN), false);

  // Setup codes: 10 per hour.
  for (let i = 0; i < 10; i++) recordIpFailure(db, '192.0.2.8', 'setup', t0 + i * MIN);
  assert.equal(isIpBlocked(db, '192.0.2.8', 'setup', t0 + 30 * MIN), true);
  db.close();
});

test('user lockout: 5 failures in 15 min lock the account for 15 min', () => {
  const db = openDatabase(':memory:');
  const uid = insertUser(db, 'clerk');
  const t0 = 1_800_000_000_000;
  const lockedUntil = () => (db.prepare('SELECT locked_until FROM users WHERE id = ?').get(uid) as { locked_until: number }).locked_until;
  for (let i = 0; i < 4; i++) recordUserFailure(db, uid, t0 + i * MIN);
  assert.equal(lockedUntil(), 0);
  recordUserFailure(db, uid, t0 + 4 * MIN);
  assert.equal(lockedUntil(), t0 + 4 * MIN + 15 * MIN);

  // Failures more than 15 minutes apart start a new count.
  const uid2 = insertUser(db, 'clerk2');
  for (let i = 0; i < 6; i++) recordUserFailure(db, uid2, t0 + i * 16 * MIN);
  assert.equal((db.prepare('SELECT locked_until FROM users WHERE id = ?').get(uid2) as { locked_until: number }).locked_until, 0);
  db.close();
});

test('username throttle: 5 per (name, IP), 100 per name from all IPs, same for unknown names', () => {
  const db = openDatabase(':memory:');
  const t0 = 1_800_000_000_000;
  const key = loginNameKey('Boss');
  assert.equal(key, loginNameKey('boss'), 'case does not matter');
  assert.match(key, /^[0-9a-f]{64}$/, 'the typed name is never stored as text');
  for (let i = 0; i < 4; i++) recordLoginFailure(db, '192.0.2.1', key, t0 + i * 1000);
  assert.equal(isLoginNameBlocked(db, key, '192.0.2.1', t0 + 5000), false);
  const last = recordLoginFailure(db, '192.0.2.1', key, t0 + 4000);
  assert.equal(isLoginNameBlocked(db, key, '192.0.2.1', t0 + 5000), true);
  assert.equal(isLoginNameBlocked(db, key, '192.0.2.2', t0 + 5000), false, 'other networks still get in');
  assert.equal(isLoginNameBlocked(db, key, '192.0.2.1', t0 + 4000 + 15 * MIN), false, 'block ends after 15 min');
  forgetLoginFailure(db, last);
  assert.equal(isLoginNameBlocked(db, key, '192.0.2.1', t0 + 5000), false, 'a taken-back try does not count');

  const other = loginNameKey('someone');
  for (let i = 0; i < 100; i++) recordLoginFailure(db, '198.51.100.' + i, other, t0 + i * 100);
  assert.equal(isLoginNameBlocked(db, other, '203.0.113.1', t0 + 10_000), true, 'name blocked everywhere after 100');
  db.close();
});
