/**
 * Hub side of the bridge connector: the /bridge WebSocket, one live bridge connection per location,
 * and a local relay listener on 127.0.0.1 per bridged camera address. Bytes that MediaMTX, ffprobe or the
 * ONVIF client send to a relay listener travel as binary frames to the bridge, which opens the real TCP
 * connection at the business. Wire protocol: shared/bridge-protocol.ts.
 *
 * Sign-in: "Authorization: Bearer <token>" on the upgrade request (checked before the upgrade), or the token
 * in the first `hello` message when the header is absent. Tokens are compared by their SHA-256 hash, and
 * failed tries are throttled per IP (10 per 15 minutes, ip_failures kind 'bridge'). A valid token is
 * always accepted, also from a throttled IP, so failed tries from a shared address cannot lock out the
 * real bridge. Sockets without a valid header count as a failed try when their `hello` is missing or
 * wrong, and only a few of them may wait for `hello` at once (per IP and in total).
 */

import { createServer, type Server, type Socket } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyRequest } from 'fastify';
import {
  BRIDGE_CLOSE,
  BRIDGE_DATA_HEADER_BYTES,
  BRIDGE_DEAD_AFTER_MS,
  BRIDGE_HELLO_TIMEOUT_MS,
  BRIDGE_HIGH_WATER_BYTES,
  BRIDGE_LOW_WATER_BYTES,
  BRIDGE_MAX_PAYLOAD_BYTES,
  BRIDGE_MAX_STREAMS,
  BRIDGE_OPEN_TIMEOUT_MS,
  BRIDGE_PATH,
  BRIDGE_PING_INTERVAL_MS,
  BRIDGE_PROTOCOL_VERSION,
  decodeDataFrame,
  encodeDataFrame,
  isPrivateIpv4,
  type BridgeDetectedDevice,
  type HubToBridge,
} from '../../../shared/bridge-protocol.ts';
import type { DetectedDevice } from '../../../shared/api-types.ts';
import { HttpError, type RegisterRoutes } from '../contracts.ts';
import { isPort } from './net.ts';

export const BRIDGE_FAIL_LIMIT = 10;
export const BRIDGE_FAIL_WINDOW_MS = 15 * 60_000;
/** Sockets still waiting for a `hello` sign-in (no valid header), per IP and in total. */
export const BRIDGE_PENDING_PER_IP = 4;
export const BRIDGE_PENDING_TOTAL = 256;
export const BRIDGE_DETECT_TIMEOUT_MS = 150_000;
const RELAY_IDLE_MS = 10 * 60_000;
const MAX_RELAYS_PER_LOCATION = 64;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_DEVICES = 1024;
const TOUCH_EVERY_MS = 60_000;

/* ------------------------------------------------------------- tokens */

/** New bridge token: 32 random bytes, base64url (43 characters). Shown once; only its hash is stored. */
export function newBridgeToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashBridgeToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isBridgeTokenShape(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/* ------------------------------------------------------------ sockets */

/** The parts of a `ws` WebSocket the hub uses (also easy to fake in tests). */
export interface HubSocket {
  readonly readyState: number;
  send(data: string | Uint8Array, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'message', fn: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', fn: (code: number) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
}

const WS_OPEN = 1;

interface BridgeAuth {
  locationId: number;
  tokenHash: string;
}

interface HubStream {
  id: number;
  socket: Socket;
  relay: Relay;
  opened: boolean;
  remotePaused: boolean;
  sentPause: boolean;
  closed: boolean;
  openTimer: NodeJS.Timeout | null;
}

interface PendingDetect {
  resolve(result: BridgeDetectData): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

interface Conn {
  ws: HubSocket;
  locationId: number;
  tokenHash: string;
  name: string;
  version: string;
  streams: Map<number, HubStream>;
  nextId: number;
  nextReqId: number;
  detects: Map<number, PendingDetect>;
  /** Bytes handed to ws.send whose write has not completed yet. */
  pendingBytes: number;
  wsPaused: boolean;
  lastHeard: number;
  lastTouch: number;
  pingTimer: NodeJS.Timeout | null;
  closed: boolean;
}

interface Relay {
  locationId: number;
  lanIp: string;
  targetPort: number;
  server: Server;
  port: number;
  ready: Promise<void>;
  lastUsed: number;
  active: number;
}

export interface BridgeDetectData {
  devices: BridgeDetectedDevice[];
  scanned: number;
  tookMs: number;
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data), 'utf8');
}

function parseJson(buf: Buffer): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(buf.toString('utf8'));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 0xffffffff;
}

function cleanLabel(v: unknown): string {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64) : '';
}

function safeClose(ws: HubSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    try {
      ws.terminate();
    } catch {
      /* already gone */
    }
  }
}

function sanitizeDevice(d: unknown): BridgeDetectedDevice | null {
  if (d === null || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  if (typeof o.ip !== 'string' || !isPrivateIpv4(o.ip)) return null;
  const port = (p: unknown): number | null => (isPort(p) ? p : null);
  const vendor = o.guessVendor;
  return {
    ip: o.ip,
    rtspPort: port(o.rtspPort),
    onvifPort: port(o.onvifPort),
    rtsp: o.rtsp === true,
    onvif: o.onvif === true,
    guessVendor: vendor === 'tapo' || vendor === 'onvif' || vendor === 'custom' ? vendor : null,
  };
}

/* --------------------------------------------------------------- hub */

export class BridgeHub {
  private readonly db: DatabaseSync;
  private readonly conns = new Map<number, Conn>();
  private readonly relays = new Map<number, Map<string, Relay>>();
  /** Header-less sockets waiting for `hello`, by IP. */
  private readonly pending = new Map<string, number>();
  private pendingTotal = 0;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const conn of [...this.conns.values()]) this.dropConn(conn, 1001, 'Hub stopping');
    const closing: Promise<void>[] = [];
    for (const locationId of [...this.relays.keys()]) closing.push(this.closeRelays(locationId));
    await Promise.all(closing);
  }

  /* --------------------------------------------------- sign-in */

  lookupToken(token: unknown): BridgeAuth | null {
    if (!isBridgeTokenShape(token)) return null;
    const tokenHash = hashBridgeToken(token);
    const row = this.db
      .prepare("SELECT id FROM locations WHERE connector = 'bridge' AND bridge_token_hash = ?")
      .get(tokenHash) as { id: number } | undefined;
    return row ? { locationId: Number(row.id), tokenHash } : null;
  }

  isThrottled(ip: string): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM ip_failures WHERE ip = ? AND kind = 'bridge' AND at > ?")
      .get(ip, Date.now() - BRIDGE_FAIL_WINDOW_MS) as { n: number };
    return Number(row.n) >= BRIDGE_FAIL_LIMIT;
  }

  private stillValid(auth: BridgeAuth): boolean {
    const row = this.db
      .prepare("SELECT 1 AS x FROM locations WHERE id = ? AND connector = 'bridge' AND bridge_token_hash = ?")
      .get(auth.locationId, auth.tokenHash);
    return row !== undefined;
  }

  recordFailure(ip: string): void {
    this.db.prepare("INSERT INTO ip_failures (ip, kind, at) VALUES (?, 'bridge', ?)").run(ip, Date.now());
  }

  /** Counts a failed try unless the IP is already throttled (keeps ip_failures from growing during a flood). */
  private countFailure(ip: string): void {
    if (!this.isThrottled(ip)) this.recordFailure(ip);
  }

  /** True when one more header-less socket may wait for `hello` from this IP. */
  hasHelloSlot(ip: string): boolean {
    return (this.pending.get(ip) ?? 0) < BRIDGE_PENDING_PER_IP && this.pendingTotal < BRIDGE_PENDING_TOTAL;
  }

  /** Takes a `hello` slot for this IP and returns the function that gives it back (safe to call twice). */
  private takeHelloSlot(ip: string): () => void {
    this.pending.set(ip, (this.pending.get(ip) ?? 0) + 1);
    this.pendingTotal++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.pendingTotal--;
      const n = (this.pending.get(ip) ?? 1) - 1;
      if (n <= 0) this.pending.delete(ip);
      else this.pending.set(ip, n);
    };
  }

  /** Takes over an upgraded socket. `preAuth` is set when the Authorization header was valid. */
  accept(ws: HubSocket, ip: string, preAuth: BridgeAuth | null): void {
    ws.on('error', () => {
      /* 'close' follows */
    });
    // Without a valid header the socket signs in with `hello`; only a few may wait for it at once.
    // (The route checks this before the upgrade too; this catches upgrades that raced past that check.)
    if (!preAuth && !this.hasHelloSlot(ip)) {
      safeClose(ws, BRIDGE_CLOSE.throttled, 'Too many sign-ins in progress');
      return;
    }
    const releaseSlot = preAuth ? () => undefined : this.takeHelloSlot(ip);
    let state: 'hello' | 'live' | 'closed' = 'hello';
    let conn: Conn | null = null;
    /** Ends the hello stage without a sign-in; a header-less socket counts as a failed try. */
    const failHello = (code: number, reason: string): void => {
      state = 'closed';
      clearTimeout(helloTimer);
      releaseSlot();
      if (!preAuth) this.countFailure(ip);
      safeClose(ws, code, reason);
    };
    const helloTimer = setTimeout(() => {
      if (state !== 'hello') return;
      failHello(BRIDGE_CLOSE.helloTimeout, 'No hello');
    }, BRIDGE_HELLO_TIMEOUT_MS);
    helloTimer.unref();

    ws.on('message', (data, isBinary) => {
      if (state === 'closed') return;
      const buf = toBuffer(data);
      if (state === 'hello') {
        const msg = !isBinary && buf.length <= 4096 ? parseJson(buf) : null;
        if (!msg || msg.t !== 'hello' || msg.v !== BRIDGE_PROTOCOL_VERSION) {
          failHello(BRIDGE_CLOSE.protocolError, 'Expected hello');
          return;
        }
        // A header sign-in is checked again here, in case the token was replaced since the upgrade.
        let auth = preAuth && this.stillValid(preAuth) ? preAuth : null;
        if (preAuth && !auth) {
          failHello(BRIDGE_CLOSE.badToken, 'Token replaced');
          return;
        }
        if (!auth) {
          // A valid token is accepted even from a throttled IP; the throttle only slows failed tries.
          auth = this.lookupToken(msg.token);
          if (!auth) {
            if (this.isThrottled(ip)) failHello(BRIDGE_CLOSE.throttled, 'Too many failed tries');
            else failHello(BRIDGE_CLOSE.badToken, 'Token rejected');
            return;
          }
        }
        clearTimeout(helloTimer);
        releaseSlot();
        state = 'live';
        conn = this.register(ws, auth, cleanLabel(msg.name), cleanLabel(msg.version));
        return;
      }
      if (!conn || conn.closed) return;
      conn.lastHeard = Date.now();
      if (isBinary) this.onData(conn, buf);
      else this.onControl(conn, buf);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      releaseSlot();
      state = 'closed';
      if (conn) this.teardown(conn);
    });
  }

  private register(ws: HubSocket, auth: BridgeAuth, name: string, version: string): Conn {
    const old = this.conns.get(auth.locationId);
    if (old) this.dropConn(old, BRIDGE_CLOSE.replaced, 'Replaced by a newer connection');
    const now = Date.now();
    const conn: Conn = {
      ws,
      locationId: auth.locationId,
      tokenHash: auth.tokenHash,
      name,
      version,
      streams: new Map(),
      nextId: 1,
      nextReqId: 1,
      detects: new Map(),
      pendingBytes: 0,
      wsPaused: false,
      lastHeard: now,
      lastTouch: 0,
      pingTimer: null,
      closed: false,
    };
    this.conns.set(auth.locationId, conn);
    conn.pingTimer = setInterval(() => this.tick(conn), BRIDGE_PING_INTERVAL_MS);
    conn.pingTimer.unref();
    this.sendJson(conn, { t: 'welcome', locationId: auth.locationId, maxStreams: BRIDGE_MAX_STREAMS });
    this.touch(conn);
    return conn;
  }

  private tick(conn: Conn): void {
    if (conn.closed) return;
    if (Date.now() - conn.lastHeard > BRIDGE_DEAD_AFTER_MS) {
      try {
        conn.ws.terminate();
      } catch {
        /* ignore */
      }
      this.teardown(conn);
      return;
    }
    this.sendJson(conn, { t: 'ping', ts: Date.now() });
    if (Date.now() - conn.lastTouch >= TOUCH_EVERY_MS) this.touch(conn);
  }

  private touch(conn: Conn): void {
    conn.lastTouch = Date.now();
    try {
      this.db.prepare('UPDATE locations SET last_seen_at = ? WHERE id = ?').run(conn.lastTouch, conn.locationId);
    } catch {
      /* the location may be gone */
    }
  }

  /** Ends a connection's state (idempotent): streams, pending detections, timers, last seen. */
  private teardown(conn: Conn): void {
    if (conn.closed) return;
    conn.closed = true;
    if (conn.pingTimer) clearInterval(conn.pingTimer);
    for (const st of [...conn.streams.values()]) this.finishStream(conn, st, 'destroy');
    for (const p of conn.detects.values()) {
      clearTimeout(p.timer);
      p.reject(new HttpError(503, 'unavailable', 'The bridge disconnected during detection.'));
    }
    conn.detects.clear();
    if (this.conns.get(conn.locationId) === conn) {
      this.conns.delete(conn.locationId);
      this.touch(conn);
    }
  }

  private dropConn(conn: Conn, code: number, reason: string): void {
    this.teardown(conn);
    safeClose(conn.ws, code, reason);
  }

  /** Closes the live bridge of a location, if any. */
  disconnect(locationId: number, code: number = BRIDGE_CLOSE.badToken, reason = 'Disconnected by the hub'): void {
    const conn = this.conns.get(locationId);
    if (conn) this.dropConn(conn, code, reason);
  }

  /** After a location changed or was deleted: drops a bridge whose token or connector no longer matches. */
  async locationChanged(locationId: number): Promise<void> {
    const row = this.db
      .prepare('SELECT connector, bridge_token_hash FROM locations WHERE id = ?')
      .get(locationId) as { connector: string; bridge_token_hash: string | null } | undefined;
    if (!row || row.connector !== 'bridge') {
      this.disconnect(locationId, BRIDGE_CLOSE.badToken, 'This location no longer uses a bridge');
      await this.closeRelays(locationId);
      return;
    }
    const conn = this.conns.get(locationId);
    if (conn && conn.tokenHash !== row.bridge_token_hash) this.dropConn(conn, BRIDGE_CLOSE.badToken, 'Token replaced');
  }

  status(locationId: number): { online: boolean; lastSeen: number | null } {
    if (this.conns.has(locationId)) return { online: true, lastSeen: Date.now() };
    const row = this.db.prepare('SELECT last_seen_at FROM locations WHERE id = ?').get(locationId) as
      | { last_seen_at: number | null }
      | undefined;
    return { online: false, lastSeen: row?.last_seen_at != null ? Number(row.last_seen_at) : null };
  }

  isConnected(locationId: number): boolean {
    return this.conns.has(locationId);
  }

  /* ------------------------------------------------- messages */

  private sendJson(conn: Conn, msg: HubToBridge): void {
    if (conn.closed || conn.ws.readyState !== WS_OPEN) return;
    const text = JSON.stringify(msg);
    this.sendRaw(conn, text, Buffer.byteLength(text));
  }

  private sendRaw(conn: Conn, data: string | Uint8Array, size: number): void {
    conn.pendingBytes += size;
    try {
      conn.ws.send(data, () => {
        conn.pendingBytes -= size;
        if (conn.wsPaused && conn.pendingBytes < BRIDGE_LOW_WATER_BYTES) {
          conn.wsPaused = false;
          for (const st of conn.streams.values()) if (st.opened && !st.remotePaused && !st.closed) st.socket.resume();
        }
      });
    } catch {
      conn.pendingBytes -= size;
      return;
    }
    if (!conn.wsPaused && conn.pendingBytes > BRIDGE_HIGH_WATER_BYTES) {
      conn.wsPaused = true;
      for (const st of conn.streams.values()) st.socket.pause();
    }
  }

  private onControl(conn: Conn, buf: Buffer): void {
    const msg = buf.length <= MAX_TEXT_BYTES ? parseJson(buf) : null;
    if (!msg || typeof msg.t !== 'string') {
      this.dropConn(conn, BRIDGE_CLOSE.protocolError, 'Bad control message');
      return;
    }
    switch (msg.t) {
      case 'opened': {
        const st = isId(msg.id) ? conn.streams.get(msg.id) : undefined;
        if (!st || st.opened) return;
        st.opened = true;
        if (st.openTimer) clearTimeout(st.openTimer);
        st.openTimer = null;
        if (!conn.wsPaused && !st.remotePaused) st.socket.resume();
        return;
      }
      case 'open-failed': {
        const st = isId(msg.id) ? conn.streams.get(msg.id) : undefined;
        if (st) this.finishStream(conn, st, 'destroy');
        return;
      }
      case 'close': {
        const st = isId(msg.id) ? conn.streams.get(msg.id) : undefined;
        if (st) this.finishStream(conn, st, 'end');
        return;
      }
      case 'pause': {
        const st = isId(msg.id) ? conn.streams.get(msg.id) : undefined;
        if (!st) return;
        st.remotePaused = true;
        st.socket.pause();
        return;
      }
      case 'resume': {
        const st = isId(msg.id) ? conn.streams.get(msg.id) : undefined;
        if (!st) return;
        st.remotePaused = false;
        if (!conn.wsPaused && st.opened) st.socket.resume();
        return;
      }
      case 'detect-result':
      case 'detect-failed': {
        const p = isId(msg.reqId) ? conn.detects.get(msg.reqId) : undefined;
        if (!p) return;
        conn.detects.delete(msg.reqId as number);
        clearTimeout(p.timer);
        if (msg.t === 'detect-failed') {
          p.reject(new HttpError(503, 'unavailable', `The bridge could not run detection: ${cleanLabel(msg.error)}`));
          return;
        }
        const list = Array.isArray(msg.devices) ? msg.devices.slice(0, MAX_DEVICES) : [];
        const devices = list.map(sanitizeDevice).filter((d): d is BridgeDetectedDevice => d !== null);
        const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
        p.resolve({ devices, scanned: num(msg.scanned), tookMs: num(msg.tookMs) });
        return;
      }
      default:
        // 'pong' and unknown types only refresh lastHeard.
        return;
    }
  }

  private onData(conn: Conn, buf: Buffer): void {
    if (buf.length < BRIDGE_DATA_HEADER_BYTES || buf.length > BRIDGE_DATA_HEADER_BYTES + BRIDGE_MAX_PAYLOAD_BYTES) {
      this.dropConn(conn, BRIDGE_CLOSE.protocolError, 'Bad data frame');
      return;
    }
    const { id, payload } = decodeDataFrame(buf);
    const st = conn.streams.get(id);
    if (!st || st.closed || !st.opened) return;
    st.socket.write(payload);
    if (!st.sentPause && st.socket.writableLength > BRIDGE_HIGH_WATER_BYTES) {
      st.sentPause = true;
      this.sendJson(conn, { t: 'pause', id });
    }
  }

  /* --------------------------------------------------- streams */

  private onRelayClient(relay: Relay, socket: Socket): void {
    relay.lastUsed = Date.now();
    const conn = this.conns.get(relay.locationId);
    if (!conn || conn.closed || conn.streams.size >= BRIDGE_MAX_STREAMS) {
      socket.destroy();
      return;
    }
    const id = conn.nextId++;
    const st: HubStream = {
      id,
      socket,
      relay,
      opened: false,
      remotePaused: false,
      sentPause: false,
      closed: false,
      openTimer: null,
    };
    conn.streams.set(id, st);
    relay.active++;
    socket.setNoDelay(true);
    st.openTimer = setTimeout(() => this.finishStream(conn, st, 'notify'), BRIDGE_OPEN_TIMEOUT_MS + 5_000);
    st.openTimer.unref();
    socket.on('data', (chunk: Buffer) => {
      if (st.closed) return;
      for (let off = 0; off < chunk.length; off += BRIDGE_MAX_PAYLOAD_BYTES) {
        const frame = encodeDataFrame(id, chunk.subarray(off, off + BRIDGE_MAX_PAYLOAD_BYTES));
        this.sendRaw(conn, frame, frame.length);
      }
    });
    socket.on('drain', () => {
      if (st.sentPause && !st.closed) {
        st.sentPause = false;
        this.sendJson(conn, { t: 'resume', id });
      }
    });
    socket.on('error', () => {
      /* 'close' follows */
    });
    socket.on('close', () => this.finishStream(conn, st, 'notify'));
    this.sendJson(conn, { t: 'open', id, host: relay.lanIp, port: relay.targetPort });
  }

  /**
   * Ends a stream once. 'notify': the local side ended, tell the bridge. 'end': the bridge ended it, flush
   * what is queued and close. 'destroy': drop at once without telling the bridge.
   */
  private finishStream(conn: Conn, st: HubStream, how: 'notify' | 'end' | 'destroy'): void {
    if (st.closed) return;
    st.closed = true;
    if (st.openTimer) clearTimeout(st.openTimer);
    conn.streams.delete(st.id);
    st.relay.active = Math.max(0, st.relay.active - 1);
    st.relay.lastUsed = Date.now();
    if (how === 'notify') this.sendJson(conn, { t: 'close', id: st.id });
    if (how === 'end' && !st.socket.destroyed) {
      st.socket.resume();
      st.socket.end(() => st.socket.destroy());
      setTimeout(() => st.socket.destroy(), 5_000).unref();
    } else {
      st.socket.destroy();
    }
  }

  /* ---------------------------------------------------- relays */

  /**
   * Local relay address for a camera address behind this location's bridge. The listener is kept for as
   * long as a camera uses it, so its port stays stable while the bridge reconnects.
   */
  async relayAddress(locationId: number, lanIp: string, port: number): Promise<{ host: string; port: number }> {
    let byKey = this.relays.get(locationId);
    if (!byKey) {
      byKey = new Map();
      this.relays.set(locationId, byKey);
    }
    const key = `${lanIp}:${port}`;
    let relay = byKey.get(key);
    if (!relay) {
      if (byKey.size >= MAX_RELAYS_PER_LOCATION && !(await this.evictOne(locationId, byKey))) {
        throw new HttpError(503, 'unavailable', 'Too many camera addresses are open for this location.');
      }
      relay = this.createRelay(locationId, lanIp, port);
      byKey.set(key, relay);
    }
    relay.lastUsed = Date.now();
    try {
      await relay.ready;
    } catch {
      byKey.delete(key);
      throw new HttpError(503, 'unavailable', 'Could not open a local relay for this camera.');
    }
    return { host: '127.0.0.1', port: relay.port };
  }

  private createRelay(locationId: number, lanIp: string, targetPort: number): Relay {
    const relay: Relay = {
      locationId,
      lanIp,
      targetPort,
      server: createServer({ pauseOnConnect: true }, (sock) => this.onRelayClient(relay, sock)),
      port: 0,
      ready: Promise.resolve(),
      lastUsed: Date.now(),
      active: 0,
    };
    relay.server.maxConnections = BRIDGE_MAX_STREAMS;
    relay.ready = new Promise<void>((resolve, reject) => {
      relay.server.once('error', reject);
      relay.server.listen(0, '127.0.0.1', () => {
        relay.server.off('error', reject);
        relay.server.on('error', () => undefined);
        const addr = relay.server.address();
        relay.port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
    relay.server.unref();
    return relay;
  }

  private cameraUses(locationId: number, lanIp: string, port: number): boolean {
    const row = this.db
      .prepare('SELECT 1 AS x FROM cameras WHERE location_id = ? AND lan_ip = ? AND (rtsp_port = ? OR onvif_port = ?) LIMIT 1')
      .get(locationId, lanIp, port, port);
    return row !== undefined;
  }

  private async evictOne(locationId: number, byKey: Map<string, Relay>): Promise<boolean> {
    let victim: [string, Relay] | null = null;
    for (const entry of byKey) {
      const r = entry[1];
      if (r.active > 0 || this.cameraUses(locationId, r.lanIp, r.targetPort)) continue;
      if (!victim || r.lastUsed < victim[1].lastUsed) victim = entry;
    }
    if (!victim) return false;
    byKey.delete(victim[0]);
    await new Promise<void>((resolve) => victim[1].server.close(() => resolve()));
    return true;
  }

  async closeRelays(locationId: number): Promise<void> {
    const byKey = this.relays.get(locationId);
    if (!byKey) return;
    this.relays.delete(locationId);
    await Promise.all([...byKey.values()].map((r) => new Promise<void>((resolve) => r.server.close(() => resolve()))));
  }

  private sweep(): void {
    const now = Date.now();
    for (const [locationId, byKey] of this.relays) {
      for (const [key, r] of byKey) {
        if (r.active > 0 || now - r.lastUsed < RELAY_IDLE_MS) continue;
        if (this.cameraUses(locationId, r.lanIp, r.targetPort)) continue;
        byKey.delete(key);
        r.server.close();
      }
    }
    try {
      this.db.prepare("DELETE FROM ip_failures WHERE kind = 'bridge' AND at < ?").run(now - 24 * 3600_000);
    } catch {
      /* ignore */
    }
  }

  /* -------------------------------------------------- detection */

  /** Asks the location's bridge to run detection. Devices come back without alreadyAdded. */
  detect(locationId: number): Promise<BridgeDetectData> {
    const conn = this.conns.get(locationId);
    if (!conn || conn.closed) {
      return Promise.reject(new HttpError(503, 'unavailable', 'The bridge for this location is not connected.'));
    }
    const reqId = conn.nextReqId++;
    return new Promise<BridgeDetectData>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.detects.delete(reqId);
        reject(new HttpError(503, 'unavailable', 'The bridge did not finish detection in time.'));
      }, BRIDGE_DETECT_TIMEOUT_MS);
      timer.unref();
      conn.detects.set(reqId, { resolve, reject, timer });
      this.sendJson(conn, { t: 'detect', reqId });
    });
  }
}

/* --------------------------------------------- service registration */

const hubs = new WeakMap<object, BridgeHub>();

/** Links a connector service to its bridge hub (done by createConnectorService). */
export function attachBridgeHub(service: object, hub: BridgeHub): void {
  hubs.set(service, hub);
}

export function bridgeHubOf(service: object): BridgeHub {
  const hub = hubs.get(service);
  if (!hub) throw new Error('The connector service was not made by createConnectorService');
  return hub;
}

/** Fills alreadyAdded from the cameras of the location. */
export function markAlreadyAdded(
  db: DatabaseSync,
  locationId: number,
  devices: BridgeDetectedDevice[],
): DetectedDevice[] {
  const rows = db.prepare('SELECT lan_ip, rtsp_port FROM cameras WHERE location_id = ?').all(locationId) as Array<{
    lan_ip: string;
    rtsp_port: number;
  }>;
  const added = new Set(rows.map((r) => `${r.lan_ip}:${Number(r.rtsp_port)}`));
  return devices.map((d) => ({ ...d, alreadyAdded: added.has(`${d.ip}:${d.rtspPort ?? 554}`) }));
}

const preAuth = new WeakMap<object, BridgeAuth>();

/** GET /bridge (WebSocket). Needs @fastify/websocket registered on the app. */
export const registerBridgeSocket: RegisterRoutes = (app, deps) => {
  const hub = bridgeHubOf(deps.connectors);
  app.get(
    BRIDGE_PATH,
    {
      websocket: true,
      preValidation: async (req: FastifyRequest) => {
        const header = req.headers.authorization;
        const m = header === undefined ? null : /^Bearer ([A-Za-z0-9_-]{1,200})$/.exec(header);
        const auth = m ? hub.lookupToken(m[1]) : null;
        // A valid token always gets in, so failed tries from a shared address cannot lock out the real bridge.
        if (auth) {
          preAuth.set(req, auth);
          return;
        }
        if (hub.isThrottled(req.ip)) {
          throw new HttpError(429, 'throttled', 'Too many failed bridge sign-ins from this address. Try again later.');
        }
        if (header !== undefined) {
          hub.recordFailure(req.ip);
          throw new HttpError(401, 'wrong_credentials', 'Bridge token rejected.');
        }
        // No header: the socket signs in with `hello`, and only a few may wait for it at once.
        if (!hub.hasHelloSlot(req.ip)) {
          throw new HttpError(429, 'throttled', 'Too many bridge sign-ins in progress. Try again later.');
        }
      },
    },
    (socket: HubSocket, req: FastifyRequest) => {
      hub.accept(socket, req.ip, preAuth.get(req) ?? null);
    },
  );
};
