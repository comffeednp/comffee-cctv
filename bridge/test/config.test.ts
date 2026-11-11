import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextBackoff } from '../src/client.ts';
import { TOKEN_ENV, normalizeHubUrl, parseArgs } from '../src/config.ts';
import { localNetworks, parseProbeMatch } from '../src/detect.ts';

const TOKEN = 'A'.repeat(43);

test('hub address is normalised to wss://host/bridge', () => {
  assert.equal(normalizeHubUrl('cctv.example.com'), 'wss://cctv.example.com/bridge');
  assert.equal(normalizeHubUrl('https://cctv.example.com'), 'wss://cctv.example.com/bridge');
  assert.equal(normalizeHubUrl('wss://cctv.example.com/bridge?x=1#y'), 'wss://cctv.example.com/bridge');
  assert.equal(normalizeHubUrl('ws://127.0.0.1:8080'), 'ws://127.0.0.1:8080/bridge');
  assert.throws(() => normalizeHubUrl('ws://cctv.example.com/bridge'), /wss/);
  assert.throws(() => normalizeHubUrl('ftp://cctv.example.com'));
  assert.throws(() => normalizeHubUrl('wss://user:pw@cctv.example.com'));
});

test('flags, config file and environment are combined; flags win', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-cfg-'));
  try {
    const file = join(dir, 'bridge.json');
    writeFileSync(file, `﻿${JSON.stringify({ hub: 'wss://a.example/bridge', token: TOKEN, name: 'desk' })}`);
    const fromFile = parseArgs(['--config', file], {});
    assert.equal(fromFile.kind, 'run');
    if (fromFile.kind === 'run') assert.deepEqual(fromFile.config, { hub: 'wss://a.example/bridge', token: TOKEN, name: 'desk' });

    const override = parseArgs([`--config=${file}`, '--hub', 'b.example', '--name', 'shop\nfront'], {});
    if (override.kind !== 'run') throw new Error(JSON.stringify(override));
    assert.equal(override.config.hub, 'wss://b.example/bridge');
    assert.equal(override.config.name, 'shopfront');

    const creds = parseArgs([], { CREDENTIALS_DIRECTORY: dir });
    assert.equal(creds.kind, 'run');

    const env = parseArgs(['--hub', 'c.example'], { [TOKEN_ENV]: TOKEN });
    assert.equal(env.kind, 'run');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(parseArgs(['--help'], {}).kind, 'help');
  assert.equal(parseArgs(['--hub', 'x.example'], {}).kind, 'error');
  assert.equal(parseArgs(['--hub', 'x.example', '--token', 'short'], {}).kind, 'error');
  assert.equal(parseArgs(['--hub', 'x.example', '--token', `${TOKEN}\r\nX-Evil: 1`], {}).kind, 'error');
  assert.equal(parseArgs(['--unknown'], {}).kind, 'error');
  assert.equal(parseArgs(['--hub'], {}).kind, 'error');
});

test('reconnect backoff doubles from 1 s up to 30 s', () => {
  const seq: number[] = [];
  let b = 1000;
  for (let i = 0; i < 7; i++) {
    seq.push(b);
    b = nextBackoff(b);
  }
  assert.deepEqual(seq, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test('WS-Discovery replies give private ONVIF addresses only', () => {
  const xml =
    '<e:Envelope><e:Body><d:ProbeMatches><d:ProbeMatch><d:XAddrs>http://192.168.1.20:2020/onvif/device_service ' +
    'http://[fe80::1]/onvif/device_service</d:XAddrs></d:ProbeMatch></d:ProbeMatches></e:Body></e:Envelope>';
  assert.deepEqual([...parseProbeMatch(xml, '192.168.1.20')], [['192.168.1.20', 2020]]);
  const plain = '<d:XAddrs>http://10.0.0.8/onvif/device_service http://8.8.8.8/x</d:XAddrs>';
  assert.deepEqual([...parseProbeMatch(plain, '10.0.0.8')], [['10.0.0.8', 80]]);
  assert.equal(parseProbeMatch('<d:XAddrs>http://8.8.8.8/x</d:XAddrs>', '8.8.8.8').size, 0);
});

test('local networks: private IPv4 /24s, home networks first, duplicates removed', () => {
  const nets = localNetworks({
    eth0: [{ address: '172.20.1.5', netmask: '255.255.0.0', family: 'IPv4', mac: '', internal: false, cidr: null }],
    wifi: [
      { address: '192.168.1.10', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null },
      { address: '192.168.1.11', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null },
    ],
    lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: null }],
    wan: [{ address: '203.0.113.9', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null }],
  });
  assert.deepEqual(nets.map((n) => n.prefix24), ['192.168.1', '172.20.1']);
});
