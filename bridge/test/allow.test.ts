import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRIDGE_MAX_STREAMS, isAllowedBridgeTarget } from '../../shared/bridge-protocol.ts';
import { BridgeSession, checkOpen } from '../src/session.ts';

test('only private IPv4 targets on 554, 2020, 80 and 8000 are allowed', () => {
  for (const host of ['10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.64']) {
    for (const port of [554, 2020, 80, 8000]) assert.equal(checkOpen(host, port, 0), null, `${host}:${port}`);
  }
  const refused: Array<[unknown, unknown]> = [
    ['8.8.8.8', 554],
    ['127.0.0.1', 554],
    ['169.254.1.1', 554],
    ['172.32.0.1', 554],
    ['172.15.0.1', 554],
    ['100.64.0.1', 554],
    ['0.0.0.0', 554],
    ['255.255.255.255', 80],
    ['192.168.1.64', 22],
    ['192.168.1.64', 443],
    ['192.168.1.64', 8554],
    ['192.168.01.64', 554],
    ['192.168.1.64 ', 554],
    ['camera.local', 554],
    ['::1', 554],
    ['::ffff:192.168.1.64', 554],
    ['192.168.1.64', '554'],
    ['192.168.1.64', 554.5],
    [null, 554],
  ];
  for (const [host, port] of refused) {
    assert.notEqual(checkOpen(host, port, 0), null, `${String(host)}:${String(port)}`);
  }
  assert.equal(isAllowedBridgeTarget('192.168.1.64', 554), true);
});

test('at most 32 streams at once', () => {
  assert.equal(checkOpen('192.168.1.64', 554, BRIDGE_MAX_STREAMS - 1), null);
  assert.match(String(checkOpen('192.168.1.64', 554, BRIDGE_MAX_STREAMS)), /Too many streams/);
});

test('a session answers open-failed for refused targets and never connects', () => {
  const sent: Array<Record<string, unknown>> = [];
  let connects = 0;
  const session = new BridgeSession(
    {
      sendText: (t) => void sent.push(JSON.parse(t) as Record<string, unknown>),
      sendBinary: () => undefined,
      bufferedAmount: () => 0,
      close: () => undefined,
    },
    {
      connect: () => {
        connects++;
        throw new Error('must not connect');
      },
    },
  );
  session.handleText(JSON.stringify({ t: 'open', id: 1, host: '8.8.8.8', port: 554 }));
  session.handleText(JSON.stringify({ t: 'open', id: 2, host: '192.168.1.5', port: 22 }));
  session.handleText(JSON.stringify({ t: 'open', id: 2, host: '192.168.1.5', port: 554 }));
  assert.equal(connects, 0);
  assert.deepEqual(
    sent.map((m) => [m.t, m.id]),
    [
      ['open-failed', 1],
      ['open-failed', 2],
      ['open-failed', 2],
    ],
  );
  assert.match(String(sent[2].error), /already used/, 'stream ids are never reused');
  session.handleText(JSON.stringify({ t: 'ping', ts: 42 }));
  assert.deepEqual(sent[3], { t: 'pong', ts: 42 });
  session.end();
});
