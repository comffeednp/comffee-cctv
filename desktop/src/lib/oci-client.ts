/**
 * Minimal Oracle Cloud REST client: signs each request, parses JSON, follows list pages.
 * Only the calls this app needs; see provision.ts for the resources it makes.
 */

import type { KeyObject } from 'node:crypto';
import { signRequest } from './oci-signer.ts';
import { serviceEndpoint } from './oci-regions.ts';
import { NetworkError } from './https-transport.ts';
import type { Transport } from './https-transport.ts';

export interface OciAuth {
  keyId: string;
  privateKey: KeyObject;
}

/** Returns signing material for the next request (a session token may be refreshed in between). */
export type AuthProvider = () => Promise<OciAuth>;

export type OciService = 'identity' | 'iaas' | 'auth';

export class OciError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  constructor(status: number, code: string, message: string, requestId: string | null) {
    super(message);
    this.name = 'OciError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export type Query = Record<string, string | number | boolean | undefined>;

export function buildQuery(query: Query | undefined): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export interface OciRequestOptions {
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface OciClientOptions {
  region: string;
  auth: AuthProvider;
  transport: Transport;
}

export class OciClient {
  readonly region: string;
  private readonly auth: AuthProvider;
  private readonly transport: Transport;

  constructor(options: OciClientOptions) {
    this.region = options.region;
    this.auth = options.auth;
    this.transport = options.transport;
  }

  /** The same signing material in another region (home region calls). */
  inRegion(region: string): OciClient {
    return new OciClient({ region, auth: this.auth, transport: this.transport });
  }

  async request<T>(service: OciService, method: string, path: string, options: OciRequestOptions = {}): Promise<{ data: T; headers: Record<string, string> }> {
    const url = `${serviceEndpoint(service, this.region)}${path}${buildQuery(options.query)}`;
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const auth = await this.auth();
    const signed = signRequest({ method, url, keyId: auth.keyId, privateKey: auth.privateKey, body });
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers, ...signed.headers };
    const sendsBody = ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase());
    const res = await this.transport({
      method,
      url,
      headers,
      body: sendsBody ? (body ?? '') : undefined,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    const requestId = res.headers['opc-request-id'] ?? null;
    if (res.status < 200 || res.status >= 300) {
      let code = 'Unknown';
      let message = `Oracle answered ${res.status}.`;
      try {
        const parsed = JSON.parse(res.body) as { code?: unknown; message?: unknown };
        if (typeof parsed.code === 'string') code = parsed.code;
        if (typeof parsed.message === 'string') message = parsed.message;
      } catch {
        // Not JSON; keep the generic message.
      }
      throw new OciError(res.status, code, message, requestId);
    }
    let data: T;
    if (!res.body) data = undefined as T;
    else {
      try {
        data = JSON.parse(res.body) as T;
      } catch {
        throw new NetworkError('Oracle sent an answer this app could not read.');
      }
    }
    return { data, headers: res.headers };
  }

  async get<T>(service: OciService, path: string, query?: Query, signal?: AbortSignal): Promise<T> {
    return (await this.request<T>(service, 'GET', path, { query, signal })).data;
  }

  async post<T>(service: OciService, path: string, body: unknown, headers?: Record<string, string>, signal?: AbortSignal): Promise<T> {
    return (await this.request<T>(service, 'POST', path, { body, headers, signal })).data;
  }

  async put<T>(service: OciService, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return (await this.request<T>(service, 'PUT', path, { body, signal })).data;
  }

  /** Follows opc-next-page until done (at most 50 pages). */
  async list<T>(service: OciService, path: string, query: Query, signal?: AbortSignal): Promise<T[]> {
    const items: T[] = [];
    let page: string | undefined;
    for (let i = 0; i < 50; i++) {
      const res = await this.request<T[]>(service, 'GET', path, { query: { ...query, page }, signal });
      if (Array.isArray(res.data)) items.push(...res.data);
      page = res.headers['opc-next-page'];
      if (!page) break;
    }
    return items;
  }
}

export function isOciError(err: unknown): err is OciError {
  return err instanceof OciError;
}

/** "Out of host capacity" and its variants. */
export function isCapacityError(err: unknown): boolean {
  return err instanceof OciError && /out of (host )?capacity/i.test(err.message);
}

/** Worth trying again later: throttling, Oracle-side hiccups and network failures. */
export function isTransientError(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  if (err instanceof OciError) return err.status === 429 || err.status === 502 || err.status === 503 || err.status === 504 || (err.status === 500 && !isCapacityError(err));
  return false;
}
