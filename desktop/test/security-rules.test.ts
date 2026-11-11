import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IngressRule } from '../src/lib/security-rules.ts';
import {
  HUB_TCP_PORTS,
  HUB_UDP_PORTS,
  PROTOCOL_ICMP,
  PROTOCOL_TCP,
  PROTOCOL_UDP,
  mergeEgressRules,
  mergeIngressRules,
  requiredIngressRules,
  ruleCovers,
} from '../src/lib/security-rules.ts';

const VCN = '10.0.0.0/16';

const tcp = (port: number, source = '0.0.0.0/0'): IngressRule => ({
  protocol: PROTOCOL_TCP,
  source,
  isStateless: false,
  tcpOptions: { destinationPortRange: { min: port, max: port } },
});

// What Oracle puts in a new VCN's default security list.
const ORACLE_DEFAULT: IngressRule[] = [
  tcp(22),
  { protocol: PROTOCOL_ICMP, source: '0.0.0.0/0', isStateless: false, icmpOptions: { type: 3, code: 4 } },
  { protocol: PROTOCOL_ICMP, source: VCN, isStateless: false, icmpOptions: { type: 3 } },
];

function ports(rules: IngressRule[], protocol: string): number[] {
  return rules
    .filter((r) => r.protocol === protocol)
    .map((r) => (protocol === PROTOCOL_TCP ? r.tcpOptions : r.udpOptions)?.destinationPortRange?.min ?? -1)
    .sort((a, b) => a - b);
}

test('required rules: TCP 22, 80, 443 and UDP 51820, 8189 from anywhere, plus ICMP 3/4', () => {
  const rules = requiredIngressRules(VCN);
  assert.deepEqual(HUB_TCP_PORTS, [22, 80, 443]);
  assert.deepEqual(HUB_UDP_PORTS, [51820, 8189]);
  assert.deepEqual(ports(rules, PROTOCOL_TCP), [22, 80, 443]);
  assert.deepEqual(ports(rules, PROTOCOL_UDP), [8189, 51820]);
  for (const r of rules.filter((x) => x.protocol !== PROTOCOL_ICMP)) {
    assert.equal(r.source, '0.0.0.0/0');
    assert.equal(r.isStateless, false);
    const range = (r.tcpOptions ?? r.udpOptions)!.destinationPortRange!;
    assert.equal(range.min, range.max, 'one port per rule');
  }
  assert.ok(rules.some((r) => r.protocol === PROTOCOL_ICMP && r.source === '0.0.0.0/0' && r.icmpOptions?.type === 3 && r.icmpOptions.code === 4));
});

test('merging into an empty list adds every rule', () => {
  const required = requiredIngressRules(VCN);
  const { rules, added } = mergeIngressRules([], required);
  assert.equal(added.length, required.length);
  assert.deepEqual(rules, required);
});

test("merging into Oracle's default list keeps it and adds only what is missing", () => {
  const { rules, added } = mergeIngressRules(ORACLE_DEFAULT, requiredIngressRules(VCN));
  assert.deepEqual(rules.slice(0, ORACLE_DEFAULT.length), ORACLE_DEFAULT, 'existing rules stay first and unchanged');
  assert.deepEqual(ports(added, PROTOCOL_TCP), [80, 443]);
  assert.deepEqual(ports(added, PROTOCOL_UDP), [8189, 51820]);
  assert.equal(added.filter((r) => r.protocol === PROTOCOL_ICMP).length, 0);
});

test('merging twice adds nothing the second time', () => {
  const first = mergeIngressRules(ORACLE_DEFAULT, requiredIngressRules(VCN));
  const second = mergeIngressRules(first.rules, requiredIngressRules(VCN));
  assert.equal(second.added.length, 0);
  assert.equal(second.rules.length, first.rules.length);
});

test('unrelated rules are never removed', () => {
  const custom = tcp(3389, '203.0.113.0/24');
  const { rules } = mergeIngressRules([custom], requiredIngressRules(VCN));
  assert.ok(rules.includes(custom));
});

test('coverage: wider ranges cover, other sources and limited source ports do not', () => {
  const want = tcp(443);
  assert.equal(ruleCovers({ protocol: PROTOCOL_TCP, source: '0.0.0.0/0', tcpOptions: { destinationPortRange: { min: 1, max: 1024 } } }, want), true);
  assert.equal(ruleCovers({ protocol: PROTOCOL_TCP, source: '0.0.0.0/0' }, want), true, 'no range = all ports');
  assert.equal(ruleCovers({ protocol: 'all', source: '0.0.0.0/0' }, want), true);
  assert.equal(ruleCovers(tcp(443, '198.51.100.0/24'), want), false);
  assert.equal(ruleCovers(tcp(80), want), false);
  assert.equal(
    ruleCovers({ protocol: PROTOCOL_TCP, source: '0.0.0.0/0', tcpOptions: { destinationPortRange: { min: 443, max: 443 }, sourcePortRange: { min: 1000, max: 1001 } } }, want),
    false,
  );
  // UDP is not TCP.
  assert.equal(ruleCovers({ protocol: PROTOCOL_UDP, source: '0.0.0.0/0', udpOptions: { destinationPortRange: { min: 443, max: 443 } } }, want), false);
  // ICMP: a type without a code covers every code of that type; Oracle may send null.
  const icmp34: IngressRule = { protocol: PROTOCOL_ICMP, source: '0.0.0.0/0', icmpOptions: { type: 3, code: 4 } };
  assert.equal(ruleCovers({ protocol: PROTOCOL_ICMP, source: '0.0.0.0/0', icmpOptions: { type: 3 } }, icmp34), true);
  assert.equal(ruleCovers({ protocol: PROTOCOL_ICMP, source: '0.0.0.0/0', icmpOptions: JSON.parse('{"type":3,"code":null}') }, icmp34), true);
  assert.equal(ruleCovers({ protocol: PROTOCOL_ICMP, source: '0.0.0.0/0', icmpOptions: { type: 3, code: 1 } }, icmp34), false);
});

test('egress: allow-all is added only when missing', () => {
  assert.equal(mergeEgressRules([{ protocol: 'all', destination: '0.0.0.0/0' }]).added.length, 0);
  const merged = mergeEgressRules([{ protocol: PROTOCOL_TCP, destination: '10.0.0.0/8' }]);
  assert.equal(merged.added.length, 1);
  assert.equal(merged.rules.length, 2);
  assert.deepEqual(merged.added[0], { protocol: 'all', destination: '0.0.0.0/0', destinationType: 'CIDR_BLOCK', isStateless: false });
});
