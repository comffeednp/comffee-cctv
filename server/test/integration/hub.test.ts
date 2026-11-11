/**
 * End-to-end check of the hub on one machine, without the cloud.
 *
 * Starts a fake camera (an ffmpeg test pattern published to a second MediaMTX that serves /stream1 and
 * /stream2 over RTSP), MediaMTX for the hub from deploy/mediamtx.yml.template (temp data folder, local
 * ports only, 10 second segments), and the hub itself in development mode. Everything after that goes
 * through the hub's HTTP API, the way the dashboard uses it.
 *
 * Needs ffmpeg and ffprobe on PATH and the pinned MediaMTX in .cache (node scripts/dev/fetch-mediamtx.mjs).
 * The test is skipped when one of them is missing, when the machine has no network address other than
 * loopback (the hub refuses 127.x camera addresses), or with CCTV_SKIP_INTEGRATION=1.
 * CCTV_E2E_KEEP=1 keeps the temp folder (logs, data) for a look afterwards.
 */

import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createDecipheriv, createHash, createHmac, constants as cryptoConstants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import { connect, createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../src/cli.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TEMPLATE = path.join(REPO, 'deploy', 'mediamtx.yml.template');
const SEGMENT_SECONDS = 10;
const OWNER = { username: 'owner', password: 'owner password for e2e' };
const VIEWER = { username: 'viewer-b', password: 'viewer password for e2e' };
const LOCKED = { username: 'lock-check', password: 'lock-check password e2e' };
/** MediaMTX allows only some symbols in credentials; these still need URL encoding (@ # !). */
const CAMERA_LOGIN = { username: 'camadmin', password: 'Cam!pass@1#x' };
/** Session cookie name with devInsecureCookies (no __Host- prefix). */
const COOKIE_NAME = 'ccv_session';
const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ environment */

function pinnedMediamtx(): string | null {
  const version = /MediaMTX\s+(v\d+\.\d+\.\d+)/.exec(readFileSync(TEMPLATE, 'utf8'))?.[1];
  if (!version) return null;
  const cache = path.join(REPO, '.cache');
  if (!existsSync(cache)) return null;
  const exe = process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx';
  for (const dir of readdirSync(cache)) {
    if (!dir.startsWith(`mediamtx-${version}-`)) continue;
    const p = path.join(cache, dir, exe);
    if (existsSync(p)) return p;
  }
  return null;
}

function hasTool(name: string): boolean {
  const r = spawnSync(name, ['-hide_banner', '-version'], { stdio: 'ignore' });
  return r.status === 0;
}

function isPrivate(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** A network address of this machine the hub accepts as a camera address (not 127.x, not link-local). */
function cameraHostAddress(): string | null {
  const found: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) found.push(a.address);
    }
  }
  return found.find(isPrivate) ?? found[0] ?? null;
}

function skipReason(): string | null {
  if (process.env.CCTV_SKIP_INTEGRATION === '1') return 'CCTV_SKIP_INTEGRATION=1';
  if (!pinnedMediamtx()) return 'pinned MediaMTX not in .cache (run: node scripts/dev/fetch-mediamtx.mjs)';
  if (!hasTool('ffmpeg') || !hasTool('ffprobe')) return 'ffmpeg and ffprobe must be on PATH';
  if (!cameraHostAddress()) return 'no non-loopback IPv4 address for the fake camera';
  return null;
}

/* ------------------------------------------------------------------ helpers */

function freeTcpPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function freeUdpPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = createSocket('udp4');
    sock.once('error', reject);
    sock.bind(0, host, () => {
      const port = sock.address().port;
      sock.close(() => resolve(port));
    });
  });
}

function tcpOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (ok: boolean): void => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(1000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(label: string, timeoutMs: number, fn: () => Promise<T | null | undefined | false>, everyMs = 500): Promise<T> {
  const until = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > until) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}${lastError ? `: ${(lastError as Error).message}` : ''}`);
    }
    await sleep(everyMs);
  }
}

interface Proc {
  name: string;
  child: ChildProcess;
  log: string;
}

function startProcess(name: string, cmd: string, args: string[], logDir: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Proc {
  const log = path.join(logDir, `${name}.log`);
  const out = createWriteStream(log, { flags: 'a' });
  const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout?.pipe(out, { end: false });
  child.stderr?.pipe(out, { end: false });
  child.once('exit', (code, signal) => out.end(`\n[exited code=${code} signal=${signal}]\n`));
  return { name, child, log };
}

function stopProcess(p: Proc): Promise<void> {
  if (p.child.exitCode !== null || p.child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 5000);
    p.child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    p.child.kill();
  });
}

function tail(file: string, lines = 30): string {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

/* ------------------------------------------------------------------ 2-step codes (RFC 6238, own copy) */

function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/=+$/, '').toUpperCase()) {
    const i = alphabet.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = (h[h.length - 1] as number) & 0xf;
  const bin = (((h[off] as number) & 0x7f) << 24) | ((h[off + 1] as number) << 16) | ((h[off + 2] as number) << 8) | (h[off + 3] as number);
  return String(bin % 1_000_000).padStart(6, '0');
}

const usedSteps = new Map<string, number>();

/** A code the hub has not seen for this secret yet (the hub accepts one step ahead, and never a step twice). */
async function freshCode(secretBase32: string): Promise<string> {
  for (;;) {
    const now = Math.floor(Date.now() / 30_000);
    const step = Math.max(now, (usedSteps.get(secretBase32) ?? -1) + 1);
    if (step <= now + 1) {
      usedSteps.set(secretBase32, step);
      return hotp(base32Decode(secretBase32), step);
    }
    await sleep(1000);
  }
}

function wrongCode(secretBase32: string): string {
  const now = Math.floor(Date.now() / 30_000);
  const valid = new Set([-1, 0, 1, 2].map((d) => hotp(base32Decode(secretBase32), now + d)));
  for (let s = now + 100; ; s++) {
    const c = hotp(base32Decode(secretBase32), s);
    if (!valid.has(c)) return c;
  }
}

/* ------------------------------------------------------------------ CCV1 reader (own copy of the format) */

interface OpenedVault {
  keyIdHex: string;
  meta: Record<string, unknown>;
  plain: Buffer;
}

function openVault(file: Buffer, privateKey: KeyObject): OpenedVault {
  assert.equal(file.subarray(0, 4).toString('latin1'), 'CCV1', 'magic');
  const headerLength = file.readUInt32BE(4);
  const header = file.subarray(0, headerLength);
  let o = 8;
  const keyId = header.subarray(o, o + 16);
  o += 16;
  const wrappedLength = header.readUInt16BE(o);
  o += 2;
  const wrapped = header.subarray(o, o + wrappedLength);
  o += wrappedLength;
  const noncePrefix = header.subarray(o, o + 8);
  o += 8;
  const chunkSize = header.readUInt32BE(o);
  o += 4;
  const metaLength = header.readUInt32BE(o);
  o += 4;
  const meta = JSON.parse(header.subarray(o, o + metaLength).toString('utf8')) as Record<string, unknown>;
  o += metaLength;
  assert.equal(o, headerLength, 'header length covers exactly the header fields');

  const aesKey = privateDecrypt({ key: privateKey, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrapped);
  assert.equal(aesKey.length, 32);

  const parts: Buffer[] = [];
  let pos = headerLength;
  for (let index = 0; ; index++) {
    const remaining = file.length - pos;
    const isLast = remaining <= chunkSize + 16;
    const len = isLast ? remaining : chunkSize + 16;
    assert.ok(len >= 16, 'chunk holds at least its tag');
    const chunk = file.subarray(pos, pos + len);
    const idx = Buffer.alloc(4);
    idx.writeUInt32BE(index);
    const decipher = createDecipheriv('aes-256-gcm', aesKey, Buffer.concat([noncePrefix, idx]));
    decipher.setAAD(Buffer.concat([header, idx, Buffer.from([isLast ? 1 : 0])]));
    decipher.setAuthTag(chunk.subarray(len - 16));
    parts.push(decipher.update(chunk.subarray(0, len - 16)), decipher.final());
    pos += len;
    if (isLast) break;
  }
  return { keyIdHex: keyId.toString('hex'), meta, plain: Buffer.concat(parts) };
}

/* ------------------------------------------------------------------ HTTP */

interface Res {
  status: number;
  headers: Headers;
  body: Buffer;
  json: any;
}

interface CallOptions {
  body?: unknown;
  cookie?: string;
  csrf?: boolean;
  headers?: Record<string, string>;
}

function makeApi(base: string) {
  return async function call(method: string, url: string, opts: CallOptions = {}): Promise<Res> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.csrf !== false && method !== 'GET' && method !== 'HEAD') headers['x-cctv'] = '1';
    if (opts.cookie) headers.cookie = opts.cookie;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(base + url, { method, headers, body, redirect: 'manual' });
    const buf = Buffer.from(await res.arrayBuffer());
    let json: any = null;
    if ((res.headers.get('content-type') ?? '').includes('application/json') && buf.length > 0) json = JSON.parse(buf.toString('utf8'));
    return { status: res.status, headers: res.headers, body: buf, json };
  };
}

function sessionCookie(res: Res): string {
  for (const c of res.headers.getSetCookie()) {
    const first = c.split(';')[0] as string;
    if (first.startsWith(`${COOKIE_NAME}=`) && first.length > COOKIE_NAME.length + 1) return first;
  }
  throw new Error(`no session cookie in response (status ${res.status})`);
}

/* ------------------------------------------------------------------ the test */

const reason = skipReason();

test('hub end to end: fake camera -> MediaMTX -> hub API', { skip: reason ?? false, timeout: 10 * 60_000 }, async (t: TestContext) => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'cctv-e2e-'));
  const logs = path.join(tmp, 'logs');
  const dataDir = path.join(tmp, 'data');
  mkdirSync(logs, { recursive: true });
  const procs: Proc[] = [];
  const mediamtx = pinnedMediamtx() as string;
  const camHost = cameraHostAddress() as string;
  let failed = true;

  try {
    /* ---------------- ports and files */
    const camPort = await freeTcpPort(camHost);
    const hubPort = await freeTcpPort('127.0.0.1');
    const apiPort = await freeTcpPort('127.0.0.1');
    const rtspPort = await freeTcpPort('127.0.0.1');
    const webrtcPort = await freeTcpPort('127.0.0.1');
    const udpPort = await freeUdpPort('127.0.0.1');
    const base = `http://127.0.0.1:${hubPort}`;
    const api = makeApi(base);

    /* ---------------- fake camera: MediaMTX + ffmpeg test pattern */
    const camDir = path.join(tmp, 'camera');
    mkdirSync(camDir);
    const camYml = path.join(camDir, 'mediamtx.yml');
    writeFileSync(
      camYml,
      [
        'logLevel: warn',
        'api: false',
        'metrics: false',
        'pprof: false',
        'playback: false',
        'rtmp: false',
        'hls: false',
        'webrtc: false',
        'srt: false',
        'moq: false',
        'rtsp: true',
        'rtspTransports: [tcp]',
        `rtspAddress: ${camHost}:${camPort}`,
        'authMethod: internal',
        'authInternalUsers:',
        `  - user: ${JSON.stringify(CAMERA_LOGIN.username)}`,
        `    pass: ${JSON.stringify(CAMERA_LOGIN.password)}`,
        '    ips: []',
        '    permissions:',
        '      - action: publish',
        '      - action: read',
        'paths:',
        '  stream1: {}',
        '  stream2: {}',
        '',
      ].join('\n'),
    );
    const camMtx = startProcess('camera-mediamtx', mediamtx, [camYml], logs, { cwd: camDir });
    procs.push(camMtx);
    await waitFor('fake camera RTSP port', 20_000, async () => {
      if (camMtx.child.exitCode !== null) throw new Error(`fake camera MediaMTX exited: ${tail(camMtx.log, 5)}`);
      return tcpOpen(camHost, camPort);
    });

    const camUrl = (p: string): string =>
      `rtsp://${encodeURIComponent(CAMERA_LOGIN.username)}:${encodeURIComponent(CAMERA_LOGIN.password)}@${camHost}:${camPort}/${p}`;
    const x264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '15', '-keyint_min', '15'];
    procs.push(
      startProcess(
        'camera-ffmpeg',
        'ffmpeg',
        [
          '-hide_banner', '-loglevel', 'warning', '-nostdin', '-re',
          '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=15',
          '-filter_complex', '[0:v]split=2[main][s];[s]scale=640:360[sub]',
          '-map', '[main]', ...x264, '-b:v', '1500k', '-f', 'rtsp', '-rtsp_transport', 'tcp', camUrl('stream1'),
          '-map', '[sub]', ...x264, '-b:v', '300k', '-f', 'rtsp', '-rtsp_transport', 'tcp', camUrl('stream2'),
        ],
        logs,
      ),
    );
    const camProbe = await waitFor('fake camera stream', 30_000, async () => {
      const r = spawnSync(
        'ffprobe',
        ['-v', 'error', '-rtsp_transport', 'tcp', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', camUrl('stream1')],
        { encoding: 'utf8', timeout: 8000 },
      );
      return r.status === 0 ? (JSON.parse(r.stdout) as { streams: { codec_name: string; width: number; height: number }[] }) : null;
    });
    assert.equal(camProbe.streams[0]?.codec_name, 'h264');
    assert.equal(camProbe.streams[0]?.width, 1280);

    /* ---------------- MediaMTX for the hub, from the deploy template */
    const hubMtxDir = path.join(tmp, 'hub-mediamtx');
    mkdirSync(hubMtxDir);
    let yml = readFileSync(TEMPLATE, 'utf8')
      .replaceAll('{{DATA_DIR}}', dataDir.replaceAll('\\', '/'))
      .replaceAll('{{PUBLIC_IP}}', '127.0.0.1');
    const swaps: [RegExp, string][] = [
      [/^authHTTPAddress: http:\/\/127\.0\.0\.1:8080\//m, `authHTTPAddress: http://127.0.0.1:${hubPort}/`],
      [/^apiAddress: 127\.0\.0\.1:9997$/m, `apiAddress: 127.0.0.1:${apiPort}`],
      [/^rtspAddress: 127\.0\.0\.1:8554$/m, `rtspAddress: 127.0.0.1:${rtspPort}`],
      [/^webrtcAddress: 127\.0\.0\.1:8889$/m, `webrtcAddress: 127.0.0.1:${webrtcPort}`],
      [/^webrtcLocalUDPAddress: :8189$/m, `webrtcLocalUDPAddress: 127.0.0.1:${udpPort}`],
      [/^(\s+)recordSegmentDuration: 5m$/m, `$1recordSegmentDuration: ${SEGMENT_SECONDS}s`],
    ];
    for (const [re, to] of swaps) {
      assert.match(yml, re, `template line ${re} (template changed?)`);
      yml = yml.replace(re, to);
    }
    const hubYml = path.join(hubMtxDir, 'mediamtx.yml');
    writeFileSync(hubYml, yml);
    const hubMtx = startProcess('hub-mediamtx', mediamtx, [hubYml], logs, { cwd: hubMtxDir, env: { ...process.env, TZ: 'UTC' } });
    procs.push(hubMtx);
    await waitFor('hub MediaMTX API port', 20_000, async () => {
      if (hubMtx.child.exitCode !== null) throw new Error(`hub MediaMTX exited: ${tail(hubMtx.log, 5)}`);
      return tcpOpen('127.0.0.1', apiPort);
    });

    /* ---------------- the hub (development mode, temp config) */
    const configFile = path.join(tmp, 'hub.json');
    writeFileSync(
      configFile,
      JSON.stringify(
        {
          dataDir,
          listenHost: '127.0.0.1',
          listenPort: hubPort,
          publicOrigin: base,
          publicIp: '127.0.0.1',
          mediamtxApi: `http://127.0.0.1:${apiPort}`,
          mediamtxRtsp: `rtsp://127.0.0.1:${rtspPort}`,
          mediamtxWebrtc: `http://127.0.0.1:${webrtcPort}`,
          ffmpegPath: 'ffmpeg',
          ffprobePath: 'ffprobe',
          wireguard: { enabled: false },
          devInsecureCookies: true,
        },
        null,
        2,
      ),
    );
    const hubEnv: NodeJS.ProcessEnv = { ...process.env, CCTV_DEV: '1', COMFFEE_CCTV_CONFIG: configFile, CCTV_LOG_LEVEL: 'warn', TZ: 'UTC' };
    const startHub = async (): Promise<Proc> => {
      const p = startProcess('hub', process.execPath, [path.join(REPO, 'server', 'src', 'main.ts')], logs, { cwd: REPO, env: hubEnv });
      procs.push(p);
      await waitFor('hub HTTP', 30_000, async () => {
        if (p.child.exitCode !== null) throw new Error(`hub exited: ${tail(p.log, 15)}`);
        return (await api('GET', '/api/setup/status')).status === 200;
      });
      return p;
    };
    let hub = await startHub();

    /* ---------------- first setup: CLI setup code -> owner -> 2-step -> sign in */
    let ownerSecret = '';
    let owner = '';
    await t.test('setup code, owner, 2-step and sign in', async () => {
      const lines: string[] = [];
      const rc = await runCli(['setup-code'], { env: hubEnv, out: (l) => lines.push(l), err: (l) => lines.push(l) });
      assert.equal(rc, 0, lines.join('\n'));
      const setupCode = /Setup code: (\S+)/.exec(lines.join('\n'))?.[1];
      assert.ok(setupCode, 'CLI printed a setup code');

      const status = await api('GET', '/api/setup/status');
      assert.deepEqual(status.json, { needsSetup: true, hasVaultKey: false });

      const wrong = await api('POST', '/api/setup/owner', { body: { setupCode: 'AAAAAAAAAAAAAAAAAAAAAAAAAA', ...OWNER } });
      assert.ok(wrong.status >= 400 && wrong.status < 500, `wrong setup code refused (${wrong.status})`);

      const enroll = await api('POST', '/api/setup/owner', { body: { setupCode, ...OWNER } });
      assert.equal(enroll.status, 200, JSON.stringify(enroll.json));
      ownerSecret = enroll.json.secretBase32;
      assert.match(enroll.json.otpauthUrl, /^otpauth:\/\/totp\//);
      const done = await api('POST', '/api/auth/totp', { body: { challenge: enroll.json.challenge, code: await freshCode(ownerSecret) } });
      assert.equal(done.status, 200, JSON.stringify(done.json));
      assert.equal(done.json.role, 'owner');
      const firstCookie = sessionCookie(done);

      const again = await api('POST', '/api/setup/owner', { body: { setupCode, ...OWNER } });
      assert.ok(again.status >= 400, 'setup code works once');
      assert.equal((await api('GET', '/api/setup/status')).json.needsSetup, false);

      assert.equal((await api('POST', '/api/auth/logout', { cookie: firstCookie })).status, 200);
      assert.equal((await api('GET', '/api/me', { cookie: firstCookie })).status, 401, 'signed out');

      const login = await api('POST', '/api/auth/login', { body: OWNER });
      assert.equal(login.status, 200, JSON.stringify(login.json));
      assert.equal(login.json.next, 'totp');
      const totp = await api('POST', '/api/auth/totp', { body: { challenge: login.json.challenge, code: await freshCode(ownerSecret) } });
      assert.equal(totp.status, 200, JSON.stringify(totp.json));
      owner = sessionCookie(totp);
      const me = await api('GET', '/api/me', { cookie: owner });
      assert.equal(me.json.username, OWNER.username);
      assert.equal(me.json.locationIds, 'all');
    });
    assert.ok(owner, 'owner signed in');

    /* ---------------- vault key */
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 0x10001 });
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const expectedKeyId = createHash('sha256').update(spki).digest().subarray(0, 16).toString('hex');
    await t.test('vault public key', async () => {
      const wrongPw = await api('PUT', '/api/keys/vault', { cookie: owner, body: { spkiB64: spki.toString('base64'), password: 'not the password' } });
      assert.equal(wrongPw.status, 422);
      const put = await api('PUT', '/api/keys/vault', { cookie: owner, body: { spkiB64: spki.toString('base64'), password: OWNER.password } });
      assert.equal(put.status, 200, JSON.stringify(put.json));
      assert.equal(put.json.keyId, expectedKeyId);
      assert.equal(put.json.active, true);
      assert.equal((await api('GET', '/api/setup/status')).json.hasVaultKey, true);
    });

    /* ---------------- locations and camera */
    const createLocation = async (name: string): Promise<number> => {
      const r = await api('POST', '/api/locations', { cookie: owner, body: { name, timezone: 'Etc/UTC', connector: 'direct' } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.connector, 'direct');
      return r.json.id as number;
    };
    const locA = await createLocation('Site A');
    const locB = await createLocation('Site B');

    const cam = await api('POST', '/api/cameras', {
      cookie: owner,
      body: {
        locationId: locA,
        name: 'Test camera',
        lanIp: camHost,
        rtspPort: camPort,
        onvifPort: null,
        vendor: 'custom',
        mainPath: '/stream1',
        subPath: '/stream2',
        username: CAMERA_LOGIN.username,
        password: CAMERA_LOGIN.password,
        quality: '1080p',
        recording: true,
      },
    });
    assert.equal(cam.status, 200, JSON.stringify(cam.json));
    const cameraId = cam.json.id as number;
    assert.equal(cam.json.effectiveRecording, true);

    // A second camera at site B (the sub stream, not recorded), so MediaMTX has another path to refuse.
    const cam2 = await api('POST', '/api/cameras', {
      cookie: owner,
      body: {
        locationId: locB,
        name: 'Site B camera',
        lanIp: camHost,
        rtspPort: camPort,
        vendor: 'custom',
        mainPath: '/stream2',
        subPath: null,
        username: CAMERA_LOGIN.username,
        password: CAMERA_LOGIN.password,
        quality: '360p',
        recording: false,
      },
    });
    assert.equal(cam2.status, 200, JSON.stringify(cam2.json));
    const camera2Id = cam2.json.id as number;
    assert.equal(cam2.json.effectiveRecording, false);
    const rawDir = path.join(dataDir, 'raw', `c${cameraId}`);

    /* ---------------- encrypted segment: list, download, decrypt, ffprobe */
    let segment: any = null;
    await t.test('a finished segment is encrypted, listed, downloaded and decrypts to a valid MP4', async () => {
      segment = await waitFor(
        'first encrypted segment',
        180_000,
        async () => {
          const r = await api('GET', `/api/recordings?cameraId=${cameraId}&order=asc`, { cookie: owner });
          return r.status === 200 && r.json.items.length > 0 ? r.json.items[0] : null;
        },
        2000,
      );
      assert.equal(segment.cameraId, cameraId);
      assert.equal(segment.locationId, locA);
      assert.equal(segment.keyId, expectedKeyId);

      const file = await api('GET', `/api/recordings/${segment.id}/file`, { cookie: owner });
      assert.equal(file.status, 200);
      assert.equal(file.headers.get('content-type'), 'application/octet-stream');
      assert.equal(Number(file.headers.get('content-length')), file.body.length);
      assert.equal(file.body.length, segment.sizeBytes);

      const opened = openVault(file.body, privateKey);
      assert.equal(opened.keyIdHex, expectedKeyId);
      assert.deepEqual(Object.keys(opened.meta).sort(), ['cameraId', 'durationMs', 'locationId', 'mime', 'start', 'v']);
      assert.equal(opened.meta.cameraId, cameraId);
      assert.equal(opened.meta.locationId, locA);
      assert.equal(opened.meta.start, segment.start);
      assert.equal(opened.meta.durationMs, segment.durationMs);
      assert.equal(opened.meta.mime, 'video/mp4');

      const mp4 = path.join(tmp, 'segment.mp4');
      writeFileSync(mp4, opened.plain);
      const probe = spawnSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=format_name,duration', '-of', 'json', mp4],
        { encoding: 'utf8' },
      );
      assert.equal(probe.status, 0, probe.stderr);
      const info = JSON.parse(probe.stdout) as { streams: { codec_name: string; width: number; height: number }[]; format: { format_name: string; duration?: string } };
      assert.match(info.format.format_name, /mp4/);
      assert.equal(info.streams[0]?.codec_name, 'h264');
      assert.equal(info.streams[0]?.width, 1280);
      assert.equal(info.streams[0]?.height, 720);
      const seconds = Number(info.format.duration ?? '0');
      assert.ok(seconds >= SEGMENT_SECONDS - 2 && seconds <= SEGMENT_SECONDS + 15, `segment length ${seconds}s`);

      // The listed time must match the real time of recording.
      const offsetMinutes = new Date().getTimezoneOffset();
      const skew = Date.parse(segment.start) - Date.now();
      if (process.platform === 'win32' && offsetMinutes !== 0) {
        t.diagnostic(
          `Windows host at UTC${offsetMinutes > 0 ? '-' : '+'}${Math.abs(offsetMinutes) / 60}: MediaMTX ignores TZ=UTC here, so segment ` +
            `names are local time. Listed start is ${Math.round(skew / 60_000)} min from now, durationMs=${segment.durationMs}.`,
        );
      } else {
        assert.ok(Math.abs(skew) < 5 * 60_000, `segment start ${segment.start} is close to now`);
        assert.ok(segment.durationMs >= (SEGMENT_SECONDS - 2) * 1000, `durationMs ${segment.durationMs}`);
      }

      const days = await api('GET', `/api/recordings/days?locationId=${locA}&month=${segment.start.slice(0, 7)}`, { cookie: owner });
      assert.equal(days.status, 200, JSON.stringify(days.json));
      assert.ok(days.json.days.length >= 1);
    });
    assert.ok(segment, 'segment available');

    /* ---------------- viewer of another location */
    let viewer = '';
    let viewerId = 0;
    let viewerSecret = '';
    await t.test('a viewer of another location cannot see this location (404)', async () => {
      const created = await api('POST', '/api/users', { cookie: owner, body: { ...VIEWER, locationIds: [locB] } });
      assert.equal(created.status, 200, JSON.stringify(created.json));
      viewerId = created.json.id;
      const login = await api('POST', '/api/auth/login', { body: VIEWER });
      assert.equal(login.status, 200);
      assert.equal(login.json.next, 'enroll-totp');
      viewerSecret = login.json.secretBase32;
      const done = await api('POST', '/api/auth/totp', { body: { challenge: login.json.challenge, code: await freshCode(viewerSecret) } });
      assert.equal(done.status, 200, JSON.stringify(done.json));
      assert.deepEqual(done.json.locationIds, [locB]);
      viewer = sessionCookie(done);

      assert.equal((await api('GET', `/api/recordings/${segment.id}/file`, { cookie: viewer })).status, 404);
      assert.equal((await api('GET', `/api/recordings?locationId=${locA}`, { cookie: viewer })).status, 404);
      assert.equal((await api('GET', `/api/recordings?cameraId=${cameraId}`, { cookie: viewer })).status, 404);
      const all = await api('GET', '/api/recordings', { cookie: viewer });
      assert.equal(all.status, 200);
      assert.equal(all.json.items.filter((i: any) => i.locationId === locA).length, 0);
      assert.equal((await api('GET', `/api/locations/${locA}`, { cookie: viewer })).status, 404);
      assert.equal((await api('GET', `/api/cameras?locationId=${locA}`, { cookie: viewer })).status, 404);
      assert.equal((await api('POST', `/api/live/${cameraId}/token`, { cookie: viewer })).status, 404);
      const locs = await api('GET', '/api/locations', { cookie: viewer });
      assert.deepEqual(locs.json.locations.map((l: any) => l.id), [locB]);
      const cams = await api('GET', '/api/cameras', { cookie: viewer });
      assert.deepEqual(cams.json.cameras.map((c: any) => c.id), [camera2Id]);
      assert.equal(cams.json.cameras[0].username, null, 'camera login hidden from viewers');
      // Viewer may not switch recording.
      assert.equal((await api('PATCH', `/api/cameras/${cameraId}`, { cookie: viewer, body: { recording: false } })).status, 403);
    });

    /* ---------------- live token and the MediaMTX auth hook */
    await t.test('live token lets MediaMTX allow a read of that path only', async () => {
      const tok = await api('POST', `/api/live/${cameraId}/token`, { cookie: owner });
      assert.equal(tok.status, 200, JSON.stringify(tok.json));
      assert.equal(tok.json.whepUrl, `/live/c${cameraId}/whep`);
      const token = tok.json.token as string;
      assert.ok(Date.parse(tok.json.expiresAt) - Date.now() <= 61_000);

      const hook = async (fields: Record<string, unknown>): Promise<number> => {
        const body = { user: '', password: '', token, ip: '127.0.0.1', action: 'read', path: `c${cameraId}`, protocol: 'webrtc', id: null, query: '', ...fields };
        const r = await fetch(`${base}/internal/mediamtx-auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return r.status;
      };
      assert.equal(await hook({}), 200, 'read of the token path over webrtc');
      assert.equal(await hook({ path: `c${cameraId + 1000}` }), 401, 'another path');
      assert.equal(await hook({ path: `c${cameraId}_src` }), 401, 'the source path');
      assert.equal(await hook({ action: 'publish' }), 401, 'publish');
      assert.equal(await hook({ protocol: 'rtsp' }), 401, 'another protocol');
      assert.equal(await hook({ token: '' }), 401, 'no token');
      assert.equal(await hook({ token: token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA') }), 401, 'altered token');
      assert.equal(await hook({ user: 'someone', password: 'guess' }), 200, 'wrong user and password do not cancel a valid token');
      const forwarded = await fetch(`${base}/internal/mediamtx-auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5' },
        body: JSON.stringify({ token, action: 'read', path: `c${cameraId}`, protocol: 'webrtc' }),
      });
      assert.notEqual(forwarded.status, 200, 'requests through the proxy are refused');

      // Through MediaMTX itself: the WHEP endpoint asks the hub. A bad offer after a passed check is a 400, a refused check is 401.
      const whep = async (p: string, bearer: string | null): Promise<number> => {
        const headers: Record<string, string> = { 'content-type': 'application/sdp' };
        if (bearer) headers.authorization = `Bearer ${bearer}`;
        const r = await fetch(`http://127.0.0.1:${webrtcPort}/${p}/whep`, { method: 'POST', headers, body: 'v=0\r\n' });
        await r.arrayBuffer();
        return r.status;
      };
      const withToken = await whep(`c${cameraId}`, token);
      assert.notEqual(withToken, 401, `MediaMTX accepted the token for c${cameraId} (status ${withToken})`);
      assert.equal(await whep(`c${cameraId}`, null), 401, 'no token');
      assert.equal(await whep(`c${camera2Id}`, token), 401, 'token for another camera');

      // The site B viewer's token opens their camera only.
      const vb = await api('POST', `/api/live/${camera2Id}/token`, { cookie: viewer });
      assert.equal(vb.status, 200, JSON.stringify(vb.json));
      assert.equal(await hook({ token: vb.json.token, path: `c${camera2Id}` }), 200);
      assert.equal(await hook({ token: vb.json.token, path: `c${cameraId}` }), 401);
      assert.notEqual(await whep(`c${camera2Id}`, vb.json.token), 401);
      assert.equal(await whep(`c${cameraId}`, vb.json.token), 401);

      // Viewer access removed -> the token stops working at once.
      assert.equal((await api('PATCH', `/api/users/${viewerId}`, { cookie: owner, body: { locationIds: [locA] } })).status, 200);
      const vt = await api('POST', `/api/live/${cameraId}/token`, { cookie: viewer });
      assert.equal(vt.status, 200);
      assert.equal(await hook({ token: vt.json.token }), 200);
      assert.equal((await api('PATCH', `/api/users/${viewerId}`, { cookie: owner, body: { locationIds: [locB] } })).status, 200);
      assert.equal(await hook({ token: vt.json.token }), 401, 'viewer lost access to the location');
    });

    /* ---------------- CSRF */
    await t.test('requests without the CSRF header or from another origin get 403', async () => {
      const noHeader = await api('POST', '/api/auth/logout', { cookie: owner, csrf: false });
      assert.equal(noHeader.status, 403);
      assert.equal(noHeader.json.error.code, 'csrf');
      const patch = await api('PATCH', `/api/cameras/${cameraId}`, { cookie: owner, csrf: false, body: { name: 'changed' } });
      assert.equal(patch.status, 403);
      const otherOrigin = await api('POST', '/api/auth/logout', { cookie: owner, headers: { origin: 'https://evil.example' } });
      assert.equal(otherOrigin.status, 403);
      const form = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'x-cctv': '1', 'content-type': 'application/x-www-form-urlencoded' },
        body: 'username=owner&password=x',
      });
      assert.equal(form.status, 403, 'non-JSON body');
      assert.equal((await api('GET', '/api/me', { cookie: owner })).status, 200, 'owner still signed in');
      const cams = await api('GET', `/api/cameras?locationId=${locA}`, { cookie: owner });
      assert.equal(cams.json.cameras[0].name, 'Test camera');
    });

    /* ---------------- saved camera login, cameras without their own login, add-detected, rename, location delete */
    const camOctets = camHost.split('.');
    const camSubnet = `${camOctets.slice(0, 3).join('.')}.0/24`;
    const otherIp = `${camOctets.slice(0, 3).join('.')}.${Number(camOctets[3]) >= 254 ? 253 : Number(camOctets[3]) + 1}`;
    const passwordForms = [CAMERA_LOGIN.password, encodeURIComponent(CAMERA_LOGIN.password)];
    /** The camera password is in no response, in any spelling, and no response field is named like a password. */
    const assertNoCameraPassword = (res: Res, label: string): void => {
      const text = res.body.toString('utf8');
      for (const form of passwordForms) assert.ok(!text.includes(form), `${label}: camera password not in the response`);
      const walk = (v: unknown): void => {
        if (!v || typeof v !== 'object') return;
        for (const [k, x] of Object.entries(v)) {
          assert.ok(!/password/i.test(k), `${label}: no "${k}" field`);
          walk(x);
        }
      };
      walk(res.json);
    };
    function dbRow<T>(sql: string, ...params: (number | string)[]): T | undefined {
      const db = new DatabaseSync(path.join(dataDir, 'db.sqlite'), { readOnly: true });
      try {
        return db.prepare(sql).get(...params) as unknown as T | undefined;
      } finally {
        db.close();
      }
    }
    const mediamtxPathStatus = async (name: string): Promise<number> => {
      const internal = JSON.parse(readFileSync(path.join(dataDir, 'secrets', 'mediamtx-internal.json'), 'utf8')) as { user: string; password: string };
      const r = await fetch(`http://127.0.0.1:${apiPort}/v3/config/paths/get/${name}`, {
        headers: { authorization: 'Basic ' + Buffer.from(`${internal.user}:${internal.password}`).toString('base64') },
      });
      await r.arrayBuffer();
      return r.status;
    };

    let locC = 0;
    await t.test('a location camera login is saved and replaced, and its password is never returned', async () => {
      const created = await api('POST', '/api/locations', {
        cookie: owner,
        body: { name: 'Site C', timezone: 'Etc/UTC', connector: 'direct', cameraSubnet: camSubnet },
      });
      assert.equal(created.status, 200, JSON.stringify(created.json));
      locC = created.json.id;
      assert.ok(locC > locB, 'new location id');
      assert.equal(created.json.cameraSubnet, camSubnet);
      assert.equal(created.json.hasCameraLogin, false);
      assert.equal(created.json.cameraUsername, null);

      // Half a login, an empty name, or a save and a removal at once are refused and change nothing.
      const refused: Record<string, unknown>[] = [
        { cameraUsername: CAMERA_LOGIN.username },
        { cameraPassword: CAMERA_LOGIN.password },
        { cameraUsername: '', cameraPassword: CAMERA_LOGIN.password },
        { cameraUsername: CAMERA_LOGIN.username, cameraPassword: CAMERA_LOGIN.password, clearCameraLogin: true },
        { clearCameraLogin: 'yes' },
      ];
      for (const body of refused) {
        const r = await api('PATCH', `/api/locations/${locC}`, { cookie: owner, body });
        assert.equal(r.status, 422, `refused ${JSON.stringify(Object.keys(body))}: ${JSON.stringify(r.json)}`);
        assert.equal(r.json.error.code, 'invalid_input');
      }
      assert.equal((await api('GET', `/api/locations/${locC}`, { cookie: owner })).json.hasCameraLogin, false, 'nothing saved by a refused change');
      const byViewer = await api('PATCH', `/api/locations/${locB}`, { cookie: viewer, body: { cameraUsername: 'x', cameraPassword: 'y' } });
      assert.equal(byViewer.status, 403, 'viewers cannot save a camera login');

      // A wrong login first: a camera test without its own login uses it and fails.
      const wrong = await api('PATCH', `/api/locations/${locC}`, {
        cookie: owner,
        body: { cameraUsername: CAMERA_LOGIN.username, cameraPassword: 'not the camera password' },
      });
      assert.equal(wrong.status, 200, JSON.stringify(wrong.json));
      assert.equal(wrong.json.hasCameraLogin, true);
      const testBody = { locationId: locC, lanIp: camHost, rtspPort: camPort, vendor: 'custom', mainPath: '/stream2', subPath: null };
      const badTest = await api('POST', '/api/cameras/test', { cookie: owner, body: testBody });
      assert.equal(badTest.status, 200, JSON.stringify(badTest.json));
      assert.equal(badTest.json.main.ok, false, 'the saved wrong login was used');

      // The right login replaces it, and the same test now opens the stream.
      const saved = await api('PATCH', `/api/locations/${locC}`, {
        cookie: owner,
        body: { cameraUsername: CAMERA_LOGIN.username, cameraPassword: CAMERA_LOGIN.password },
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.json));
      assert.equal(saved.json.hasCameraLogin, true);
      assert.equal(saved.json.cameraUsername, CAMERA_LOGIN.username);
      assertNoCameraPassword(saved, 'PATCH location');
      const goodTest = await api('POST', '/api/cameras/test', { cookie: owner, body: testBody });
      assert.equal(goodTest.status, 200, JSON.stringify(goodTest.json));
      assert.equal(goodTest.json.main.ok, true, `saved login opens the stream: ${goodTest.json.main.error}`);
      assert.equal(goodTest.json.main.width, 640);
      assertNoCameraPassword(goodTest, 'camera test');

      // Other location changes keep the saved login.
      const renamed = await api('PATCH', `/api/locations/${locC}`, { cookie: owner, body: { name: 'Site C main hall' } });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
      assert.equal(renamed.json.hasCameraLogin, true);
      assert.equal(renamed.json.cameraUsername, CAMERA_LOGIN.username);

      const reads: [string, Res][] = [
        ['GET location', await api('GET', `/api/locations/${locC}`, { cookie: owner })],
        ['GET locations', await api('GET', '/api/locations', { cookie: owner })],
        ['GET location setup', await api('GET', `/api/locations/${locC}/setup`, { cookie: owner })],
        ['GET audit', await api('GET', '/api/audit?limit=200', { cookie: owner })],
      ];
      for (const [label, res] of reads) {
        assert.equal(res.status, 200, `${label}: ${JSON.stringify(res.json)}`);
        assertNoCameraPassword(res, label);
      }
      const listed = (reads[1]![1].json.locations as any[]).find((l) => l.id === locC);
      assert.equal(listed.hasCameraLogin, true);
      assert.equal(listed.cameraUsername, CAMERA_LOGIN.username);
      assert.equal((reads[1]![1].json.locations as any[]).find((l) => l.id === locA).hasCameraLogin, false, 'other locations unchanged');

      const row = dbRow<{ camera_username: string | null; camera_password_enc: string | null }>(
        'SELECT camera_username, camera_password_enc FROM locations WHERE id = ?',
        locC,
      );
      assert.equal(row?.camera_username, CAMERA_LOGIN.username);
      assert.ok(row?.camera_password_enc && !passwordForms.some((f) => row.camera_password_enc!.includes(f)), 'password stored sealed');

      // A viewer of the location sees that a login exists, never its name.
      assert.equal((await api('PATCH', `/api/users/${viewerId}`, { cookie: owner, body: { locationIds: [locB, locC] } })).status, 200);
      const asViewer = await api('GET', `/api/locations/${locC}`, { cookie: viewer });
      assert.equal(asViewer.status, 200, JSON.stringify(asViewer.json));
      assert.equal(asViewer.json.hasCameraLogin, true);
      assert.equal(asViewer.json.cameraUsername, null, 'login name hidden from viewers');
      assertNoCameraPassword(asViewer, 'GET location as viewer');
      assert.equal((await api('PATCH', `/api/users/${viewerId}`, { cookie: owner, body: { locationIds: [locB] } })).status, 200);
    });
    assert.ok(locC, 'Site C created');

    let savedLoginCamId = 0;
    await t.test('a camera added without its own login uses the saved login and keeps its own copy', async () => {
      const body = {
        locationId: locC,
        name: 'Saved login camera',
        lanIp: camHost,
        rtspPort: camPort,
        vendor: 'custom',
        mainPath: '/stream2',
        subPath: null,
        quality: '360p',
        recording: false,
      };
      const half = await api('POST', '/api/cameras', { cookie: owner, body: { ...body, username: CAMERA_LOGIN.username } });
      assert.equal(half.status, 422, `half a login refused: ${JSON.stringify(half.json)}`);
      const noSaved = await api('POST', '/api/cameras', { cookie: owner, body: { ...body, locationId: locB } });
      assert.equal(noSaved.status, 422, `location without a saved login: ${JSON.stringify(noSaved.json)}`);
      assert.equal(noSaved.json.error.code, 'invalid_input');

      const made = await api('POST', '/api/cameras', { cookie: owner, body });
      assert.equal(made.status, 200, JSON.stringify(made.json));
      savedLoginCamId = made.json.id;
      assert.ok(savedLoginCamId > camera2Id, 'new camera id');
      assert.equal(made.json.locationId, locC);
      assert.equal(made.json.username, CAMERA_LOGIN.username, 'the saved login name was copied');
      assert.equal(made.json.recording, false);
      assertNoCameraPassword(made, 'POST camera');
      const camRow = dbRow<{ username: string; password_enc: string }>('SELECT username, password_enc FROM cameras WHERE id = ?', savedLoginCamId);
      assert.equal(camRow?.username, CAMERA_LOGIN.username);
      assert.ok(camRow && camRow.password_enc.length > 0 && !passwordForms.some((f) => camRow.password_enc.includes(f)), 'camera password sealed');

      // Removing the saved login leaves the camera working with its own copy.
      const cleared = await api('PATCH', `/api/locations/${locC}`, { cookie: owner, body: { clearCameraLogin: true } });
      assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
      assert.equal(cleared.json.hasCameraLogin, false);
      assert.equal(cleared.json.cameraUsername, null);
      const locRow = dbRow<{ camera_username: string | null; camera_password_enc: string | null }>(
        'SELECT camera_username, camera_password_enc FROM locations WHERE id = ?',
        locC,
      );
      assert.deepEqual({ ...locRow }, { camera_username: null, camera_password_enc: null }, 'saved login removed from the database');
      const kept = await api('POST', `/api/cameras/${savedLoginCamId}/test`, { cookie: owner, body: {} });
      assert.equal(kept.status, 200, JSON.stringify(kept.json));
      assert.equal(kept.json.main.ok, true, `camera keeps its own login: ${kept.json.main.error}`);
      const list = await api('GET', `/api/cameras?locationId=${locC}`, { cookie: owner });
      assert.equal((list.json.cameras as any[]).find((c) => c.id === savedLoginCamId)?.username, CAMERA_LOGIN.username);
      assertNoCameraPassword(list, 'GET cameras');

      // With no saved login, adding or testing without a login is refused again.
      const again = await api('POST', '/api/cameras', { cookie: owner, body });
      assert.equal(again.status, 422, JSON.stringify(again.json));
      const testAgain = await api('POST', '/api/cameras/test', { cookie: owner, body });
      assert.equal(testAgain.status, 422, JSON.stringify(testAgain.json));
    });
    assert.ok(savedLoginCamId, 'camera without its own login added');

    await t.test('renaming a camera changes only its name', async () => {
      const before = (await api('GET', `/api/cameras?locationId=${locC}`, { cookie: owner })).json.cameras.find((c: any) => c.id === savedLoginCamId);
      const sealedBefore = dbRow<{ password_enc: string }>('SELECT password_enc FROM cameras WHERE id = ?', savedLoginCamId)?.password_enc;
      const r = await api('PATCH', `/api/cameras/${savedLoginCamId}`, { cookie: owner, body: { name: '  Front door  ' } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.name, 'Front door', 'name trimmed');
      for (const k of ['locationId', 'lanIp', 'rtspPort', 'onvifPort', 'vendor', 'mainPath', 'subPath', 'quality', 'recording', 'username', 'createdAt']) {
        assert.deepEqual(r.json[k], before[k], `${k} unchanged by a rename`);
      }
      assert.equal(dbRow<{ password_enc: string }>('SELECT password_enc FROM cameras WHERE id = ?', savedLoginCamId)?.password_enc, sealedBefore, 'login untouched');
      const listed = await api('GET', `/api/cameras?locationId=${locC}`, { cookie: owner });
      assert.equal((listed.json.cameras as any[]).find((c) => c.id === savedLoginCamId)?.name, 'Front door');

      for (const name of ['', '   ', 'x'.repeat(81), 'Bad\nname']) {
        const bad = await api('PATCH', `/api/cameras/${savedLoginCamId}`, { cookie: owner, body: { name } });
        assert.equal(bad.status, 422, `name ${JSON.stringify(name)} refused: ${JSON.stringify(bad.json)}`);
      }
      assert.equal((await api('PATCH', `/api/cameras/${savedLoginCamId}`, { cookie: viewer, body: { name: 'Viewer name' } })).status, 403);
      const after = await api('GET', `/api/cameras?locationId=${locC}`, { cookie: owner });
      assert.equal((after.json.cameras as any[]).find((c) => c.id === savedLoginCamId)?.name, 'Front door', 'refused renames changed nothing');

      const audit = await api('GET', '/api/audit?limit=50', { cookie: owner });
      const entry = (audit.json.items as any[]).find((i) => i.target === `camera:${savedLoginCamId}` && i.action === 'camera.update');
      assert.ok(entry, 'rename audited');
      assert.match(String(entry.detail), /name/);
    });

    let addedId = 0;
    await t.test(
      'adding detected cameras uses the saved login, tests each stream and names them Camera 1, 2, ...',
      { skip: isPrivate(camHost) ? false : 'the fake camera address is not a private network address' },
      async () => {
        const url = `/api/locations/${locC}/cameras/add-detected`;
        const device = { ip: camHost, rtspPort: camPort, onvifPort: null, vendor: 'tapo' };

        const noLogin = await api('POST', url, { cookie: owner, body: { devices: [device], quality: '360p' } });
        assert.equal(noLogin.status, 422, `no saved login: ${JSON.stringify(noLogin.json)}`);
        assert.equal(noLogin.json.error.code, 'invalid_input');
        const resaved = await api('PATCH', `/api/locations/${locC}`, {
          cookie: owner,
          body: { cameraUsername: CAMERA_LOGIN.username, cameraPassword: CAMERA_LOGIN.password },
        });
        assert.equal(resaved.status, 200, JSON.stringify(resaved.json));

        const badLists: unknown[] = [
          {},
          { devices: [] },
          { devices: [{ ...device, ip: '203.0.113.9' }] },
          { devices: [{ ...device, rtspPort: 70000 }] },
          { devices: [{ ...device, vendor: 'other' }] },
          { devices: [device], quality: '4k' },
        ];
        for (const body of badLists) {
          const r = await api('POST', url, { cookie: owner, body });
          assert.equal(r.status, 422, `refused ${JSON.stringify(body)}: ${JSON.stringify(r.json)}`);
        }
        assert.equal((await api('POST', url, { cookie: viewer, body: { devices: [device] } })).status, 403, 'owner only');
        assert.equal((await api('POST', `/api/locations/999999/cameras/add-detected`, { cookie: owner, body: { devices: [device] } })).status, 404);

        // The address is taken by the renamed camera: reported, nothing added.
        const taken = await api('POST', url, { cookie: owner, body: { devices: [device] } });
        assert.equal(taken.status, 200, JSON.stringify(taken.json));
        assert.deepEqual(taken.json.added, []);
        assert.deepEqual((taken.json.failed as any[]).map((f) => f.ip), [camHost]);

        // Free the address, then add: the fake camera passes its stream test, a device with no known stream address is
        // reported without a test, and a repeated device is added once.
        assert.equal((await api('DELETE', `/api/cameras/${savedLoginCamId}`, { cookie: owner })).status, 200);
        const res = await api('POST', url, {
          cookie: owner,
          body: { devices: [device, { ip: otherIp, rtspPort: 554, onvifPort: null, vendor: null }, device], quality: '360p' },
        });
        assert.equal(res.status, 200, JSON.stringify(res.json));
        assertNoCameraPassword(res, 'add-detected');
        assert.equal(res.json.added.length, 1, JSON.stringify(res.json));
        const added = res.json.added[0];
        addedId = added.id;
        assert.ok(addedId > savedLoginCamId, 'a new id, never the deleted camera id');
        assert.equal(added.name, 'Camera 1');
        assert.equal(added.locationId, locC);
        assert.equal(added.lanIp, camHost);
        assert.equal(added.rtspPort, camPort);
        assert.equal(added.onvifPort, null);
        assert.equal(added.vendor, 'tapo');
        assert.equal(added.mainPath, '/stream1');
        assert.equal(added.subPath, '/stream2');
        assert.equal(added.quality, '360p');
        assert.equal(added.recording, true);
        assert.equal(added.username, CAMERA_LOGIN.username);
        assert.deepEqual((res.json.failed as any[]).map((f) => f.ip), [otherIp]);
        assert.ok(typeof res.json.failed[0].error === 'string' && res.json.failed[0].error.length > 0, 'failure has a reason');
        const sealed = dbRow<{ password_enc: string }>('SELECT password_enc FROM cameras WHERE id = ?', addedId)?.password_enc ?? '';
        assert.ok(sealed.length > 0 && !passwordForms.some((f) => sealed.includes(f)), 'added camera password sealed');

        const repeat = await api('POST', url, { cookie: owner, body: { devices: [device] } });
        assert.equal(repeat.status, 200, JSON.stringify(repeat.json));
        assert.deepEqual(repeat.json.added, [], 'already added');
        assert.deepEqual((repeat.json.failed as any[]).map((f) => f.ip), [camHost]);

        await waitFor('MediaMTX path for the added camera', 15_000, async () => (await mediamtxPathStatus(`c${addedId}`)) === 200);
      },
    );

    await t.test('a deleted location and its cameras are gone, and their ids are never given out again', async () => {
      const camsBefore = (await api('GET', '/api/cameras', { cookie: owner })).json.cameras as any[];
      const siteCams = camsBefore.filter((c) => c.locationId === locC).map((c) => c.id as number);
      const maxCameraId = Math.max(savedLoginCamId, addedId, ...camsBefore.map((c) => c.id as number));
      const locIds = ((await api('GET', '/api/locations', { cookie: owner })).json.locations as any[]).map((l) => l.id as number);
      assert.equal(Math.max(...locIds), locC, 'Site C is the newest location');

      const del = (body: unknown, cookie = owner): Promise<Res> => api('DELETE', `/api/locations/${locC}`, { cookie, body });
      const noPassword = await del({});
      assert.equal(noPassword.status, 422, JSON.stringify(noPassword.json));
      assert.equal(noPassword.json.error.code, 'invalid_input');
      const wrongPassword = await del({ password: 'not the owner password' });
      assert.equal(wrongPassword.status, 422, JSON.stringify(wrongPassword.json));
      assert.equal(wrongPassword.json.error.code, 'wrong_password');
      assert.equal((await api('DELETE', `/api/locations/${locB}`, { cookie: viewer, body: { password: VIEWER.password } })).status, 403);
      assert.equal((await api('GET', `/api/locations/${locC}`, { cookie: owner })).status, 200, 'refused deletes kept the location');

      const done = await del({ password: OWNER.password });
      assert.equal(done.status, 200, JSON.stringify(done.json));
      assert.deepEqual(done.json, { ok: true });
      assert.equal((await api('GET', `/api/locations/${locC}`, { cookie: owner })).status, 404);
      assert.equal((await api('GET', `/api/cameras?locationId=${locC}`, { cookie: owner })).status, 404);
      const camsAfter = (await api('GET', '/api/cameras', { cookie: owner })).json.cameras as any[];
      assert.equal(camsAfter.filter((c) => c.locationId === locC || siteCams.includes(c.id)).length, 0, 'cameras of the location removed');
      for (const id of [cameraId, camera2Id]) assert.ok(camsAfter.some((c) => c.id === id), `camera ${id} of another location kept`);
      for (const id of siteCams) {
        assert.equal((await api('PATCH', `/api/cameras/${id}`, { cookie: owner, body: { name: 'gone' } })).status, 404);
        assert.equal((await api('POST', `/api/live/${id}/token`, { cookie: owner })).status, 404);
        await waitFor(`MediaMTX path c${id} removed`, 15_000, async () => (await mediamtxPathStatus(`c${id}`)) === 404);
      }

      // A new location and camera get new ids, never the deleted ones.
      const next = await api('POST', '/api/locations', { cookie: owner, body: { name: 'Site D', timezone: 'Etc/UTC', connector: 'direct' } });
      assert.equal(next.status, 200, JSON.stringify(next.json));
      const locD = next.json.id as number;
      assert.ok(locD > locC, `new location id ${locD} is above the deleted ${locC}`);
      assert.equal(next.json.hasCameraLogin, false, 'a new location starts without a saved login');
      const cam = await api('POST', '/api/cameras', {
        cookie: owner,
        body: {
          locationId: locD,
          name: 'Site D camera',
          lanIp: camHost,
          rtspPort: camPort,
          vendor: 'custom',
          mainPath: '/stream2',
          subPath: null,
          username: CAMERA_LOGIN.username,
          password: CAMERA_LOGIN.password,
          quality: '360p',
          recording: false,
        },
      });
      assert.equal(cam.status, 200, JSON.stringify(cam.json));
      assert.ok(cam.json.id > maxCameraId, `new camera id ${cam.json.id} is above every earlier one (${maxCameraId})`);
      assert.equal(cam.json.lastSegmentAt, null, 'no footage of an earlier camera shows on the new one');
      assertNoCameraPassword(cam, 'POST camera with its own login');

      const cleanup = await api('DELETE', `/api/locations/${locD}`, { cookie: owner, body: { password: OWNER.password } });
      assert.equal(cleanup.status, 200, JSON.stringify(cleanup.json));
    });

    /* ---------------- login lockout */
    await t.test('sign-in locks after 5 failures', async () => {
      const created = await api('POST', '/api/users', { cookie: owner, body: { ...LOCKED, locationIds: [locB] } });
      assert.equal(created.status, 200, JSON.stringify(created.json));
      const from = { 'x-forwarded-for': '198.51.100.7' };
      for (let i = 0; i < 5; i++) {
        const r = await api('POST', '/api/auth/login', { body: { username: LOCKED.username, password: `wrong password ${i}` }, headers: from });
        assert.equal(r.status, 401, `failure ${i + 1}`);
        assert.equal(r.json.error.code, 'wrong_credentials');
      }
      const locked = await api('POST', '/api/auth/login', { body: LOCKED, headers: from });
      assert.equal(locked.status, 429, 'right password refused while locked');
      assert.equal(locked.json.error.code, 'throttled');

      // The lock is per name and network: the same account still works from another address.
      const elsewhere = await api('POST', '/api/auth/login', { body: LOCKED, headers: { 'x-forwarded-for': '198.51.100.8' } });
      assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.json));

      // Wrong 2-step codes (after a right password) lock the account itself.
      const from2 = { 'x-forwarded-for': '198.51.100.9' };
      const start = await api('POST', '/api/auth/login', { body: VIEWER, headers: from2 });
      assert.equal(start.status, 200, JSON.stringify(start.json));
      assert.equal(start.json.next, 'totp');
      for (let i = 0; i < 5; i++) {
        const r = await api('POST', '/api/auth/totp', { body: { challenge: start.json.challenge, code: wrongCode(viewerSecret) }, headers: from2 });
        assert.equal(r.status, 401, `wrong code ${i + 1}`);
      }
      const after = await api('POST', '/api/auth/login', { body: VIEWER, headers: from2 });
      assert.equal(after.status, 429, 'account locked after 5 wrong codes');
      const right = await api('POST', '/api/auth/totp', { body: { challenge: start.json.challenge, code: await freshCode(viewerSecret) }, headers: from2 });
      assert.equal(right.status, 429, 'even a right code is refused while locked');
    });

    /* ---------------- recording off */
    await t.test('switching recording off stops new segments', async () => {
      const off = await api('PATCH', `/api/cameras/${cameraId}`, { cookie: owner, body: { recording: false } });
      assert.equal(off.status, 200, JSON.stringify(off.json));
      assert.equal(off.json.recording, false);
      assert.equal(off.json.effectiveRecording, false);

      const internal = JSON.parse(readFileSync(path.join(dataDir, 'secrets', 'mediamtx-internal.json'), 'utf8')) as { user: string; password: string };
      const auth = 'Basic ' + Buffer.from(`${internal.user}:${internal.password}`).toString('base64');
      const conf = await waitFor('MediaMTX path config with record off', 15_000, async () => {
        const r = await fetch(`http://127.0.0.1:${apiPort}/v3/config/paths/get/c${cameraId}`, { headers: { authorization: auth } });
        const j = r.ok ? ((await r.json()) as { record: boolean; sourceOnDemand: boolean }) : null;
        return j && j.record === false ? j : null;
      });
      assert.equal(conf.sourceOnDemand, true, 'source pulled only on demand while not recording');

      await sleep(4000);
      const snapshot = (): Map<string, number> => {
        const m = new Map<string, number>();
        if (!existsSync(rawDir)) return m;
        for (const n of readdirSync(rawDir)) m.set(n, statSync(path.join(rawDir, n)).size);
        return m;
      };
      const before = snapshot();
      const segCountBefore = (await api('GET', `/api/recordings?cameraId=${cameraId}`, { cookie: owner })).json.items.length as number;
      await sleep((SEGMENT_SECONDS * 2 + 10) * 1000);
      const after = snapshot();
      for (const [name, size] of after) {
        assert.ok(before.has(name), `no new raw segment after recording off (new: ${name})`);
        assert.equal(size, before.get(name), `raw file ${name} no longer grows`);
      }
      const segCountAfter = (await api('GET', `/api/recordings?cameraId=${cameraId}`, { cookie: owner })).json.items.length as number;
      assert.ok(segCountAfter <= segCountBefore + before.size, 'no segments beyond what was already on disk');
    });

    /* ---------------- retention */
    await t.test('retention removes a segment older than the location keeps', async () => {
      const list = await api('GET', `/api/recordings?cameraId=${cameraId}&order=asc`, { cookie: owner });
      const items = list.json.items as any[];
      assert.ok(items.length >= 1);
      const old = items[0];
      await stopProcess(hub);
      const db = new DatabaseSync(path.join(dataDir, 'db.sqlite'));
      let relPath: string;
      try {
        const row = db.prepare('SELECT rel_path FROM segments WHERE id = ?').get(old.id) as { rel_path: string };
        relPath = row.rel_path;
        db.prepare('UPDATE segments SET start_at = ?, duration_ms = ? WHERE id = ?').run(Date.now() - 30 * DAY_MS, 10_000, old.id);
      } finally {
        db.close();
      }
      const vaultFile = path.join(dataDir, 'vault', ...relPath.split('/'));
      assert.ok(existsSync(vaultFile), 'vault file exists before retention');

      hub = await startHub();
      await waitFor('retention at start', 30_000, async () => {
        const r = await api('GET', `/api/recordings?cameraId=${cameraId}&order=asc`, { cookie: owner });
        return r.status === 200 && !r.json.items.some((i: any) => i.id === old.id);
      });
      assert.equal(existsSync(vaultFile), false, 'vault file deleted');
      const left = (await api('GET', `/api/recordings?cameraId=${cameraId}`, { cookie: owner })).json.items as any[];
      for (const i of items.slice(1)) assert.ok(left.some((l) => l.id === i.id), `segment ${i.id} inside retention is kept`);
    });

    failed = false;
  } finally {
    if (failed) {
      for (const p of procs) t.diagnostic(`--- ${p.name} log (last lines) ---\n${tail(p.log)}`);
    }
    await Promise.all(procs.map(stopProcess));
    if (process.env.CCTV_E2E_KEEP === '1' || failed) {
      t.diagnostic(`temp folder kept: ${tmp}`);
    } else {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  }
});
