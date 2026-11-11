import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkRouterCameraSubnet,
  checkSmallCameraSubnet,
  isInterfaceName,
  isRoutingTableName,
  isWireguardKey,
  lowestFreeSlot,
  networkHosts,
  parseIpv4Network,
  realAddressFromMapped,
  routerMappedAddress,
} from '../../src/sites/net.ts';
import { mappedCameraSubnet, routerTunnelIp } from '../../src/contracts.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');

test('router slot mapping: tunnel address, mapped subnet and camera address', () => {
  assert.equal(routerTunnelIp(5), '10.77.5.2');
  assert.equal(mappedCameraSubnet(5), '10.78.5.0/24');
  assert.equal(routerMappedAddress(5, '192.168.1.64'), '10.78.5.64');
  assert.equal(routerMappedAddress(250, '172.16.9.1'), '10.78.250.1');
  const net = parseIpv4Network('192.168.1.0/24');
  assert.ok(net);
  assert.equal(realAddressFromMapped(net, '10.78.5.64'), '192.168.1.64');
  assert.throws(() => routerMappedAddress(0, '192.168.1.5'));
  assert.throws(() => routerMappedAddress(251, '192.168.1.5'));
  assert.throws(() => routerMappedAddress(3, '192.168.1.256'));
});

test('lowest free slot from 1 to 250', () => {
  assert.equal(lowestFreeSlot([]), 1);
  assert.equal(lowestFreeSlot([1, 2, 4]), 3);
  assert.equal(lowestFreeSlot([2, 3]), 1);
  const all = Array.from({ length: 250 }, (_, i) => i + 1);
  assert.equal(lowestFreeSlot(all), null);
  assert.equal(lowestFreeSlot(all.filter((s) => s !== 250)), 250);
});

test('network parsing is strict and normalises host bits', () => {
  assert.equal(parseIpv4Network('192.168.1.77/24')?.cidr, '192.168.1.0/24');
  assert.equal(parseIpv4Network('10.0.0.0/8')?.prefix, 8);
  for (const bad of ['192.168.1.0', '192.168.1.0/33', '192.168.01.0/24', '192.168.1.0/024', ' 192.168.1.0/24', '1.2.3.4/24\n', 'a.b.c.d/24']) {
    assert.equal(parseIpv4Network(bad), null, bad);
  }
});

test('router camera network must be exactly a private /24 outside the tunnel ranges', () => {
  assert.deepEqual(checkRouterCameraSubnet('192.168.1.5/24'), { net: parseIpv4Network('192.168.1.0/24') });
  assert.ok('error' in checkRouterCameraSubnet('192.168.0.0/23'));
  assert.ok('error' in checkRouterCameraSubnet('192.168.1.0/25'));
  assert.ok('error' in checkRouterCameraSubnet('8.8.8.0/24'));
  assert.ok('error' in checkRouterCameraSubnet('10.77.3.0/24'));
  assert.ok('error' in checkRouterCameraSubnet('10.78.0.0/24'));
  assert.ok('net' in checkRouterCameraSubnet('10.79.0.0/24'));
});

test('direct networks may be smaller than /24, bridge networks must be private', () => {
  assert.ok('net' in checkSmallCameraSubnet('192.168.1.16/28', true));
  assert.ok('error' in checkSmallCameraSubnet('192.168.0.0/16', false));
  assert.ok('error' in checkSmallCameraSubnet('8.8.8.0/24', true));
  assert.ok('net' in checkSmallCameraSubnet('8.8.8.0/24', false));
});

test('host lists leave out network and broadcast addresses', () => {
  const hosts = networkHosts(parseIpv4Network('192.168.1.0/24')!);
  assert.equal(hosts.length, 254);
  assert.equal(hosts[0], '192.168.1.1');
  assert.equal(hosts[253], '192.168.1.254');
  assert.deepEqual(networkHosts(parseIpv4Network('192.168.1.8/30')!), ['192.168.1.9', '192.168.1.10']);
  assert.deepEqual(networkHosts(parseIpv4Network('192.168.1.8/32')!), ['192.168.1.8']);
  assert.throws(() => networkHosts(parseIpv4Network('192.168.0.0/23')!));
});

test('validators for keys, routing tables and interface names', () => {
  assert.equal(KEY.length, 44);
  assert.equal(isWireguardKey(KEY), true);
  assert.equal(isWireguardKey(KEY.slice(0, 43) + '"'), false);
  assert.equal(isWireguardKey(`${KEY.slice(0, 42)}B=`), false, 'non-canonical last character');
  assert.equal(isWireguardKey(`${KEY}\n`), false);
  assert.equal(isRoutingTableName('isp2_backup-1'), true);
  assert.equal(isRoutingTableName('a'.repeat(33)), false);
  assert.equal(isRoutingTableName('isp2"; /system reset-configuration'), false);
  assert.equal(isRoutingTableName(''), false);
  assert.equal(isInterfaceName('wg0'), true);
  assert.equal(isInterfaceName('wg0; rm -rf /'), false);
  assert.equal(isInterfaceName('-x'), true, 'arguments go as an array, so a dash cannot become a shell option');
});
