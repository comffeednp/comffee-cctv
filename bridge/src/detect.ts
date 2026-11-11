/**
 * Camera detection on the bridge: an ONVIF WS-Discovery multicast probe on each local network, plus a
 * TCP scan of every local private /24 on ports 554 and 2020 (probes shared with the hub).
 */

import { createSocket } from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { isPrivateIpv4, parseIpv4 } from '../../shared/bridge-protocol.ts';
import { scanTargets, type ProbeTarget } from '../../server/src/sites/probe.ts';
import { xmlElementText } from '../../server/src/sites/onvif.ts';
import type { DetectionResult } from './session.ts';

const WS_DISCOVERY_ADDRESS = '239.255.255.250';
const WS_DISCOVERY_PORT = 3702;
const WS_DISCOVERY_WAIT_MS = 3000;
/** At most this many local /24 networks are scanned (virtual adapters can add many). */
export const MAX_SCAN_NETWORKS = 6;

/** Local private IPv4 addresses of this device, with the /24 each one sits in. */
export function localNetworks(
  ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): Array<{ address: string; prefix24: string }> {
  const out: Array<{ address: string; prefix24: string }> = [];
  const seen = new Set<string>();
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal || !isPrivateIpv4(info.address)) continue;
      const p = parseIpv4(info.address);
      if (!p) continue;
      const prefix24 = `${p[0]}.${p[1]}.${p[2]}`;
      if (seen.has(prefix24)) continue;
      seen.add(prefix24);
      out.push({ address: info.address, prefix24 });
    }
  }
  // Typical camera networks first.
  const rank = (a: string): number => (a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : 2);
  return out.sort((a, b) => rank(a.address) - rank(b.address)).slice(0, MAX_SCAN_NETWORKS);
}

export function wsDiscoveryProbe(messageId: string = randomUUID()): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"' +
    ' xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"' +
    ' xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"' +
    ' xmlns:dn="http://www.onvif.org/ver10/network/wsdl">' +
    '<e:Header>' +
    `<w:MessageID>uuid:${messageId}</w:MessageID>` +
    '<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>' +
    '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>' +
    '</e:Header>' +
    '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body>' +
    '</e:Envelope>'
  );
}

/** ONVIF service addresses from a ProbeMatches reply: private IPv4 host -> port. */
export function parseProbeMatch(xml: string, from: string): Map<string, number> {
  const found = new Map<string, number>();
  const xaddrs = xmlElementText(xml, 'XAddrs');
  if (!xaddrs) return found;
  for (const part of xaddrs.split(/\s+/)) {
    let url: URL;
    try {
      url = new URL(part);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' || !isPrivateIpv4(url.hostname)) continue;
    const port = url.port === '' ? 80 : Number(url.port);
    if (!found.has(url.hostname)) found.set(url.hostname, port);
  }
  // Prefer the address the reply actually came from.
  if (found.has(from)) return new Map([[from, found.get(from) as number]]);
  return found;
}

/** Sends one WS-Discovery probe out of each local address and collects replies for a few seconds. */
export async function wsDiscovery(localAddresses: string[], waitMs = WS_DISCOVERY_WAIT_MS): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  const probe = Buffer.from(wsDiscoveryProbe(), 'utf8');
  await Promise.all(
    localAddresses.map(
      (address) =>
        new Promise<void>((resolve) => {
          const sock = createSocket({ type: 'udp4', reuseAddr: true });
          const done = (): void => {
            try {
              sock.close();
            } catch {
              /* already closed */
            }
            resolve();
          };
          const timer = setTimeout(done, waitMs);
          sock.on('error', () => {
            clearTimeout(timer);
            done();
          });
          sock.on('message', (msg, rinfo) => {
            if (msg.length > 64 * 1024 || !isPrivateIpv4(rinfo.address)) return;
            for (const [ip, port] of parseProbeMatch(msg.toString('utf8'), rinfo.address)) {
              if (!found.has(ip)) found.set(ip, port);
            }
          });
          sock.bind(0, address, () => {
            try {
              sock.setMulticastInterface(address);
              sock.setMulticastTTL(1);
              sock.send(probe, WS_DISCOVERY_PORT, WS_DISCOVERY_ADDRESS);
            } catch {
              clearTimeout(timer);
              done();
            }
          });
        }),
    ),
  );
  return found;
}

/** Full detection run: WS-Discovery first, then the TCP scan of the local /24 networks. */
export async function runDetection(): Promise<DetectionResult> {
  const started = Date.now();
  const nets = localNetworks();
  const discovered = await wsDiscovery(nets.map((n) => n.address));
  const targets = new Map<string, ProbeTarget>();
  for (const n of nets) {
    for (let h = 1; h <= 254; h++) {
      const ip = `${n.prefix24}.${h}`;
      targets.set(ip, { probeHost: ip, ip });
    }
  }
  for (const [ip, port] of discovered) {
    const t = targets.get(ip) ?? { probeHost: ip, ip };
    targets.set(ip, { ...t, onvifPort: port });
  }
  const list = [...targets.values()];
  const devices = await scanTargets(list);
  return { devices, scanned: list.length, tookMs: Date.now() - started };
}
