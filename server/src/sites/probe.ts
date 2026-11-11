/**
 * Camera detection probes, shared by the hub (router and direct connectors) and the bridge program.
 * TCP connect to 554 and 2020 (800 ms timeout, 32 at a time), then RTSP OPTIONS on 554 and an
 * unauthenticated ONVIF GetSystemDateAndTime on the ONVIF port.
 */

import { connect } from 'node:net';
import type { BridgeDetectedDevice } from '../../../shared/bridge-protocol.ts';
import { onvifProbe } from './onvif.ts';

export const DETECT_PORTS = { rtsp: 554, onvif: 2020 } as const;
export const TCP_PROBE_TIMEOUT_MS = 800;
export const PROBE_CONCURRENCY = 32;
const RTSP_TIMEOUT_MS = 2000;

export interface ProbeTarget {
  /** Address the probe connects to (10.78.S.x through a router tunnel, or the LAN IP itself). */
  probeHost: string;
  /** Real LAN IP reported back to the owner. */
  ip: string;
  /** Extra ONVIF port learned elsewhere (for example from WS-Discovery). */
  onvifPort?: number;
}

/** Runs fn over items with at most `limit` running at once; results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** True when a TCP connection opens within the timeout. */
export function tcpOpen(host: string, port: number, timeoutMs = TCP_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

/** Sends "OPTIONS rtsp://ip:port/ RTSP/1.0" and expects a reply starting with "RTSP/1.0". */
export function rtspOptions(host: string, port: number, urlIp: string, timeoutMs = RTSP_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    let done = false;
    let got = '';
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.once('connect', () => {
      sock.write(`OPTIONS rtsp://${urlIp}:${port}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: comffee-cctv\r\n\r\n`);
    });
    sock.on('data', (chunk: Buffer) => {
      got += chunk.toString('latin1');
      if (got.length >= 8) finish(got.startsWith('RTSP/1.0'));
    });
    sock.once('error', () => finish(false));
    sock.once('close', () => finish(got.startsWith('RTSP/1.0')));
  });
}

/** Vendor guess from what answered. Tapo: ONVIF on 2020 plus RTSP on 554. */
export function guessVendor(d: Pick<BridgeDetectedDevice, 'rtsp' | 'onvif' | 'rtspPort' | 'onvifPort'>): BridgeDetectedDevice['guessVendor'] {
  if (d.onvif && d.onvifPort === DETECT_PORTS.onvif && d.rtsp && d.rtspPort === DETECT_PORTS.rtsp) return 'tapo';
  if (d.onvif) return 'onvif';
  if (d.rtsp) return 'custom';
  return null;
}

/** Probes one host fully; null when nothing answered. */
export async function probeHost(t: ProbeTarget): Promise<BridgeDetectedDevice | null> {
  const [rtspOpen, onvifOpen] = await Promise.all([
    tcpOpen(t.probeHost, DETECT_PORTS.rtsp),
    tcpOpen(t.probeHost, DETECT_PORTS.onvif),
  ]);
  let onvifPort: number | null = onvifOpen ? DETECT_PORTS.onvif : null;
  if (onvifPort === null && t.onvifPort !== undefined) onvifPort = t.onvifPort;
  if (!rtspOpen && onvifPort === null) return null;
  const [rtsp, onvif] = await Promise.all([
    rtspOpen ? rtspOptions(t.probeHost, DETECT_PORTS.rtsp, t.ip) : Promise.resolve(false),
    onvifPort !== null
      ? onvifProbe({ host: t.probeHost, port: onvifPort, hostHeader: `${t.ip}:${onvifPort}` }).then((r) => r.onvif)
      : Promise.resolve(false),
  ]);
  const device = {
    ip: t.ip,
    rtspPort: rtspOpen ? DETECT_PORTS.rtsp : null,
    onvifPort,
    rtsp,
    onvif: onvif || t.onvifPort !== undefined,
  };
  return { ...device, guessVendor: guessVendor(device) };
}

/**
 * Scans hosts on 554 and 2020. The TCP connects run PROBE_CONCURRENCY at a time (each host opens two
 * sockets, so hosts run half that many at once). Devices come back sorted by IP.
 */
export async function scanTargets(targets: readonly ProbeTarget[]): Promise<BridgeDetectedDevice[]> {
  const found = await mapLimit(targets, Math.max(1, PROBE_CONCURRENCY / 2), probeHost);
  return sortDevices(found.filter((d): d is BridgeDetectedDevice => d !== null));
}

export function sortDevices<T extends { ip: string }>(devices: T[]): T[] {
  const key = (ip: string): number => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
  return devices.sort((a, b) => key(a.ip) - key(b.ip));
}
