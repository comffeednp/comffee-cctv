/**
 * Pure network helpers for the connectors: IPv4 networks, router slot mapping and the strict
 * validators every value goes through before it reaches a router script or a `wg`/`ip` command.
 */

import { parseIpv4 } from '../../../shared/bridge-protocol.ts';
import { ROUTER_SLOT_MAX, ROUTER_SLOT_MIN, mappedCameraSubnet } from '../contracts.ts';

export interface Ipv4Network {
  /** Normalised network address, for example "192.168.1.0". */
  address: string;
  prefix: number;
  /** Network address as an unsigned 32-bit number. */
  base: number;
  /** "address/prefix". */
  cidr: string;
}

/** Tunnel addresses (hub 10.77.0.1, router S at 10.77.S.2). */
export const TUNNEL_NETWORK = '10.77.0.0/16';
/** Hub-side addresses that routers map onto their camera networks (10.78.S.0/24). */
export const MAPPED_NETWORK = '10.78.0.0/16';

export function ipv4ToInt(ip: string): number | null {
  const p = parseIpv4(ip);
  if (!p) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

export function intToIpv4(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function maskOf(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/**
 * Parses "a.b.c.d/p" strictly. Host bits are cleared, so "192.168.1.7/24" becomes 192.168.1.0/24.
 * Returns null for anything else (no spaces, no leading zeros, prefix 0..32).
 */
export function parseIpv4Network(text: string): Ipv4Network | null {
  if (typeof text !== 'string' || text.length > 18) return null;
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/.exec(text);
  if (!m) return null;
  const ip = ipv4ToInt(m[1]);
  if (ip === null) return null;
  if (m[2].length > 1 && m[2].startsWith('0')) return null;
  const prefix = Number(m[2]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const base = (ip & maskOf(prefix)) >>> 0;
  const address = intToIpv4(base);
  return { address, prefix, base, cidr: `${address}/${prefix}` };
}

/** Last address of a network. */
export function networkLast(net: Ipv4Network): number {
  return (net.base | (~maskOf(net.prefix) >>> 0)) >>> 0;
}

export function networkContains(net: Ipv4Network, ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return ((n & maskOf(net.prefix)) >>> 0) === net.base;
}

export function networksOverlap(a: Ipv4Network, b: Ipv4Network): boolean {
  return a.base <= networkLast(b) && b.base <= networkLast(a);
}

/** True when the whole network lies inside 10/8, 172.16/12 or 192.168/16. */
export function isPrivateNetwork(net: Ipv4Network): boolean {
  const ranges = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].map((c) => parseIpv4Network(c) as Ipv4Network);
  const last = networkLast(net);
  return ranges.some((r) => net.base >= r.base && last <= networkLast(r));
}

/** Usable host addresses (network and broadcast left out for prefixes up to /30). At most a /24. */
export function networkHosts(net: Ipv4Network): string[] {
  if (net.prefix < 24) throw new Error('Network larger than /24');
  const last = networkLast(net);
  const first = net.prefix <= 30 ? net.base + 1 : net.base;
  const end = net.prefix <= 30 ? last - 1 : last;
  const out: string[] = [];
  for (let n = first; n <= end; n++) out.push(intToIpv4(n >>> 0));
  return out;
}

export function lastOctet(ip: string): number {
  const p = parseIpv4(ip);
  if (!p) throw new Error('Invalid IPv4 address');
  return p[3];
}

export function isValidSlot(slot: unknown): slot is number {
  return typeof slot === 'number' && Number.isInteger(slot) && slot >= ROUTER_SLOT_MIN && slot <= ROUTER_SLOT_MAX;
}

/** Lowest free router slot (1..250), or null when all are taken. */
export function lowestFreeSlot(used: Iterable<number>): number | null {
  const taken = new Set(used);
  for (let s = ROUTER_SLOT_MIN; s <= ROUTER_SLOT_MAX; s++) if (!taken.has(s)) return s;
  return null;
}

/** Address the hub uses for a camera behind router slot S: 10.78.S.<last octet of lanIp>. */
export function routerMappedAddress(slot: number, lanIp: string): string {
  if (!isValidSlot(slot)) throw new Error('Invalid router slot');
  const last = lastOctet(lanIp);
  return `10.78.${slot}.${last}`;
}

/** Real LAN address for a mapped hub-side address, given the camera /24. */
export function realAddressFromMapped(cameraNet: Ipv4Network, mappedIp: string): string {
  return intToIpv4((cameraNet.base + lastOctet(mappedIp)) >>> 0);
}

/** Exactly a /24, private, and clear of the tunnel and mapped ranges (router connector). */
export function checkRouterCameraSubnet(text: string): { net: Ipv4Network } | { error: string } {
  const net = parseIpv4Network(text);
  if (!net || net.prefix !== 24) {
    return { error: 'The router connector needs the camera network as exactly a /24, for example 192.168.1.0/24.' };
  }
  if (!isPrivateNetwork(net)) return { error: 'The camera network must be a private network (10.x, 172.16-31.x or 192.168.x).' };
  const tunnel = parseIpv4Network(TUNNEL_NETWORK) as Ipv4Network;
  const mapped = parseIpv4Network(MAPPED_NETWORK) as Ipv4Network;
  if (networksOverlap(net, tunnel) || networksOverlap(net, mapped)) {
    return { error: 'The camera network must not be inside 10.77.0.0/16 or 10.78.0.0/16; those are used by the tunnel.' };
  }
  return { net };
}

/** At most a /24 (direct and bridge connectors). Bridge networks must also be private. */
export function checkSmallCameraSubnet(text: string, mustBePrivate: boolean): { net: Ipv4Network } | { error: string } {
  const net = parseIpv4Network(text);
  if (!net || net.prefix < 24) {
    return { error: 'The camera network must be an IPv4 network of at most /24, for example 192.168.1.0/24.' };
  }
  if (mustBePrivate && !isPrivateNetwork(net)) {
    return { error: 'The camera network must be a private network (10.x, 172.16-31.x or 192.168.x).' };
  }
  return { net };
}

/** WireGuard public key: 32 bytes in canonical base64 (44 characters ending in "="). */
export function isWireguardKey(key: unknown): key is string {
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(key)) return false;
  const raw = Buffer.from(key, 'base64');
  return raw.length === 32 && raw.toString('base64') === key;
}

/** RouterOS routing table name the script may reference. */
export function isRoutingTableName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(name);
}

/** Linux interface name for `wg`/`ip` arguments. */
export function isInterfaceName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9_.-]{1,15}$/.test(name) && name !== '.' && name !== '..';
}

export function isPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** Mapped network of a router slot as an Ipv4Network. */
export function mappedNetwork(slot: number): Ipv4Network {
  return parseIpv4Network(mappedCameraSubnet(slot)) as Ipv4Network;
}
