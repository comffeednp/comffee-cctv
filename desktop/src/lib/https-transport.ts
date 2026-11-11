/**
 * Small HTTPS client on node:https with full control of the request headers (OCI signs host and
 * content-length). Certificates are always verified; there is no option to turn that off.
 */

import { request } from 'node:https';

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Default 30 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

/** Largest answer read into memory. OCI list pages and the hub status are far smaller. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export const httpsTransport: Transport = (req) =>
  new Promise<HttpResponse>((resolve, reject) => {
    const url = new URL(req.url);
    if (url.protocol !== 'https:') {
      reject(new NetworkError('Only https addresses are allowed.'));
      return;
    }
    const r = request(
      url,
      { method: req.method, headers: req.headers, timeout: req.timeoutMs ?? 30_000, signal: req.signal },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            res.destroy(new NetworkError('The answer was too large.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (err) => reject(err instanceof NetworkError ? err : new NetworkError(err.message)));
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') headers[name] = value;
            else if (Array.isArray(value)) headers[name] = value.join(', ');
          }
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    r.on('timeout', () => r.destroy(new NetworkError('The request timed out.')));
    r.on('error', (err) => reject(err instanceof NetworkError ? err : new NetworkError(err.message)));
    if (req.body !== undefined) r.write(req.body, 'utf8');
    r.end();
  });
