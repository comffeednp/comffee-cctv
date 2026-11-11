import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DB_PRAGMAS_SQL, HUB_CONFIG_DEFAULTS, HttpError, SCHEMA_SQL, type HubConfig } from '../../src/contracts.ts';
import { createConnectorServiceWith } from '../../src/sites/connectors.ts';
import type { CommandRunner } from '../../src/sites/wireguard.ts';

const HUB_KEY = Buffer.alloc(32, 1).toString('base64');
const ROUTER_KEY = Buffer.alloc(32, 2).toString('base64');
const OLD_KEY = Buffer.alloc(32, 3).toString('base64');

function setup(wgEnabled: boolean, staleAllowedIps = '') {
  const db = new DatabaseSync(':memory:');
  db.exec(DB_PRAGMAS_SQL);
  db.exec(SCHEMA_SQL);
  const config: HubConfig = {
    ...HUB_CONFIG_DEFAULTS,
    publicIp: '203.0.113.10',
    wireguard: { ...HUB_CONFIG_DEFAULTS.wireguard, enabled: wgEnabled, publicKey: HUB_KEY },
  };
  const calls: string[][] = [];
  const run: CommandRunner = async (program, args) => {
    calls.push([program, ...args]);
    if (args[0] === 'show' && args[2] === 'allowed-ips') return { code: 0, stdout: staleAllowedIps, stderr: '' };
    if (args[0] === 'show' && args[2] === 'latest-handshakes') {
      return { code: 0, stdout: `${ROUTER_KEY}\t${Math.floor(Date.now() / 1000) - 10}\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const box = { seal: (s: string) => s, open: (s: string) => s };
  const secrets = { masterKey: Buffer.alloc(32), streamTokenKey: Buffer.alloc(32), mediamtxUser: 'u', mediamtxPassword: 'p' };
  const service = createConnectorServiceWith({ db, config, secrets, box, audit: () => undefined }, { runCommand: run });
  const add = (connector: string, extra: Record<string, unknown> = {}): number => {
    const r = db
      .prepare(
        'INSERT INTO locations (name, timezone, connector, slot, camera_subnet, router_public_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'Shop',
        'UTC',
        connector,
        (extra.slot as number | null) ?? null,
        (extra.subnet as string | null) ?? null,
        (extra.key as string | null) ?? null,
        Date.now(),
      );
    return Number(r.lastInsertRowid);
  };
  return { db, service, calls, add };
}

async function rejectsWith(p: Promise<unknown>, status: number): Promise<void> {
  await assert.rejects(p, (err: unknown) => err instanceof HttpError && err.status === status);
}

test('router peers are applied from the database at start with argument arrays', async () => {
  const stale = `${OLD_KEY}\t10.77.9.2/32 10.78.9.0/24\nADMINKEYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=\t10.99.0.2/32\n`;
  const { service, calls, add } = setup(true, stale);
  const id = add('router', { slot: 3, subnet: '192.168.1.0/24', key: ROUTER_KEY });
  try {
    await service.start();
    const flat = calls.map((c) => c.join(' '));
    assert.ok(flat.includes(`wg set wg0 peer ${OLD_KEY} remove`), 'stale hub-made peer removed');
    assert.ok(flat.includes('ip route del 10.78.9.0/24 dev wg0'));
    assert.ok(!flat.some((c) => c.includes('ADMINKEY')), 'peers the hub did not make are left alone');
    assert.ok(calls.some((c) => c.join('\u0001') === ['wg', 'set', 'wg0', 'peer', ROUTER_KEY, 'allowed-ips', '10.77.3.2/32,10.78.3.0/24'].join('\u0001')));
    assert.ok(flat.includes('ip route replace 10.78.3.0/24 dev wg0'));
    assert.ok(flat.includes('wg show wg0 latest-handshakes'));

    assert.deepEqual(await service.resolveCameraAddress(id, '192.168.1.64', 554), { host: '10.78.3.64', port: 554 });
    assert.deepEqual(await service.resolveCameraAddress(id, '192.168.1.64', 2020), { host: '10.78.3.64', port: 2020 });
    await rejectsWith(service.resolveCameraAddress(id, '192.168.2.64', 554), 422);
    await rejectsWith(service.resolveCameraAddress(id, '192.168.1.64', 80), 422);
    await rejectsWith(service.resolveCameraAddress(id, 'camera.local', 554), 422);
    await rejectsWith(service.resolveCameraAddress(999, '192.168.1.64', 554), 404);

    const status = service.locationStatus(id);
    assert.equal(status.online, true);
    assert.ok(status.lastSeen !== null && Date.now() - status.lastSeen < 60_000);
  } finally {
    await service.stop();
  }
});

test('a changed or removed router key updates the hub peer', async () => {
  const { db, service, calls, add } = setup(true);
  const id = add('router', { slot: 4, subnet: '192.168.5.0/24', key: ROUTER_KEY });
  try {
    await service.start();
    calls.length = 0;
    db.prepare('UPDATE locations SET router_public_key = NULL WHERE id = ?').run(id);
    await service.onLocationChanged(id);
    const flat = calls.map((c) => c.join(' '));
    assert.ok(flat.includes(`wg set wg0 peer ${ROUTER_KEY} remove`));
    assert.ok(flat.includes('ip route del 10.78.4.0/24 dev wg0'));
    await rejectsWith(service.resolveCameraAddress(id, '192.168.5.10', 554), 503);
    db.prepare('DELETE FROM locations WHERE id = ?').run(id);
    calls.length = 0;
    await service.onLocationChanged(id);
    assert.equal(calls.length, 0, 'nothing left to remove');
  } finally {
    await service.stop();
  }
});

test('with WireGuard disabled no command runs and router addresses are unavailable', async () => {
  const { service, calls, add } = setup(false);
  const router = add('router', { slot: 1, subnet: '192.168.1.0/24', key: ROUTER_KEY });
  const direct = add('direct', { subnet: '192.168.9.0/24' });
  const bridge = add('bridge');
  try {
    await service.start();
    await service.onLocationChanged(router);
    assert.equal(calls.length, 0);
    await rejectsWith(service.resolveCameraAddress(router, '192.168.1.5', 554), 503);
    assert.deepEqual(await service.resolveCameraAddress(direct, '192.168.9.5', 8554), { host: '192.168.9.5', port: 8554 });
    assert.deepEqual(service.locationStatus(direct), { online: true, lastSeen: null });
    await rejectsWith(service.resolveCameraAddress(bridge, '192.168.1.5', 554), 503);
    await rejectsWith(service.resolveCameraAddress(bridge, '8.8.8.8', 554), 422);
    await rejectsWith(service.resolveCameraAddress(bridge, '192.168.1.5', 22), 422);
    assert.equal(service.locationStatus(bridge).online, false);
    await rejectsWith(service.detect(bridge), 503);
    assert.equal(await service.deviceInfo(bridge, '192.168.1.5', 2020, 'admin', 'x'), null);
  } finally {
    await service.stop();
  }
});

test('direct detection needs a camera network', async () => {
  const { service, add } = setup(false);
  const direct = add('direct');
  try {
    await rejectsWith(service.detect(direct), 422);
  } finally {
    await service.stop();
  }
});
