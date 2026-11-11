/**
 * Keeps one WebSocket connection to the hub open, using Node's built-in WebSocket client.
 * Signs in with "Authorization: Bearer <token>" (and the token in `hello`), reconnects with backoff,
 * and drops a silent connection after BRIDGE_DEAD_AFTER_MS.
 */

import {
  BRIDGE_CLOSE,
  BRIDGE_DEAD_AFTER_MS,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RECONNECT_MAX_MS,
  BRIDGE_RECONNECT_MIN_MS,
} from '../../shared/bridge-protocol.ts';
import { BRIDGE_VERSION, type BridgeConfig } from './config.ts';
import { BridgeSession, type DetectionResult } from './session.ts';

/** Wait after the hub rejected the token, or throttled this address. */
const REJECTED_WAIT_MS = 5 * 60_000;
const THROTTLED_WAIT_MS = 15 * 60_000;
/** After this many failed connects in a row, wait REJECTED_WAIT_MS (the hub may be refusing the token). */
const FAILS_BEFORE_LONG_WAIT = 5;

export interface ClientOptions {
  detect: () => Promise<DetectionResult>;
  log: (message: string) => void;
}

export function nextBackoff(current: number): number {
  return Math.min(BRIDGE_RECONNECT_MAX_MS, Math.max(BRIDGE_RECONNECT_MIN_MS, current * 2));
}

export class BridgeClient {
  private readonly cfg: BridgeConfig;
  private readonly opts: ClientOptions;
  private ws: WebSocket | null = null;
  private session: BridgeSession | null = null;
  private generation = 0;
  private backoff = BRIDGE_RECONNECT_MIN_MS;
  private failedInRow = 0;
  private lastHeard = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(cfg: BridgeConfig, opts: ClientOptions) {
    this.cfg = cfg;
    this.opts = opts;
  }

  start(): void {
    this.stopped = false;
    this.watchdog = setInterval(() => this.checkAlive(), 10_000);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.dropCurrent(1000, 'Bridge stopping');
  }

  private dropCurrent(code: number, reason: string): void {
    this.generation++;
    this.session?.end();
    this.session = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(code, reason);
      } catch {
        /* already closed */
      }
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const gen = ++this.generation;
    let welcomed = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.cfg.hub, { headers: { Authorization: `Bearer ${this.cfg.token}` } });
    } catch (err) {
      this.opts.log(`Could not start a connection to the hub: ${(err as Error).message}`);
      this.scheduleReconnect(this.backoff);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    const session = new BridgeSession(
      {
        sendText: (text) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(text);
        },
        sendBinary: (data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        },
        bufferedAmount: () => ws.bufferedAmount,
        close: (code, reason) => {
          try {
            ws.close(code, reason);
          } catch {
            /* ignore */
          }
        },
      },
      { detect: this.opts.detect, log: this.opts.log },
    );
    this.session = session;

    ws.addEventListener('open', () => {
      if (gen !== this.generation) return;
      this.lastHeard = Date.now();
      ws.send(
        JSON.stringify({ t: 'hello', v: BRIDGE_PROTOCOL_VERSION, token: this.cfg.token, name: this.cfg.name, version: BRIDGE_VERSION }),
      );
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (gen !== this.generation) return;
      this.lastHeard = Date.now();
      if (typeof ev.data === 'string') {
        if (!welcomed && ev.data.includes('"welcome"')) {
          try {
            const msg = JSON.parse(ev.data) as { t?: string; locationId?: number };
            if (msg.t === 'welcome') {
              welcomed = true;
              this.backoff = BRIDGE_RECONNECT_MIN_MS;
              this.failedInRow = 0;
              this.opts.log(`Connected to the hub for location ${String(msg.locationId)}.`);
              return;
            }
          } catch {
            /* fall through */
          }
        }
        session.handleText(ev.data);
      } else if (ev.data instanceof ArrayBuffer) {
        session.handleBinary(new Uint8Array(ev.data));
      }
    });
    ws.addEventListener('error', () => {
      /* 'close' follows */
    });
    ws.addEventListener('close', (ev: CloseEvent) => {
      session.end();
      if (gen !== this.generation) return;
      this.ws = null;
      this.session = null;
      if (this.stopped) return;
      let wait = this.backoff;
      if (ev.code === BRIDGE_CLOSE.badToken) {
        this.opts.log('The hub rejected the bridge token. Make a new token on the location page and update this bridge.');
        wait = REJECTED_WAIT_MS;
      } else if (ev.code === BRIDGE_CLOSE.throttled) {
        this.opts.log('The hub is refusing this address for a while after failed sign-ins.');
        wait = THROTTLED_WAIT_MS;
      } else if (ev.code === BRIDGE_CLOSE.replaced) {
        this.opts.log('Another bridge with the same token connected; this one waits and tries again.');
        wait = BRIDGE_RECONNECT_MAX_MS;
      } else if (!welcomed) {
        this.failedInRow++;
        this.opts.log('Could not connect to the hub. Check the hub address, the token and the internet connection.');
        if (this.failedInRow >= FAILS_BEFORE_LONG_WAIT) wait = REJECTED_WAIT_MS;
      } else {
        this.opts.log('Lost the connection to the hub; reconnecting.');
      }
      this.backoff = nextBackoff(this.backoff);
      this.scheduleReconnect(wait);
    });
  }

  private scheduleReconnect(waitMs: number): void {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const jitter = Math.floor(Math.random() * Math.min(1000, waitMs / 4));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, waitMs + jitter);
  }

  private checkAlive(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastHeard <= BRIDGE_DEAD_AFTER_MS) return;
    this.opts.log('The hub went silent; reconnecting.');
    this.dropCurrent(4000, 'No traffic');
    this.backoff = nextBackoff(this.backoff);
    this.scheduleReconnect(BRIDGE_RECONNECT_MIN_MS);
  }
}
