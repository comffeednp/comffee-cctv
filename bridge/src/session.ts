/**
 * One hub connection's relay state on the bridge: opens TCP connections the hub asks for (only to allowed
 * targets), moves bytes both ways as binary frames with flow control, answers pings and detection
 * requests. Nothing is ever written to disk. Independent of the WebSocket implementation, so tests can
 * drive it directly.
 */

import { connect, type Socket } from 'node:net';
import {
  BRIDGE_CLOSE,
  BRIDGE_DATA_HEADER_BYTES,
  BRIDGE_HIGH_WATER_BYTES,
  BRIDGE_LOW_WATER_BYTES,
  BRIDGE_MAX_PAYLOAD_BYTES,
  BRIDGE_MAX_STREAMS,
  BRIDGE_OPEN_TIMEOUT_MS,
  decodeDataFrame,
  encodeDataFrame,
  isAllowedBridgeTarget,
  type BridgeDetectedDevice,
  type BridgeToHub,
} from '../../shared/bridge-protocol.ts';

export interface SessionIo {
  sendText(text: string): void;
  sendBinary(data: Uint8Array): void;
  /** Bytes queued on the WebSocket and not yet sent. */
  bufferedAmount(): number;
  close(code: number, reason: string): void;
}

export interface DetectionResult {
  devices: BridgeDetectedDevice[];
  scanned: number;
  tookMs: number;
}

export interface SessionOptions {
  detect?: () => Promise<DetectionResult>;
  /** Tests only: replaces the allow-list check (the real bridge always uses isAllowedBridgeTarget). */
  isAllowed?: (host: string, port: number) => boolean;
  connect?: (host: string, port: number) => Socket;
  log?: (message: string) => void;
}

/**
 * The bridge's own gate for an `open` request: an RFC 1918 IPv4 address, port 554, 2020, 80 or 8000,
 * and fewer than BRIDGE_MAX_STREAMS streams already open. Returns the refusal reason, or null if allowed.
 */
export function checkOpen(
  host: unknown,
  port: unknown,
  openStreams: number,
  isAllowed: (host: string, port: number) => boolean = isAllowedBridgeTarget,
): string | null {
  if (typeof host !== 'string' || typeof port !== 'number' || !Number.isInteger(port)) return 'Bad target';
  if (!isAllowed(host, port)) return 'Target not allowed: only private IPv4 addresses on ports 554, 2020, 80 and 8000';
  if (openStreams >= BRIDGE_MAX_STREAMS) return `Too many streams (at most ${BRIDGE_MAX_STREAMS})`;
  return null;
}

interface Stream {
  id: number;
  socket: Socket;
  connected: boolean;
  remotePaused: boolean;
  sentPause: boolean;
  closed: boolean;
  timer: NodeJS.Timeout | null;
}

function isId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 0xffffffff;
}

export class BridgeSession {
  private readonly io: SessionIo;
  private readonly opts: SessionOptions;
  private readonly streams = new Map<number, Stream>();
  /** Ids the hub has used on this connection; never reused. */
  private readonly seen = new Set<number>();
  private wsPaused = false;
  private drainTimer: NodeJS.Timeout | null = null;
  private detecting = false;
  private ended = false;

  constructor(io: SessionIo, opts: SessionOptions = {}) {
    this.io = io;
    this.opts = opts;
  }

  get streamCount(): number {
    return this.streams.size;
  }

  private send(msg: BridgeToHub): void {
    if (!this.ended) this.io.sendText(JSON.stringify(msg));
  }

  handleText(text: string): void {
    if (this.ended || text.length > 64 * 1024) return;
    let msg: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(text);
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return;
      msg = v as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'open':
        this.open(msg.id, msg.host, msg.port);
        return;
      case 'close': {
        const st = isId(msg.id) ? this.streams.get(msg.id) : undefined;
        if (st) this.finish(st, 'end');
        return;
      }
      case 'pause': {
        const st = isId(msg.id) ? this.streams.get(msg.id) : undefined;
        if (!st) return;
        st.remotePaused = true;
        st.socket.pause();
        return;
      }
      case 'resume': {
        const st = isId(msg.id) ? this.streams.get(msg.id) : undefined;
        if (!st) return;
        st.remotePaused = false;
        if (!this.wsPaused && st.connected) st.socket.resume();
        return;
      }
      case 'ping':
        this.send({ t: 'pong', ts: typeof msg.ts === 'number' ? msg.ts : Date.now() });
        return;
      case 'detect':
        if (isId(msg.reqId)) void this.detect(msg.reqId);
        return;
      default:
        return;
    }
  }

  handleBinary(frame: Uint8Array): void {
    if (this.ended) return;
    if (frame.length < BRIDGE_DATA_HEADER_BYTES || frame.length > BRIDGE_DATA_HEADER_BYTES + BRIDGE_MAX_PAYLOAD_BYTES) {
      this.io.close(BRIDGE_CLOSE.protocolError, 'Bad data frame');
      return;
    }
    const { id, payload } = decodeDataFrame(frame);
    const st = this.streams.get(id);
    if (!st || st.closed || !st.connected) return;
    st.socket.write(payload);
    if (!st.sentPause && st.socket.writableLength > BRIDGE_HIGH_WATER_BYTES) {
      st.sentPause = true;
      this.send({ t: 'pause', id });
    }
  }

  private open(id: unknown, host: unknown, port: unknown): void {
    if (!isId(id)) return;
    if (this.seen.has(id)) {
      this.send({ t: 'open-failed', id, error: 'Stream id already used' });
      return;
    }
    this.seen.add(id);
    const refusal = checkOpen(host, port, this.streams.size, this.opts.isAllowed);
    if (refusal !== null) {
      this.send({ t: 'open-failed', id, error: refusal });
      return;
    }
    const target = { host: host as string, port: port as number };
    const socket = (this.opts.connect ?? ((h, p) => connect({ host: h, port: p })))(target.host, target.port);
    const st: Stream = { id, socket, connected: false, remotePaused: false, sentPause: false, closed: false, timer: null };
    this.streams.set(id, st);
    st.timer = setTimeout(() => this.failOpen(st, 'Connection timed out'), BRIDGE_OPEN_TIMEOUT_MS);
    st.timer.unref();
    socket.once('connect', () => {
      if (st.closed) return;
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
      st.connected = true;
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30_000);
      this.send({ t: 'opened', id });
      if (this.wsPaused || st.remotePaused) socket.pause();
    });
    socket.on('data', (chunk: Buffer) => {
      if (st.closed) return;
      for (let off = 0; off < chunk.length; off += BRIDGE_MAX_PAYLOAD_BYTES) {
        this.io.sendBinary(encodeDataFrame(id, chunk.subarray(off, off + BRIDGE_MAX_PAYLOAD_BYTES)));
      }
      this.checkBackpressure();
    });
    socket.on('drain', () => {
      if (st.sentPause && !st.closed) {
        st.sentPause = false;
        this.send({ t: 'resume', id });
      }
    });
    socket.on('error', (err: Error) => {
      if (!st.connected) this.failOpen(st, err.message);
    });
    socket.on('close', () => this.finish(st, 'notify'));
  }

  private failOpen(st: Stream, error: string): void {
    if (st.closed) return;
    this.finish(st, 'quiet');
    this.send({ t: 'open-failed', id: st.id, error: error.slice(0, 200) });
  }

  /** 'notify': tell the hub; 'end': the hub ended it, flush and close; 'quiet': drop without a message. */
  private finish(st: Stream, how: 'notify' | 'end' | 'quiet'): void {
    if (st.closed) return;
    st.closed = true;
    if (st.timer) clearTimeout(st.timer);
    this.streams.delete(st.id);
    if (how === 'notify') this.send({ t: 'close', id: st.id });
    if (how === 'end' && st.connected && !st.socket.destroyed) {
      st.socket.end(() => st.socket.destroy());
      setTimeout(() => st.socket.destroy(), 5_000).unref();
    } else {
      st.socket.destroy();
    }
  }

  /** Stops reading from cameras while the WebSocket has too much queued; resumes once it drains. */
  private checkBackpressure(): void {
    if (this.wsPaused || this.io.bufferedAmount() <= BRIDGE_HIGH_WATER_BYTES) return;
    this.wsPaused = true;
    for (const st of this.streams.values()) st.socket.pause();
    this.drainTimer = setInterval(() => {
      if (this.ended || this.io.bufferedAmount() >= BRIDGE_LOW_WATER_BYTES) return;
      this.wsPaused = false;
      if (this.drainTimer) clearInterval(this.drainTimer);
      this.drainTimer = null;
      for (const st of this.streams.values()) if (st.connected && !st.remotePaused) st.socket.resume();
    }, 25);
    this.drainTimer.unref();
  }

  private async detect(reqId: number): Promise<void> {
    if (!this.opts.detect) {
      this.send({ t: 'detect-failed', reqId, error: 'Detection is not available on this bridge' });
      return;
    }
    if (this.detecting) {
      this.send({ t: 'detect-failed', reqId, error: 'Detection is already running' });
      return;
    }
    this.detecting = true;
    try {
      const r = await this.opts.detect();
      this.send({ t: 'detect-result', reqId, devices: r.devices, scanned: r.scanned, tookMs: r.tookMs });
    } catch (err) {
      this.send({ t: 'detect-failed', reqId, error: (err as Error).message.slice(0, 200) });
    } finally {
      this.detecting = false;
    }
  }

  /** Drops every stream (the WebSocket closed). */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.drainTimer) clearInterval(this.drainTimer);
    for (const st of [...this.streams.values()]) this.finish(st, 'quiet');
  }
}
