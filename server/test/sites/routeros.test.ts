import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RouterScriptError,
  genericWireguardConfig,
  routerOsScript,
  routerOsUndoScript,
  type RouterScriptInput,
} from '../../src/sites/routeros.ts';

const HUB_KEY = Buffer.alloc(32, 9).toString('base64');

function input(over: Partial<RouterScriptInput> = {}): RouterScriptInput {
  return {
    locationId: 3,
    slot: 7,
    cameraSubnet: '192.168.1.0/24',
    hubPublicKey: HUB_KEY,
    hubIp: '203.0.113.10',
    hubPort: 51820,
    uploadCapKbps: 5000,
    routingTable: null,
    ...over,
  };
}

/** Lines that create something: every one must carry the marker comment. */
function addLines(script: string): string[] {
  return script.split('\n').filter((l) => / add /.test(l));
}

test('script has every item from the contract, tagged with the comment', () => {
  const s = routerOsScript(input());
  assert.match(s, /\/interface wireguard add name="wg-cctv" listen-port=52007 comment="comffee-cctv"/);
  assert.match(
    s,
    new RegExp(
      `/interface wireguard peers add interface="wg-cctv" public-key="${HUB_KEY.replace(/[+/]/g, '\\$&')}" endpoint-address=203\\.0\\.113\\.10 endpoint-port=51820 allowed-address=10\\.77\\.0\\.1/32 persistent-keepalive=25s comment="comffee-cctv"`,
    ),
  );
  assert.match(s, /\/ip address add address=10\.77\.7\.2\/16 interface="wg-cctv" comment="comffee-cctv"/);
  assert.match(
    s,
    /chain=dstnat in-interface="wg-cctv" dst-address=10\.78\.7\.0\/24 action=netmap to-addresses=192\.168\.1\.0\/24 comment="comffee-cctv"/,
  );
  assert.match(
    s,
    /chain=forward in-interface="wg-cctv" dst-address=192\.168\.1\.0\/24 protocol=tcp dst-port=554,2020 action=accept comment="comffee-cctv"/,
  );
  assert.match(
    s,
    /chain=forward out-interface="wg-cctv" src-address=192\.168\.1\.0\/24 protocol=tcp src-port=554,2020 action=accept comment="comffee-cctv"/,
  );
  assert.match(s, /chain=forward in-interface="wg-cctv" action=drop comment="comffee-cctv"/);
  assert.match(s, /chain=input in-interface="wg-cctv" action=drop comment="comffee-cctv"/);
  assert.match(s, /\/queue simple add name="comffee-cctv" target="wg-cctv" max-limit=5000k\/5000k priority=8\/8 comment="comffee-cctv"/);
  assert.doesNotMatch(s, /mangle add/);
  const lines = s.trimEnd().split('\n');
  assert.equal(lines[lines.length - 1], '}');
  assert.match(lines[lines.length - 3], /^:put \("Router public key: " \. \[\/interface wireguard get \[find where name="wg-cctv"\] public-key\]\)$/);
  for (const line of addLines(s)) assert.match(line, /comment="comffee-cctv"/, line);
});

test('firewall and NAT rules go to the top and still work on an empty list', () => {
  const s = routerOsScript(input());
  for (const menu of ['/ip firewall filter', '/ip firewall nat', '/queue simple']) {
    assert.ok(s.includes(`:set ids [${menu} find where dynamic=no]`), menu);
  }
  assert.match(s, /:if \(\[:len \$ids\] = 0\) do=\{\n  \/ip firewall filter add chain=input/);
  assert.match(s, /place-before=\[:pick \$ids 0\]/);
  // Added top-first, so the forward accept is added last and ends up above the forward drop.
  const iInput = s.indexOf('chain=input in-interface');
  const iDrop = s.indexOf('chain=forward in-interface="wg-cctv" action=drop');
  const iAccept = s.indexOf('action=accept');
  assert.ok(iInput < iDrop && iDrop < iAccept);
  // Camera replies are accepted at the very top too, so tunnel connections never reach the router's
  // FastTrack rule (FastTrack would skip the upload cap queue).
  const iReplies = s.indexOf('chain=forward out-interface="wg-cctv"');
  assert.ok(iAccept < iReplies && iReplies < s.indexOf('/queue simple add'));
  // The whole script is one block so :local works when pasted into a terminal.
  assert.match(s, /\n\{\n:local ids\n/);
});

test('re-running removes the earlier setup first but keeps the tunnel key', () => {
  const s = routerOsScript(input());
  const removeAt = s.indexOf('/ip firewall filter remove [find where comment="comffee-cctv"]');
  assert.ok(removeAt > 0 && removeAt < s.indexOf('/interface wireguard peers add'));
  assert.doesNotMatch(s, /\/interface wireguard remove/);
  assert.match(s, /:if \(\[:len \[\/interface wireguard find where name="wg-cctv"\]\] = 0\) do=\{/);
});

test('optional routing table adds a checked mangle rule', () => {
  const s = routerOsScript(input({ routingTable: 'isp2' }));
  assert.match(s, /\/routing table find where name="isp2"\]\] = 0\) do=\{ :error "Routing table isp2 was not found on this router\." \}/);
  assert.match(
    s,
    /chain=output protocol=udp dst-address=203\.0\.113\.10 dst-port=51820 action=mark-routing new-routing-mark="isp2" passthrough=no comment="comffee-cctv"/,
  );
});

test('undo script removes every tagged item including the interface', () => {
  const u = routerOsUndoScript();
  for (const menu of [
    '/queue simple',
    '/ip firewall mangle',
    '/ip firewall filter',
    '/ip firewall nat',
    '/ip address',
    '/interface wireguard peers',
    '/interface wireguard',
  ]) {
    assert.ok(u.includes(`${menu} remove [find where comment="comffee-cctv"]`), menu);
  }
  assert.ok(u.indexOf('/queue simple remove') < u.indexOf('/interface wireguard remove'), 'queue before its target');
});

test('generic WireGuard config carries the mapping note', () => {
  const g = genericWireguardConfig(input());
  assert.match(g, /must map 10\.78\.7\.0\/24 one-to-one onto the camera network 192\.168\.1\.0\/24/);
  assert.match(g, /use the bridge connector instead/);
  assert.match(g, /^Address = 10\.77\.7\.2\/16$/m);
  assert.match(g, new RegExp(`^PublicKey = ${HUB_KEY.replace(/[+/]/g, '\\$&')}$`, 'm'));
  assert.match(g, /^Endpoint = 203\.0\.113\.10:51820$/m);
  assert.match(g, /^AllowedIPs = 10\.77\.0\.1\/32$/m);
  assert.match(g, /^PersistentKeepalive = 25$/m);
});

test('every interpolated value is validated (injection attempts are refused)', () => {
  const bad: Array<Partial<RouterScriptInput>> = [
    { routingTable: 'isp2" ; /system reset-configuration ; "' },
    { routingTable: 'a b' },
    { routingTable: 'x'.repeat(33) },
    { routingTable: 'isp\n/user add name=x' },
    { hubPublicKey: `${HUB_KEY.slice(0, 43)}"` },
    { hubPublicKey: 'short=' },
    { hubPublicKey: `${HUB_KEY}\n/system reset-configuration` },
    { hubIp: '203.0.113.10 ; /system reboot' },
    { hubIp: '203.0.113.300' },
    { hubIp: '' },
    { cameraSubnet: '192.168.1.0/24 action=accept' },
    { cameraSubnet: '192.168.0.0/16' },
    { cameraSubnet: '8.8.8.0/24' },
    { slot: 0 },
    { slot: 251 },
    { slot: 1.5 },
    { uploadCapKbps: 5000.5 },
    { uploadCapKbps: 10 },
    { uploadCapKbps: Number.NaN },
    { hubPort: 0 },
    { hubPort: 70000 },
    { locationId: -1 },
  ];
  for (const over of bad) {
    assert.throws(() => routerOsScript(input(over)), RouterScriptError, JSON.stringify(over));
    assert.throws(() => genericWireguardConfig(input(over)), RouterScriptError, JSON.stringify(over));
  }
});

test('camera subnet host bits are cleared before use', () => {
  const s = routerOsScript(input({ cameraSubnet: '192.168.1.99/24' }));
  assert.match(s, /to-addresses=192\.168\.1\.0\/24 /);
});

test('nothing outside the fixed text and validated values reaches the script', () => {
  const s = routerOsScript(input({ routingTable: 'wan-2' }));
  // Only quotes from the fixed template: no stray quote can open or close a value.
  for (const line of s.split('\n')) {
    if (line.startsWith('#')) continue;
    assert.equal((line.match(/"/g) ?? []).length % 2, 0, line);
  }
  assert.doesNotMatch(s, /[\r\t\u0000]/);
});
