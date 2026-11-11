/** The real bridge client against the real /bridge route over a local WebSocket. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { DB_PRAGMAS_SQL, HUB_CONFIG_DEFAULTS, HttpError, SCHEMA_SQL, type AppDeps } from '../../src/contracts.ts';
import { createConnectorServiceWith } from '../../src/sites/connectors.ts';
import { bridgeHubOf, hashBridgeToken, newBridgeToken, registerBridgeSocket } from '../../src/sites/bridge-hub.ts';
import { BridgeClient } from '../../../bridge/src/client.ts';

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Sends a WebSocket upgrade request to /bridge and returns the HTTP status (101 when upgraded). */
function upgradeStatus(port: number, authorization: string | undefined): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const headers: Record<string, string> = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
    };
    if (authorization !== undefined) headers.Authorization = authorization;
    // A fresh connection each time: the server closes a refused upgrade connection.
    const req = request({ host: '127.0.0.1', port, path: '/bridge', headers, agent: false });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('error', reject);
    req.end();
  });
}

test('bridge signs in with the Authorization header, runs detection, and a bad token is refused before upgrade', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(DB_PRAGMAS_SQL);
  db.exec(SCHEMA_SQL);
  const token = newBridgeToken();
  const locationId = Number(
    db
      .prepare("INSERT INTO locations (name, timezone, connector, bridge_token_hash, created_at) VALUES ('S', 'UTC', 'bridge', ?, 0)")
      .run(hashBridgeToken(token)).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO cameras (location_id, name, lan_ip, vendor, main_path, username, password_enc, created_at) VALUES (?, 'C', '192.168.1.20', 'tapo', '/stream1', 'u', 'x', 0)",
  ).run(locationId);
  const config = { ...HUB_CONFIG_DEFAULTS };
  const box = { seal: (s: string) => s, open: (s: string) => s };
  const secrets = { masterKey: Buffer.alloc(32), streamTokenKey: Buffer.alloc(32), mediamtxUser: 'u', mediamtxPassword: 'p' };
  const connectors = createConnectorServiceWith({ db, config, secrets, box, audit: () => undefined });
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    return reply.code(500).send({ error: { code: 'internal', message: 'error' } });
  });
  await app.register(fastifyWebsocket);
  await registerBridgeSocket(app, { db, config, secrets, box, connectors } as unknown as AppDeps);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const logs: string[] = [];
  const client = new BridgeClient(
    { hub: `ws://127.0.0.1:${port}/bridge`, token, name: 'test' },
    {
      log: (m) => void logs.push(m),
      detect: async () => ({
        devices: [{ ip: '192.168.1.20', rtspPort: 554, onvifPort: 2020, rtsp: true, onvif: true, guessVendor: 'tapo' }],
        scanned: 254,
        tookMs: 5,
      }),
    },
  );
  try {
    await connectors.start();
    client.start();
    const hub = bridgeHubOf(connectors);
    await waitFor(() => hub.isConnected(locationId));
    assert.equal(connectors.locationStatus(locationId).online, true);
    await waitFor(() => logs.some((l) => l.includes(`location ${locationId}`)));

    const result = await connectors.detect(locationId);
    assert.deepEqual(result.devices, [
      { ip: '192.168.1.20', rtspPort: 554, onvifPort: 2020, rtsp: true, onvif: true, guessVendor: 'tapo', alreadyAdded: true },
    ]);
    assert.equal(result.scanned, 254);

    const relay = await connectors.resolveCameraAddress(locationId, '192.168.1.20', 554);
    assert.equal(relay.host, '127.0.0.1');

    const status = await upgradeStatus(port, `Bearer ${newBridgeToken()}`);
    assert.equal(status, 401, 'a wrong token never gets a WebSocket');
    const fails = db.prepare("SELECT COUNT(*) AS n FROM ip_failures WHERE kind = 'bridge'").get() as { n: number };
    assert.equal(Number(fails.n), 1);

    // Failed tries from the same address (a neighbour behind the same public IP) must not lock out the real bridge.
    for (let i = 0; i < 10; i++) hub.recordFailure('127.0.0.1');
    assert.equal(await upgradeStatus(port, `Bearer ${newBridgeToken()}`), 429, 'a wrong token from a throttled IP waits');
    assert.equal(await upgradeStatus(port, undefined), 429, 'a header-less try from a throttled IP waits');
    client.stop();
    await waitFor(() => !hub.isConnected(locationId));
    const again = new BridgeClient({ hub: `ws://127.0.0.1:${port}/bridge`, token, name: 'test' }, { log: () => undefined, detect: async () => ({ devices: [], scanned: 0, tookMs: 0 }) });
    try {
      again.start();
      await waitFor(() => hub.isConnected(locationId));
    } finally {
      again.stop();
    }
  } finally {
    client.stop();
    await connectors.stop();
    await app.close();
    db.close();
  }
});
