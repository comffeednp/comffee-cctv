// Small fetch wrapper for the hub API. Every request is same-origin, sends the CSRF header and parses the
// hub's {"error":{"code","message"}} body into an ApiFailure.

import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../../shared/api-types.ts';
import type { ApiErrorBody, ApiErrorCode } from '../../../shared/api-types.ts';
import { navigate, safeNextPath } from './router.ts';

/** 'network' = the hub did not answer at all; 'unknown' = an error body the dashboard did not recognise. */
export type ApiFailureCode = ApiErrorCode | 'network' | 'unknown';

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: ApiFailureCode;

  constructor(status: number, code: ApiFailureCode, message: string) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = code;
  }
}

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue> | URLSearchParams;

export interface RequestOptions {
  signal?: AbortSignal;
}

/** Fired on window when the hub says the session is gone; the session store listens for it. */
export const SIGNED_OUT_EVENT = 'cctv:signed-out';

const KNOWN_CODES: readonly ApiErrorCode[] = [
  'not_signed_in',
  'wrong_credentials',
  'challenge_expired',
  'owner_only',
  'csrf',
  'not_found',
  'conflict',
  'wrong_password',
  'invalid_input',
  'throttled',
  'unavailable',
  'internal',
];

function buildUrl(path: string, query?: Query): string {
  if (!query) return path;
  const params = query instanceof URLSearchParams ? query : new URLSearchParams();
  if (!(query instanceof URLSearchParams)) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  if (!text) return path;
  return path + (path.includes('?') ? '&' : '?') + text;
}

/** Sends the person to the sign-in page, remembering where they were. */
function handleSignedOut(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  if (window.location.pathname === '/login' || window.location.pathname === '/setup') return;
  const here = safeNextPath(window.location.pathname + window.location.search);
  const target = here && here !== '/' ? `/login?next=${encodeURIComponent(here)}` : '/login';
  navigate(target, { replace: true });
}

async function failureFrom(response: Response, path: string): Promise<ApiFailure> {
  let code: ApiFailureCode = 'unknown';
  let message = '';
  try {
    const body = (await response.json()) as Partial<ApiErrorBody>;
    const raw = body?.error?.code;
    if (typeof raw === 'string' && (KNOWN_CODES as readonly string[]).includes(raw)) code = raw as ApiErrorCode;
    if (typeof body?.error?.message === 'string') message = body.error.message;
  } catch {
    // Not JSON (for example a proxy error page). Fall back to the status.
  }
  if (code === 'unknown') {
    if (response.status === 401) code = 'not_signed_in';
    else if (response.status === 404) code = 'not_found';
    else if (response.status === 429) code = 'throttled';
    else if (response.status >= 500) code = response.status === 503 || response.status === 502 ? 'unavailable' : 'internal';
  }
  const failure = new ApiFailure(response.status, code, message || `Request failed (${response.status})`);
  // A lost session on any call except the "who am I" check sends the person to sign in. Wrong passwords
  // and expired sign-in steps are also 401 but carry other codes, so they stay on their form.
  if (response.status === 401 && code === 'not_signed_in' && !path.startsWith('/api/me')) handleSignedOut();
  return failure;
}

async function request(method: string, path: string, body: unknown, options: RequestOptions | undefined, query?: Query): Promise<Response> {
  const headers: Record<string, string> = { [CSRF_HEADER]: CSRF_HEADER_VALUE, Accept: 'application/json' };
  const init: RequestInit = { method, headers, credentials: 'same-origin', cache: 'no-store', signal: options?.signal };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiFailure(0, 'network', 'The hub did not answer.');
  }
  if (!response.ok) throw await failureFrom(response, path);
  return response;
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** GET a JSON resource. Empty, null and undefined query values are left out. */
export async function apiGet<T>(path: string, query?: Query, options?: RequestOptions): Promise<T> {
  return readJson<T>(await request('GET', path, undefined, options, query));
}

/** POST, PATCH, PUT or DELETE with an optional JSON body. */
export async function apiSend<T>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  return readJson<T>(await request(method, path, body, options));
}

/** GET a raw response (recording files). Throws ApiFailure when the status is not 2xx. */
export async function apiRaw(path: string, options?: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { [CSRF_HEADER]: CSRF_HEADER_VALUE };
  let response: Response;
  try {
    response = await fetch(path, { method: 'GET', headers, credentials: 'same-origin', cache: 'no-store', signal: options?.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiFailure(0, 'network', 'The hub did not answer.');
  }
  if (!response.ok) throw await failureFrom(response, path);
  return response;
}

const DEFAULT_MESSAGES: Record<ApiFailureCode, string> = {
  not_signed_in: 'You are signed out. Sign in again.',
  wrong_credentials: 'Wrong username or password.',
  challenge_expired: 'That sign-in took too long. Start again.',
  owner_only: 'Only the owner can do that.',
  csrf: 'The hub refused this request. Reload the page and try again.',
  not_found: 'That was not found. It may have been removed.',
  conflict: 'That already exists or is busy. Check and try again.',
  wrong_password: 'That password is not right. Type your own password again.',
  invalid_input: 'Some details are not right. Check them and try again.',
  throttled: 'Too many tries. Wait a few minutes and try again.',
  unavailable: 'The hub could not reach what it needed. Try again in a minute.',
  internal: 'Something went wrong on the hub. Try again.',
  network: 'The hub did not answer. Check your internet connection and try again.',
  unknown: 'That did not go through. Try again.',
};

// The hub writes plain sentences for these codes that say exactly what to fix, so they are shown as is.
const SERVER_WORDED: readonly ApiFailureCode[] = ['invalid_input', 'conflict', 'throttled', 'unavailable'];

/** Turns any thrown value into one plain sentence for the screen. Raw codes never reach the screen. */
export function describeError(error: unknown, overrides?: Partial<Record<ApiFailureCode, string>>): string {
  if (error instanceof ApiFailure) {
    const override = overrides?.[error.code];
    if (override) return override;
    if (SERVER_WORDED.includes(error.code) && error.message && !error.message.startsWith('Request failed')) {
      return /[.!?]$/.test(error.message) ? error.message : `${error.message}.`;
    }
    return DEFAULT_MESSAGES[error.code];
  }
  return overrides?.unknown ?? DEFAULT_MESSAGES.unknown;
}

/** True when the error is a fetch the caller aborted on purpose. */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
