/**
 * Small request parsing helpers for the media routes. Bad input -> HttpError 422 invalid_input;
 * a malformed id in the URL -> 404 not_found (same as a missing row).
 */

import { HttpError } from '../contracts.ts';

export function invalidInput(message: string): HttpError {
  return new HttpError(422, 'invalid_input', message);
}

export function notFound(message = 'Not found'): HttpError {
  return new HttpError(404, 'not_found', message);
}

/** Id from a URL parameter; anything but a positive integer is "not found". */
export function parseIdParam(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value)) throw notFound();
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw notFound();
  return id;
}

export function asObject(value: unknown, what = 'Request body'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidInput(`${what} must be a JSON object`);
  return value as Record<string, unknown>;
}

/** Single string value of a query parameter (undefined when absent or empty). */
export function queryValue(query: unknown, key: string): string | undefined {
  if (typeof query !== 'object' || query === null) return undefined;
  const raw = (query as Record<string, unknown>)[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw invalidInput(`${key} is invalid`);
  return value;
}

export function queryInt(query: unknown, key: string, min: number, max: number): number | undefined {
  const value = queryValue(query, key);
  if (value === undefined) return undefined;
  if (!/^-?\d{1,16}$/.test(value)) throw invalidInput(`${key} must be a whole number`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw invalidInput(`${key} must be between ${min} and ${max}`);
  return n;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** ISO 8601 time with an explicit offset -> unix ms. */
export function queryTime(query: unknown, key: string): number | undefined {
  const value = queryValue(query, key);
  if (value === undefined) return undefined;
  const ms = ISO_RE.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw invalidInput(`${key} must be an ISO 8601 time`);
  return ms;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
