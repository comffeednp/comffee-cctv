/**
 * Minimal MediaMTX control API v3 client (path configuration and path state), signed in with the
 * internal credentials. Every request has a timeout.
 */

import { HttpError } from '../contracts.ts';
import { redactUrls } from './paths.ts';

export interface MediaMtxPathState {
  name: string;
  /** Stream is online (MediaMTX "online", or the older "ready"). */
  online: boolean;
  /** Bytes received from the source so far. */
  inboundBytes: number;
}

export interface MediaMtxClient {
  /** Every configured path, keyed by name. */
  listPathConfs(): Promise<Map<string, Record<string, unknown>>>;
  /** One configured path, or null when it does not exist. */
  getPathConf(name: string): Promise<Record<string, unknown> | null>;
  addPathConf(name: string, conf: Record<string, unknown>): Promise<void>;
  /** Replaces every value of a path (unset keys go back to the defaults). */
  replacePathConf(name: string, conf: Record<string, unknown>): Promise<void>;
  /** Removes a path; a path that does not exist is not an error. */
  deletePathConf(name: string): Promise<void>;
  /** Runtime state of every active path. */
  listPaths(): Promise<MediaMtxPathState[]>;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 1000;

/** Thrown when MediaMTX answers with an error status. */
export class MediaMtxError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'MediaMtxError';
    this.status = status;
  }
}

export function createMediaMtxClient(
  baseUrl: string,
  user: string,
  password: string,
  timeoutMs = 5000,
  fetchImpl: typeof fetch = fetch,
): MediaMtxClient {
  const base = baseUrl.replace(/\/+$/, '');
  const authorization = `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;

  async function call(method: string, urlPath: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${urlPath}`, {
        method,
        headers: {
          authorization,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new HttpError(503, 'unavailable', 'The media server did not answer');
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let message = text;
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === 'string') message = parsed.error;
      } catch {
        // Not JSON; keep the text.
      }
      throw new MediaMtxError(res.status, redactUrls(`MediaMTX ${method} ${urlPath}: ${res.status} ${message}`.slice(0, 500)));
    }
    if (text === '') return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  async function listAll(urlPath: string): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = (await call('GET', `${urlPath}?page=${page}&itemsPerPage=${PAGE_SIZE}`)) as {
        items?: unknown;
        pageCount?: unknown;
      } | null;
      const pageItems = Array.isArray(res?.items) ? (res.items as Record<string, unknown>[]) : [];
      items.push(...pageItems);
      const pageCount = typeof res?.pageCount === 'number' ? res.pageCount : 0;
      if (page + 1 >= pageCount || pageItems.length === 0) break;
    }
    return items;
  }

  const enc = (name: string): string => encodeURIComponent(name);

  return {
    async listPathConfs() {
      const out = new Map<string, Record<string, unknown>>();
      for (const item of await listAll('/v3/config/paths/list')) {
        if (typeof item.name === 'string') out.set(item.name, item);
      }
      return out;
    },
    async getPathConf(name) {
      try {
        return (await call('GET', `/v3/config/paths/get/${enc(name)}`)) as Record<string, unknown> | null;
      } catch (err) {
        if (err instanceof MediaMtxError && err.status === 404) return null;
        throw err;
      }
    },
    async addPathConf(name, conf) {
      await call('POST', `/v3/config/paths/add/${enc(name)}`, conf);
    },
    async replacePathConf(name, conf) {
      await call('POST', `/v3/config/paths/replace/${enc(name)}`, conf);
    },
    async deletePathConf(name) {
      try {
        await call('DELETE', `/v3/config/paths/delete/${enc(name)}`);
      } catch (err) {
        if (err instanceof MediaMtxError && err.status === 404) return;
        throw err;
      }
    },
    async listPaths() {
      return (await listAll('/v3/paths/list')).flatMap((item) => {
        if (typeof item.name !== 'string') return [];
        const online = typeof item.online === 'boolean' ? item.online : item.ready === true;
        const bytes =
          typeof item.inboundBytes === 'number'
            ? item.inboundBytes
            : typeof item.bytesReceived === 'number'
              ? item.bytesReceived
              : 0;
        return [{ name: item.name, online, inboundBytes: bytes }];
      });
    },
  };
}
