// A small WHEP client (WebRTC-HTTP Egress Protocol) for watching one camera, receive-only video.
//
// One POST carries the complete SDP offer (all ICE candidates gathered first, no trickle), with the
// short-lived live token as "Authorization: Bearer". The hub's media server answers 201 with the SDP answer
// and a Location for the session, which is DELETEd on close. connectLive() wraps this with fresh tokens and
// reconnects with back-off when the stream drops.

export type WhepErrorKind = 'unauthorized' | 'not-found' | 'unavailable' | 'network' | 'timeout' | 'unsupported' | 'protocol';

export class WhepError extends Error {
  readonly kind: WhepErrorKind;
  readonly status: number;

  constructor(kind: WhepErrorKind, message: string, status = 0) {
    super(message);
    this.name = 'WhepError';
    this.kind = kind;
    this.status = status;
  }
}

export interface WhepOptions {
  /** WHEP endpoint, same origin ("/live/c12/whep"). */
  url: string;
  /** Live token from POST /api/live/:cameraId/token. */
  token: string;
  signal?: AbortSignal;
  /** Whole-request timeout for gathering and the POST (default 15 s). */
  timeoutMs?: number;
}

export interface WhepSession {
  pc: RTCPeerConnection;
  /** Receives the remote video track as soon as it arrives. */
  stream: MediaStream;
  /** Session resource URL, or null when the server did not give one. */
  resourceUrl: string | null;
  /** Ends the session: DELETE to the server (best effort) and close the peer connection. Safe to call twice. */
  close: () => void;
}

const GATHER_WAIT_MS = 2000;
const SESSION_ID = /^[A-Za-z0-9._~-]{1,200}$/;

function waitForGathering(pc: RTCPeerConnection, ms: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    // Host candidates arrive at once; do not wait forever on slow interfaces, the server is public anyway.
    const timer = setTimeout(finish, ms);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function sameOriginUrl(url: string): URL {
  const resolved = new URL(url, window.location.href);
  if (resolved.origin !== window.location.origin) throw new WhepError('protocol', 'The live address is not on this hub.');
  return resolved;
}

/**
 * The session resource always sits right under the WHEP endpoint ("<whep>/<session id>"). The media server
 * names it relative to its own root, which differs from the public path when a proxy adds a prefix (/live),
 * so only the last path segment of Location is used.
 */
function sessionUrl(endpoint: URL, location: string | null): string | null {
  if (!location) return null;
  let parsed: URL;
  try {
    parsed = new URL(location, endpoint);
  } catch {
    return null;
  }
  const id = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
  if (!SESSION_ID.test(id) || id === 'whep') return null;
  return `${endpoint.pathname.replace(/\/+$/, '')}/${encodeURIComponent(id)}`;
}

function errorForStatus(status: number): WhepError {
  if (status === 401 || status === 403) return new WhepError('unauthorized', 'The live pass was refused.', status);
  if (status === 404) return new WhepError('not-found', 'The camera stream is not ready.', status);
  if (status === 400 || status === 406 || status === 415) {
    return new WhepError('protocol', 'The live stream could not be agreed with this browser.', status);
  }
  return new WhepError('unavailable', 'The live service did not answer.', status);
}

/** Starts one WHEP session. Rejects with WhepError. */
export async function startWhep(options: WhepOptions): Promise<WhepSession> {
  if (typeof RTCPeerConnection === 'undefined') {
    throw new WhepError('unsupported', 'This browser cannot play live video. Use an up-to-date browser.');
  }
  const endpoint = sameOriginUrl(options.url);
  const timeoutMs = options.timeoutMs ?? 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onOuterAbort);

  const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
  const stream = new MediaStream();
  pc.addEventListener('track', (event) => {
    if (event.track.kind !== 'video') return;
    for (const old of stream.getVideoTracks()) stream.removeTrack(old);
    stream.addTrack(event.track);
  });
  pc.addTransceiver('video', { direction: 'recvonly' });

  let resourceUrl: string | null = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (resourceUrl) {
      // keepalive lets the DELETE finish while the page is being closed.
      fetch(resourceUrl, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${options.token}` },
        credentials: 'omit',
        keepalive: true,
      }).catch(() => undefined);
    }
    for (const receiver of pc.getReceivers()) receiver.track?.stop();
    pc.close();
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForGathering(pc, GATHER_WAIT_MS);
    if (controller.signal.aborted) throw new WhepError(options.signal?.aborted ? 'network' : 'timeout', 'Stopped.');
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new WhepError('protocol', 'The browser did not make a live request.');

    let res: Response;
    try {
      res = await fetch(endpoint.href, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/sdp' },
        body: sdp,
        // The media server needs only the live token, never the dashboard session cookie.
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch {
      if (options.signal?.aborted) throw new WhepError('network', 'Stopped.');
      if (controller.signal.aborted) throw new WhepError('timeout', 'The live service took too long to answer.');
      throw new WhepError('network', 'The live service could not be reached.');
    }
    if (res.status !== 201 && res.status !== 200) throw errorForStatus(res.status);
    resourceUrl = sessionUrl(endpoint, res.headers.get('Location'));
    const answer = await res.text();
    if (!answer.startsWith('v=0')) throw new WhepError('protocol', 'The live service sent an answer this browser cannot use.');
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    return { pc, stream, resourceUrl, close };
  } catch (err) {
    close();
    if (err instanceof WhepError) throw err;
    throw new WhepError('protocol', 'The live stream could not be agreed with this browser.');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/* ----------------------------------------------------------- reconnecting */

export type LiveState = 'connecting' | 'live' | 'retrying' | 'failed';

export interface LiveTicket {
  url: string;
  token: string;
  /**
   * When the hub ends the viewing session this ticket opens (unix ms), if it says so. Without it the session is
   * taken to last `sessionMaxMs` from the moment the ticket was asked for.
   */
  sessionEndsAt?: number | null;
}

export interface LiveConnectionOptions {
  /** Fetches a fresh token for every attempt (tokens live 60 s). */
  getTicket: (signal: AbortSignal) => Promise<LiveTicket>;
  /**
   * A new MediaStream for the video element: after the first connection, after a reconnect and for every
   * renewal. When it returns a promise (resolved once the new picture is on screen), the previous session is
   * closed only after it settles (at most 8 s), so a renewal never leaves a blank frame.
   */
  onStream: (stream: MediaStream) => void | Promise<void>;
  /** State changes; `error` is the last failure when retrying or failed. A renewal does not change the state. */
  onState: (state: LiveState, error?: unknown) => void;
  /** Errors that make retrying pointless (camera removed, access lost). Default: none. */
  isFatal?: (error: unknown) => boolean;
  /** Attempts in a row before giving up with 'failed' (default 6). */
  maxAttempts?: number;
  /** How long a connection may take to come up after the answer (default 15 s). */
  connectTimeoutMs?: number;
  /** How long the hub lets one viewing session run before it closes it (default 10 minutes). */
  sessionMaxMs?: number;
  /** How long before that end a replacement session is opened (default 30 s). */
  renewBeforeMs?: number;
}

export interface LiveConnection {
  /** Start again after 'failed' (or force a fresh connection). */
  retry: () => void;
  /** Stop for good. */
  close: () => void;
}

const DISCONNECT_GRACE_MS = 5000;
/** The hub ends every viewing session after this long and checks access again (server LIVE_SESSION_MAX_MS). */
export const LIVE_SESSION_MS = 10 * 60_000;
const RENEW_BEFORE_MS = 30_000;
/** Never renew more often than this, whatever the hub says. */
const RENEW_MIN_DELAY_MS = 20_000;
/** A failed renewal is tried again after this long, while the old session still runs. */
const RENEW_RETRY_MS = 5000;
/** Longest wait for the new picture before the old session is closed anyway. */
const SWAP_WAIT_MS = 8000;
/** A stream that played at least this long and then dropped comes back at once, without counting a failure. */
const STABLE_MS = 15_000;

interface OpenedSession {
  session: WhepSession;
  /** When the hub will end it (unix ms). */
  endsAt: number;
}

/** Resolves once the peer connection is connected; rejects when it fails, closes, times out or is aborted. */
function whenConnected(pc: RTCPeerConnection, ms: number, signal: AbortSignal): Promise<void> {
  if (pc.connectionState === 'connected') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: WhepError) => {
      clearTimeout(timer);
      pc.removeEventListener('connectionstatechange', check);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      const state = pc.connectionState;
      if (state === 'connected') finish();
      else if (state === 'failed' || state === 'closed') finish(new WhepError('network', 'The live stream dropped.'));
    };
    const onAbort = () => finish(new WhepError('network', 'Stopped.'));
    const timer = setTimeout(() => finish(new WhepError('timeout', 'The live stream did not start.')), ms);
    pc.addEventListener('connectionstatechange', check);
    signal.addEventListener('abort', onAbort);
  });
}

function settleWithin(value: void | Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    Promise.resolve(value)
      .catch(() => undefined)
      .then(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

/**
 * Keeps one camera playing: fresh token, WHEP session, reconnect with back-off (1, 2, 4, 8, 16, 30 s) when the
 * connection fails, until `maxAttempts` attempts in a row have failed.
 *
 * The hub closes every viewing session after about 10 minutes. About 30 s before that a second session is
 * opened beside the first; once its picture is on screen (see `onStream`) the old one is closed, so the video
 * runs on without a gap. A stream that was playing fine and drops anyway is reconnected at once and that is
 * not counted as a failure.
 */
export function connectLive(options: LiveConnectionOptions): LiveConnection {
  const maxAttempts = options.maxAttempts ?? 6;
  const connectTimeoutMs = options.connectTimeoutMs ?? 15000;
  const sessionMaxMs = options.sessionMaxMs ?? LIVE_SESSION_MS;
  const renewBeforeMs = options.renewBeforeMs ?? RENEW_BEFORE_MS;
  let stopped = false;
  let generation = 0;
  let failures = 0;
  let current: WhepSession | null = null;
  /** When the stream of this generation first played (0 = not playing). Survives renewals. */
  let liveSince = 0;
  let controller: AbortController | null = null;
  let renewal: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  let renewTimer: ReturnType<typeof setTimeout> | null = null;

  const clearWatch = () => {
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = null;
  };

  const stopRenewal = () => {
    if (renewTimer) clearTimeout(renewTimer);
    renewTimer = null;
    renewal?.abort();
    renewal = null;
  };

  const teardown = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    clearWatch();
    stopRenewal();
    controller?.abort();
    controller = null;
    current?.close();
    current = null;
    liveSince = 0;
  };

  const open = async (signal: AbortSignal): Promise<OpenedSession> => {
    const askedAt = Date.now();
    const ticket = await options.getTicket(signal);
    if (signal.aborted) throw new WhepError('network', 'Stopped.');
    const session = await startWhep({ url: ticket.url, token: ticket.token, signal });
    const told = ticket.sessionEndsAt;
    const endsAt = typeof told === 'number' && Number.isFinite(told) && told > askedAt ? told : askedAt + sessionMaxMs;
    return { session, endsAt };
  };

  const scheduleRetry = (gen: number, error: unknown) => {
    if (stopped || gen !== generation) return;
    const playedFor = liveSince ? Date.now() - liveSince : 0;
    teardown();
    const fatal = options.isFatal?.(error) ?? false;
    if (!fatal && playedFor >= STABLE_MS) {
      options.onState('retrying', error);
      void attempt(gen, false);
      return;
    }
    failures += 1;
    if (failures >= maxAttempts || fatal) {
      options.onState('failed', error);
      return;
    }
    options.onState('retrying', error);
    const delay = Math.min(30000, 1000 * 2 ** (failures - 1));
    retryTimer = setTimeout(() => void attempt(gen, false), delay);
  };

  const scheduleRenewal = (gen: number, endsAt: number) => {
    if (renewTimer || renewal) return;
    const delay = Math.max(RENEW_MIN_DELAY_MS, endsAt - renewBeforeMs - Date.now());
    renewTimer = setTimeout(() => {
      renewTimer = null;
      void renew(gen, endsAt);
    }, delay);
  };

  /** Watches the session that is now `current`. */
  const watch = (gen: number, opened: OpenedSession) => {
    const pc = opened.session.pc;
    clearWatch();
    watchTimer = setTimeout(() => {
      if (pc.connectionState !== 'connected') scheduleRetry(gen, new WhepError('timeout', 'The live stream did not start.'));
    }, connectTimeoutMs);
    const onChange = () => {
      if (stopped || gen !== generation || current?.pc !== pc) return;
      const state = pc.connectionState;
      if (state === 'connected') {
        clearWatch();
        if (!liveSince) liveSince = Date.now();
        failures = 0;
        options.onState('live');
        scheduleRenewal(gen, opened.endsAt);
      } else if (state === 'failed' || state === 'closed') {
        scheduleRetry(gen, new WhepError('network', 'The live stream dropped.'));
      } else if (state === 'disconnected') {
        // Often recovers on its own (a phone switching networks); give it a moment first.
        clearWatch();
        watchTimer = setTimeout(() => {
          if (pc.connectionState !== 'connected') scheduleRetry(gen, new WhepError('network', 'The live stream dropped.'));
        }, DISCONNECT_GRACE_MS);
      }
    };
    pc.addEventListener('connectionstatechange', onChange);
    // A renewed session is already connected when it takes over.
    if (pc.connectionState === 'connected') onChange();
  };

  const attempt = async (gen: number, announce: boolean) => {
    if (stopped || gen !== generation) return;
    const ctl = new AbortController();
    controller = ctl;
    if (announce) options.onState('connecting');
    let opened: OpenedSession;
    try {
      opened = await open(ctl.signal);
    } catch (err) {
      if (ctl.signal.aborted && (stopped || gen !== generation)) return;
      if (controller === ctl) controller = null;
      scheduleRetry(gen, err);
      return;
    }
    if (stopped || gen !== generation || ctl.signal.aborted) {
      opened.session.close();
      return;
    }
    controller = null;
    current = opened.session;
    void options.onStream(opened.session.stream);
    watch(gen, opened);
  };

  /** Opens the replacement session beside the playing one and hands over once its picture shows. */
  const renew = async (gen: number, oldEndsAt: number) => {
    const old = current;
    if (stopped || gen !== generation || !old) return;
    const ctl = new AbortController();
    renewal = ctl;
    const still = () => !stopped && gen === generation && current === old && !ctl.signal.aborted;
    let opened: OpenedSession | null = null;
    try {
      opened = await open(ctl.signal);
      await whenConnected(opened.session.pc, connectTimeoutMs, ctl.signal);
    } catch {
      opened?.session.close();
      if (renewal === ctl) renewal = null;
      if (!still()) return;
      // Try again shortly while the old session still has time; if it ends first, the reconnect takes over.
      if (Date.now() + RENEW_RETRY_MS < oldEndsAt) {
        renewTimer = setTimeout(() => {
          renewTimer = null;
          void renew(gen, oldEndsAt);
        }, RENEW_RETRY_MS);
      }
      return;
    }
    if (!still()) {
      opened.session.close();
      if (renewal === ctl) renewal = null;
      return;
    }
    // The new picture goes on screen first; only then does the old session end.
    await settleWithin(options.onStream(opened.session.stream), SWAP_WAIT_MS);
    if (renewal === ctl) renewal = null;
    if (!still()) {
      opened.session.close();
      return;
    }
    current = opened.session;
    old.close();
    watch(gen, opened);
  };

  void attempt(generation, true);

  return {
    retry: () => {
      if (stopped) return;
      generation += 1;
      teardown();
      failures = 0;
      void attempt(generation, true);
    },
    close: () => {
      if (stopped) return;
      stopped = true;
      generation += 1;
      teardown();
    },
  };
}
