/**
 * Oracle Cloud request signing (HTTP Signatures, draft-cavage version 1, rsa-sha256), as documented in
 * Oracle's "Request Signatures" page and implemented by every OCI SDK.
 *
 * GET, HEAD and DELETE sign: date (request-target) host.
 * POST, PUT and PATCH also sign: content-length content-type x-content-sha256.
 *
 * keyId is "<tenancy>/<user>/<fingerprint>" for an API key, or "ST$<token>" for a session token.
 */

import { createHash, createSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

const GENERIC_HEADERS = ['date', '(request-target)', 'host'] as const;
const BODY_HEADERS = ['content-length', 'content-type', 'x-content-sha256'] as const;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export interface SignRequestInput {
  method: string;
  /** Full https URL, with the query string exactly as it will be sent. */
  url: string;
  keyId: string;
  privateKey: KeyObject | string;
  /** Request body as sent (UTF-8). Only used for POST, PUT and PATCH; empty when omitted. */
  body?: string;
  /** Defaults to application/json for body methods. */
  contentType?: string;
  /** RFC 7231 date; defaults to now. Tests pass a fixed one. */
  date?: string;
}

export interface SignedRequest {
  /** Every header the request must carry, lower-case names (authorization included). */
  headers: Record<string, string>;
  /** The exact text that was signed (for tests). */
  signingString: string;
  signature: string;
}

export function sha256Base64(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('base64');
}

export function signRequest(input: SignRequestInput): SignedRequest {
  const method = input.method.toUpperCase();
  const url = new URL(input.url);
  const headers: Record<string, string> = {
    date: input.date ?? new Date().toUTCString(),
    host: url.host,
  };
  const names: string[] = [...GENERIC_HEADERS];
  if (BODY_METHODS.has(method)) {
    const body = input.body ?? '';
    headers['content-type'] = input.contentType ?? 'application/json';
    headers['content-length'] = String(Buffer.byteLength(body, 'utf8'));
    headers['x-content-sha256'] = sha256Base64(body);
    names.push(...BODY_HEADERS);
  }
  const requestTarget = `${method.toLowerCase()} ${url.pathname}${url.search}`;
  const signingString = names
    .map((name) => (name === '(request-target)' ? `(request-target): ${requestTarget}` : `${name}: ${headers[name]}`))
    .join('\n');
  const signer = createSign('RSA-SHA256');
  signer.update(signingString, 'utf8');
  const signature = signer.sign(input.privateKey, 'base64');
  headers.authorization =
    `Signature version="1",headers="${names.join(' ')}",keyId="${input.keyId}",` +
    `algorithm="rsa-sha256",signature="${signature}"`;
  return { headers, signingString, signature };
}
