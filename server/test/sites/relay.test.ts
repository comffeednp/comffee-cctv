/**
 * End-to-end relay: TCP client -> hub relay listener -> binary frames -> bridge session -> TCP echo server,
 * and back. The two WebSocket ends are joined in memory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer, type AddressInfo, type Server } from 'node:net';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DB_PRAGMAS_SQL, SCHEMA_SQL } from '../../src/contracts.ts';
import { BRIDGE_PENDING_PER_IP, BridgeHub, hashBridgeToken, newBridgeToken, type HubSocket } from '../../src/sites/bridge-hub.ts';
import { BridgeSession } from '../../../bridge/src/session.ts';
import { BRIDGE_CLOSE, BRIDGE_HELLO_TIMEOUT_MS, decodeDataFrame, encodeDataFrame } from '../../../shared/bridge-protocol.ts';

type Handler = (...args: never[]) => void;

class FakeWs implements HubSocket {
  readyState = 1;
  closedWith: number | null = null;
  readonly sent: Array<string | Buffer> = [];
  private readonly handlers: Record<string, Handler[]> = { message: [], close: [], error: [] };
  peer: (data: string | Buffer) => void = () => undefined;

  send(data: string | Uint8Array, cb?: (err?: Error) => void): void {
    const copy = typeof data === 'string' ? data : Buffer.from(data);
    this.sent.push(copy);
    setImmediate(() => {
      this.peer(copy);
      cb?.();
    });
  }
  close(code?: number): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closedWith = code ?? 1000;
    setImmediate(() => this.emit('close', this.closedWith));
  }
  terminate(): void {
    this.close(1006);
  }
  on(event: string, fn: Handler): this {
    this.handlers[event].push(fn);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.handlers[event]) (fn as (...a: unknown[]) => void)(...args);
  }
}

function setupDb(): { db: DatabaseSync; token: string; locationId: number } {
  const db = new DatabaseSync(':memory:');
  db.exec(DB_PRAGMAS_SQL);
  db.exec(SCHEMA_SQL);
  const token = newBridgeToken();
  const r = db
    .prepare("INSERT INTO locations (name, timezone, connector, bridge_token_hash, created_at) VALUES ('Shop', 'UTC', 'bridge', ?, ?)")
    .run(hashBridgeToken(token), Date.now());
  return { db, token, locationId: Number(r.lastInsertRowid) };
}

async function echoServer(): Promise<Server> {
  const server = createServer((s) => s.pipe(s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

/** Joins a hub-side FakeWs and a bridge session in memory; `fromBridge` records the bridge's control messages. */
function join(ws: FakeWs, allowPort: number, fromBridge: string[] = []): BridgeSession {
  const session = new BridgeSession(
    {
      sendText: (text) => {
        fromBridge.push(text);
        setImmediate(() => ws.emit('message', Buffer.from(text), false));
      },
      sendBinary: (data) => {
        const copy = Buffer.from(data);
        setImmediate(() => ws.emit('message', copy, true));
      },
      bufferedAmount: () => 0,
      close: () => ws.close(),
    },
    { isAllowed: (h, p) => h === '127.0.0.1' && p === allowPort },
  );
  ws.peer = (data) => (typeof data === 'string' ? session.handleText(data) : session.handleBinary(data));
  return session;
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('data frames round-trip through encode and decode', () => {
  const payload = randomBytes(1000);
  const frame = encodeDataFrame(0xfffffffe, payload);
  assert.equal(frame.length, 1004);
  const out = decodeDataFrame(frame);
  assert.equal(out.id, 0xfffffffe);
  assert.deepEqual(Buffer.from(out.payload), payload);
  assert.throws(() => encodeDataFrame(0, payload));
  assert.throws(() => decodeDataFrame(new Uint8Array(3)));
});

test('bytes travel client -> hub relay -> bridge -> camera and back', async () => {
  const { db, token, locationId } = setupDb();
  const hub = new BridgeHub(db);
  const echo = await echoServer();
  const echoPort = (echo.address() as AddressInfo).port;
  const ws = new FakeWs();
  const session = join(ws, echoPort);
  try {
    hub.accept(ws, '198.51.100.7', null);
    ws.emit('message', Buffer.from(JSON.stringify({ t: 'hello', v: 1, token, name: 'pc', version: 't' })), false);
    await tick();
    assert.equal(hub.isConnected(locationId), true);
    assert.equal(hub.status(locationId).online, true);
    assert.ok(ws.sent.some((m) => typeof m === 'string' && m.includes('"welcome"')));

    const relay = await hub.relayAddress(locationId, '127.0.0.1', echoPort);
    assert.equal(relay.host, '127.0.0.1');
    const again = await hub.relayAddress(locationId, '127.0.0.1', echoPort);
    assert.equal(again.port, relay.port, 'the relay port stays the same');

    const data = randomBytes(1024 * 1024 + 123);
    const client = connect(relay.port, '127.0.0.1');
    const received: Buffer[] = [];
    let total = 0;
    const done = new Promise<void>((resolve) =>
      client.on('data', (c: Buffer) => {
        received.push(c);
        total += c.length;
        if (total >= data.length) resolve();
      }),
    );
    client.write(data);
    await done;
    assert.deepEqual(Buffer.concat(received), data);
    assert.equal(session.streamCount, 1);
    const frames = ws.sent.filter((m): m is Buffer => Buffer.isBuffer(m));
    assert.ok(frames.length >= 5, 'large writes are split into frames of at most 256 KiB');
    assert.ok(frames.every((f) => f.length <= 4 + 256 * 1024));

    client.destroy();
    await tick(50);
    assert.equal(session.streamCount, 0, 'closing the client closes the camera connection');
    assert.ok(ws.sent.some((m) => typeof m === 'string' && m.includes('"t":"close"')));
  } finally {
    session.end();
    await hub.stop();
    echo.close();
    db.close();
  }
});

test('the bridge refuses targets outside its allow-list, and the hub drops the client', async () => {
  const { db, token, locationId } = setupDb();
  const hub = new BridgeHub(db);
  const ws = new FakeWs();
  const fromBridge: string[] = [];
  const session = join(ws, 1, fromBridge); // nothing on 127.0.0.1 is allowed except port 1
  try {
    hub.accept(ws, '198.51.100.7', null);
    ws.emit('message', Buffer.from(JSON.stringify({ t: 'hello', v: 1, token, name: 'pc', version: 't' })), false);
    await tick();
    const relay = await hub.relayAddress(locationId, '192.168.1.50', 554);
    const client = connect(relay.port, '127.0.0.1');
    const closed = new Promise<void>((r) => client.on('close', () => r()));
    client.on('error', () => undefined);
    await closed;
    const failed = fromBridge.map((t) => JSON.parse(t) as { t: string; error?: string }).find((m) => m.t === 'open-failed');
    assert.ok(failed, 'the bridge answered open-failed');
    assert.match(failed.error ?? '', /not allowed/);
    assert.equal(session.streamCount, 0);
  } finally {
    session.end();
    await hub.stop();
    db.close();
  }
});

test('a wrong token in hello closes with badToken and counts a failure for the IP', async () => {
  const { db } = setupDb();
  const hub = new BridgeHub(db);
  const ws = new FakeWs();
  try {
    hub.accept(ws, '198.51.100.9', null);
    ws.emit('message', Buffer.from(JSON.stringify({ t: 'hello', v: 1, token: newBridgeToken(), name: 'x', version: 't' })), false);
    await tick();
    assert.equal(ws.closedWith, BRIDGE_CLOSE.badToken);
    const n = db.prepare("SELECT COUNT(*) AS n FROM ip_failures WHERE ip = ? AND kind = 'bridge'").get('198.51.100.9') as { n: number };
    assert.equal(Number(n.n), 1);
    for (let i = 0; i < 9; i++) hub.recordFailure('198.51.100.9');
    assert.equal(hub.isThrottled('198.51.100.9'), true);
    assert.equal(hub.isThrottled('198.51.100.10'), false);
  } finally {
    await hub.stop();
    db.close();
  }
});

test('a valid token in hello signs in even when the IP is throttled', async () => {
  const { db, token, locationId } = setupDb();
  const hub = new BridgeHub(db);
  const ip = '198.51.100.11';
  const ws = new FakeWs();
  const bad = new FakeWs();
  try {
    for (let i = 0; i < 10; i++) hub.recordFailure(ip);
    assert.equal(hub.isThrottled(ip), true);
    hub.accept(bad, ip, null);
    bad.emit('message', Buffer.from(JSON.stringify({ t: 'hello', v: 1, token: newBridgeToken(), name: 'x', version: 't' })), false);
    assert.equal(bad.closedWith, BRIDGE_CLOSE.throttled, 'a wrong token from a throttled IP is told to wait');
    hub.accept(ws, ip, null);
    ws.emit('message', Buffer.from(JSON.stringify({ t: 'hello', v: 1, token, name: 'pc', version: 't' })), false);
    await tick();
    assert.equal(ws.closedWith, null);
    assert.equal(hub.isConnected(locationId), true);
    const n = db.prepare("SELECT COUNT(*) AS n FROM ip_failures WHERE ip = ? AND kind = 'bridge'").get(ip) as { n: number };
    assert.equal(Number(n.n), 10, 'tries from an already throttled IP are not stored again');
  } finally {
    await hub.stop();
    db.close();
  }
});

test('header-less sockets count a failure without a good hello, and only a few may wait at once', async (t) => {
  const { db, token } = setupDb();
  const hub = new BridgeHub(db);
  const ip = '198.51.100.12';
  const failures = (): number =>
    Number((db.prepare("SELECT COUNT(*) AS n FROM ip_failures WHERE ip = ? AND kind = 'bridge'").get(ip) as { n: number }).n);
  const sockets: FakeWs[] = [];
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (let i = 0; i < BRIDGE_PENDING_PER_IP; i++) {
      const ws = new FakeWs();
      sockets.push(ws);
      hub.accept(ws, ip, null);
    }
    assert.equal(hub.hasHelloSlot(ip), false);
    assert.equal(hub.hasHelloSlot('198.51.100.13'), true, 'other addresses are not affected');
    const extra = new FakeWs();
    hub.accept(extra, ip, null);
    assert.equal(extra.closedWith, BRIDGE_CLOSE.throttled, 'a fifth waiting socket from one IP is closed at once');
    assert.equal(failures(), 0);

    sockets[0].emit('message', Buffer.from('not json'), false);
    assert.equal(sockets[0].closedWith, BRIDGE_CLOSE.protocolError);
    assert.equal(failures(), 1, 'a bad hello counts as a failed try');
    assert.equal(hub.hasHelloSlot(ip), true, 'the slot is free again');

    sockets[1].emit('message', Buffer.from(JSON.stringify({ t: 'hello', v: 1, token, name: 'pc', version: 't' })), false);
    assert.equal(sockets[1].closedWith, null, 'a good hello signs in');
    assert.equal(failures(), 1);

    t.mock.timers.tick(BRIDGE_HELLO_TIMEOUT_MS);
    assert.equal(sockets[2].closedWith, BRIDGE_CLOSE.helloTimeout);
    assert.equal(sockets[3].closedWith, BRIDGE_CLOSE.helloTimeout);
    assert.equal(failures(), 3, 'a missing hello counts as a failed try');
    assert.equal(hub.hasHelloSlot(ip), true);

    // A socket that signed in with a valid header is the real bridge: a bad hello does not count against the IP.
    const auth = hub.lookupToken(token);
    assert.ok(auth);
    const headerSigned = new FakeWs();
    hub.accept(headerSigned, ip, auth);
    headerSigned.emit('message', Buffer.from(JSON.stringify({ t: 'hello', v: 999 })), false);
    assert.equal(headerSigned.closedWith, BRIDGE_CLOSE.protocolError);
    assert.equal(failures(), 3);
  } finally {
    t.mock.timers.reset();
    await hub.stop();
    db.close();
  }
});

test('a newer connection replaces the older one; a new token drops the bridge', async () => {
  const { db, token, locationId } = setupDb();
  const hub = new BridgeHub(db);
  const first = new FakeWs();
  const second = new FakeWs();
  try {
    const auth = hub.lookupToken(token);
    assert.ok(auth);
    hub.accept(first, '198.51.100.7', auth);
    first.emit('message', Buffer.from(JSON.stringify({ t: 'hello', v: 1, token: '', name: 'a', version: 't' })), false);
    hub.accept(second, '198.51.100.8', auth);
    second.emit('message', Buffer.from(JSON.stringify({ t: 'hello', v: 1, token: '', name: 'b', version: 't' })), false);
    await tick();
    assert.equal(first.closedWith, BRIDGE_CLOSE.replaced);
    assert.equal(hub.isConnected(locationId), true);
    db.prepare('UPDATE locations SET bridge_token_hash = ? WHERE id = ?').run(hashBridgeToken(newBridgeToken()), locationId);
    await hub.locationChanged(locationId);
    await tick();
    assert.equal(second.closedWith, BRIDGE_CLOSE.badToken);
    assert.equal(hub.isConnected(locationId), false);
    assert.equal(hub.lookupToken(token), null);
  } finally {
    await hub.stop();
    db.close();
  }
});

test('detection request and result pass through, with devices sanitised', async () => {
  const { db, token, locationId } = setupDb();
  const hub = new BridgeHub(db);
  const ws = new FakeWs();
  const session = new BridgeSession(
    {
      sendText: (text) => setImmediate(() => ws.emit('message', Buffer.from(text), false)),
      sendBinary: () => undefined,
      bufferedAmount: () => 0,
      close: () => ws.close(),
    },
    {
      detect: async () => ({
        devices: [
          { ip: '192.168.1.20', rtspPort: 554, onvifPort: 2020, rtsp: true, onvif: true, guessVendor: 'tapo' },
          { ip: '8.8.8.8', rtspPort: 554, onvifPort: null, rtsp: true, onvif: false, guessVendor: 'custom' },
        ],
        scanned: 254,
        tookMs: 1200,
      }),
    },
  );
  ws.peer = (data) => (typeof data === 'string' ? session.handleText(data) : session.handleBinary(data));
  try {
    hub.accept(ws, '198.51.100.7', null);
    ws.emit('message', Buffer.from(JSON.stringify({ t: 'hello', v: 1, token, name: 'pc', version: 't' })), false);
    await tick();
    const result = await hub.detect(locationId);
    assert.equal(result.scanned, 254);
    assert.deepEqual(result.devices.map((d) => d.ip), ['192.168.1.20'], 'public addresses from a bridge are dropped');
  } finally {
    session.end();
    await hub.stop();
    db.close();
  }
});
