/**
 * Wire protocol between the hub and the bridge program (bridge connector).
 *
 * The bridge connects OUT to wss://<hub>/bridge and must send `hello` (with its location token) as the
 * first message within BRIDGE_HELLO_TIMEOUT_MS. The hub answers `welcome`, or closes with BRIDGE_CLOSE.badToken.
 * A newer connection for the same location replaces the older one (closed with BRIDGE_CLOSE.replaced).
 *
 * Text frames carry JSON control messages (below). Binary frames carry relayed TCP bytes:
 *   u32 BE stream id || payload
 * in either direction. Stream ids are chosen by the hub (1, 2, 3, ...) and never reused on one connection.
 *
 * Flow control: when the receiving side's TCP socket buffer for a stream grows past BRIDGE_HIGH_WATER_BYTES it
 * sends `pause`; once drained below BRIDGE_LOW_WATER_BYTES it sends `resume`. The other side stops reading that
 * stream's source while paused.
 *
 * The bridge refuses any `open` whose target fails isAllowedBridgeTarget, or beyond BRIDGE_MAX_STREAMS open
 * streams, and never writes video to disk. Detection runs on the bridge (ONVIF WS-Discovery plus a TCP scan of
 * its local /24 networks on 554 and 2020) and returns devices without `alreadyAdded` (the hub fills that in).
 */

import type { DetectedDevice } from './api-types.ts';

export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_PATH = '/bridge';
/** Ports the bridge will relay to: RTSP, ONVIF (Tapo), HTTP, alternative HTTP/ONVIF. */
export const BRIDGE_ALLOWED_PORTS: readonly number[] = [554, 2020, 80, 8000];
export const BRIDGE_MAX_STREAMS = 32;
export const BRIDGE_HELLO_TIMEOUT_MS = 10_000;
/** Hub pings every interval; either side drops the connection after BRIDGE_DEAD_AFTER_MS of silence. */
export const BRIDGE_PING_INTERVAL_MS = 20_000;
export const BRIDGE_DEAD_AFTER_MS = 60_000;
/** Bridge reconnect backoff: starts at the minimum, doubles, capped at the maximum. */
export const BRIDGE_RECONNECT_MIN_MS = 1_000;
export const BRIDGE_RECONNECT_MAX_MS = 30_000;
export const BRIDGE_DATA_HEADER_BYTES = 4;
/** Largest payload in one binary frame; larger reads are split. */
export const BRIDGE_MAX_PAYLOAD_BYTES = 256 * 1024;
export const BRIDGE_HIGH_WATER_BYTES = 4 * 1024 * 1024;
export const BRIDGE_LOW_WATER_BYTES = 1024 * 1024;
/** TCP connect timeout for `open` on the bridge. */
export const BRIDGE_OPEN_TIMEOUT_MS = 5_000;

/** WebSocket close codes. */
export const BRIDGE_CLOSE = {
  badToken: 4001,
  replaced: 4002,
  protocolError: 4003,
  helloTimeout: 4008,
  throttled: 4029,
} as const;

/** A device found by the bridge's own detection. */
export type BridgeDetectedDevice = Omit<DetectedDevice, 'alreadyAdded'>;

/* ------------------------------------------------------- bridge -> hub */

export interface BridgeHello {
  t: 'hello';
  v: number;
  token: string;
  /** Free text the owner recognises, for example the device host name. */
  name: string;
  /** Bridge program version. */
  version: string;
}
export interface BridgeOpened {
  t: 'opened';
  id: number;
}
export interface BridgeOpenFailed {
  t: 'open-failed';
  id: number;
  error: string;
}
export interface BridgeDetectResult {
  t: 'detect-result';
  reqId: number;
  devices: BridgeDetectedDevice[];
  scanned: number;
  tookMs: number;
}
export interface BridgeDetectFailed {
  t: 'detect-failed';
  reqId: number;
  error: string;
}
export interface BridgePong {
  t: 'pong';
  ts: number;
}

/* ------------------------------------------------------- hub -> bridge */

export interface HubWelcome {
  t: 'welcome';
  locationId: number;
  maxStreams: number;
}
export interface HubOpen {
  t: 'open';
  id: number;
  host: string;
  port: number;
}
export interface HubDetect {
  t: 'detect';
  reqId: number;
}
export interface HubPing {
  t: 'ping';
  ts: number;
}

/* ---------------------------------------------------------- both ways */

/** The stream ended (either side). No more data frames follow for this id. */
export interface StreamClosed {
  t: 'close';
  id: number;
}
export interface StreamPause {
  t: 'pause';
  id: number;
}
export interface StreamResume {
  t: 'resume';
  id: number;
}

export type BridgeToHub =
  | BridgeHello
  | BridgeOpened
  | BridgeOpenFailed
  | BridgeDetectResult
  | BridgeDetectFailed
  | BridgePong
  | StreamClosed
  | StreamPause
  | StreamResume;

export type HubToBridge = HubWelcome | HubOpen | HubDetect | HubPing | StreamClosed | StreamPause | StreamResume;

/* ------------------------------------------------------------ helpers */

/** Parses a dotted-quad IPv4 address strictly; null if invalid. */
export function parseIpv4(ip: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map((s) => (s.length > 1 && s.startsWith('0') ? NaN : Number(s)));
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts as [number, number, number, number];
}

/** True for RFC 1918 private IPv4 addresses (10/8, 172.16/12, 192.168/16). */
export function isPrivateIpv4(ip: string): boolean {
  const p = parseIpv4(ip);
  if (!p) return false;
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}

/** The only targets a bridge may open: private IPv4 and an allowed port. */
export function isAllowedBridgeTarget(host: string, port: number): boolean {
  return isPrivateIpv4(host) && BRIDGE_ALLOWED_PORTS.includes(port);
}

/** Builds a binary data frame. */
export function encodeDataFrame(id: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(id) || id < 1 || id > 0xffffffff) throw new Error('Invalid stream id');
  const out = new Uint8Array(BRIDGE_DATA_HEADER_BYTES + payload.length);
  new DataView(out.buffer).setUint32(0, id);
  out.set(payload, BRIDGE_DATA_HEADER_BYTES);
  return out;
}

/** Splits a binary data frame; throws if it is shorter than the header. */
export function decodeDataFrame(frame: Uint8Array): { id: number; payload: Uint8Array } {
  if (frame.length < BRIDGE_DATA_HEADER_BYTES) throw new Error('Short data frame');
  const id = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0);
  return { id, payload: frame.subarray(BRIDGE_DATA_HEADER_BYTES) };
}
