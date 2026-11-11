// Oracle account helpers: config preview parsing, fingerprints, the browser sign-in link and listener,
// session token claims, server links and IPC argument checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { request } from 'node:http';
import { parseConfigPreview } from '../src/lib/oci-config.ts';
import { apiKeyFingerprint, generateSshKeyPair, readSessionToken, signInPublicKeyParam } from '../src/lib/keys.ts';
import { hubUrlFromIp, isPublicIpv4, isSameOrigin, normaliseServerLink } from '../src/lib/hub-url.ts';
import { OCI_REGIONS, serviceEndpoint } from '../src/lib/oci-regions.ts';
import * as v from '../src/lib/validate.ts';
import { REDIRECT_URI, SIGN_IN_PORT, buildAuthorizeUrl, startSignInListener } from '../src/main/oracle-sign-in.ts';

const USER = 'ocid1.user.oc1..aaaaaaaat5nvwcna5j6aqzjcaty5eqbb6qt2jvpkanghtgdaqedqw3rynjq';
const TENANCY = 'ocid1.tenancy.oc1..aaaaaaaaba3pv6wkcr4jqae5f15p2b2m2yt2j6rx32uzr4h25vqstifsfdsq';
const PREVIEW = `[DEFAULT]
user=${USER}
fingerprint=20:3B:97:13:55:1c:5b:0d:d3:37:d8:50:4e:c5:3a:34
tenancy=${TENANCY}
region=ap-singapore-1
key_file=<path to your private keyfile> # TODO
`;

test('reads Oracle\'s configuration file preview', () => {
  const parsed = parseConfigPreview(PREVIEW);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.config, {
    userId: USER,
    tenancyId: TENANCY,
    fingerprint: '20:3b:97:13:55:1c:5b:0d:d3:37:d8:50:4e:c5:3a:34',
    region: 'ap-singapore-1',
  });
  // Windows line ends and spaces around "=".
  assert.ok(parseConfigPreview(PREVIEW.replace(/\n/g, '\r\n').replace(/=/g, ' = ')).ok);
});

test('config preview errors say what is missing', () => {
  assert.equal(parseConfigPreview('').ok, false);
  const noUser = parseConfigPreview(PREVIEW.replace(/^user=.*$/m, ''));
  assert.ok(!noUser.ok && /user line/.test(noUser.error));
  const badRegion = parseConfigPreview(PREVIEW.replace('ap-singapore-1', 'mars-1'));
  assert.ok(!badRegion.ok && /region/.test(badRegion.error));
  const second = parseConfigPreview(`${PREVIEW}\n[OTHER]\nuser=x\n`);
  assert.ok(second.ok, 'only the first profile counts');
  assert.equal(parseConfigPreview('x'.repeat(5000)).ok, false);
});

test('API key fingerprint is MD5 of the public key DER, colon hex', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const fp = apiKeyFingerprint(privateKey);
  assert.match(fp, /^([0-9a-f]{2}:){15}[0-9a-f]{2}$/);
  assert.equal(apiKeyFingerprint(createPublicKey(privateKey)), fp);
});

test('the app SSH key is an OpenSSH ed25519 public key line', () => {
  const pair = generateSshKeyPair();
  const [kind, blob, comment] = pair.publicKey.split(' ');
  assert.equal(kind, 'ssh-ed25519');
  assert.equal(comment, 'comffee-cctv');
  const raw = Buffer.from(blob!, 'base64');
  assert.equal(raw.readUInt32BE(0), 11);
  assert.equal(raw.subarray(4, 15).toString(), 'ssh-ed25519');
  assert.equal(raw.readUInt32BE(15), 32);
  assert.equal(raw.length, 4 + 11 + 4 + 32);
  assert.match(pair.privateKeyPem, /^-----BEGIN PRIVATE KEY-----/);
});

test('sign-in link matches the OCI CLI (oci session authenticate)', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const param = signInPublicKeyParam(publicKey);
  const json = Buffer.from(param, 'base64url').toString('utf8');
  const jwk = publicKey.export({ format: 'jwk' });
  assert.equal(json, `{"kty": "RSA", "n": "${jwk.n}", "e": "AQAB", "kid": "Ignored"}`);
  assert.ok(!/[+/]/.test(param), 'url-safe alphabet');
  assert.equal(param.length % 4, 0, 'padded like Python urlsafe_b64encode');

  const url = new URL(buildAuthorizeUrl('ap-singapore-1', param, 'nonce-1'));
  assert.equal(url.origin, 'https://login.ap-singapore-1.oraclecloud.com');
  assert.equal(url.pathname, '/v1/oauth2/authorize');
  assert.equal(url.searchParams.get('action'), 'login');
  assert.equal(url.searchParams.get('client_id'), 'iaas_console');
  assert.equal(url.searchParams.get('response_type'), 'token id_token');
  assert.equal(url.searchParams.get('scope'), 'openid');
  assert.equal(url.searchParams.get('nonce'), 'nonce-1');
  assert.equal(url.searchParams.get('public_key'), param);
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:8181');
  assert.match(url.search, /response_type=token\+id_token/, 'spaces as + like Python urlencode');
  assert.equal(REDIRECT_URI, `http://localhost:${SIGN_IN_PORT}`);
});

test('regions: Singapore first, endpoints only for known regions', () => {
  assert.equal(OCI_REGIONS[0]!.name, 'ap-singapore-1');
  assert.equal(serviceEndpoint('iaas', 'us-ashburn-1'), 'https://iaas.us-ashburn-1.oraclecloud.com');
  assert.equal(serviceEndpoint('auth', 'ap-singapore-1'), 'https://auth.ap-singapore-1.oraclecloud.com');
  assert.throws(() => serviceEndpoint('iaas', 'evil.example.com/x'));
});

function fakeJwt(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.c2ln`;
}

test('session token claims', () => {
  const info = readSessionToken(fakeJwt({ sub: USER, tenant: TENANCY, exp: 1_800_000_000, jwk: JSON.stringify({ n: 'abc', e: 'AQAB' }) }));
  assert.deepEqual(info, { userId: USER, tenancyId: TENANCY, expiresAt: 1_800_000_000_000, boundKeyN: 'abc' });
  assert.equal(readSessionToken(fakeJwt({ sub: USER, tenant: TENANCY }))?.expiresAt, undefined);
  assert.equal(readSessionToken('not a token'), null);
  assert.equal(readSessionToken(fakeJwt({ sub: USER, tenant: TENANCY, exp: 1 }))!.boundKeyN, null);
});

test('server links and sslip.io names', () => {
  assert.equal(hubUrlFromIp('203.0.113.10'), 'https://203-0-113-10.sslip.io');
  assert.throws(() => hubUrlFromIp('10.0.0.5'));
  assert.equal(isPublicIpv4('192.168.1.1'), false);
  assert.equal(isPublicIpv4('100.64.0.1'), false);
  assert.equal(isPublicIpv4('8.8.8.8'), true);
  assert.deepEqual(normaliseServerLink(' cctv.example.com/live '), { ok: true, origin: 'https://cctv.example.com' });
  assert.deepEqual(normaliseServerLink('https://203-0-113-10.sslip.io/setup#code=x'), { ok: true, origin: 'https://203-0-113-10.sslip.io' });
  assert.equal(normaliseServerLink('http://cctv.example.com').ok, false);
  assert.equal(normaliseServerLink('https://user:pw@cctv.example.com').ok, false);
  assert.equal(normaliseServerLink('javascript:alert(1)').ok, false);
  assert.equal(normaliseServerLink('').ok, false);
  assert.equal(isSameOrigin('https://a.example.com/x', 'https://a.example.com'), true);
  assert.equal(isSameOrigin('https://a.example.com.evil.com/', 'https://a.example.com'), false);
});

test('IPC argument checks', () => {
  assert.equal(v.id('0123456789abcdef01234567'), '0123456789abcdef01234567');
  assert.throws(() => v.id('../etc'));
  assert.throws(() => v.id(42));
  assert.equal(v.optionalId(null), null);
  assert.equal(v.displayName('  Main shop  '), 'Main shop');
  assert.throws(() => v.displayName('a\u0000b'));
  assert.throws(() => v.displayName('x'.repeat(61)));
  assert.throws(() => v.bool('true', 'x'));
  assert.throws(() => v.oneOf('other', ['a', 'b'], 'x'));
});

function get(path: string, host = `127.0.0.1:${SIGN_IN_PORT}`): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: SIGN_IN_PORT, path, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('sign-in listener hands over the token from the fragment page', async (t) => {
  let listener;
  try {
    listener = await startSignInListener(30_000);
  } catch {
    t.skip('port 8181 is in use on this computer');
    return;
  }
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.body, /<script src="\/callback\.js"><\/script>/);
  assert.doesNotMatch(page.body, /<script>/, 'no inline script');
  assert.equal((await get('/callback.js')).status, 200);
  assert.equal((await get('/', 'evil.example.com')).status, 400, 'other Host headers are refused');
  assert.equal((await get('/token?nothing=1')).status, 400);
  assert.equal((await get('/token?security_token=abc.def.ghi&expires_in=3600')).status, 200);
  assert.equal(await listener.token, 'abc.def.ghi');
  assert.equal((await get('/token?security_token=second')).status, 409, 'only the first token counts');
});
